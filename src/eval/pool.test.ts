import assert from 'node:assert/strict';
import test from 'node:test';
import { runPool } from './pool.ts';

const work = (c: number): Promise<{ id: number; total_cost: number }> => Promise.resolve({ id: c, total_cost: 0.5 });

test('every result arrives through onResult with its index', async () => {
  const seen: [number, number][] = [];
  const r = await runPool([10, 11, 12], { concurrency: 2, maxCost: 100 }, work, (x, i) => { seen.push([x.id, i]); });
  assert.deepEqual(seen.sort((a, b) => a[1] - b[1]), [[10, 0], [11, 1], [12, 2]]);
  assert.deepEqual(r, { stoppedByCost: false, notStarted: 0 });
});

test('no case starts once the spend reaches maxCost, and the rest are counted', async () => {
  const seen: number[] = [];
  const r = await runPool([1, 2, 3, 4], { concurrency: 1, maxCost: 1 }, work, (x) => { seen.push(x.id); });
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(r, { stoppedByCost: true, notStarted: 2 });
});

test('a throw from onResult stops new cases and rejects', async () => {
  const seen: number[] = [];
  await assert.rejects(runPool([1, 2, 3], { concurrency: 1, maxCost: 100 }, work, (x) => { seen.push(x.id); throw new Error('disk_full'); }), /disk_full/);
  assert.deepEqual(seen, [1]);
});
