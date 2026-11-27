import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import { markPublished, recordRun } from './review-runs.ts';
import type { RunRecord } from './review-runs.ts';
import { clearDismissFailure, markDismissFailed } from './approvals.ts';
import { clearAlerts, openAlerts, pruneAlerts, readHealth, recentAlerts, storeAlert, writeHealth } from './status.ts';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
const DAY = 86400;
const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 128 } as const;
const store = (db: Awaited<ReturnType<typeof testDb>>, code: string, key: string, seconds: number, dedupe: string | null = null, details = {}) =>
  storeAlert(db, { code, key, details, at: at(seconds), dedupeSince: dedupe });
const idOf = async (db: Awaited<ReturnType<typeof testDb>>, code: string, key: string, raised: number): Promise<number> =>
  (await db.query<{ id: number }>('select id from visto_ai.alerts where code = $1 and key = $2 and raised_at = $3::timestamptz', [code, key, at(raised)]))[0]!.id;

test('an alert is stored with its key and details, and an opener is not stored again while one of its key is open', async () => {
  const db = await testDb();
  const epoch = '1970-01-01T00:00:00.000Z';
  assert.equal(await store(db, 'mcp_error', 'docs', 0, epoch, { server: 'docs', reason: 'mcp_timeout' }), true);
  assert.deepEqual(
    (await db.query<{ code: string; key: string; details: unknown; raised_at: Date; cleared_at: Date | null }>(
      'select code, key, details, raised_at, cleared_at from visto_ai.alerts')),
    [{ code: 'mcp_error', key: 'docs', details: { server: 'docs', reason: 'mcp_timeout' }, raised_at: new Date(at(0)), cleared_at: null }]);
  assert.equal(await store(db, 'mcp_error', 'docs', 10, epoch), false);
  assert.equal(await store(db, 'mcp_error', 'other', 10, epoch), true);
  assert.equal(await clearAlerts(db, 'mcp_error', 'docs', at(20)), 1);
  assert.equal(await store(db, 'mcp_error', 'docs', 30, epoch), true);
  assert.equal(await store(db, 'gate_bypass', 'k', 40), true);
  assert.equal(await store(db, 'gate_bypass', 'k', 41), true);
  assert.deepEqual(await db.query('select count(*)::int as n from visto_ai.alerts where code = $1', ['gate_bypass']), [{ n: 2 }]);
  await db.close();
});
test('a spend alert is stored once a UTC day', async () => {
  const db = await testDb();
  const day0 = '2026-03-01T00:00:00.000Z';
  const day1 = '2026-03-02T00:00:00.000Z';
  assert.equal(await store(db, 'spend_80', 'global', 0, day0), true);
  assert.equal(await store(db, 'spend_80', 'global', 60, day0), false);
  assert.equal(await store(db, 'spend_80', 'global', DAY, day1), true);
  await db.close();
});
test('alerts are cleared by code and key, or by code alone', async () => {
  const db = await testDb();
  await store(db, 'feature_off', 'gate', 0);
  await store(db, 'feature_off', 'approval', 1);
  await store(db, 'mcp_error', 'docs', 2);
  assert.equal(await clearAlerts(db, 'feature_off', null, at(10)), 2);
  assert.equal(await clearAlerts(db, 'mcp_error', 'docs', at(11)), 1);
  assert.deepEqual(await db.query('select code, cleared_at from visto_ai.alerts order by id'), [
    { code: 'feature_off', cleared_at: new Date(at(10)) }, { code: 'feature_off', cleared_at: new Date(at(10)) },
    { code: 'mcp_error', cleared_at: new Date(at(11)) },
  ]);
  assert.equal(await clearAlerts(db, 'feature_off', null, at(12)), 0);
  assert.equal(await clearAlerts(db, 'mcp_error', 'docs', at(12)), 0);
  await db.close();
});

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'merge000', baseBranch: 'main',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [], result: { findings: [] },
  usage: { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.0375 },
  startedAt: at(0), finishedAt: at(90), ...over,
});

