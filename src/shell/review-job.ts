import type { RepoSettings } from '../config/load.ts';
import { enqueueJob, finishJob, requeueJob } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import { getPullRequest } from '../db/pull-requests.ts';
import { hasOkRun, recordRun } from '../db/review-runs.ts';
import type { RunRecord } from '../db/review-runs.ts';
import type { Db } from '../db/types.ts';
import { renderReview } from '../engine/render/body.ts';
import type { InlineComment } from '../engine/render/body.ts';
import type { Span } from '../engine/score/types.ts';
import type { Limits, ReviewDeps, ReviewInput, ReviewResult, Usage } from '../engine/types.ts';
import type { ForgeAccess, LivePullRequest, PullRequestInfo, Source } from '../forge/types.ts';
import { PAUSE_MS } from './model-health.ts';
import type { ModelHealth } from './model-health.ts';
import { QUIET_SECONDS, skipReason } from './triggers.ts';

export const RECORD_WAITS_MS = [1_000, 5_000];
/** The wait before a job the git service failed is tried again: after its first start, then after its second or third. */
export const RETRY_WAITS_MS = [60_000, 900_000];

type Log = (entry: Record<string, unknown>) => void;

export interface ReviewJobDeps {
  db: Db; forge: ForgeAccess; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  sleep: (ms: number) => Promise<void>;
  settingsFor: (fullName: string) => RepoSettings;
  limits: Limits;
  dryRun: boolean;
  /** The engine's dependencies for one review, around the source it is given. */
  engineDeps: (source: Source) => ReviewDeps;
  /** The engine's entry point. */
  review: (input: ReviewInput, deps: ReviewDeps) => Promise<ReviewResult>;
  lineUrl: (pr: PullRequestInfo, file: { path: string; previousPath: string | null }, span: Span) => string;
  health: Pick<ModelHealth, 'reviewed'>;
  spend: { noteRun(usage: Usage): void };
}

const SHORT_CODE = /^[a-z][a-z0-9_]*$/;
const NO_USAGE: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };

/** The error's message when it is a short code, else internal_error. */
function codeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message.length <= 40 && SHORT_CODE.test(message) ? message : 'internal_error';
}

