// The learning pass (7.3, 14): turns what capture stored into records, with no model. It finds its work by what is
// stored, makes the records of one pull request in one transaction, passes over one that fails, retires expired
// records and writes when it ran and what it added. Logs hold ids, counts, a repository's name, a number and short
// codes: never a path, a login, an excerpt or an error's message.
import { inlineComments, markLearned, noteLearnFailure, noteLearning, pullRequestsToLearn, readLearning, startLearning } from '../db/learning.ts';
import type { ToLearn } from '../db/learning.ts';
import { addRecords, retireExpired } from '../db/memory-records.ts';
import type { NewRecord } from '../db/memory-records.ts';
import { listComments, NOTE } from '../db/review-comments.ts';
import { scoredAt } from '../db/review-runs.ts';
import type { Db } from '../db/types.ts';
import type { PullRequestRef } from '../forge/types.ts';
import { mayCount, readScored, signalsOf } from '../memory/signals.ts';
import type { PersonComment, ScoredRun, Signal } from '../memory/signals.ts';
import type { Alert } from './alerts.ts';
import { codeOf } from './codes.ts';

export const WORK = 'signals';                  // the row of the learning work this plan writes
export const LEARN_MS = 300_000;                // the pass's timer
export const PASS_LIMIT_MS = 240_000;           // how long a tick waits for its pass
export const LEARN_BATCH = 50;                  // pull requests read in one batch
export const LEARN_BATCHES = 20;                // batches in one pass
export const LEARN_ATTEMPTS = 3;                // failed passes in a row after which a pull request is given up
export const STALE_AFTER_MS = 36 * 3_600_000;

const HOUR_MS = 3_600_000;

export interface Learned { pullRequests: number; examined: number; added: number; retired: number; failed: number; more: boolean }

type Log = (entry: Record<string, unknown>) => void;

const safe = (log: Log | undefined): Log => (entry) => {
  if (log === undefined) return;
  try {
    log(entry);
  } catch {
    // a logger that throws changes nothing
  }
};

const repoOf = (ref: PullRequestRef): string => `${ref.owner}/${ref.repo}`;

// A stored inline comment as the rule reads it (rule 3). Capture stores no bot's comment.
function personOf(c: Awaited<ReturnType<typeof inlineComments>>[number]['comment']): PersonComment {
  return {
    id: c.sourceId, author: c.author, bot: false, association: c.association, at: c.at, body: c.body,
    path: c.path, side: c.side, line: c.line, startLine: c.startLine, fileLevel: c.fileLevel === true,
    commit: c.commit, replyTo: c.replyTo,
  };
}

const recordOf = (s: Signal): NewRecord => ({
  kind: 'human_signal', sourceRef: s.sourceRef, number: s.number, path: s.path, directory: s.directory,
  category: s.category, reason: s.reason, missed: s.missed, excerpt: s.excerpt, comment: s.comment,
  createdAt: s.createdAt, expiresAt: s.expiresAt,
});

/** One pull request, in one transaction (rule 2). Resolves with what it looked at and added. */
async function learnOne(tx: Db, pr: ToLearn, now: string): Promise<{ examined: number; added: number }> {
  const stored = await inlineComments(tx, pr.ref);
  const comments = stored.map((s) => personOf(s.comment));
  const counting = comments.filter((c) => mayCount(c, pr.author));
  let posted: Map<string, 'finding' | 'note'> | undefined;
  let scored: Map<string, ScoredRun> | undefined;
  if (counting.length > 0) {
    posted = new Map();
    for (const c of await listComments(tx, pr.ref)) posted.set(c.commentId, c.severity === NOTE ? 'note' : 'finding');
    const commits = [...new Set(counting.map((c) => c.commit).filter((c): c is string => typeof c === 'string'))];
    scored = new Map();
    for (const run of await scoredAt(tx, pr.ref, commits)) scored.set(run.commit, readScored(run.scores, run.threshold));
  }
  const signals = signalsOf({ number: pr.ref.number, author: pr.author, closedAt: pr.closedAt, comments, posted, scored });
  const kept = pr.closedAt === null ? signals.filter((s) => s.missed) : signals;
  const added = await addRecords(tx, { service: pr.ref.service, owner: pr.ref.owner, repo: pr.ref.repo }, kept.map(recordOf));
  const fresh = stored.filter((s) => !s.learned).map((s) => s.comment.sourceId);
  await markLearned(tx, pr.ref, fresh, now, pr.closedAt);
  return { examined: fresh.length, added };
}

