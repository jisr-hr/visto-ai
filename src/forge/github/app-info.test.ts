import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppInfo } from '../types.ts';
import type { AppAuth } from './app-auth.ts';
import { createAppInfo, missingFor } from './app-info.ts';
import manifest from './app-manifest.json' with { type: 'json' };

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
const FULL: AppInfo = { botLogin: 'visto-test[bot]', permissions: { pull_requests: 'write', contents: 'write', issues: 'write' },
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
    { feature: 'resolving', missing: 'contents:write' },
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
  assert.deepEqual((await info.lacks(false)).map((m) => m.missing), ['contents:write', 'issues:write', 'event:pull_request_review', 'event:pull_request_review_comment', 'event:pull_request_review_thread']);
});
test('resolving is lacking out of dry run when contents is only read, and not otherwise', () => {
  const read = { ...FULL, permissions: { ...FULL.permissions, contents: 'read' } };
  assert.deepEqual(missingFor(read, false), [{ feature: 'resolving', missing: 'contents:write' }]);
  assert.deepEqual(missingFor(read, true), []);
  assert.deepEqual(missingFor(FULL, false), []);
});
test('canResolve is true for write and admin contents only', async () => {
  for (const [level, expected] of [['read', false], ['write', true], ['admin', true]] as const) {
    const { info } = setup([new Response(JSON.stringify({ ...APP, permissions: { contents: level } }))]);
    assert.equal(await info.canResolve(), expected);
  }
  assert.equal(await setup([new Response(JSON.stringify({ ...APP, permissions: {} }))]).info.canResolve(), false);
});

const NOTHING = { check: false, statuses: false, members: false };
const TODAYS: AppInfo = { ...FULL, permissions: { pull_requests: 'write', contents: 'write', issues: 'write', metadata: 'read' } };
test('with no gate configured the app lacks what it lacked before', () => {
  const bare: AppInfo = { botLogin: 'visto-test[bot]', permissions: {}, events: [] };
  assert.deepEqual(missingFor(bare, false), missingFor(bare, false, NOTHING));
  assert.deepEqual(missingFor(bare, true), missingFor(bare, true, NOTHING));
  assert.deepEqual(missingFor(TODAYS, false, NOTHING), []);
});
test('a configured gate needs the check permission and the check_run event; required checks need statuses; a skip team needs members', () => {
  assert.deepEqual(missingFor(TODAYS, false, { ...NOTHING, check: true }), [
    { feature: 'gate', missing: 'checks:write' }, { feature: 'gate', missing: 'event:check_run' },
  ]);
  assert.deepEqual(missingFor(TODAYS, false, { ...NOTHING, statuses: true }), [{ feature: 'gate', missing: 'statuses:read' }]);
  assert.deepEqual(missingFor(TODAYS, false, { ...NOTHING, members: true }), [{ feature: 'gate', missing: 'members:read' }]);
  const read: AppInfo = { ...TODAYS, permissions: { ...TODAYS.permissions, checks: 'read' }, events: [...TODAYS.events, 'check_run'] };
  assert.deepEqual(missingFor(read, false, { ...NOTHING, check: true }), [{ feature: 'gate', missing: 'checks:write' }]);
  const full: AppInfo = { ...TODAYS, permissions: { ...TODAYS.permissions, checks: 'write', statuses: 'read', members: 'read' }, events: [...TODAYS.events, 'check_run'] };
  assert.deepEqual(missingFor(full, false, { check: true, statuses: true, members: true }), []);
});
test('in dry run the gate needs nothing', () => {
  const all = { check: true, statuses: true, members: true };
  assert.deepEqual(missingFor(TODAYS, true, all), []);
  assert.deepEqual(missingFor(TODAYS, true, all), missingFor(TODAYS, true));
});
test('lacks passes what the gate needs on', async () => {
  const { info } = setup([new Response(JSON.stringify({ ...APP, events: FULL.events, permissions: TODAYS.permissions }))]);
  assert.deepEqual((await info.lacks(false, { ...NOTHING, check: true })).map((m) => m.missing), ['checks:write', 'event:check_run']);
});

