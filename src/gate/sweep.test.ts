import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { GATE_OFF } from '../config/load.ts';
import type { RepoSettings } from '../config/load.ts';
import { NO_COUNTS, recordEvaluation } from '../db/gate.ts';
import type { GateState } from '../db/gate.ts';
import { askGate, claimJob, enqueueJob } from '../db/jobs.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import type { PullRequestFacts, PullRequestRef } from '../forge/types.ts';
import { askWaiting, sweepGate } from './sweep.ts';
import { at, REF, SETTINGS, withGate } from './testing.ts';

const opened: Db[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});
async function db(): Promise<Db> {
  const d = await testDb();
  opened.push(d);
  return d;
}

const refOf = (number: number, repo = 'shop'): PullRequestRef => ({ ...REF, repo, number });
const facts = (ref: PullRequestRef, over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: 'h1', draft: false,
  state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0), ...over,
});
const evaluation = (ref: PullRequestRef, mode: 'enforce' | 'shadow' | 'bypass', state: GateState) =>
  ({ ref, headSha: 'h1', at: at(0), mode, state, code: state === 'paused' ? 'spend_limit' : null, run: null, counts: NO_COUNTS });
/** acme/shop has the gate on main in `mode`; acme/other has it off. */
const settingsIn = (mode: 'enforce' | 'shadow' | 'bypass') => (name: string): RepoSettings =>
  (name.toLowerCase() === 'acme/shop' ? withGate({ mode }) : { ...SETTINGS, gate: GATE_OFF });
const gateJobs = async (d: Db): Promise<number[]> =>
  (await d.query<{ number: number }>("select number from visto_ai.jobs where kind = 'gate' and status = 'pending' order by number")).map((r) => r.number);

test('at start the check of every stored open gated pull request is asked for, whatever its record says', async () => {
  const states: Array<[number, ['enforce' | 'shadow' | 'bypass', GateState] | null]> = [
    [1, null], [2, ['enforce', 'passed']], [3, ['bypass', 'bypassed']], [4, ['enforce', 'reviewing']], [5, ['enforce', 'paused']],
  ];
  const prepare = async (): Promise<Db> => {
    const d = await db();
    for (const [number, row] of states) {
      await savePullRequest(d, facts(refOf(number)));
      if (row !== null) {
        // An older row that says something else does not count: the newest one does.
        await recordEvaluation(d, evaluation(refOf(number), 'shadow', 'waiting'));
        await recordEvaluation(d, evaluation(refOf(number), row[0], row[1]));
      }
    }
    await savePullRequest(d, facts(refOf(6), { state: 'closed', closedAt: at(1) }));
    await savePullRequest(d, facts(refOf(8), { baseBranch: 'feature/x' }));
    await savePullRequest(d, facts(refOf(9, 'other')));
    return d;
  };

  const enforce = await prepare();
  assert.equal(await sweepGate(enforce, settingsIn('enforce'), at(10)), 5);
  assert.deepEqual(await gateJobs(enforce), [1, 2, 3, 4, 5]);
  const job = await enforce.query<{ run_at: Date; reason: string; trigger: string }>("select run_at, reason, trigger from visto_ai.jobs where number = 1");
  assert.deepEqual([job[0]!.run_at.toISOString(), job[0]!.reason, job[0]!.trigger], [at(10), 'sync', 'automatic']);

  const bypass = await prepare();
  assert.equal(await sweepGate(bypass, settingsIn('bypass'), at(10)), 5);
  assert.deepEqual(await gateJobs(bypass), [1, 2, 3, 4, 5]);

  const none = await db();
  assert.equal(await sweepGate(none, settingsIn('enforce'), at(10)), 0);
});

