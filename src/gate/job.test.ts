import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GATE_OFF } from '../config/load.ts';
import { markDismissed, markDismissFailed } from '../db/approvals.ts';
import { recordEvaluation, recordSkip, NO_COUNTS } from '../db/gate.ts';
import type { GateState } from '../db/gate.ts';
import { askGate, claimJob, enqueueJob, finishJob, getJob } from '../db/jobs.ts';
import { markPublished } from '../db/review-runs.ts';
import type { Db } from '../db/types.ts';
import type { CheckWrite, OwnCheck } from '../forge/types.ts';
import { checkText } from './check.ts';
import type { CheckMeta } from './check.ts';
import { runGateJob } from './job.ts';
import { createKeyedLock } from './lock.ts';
import { sweepGate } from './sweep.ts';
import {
  appComment, at, closeHarnesses, finding, harness, liveOf, REF, reply, SETTINGS, storeComment, storeRun, thread, withGate,
} from './testing.ts';
import type { Harness } from './testing.ts';

afterEach(closeHarnesses);

const META: CheckMeta = { head: 'h1', canSkip: false, clearByReply: true, retrying: true, threadUrl: (id) => `https://git.example.test/c/${id}` };
const WAITING = checkText({ state: 'waiting' }, META);
const WAITING_CHECK: OwnCheck = { id: '71', ...WAITING };

const finds = (h: Harness): unknown[][] => h.calls.filter((c) => c[0] === 'findCheck');
const writes = (h: Harness): CheckWrite[] => h.calls.filter((c) => c[0] === 'writeCheck').map((c) => c[3] as CheckWrite);
const threadReads = (h: Harness): number => h.calls.filter((c) => c[0] === 'listThreads').length;
const gateLogs = (h: Harness): Array<Record<string, unknown>> => h.logs.filter((e) => e['event'] === 'gate');

interface Row {
  head_sha: string; mode: string; state: string; code: string | null; run: number | null;
  blocking: number; cleared_by_review: number; cleared_by_reply: number; unknown_threads: number; findings: number; refused_inline: number;
}
const rows = (db: Db): Promise<Row[]> => db.query<Row>('select * from visto_ai.gate_evaluations order by id');

async function statusOf(h: Harness, id = h.job.id): Promise<[string, string | null]> {
  const job = (await getJob(h.db, id))!;
  return [job.status, job.outcome];
}

/** Stores a review job of the pull request: pending, or claimed (running in the database). */
async function reviewJob(db: Db, trigger: 'automatic' | 'manual', claim = false, number: number = REF.number): Promise<void> {
  const id = await enqueueJob(db, {
    ref: { ...REF, number }, reason: trigger === 'manual' ? 'command' : 'synchronize', headSha: trigger === 'manual' ? '' : 'h1', runAt: at(0), now: at(0),
    delivery: null, replace: true, trigger, requestedBy: trigger === 'manual' ? 'octo-lead' : null, commentId: trigger === 'manual' ? '31' : null,
    association: trigger === 'manual' ? 'member' : null, installation: '99',
  });
  if (claim) await claimJob(db, id!, at(0));
}

/** Asks for the check again at `seconds`, claims that job and runs it. */
async function again(h: Harness, seconds: number): Promise<number> {
  await askGate(h.db, REF, at(seconds));
  const job = await h.claimNext(at(seconds));
  assert.ok(job !== null);
  await h.run(job);
  return job.id;
}

/** A published review at h1 with comment 8001 stored as a major, and its open thread. */
async function blockedHarness(over: Parameters<typeof harness>[0] = {}): Promise<{ h: Harness; run: number }> {
  const h = await harness({ threads: [[thread()]], ...over });
  const run = await storeRun(h.db);
  await storeComment(h.db, run, 'major');
  return { h, run };
}

test('a gated pull request with no review gets a check that waits for /done', async () => {
  const h = await harness();
  await h.run();
  assert.equal(finds(h).length, 1);
  assert.deepEqual(finds(h)[0]!.slice(2), ['99', 'h1', 'AI Review']);
  assert.deepEqual(writes(h), [{ id: null, commit: 'h1', name: 'AI Review', status: 'queued', conclusion: null, title: 'Waiting for /done', summary: WAITING.summary }]);
  const r = await rows(h.db);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0]!.state, r[0]!.mode, r[0]!.code, r[0]!.run, r[0]!.head_sha], ['waiting', 'enforce', null, null, 'h1']);
  assert.deepEqual(await statusOf(h), ['done', 'synced']);
  assert.equal(threadReads(h), 0);
});

test('a second look that finds nothing changed writes nothing and records nothing', async () => {
  const h = await harness();
  await h.run();
  const second = await again(h, 5);
  assert.equal(writes(h).length, 1);
  assert.equal(finds(h).length, 2);
  assert.equal((await rows(h.db)).length, 1);
  assert.deepEqual(await statusOf(h, second), ['done', 'synced']);
  assert.equal(gateLogs(h).at(-1)!['wrote'], false);
});

test('a look that needs no write is still recorded when the record says something else', async () => {
  const h = await harness({ check: WAITING_CHECK });
  await recordEvaluation(h.db, { ref: REF, headSha: 'h1', at: at(0), mode: 'shadow', state: 'waiting', code: null, run: null, counts: NO_COUNTS });
  await h.run();
  assert.equal(writes(h).length, 0);
  const r = await rows(h.db);
  assert.deepEqual(r.map((x) => x.mode), ['shadow', 'enforce']);
  assert.deepEqual(await statusOf(h), ['done', 'synced']);

  const fresh = await harness({ check: WAITING_CHECK });
  await fresh.run();
  assert.equal(writes(fresh).length, 0);
  assert.deepEqual((await rows(fresh.db)).map((x) => [x.mode, x.state]), [['enforce', 'waiting']]);
});

