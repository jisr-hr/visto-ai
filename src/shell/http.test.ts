import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createListener, MAX_BODY_BYTES, MAX_IN_FLIGHT } from './http.ts';
import type { RequestLike, ResponseLike } from './http.ts';
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
