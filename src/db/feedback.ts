import { storable } from './text.ts';
import type { Db } from './types.ts';

export interface Feedback { run: number; login: string; vote: 'up' | 'down'; reason: string | null; extension: string; at: string }

/** Stores one person's answer on a published run, in place of the answer that person gave before. false when no published run has that id. */
export async function recordFeedback(db: Db, f: Feedback): Promise<boolean> {
  const rows = await db.query(
    `insert into visto_ai.review_feedback (run, service, owner, repo, number, login, vote, reason, extension, at)
     select id, service, owner, repo, number, $2, $3, $4, $5, $6::timestamptz
     from visto_ai.review_runs
     where id = $1 and published = true and dry_run = false
     on conflict (run, login) do update set vote = excluded.vote, reason = excluded.reason, extension = excluded.extension, at = excluded.at
     returning id`,
    [f.run, storable(f.login), f.vote, f.reason === null ? null : storable(f.reason), storable(f.extension), f.at]);
  return rows.length === 1;
}