test('a check GitHub holds as completed with no conclusion is never read as the check wanted', async () => {
  const passed = checkText({ state: 'bypassed' }, META);
  const h = await harness({ settings: withGate({ mode: 'bypass' }), check: { id: '71', ...passed, conclusion: null } });
  await h.run();
  assert.deepEqual(writes(h).map((w) => [w.id, w.status, w.conclusion]), [['71', 'completed', 'success']]);
});

test('the head\'s review with an open major gives a blocked check that names the thread', async () => {
  const { h, run } = await blockedHarness({ check: WAITING_CHECK });
  await h.run();
  const w = writes(h);
  assert.equal(w.length, 1);
  assert.deepEqual([w[0]!.id, w[0]!.commit, w[0]!.status, w[0]!.conclusion, w[0]!.title], ['71', 'h1', 'completed', 'action_required', '1 blocking finding is open']);
  assert.ok(w[0]!.summary.includes('(https://git.example.test/c/8001)'));
  const r = await rows(h.db);
  assert.deepEqual([r[0]!.state, r[0]!.blocking, r[0]!.findings, r[0]!.run], ['blocked', 1, 1, run]);
  assert.deepEqual(await statusOf(h), ['done', 'synced']);
});

test('a reply by a person and a resolve turn it green with no review', async () => {
  const resolved = thread({ resolved: true, comments: [appComment('8001'), reply('octo-dev')] });
  const { h } = await blockedHarness({ threads: [[resolved]] });
  await h.run();
  const w = writes(h);
  assert.deepEqual([w[0]!.status, w[0]!.conclusion, w[0]!.title], ['completed', 'success', '1 finding, none blocking']);
  const r = await rows(h.db);
  assert.deepEqual([r[0]!.state, r[0]!.cleared_by_reply, r[0]!.blocking], ['passed', 1, 0]);
});

test('a finding whose row the read-back missed is known from its thread', async () => {
  const h = await harness({ threads: [[thread()]] });
  await storeRun(h.db);
  await h.run();
  const w = writes(h);
  assert.deepEqual([w[0]!.conclusion, w[0]!.title], ['action_required', '1 blocking finding is open']);
  assert.ok(w[0]!.summary.includes('**\\[major]**'));
  const r = await rows(h.db);
  assert.deepEqual([r[0]!.state, r[0]!.unknown_threads], ['blocked', 0]);
});

test('a review GitHub refused inline blocks the check, and a re-check of the same head does not turn it green', async () => {
  const h = await harness();
  await storeRun(h.db, { publish: { inlineDropped: true } });
  await h.run();
  const first = writes(h)[0]!;
  assert.deepEqual([first.status, first.conclusion, first.title], ['completed', 'action_required', 'Blocking findings open: 1 (1 listed in the review only)']);
  assert.equal((await rows(h.db))[0]!.refused_inline, 1);
  assert.equal(gateLogs(h)[0]!['refused_inline'], 1);

  await storeRun(h.db, { findings: [], mode: 'recheck', publish: { reviewId: '502' } });
  await again(h, 5);
  assert.equal(writes(h).length, 1, 'the check stays as it was');
  assert.equal(h.held.get('h1')!.conclusion, 'action_required');

  const minor = await harness();
  await storeRun(minor.db, { findings: [finding('minor')], publish: { inlineDropped: true } });
  await minor.run();
  assert.deepEqual([writes(minor)[0]!.conclusion, writes(minor)[0]!.title], ['success', 'No blocking findings']);

  const next = await harness({ live: liveOf({ head: 'h2' }) });
  await storeRun(next.db, { publish: { inlineDropped: true } });
  await storeRun(next.db, { headSha: 'h2', findings: [], publish: { reviewId: '503' } });
  await next.run();
  assert.deepEqual(writes(next).map((w) => [w.commit, w.conclusion]), [['h2', 'success']]);
});

test('a review job that waits or runs shows Reviewing, and one that waits while reviews are paused says why', async () => {
  const pending = await harness();
  await reviewJob(pending.db, 'manual');
  await pending.run();
  assert.deepEqual(writes(pending).map((w) => [w.status, w.title]), [['in_progress', 'Reviewing']]);
  assert.equal(pending.calls.filter((c) => c[0] === 'paused').length, 1);

  const running = await harness();
  await reviewJob(running.db, 'manual', true);
  await running.run();
  assert.deepEqual(writes(running).map((w) => [w.status, w.title]), [['in_progress', 'Reviewing']]);
  assert.equal(running.calls.filter((c) => c[0] === 'paused').length, 0, 'paused() is not asked when no job is pending');

  const paused = await harness({ paused: 'spend_limit' });
  await reviewJob(paused.db, 'manual');
  await paused.run();
  assert.deepEqual(writes(paused).map((w) => [w.status, w.title]), [['queued', 'Review waiting: reviews are paused (spend_limit)']]);
  const r = await rows(paused.db);
  assert.deepEqual([r[0]!.state, r[0]!.code], ['paused', 'spend_limit']);

  const none = await harness({ paused: 'spend_limit' });
  await none.run();
  assert.equal(none.calls.filter((c) => c[0] === 'paused').length, 0);
  assert.equal(writes(none)[0]!.title, 'Waiting for /done');
});

test('a push\'s job that is about to be dropped as gated is no review under way', async () => {
  const enforce = await harness();
  await reviewJob(enforce.db, 'automatic');
  await enforce.run();
  assert.equal(writes(enforce)[0]!.title, 'Waiting for /done');

  const shadow = await harness({ settings: withGate({ mode: 'shadow' }) });
  await reviewJob(shadow.db, 'automatic');
  await shadow.run();
  assert.equal(writes(shadow)[0]!.title, 'Reviewing');
});

