import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/load.ts';
import type { DeploymentConfig } from '../config/load.ts';
import { markPublished, recordJudgeCall, recordRun } from '../db/review-runs.ts';
import type { RunRecord } from '../db/review-runs.ts';
import { storeAlert, writeHealth } from '../db/status.ts';
import type { HealthKind } from '../db/status.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import type {
  AlertShown, ApprovalShort, DependencyPart, DependencyShown, Health, Measure, Overview, OverviewQuality,
} from './api-types.ts';
import type { InsightDeps, StartedWith } from './insight.ts';
import { COLD_PER_OVERVIEW, QUALITY_ON_OVERVIEW, health, overview } from './overview.ts';
import { createQualityCache, qualityKey } from './quality.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const DAY = 86400;
const HEAD = '3f9c2e1a7b04' + 'a'.repeat(28);
const BASE = 'model:\n  apiKey: { env: K }\n  model: vendor/model-a\n';
const configOf = (yaml = ''): DeploymentConfig => parseConfig(BASE + yaml, { K: 'model-key-for-tests-only', AUDIT: 'audit-key-for-tests-only-'.padEnd(40, 'x') });
const STARTED: StartedWith = { dryRun: false, learning: false, scorer: false, extensions: [], mcpServers: [] };

const run = (repo: string, number: number, seconds: number, over: Partial<RunRecord> = {}): RunRecord => ({
  ref: { service: 'github', owner: 'acme', repo, number }, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: HEAD,
  baseSha: 'base-1', baseBranch: 'main', outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 30, body: 'BODY',
  comments: [], result: {}, usage: { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 1 },
  startedAt: at(seconds), finishedAt: at(seconds + 10), ...over,
});

type Hook = (text: string) => Promise<void> | void;
interface Harness { deps: InsightDeps; hook: { before: Hook | null } }
function harness(inner: Db, over: { config?: DeploymentConfig; started?: StartedWith } = {}): Harness {
  const inForce = over.config ?? configOf();
  const hook: Harness['hook'] = { before: null };
  const db: Db = {
    query: async <Row,>(text: string, params?: unknown[]): Promise<Row[]> => {
      if (hook.before !== null) await hook.before(text);
      return inner.query<Row>(text, params);
    },
    script: (sql) => inner.script(sql), close: () => inner.close(), transaction: (work) => inner.transaction(work),
  };
  const clock = (): Date => new Date(at(0));
  return {
    deps: { db, clock, inForce: () => inForce, started: over.started ?? STARTED, quality: createQualityCache({ clock, log: () => undefined }) },
    hook,
  };
}
const asOverview = (a: Overview | 'bad_request'): Overview => { assert.notEqual(a, 'bad_request'); return a as Overview; };
const query = (days?: string): URLSearchParams => new URLSearchParams(days === undefined ? '' : { days });

test('the overview holds the window\'s reviews, spend against the limit in force, approvals and each day', async () => {
  const db = await testDb();
  const h = harness(db, { config: configOf('limits:\n  spendPerDay: 40\n') });
  const id = await recordRun(db, run('shop', 1, -60, { usage: { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 12 } }));
  await markPublished(db, id, { reviewId: 'r1', publishedAt: at(0), body: 'B', inlineDropped: false, approved: true });
  await recordJudgeCall(db, { service: 'github', owner: 'acme', repo: 'shop', number: 1 }, 'x', at(-30),
    { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0.4 });
  await recordRun(db, run('shop', 2, -2 * DAY, { dryRun: true }));
  const a = asOverview(await overview(h.deps, query('7')));
  assert.equal(a.days, 7);
  assert.deepEqual(a.spend, { today: 12.4, limit: 40 });
  assert.deepEqual(a.reviews, { total: 2, published: 1, dryRun: 1, failed: 0, nothingNew: 0, notPosted: 0 });
  assert.deepEqual(a.approvals, { approved: 1, audited: 0 });
  assert.equal(a.perDay.length, 7);
  assert.equal(a.perDay[0]!.day, '2026-02-23');
  assert.deepEqual(a.perDay[6], { day: '2026-03-01', published: 1, failed: 0, other: 0, cost: 12.4 });
  assert.deepEqual(a.perDay[4], { day: '2026-02-27', published: 0, failed: 0, other: 1, cost: 1 });
  assert.deepEqual(a.perDay[5], { day: '2026-02-28', published: 0, failed: 0, other: 0, cost: 0 });
  assert.equal(a.now, at(0));
});

test('the window must be 7, 30 or 90 days, and an empty one is 30', async () => {
  const h = harness(await testDb());
  assert.equal(asOverview(await overview(h.deps, query(''))).days, 30);
  assert.equal(asOverview(await overview(h.deps, query())).days, 30);
  assert.equal(asOverview(await overview(h.deps, query('7'))).days, 7);
  assert.equal(asOverview(await overview(h.deps, query('90'))).days, 90);
  for (const bad of ['0', '31', 'all', 'abc', '07']) assert.equal(await overview(h.deps, query(bad)), 'bad_request', bad);
});

