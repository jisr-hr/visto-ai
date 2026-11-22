import type { RepoSettings } from '../config/load.ts';
import { lastEvaluation, recordEvaluation, skipOf } from '../db/gate.ts';
import type { GateCounts } from '../db/gate.ts';
import { askGate, finishJob, requeueJob, reviewJobsOf } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import { getPullRequest } from '../db/pull-requests.ts';
import { listComments } from '../db/review-comments.ts';
import { listRuns } from '../db/review-runs.ts';
import type { StoredRun } from '../db/review-runs.ts';
import type { Db } from '../db/types.ts';
import type { ForgeAccess, ForgeChecks, ForgeWriter, LivePullRequest, PullRequestRef } from '../forge/types.ts';
import type { Alert } from '../shell/alerts.ts';
import { codeOf } from '../shell/codes.ts';
import { missedComments } from '../shell/earlier.ts';
import { MAX_STARTS } from '../shell/runner.ts';
import { checkText, countsOf, planAfter, planBefore, sameCheck } from './check.ts';
import type { CheckPlan } from './check.ts';
import { gatingOf, reviewedOnRequest } from './gating.ts';
import type { Gating } from './gating.ts';
import type { KeyedLock } from './lock.ts';
import { evaluateGate, refusedInline, reviewedRun } from './rule.ts';

/** The wait before a gate job is tried again: after its first start, then after its second. */
export const GATE_RETRY_WAITS_MS = [10_000, 60_000];

export interface GateJobDeps {
  db: Db; forge: ForgeAccess; checks: ForgeChecks;
  writer: Pick<ForgeWriter, 'listThreads' | 'react' | 'comment'>;
  clock: () => Date; log: (entry: Record<string, unknown>) => void;
  settingsFor: (fullName: string) => RepoSettings;
  dryRun: boolean;
  /** Why reviews do not start now, as a short code; null when they do. */
  paused: () => Promise<string | null>;
  /** Whether a review job of the pull request is running in this process. */
  reviewing: (ref: PullRequestRef) => boolean;
  commentUrl: (ref: PullRequestRef, commentId: string) => string;
  alert: Alert;
  lock: KeyedLock;
  /** Called after a job was stored, so that the runners look at once. */
  onQueued: () => void;
}

/** Whether a review of the pull request is under way, from its unfinished review jobs. `held`: a review job of it is running in this process. */
export function underWay(jobs: Job[], gating: Gating, held: boolean): 'running' | 'pending' | null {
  // A push's job on a pull request reviewed only when asked is about to be dropped as gated: no review.
  const counted = jobs.filter((j) => !(j.trigger === 'automatic' && reviewedOnRequest(gating)));
  if (held && counted.some((j) => j.status === 'running')) return 'running';
  if (counted.some((j) => j.status === 'pending')) return 'pending';
  return null;
}

const isCount = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** Every count of the plan is a whole number at or above 0; a plan that holds another never reads as passed. */
function wholeCounts(plan: CheckPlan): boolean {
  if (plan.state !== 'passed' && plan.state !== 'blocked') return true;
  return Object.values(countsOf(plan)).every(isCount);
}

/** What the check of the live head should say now, and the review it was decided on. Rejects only when the database or `paused` does. */
export async function planNow(deps: GateJobDeps, args: {
  ref: PullRequestRef; installation: string; settings: RepoSettings; gating: 'enforce' | 'shadow' | 'bypass'; live: LivePullRequest;
}): Promise<{ plan: CheckPlan; run: StoredRun | null }> {
  const { db } = deps;
  const head = args.live.info.headSha;
  const base = args.live.info.baseSha;
  const skip = await skipOf(db, args.ref, head);
  // The jobs before the runs: a review that ends in between is seen with its run, never as ended without it.
  const jobs = await reviewJobsOf(db, args.ref);
  const job = underWay(jobs, args.gating, deps.reviewing(args.ref));
  const paused = job === 'pending' ? await deps.paused() : null;
  const runs = await listRuns(db, args.ref);
  const before = planBefore({ gating: args.gating, head, base, skip, job, paused, runs });
  if (before !== null) return { plan: before, run: null };
  const reviewed = reviewedRun(runs, head, base);
  if (reviewed === null) return { plan: { state: 'failed', code: 'internal_error', evaluated: true }, run: null };
  try {
    const threads = await deps.writer.listThreads(args.ref, args.installation);
    let stored = await listComments(db, args.ref);
    try {
      stored = [...stored, ...missedComments({ runs, stored, threads })];
    } catch {
      // a repair that throws leaves the comments as they were read
    }
    const verdict = evaluateGate({ threads, stored, runs, reviewed, clearByReply: args.settings.gate.clearByReply });
    const refused = refusedInline(runs, head, base);
    if (!isCount(refused)) throw new Error('internal_error');
    const plan = planAfter(verdict, reviewed, refused);
    if (!wholeCounts(plan)) throw new Error('internal_error');
    return { plan, run: reviewed };
  } catch (error) {
    // A thread list that cannot be read never reads as no thread.
    return { plan: { state: 'failed', code: codeOf(error), evaluated: true }, run: reviewed };
  }
}

type Entry = {
  event: 'gate'; job: number; repo: string; number: number; reason: string;
  head: string | null; mode: string | null; state: string | null; code: string | null;
  blocking: number | null; cleared_by_review: number | null; cleared_by_reply: number | null; unknown: number | null; refused_inline: number | null;
  wrote: boolean | null; outcome: string | null; requeued: boolean | null;
};

/** How the job ends: finished with an outcome (and maybe a request for the check), or tried again with a code. */
type End =
  | { kind: 'finish'; status: 'done' | 'dropped'; outcome: string; ask?: boolean }
  | { kind: 'retry'; code: string };

