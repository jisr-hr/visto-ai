import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { MAX_ID_CHARS } from './events.ts';
import { createGithubWebhookReader } from './webhook.ts';

const secret = 'hook-secret-value';
const reader = createGithubWebhookReader(secret);
const sign = (body: Buffer, key = secret) => 'sha256=' + createHmac('sha256', key).update(body).digest('hex');
const headers = (body: Buffer, over: Record<string, string | undefined> = {}) =>
  ({ 'x-github-event': 'ping', 'x-github-delivery': 'd-1', 'x-hub-signature-256': sign(body), ...over });
const bad = { ok: false, reason: 'bad_signature' };

test('a signed ping is read', () => {
  const body = Buffer.from('{"zen":"x"}');
  assert.deepEqual(reader.read(headers(body), body), { ok: true, delivery: 'd-1', name: 'ping', action: null, event: { kind: 'ping' } });
});

test('a bad signature is bad_signature in every form', () => {
  const body = Buffer.from('{"zen":"x"}');
  const good = sign(body);
  const other = Buffer.from('{"zen":"y"}');
  const nonAscii = good.slice(0, -1) + String.fromCharCode(233);
  const cases: Record<string, string | undefined> = {
    missing: undefined,
    empty: '',
    'another length': good.slice(0, -2),
    'another secret': sign(body, 'other-secret'),
    'another body': sign(other),
    sha1: 'sha1=' + good.slice('sha256='.length),
    'non-ascii': nonAscii,
  };
  assert.equal(nonAscii.length, good.length);
  for (const [name, value] of Object.entries(cases)) {
    assert.deepEqual(reader.read(headers(body, { 'x-hub-signature-256': value }), body), bad, name);
  }
});

test('the signature is checked before anything else', () => {
  const body = Buffer.from('a=1&b=2');
  assert.deepEqual(reader.read(headers(body, { 'x-hub-signature-256': 'sha256=00', 'x-github-delivery': undefined }), body), bad);
});

test('a signed body that is not JSON is not_json', () => {
  const body = Buffer.from('a=1&b=2');
  assert.deepEqual(reader.read(headers(body), body), { ok: false, reason: 'not_json' });
});

test('a missing or empty delivery id or event name', () => {
  const body = Buffer.from('{"zen":"x"}');
  for (const v of [undefined, '']) {
    assert.deepEqual(reader.read(headers(body, { 'x-github-delivery': v }), body), { ok: false, reason: 'no_delivery_id' });
    assert.deepEqual(reader.read(headers(body, { 'x-github-event': v }), body), { ok: false, reason: 'no_event_name' });
  }
});

test('an issue_comment gives its action and event; a numeric action gives null', () => {
  const payload = (action: unknown) => ({
    action, repository: { name: 'shop', owner: { login: 'acme' } }, issue: { number: 7, pull_request: {} },
    comment: { id: 31, user: { login: 'octo-dev', type: 'User' }, author_association: 'OWNER', created_at: '2026-03-01T10:00:00Z', body: 'hello' },
  });
  const body = Buffer.from(JSON.stringify(payload('created')));
  const read = reader.read(headers(body, { 'x-github-event': 'issue_comment' }), body);
  assert.ok(read.ok);
  assert.equal(read.action, 'created');
  assert.equal(read.event.kind, 'general_comment');
  const num = Buffer.from(JSON.stringify(payload(5)));
  const readNum = reader.read(headers(num, { 'x-github-event': 'issue_comment' }), num);
  assert.ok(readNum.ok);
  assert.equal(readNum.action, null);
});

test('an empty secret is refused', () => {
  assert.throws(() => createGithubWebhookReader(''), { message: 'empty_webhook_secret' });
});

test('a delivery id longer than MAX_ID_CHARS is no_delivery_id', () => {
  const body = Buffer.from('{"zen":"x"}');
  assert.deepEqual(reader.read(headers(body, { 'x-github-delivery': 'd'.repeat(MAX_ID_CHARS + 1) }), body), { ok: false, reason: 'no_delivery_id' });
  const got = reader.read(headers(body, { 'x-github-delivery': 'd'.repeat(MAX_ID_CHARS) }), body);
  assert.equal(got.ok && got.delivery, 'd'.repeat(MAX_ID_CHARS));
});
