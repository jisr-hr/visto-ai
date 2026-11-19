import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import { hasOkRun, hasRun, lastPublishedRun, listRuns, markPublished, recordRun, spentSince, unpublishedRun } from './review-runs.ts';
import type { RunRecord } from './review-runs.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: true, headSha: 'h1', baseSha: 'b1',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [{ path: 'a.ts', side: 'RIGHT', line: 3, body: 'note' }], result: { findings: [] },
  usage: { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.0375 },
  startedAt: at(0), finishedAt: at(90), ...over,
});
const UNPUBLISHED = { published: false, reviewId: null, publishedAt: null, inlineDropped: false };
test('a run is read back as it was recorded', async () => {
  const db = await testDb();
  const id = await recordRun(db, run());
  assert.deepEqual(await listRuns(db, REF), [{ id, ...run(), ...UNPUBLISHED }]);
  await db.close();
});
test('a failed run keeps its stage and code, and may have no base', async () => {
  const db = await testDb();
  const failed = run({ outcome: 'failed', failureStage: 'prepare', failureCode: 'github_network', baseSha: null, needsHuman: true, highestScore: 100, body: '', comments: [], result: {} });
  const id = await recordRun(db, failed);
  assert.deepEqual(await listRuns(db, REF), [{ id, ...failed, ...UNPUBLISHED }]);
  await db.close();
});
test('a run whose text Postgres would refuse is still recorded', async () => {
  const db = await testDb();
  const NUL = String.fromCharCode(0);
  const HALF = String.fromCharCode(0xd83d);
  await recordRun(db, run({ body: `a${NUL}b`, comments: [{ body: HALF }], result: { findings: [{ body: `x${NUL}y${HALF}` }] } }));
  const [stored] = await listRuns(db, REF);
  assert.equal(stored!.body, 'ab');
  assert.equal(JSON.stringify(stored!.result).includes('\\u0000'), false);
  await db.close();
});
test('hasOkRun finds a finished review of the same head, base and kind, and nothing else', async () => {
  const db = await testDb();
  await recordRun(db, run());
  await recordRun(db, run({ headSha: 'h9', outcome: 'failed', failureStage: 'model', failureCode: 'timeout' }));
  assert.deepEqual(await Promise.all([
    hasOkRun(db, REF, 'h1', 'b1', true), hasOkRun(db, REF, 'h1', 'b2', true), hasOkRun(db, REF, 'h1', 'b1', false),
    hasOkRun(db, REF, 'h9', 'b1', true), hasOkRun(db, { ...REF, number: 8 }, 'h1', 'b1', true),
  ]), [true, false, false, false, false]);
  await db.close();
});
test('hasRun finds a run of that head and kind, whatever its outcome, and nothing else', async () => {
  const db = await testDb();
  await recordRun(db, run({ dryRun: false, outcome: 'failed', failureStage: 'model', failureCode: 'timeout', baseSha: null }));
  assert.deepEqual(await Promise.all([
    hasRun(db, REF, 'h1', false), hasRun(db, REF, 'h2', false), hasRun(db, REF, 'h1', true), hasRun(db, { ...REF, number: 8 }, 'h1', false),
  ]), [true, false, false, false]);
  await recordRun(db, run({ dryRun: true }));
  assert.equal(await hasRun(db, REF, 'h1', true), true);
  await db.close();
});
test('spentSince adds the cost of runs started at or after the time given', async () => {
  const db = await testDb();
  assert.equal(await spentSince(db, at(0)), 0);
  await recordRun(db, run({ startedAt: at(-10), usage: { ...run().usage, cost: 4 } }));
  await recordRun(db, run({ startedAt: at(0), usage: { ...run().usage, cost: 0.5 } }));
  await recordRun(db, run({ startedAt: at(100), usage: { ...run().usage, cost: 0.25 } }));
  assert.equal(await spentSince(db, at(0)), 0.75);
  await db.close();
});
test('token counts are stored as whole numbers, and a count or a cost that is not a number at or above 0 as 0', async () => {
  const db = await testDb();
  await recordRun(db, run({ usage: { calls: 2, inputTokens: 12.5, outputTokens: Number.NaN, cachedTokens: 50, cost: Number.NaN } }));
  await recordRun(db, run({ usage: { ...run().usage, cost: -1 } }));
  const [odd, negative] = await listRuns(db, REF);
  assert.deepEqual([odd!.usage.inputTokens, odd!.usage.outputTokens, odd!.usage.cost, negative!.usage.cost], [13, 0, 0, 0]);
  assert.equal(await spentSince(db, at(0)), 0);
  await db.close();
});
test('a run is recorded unpublished and marked published once', async () => {
  const db = await testDb();
  const id = await recordRun(db, run({ dryRun: false }));
  assert.equal(await markPublished(db, id, { reviewId: '501', publishedAt: at(95), body: 'posted text', inlineDropped: true }), true);
  assert.equal(await markPublished(db, id, { reviewId: '502', publishedAt: at(99), body: 'other', inlineDropped: false }), false);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.published, stored!.reviewId, stored!.publishedAt, stored!.body, stored!.inlineDropped], [true, '501', at(95), 'posted text', true]);
  await db.close();
});
test('unpublishedRun finds the newest finished live review of that head and base that is not published yet', async () => {
  const db = await testDb();
  assert.equal(await unpublishedRun(db, REF, 'h1', 'b1', at(-100)), null);
  await recordRun(db, run({ dryRun: true }));
  await recordRun(db, run({ dryRun: false, outcome: 'failed', failureStage: 'model', failureCode: 'timeout' }));
  await recordRun(db, run({ dryRun: false, headSha: 'h2' }));
  await recordRun(db, run({ dryRun: false, body: '' }));
  await recordRun(db, run({ dryRun: false, startedAt: at(-200) }));
  assert.equal(await unpublishedRun(db, REF, 'h1', 'b1', at(-100)), null);
  const wanted = await recordRun(db, run({ dryRun: false }));
  assert.equal((await unpublishedRun(db, REF, 'h1', 'b1', at(-100)))?.id, wanted);
  await markPublished(db, wanted, { reviewId: '501', publishedAt: at(95), body: 'x', inlineDropped: false });
  assert.equal(await unpublishedRun(db, REF, 'h1', 'b1', at(-100)), null);
  await db.close();
});
test('unpublishedRun does not find a run on another base, and finds one that started exactly at the time given', async () => {
  const db = await testDb();
  await recordRun(db, run({ dryRun: false, baseSha: 'b2' }));
  assert.equal(await unpublishedRun(db, REF, 'h1', 'b1', at(-100)), null);
  const edge = await recordRun(db, run({ dryRun: false, startedAt: at(-100) }));
  assert.equal((await unpublishedRun(db, REF, 'h1', 'b1', at(-100)))?.id, edge);
  await db.close();
});
test('lastPublishedRun is the newest published run of the pull request', async () => {
  const db = await testDb();
  assert.equal(await lastPublishedRun(db, REF), null);
  const a = await recordRun(db, run({ dryRun: false }));
  await recordRun(db, run({ dryRun: false, headSha: 'h2' }));
  await markPublished(db, a, { reviewId: '501', publishedAt: at(95), body: 'x', inlineDropped: false });
  assert.deepEqual([(await lastPublishedRun(db, REF))?.id, (await lastPublishedRun(db, { ...REF, number: 8 }))], [a, null]);
  await db.close();
});
