import type { RepoSettings } from '../config/load.ts';

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
