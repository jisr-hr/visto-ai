import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer, HEADERS_TIMEOUT_MS, main, REQUEST_TIMEOUT_MS } from './main.ts';

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
