// A repository's live score quality (main 6.6 "Live"; UI design 3.3 items 6 and 8, 3.4; calls 23 to 29), and the list of
// repositories. The reviews and the webhooks share the database's few connections with the UI, so a computation is bounded in
// what it reads, in what it holds and in how many run at once (call 26): one at a time in the whole service, one statement at a
// time, the scores of at most QUALITY_GROUP runs and about QUALITY_GROUP_BYTES stored held at once (one pull request's too) and
// dropped once counted, stopped past QUALITY_DEADLINE_MS or by the service's stop, and kept; a repository with no pull request
// stored is not measured.
// Every answer is built field by field: no comment's body, author or id, no quote, no score's reason and no stored result leaves.
import { approvalOf, repoSettingsFor } from '../config/load.ts';
import { knownRepositories } from '../db/activity.ts';
import type { RepoKey } from '../db/memory-records.ts';
import {
  auditedPulls, closedPulls, feedbackCounts, feedbackReasons, findingThreads, inlineCommentsOf, mergedReverts, okRuns, repositoryKnown, runScores,
} from '../db/quality.ts';
import { THRESHOLDS, addCounts, blockFlagged, countAt, share } from '../eval/backtest/metrics.ts';
import type { Counts } from '../eval/backtest/metrics.ts';
import { blockKey, countedComments, liveCases, storedScores } from '../eval/live/labels.ts';
import type { LiveComment, LiveFile, LivePull, LiveRun } from '../eval/live/labels.ts';
import { codeOf } from '../shell/codes.ts';
import type {
  ApprovalShort, Measure, Quality, QualityAnswer, QualityRow, QualityWindow, Repositories, SteppedBlock,
} from './api-types.ts';
import { windowStart } from './insight.ts';
import type { InsightDeps } from './insight.ts';

export const QUALITY_PULLS = 300;
export const QUALITY_RUN_ROWS = 10000;
export const QUALITY_COMMENTS = 20000;
export const QUALITY_RUNS = 1000;
/** Runs whose scores one statement reads. */
export const QUALITY_GROUP = 10;
/**
 * A statement of scores reads at most about this much stored: a group closes before a pull request that would take it past, and
 * one pull request's own reads are held to it (call 26, as built, last fix).
 */
export const QUALITY_GROUP_BYTES = 4 * 1024 * 1024;
/** A stored result above this, as stored, is not read. */
export const QUALITY_RESULT_BYTES = 2 * 1024 * 1024;
export const QUALITY_DEADLINE_MS = 60_000;
export const QUALITY_WAIT_MS = 10_000;
export const QUALITY_CACHE_MS = 900_000;
export const QUALITY_FAILED_MS = 60_000;
export const QUALITY_KEPT = 100;
export const STEPPED_SHOWN = 20;
export const REASONS_SHOWN = 5;
/** The merged reverts read: those of the window, and those whose reverted pull request an audit may have drawn. */
const REVERTS_READ = 1000;
const REPOSITORIES_SHOWN = 200;
const REPOSITORY = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/;
const WINDOWS: ReadonlyMap<string, QualityWindow> = new Map<string, QualityWindow>([['', 30], ['7', 7], ['30', 30], ['90', 90], ['all', 'all']]);

export type Measured = { state: 'ready'; quality: Quality } | { state: 'computing' } | { state: 'failed' };
export interface QualityCache {
  /** What is kept for the key: a result younger than QUALITY_CACHE_MS or a failure younger than QUALITY_FAILED_MS; else null. */
  kept(key: string): Measured | null;
  /** What is kept, else the key's computation: queued behind every other of the service (one runs at a time), not queued twice, waited for at most `waitMs`. */
  measure(key: string, compute: () => Promise<Quality>, waitMs: number): Promise<Measured>;
  /** Whether the cache was stopped: a computation asks before each of its statements. */
  stopped(): boolean;
  /** How many requests are held waiting for a computation (for tests: none once each wait has ended). */
  waiting(): number;
  /**
   * The service's stop (call 26, as built, last fix): from now on no computation starts, the one under way ends before its next
   * statement, and every request waiting is answered `computing` at once; what is kept is still answered. Resolves once the one
   * under way has ended; never rejects.
   */
  stop(): Promise<void>;
}

const COMPUTING: Measured = { state: 'computing' };
/** What a statement asked for after the stop rejects with. */
const STOPPED = 'stopped';

