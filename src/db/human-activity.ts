import type { Association, HumanReview, PullRequestRef, Side } from '../forge/types.ts';
import { storable, storableOrNull } from './text.ts';
import type { Db } from './types.ts';

export type ActivityKind = 'review' | 'inline_comment' | 'general_comment' | 'thread_resolved' | 'thread_unresolved';
export interface Activity {
  ref: PullRequestRef; kind: ActivityKind;
  sourceId: string;                 // the git service's id of the review or comment; the delivery id for a thread event
  author: string; association: Association | null;
  state: HumanReview['state'] | null; body: string;
  path: string | null; side: Side | null; line: number | null; startLine: number | null; fileLevel: boolean | null;
  commit: string | null; replyTo: string | null; thread: string | null;
  at: string;
  delivery: string | null;          // the delivery that brought it; null for a row that came another way
}

/** false when it was already stored (same service, kind and source id). */
export async function recordActivity(db: Db, a: Activity): Promise<boolean> {
  const rows = await db.query(
    `insert into visto_ai.human_activity
       (service, owner, repo, number, kind, source_id, author, association, state, body,
        path, side, line, start_line, file_level, commit, reply_to, thread, at, delivery)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::timestamptz, $20)
     on conflict (service, kind, source_id) do nothing
     returning id`,
    [
      a.ref.service, storable(a.ref.owner).toLowerCase(), storable(a.ref.repo).toLowerCase(), a.ref.number,
      a.kind, storable(a.sourceId), storable(a.author), a.association, a.state, storable(a.body),
      storableOrNull(a.path), a.side, a.line, a.startLine, a.fileLevel,
      storableOrNull(a.commit), storableOrNull(a.replyTo), storableOrNull(a.thread), a.at, storableOrNull(a.delivery),
    ]);
  return rows.length === 1;
}

interface Row {
  kind: ActivityKind; source_id: string; author: string; association: Association | null;
  state: HumanReview['state'] | null; body: string;
  path: string | null; side: Side | null; line: number | null; start_line: number | null; file_level: boolean | null;
  commit: string | null; reply_to: string | null; thread: string | null; at: Date; delivery: string | null;
}

/** Oldest first: by `at`, then by insertion. */
export async function listActivity(db: Db, ref: PullRequestRef): Promise<Activity[]> {
  const owner = storable(ref.owner).toLowerCase();
  const repo = storable(ref.repo).toLowerCase();
  const rows = await db.query<Row>(
    `select kind, source_id, author, association, state, body, path, side, line, start_line, file_level,
            commit, reply_to, thread, at, delivery
     from visto_ai.human_activity
     where service = $1 and owner = $2 and repo = $3 and number = $4
     order by at, id`,
    [ref.service, owner, repo, ref.number]);
  return rows.map((r) => ({
    ref: { service: ref.service, owner, repo, number: ref.number },
    kind: r.kind, sourceId: r.source_id, author: r.author, association: r.association,
    state: r.state, body: r.body,
    path: r.path, side: r.side, line: r.line, startLine: r.start_line, fileLevel: r.file_level,
    commit: r.commit, replyTo: r.reply_to, thread: r.thread,
    at: r.at.toISOString(), delivery: r.delivery,
  }));
}
