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

test('no more than concurrency cases run at the same time', async () => {
  let running = 0;
  let peak = 0;
  const slow = async (c: number): Promise<{ id: number; total_cost: number }> => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((done) => setTimeout(done, 10));
    running -= 1;
    return { id: c, total_cost: 0 };
  };
  const seen: number[] = [];
  await runPool([1, 2, 3, 4, 5, 6], { concurrency: 2, maxCost: 100 }, slow, (x) => { seen.push(x.id); });
  assert.equal(peak, 2);
  assert.equal(seen.length, 6);
});

test('when one case fails while another is running, the running one is delivered, none starts and the call rejects', async () => {
  const delivered: number[] = [];
  const started: number[] = [];
  const timed = async (c: number): Promise<{ id: number; total_cost: number }> => {
    started.push(c);
    await new Promise((done) => setTimeout(done, c === 1 ? 5 : 40));
    return { id: c, total_cost: 0 };
  };
  await assert.rejects(
    runPool([1, 2, 3, 4], { concurrency: 2, maxCost: 100 }, timed, (x) => { delivered.push(x.id); if (x.id === 1) throw new Error('disk_full'); }),
    /^Error: disk_full$/,
  );
  assert.deepEqual(started.sort(), [1, 2]);
  assert.deepEqual(delivered, [1, 2]);
});