/** The computation's answer, or `computing` once `waitMs` has passed or the cache stops; the computation goes on either way. */
async function waitFor(job: Promise<Measured>, waitMs: number, waiting: Set<() => void>): Promise<Measured> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answer = (): void => {};
  const waited = new Promise<Measured>((resolve) => { answer = () => resolve(COMPUTING); timer = setTimeout(answer, waitMs); });
  waiting.add(answer);
  try {
    return await Promise.race([job, waited]);
  } finally {
    clearTimeout(timer);
    waiting.delete(answer);
  }
}

export function createQualityCache(deps: { clock: () => Date; log: (entry: Record<string, unknown>) => void }): QualityCache {
  // A Map keeps the order its keys were put in: the first is the oldest put.
  const kept = new Map<string, { measured: Measured; at: number }>();
  const pending = new Map<string, Promise<Measured>>();
  let tail: Promise<unknown> = Promise.resolve();
  let stopped = false;
  const waiting = new Set<() => void>();

  const keptFor = (key: string): Measured | null => {
    const entry = kept.get(key);
    if (entry === undefined) return null;
    const life = entry.measured.state === 'ready' ? QUALITY_CACHE_MS : QUALITY_FAILED_MS;
    if (deps.clock().getTime() - entry.at < life) return entry.measured;
    kept.delete(key);
    return null;
  };
  const put = (key: string, measured: Measured): void => {
    kept.delete(key);
    kept.set(key, { measured, at: deps.clock().getTime() });
    for (const oldest of kept.keys()) {
      if (kept.size <= QUALITY_KEPT) break;
      kept.delete(oldest);
    }
  };
  const run = async (key: string, compute: () => Promise<Quality>): Promise<Measured> => {
    // A computation whose turn comes after the stop does not start.
    if (stopped) { pending.delete(key); return COMPUTING; }
    let measured: Measured;
    let failure: string | null = null;
    try {
      measured = { state: 'ready', quality: await compute() };
    } catch (error) {
      measured = { state: 'failed' };
      failure = codeOf(error);
    }
    pending.delete(key);
    // One the stop ended is neither kept nor logged: it did not fail.
    if (stopped && measured.state === 'failed') return COMPUTING;
    put(key, measured);
    if (failure !== null) deps.log({ event: 'quality_failed', reason: failure });
    return measured;
  };

  return {
    kept: keptFor,
    measure(key, compute, waitMs) {
      const known = keptFor(key);
      if (known !== null) return Promise.resolve(known);
      if (stopped) return Promise.resolve(COMPUTING);
      let job = pending.get(key);
      if (job === undefined) {
        // A computation starts only when the one before it settled.
        job = tail.then(() => run(key, compute));
        tail = job.then(() => undefined, () => undefined);
        pending.set(key, job);
      }
      return waitFor(job, waitMs, waiting);
    },
    stopped: () => stopped,
    waiting: () => waiting.size,
    stop() {
      stopped = true;
      for (const answer of waiting) answer();
      return tail.then(() => undefined);
    },
  };
}

/** The repository lower-cased, the window and the threshold, joined by a line feed. */
export function qualityKey(repository: string, window: QualityWindow, threshold: number): string {
  return `${repository.toLowerCase()}\n${window}\n${threshold}`;
}

/** The constants above; a test gives lower ones. */
export interface QualityBounds { resultBytes: number; comments: number; runRows: number; runs: number; groupBytes: number }

const repoKeyOf = (name: string): RepoKey => {
  const slash = name.indexOf('/');
  return { service: 'github', owner: slash < 0 ? name : name.slice(0, slash), repo: slash < 0 ? '' : name.slice(slash + 1) };
};
const sideOf = (side: string | null): 'LEFT' | 'RIGHT' | null => (side === 'LEFT' || side === 'RIGHT' ? side : null);
const measureOf = (part: number, of: number): Measure => ({ share: share(part, of), part, of });
const byPlace = (a: SteppedBlock, b: SteppedBlock): number => b.number - a.number || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** A run that did not fail, as `okRuns` reads it: `size` is its stored result's size as stored. */
export interface PlanRun { id: number; head: string; started: Date; size: number }
/** A pull request to measure: the ids of its runs to read, its last run first, what they hold as stored, and what its labels are read from. */
export interface Planned {
  number: number; author: string | null;
  last: { id: number; head: string } | null;   // its last run: the newest that did not fail, started at or before its close
  heads: Map<string, number>;                  // each head a counted comment names whose run is read, and that run (the last run's head is its own)
  read: number[];
  bytes: number;                               // the sizes as stored of the runs read (at most `resultBytes` each; none when the last run is over it)
  cut: boolean;                                // a head a counted comment names, scored by a run, was left out: its comments label the last run's file only
  comments: LiveComment[]; findings: Set<string>;
}

