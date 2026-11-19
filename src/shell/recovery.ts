import { requeueJob, unfinishedJobs } from '../db/jobs.ts';
import type { Db } from '../db/types.ts';

/** PM-recovery: puts every running job back to pending, due at `now`, its starts kept. One whose pull request already has a pending job is dropped as `superseded`. Logs { event: 'recovery', requeued, dropped }. */
export async function recoverJobs(db: Db, now: Date, log: (entry: Record<string, unknown>) => void): Promise<{ requeued: number; dropped: number }> {
  const at = now.toISOString();
  let requeued = 0;
  let dropped = 0;
  for (const job of await unfinishedJobs(db)) {
    if (job.status !== 'running') continue;
    if (await requeueJob(db, job.id, at, at, false) === 'requeued') requeued += 1;
    else dropped += 1;
  }
  log({ event: 'recovery', requeued, dropped });
  return { requeued, dropped };
}
