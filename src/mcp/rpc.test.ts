import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_ANSWER_BYTES, rpcRequest, rpcSend, type RpcTarget } from './rpc.ts';

const URL_ = 'https://docs.example.test/mcp';
const SSE = { 'Content-Type': 'text/event-stream' };
const JSON_TYPE = { 'Content-Type': 'application/json' };

interface Source {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  cancelled: () => boolean;
}

/** A stream that hands out one chunk on each pull, and then closes, or never closes. */
function source(chunks: (string | Uint8Array)[], close = true): Source {
  const bytes = chunks.map((chunk) => (typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk));
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled < bytes.length) {
          controller.enqueue(bytes[pulled]!);
          pulled += 1;
          return;
        }
        if (close) {
          controller.close();
          return;
        }
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

type Call = [string, RequestInit];
type Answer = Response | (() => Response | Promise<Response>) | Error;

/** A fetch that records each call and gives the answers in order; the last one is given again. */
function fakeFetch(...answers: Answer[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push([String(url), init ?? {}]);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer() : answer;
  };
  return { fetch: fetchFn as typeof fetch, calls };
}

function target(fetchFn: typeof fetch, headers: Record<string, string> = {}): RpcTarget {
  return { url: URL_, headers, fetch: fetchFn };
}

const event = (message: unknown) => `data: ${JSON.stringify(message)}\n\n`;
const signal = () => new AbortController().signal;
const bodyOf = (call: Call) => JSON.parse(call[1].body as string) as unknown;

test('a request is one POST with both accepted types, the headers given, no redirect followed and the signal', async () => {
  const answer = () => Response.json({ jsonrpc: '2.0', id: 3, result: {} });
  const fake = fakeFetch(answer);
  const s = signal();
  await rpcRequest(target(fake.fetch, { Authorization: 'Bearer t0k', 'Mcp-Session-Id': 's1' }), 3, 'tools/call', { name: 'search', arguments: { query: 'cart' } }, s);
  assert.equal(fake.calls.length, 1);
  const [url, init] = fake.calls[0]!;
  assert.equal(url, URL_);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.signal, s);
  assert.deepEqual(init.headers, {
    Authorization: 'Bearer t0k',
    'Mcp-Session-Id': 's1',
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(bodyOf(fake.calls[0]!), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { query: 'cart' } } });
  await rpcRequest(target(fake.fetch), 4, 'tools/list', undefined, s);
  const second = bodyOf(fake.calls[1]!) as Record<string, unknown>;
  assert.deepEqual(second, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
  assert.equal(Object.hasOwn(second, 'params'), false);
});

test('an answer as JSON and an answer as an event stream give the same result', async () => {
  const message = { jsonrpc: '2.0', id: 3, result: { content: [] } };
  const answers = [
    new Response(JSON.stringify(message), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Kind': 'json' } }),
    new Response(event(message), { headers: { ...SSE, 'X-Kind': 'sse' } }),
    new Response(event(message), { headers: { 'Content-Type': 'Text/Event-Stream; charset=utf-8', 'X-Kind': 'sse2' } }),
  ];
  for (const response of answers) {
    const got = await rpcRequest(target(fakeFetch(response).fetch), 3, 'tools/list', undefined, signal());
    assert.ok(got.ok);
    assert.deepEqual(got.result, { content: [] });
    assert.equal(got.headers, response.headers);
  }
});

test('on a stream, notifications and answers to other ids are passed over, and reading stops at the answer', async () => {
  const s = source(
    [
      ': a comment\n\n',
      'id: e1\ndata:\n\n',
      event({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } }),
      event({ jsonrpc: '2.0', id: 99, result: { wrong: true } }),
      'data: not json\n\n',
      event({ jsonrpc: '2.0', id: 3, result: { right: true } }),
      event({ jsonrpc: '2.0', method: 'notifications/message', params: {} }),
    ],
    false,
  );
  const got = await rpcRequest(target(fakeFetch(new Response(s.stream, { headers: SSE })).fetch), 3, 'tools/call', {}, signal());
  assert.ok(got.ok);
  assert.deepEqual(got.result, { right: true });
  assert.equal(s.cancelled(), true);
  assert.equal(s.pulled(), 6);
});

