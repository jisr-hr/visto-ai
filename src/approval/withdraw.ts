import type { RepoSettings } from '../config/load.ts';
import {
  failedDismissals, markDismissed, markDismissFailed, markStoodAtMerge, newestApprovalStands, standingApprovals,
} from '../db/approvals.ts';
import type { Standing } from '../db/approvals.ts';
import { askGate, askWithdraw, finishJob, requeueJob } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import { getPullRequest } from '../db/pull-requests.ts';
import type { Db } from '../db/types.ts';
import type { ForgeAccess, ForgeApprovals, LivePullRequest, PullRequestFacts } from '../forge/types.ts';
import { gatingOf } from '../gate/gating.ts';
import type { Alert } from '../shell/alerts.ts';
import { codeOf } from '../shell/codes.ts';
import { MAX_STARTS } from '../shell/runner.ts';
import { dismissMessage } from './text.ts';

/** The wait before a withdraw job is tried again: after its first start, then after its second. */
export const WITHDRAW_RETRY_WAITS_MS = [10_000, 60_000];

export interface WithdrawJobDeps {
  db: Db; forge: ForgeAccess; approvals: ForgeApprovals;
  clock: () => Date; log: (entry: Record<string, unknown>) => void; alert: Alert;
  settingsFor: (fullName: string) => RepoSettings;
  dryRun: boolean;
  onQueued: () => void;          // after a gate job was asked for
}

type Entry = {
  event: 'withdraw'; job: number; repo: string; number: number;
  state: LivePullRequest['state'] | null;
  standing: number;              // the standing approvals read
  targets: number;               // those the job read again on GitHub
  dismissed: number;             // dismissed by this job and recorded so
  by_git_service: number;        // found dismissed, or no longer an approval, and recorded so
  failed: number;                // targets left standing for a failure
  code: string | null;           // the first failure's code
  outcome: string | null; requeued: boolean | null;
};

/** How the job ends: finished with an outcome, or failed with the first failure's code. */
type End = { kind: 'finish'; status: 'done' | 'dropped'; outcome: string } | { kind: 'retry'; code: string };

/** What one start read and did. A field left undefined was not read at this start. */
interface Found {
  standing?: Standing[];
  stored?: PullRequestFacts | null;
  installation?: string;
  live?: LivePullRequest | null;
  targets?: Standing[];
  /** The targets left standing for a failure, in order, each with its code. */
  failures: Array<{ run: number; code: string }>;
  /** A dismissal was recorded, or a failure recorded for the first time: the gate is asked. */
  changed: boolean;
}

const LIVE_STATES = new Set(['open', 'closed', 'merged']);

/** The state of a review as read, or null when the answer has none. */
const stateOf = (answer: unknown): string | null => {
  const state = typeof answer === 'object' && answer !== null ? (answer as { state?: unknown }).state : undefined;
  return typeof state === 'string' ? state : null;
};

/** The job's own steps, given what it is to call. */
interface Steps {
  job: Job; deps: WithdrawJobDeps; found: Found; entry: Entry;
  now: () => string;
  alert: Alert;
}

/** Takes one claimed withdraw job to its end. Never rejects. */
export async function runWithdrawJob(job: Job, deps: WithdrawJobDeps): Promise<void> {
  const log = (entry: Record<string, unknown>): void => {
    try { deps.log(entry); } catch { /* a logger that throws changes nothing */ }
  };
  const alert: Alert = (code, details) => {
    try { deps.alert(code, details); } catch { /* an alert that throws changes nothing */ }
  };
  const now = (): string => {
    try { return deps.clock().toISOString(); } catch { return new Date().toISOString(); }
  };
  const entry: Entry = {
    event: 'withdraw', job: job.id, repo: `${job.ref.owner}/${job.ref.repo}`, number: job.ref.number,
    state: null, standing: 0, targets: 0, dismissed: 0, by_git_service: 0, failed: 0, code: null, outcome: null, requeued: null,
  };
  const found: Found = { failures: [], changed: false };
  const steps: Steps = { job, deps, found, entry, now, alert };

  let end: End;
  try {
    end = await work(steps);
  } catch (error) {
    end = { kind: 'retry', code: codeOf(error) };
  }
  entry.failed = found.failures.length;
  if (end.kind === 'retry') entry.code = end.code;

  try {
    if (end.kind === 'finish') {
      // An outcome is this job's only when its finish was stored.
      if (await finishJob(deps.db, job.id, end.status, end.outcome, now())) entry.outcome = end.outcome;
    } else if (job.starts >= MAX_STARTS) {
      entry.requeued = false;
      if (await finishJob(deps.db, job.id, 'done', 'failed', now())) {
        entry.outcome = 'failed';
        await giveUp(steps, end.code);
      }
    } else {
      const at = deps.clock();
      const wait = WITHDRAW_RETRY_WAITS_MS[job.starts <= 1 ? 0 : 1]!;
      const answer = await requeueJob(deps.db, job.id, new Date(at.getTime() + wait).toISOString(), at.toISOString(), false);
      entry.requeued = answer === 'requeued';
      entry.outcome = answer === 'requeued' ? 'put_back' : 'superseded';
    }
  } catch {
    // Left as it is: it runs again after the next start.
    entry.outcome = 'error';
  }
  if (found.changed) await askTheGate(steps);
  log({ ...entry });
}