test('the open alerts follow their rules: openers and feature_off until cleared, spend for its UTC day, a withdrawal while its failure is recorded', async () => {
  const db = await testDb();
  const base = 2 * DAY;
  const dayStart = at(base);
  await store(db, 'memory_error', 'memory', base + 1);
  await store(db, 'model_error', 'model', base + 2);
  await clearAlerts(db, 'model_error', null, at(base + 3));
  await store(db, 'feature_off', 'gate', base + 4);
  await store(db, 'spend_80', 'global', base - 100);
  await store(db, 'gate_bypass', 'k', base + 7);
  await store(db, 'dismissal_failed', 'acme/shop#128', base + 10);
  await store(db, 'dismissal_failed', 'acme/shop#128', base + 20);
  await store(db, 'spend_limit', 'global', base + 30);
  const id = await recordRun(db, run());
  await markPublished(db, id, { reviewId: '501', publishedAt: at(95), body: 'posted', inlineDropped: false, approved: true, approvalCode: 'approved' });
  assert.equal(await markDismissFailed(db, id, 'github_403'), true);
  const open = await openAlerts(db, dayStart, 50);
  assert.deepEqual(open.map((a) => [a.code, a.raised_at.toISOString()]), [
    ['spend_limit', at(base + 30)], ['dismissal_failed', at(base + 20)], ['feature_off', at(base + 4)], ['memory_error', at(base + 1)],
  ]);
  assert.equal((await openAlerts(db, dayStart, 2)).length, 2);
  assert.equal(await clearDismissFailure(db, id), true);
  assert.deepEqual((await openAlerts(db, dayStart, 50)).map((a) => a.code), ['spend_limit', 'feature_off', 'memory_error']);
  await db.close();
});
test('the recent alerts are those of the last days that are not open, newest first', async () => {
  const db = await testDb();
  const now = 20 * DAY;
  await store(db, 'memory_error', 'memory', now - 100);
  await store(db, 'model_error', 'model', now - 200);
  await clearAlerts(db, 'model_error', null, at(now - 150));
  await store(db, 'gate_bypass', 'k', now - 50);
  await store(db, 'spend_80', 'global', now - DAY);
  await store(db, 'dismissal_failed', 'acme/shop#128', now - 3 * DAY);
  await store(db, 'gate_bypass', 'old', now - 8 * DAY);
  const open = [await idOf(db, 'memory_error', 'memory', now - 100)];
  const recent = await recentAlerts(db, at(now - 7 * DAY), open, 20);
  assert.deepEqual(recent.map((a) => a.code), ['gate_bypass', 'model_error', 'spend_80', 'dismissal_failed']);
  assert.equal((await recentAlerts(db, at(now - 7 * DAY), [], 2)).length, 2);
  assert.deepEqual((await recentAlerts(db, at(now - 7 * DAY), [], 20)).length, 5);
  await db.close();
});
test('pruning keeps what is open, and deletes the rest raised before the time', async () => {
  const db = await testDb();
  const now = 60 * DAY;
  const old = now - 40 * DAY;
  await store(db, 'memory_error', 'memory', old);
  await store(db, 'memory_error', 'cleared', old);
  await clearAlerts(db, 'memory_error', 'cleared', at(old + 5));
  await store(db, 'gate_bypass', 'k', old);
  await store(db, 'dismissal_failed', 'acme/shop#128', old);
  await store(db, 'gate_bypass', 'new', now - DAY);
  const id = await recordRun(db, run());
  await markPublished(db, id, { reviewId: '501', publishedAt: at(95), body: 'posted', inlineDropped: false, approved: true, approvalCode: 'approved' });
  await markDismissFailed(db, id, 'github_403');
  assert.equal(await pruneAlerts(db, at(now - 30 * DAY)), 2);
  assert.deepEqual(
    (await db.query<{ code: string; key: string }>('select code, key from visto_ai.alerts order by id')).map((r) => `${r.code}:${r.key}`),
    ['memory_error:memory', 'dismissal_failed:acme/shop#128', 'gate_bypass:new']);
  await db.close();
});
test("a dependency's state keeps since while its status holds, moves it when the status changes, and an older write changes nothing", async () => {
  const db = await testDb();
  const h = (ok: boolean, code: string | null, seconds: number) => ({ kind: 'mcp' as const, name: 'docs', part: 'server', ok, code, missing: null, at: at(seconds) });
  const view = async () => (await readHealth(db)).map((r) => ({ ...r, since: r.since.toISOString(), seen_at: r.seen_at.toISOString() }));
  await writeHealth(db, h(true, null, 0));
  assert.deepEqual(await view(), [{ kind: 'mcp', name: 'docs', part: 'server', status: 'ok', code: null, missing: null, since: at(0), seen_at: at(0) }]);
  await writeHealth(db, h(true, null, 60));
  assert.deepEqual(await view(), [{ kind: 'mcp', name: 'docs', part: 'server', status: 'ok', code: null, missing: null, since: at(0), seen_at: at(60) }]);
  await writeHealth(db, h(false, 'mcp_timeout', 120));
  const failing = { kind: 'mcp', name: 'docs', part: 'server', status: 'failing', code: 'mcp_timeout', missing: null, since: at(120), seen_at: at(120) };
  assert.deepEqual(await view(), [failing]);
  await writeHealth(db, h(true, null, 90));
  assert.deepEqual(await view(), [failing]);
  const missing = [{ feature: 'gate', missing: 'checks:write' }];
  await writeHealth(db, { kind: 'app', name: 'github', part: 'permissions', ok: false, code: 'missing', missing, at: at(130) });
  const rows = await readHealth(db);
  assert.deepEqual(rows.map((r) => r.kind), ['app', 'mcp']);
  assert.deepEqual(rows[0]!.missing, missing);
  await db.close();
});
