// The reads of the UI's One review page (UI design 3.3; calls 5, 6, 8, 11, 12, 15 and 19). Read only, and only inside an API
// request. Owner and repo of a ref are lower-cased before the statement.
import type { PullRequestRef } from '../forge/types.ts';
import { storable } from './text.ts';
import type { Db } from './types.ts';

const keyOf = (ref: PullRequestRef): [string, string, string, number] =>
  [ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number];

/** A run, with its pull request's and its job's facts and its place among the runs of its pull request. */
export interface RunRow {
  id: number; service: 'github'; owner: string; repo: string; number: number; job: number | null;
  trigger: 'automatic' | 'manual'; mode: 'full' | 'incremental' | 'recheck'; dry_run: boolean; head_sha: string; base_branch: string | null;
  outcome: 'ok' | 'failed'; failure_stage: string | null; failure_code: string | null;
  result: unknown;   // without audit, overview, acceptance and providers; null when the stored result is no object
  calls: number; input_tokens: number; output_tokens: number; cached_tokens: number; cost: number;
  started_at: Date; finished_at: Date; published: boolean; published_at: Date | null; approved: boolean; approval_code: string | null;
  body_tail: string | null;   // the body's last 4,000 characters, read only when approval_code is set
  title: string | null; author: string | null; head_branch: string | null; pr_base_branch: string | null;   // of its pull request
  job_reason: string | null; job_requested_by: string | null;   // of its job; null when it has none or it was deleted
  ordinal: number; runs: number;
}

export async function runOf(db: Db, id: number): Promise<RunRow | null> {
  const rows = await db.query<RunRow>(
    `select r.id, r.service, r.owner, r.repo, r.number, r.job, r.trigger, r.mode, r.dry_run, r.head_sha, r.base_branch, r.outcome,
            r.failure_stage, r.failure_code,
            case when jsonb_typeof(r.result) = 'object' then r.result - 'audit' - 'overview' - 'acceptance' - 'providers' end as result,
            r.calls, r.input_tokens, r.output_tokens, r.cached_tokens, r.cost::float8 as cost,
            r.started_at, r.finished_at, r.published, r.published_at, r.approved, r.approval_code,
            case when r.approval_code is not null then right(r.body, 4000) end as body_tail,
            p.title, p.author, p.head_branch, p.base_branch as pr_base_branch,
            j.reason as job_reason, j.requested_by as job_requested_by,
            (select count(*) from visto_ai.review_runs o
             where o.service = r.service and o.owner = r.owner and o.repo = r.repo and o.number = r.number and o.id <= r.id)::int as ordinal,
            (select count(*) from visto_ai.review_runs o
             where o.service = r.service and o.owner = r.owner and o.repo = r.repo and o.number = r.number)::int as runs
     from visto_ai.review_runs r
     left join visto_ai.pull_requests p on p.service = r.service and p.owner = r.owner and p.repo = r.repo and p.number = r.number
     left join visto_ai.jobs j on j.id = r.job
     where r.id = $1`,
    [id]);
  return rows[0] ?? null;
}

export interface CommentRow { comment_id: string; path: string; side: string; line: number | null; severity: string; quote: string }

/** The findings a run posted as inline comments, in the order stored; never its notes. */
export async function runComments(db: Db, run: number): Promise<CommentRow[]> {
  return db.query<CommentRow>(
    `select comment_id, path, side, line, severity, quote from visto_ai.review_comments
     where run = $1 and severity in ('blocker', 'major', 'minor')
     order by id`,
    [run]);
}

export interface ThreadEventRow { reply_to: string; kind: 'thread_resolved' | 'thread_unresolved'; author: string; at: Date }

/** The resolve and unresolve events of the threads those first comments started, oldest first. */
export async function threadEvents(db: Db, ref: PullRequestRef, commentIds: string[]): Promise<ThreadEventRow[]> {
  if (commentIds.length === 0) return [];
  return db.query<ThreadEventRow>(
    `select reply_to, kind, author, at from visto_ai.human_activity
     where service = $1 and owner = $2 and repo = $3 and number = $4
       and kind in ('thread_resolved', 'thread_unresolved')
       and reply_to in (select jsonb_array_elements_text($5::jsonb))
     order by at, id`,
    [...keyOf(ref), JSON.stringify(commentIds)]);
}

export interface VerdictRow { run: number; started_at: Date; comment_id: string; verdict: string | null }

