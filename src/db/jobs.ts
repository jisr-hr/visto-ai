import type { PullRequestRef } from '../forge/types.ts';
import { storable, storableOrNull } from './text.ts';
import type { Db } from './types.ts';

export type JobStatus = 'pending' | 'running' | 'done' | 'dropped';
/** The lane of the queue: a review, or the gate's check and commands. */
export type JobKind = 'review' | 'gate';
export interface Job {
  id: number; ref: PullRequestRef;      // owner and repo in lower case
  kind: JobKind;
  // review lane: opened, reopened, ready_for_review, synchronize, retargeted, command, done, rerun, or command_retry,
  // done_retry, rerun_retry; gate lane: sync, done, skip, rerun
  reason: string;
  headSha: string;                      // the head the event named; '' for a manual job, which reviews the live head
  trigger: 'automatic' | 'manual';
  requestedBy: string | null;           // who commented /review
  commentId: string | null;             // that comment
  association: string | null;           // the commenter's association with the repository, as the event gave it
  installation: string | null;          // the installation the command came through
  status: JobStatus; outcome: string | null;
  runAt: string; starts: number; createdAt: string;
}

interface Row {
  id: number; service: 'github'; owner: string; repo: string; number: number; kind: JobKind;
  reason: string; head_sha: string; trigger: 'automatic' | 'manual';
  requested_by: string | null; comment_id: string | null; association: string | null; installation: string | null;
  status: JobStatus; outcome: string | null;
  run_at: Date; starts: number; created_at: Date;
}
const COLUMNS = 'id, service, owner, repo, number, kind, reason, head_sha, trigger, requested_by, comment_id, association, installation, '
  + 'status, outcome, run_at, starts, created_at';

function toJob(r: Row): Job {
  return {
    id: r.id, ref: { service: r.service, owner: r.owner, repo: r.repo, number: r.number }, kind: r.kind,
    reason: r.reason, headSha: r.head_sha, trigger: r.trigger,
    requestedBy: r.requested_by, commentId: r.comment_id, association: r.association, installation: r.installation,
    status: r.status, outcome: r.outcome,
    runAt: r.run_at.toISOString(), starts: r.starts, createdAt: r.created_at.toISOString(),
  };
}

/**
 * One pending job per pull request and kind (absent reads as `review`). With none, a job is stored and its id returned. With one: when `replace` is true
 * every field of the pending job becomes this job's, its starts go back to 0 and its id is returned, except that an
 * automatic job never replaces a pending manual one (null is returned and nothing changes); when `replace` is false
 * the pending job is left as it is and null is returned. A job of the other kind is never touched.
 */
export async function enqueueJob(db: Db, j: {
  ref: PullRequestRef; reason: string; headSha: string; runAt: string; now: string; delivery: string | null; replace: boolean;
  trigger: 'automatic' | 'manual'; requestedBy: string | null; commentId: string | null; association: string | null; installation: string | null;
  kind?: JobKind;
}): Promise<number | null> {
  const onConflict = !j.replace
    ? 'do nothing'
    : `do update set reason = excluded.reason, head_sha = excluded.head_sha, trigger = excluded.trigger,
              requested_by = excluded.requested_by, comment_id = excluded.comment_id, association = excluded.association,
              installation = excluded.installation, run_at = excluded.run_at,
              starts = 0, created_at = excluded.created_at, delivery = excluded.delivery
       ${j.trigger === 'automatic' ? "where visto_ai.jobs.trigger = 'automatic'" : ''}`;
  const rows = await db.query<{ id: number }>(
    `insert into visto_ai.jobs (service, owner, repo, number, reason, head_sha, status, run_at, starts, created_at, delivery,
                                trigger, requested_by, comment_id, association, installation, kind)
     values ($1, $2, $3, $4, $5, $6, 'pending', $7::timestamptz, 0, $8::timestamptz, $9, $10, $11, $12, $13, $14, $15)
     on conflict (service, owner, repo, number, kind) where status = 'pending'
     ${onConflict}
     returning id`,
    [
      j.ref.service, storable(j.ref.owner).toLowerCase(), storable(j.ref.repo).toLowerCase(), j.ref.number,
      storable(j.reason), storable(j.headSha), j.runAt, j.now, storableOrNull(j.delivery),
      j.trigger, storableOrNull(j.requestedBy), storableOrNull(j.commentId), storableOrNull(j.association), storableOrNull(j.installation),
      j.kind ?? 'review',
    ]);
  return rows[0]?.id ?? null;
}

