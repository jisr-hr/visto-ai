import { claimJob, dropJobIfUnchanged, dueJobs, finishJob } from '../db/jobs.ts';
import type { Job, JobKind } from '../db/jobs.ts';
import type { Db } from '../db/types.ts';
import type { PullRequestRef } from '../forge/types.ts';

export const MAX_STARTS = 3;
export const MAX_AGE_MS = 24 * 3_600_000;

type Log = (entry: Record<string, unknown>) => void;

export interface RunnerDeps {
  db: Db; concurrency: number; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  /** The lane of the queue this runner takes its jobs from. */
  kind: JobKind;
  /** false: start nothing now. */
  mayStart: () => Promise<boolean>;
  /** Takes one claimed job to its end and writes its outcome. */
  run: (job: Job) => Promise<void>;
  /** Told when a job has left the runner: its run ended (resolved or threw), or it was dropped as too old or out of starts. */
  onLeft?: (job: Job, how: 'ended' | 'too_old' | 'attempts_exhausted') => Promise<void>;
}
export interface Runner {
  /** Starts due jobs while there is a free place. Resolves when the claims are made, not when the jobs end. A call made while one is under way is folded into one more pass, and resolves when that pass has ended. */
  tick(): Promise<void>;
  /** From now on nothing is started. Resolves when the pass under way, if any, has ended and no job is running. */
  drain(): Promise<void>;
  running(): number;
  /** Whether a job of that pull request is running in this process. */
  holds(ref: PullRequestRef): boolean;
}

/** The error's name and, when it is a string, its code. Never its message. */
function describe(err: unknown): { error: string; code: string | null } {
  const o = typeof err === 'object' && err !== null ? err as { name?: unknown; code?: unknown } : {};
  return {
    error: typeof o.name === 'string' ? o.name : 'unknown',
    code: typeof o.code === 'string' ? o.code : null,
  };
}

const keyOf = (ref: PullRequestRef): string => `${ref.service}/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;

export function createRunner(deps: RunnerDeps): Runner {
  const { db } = deps;
  const log: Log = (entry) => {
    try {
      deps.log(entry);
    } catch {
      // a logger that fails changes nothing
    }
  };
  const keys = new Set<string>();           // pull requests with a job running in this process
  const ends = new Set<Promise<void>>();    // every started job, until it has been finished in the database
  let draining = false;
  let current: Promise<void> | null = null; // the pass under way
  let folded: Promise<void> | null = null;  // the one more pass asked for meanwhile

  const free = (): boolean => keys.size < deps.concurrency;

  /** Tells `onLeft`, when given. Its failure is logged and changes nothing. */
  const left = async (job: Job, how: 'ended' | 'too_old' | 'attempts_exhausted'): Promise<void> => {
    if (deps.onLeft === undefined) return;
    try {
      await deps.onLeft(job, how);
    } catch (err) {
      log({ event: 'runner_failed', job: job.id, ...describe(err) });
    }
  };

  /** Drops the job as it was listed. false when it was replaced or taken meanwhile: a later pass sees it again. */
  const dropped = async (job: Job, reason: 'too_old' | 'attempts_exhausted', now: Date): Promise<boolean> => {
    if (!(await dropJobIfUnchanged(db, job, reason, now.toISOString()))) return false;
    log({ event: 'job', job: job.id, repo: `${job.ref.owner}/${job.ref.repo}`, number: job.ref.number, outcome: 'dropped', reason });
    await left(job, reason);
    return true;
  };

  const start = (job: Job): void => {
    const key = keyOf(job.ref);
    keys.add(key);
    const ended: Promise<void> = (async () => {
      try {
        await deps.run(job);
      } catch (err) {
        try {
          if (await finishJob(db, job.id, 'done', 'failed', deps.clock().toISOString())) {
            log({ event: 'job', job: job.id, repo: `${job.ref.owner}/${job.ref.repo}`, number: job.ref.number, outcome: 'failed', reason: 'internal_error', error: describe(err).error });
          }
        } catch (finishErr) {
          log({ event: 'runner_failed', job: job.id, ...describe(finishErr) });
        }
      } finally {
        keys.delete(key);
      }
      await left(job, 'ended');
    })().finally(() => {
      ends.delete(ended);
      void tick();
    });
    ends.add(ended);
  };

  /** One pass over the due jobs. True when it started or dropped something. */
  const pass = async (): Promise<boolean> => {
    if (draining || !free()) return false;
    try {
      if (!(await deps.mayStart())) return false;
    } catch (err) {
      log({ event: 'gate_failed', ...describe(err) });
      return false;
    }
    let progressed = false;
    const now = deps.clock();
    for (const due of await dueJobs(db, now.toISOString(), deps.concurrency, deps.kind)) {
      if (draining || !free()) break;
      if (keys.has(keyOf(due.ref))) continue;
      if (Date.parse(due.createdAt) < now.getTime() - MAX_AGE_MS) {
        if (await dropped(due, 'too_old', now)) progressed = true;
        continue;
      }
      if (due.starts >= MAX_STARTS) {
        if (await dropped(due, 'attempts_exhausted', now)) progressed = true;
        continue;
      }
      const claimed = await claimJob(db, due.id, now.toISOString());
      if (claimed === null) continue;
      start(claimed);
      progressed = true;
    }
    return progressed;
  };

  const loop = async (): Promise<void> => {
    try {
      while (await pass() && free() && !draining) {
        // go again while something was started or dropped and a place is free
      }
    } catch (err) {
      log({ event: 'runner_failed', ...describe(err) });
    }
  };

  function tick(): Promise<void> {
    if (current === null) {
      current = loop().finally(() => { current = null; });
      return current;
    }
    folded ??= current.then(() => {
      folded = null;
      return tick();
    });
    return folded;
  }

  return {
    tick,
    running: () => keys.size,
    holds: (ref) => keys.has(keyOf(ref)),
    async drain(): Promise<void> {
      draining = true;
      for (;;) {
        const waiting = [...ends];
        if (current !== null) waiting.push(current);
        if (waiting.length === 0) return;
        await Promise.all(waiting);
      }
    },
  };
}
