import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryHealth } from './memory-health.ts';

function setup(throwing = false) {
  const alerts: unknown[][] = [];
  const health = createMemoryHealth((code, details) => {
    alerts.push([code, details]);
    if (throwing) throw new Error('alert');
  });
  return { health, alerts };
}

test('the first failure raises one alert, further failures none, and the first success after it one', () => {
  const { health, alerts } = setup();
  health.noted(false, 'timeout');
  health.noted(false, 'timeout');
  health.noted(false, 'lookup_failed');
  health.noted(true, 'ok');
  health.noted(true, 'empty');
  assert.deepEqual(alerts, [['memory_error', { reason: 'timeout' }], ['memory_ok', undefined]]);
  health.noted(false, 'bad_answer');
  assert.deepEqual([alerts.length, alerts.at(-1)], [3, ['memory_error', { reason: 'bad_answer' }]]);
  health.noted(true, 'empty');
  assert.deepEqual([alerts.length, alerts.at(-1)], [4, ['memory_ok', undefined]]);
});

test('memory that works from the start raises nothing', () => {
  const { health, alerts } = setup();
  health.noted(true, 'ok');
  health.noted(true, 'empty');
  health.noted(true, 'ok');
  assert.deepEqual(alerts, []);
});

test('an alert that throws changes nothing, and a reason that is no short code is not passed on', () => {
  const throwing = setup(true);
  assert.doesNotThrow(() => throwing.health.noted(false, 'timeout'));
  throwing.health.noted(false, 'timeout');
  assert.doesNotThrow(() => throwing.health.noted(true, 'ok'));
  throwing.health.noted(true, 'ok');
  assert.deepEqual(throwing.alerts.map((a) => a[0]), ['memory_error', 'memory_ok']);

  for (const code of ['Not A Code', '', 'a'.repeat(41), 5 as unknown as string]) {
    const { health, alerts } = setup();
    health.noted(false, code);
    assert.deepEqual(alerts, [['memory_error', { reason: 'internal_error' }]], String(code));
  }
});

test('an alert that returns a rejected promise leaves no rejection unhandled', async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    const codes: string[] = [];
    const health = createMemoryHealth(((code: string) => { codes.push(code); return Promise.reject(new Error('alert_down')); }) as unknown as Parameters<typeof createMemoryHealth>[0]);
    assert.doesNotThrow(() => health.noted(false, 'timeout'));
    assert.doesNotThrow(() => health.noted(true, 'ok'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([codes, unhandled], [['memory_error', 'memory_ok'], []]);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('the health tells its note of what it was told, every time, and a note that throws changes nothing', () => {
  const alerts: unknown[][] = [];
  const notes: unknown[][] = [];
  const health = createMemoryHealth((code, details) => { alerts.push([code, details]); }, (...args) => { notes.push(args); });
  health.noted(false, 'timeout');
  health.noted(false, 'timeout');
  health.noted(true, 'ok');
  assert.deepEqual(notes, [[false, 'timeout'], [false, 'timeout'], [true, 'ok']]);
  assert.deepEqual(alerts, [['memory_error', { reason: 'timeout' }], ['memory_ok', undefined]]);
  const after: unknown[][] = [];
  const throwing = createMemoryHealth((code) => { after.push([code]); }, () => { throw new Error('note'); });
  assert.doesNotThrow(() => throwing.noted(false, 'timeout'));
  assert.doesNotThrow(() => throwing.noted(true, 'ok'));
  assert.deepEqual(after, [['memory_error'], ['memory_ok']]);
});
