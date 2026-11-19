import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppInfo } from '../types.ts';
import type { AppAuth } from './app-auth.ts';
import { createAppInfo, missingFor } from './app-info.ts';

const auth: AppAuth = { appToken: () => 'jwt', installationToken: async () => 'unused' };

function setup(answers: Array<Response | Error>) {
  const calls: Array<{ url: string; authorization: string }> = [];
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get('authorization') ?? '' });
    const next = answers.shift();
    if (next === undefined) throw new Error('no answer left');
    if (next instanceof Error) throw next;
    return next;
  };
  return { info: createAppInfo({ auth, fetch: stub as typeof fetch }), calls };
}

const APP = { slug: 'visto-test', permissions: { pull_requests: 'write', contents: 'read' }, events: ['pull_request', 'issue_comment'] };
const FULL: AppInfo = { botLogin: 'visto-test[bot]', permissions: { pull_requests: 'write', contents: 'read', issues: 'write' },
  events: ['pull_request', 'issue_comment', 'pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread'] };

test('the app is read with its own token and remembered', async () => {
  const { info, calls } = setup([new Response(JSON.stringify(APP))]);
  const expected = { botLogin: 'visto-test[bot]', permissions: { pull_requests: 'write', contents: 'read' }, events: ['pull_request', 'issue_comment'] };
  assert.deepEqual(await info.read(), expected);
  assert.deepEqual(await info.read(), expected);
  assert.deepEqual(calls, [{ url: 'https://api.github.com/app', authorization: 'Bearer jwt' }]);
});
test('a failure is not remembered, and callers that ask together share one request', async () => {
  const { info, calls } = setup([new Response('', { status: 401 }), new Response(JSON.stringify(APP))]);
  await assert.rejects(info.read(), /^Error: github_401$/);
  const [a, b] = await Promise.all([info.read(), info.read()]);
  assert.deepEqual([a.botLogin, b.botLogin, calls.length], ['visto-test[bot]', 'visto-test[bot]', 2]);
});
test('an answer of another shape is refused', async () => {
  for (const broken of [{ ...APP, slug: '' }, { ...APP, permissions: [] }, { ...APP, events: 'all' }, { ...APP, permissions: { contents: 1 } }]) {
    await assert.rejects(setup([new Response(JSON.stringify(broken))]).info.read(), /^Error: github_bad_response$/);
  }
});
test('a failure to reach the git service has its own code', async () => {
  await assert.rejects(setup([new Error('down')]).info.read(), /^Error: github_network$/);
});
test('an app that has everything lacks nothing', () => {
  assert.deepEqual(missingFor(FULL, false), []);
  assert.deepEqual(missingFor({ ...FULL, permissions: { pull_requests: 'admin', contents: 'write', issues: 'admin' } }, false), []);
});
test('in dry run, read access is enough', () => {
  assert.deepEqual(missingFor({ ...FULL, permissions: { pull_requests: 'read', contents: 'read' } }, true), []);
});
test('each thing an app lacks is named with the feature it switches off', () => {
  assert.deepEqual(missingFor({ botLogin: 'visto-test[bot]', permissions: { pull_requests: 'read' }, events: ['pull_request'] }, false), [
    { feature: 'reviews', missing: 'contents:read' },
    { feature: 'publishing', missing: 'pull_requests:write' },
    { feature: 'commands', missing: 'issues:write' },
    { feature: 'commands', missing: 'event:issue_comment' },
    { feature: 'capture', missing: 'event:pull_request_review' },
    { feature: 'capture', missing: 'event:pull_request_review_comment' },
    { feature: 'capture', missing: 'event:pull_request_review_thread' },
    { feature: 'capture', missing: 'event:issue_comment' },
  ]);
});
test('lacks reads the app and says what is missing', async () => {
  const { info } = setup([new Response(JSON.stringify(APP))]);
  assert.deepEqual((await info.lacks(false)).map((m) => m.missing), ['issues:write', 'event:pull_request_review', 'event:pull_request_review_comment', 'event:pull_request_review_thread']);
});
