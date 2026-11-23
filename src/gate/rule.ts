import type { StoredComment } from '../db/review-comments.ts';
import { NOTE } from '../db/review-comments.ts';
import type { StoredRun } from '../db/review-runs.ts';
import type { ReviewThread, ThreadComment } from '../forge/types.ts';

export interface Blocking {
  thread: string; commentId: string;            // the thread, and its first comment
  path: string; line: number | null;
  severity: 'blocker' | 'major' | 'unknown';    // unknown: the app's own thread with no stored finding
  why: 'open' | 'resolved_no_reply' | 'resolved_reply_off';
  unread: boolean;                              // the head's review kept no verdict on it and did not read its file
}
export interface GateVerdict {
  blocking: Blocking[];        // the lowest first comment first
  clearedByReview: number; clearedByReply: number;
  silentResolves: number;      // blocking threads that are resolved
  unknownThreads: number;      // blocking threads of unknown severity
  findings: number;            // the app's own threads that are a blocker, a major, a minor or unknown, cleared or not
}

type Severity = 'blocker' | 'major' | 'minor' | 'unknown' | 'note';
interface Verdict { verdict: 'fixed' | 'answered' | 'open'; replies: number | null }

const VERDICTS: readonly unknown[] = ['fixed', 'answered', 'open'];
const GATING: readonly unknown[] = ['blocker', 'major'];
// When the stored rows disagree on one comment, the one that gates the most wins.
const RANK: Record<Severity, number> = { blocker: 4, major: 3, unknown: 2, minor: 1, note: 0 };

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPerson = (c: ThreadComment): boolean => c.byApp === false && c.authorIsBot === false;
const cleared = (v: Verdict | 'damaged' | null): v is Verdict => v !== null && v !== 'damaged' && (v.verdict === 'fixed' || v.verdict === 'answered');

/** A run's verdict on a thread: the first entry that is an object with the thread's id and a known word decides. `damaged` when that entry's `replies` is present and not a whole number at or above 0: no verdict, and no older run's verdict stands in for it. */
function verdictOf(run: StoredRun, threadId: string): Verdict | 'damaged' | null {
  const list = asArray(isObject(run.result) ? run.result['threadVerdicts'] : undefined);
  for (const v of list) {
    if (!isObject(v) || v['threadId'] !== threadId || !VERDICTS.includes(v['verdict'])) continue;
    const replies = v['replies'];
    if (replies === undefined) return { verdict: v['verdict'] as Verdict['verdict'], replies: null };
    if (typeof replies === 'number' && Number.isInteger(replies) && replies >= 0) return { verdict: v['verdict'] as Verdict['verdict'], replies };
    return 'damaged';
  }
  return null;
}

/** The paths the run read, or null when its coverage cannot be read. */
function readPaths(run: StoredRun): Set<string> | null {
  const coverage = isObject(run.result) ? run.result['coverage'] : undefined;
  const reviewed = isObject(coverage) ? coverage['reviewed'] : undefined;
  if (!Array.isArray(reviewed)) return null;
  return new Set(reviewed.filter((p): p is string => typeof p === 'string'));
}

function severityOf(word: string): Severity {
  if (word === 'blocker' || word === 'major' || word === 'minor') return word;
  return word === NOTE ? 'note' : 'unknown';
}

/** Orders comment ids as numbers when both are digits, else as text. */
function byId(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b) && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

const isReviewOf = (run: StoredRun, head: string, base: string): boolean =>
  run.published && !run.dryRun && run.headSha === head && run.baseSha === base;

/** The newest published run of these, not a dry run, whose head and base are the ones given; null when there is none. */
export function reviewedRun(runs: StoredRun[], head: string, base: string): StoredRun | null {
  let best: StoredRun | null = null;
  for (const run of runs) {
    if (isReviewOf(run, head, base) && (best === null || run.id > best.id)) best = run;
  }
  return best;
}

/** How many major and blocker findings the newest published review of this head and base that was posted without its inline comments had placed on the diff; 0 when there is no such review. A stored result that cannot be read (not an object, or its `findings` not a list) counts as 1: it is not read as none (call 51). */
export function refusedInline(runs: StoredRun[], head: string, base: string): number {
  let best: { id: number; count: number } | null = null;
  for (const run of runs) {
    if (!isReviewOf(run, head, base) || !run.inlineDropped) continue;
    const findings = isObject(run.result) ? run.result['findings'] : undefined;
    const count = Array.isArray(findings) ? findings.filter((f) => isObject(f) && GATING.includes(f['severity'])).length : 1;
    if (count > 0 && (best === null || run.id > best.id)) best = { id: run.id, count };
  }
  return best === null ? 0 : best.count;
}

/** Which threads block the merge. Pure; reads no comment's text; never throws on a damaged run. */
export function evaluateGate(args: {
  threads: ReviewThread[]; stored: Array<StoredComment & { run: number }>; runs: StoredRun[];
  reviewed: StoredRun;         // the head's review
  clearByReply: boolean;
}): GateVerdict {
  const severities = new Map<string, Severity>();
  for (const s of args.stored) {
    const severity = severityOf(s.severity);
    const known = severities.get(s.commentId);
    if (known === undefined || RANK[severity] > RANK[known]) severities.set(s.commentId, severity);
  }
  const published = args.runs.filter((r) => r.published).sort((a, b) => b.id - a.id);
  const read = readPaths(args.reviewed);
  const verdict: GateVerdict = { blocking: [], clearedByReview: 0, clearedByReply: 0, silentResolves: 0, unknownThreads: 0, findings: 0 };
  const seen = new Set<string>();
  for (const t of args.threads) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const comments = Array.isArray(t.comments) ? t.comments : [];
    const first = comments[0];
    if (first === undefined || first.byApp !== true) continue;
    const severity = severities.get(first.id) ?? 'unknown';
    if (severity === 'note') continue;
    verdict.findings += 1;
    if (severity === 'minor') continue;

    const kept = verdictOf(args.reviewed, t.id);
    const personReplied = comments.slice(1).some(isPerson);
    const verified = cleared(kept) && (kept.replies === null || comments.slice(1 + kept.replies).every((c) => c.byApp === true));
    if (verified) { verdict.clearedByReview += 1; continue; }
    if (t.resolved === true && t.resolvedByApp === true) {
      // The newest run with an entry on the thread decides; a damaged one clears nothing.
      let newest: Verdict | 'damaged' | null = null;
      for (const run of published) { newest = verdictOf(run, t.id); if (newest !== null) break; }
      if (cleared(newest)) { verdict.clearedByReview += 1; continue; }
    }
    if (args.clearByReply && t.resolved === true && personReplied) { verdict.clearedByReply += 1; continue; }

    const resolved = t.resolved === true;
    const why: Blocking['why'] = !resolved ? 'open' : personReplied ? 'resolved_reply_off' : 'resolved_no_reply';
    const unread = severity !== 'unknown' && kept === null && read !== null && !read.has(t.path);
    verdict.blocking.push({ thread: t.id, commentId: first.id, path: t.path, line: t.line, severity, why, unread });
    if (resolved) verdict.silentResolves += 1;
    if (severity === 'unknown') verdict.unknownThreads += 1;
  }
  verdict.blocking.sort((a, b) => byId(a.commentId, b.commentId));
  return verdict;
}
