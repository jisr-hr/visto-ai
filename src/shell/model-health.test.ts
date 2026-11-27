import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkModelKey, createModelHealth } from './model-health.ts';
import type { KeyCheck, ModelHealth } from './model-health.ts';

const t = (seconds: number): Date => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000);

let alerts: Array<[string, Record<string, unknown>]>;
let health: ModelHealth;
beforeEach(() => {
  alerts = [];
  health = createModelHealth((code, details) => { alerts.push([code, details ?? {}]); });
});

test('the key check asks the key route of the model endpoint, with the extra headers and the key as a bearer token', async () => {
  const calls: Array<{ url: string; authorization: string | null; team: string | null }> = [];
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get('authorization'), team: headers.get('x-team') });
    return new Response('{"data":{"limit_remaining":12.5}}');
  };
  const model = { baseUrl: 'https://models.example.test/v1/', apiKey: 'k', extraHeaders: { 'x-team': 'a', Authorization: 'Bearer other' } };
  assert.equal(await checkModelKey(model, { fetch: stub as typeof fetch }), 'ok');
  assert.deepEqual(calls, [{ url: 'https://models.example.test/v1/key', authorization: 'Bearer k', team: 'a' }]);
});
test('what each answer of the key route means', async () => {
  const cases: Array<[Response | Error, KeyCheck]> = [
    [new Response('', { status: 401 }), 'auth'], [new Response('', { status: 402 }), 'no_credit'],
    [new Response('{"data":{"limit_remaining":0}}'), 'no_credit'], [new Response('{"data":{"limit_remaining":null}}'), 'ok'],
    [new Response('not json'), 'ok'], [new Response('', { status: 404 }), 'unknown'], [new Response('', { status: 500 }), 'unknown'],
    [new Error('down'), 'unknown'],
  ];
  for (const [answer, expected] of cases) {
    const stub = async (): Promise<Response> => { if (answer instanceof Error) throw answer; return answer; };
    assert.equal(await checkModelKey({ baseUrl: 'https://models.example.test/v1', apiKey: 'k', extraHeaders: {} }, { fetch: stub as typeof fetch }), expected);
  }
});
test('a review that meets a rejected key pauses reviews for five minutes and raises one alert', () => {
  health.reviewed('auth', t(0));
  assert.deepEqual([health.paused(t(299)), health.paused(t(300))], [true, false]);
  health.reviewed('auth', t(300));
  assert.deepEqual([health.paused(t(599)), alerts], [true, [['model_error', { reason: 'auth', seen_by: 'review' }]]]);
});
test('a key check that says the key is refused starts a pause once and never extends it', () => {
  health.checked('auth', t(0));
  health.checked('auth', t(200));
  assert.deepEqual([health.paused(t(299)), health.paused(t(300)), alerts], [true, false, [['model_error', { reason: 'auth', seen_by: 'check' }]]]);
});
test('a key check that passes lifts a pause a check caused, and not one a review caused', () => {
  health.checked('no_credit', t(0));
  health.checked('ok', t(60));
  assert.deepEqual([health.paused(t(61)), alerts.map((a) => a[0])], [false, ['model_error', 'model_ok']]);
  health.reviewed('no_credit', t(100));
  health.checked('ok', t(160));
  assert.equal(health.paused(t(161)), true);
});
test('a review the model answered lifts the pause and says so once', () => {
  health.reviewed('no_credit', t(0));
  health.reviewed(null, t(300));
  health.reviewed(null, t(400));
  assert.deepEqual([health.paused(t(301)), alerts.map((a) => a[0])], [false, ['model_error', 'model_ok']]);
});
test('a check that a review proves wrong is ignored from then on', () => {
  health.checked('auth', t(0));
  health.reviewed(null, t(300));
  health.checked('auth', t(600));
  assert.deepEqual([health.paused(t(601)), alerts.map((a) => a[0])], [false, ['model_error', 'model_ok']]);
});
test('a check that says nothing changes nothing', () => {
  health.checked('unknown', t(0));
  assert.deepEqual([health.paused(t(1)), alerts], [false, []]);
  health.reviewed('auth', t(0));
  health.checked('unknown', t(10));
  assert.equal(health.paused(t(11)), true);
});
test('a different failure is a new alert', () => {
  health.reviewed('auth', t(0));
  health.reviewed('no_credit', t(10));
  assert.deepEqual(alerts.map((a) => (a[1] as { reason: string }).reason), ['auth', 'no_credit']);
});
test('the model health tells its note of its state after each check and review, and a check that says nothing tells nothing', () => {
  const notes: Array<[boolean, string | null]> = [];
  const h = createModelHealth(() => {}, (ok, code) => { notes.push([ok, code]); });
  h.checked('auth', t(0));
  h.checked('unknown', t(1));
  h.checked('ok', t(2));
  assert.deepEqual(notes, [[false, 'auth'], [true, null]]);
  notes.length = 0;
  h.reviewed('no_credit', t(10));
  h.checked('ok', t(11));
  h.reviewed(null, t(12));
  assert.deepEqual(notes, [[false, 'no_credit'], [false, 'no_credit'], [true, null]]);
  const throwing = createModelHealth((code, details) => { alerts.push([code, details ?? {}]); }, () => { throw new Error('note'); });
  assert.doesNotThrow(() => throwing.reviewed('auth', t(0)));
  assert.equal(throwing.paused(t(1)), true);
  assert.doesNotThrow(() => throwing.checked('ok', t(2)));
  assert.doesNotThrow(() => throwing.reviewed(null, t(3)));
  assert.deepEqual(alerts.map((a) => a[0]), ['model_error', 'model_ok']);
});
