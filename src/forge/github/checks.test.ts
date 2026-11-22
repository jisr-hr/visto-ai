import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubChecks, MAX_CHECK_PAGES } from './checks.ts';
import type { AppAuth } from './app-auth.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const auth: AppAuth = { appToken: () => 'jwt', installationToken: async (id) => `tok-${id}` };
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
/** Answers by "<METHOD> <path and query>"; an unknown one is 404. Records each request. */
function github(routes: Record<string, () => Response>) {
  const seen: Array<{ method: string; path: string; authorization: string | null; redirect?: string; body?: Record<string, unknown> }> = [];
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = String(url).replace('https://api.github.com', '');
    const entry: (typeof seen)[number] = { method, path, authorization: new Headers(init?.headers).get('authorization') };
    if (init?.redirect) entry.redirect = init.redirect;
    if (typeof init?.body === 'string') entry.body = JSON.parse(init.body) as Record<string, unknown>;
    seen.push(entry);
    return (routes[`${method} ${path}`] ?? (() => json({ message: 'Not Found' }, 404)))();
  };
  return { seen, checks: createGithubChecks({ auth, appId: '12345', fetch: stub as typeof fetch }) };
}

const FIND = '/repos/acme/shop/commits/head222/check-runs?check_name=AI%20Review&app_id=12345&per_page=100';
const run = (id: number, extra: Record<string, unknown> = {}) => ({
  id, name: 'AI Review', app: { id: 12345 }, status: 'completed', conclusion: 'success', output: { title: `t${id}`, summary: `s${id}` }, ...extra,
});

