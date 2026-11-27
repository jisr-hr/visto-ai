import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalCounts, judgeCostPerDay, reviewedRepositories, reviewsPerDay, reviewTotals } from './overview.ts';
import { markPublished, recordJudgeCall, recordRun } from './review-runs.ts';
import type { RunRecord } from './review-runs.ts';
import { testDb } from './testing.ts';
import type { Db } from './types.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const DAY = 86400;
const HEAD = '3f9c2e1a7b04' + 'a'.repeat(28);
const run = (number: number, seconds: number, over: Partial<RunRecord> = {}, repo = 'shop'): RunRecord => ({
  ref: { service: 'github', owner: 'acme', repo, number }, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: HEAD,
  baseSha: 'base-1', baseBranch: 'main', outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 30, body: 'BODY',
  comments: [], result: {}, usage: { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 1 },
  startedAt: at(seconds), finishedAt: at(seconds + 10), ...over,
});
const publish = (db: Db, id: number, approved: boolean, code: string | null = null): Promise<boolean> =>
  markPublished(db, id, { reviewId: `r${id}`, publishedAt: at(0), body: 'BODY', inlineDropped: false, approved, approvalCode: code });

test('the reviews of a window are counted so they add up', async () => {
  const db = await testDb();
  const published = await recordRun(db, run(1, 0));
  await publish(db, published, false);
  await recordRun(db, run(2, 1, { dryRun: true }));
  await recordRun(db, run(3, 2, { outcome: 'failed', failureStage: 'model', failureCode: 'model_error' }));
  await recordRun(db, run(4, 3, { result: { nothingToDo: true } }));
  await recordRun(db, run(5, 4));
  await recordRun(db, run(6, -10 * DAY));
  const t = await reviewTotals(db, at(-DAY));
  assert.deepEqual(t, { total: 5, published: 1, dry_run: 1, failed: 1, nothing_new: 1, not_posted: 1, repositories: 1 });
  assert.equal(t.published + t.dry_run + t.failed + t.nothing_new + t.not_posted, t.total);
});

test('reviews and spend are read per UTC day, the judge calls counted with the runs', async () => {
  const db = await testDb();
  const secondsOf = (iso: string): number => (Date.parse(iso) - Date.parse(at(0))) / 1000;
  await recordRun(db, run(1, secondsOf('2026-03-01T23:59:00.000Z'), { usage: { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 1.5 } }));
  await recordRun(db, run(2, secondsOf('2026-03-02T00:01:00.000Z'), { usage: { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 2 } }));
  await recordJudgeCall(db, { service: 'github', owner: 'acme', repo: 'shop', number: 2 }, 'reply-1', '2026-03-02T00:30:00.000Z',
    { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0.5 });
  const since = '2026-03-01T00:00:00.000Z';
  assert.deepEqual((await reviewsPerDay(db, since)).map((d) => [d.day, d.other, d.cost]), [['2026-03-01', 1, 1.5], ['2026-03-02', 1, 2]]);
  assert.deepEqual(await judgeCostPerDay(db, since), [{ day: '2026-03-02', cost: 0.5 }]);
});

test('approvals and audits are counted by pull request, once each by its newest decision, and a dry run never counts', async () => {
  const db = await testDb();
  await publish(db, await recordRun(db, run(7, 0)), true);
  await publish(db, await recordRun(db, run(7, 1)), true);
  await publish(db, await recordRun(db, run(8, 2)), false, 'audit_sample');
  await publish(db, await recordRun(db, run(9, 3, { dryRun: true })), true);
  await publish(db, await recordRun(db, run(10, 4)), true);
  await publish(db, await recordRun(db, run(10, 5)), false, 'audit_sample');
  assert.deepEqual(await approvalCounts(db, at(-DAY)), { approved: 1, audited: 2 });
});

test('the repositories of the overview are the busiest of the window', async () => {
  const db = await testDb();
  for (let i = 0; i < 21; i++) await recordRun(db, run(1, i, {}, `r${String(i).padStart(2, '0')}`));
  await recordRun(db, run(2, 30, {}, 'zz'));
  await recordRun(db, run(3, 31, {}, 'zz'));
  const names = await reviewedRepositories(db, at(-DAY), 20);
  assert.equal(names.length, 20);
  assert.equal(names[0], 'acme/zz');
  assert.deepEqual(names.slice(1, 3), ['acme/r00', 'acme/r01']);
});
