import type { RepoSettings } from '../config/load.ts';
import { evaluatedUnstored } from '../db/gate.ts';
import { askGate, unfinishedJobs } from '../db/jobs.ts';
import { openPullRequests } from '../db/pull-requests.ts';
import type { Db } from '../db/types.ts';
import type { PullRequestRef } from '../forge/types.ts';
import { gatingOf } from './gating.ts';

const keyOf = (ref: PullRequestRef): string => `${ref.service}/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;

/** The recorded states that keep the sweep from a pull request it stores no row for: its last sync found it closed or gone. */
const UNSTORED_LEFT = new Set(['closed', 'not_found']);

/**
 * Asks for the check of every stored open pull request that is gated, whatever its newest recorded evaluation says,
 * and of every pull request the service stores no row for whose check the gate wrote, in a repository whose gate is
 * enabled, unless its last sync found it closed or gone. A sync writes only on a difference, so an unchanged pull
 * request costs reads and no write. The ask renews a sync that already waits. For a stored pull request it carries no
 * installation: the job falls back to the stored one, and a later ask that merges into it brings a newer one (the app
 * installed again). For a pull request with no row it carries the installation of its newest job that has one, since
 * there is no row to fall back to. Returns how many.
 */
export async function sweepGate(db: Db, settingsFor: (fullName: string) => RepoSettings, now: string): Promise<number> {
  let asked = 0;
  for (const { ref, baseBranch } of await openPullRequests(db)) {
    if (gatingOf(settingsFor(`${ref.owner}/${ref.repo}`), baseBranch) === 'off') continue;
    await askGate(db, ref, now, undefined, { renew: true });
    asked += 1;
  }
  // No stored row, so no base branch: the sync reads the live pull request and decides whether it is gated.
  for (const { ref, state, installation } of await evaluatedUnstored(db)) {
    if (!settingsFor(`${ref.owner}/${ref.repo}`).gate.enabled || UNSTORED_LEFT.has(state)) continue;
    await askGate(db, ref, now, undefined, { installation, renew: true });
    asked += 1;
  }
  return asked;
}

/** Asks for the check of each pull request with a review job waiting, in a repository whose gate is enabled. Returns how many. */
export async function askWaiting(db: Db, settingsFor: (fullName: string) => RepoSettings, now: string): Promise<number> {
  const asked = new Set<string>();
  for (const job of await unfinishedJobs(db)) {
    if (job.kind !== 'review' || job.status !== 'pending') continue;
    const key = keyOf(job.ref);
    if (asked.has(key) || !settingsFor(`${job.ref.owner}/${job.ref.repo}`).gate.enabled) continue;
    await askGate(db, job.ref, now, undefined, { installation: job.installation });
    asked.add(key);
  }
  return asked.size;
}
