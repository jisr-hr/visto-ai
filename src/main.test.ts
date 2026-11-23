import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { InstanceLock } from './db/types.ts';
import type { LoadedExtension } from './extensions/types.ts';
import { boundedFetch, createServer, describeFailure, GITHUB_CALL_MS, guardRejections, HEADERS_TIMEOUT_MS, lockThenLoad, main, rejectionHandler, REQUEST_TIMEOUT_MS, runUntilSignal } from './main.ts';

async function run(argv: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await main(argv, env, (line) => lines.push(line));
  return { code, lines };
}

test('no arguments is a usage error', async () => {
  const { code, lines } = await run([]);
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.startsWith('usage:'));
});

test('an unknown option and a missing value are usage errors', async () => {
  assert.equal((await run(['--nope'])).code, 2);
  assert.equal((await run(['--config'])).code, 2);
});

test('a config file that cannot be read is a usage error', async () => {
  const { code, lines } = await run(['--config', join(tmpdir(), 'visto-ai-no-such-dir', 'missing.yaml')]);
  assert.equal(code, 2);
  assert.deepEqual(lines, ['usage: cannot read --config']);
});

test('a config without the app block is refused and no value of the environment is printed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visto-ai-main-'));
  const file = join(dir, 'config.yaml');
  writeFileSync(file, 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\ndatabase:\n  url: { env: DB_URL }\n');
  const env = { MODEL_KEY: 'model-secret-value', DB_URL: 'postgres://user:db-password-value@db.invalid/visto' };
  const { code, lines } = await run(['--config', file], env);
  assert.equal(code, 2);
  assert.ok(lines.includes('config: app: required to run the service'));
  for (const line of lines) for (const value of Object.values(env)) assert.ok(!line.includes(value));
});

test('the server limits how long a caller may take to send a request', () => {
  const server = createServer(() => {});
  assert.equal(server.requestTimeout, REQUEST_TIMEOUT_MS);
  assert.equal(server.headersTimeout, HEADERS_TIMEOUT_MS);
  assert.equal(REQUEST_TIMEOUT_MS, 30000);
  assert.equal(HEADERS_TIMEOUT_MS, 10000);
});