test('with approval on and out of dry run the app needs administration read, pull requests write and the review event', () => {
  const permissions: Record<string, string> = { ...manifest.default_permissions };
  delete permissions.administration;
  const withoutAdministration: AppInfo = { botLogin: 'visto-test[bot]', permissions, events: manifest.default_events };
  assert.deepEqual(missingFor(withoutAdministration, false, undefined, true), [{ feature: 'approval', missing: 'administration:read' }]);
  assert.deepEqual(missingFor(withoutAdministration, true, undefined, true), []);
  assert.deepEqual(missingFor(withoutAdministration, false), []);
  assert.deepEqual(missingFor(withoutAdministration, false, undefined, false), []);
  const readOnly: AppInfo = { ...withoutAdministration, permissions: { ...permissions, administration: 'read', pull_requests: 'read' } };
  assert.deepEqual(missingFor(readOnly, false, undefined, true).filter((m) => m.feature === 'approval'), [{ feature: 'approval', missing: 'pull_requests:write' }]);
  const unsubscribed: AppInfo = { ...withoutAdministration, permissions: { ...permissions, administration: 'write' }, events: manifest.default_events.filter((e) => e !== 'pull_request_review') };
  assert.deepEqual(missingFor(unsubscribed, false, undefined, true).filter((m) => m.feature === 'approval'), [{ feature: 'approval', missing: 'event:pull_request_review' }]);
  const bare: AppInfo = { botLogin: 'visto-test[bot]', permissions: {}, events: [] };
  assert.deepEqual(missingFor(bare, false, undefined, true).filter((m) => m.feature === 'approval'), [
    { feature: 'approval', missing: 'administration:read' }, { feature: 'approval', missing: 'pull_requests:write' }, { feature: 'approval', missing: 'event:pull_request_review' },
  ]);
  assert.deepEqual(missingFor(bare, true, undefined, true), missingFor(bare, true));
});
test('lacks passes approval on', async () => {
  const { info } = setup([new Response(JSON.stringify({ ...APP, events: FULL.events, permissions: TODAYS.permissions }))]);
  assert.deepEqual((await info.lacks(false, NOTHING, true)).map((m) => [m.feature, m.missing]), [['approval', 'administration:read']]);
  assert.deepEqual((await info.lacks(false, NOTHING)).map((m) => m.missing), []);
});

test("with the UI's team named, the app lacks members read when it has not got it, in dry run too", () => {
  assert.deepEqual(missingFor(FULL, true, undefined, false, true), [{ feature: 'ui', missing: 'members:read' }]);
  assert.deepEqual(missingFor(FULL, false, undefined, false, true), [{ feature: 'ui', missing: 'members:read' }]);
  for (const level of ['read', 'write', 'admin']) {
    const members: AppInfo = { ...FULL, permissions: { ...FULL.permissions, members: level } };
    assert.deepEqual(missingFor(members, true, undefined, false, true), [], level);
    assert.deepEqual(missingFor(members, false, undefined, false, true), [], level);
  }
});
test('with no team named, the app lacks what it lacked', () => {
  const bare: AppInfo = { botLogin: 'visto-test[bot]', permissions: {}, events: [] };
  for (const info of [bare, FULL, TODAYS]) {
    for (const dryRun of [true, false]) {
      for (const gate of [undefined, NOTHING, { check: true, statuses: true, members: true }]) {
        for (const approval of [undefined, false, true]) {
          const before = missingFor(info, dryRun, gate, approval);
          assert.deepEqual(missingFor(info, dryRun, gate, approval, undefined), before);
          assert.deepEqual(missingFor(info, dryRun, gate, approval, false), before);
        }
      }
    }
  }
});
test("lacks passes the UI's team on", async () => {
  const { info } = setup([new Response(JSON.stringify({ ...APP, events: FULL.events, permissions: TODAYS.permissions }))]);
  assert.deepEqual((await info.lacks(true, undefined, undefined, true)).map((m) => [m.feature, m.missing]), [['ui', 'members:read']]);
  assert.deepEqual((await info.lacks(true, undefined, undefined, false)).map((m) => m.missing), []);
  assert.deepEqual((await info.lacks(true)).map((m) => m.missing), []);
});
