import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import type { McpServerConfig } from '../config/load.ts';
import { ACCEPTED_VERSIONS, createMcpServers, LIST_PAGES_MAX, PROTOCOL_VERSION } from './client.ts';

const URL_ = 'https://docs.example.test/mcp';
const DOCS: McpServerConfig = { name: 'docs', url: URL_, headers: { Authorization: 'Bearer t0k' }, tools: ['search', 'get_page'] };

interface Rec {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | null | undefined;
  redirect: RequestRedirect | undefined;
}
type Reply = Response | Error | Promise<Response>;
type Handler = (body: Record<string, unknown>, rec: Rec) => Reply;

const INIT = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'docs', version: '1' } };
const TOOLS = [
  { name: 'search', description: 'Search the docs', inputSchema: { type: 'object' } },
  { name: 'get_page', description: 'One page', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
];

const answer = (id: unknown, result: unknown, headers: Record<string, string> = {}) =>
  Response.json({ jsonrpc: '2.0', id, result }, { headers });
const rpcError = (id: unknown, error: unknown, status = 200) => Response.json({ jsonrpc: '2.0', id, error }, { status });
const asStream = (id: unknown, result: unknown) =>
  new Response(`id: e1\ndata:\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });

const DEFAULTS: Record<string, Handler> = {
  initialize: (b) => answer(b.id, INIT, { 'Mcp-Session-Id': 's-1' }),
  'notifications/initialized': () => new Response(null, { status: 202 }),
  'tools/list': (b) => answer(b.id, { tools: TOOLS }),
  'tools/call': (b) => asStream(b.id, { content: [{ type: 'text', text: 'found' }] }),
  DELETE: () => new Response(null, { status: 200 }),
};

/** A fake server: a fetch that records each call and answers by the body's method, or by DELETE. */
function fakeServer(table: Partial<Record<string, Handler>> = {}): { fetch: typeof fetch; calls: Rec[] } {
  const calls: Rec[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const rec: Rec = { url: String(url), method, headers: new Headers(init?.headers), body, signal: init?.signal, redirect: init?.redirect };
    calls.push(rec);
    const key = method === 'DELETE' ? 'DELETE' : String(body?.method);
    const handler = table[key] ?? DEFAULTS[key];
    if (handler === undefined) throw new Error(`no handler for ${key}`);
    const reply = await handler(body ?? {}, rec);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { fetch: fetchFn as typeof fetch, calls };
}

const server = (fake: { fetch: typeof fetch }, config: McpServerConfig = DOCS) => createMcpServers([config], { fetch: fake.fetch })[0]!;
const signal = () => new AbortController().signal;
const deletes = (calls: Rec[]) => calls.filter((c) => c.method === 'DELETE');
const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail('expected a rejection');
}

test('the constants are those of the plan', () => {
  assert.equal(PROTOCOL_VERSION, '2025-11-25');
  assert.deepEqual(ACCEPTED_VERSIONS, ['2025-11-25', '2025-06-18', '2025-03-26']);
  assert.equal(LIST_PAGES_MAX, 10);
});

test('opening sends initialize, then the initialized notification, then lists the tools, following the cursor', async () => {
  const fake = fakeServer({
    'tools/list': (b) => {
      const params = b.params as { cursor?: string } | undefined;
      if (params?.cursor === 'c1') return answer(b.id, { tools: [TOOLS[1], { description: 'no name' }, { name: '' }] });
      return answer(b.id, { tools: [TOOLS[0], 5, { name: 7 }], nextCursor: 'c1' });
    },
  });
  const session = await server(fake).open(signal());
  assert.deepEqual(
    fake.calls.map((c) => c.body),
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'visto-ai', version: '0.0.0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: 'c1' } },
    ],
  );
  assert.deepEqual(session.tools, TOOLS);
  assert.ok(fake.calls.every((c) => c.url === URL_ && c.method === 'POST'));
});

test('a tool keeps its description and schema as sent, and only those three keys', async () => {
  const listed = { name: 'search', description: 7, inputSchema: 'x', annotations: { readOnlyHint: true } };
  const fake = fakeServer({ 'tools/list': (b) => answer(b.id, { tools: [listed, { name: 'get_page' }] }) });
  const session = await server(fake).open(signal());
  assert.deepEqual(session.tools, [
    { name: 'search', description: 7, inputSchema: 'x' },
    { name: 'get_page', description: undefined, inputSchema: undefined },
  ]);
});

test('the session header is sent on every later request when the server issued one, and the version header from the notification on', async () => {
  const fake = fakeServer();
  const session = await server(fake).open(signal());
  await session.call('search', { query: 'cart' }, signal());
  await session.close(signal());
  const [init, ...later] = fake.calls;
  assert.equal(init!.headers.has('mcp-session-id'), false);
  assert.equal(init!.headers.has('mcp-protocol-version'), false);
  assert.deepEqual(
    later.map((c) => c.body?.method ?? c.method),
    ['notifications/initialized', 'tools/list', 'tools/call', 'DELETE'],
  );
  for (const c of later) {
    assert.equal(c.headers.get('mcp-session-id'), 's-1');
    assert.equal(c.headers.get('mcp-protocol-version'), '2025-11-25');
  }

  const bare = fakeServer({ initialize: (b) => answer(b.id, INIT) });
  const s2 = await server(bare).open(signal());
  await s2.call('search', {}, signal());
  await s2.close(signal());
  assert.ok(bare.calls.every((c) => !c.headers.has('mcp-session-id')));
  assert.ok(bare.calls.slice(1).every((c) => c.headers.get('mcp-protocol-version') === '2025-11-25'));
  assert.equal(deletes(bare.calls).length, 0);
});

test('a server that answers an earlier revision of the same transport is used, and any other revision is refused', async () => {
  for (const version of ['2025-06-18', '2025-03-26']) {
    const fake = fakeServer({ initialize: (b) => answer(b.id, { ...INIT, protocolVersion: version }, { 'Mcp-Session-Id': 's-1' }) });
    const session = await server(fake).open(signal());
    await session.call('search', {}, signal());
    assert.ok(fake.calls.slice(1).every((c) => c.headers.get('mcp-protocol-version') === version));
  }
  for (const version of ['2024-11-05', '2026-07-28', 7, undefined]) {
    const result: Record<string, unknown> = { ...INIT, protocolVersion: version };
    if (version === undefined) delete result.protocolVersion;
    const fake = fakeServer({ initialize: (b) => answer(b.id, result) });
    assert.equal(await rejection(server(fake).open(signal())), 'protocol_version');
    assert.equal(fake.calls.length, 1);
  }
  for (const result of [null, 'x', [], 3]) {
    const fake = fakeServer({ initialize: (b) => answer(b.id, result) });
    assert.equal(await rejection(server(fake).open(signal())), 'protocol_version');
  }
  const issued = fakeServer({ initialize: (b) => answer(b.id, { ...INIT, protocolVersion: '2024-11-05' }, { 'Mcp-Session-Id': 's-1' }) });
  assert.equal(await rejection(server(issued).open(signal())), 'protocol_version');
  const [del] = deletes(issued.calls);
  assert.ok(del);
  assert.equal(del.headers.get('mcp-session-id'), 's-1');
  assert.equal(del.headers.has('mcp-protocol-version'), false);
});

test('a server that speaks only a newer revision is refused with protocol_version', async () => {
  const cases: Array<[Handler, string]> = [
    [() => rpcError(undefined, { code: -32022, data: { supported: ['2026-07-28'] } }, 400), 'protocol_version'],
    [(b) => rpcError(b.id, { code: -32602, data: { supported: ['2026-07-28'] } }), 'protocol_version'],
    [(b) => rpcError(b.id, { code: -32022, message: 'Unsupported protocol version' }), 'protocol_version'],
    [(b) => rpcError(b.id, { code: -32602, message: 'Invalid params' }), 'rpc_32602'],
    [(b) => rpcError(b.id, { code: -32602, data: { supported: 'x' } }), 'rpc_32602'],
    [() => new Response('nope', { status: 400 }), 'http_400'],
    [() => new Response(null, { status: 401 }), 'http_401'],
  ];
  for (const [handler, code] of cases) {
    const fake = fakeServer({ initialize: handler });
    assert.equal(await rejection(server(fake).open(signal())), code);
    assert.equal(fake.calls.length, 1);
  }
});

test('a server with no tools capability, a list of more than ten pages, and a session id that is not printable are refused', async () => {
  for (const capabilities of [{}, { tools: true }, { tools: null }, null, undefined]) {
    const fake = fakeServer({ initialize: (b) => answer(b.id, { ...INIT, capabilities }) });
    assert.equal(await rejection(server(fake).open(signal())), 'no_tools');
  }

  let page = 0;
  const endless = fakeServer({
    'tools/list': (b) => {
      page += 1;
      return answer(b.id, { tools: [{ name: `t${page}` }], nextCursor: `c${page}` });
    },
  });
  assert.equal(await rejection(server(endless).open(signal())), 'list_too_long');
  assert.equal(endless.calls.filter((c) => c.body?.method === 'tools/list').length, 10);
  assert.equal(deletes(endless.calls).length, 1);

  const ten = fakeServer({
    'tools/list': (b) => {
      const n = (b.id as number) - 1;
      return answer(b.id, n < 10 ? { tools: [{ name: `t${n}` }], nextCursor: `c${n}` } : { tools: [{ name: 't10' }], nextCursor: '' });
    },
  });
  assert.equal((await server(ten).open(signal())).tools.length, 10);

  for (const result of [{}, { tools: 'x' }, { tools: {} }, null, []]) {
    const fake = fakeServer({ 'tools/list': (b) => answer(b.id, result) });
    assert.equal(await rejection(server(fake).open(signal())), 'bad_answer');
  }

  for (const id of ['s 1', 'x'.repeat(1025), 's\u00e9']) {
    const fake = fakeServer({ initialize: (b) => answer(b.id, INIT, { 'Mcp-Session-Id': id }) });
    assert.equal(await rejection(server(fake).open(signal())), 'bad_session_id');
    assert.equal(fake.calls.length, 1);
  }
  const longest = fakeServer({ initialize: (b) => answer(b.id, INIT, { 'Mcp-Session-Id': '~'.repeat(1024) }) });
  await server(longest).open(signal());
});

test('a failure of the initialized notification fails the open with its code', async () => {
  const fake = fakeServer({ 'notifications/initialized': () => new Response(null, { status: 500 }) });
  assert.equal(await rejection(server(fake).open(signal())), 'http_500');
  assert.equal(fake.calls.filter((c) => c.body?.method === 'tools/list').length, 0);
  assert.equal(deletes(fake.calls).length, 1);
});

test('an open that fails after a session was issued ends that session', async () => {
  const failing = fakeServer({ 'tools/list': () => new Response(null, { status: 500 }) });
  assert.equal(await rejection(server(failing).open(signal())), 'http_500');
  const [del] = deletes(failing.calls);
  assert.ok(del);
  assert.equal(del.headers.get('mcp-session-id'), 's-1');
  assert.equal(del.headers.get('authorization'), 'Bearer t0k');
  assert.equal(del.redirect, 'manual');

  const controller = new AbortController();
  const aborted = fakeServer({
    'tools/list': () => {
      controller.abort();
      return new DOMException('aborted', 'AbortError') as unknown as Error;
    },
  });
  assert.equal(await rejection(server(aborted).open(controller.signal)), 'timeout');
  const [del2] = deletes(aborted.calls);
  assert.ok(del2);
  assert.equal(del2.headers.get('mcp-session-id'), 's-1');
  assert.notEqual(del2.signal, controller.signal);
  assert.equal(del2.signal?.aborted, false);

  const refused = fakeServer({ initialize: (b) => answer(b.id, { ...INIT, capabilities: {} }, { 'Mcp-Session-Id': 's-1' }) });
  assert.equal(await rejection(server(refused).open(signal())), 'no_tools');
  assert.equal(deletes(refused.calls).length, 1);

  const none = fakeServer({ initialize: (b) => answer(b.id, INIT), 'tools/list': () => new Response(null, { status: 500 }) });
  assert.equal(await rejection(server(none).open(signal())), 'http_500');
  assert.equal(deletes(none.calls).length, 0);
});

test('the end of a failed open is bounded by a second of its own, and leaves no timer', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let started = () => {};
    const deleteStarted = new Promise<void>((resolve) => (started = resolve));
    const fake = fakeServer({
      'tools/list': () => new Response(null, { status: 500 }),
      DELETE: () => {
        started();
        return new Promise<Response>(() => {});
      },
    });
    const open = rejection(server(fake).open(signal()));
    let settled = false;
    void open.then(() => (settled = true));
    await Promise.race([deleteStarted, open]);
    assert.equal(deletes(fake.calls).length, 1);
    mock.timers.tick(999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    mock.timers.tick(1);
    assert.equal(await open, 'http_500');
    assert.equal(deletes(fake.calls)[0]!.signal?.aborted, true);
  } finally {
    mock.timers.reset();
  }
  const before = timeouts();
  const quick = fakeServer({ 'tools/list': () => new Response(null, { status: 500 }) });
  await rejection(server(quick).open(signal()));
  assert.equal(timeouts(), before);
});

test('a call sends the name and the arguments under a new id, and two calls at once do not mix their answers', async () => {
  const fake = fakeServer();
  const session = await server(fake).open(signal());
  const got = await session.call('search', { query: 'cart' }, signal());
  const call = fake.calls.find((c) => c.body?.method === 'tools/call')!;
  assert.deepEqual(call.body, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { query: 'cart' } } });
  assert.deepEqual(got, { ok: true, result: { content: [{ type: 'text', text: 'found' }] } });
  assert.equal(Object.hasOwn(got, 'headers'), false);

  const pending: Array<{ id: unknown; release: () => void }> = [];
  const racing = fakeServer({
    'tools/call': (b) =>
      new Promise<Response>((resolve) => {
        const name = (b.params as { name: string }).name;
        pending.push({ id: b.id, release: () => resolve(answer(b.id, { content: [{ type: 'text', text: name }] })) });
      }),
  });
  const s2 = await server(racing).open(signal());
  const a = s2.call('search', {}, signal());
  const b = s2.call('get_page', { id: 'p1' }, signal());
  for (let i = 0; i < 100 && pending.length < 2; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1]!.release();
  pending[0]!.release();
  assert.deepEqual(await a, { ok: true, result: { content: [{ type: 'text', text: 'search' }] } });
  assert.deepEqual(await b, { ok: true, result: { content: [{ type: 'text', text: 'get_page' }] } });
  assert.deepEqual(
    pending.map((p) => p.id),
    [3, 4],
  );
});

test('a call on a session the server has dropped is session_lost', async () => {
  const lost = fakeServer({ 'tools/call': () => new Response(null, { status: 404 }) });
  const s1 = await server(lost).open(signal());
  assert.deepEqual(await s1.call('search', {}, signal()), { ok: false, code: 'session_lost' });

  const bare = fakeServer({ initialize: (b) => answer(b.id, INIT), 'tools/call': () => new Response(null, { status: 404 }) });
  const s2 = await server(bare).open(signal());
  assert.deepEqual(await s2.call('search', {}, signal()), { ok: false, code: 'http_404' });

  const refused = fakeServer({ 'tools/call': (b) => rpcError(b.id, { code: -32602, message: 'Unknown tool: secret_name' }) });
  const s3 = await server(refused).open(signal());
  const got = await s3.call('search', {}, signal());
  assert.deepEqual(got, { ok: false, code: 'rpc_32602' });
  assert.equal(JSON.stringify(got).includes('secret_name'), false);

  const broken = fakeServer({ 'tools/call': () => new Error('getaddrinfo ENOTFOUND docs.example.test') });
  const s4 = await server(broken).open(signal());
  assert.deepEqual(await s4.call('search', {}, signal()), { ok: false, code: 'network' });
});

test('a call never rejects, and a call after the close sends nothing', async () => {
  const fake = fakeServer();
  const session = await server(fake).open(signal());
  const hostile = {};
  Object.defineProperty(hostile, 'toJSON', {
    value: () => {
      throw new Error('boom');
    },
  });
  const got = await session.call('search', hostile as Record<string, unknown>, signal());
  assert.equal(got.ok, false);
  assert.equal(JSON.stringify(got).includes('boom'), false);
  await session.close(signal());
  const before = fake.calls.length;
  assert.deepEqual(await session.call('search', {}, signal()), { ok: false, code: 'closed' });
  assert.equal(fake.calls.length, before);
});

test('closing sends one DELETE with the session header, accepts any answer, and sends nothing when no session was issued', async () => {
  const replies: Array<() => Reply> = [
    () => new Response('bye', { status: 200 }),
    () => new Response(null, { status: 405 }),
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.test/' } }),
    () => new Error('getaddrinfo ENOTFOUND docs.example.test'),
  ];
  for (const reply of replies) {
    const fake = fakeServer({ DELETE: () => reply() });
    const session = await server(fake).open(signal());
    const s = signal();
    await session.close(s);
    await session.close(s);
    const sent = deletes(fake.calls);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.url, URL_);
    assert.equal(sent[0]!.redirect, 'manual');
    assert.equal(sent[0]!.signal, s);
    assert.equal(sent[0]!.body, undefined);
  }

  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: () => {
      cancelled = true;
    },
  });
  const unread = fakeServer({ DELETE: () => new Response(body, { status: 200 }) });
  await (await server(unread).open(signal())).close(signal());
  assert.equal(cancelled, true);

  const bare = fakeServer({ initialize: (b) => answer(b.id, INIT) });
  const s2 = await server(bare).open(signal());
  await s2.close(signal());
  assert.equal(deletes(bare.calls).length, 0);
});

test('a close whose DELETE never settles ends when its signal aborts', async () => {
  const fake = fakeServer({ DELETE: () => new Promise<Response>(() => {}) });
  const session = await server(fake).open(signal());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  await session.close(controller.signal);
  assert.equal(deletes(fake.calls).length, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test("the headers of the config are sent on every request and cannot replace the client's own", async () => {
  const config: McpServerConfig = {
    ...DOCS,
    headers: { Authorization: 'Bearer t0k', accept: 'text/plain', 'content-type': 'text/plain', 'mcp-session-id': 'forged', 'MCP-PROTOCOL-VERSION': '1999-01-01' },
  };
  const fake = fakeServer();
  const session = await server(fake, config).open(signal());
  await session.call('search', {}, signal());
  await session.close(signal());
  assert.equal(fake.calls.length, 5);
  for (const c of fake.calls) {
    assert.equal(c.headers.get('authorization'), 'Bearer t0k');
    if (c.method === 'POST') {
      assert.equal(c.headers.get('accept'), 'application/json, text/event-stream');
      assert.equal(c.headers.get('content-type'), 'application/json');
    }
  }
  const [init, ...later] = fake.calls;
  assert.equal(init!.headers.has('mcp-session-id'), false);
  assert.equal(init!.headers.has('mcp-protocol-version'), false);
  for (const c of later) {
    assert.equal(c.headers.get('mcp-session-id'), 's-1');
    assert.equal(c.headers.get('mcp-protocol-version'), '2025-11-25');
  }
  assert.equal(config.headers.accept, 'text/plain');
});

test('each open is a session of its own', async () => {
  let n = 0;
  const fake = fakeServer({
    initialize: (b) => {
      n += 1;
      return answer(b.id, INIT, { 'Mcp-Session-Id': `s-${n}` });
    },
  });
  const docs = server(fake);
  const first = await docs.open(signal());
  const second = await docs.open(signal());
  assert.equal(fake.calls.filter((c) => c.body?.method === 'initialize').length, 2);
  await second.call('search', {}, signal());
  const call = fake.calls.find((c) => c.body?.method === 'tools/call')!;
  assert.equal(call.headers.get('mcp-session-id'), 's-2');
  assert.equal(call.body?.id, 3);
  await first.close(signal());
  const sent = deletes(fake.calls);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.headers.get('mcp-session-id'), 's-1');
  await second.close(signal());
  assert.equal(deletes(fake.calls)[1]!.headers.get('mcp-session-id'), 's-2');
});

test('the servers are those of the config, in order, and nothing is asked until open', () => {
  const fake = fakeServer();
  const wiki: McpServerConfig = { name: 'wiki', url: 'https://wiki.example.test/mcp', headers: {}, tools: ['find'] };
  const servers = createMcpServers([DOCS, wiki], { fetch: fake.fetch });
  assert.deepEqual(
    servers.map((s) => [s.name, s.tools]),
    [
      ['docs', ['search', 'get_page']],
      ['wiki', ['find']],
    ],
  );
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(createMcpServers([], { fetch: fake.fetch }), []);
});

test('nothing of a failure is kept but its code, and nothing of a session outlives its close', async () => {
  const broken = fakeServer({ initialize: () => new Error('getaddrinfo ENOTFOUND docs.example.test Bearer t0k') });
  assert.equal(await rejection(server(broken).open(signal())), 'network');

  const fake = fakeServer();
  const s = signal();
  const before = timeouts();
  const session = await server(fake).open(s);
  await session.call('search', { query: 'cart' }, s);
  await session.close(s);
  assert.equal(getEventListeners(s, 'abort').length, 0);
  assert.equal(timeouts(), before);
});