test('a review job the database calls running that no runner holds is not under way', async () => {
  const h = await harness({ reviewing: false });
  await reviewJob(h.db, 'manual', true);
  await h.run();
  assert.equal(writes(h)[0]!.title, 'Waiting for /done');

  await reviewJob(h.db, 'manual');
  await again(h, 5);
  assert.deepEqual(writes(h).map((w) => w.title), ['Waiting for /done', 'Reviewing']);
});

test('a skip stored for the head outranks a review under way and the threads; one stored for another head does not', async () => {
  const { h } = await blockedHarness();
  await reviewJob(h.db, 'manual');
  await recordSkip(h.db, { ref: REF, headSha: 'h1', actor: 'octo-lead', reason: 'hotfix', commentId: '41', at: at(0) });
  await h.run();
  assert.deepEqual(writes(h).map((w) => [w.conclusion, w.title]), [['success', 'Skipped by @octo-lead']]);
  assert.equal((await rows(h.db))[0]!.state, 'skipped');
  assert.equal(threadReads(h), 0);

  const other = await blockedHarness();
  await reviewJob(other.h.db, 'manual');
  await recordSkip(other.h.db, { ref: REF, headSha: 'h0', actor: 'octo-lead', reason: 'hotfix', commentId: '41', at: at(0) });
  await other.h.run();
  assert.equal(writes(other.h)[0]!.title, 'Reviewing');

  const blocked = await blockedHarness();
  await recordSkip(blocked.h.db, { ref: REF, headSha: 'h0', actor: 'octo-lead', reason: 'hotfix', commentId: '41', at: at(0) });
  await blocked.h.run();
  assert.equal(writes(blocked.h)[0]!.conclusion, 'action_required');
});

test('in bypass the check is green whatever the threads say, and no thread is read', async () => {
  const { h } = await blockedHarness({ settings: withGate({ mode: 'bypass' }) });
  await h.run();
  assert.deepEqual(writes(h).map((w) => [w.status, w.conclusion, w.title]), [['completed', 'success', 'Gate bypassed']]);
  const r = await rows(h.db);
  assert.deepEqual([r[0]!.mode, r[0]!.state], ['bypass', 'bypassed']);
  assert.equal(threadReads(h), 0);
});

test('threads that cannot be read fail the check at once, and the job tries again', async () => {
  const { h, run } = await blockedHarness({ threads: [new Error('github_502'), []] });
  await h.run();
  const first = writes(h)[0]!;
  assert.deepEqual([first.status, first.conclusion, first.title], ['completed', 'failure', 'Could not evaluate (github_502): comment /done to retry']);
  assert.ok(first.summary.includes('The service tries again by itself.'));
  const r = await rows(h.db);
  assert.deepEqual([r[0]!.state, r[0]!.code, r[0]!.run], ['failed', 'github_502', run]);
  const job = (await getJob(h.db, h.job.id))!;
  assert.deepEqual([job.status, job.runAt], ['pending', at(10)]);
  assert.equal(gateLogs(h)[0]!['outcome'], 'put_back');
  assert.equal(gateLogs(h)[0]!['requeued'], true);

  assert.equal(await h.claimNext(at(9)), null);
  const second = await h.claimNext(at(10));
  assert.ok(second !== null && second.id === h.job.id && second.starts === 2);
  await h.run(second);
  assert.deepEqual(writes(h).map((w) => [w.id, w.conclusion]), [[null, 'failure'], ['701', 'success']]);
  assert.deepEqual(await statusOf(h), ['done', 'synced']);
  assert.deepEqual(h.alerts, []);
});

test('a job that fails three times ends, stops promising, and the operator is told', async () => {
  const { h } = await blockedHarness({ threads: [new Error('github_502')], starts: 3 });
  await h.run();
  const w = writes(h)[0]!;
  assert.equal(w.title, 'Could not evaluate (github_502): comment /done to retry');
  assert.ok(!w.summary.includes('tries again'));
  assert.deepEqual(await statusOf(h), ['done', 'failed']);
  assert.deepEqual(h.alerts, [['gate_check_failed', { reason: 'github_502' }]]);

  for (const code of ['github_500', 'check_not_rewritten']) {
    const failing = await harness({ writeFailures: [new Error(code)], starts: 3 });
    await failing.run();
    assert.equal(writes(failing).length, 1);
    assert.equal(failing.calls.at(-1)![0], 'writeCheck', 'no further call');
    assert.deepEqual((await rows(failing.db)).map((r) => [r.head_sha, r.mode, r.state, r.code]), [['h1', 'enforce', 'failed', code]], 'the give-up is recorded (call 52)');
    assert.deepEqual(await statusOf(failing), ['done', 'failed']);
    assert.deepEqual(failing.alerts, [['gate_check_failed', { reason: code }]]);
  }

  const gone = await harness({ live: new Error('github_503') });
  await gone.run();
  assert.equal(finds(gone).length, 0);
  assert.deepEqual((await getJob(gone.db, gone.job.id))!.runAt, at(10));
  const two = (await gone.claimNext(at(10)))!;
  await gone.run(two);
  assert.deepEqual([(await getJob(gone.db, gone.job.id))!.status, (await getJob(gone.db, gone.job.id))!.runAt], ['pending', at(70)]);
  assert.deepEqual(gone.alerts, []);
  const three = (await gone.claimNext(at(70)))!;
  assert.equal(three.starts, 3);
  await gone.run(three);
  assert.deepEqual(await statusOf(gone), ['done', 'failed']);
  assert.deepEqual(gone.alerts, [['gate_check_failed', { reason: 'github_503' }]]);
  assert.equal(finds(gone).length + writes(gone).length, 0);
  // The head and mode come from the stored pull request when the live one could not be read.
  assert.deepEqual((await rows(gone.db)).map((r) => [r.head_sha, r.mode, r.state, r.code]), [['h1', 'enforce', 'failed', 'github_503']]);
});

