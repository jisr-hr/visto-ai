// The reads of the UI's frame and Activity screen (UI design 3.1; calls 13, 14, 16 and 20). Read only, and only inside an API
// request. Owner and repo are stored lower-cased.
import type { Db } from './types.ts';

/** A review job running or pending, with its pull request's title and stored head when the pull request is stored. */
export interface JobRow {
  id: number; owner: string; repo: string; number: number; reason: string; head_sha: string; trigger: string; requested_by: string | null;
  status: string; run_at: Date; starts: number; started_at: Date | null; created_at: Date; stage: string | null; batch: number | null; batches: number | null;
  threads_due: number | null; title: string | null; stored_head: string | null;
}

/** The review jobs running (by when they started) and then pending (by when they may start), the lower id first at a tie; at most `limit`. */
export async function activityJobs(db: Db, limit: number): Promise<JobRow[]> {
  return db.query<JobRow>(
    `select j.id, j.owner, j.repo, j.number, j.reason, j.head_sha, j.trigger, j.requested_by, j.status, j.run_at, j.starts,
            j.started_at, j.created_at, j.stage, j.batch, j.batches, j.threads_due, p.title, p.head_sha as stored_head
     from visto_ai.jobs j
     left join visto_ai.pull_requests p on p.service = j.service and p.owner = j.owner and p.repo = j.repo and p.number = j.number
     where j.kind = 'review' and j.status in ('pending', 'running')
     order by case when j.status = 'running' then 0 else 1 end, case when j.status = 'running' then j.started_at else j.run_at end, j.id
     limit $1`,
    [limit]);
}

/**
 * The withdraw jobs waiting to try again after a failed try (pending, with at least one start and a retry code), with that code; at
 * most `limit`. One with starts and no code (a crash's recovery, or starts handed on by a superseded one) tried nothing that failed.
 */
export async function waitingWithdrawals(db: Db, limit: number): Promise<Array<{ owner: string; repo: string; number: number; retry_code: string | null; run_at: Date }>> {
  return db.query(
    `select owner, repo, number, retry_code, run_at from visto_ai.jobs
     where kind = 'withdraw' and status = 'pending' and starts > 0 and retry_code is not null
     order by run_at, id limit $1`,
    [limit]);
}

/** The repositories a pull request is stored of, as `owner/repo`, sorted; at most `limit`. */
export async function knownRepositories(db: Db, limit: number): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `select distinct owner || '/' || repo as name from visto_ai.pull_requests order by name limit $1`,
    [limit]);
  return rows.map((r) => r.name);
}

/**
 * `since`: the window's start, an ISO time. `repository`: `owner/repo` in lower case. `kinds`: the outcomes kept (call 20).
 * `title`: text the title holds, letter case aside, taken as itself; with it, `number` also matches the run's number.
 * `before`: only runs of a lower id. Each null reads as no filter.
 */
export interface ReviewFilters { since: string; repository: string | null; kinds: string[] | null; title: string | null; number: number | null; before: number | null }
/** A run of the window, its outcome as `kind` (call 20) and its placed findings counted by severity. */
export interface ReviewRow {
  id: number; owner: string; repo: string; number: number; title: string | null; mode: 'full' | 'incremental' | 'recheck'; dry_run: boolean;
  failure_code: string | null; highest_score: number; cost: number; started_at: Date; finished_at: Date;
  threshold: number | null; blockers: number; majors: number; minors: number; kind: string;
}

// $1 the window's start, $2 the repository or null.
const INNER = `select r.id, r.owner, r.repo, r.number, p.title, r.mode, r.dry_run, r.failure_code, r.highest_score, r.cost::float8 as cost,
       r.started_at, r.finished_at,
       case when jsonb_typeof(r.result->'verdict'->'threshold') = 'number' then (r.result->'verdict'->>'threshold')::float8 end as threshold,
       (select count(*) from jsonb_array_elements(case when jsonb_typeof(r.result->'findings') = 'array' then r.result->'findings' else '[]'::jsonb end) f
        where f->>'severity' = 'blocker')::int as blockers,
       (select count(*) from jsonb_array_elements(case when jsonb_typeof(r.result->'findings') = 'array' then r.result->'findings' else '[]'::jsonb end) f
        where f->>'severity' = 'major')::int as majors,
       (select count(*) from jsonb_array_elements(case when jsonb_typeof(r.result->'findings') = 'array' then r.result->'findings' else '[]'::jsonb end) f
        where f->>'severity' = 'minor')::int as minors,
       case
         when r.outcome = 'failed' then 'failed'
         when not r.published and r.result->'nothingToDo' = 'true'::jsonb then 'nothing_new'
         when r.approval_code = 'audit_sample' then 'audit'
         when r.approved then 'approved'
         when not r.dry_run and not r.published then 'not_posted'
         when r.needs_human then 'needs_person'
         else 'reviewed'
       end as kind
from visto_ai.review_runs r
left join visto_ai.pull_requests p on p.service = r.service and p.owner = r.owner and p.repo = r.repo and p.number = r.number
where r.started_at >= $1::timestamptz and ($2::text is null or r.owner || '/' || r.repo = $2)`;

/** $3 to $5 of the filters: the kinds joined with commas, the title's pattern with `\`, `%` and `_` escaped, and the number. */
function filterParams(f: ReviewFilters): [string, string | null, string | null, string | null, number | null] {
  return [
    f.since, f.repository, f.kinds === null ? null : f.kinds.join(','),
    f.title === null ? null : '%' + f.title.replaceAll(/[\\%_]/g, (c) => '\\' + c) + '%',
    f.number,
  ];
}

/** The runs of the window that pass the filters, newest first; at most `limit`. */
export async function recentReviews(db: Db, f: ReviewFilters, limit: number): Promise<ReviewRow[]> {
  return db.query<ReviewRow>(
    `select * from (${INNER}) x
     where ($3::text is null or x.kind = any(string_to_array($3, ',')))
       and ($4::text is null or x.title ilike $4 escape '\\' or ($5::integer is not null and x.number = $5::integer))
       and ($6::integer is null or x.id < $6::integer)
     order by x.id desc
     limit $7`,
    [...filterParams(f), f.before, limit]);
}

/** How many runs of the window pass the filters; `before` is not read. */
export async function countReviews(db: Db, f: ReviewFilters): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from (${INNER}) x
     where ($3::text is null or x.kind = any(string_to_array($3, ',')))
       and ($4::text is null or x.title ilike $4 escape '\\' or ($5::integer is not null and x.number = $5::integer))`,
    filterParams(f));
  return rows[0]?.n ?? 0;
}
