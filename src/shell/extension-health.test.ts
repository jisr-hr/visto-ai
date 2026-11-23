import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionHealth } from './extension-health.ts';

function setup(throwing = false) {
  const alerts: unknown[][] = [];
  const health = createExtensionHealth((code, details) => {
    alerts.push([code, details]);
    if (throwing) throw new Error('alert');
  });
  return { health, alerts };
}

test('the first failure raises one alert, further failures none, and the first success after it one', () => {
  const { health, alerts } = setup();
  health.noted('tickets', 'context', false, 'timeout');
  assert.deepEqual(alerts, [['extension_error', { extension: 'tickets', part: 'context', reason: 'timeout' }]]);
  health.noted('tickets', 'context', false, 'bad_shape');
  assert.equal(alerts.length, 1);
  health.noted('tickets', 'context', true, 'ok');
  assert.deepEqual(alerts.at(-1), ['extension_ok', { extension: 'tickets', part: 'context' }]);
  health.noted('tickets', 'context', true, 'ok');
  assert.equal(alerts.length, 2);
  health.noted('tickets', 'context', false, 'timeout');
  assert.deepEqual([alerts.length, alerts.at(-1)], [3, ['extension_error', { extension: 'tickets', part: 'context', reason: 'timeout' }]]);
});

test('a part that works from the start raises nothing', () => {
  const { health, alerts } = setup();
  health.noted('chat', 'notify', true, 'ok');
  health.noted('chat', 'notify', true, 'ok');
  assert.deepEqual(alerts, []);
});

test('each module and each part has a state of its own', () => {
  const { health, alerts } = setup();
  health.noted('tickets', 'context', false, 'timeout');
  health.noted('chat', 'notify', false, 'chat_unreachable');
  health.noted('tickets', 'notify', false, 'timeout');
  health.noted('tickets', 'route', true, 'ok');
  assert.deepEqual(alerts, [
    ['extension_error', { extension: 'tickets', part: 'context', reason: 'timeout' }],
    ['extension_error', { extension: 'chat', part: 'notify', reason: 'chat_unreachable' }],
    ['extension_error', { extension: 'tickets', part: 'notify', reason: 'timeout' }],
  ]);
});

test('an alert that throws changes nothing', () => {
  const { health, alerts } = setup(true);
  assert.doesNotThrow(() => health.noted('tickets', 'context', false, 'timeout'));
  health.noted('tickets', 'context', false, 'timeout');
  assert.doesNotThrow(() => health.noted('tickets', 'context', true, 'ok'));
  health.noted('tickets', 'context', true, 'ok');
  assert.deepEqual(alerts.map((a) => a[0]), ['extension_error', 'extension_ok']);
});

test('a reason that is no short code is not passed on', () => {
  const { health, alerts } = setup();
  health.noted('tickets', 'route', false, 'Error at https://tickets.example.test');
  assert.deepEqual(alerts, [['extension_error', { extension: 'tickets', part: 'route', reason: 'internal_error' }]]);
});