/** The verdicts that published runs after `after` kept for those first comments, oldest run first. */
export async function laterVerdicts(db: Db, ref: PullRequestRef, after: number, commentIds: string[]): Promise<VerdictRow[]> {
  if (commentIds.length === 0) return [];
  return db.query<VerdictRow>(
    `select r.id as run, r.started_at, v ->> 'commentId' as comment_id, v ->> 'verdict' as verdict
     from visto_ai.review_runs r
     cross join lateral jsonb_array_elements(
       case when jsonb_typeof(r.result -> 'threadVerdicts') = 'array' then r.result -> 'threadVerdicts' else '[]'::jsonb end) as v
     where r.service = $1 and r.owner = $2 and r.repo = $3 and r.number = $4 and r.published and r.id > $5
       and jsonb_typeof(v) = 'object'
       and v ->> 'commentId' in (select jsonb_array_elements_text($6::jsonb))
     order by r.id`,
    [...keyOf(ref), after, JSON.stringify(commentIds)]);
}

export interface GateRow { mode: string; state: string; code: string | null; blocking: number; refused_inline: number }

/** The newest gate evaluation at a head, or null. */
export async function gateAt(db: Db, ref: PullRequestRef, head: string): Promise<GateRow | null> {
  const rows = await db.query<GateRow>(
    `select mode, state, code, blocking, refused_inline from visto_ai.gate_evaluations
     where service = $1 and owner = $2 and repo = $3 and number = $4 and head_sha = $5
     order by id desc limit 1`,
    [...keyOf(ref), head]);
  return rows[0] ?? null;
}

export interface ApprovalRow {
  run: number; ordinal: number; head_sha: string; dismissed_at: Date | null; dismissed_by: string | null; dismiss_failure: string | null; stood_at_merge: Date | null;
}

/** The approvals the app posted up to and including a run, newest first; at most `limit`. */
export async function approvalsUpTo(db: Db, ref: PullRequestRef, run: number, limit: number): Promise<ApprovalRow[]> {
  return db.query<ApprovalRow>(
    `select r.id as run, r.head_sha, r.dismissed_at, r.dismissed_by, r.dismiss_failure, r.stood_at_merge,
            (select count(*) from visto_ai.review_runs o
             where o.service = r.service and o.owner = r.owner and o.repo = r.repo and o.number = r.number and o.id <= r.id)::int as ordinal
     from visto_ai.review_runs r
     where r.service = $1 and r.owner = $2 and r.repo = $3 and r.number = $4 and r.approved and r.id <= $5
     order by r.id desc limit $6`,
    [...keyOf(ref), run, limit]);
}

/** The withdraw job of the pull request waiting to try again after a failed try, as Activity lists them; null when none waits. */
export async function pendingWithdrawal(db: Db, ref: PullRequestRef): Promise<{ run_at: Date } | null> {
  const rows = await db.query<{ run_at: Date }>(
    `select run_at from visto_ai.jobs
     where service = $1 and owner = $2 and repo = $3 and number = $4 and kind = 'withdraw' and status = 'pending'
       and starts > 0 and retry_code is not null
     order by id desc limit 1`,
    keyOf(ref));
  return rows[0] ?? null;
}

export interface FeedbackRow { reason: string; login: string }

/** The thumbs counted by vote, and the newest reasons people gave; at most `limit`. */
export async function runFeedback(db: Db, run: number, limit: number): Promise<{ up: number; down: number; reasons: FeedbackRow[] }> {
  const counts = await db.query<{ up: number; down: number }>(
    `select (count(*) filter (where vote = 'up'))::int as up, (count(*) filter (where vote = 'down'))::int as down
     from visto_ai.review_feedback where run = $1`,
    [run]);
  const reasons = await db.query<FeedbackRow>(
    `select reason, login from visto_ai.review_feedback
     where run = $1 and reason is not null
     order by at desc, id desc limit $2`,
    [run, limit]);
  return { up: counts[0]?.up ?? 0, down: counts[0]?.down ?? 0, reasons };
}

export interface PullRunRow { id: number; finished_at: Date; ordinal: number; total: number }

/** The runs of a pull request, newest first, each with its place among all of them and their total; at most `limit`. */
export async function pullRuns(db: Db, ref: PullRequestRef, limit: number): Promise<PullRunRow[]> {
  return db.query<PullRunRow>(
    `select id, finished_at, (row_number() over (order by id))::int as ordinal, (count(*) over ())::int as total
     from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number = $4
     order by id desc limit $5`,
    [...keyOf(ref), limit]);
}
