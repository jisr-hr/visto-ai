import type { Association, HumanReview, PullRequestRef, Side } from '../forge/types.ts';
import type { Activity } from './human-activity.ts';
import { storable } from './text.ts';
import type { Db } from './types.ts';

export interface LearningState { since: string; ranAt: string | null; examined: number; added: number; retired: number; failed: number }

interface StateRow { since: Date; ran_at: Date | null; examined: number; added: number; retired: number; failed: number }

const toState = (r: StateRow): LearningState => ({
  since: r.since.toISOString(), ranAt: r.ran_at?.toISOString() ?? null,
  examined: r.examined, added: r.added, retired: r.retired, failed: r.failed,
});

const lowered = (ref: PullRequestRef): PullRequestRef => ({
  service: ref.service, owner: storable(ref.owner).toLowerCase(), repo: storable(ref.repo).toLowerCase(), number: ref.number,
});

/** The row of that work, made with `since = now` when it is not there. A row that is there is not changed. */
export async function startLearning(db: Db, work: string, now: string): Promise<LearningState> {
  await db.query(
    'insert into visto_ai.learning (work, since) values ($1, $2::timestamptz) on conflict (work) do nothing',
    [storable(work), now]);
  return (await readLearning(db, work))!;
}

/** A pass completed: `ran_at = now`, and each total raised by its count. Makes the row when it is not there. */
export async function noteLearning(db: Db, work: string, now: string, counts: { examined: number; added: number; retired: number; failed: number }): Promise<void> {
  await db.query(
    `insert into visto_ai.learning (work, since, ran_at, examined, added, retired, failed)
     values ($1, $2::timestamptz, $2::timestamptz, $3, $4, $5, $6)
     on conflict (work) do update set
       ran_at = excluded.ran_at,
       examined = visto_ai.learning.examined + excluded.examined,
       added = visto_ai.learning.added + excluded.added,
       retired = visto_ai.learning.retired + excluded.retired,
       failed = visto_ai.learning.failed + excluded.failed`,
    [storable(work), now, counts.examined, counts.added, counts.retired, counts.failed]);
}

export async function readLearning(db: Db, work: string): Promise<LearningState | null> {
  const rows = await db.query<StateRow>(
    'select since, ran_at, examined, added, retired, failed from visto_ai.learning where work = $1',
    [storable(work)]);
  return rows[0] === undefined ? null : toState(rows[0]);
}

export interface ToLearn { ref: PullRequestRef; author: string; closedAt: string | null }   // closedAt: null while the pull request is open

interface ToLearnRow { service: 'github'; owner: string; repo: string; number: number; author: string; closed: Date | null }

/** The stored pull requests with work that come after `after` (null: from the first) in the order of service, owner, repository and number; at most `limit`. One with `maxAttempts` failed attempts or more is left out. */
export async function pullRequestsToLearn(db: Db, limit: number, after: PullRequestRef | null, maxAttempts: number): Promise<ToLearn[]> {
  const a = after === null ? null : lowered(after);
  const rows = await db.query<ToLearnRow>(
    `select p.service, p.owner, p.repo, p.number, p.author,
            case when p.state = 'open' then null else coalesce(p.closed_at, p.merged_at, p.updated_at) end as closed
     from visto_ai.pull_requests p
     where p.learn_attempts < $1
       and ($2::boolean or (p.service, p.owner, p.repo, p.number) > ($3::text, $4::text, $5::text, $6::integer))
       and (
         (p.state <> 'open' and (p.learned_at is null or p.learned_at < coalesce(p.closed_at, p.merged_at, p.updated_at)))
         or exists (
           select 1 from visto_ai.human_activity h
           where h.service = p.service and h.owner = p.owner and h.repo = p.repo and h.number = p.number
             and h.kind = 'inline_comment' and h.learned_at is null))
     order by p.service, p.owner, p.repo, p.number
     limit $7`,
    [maxAttempts, a === null, a?.service ?? '', a?.owner ?? '', a?.repo ?? '', a?.number ?? 0, limit]);
  return rows.map((r) => ({
    ref: { service: r.service, owner: r.owner, repo: r.repo, number: r.number },
    author: r.author, closedAt: r.closed?.toISOString() ?? null,
  }));
}

interface CommentRow {
  source_id: string; author: string; association: Association | null;
  state: HumanReview['state'] | null; body: string;
  path: string | null; side: Side | null; line: number | null; start_line: number | null; file_level: boolean | null;
  commit: string | null; reply_to: string | null; thread: string | null; at: Date; delivery: string | null;
  learned: boolean;
}

/** Every inline comment stored for the pull request, oldest first, each with whether it was looked at. */
export async function inlineComments(db: Db, ref: PullRequestRef): Promise<Array<{ comment: Activity; learned: boolean }>> {
  const r = lowered(ref);
  const rows = await db.query<CommentRow>(
    `select source_id, author, association, state, body, path, side, line, start_line, file_level,
            commit, reply_to, thread, at, delivery, learned_at is not null as learned
     from visto_ai.human_activity
     where service = $1 and owner = $2 and repo = $3 and number = $4 and kind = 'inline_comment'
     order by at, id`,
    [r.service, r.owner, r.repo, r.number]);
  return rows.map((x) => ({
    comment: {
      ref: r, kind: 'inline_comment', sourceId: x.source_id, author: x.author, association: x.association,
      state: x.state, body: x.body,
      path: x.path, side: x.side, line: x.line, startLine: x.start_line, fileLevel: x.file_level,
      commit: x.commit, replyTo: x.reply_to, thread: x.thread,
      at: x.at.toISOString(), delivery: x.delivery,
    },
    learned: x.learned,
  }));
}

/** Marks those inline comments as looked at, at `now`; one already marked keeps its time. With `closed`, the pull request is marked as learned at the later of `now` and `closed`. The pull request's failed attempts are set to 0. One statement. */
export async function markLearned(db: Db, ref: PullRequestRef, comments: string[], now: string, closed: string | null): Promise<void> {
  const r = lowered(ref);
  await db.query(
    `with marked as (
       update visto_ai.human_activity set learned_at = $5::timestamptz
       where service = $1 and owner = $2 and repo = $3 and number = $4 and kind = 'inline_comment' and learned_at is null
         and source_id in (select jsonb_array_elements_text($6::jsonb))
       returning 1
     )
     update visto_ai.pull_requests set
       learn_attempts = 0,
       learned_at = case when $7::timestamptz is null then learned_at else greatest($5::timestamptz, $7::timestamptz) end
     where service = $1 and owner = $2 and repo = $3 and number = $4`,
    [r.service, r.owner, r.repo, r.number, now, JSON.stringify(comments.map(storable)), closed]);
}

/** One more failed attempt for the pull request. Returns the count it has now; 0 when the pull request is not stored. */
export async function noteLearnFailure(db: Db, ref: PullRequestRef): Promise<number> {
  const r = lowered(ref);
  const rows = await db.query<{ n: number }>(
    `update visto_ai.pull_requests set learn_attempts = learn_attempts + 1
     where service = $1 and owner = $2 and repo = $3 and number = $4
     returning learn_attempts as n`,
    [r.service, r.owner, r.repo, r.number]);
  return rows[0]?.n ?? 0;
}