/**
 * What of a closed pull request is read (call 26): its last run, then the runs at the heads its counted comments name (the comments
 * `liveCases` counts, by `countedComments`), each head's newest started at or before the close, newest first, other than the last
 * run, while they fit: at most QUALITY_GROUP in all and `groupBytes` stored (as built, last fix). A head no run scored is not read:
 * its comments label the last run's file, as do those of a head left out (`cut`), whose run is over `resultBytes` or does not fit.
 * A last run over `resultBytes` is read alone: it is not read, so its pull request is unreadable, and no other run of it is read.
 */
export function planOf(
  pull: { number: number; author: string | null; closed_at: Date }, runs: readonly PlanRun[], comments: readonly LiveComment[],
  findings: ReadonlySet<string>, resultBytes = QUALITY_RESULT_BYTES, groupBytes = QUALITY_GROUP_BYTES,
): Planned {
  const close = pull.closed_at.getTime();
  const plan: Planned = {
    number: pull.number, author: pull.author, last: null, heads: new Map(), read: [], bytes: 0, cut: false, comments: [...comments], findings: new Set(findings),
  };
  const newest = new Map<string, PlanRun>();
  let last: PlanRun | null = null;
  for (const r of runs) {
    if (r.started.getTime() > close) continue;
    if (last === null || r.id > last.id) last = r;
    if ((newest.get(r.head)?.id ?? -1) < r.id) newest.set(r.head, r);
  }
  if (last === null) return plan;
  plan.last = { id: last.id, head: last.head };
  plan.read = [last.id];
  if (last.size > resultBytes) return plan;
  plan.bytes = last.size;
  const counted = countedComments({ author: pull.author, comments: plan.comments, findingThreads: plan.findings });
  const others: PlanRun[] = [];
  for (const head of new Set(counted.flatMap((c) => (c.commit === null ? [] : [c.commit])))) {
    const run = newest.get(head);
    if (run === undefined) continue;
    if (run.id === last.id) plan.heads.set(head, run.id);
    else others.push(run);
  }
  // A pull request is never split across two groups, so it reads at most QUALITY_GROUP runs and about `groupBytes` stored.
  for (const run of others.sort((x, y) => y.id - x.id)) {
    if (run.size > resultBytes) { plan.cut = true; continue; }
    if (plan.read.length >= QUALITY_GROUP || plan.bytes + run.size > groupBytes) { plan.cut = true; break; }
    plan.heads.set(run.head, run.id);
    plan.read.push(run.id);
    plan.bytes += run.size;
  }
  return plan;
}

const rowsOf = (thresholds: readonly number[], t: number, pulls: ReadonlyMap<number, Counts>, labelled: ReadonlyMap<number, Counts>): QualityRow[] =>
  thresholds.map((x) => {
    const p = pulls.get(x)!;
    const l = labelled.get(x)!;
    return {
      threshold: x, current: x === t,
      safetyBlocks: measureOf(l.blocksLeft, l.blocks), safetyFiles: measureOf(l.filesLeft, l.files),
      benefit: measureOf(p.prsClear, p.prs), focus: measureOf(p.flaggedLines, p.totalLines),
    };
  });
const thresholdsOf = (t: number): number[] => [...new Set([...THRESHOLDS, t])].sort((x, y) => x - y);
const zeroCounts = (thresholds: readonly number[]): Map<number, Counts> => new Map(thresholds.map((x) => [x, countAt([], x)]));

/** The answer of a repository with no pull request stored: nothing read, nothing kept. */
function nothingStored(name: string, window: QualityWindow, t: number): Quality {
  const thresholds = thresholdsOf(t);
  return {
    repository: name, window, threshold: t, closed: 0, pullRequests: 0, unreadable: 0, cut: { pulls: false, comments: false, runs: false },
    rows: rowsOf(thresholds, t, zeroCounts(thresholds), zeroCounts(thresholds)), stepped: [],
    reverts: { merged: 0, approved: 0 }, audits: { drawn: 0, needed: 0 }, feedback: { helpful: 0, notHelpful: 0, reasons: [] },
  };
}

