import type { PullRequestRef } from '../forge/types.ts';
import { storable } from './text.ts';
import type { Db } from './types.ts';

export interface StoredComment { commentId: string; path: string; side: 'LEFT' | 'RIGHT'; line: number | null; severity: string; quote: string }

interface Row {
  run: number; comment_id: string; path: string; side: 'LEFT' | 'RIGHT'; line: number | null; severity: string; quote: string;
}

/** Stores a run's posted comments. One already stored (same comment id) is left as it is. */
export async function recordComments(db: Db, runId: number, ref: PullRequestRef, comments: StoredComment[]): Promise<void> {
  for (const c of comments) {
    await db.query(
      `insert into visto_ai.review_comments (run, service, owner, repo, number, comment_id, path, side, line, severity, quote)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (service, comment_id) do nothing`,
      [
        runId, ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number,
        storable(c.commentId), storable(c.path), c.side, c.line, storable(c.severity), storable(c.quote),
      ]);
  }
}

/** A pull request's stored comments, lowest id first, each with the run it belongs to. */
export async function listComments(db: Db, ref: PullRequestRef): Promise<Array<StoredComment & { run: number }>> {
  const rows = await db.query<Row>(
    `select run, comment_id, path, side, line, severity, quote from visto_ai.review_comments
     where service = $1 and owner = $2 and repo = $3 and number = $4
     order by id`,
    [ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number]);
  return rows.map((r) => ({ commentId: r.comment_id, path: r.path, side: r.side, line: r.line, severity: r.severity, quote: r.quote, run: r.run }));
}