test('the score quality of each reviewed repository, at most 20, at its threshold and approval in force, at most 2 measured a request', async () => {
  const db = await testDb();
  const config = configOf(
    'repositories:\n  overrides:\n    acme/shop: { score: { threshold: 60 } }\n    acme/web: { score: { autoApprove: true, approvalThreads: gate, auditShare: 10 } }\nauditKey: { env: AUDIT }\n');
  const h = harness(db, { config });
  await recordRun(db, run('shop', 1, -1));
  await recordRun(db, run('shop', 2, -2));
  await recordRun(db, run('web', 1, -3));
  await recordRun(db, run('web', 2, -4));
  for (let i = 0; i < 19; i++) await recordRun(db, run(`r${String(i).padStart(2, '0')}`, 1, -10 - i));
  await recordRun(db, run('zz-last', 1, -100));
  const first = asOverview(await overview(h.deps, query('30')));
  assert.equal(first.repositories, 22);
  assert.equal(first.qualityCut, 22 - QUALITY_ON_OVERVIEW);
  assert.equal(first.quality.length, 20);
  assert.equal(first.quality[0]!.repository, 'acme/shop');
  assert.equal(first.quality.filter((q) => q.state === 'ready').length, COLD_PER_OVERVIEW);
  assert.equal(first.quality.filter((q) => q.state === 'computing').length, 20 - COLD_PER_OVERVIEW);
  for (const q of first.quality.filter((x) => x.state === 'computing')) assert.deepEqual([q.safety, q.benefit, q.focus, q.reverts], [null, null, null, null]);
  const ready = first.quality[0]!;
  assert.equal(ready.threshold, 60);
  assert.ok(ready.safety !== null && ready.benefit !== null && ready.focus !== null);
  assert.deepEqual(ready.reverts, { merged: 0, approved: 0 });
  const second = asOverview(await overview(h.deps, query('30')));
  assert.equal(second.quality.filter((q) => q.state === 'ready').length, 2 * COLD_PER_OVERVIEW);
  const web = second.quality.find((q) => q.repository === 'acme/web')!;
  assert.deepEqual(web.approval, { enabled: true, threads: 'gate', auditShare: 10 });
  assert.deepEqual(second.quality.find((q) => q.repository === 'acme/r00')!.approval, { enabled: false, threads: 'strict', auditShare: 5 });
  assert.ok(h.deps.quality.kept(qualityKey('acme/shop', 30, 60)) !== null);
});

test('a repository whose computation fails is a row failed, and the rest of the overview is answered', async () => {
  const db = await testDb();
  await recordRun(db, run('shop', 1, -1));
  await recordRun(db, run('shop', 2, -2));
  await recordRun(db, run('web', 1, -3));
  const without = asOverview(await overview(harness(db).deps, query('30')));
  const h = harness(db);
  h.hook.before = (text) => { if (text.includes("state in ('merged', 'closed')")) throw new Error('db_down'); };
  const a = asOverview(await overview(h.deps, query('30')));
  assert.equal(a.quality[0]!.state, 'failed');
  const q = a.quality[0]!;
  assert.deepEqual([q.safety, q.benefit, q.focus, q.reverts], [null, null, null, null]);
  assert.deepEqual({ ...a, quality: [] }, { ...without, quality: [] });
});

test('health lists the dependencies the service started with, each with its stored state or none', async () => {
  const db = await testDb();
  const started: StartedWith = {
    dryRun: false, learning: true, scorer: true, mcpServers: ['docs'],
    extensions: [{ name: 'example', parts: ['context', 'notify', 'alert'] }],
  };
  const h = harness(db, { started });
  const put = (kind: HealthKind, name: string, part: string, ok: boolean, code: string | null, seconds: number, missing: unknown = null): Promise<void> =>
    writeHealth(db, { kind, name, part, ok, code, missing, at: at(seconds) });
  await put('model', '', '', true, null, -120);
  await put('mcp', 'docs', '', false, 'mcp_timeout', -300);
  await put('mcp', 'old', '', false, 'mcp_timeout', -300);
  await put('extension', 'example', 'notify', false, 'ext_timeout', -200);
  const a = await health(h.deps);
  assert.deepEqual(a.dependencies.map((d) => [d.kind, d.name, d.status]), [
    ['model', null, 'working'], ['scorer', null, 'unknown'], ['memory', null, 'unknown'], ['extension', 'example', 'failing'], ['mcp', 'docs', 'failing'], ['app', null, 'unknown'],
  ]);
  assert.equal(a.dependencies[0]!.model, 'vendor/model-a');
  assert.equal(a.dependencies[0]!.since, at(-120));
  assert.deepEqual(a.dependencies[1], { kind: 'scorer', name: null, model: null, status: 'unknown', code: null, since: null, seenAt: null, parts: [], missing: [] });
  assert.deepEqual(a.dependencies[3]!.parts, [
    { part: 'context', status: 'unknown', code: null, since: null }, { part: 'notify', status: 'failing', code: 'ext_timeout', since: at(-200) },
    { part: 'alert', status: 'unknown', code: null, since: null },
  ]);
  assert.equal(a.dependencies[3]!.code, 'ext_timeout');
  assert.equal(a.dependencies[4]!.code, 'mcp_timeout');
  const off = harness(db, { started: { ...started, learning: false } });
  assert.ok(!(await health(off.deps)).dependencies.some((d) => d.kind === 'memory'));
  await put('app', '', '', false, 'missing', -60, [{ feature: 'capture', missing: 'event:pull_request_review' }, { feature: 5, missing: 'x' }, 'nope']);
  assert.deepEqual((await health(h.deps)).dependencies.at(-1)!.missing, [{ feature: 'capture', missing: 'event:pull_request_review' }]);
});

