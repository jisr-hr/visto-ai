import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { readHealth, storeAlert } from '../db/status.ts';
import { ALERT_KEEP_MS, MAX_WAITING, SEEN_WRITE_MS, alertKey, createStatusStore } from './status-store.ts';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

function setup(db: Db) {
  let now = 0;
  const logged: Array<Record<string, unknown>> = [];
  const store = createStatusStore({ db, clock: () => at(now), log: (entry) => { logged.push(entry); } });
  return { store, logged, move: (seconds: number) => { now = seconds; } };
}
type Row = { code: string; key: string; details: unknown; raised_at: Date; cleared_at: Date | null };
const alertRows = (db: Db) => db.query<Row>('select code, key, details, raised_at, cleared_at from visto_ai.alerts order by id');
/** A db whose statements go through `gate` first; the gate may reject or hold. */
function gated(db: Db, gate: (text: string) => Promise<void> | void): Db {
  return { ...db, query: async (text, params) => { await gate(text); return db.query(text, params); } } as Db;
}

test('every alert raised is stored but the closers, with its key and only the allowlisted details', async () => {
  const db = await testDb();
  const { store } = setup(db);
  store.alerted('mcp_error', { server: 'docs', reason: 'mcp_timeout', extra: 'x', bad: null });
  store.alerted('mcp_ok', { server: 'docs' });
  store.alerted('model_ok', {});
  store.alerted('gate_bypass', {});
  store.alerted('feature_off', { feature: 'gate', missing: 'checks:write' });
  store.alerted('dismissal_failed', { reason: 'github_403', repo: 'Acme/Shop', number: 128 });
  await store.settled();
  const rows = await alertRows(db);
  assert.deepEqual(rows.map((r) => [r.code, r.key, r.details]), [
    ['mcp_error', 'docs', { server: 'docs', reason: 'mcp_timeout' }],
    ['gate_bypass', '', {}],
    ['feature_off', 'gate:checks:write', { feature: 'gate', missing: 'checks:write' }],
    ['dismissal_failed', 'acme/shop#128', { reason: 'github_403', repo: 'Acme/Shop', number: 128 }],
  ]);
  store.alerted('mcp_error', { server: 'docs', reason: 'mcp_timeout' });
  store.alerted('gate_bypass', { reason: 'x'.repeat(300), spent: Infinity, complete: true });
  await store.settled();
  const after = await alertRows(db);
  assert.equal(after.filter((r) => r.code === 'mcp_error').length, 1);
  assert.deepEqual(after.at(-1)!.details, { reason: 'x'.repeat(200), complete: true });
  assert.equal(alertKey('extension_error', { extension: 'example', part: 'notify' }), 'example/notify');
  assert.equal(alertKey('mcp_error', {}), '');
  assert.equal(alertKey('stale_approval_merged', { repo: 'Acme/Web', number: 7 }), 'acme/web#7');
  await db.close();
});

test('a spend alert is stored once a UTC day', async () => {
  const db = await testDb();
  const { store, move } = setup(db);
  store.alerted('spend_80', { spent: 40, limit: 50 });
  move(60);
  store.alerted('spend_80', { spent: 41, limit: 50 });
  move(2 * 86400);
  store.alerted('spend_80', { spent: 42, limit: 50 });
  await store.settled();
  assert.equal((await alertRows(db)).length, 2);
  await db.close();
});

