import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { clearCredentialEnv, NetworkBlockedError } from './setup.ts';

test('fetch is blocked', async () => {
  await assert.rejects(fetch('https://example.com'), NetworkBlockedError);
});
test('raw sockets are blocked', () => {
  assert.throws(() => net.connect(443, 'example.com'), NetworkBlockedError);
});
test('credential variables are cleared', () => {
  const env = { GITHUB_TOKEN: 'x', OPENROUTER_API_KEY: 'x', DATABASE_URL: 'x', APP_PRIVATE_KEY: 'x', PATH: '/bin', HOME: '/h' };
  assert.deepEqual(clearCredentialEnv(env).sort(), ['APP_PRIVATE_KEY', 'DATABASE_URL', 'GITHUB_TOKEN', 'OPENROUTER_API_KEY']);
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});
