import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createListener, EXTENSION_BODY_BYTES, EXTENSION_IN_FLIGHT, MAX_BODY_BYTES, MAX_IN_FLIGHT } from './http.ts';
import type { CheckedAnswer, ExtensionRoute, RequestLike, ResponseLike } from './http.ts';
import type { RouteRequest } from '../extensions/types.ts';
import type { HttpAnswer } from './receive.ts';

type Routes = Parameters<typeof createListener>[0];

interface Written { status: number; headers: Record<string, string>; body: string }
function response() {
  const out: { written: Written | null; calls: number } = { written: null, calls: 0 };
  let status = 0;
  let headers: Record<string, string> = {};
  const res: ResponseLike = {
    writeHead(s, h) { status = s; headers = h; return res; },
    end(body) { out.calls += 1; out.written = { status, headers, body }; return res; },
  };
  return { res, out };
}
function request(
  method: string, url: string, chunks: Buffer[] = [Buffer.from('ab'), Buffer.from('c')],
  headers: Record<string, string | string[] | undefined> = { 'x-a': 'b' },
): RequestLike {
  return Object.assign(Readable.from(chunks), { method, url, headers });
}
const ok: HttpAnswer = { status: 202, body: 'accepted' };
const routes: Routes = { webhook: async () => ok };

async function send(req: RequestLike, r = routes, limits?: { maxBodyBytes?: number; maxInFlight?: number }) {
  const { listener, idle } = createListener(r, limits);
  const { res, out } = response();
  listener(req, res);
  await idle();
  return out;
}

test('the limits are 25 MB and 20 requests', () => {
  assert.equal(MAX_BODY_BYTES, 25 * 1024 * 1024);
  assert.equal(MAX_IN_FLIGHT, 20);
});