/** Pending jobs of one kind whose time is at or before `now`, earliest time first, then lowest id; at most `limit`. */
export async function dueJobs(db: Db, now: string, limit: number, kind: JobKind): Promise<Job[]> {
  const rows = await db.query<Row>(
    `select ${COLUMNS} from visto_ai.jobs
     where status = 'pending' and kind = $3 and run_at <= $1::timestamptz
     order by run_at, id
     limit $2`,
    [now, limit, kind]);
  return rows.map(toJob);
}

/** The review jobs of a pull request that are not finished (pending or running), lowest id first. */
export async function reviewJobsOf(db: Db, ref: PullRequestRef): Promise<Job[]> {
  const rows = await db.query<Row>(
    `select ${COLUMNS} from visto_ai.jobs
     where service = $1 and owner = $2 and repo = $3 and number = $4
       and kind = 'review' and status in ('pending', 'running')
     order by id`,
    [ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number]);
  return rows.map(toJob);
}

/**
 * Stores a gate job of reason `sync` for the pull request, due at `runAt` (at `now` when not given). A pending sync is
 * kept as it is and only takes this time. null when a pending command of the gate stands in the slot: it asks again
 * when it ends. Not `enqueueJob` with `replace`, which would set a waiting sync's starts back to 0.
 */
export async function askGate(db: Db, ref: PullRequestRef, now: string, runAt?: string): Promise<number | null> {
  const rows = await db.query<{ id: number }>(
    `insert into visto_ai.jobs (service, owner, repo, number, kind, reason, head_sha, status, run_at, starts, created_at, delivery,
                                trigger, requested_by, comment_id, association, installation)
     values ($1, $2, $3, $4, 'gate', 'sync', '', 'pending', $5::timestamptz, 0, $6::timestamptz, null,
             'automatic', null, null, null, null)
     on conflict (service, owner, repo, number, kind) where status = 'pending'
     do update set run_at = excluded.run_at
     where visto_ai.jobs.trigger = 'automatic'
     returning id`,
    [ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number, runAt ?? now, now]);
  return rows[0]?.id ?? null;
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
 * already has a pending job of the same kind, this one is dropped with outcome `superseded` instead, finished at `now`,
 * with two exceptions for the gate's lane: a command (a manual gate job) takes the place of a waiting sync, which is
 * dropped as `superseded`; and a sync that is superseded by a waiting sync hands it its count of starts when that is
 * higher. A job of the other kind never supersedes.
 * It runs its statements outside any transaction, so it is the one place that may catch a statement's error.
 */
export async function requeueJob(db: Db, id: number, runAt: string, now: string, giveBackStart: boolean): Promise<'requeued' | 'superseded'> {
  const back = giveBackStart ? 1 : 0;
  const putBack = async (): Promise<boolean> => {
    try {
      const rows = await db.query(
        `update visto_ai.jobs j set status = 'pending', run_at = $2::timestamptz, starts = starts - $3
         where j.id = $1 and j.status = 'running'
           and not exists (select 1 from visto_ai.jobs p where p.status = 'pending' and p.kind = j.kind
                           and p.service = j.service and p.owner = j.owner and p.repo = j.repo and p.number = j.number)
         returning id`,
        [id, runAt, back]);
      return rows.length === 1;
    } catch (error) {
      if ((error as { code?: unknown }).code !== '23505') throw error;
      return false;
    }
  };
  if (await putBack()) return 'requeued';
  // A gate command keeps its place against a waiting sync; once more when a sync was stored between the two statements.
  for (let round = 0; round < 2; round += 1) {
    const freed = await db.query(
      `update visto_ai.jobs p set status = 'dropped', outcome = 'superseded', finished_at = $2::timestamptz
       from visto_ai.jobs j
       where j.id = $1 and j.status = 'running' and j.kind = 'gate' and j.trigger = 'manual'
         and p.status = 'pending' and p.kind = 'gate' and p.trigger = 'automatic'
         and p.service = j.service and p.owner = j.owner and p.repo = j.repo and p.number = j.number
       returning p.id`,
      [id, now]);
    if (freed.length === 0) break;
    if (await putBack()) return 'requeued';
  }
  await db.query(
    `with this as (
       update visto_ai.jobs set status = 'dropped', outcome = 'superseded', finished_at = $2::timestamptz
       where id = $1 and status = 'running'
       returning service, owner, repo, number, kind, trigger, starts - $3 as starts
     )
     update visto_ai.jobs p set starts = greatest(p.starts, this.starts)
     from this
     where this.kind = 'gate' and this.trigger = 'automatic'
       and p.status = 'pending' and p.kind = 'gate' and p.trigger = 'automatic'
       and p.service = this.service and p.owner = this.owner and p.repo = this.repo and p.number = this.number`,
    [id, now, back]);
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
