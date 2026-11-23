import type { PullRequestRef } from '../forge/types.ts';
import { storable } from './text.ts';
import type { Db } from './types.ts';

// closed and not_found: a sync found the live pull request closed, or gone; no check was read or written.
export type GateState = 'waiting' | 'paused' | 'reviewing' | 'passed' | 'blocked' | 'failed' | 'skipped' | 'bypassed' | 'closed' | 'not_found';
export interface GateCounts {
  blocking: number; clearedByReview: number; clearedByReply: number; silentResolves: number; unknownThreads: number;
  findings: number; notReviewed: number; withoutThread: number; refusedInline: number;
}
export const NO_COUNTS: GateCounts = { blocking: 0, clearedByReview: 0, clearedByReply: 0, silentResolves: 0, unknownThreads: 0, findings: 0, notReviewed: 0, withoutThread: 0, refusedInline: 0 };
export interface Evaluation {
  ref: PullRequestRef; headSha: string; at: string;
  mode: 'enforce' | 'shadow' | 'bypass'; state: GateState;
  code: string | null;                 // of a failure or a pause
  run: number | null;                  // the review run the check was decided on
  counts: GateCounts;
}

const keyOf = (ref: PullRequestRef): [string, string, string, number] =>
  [ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number];

export async function recordEvaluation(db: Db, e: Evaluation): Promise<void> {
  const c = e.counts;
  await db.query(
    `insert into visto_ai.gate_evaluations
       (service, owner, repo, number, head_sha, at, mode, state, code, run,
        blocking, cleared_by_review, cleared_by_reply, silent_resolves, unknown_threads,
        findings, not_reviewed, without_thread, refused_inline)
     values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      ...keyOf(e.ref), storable(e.headSha), e.at, e.mode, e.state, e.code === null ? null : storable(e.code), e.run,
      c.blocking, c.clearedByReview, c.clearedByReply, c.silentResolves, c.unknownThreads,
      c.findings, c.notReviewed, c.withoutThread, c.refusedInline,
    ]);
}

/** The newest evaluation of the pull request, or null. */
export async function lastEvaluation(db: Db, ref: PullRequestRef): Promise<{ headSha: string; mode: string; state: string; code: string | null } | null> {
  const rows = await db.query<{ head_sha: string; mode: string; state: string; code: string | null }>(
    `select head_sha, mode, state, code from visto_ai.gate_evaluations
     where service = $1 and owner = $2 and repo = $3 and number = $4
     order by id desc
     limit 1`,
    keyOf(ref));
  const r = rows[0];
  return r === undefined ? null : { headSha: r.head_sha, mode: r.mode, state: r.state, code: r.code };
}

/** The newest evaluation of each pull request that has one. */
export async function lastEvaluations(db: Db): Promise<Array<{ ref: PullRequestRef; mode: string; state: string }>> {
  const rows = await db.query<{ service: 'github'; owner: string; repo: string; number: number; mode: string; state: string }>(
    `select distinct on (service, owner, repo, number) service, owner, repo, number, mode, state
     from visto_ai.gate_evaluations
     order by service, owner, repo, number, id desc`);
  return rows.map((r) => ({ ref: { service: r.service, owner: r.owner, repo: r.repo, number: r.number }, mode: r.mode, state: r.state }));
}

export interface Skip { ref: PullRequestRef; headSha: string; actor: string; reason: string; commentId: string; at: string }

/** false when this comment's skip was already stored. */
export async function recordSkip(db: Db, s: Skip): Promise<boolean> {
  const rows = await db.query(
    `insert into visto_ai.gate_overrides (service, owner, repo, number, head_sha, actor, reason, comment_id, at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
     on conflict (service, comment_id) do nothing
     returning id`,
    [...keyOf(s.ref), storable(s.headSha), storable(s.actor), storable(s.reason), storable(s.commentId), s.at]);
  return rows.length === 1;
}

/** The newest skip stored for this head of the pull request, or null. */
export async function skipOf(db: Db, ref: PullRequestRef, headSha: string): Promise<{ actor: string; reason: string } | null> {
  const rows = await db.query<{ actor: string; reason: string }>(
    `select actor, reason from visto_ai.gate_overrides
     where service = $1 and owner = $2 and repo = $3 and number = $4 and head_sha = $5
     order by id desc
     limit 1`,
    [...keyOf(ref), storable(headSha)]);
  return rows[0] ?? null;
}
