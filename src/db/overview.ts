// What the Overview counts (the UI plan's Overview; calls 15 to 18): the reviews of a window, each UTC day's, the pull requests approved
// automatically. Read-only statements; `$1` is the start of the window.
import type { Db } from './types.ts';

export interface ReviewTotals { total: number; published: number; dry_run: number; failed: number; nothing_new: number; not_posted: number; repositories: number }
export interface DayRow { day: string; published: number; failed: number; other: number; cost: number }

/** The runs started in the window, split so the parts add up. */
export async function reviewTotals(db: Db, since: string): Promise<ReviewTotals> {
  const rows = await db.query<ReviewTotals>(
    `select count(*)::int as total,
            (count(*) filter (where outcome = 'ok' and published))::int as published,
            (count(*) filter (where outcome = 'ok' and dry_run))::int as dry_run,
            (count(*) filter (where outcome = 'failed'))::int as failed,
            (count(*) filter (where outcome = 'ok' and not dry_run and not published and result -> 'nothingToDo' = 'true'::jsonb))::int as nothing_new,
            (count(*) filter (where outcome = 'ok' and not dry_run and not published
                               and (result -> 'nothingToDo') is distinct from 'true'::jsonb))::int as not_posted,
            (count(distinct owner || '/' || repo))::int as repositories
     from visto_ai.review_runs where started_at >= $1::timestamptz`,
    [since]);
  return rows[0]!;
}

/** The runs of each UTC day of the window, oldest first. */
export function reviewsPerDay(db: Db, since: string): Promise<DayRow[]> {
  return db.query<DayRow>(
    `select to_char(started_at at time zone 'UTC', 'YYYY-MM-DD') as day,
            (count(*) filter (where outcome = 'ok' and published))::int as published,
            (count(*) filter (where outcome = 'failed'))::int as failed,
            (count(*) filter (where outcome = 'ok' and not published))::int as other,
            coalesce(sum(cost), 0)::float8 as cost
     from visto_ai.review_runs where started_at >= $1::timestamptz group by 1 order by 1`,
    [since]);
}

/** The judge's calls' cost of each UTC day of the window, oldest first. */
export function judgeCostPerDay(db: Db, since: string): Promise<Array<{ day: string; cost: number }>> {
  return db.query<{ day: string; cost: number }>(
    `select to_char(at at time zone 'UTC', 'YYYY-MM-DD') as day, coalesce(sum(cost), 0)::float8 as cost
     from visto_ai.judge_calls where at >= $1::timestamptz group by 1 order by 1`,
    [since]);
}

/** Pull requests approved and drawn for the audit, each once, by its newest published live decision of the window (call 17). */
export async function approvalCounts(db: Db, since: string): Promise<{ approved: number; audited: number }> {
  const rows = await db.query<{ approved: number; audited: number }>(
    `select (count(*) filter (where approved))::int as approved, (count(*) filter (where approval_code = 'audit_sample'))::int as audited
     from (select distinct on (owner, repo, number) approved, approval_code from visto_ai.review_runs
           where started_at >= $1::timestamptz and published and not dry_run and (approved or approval_code is not null)
           order by owner, repo, number, id desc) d`,
    [since]);
  return rows[0]!;
}

/** The busiest repositories of the window, then by name. */
export async function reviewedRepositories(db: Db, since: string, limit: number): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `select owner || '/' || repo as name from visto_ai.review_runs where started_at >= $1::timestamptz
     group by owner, repo order by count(*) desc, name limit $2`,
    [since, limit]);
  return rows.map((r) => r.name);
}
