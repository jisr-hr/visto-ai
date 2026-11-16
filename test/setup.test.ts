import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { clearCredentialEnv, NetworkBlockedError } from './setup.ts';

test('fetch is blocked', async () => {
  await assert.rejects(fetch('https://example.com'), NetworkBlockedError);
});
test('raw sockets are blocked', () => {
  assert.throws(() => net.connect(443, 'example.com'), NetworkBlockedError);
});
test('UDP sends are blocked', () => {
  const socket = dgram.createSocket('udp4');
  try {
    assert.throws(() => socket.send('x', 53, '127.0.0.1'), NetworkBlockedError);
  } finally {
    socket.close();
  }
});
test('names holding AUTH or ending in _PAT are cleared', () => {
  const env = { GH_PAT: 'x', PAT: 'x', NPM_AUTH: 'x', AUTH_HEADER: 'x', PATH: '/bin', PATTERN: 'p', COMPAT: 'c' };
  assert.deepEqual(clearCredentialEnv(env).sort(), ['AUTH_HEADER', 'GH_PAT', 'NPM_AUTH', 'PAT']);
  assert.deepEqual(Object.keys(env).sort(), ['COMPAT', 'PATH', 'PATTERN']);
});
test('credential variables are cleared', () => {
  const env = { GITHUB_TOKEN: 'x', OPENROUTER_API_KEY: 'x', DATABASE_URL: 'x', APP_PRIVATE_KEY: 'x', PATH: '/bin', HOME: '/h' };
  assert.deepEqual(clearCredentialEnv(env).sort(), ['APP_PRIVATE_KEY', 'DATABASE_URL', 'GITHUB_TOKEN', 'OPENROUTER_API_KEY']);
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});
