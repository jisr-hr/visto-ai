import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, parseConfig } from './config/load.ts';
import type { InstanceLock } from './db/types.ts';
import type { ModelRequest } from './engine/types.ts';
import type { LoadedExtension } from './extensions/types.ts';
import type { Settings } from './shell/settings.ts';
import {
  afterLock, boundedFetch, clientsFor, createServer, describeFailure, engineBase, GITHUB_CALL_MS, guardRejections, HEADERS_TIMEOUT_MS, lockThenLoad, main,
  mcpServersOf, rejectionHandler, REQUEST_TIMEOUT_MS, runUntilSignal, startFailed, uiOnOf,
} from './main.ts';

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

test('the engine is given MCP servers only when the config names some, and nothing is asked until one is opened', async () => {
  const asked: string[] = [];
  const fetchFn = ((url: string | URL | Request) => { asked.push(String(url)); return Promise.reject(new Error('refused')); }) as typeof fetch;
  assert.deepEqual(mcpServersOf([], fetchFn), {});
  const { mcpServers } = mcpServersOf([{ name: 'docs', url: 'https://docs.example.test/mcp', headers: {}, tools: ['search', 'get_page'] }], fetchFn);
  assert.deepEqual(mcpServers!.map((s) => [s.name, s.tools]), [['docs', ['search', 'get_page']]]);
  assert.deepEqual(asked, []);
  await assert.rejects(mcpServers![0]!.open(new AbortController().signal));
  assert.deepEqual(asked, ['https://docs.example.test/mcp']);
});

test('the engine\'s dependencies carry the tool choice and the MCP servers only when the config writes them', async () => {
  const yaml = 'model:\n  apiKey: { env: K }\n  model: vendor/model-a\n';
  const asked: string[] = [];
  const plain = ((url: string | URL | Request) => { asked.push(String(url)); return Promise.reject(new Error('refused')); }) as typeof fetch;
  const io = { fetch: plain, sleep: () => Promise.resolve(), clock: () => new Date(0), log: () => {} };
  const neither = engineBase(parseConfig(yaml, { K: 'k' }), io);
  assert.deepEqual(Object.keys(neither), ['model', 'contract', 'clock', 'token', 'log']);
  const servers = 'mcpServers:\n  - name: docs\n    url: https://docs.example.test/mcp\n    tools: [search]\n';
  const both = engineBase(parseConfig(`${yaml}  toolChoice: auto\n${servers}`, { K: 'k' }), io);
  assert.deepEqual(Object.keys(both), ['model', 'contract', 'clock', 'token', 'log', 'toolChoice', 'mcpServers']);
  assert.equal(both.toolChoice, 'auto');
  assert.deepEqual(both.mcpServers!.map((s) => s.name), ['docs']);
  // built on the plain fetch it was given, which nothing has asked yet
  assert.deepEqual(asked, []);
  await assert.rejects(both.mcpServers![0]!.open(new AbortController().signal));
  assert.deepEqual(asked, ['https://docs.example.test/mcp']);
});

/** A lock and a database that record their release and close, each failing when asked. */
function afterLockFakes(fail: { release?: boolean; close?: boolean } = {}) {
  const calls: string[] = [];
  const lock: InstanceLock = { release: async () => { calls.push('release'); if (fail.release === true) throw new Error('release_failed'); } };
  const db = { close: async () => { calls.push('close'); if (fail.close === true) throw new Error('close_failed'); } };
  return { calls, lock, db };
}
const SETTINGS = { atStart: { dryRun: true } } as unknown as Settings;

test('the steps after the lock run in order, and the settings and the base come back', async () => {
  const { calls, lock, db } = afterLockFakes();
  const given: unknown[] = [];
  const base = { engine: 'base' };
  const done = await afterLock(lock, db, {
    migrate: async () => { calls.push('migrate'); },
    settings: async () => { calls.push('settings'); return SETTINGS; },
    base: (settings) => { calls.push('base'); given.push(settings); return base; },
  });
  assert.deepEqual(calls, ['migrate', 'settings', 'base']);
  assert.deepEqual([done.settings === SETTINGS, done.base === base, given.length, given[0] === SETTINGS], [true, true, 1, true]);
});

