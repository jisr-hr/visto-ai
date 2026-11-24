import type { PullRequestRef } from '../forge/types.ts';
import { storable } from './text.ts';
import type { Db } from './types.ts';

// closed and not_found: a sync found the live pull request closed, or gone; no check was read or written.
// unwithdrawn: an approval of the app's whose withdrawal failed still stands.
export type GateState = 'waiting' | 'paused' | 'reviewing' | 'passed' | 'blocked' | 'failed' | 'skipped' | 'bypassed' | 'closed' | 'not_found' | 'unwithdrawn';
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

/**
 * The pull requests the gate recorded an evaluation for and the service stores no row of (opened before the app was
 * installed), with the state of the newest evaluation and the installation of the newest job of the pull request that
 * has one (null when none has).
 */
export async function evaluatedUnstored(db: Db): Promise<Array<{ ref: PullRequestRef; state: string; installation: string | null }>> {
  const rows = await db.query<{ service: 'github'; owner: string; repo: string; number: number; state: string; installation: string | null }>(
    // The newest row of each pull request is picked first; the installation is then looked up for those rows only.
    `select n.service, n.owner, n.repo, n.number, n.state,
            (select j.installation from visto_ai.jobs j
              where j.service = n.service and j.owner = n.owner and j.repo = n.repo and j.number = n.number and j.installation is not null
              order by j.id desc limit 1) as installation
     from (select distinct on (e.service, e.owner, e.repo, e.number) e.service, e.owner, e.repo, e.number, e.state
           from visto_ai.gate_evaluations e
           where not exists (select 1 from visto_ai.pull_requests p
                             where p.service = e.service and p.owner = e.owner and p.repo = e.repo and p.number = e.number)
           order by e.service, e.owner, e.repo, e.number, e.id desc) n
     order by n.service, n.owner, n.repo, n.number`);
  return rows.map((r) => ({ ref: { service: r.service, owner: r.owner, repo: r.repo, number: r.number }, state: r.state, installation: r.installation }));
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
