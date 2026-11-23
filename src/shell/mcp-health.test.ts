import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHealth } from './mcp-health.ts';

function setup(throwing = false) {
  const alerts: unknown[][] = [];
  const health = createMcpHealth((code, details) => {
    alerts.push([code, details]);
    if (throwing) throw new Error('alert');
  });
  return { health, alerts };
}

test('the first failure raises one alert, further failures none, and the first success after it one', () => {
  const { health, alerts } = setup();
  health.noted('docs', false, 'open_http_401');
  health.noted('docs', false, 'open_http_401');
  health.noted('docs', true, 'ok');
  health.noted('docs', true, 'ok');
  assert.deepEqual(alerts, [['mcp_error', { server: 'docs', reason: 'open_http_401' }], ['mcp_ok', { server: 'docs' }]]);
  health.noted('docs', false, 'call_timeout');
  assert.deepEqual([alerts.length, alerts.at(-1)], [3, ['mcp_error', { server: 'docs', reason: 'call_timeout' }]]);
});

test('a server that works from the start raises nothing, and each server has a state of its own', () => {
  const { health, alerts } = setup();
  health.noted('docs', true, 'ok');
  health.noted('docs', true, 'ok');
  assert.deepEqual(alerts, []);
  health.noted('wiki', false, 'tool_not_listed');
  health.noted('docs', true, 'ok');
  health.noted('docs', false, 'call_timeout');
  health.noted('wiki', false, 'tool_not_listed');
  assert.deepEqual(alerts, [
    ['mcp_error', { server: 'wiki', reason: 'tool_not_listed' }],
    ['mcp_error', { server: 'docs', reason: 'call_timeout' }],
  ]);
  health.noted('wiki', true, 'ok');
  assert.deepEqual(alerts.at(-1), ['mcp_ok', { server: 'wiki' }]);
});

test('an alert that throws changes nothing, and a reason that is no short code is not passed on', () => {
  const throwing = setup(true);
  assert.doesNotThrow(() => throwing.health.noted('docs', false, 'open_http_401'));
  throwing.health.noted('docs', false, 'open_http_401');
  assert.doesNotThrow(() => throwing.health.noted('docs', true, 'ok'));
  throwing.health.noted('docs', true, 'ok');
  assert.deepEqual(throwing.alerts.map((a) => a[0]), ['mcp_error', 'mcp_ok']);

  const { health, alerts } = setup();
  health.noted('docs', false, 'Not A Code');
  assert.deepEqual(alerts, [['mcp_error', { server: 'docs', reason: 'internal_error' }]]);
});
