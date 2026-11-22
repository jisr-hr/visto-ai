import type { PullRequestRef } from '../forge/types.ts';
import { storable, storableOrNull } from './text.ts';
import type { Db } from './types.ts';

/** `around`: the surroundings the score was given among; null on a row stored without them, which no one reuses. */
export interface StoredBlockScore { path: string; hash: string; around: string | null; score: number; category: string; reason: string }

/** The most pairs asked in one statement. */
const CHUNK = 500;

/** Stores the scores a run gave, one row each. `by` says who gave them; `at` is when the run finished. */
export async function recordBlockScores(db: Db, runId: number, ref: PullRequestRef, by: 'model' | 'scorer', scores: StoredBlockScore[], at: string): Promise<void> {
  if (scores.length === 0) return;
  const rows = scores.map((s) => ({
    path: storable(s.path), hash: storable(s.hash), around: storableOrNull(s.around), score: s.score, category: storable(s.category), reason: storable(s.reason),
  }));
  await db.query(
    `insert into visto_ai.block_scores (run, service, owner, repo, number, path, hash, around, score, category, reason, scored_by, scored_at)
     select $1, $2, $3, $4, $5, s.path, s.hash, s.around, s.score, s.category, s.reason, $6, $7::timestamptz
     from jsonb_to_recordset($8::jsonb) as s(path text, hash text, around text, score integer, category text, reason text)`,
    [runId, ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number, by, at, JSON.stringify(rows)]);
}

/**
 * For each (path, hash, around) asked: the highest score stored for it, by `by`, by another pull request of the same
 * repository at or after `since`. A row with no surroundings matches nothing: the join leaves none without them.
 */
export async function reusableScores(db: Db, ref: PullRequestRef, by: 'model' | 'scorer', blocks: Array<{ path: string; hash: string; around: string }>, since: string): Promise<Array<StoredBlockScore & { around: string }>> {
  const found: Array<StoredBlockScore & { around: string }> = [];
  for (let i = 0; i < blocks.length; i += CHUNK) {
    const pairs = blocks.slice(i, i + CHUNK).map((b) => ({ path: storable(b.path), hash: storable(b.hash), around: storable(b.around) }));
    const rows = await db.query<StoredBlockScore & { around: string }>(
      `select distinct on (b.path, b.hash, b.around) b.path, b.hash, b.around, b.score, b.category, b.reason
       from visto_ai.block_scores b
       join jsonb_to_recordset($6::jsonb) as p(path text, hash text, around text) on p.path = b.path and p.hash = b.hash and p.around = b.around
       where b.service = $1 and b.owner = $2 and b.repo = $3 and b.scored_by = $4
         and b.number <> $5 and b.scored_at >= $7::timestamptz
       order by b.path, b.hash, b.around, b.score desc, b.scored_at desc, b.id desc`,
      [ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), by, ref.number, JSON.stringify(pairs), since]);
    found.push(...rows);
  }
  return found;
}