test('the open and recent alerts carry only the allowlisted details', async () => {
  const db = await testDb();
  const h = harness(db);
  await storeAlert(db, { code: 'mcp_error', key: 'docs', details: { server: 'docs', reason: 'mcp_timeout', login: 'octo-guest' }, at: at(-100), dedupeSince: null });
  await storeAlert(db, { code: 'spend_80', key: '', details: { spent: 40.2, limit: 50 }, at: at(-2 * DAY), dedupeSince: null });
  const a = await health(h.deps);
  assert.equal(a.open.length, 1);
  assert.deepEqual(a.open[0]!.details, { server: 'docs', reason: 'mcp_timeout' });
  assert.equal(a.open[0]!.open, true);
  assert.deepEqual(a.recent.map((r) => [r.code, r.open, r.details]), [['spend_80', false, { spent: 40.2, limit: 50 }]]);
  assert.ok(!JSON.stringify(a).includes('octo-guest'));
});

test('an answer holds no field the screens do not show', async () => {
  const db = await testDb();
  const h = harness(db, { started: { ...STARTED, extensions: [{ name: 'example', parts: ['context'] }], mcpServers: ['docs'] } });
  await recordRun(db, run('shop', 1, -1));
  await writeHealth(db, { kind: 'app', name: '', part: '', ok: false, code: 'missing', missing: [{ feature: 'capture', missing: 'x', secret: 'S' }], at: at(-5) });
  await storeAlert(db, { code: 'model_error', key: '', details: { reason: 'x' }, at: at(-5), dedupeSince: null });
  await storeAlert(db, { code: 'spend_80', key: '', details: { spent: 1 }, at: at(-2 * DAY), dedupeSince: null });
  const o = asOverview(await overview(h.deps, query('30')));
  const ready = o.quality[0]!;
  assert.equal(ready.state, 'ready');
  const hl = await health(h.deps);
  const keys = (x: object): string[] => Object.keys(x).sort();
  const of = (m: Record<string, true>): string[] => Object.keys(m).sort();
  const overviewKeys: Record<keyof Overview, true> = { now: true, days: true, repositories: true, reviews: true, spend: true, approvals: true, perDay: true, quality: true, qualityCut: true };
  const qualityKeys: Record<keyof OverviewQuality, true> = { repository: true, threshold: true, state: true, safety: true, benefit: true, focus: true, reverts: true, approval: true };
  const measureKeys: Record<keyof Measure, true> = { share: true, part: true, of: true };
  const approvalKeys: Record<keyof ApprovalShort, true> = { enabled: true, threads: true, auditShare: true };
  const healthKeys: Record<keyof Health, true> = { now: true, dependencies: true, open: true, recent: true };
  const depKeys: Record<keyof DependencyShown, true> = { kind: true, name: true, model: true, status: true, code: true, since: true, seenAt: true, parts: true, missing: true };
  const partKeys: Record<keyof DependencyPart, true> = { part: true, status: true, code: true, since: true };
  const alertKeys: Record<keyof AlertShown, true> = { id: true, code: true, details: true, raisedAt: true, open: true };
  assert.deepEqual(keys(o), of(overviewKeys));
  assert.deepEqual(keys(ready), of(qualityKeys));
  assert.deepEqual(keys(ready.safety!), of(measureKeys));
  assert.deepEqual(keys(ready.approval), of(approvalKeys));
  assert.deepEqual(keys(hl), of(healthKeys));
  for (const d of hl.dependencies) assert.deepEqual(keys(d), of(depKeys));
  for (const p of hl.dependencies.find((d) => d.kind === 'extension')!.parts) assert.deepEqual(keys(p), of(partKeys));
  for (const x of [...hl.open, ...hl.recent]) assert.deepEqual(keys(x), of(alertKeys));
  assert.deepEqual(hl.dependencies.at(-1)!.missing, [{ feature: 'capture', missing: 'x' }]);
  assert.ok(hl.open.length === 1 && hl.recent.length === 1);
  for (const answer of [o, hl]) assert.ok(!JSON.stringify(answer).includes('model-key-for-tests-only'));
});