/** One pass. Rejects when the database does not answer; what it committed before stays. batch, batches: for tests; absent: LEARN_BATCH, LEARN_BATCHES. */
export async function learnOnce(deps: {
  db: Db; clock: () => Date; log?: (entry: Record<string, unknown>) => void; stopping?: () => boolean; batch?: number; batches?: number;
}): Promise<Learned> {
  const log = safe(deps.log);
  try {
    return await pass(deps, log);
  } catch (err) {
    log({ event: 'learning_failed', reason: codeOf(err) });
    throw err;
  }
}

async function pass(deps: Parameters<typeof learnOnce>[0], log: Log): Promise<Learned> {
  const { db } = deps;
  const size = deps.batch ?? LEARN_BATCH;
  const batches = deps.batches ?? LEARN_BATCHES;
  const stopping = (): boolean => {
    try {
      return deps.stopping?.() === true;
    } catch {
      return true;   // a stop that cannot be read is a stop
    }
  };
  const out: Learned = { pullRequests: 0, examined: 0, added: 0, retired: 0, failed: 0, more: false };
  let after: PullRequestRef | null = null;
  let told = false;
  for (let i = 0; i < batches && !told; i += 1) {
    if (stopping()) break;
    const batch = await pullRequestsToLearn(db, size, after, LEARN_ATTEMPTS);
    out.more = batch.length >= size;
    for (const pr of batch) {
      if (stopping()) {
        told = true;
        break;
      }
      const now = deps.clock().toISOString();
      try {
        const done = await db.transaction((tx) => learnOne(tx, pr, now));
        out.pullRequests += 1;
        out.examined += done.examined;
        out.added += done.added;
      } catch (err) {
        // This pull request fails; the database not answering is told by the statement below rejecting.
        const attempts = await noteLearnFailure(db, pr.ref);
        out.failed += 1;
        const reason = codeOf(err);
        log({ event: 'learning_pr_failed', repo: repoOf(pr.ref), number: pr.ref.number, reason, attempts });
        if (attempts >= LEARN_ATTEMPTS) log({ event: 'learning_pr_given_up', repo: repoOf(pr.ref), number: pr.ref.number, reason });
      }
    }
    if (batch.length === 0 || batch.length < size) break;
    after = batch[batch.length - 1]!.ref;
  }
  const now = deps.clock().toISOString();
  out.retired = await retireExpired(db, now);
  await noteLearning(db, WORK, now, { examined: out.examined, added: out.added, retired: out.retired, failed: out.failed });
  if (out.pullRequests > 0 || out.retired > 0 || out.failed > 0) {
    log({ event: 'learning', pull_requests: out.pullRequests, examined: out.examined, added: out.added, retired: out.retired, failed: out.failed, more: out.more });
  }
  return out;
}

export interface Learning {
  /** Makes sure the work's row is there, and logs what it holds. Rejects when the database does. */
  start(): Promise<void>;
  /** Asks for a pass soon. Returns at once and never throws. */
  wake(): void;
  /** The check for staleness, then one pass, waited for at most the pass limit. Never rejects. */
  tick(): Promise<void>;
  /** Resolves when no pass is under way. */
  idle(): Promise<void>;
  /** No pass starts from now on. */
  stop(): void;
}

