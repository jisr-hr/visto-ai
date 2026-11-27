// A repository's live score quality (main 6.6 "Live"; UI design 3.3 items 6 and 8, 3.4; calls 23 to 29), and the list of
// repositories. The reviews and the webhooks share the database's few connections with the UI, so a computation is bounded in
// what it reads, in what it holds and in how many run at once (call 26): one at a time in the whole service, one statement at a
// time, the scores of at most QUALITY_GROUP runs held at once and dropped once counted, stopped past QUALITY_DEADLINE_MS, and kept.
// Every answer is built field by field: no comment's body, author or id, no quote, no score's reason and no stored result leaves.
import { approvalOf, repoSettingsFor } from '../config/load.ts';
import { knownRepositories } from '../db/activity.ts';
import type { RepoKey } from '../db/memory-records.ts';
import {
  auditedPulls, closedPulls, feedbackCounts, feedbackReasons, findingThreads, inlineCommentsOf, mergedReverts, okRuns, runScores,
} from '../db/quality.ts';
import { THRESHOLDS, addCounts, blockFlagged, countAt, share } from '../eval/backtest/metrics.ts';
import type { Counts } from '../eval/backtest/metrics.ts';
import { blockKey, liveCases, storedScores } from '../eval/live/labels.ts';
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
/** A stored result above this, as stored, is not read. */
export const QUALITY_RESULT_BYTES = 2 * 1024 * 1024;
export const QUALITY_DEADLINE_MS = 60_000;
export const QUALITY_WAIT_MS = 10_000;
export const QUALITY_CACHE_MS = 300_000;
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
}

/** The computation's answer, or `computing` once `waitMs` has passed; the computation goes on either way. */
async function waitFor(job: Promise<Measured>, waitMs: number): Promise<Measured> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<Measured>((resolve) => { timer = setTimeout(() => resolve({ state: 'computing' }), waitMs); });
  try {
    return await Promise.race([job, waited]);
  } finally {
    clearTimeout(timer);
  }
}

export function createQualityCache(deps: { clock: () => Date; log: (entry: Record<string, unknown>) => void }): QualityCache {
  // A Map keeps the order its keys were put in: the first is the oldest put.
  const kept = new Map<string, { measured: Measured; at: number }>();
  const pending = new Map<string, Promise<Measured>>();
  let tail: Promise<unknown> = Promise.resolve();

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
    let measured: Measured;
    let failure: string | null = null;
    try {
      measured = { state: 'ready', quality: await compute() };
    } catch (error) {
      measured = { state: 'failed' };
      failure = codeOf(error);
    }
    pending.delete(key);
    put(key, measured);
    if (failure !== null) deps.log({ event: 'quality_failed', reason: failure });
    return measured;
  };

  return {
    kept: keptFor,
    measure(key, compute, waitMs) {
      const known = keptFor(key);
      if (known !== null) return Promise.resolve(known);
      let job = pending.get(key);
      if (job === undefined) {
        // A computation starts only when the one before it settled.
        job = tail.then(() => run(key, compute));
        tail = job.then(() => undefined, () => undefined);
        pending.set(key, job);
      }
      return waitFor(job, waitMs);
    },
  };
}

/** The repository lower-cased, the window and the threshold, joined by a line feed. */
export function qualityKey(repository: string, window: QualityWindow, threshold: number): string {
  return `${repository.toLowerCase()}\n${window}\n${threshold}`;
}

/** The constants above; a test gives lower ones. */
export interface QualityBounds { resultBytes: number; comments: number; runRows: number; runs: number }

const repoKeyOf = (name: string): RepoKey => {
  const slash = name.indexOf('/');
  return { service: 'github', owner: slash < 0 ? name : name.slice(0, slash), repo: slash < 0 ? '' : name.slice(slash + 1) };
};
const sideOf = (side: string | null): 'LEFT' | 'RIGHT' | null => (side === 'LEFT' || side === 'RIGHT' ? side : null);
const measureOf = (part: number, of: number): Measure => ({ share: share(part, of), part, of });
const byPlace = (a: SteppedBlock, b: SteppedBlock): number => b.number - a.number || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** A pull request to measure: the ids of its runs to read, its last run first, and what its labels are read from. */
interface Planned {
  number: number; author: string | null;
  last: { id: number; head: string } | null;
  heads: Map<string, number>;   // each commented head whose run is read, and that run (the last run's head is its own)
  read: number[];
  comments: LiveComment[]; findings: Set<string>;
}