test('each step after the lock that fails releases the lock and closes the database once, and nothing after it runs', async () => {
  const failed = new Error('unknown_migration_applied: 0099_x');
  const clash = new ConfigError(['limits.spendPerDay: must be positive']);
  const broken = new Error('contract_unreadable');
  const steps = (calls: string[], which: 'migrate' | 'settings' | 'base') => ({
    migrate: async () => { calls.push('migrate'); if (which === 'migrate') throw failed; },
    settings: async () => { calls.push('settings'); if (which === 'settings') throw clash; return SETTINGS; },
    base: () => { calls.push('base'); if (which === 'base') throw broken; return {}; },
  });

  // The migrations reject: neither the settings nor the base is asked for.
  let fakes = afterLockFakes();
  await assert.rejects(afterLock(fakes.lock, fakes.db, steps(fakes.calls, 'migrate')), (error) => error === failed);
  assert.deepEqual(fakes.calls, ['migrate', 'release', 'close']);

  // The settings refuse the start (a clash): the base is not made.
  fakes = afterLockFakes();
  await assert.rejects(afterLock(fakes.lock, fakes.db, steps(fakes.calls, 'settings')), (error) => error === clash);
  assert.deepEqual(fakes.calls, ['migrate', 'settings', 'release', 'close']);

  // The base throws.
  fakes = afterLockFakes();
  await assert.rejects(afterLock(fakes.lock, fakes.db, steps(fakes.calls, 'base')), (error) => error === broken);
  assert.deepEqual(fakes.calls, ['migrate', 'settings', 'base', 'release', 'close']);

  // A release and a close that reject too: each is tried once, and the step's error is the one passed on.
  for (const which of ['migrate', 'settings', 'base'] as const) {
    fakes = afterLockFakes({ release: true, close: true });
    const expected = { migrate: failed, settings: clash, base: broken }[which];
    await assert.rejects(afterLock(fakes.lock, fakes.db, steps(fakes.calls, which)), (error) => error === expected);
    assert.deepEqual(fakes.calls.filter((c) => c === 'release' || c === 'close'), ['release', 'close'], which);
  }
});

test('a start refused for its config writes each issue as a config line, then start_failed, and ends 1', async () => {
  const refused = new ConfigError([
    'auditKey: must be written when a repository turns automatic approval on',
    'Saved in the UI: repositories.defaults.score.autoApprove; with them config.yml does not pass.',
  ]);
  const lines: string[] = [];
  startFailed(refused, (line) => { lines.push(line); });
  assert.deepEqual(lines, [
    'config: auditKey: must be written when a repository turns automatic approval on',
    'config: Saved in the UI: repositories.defaults.score.autoApprove; with them config.yml does not pass.',
    'start_failed',
  ]);
  lines.length = 0;
  startFailed(new Error('contract_unreadable'), (line) => { lines.push(line); });
  assert.deepEqual(lines, ['start_failed']);

  // As main runs it: the start writes its lines and rethrows, and the run logs one start_failed and ends 1.
  lines.length = 0;
  const logged: Array<Record<string, unknown>> = [];
  const code = await runUntilSignal(async () => {
    try {
      throw refused;
    } catch (error) {
      startFailed(error, (line) => { lines.push(line); });
      throw error;
    }
  }, signalsFake(), () => {}, (entry) => { logged.push(entry); });
  assert.equal(code, 1);
  assert.equal(lines.at(-1), 'start_failed');
  assert.equal(lines.filter((l) => l.startsWith('config: ')).length, 2);
  assert.deepEqual(logged, [{ event: 'start_failed', error: 'ConfigError', code: null, reason: null }]);
});

