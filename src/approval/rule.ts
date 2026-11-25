import type { StoredRun } from '../db/review-runs.ts';
import type { PullRequestInfo } from '../forge/types.ts';

/** The decision a publication ends with: `approved`, or the first condition of 6.4 that did not hold. */
export type ApprovalCode =
  | 'approved' | 'record_unreadable' | 'not_covered' | 'needs_human' | 'blocking_finding' | 'finding_without_thread'
  | 'draft' | 'from_fork' | 'origin_unknown' | 'threads_unreadable' | 'open_thread' | 'rule_unreadable' | 'rule_off' | 'refused' | 'audit_sample';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// The engine's severities. A word that is none of them cannot be told a minor, so it cannot be read.
const SEVERITIES: readonly unknown[] = ['blocker', 'major', 'minor'];
const readable = (entry: unknown): entry is Record<string, unknown> => isObject(entry) && SEVERITIES.includes(entry['severity']);
const isBlocking = (entry: Record<string, unknown>): boolean => entry['severity'] === 'major' || entry['severity'] === 'blocker';
const below = (value: unknown, threshold: number): boolean => typeof value === 'number' && value < threshold;

/** A list a stored result may lack: absent is none; present and no list cannot be read (null). */
function optionalList(result: Record<string, unknown>, key: string): unknown[] | null {
  const value = result[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : null;
}

/** Conditions 2, 3 and 4 as the stored runs tell them; the first that fails, or null. `runs`: every run of the pull request. Pure. */
export function storedRefusal(run: StoredRun, runs: StoredRun[], threshold: number): ApprovalCode | null {
  // (a) The shape this rule reads.
  if (!isObject(run)) return 'record_unreadable';
  const result = run.result;
  if (!isObject(result)) return 'record_unreadable';
  const { scores, findings, unplaced, coverage, verdict } = result;
  if (!Array.isArray(scores) || !Array.isArray(findings) || !Array.isArray(unplaced)) return 'record_unreadable';
  if (!isObject(coverage) || !Array.isArray(coverage['notReviewed']) || !isObject(verdict)) return 'record_unreadable';

  // (b) Condition 2: every file covered at this head, none left unreviewed.
  if (scores.length === 0 || !scores.every((s) => isObject(s) && s['covered'] === true) || coverage['notReviewed'].length > 0) return 'not_covered';

  // (c) Condition 3, against the threshold in force now, whatever the run was scored with.
  const files = scores as Array<Record<string, unknown>>;
  if (verdict['needsHuman'] !== false || !below(verdict['highest'], threshold) || !files.every((s) => below(s['finalScore'], threshold))) return 'needs_human';

  // (d) Condition 4, this review. Beyond the diff is never read (5.6, step 4).
  const unchanged = optionalList(result, 'unchanged');
  if (unchanged === null) return 'record_unreadable';
  const own = [...findings, ...unplaced, ...unchanged];
  if (!own.every(readable)) return 'record_unreadable';
  if (own.some(isBlocking)) return 'blocking_finding';

  // (e) Condition 4, every run: the published runs that are not dry runs, and this one as handed in.
  if (!Array.isArray(runs) || !runs.every((r) => isObject(r))) return 'record_unreadable';
  // A run that cannot be told unpublished or not a dry run is read.
  const others = runs.filter((r) => r.id !== run.id && r.published !== false && r.dryRun !== true);
  const left = withoutThread([...others, run]);
  if (left === null) return 'record_unreadable';
  return left > 0 ? 'finding_without_thread' : null;
}

/** Major and blocker findings these runs left without a thread; null when a result cannot be read. Pure. */
export function withoutThread(runs: StoredRun[]): number | null {
  if (!Array.isArray(runs)) return null;
  let total = 0;
  for (const run of runs) {
    if (!isObject(run)) return null;
    const result = run.result;
    if (!isObject(result)) return null;
    const unplaced = optionalList(result, 'unplaced');
    const unchanged = optionalList(result, 'unchanged');
    const discussed = optionalList(result, 'alreadyDiscussed');
    if (unplaced === null || unchanged === null || discussed === null) return null;
    // A run posted without its inline comments left its placed findings without a thread; one that cannot be told posted with them, too.
    const placed = run.inlineDropped === false ? [] : result['findings'];
    if (!Array.isArray(placed)) return null;
    const entries = [...unplaced, ...placed, ...unchanged];
    if (!entries.every(readable)) return null;
    total += entries.filter(isBlocking).length;
    // A finding dropped as a duplicate of a thread closed for approval; an entry stored before the flag reads `settled` in its place.
    for (const d of discussed) {
      if (!isObject(d)) return null;
      const closed = d['closedForApproval'];
      if (closed === undefined) {
        if (typeof d['settled'] !== 'boolean') return null;
        if (d['settled']) total += 1;
      } else {
        if (typeof closed !== 'boolean') return null;
        if (closed) total += 1;
      }
    }
  }
  return total;
}

/** Conditions 5 (draft) and 7 (fork), in that order; null when both hold. */
export function liveRefusal(info: PullRequestInfo): ApprovalCode | null {
  const live: Partial<PullRequestInfo> = typeof info === 'object' && info !== null ? info : {};
  // What is not false cannot be told: never "not a draft" or "not a fork".
  if (live.draft !== false) return 'draft';
  if (live.fromFork === true) return 'from_fork';
  if (live.fromFork !== false) return 'origin_unknown';
  return null;
}