test('a failed review of this head says so with its code, and a later look does not turn it back to waiting', async () => {
  const h = await harness();
  await storeRun(h.db, { outcome: 'failed', failureStage: 'model', failureCode: 'timeout', body: '', publish: false });
  await h.run();
  assert.deepEqual(writes(h).map((w) => [w.conclusion, w.title]), [['failure', 'Review failed (timeout): comment /done to retry']]);
  assert.deepEqual(await statusOf(h), ['done', 'synced']);
  await again(h, 5);
  assert.equal(writes(h).length, 1);
  assert.equal((await rows(h.db)).length, 1);
  assert.equal(h.held.get('h1')!.title, 'Review failed (timeout): comment /done to retry');
});

test('the check is written on the commit that was read', async () => {
  const h = await harness({ live: liveOf({ head: 'h2' }), threads: [[thread()]] });
  const run = await storeRun(h.db);
  await storeComment(h.db, run, 'major');
  await h.run();
  assert.deepEqual(finds(h).map((c) => c[3]), ['h2']);
  assert.deepEqual(writes(h).map((w) => [w.commit, w.title]), [['h2', 'Waiting for /done']]);
  assert.equal(h.held.has('h1'), false);
  assert.equal((await rows(h.db))[0]!.head_sha, 'h2');
});

test('two pull requests on one commit decide the check one after the other', async () => {
  // Pull request 8 has a review waiting, so its check says something else than 7's.
  const h = await harness({ slow: true });
  const eight = await h.another(8);
  await reviewJob(h.db, 'manual', false, 8);
  await Promise.all([h.run(), h.run(eight)]);
  const order = h.calls.filter((c) => c[0] === 'findCheck' || c[0] === 'writeCheck').map((c) => c[0]);
  assert.deepEqual(order, ['findCheck', 'writeCheck', 'findCheck', 'writeCheck']);
  const w = writes(h);
  assert.equal(w[0]!.id, null);
  assert.deepEqual([w[0]!.title, w[1]!.id, w[1]!.title], ['Waiting for /done', '701', 'Reviewing'], 'the second write names the first one\'s check');

  const loose = await harness({ slow: true });
  const other = await loose.another(8);
  await reviewJob(loose.db, 'manual', false, 8);
  await Promise.all([runGateJob(loose.job, loose.deps), runGateJob(other, { ...loose.deps, lock: createKeyedLock() })]);
  const looseOrder = loose.calls.filter((c) => c[0] === 'findCheck' || c[0] === 'writeCheck').map((c) => c[0]);
  assert.deepEqual(looseOrder, ['findCheck', 'findCheck', 'writeCheck', 'writeCheck']);
  assert.deepEqual(writes(loose).map((x) => x.id), [null, null], 'without the shared lock two checks are written');
});

test('a pull request that is closed, gone or not gated, a repository with the gate off, no installation and a dry run touch no check', async () => {
  // closed, merged and gone record what they found (call 52); the others record nothing.
  const cases: Array<[Parameters<typeof harness>[0], [string, string], boolean, string | null]> = [
    [{ live: liveOf({ state: 'closed' }) }, ['done', 'closed'], true, 'closed'],
    [{ live: liveOf({ state: 'merged' }) }, ['done', 'closed'], true, 'closed'],
    [{ live: null }, ['dropped', 'not_found'], true, 'not_found'],
    [{ live: liveOf({ baseBranch: 'feature/x' }) }, ['done', 'not_gated'], true, null],
    [{ settings: { ...SETTINGS, gate: GATE_OFF } }, ['dropped', 'gate_off'], false, null],
    [{ installation: null }, ['dropped', 'no_installation'], false, null],
    [{ dryRun: true }, ['dropped', 'dry_run'], false, null],
  ];
  for (const [options, end, read, recorded] of cases) {
    const h = await harness({ ...options, check: WAITING_CHECK });
    await h.run();
    assert.equal(finds(h).length + writes(h).length, 0, end[1]);
    assert.equal(h.calls.some((c) => c[0] === 'readPullRequest'), read, end[1]);
    assert.deepEqual(await statusOf(h), end);
    assert.deepEqual((await rows(h.db)).map((r) => r.state), recorded === null ? [] : [recorded], end[1]);
    assert.equal(gateLogs(h)[0]!['outcome'], end[1]);
  }
});

test('a record that cannot be stored changes nothing', async () => {
  const h = await harness({ failQuery: 'insert into visto_ai.gate_evaluations' });
  await h.run();
  assert.equal(writes(h).length, 1);
  assert.deepEqual(await statusOf(h), ['done', 'synced']);
  assert.deepEqual(h.logs.filter((e) => e['event'] === 'gate_record_failed'), [{ event: 'gate_record_failed', job: h.job.id, reason: 'db_down' }]);

  const unread = await harness({ failQuery: 'from visto_ai.gate_evaluations', check: WAITING_CHECK });
  await unread.run();
  assert.equal(writes(unread).length, 0);
  assert.deepEqual(await statusOf(unread), ['done', 'synced']);
  assert.equal(unread.logs.filter((e) => e['event'] === 'gate_record_failed').length, 1);
});

test('a job of a reason the gate does not know ends and asks for the check', async () => {
  const h = await harness({ reason: 'other' });
  await h.run();
  assert.deepEqual(await statusOf(h), ['done', 'unknown_reason']);
  const pending = await h.db.query<{ reason: string }>("select reason from visto_ai.jobs where kind = 'gate' and status = 'pending'");
  assert.deepEqual(pending.map((p) => p.reason), ['sync']);
  assert.equal(h.queued(), 1);
  assert.equal(h.calls.length, 0);
});