test('POST /webhooks/github answers what the route answers, with the two headers', async () => {
  const out = await send(request('POST', '/webhooks/github'));
  assert.deepEqual(out.written, {
    status: 202, body: 'accepted',
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
});

test('the route receives the joined body and the headers', async () => {
  let seen: { headers: Record<string, string | undefined>; body: string } | null = null;
  await send(request('POST', '/webhooks/github'), {
    webhook: async (headers, body) => { seen = { headers, body: body.toString() }; return ok; },
  });
  assert.deepEqual(seen, { headers: { 'x-a': 'b' }, body: 'abc' });
});

test('a header given several times is read as its first value', async () => {
  let seen: Record<string, string | undefined> = {};
  await send(request('POST', '/webhooks/github', [], { 'x-a': ['first', 'second'], 'x-b': undefined }), {
    webhook: async (headers) => { seen = headers; return ok; },
  });
  assert.equal(seen['x-a'], 'first');
  assert.equal(seen['x-b'], undefined);
});

test('a query string does not change the path', async () => {
  assert.equal((await send(request('POST', '/webhooks/github?x=1'))).written?.status, 202);
});

test('GET /healthz answers 200 ok', async () => {
  const out = await send(request('GET', '/healthz'));
  assert.deepEqual([out.written?.status, out.written?.body], [200, 'ok']);
});

test('another method on either path answers 405', async () => {
  for (const [m, u] of [['GET', '/webhooks/github'], ['POST', '/healthz'], ['PUT', '/webhooks/github']] as const) {
    const out = await send(request(m, u));
    assert.deepEqual([out.written?.status, out.written?.body], [405, 'method_not_allowed']);
  }
});

test('any other path answers 404, whatever the url or method', async () => {
  for (const [m, u] of [['GET', '/'], ['POST', '/nope'], [undefined, undefined]] as const) {
    const req = Object.assign(Readable.from([]), { method: m, url: u, headers: {} });
    const out = await send(req);
    assert.deepEqual([out.written?.status, out.written?.body], [404, 'not_found']);
  }
});

test('a route that rejects answers 500 internal_error', async () => {
  const out = await send(request('POST', '/webhooks/github'), { webhook: async () => { throw new Error('secret detail'); } });
  assert.deepEqual([out.written?.status, out.written?.body], [500, 'internal_error']);
});

test('a route that throws at once answers 500 internal_error', async () => {
  const out = await send(request('POST', '/webhooks/github'), { webhook: () => { throw new Error('x'); } });
  assert.deepEqual([out.written?.status, out.written?.body], [500, 'internal_error']);
});

test('a body that grows past the limit answers 413 and the route is not called', async () => {
  let called = 0;
  const chunks = [Buffer.from('abcd'), Buffer.from('efgh'), Buffer.from('i')];
  const out = await send(request('POST', '/webhooks/github', chunks), { webhook: async () => { called += 1; return ok; } }, { maxBodyBytes: 8 });
  assert.deepEqual([out.written?.status, out.written?.body], [413, 'payload_too_large']);
  assert.equal(called, 0);
});

test('a body of exactly the limit is handled', async () => {
  const out = await send(request('POST', '/webhooks/github', [Buffer.from('abcdefgh')]), routes, { maxBodyBytes: 8 });
  assert.equal(out.written?.status, 202);
});

test('a content-length over the limit answers 413 and the route is not called', async () => {
  let called = 0;
  const out = await send(
    request('POST', '/webhooks/github', [Buffer.from('a')], { 'content-length': '9' }),
    { webhook: async () => { called += 1; return ok; } }, { maxBodyBytes: 8 });
  assert.deepEqual([out.written?.status, out.written?.body], [413, 'payload_too_large']);
  assert.equal(called, 0);
});

test('over maxInFlight answers 503 busy without reading the body; a later request is handled', async () => {
  let release: (a: HttpAnswer) => void = () => undefined;
  const held = new Promise<HttpAnswer>((resolve) => { release = resolve; });
  let calls = 0;
  const { listener, idle } = createListener({
    webhook: () => { calls += 1; return calls === 1 ? held : Promise.resolve(ok); },
  }, { maxInFlight: 1 });
  const first = response();
  listener(request('POST', '/webhooks/github'), first.res);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);

  const secondReq = Object.assign(Readable.from([Buffer.from('abc')]), { method: 'POST', url: '/webhooks/github', headers: {} });
  const second = response();
  listener(secondReq, second.res);
  assert.deepEqual([second.out.written?.status, second.out.written?.body], [503, 'busy']);
  assert.equal(secondReq.readableFlowing ?? null, null);
  assert.equal(calls, 1);

  release(ok);
  await idle();
  assert.equal(first.out.written?.status, 202);

  const third = response();
  listener(request('POST', '/webhooks/github'), third.res);
  await idle();
  assert.equal(third.out.written?.status, 202);
});

test('a stream that fails: no answer, no route call, no unhandled rejection, and idle resolves', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };
  process.on('unhandledRejection', onUnhandled);
  try {
    let called = 0;
    async function* body() { yield Buffer.from('ab'); throw new Error('connection reset'); }
    const req = Object.assign(Readable.from(body()), { method: 'POST', url: '/webhooks/github', headers: {} });
    const { listener, idle } = createListener({ webhook: async () => { called += 1; return ok; } });
    const { res, out } = response();
    listener(req, res);
    await idle();
    await new Promise((r) => setImmediate(r));
    assert.equal(called, 0);
    assert.equal(out.calls, 0);
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('a failed stream stops counting as in flight', async () => {
  async function* body() { throw new Error('reset'); yield Buffer.from(''); }
  const { listener, idle } = createListener(routes, { maxInFlight: 1 });
  listener(Object.assign(Readable.from(body()), { method: 'POST', url: '/webhooks/github', headers: {} }), response().res);
  await idle();
  const next = response();
  listener(request('POST', '/webhooks/github'), next.res);
  await idle();
  assert.equal(next.out.written?.status, 202);
});

test('a response that throws when written does not escape', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const { listener, idle } = createListener(routes);
    const res: ResponseLike = { writeHead() { throw new Error('closed'); }, end() { throw new Error('closed'); } };
    listener(request('POST', '/webhooks/github'), res);
    await idle();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('idle resolves at once with nothing in flight, and only after the answer otherwise', async () => {
  const { listener, idle } = createListener(routes);
  await idle();
  let release: (a: HttpAnswer) => void = () => undefined;
  const held = new Promise<HttpAnswer>((resolve) => { release = resolve; });
  const l2 = createListener({ webhook: () => held });
  const { res, out } = response();
  l2.listener(request('POST', '/webhooks/github'), res);
  let done = false;
  const waiting = l2.idle().then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  release(ok);
  await waiting;
  assert.equal(out.written?.status, 202);
  void listener;
});

const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
const CLOSE = { ...TEXT, connection: 'close' };

test('a body over the limit is answered 413 with connection close, and the iterator is not returned', async () => {
  let returned = 0;
  const parts = [Buffer.from('abcde'), Buffer.from('fghi'), Buffer.from('jk')];
  let i = 0;
  const req: RequestLike = {
    method: 'POST', url: '/webhooks/github', headers: {},
    [Symbol.asyncIterator]: () => ({
      next: async () => (i < parts.length ? { done: false as const, value: parts[i++] as Buffer } : { done: true as const, value: undefined }),
      return: async () => { returned += 1; return { done: true as const, value: undefined }; },
    }),
  };
  let called = 0;
  const out = await send(req, { webhook: async () => { called += 1; return ok; } }, { maxBodyBytes: 8 });
  assert.deepEqual(out.written, { status: 413, body: 'payload_too_large', headers: CLOSE });
  assert.equal(called, 0);
  assert.equal(returned, 0);
});

test('a content-length over the limit is answered 413 with connection close', async () => {
  const out = await send(
    request('POST', '/webhooks/github', [Buffer.from('a')], { 'content-length': '9' }), routes, { maxBodyBytes: 8 });
  assert.deepEqual(out.written, { status: 413, body: 'payload_too_large', headers: CLOSE });
});

test('other answers carry no connection header', async () => {
  for (const req of [request('POST', '/webhooks/github'), request('GET', '/nope'), request('GET', '/healthz')]) {
    assert.deepEqual((await send(req)).written?.headers, TEXT);
  }
});

test('a 413 stops counting as in flight', async () => {
  const { listener, idle } = createListener(routes, { maxBodyBytes: 1, maxInFlight: 1 });
  listener(request('POST', '/webhooks/github'), response().res);
  await idle();
  const next = response();
  listener(request('POST', '/webhooks/github', [Buffer.from('a')]), next.res);
  await idle();
  assert.equal(next.out.written?.status, 202);
});

// -- module routes ----------------------------------------------------------------------------------------------

type Route = ExtensionRoute;
interface Held { request: RouteRequest; answer: (a: CheckedAnswer) => void; settle: () => void }
/** A fake route: records each request and returns two promises the test settles by hand. */
function fakeRoute() {
  const held: Held[] = [];
  const route: Route = (request) => {
    let answer: (a: CheckedAnswer) => void = () => undefined;
    let settle: () => void = () => undefined;
    const a = new Promise<CheckedAnswer>((r) => { answer = r; });
    const s = new Promise<void>((r) => { settle = r; });
    held.push({ request, answer, settle });
    return { answer: a, settled: s };
  };
  return { route, held };
}
/** A route that answers at once and is settled at once. */
function readyRoute(a: CheckedAnswer = { status: 200, headers: {}, body: 'fine' }) {
  const seen: RouteRequest[] = [];
  const route: Route = (request) => { seen.push(request); return { answer: Promise.resolve(a), settled: Promise.resolve() }; };
  return { route, seen };
}
/** A request whose body is never asked for, and counts each time it is. */
function untouched(method: string, url: string, headers: Record<string, string> = {}) {
  let asked = 0;
  const req: RequestLike = {
    method, url, headers,
    [Symbol.asyncIterator]: () => ({ next: () => { asked += 1; return new Promise<IteratorResult<Buffer>>(() => {}); } }),
  };
  return { req, asked: () => asked };
}
const tick = () => new Promise((r) => setImmediate(r));
const MODULE_HEADERS = { ...TEXT, 'x-content-type-options': 'nosniff' };

test('the module limits are 1 MiB and 10 requests', () => {
  assert.equal(EXTENSION_BODY_BYTES, 1024 * 1024);
  assert.equal(EXTENSION_IN_FLIGHT, 10);
});

test('a request for a name no module has is answered 404 at once, as on main: nothing is read and no place is taken', async () => {
  const chat = readyRoute();
  const cases: Routes[] = [
    { webhook: async () => ok },
    { webhook: async () => ok, extensions: new Map() },
    { webhook: async () => ok, extensions: new Map([['chat', chat.route]]) },
  ];
  for (const r of cases) {
    for (const [url, headers] of [
      ['/extensions/x/y', {}], ['/extensions/x/y', { 'content-length': String(5 * 1024 * 1024) }],
      ['/extensions/Chat/x', {}], ['/extensions//x', {}], ['/extensions', {}], ['/extensions/', {}], ['/extensions?x=1', {}],
    ] as const) {
      const { listener, idle } = createListener(r);
      const { req, asked } = untouched('POST', url, headers);
      const { res, out } = response();
      listener(req, res);
      assert.deepEqual(out.written, { status: 404, body: 'not_found', headers: TEXT }, url);
      await idle();
      assert.equal(asked(), 0);
    }
  }
  assert.equal(chat.seen.length, 0);

  const pager = fakeRoute();
  const { listener, idle } = createListener(
    { webhook: async () => ok, extensions: new Map([['chat', chat.route], ['pager', pager.route]]) },
    { maxInFlight: 1, maxExtensionInFlight: 1 });
  for (let n = 0; n < 20; n += 1) {
    const { req } = untouched('POST', '/extensions/x/y');
    const { res, out } = response();
    listener(req, res);
    assert.equal(out.written?.status, 404);
  }
  const hook = response();
  listener(request('POST', '/webhooks/github'), hook.res);
  const mod = response();
  listener(request('POST', '/extensions/chat/x'), mod.res);
  await idle();
  assert.equal(hook.out.written?.status, 202);
  assert.equal(mod.out.written?.status, 200);
});

test('a request under a module prefix is handed over with its method, the rest of its path, its query, its headers and its body', async () => {
  const chat = readyRoute();
  const r: Routes = { webhook: async () => ok, extensions: new Map([['chat', chat.route]]) };
  await send(request('POST', '/extensions/chat/events/x?a=1&b=%20', undefined, { 'x-a': ['b', 'c'], 'x-b': undefined }), r);
  assert.deepEqual(
    { ...chat.seen[0], body: chat.seen[0]?.body.toString() },
    { method: 'POST', path: '/events/x', query: 'a=1&b=%20', headers: { 'x-a': 'b', 'x-b': undefined }, body: 'abc' });
  assert.ok(Buffer.isBuffer(chat.seen[0]?.body));
  await send(request('GET', '/extensions/chat', []), r);
  await send(request('GET', '/extensions/chat/', []), r);
  await send(request('DELETE', '/extensions/chat?x=1', []), r);
  await send(request('PATCH', '/extensions/chat/a%2Fb/?q=1?2', []), r);
  await send(Object.assign(Readable.from([]), { method: undefined, url: '/extensions/chat/z', headers: { 'X-Up': 'v' } }), r);
  assert.deepEqual(chat.seen.slice(1).map((s) => [s.method, s.path, s.query, s.body.length]), [
    ['GET', '/', '', 0], ['GET', '/', '', 0], ['DELETE', '/', 'x=1', 0], ['PATCH', '/a%2Fb/', 'q=1?2', 0], ['', '/z', '', 0],
  ]);
  assert.deepEqual(chat.seen[5]?.headers, { 'x-up': 'v' });
  const odd: Record<string, string> = {};
  Object.defineProperty(odd, '__proto__', { value: 'p', enumerable: true });
  odd.constructor = 'c' as unknown as typeof Object;
  await send(Object.assign(Readable.from([]), { method: 'GET', url: '/extensions/chat', headers: odd }), r);
  assert.equal(Object.getPrototypeOf(chat.seen[6]?.headers), Object.prototype);
  assert.deepEqual(Object.entries(chat.seen[6]?.headers ?? {}), [['__proto__', 'p'], ['constructor', 'c']]);
});

test('what the module answers is written with its headers, and the two headers of the service are always set', async () => {
  const json = readyRoute({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' });
  const out = await send(request('POST', '/extensions/chat/x'), { webhook: async () => ok, extensions: new Map([['chat', json.route]]) });
  assert.deepEqual(out.written, {
    status: 200, body: '{}',
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
  const plain = readyRoute({ status: 418, headers: { 'x-a': 'b' }, body: 'tea' });
  const out2 = await send(request('GET', '/extensions/chat'), { webhook: async () => ok, extensions: new Map([['chat', plain.route]]) });
  assert.deepEqual(out2.written, { status: 418, body: 'tea', headers: { ...MODULE_HEADERS, 'x-a': 'b' } });
});

test('a route whose answer rejects is answered 500 internal_error', async () => {
  const route: Route = () => ({ answer: Promise.reject(new Error('detail')), settled: Promise.resolve() });
  const out = await send(request('GET', '/extensions/chat'), { webhook: async () => ok, extensions: new Map([['chat', route]]) });
  assert.deepEqual(out.written, { status: 500, body: 'internal_error', headers: MODULE_HEADERS });
});

test('a body over 1 MiB is answered 413 on a module route, its place is given back, and the webhook route keeps its own cap', async () => {
  const chat = readyRoute();
  const r: Routes = { webhook: async () => ok, extensions: new Map([['chat', chat.route]]) };
  const { listener, idle } = createListener(r, { maxExtensionInFlight: 1 });
  const declared = response();
  listener(request('POST', '/extensions/chat/x', [Buffer.from('a')], { 'content-length': String(1024 * 1024 + 1) }), declared.res);
  await idle();
  assert.deepEqual(declared.out.written, { status: 413, body: 'payload_too_large', headers: CLOSE });
  const arriving = response();
  listener(request('POST', '/extensions/chat/x', [Buffer.alloc(1024 * 1024), Buffer.from('a')]), arriving.res);
  await idle();
  assert.deepEqual(arriving.out.written, { status: 413, body: 'payload_too_large', headers: CLOSE });
  assert.equal(chat.seen.length, 0);
  const exact = response();
  listener(request('POST', '/extensions/chat/x', [Buffer.alloc(1024 * 1024)]), exact.res);
  await idle();
  assert.equal(exact.out.written?.status, 200);
  assert.equal(chat.seen.length, 1);
  const hook = response();
  listener(request('POST', '/webhooks/github', [Buffer.alloc(2 * 1024 * 1024)]), hook.res);
  await idle();
  assert.equal(hook.out.written?.status, 202);
});

test('a module request whose stream fails gives its place back, unanswered', async () => {
  async function* body() { throw new Error('reset'); yield Buffer.from(''); }
  const chat = readyRoute();
  const { listener, idle } = createListener({ webhook: async () => ok, extensions: new Map([['chat', chat.route]]) }, { maxExtensionInFlight: 1 });
  const first = response();
  listener(Object.assign(Readable.from(body()), { method: 'POST', url: '/extensions/chat/x', headers: {} }), first.res);
  await idle();
  assert.equal(first.out.calls, 0);
  const next = response();
  listener(request('POST', '/extensions/chat/x'), next.res);
  await idle();
  assert.equal(next.out.written?.status, 200);
  assert.equal(chat.seen.length, 1);
});

test('each module has places of its own, and the webhook route has its own', async () => {
  const chat = fakeRoute();
  const pager = readyRoute();
  let releaseHook: (a: HttpAnswer) => void = () => undefined;
  let hookCalls = 0;
  const { listener, idle } = createListener({
    webhook: () => { hookCalls += 1; return hookCalls === 2 ? new Promise<HttpAnswer>((r) => { releaseHook = r; }) : Promise.resolve(ok); },
    extensions: new Map([['chat', chat.route], ['pager', pager.route]]),
  }, { maxInFlight: 1, maxExtensionInFlight: 1 });

  const first = response();
  listener(request('POST', '/extensions/chat/a'), first.res);
  await tick();
  assert.equal(chat.held.length, 1);
  const { req, asked } = untouched('POST', '/extensions/chat/b');
  const second = response();
  listener(req, second.res);
  assert.deepEqual(second.out.written, { status: 503, body: 'busy', headers: TEXT });
  const pagerOut = response();
  listener(request('POST', '/extensions/pager/a'), pagerOut.res);
  const hook = response();
  listener(request('POST', '/webhooks/github'), hook.res);
  await tick(); await tick();
  assert.equal(pagerOut.out.written?.status, 200);
  assert.equal(hook.out.written?.status, 202);
  assert.equal(asked(), 0);
  assert.equal(chat.held.length, 1);
  chat.held[0]!.answer({ status: 200, headers: {}, body: 'one' });
  chat.held[0]!.settle();
  await idle();
  assert.equal(first.out.written?.body, 'one');

  const heldHook = response();
  listener(request('POST', '/webhooks/github'), heldHook.res);
  await tick();
  assert.equal(hookCalls, 2);
  const busyHook = response();
  listener(request('POST', '/webhooks/github'), busyHook.res);
  assert.equal(busyHook.out.written?.status, 503);
  const chatAgain = response();
  listener(request('POST', '/extensions/chat/c'), chatAgain.res);
  await tick();
  chat.held[1]!.answer({ status: 200, headers: {}, body: 'two' });
  chat.held[1]!.settle();
  await tick(); await tick();
  assert.equal(chatAgain.out.written?.body, 'two');
  releaseHook(ok);
  await idle();
  assert.equal(heldHook.out.written?.status, 202);
});

test('a handler that never settles keeps its place after its caller was answered, and gives it back when it settles', async () => {
  const chat = fakeRoute();
  const pager = readyRoute();
  const { listener, idle } = createListener({
    webhook: async () => ok, extensions: new Map([['chat', chat.route], ['pager', pager.route]]),
  }, { maxExtensionInFlight: 2 });
  const answered = [response(), response()];
  for (const a of answered) listener(request('POST', '/extensions/chat/x'), a.res);
  await tick();
  for (const h of chat.held) h.answer({ status: 500, headers: {}, body: 'internal_error' });
  await idle();
  assert.deepEqual(answered.map((a) => a.out.written?.status), [500, 500]);

  const reads: (() => number)[] = [];
  for (let n = 0; n < 20; n += 1) {
    const { req, asked } = untouched('POST', '/extensions/chat/x');
    reads.push(asked);
    const { res, out } = response();
    listener(req, res);
    assert.deepEqual([out.written?.status, out.written?.body], [503, 'busy']);
  }
  assert.deepEqual(reads.map((r) => r()), new Array(20).fill(0));
  assert.equal(chat.held.length, 2);
  const hook = response();
  listener(request('POST', '/webhooks/github'), hook.res);
  const other = response();
  listener(request('POST', '/extensions/pager/x'), other.res);
  await idle();
  assert.equal(hook.out.written?.status, 202);
  assert.equal(other.out.written?.status, 200);

  chat.held[0]!.settle();
  await tick();
  const next = response();
  listener(request('POST', '/extensions/chat/x'), next.res);
  await tick();
  assert.equal(chat.held.length, 3);
  chat.held[2]!.answer({ status: 200, headers: {}, body: 'back' });
  await idle();
  assert.equal(next.out.written?.body, 'back');
});