test('the pull requests with a review waiting are asked for, and a running review, a gate job and an ungated repository are not', async () => {
  const d = await db();
  const review = (ref: PullRequestRef, over = {}) => ({
    ref, kind: 'review' as const, reason: 'command', headSha: '', runAt: at(0), now: at(0), delivery: null, replace: true,
    trigger: 'manual' as const, requestedBy: 'octo-lead', commentId: '31', association: 'member', installation: '99', ...over,
  });
  // A pull request with a review running and another waiting is asked for once.
  await claimJob(d, (await enqueueJob(d, review(refOf(1))))!, at(0));
  await enqueueJob(d, review(refOf(1)));
  const running = (await enqueueJob(d, review(refOf(2))))!;
  await claimJob(d, running, at(0));
  await askGate(d, refOf(3), at(0));
  await enqueueJob(d, review(refOf(4, 'other')));
  const settled = (await enqueueJob(d, review(refOf(5))))!;
  await d.query("update visto_ai.jobs set status = 'done' where id = $1", [settled]);
  assert.equal(await askWaiting(d, settingsIn('enforce'), at(10)), 1);
  const gate = await d.query<{ repo: string; number: number; run_at: Date }>("select repo, number, run_at from visto_ai.jobs where kind = 'gate' order by id");
  assert.deepEqual(gate.map((r) => [r.repo, r.number, r.run_at.toISOString()]), [['shop', 3, at(0)], ['shop', 1, at(10)]]);
});

test('at start every recorded state is asked for again, closed and not_found too, and a pull request stored as closed is not', async () => {
  const d = await db();
  const states: GateState[] = ['failed', 'passed', 'blocked', 'waiting', 'skipped', 'bypassed', 'closed', 'not_found'];
  for (const [i, state] of states.entries()) {
    await savePullRequest(d, facts(refOf(i + 1)));
    await recordEvaluation(d, { ...evaluation(refOf(i + 1), 'enforce', state), code: state === 'failed' ? 'github_500' : null });
  }
  await savePullRequest(d, facts(refOf(9), { state: 'closed', closedAt: at(1) }));
  await recordEvaluation(d, evaluation(refOf(9), 'enforce', 'passed'));
  assert.equal(await sweepGate(d, settingsIn('enforce'), at(10)), 8);
  assert.deepEqual(await gateJobs(d), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('the sweep renews a sync left waiting from a long stop and gives a stored pull request no installation: the job falls back to the stored one', async () => {
  const d = await db();
  await savePullRequest(d, facts(refOf(1), { installation: '42' }));
  const old = (await askGate(d, refOf(1), at(-90_000)))!;
  await d.query('update visto_ai.jobs set starts = 2 where id = $1', [old]);
  assert.equal(await sweepGate(d, settingsIn('enforce'), at(0)), 1);
  const row = await d.query<{ id: number; starts: number; created_at: Date; run_at: Date; installation: string | null }>(
    "select id, starts, created_at, run_at, installation from visto_ai.jobs where kind = 'gate' and status = 'pending'");
  assert.deepEqual(row.map((r) => [r.id, r.starts, r.created_at.toISOString(), r.run_at.toISOString(), r.installation]), [[old, 0, at(0), at(0), null]]);
});

test('at start a pull request the service stores no row for, but whose check the gate wrote, is asked for with the installation of its newest job', async () => {
  const d = await db();
  // 1: a gate job carried installation 42 and wrote its check; no row was ever stored.
  const first = (await askGate(d, refOf(1), at(0), undefined, { installation: '41' }))!;
  await d.query("update visto_ai.jobs set status = 'done' where id = $1", [first]);
  const second = (await askGate(d, refOf(1), at(1), undefined, { installation: '42' }))!;
  await d.query("update visto_ai.jobs set status = 'done' where id = $1", [second]);
  await askGate(d, refOf(1), at(2));
  await d.query("update visto_ai.jobs set status = 'done' where kind = 'gate' and number = 1 and installation is null");
  await recordEvaluation(d, evaluation(refOf(1), 'bypass', 'bypassed'));
  // 2: found closed by its last sync; 3: in a repository whose gate is off; 4: stored, open and gated (asked as before).
  await recordEvaluation(d, evaluation(refOf(2), 'enforce', 'closed'));
  await recordEvaluation(d, evaluation(refOf(3, 'other'), 'enforce', 'passed'));
  await savePullRequest(d, facts(refOf(4)));
  assert.equal(await sweepGate(d, settingsIn('enforce'), at(10)), 2);
  const asked = await d.query<{ repo: string; number: number; installation: string | null }>(
    "select repo, number, installation from visto_ai.jobs where kind = 'gate' and status = 'pending' order by number");
  assert.deepEqual(asked.map((r) => [r.repo, r.number, r.installation]), [['shop', 1, '42'], ['shop', 4, null]]);
});
