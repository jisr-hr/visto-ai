// The two answers of the One review screen (UI design 3.3 and 3.4; calls 5 to 17 and 24): one review, and the reviews of a pull
// request. Each is built field by field from an allowlist, out of the reads of src/db/review-page.ts and the readers of
// review-result.ts and threads.ts: nothing a person wrote, no quote, id of another system or text of the stored result leaves here.
import {
  approvalsUpTo, gateAt, laterVerdicts, pendingWithdrawal, pullRuns, runComments, runFeedback, runOf, threadEvents,
} from '../db/review-page.ts';
import type { ApprovalRow, RunRow } from '../db/review-page.ts';
import type { PullRequestRef } from '../forge/types.ts';
import { isShortCode } from '../shell/codes.ts';
import { REQUESTER_SHOWN } from './api.ts';
import type { ApiDeps } from './api.ts';
import type {
  ApprovalDecision, ApprovalEntry, FeedbackReason, GateShown, OneReview, Posting, PullReviews, ReviewFinding,
} from './api-types.ts';
import {
  countsOf, dependenciesOf, earlierOf, filesOf, findingsOf, FINDINGS_SHOWN, modelsOf, nothingNew, paragraphOf, readOf, thresholdOf,
} from './review-result.ts';
import type { ReadFinding } from './review-result.ts';
import { commentsOf, signalsOf, threadOf } from './threads.ts';

export const APPROVALS_SHOWN = 20;
export const REASONS_SHOWN = 20;
export const PULL_RUNS_SHOWN = 200;
/** A login of GitHub's shape, on the stored lower-cased value (call 15). */
export const FEEDBACK_LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const HEAD_SHOWN = 12;

const codeOrUnknown = (value: string | null): string => (value !== null && isShortCode(value) ? value : 'unknown');
const codeOrNull = (value: string | null): string | null => (value !== null && isShortCode(value) ? value : null);

function postingOf(row: RunRow): Posting {
  if (row.outcome === 'failed') return 'failed';
  if (row.dry_run) return 'dry_run';
  if (row.published) return 'published';
  return nothingNew(row.result) ? 'nothing_new' : 'not_posted';
}

/** Call 7: a published run is approved, or not approved when it carries an approval code, else not decided. */
function decisionOf(row: RunRow, posting: Posting): ApprovalDecision {
  if (posting !== 'published') return posting;
  if (row.approved) return 'approved';
  return row.approval_code !== null ? 'not_approved' : 'not_decided';
}

function approvalEntry(row: ApprovalRow, retry: Date | null): ApprovalEntry {
  const base = { run: row.run, ordinal: row.ordinal, head: row.head_sha.slice(0, HEAD_SHOWN), stoodAtMerge: row.stood_at_merge !== null };
  if (row.dismissed_at !== null) {
    return { ...base, state: row.dismissed_by === 'app' ? 'withdrawn' : 'dismissed_on_github', code: null, retryAt: null };
  }
  if (row.dismiss_failure !== null) {
    return { ...base, state: 'withdrawal_failed', code: codeOrUnknown(row.dismiss_failure), retryAt: retry === null ? null : retry.toISOString() };
  }
  return { ...base, state: 'stands', code: null, retryAt: null };
}

/** The thread of each placed finding of a published run (the key is the finding itself); a run not published has none to read. */
async function threadsOf(deps: ApiDeps, row: RunRow, ref: PullRequestRef, placed: readonly ReadFinding[]): Promise<Map<ReadFinding, ReviewFinding['thread']>> {
  const threads = new Map<ReadFinding, ReviewFinding['thread']>();
  if (!row.published) return threads;
  const ids = commentsOf(placed, await runComments(deps.db, row.id));
  const present = ids.filter((id): id is string => id !== null);
  const signals = present.length > 0
    ? signalsOf(await threadEvents(deps.db, ref, present), await laterVerdicts(deps.db, ref, row.id, present))
    : signalsOf([], []);
  placed.forEach((finding, i) => {
    const id = ids[i]!;
    threads.set(finding, id === null ? { state: 'no_thread', by: null } : threadOf(signals.get(id) ?? []));
  });
  return threads;
}