test('a note that a dependency works clears the open alert of its pair, one a restart forgot included', async () => {
  const db = await testDb();
  const iso = at(-100).toISOString();
  const dedupeSince = '1970-01-01T00:00:00.000Z';
  await storeAlert(db, { code: 'memory_error', key: '', details: {}, at: iso, dedupeSince });
  await storeAlert(db, { code: 'mcp_error', key: 'docs', details: {}, at: iso, dedupeSince });
  await storeAlert(db, { code: 'extension_error', key: 'example/notify', details: {}, at: iso, dedupeSince });
  await storeAlert(db, { code: 'extension_error', key: 'example/route', details: {}, at: iso, dedupeSince });
  const { store, move } = setup(db);
  move(5);
  store.noted({ kind: 'memory', name: '', part: '', ok: true, code: null });
  await store.settled();
  const cleared = async () => (await alertRows(db)).filter((r) => r.cleared_at !== null).map((r) => `${r.code}:${r.key}:${r.cleared_at!.toISOString()}`);
  assert.deepEqual(await cleared(), [`memory_error::${at(5).toISOString()}`]);
  store.noted({ kind: 'mcp', name: 'web', part: '', ok: true, code: null });
  await store.settled();
  assert.equal((await cleared()).length, 1);
  store.noted({ kind: 'mcp', name: 'docs', part: '', ok: true, code: null });
  store.noted({ kind: 'extension', name: 'example', part: 'notify', ok: true, code: null });
  await store.settled();
  assert.deepEqual((await cleared()).map((c) => c.split(':').slice(0, 2).join(':')).sort(), ['extension_error:example/notify', 'mcp_error:docs', 'memory_error:']);
  await db.close();
});

test("a dependency's state is written when it changes, and its sighting at most once a minute", async () => {
  const db = await testDb();
  const { store, move } = setup(db);
  const model = (ok: boolean, code: string | null) => store.noted({ kind: 'model', name: 'vendor/model-a', part: '', ok, code });
  const seen = async () => (await readHealth(db)).map((r) => [r.status, r.code, r.since.toISOString(), r.seen_at.toISOString()]);
  for (const s of [0, 30, 59]) { move(s); model(true, null); }
  await store.settled();
  assert.deepEqual(await seen(), [['ok', null, at(0).toISOString(), at(0).toISOString()]]);
  move(SEEN_WRITE_MS / 1000);
  model(true, null);
  await store.settled();
  assert.deepEqual(await seen(), [['ok', null, at(0).toISOString(), at(60).toISOString()]]);
  move(61);
  model(false, 'auth');
  await store.settled();
  assert.deepEqual(await seen(), [['failing', 'auth', at(61).toISOString(), at(61).toISOString()]]);
  move(62);
  model(false, 'Not A Code');
  await store.settled();
  assert.deepEqual((await seen())[0]!.slice(0, 2), ['failing', 'internal_error']);
  await db.close();
});

test("the app's check writes its state with what it lacks, and clears the feature_off alerts before those still missing are stored again", async () => {
  const db = await testDb();
  const { store, move } = setup(db);
  store.alerted('feature_off', { feature: 'gate', missing: 'checks:write' });
  store.alerted('feature_off', { feature: 'notes', missing: 'pull_requests:write' });
  await store.settled();
  move(10);
  const lacking = [{ feature: 'gate', missing: 'checks:write' }];
  store.appChecked(lacking);
  store.alerted('feature_off', { feature: 'gate', missing: 'checks:write' });
  await store.settled();
  assert.deepEqual((await alertRows(db)).map((r) => [r.key, r.cleared_at === null]),
    [['gate:checks:write', false], ['notes:pull_requests:write', false], ['gate:checks:write', true]]);
  const app = async () => (await readHealth(db)).map((r) => [r.kind, r.status, r.code, r.missing]);
  assert.deepEqual(await app(), [['app', 'failing', 'missing', lacking]]);
  move(20);
  store.appChecked([]);
  await store.settled();
  assert.deepEqual(await app(), [['app', 'ok', null, null]]);
  assert.equal((await alertRows(db)).every((r) => r.cleared_at !== null), true);
  await db.close();
});

