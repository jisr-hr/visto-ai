import type { RepoSettings } from '../config/load.ts';
import { lastEvaluations } from '../db/gate.ts';
import { askGate, unfinishedJobs } from '../db/jobs.ts';
import { openPullRequests } from '../db/pull-requests.ts';
import type { Db } from '../db/types.ts';
import type { PullRequestRef } from '../forge/types.ts';
import { gatingOf } from './gating.ts';

const keyOf = (ref: PullRequestRef): string => `${ref.service}/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;

/** Asks for the check of each stored open pull request that is gated and whose newest recorded evaluation is absent, was made under another mode, or says reviewing or paused. Returns how many. */
export async function sweepGate(db: Db, settingsFor: (fullName: string) => RepoSettings, now: string): Promise<number> {
  const open = await openPullRequests(db);
  const newest = new Map((await lastEvaluations(db)).map((e) => [keyOf(e.ref), e]));
  let asked = 0;
  for (const { ref, baseBranch } of open) {
    const gating = gatingOf(settingsFor(`${ref.owner}/${ref.repo}`), baseBranch);
    if (gating === 'off') continue;
    const last = newest.get(keyOf(ref));
    if (last !== undefined && last.mode === gating && last.state !== 'reviewing' && last.state !== 'paused') continue;
    await askGate(db, ref, now);
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
    await askGate(db, job.ref, now);
    asked.add(key);
  }
  return asked.size;
}