test('a request for the check that fails after a job of an unknown reason ended leaves the end as it was', async () => {
  const h = await harness({ reason: 'other', failQuery: "'gate', 'sync', '', 'pending'" });
  await h.run();
  assert.deepEqual(await statusOf(h), ['done', 'unknown_reason']);
  assert.equal(gateLogs(h)[0]!['outcome'], 'unknown_reason');
  assert.equal(h.queued(), 0);
});

test('the log says a check was not written only once it was compared, and an outcome only once the job was finished', async () => {
  const unread = await harness({ check: new Error('github_502') });
  await unread.run();
  assert.deepEqual([gateLogs(unread)[0]!['wrote'], gateLogs(unread)[0]!['outcome']], [null, 'put_back']);
  assert.equal(writes(unread).length, 0);
  assert.equal((await rows(unread.db)).length, 0);
  assert.deepEqual((await getJob(unread.db, unread.job.id))!.runAt, at(10));

  const taken = await harness({ dryRun: true });
  await taken.db.query("update visto_ai.jobs set status = 'done', outcome = 'other' where id = $1", [taken.job.id]);
  await taken.run();
  assert.equal(gateLogs(taken)[0]!['outcome'], null);
  assert.deepEqual(await statusOf(taken), ['done', 'other']);

  const given = await harness({ threads: [new Error('github_502')], starts: 3 });
  await given.db.query("update visto_ai.jobs set status = 'done', outcome = 'other' where id = $1", [given.job.id]);
  await given.run();
  assert.equal(gateLogs(given)[0]!['outcome'], null);
  assert.deepEqual(given.alerts, []);
});

test('a thread list that is not a list fails the check', async () => {
  const { h } = await blockedHarness({ threads: ['nothing' as unknown as []] });
  await h.run();
  assert.deepEqual(writes(h).map((w) => [w.conclusion, w.title]), [['failure', 'Could not evaluate (internal_error): comment /done to retry']]);
  assert.equal((await rows(h.db))[0]!.state, 'failed');
});

test('a sync that fails while another waits is dropped as superseded and hands it its starts', async () => {
  const { h } = await blockedHarness({ threads: [new Error('github_502')] });
  await askGate(h.db, REF, at(1));
  await h.run();
  assert.deepEqual(await statusOf(h), ['dropped', 'superseded']);
  assert.deepEqual([gateLogs(h)[0]!['outcome'], gateLogs(h)[0]!['requeued']], ['superseded', false]);
  const waiting = await h.db.query<{ starts: number }>("select starts from visto_ai.jobs where kind = 'gate' and status = 'pending'");
  assert.deepEqual(waiting.map((w) => w.starts), [1]);
  assert.deepEqual(h.alerts, []);
});

test('a write that fails on the first start and on the second is put back after 10 and then 60 seconds', async () => {
  const h = await harness({ writeFailures: [new Error('github_500'), new Error('github_500')] });
  await h.run();
  assert.deepEqual(await statusOf(h), ['pending', null]);
  assert.equal((await getJob(h.db, h.job.id))!.runAt, at(10));
  const second = (await h.claimNext(at(10)))!;
  await h.run(second);
  assert.equal((await getJob(h.db, h.job.id))!.runAt, at(70));
  assert.deepEqual(gateLogs(h).map((e) => [e['wrote'], e['outcome']]), [[false, 'put_back'], [false, 'put_back']]);
  const third = (await h.claimNext(at(70)))!;
  await h.run(third);
  assert.deepEqual(await statusOf(h), ['done', 'synced']);
  assert.equal(writes(h).length, 3);
  assert.deepEqual(h.alerts, []);
});

test('the end of a job that cannot be stored is logged as error and the job is left for the next start', async () => {
  const h = await harness({ failQuery: 'set status = $2, outcome = $3' });
  await h.run();
  assert.equal(gateLogs(h)[0]!['outcome'], 'error');
  assert.deepEqual(await statusOf(h), ['running', null]);
});

test('a look that needs no write is recorded when the newest record has another head, another state or another code', async () => {
  const cases: Array<[string, { headSha: string; state: GateState; code: string | null }]> = [
    ['another head', { headSha: 'h0', state: 'waiting', code: null }],
    ['another state', { headSha: 'h1', state: 'reviewing', code: null }],
    ['another code', { headSha: 'h1', state: 'waiting', code: 'github_502' }],
    ['the same', { headSha: 'h1', state: 'waiting', code: null }],
  ];
  for (const [name, record] of cases) {
    const h = await harness({ check: WAITING_CHECK });
    await recordEvaluation(h.db, { ref: REF, at: at(0), mode: 'enforce', run: null, counts: NO_COUNTS, ...record });
    await h.run();
    assert.equal(writes(h).length, 0, name);
    assert.equal((await rows(h.db)).length, name === 'the same' ? 1 : 2, name);
  }
});

