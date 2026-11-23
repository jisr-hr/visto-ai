import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GATE_OFF } from '../config/load.ts';
import { recordEvaluation, recordSkip, NO_COUNTS } from '../db/gate.ts';
import type { GateState } from '../db/gate.ts';
import { askGate, claimJob, enqueueJob, finishJob, getJob } from '../db/jobs.ts';
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

test('a pull request the database holds as open that is closed or gone is asked for at the first start and not again', async () => {
  for (const [live, state] of [[liveOf({ state: 'closed' }), 'closed'], [liveOf({ state: 'merged', head: 'h2' }), 'closed'], [null, 'not_found']] as const) {
    const h = await harness({ live });
    await finishJob(h.db, h.job.id, 'dropped', 'other', at(0));
    const asked: number[] = [];
    for (const start of [100, 200, 300]) {
      asked.push(await sweepGate(h.db, () => SETTINGS, at(start)));
      const job = await h.claimNext(at(start));
      if (job !== null) await h.run(job);
    }
    assert.deepEqual(asked, [1, 0, 0], state);
    const head = live === null ? 'h1' : live.info.headSha;
    assert.deepEqual((await rows(h.db)).map((r) => [r.head_sha, r.mode, r.state, r.code, r.blocking, r.findings, r.run]), [[head, 'enforce', state, null, 0, 0, null]], state);
    assert.equal(finds(h).length + writes(h).length, 0, state);
  }
});
