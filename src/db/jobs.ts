import type { PullRequestRef } from '../forge/types.ts';
import { storable, storableOrNull } from './text.ts';
import type { Db } from './types.ts';

export type JobStatus = 'pending' | 'running' | 'done' | 'dropped';
export interface Job {
  id: number; ref: PullRequestRef;      // owner and repo in lower case
  reason: string;                       // the event that queued it: opened, reopened, ready_for_review, synchronize, retargeted
  headSha: string;                      // the head that event named
  status: JobStatus; outcome: string | null;
  runAt: string; starts: number; createdAt: string;
}

interface Row {
  id: number; service: 'github'; owner: string; repo: string; number: number;
  reason: string; head_sha: string; status: JobStatus; outcome: string | null;
  run_at: Date; starts: number; created_at: Date;
}
const COLUMNS = 'id, service, owner, repo, number, reason, head_sha, status, outcome, run_at, starts, created_at';

function toJob(r: Row): Job {
  return {
    id: r.id, ref: { service: r.service, owner: r.owner, repo: r.repo, number: r.number },
    reason: r.reason, headSha: r.head_sha, status: r.status, outcome: r.outcome,
    runAt: r.run_at.toISOString(), starts: r.starts, createdAt: r.created_at.toISOString(),
  };
}

/**
 * One pending job per pull request. With none, a job is stored and its id returned. With one: when `replace` is true
 * its reason, head, time and delivery are replaced, its starts go back to 0, its creation time becomes `now` and its id
 * is returned; when `replace` is false it is left as it is and null is returned.
 */
export async function enqueueJob(db: Db, j: { ref: PullRequestRef; reason: string; headSha: string; runAt: string; now: string; delivery: string | null; replace: boolean }): Promise<number | null> {
  const onConflict = j.replace
    ? `do update set reason = excluded.reason, head_sha = excluded.head_sha, run_at = excluded.run_at,
              starts = 0, created_at = excluded.created_at, delivery = excluded.delivery`
    : 'do nothing';
  const rows = await db.query<{ id: number }>(
    `insert into visto_ai.jobs (service, owner, repo, number, reason, head_sha, status, run_at, starts, created_at, delivery)
     values ($1, $2, $3, $4, $5, $6, 'pending', $7::timestamptz, 0, $8::timestamptz, $9)
     on conflict (service, owner, repo, number) where status = 'pending'
     ${onConflict}
     returning id`,
    [
      j.ref.service, storable(j.ref.owner).toLowerCase(), storable(j.ref.repo).toLowerCase(), j.ref.number,
      storable(j.reason), storable(j.headSha), j.runAt, j.now, storableOrNull(j.delivery),
    ]);
  return rows[0]?.id ?? null;
}

/** Pending jobs whose time is at or before `now`, earliest time first, then lowest id; at most `limit`. */
export async function dueJobs(db: Db, now: string, limit: number): Promise<Job[]> {
  const rows = await db.query<Row>(
    `select ${COLUMNS} from visto_ai.jobs
     where status = 'pending' and run_at <= $1::timestamptz
     order by run_at, id
     limit $2`,
    [now, limit]);
  return rows.map(toJob);
}

/** pending and due -> running, counting a start. null when the job is not pending any more or its time is after `now`. */
export async function claimJob(db: Db, id: number, now: string): Promise<Job | null> {
  const rows = await db.query<Row>(
    `update visto_ai.jobs set status = 'running', starts = starts + 1, started_at = $2::timestamptz
     where id = $1 and status = 'pending' and run_at <= $2::timestamptz
     returning ${COLUMNS}`,
    [id, now]);
  return rows[0] === undefined ? null : toJob(rows[0]);
}

/** pending or running -> done or dropped, with its outcome. false when it was already finished. */
export async function finishJob(db: Db, id: number, status: 'done' | 'dropped', outcome: string, now: string): Promise<boolean> {
  const rows = await db.query(
    `update visto_ai.jobs set status = $2, outcome = $3, finished_at = $4::timestamptz
     where id = $1 and status in ('pending', 'running')
     returning id`,
    [id, status, storable(outcome), now]);
  return rows.length === 1;
}

/** pending -> dropped, with its outcome, only when the job still has the starts and creation time it was listed with. false when it was replaced, taken or finished meanwhile. */
export async function dropJobIfUnchanged(db: Db, job: Pick<Job, 'id' | 'starts' | 'createdAt'>, outcome: string, now: string): Promise<boolean> {
  const rows = await db.query(
    `update visto_ai.jobs set status = 'dropped', outcome = $4, finished_at = $5::timestamptz
     where id = $1 and status = 'pending' and starts = $2 and created_at = $3::timestamptz
     returning id`,
    [job.id, job.starts, job.createdAt, storable(outcome), now]);
  return rows.length === 1;
}

/**
 * running -> pending, due at `runAt`; with `giveBackStart` its count of starts goes down by one. When the pull request
 * already has a pending job, this one is dropped with outcome `superseded` instead, finished at `now`.
 * It runs its statements outside any transaction, so it is the one place that may catch a statement's error.
 */
export async function requeueJob(db: Db, id: number, runAt: string, now: string, giveBackStart: boolean): Promise<'requeued' | 'superseded'> {
  let requeued = false;
  try {
    const rows = await db.query(
      `update visto_ai.jobs j set status = 'pending', run_at = $2::timestamptz, starts = starts - $3
       where j.id = $1 and j.status = 'running'
         and not exists (select 1 from visto_ai.jobs p where p.status = 'pending'
                         and p.service = j.service and p.owner = j.owner and p.repo = j.repo and p.number = j.number)
       returning id`,
      [id, runAt, giveBackStart ? 1 : 0]);
    requeued = rows.length === 1;
  } catch (error) {
    if ((error as { code?: unknown }).code !== '23505') throw error;
  }
  if (requeued) return 'requeued';
  await db.query(
    `update visto_ai.jobs set status = 'dropped', outcome = 'superseded', finished_at = $2::timestamptz
     where id = $1 and status = 'running'`,
    [id, now]);
  return 'superseded';
}

/** Every pending or running job, lowest id first. */
export async function unfinishedJobs(db: Db): Promise<Job[]> {
  const rows = await db.query<Row>(`select ${COLUMNS} from visto_ai.jobs where status in ('pending', 'running') order by id`);
  return rows.map(toJob);
}

export async function getJob(db: Db, id: number): Promise<Job | null> {
  const rows = await db.query<Row>(`select ${COLUMNS} from visto_ai.jobs where id = $1`, [id]);
  return rows[0] === undefined ? null : toJob(rows[0]);
}

/** Deletes done and dropped jobs finished before `before`. Returns how many. */
export async function deleteFinishedJobs(db: Db, before: string): Promise<number> {
  const rows = await db.query(
    `delete from visto_ai.jobs where status in ('done', 'dropped') and finished_at < $1::timestamptz returning id`,
    [before]);
  return rows.length;
}
