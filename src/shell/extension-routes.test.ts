import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionRoutes, ROUTE_TIMEOUT_MS } from './extension-routes.ts';
import type { LoadedExtension, RouteAnswer, RouteRequest } from '../extensions/types.ts';

const REQUEST: RouteRequest = { method: 'POST', path: '/vote', query: 'a=1', headers: { 'x-a': 'b' }, body: Buffer.from('abc') };
const FAILED = { status: 500, headers: {}, body: 'internal_error' };

function module(name: string, route: (request: RouteRequest, signal: AbortSignal) => Promise<RouteAnswer>): LoadedExtension {
  return { name, parts: { route } };
}
function logger() {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: (entry: Record<string, unknown>) => { lines.push(entry); } };
}
async function pending(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  return !done;
}

test('the limit is 10 seconds', () => {
  assert.equal(ROUTE_TIMEOUT_MS, 10_000);
});

test('there is one route for each module that has the part, and none for a module without it', () => {
  const { log } = logger();
  const routes = createExtensionRoutes([
    module('chat', async () => ({ status: 200 })),
    { name: 'tickets', parts: { context: async () => ({ status: 'empty' }) } as LoadedExtension['parts'] },
  ], { log });
  assert.deepEqual([...routes.keys()], ['chat']);
  assert.equal(createExtensionRoutes([], { log }).size, 0);
});

test('a request is handed to the handler as it is, with a signal, and its answer comes back checked', async () => {
  const { log } = logger();
  let seen: { request: RouteRequest; aborted: boolean } | null = null;
  const routes = createExtensionRoutes([module('chat', async (request, signal) => {
    seen = { request, aborted: signal.aborted };
    return { status: 201, headers: { 'Content-Type': 'application/json', 'X-A': 'b' }, body: '{}' };
  }), module('example', async () => ({ status: 204 }))], { log });
  const { answer, settled } = routes.get('chat')!(REQUEST);
  assert.deepEqual(await answer, { status: 201, headers: { 'content-type': 'application/json', 'x-a': 'b' }, body: '{}' });
  await settled;
  assert.equal(seen!.request, REQUEST);
  assert.equal(seen!.aborted, false);
  assert.deepEqual(await routes.get('example')!(REQUEST).answer, { status: 204, headers: {}, body: '' });
});

test('a handler that throws, or throws at once, is answered 500 internal_error, logged by its name and a code, and nothing is thrown', async () => {
  for (const route of [
    async () => { throw new Error('token abc123 refused'); },
    () => { throw new Error('token abc123 refused'); },
  ]) {
    const { lines, log } = logger();
    const routes = createExtensionRoutes([module('chat', route as () => Promise<RouteAnswer>)], { log });
    const { answer, settled } = routes.get('chat')!(REQUEST);
    assert.deepEqual(await answer, FAILED);
    await settled;
    assert.deepEqual(lines, [{ event: 'extension_route_failed', extension: 'chat', code: 'threw' }]);
    assert.equal(JSON.stringify(lines).includes('abc123'), false);
  }
});

test('a handler that rejects with an Error named timeout before its limit is a throw', async () => {
  const { lines, log } = logger();
  const routes = createExtensionRoutes([module('chat', async () => { throw new Error('timeout'); })], { log });
  assert.deepEqual(await routes.get('chat')!(REQUEST).answer, FAILED);
  assert.equal(lines[0]?.code, 'threw');
});

test('a handler past its limit is answered at the limit, its signal is aborted, and it is settled only when its own promise is', async () => {
  const { lines, log } = logger();
  let finish: (a: RouteAnswer) => void = () => undefined;
  let signalSeen: AbortSignal | null = null;
  const routes = createExtensionRoutes([module('chat', (_request, signal) => {
    signalSeen = signal;
    return new Promise<RouteAnswer>((resolve) => { finish = resolve; });
  })], { log, timeoutMs: 5 });
  const { answer, settled } = routes.get('chat')!(REQUEST);
  assert.deepEqual(await answer, FAILED);
  assert.equal(signalSeen!.aborted, true);
  assert.equal(await pending(settled), true);
  assert.deepEqual(lines, [{ event: 'extension_route_failed', extension: 'chat', code: 'timeout' }]);
  finish({ status: 200, body: 'late' });
  await settled;
  assert.deepEqual(await answer, FAILED);
  assert.equal(lines.length, 1);
});