/** Takes one claimed job to its end: drops it, puts it back, or reviews and records. Never rejects. */
export async function runReviewJob(job: Job, deps: ReviewJobDeps): Promise<void> {
  const { db } = deps;
  const repo = `${job.ref.owner}/${job.ref.repo}`;
  const log: Log = (entry) => {
    try {
      deps.log(entry);
    } catch {
      // a logger that fails changes nothing
    }
  };
  const now = deps.clock();
  const nowIso = now.toISOString();
  const at = (ms: number): string => new Date(now.getTime() + ms).toISOString();
  /** `ms` after the clock as it reads now; after the job's start when the clock fails. */
  const later = (ms: number): string => {
    let t = now;
    try {
      t = deps.clock();
    } catch {
      // a clock that fails leaves the start's time
    }
    return new Date(t.getTime() + ms).toISOString();
  };
  const retryWait = RETRY_WAITS_MS[job.starts <= 1 ? 0 : 1]!;

  /** Runs one write, up to three times, with the waits between. false when the third try failed too. */
  const tried = async (write: () => Promise<void>): Promise<boolean> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await write();
        return true;
      } catch {
        const wait = RECORD_WAITS_MS[attempt];
        if (wait === undefined) return false;
        try {
          await deps.sleep(wait);
        } catch {
          // a sleep that fails only shortens the wait
        }
      }
    }
  };

  const dropped = async (reason: string, write: () => Promise<void>): Promise<void> => {
    const done = await tried(write);
    log({ event: 'job', job: job.id, repo, number: job.ref.number, outcome: done ? 'dropped' : 'drop_failed', reason });
  };
  const drop = (reason: string): Promise<void> =>
    dropped(reason, async () => { await finishJob(db, job.id, 'dropped', reason, nowIso); });

  let result: ReviewResult | null = null;
  try {
    // 1. The installation.
    const stored = await getPullRequest(db, job.ref);
    if (stored === null || stored.installation === null) return await drop('no_installation');
    const installation = stored.installation;

    // 2. The live read.
    let live: LivePullRequest | null = null;
    let prepareError: unknown = null;
    try {
      live = await deps.forge.readPullRequest(job.ref, installation);
    } catch (error) {
      prepareError = error;
    }
    if (prepareError === null) {
      if (live === null) return await drop('not_found');

      // 3. The checks.
      const reason = skipReason({ state: live.state, draft: live.info.draft, author: live.info.author, baseBranch: live.info.baseBranch }, deps.settingsFor(repo));
      if (reason !== null) return await drop(reason);
      if (live.info.headSha !== job.headSha) {
        const head = live.info.headSha;
        return await dropped('stale_head', () => db.transaction(async (tx) => {
          await enqueueJob(tx, { ref: job.ref, reason: job.reason, headSha: head, runAt: at(QUIET_SECONDS * 1000), now: nowIso, delivery: null, replace: false,
            trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null });
          await finishJob(tx, job.id, 'dropped', 'stale_head', nowIso);
        }));
      }
      if (await hasOkRun(db, job.ref, live.info.headSha, live.info.baseSha, deps.dryRun)) return await drop('already_reviewed');
    }

    // 4. The review.
    let failure: { stage: string; code: string } | null = null;
    if (prepareError !== null) {
      failure = { stage: 'prepare', code: codeOf(prepareError) };
    } else {
      const pr = live!;
      let source: Source | null = null;
      try {
        source = await deps.forge.sourceFor(installation);
      } catch (error) {
        failure = { stage: 'prepare', code: codeOf(error) };
      }
      if (source !== null) {
        const settings = deps.settingsFor(repo);
        try {
          result = await deps.review({
            pullRequest: pr.info, trigger: 'automatic',
            repoConfig: { primaryBranches: settings.primaryBranches, scoreThreshold: settings.scoreThreshold },
            limits: deps.limits, asOf: now, earlier: null,
          }, deps.engineDeps(source));
        } catch {
          failure = { stage: 'engine', code: 'internal_error' };
        }
      }
    }

    // 5 and 6. What would be posted, and telling the guards.
    let body = '';
    let comments: InlineComment[] = [];
    let refused: 'auth' | 'no_credit' | null = null;
    if (result !== null) {
      const info = live!.info;
      try {
        ({ body, comments } = renderReview(result, { trigger: 'automatic', requestedBy: null, lineUrl: (file, span) => deps.lineUrl(info, file, span), inline: true }));
      } catch {
        log({ event: 'render_failed', job: job.id, repo, number: job.ref.number });
      }
      try {
        deps.spend.noteRun(result.usage);
      } catch {
        // a guard that fails changes nothing
      }
      const code = result.failure?.code;
      if (code === 'auth' || code === 'no_credit') refused = code;
      try {
        if (refused !== null) deps.health.reviewed(refused, deps.clock());
        else if (result.usage.calls >= 1 && result.dependencies.model === 'ok') deps.health.reviewed(null, deps.clock());
      } catch {
        // a guard that fails changes nothing
      }
    }

    // 7. The record.
    const usage = result === null ? NO_USAGE : result.usage;
    const run: RunRecord = result === null
      ? {
        ref: job.ref, job: job.id, trigger: 'automatic', mode: 'full', dryRun: deps.dryRun, headSha: job.headSha, baseSha: null,
        outcome: 'failed', failureStage: failure!.stage, failureCode: failure!.code, needsHuman: true, highestScore: 100,
        body: '', comments: [], result: {}, usage: NO_USAGE, startedAt: nowIso, finishedAt: deps.clock().toISOString(),
      }
      : {
        ref: job.ref, job: job.id, trigger: 'automatic', mode: 'full', dryRun: deps.dryRun,
        headSha: live!.info.headSha, baseSha: live!.info.baseSha,
        outcome: result.status, failureStage: result.failure?.stage ?? null, failureCode: result.failure?.code ?? null,
        needsHuman: result.verdict.needsHuman, highestScore: result.verdict.highest,
        body, comments, result, usage: result.usage, startedAt: nowIso, finishedAt: deps.clock().toISOString(),
      };

    const gitFailed = failure?.stage === 'prepare'
      || (result?.failure?.stage === 'context' && result.failure.code.startsWith('github_') && result.usage.calls === 0);
    const putBack = refused !== null
      ? { runAt: later(PAUSE_MS), giveBackStart: usage.calls === 0 }
      : gitFailed ? { runAt: later(retryWait), giveBackStart: false } : null;

    let written: boolean;
    let requeued = false;
    if (putBack !== null) {
      written = await tried(async () => { await recordRun(db, run); });
      if (written) {
        written = await tried(async () => { requeued = (await requeueJob(db, job.id, putBack.runAt, nowIso, putBack.giveBackStart)) === 'requeued'; });
      }
    } else {
      const ended = run.outcome === 'ok' ? 'reviewed' : 'failed';
      written = await tried(() => db.transaction(async (tx) => {
        if (await finishJob(tx, job.id, 'done', ended, nowIso)) await recordRun(tx, run);
      }));
    }

    // 8. The log.
    log({
      event: 'review', job: job.id, repo, number: job.ref.number, head: run.headSha, trigger: 'automatic', mode: 'full', dry_run: deps.dryRun,
      outcome: written ? run.outcome : 'record_failed', failure_stage: run.failureStage, failure_code: run.failureCode,
      needs_human: run.needsHuman, highest: run.highestScore, findings: result === null ? 0 : result.findings.length,
      calls: usage.calls, cost: usage.cost, duration_ms: deps.clock().getTime() - now.getTime(), requeued,
    });
  } catch (error) {
    if (result !== null) {
      // The review was paid for: putting the job back would pay for it again. It is left running, as after three failed tries to record.
      let cost = 0;
      try {
        if (typeof result.usage.cost === 'number') cost = result.usage.cost;
      } catch {
        // a cost that cannot be read is logged as 0
      }
      log({ event: 'review', job: job.id, repo, number: job.ref.number, head: job.headSha, trigger: 'automatic', mode: 'full', dry_run: deps.dryRun, outcome: 'record_failed', cost, requeued: false });
      return;
    }
    // Nothing has been spent on this path: put the job back, its start counted, as for a git service failure.
    let requeued = false;
    await tried(async () => { requeued = (await requeueJob(db, job.id, later(retryWait), nowIso, false)) === 'requeued'; });
    log({ event: 'job', job: job.id, repo, number: job.ref.number, outcome: 'error', reason: codeOf(error), requeued });
  }
}