test('a write that fails is logged with a short code and changes nothing else, and past 200 waiting writes one is dropped and logged', async () => {
  const db = await testDb();
  const down = setup(gated(db, (text) => { if (text.includes('insert into visto_ai.alerts')) return Promise.reject(new Error('db_down')); }));
  assert.doesNotThrow(() => down.store.alerted('gate_bypass', {}));
  await down.store.settled();
  assert.deepEqual(down.logged, [{ event: 'status_store_failed', what: 'alert', reason: 'db_down' }]);
  assert.equal((await alertRows(db)).length, 0);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  const slow = setup(gated(db, (text) => {
    if (!text.includes('insert into visto_ai.alerts') || !first) return;
    first = false;
    return held;
  }));
  const started = Date.now();
  for (let i = 0; i < MAX_WAITING + 1; i++) slow.store.alerted('gate_bypass', {});
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(slow.logged, [{ event: 'status_store_full', what: 'alert' }]);
  release();
  await slow.store.settled();
  assert.equal((await alertRows(db)).length, MAX_WAITING);
  await db.close();
});

test('a failing health write, clear, prune and clock are each logged and change nothing else', async () => {
  const db = await testDb();
  const broken = setup(gated(db, (text) => { if (/^\s*(insert|update|delete)/i.test(text)) return Promise.reject(new Error('db_down')); }));
  broken.store.noted({ kind: 'mcp', name: 'docs', part: '', ok: true, code: null });
  broken.store.appChecked([]);
  broken.store.prune();
  await broken.store.settled();
  assert.deepEqual(broken.logged.map((e) => [e.what, e.reason]),
    [['health', 'db_down'], ['clear', 'db_down'], ['health', 'db_down'], ['clear', 'db_down'], ['prune', 'db_down']]);
  broken.store.noted({ kind: 'mcp', name: 'docs', part: '', ok: true, code: null });
  await broken.store.settled();
  assert.equal(broken.logged.length, 7, 'a write that failed is told again at the next sighting');
  const logged: Array<Record<string, unknown>> = [];
  const noClock = createStatusStore({ db, clock: () => { throw new Error('clock'); }, log: (e) => { logged.push(e); } });
  assert.doesNotThrow(() => { noClock.alerted('gate_bypass', {}); noClock.noted({ kind: 'model', name: 'm', part: '', ok: true, code: null }); noClock.prune(); noClock.appChecked([]); });
  await noClock.settled();
  assert.equal(logged.length >= 4, true);
  assert.equal(logged.every((e) => e.event === 'status_store_failed'), true);
  assert.equal((await alertRows(db)).length, 0);
  const noLog = createStatusStore({ db: gated(db, () => Promise.reject(new Error('db_down'))), clock: () => at(0), log: () => { throw new Error('log'); } });
  noLog.alerted('gate_bypass', {});
  await assert.doesNotReject(noLog.settled());
  await db.close();
});

test('pruning deletes what is past keeping, queued and not waited for', async () => {
  const db = await testDb();
  const { store, move } = setup(db);
  const old = at(-(ALERT_KEEP_MS / 1000) - 86400).toISOString();
  await storeAlert(db, { code: 'gate_bypass', key: '', details: {}, at: old, dedupeSince: null });
  await storeAlert(db, { code: 'spend_80', key: '', details: {}, at: old, dedupeSince: null });
  await storeAlert(db, { code: 'memory_error', key: '', details: {}, at: old, dedupeSince: null });
  move(0);
  store.prune();
  await store.settled();
  assert.deepEqual((await alertRows(db)).map((r) => r.code), ['memory_error']);
  await db.close();
});

test('a closed store writes nothing more', async () => {
  const db = await testDb();
  const statements: string[] = [];
  const { store, logged } = setup(gated(db, (text) => { statements.push(text); }));
  store.alerted('gate_bypass', {});
  store.close();
  const before = statements.length;
  store.alerted('gate_bypass', {});
  store.noted({ kind: 'model', name: 'm', part: '', ok: true, code: null });
  store.appChecked([]);
  store.prune();
  await store.settled();
  assert.equal((await alertRows(db)).length, 1);
  assert.equal(statements.length - before, 1, 'only the write queued before close ran');
  assert.deepEqual(logged, []);
  assert.equal((await readHealth(db)).length, 0);
  await db.close();
});
