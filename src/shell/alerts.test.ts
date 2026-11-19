import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlerts } from './alerts.ts';

function setup(webhook: string | null, answer: Response | Error, log?: (entry: Record<string, unknown>) => void) {
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