test('the model client and the scorer of each review are made from the settings given, and no scorer when they name none', async () => {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response('{}', { status: 400 });
  }) as typeof fetch;
  const io = { fetch: fetchFn, sleep: () => Promise.resolve() };
  const plain = parseConfig('model:\n  apiKey: { env: K }\n  model: vendor/model-a\n', { K: 'model-key-for-tests-only' });
  const c = { ...plain, model: { ...plain.model, baseUrl: 'https://model.example.test/v1', model: 'vendor/model-b' } };
  const request: ModelRequest = { messages: [{ role: 'user', content: 'hello' }], tools: [], forcedTool: null, effort: 'default', timeoutMs: 1_000 };

  const without = clientsFor(c, io);
  assert.equal('scorer' in without, false);
  await without.model.complete(request).catch(() => {});
  assert.deepEqual([sent[0]!.url, sent[0]!.body.model], ['https://model.example.test/v1/chat/completions', 'vendor/model-b']);

  sent.length = 0;
  const scored = clientsFor({
    ...c, scorer: { baseUrl: 'https://scorer.example.test', apiKey: 'scorer-key-for-tests-only', model: 'vendor/decision-model', timeoutSeconds: 60 },
  }, io);
  assert.notEqual(scored.scorer, undefined);
  await scored.scorer!.score({ text: 'a block', blocks: ['b1'] }).catch(() => {});
  assert.deepEqual([sent[0]!.url, sent[0]!.body.model], ['https://scorer.example.test/decisions', 'vendor/decision-model']);
});

const APP_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const SERVICE_ENV = {
  OPENROUTER_API_KEY: 'model-key-for-tests-only', APP_PRIVATE_KEY: APP_KEY, WEBHOOK_SECRET: 'webhook-secret-for-tests-only',
  DATABASE_URL: 'postgres://visto:db-password-for-tests@db.example.test/visto',
};
const SERVICE_FILE = 'model:\n  apiKey: { env: OPENROUTER_API_KEY }\n  model: vendor/model-a\napp:\n  id: 12345\n  privateKey: { env: APP_PRIVATE_KEY }\n'
  + '  webhookSecret: { env: WEBHOOK_SECRET }\ndatabase:\n  url: { env: DATABASE_URL }\n';

test('a config.yml that fails on its own is refused before the start, as before: config lines, no start_failed, and 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'visto-ai-main-'));
  // A whole file but for one setting, and a file that is not YAML: neither reaches the start (which would write start_failed and end 1).
  const bad = join(dir, 'bad-setting.yml');
  writeFileSync(bad, `${SERVICE_FILE}limits:\n  spendPerDay: -1\n`);
  const refused = await run(['--config', bad], SERVICE_ENV);
  assert.equal(refused.code, 2);
  assert.ok(refused.lines.length > 0 && refused.lines.every((l) => l.startsWith('config: ')), refused.lines.join('\n'));
  assert.ok(refused.lines.some((l) => l.startsWith('config: limits.spendPerDay: ')));
  const unreadable = join(dir, 'not-yaml.yml');
  writeFileSync(unreadable, 'model: [m\n');
  const notYaml = await run(['--config', unreadable], SERVICE_ENV);
  assert.equal(notYaml.code, 2);
  assert.ok(notYaml.lines.length === 1 && notYaml.lines[0]!.startsWith('config: not valid YAML'), notYaml.lines.join('\n'));
  for (const line of [...refused.lines, ...notYaml.lines]) for (const value of Object.values(SERVICE_ENV)) assert.ok(!line.includes(value));
});

test('the sync is told the UI is on exactly when config.yml writes ui.publicUrl', () => {
  const of = (yaml: string, env: Record<string, string> = {}): boolean => uiOnOf(parseConfig(SERVICE_FILE + yaml, { ...SERVICE_ENV, ...env }));
  assert.equal(of(''), false);
  assert.equal(of('ui: {}\n'), false);
  assert.equal(of('ui:\n  accounts: []\n'), false);
  assert.equal(of('ui:\n  publicUrl: https://visto.example.test\n'), true);
  // GitHub sign-in needs the address too, so a file that names an account passes only with it.
  const signIn = SERVICE_FILE.replace('  webhookSecret: { env: WEBHOOK_SECRET }\n', '  webhookSecret: { env: WEBHOOK_SECRET }\n  clientId: Iv1.0123456789abcdef\n  clientSecret: { env: CLIENT_SECRET }\n');
  const named = parseConfig(`${signIn}ui:\n  publicUrl: https://visto.example.test\n  accounts: [octo-admin]\n`, { ...SERVICE_ENV, CLIENT_SECRET: 'client-secret-for-tests-only' });
  assert.equal(uiOnOf(named), true);
  assert.throws(() => parseConfig(`${signIn}ui:\n  accounts: [octo-admin]\n`, { ...SERVICE_ENV, CLIENT_SECRET: 'client-secret-for-tests-only' }), /ui\.publicUrl/);
});