test("the app's own check on a commit is found by its name and the app's id, the newest when there are several", async () => {
  const { checks, seen } = github({ [`GET ${FIND}`]: () => json({ check_runs: [run(71, { status: 'in_progress', conclusion: null }), run(70)] }) });
  assert.deepEqual(await checks.findCheck(REF, '99', 'head222', 'AI Review'), { id: '71', status: 'in_progress', conclusion: null, title: 't71', summary: 's71' });
  assert.deepEqual(seen.map((s) => [s.method, s.path, s.authorization]), [['GET', FIND, 'Bearer tok-99']]);
});
test("another app's check of the same name, and the app's check of another name, are not it", async () => {
  const { checks } = github({ [`GET ${FIND}`]: () => json({ check_runs: [run(80, { app: { id: 999 } }), run(81, { name: 'Other' })] }) });
  assert.equal(await checks.findCheck(REF, '99', 'head222', 'AI Review'), null);
});
test('no check gives null; an answer that is no list, and a status GitHub does not have for a check of ours, are refused', async () => {
  const none = github({ [`GET ${FIND}`]: () => json({ check_runs: [] }) });
  assert.equal(await none.checks.findCheck(REF, '99', 'head222', 'AI Review'), null);
  for (const answer of [{ check_runs: 'x' }, { check_runs: [run(71, { status: 'waiting' })] }]) {
    const { checks } = github({ [`GET ${FIND}`]: () => json(answer) });
    await assert.rejects(checks.findCheck(REF, '99', 'head222', 'AI Review'), /^Error: github_bad_response$/);
  }
  const down = github({ [`GET ${FIND}`]: () => json({}, 502) });
  await assert.rejects(down.checks.findCheck(REF, '99', 'head222', 'AI Review'), /^Error: github_502$/);
  const down2 = github({ [`GET ${FIND}`]: () => json({}, 502) });
  await assert.rejects(down2.checks.findCheck(REF, '99', 'head222', 'AI Review'), /^Error: github_502$/);
});
test('a new check is posted once, with its commit, the pull request number it is for and the pull request page', async () => {
  const { checks, seen } = github({ 'POST /repos/acme/shop/check-runs': () => json({ id: 71, status: 'queued' }, 201) });
  const write = { id: null, commit: 'head222', name: 'AI Review', status: 'queued', conclusion: null, title: 'Waiting', summary: 'Say /done' } as const;
  assert.deepEqual(await checks.writeCheck(REF, '99', write), { id: '71' });
  assert.deepEqual(seen, [{ method: 'POST', path: '/repos/acme/shop/check-runs', authorization: 'Bearer tok-99', redirect: 'manual',
    body: { name: 'AI Review', head_sha: 'head222', status: 'queued', output: { title: 'Waiting', summary: 'Say /done' }, external_id: '7', details_url: 'https://github.com/acme/shop/pull/7' } }]);
});
test('a known check is rewritten by its id, without the commit', async () => {
  const { checks, seen } = github({ 'PATCH /repos/acme/shop/check-runs/71': () => json({ id: 71, status: 'completed' }) });
  const write = { id: '71', commit: 'head222', name: 'AI Review', status: 'completed', conclusion: 'action_required', title: 'Blocked', summary: 'x' } as const;
  assert.deepEqual(await checks.writeCheck(REF, '99', write), { id: '71' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, 'PATCH');
  assert.equal(seen[0]!.redirect, 'manual');
  assert.deepEqual(seen[0]!.body, { name: 'AI Review', status: 'completed', conclusion: 'action_required', output: { title: 'Blocked', summary: 'x' }, external_id: '7', details_url: 'https://github.com/acme/shop/pull/7' });
});
test('a rewrite GitHub answers while keeping the old status is an error with its own code', async () => {
  const write = { id: '71', commit: 'head222', name: 'AI Review', status: 'in_progress', conclusion: null, title: 'Reviewing', summary: 'x' } as const;
  const kept = github({ 'PATCH /repos/acme/shop/check-runs/71': () => json({ id: 71, status: 'completed' }) });
  await assert.rejects(kept.checks.writeCheck(REF, '99', write), /^Error: check_not_rewritten$/);
  const taken = github({ 'PATCH /repos/acme/shop/check-runs/71': () => json({ id: 71, status: 'in_progress' }) });
  assert.deepEqual(await taken.checks.writeCheck(REF, '99', write), { id: '71' });
});
test('a completed check with no conclusion, and an open one with a conclusion, are refused before anything is sent', async () => {
  const { checks, seen } = github({});
  const base = { id: null, commit: 'head222', name: 'AI Review', title: 't', summary: 's' } as const;
  await assert.rejects(checks.writeCheck(REF, '99', { ...base, status: 'completed', conclusion: null }), /^Error: bad_check$/);
  await assert.rejects(checks.writeCheck(REF, '99', { ...base, status: 'queued', conclusion: 'success' }), /^Error: bad_check$/);
  assert.equal(seen.length, 0);
});
test('a write GitHub refuses or that fails has a short code and is never sent twice', async () => {
  const write = { id: null, commit: 'head222', name: 'AI Review', status: 'queued', conclusion: null, title: 't', summary: 's' } as const;
  for (const status of [403, 422, 502]) {
    const { checks, seen } = github({ 'POST /repos/acme/shop/check-runs': () => json({ message: 'no' }, status) });
    await assert.rejects(checks.writeCheck(REF, '99', write), new RegExp(`^Error: github_${status}$`));
    assert.equal(seen.length, 1);
  }
  const down = github({ 'POST /repos/acme/shop/check-runs': () => { throw new Error('socket closed'); } });
  await assert.rejects(down.checks.writeCheck(REF, '99', write), /^Error: github_network$/);
  assert.equal(down.seen.length, 1);
  const noId = github({ 'POST /repos/acme/shop/check-runs': () => json({ status: 'queued' }, 201) });
  await assert.rejects(noId.checks.writeCheck(REF, '99', write), /^Error: github_bad_response$/);
});
test('a title and a summary too long for GitHub are cut', async () => {
  const { checks, seen } = github({ 'POST /repos/acme/shop/check-runs': () => json({ id: 71, status: 'queued' }, 201) });
  const write = { id: null, commit: 'head222', name: 'AI Review', status: 'queued', conclusion: null } as const;
  await checks.writeCheck(REF, '99', { ...write, title: 'a'.repeat(300), summary: 'b'.repeat(70_000) });
  const output = seen[0]!.body!.output as { title: string; summary: string };
  assert.equal(output.title.length, 255);
  assert.equal(output.summary.length, 60_000);
  // a cut inside a surrogate pair leaves well-formed text
  await checks.writeCheck(REF, '99', { ...write, title: `${'a'.repeat(254)}\u{1F600}`, summary: `${'b'.repeat(59_999)}\u{1F600}` });
  const second = seen[1]!.body!.output as { title: string; summary: string };
  assert.equal(second.title.isWellFormed(), true);
  assert.equal(second.summary.isWellFormed(), true);
  assert.ok(second.title.length <= 255 && second.summary.length <= 60_000);
});

const STATUS = '/repos/acme/shop/commits/head222/status?per_page=100';
const RUNS = (page: number) => `/repos/acme/shop/commits/head222/check-runs?per_page=100&page=${page}`;
test('a required check is green when every place that reports it says success', async () => {
  const { checks, seen } = github({
    [`GET ${STATUS}`]: () => json({ statuses: [{ context: 'build', state: 'success' }, { context: 'lint', state: 'pending' }, { context: 'test', state: 'success' }] }),
    [`GET ${RUNS(1)}`]: () => json({ check_runs: [
      { id: 5, name: 'test', status: 'completed', conclusion: 'failure' }, { id: 9, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 6, name: 'build', status: 'completed', conclusion: 'success' }, { id: 7, name: 'deploy', status: 'in_progress', conclusion: null },
    ] }),
  });
  assert.deepEqual(await checks.greenChecks(REF, '99', 'head222', ['build', 'test', 'lint', 'deploy', 'docs']), ['build', 'test']);
  // a status success with a failed check run of the same name is not green
  const mixed = github({
    [`GET ${STATUS}`]: () => json({ statuses: [{ context: 'build', state: 'success' }] }),
    [`GET ${RUNS(1)}`]: () => json({ check_runs: [{ id: 6, name: 'build', status: 'completed', conclusion: 'failure' }] }),
  });
  assert.deepEqual(await mixed.checks.greenChecks(REF, '99', 'head222', ['build']), []);
  // no name sends nothing
  const none = github({});
  assert.deepEqual(await none.checks.greenChecks(REF, '99', 'head222', []), []);
  assert.equal(none.seen.length, 0);
  assert.equal(seen.length, 2);
});
test('the check runs of a commit are read page by page, to the cap', async () => {
  const full = (from: number) => Array.from({ length: 100 }, (_, i) => ({ id: from + i, name: 'x', status: 'completed', conclusion: 'success' }));
  const two = github({
    [`GET ${STATUS}`]: () => json({ statuses: [] }),
    [`GET ${RUNS(1)}`]: () => json({ check_runs: full(1) }),
    [`GET ${RUNS(2)}`]: () => json({ check_runs: [{ id: 500, name: 'y', status: 'completed', conclusion: 'success' }, { id: 501, name: 'z', status: 'completed', conclusion: 'success' }, { id: 502, name: 'w', status: 'queued', conclusion: null }] }),
  });
  assert.deepEqual(await two.checks.greenChecks(REF, '99', 'head222', ['y']), ['y']);
  assert.equal(two.seen.filter((s) => s.path.includes('check-runs')).length, 2);
  const routes: Record<string, () => Response> = { [`GET ${STATUS}`]: () => json({ statuses: [] }) };
  for (let p = 1; p <= MAX_CHECK_PAGES; p += 1) routes[`GET ${RUNS(p)}`] = () => json({ check_runs: full(p * 1000) });
  const many = github(routes);
  await assert.rejects(many.checks.greenChecks(REF, '99', 'head222', ['x']), /^Error: github_too_many_pages$/);
});
test('an active member of the team is a member; a pending one, and one GitHub does not find, are not', async () => {
  const PATH = '/orgs/acme/teams/release-managers/memberships/octo-lead';
  const active = github({ [`GET ${PATH}`]: () => json({ state: 'active' }) });
  assert.equal(await active.checks.isTeamMember('99', 'acme/release-managers', 'octo-lead'), true);
  assert.deepEqual(active.seen.map((s) => [s.method, s.path]), [['GET', PATH]]);
  const pending = github({ [`GET ${PATH}`]: () => json({ state: 'pending' }) });
  assert.equal(await pending.checks.isTeamMember('99', 'acme/release-managers', 'octo-lead'), false);
  const absent = github({});
  assert.equal(await absent.checks.isTeamMember('99', 'acme/release-managers', 'octo-lead'), false);
});
test('a lookup GitHub refuses or fails is an error, never "not a member"', async () => {
  const PATH = '/orgs/acme/teams/release-managers/memberships/octo-lead';
  const refused = github({ [`GET ${PATH}`]: () => json({}, 403) });
  await assert.rejects(refused.checks.isTeamMember('99', 'acme/release-managers', 'octo-lead'), /^Error: github_403$/);
  const down = github({ [`GET ${PATH}`]: () => json({}, 500) });
  await assert.rejects(down.checks.isTeamMember('99', 'acme/release-managers', 'octo-lead'), /^Error: github_500$/);
  const net = github({ [`GET ${PATH}`]: () => { throw new Error('socket closed'); } });
  await assert.rejects(net.checks.isTeamMember('99', 'acme/release-managers', 'octo-lead'), /^Error: github_network$/);
  assert.equal(net.seen.length, 2);
});
test('odd names never reach a URL', async () => {
  const { checks, seen } = github({});
  const bad = /^Error: github_bad_path$/;
  await assert.rejects(checks.isTeamMember('99', 'releasemanagers', 'octo-lead'), bad);
  await assert.rejects(checks.isTeamMember('99', 'acme/release-managers', 'octo/lead'), bad);
  await assert.rejects(checks.findCheck(REF, '99', 'he/ad', 'AI Review'), bad);
  await assert.rejects(checks.findCheck(REF, 'x', 'head222', 'AI Review'), bad);
  await assert.rejects(checks.greenChecks(REF, '99', 'he/ad', ['a']), bad);
  const write = { id: null, commit: 'head222', name: 'AI Review', status: 'queued', conclusion: null, title: 't', summary: 's' } as const;
  await assert.rejects(checks.writeCheck(REF, '99', { ...write, commit: 'a/b' }), bad);
  await assert.rejects(checks.writeCheck(REF, '99', { ...write, id: 'x' }), bad);
  await assert.rejects(checks.writeCheck(REF, 'x', write), bad);
  const badApp = createGithubChecks({ auth, appId: 'x', fetch: (async () => { throw new Error('reached'); }) as typeof fetch });
  await assert.rejects(badApp.findCheck(REF, '99', 'head222', 'AI Review'), bad);
  assert.equal(seen.length, 0);
});