test('an event stream that never ends is a timeout when the signal aborts, and the stream is cancelled', async () => {
  for (const [chunks, headers] of [
    [[': keep-alive\n\n'], SSE],
    [['{"jsonrpc":"2.0","id":3,'], JSON_TYPE],
  ] as const) {
    const s = source([...chunks], false);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const got = await rpcRequest(target(fakeFetch(new Response(s.stream, { headers })).fetch), 3, 'tools/call', {}, controller.signal);
    assert.deepEqual(got, { ok: false, code: 'timeout' });
    assert.equal(s.cancelled(), true);
  }
});

test('a stream that ends before the answer is stream_ended', async () => {
  const response = new Response('id: e1\ndata:\n\n', { headers: SSE });
  assert.deepEqual(await rpcRequest(target(fakeFetch(response).fetch), 3, 'tools/call', {}, signal()), { ok: false, code: 'stream_ended' });
});

test('an answer over the size limit is answer_too_large and is not read whole', async () => {
  const size = 65_536;
  const chunks = 32;
  const json = source(Array.from({ length: chunks }, () => new Uint8Array(size).fill(0x20)), false);
  const got = await rpcRequest(target(fakeFetch(new Response(json.stream, { headers: JSON_TYPE })).fetch), 3, 'tools/call', {}, signal());
  assert.deepEqual(got, { ok: false, code: 'answer_too_large' });
  assert.equal(json.pulled(), MCP_ANSWER_BYTES / size + 1);
  assert.equal(json.cancelled(), true);
  const note = event({ jsonrpc: '2.0', method: 'notifications/progress', params: { pad: '' } });
  const padded = note.replace('"pad":""', `"pad":"${'x'.repeat(size - note.length)}"`);
  assert.equal(padded.length, size);
  const sse = source(Array.from({ length: chunks }, () => padded), false);
  const got2 = await rpcRequest(target(fakeFetch(new Response(sse.stream, { headers: SSE })).fetch), 3, 'tools/call', {}, signal());
  assert.deepEqual(got2, { ok: false, code: 'answer_too_large' });
  assert.equal(sse.pulled(), MCP_ANSWER_BYTES / size + 1);
  assert.equal(sse.cancelled(), true);
});

