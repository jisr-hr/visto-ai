import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { createAppAuth } from './app-auth.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const NOW = Date.parse('2026-03-01T10:00:00.000Z');
function setup(answers: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let now = NOW;
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (next === undefined) throw new Error('no answer left');
    if (next instanceof Error) throw next;
    return next;
  };
  const auth = createAppAuth({ appId: '12345', privateKey: PEM, clock: () => new Date(now), fetch: stub as typeof fetch });
  return { auth, calls, advance: (ms: number): void => { now += ms; } };
}
const minted = (token: string, expiresAt: string | null): Response =>
  new Response(JSON.stringify(expiresAt === null ? { token } : { token, expires_at: expiresAt }), { status: 201 });
const decode = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const MINUTE = 60_000;

test('the app token is an RS256 token for the app, valid from a minute ago for nine more', () => {
  const [h, p, s] = setup([]).auth.appToken().split('.') as [string, string, string];
  assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decode(p), { iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: '12345' });
  assert.equal(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, s, 'base64url'), true);
});
test('an installation token is minted with the app token', async () => {
  const { auth, calls } = setup([minted('t-1', '2026-03-01T11:00:00Z')]);
  assert.equal(await auth.installationToken('99'), 't-1');
  assert.equal(calls[0]!.url, 'https://api.github.com/app/installations/99/access_tokens');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.match(String(new Headers(calls[0]!.init.headers).get('authorization')), /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
});
test('a token is reused while it has ten minutes or more left', async () => {
  const { auth, calls, advance } = setup([minted('t-1', '2026-03-01T11:00:00Z'), minted('t-2', '2026-03-01T12:00:00Z')]);
  await auth.installationToken('99');
  advance(49 * MINUTE);
  assert.equal(await auth.installationToken('99'), 't-1');
  advance(2 * MINUTE);
  assert.equal(await auth.installationToken('99'), 't-2');
  assert.equal(calls.length, 2);
});
test('an answer with no expiry is treated as valid for one hour', async () => {
  const { auth, calls, advance } = setup([minted('t-1', null), minted('t-2', null)]);
  await auth.installationToken('99');
  advance(49 * MINUTE);
  await auth.installationToken('99');
  assert.equal(calls.length, 1);
  advance(2 * MINUTE);
  assert.equal(await auth.installationToken('99'), 't-2');
});
test('callers that ask together share one mint, and each installation has its own token', async () => {
  const { auth, calls } = setup([minted('t-99', '2026-03-01T11:00:00Z'), minted('t-100', '2026-03-01T11:00:00Z')]);
  assert.deepEqual(await Promise.all([auth.installationToken('99'), auth.installationToken('99')]), ['t-99', 't-99']);
  assert.equal(await auth.installationToken('100'), 't-100');
  assert.equal(calls.length, 2);
});
test('a refused mint rejects with the status as its code, is not cached, and its error holds no token', async () => {
  const { auth, calls } = setup([new Response('{"message":"Bad credentials"}', { status: 401 }), minted('t-1', '2026-03-01T11:00:00Z')]);
  await assert.rejects(auth.installationToken('99'), (e: unknown) => e instanceof Error && e.message === 'github_401');
  assert.equal(await auth.installationToken('99'), 't-1');
  assert.equal(calls.length, 2);
});
test('an answer with no token, or that is not JSON, is refused', async () => {
  await assert.rejects(setup([new Response('{"token":""}', { status: 201 })]).auth.installationToken('99'), /^Error: github_bad_response$/);
  await assert.rejects(setup([new Response('nope', { status: 201 })]).auth.installationToken('99'), /^Error: github_bad_response$/);
});
test('an installation id that is not digits is refused before any request', async () => {
  const { auth, calls } = setup([]);
  await assert.rejects(auth.installationToken('9/9'), /^Error: github_bad_path$/);
  assert.equal(calls.length, 0);
});
test('a server error or a network failure is tried once more', async () => {
  const flaky = setup([new Response('', { status: 502 }), minted('t-1', '2026-03-01T11:00:00Z')]);
  assert.equal(await flaky.auth.installationToken('99'), 't-1');
  await assert.rejects(setup([new Error('down'), new Error('down')]).auth.installationToken('99'), /^Error: github_network$/);
});
test('a key that cannot be read is refused when the app identity is built', () => {
  const noFetch = (async () => new Response('')) as typeof fetch;
  assert.throws(() => createAppAuth({ appId: '12345', privateKey: 'not-a-key-value', clock: () => new Date(NOW), fetch: noFetch }),
    (e: unknown) => e instanceof Error && e.message === 'bad_private_key');
});