test('the log holds ids, states, codes and counts only', async () => {
  const { h } = await blockedHarness({ settings: withGate({ skipTeam: 'acme/release-managers' }) });
  await h.run();
  await recordSkip(h.db, { ref: REF, headSha: 'h1', actor: 'octo-lead', reason: 'hotfix for octo-dev in src/a.ts', commentId: '41', at: at(3) });
  const second = await again(h, 5);
  const logs = gateLogs(h);
  assert.equal(logs.length, 2);
  const keys = ['event', 'job', 'repo', 'number', 'reason', 'head', 'mode', 'state', 'code', 'blocking', 'cleared_by_review', 'cleared_by_reply',
    'unknown', 'refused_inline', 'wrote', 'outcome', 'requeued'];
  for (const entry of logs) assert.deepEqual(Object.keys(entry).sort(), [...keys].sort());
  assert.deepEqual(logs[0], {
    event: 'gate', job: h.job.id, repo: 'acme/shop', number: 7, reason: 'sync', head: 'h1', mode: 'enforce', state: 'blocked', code: null,
    blocking: 1, cleared_by_review: 0, cleared_by_reply: 0, unknown: 0, refused_inline: 0, wrote: true, outcome: 'synced', requeued: null,
  });
  assert.deepEqual([logs[1]!['job'], logs[1]!['state'], logs[1]!['wrote'], logs[1]!['blocking']], [second, 'skipped', true, 0]);
  const text = JSON.stringify(h.logs);
  for (const word of ['octo-', 'src/a.ts', 'hotfix', 'release-managers']) assert.ok(!text.includes(word), word);
});

test('a sync that gives up on a write that never succeeds records one failed row, and the same failure again adds none', async () => {
  const fail = (): Error => new Error('github_500');
  const h = await harness({ writeFailures: [fail(), fail(), fail(), fail()] });
  await h.run();
  await h.run((await h.claimNext(at(10)))!);
  await h.run((await h.claimNext(at(70)))!);
  assert.deepEqual(await statusOf(h), ['done', 'failed']);
  const failed = (await rows(h.db)).map((r) => [r.head_sha, r.mode, r.state, r.code, r.blocking, r.findings]);
  assert.deepEqual(failed, [['h1', 'enforce', 'failed', 'github_500', 0, 0]]);
  // The next start's sweep asks for it again, and the same failure records nothing new.
  assert.equal(await sweepGate(h.db, () => SETTINGS, at(100)), 1);
  await h.db.query("update visto_ai.jobs set starts = 2 where kind = 'gate' and status = 'pending'");
  const again = (await h.claimNext(at(100)))!;
  assert.equal(again.starts, 3);
  await h.run(again);
  assert.equal((await rows(h.db)).length, 1);
  assert.equal(writes(h).length, 4);
});

test('a pull request the database holds as open that is closed or gone is asked for at each start, and recorded once', async () => {
  for (const [live, state] of [[liveOf({ state: 'closed' }), 'closed'], [liveOf({ state: 'merged', head: 'h2' }), 'closed'], [null, 'not_found']] as const) {
    const h = await harness({ live });
    await finishJob(h.db, h.job.id, 'dropped', 'other', at(0));
    const asked: number[] = [];
    for (const start of [100, 200, 300]) {
      asked.push(await sweepGate(h.db, () => SETTINGS, at(start)));
      const job = await h.claimNext(at(start));
      if (job !== null) await h.run(job);
    }
    assert.deepEqual(asked, [1, 1, 1], state);
    const head = live === null ? 'h1' : live.info.headSha;
    assert.deepEqual((await rows(h.db)).map((r) => [r.head_sha, r.mode, r.state, r.code, r.blocking, r.findings, r.run]), [[head, 'enforce', state, null, 0, 0, null]], state);
    assert.equal(finds(h).length + writes(h).length, 0, state);
  }
});

test('a completed check that must say Reviewing or wait again is replaced by a new run, since GitHub does not reopen one', async () => {
  const passed: OwnCheck = { id: '71', ...checkText({ state: 'bypassed' }, META) };
  const blocked: OwnCheck = { id: '72', status: 'completed', conclusion: 'action_required', title: '1 blocking finding is open', summary: 'x' };
  for (const held of [passed, blocked]) {
    const h = await harness({ check: held });
    await reviewJob(h.db, 'manual');
    await h.run();
    const reviewing = checkText({ state: 'reviewing' }, META);
    assert.deepEqual(writes(h), [{ id: null, commit: 'h1', name: 'AI Review', ...reviewing }], held.id);
    assert.deepEqual(await statusOf(h), ['done', 'synced'], held.id);
    // The new run is the one GitHub answers from now on: the next look finds it and writes nothing.
    await again(h, 5);
    assert.equal(writes(h).length, 1, held.id);
    assert.equal(h.held.get('h1')!.id, '701', held.id);
  }

  // Leaving bypass on a head with no review: the bypassed run is replaced by a waiting one.
  const left = await harness({ check: passed });
  await recordEvaluation(left.db, { ref: REF, headSha: 'h1', at: at(0), mode: 'bypass', state: 'bypassed', code: null, run: null, counts: NO_COUNTS });
  await left.run();
  assert.deepEqual(writes(left).map((w) => [w.id, w.status, w.conclusion, w.title]), [[null, 'queued', null, 'Waiting for /done']]);
});

test('a completed check that must say another conclusion, and a check not yet completed, are updated in place', async () => {
  const passed: OwnCheck = { id: '71', ...checkText({ state: 'bypassed' }, META) };
  const { h } = await blockedHarness({ check: passed });
  await h.run();
  assert.deepEqual(writes(h).map((w) => [w.id, w.status, w.conclusion]), [['71', 'completed', 'action_required']]);

  for (const held of [WAITING_CHECK, { id: '73', ...checkText({ state: 'reviewing' }, META) }]) {
    const toReviewing = await harness({ check: { ...held, title: 'Something else' } });
    await reviewJob(toReviewing.db, 'manual');
    await toReviewing.run();
    const toDone = await blockedHarness({ check: held });
    await toDone.h.run();
    const toWaiting = await harness({ check: { ...held, title: 'Something else' } });
    await toWaiting.run();
    assert.deepEqual([...writes(toReviewing), ...writes(toDone.h), ...writes(toWaiting)].map((w) => [w.id, w.status]),
      [[held.id, 'in_progress'], [held.id, 'completed'], [held.id, 'queued']], held.id);
  }
});

