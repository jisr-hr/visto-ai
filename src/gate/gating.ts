import type { RepoSettings } from '../config/load.ts';
import type { Job } from '../db/jobs.ts';
import { mayCommand } from '../shell/commands.ts';

/** `off`: not gated. Otherwise the mode of the repository's gate. */
export type Gating = 'off' | 'enforce' | 'shadow' | 'bypass';

/** Gated when the repository has the gate enabled and the base branch is listed, compared exactly, case and all. */
export function gatingOf(settings: RepoSettings, baseBranch: string): Gating {
  const { gate } = settings;
  if (!gate.enabled || !gate.branches.includes(baseBranch)) return 'off';
  return gate.mode;
}

/** Whether a pull request with this gating is reviewed only when asked: enforce and bypass. */
export function reviewedOnRequest(gating: Gating): boolean {
  return gating === 'enforce' || gating === 'bypass';
}

/**
 * Whether a review job will run, on a pull request of this gating: a manual one asked for by a re-run or by someone
 * D15 lets command (a stranger's is about to be refused); an automatic one on a pull request that is not reviewed only
 * when asked (on one that is, it is about to be dropped as gated). Only such a job counts as a review under way, and
 * only such a job is joined by a command.
 */
export function reviewWillRun(job: Pick<Job, 'trigger' | 'reason' | 'association'>, gating: Gating): boolean {
  if (job.trigger === 'manual') return job.reason === 'rerun' || job.reason === 'rerun_retry' || mayCommand(job.association);
  return job.trigger === 'automatic' && !reviewedOnRequest(gating);
}
