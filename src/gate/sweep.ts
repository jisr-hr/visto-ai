import type { RepoSettings } from '../config/load.ts';
import { lastEvaluations } from '../db/gate.ts';
import { askGate, unfinishedJobs } from '../db/jobs.ts';
import { openPullRequests } from '../db/pull-requests.ts';
import type { Db } from '../db/types.ts';
import type { PullRequestRef } from '../forge/types.ts';
import { gatingOf } from './gating.ts';

const keyOf = (ref: PullRequestRef): string => `${ref.service}/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;

/** The recorded states the sweep leaves alone: a pull request a sync found closed or gone; its next event asks (call 52). */
const LEFT_ALONE = new Set(['closed', 'not_found']);

/**
 * Asks for the check of every stored open pull request that is gated, unless its newest recorded evaluation says
 * closed or not_found. A sync writes only on a difference, so an unchanged pull request costs reads and no write.
 * The ask renews a sync that already waits, and carries the stored installation. Returns how many.
 */
export async function sweepGate(db: Db, settingsFor: (fullName: string) => RepoSettings, now: string): Promise<number> {
  const open = await openPullRequests(db);
  const newest = new Map((await lastEvaluations(db)).map((e) => [keyOf(e.ref), e]));
  let asked = 0;
  for (const { ref, baseBranch, installation } of open) {
    if (gatingOf(settingsFor(`${ref.owner}/${ref.repo}`), baseBranch) === 'off') continue;
    const last = newest.get(keyOf(ref));
    if (last !== undefined && LEFT_ALONE.has(last.state)) continue;
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
