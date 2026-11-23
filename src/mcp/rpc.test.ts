import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
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
  assert.ok(json.pulled() < chunks);
  assert.equal(json.cancelled(), true);
  const note = event({ jsonrpc: '2.0', method: 'notifications/progress', params: { pad: '' } });
  const padded = note.replace('"pad":""', `"pad":"${'x'.repeat(size - note.length)}"`);
  assert.equal(padded.length, size);
  const sse = source(Array.from({ length: chunks }, () => padded), false);
  const got2 = await rpcRequest(target(fakeFetch(new Response(sse.stream, { headers: SSE })).fetch), 3, 'tools/call', {}, signal());
  assert.deepEqual(got2, { ok: false, code: 'answer_too_large' });
  assert.equal(sse.pulled(), MCP_ANSWER_BYTES / size + 1);
  assert.ok(sse.pulled() < chunks);
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

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/**
 * A stream of `count` chunks of `width` spaces each (width 0: empty chunks), then `last`, then the end, or a pull that never
 * settles when `close` is false. At the last chunk it measures how far the live heap grew since the stream was made, and runs `atLast`.
 */
function drip(count: number, width: number, last: string, close: boolean, atLast = () => {}) {
  const filler = new TextEncoder().encode(' '.repeat(width));
  const tail = new TextEncoder().encode(last);
  let pulled = 0;
  let cancelled = false;
  let grown = Number.NaN;
  gc();
  const before = process.memoryUsage().heapUsed;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled < count) {
          pulled += 1;
          controller.enqueue(filler.slice());
          return;
        }
        if (pulled === count) {
          pulled += 1;
          gc();
          grown = process.memoryUsage().heapUsed - before;
          controller.enqueue(tail);
          atLast();
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
  return { stream, grown: () => grown, cancelled: () => cancelled };
}

test('an answer that drips in tiny chunks or in empty ones holds no memory for each chunk', async () => {
  const count = 200_000;
  const limit = 4 * 1024 * 1024;
  const message = { jsonrpc: '2.0', id: 3, result: { done: true } };
  const answer = JSON.stringify(message);
  const cases = [
    { width: 1, headers: JSON_TYPE, last: answer, close: true },
    { width: 0, headers: JSON_TYPE, last: answer, close: true },
    { width: 1, headers: SSE, last: `\n\n${event(message)}`, close: false },
    { width: 0, headers: SSE, last: event(message), close: false },
  ];
  // a short run of each kind first, so that what the first run of the code costs once is not counted
  for (const { width, headers, last, close } of cases) {
    await rpcRequest(target(fakeFetch(new Response(drip(1000, width, last, close).stream, { headers })).fetch), 3, 'tools/call', {}, signal());
  }
  for (const { width, headers, last, close } of cases) {
    const label = `${headers['Content-Type']}, width ${width}`;
    const s = drip(count, width, last, close);
    const got = await rpcRequest(target(fakeFetch(new Response(s.stream, { headers })).fetch), 3, 'tools/call', {}, signal());
    assert.ok(got.ok, label);
    assert.deepEqual(got.result, { done: true }, label);
    assert.ok(s.grown() < limit, `${label}: the live heap grew ${Math.round(s.grown() / 1e6)} MB`);
  }
  for (const headers of [JSON_TYPE, SSE]) {
    const controller = new AbortController();
    const s = drip(count, 1, ':', false, () => controller.abort());
    const got = await rpcRequest(target(fakeFetch(new Response(s.stream, { headers })).fetch), 3, 'tools/call', {}, controller.signal);
    assert.deepEqual(got, { ok: false, code: 'timeout' }, headers['Content-Type']);
    assert.equal(s.cancelled(), true);
    assert.ok(s.grown() < limit, `${headers['Content-Type']}: the live heap grew ${Math.round(s.grown() / 1e6)} MB`);
  }
});

test('a given header of the client own names, in any letter case, is replaced by the client one', async () => {
  const fake = fakeFetch(() => Response.json({ jsonrpc: '2.0', id: 3, result: {} }), () => new Response(null, { status: 202 }));
  await rpcRequest(target(fake.fetch, { accept: 'text/html', 'CONTENT-TYPE': 'text/plain', Authorization: 'Bearer t0k' }), 3, 'tools/list', undefined, signal());
  await rpcSend(target(fake.fetch, { accept: 'text/html' }), { jsonrpc: '2.0', method: 'notifications/initialized' }, signal());
  assert.deepEqual(fake.calls[0]![1].headers, { Authorization: 'Bearer t0k', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' });
  assert.deepEqual(fake.calls[1]![1].headers, { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' });
  assert.equal(new Headers(fake.calls[0]![1].headers).get('accept'), 'application/json, text/event-stream');
});

test('the content type is judged by its media type alone', async () => {
  const message = { jsonrpc: '2.0', id: 3, result: { content: [] } };
  for (const type of ['application/json-seq', 'application/jsonx; charset=utf-8', 'text/event-streamed', 'application/problem+json']) {
    const got = await rpcRequest(target(fakeFetch(new Response(JSON.stringify(message), { headers: { 'Content-Type': type } })).fetch), 3, 'tools/list', undefined, signal());
    assert.deepEqual(got, { ok: false, code: 'bad_answer' }, type);
  }
  for (const [type, body] of [[' Application/JSON ; charset=utf-8', JSON.stringify(message)], ['text/event-stream ;charset=utf-8', event(message)]] as const) {
    const got = await rpcRequest(target(fakeFetch(new Response(body, { headers: { 'Content-Type': type } })).fetch), 3, 'tools/list', undefined, signal());
    assert.ok(got.ok, type);
  }
});

test('a result whose body cannot be read is a short code, never a rejection', async () => {
  const broken = {
    status: 200,
    headers: new Headers(JSON_TYPE),
    get body(): never {
      throw new Error('secret t0k at docs.example.test');
    },
  } as unknown as Response;
  const got = await rpcRequest(target(fakeFetch(() => broken).fetch), 3, 'tools/list', undefined, signal());
  assert.deepEqual(got, { ok: false, code: 'network' });
  assert.equal(await rpcSend(target(fakeFetch(() => broken).fetch), { jsonrpc: '2.0', method: 'notifications/initialized' }, signal()), 'network');
});

test('the abort listener is removed after every kind of end', async () => {
  const message = { jsonrpc: '2.0', id: 3, result: {} };
  const answers: [string, () => Response][] = [
    ['json', () => Response.json(message)],
    ['stream', () => new Response(event(message), { headers: SSE })],
    ['stream ended', () => new Response(': only a comment\n\n', { headers: SSE })],
    ['http 500', () => new Response('x', { status: 500 })],
    ['http 400', () => Response.json({ error: { code: 1 } }, { status: 400 })],
    ['not json', () => new Response('x', { headers: JSON_TYPE })],
  ];
  for (const [label, answer] of answers) {
    const s = signal();
    await rpcRequest(target(fakeFetch(answer).fetch), 3, 'tools/list', undefined, s);
    assert.equal(getEventListeners(s, 'abort').length, 0, label);
  }
  for (const headers of [JSON_TYPE, SSE]) {
    const controller = new AbortController();
    const s = source([' '], false);
    const pending = rpcRequest(target(fakeFetch(new Response(s.stream, { headers })).fetch), 3, 'tools/list', undefined, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1, 'listening while it reads');
    controller.abort();
    assert.deepEqual(await pending, { ok: false, code: 'timeout' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, headers['Content-Type']);
  }
});
