import type { RepoSettings } from '../config/load.ts';
import type { PullRequestAction, PullRequestFacts } from '../forge/types.ts';
import { gatingOf, reviewedOnRequest } from '../gate/gating.ts';

/** How long a push waits for the next one before its review is due. */
export const QUIET_SECONDS = 180;

export type SkipReason = 'closed' | 'draft' | 'ignored_author' | 'base_filtered' | 'gated';
export type TriggerReason = 'opened' | 'reopened' | 'ready_for_review' | 'synchronize' | 'retargeted';
export type Trigger =
  | { kind: 'queue'; reason: TriggerReason; headSha: string; delaySeconds: number }
  | { kind: 'skip'; reason: SkipReason }
  | { kind: 'none' };

/** Why no automatic review is wanted for a pull request in this state; null when one is. Checked in this order: any state but open (`closed`), draft, ignored author, base branch (a `*` among `baseBranches` means every branch), gated (reviewed only when asked: enforce and bypass). */
export function skipReason(
  pr: { state: 'open' | 'closed' | 'merged'; draft: boolean; author: string; baseBranch: string }, settings: RepoSettings,
): SkipReason | null {
  if (pr.state !== 'open') return 'closed';
  if (pr.draft) return 'draft';
  const author = pr.author.toLowerCase();
  if (settings.ignoredAuthors.some((ignored) => ignored.toLowerCase() === author)) return 'ignored_author';
  if (settings.baseBranches.length > 0 && !settings.baseBranches.includes('*') && !settings.baseBranches.includes(pr.baseBranch)) return 'base_filtered';
  if (reviewedOnRequest(gatingOf(settings, pr.baseBranch))) return 'gated';
  return null;
}

/** What a pull request event asks for. `facts` are the newest the service has for the pull request: the event's own, or the stored ones when the event is older than what is stored. */
export function triggerOf(action: PullRequestAction, facts: PullRequestFacts, settings: RepoSettings): Trigger {
  if (action === 'closed' || action === 'other') return { kind: 'none' };
  const skip = skipReason(facts, settings);
  if (skip !== null) return { kind: 'skip', reason: skip };
  return { kind: 'queue', reason: action, headSha: facts.headSha, delaySeconds: action === 'synchronize' ? QUIET_SECONDS : 0 };
}