/** One repository's quality over a window at a threshold (calls 23 to 29); rejects `too_slow` past QUALITY_DEADLINE_MS, and `stopped` once the cache is. */
export async function computeQuality(
  deps: InsightDeps, repository: string, window: QualityWindow, threshold: number, bounds: Partial<QualityBounds> = {},
): Promise<Quality> {
  const b: QualityBounds = {
    resultBytes: QUALITY_RESULT_BYTES, comments: QUALITY_COMMENTS, runRows: QUALITY_RUN_ROWS, runs: QUALITY_RUNS, groupBytes: QUALITY_GROUP_BYTES, ...bounds,
  };
  const began = deps.clock().getTime();
  // Checked before each statement: a statement under way is cut by the pool.
  const step = <T>(read: () => Promise<T>): Promise<T> =>
    (deps.quality.stopped() ? Promise.reject(new Error(STOPPED))
      : deps.clock().getTime() - began >= QUALITY_DEADLINE_MS ? Promise.reject(new Error('too_slow')) : read());
  const name = repository.toLowerCase();
  const key = repoKeyOf(name);
  const since = windowStart(deps.clock(), window);
  const t = threshold;
  const thresholds = thresholdsOf(t);
  const cut = { pulls: false, comments: false, runs: false };
  const pullCounts = zeroCounts(thresholds);
  const labelCounts = zeroCounts(thresholds);
  let stepped: SteppedBlock[] = [];
  const strict = new Set<number>();
  let measured = 0;
  let unreadable = 0;

  const closed = await step(() => closedPulls(deps.db, key, since, QUALITY_PULLS + 1));
  cut.pulls = closed.length > QUALITY_PULLS;
  const pulls = closed.slice(0, QUALITY_PULLS);
  const numbers = pulls.map((p) => p.number);

  if (pulls.length > 0) {
    const commentRows = await step(() => inlineCommentsOf(deps.db, key, numbers, b.comments + 1));
    cut.comments = commentRows.length > b.comments;
    const runRows = await step(() => okRuns(deps.db, key, numbers, b.runRows + 1));
    if (runRows.length > b.runRows) cut.runs = true;
    const threadRows = await step(() => findingThreads(deps.db, key, numbers));

    const comments = new Map<number, LiveComment[]>();
    for (const c of commentRows.slice(0, b.comments)) {
      const list = comments.get(c.number) ?? [];
      list.push({
        id: c.id, author: c.author, path: c.path, side: sideOf(c.side), line: c.line, startLine: c.start_line,
        fileLevel: c.file_level === true, commit: c.commit, replyTo: c.reply_to,
      });
      comments.set(c.number, list);
    }
    const runs = new Map<number, PlanRun[]>();
    for (const r of runRows.slice(0, b.runRows)) {
      const list = runs.get(r.number) ?? [];
      list.push({ id: r.id, head: r.head_sha, started: r.started_at, size: r.size });
      runs.set(r.number, list);
    }
    const findings = new Map<number, Set<string>>();
    for (const f of threadRows) findings.set(f.number, (findings.get(f.number) ?? new Set()).add(f.comment_id));
    const planned = pulls.map((p) => planOf(p, runs.get(p.number) ?? [], comments.get(p.number) ?? [], findings.get(p.number) ?? new Set(), b.resultBytes, b.groupBytes));

    // One group: its runs' scores in one statement; each pull request then measured by one call of liveCases, counted, and dropped.
    const measureGroup = async (group: readonly Planned[]): Promise<void> => {
      const rows = await step(() => runScores(deps.db, group.flatMap((p) => p.read), b.resultBytes));
      const scores = new Map<number, LiveFile[] | null>(rows.map((r) => [r.id, storedScores(r.scores)]));
      for (const p of group) {
        const lastScores = scores.get(p.last!.id) ?? null;
        if (lastScores === null) { unreadable += 1; continue; }
        const last: LiveRun = { id: p.last!.id, head: p.last!.head, scores: lastScores };
        const atHead = new Map<string, LiveRun>();
        for (const [head, id] of p.heads) {
          if (id === last.id) { atHead.set(head, last); continue; }
          const read = scores.get(id) ?? null;
          if (read !== null) atHead.set(head, { id, head, scores: read });
        }
        const pull: LivePull = { number: p.number, author: p.author, threshold: t, last, atHead, comments: p.comments, findingThreads: p.findings };
        const cases = liveCases([pull]);
        measured += cases.pulls.length;
        for (const x of thresholds) {
          pullCounts.set(x, addCounts(pullCounts.get(x)!, countAt(cases.pulls, x)));
          labelCounts.set(x, addCounts(labelCounts.get(x)!, countAt(cases.labelled, x)));
        }
        const found: SteppedBlock[] = [];
        for (const c of cases.labelled) {
          for (const file of c.scores) {
            for (const block of file.blocks) {
              if (c.labels.blocks.get(blockKey(file.path, block.id))?.strict !== true || blockFlagged(file, block, t)) continue;
              found.push({ path: file.path, number: p.number, score: block.entry?.score ?? file.fileLevel?.score ?? 0 });
            }
          }
        }
        if (found.length > 0) stepped = [...stepped, ...found].sort(byPlace).slice(0, STEPPED_SHOWN);
        if (cases.strict.size > 0) strict.add(p.number);
      }
    };

    // A group closes before a pull request that would take it past QUALITY_GROUP runs or `groupBytes` stored; a pull request's
    // own reads are held to both (`planOf`), and a head it left out is said.
    let group: Planned[] = [];
    let inGroup = 0;
    let groupBytes = 0;
    let read = 0;
    for (const p of planned) {
      const n = p.read.length;
      if (n === 0) continue;
      if (read + n > b.runs) { cut.runs = true; break; }
      if (p.cut) cut.runs = true;
      if (group.length > 0 && (inGroup + n > QUALITY_GROUP || groupBytes + p.bytes > b.groupBytes)) {
        await measureGroup(group);
        group = []; inGroup = 0; groupBytes = 0;
      }
      group.push(p);
      inGroup += n;
      groupBytes += p.bytes;
      read += n;
    }
    if (group.length > 0) await measureGroup(group);
  }

  const reverted = await step(() => mergedReverts(deps.db, key, REVERTS_READ));
  const start = Date.parse(since);
  const ofWindow = reverted.filter((r) => r.merged_at.getTime() >= start);
  let audits = { drawn: 0, needed: 0 };
  if (numbers.length > 0) {
    const drawn = await step(() => auditedPulls(deps.db, key, numbers));
    const revertedNumbers = new Set(reverted.map((r) => r.reverts));
    audits = { drawn: drawn.length, needed: drawn.filter((n) => strict.has(n) || revertedNumbers.has(n)).length };
  }
  const votes = await step(() => feedbackCounts(deps.db, key, since));
  const reasons = await step(() => feedbackReasons(deps.db, key, since, REASONS_SHOWN));

  return {
    repository: name, window, threshold: t,
    closed: pulls.length, pullRequests: measured, unreadable, cut,
    rows: rowsOf(thresholds, t, pullCounts, labelCounts), stepped: stepped.map((s) => ({ path: s.path, number: s.number, score: s.score })),
    reverts: { merged: ofWindow.length, approved: ofWindow.filter((r) => r.approved).length },
    audits,
    feedback: { helpful: votes.up, notHelpful: votes.down, reasons: reasons.map((r) => ({ reason: r.reason, count: r.count })) },
  };
}