const codeOfPlan = (plan: CheckPlan): string | null => (plan.state === 'failed' || plan.state === 'paused' ? plan.code : null);

/** Takes one claimed gate job to its end. Never rejects. */
export async function runGateJob(job: Job, deps: GateJobDeps): Promise<void> {
  const log = (entry: Record<string, unknown>): void => {
    try { deps.log(entry); } catch { /* a logger that throws changes nothing */ }
  };
  const entry: Entry = {
    event: 'gate', job: job.id, repo: `${job.ref.owner}/${job.ref.repo}`, number: job.ref.number, reason: job.reason,
    head: null, mode: null, state: null, code: null,
    blocking: null, cleared_by_review: null, cleared_by_reply: null, unknown: null, refused_inline: null,
    wrote: null, outcome: null, requeued: null,
  };
  const now = (): string => {
    try { return deps.clock().toISOString(); } catch { return new Date().toISOString(); }
  };

  let end: End;
  try {
    end = await work(job, deps, entry, log);
  } catch (error) {
    end = { kind: 'retry', code: codeOf(error) };
  }

  try {
    if (end.kind === 'finish') {
      const finished = await finishJob(deps.db, job.id, end.status, end.outcome, now());
      entry.outcome = end.outcome;
      if (finished && end.ask === true) {
        await askGate(deps.db, job.ref, now());
        try { deps.onQueued(); } catch { /* the runners look at their next tick */ }
      }
    } else if (job.starts >= MAX_STARTS) {
      // Nothing else is written: the check keeps what GitHub shows.
      entry.requeued = false;
      entry.outcome = 'failed';
      if (await finishJob(deps.db, job.id, 'done', 'failed', now())) {
        try { deps.alert('gate_check_failed', { reason: end.code }); } catch { /* an alert that throws changes nothing */ }
      }
    } else {
      const at = deps.clock();
      const wait = GATE_RETRY_WAITS_MS[job.starts <= 1 ? 0 : 1]!;
      const answer = await requeueJob(deps.db, job.id, new Date(at.getTime() + wait).toISOString(), at.toISOString(), false);
      entry.requeued = answer === 'requeued';
      entry.outcome = answer === 'requeued' ? 'put_back' : 'superseded';
    }
  } catch {
    // Left as it is: it runs again after the next start.
    entry.outcome = 'error';
  }
  log({ ...entry });
}

/** The job up to its end; rejects when a step does, and the caller tries again. */
async function work(job: Job, deps: GateJobDeps, entry: Entry, log: (e: Record<string, unknown>) => void): Promise<End> {
  const { db } = deps;
  if (deps.dryRun) return { kind: 'finish', status: 'dropped', outcome: 'dry_run' };
  const settings = deps.settingsFor(`${job.ref.owner}/${job.ref.repo}`);
  if (!settings.gate.enabled) return { kind: 'finish', status: 'dropped', outcome: 'gate_off' };
  const installation = job.installation ?? (await getPullRequest(db, job.ref))?.installation ?? null;
  if (installation === null) return { kind: 'finish', status: 'dropped', outcome: 'no_installation' };
  if (job.reason !== 'sync') return { kind: 'finish', status: 'done', outcome: 'unknown_reason', ask: true };

  const live = await deps.forge.readPullRequest(job.ref, installation);
  if (live === null) return { kind: 'finish', status: 'dropped', outcome: 'not_found' };
  if (live.state !== 'open') return { kind: 'finish', status: 'done', outcome: 'closed' };
  const gating = gatingOf(settings, live.info.baseBranch);
  if (gating === 'off') return { kind: 'finish', status: 'done', outcome: 'not_gated' };

  const head = live.info.headSha;
  entry.head = head;
  entry.mode = gating;
  const ref = job.ref;
  const name = settings.gate.checkName;
  const key = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}@${head.toLowerCase()}`;

  const plan = await deps.lock.run(key, async (): Promise<CheckPlan> => {
    entry.wrote = false;
    const current = await deps.checks.findCheck(ref, installation, head, name);
    const { plan, run } = await planNow(deps, { ref, installation, settings, gating, live });
    const counts: GateCounts = countsOf(plan);
    entry.state = plan.state;
    entry.code = codeOfPlan(plan);
    entry.blocking = counts.blocking;
    entry.cleared_by_review = counts.clearedByReview;
    entry.cleared_by_reply = counts.clearedByReply;
    entry.unknown = counts.unknownThreads;
    entry.refused_inline = counts.refusedInline;
    const text = checkText(plan, {
      head, canSkip: settings.gate.skipTeam !== null, clearByReply: settings.gate.clearByReply,
      retrying: job.starts < MAX_STARTS, threadUrl: (id) => deps.commentUrl(ref, id),
    });
    const wrote = !sameCheck(current, text);
    if (wrote) {
      await deps.checks.writeCheck(ref, installation, { id: current?.id ?? null, commit: head, name, ...text });
      entry.wrote = true;
    }
    try {
      const last = wrote ? null : await lastEvaluation(db, ref);
      const differs = wrote || last === null || last.headSha !== head || last.mode !== gating || last.state !== plan.state || last.code !== entry.code;
      if (differs) {
        await recordEvaluation(db, {
          ref, headSha: head, at: deps.clock().toISOString(), mode: gating, state: plan.state, code: entry.code, run: run?.id ?? null, counts,
        });
      }
    } catch (error) {
      log({ event: 'gate_record_failed', job: job.id, reason: codeOf(error) });
    }
    return plan;
  });

  if (plan.state === 'failed' && plan.evaluated) return { kind: 'retry', code: plan.code };
  return { kind: 'finish', status: 'done', outcome: 'synced' };
}