// The clock's time in milliseconds; null when it cannot be read.
function msOf(clock: () => Date): number | null {
  try {
    const ms = clock().getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

// Resolves true when `work` settles within `ms`, false when it does not. Leaves no timer behind.
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** passLimitMs: for tests; absent: PASS_LIMIT_MS. */
export function createLearning(deps: { db: Db; clock: () => Date; log: (entry: Record<string, unknown>) => void; alert: Alert; passLimitMs?: number }): Learning {
  const log = safe(deps.log);
  const limit = deps.passLimitMs ?? PASS_LIMIT_MS;
  let made: number | null = null;            // the first time the clock could be read: the 36 hours count from it when nothing else tells
  let lastCompleted: number | null = null;   // when a pass last completed in this process
  let raised = false;                        // learning_stale was raised since a pass last completed
  let stopped = false;
  let pending = false;                       // one more pass was asked for meanwhile

  /** One pass: settles when that pass has ended and the next one, if asked for, has started. */
  interface Pass { settled: Promise<void>; ctl: { stop: boolean } }
  let current: Pass | null = null;           // the pass under way

  // The clock's time, remembered as `made` when it is the first that could be read.
  const now = (): number | null => {
    const ms = msOf(deps.clock);
    if (made === null && ms !== null) made = ms;
    return ms;
  };
  now();

  function startPass(): Pass {
    const ctl = { stop: false };
    const pass: Pass = {
      ctl,
      settled: (async () => {
        try {
          await learnOnce({ db: deps.db, clock: deps.clock, log, stopping: () => stopped || ctl.stop });
          lastCompleted = now() ?? lastCompleted;
          raised = false;
        } catch {
          // logged by the pass
        }
      })().finally(() => {
        current = null;
        const again = pending && !stopped;
        pending = false;
        if (again) current = startPass();
      }),
    };
    return pass;
  }

  /** The pass this call is for: the one under way, after which one more is asked for, or the one it starts. null after stop. */
  function ask(): Pass | null {
    if (stopped) return null;
    if (current !== null) {
      pending = true;
      return current;
    }
    current = startPass();
    return current;
  }

  async function idle(): Promise<void> {
    while (current !== null) await current.settled;
  }

  // The time the 36 hours count from (rule 9). null: none can be told. The read is waited for until `deadline` at most.
  async function lastOf(deadline: number): Promise<number | null> {
    let row: { ranAt: string | null; since: string } | null = null;
    try {
      // One that fails or hangs counts from this process.
      await within(readLearning(deps.db, WORK).then((r) => { row = r; }), Math.max(0, deadline - Date.now()));
    } catch {
      row = null;
    }
    const fallback = lastCompleted ?? made;
    const found = row as { ranAt: string | null; since: string } | null;
    if (found === null) return fallback;
    const ms = Date.parse(found.ranAt ?? found.since);
    return Number.isFinite(ms) ? ms : fallback;
  }

  async function checkStale(deadline: number): Promise<void> {
    if (raised) return;
    const last = await lastOf(deadline);
    const at = now();
    if (last === null || at === null || raised || at - last <= STALE_AFTER_MS) return;
    raised = true;
    try {
      // An alert that throws, or returns a promise that rejects, changes nothing.
      const returned: unknown = deps.alert('learning_stale', { hours: Math.floor((at - last) / HOUR_MS) });
      void Promise.resolve(returned).catch(() => {});
    } catch {
      // an alert that throws changes nothing
    }
  }

  return {
    async start(): Promise<void> {
      const at = deps.clock().toISOString();
      const row = await startLearning(deps.db, WORK, at);
      log({ event: 'learning_state', since: row.since, last_ran: row.ranAt, examined: row.examined, added: row.added, retired: row.retired, failed: row.failed });
    },
    wake(): void {
      try {
        ask();
      } catch {
        // a wake that fails changes nothing
      }
    },
    async tick(): Promise<void> {
      if (stopped) return;
      // One deadline for the whole tick, shared by the stale read and the wait for the pass.
      const deadline = Date.now() + limit;
      try {
        await checkStale(deadline);
      } catch {
        // the check never stops a tick
      }
      try {
        const own = ask();
        if (own === null) return;
        if (!(await within(own.settled, Math.max(0, deadline - Date.now())))) {
          own.ctl.stop = true;
          log({ event: 'learning_failed', reason: 'timeout' });
        }
      } catch {
        // a tick never rejects
      }
    },
    idle,
    stop(): void {
      stopped = true;
      pending = false;
    },
  };
}