/** Through the cache, at the repository's threshold in force. */
export async function qualityOf(deps: InsightDeps, repository: string, window: QualityWindow, waitMs: number): Promise<Measured> {
  const name = repository.toLowerCase();
  const threshold = repoSettingsFor(deps.inForce(), name).scoreThreshold;
  return deps.quality.measure(qualityKey(name, window, threshold), () => computeQuality(deps, name, window, threshold), waitMs);
}

/**
 * The answer of the quality route. What is kept is answered; else a repository with no pull request stored is answered at once
 * with none, neither queued nor kept, so names made up cannot take the cache's places or the queue; else it is measured.
 */
export async function quality(deps: InsightDeps, repository: string, query: URLSearchParams): Promise<QualityAnswer | 'bad_request'> {
  const name = repository.toLowerCase();
  const window = WINDOWS.get(query.get('days') ?? '');
  if (!REPOSITORY.test(name) || window === undefined) return 'bad_request';
  const threshold = repoSettingsFor(deps.inForce(), name).scoreThreshold;
  let measured = deps.quality.kept(qualityKey(name, window, threshold));
  if (measured === null) {
    // A lookup that fails is answered `failed`, not kept: the route answers a state, never 500.
    let known: boolean | null;
    try {
      known = await repositoryKnown(deps.db, repoKeyOf(name));
    } catch {
      known = null;
    }
    measured = known === null ? { state: 'failed' }
      : known ? await qualityOf(deps, name, window, QUALITY_WAIT_MS)
      : { state: 'ready', quality: nothingStored(name, window, threshold) };
  }
  return { now: deps.clock().toISOString(), state: measured.state, quality: measured.state === 'ready' ? measured.quality : null };
}

export async function repositories(deps: InsightDeps): Promise<Repositories> {
  const names = await knownRepositories(deps.db, REPOSITORIES_SHOWN);
  return { now: deps.clock().toISOString(), repositories: [...names] };
}

/** A repository's automatic approval in short, from the settings in force. */
export function approvalShort(deps: InsightDeps, repository: string): ApprovalShort {
  const approval = approvalOf(repoSettingsFor(deps.inForce(), repository));
  return { enabled: approval.enabled, threads: approval.threads, auditShare: approval.auditShare };
}
