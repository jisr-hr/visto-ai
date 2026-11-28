import type { GateCounts } from '../db/gate.ts';
import { NO_COUNTS } from '../db/gate.ts';
import type { StoredRun } from '../db/review-runs.ts';
import type { CheckWrite, OwnCheck } from '../forge/types.ts';
import { isShortCode } from '../shell/codes.ts';
import { head12 } from './answers.ts';
import type { GateVerdict } from './rule.ts';
import { reviewedRun } from './rule.ts';

export type CheckPlan =
  | { state: 'waiting' }
  | { state: 'paused'; code: string }
  | { state: 'reviewing' }
  | { state: 'passed' | 'blocked'; verdict: GateVerdict; notReviewed: number; withoutThread: number; refused: number }
  | { state: 'failed'; code: string; evaluated: boolean }   // evaluated: the head has its review and the check could not be decided
  | { state: 'skipped'; actor: string; reason: string }
  | { state: 'bypassed' }
  | { state: 'unwithdrawn'; code: string }       // an approval of the app's that could not be dismissed stands
  | { state: 'withdrawing' };                    // an approval of the app's of another head or base branch stands, its withdrawal under way

export interface CheckFacts {
  gating: 'enforce' | 'shadow' | 'bypass';
  head: string; base: string;                    // the live head, and the merge base
  skip: { actor: string; reason: string } | null;
  job: 'running' | 'pending' | null;             // whether a review of the pull request is under way
  paused: string | null;                         // why reviews are paused, when a job is pending
  runs: StoredRun[];
  unwithdrawn?: string | null;                   // the code of a standing approval's recorded withdrawal failure; absent or null: none
  withdrawing?: boolean;                         // an approval of another head or base branch stands; absent: none
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the check says before any thread is read; null when the head has its review and the threads decide. */
export function planBefore(facts: CheckFacts): CheckPlan | null {
  if (facts.gating === 'bypass') return { state: 'bypassed' };
  // A recorded failure to withdraw outranks a skip and a review (call 19); a code that is not a short code is still one.
  if (facts.unwithdrawn !== undefined && facts.unwithdrawn !== null) {
    return { state: 'unwithdrawn', code: isShortCode(facts.unwithdrawn) ? facts.unwithdrawn : 'internal_error' };
  }
  // A stale approval may count toward the approvals the branch requires: nothing passes while it stands, a skip included.
  if (facts.withdrawing === true) return { state: 'withdrawing' };
  if (facts.skip !== null) return { state: 'skipped', actor: facts.skip.actor, reason: facts.skip.reason };
  if (facts.job === 'running') return { state: 'reviewing' };
  if (facts.job === 'pending') return facts.paused !== null ? { state: 'paused', code: facts.paused } : { state: 'reviewing' };
  if (reviewedRun(facts.runs, facts.head, facts.base) !== null) return null;
  let last: StoredRun | null = null;
  for (const run of facts.runs) {
    if (!run.dryRun && run.headSha === facts.head && (last === null || run.id > last.id)) last = run;
  }
  if (last === null || last.published) return { state: 'waiting' };
  if (last.outcome === 'failed') {
    return { state: 'failed', code: last.failureCode !== null && isShortCode(last.failureCode) ? last.failureCode : 'review_failed', evaluated: false };
  }
  if (last.body === '') {
    if (isObject(last.result) && last.result['nothingToDo'] === true) return { state: 'waiting' };
    return { state: 'failed', code: 'render_failed', evaluated: false };
  }
  return { state: 'failed', code: 'not_published', evaluated: false };
}

/** `refused`: what refusedInline answers for this head and base. */
export function planAfter(verdict: GateVerdict, reviewed: StoredRun, refused: number): CheckPlan {
  const result = isObject(reviewed.result) ? reviewed.result : {};
  const coverage = result['coverage'];
  const notReviewedList = isObject(coverage) ? coverage['notReviewed'] : undefined;
  const notReviewed = Array.isArray(notReviewedList) ? notReviewedList.length : 0;
  const unplaced = Array.isArray(result['unplaced']) ? (result['unplaced'] as unknown[]) : [];
  const unchanged = Array.isArray(result['unchanged']) ? (result['unchanged'] as unknown[]) : [];
  const withoutThread = unplaced.filter((e) => isObject(e) && (e['severity'] === 'major' || e['severity'] === 'blocker')).length + unchanged.length;
  // A count that is not a whole number at or above 0 cannot be read: it blocks, as one refused finding.
  const counted = Number.isInteger(refused) && refused >= 0 ? refused : 1;
  const blocked = verdict.blocking.length > 0 || counted > 0;
  return { state: blocked ? 'blocked' : 'passed', verdict, notReviewed, withoutThread, refused: counted };
}

export interface CheckMeta {
  head: string;
  canSkip: boolean;            // a skip team is named
  clearByReply: boolean;
  retrying: boolean;           // the service will try a failed evaluation again by itself
  threadUrl: (commentId: string) => string;
}
export type CheckText = Pick<CheckWrite, 'status' | 'conclusion' | 'title' | 'summary'>;

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const MAX_LISTED = 50;
const SKIP_LINE = 'The team that may skip can comment `/ai-review-skip <reason>` to let this commit through.';

const shownCode = (code: string): string => (isShortCode(code) ? code : 'internal_error');

/** A path as it may be shown inside a code span: printable ASCII only, a backtick and everything else as `?`; `?` when nothing is left. */
function shownPath(path: string): string {
  const shown = path.replace(/[^\x20-\x7E]|`/g, '?').slice(0, 200);
  return shown === '' ? '?' : shown;
}

function listLine(b: GateVerdict['blocking'][number], meta: CheckMeta): string {
  const where = `${shownPath(b.path)}${b.line !== null ? `:${b.line}` : ''}`;
  let line = `- **\\[${b.severity}]** [\`${where}\`](${meta.threadUrl(b.commentId)})`;
  if (b.why === 'resolved_no_reply') line += ' (resolved with no reply from a person, so it still blocks)';
  if (b.why === 'resolved_reply_off') line += ' (resolved; on this repository only a review clears it)';
  if (b.unread) {
    line += meta.clearByReply
      ? " (the review of this commit did not read this thread's file, so it could not judge it: reply in the thread and resolve it)"
      : " (the review of this commit did not read this thread's file, so it could not judge it: while that stays so, only a skip lets it through)";
  }
  if (b.severity === 'unknown') {
    line += meta.clearByReply
      ? ' (this app has no record of this finding, so no review can clear it: reply in the thread and resolve it)'
      : ' (this app has no record of this finding, so no review can clear it: only a skip lets it through)';
  }
  return line;
}

const WAY_OUT_ON = 'To clear a finding, push a fix, or reply in its thread saying why the code is right, and comment `/done`: the review then says which findings still stand. You can also reply in the thread and resolve it yourself. Resolving a thread without a reply does not clear it.';
const WAY_OUT_OFF = 'To clear a finding, push a fix, or reply in its thread saying why the code is right, and comment `/done`: the review then says which findings still stand. On this repository, resolving a thread yourself does not clear it.';

function blockingList(verdict: GateVerdict, meta: CheckMeta): string {
  const lines = verdict.blocking.slice(0, MAX_LISTED).map((b) => listLine(b, meta));
  if (verdict.blocking.length > MAX_LISTED) lines.push(`- and ${verdict.blocking.length - MAX_LISTED} more`);
  return lines.join('\n');
}

type Counted = Extract<CheckPlan, { state: 'passed' | 'blocked' }>;

function extras(plan: Counted): string[] {
  const out: string[] = [];
  const { clearedByReview: r, clearedByReply: p } = plan.verdict;
  if (r + p > 0) out.push(`Major and blocker findings cleared: ${r} by a review, ${p} by a reply in a resolved thread.`);
  if (plan.notReviewed > 0) out.push(`Files not reviewed: ${plan.notReviewed}. The review lists them under Coverage, and this check is decided on the files that were reviewed.`);
  if (plan.withoutThread > 0) out.push(`Major and blocker findings the review could not place on the diff, or raised on code unchanged since the last review: ${plan.withoutThread}. The review lists them, and they do not block.`);
  return out;
}

// Control characters, and the characters that change the direction of text.
const UNSHOWN = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** The skip's reason as one code span: white space collapsed, control and direction characters removed, each backtick an apostrophe, at most 300 code points; `?` when nothing is left. Nothing in it is live. */
function skipReasonShown(reason: string): string {
  const flat = reason.replace(/\s+/g, ' ').replace(UNSHOWN, '').replace(/\s+/g, ' ').trim().replace(/`/g, "'");
  const cut = Array.from(flat).slice(0, 300).join('').trim();
  return `\`${cut === '' ? '?' : cut}\``;
}

function make(status: CheckText['status'], conclusion: CheckText['conclusion'], title: string, paragraphs: string[]): CheckText {
  return { status, conclusion, title, summary: paragraphs.join('\n\n') };
}

export function checkText(plan: CheckPlan, meta: CheckMeta): CheckText {
  const skipLine = meta.canSkip ? [SKIP_LINE] : [];
  switch (plan.state) {
    case 'waiting':
      return make('queued', null, 'Waiting for /done', ['Comment `/done` on this pull request when it is ready to be reviewed. The review then decides this check: a finding marked major or blocker has to be fixed or answered before the merge.']);
    case 'reviewing':
      return make('in_progress', null, 'Reviewing', ['A review of this pull request is under way or waiting for its turn. Its findings arrive as inline comments with one review, and this check is decided when the review is posted.']);
    case 'paused': {
      const text = plan.code === 'spend_limit'
        ? 'A review of this pull request was asked for and has not started: this deployment has reached its daily spending limit. Reviews start again with the next UTC day, and this one then starts by itself.'
        : "A review of this pull request was asked for and has not started: reviews are paused on the reviewer's side. This one starts by itself when they resume.";
      return make('queued', null, `Review waiting: reviews are paused (${shownCode(plan.code)})`, [text, ...skipLine]);
    }
    case 'passed': {
      const f = plan.verdict.findings;
      const base = f === 0 ? 'No blocking findings' : f === 1 ? '1 finding, none blocking' : `${f} findings, none blocking`;
      return make('completed', 'success', base + notReviewedSuffix(plan), ['Nothing blocks this merge.', ...extras(plan)]);
    }
    case 'blocked': {
      const n = plan.verdict.blocking.length;
      const m = plan.refused;
      const base = m > 0 ? `Blocking findings open: ${n + m} (${m} listed in the review only)` : n === 1 ? '1 blocking finding is open' : `${n} blocking findings are open`;
      const paragraphs: string[] = [];
      if (n > 0) paragraphs.push('These threads block the merge:', blockingList(plan.verdict, meta), meta.clearByReply ? WAY_OUT_ON : WAY_OUT_OFF);
      if (m > 0) {
        paragraphs.push(
          `GitHub refused the inline comments of the review of this commit, so its findings could not be opened as threads. Major and blocker findings among them: ${m}. They are listed in the review, and they block this merge.`,
          'To clear them, push a fix and comment `/done`: the review of the new commit decides.');
      }
      return make('completed', 'action_required', base + notReviewedSuffix(plan), [...paragraphs, ...extras(plan), ...skipLine]);
    }
    case 'failed': {
      const code = shownCode(plan.code);
      if (!plan.evaluated) {
        return make('completed', 'failure', `Review failed (${code}): comment /done to retry`,
          [`The review of this commit did not finish or was not posted (\`${code}\`). Comment \`/done\` to run it again.`, ...skipLine]);
      }
      const text = meta.retrying
        ? `The review was posted, but its threads could not be read to decide this check (\`${code}\`). The service tries again by itself. You can also comment \`/done\`.`
        : `The review was posted, but its threads could not be read to decide this check (\`${code}\`). Comment \`/done\` to try again.`;
      return make('completed', 'failure', `Could not evaluate (${code}): comment /done to retry`, [text, ...skipLine]);
    }
    case 'skipped': {
      const named = LOGIN.test(plan.actor);
      return make('completed', 'success', named ? `Skipped by @${plan.actor}` : 'Skipped by a team member', [
        `The review was skipped for commit \`${head12(meta.head)}\` by ${named ? `\`${plan.actor}\`` : 'a team member'}.`,
        `Reason: ${skipReasonShown(plan.reason)}`,
        'A new commit ends the skip: its check waits for `/done` again.',
      ]);
    }
    case 'bypassed':
      return make('completed', 'success', 'Gate bypassed', ["The merge gate is in bypass mode for this repository, so this check passes without a review. When bypass is switched off, the check goes back to what the gate's rule says."]);
    case 'unwithdrawn': {
      // No skip line: a skip does not pass it.
      const code = shownCode(plan.code);
      return make('completed', 'failure', `Earlier approval not withdrawn (${code})`, [
        `This reviewer approved an earlier commit of this pull request, or gave an approval it no longer stands behind, and could not dismiss it (\`${code}\`). While it stands it may count toward the approvals this branch requires, so this check fails.`,
        "Dismiss that approval on the pull request's page. The service also tries again at the next commit, the next review of this pull request and its next start, and this check is decided again once the approval is gone.",
      ]);
    }
    case 'withdrawing':
      // No skip line: a skip does not pass it.
      return make('in_progress', null, 'Withdrawing an earlier approval', [
        'This reviewer approved an earlier commit of this pull request, or another base branch, and is dismissing that approval. While it stands it may count toward the approvals this branch requires, so this check waits, and a skip does not pass it.',
        'The check is decided again once the approval is gone, usually within seconds. If it cannot be dismissed, this check fails and says why.',
      ]);
  }
}

function notReviewedSuffix(plan: Counted): string {
  if (plan.notReviewed === 0) return '';
  return plan.notReviewed === 1 ? '; 1 file not reviewed' : `; ${plan.notReviewed} files not reviewed`;
}

/** The current check is there and says the same. */
export function sameCheck(current: OwnCheck | null, wanted: CheckText): boolean {
  return current !== null && current.status === wanted.status && current.conclusion === wanted.conclusion
    && current.title === wanted.title && current.summary === wanted.summary;
}

/** The numbers a plan puts into the record of an evaluation. */
export function countsOf(plan: CheckPlan): GateCounts {
  if (plan.state !== 'passed' && plan.state !== 'blocked') return NO_COUNTS;
  const v = plan.verdict;
  return {
    blocking: v.blocking.length, clearedByReview: v.clearedByReview, clearedByReply: v.clearedByReply,
    silentResolves: v.silentResolves, unknownThreads: v.unknownThreads, findings: v.findings,
    notReviewed: plan.notReviewed, withoutThread: plan.withoutThread, refusedInline: plan.refused,
  };
}