test('a handler past its limit that later rejects is settled, with no unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const { log } = logger();
    let fail: (e: Error) => void = () => undefined;
    const routes = createExtensionRoutes([module('chat', () => new Promise<RouteAnswer>((_r, reject) => { fail = reject; }))], { log, timeoutMs: 5 });
    const { answer, settled } = routes.get('chat')!(REQUEST);
    assert.deepEqual(await answer, FAILED);
    fail(new Error('later'));
    await settled;
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('each request tells how its handler did, once', async () => {
  const { log } = logger();
  const noted: unknown[] = [];
  const answers: (() => Promise<RouteAnswer>)[] = [
    async () => ({ status: 404, body: 'none' }),
    async () => { throw new Error('x'); },
    () => new Promise<RouteAnswer>(() => {}),
    async () => ({ status: 99 }),
  ];
  let i = 0;
  const routes = createExtensionRoutes([module('chat', () => answers[i++]!())], {
    log, timeoutMs: 5, noted: (...args) => { noted.push(args); },
  });
  for (let n = 0; n < answers.length; n += 1) await routes.get('chat')!(REQUEST).answer;
  assert.deepEqual(noted, [['chat', true, 'ok'], ['chat', false, 'threw'], ['chat', false, 'timeout'], ['chat', false, 'bad_answer']]);

  const throwing = createExtensionRoutes([module('chat', async () => ({ status: 200, body: 'fine' }))], {
    log, noted: () => { throw new Error('noted broke'); },
  });
  assert.deepEqual(await throwing.get('chat')!(REQUEST).answer, { status: 200, headers: {}, body: 'fine' });
});

test('an answer of the wrong shape is a 500, and the headers the service owns are left out', async () => {
  const many: Record<string, string> = {};
  for (let n = 0; n < 21; n += 1) many[`x-h${n}`] = 'v';
  const bad: unknown[] = [
    null, undefined, 'ok', [200],
    { status: 99 }, { status: 600 }, { status: 200.5 }, { status: '200' }, { status: Number.NaN },
    { status: 200, body: 5 }, { status: 200, body: null },
    { status: 200, headers: { 'x-a': 'one\ntwo' } }, { status: 200, headers: { 'x-a': 'one\rtwo' } },
    { status: 200, headers: { 'x-a': 'tab\there' } }, { status: 200, headers: { 'x-a': '\u00e9\u20ac' } },
    { status: 200, headers: { 'x a': 'v' } }, { status: 200, headers: { 'x-a:': 'v' } }, { status: 200, headers: { '': 'v' } },
    { status: 200, headers: { ['x'.repeat(65)]: 'v' } }, { status: 200, headers: { 'x-a': 'v'.repeat(2001) } },
    { status: 200, headers: { 'x-a': 5 } }, { status: 200, headers: many }, { status: 200, headers: null }, { status: 200, headers: ['x'] },
    { get status() { throw new Error('getter'); } },
    { status: 200, headers: new Proxy({}, { ownKeys() { throw new Error('keys'); } }) },
  ];
  for (const value of bad) {
    const { lines, log } = logger();
    const routes = createExtensionRoutes([module('chat', async () => value as RouteAnswer)], { log });
    assert.deepEqual(await routes.get('chat')!(REQUEST).answer, FAILED, `case ${bad.indexOf(value)}`);
    assert.deepEqual(lines, [{ event: 'extension_route_failed', extension: 'chat', code: 'bad_answer' }]);
  }
  const { log } = logger();
  const owned = createExtensionRoutes([module('chat', async () => ({
    status: 200,
    headers: { 'Cache-Control': 'public', Connection: 'close', 'Content-Length': '5', 'X-Content-Type-Options': 'x', 'Transfer-Encoding': 'chunked' },
  }))], { log });
  assert.deepEqual(await owned.get('chat')!(REQUEST).answer, { status: 200, headers: {}, body: '' });
  const edges = createExtensionRoutes([module('chat', async () => ({
    status: 599, headers: { ...Object.fromEntries(Object.keys(many).slice(0, 20).map((k) => [k, 'v'])), }, body: '',
  }))], { log });
  assert.equal(Object.keys((await edges.get('chat')!(REQUEST).answer).headers).length, 20);
});
