import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_TIMEOUT_MS, createAlerts } from './alerts.ts';
import type { AlertNotice } from '../extensions/types.ts';

type Sink = { name: string; alert(notice: AlertNotice, signal: AbortSignal): Promise<void> };

function setup(webhook: string | null, answer: Response | Error, log?: (entry: Record<string, unknown>) => void, sinks?: { sinks: Sink[]; sinkTimeoutMs?: number }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const logged: Array<Record<string, unknown>> = [];
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const { alert, settled } = createAlerts({
    webhook, fetch: stub as typeof fetch, clock: () => new Date('2026-03-01T10:00:00.000Z'),
    log: log ?? ((entry) => { logged.push(entry); }),
    ...sinks,
  });
  return { alert, settled, calls, logged };
}

test('an alert is logged, and posted as JSON when a webhook is set', async () => {
  const h = setup('https://alerts.example.test/in', new Response('', { status: 200 }));
  h.alert('spend_limit', { spent: 50.25, limit: 50 });
  await h.settled();
  assert.deepEqual(h.logged, [{ event: 'alert', code: 'spend_limit', spent: 50.25, limit: 50 }]);
  assert.deepEqual([h.calls[0]!.url, h.calls[0]!.init.method, JSON.parse(String(h.calls[0]!.init.body))], [
    'https://alerts.example.test/in', 'POST',
    { source: 'visto-ai', code: 'spend_limit', at: '2026-03-01T10:00:00.000Z', details: { spent: 50.25, limit: 50 } },
  ]);
});
test('an alert that names a reason keeps its own code in the log', async () => {
  const h = setup(null, new Response(''));
  h.alert('model_error', { reason: 'auth', seen_by: 'review' });
  await h.settled();
  assert.deepEqual(h.logged, [{ event: 'alert', code: 'model_error', reason: 'auth', seen_by: 'review' }]);
});
test('with no webhook an alert is a log line only', async () => {
  const h = setup(null, new Response(''));
  h.alert('model_ok');
  await h.settled();
  assert.deepEqual([h.logged, h.calls.length], [[{ event: 'alert', code: 'model_ok' }], 0]);
});
test('a webhook that refuses or cannot be reached is logged without its address, and nothing is thrown', async () => {
  for (const [answer, status] of [[new Response('', { status: 500 }), 500], [new Error('down'), null]] as const) {
    const h = setup('https://alerts.example.test/in', answer);
    h.alert('model_error', { reason: 'auth' });
    await h.settled();
    assert.deepEqual(h.logged.at(-1), { event: 'alert_failed', code: 'model_error', status });
    assert.equal(JSON.stringify(h.logged).includes('alerts.example.test'), false);
  }
});
test('a logger that throws stops neither the post nor the caller', async () => {
  const h = setup('https://alerts.example.test/in', new Response(''), () => { throw new Error('log'); });
  h.alert('model_ok');
  await h.settled();
  assert.equal(h.calls.length, 1);
});

test('with no sink an alert is what it was', async () => {
  const h = setup('https://alerts.example.test/in', new Response('', { status: 200 }));
  h.alert('spend_80', { spent: 40 });
  await h.settled();
  assert.deepEqual(h.logged, [{ event: 'alert', code: 'spend_80', spent: 40 }]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual([h.calls[0]!.url, h.calls[0]!.init.method, h.calls[0]!.init.headers, h.calls[0]!.init.redirect, JSON.parse(String(h.calls[0]!.init.body))], [
    'https://alerts.example.test/in', 'POST', { 'Content-Type': 'application/json' }, 'manual',
    { source: 'visto-ai', code: 'spend_80', at: '2026-03-01T10:00:00.000Z', details: { spent: 40 } },
  ]);
  assert.ok(h.calls[0]!.init.signal instanceof AbortSignal);
});

test('an alert goes to every sink, beside the webhook, with its code, its time and its details', async () => {
  const calls: unknown[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let done = 0;
  const sink = (name: string): Sink => ({ name, async alert(notice) { calls.push([name, notice]); await gate; done += 1; } });
  const h = setup('https://alerts.example.test/in', new Response('', { status: 200 }), undefined, { sinks: [sink('pager'), sink('chat')] });
  h.alert('spend_80', { spent: 40 });
  const settled = h.settled();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, 0);
  release();
  await settled;
  assert.equal(done, 2);
  const told = { code: 'spend_80', at: '2026-03-01T10:00:00.000Z', details: { spent: 40 } };
  assert.deepEqual(calls, [['pager', told], ['chat', told]]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.logged, [{ event: 'alert', code: 'spend_80', spent: 40 }]);
});

test('each sink gets its own copy of the alert', async () => {
  let seen: AlertNotice | null = null;
  const h = setup(null, new Response(''), undefined, { sinks: [
    { name: 'pager', async alert(notice) { notice.code = 'changed'; notice.details.spent = 0; } },
    { name: 'chat', async alert(notice) { await Promise.resolve(); seen = notice; } },
  ] });
  h.alert('spend_80', { spent: 40 });
  await h.settled();
  assert.deepEqual(seen, { code: 'spend_80', at: '2026-03-01T10:00:00.000Z', details: { spent: 40 } });
});

test('a sink that throws or hangs is logged with its name, stops nothing and raises nothing', async () => {
  const told: string[] = [];
  const h = setup('https://alerts.example.test/in', new Response('', { status: 200 }), undefined, { sinks: [
    { name: 'pager', async alert() { throw new Error('pager_down'); } },
    { name: 'sync', alert() { throw new Error('at once'); } },
    { name: 'chat', async alert(notice) { told.push(notice.code); } },
  ] });
  assert.doesNotThrow(() => h.alert('spend_80'));
  await h.settled();
  assert.deepEqual(told, ['spend_80']);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.logged, [
    { event: 'alert', code: 'spend_80' },
    { event: 'alert_failed', code: 'spend_80', extension: 'pager', reason: 'threw' },
    { event: 'alert_failed', code: 'spend_80', extension: 'sync', reason: 'threw' },
  ]);

  let hungSignal: AbortSignal | null = null;
  const hung = setup(null, new Response(''), undefined, { sinkTimeoutMs: 5, sinks: [
    { name: 'pager', alert(_notice, signal) { hungSignal = signal; return new Promise<void>(() => {}); } },
  ] });
  hung.alert('spend_80');
  await hung.settled();
  assert.deepEqual(hung.logged, [
    { event: 'alert', code: 'spend_80' },
    { event: 'alert_failed', code: 'spend_80', extension: 'pager', reason: 'timeout' },
  ]);
  assert.equal((hungSignal as AbortSignal | null)?.aborted, true);
});