test('a ping the server sends on the stream is answered, and any other request of the server is refused as an unknown method', async () => {
  const ours = { jsonrpc: '2.0', id: 3, result: { done: true } };
  const stream = () =>
    new Response(event({ jsonrpc: '2.0', id: 'p1', method: 'ping' }) + event({ jsonrpc: '2.0', id: 7, method: 'sampling/createMessage', params: {} }) + event(ours), { headers: SSE });
  const fake = fakeFetch(stream, () => new Response(null, { status: 202 }));
  const got = await rpcRequest(target(fake.fetch, { Authorization: 'Bearer t0k' }), 3, 'tools/call', {}, signal());
  assert.ok(got.ok);
  assert.deepEqual(got.result, { done: true });
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(bodyOf(fake.calls[1]!), { jsonrpc: '2.0', id: 'p1', result: {} });
  assert.deepEqual(bodyOf(fake.calls[2]!), { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found' } });
  for (const call of fake.calls.slice(1)) {
    assert.equal(call[0], URL_);
    assert.equal(call[1].method, 'POST');
    assert.equal((call[1].headers as Record<string, string>).Authorization, 'Bearer t0k');
  }

  const failing = fakeFetch(stream, new Error('refused'));
  const got2 = await rpcRequest(target(failing.fetch), 3, 'tools/call', {}, signal());
  assert.ok(got2.ok);
  assert.deepEqual(got2.result, { done: true });
  assert.equal(failing.calls.length, 3);

  const pings = Array.from({ length: 10 }, (_, i) => event({ jsonrpc: '2.0', id: i, method: 'ping' })).join('') + event(ours);
  const many = fakeFetch(() => new Response(pings, { headers: SSE }), () => new Response(null, { status: 202 }));
  const got3 = await rpcRequest(target(many.fetch), 3, 'tools/call', {}, signal());
  assert.ok(got3.ok);
  assert.equal(many.calls.length, 1 + 8);
});

test('a status outside 2xx, a redirect, another content type, a body that is no JSON-RPC answer and a JSON-RPC error each end as a short code', async () => {
  const run = async (response: Response) => {
    const fake = fakeFetch(response);
    const got = await rpcRequest(target(fake.fetch), 3, 'tools/call', {}, signal());
    return { got, calls: fake.calls.length };
  };
  assert.deepEqual((await run(new Response(null, { status: 401 }))).got, { ok: false, code: 'http_401' });
  const redirect = await run(new Response(null, { status: 302, headers: { Location: 'https://other.example.test/mcp' } }));
  assert.deepEqual(redirect, { got: { ok: false, code: 'http_302' }, calls: 1 });
  assert.deepEqual((await run(new Response('oops', { status: 500 }))).got, { ok: false, code: 'http_500' });
  assert.deepEqual((await run(new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }))).got, { ok: false, code: 'bad_answer' });
  assert.deepEqual((await run(new Response(null, { headers: JSON_TYPE }))).got, { ok: false, code: 'bad_answer' });
  for (const body of ['x', '[]', '{}', '{"jsonrpc":"2.0","id":4,"result":{}}', '[{"jsonrpc":"2.0","id":3,"result":{}}]']) {
    assert.deepEqual((await run(new Response(body, { headers: JSON_TYPE }))).got, { ok: false, code: 'bad_answer' }, body);
  }
  const unknownTool = { code: -32602, message: 'Unknown tool' };
  assert.deepEqual((await run(Response.json({ jsonrpc: '2.0', id: 3, error: unknownTool }))).got, { ok: false, code: 'rpc_32602', error: unknownTool });
  for (const code of ['x', 12345678, 1.5]) {
    const got = (await run(Response.json({ jsonrpc: '2.0', id: 3, error: { code } }))).got;
    assert.deepEqual(got, { ok: false, code: 'rpc_error', error: { code } }, String(code));
  }
  const versionError = { code: -32022, data: { supported: ['2026-07-28'] } };
  assert.deepEqual((await run(Response.json({ jsonrpc: '2.0', error: versionError }, { status: 400 }))).got, { ok: false, code: 'http_400', error: versionError });
  assert.deepEqual((await run(new Response('not json', { status: 400 }))).got, { ok: false, code: 'http_400' });
  assert.deepEqual((await run(Response.json({ jsonrpc: '2.0', error: 'text' }, { status: 400 }))).got, { ok: false, code: 'http_400' });
});

test('nothing of a failure is kept but its code', async () => {
  const fake = fakeFetch(new Error('getaddrinfo ENOTFOUND docs.example.test'));
  const got = await rpcRequest(target(fake.fetch, { Authorization: 'Bearer t0k' }), 3, 'tools/call', {}, signal());
  assert.deepEqual(got, { ok: false, code: 'network' });
  const text = JSON.stringify(got);
  assert.ok(!text.includes('ENOTFOUND'));
  assert.ok(!text.includes('example'));
  assert.ok(!text.includes('t0k'));
});

test('a notification is one POST, and any 2xx is accepted', async () => {
  const message = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const accepted = fakeFetch(new Response(null, { status: 202 }));
  const s = signal();
  assert.equal(await rpcSend(target(accepted.fetch, { 'Mcp-Session-Id': 's1' }), message, s), null);
  const [url, init] = accepted.calls[0]!;
  assert.equal(url, URL_);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.signal, s);
  assert.deepEqual(init.headers, { 'Mcp-Session-Id': 's1', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' });
  assert.deepEqual(bodyOf(accepted.calls[0]!), message);

  const endless = source(['{'], false);
  assert.equal(await rpcSend(target(fakeFetch(new Response(endless.stream, { status: 200, headers: JSON_TYPE })).fetch), message, signal()), null);
  assert.equal(endless.cancelled(), true);
  assert.equal(endless.pulled(), 0);

  const refused = source(['{"jsonrpc":"2.0","error":{"code":-32600}}']);
  assert.equal(await rpcSend(target(fakeFetch(new Response(refused.stream, { status: 500 })).fetch), message, signal()), 'http_500');
  assert.equal(refused.cancelled(), true);

  const controller = new AbortController();
  controller.abort();
  assert.equal(await rpcSend(target(fakeFetch(new DOMException('aborted', 'AbortError')).fetch), message, controller.signal), 'timeout');
  assert.equal(await rpcSend(target(fakeFetch(new Error('reset')).fetch), message, signal()), 'network');
});