test('a stranger\'s waiting /review, about to be refused, is no review under way: a green check stays green, paused or not', async () => {
  for (const [paused, claim] of [['spend_limit', false], [null, false], [null, true]] as const) {
    const h = await harness({ paused });
    await storeRun(h.db, { findings: [] });
    const id = await enqueueJob(h.db, {
      ref: REF, reason: 'command', headSha: '', runAt: at(0), now: at(0), delivery: null, replace: true, trigger: 'manual',
      requestedBy: 'stranger-1', commentId: '35', association: 'none', installation: '99',
    });
    if (claim) await claimJob(h.db, id!, at(0));
    await h.run();
    assert.deepEqual(writes(h).map((w) => [w.status, w.conclusion, w.title]), [['completed', 'success', 'No blocking findings']], `${paused} ${claim}`);
  }
});

test('the sweep\'s sync for a stored pull request carries no installation, and the job uses the stored one', async () => {
  const h = await harness({ installation: '42' });
  await finishJob(h.db, h.job.id, 'dropped', 'other', at(0));
  assert.equal(await sweepGate(h.db, () => SETTINGS, at(100)), 1);
  const job = (await h.claimNext(at(100)))!;
  assert.equal(job.installation, null);
  await h.run(job);
  assert.deepEqual(h.calls.filter((c) => c[0] === 'readPullRequest').map((c) => c[2]), ['42']);
  assert.deepEqual(await statusOf(h, job.id), ['done', 'synced']);
});

/** Stores a run of the pull request `number` at `head` with no finding, published as review `reviewId`, as an approval or as a comment. */
async function postedRun(db: Db, reviewId: string, approved: boolean, head = 'h1', number: number = REF.number): Promise<number> {
  const id = await storeRun(db, { ref: { ...REF, number }, headSha: head, findings: [], publish: false });
  await markPublished(db, id, { reviewId, publishedAt: at(2), body: 'A review.', inlineDropped: false, approved, approvalCode: approved ? 'approved' : null });
  return id;
}

/** Runs the job with a database that keeps the text of each statement it is given. */
async function runSeen(h: Harness, job = h.job): Promise<string[]> {
  const seen: string[] = [];
  const db: Db = {
    query: (text, params) => { seen.push(text); return h.deps.db.query(text, params); },
    script: (sql) => h.deps.db.script(sql),
    transaction: (work) => h.deps.db.transaction(work),
    close: () => h.deps.db.close(),
  };
  await runGateJob(job, { ...h.deps, db });
  return seen;
}

const UNWITHDRAWN_SUMMARY = [
  'This reviewer approved an earlier commit of this pull request, or gave an approval it no longer stands behind, and could not dismiss it (`github_403`). While it stands it may count toward the approvals this branch requires, so this check fails.',
  "Dismiss that approval on the pull request's page. The service also tries again at the next commit, the next review of this pull request and its next start, and this check is decided again once the approval is gone.",
].join('\n\n');

test('a gate job on a pull request whose approval could not be dismissed writes the failing check and records it', async () => {
  // The approval of h1 stands after a push to h2: its withdrawal failed. A skip of h2 and a review under way do not pass it.
  const h = await harness({ live: liveOf({ head: 'h2' }), threads: [[thread()]], check: WAITING_CHECK, starts: 3 });
  const approval = await postedRun(h.db, '501', true);
  assert.equal(await markDismissFailed(h.db, approval, 'github_403'), true);
  await recordSkip(h.db, { ref: REF, headSha: 'h2', actor: 'octo-lead', reason: 'hotfix', commentId: '41', at: at(0) });
  await reviewJob(h.db, 'manual');
  const statements = await runSeen(h);
  assert.deepEqual(writes(h), [{
    id: '71', commit: 'h2', name: 'AI Review', status: 'completed', conclusion: 'failure', title: 'Earlier approval not withdrawn (github_403)', summary: UNWITHDRAWN_SUMMARY,
  }]);
  assert.deepEqual((await rows(h.db)).map((r) => [r.head_sha, r.mode, r.state, r.code, r.run, r.blocking, r.findings, r.refused_inline]),
    [['h2', 'enforce', 'unwithdrawn', 'github_403', null, 0, 0, 0]]);
  // Ended, not tried again, even on its last start: no alert, no sync left waiting, no thread read.
  assert.deepEqual(await statusOf(h), ['done', 'synced']);
  assert.deepEqual(await h.db.query("select id from visto_ai.jobs where kind = 'gate' and status = 'pending'"), []);
  assert.deepEqual(h.alerts, []);
  assert.equal(threadReads(h), 0);
  assert.deepEqual(gateLogs(h), [{
    event: 'gate', job: h.job.id, repo: 'acme/shop', number: 7, reason: 'sync', head: 'h2', mode: 'enforce', state: 'unwithdrawn', code: 'github_403',
    blocking: 0, cleared_by_review: 0, cleared_by_reply: 0, unknown: 0, refused_inline: 0, wrote: true, outcome: 'synced', requeued: null,
  }]);
  // Read beside the skip, before the jobs.
  const skipAt = statements.findIndex((s) => s.includes('from visto_ai.gate_overrides'));
  const failureAt = statements.findIndex((s) => s.includes('dismiss_failure is not null'));
  const jobsAt = statements.findIndex((s) => s.includes("kind = 'review' and status in ('pending', 'running')"));
  assert.ok(skipAt >= 0 && failureAt === skipAt + 1 && jobsAt === failureAt + 1, JSON.stringify([skipAt, failureAt, jobsAt]));

  // A second look writes nothing and records nothing.
  await again(h, 5);
  assert.equal(writes(h).length, 1);
  assert.equal((await rows(h.db)).length, 1);
  // Once the approval is dismissed, by anyone, the check is decided again: here the skip of h2 lets it through.
  assert.equal(await markDismissed(h.db, approval, at(6), 'git_service'), true);
  await again(h, 7);
  assert.deepEqual(writes(h).map((w) => [w.commit, w.conclusion, w.title]).at(-1), ['h2', 'success', 'Skipped by @octo-lead']);
  assert.deepEqual((await rows(h.db)).map((r) => r.state), ['unwithdrawn', 'skipped']);

  // Bypass outranks it.
  const bypass = await harness({ settings: withGate({ mode: 'bypass' }), live: liveOf({ head: 'h2' }) });
  await markDismissFailed(bypass.db, await postedRun(bypass.db, '501', true), 'github_403');
  await bypass.run();
  assert.deepEqual(writes(bypass).map((w) => [w.conclusion, w.title]), [['success', 'Gate bypassed']]);
  assert.deepEqual((await rows(bypass.db)).map((r) => r.state), ['bypassed']);

  // An approval of the head that could not be dismissed fails the head's check as well, whatever its review says.
  const same = await harness({ threads: [[]] });
  await markDismissFailed(same.db, await postedRun(same.db, '501', true), 'review_state_other');
  await same.run();
  assert.deepEqual(writes(same).map((w) => [w.commit, w.conclusion, w.title]), [['h1', 'failure', 'Earlier approval not withdrawn (review_state_other)']]);
  assert.deepEqual(await statusOf(same), ['done', 'synced']);
});