test('no sink is called when the alert has no webhook and no sinks list', async () => {
  const h = setup(null, new Response(''), undefined, { sinks: [] });
  h.alert('model_ok');
  await h.settled();
  assert.deepEqual([h.logged, h.calls.length], [[{ event: 'alert', code: 'model_ok' }], 0]);
});

test('the time of an alert is read once, and the sinks get the time the webhook gets', async () => {
  let reads = 0;
  const posted: string[] = [];
  const told: string[] = [];
  const { alert, settled } = createAlerts({
    webhook: 'https://alerts.example.test/in',
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => { posted.push(JSON.parse(String(init?.body)).at); return new Response(''); }) as typeof fetch,
    clock: () => { reads += 1; return new Date(Date.UTC(2026, 2, 1, 10, 0, reads)); },
    log: () => {},
    sinks: [{ name: 'pager', async alert(notice) { told.push(notice.at); } }],
  });
  alert('spend_80');
  await settled();
  assert.deepEqual([reads, posted, told], [1, ['2026-03-01T10:00:01.000Z'], ['2026-03-01T10:00:01.000Z']]);
});

test('a clock that throws is a failed post, as before, and no sink is told', async () => {
  const logged: Array<Record<string, unknown>> = [];
  let told = 0;
  const { alert, settled } = createAlerts({
    webhook: 'https://alerts.example.test/in', fetch: (async () => new Response('')) as typeof fetch,
    clock: () => { throw new Error('clock'); }, log: (e) => { logged.push(e); },
    sinks: [{ name: 'pager', async alert() { told += 1; } }],
  });
  alert('spend_80');
  await settled();
  assert.deepEqual([logged, told], [[{ event: 'alert', code: 'spend_80' }, { event: 'alert_failed', code: 'spend_80', status: null }], 0]);
});

test('a sink that settles after its limit is logged once', async () => {
  const finish: Array<() => void> = [];
  const h = setup(null, new Response(''), undefined, { sinkTimeoutMs: 5, sinks: [
    { name: 'pager', alert() { return new Promise<void>((_resolve, reject) => { finish.push(() => reject(new Error('late'))); }); } },
    { name: 'chat', alert() { return new Promise<void>((resolve) => { finish.push(resolve); }); } },
  ] });
  h.alert('spend_80');
  await h.settled();
  for (const f of finish) f();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.logged, [
    { event: 'alert', code: 'spend_80' },
    { event: 'alert_failed', code: 'spend_80', extension: 'pager', reason: 'timeout' },
    { event: 'alert_failed', code: 'spend_80', extension: 'chat', reason: 'timeout' },
  ]);
});

test('with no limit given each sink has 5 seconds', async () => {
  assert.equal(ALERT_TIMEOUT_MS, 5_000);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let signal: AbortSignal | null = null;
    const h = setup(null, new Response(''), undefined, { sinks: [
      { name: 'pager', alert(_notice, s) { signal = s; return new Promise<void>(() => {}); } },
    ] });
    h.alert('spend_80');
    const settled = h.settled();
    mock.timers.tick(4_999);
    assert.equal((signal as AbortSignal | null)?.aborted, false);
    mock.timers.tick(1);
    assert.equal((signal as AbortSignal | null)?.aborted, true);
    await settled;
    assert.deepEqual(h.logged.at(-1), { event: 'alert_failed', code: 'spend_80', extension: 'pager', reason: 'timeout' });
  } finally {
    mock.timers.reset();
  }
});
