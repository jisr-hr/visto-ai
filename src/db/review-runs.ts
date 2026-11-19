import type { PullRequestRef } from '../forge/types.ts';
import { storable, storableJson, storableOrNull } from './text.ts';
import type { Db } from './types.ts';

export interface RunUsage { calls: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }
export interface RunRecord {
  ref: PullRequestRef; job: number | null;
  trigger: 'automatic' | 'manual'; mode: 'full'; dryRun: boolean;
  headSha: string; baseSha: string | null;          // baseSha is null when the run failed before the pull request was read
  outcome: 'ok' | 'failed'; failureStage: string | null; failureCode: string | null;
  needsHuman: boolean; highestScore: number;
  body: string;                                     // the review text as it would be posted; '' when none was rendered
  comments: unknown;                                // the inline comments as they would be posted
  result: unknown;                                  // the engine's result
  usage: RunUsage;
  startedAt: string; finishedAt: string;
}
export interface StoredRun extends RunRecord { id: number }

/** Appends one row. Returns its id. */
export async function recordRun(db: Db, run: RunRecord): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `insert into visto_ai.review_runs
       (service, owner, repo, number, job, trigger, mode, dry_run, head_sha, base_sha, outcome,
        failure_stage, failure_code, needs_human, highest_score, body, comments, result,
        calls, input_tokens, output_tokens, cached_tokens, cost, started_at, finished_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb,
             $19, $20, $21, $22, $23, $24::timestamptz, $25::timestamptz)
     returning id`,
    [
      run.ref.service, storable(run.ref.owner).toLowerCase(), storable(run.ref.repo).toLowerCase(), run.ref.number,
      run.job, run.trigger, run.mode, run.dryRun, storable(run.headSha), storableOrNull(run.baseSha), run.outcome,
      storableOrNull(run.failureStage), storableOrNull(run.failureCode), run.needsHuman, run.highestScore,
      storable(run.body), storableJson(run.comments), storableJson(run.result),
      run.usage.calls, run.usage.inputTokens, run.usage.outputTokens, run.usage.cachedTokens, run.usage.cost,
      run.startedAt, run.finishedAt,
    ]);
  return rows[0]!.id;
}

interface Row {
  id: number; job: number | null; trigger: RunRecord['trigger']; mode: 'full'; dry_run: boolean;
  head_sha: string; base_sha: string | null; outcome: RunRecord['outcome'];
  failure_stage: string | null; failure_code: string | null; needs_human: boolean; highest_score: number;
  body: string; comments: unknown; result: unknown;
  calls: number; input_tokens: number; output_tokens: number; cached_tokens: number; cost: number;
  started_at: Date; finished_at: Date;
}

/** A pull request's runs, lowest id first. */
export async function listRuns(db: Db, ref: PullRequestRef): Promise<StoredRun[]> {
  const owner = storable(ref.owner).toLowerCase();
  const repo = storable(ref.repo).toLowerCase();
  const rows = await db.query<Row>(
    `select id, job, trigger, mode, dry_run, head_sha, base_sha, outcome, failure_stage, failure_code,
            needs_human, highest_score, body, comments, result,
            calls, input_tokens, output_tokens, cached_tokens, cost::float8 as cost, started_at, finished_at
     from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number = $4
     order by id`,
    [ref.service, owner, repo, ref.number]);
  return rows.map((r) => ({
    id: r.id, ref: { service: ref.service, owner, repo, number: ref.number }, job: r.job,
    trigger: r.trigger, mode: r.mode, dryRun: r.dry_run, headSha: r.head_sha, baseSha: r.base_sha,
    outcome: r.outcome, failureStage: r.failure_stage, failureCode: r.failure_code,
    needsHuman: r.needs_human, highestScore: r.highest_score,
    body: r.body, comments: r.comments, result: r.result,
    usage: { calls: r.calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cachedTokens: r.cached_tokens, cost: r.cost },
    startedAt: r.started_at.toISOString(), finishedAt: r.finished_at.toISOString(),
  }));
}

/** The summed cost of the runs started at or after `since`. 0 when there are none. */
export async function spentSince(db: Db, since: string): Promise<number> {
  const rows = await db.query<{ spent: number }>(
    'select coalesce(sum(cost), 0)::float8 as spent from visto_ai.review_runs where started_at >= $1::timestamptz',
    [since]);
  return rows[0]!.spent;
}

/** Whether the pull request has a run with outcome `ok` at this head and this base, of the same kind (dry or live). */
export async function hasOkRun(db: Db, ref: PullRequestRef, headSha: string, baseSha: string, dryRun: boolean): Promise<boolean> {
  const rows = await db.query(
    `select 1 from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number = $4
       and head_sha = $5 and base_sha = $6 and dry_run = $7 and outcome = 'ok'
     limit 1`,
    [ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number,
      storable(headSha), storable(baseSha), dryRun]);
  return rows.length === 1;
}