export async function review(deps: ApiDeps, run: number): Promise<OneReview | null> {
  const row = await runOf(deps.db, run);
  if (row === null) return null;
  const ref: PullRequestRef = { service: row.service, owner: row.owner, repo: row.repo, number: row.number };
  const all = findingsOf(row.result);
  const threads = await threadsOf(deps, row, ref, all.filter((f) => f.kind === 'placed'));
  const gateRow = await gateAt(deps.db, ref, row.head_sha);
  const approvalRows = await approvalsUpTo(deps.db, ref, row.id, APPROVALS_SHOWN);
  const pending = approvalRows.some((a) => a.dismiss_failure !== null) ? await pendingWithdrawal(deps.db, ref) : null;
  const feedback = await runFeedback(deps.db, row.id, REASONS_SHOWN);

  const posting = postingOf(row);
  const decision = decisionOf(row, posting);
  const decided = decision === 'approved' || decision === 'not_approved';
  const gate: GateShown | null = gateRow === null ? null : {
    mode: codeOrUnknown(gateRow.mode), state: codeOrUnknown(gateRow.state), code: codeOrNull(gateRow.code), blocking: gateRow.blocking + gateRow.refused_inline,
  };
  const files = filesOf(row.result);
  const shown = all.slice(0, FINDINGS_SHOWN);
  const reasons: FeedbackReason[] = feedback.reasons.map((r) => ({ reason: r.reason, login: FEEDBACK_LOGIN.test(r.login) ? r.login : null }));
  const reason = row.job_reason ?? (isShortCode(row.trigger) ? row.trigger : 'unknown');
  return {
    now: deps.clock().toISOString(), run: row.id, ordinal: row.ordinal, runs: row.runs,
    pullRequest: {
      repository: `${row.owner}/${row.repo}`, number: row.number, title: row.title, author: row.author, headBranch: row.head_branch,
      baseBranch: row.base_branch ?? row.pr_base_branch, url: deps.pullRequestUrl(ref),
    },
    head: row.head_sha.slice(0, HEAD_SHOWN),
    askedBy: { reason, login: REQUESTER_SHOWN.has(reason) ? row.job_requested_by : null },
    mode: row.mode, posting,
    failure: row.outcome === 'failed' ? { stage: codeOrUnknown(row.failure_stage), code: codeOrNull(row.failure_code) } : null,
    startedAt: row.started_at.toISOString(), finishedAt: row.finished_at.toISOString(),
    publishedAt: row.published_at === null ? null : row.published_at.toISOString(),
    approval: {
      decision,
      code: decided && row.approval_code !== null ? codeOrUnknown(row.approval_code) : null,
      text: decided && row.approval_code !== null ? paragraphOf(row.body_tail, row.approved) : null,
    },
    gate, threshold: thresholdOf(row.result),
    files: files.files, filesCut: files.cut, read: readOf(row.result),
    findings: shown.map((finding) => ({
      kind: finding.kind, severity: finding.severity, path: finding.path, side: finding.side, line: finding.line, body: finding.body,
      thread: finding.kind !== 'placed' ? { state: 'none', by: null } : row.published ? threads.get(finding)! : { state: 'not_posted', by: null },
    })),
    findingsCut: all.length - shown.length, counts: countsOf(all), earlier: earlierOf(row.result),
    usage: {
      models: modelsOf(row.result), calls: row.calls, inputTokens: row.input_tokens, cachedTokens: row.cached_tokens,
      outputTokens: row.output_tokens, cost: row.cost,
    },
    approvals: approvalRows.map((a) => approvalEntry(a, pending === null ? null : pending.run_at)),
    dependencies: dependenciesOf(row.result),
    feedback: { helpful: feedback.up, notHelpful: feedback.down, reasons },
  };
}

export async function pullReviews(deps: ApiDeps, ref: PullRequestRef): Promise<PullReviews> {
  const rows = await pullRuns(deps.db, ref, PULL_RUNS_SHOWN);
  return {
    now: deps.clock().toISOString(), total: rows[0]?.total ?? 0,
    reviews: rows.map((r) => ({ run: r.id, ordinal: r.ordinal, at: r.finished_at.toISOString() })),
  };
}
