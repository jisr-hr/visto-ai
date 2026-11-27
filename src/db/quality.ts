// The reads of a repository's live score quality (the plan "The UI's Overview, Repositories and Memory"; calls 23 to 29). Read
// only, and only from an API request's computation, one statement at a time. Owner and repo are stored lower-cased; a list of
// numbers or ids is passed as one JSON text. No statement reads a comment's body, a quote, or a stored result but its scores.
import type { RepoKey } from './memory-records.ts';
import { storable } from './text.ts';
import type { Db } from './types.ts';

const keyOf = (repo: RepoKey): [string, string, string] => [repo.service, storable(repo.owner).toLowerCase(), storable(repo.repo).toLowerCase()];
const listOf = (values: readonly number[]): string => JSON.stringify(values);

/** The repository's closed pull requests closed at or after `since`, the newest close first; at most `limit`. */
export async function closedPulls(db: Db, repo: RepoKey, since: string, limit: number): Promise<Array<{ number: number; author: string | null; closed_at: Date }>> {
  return db.query(
    `select number, author, coalesce(merged_at, closed_at) as closed_at from visto_ai.pull_requests
     where service = $1 and owner = $2 and repo = $3 and state in ('merged', 'closed') and coalesce(merged_at, closed_at) >= $4::timestamptz
     order by coalesce(merged_at, closed_at) desc, number desc
     limit $5`,
    [...keyOf(repo), since, limit]);
}

/** The runs of those pull requests that did not fail, a nothing-new one included, by number then id from the highest; at most `limit`. No result is read. */
export async function okRuns(db: Db, repo: RepoKey, numbers: readonly number[], limit: number): Promise<Array<{ id: number; number: number; head_sha: string; started_at: Date }>> {
  return db.query(
    `select id, number, head_sha, started_at from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number in (select (jsonb_array_elements_text($4::jsonb))::int) and outcome = 'ok'
     order by number desc, id desc
     limit $5`,
    [...keyOf(repo), listOf(numbers), limit]);
}

/** Each run's stored scores; null for a run whose stored result is over `maxBytes` as stored (which reads no value), or holds none. */
export async function runScores(db: Db, ids: readonly number[], maxBytes: number): Promise<Array<{ id: number; scores: unknown }>> {
  return db.query(
    `select id, case when pg_column_size(result) <= $2 then result -> 'scores' end as scores
     from visto_ai.review_runs where id in (select (jsonb_array_elements_text($1::jsonb))::int)`,
    [listOf(ids), maxBytes]);
}

/** The inline comments of those pull requests, the highest number first, each one's in the order they were made; at most `limit`. No body is read. */
export async function inlineCommentsOf(db: Db, repo: RepoKey, numbers: readonly number[], limit: number): Promise<Array<{
  id: string; number: number; author: string; path: string | null; side: string | null; line: number | null; start_line: number | null;
  file_level: boolean | null; commit: string | null; reply_to: string | null }>> {
  return db.query(
    `select source_id as id, number, author, path, side, line, start_line, file_level, commit, reply_to from visto_ai.human_activity
     where service = $1 and owner = $2 and repo = $3 and number in (select (jsonb_array_elements_text($4::jsonb))::int) and kind = 'inline_comment'
     order by number desc, at, id
     limit $5`,
    [...keyOf(repo), listOf(numbers), limit]);
}

/** The ids of the app's posted findings on those pull requests (not its notes): the first comments of the threads people's replies are not counted in. */
export async function findingThreads(db: Db, repo: RepoKey, numbers: readonly number[]): Promise<Array<{ number: number; comment_id: string }>> {
  return db.query(
    `select number, comment_id from visto_ai.review_comments
     where service = $1 and owner = $2 and repo = $3 and number in (select (jsonb_array_elements_text($4::jsonb))::int)
       and severity in ('blocker', 'major', 'minor')`,
    [...keyOf(repo), listOf(numbers)]);
}

/** The repository's merged pull requests that revert another, the newest merge first, each with whether the reverted one held an approval of the app never withdrawn; at most `limit`. */
export async function mergedReverts(db: Db, repo: RepoKey, limit: number): Promise<Array<{ number: number; reverts: number; merged_at: Date; approved: boolean }>> {
  return db.query(
    `select p.number, p.reverts, p.merged_at,
            exists (select 1 from visto_ai.review_runs r
                    where r.service = p.service and r.owner = p.owner and r.repo = p.repo and r.number = p.reverts
                      and r.approved and r.published and not r.dry_run and r.dismissed_at is null) as approved
     from visto_ai.pull_requests p
     where p.service = $1 and p.owner = $2 and p.repo = $3 and p.state = 'merged' and p.reverts is not null
     order by p.merged_at desc
     limit $4`,
    [...keyOf(repo), limit]);
}

/** Those of the pull requests with a published run drawn for the audit. */
export async function auditedPulls(db: Db, repo: RepoKey, numbers: readonly number[]): Promise<number[]> {
  const rows = await db.query<{ number: number }>(
    `select distinct number from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number in (select (jsonb_array_elements_text($4::jsonb))::int)
       and published and approval_code = 'audit_sample'`,
    [...keyOf(repo), listOf(numbers)]);
  return rows.map((r) => r.number);
}

/** The answers given since `since`: helpful and not helpful. */
export async function feedbackCounts(db: Db, repo: RepoKey, since: string): Promise<{ up: number; down: number }> {
  const rows = await db.query<{ up: number; down: number }>(
    `select (count(*) filter (where vote = 'up'))::int as up, (count(*) filter (where vote = 'down'))::int as down
     from visto_ai.review_feedback where service = $1 and owner = $2 and repo = $3 and at >= $4::timestamptz`,
    [...keyOf(repo), since]);
  return { up: rows[0]?.up ?? 0, down: rows[0]?.down ?? 0 };
}

/** The reasons given since `since` with "not helpful", grouped by their trimmed text, letter case aside, the most given first, each in its newest wording cut at 200 characters; at most `limit`. */
export async function feedbackReasons(db: Db, repo: RepoKey, since: string, limit: number): Promise<Array<{ reason: string; count: number }>> {
  return db.query(
    `select (array_agg(left(btrim(reason), 200) order by at desc, id desc))[1] as reason, count(*)::int as count
     from visto_ai.review_feedback
     where service = $1 and owner = $2 and repo = $3 and at >= $4::timestamptz and vote = 'down' and reason is not null and btrim(reason) <> ''
     group by lower(btrim(reason))
     order by count desc, lower(btrim(reason))
     limit $5`,
    [...keyOf(repo), since, limit]);
}
