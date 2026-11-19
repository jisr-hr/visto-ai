import assert from 'node:assert/strict';
import test from 'node:test';

import { PACE_MS, RATE_LIMIT_WAIT_MS, pickRedeliveries, runRedelivery } from './redelivery.ts';
import type { HookDelivery, HookDeliveries } from '../forge/types.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const d = (id: string, guid: string, seconds: number, ok: boolean): HookDelivery => ({ id, guid, at: at(seconds), ok });

function harness(listing: { deliveries: HookDelivery[]; complete: boolean } | Error, failures: Record<string, Error[]> = {}) {
  const asked: string[] = [];
  const slept: number[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const hooks: HookDeliveries = {
    listSince: async () => {
      if (listing instanceof Error) throw listing;
      return listing;
    },
    redeliver: async (id) => {
      asked.push(id);
      const next = failures[id]?.shift();
      if (next !== undefined) throw next;
    },
  };
  const deps = { hooks, sleep: async (ms: number) => { slept.push(ms); }, log: (entry: Record<string, unknown>) => { logged.push(entry); } };
  return { deps, asked, slept, logged };
}

test('each delivery that never succeeded is picked once, by its latest attempt, oldest first', () => {
  assert.deepEqual(pickRedeliveries([
    d('5', 'g3', 50, false), d('4', 'g2', 40, true), d('3', 'g2', 30, false), d('2', 'g1', 20, false), d('1', 'g1', 10, false),
  ]), ['2', '5']);
});
test('at most the cap is picked, the oldest', () => {
  assert.deepEqual(pickRedeliveries([d('3', 'g3', 30, false), d('2', 'g2', 20, false), d('1', 'g1', 10, false)], 2), ['1', '2']);
});
test('redeliveries are paced, counted and logged', async () => {
  const h = harness({ deliveries: [d('2', 'g2', 20, false), d('1', 'g1', 10, false)], complete: true });
  assert.deepEqual(await runRedelivery(h.deps, at(0)), { picked: 2, requested: 2, failed: 0, complete: true, code: null });
  assert.deepEqual([h.asked, h.slept], [['1', '2'], [PACE_MS]]);
  assert.deepEqual(h.logged, [{ event: 'redelivery', listed: 2, picked: 2, requested: 2, failed: 0, complete: true, code: null }]);
});
test('a rate limit is waited out once', async () => {
  const h = harness({ deliveries: [d('1', 'g1', 10, false)], complete: true }, { '1': [new Error('github_rate_limited')] });
  assert.deepEqual(await runRedelivery(h.deps, at(0)), { picked: 1, requested: 1, failed: 0, complete: true, code: null });
  assert.deepEqual([h.asked, h.slept], [['1', '1'], [RATE_LIMIT_WAIT_MS]]);
});
test('a second rate limit ends the run, and what was not asked for counts as failed', async () => {
  const limited = [new Error('github_rate_limited'), new Error('github_rate_limited')];
  const h = harness({ deliveries: [d('2', 'g2', 20, false), d('1', 'g1', 10, false)], complete: true }, { '1': limited });
  assert.deepEqual(await runRedelivery(h.deps, at(0)), { picked: 2, requested: 0, failed: 2, complete: true, code: 'github_rate_limited' });
  assert.deepEqual(h.asked, ['1', '1']);
});
test('one delivery that cannot be sent again does not stop the others', async () => {
  const h = harness({ deliveries: [d('2', 'g2', 20, false), d('1', 'g1', 10, false)], complete: true }, { '1': [new Error('github_422')] });
  assert.deepEqual(await runRedelivery(h.deps, at(0)), { picked: 2, requested: 1, failed: 1, complete: true, code: null });
});
test('a listing that fails is logged with its code and nothing is asked for', async () => {
  const h = harness(new Error('github_401'));
  assert.deepEqual(await runRedelivery(h.deps, at(0)), { picked: 0, requested: 0, failed: 0, complete: false, code: 'github_401' });
  assert.deepEqual(h.asked, []);
});
test('deliveries the cap leaves out are counted as failed', async () => {
  const deliveries = Array.from({ length: 201 }, (_, i) => d(String(i + 1), `g${i + 1}`, i, false));
  const h = harness({ deliveries, complete: true });
  assert.deepEqual(await runRedelivery(h.deps, at(0)), { picked: 200, requested: 200, failed: 1, complete: true, code: null });
  assert.equal(h.asked.includes('201'), false);
});