/** The job up to its end; rejects when a step it cannot go on without does, and the caller tries again. */
async function work(s: Steps): Promise<End> {
  const { job, deps, found, entry } = s;
  const { db } = deps;
  if (deps.dryRun) return { kind: 'finish', status: 'dropped', outcome: 'dry_run' };
  found.standing = await standingApprovals(db, job.ref);
  entry.standing = found.standing.length;
  if (found.standing.length === 0) return { kind: 'finish', status: 'done', outcome: 'none' };
  // The job's own installation, else the stored pull request's: an app installed again has a new id.
  let installation = job.installation;
  if (installation === null) {
    found.stored = await getPullRequest(db, job.ref);
    installation = found.stored?.installation ?? null;
  }
  if (installation === null) return { kind: 'finish', status: 'dropped', outcome: 'no_installation' };
  found.installation = installation;

  const live = await deps.forge.readPullRequest(job.ref, installation);
  // An answer of the wrong shape is no answer: never read as closed.
  if (live !== null && !LIVE_STATES.has((live as { state?: unknown } | undefined)?.state as string)) throw new Error('internal_error');
  found.live = live;
  if (live === null) return { kind: 'finish', status: 'done', outcome: 'not_found' };
  entry.state = live.state;
  if (live.state === 'closed') return { kind: 'finish', status: 'done', outcome: 'closed' };

  const head = live.info.headSha;
  if (live.state === 'open') {
    // Every standing approval when the newest review is not an approval that stands (calls 11, 34).
    const newest = await newestApprovalStands(db, job.ref);
    found.targets = newest
      ? found.standing.filter((a) => a.headSha !== head || a.baseBranch !== live.info.baseBranch)
      : found.standing;
  } else {
    found.targets = found.standing.filter((a) => a.headSha !== head);
  }
  entry.targets = found.targets.length;
  if (found.targets.length === 0) return { kind: 'finish', status: 'done', outcome: 'kept' };

  for (const target of found.targets) {
    try {
      if (live.state === 'open') await withdraw(s, installation, target);
      else await atMerge(s, installation, target);
    } catch (error) {
      found.failures.push({ run: target.run, code: codeOf(error) });
    }
  }
  const first = found.failures[0];
  if (first !== undefined) return { kind: 'retry', code: first.code };
  return { kind: 'finish', status: 'done', outcome: 'done' };
}

/** Records a target as dismissed. Rejects when the database does. */
async function recordDismissed(s: Steps, target: Standing, by: 'app' | 'git_service'): Promise<void> {
  await markDismissed(s.deps.db, target.run, s.now(), by);
  s.found.changed = true;
  if (by === 'app') s.entry.dismissed += 1;
  else s.entry.by_git_service += 1;
}

