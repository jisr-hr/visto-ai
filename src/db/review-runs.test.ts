import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import { hasOkRun, listRuns, recordRun, spentSince } from './review-runs.ts';
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
test('a run is read back as it was recorded', async () => {
  const db = await testDb();
  const id = await recordRun(db, run());
  assert.deepEqual(await listRuns(db, REF), [{ id, ...run() }]);
  await db.close();
});
test('a failed run keeps its stage and code, and may have no base', async () => {
  const db = await testDb();
  const failed = run({ outcome: 'failed', failureStage: 'prepare', failureCode: 'github_network', baseSha: null, needsHuman: true, highestScore: 100, body: '', comments: [], result: {} });
  const id = await recordRun(db, failed);
  assert.deepEqual(await listRuns(db, REF), [{ id, ...failed }]);
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
test('spentSince adds the cost of runs started at or after the time given', async () => {
  const db = await testDb();
  assert.equal(await spentSince(db, at(0)), 0);
  await recordRun(db, run({ startedAt: at(-10), usage: { ...run().usage, cost: 4 } }));
  await recordRun(db, run({ startedAt: at(0), usage: { ...run().usage, cost: 0.5 } }));
  await recordRun(db, run({ startedAt: at(100), usage: { ...run().usage, cost: 0.25 } }));
  assert.equal(await spentSince(db, at(0)), 0.75);
  await db.close();
});
