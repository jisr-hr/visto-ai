import type { ApprovalThreads } from '../config/load.ts';
import type { StoredRun } from '../db/review-runs.ts';
import type { Association, ReviewThread, ThreadComment } from '../forge/types.ts';

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
