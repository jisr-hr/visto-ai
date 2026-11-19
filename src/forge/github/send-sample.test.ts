import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubWebhookReader } from './webhook.ts';
import { isLocalUrl, sampleWebhook } from './send-sample.ts';
import type { SampleKind } from './send-sample.ts';

const KINDS: Array<[SampleKind, string]> = [['pull_request', 'pull_request'], ['review', 'review'], ['comment', 'general_comment']];

for (const [kind, expected] of KINDS) {
  test(`the ${kind} sample is read as ${expected}`, () => {
    const { headers, body } = sampleWebhook(kind, 'a-secret', 'd-1');
    const reading = createGithubWebhookReader('a-secret').read(headers, Buffer.from(body));
    assert.ok(reading.ok);
    assert.equal(reading.delivery, 'd-1');
    assert.equal(reading.event.kind, expected);
  });

  test(`the ${kind} sample read with another secret is a bad signature`, () => {
    const { headers, body } = sampleWebhook(kind, 'a-secret', 'd-1');
    assert.deepEqual(createGithubWebhookReader('other-secret').read(headers, Buffer.from(body)), { ok: false, reason: 'bad_signature' });
  });

  test(`the ${kind} sample names only invented things`, () => {
    const { headers, body } = sampleWebhook(kind, 'a-secret', 'd-1');
    const reading = createGithubWebhookReader('a-secret').read(headers, Buffer.from(body));
    assert.ok(reading.ok);
    const ev = reading.event;
    assert.ok(ev.kind === 'pull_request' ? ev.facts.ref.owner === 'acme' && ev.facts.ref.repo === 'shop' && ev.facts.ref.number === 7
      : 'ref' in ev && ev.ref.owner === 'acme' && ev.ref.repo === 'shop' && ev.ref.number === 7);
  });
}

test('isLocalUrl accepts only plain http to this machine', () => {
  for (const url of ['http://localhost:8080/x', 'http://127.0.0.1:8080/x', 'http://[::1]:8080/x']) assert.equal(isLocalUrl(url), true, url);
  for (const url of ['https://example.com/x', 'http://localhost.example.com/x', 'http://localhost@example.com/x', 'http://user:pw@localhost/x', 'ftp://localhost/x', 'not a url']) {
    assert.equal(isLocalUrl(url), false, url);
  }
});

test('a pull request sample can carry another action and another head', () => {
  const { body } = sampleWebhook('pull_request', 's', 'd1', { action: 'synchronize', head: 'def456' });
  const payload = JSON.parse(body) as { action: string; pull_request: { head: { sha: string } } };
  assert.deepEqual([payload.action, payload.pull_request.head.sha], ['synchronize', 'def456']);
});

test('a comment sample can carry another body, and names an installation', () => {
  const { headers, body } = sampleWebhook('comment', 's', 'd1', { body: '/review' });
  const payload = JSON.parse(body) as { comment: { body: string }; installation: { id: number } };
  assert.deepEqual([payload.comment.body, payload.installation.id], ['/review', 99]);
  const reading = createGithubWebhookReader('s').read(headers, Buffer.from(body));
  assert.ok(reading.ok && reading.event.kind === 'general_comment' && reading.event.comment.body ==='/review' && reading.event.installation === '99');
});
