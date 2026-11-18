import assert from 'node:assert/strict';
import test from 'node:test';

import { createGithubHistorySource } from './history-source.ts';
import { createGithubHttp, ReadOnlyViolation } from './http.ts';

const TOKEN = 'ghp_invented0token0value0123';

function counting(response: () => Response): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchStub = (() => {
    calls += 1;
    return Promise.resolve(response());
  }) as typeof fetch;
  return { fetch: fetchStub, calls: () => calls };
}

test('a method other than GET is refused before any request', async () => {
  const stub = counting(() => new Response('{}', { status: 200 }));
  const http = createGithubHttp({ token: TOKEN, fetch: stub.fetch });
  for (const method of ['POST', 'get', 'PUT', 'DELETE']) {
    await assert.rejects(http.send(method, 'https://api.github.com/repos/acme/shop', 'application/json'), ReadOnlyViolation, method);
  }
  assert.equal(stub.calls(), 0);
});

test('a failing response that echoes the token does not put it in the thrown error', async () => {
  const stub = counting(() => new Response(`Bad credentials for ${TOKEN}`, { status: 401 }));
  const source = createGithubHistorySource({ token: TOKEN, fetch: stub.fetch });
  const error = await source.listReviews({ owner: 'acme', repo: 'shop' }, 1).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'github_401');
  assert.ok(!error.message.includes(TOKEN));
  assert.ok(!(error.stack ?? '').includes(TOKEN));
  assert.equal(stub.calls(), 1);
});
