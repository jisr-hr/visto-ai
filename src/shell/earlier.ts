import type { StoredComment } from '../db/review-comments.ts';
import type { StoredRun } from '../db/review-runs.ts';
import type { EarlierReply, EarlierState, EarlierThread, Severity } from '../engine/types.ts';
import { hasMarker } from '../engine/render/thread-reply.ts';
import type { PostedComment, ReviewThread } from '../forge/types.ts';
import { matchPosted } from './posted.ts';

type Stored = StoredComment & { run: number };
type Verdict = 'fixed' | 'answered' | 'open';

const SEVERITIES: readonly string[] = ['blocker', 'major', 'minor'];
const VERDICTS: readonly unknown[] = ['fixed', 'answered', 'open'];

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The verdict a run kept on a thread, or null. */
function verdictOf(run: StoredRun, threadId: string): Verdict | null {
  const list = asArray(isObject(run.result) ? run.result['threadVerdicts'] : undefined);
  for (const v of list) {
    if (isObject(v) && v['threadId'] === threadId && VERDICTS.includes(v['verdict'])) return v['verdict'] as Verdict;
  }
  return null;
}

/** The diff hash of the score for `path` in a run's stored result, or null. */
function diffHashOf(run: StoredRun, path: string): string | null {
  for (const s of asArray(isObject(run.result) ? run.result['scores'] : undefined)) {
    if (isObject(s) && s['path'] === path) return typeof s['diffHash'] === 'string' ? s['diffHash'] : null;
  }
  return null;
}

/** First comments of threads that belong to a review this service published and are not stored, each tied to its finding. */
export function missedComments(args: { runs: StoredRun[]; stored: Stored[]; threads: ReviewThread[] }): Stored[] {
  const known = new Set(args.stored.map((s) => s.commentId));
  const missed: Stored[] = [];
  for (const run of args.runs) {
    if (!run.published || run.reviewId === null) continue;
    const posted: PostedComment[] = args.threads
      .filter((t) => t.comments[0]!.reviewId === run.reviewId)
      .map((t) => ({ id: t.comments[0]!.id, path: t.path, side: t.side, line: t.line, body: t.comments[0]!.body }));
    for (const m of matchPosted(run, posted)) {
      if (!known.has(m.commentId)) missed.push({ ...m, run: run.id });
    }
  }
  return missed;
}

/** What the engine is told about the pull request's earlier review and its threads. */
export function earlierOf(args: { last: StoredRun; runs: StoredRun[]; stored: Stored[]; threads: ReviewThread[] }): EarlierState {
  const byComment = new Map(args.stored.filter((s) => SEVERITIES.includes(s.severity)).map((s) => [s.commentId, s]));
  const newestFirst = args.runs.filter((r) => r.published).sort((a, b) => b.id - a.id);
  const threads: EarlierThread[] = [];
  const listed = new Set<string>();
  for (const t of args.threads) {
    if (listed.has(t.id)) continue;
    listed.add(t.id);
    const first = t.comments[0]!;
    const row = byComment.get(first.id);
    if (row === undefined) continue;
    const opened = args.runs.find((r) => r.id === row.run);
    const replies: EarlierReply[] = t.comments.slice(1).map((c) => ({
      author: c.author, kind: c.byApp ? 'app' : c.authorIsBot ? 'bot' : 'person', body: c.body,
    }));
    let lastVerdict: Verdict | null = null;
    for (const r of newestFirst) {
      lastVerdict = verdictOf(r, t.id);
      if (lastVerdict !== null) break;
    }
    threads.push({
      id: t.id, commentId: first.id, path: t.path, side: t.side, line: t.line,
      severity: row.severity as Severity, quote: row.quote, body: first.body,
      openedAt: { head: opened === undefined ? '' : opened.headSha, diffHash: opened === undefined ? null : diffHashOf(opened, row.path) },
      resolved: t.resolved,
      // The app resolved it only when the app's own reply with a marker stands in the thread too: a login alone proves nothing.
      settled: t.resolved && ((t.resolvedByApp && t.comments.some((c) => c.byApp && hasMarker(c.body))) || replies.some((r) => r.kind === 'person')),
      lastVerdict, replies,
    });
  }
  threads.sort((a, b) => Number(a.commentId) - Number(b.commentId));
  return { head: args.last.headSha, threads };
}
