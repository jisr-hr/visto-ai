import type { ApprovalThreads } from '../config/load.ts';
import type { StoredComment } from '../db/review-comments.ts';
import { NOTE } from '../db/review-comments.ts';
import type { StoredRun } from '../db/review-runs.ts';
import type { Association, ReviewThread, ThreadComment } from '../forge/types.ts';
import { evaluateGate, storedSeverities } from '../gate/rule.ts';

export interface ThreadContext { rule: ApprovalThreads; author: string; clearByReply: boolean; published: StoredRun[] }
interface Verdict { verdict: 'fixed' | 'answered' | 'open'; fileChanged: boolean; replies: number | null }

const VERDICTS: readonly unknown[] = ['fixed', 'answered', 'open'];
// Access, as the git service reports it for the comment; absent or any other word is none (call 6).
const ACCESS: readonly unknown[] = ['owner', 'member', 'collaborator'] satisfies Association[];

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPerson = (c: ThreadComment): boolean => c.byApp === false && c.authorIsBot === false;
const repliesOf = (thread: ReviewThread): ThreadComment[] => (Array.isArray(thread.comments) ? thread.comments.slice(1) : []);

/** A run's verdict on a thread, read as the gate's `verdictOf` reads one; `fileChanged` is false unless it is true or false. */
function verdictOf(run: StoredRun, threadId: string): Verdict | 'damaged' | null {
  for (const v of asArray(isObject(run.result) ? run.result['threadVerdicts'] : undefined)) {
    if (!isObject(v) || v['threadId'] !== threadId || !VERDICTS.includes(v['verdict'])) continue;
    const word = v['verdict'] as Verdict['verdict'];
    const fileChanged = typeof v['fileChanged'] === 'boolean' ? v['fileChanged'] : false;
    const replies = v['replies'];
    if (replies === undefined) return { verdict: word, fileChanged, replies: null };
    if (typeof replies === 'number' && Number.isInteger(replies) && replies >= 0) return { verdict: word, fileChanged, replies };
    return 'damaged';
  }
  return null;
}

/** The verdict the newest published run that has one kept on a thread (rule 1); null when none, 'damaged' when that entry cannot be read. */
export function newestVerdict(published: StoredRun[], threadId: string): Verdict | 'damaged' | null {
  // The newest run with an entry decides; a damaged one gives no verdict, and no older run stands in for it.
  for (const run of [...published].sort((a, b) => b.id - a.id)) {
    const found = verdictOf(run, threadId);
    if (found !== null) return found;
  }
  return null;
}

/** A person other than `author` (compared without letter case), with access, wrote a reply in the thread. */
export function accessReplied(thread: ReviewThread, author: string): boolean {
  // An author that cannot be read cannot be told apart from anyone: no reply counts.
  if (typeof author !== 'string') return false;
  const who = author.toLowerCase();
  return repliesOf(thread).some((c) => isPerson(c) && typeof c.author === 'string' && c.author.toLowerCase() !== who && ACCESS.includes(c.association));
}

/** The second half of the thread rule: resolved, and closed without a further verdict. Pure. */
export function closedBefore(thread: ReviewThread, ctx: ThreadContext): boolean {
  if (thread.resolved !== true) return false;
  const byApp = thread.resolvedByApp === true;
  const newest = byApp ? newestVerdict(ctx.published, thread.id) : null;
  const known = newest !== null && newest !== 'damaged' ? newest : null;
  if (ctx.rule === 'strict') {
    return (byApp && known !== null && known.verdict === 'fixed' && known.fileChanged === true) || accessReplied(thread, ctx.author);
  }
  if (ctx.rule === 'gate') {
    return (byApp && known !== null && (known.verdict === 'fixed' || known.verdict === 'answered')) || (ctx.clearByReply === true && repliesOf(thread).some(isPerson));
  }
  // A rule this code does not know closes nothing.
  return false;
}