test('with no failed withdrawal the evaluation is what it was', async () => {
  // Each case is run twice, on the same runs: posted as comments, and posted as approvals none of which carries a
  // failure that stands (one with none, one whose failure ended with its dismissal, one of another pull request).
  const cases: Array<[string, Parameters<typeof harness>[0], (db: Db) => Promise<void>]> = [
    ['waiting', { live: liveOf({ head: 'h2' }) }, async () => {}],
    ['blocked', { threads: [[thread()]] }, async (db) => { await storeComment(db, await storeRun(db), 'major'); }],
    ['passed', { threads: [[thread({ resolved: true, comments: [appComment('8001'), reply('octo-dev')] })]] }, async (db) => { await storeComment(db, await storeRun(db), 'major'); }],
    ['skipped', {}, async (db) => { await recordSkip(db, { ref: REF, headSha: 'h1', actor: 'octo-lead', reason: 'hotfix', commentId: '41', at: at(0) }); }],
    ['reviewing', {}, async (db) => { await reviewJob(db, 'manual'); }],
    ['bypassed', { settings: withGate({ mode: 'bypass' }) }, async () => {}],
    ['failed', { threads: [new Error('github_502')] }, async (db) => { await storeComment(db, await storeRun(db), 'major'); }],
  ];
  type Seen = { writes: CheckWrite[]; rows: Row[]; logs: unknown[]; calls: unknown[][]; status: [string, string | null]; statements: string[] };
  for (const [name, options, setup] of cases) {
    const seen: Seen[] = [];
    for (const approvals of [false, true]) {
      const h = await harness(options);
      await setup(h.db);
      await postedRun(h.db, '601', approvals, 'h0');
      const ended = await postedRun(h.db, '602', approvals, 'h0');
      const other = await postedRun(h.db, '603', approvals, 'h1', 8);
      if (approvals) {
        assert.equal(await markDismissFailed(h.db, ended, 'github_403'), true);
        assert.equal(await markDismissed(h.db, ended, at(3), 'app'), true);
        assert.equal(await markDismissFailed(h.db, other, 'github_403'), true);
      }
      const statements = await runSeen(h);
      seen.push({ writes: writes(h), rows: await rows(h.db), logs: gateLogs(h), calls: h.calls, status: await statusOf(h), statements });
    }
    const [plain, quiet] = seen as [Seen, Seen];
    assert.equal(plain.rows[0]!.state, name, name);
    assert.deepEqual(quiet, plain, name);
    // The failures are read once in each evaluation, and nothing else is.
    assert.equal(quiet.statements.filter((s) => s.includes('dismiss_failure')).length, 1, name);
  }
});

test('a read of the failed withdrawals that rejects writes nothing, and the job is tried again, as when the skip cannot be read', async () => {
  const ends: unknown[] = [];
  for (const failQuery of ['dismiss_failure is not null', 'from visto_ai.gate_overrides']) {
    const h = await harness({ failQuery, check: WAITING_CHECK, threads: [[thread()]] });
    await storeComment(h.db, await storeRun(h.db), 'major');
    await h.run();
    const first = { writes: writes(h), rows: await rows(h.db), job: await statusOf(h), runAt: (await getJob(h.db, h.job.id))!.runAt, log: gateLogs(h)[0] };
    assert.deepEqual([first.writes, first.rows, first.job, first.runAt], [[], [], ['pending', null], at(10)], failQuery);
    assert.equal(threadReads(h), 0, failQuery);
    // On the third start it gives up as any sync does: an alert, and the give-up recorded.
    await h.run((await h.claimNext(at(10)))!);
    await h.run((await h.claimNext(at(70)))!);
    const last = { writes: writes(h), states: (await rows(h.db)).map((r) => [r.head_sha, r.state, r.code]), job: await statusOf(h), alerts: h.alerts };
    assert.deepEqual(last, { writes: [], states: [['h1', 'failed', 'db_down']], job: ['done', 'failed'], alerts: [['gate_check_failed', { reason: 'db_down' }]] }, failQuery);
    ends.push([first, last, gateLogs(h)]);
  }
  assert.deepEqual(ends[0], ends[1]);
});
