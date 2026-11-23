import test from 'node:test';
import assert from 'node:assert/strict';
import { sendNotice, type Notifier } from './notify.ts';
import type { ReviewNotice } from '../extensions/types.ts';

const notice = (): ReviewNotice => ({
  run: 41, repository: 'acme/shop', number: 7, title: 'Add the cart', author: 'octo-dev', headSha: 'head111',
  mode: 'full', trigger: 'automatic',
  reviewUrl: 'https://github.com/acme/shop/pull/7#pullrequestreview-501', pullRequestUrl: 'https://github.com/acme/shop/pull/7',
  needsHuman: true, highestScore: 4, findings: { blocker: 0, major: 1, minor: 2 }, body: 'The review.',
});

test('every notifier is called once with the notice, at the same time', async () => {
  const calls: unknown[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const make = (name: string): Notifier => ({
    name,
    async notify(n) {
      calls.push([name, n]);
      if (calls.length === 2) release();
      await gate;
    },
  });
  const outcomes = await sendNotice([make('chat'), make('tickets')], notice());
  assert.deepEqual(calls, [['chat', notice()], ['tickets', notice()]]);
  assert.deepEqual(outcomes, [{ name: 'chat', ok: true, code: 'ok' }, { name: 'tickets', ok: true, code: 'ok' }]);
});

test('a notifier that throws, throws at once or hangs is an outcome with a short code, and the others are still called', async () => {
  const called: string[] = [];
  let hungSignal: AbortSignal | null = null;
  const notifiers: Notifier[] = [
    { name: 'chat', async notify() { called.push('chat'); throw new Error('chat_unreachable'); } },
    { name: 'tickets', async notify() { called.push('tickets'); throw new Error('401 from https://chat.example.test'); } },
    { name: 'sync', notify() { called.push('sync'); throw new Error('Sync failure'); } },
    { name: 'hang', notify(_n, signal) { called.push('hang'); hungSignal = signal; return new Promise<void>(() => {}); } },
    { name: 'example', async notify() { called.push('example'); } },
  ];
  const outcomes = await sendNotice(notifiers, notice(), 5);
  assert.deepEqual(called, ['chat', 'tickets', 'sync', 'hang', 'example']);
  assert.deepEqual(outcomes, [
    { name: 'chat', ok: false, code: 'chat_unreachable' },
    { name: 'tickets', ok: false, code: 'notifier_failed' },
    { name: 'sync', ok: false, code: 'notifier_failed' },
    { name: 'hang', ok: false, code: 'timeout' },
    { name: 'example', ok: true, code: 'ok' },
  ]);
  assert.equal((hungSignal as AbortSignal | null)?.aborted, true);
});

test('a thrown value that is no Error is notifier_failed', async () => {
  const outcomes = await sendNotice([{ name: 'chat', notify() { throw 'chat_unreachable'; } }], notice(), 5);
  assert.deepEqual(outcomes, [{ name: 'chat', ok: false, code: 'notifier_failed' }]);
});

test('a notifier that changes its notice changes nobody else\'s, nor the caller\'s', async () => {
  const given = notice();
  let seen: ReviewNotice | null = null;
  const notifiers: Notifier[] = [
    { name: 'chat', async notify(n) { n.run = 0; n.body = ''; n.findings.major = 99; } },
    { name: 'tickets', async notify(n) { await Promise.resolve(); seen = n; } },
  ];
  await sendNotice(notifiers, given);
  assert.deepEqual(seen, notice());
  assert.deepEqual(given, notice());
});

test('with no notifier nothing is called and nothing is thrown', async () => {
  assert.deepEqual(await sendNotice([], notice()), []);
});