/** On an open pull request: dismisses an approval GitHub still holds, and records one it no longer holds. Rejects with the failure's code. */
async function withdraw(s: Steps, installation: string, target: Standing): Promise<void> {
  const { approvals } = s.deps;
  const ref = s.job.ref;
  const answer = await approvals.readReview(ref, installation, target.reviewId);
  // A lost repository, or a review GitHub does not find, is never read as a dismissal.
  if (answer === null) throw new Error('review_not_found');
  const state = stateOf(answer);
  if (state === 'dismissed' || state === 'commented') {
    await recordDismissed(s, target, 'git_service');
    return;
  }
  if (state !== 'approved') throw new Error('review_state_other');
  try {
    await approvals.dismissReview(ref, installation, target.reviewId, dismissMessage(target.headSha));
  } catch (error) {
    const code = codeOf(error);
    // Dismissed meanwhile, by GitHub's own rule or by hand: no failure.
    let again: unknown;
    try {
      again = await approvals.readReview(ref, installation, target.reviewId);
    } catch {
      throw new Error(code);
    }
    if (stateOf(again) !== 'dismissed') throw new Error(code);
    await recordDismissed(s, target, 'git_service');
    return;
  }
  await recordDismissed(s, target, 'app');
}

/** At a merge: records an approval of another head that GitHub still holds, and one it no longer holds as dismissed. Rejects with the failure's code. */
async function atMerge(s: Steps, installation: string, target: Standing): Promise<void> {
  const answer = await s.deps.approvals.readReview(s.job.ref, installation, target.reviewId);
  if (answer === null) return;
  const state = stateOf(answer);
  if (state === 'approved') {
    if (await markStoodAtMerge(s.deps.db, target.run, s.now())) {
      s.alert('stale_approval_merged', { repo: s.entry.repo, number: s.entry.number });
    }
    return;
  }
  if (state === 'dismissed' || state === 'commented') {
    await recordDismissed(s, target, 'git_service');
    return;
  }
  throw new Error('review_state_other');
}

/**
 * The third start failed: on an open pull request each target left standing records its code; when the live pull
 * request was not read at this start, or its targets were not known, every standing approval records the first code
 * (call 19); on a merged one nothing is recorded. One alert when any of these was recorded for the first time.
 */
async function giveUp(s: Steps, code: string): Promise<void> {
  const { db } = s.deps;
  const { found } = s;
  const live = found.live;
  let records: Array<{ run: number; code: string }> = [];
  try {
    if (live !== undefined && live !== null && live.state === 'merged') return;
    if (live !== undefined && live !== null && found.targets !== undefined) {
      records = found.failures;
    } else {
      const standing = found.standing ?? await standingApprovals(db, s.job.ref);
      records = standing.map((a) => ({ run: a.run, code }));
    }
  } catch {
    // The approvals could not be read: nothing is recorded, and the next push, publication or start asks again.
    return;
  }
  let first = false;
  for (const r of records) {
    try {
      if (await markDismissFailed(db, r.run, r.code)) first = true;
    } catch {
      // left as it was: the next withdraw job of the pull request records it
    }
  }
  if (!first) return;
  found.changed = true;
  s.alert('dismissal_failed', { reason: code, repo: s.entry.repo, number: s.entry.number });
}

/**
 * The record changed: the gate is asked when the repository's gate is enabled and the pull request is gated by its live
 * base branch, or by its stored one when the live one was not read. With neither, the gate's own job reads the live
 * pull request and decides. Each step is caught.
 */
async function askTheGate(s: Steps): Promise<void> {
  const { job, deps, found } = s;
  try {
    const settings = deps.settingsFor(`${job.ref.owner}/${job.ref.repo}`);
    let base: string | undefined = found.live?.info.baseBranch;
    if (found.live === undefined || found.live === null) {
      if (found.stored === undefined) found.stored = await getPullRequest(deps.db, job.ref);
      base = found.stored?.baseBranch;
    }
    const gated = base === undefined ? settings.gate.enabled : gatingOf(settings, base) !== 'off';
    if (!gated) return;
    const installation = found.installation ?? job.installation ?? found.stored?.installation ?? null;
    await askGate(deps.db, job.ref, s.now(), undefined, { installation });
  } catch {
    // The request for the check is lost: the next event or start asks again.
    return;
  }
  try { deps.onQueued(); } catch { /* the runners look at their next tick */ }
}

/** Asks for a withdraw job for each pull request stored as open with a standing approval whose withdrawal failed. Returns how many. */
export async function sweepWithdraw(db: Db, now: string): Promise<number> {
  let asked = 0;
  for (const ref of await failedDismissals(db)) {
    // A closed or merged pull request keeps its failure recorded as it is (call 22).
    const stored = await getPullRequest(db, ref);
    if (stored === null || stored.state !== 'open') continue;
    await askWithdraw(db, ref, now);
    asked += 1;
  }
  return asked;
}