/** How many threads and lost threads are open for approval once `run` is posted as the head's review. Pure; never throws. */
export function openForApproval(args: {
  threads: ReviewThread[]; stored: Array<StoredComment & { run: number }>; runs: StoredRun[]; run: StoredRun;
  rule: ApprovalThreads; author: string; clearByReply: boolean;
}): number {
  const { run, rule, author } = args;
  // What cannot be read is never closed: a list or this run that cannot be read is open, and so is each row or run that is no object.
  if (!Array.isArray(args.threads) || !Array.isArray(args.stored) || !Array.isArray(args.runs) || !isObject(run)) return 1;
  const stored = args.stored.filter((s) => isObject(s));
  const runs = args.runs.filter((r) => isObject(r));
  let open = args.stored.length - stored.length + args.runs.length - runs.length;
  const clearByReply = args.clearByReply === true;
  const severities = storedSeverities(stored);
  const others = runs.filter((r) => r.id !== run.id);
  const asHead: StoredRun = { ...run, published: true };
  // This run's verdicts that are no list: no thread can be told it was not kept open.
  const verdicts = isObject(run.result) ? run.result['threadVerdicts'] : null;
  const readable = verdicts === undefined || Array.isArray(verdicts);

  // Rule 1: each listed thread once, the app's own, of a severity that counts; and the app's first comments the list holds (rule 5).
  const counted: Array<{ thread: ReviewThread; severity: 'blocker' | 'major' | 'unknown' }> = [];
  const appFirst = new Set<string>();
  const seen = new Set<unknown>();
  for (const t of args.threads) {
    if (!isObject(t)) { open += 1; continue; }
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const comments = Array.isArray(t.comments) ? t.comments : [];
    const first = comments[0];
    // A first comment that cannot be read cannot be told the app's or not.
    if (!isObject(first) || typeof first.byApp !== 'boolean') { open += 1; continue; }
    if (!first.byApp) continue;
    appFirst.add(first.id);
    const severity = severities.get(first.id) ?? 'unknown';
    if (severity === 'note' || severity === 'minor') continue;
    if (!readable || !comments.every((c) => isObject(c))) { open += 1; continue; }
    counted.push({ thread: t, severity });
  }

  // Rule 3: the gate, with this run as the head's review and as published.
  const blocking = rule === 'gate'
    ? new Set(evaluateGate({ threads: counted.map((c) => c.thread), stored, runs: [...others, asHead], reviewed: asHead, clearByReply }).blocking.map((b) => b.thread))
    : null;
  const before: ThreadContext = { rule: 'strict', author, clearByReply, published: others.filter((r) => r.published) };
  for (const { thread: t, severity } of counted) {
    // Rule 2: a thread this run kept open is open under both rules, and so is one whose verdict of this run cannot be read.
    const kept = newestVerdict([run], t.id);
    if (kept === 'damaged' || kept?.verdict === 'open') { open += 1; continue; }
    if (blocking !== null) { if (blocking.has(t.id)) open += 1; continue; }
    // A rule this code does not know closes nothing.
    if (rule !== 'strict') { open += 1; continue; }
    // Rule 4. The app's own thread with no stored finding closes only by a reply of case 2 (call 27).
    if (severity === 'unknown') { if (!(t.resolved === true && accessReplied(t, author))) open += 1; continue; }
    // Case 1: this run verified the fix in changed code, and no one but the app wrote after the replies it judged.
    const verified = kept !== null && kept.verdict === 'fixed' && kept.fileChanged
      && (kept.replies === null || t.comments.slice(1 + kept.replies).every((c) => c.byApp === true));
    if (!verified && !closedBefore(t, before)) open += 1;
  }

  // Rule 5: a stored blocker or major of a published run, not a dry run, whose comment is not the first of an app's own listed thread.
  const runOf = new Map(runs.map((r) => [r.id, r]));
  const lost = new Set<string>();
  for (const s of stored) {
    // A word that is no severity reads as the gate reads it, unknown, and counts: it cannot be told a minor or a note.
    if (s.severity === 'minor' || s.severity === NOTE) continue;
    // A row of a run the list does not hold cannot be told unpublished: it counts.
    const of = runOf.get(s.run);
    if (of !== undefined && (of.published === false || of.dryRun === true)) continue;
    if (!appFirst.has(s.commentId)) lost.add(s.commentId);
  }
  // Rule 6.
  return open + lost.size;
}
