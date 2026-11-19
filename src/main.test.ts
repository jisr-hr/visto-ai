import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer, describeFailure, HEADERS_TIMEOUT_MS, main, REQUEST_TIMEOUT_MS, runUntilSignal } from './main.ts';

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