/** One repository's quality over a window at a threshold (calls 23 to 29); rejects `too_slow` past QUALITY_DEADLINE_MS. */
export async function computeQuality(
  deps: InsightDeps, repository: string, window: QualityWindow, threshold: number, bounds: Partial<QualityBounds> = {},
): Promise<Quality> {
  const b: QualityBounds = { resultBytes: QUALITY_RESULT_BYTES, comments: QUALITY_COMMENTS, runRows: QUALITY_RUN_ROWS, runs: QUALITY_RUNS, ...bounds };
  const began = deps.clock().getTime();
  // Checked before each statement: a statement under way is cut by the pool.
  const step = <T>(read: () => Promise<T>): Promise<T> =>
    (deps.clock().getTime() - began >= QUALITY_DEADLINE_MS ? Promise.reject(new Error('too_slow')) : read());
  const name = repository.toLowerCase();
  const key = repoKeyOf(name);
  const since = windowStart(deps.clock(), window);
  const t = threshold;
  const thresholds = [...new Set([...THRESHOLDS, t])].sort((x, y) => x - y);
  const cut = { pulls: false, comments: false, runs: false };
  const pullCounts = new Map<number, Counts>(thresholds.map((x) => [x, countAt([], x)]));
  const labelCounts = new Map<number, Counts>(thresholds.map((x) => [x, countAt([], x)]));
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
    const runs = new Map<number, Array<{ id: number; head: string; started: number }>>();
    for (const r of runRows.slice(0, b.runRows)) {
      const list = runs.get(r.number) ?? [];
      list.push({ id: r.id, head: r.head_sha, started: r.started_at.getTime() });
      runs.set(r.number, list);
    }
    const findings = new Map<number, Set<string>>();
    for (const f of threadRows) findings.set(f.number, (findings.get(f.number) ?? new Set()).add(f.comment_id));

    const planned: Planned[] = pulls.map((p) => {
      const close = p.closed_at.getTime();
      const own = comments.get(p.number) ?? [];
      const plan: Planned = {
        number: p.number, author: p.author, last: null, heads: new Map(), read: [], comments: own, findings: findings.get(p.number) ?? new Set(),
      };
      // The newest run that did not fail, started at or before the close; and at each head, that head's newest.
      const newest = new Map<string, number>();
      for (const r of runs.get(p.number) ?? []) {
        if (r.started > close) continue;
        if (plan.last === null || r.id > plan.last.id) plan.last = { id: r.id, head: r.head };
        if ((newest.get(r.head) ?? -1) < r.id) newest.set(r.head, r.id);
      }
      if (plan.last === null) return plan;
      const last = plan.last;
      const commented = new Set(own.flatMap((c) => (c.commit === null ? [] : [c.commit])));
      const others: Array<[string, number]> = [];
      for (const head of commented) {
        const id = newest.get(head);
        if (id === undefined) continue;
        if (id === last.id) plan.heads.set(head, id);
        else others.push([head, id]);
      }
      // Its last run, then its commented heads' runs newest first, at most QUALITY_GROUP in all: a pull request is never split across two groups.
      const chosen = others.sort((x, y) => y[1] - x[1]).slice(0, QUALITY_GROUP - 1);
      for (const [head, id] of chosen) plan.heads.set(head, id);
      plan.read = [last.id, ...chosen.map(([, id]) => id)];
      return plan;
    });

    // One group: its runs' scores in one statement, its pull requests in one call of liveCases, counted, then dropped.
    const measureGroup = async (group: Planned[]): Promise<void> => {
      const rows = await step(() => runScores(deps.db, group.flatMap((p) => p.read), b.resultBytes));
      const scores = new Map<number, LiveFile[] | null>(rows.map((r) => [r.id, storedScores(r.scores)]));
      const livePulls: LivePull[] = group.map((p) => {
        const lastScores = scores.get(p.last!.id) ?? null;
        if (lastScores === null) unreadable += 1;
        const last: LiveRun | null = lastScores === null ? null : { id: p.last!.id, head: p.last!.head, scores: lastScores };
        const atHead = new Map<string, LiveRun>();
        for (const [head, id] of p.heads) {
          if (last !== null && id === last.id) { atHead.set(head, last); continue; }
          const read = scores.get(id) ?? null;
          if (read !== null) atHead.set(head, { id, head, scores: read });
        }
        return { number: p.number, author: p.author, threshold: t, last, atHead, comments: p.comments, findingThreads: p.findings };
      });
      const cases = liveCases(livePulls);
      measured += cases.pulls.length;
      for (const x of thresholds) {
        pullCounts.set(x, addCounts(pullCounts.get(x)!, countAt(cases.pulls, x)));
        labelCounts.set(x, addCounts(labelCounts.get(x)!, countAt(cases.labelled, x)));
      }
      const found: SteppedBlock[] = [];
      for (const c of cases.labelled) {
        const number = Number(c.key.slice(0, c.key.indexOf(':')));
        for (const file of c.scores) {
          for (const block of file.blocks) {
            if (c.labels.blocks.get(blockKey(file.path, block.id))?.strict !== true || blockFlagged(file, block, t)) continue;
            found.push({ path: file.path, number, score: block.entry?.score ?? file.fileLevel?.score ?? 0 });
          }
        }
      }
      stepped = [...stepped, ...found].sort(byPlace).slice(0, STEPPED_SHOWN);
      for (const n of cases.strict) strict.add(n);
    };

    let group: Planned[] = [];
    let inGroup = 0;
    let read = 0;
    for (const p of planned) {
      const n = p.read.length;
      if (n === 0) continue;
      if (read + n > b.runs) { cut.runs = true; break; }
      if (inGroup + n > QUALITY_GROUP) { await measureGroup(group); group = []; inGroup = 0; }
      group.push(p);
      inGroup += n;
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

  const rows: QualityRow[] = thresholds.map((x) => {
    const p = pullCounts.get(x)!;
    const l = labelCounts.get(x)!;
    return {
      threshold: x, current: x === t,
      safetyBlocks: measureOf(l.blocksLeft, l.blocks), safetyFiles: measureOf(l.filesLeft, l.files),
      benefit: measureOf(p.prsClear, p.prs), focus: measureOf(p.flaggedLines, p.totalLines),
    };
  });
  return {
    repository: name, window, threshold: t,
    pullRequests: measured, unreadable, cut,
    rows, stepped: stepped.map((s) => ({ path: s.path, number: s.number, score: s.score })),
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

export async function quality(deps: InsightDeps, repository: string, query: URLSearchParams): Promise<QualityAnswer | 'bad_request'> {
  const name = repository.toLowerCase();
  const window = WINDOWS.get(query.get('days') ?? '');
  if (!REPOSITORY.test(name) || window === undefined) return 'bad_request';
  const measured = await qualityOf(deps, name, window, QUALITY_WAIT_MS);
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