test('a failure is described by its name, its code and the short code its message starts with', () => {
  assert.deepEqual(describeFailure(new Error('another_instance_running')), { error: 'Error', code: null, reason: 'another_instance_running' });
  assert.deepEqual(describeFailure(new Error('unknown_migration_applied: 0009_x')), { error: 'Error', code: null, reason: 'unknown_migration_applied' });
  assert.deepEqual(describeFailure(Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' })), { error: 'Error', code: 'ECONNREFUSED', reason: null });
});

function signalsFake() {
  const listeners = new Set<() => void>();
  return {
    on: (l: () => void): void => { listeners.add(l); }, off: (l: () => void): void => { listeners.delete(l); },
    send: (): void => { for (const l of [...listeners]) l(); }, count: (): number => listeners.size,
  };
}
test('the first signal stops the service and the code is 0', async () => {
  const signals = signalsFake();
  let stops = 0;
  const done = runUntilSignal(async () => ({ stop: async () => { stops += 1; } }), signals, () => {}, () => {});
  await new Promise((r) => setImmediate(r));
  signals.send();
  assert.deepEqual([await done, stops, signals.count()], [0, 1, 0]);
});
test('a signal that arrives during the start stops the service as soon as it has started', async () => {
  const signals = signalsFake();
  let started!: (service: { stop(): Promise<void> }) => void;
  let stops = 0;
  const done = runUntilSignal(() => new Promise((resolve) => { started = resolve; }), signals, () => {}, () => {});
  signals.send();
  started({ stop: async () => { stops += 1; } });
  assert.deepEqual([await done, stops], [0, 1]);
});
test('a second signal ends the process at once', async () => {
  const signals = signalsFake();
  const exits: number[] = [];
  void runUntilSignal(async () => ({ stop: () => new Promise<void>(() => {}) }), signals, (code) => { exits.push(code); }, () => {});
  await new Promise((r) => setImmediate(r));
  signals.send();
  signals.send();
  assert.deepEqual(exits, [1]);
});
test('a start that fails is logged with its reason and the code is 1', async () => {
  const logged: Array<Record<string, unknown>> = [];
  const code = await runUntilSignal(() => Promise.reject(new Error('another_instance_running')), signalsFake(), () => {}, (e) => { logged.push(e); });
  assert.deepEqual([code, logged], [1, [{ event: 'start_failed', error: 'Error', code: null, reason: 'another_instance_running' }]]);
});

test('every call to GitHub has a time limit of a minute, for its answer and its body, and a caller\'s own signal still aborts it', async () => {
  assert.equal(GITHUB_CALL_MS, 60_000);
  const never: typeof fetch = () => new Promise<Response>(() => {});
  const started = Date.now();
  await assert.rejects(boundedFetch(never, 20)('https://api.example.test/x'));
  assert.ok(Date.now() - started < 5_000);

  // An answer whose body never ends is cut by the same limit.
  const stalled: typeof fetch = async () => new Response(new ReadableStream({ start() { /* never sends */ } }), { status: 200 });
  await assert.rejects(boundedFetch(stalled, 20)('https://api.example.test/x'));

  const own = new AbortController();
  const waiting = boundedFetch(never, 60_000)('https://api.example.test/x', { signal: own.signal });
  own.abort();
  await assert.rejects(waiting);

  // The signal given to the inner fetch carries the limit too, and an answer in time passes through with its status, headers and body.
  let given: AbortSignal | null | undefined;
  const quick: typeof fetch = async (_input, init) => {
    given = init?.signal;
    return new Response('{"a":1}', { status: 201, headers: { 'x-thing': 'y' } });
  };
  const res = await boundedFetch(quick, 60_000)('https://api.example.test/x', { method: 'POST', headers: { Accept: 'a' } });
  assert.deepEqual([res.status, res.ok, res.headers.get('x-thing'), await res.json()], [201, true, 'y', { a: 1 }]);
  assert.ok(given instanceof AbortSignal);
  const empty = await boundedFetch(async () => new Response(null, { status: 204 }), 60_000)('https://api.example.test/x');
  assert.equal(empty.status, 204);
  const failing: typeof fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(boundedFetch(failing, 60_000)('https://api.example.test/x'), TypeError);
});

test('the lock is taken before a module is loaded, and a second instance loads none', async () => {
  const calls: string[] = [];
  const lock: InstanceLock = { release: async () => { calls.push('release'); } };
  const modules: LoadedExtension[] = [{ name: 'tickets', parts: { context: async () => ({ status: 'empty' }) } }];
  const load = async (): Promise<LoadedExtension[]> => { calls.push('load'); return modules; };

  // The lock held elsewhere: refused, and nothing is loaded.
  await assert.rejects(lockThenLoad(async () => { calls.push('lock'); return null; }, load), /^Error: another_instance_running$/);
  assert.deepEqual(calls, ['lock']);

  // A module that does not load: the lock is released once and the loader's error passed on.
  calls.length = 0;
  const failed = new Error('extension_import_failed');
  await assert.rejects(lockThenLoad(async () => { calls.push('lock'); return lock; }, async () => { calls.push('load'); throw failed; }), (error) => error === failed);
  assert.deepEqual(calls, ['lock', 'load', 'release']);

  // A release that throws changes nothing.
  calls.length = 0;
  const stuck: InstanceLock = { release: async () => { calls.push('release'); throw new Error('release_failed'); } };
  await assert.rejects(lockThenLoad(async () => { calls.push('lock'); return stuck; }, async () => { calls.push('load'); throw failed; }), (error) => error === failed);
  assert.deepEqual(calls, ['lock', 'load', 'release']);

  // Both succeed: the lock and the modules come back, and nothing is released.
  calls.length = 0;
  const done = await lockThenLoad(async () => { calls.push('lock'); return lock; }, load);
  assert.deepEqual([done.lock === lock, done.extensions === modules, calls], [true, true, ['lock', 'load']]);
});

test('a rejection nobody handled is one log line with the error\'s name, or null, and nothing is thrown', () => {
  const logged: Array<Record<string, unknown>> = [];
  const handle = rejectionHandler((entry) => { logged.push(entry); });
  const named = Object.defineProperty({}, 'name', { get() { throw new Error('secret in a getter'); } });
  for (const reason of [new Error('token abc123 refused'), new TypeError('x is not a function'), 'a thrown string', named]) handle(reason);
  assert.deepEqual(logged, [
    { event: 'unhandled_rejection', error: 'Error' }, { event: 'unhandled_rejection', error: 'TypeError' },
    { event: 'unhandled_rejection', error: null }, { event: 'unhandled_rejection', error: null },
  ]);
  assert.equal(JSON.stringify(logged).includes('abc123'), false);
  // A logger that throws changes nothing.
  rejectionHandler(() => { throw new Error('logger down'); })(new Error('x'));
});

test('the handler is registered only when a module was loaded', () => {
  const registered: unknown[] = [];
  assert.equal(guardRejections([], () => {}, (handler) => { registered.push(handler); }), null);
  assert.equal(registered.length, 0);
  const modules: LoadedExtension[] = [{ name: 'chat', parts: { notify: async () => {} } }];
  const handler = guardRejections(modules, () => {}, (h) => { registered.push(h); });
  assert.deepEqual([typeof handler, registered.length, registered[0] === handler], ['function', 1, true]);
});
