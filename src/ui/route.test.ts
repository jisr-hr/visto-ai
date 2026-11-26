import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { enqueueJob } from '../db/jobs.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { recordRun } from '../db/review-runs.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import type { ForgeChecks, ForgeSignIn, PullRequestRef } from '../forge/types.ts';
import type { UiAnswer } from '../shell/http.ts';
import { activity, reviews } from './api.ts';
import type { ApiDeps } from './api.ts';
import { createAuth } from './auth.ts';
import type { UiFile, UiFiles } from './files.ts';
import { createUiRoute, METHODS } from './route.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const REF: PullRequestRef = { service: 'github', owner: 'acme', repo: 'shop', number: 7 };
const HEAD = 'a41c09e2b7d3f00dbabe0123456789abcdef0123';
const tokenOf = (id: string): string => createHash('sha256').update('csrf:' + id).digest('base64url');

// Call 17, written out here apart from the code.
const SECURITY = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; "
    + "manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
};
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY };
const PLAIN_HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY };
const SESSION_CLEARED = '__Host-visto_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict';
const error = (status: number, code: string, extra: Record<string, string> = {}): UiAnswer =>
  ({ status, headers: { ...extra, ...JSON_HEADERS }, body: JSON.stringify({ error: code }) });

const INDEX: UiFile = { body: Buffer.from('<!doctype html><title>Visto AI</title>'), type: 'text/html; charset=utf-8' };
const FILES: UiFiles = new Map([['/ui/index.html', INDEX]]);

interface Sent { query?: string; cookie?: string; csrf?: string }
interface Harness {
  db: Db; api: ApiDeps; logs: Array<Record<string, unknown>>;
  /** Every statement the route's parts ran. */
  statements: string[];
  /** A statement holding `text` rejects with `error`. */
  failing: { text: string | null; error: Error };
  send(method: string, path: string, sent?: Sent): Promise<UiAnswer>;
  /** A start and the way back with code-1, the browser sending back what each step set; the session's cookie as a browser sends it. */
  signIn(): Promise<{ started: UiAnswer; back: UiAnswer; cookie: string }>;
}

async function harness(): Promise<Harness> {
  const real = await testDb();
  const logs: Array<Record<string, unknown>> = [];
  const statements: string[] = [];
  const failing: Harness['failing'] = { text: null, error: new Error('db_down') };
  const spy = (inner: Db): Db => ({
    query: (text, params) => {
      statements.push(text);
      if (failing.text !== null && text.includes(failing.text)) return Promise.reject(failing.error);
      return inner.query(text, params);
    },
    script: (sql) => inner.script(sql),
    close: () => inner.close(),
    transaction: (work) => inner.transaction((tx) => work(spy(tx))),
  });
  const db = spy(real);
  const signIn: ForgeSignIn = {
    authorizeUrl: (state, challenge) => `https://github.example.test/login/oauth/authorize?state=${state}&code_challenge=${challenge}`,
    signedIn: async (code) => {
      if (code === 'code-1') return { login: 'octo-lead', isBot: false };
      throw new Error('oauth_refused');
    },
    orgInstallation: async () => null,
  };
  const checks: Pick<ForgeChecks, 'isTeamMember'> = { isTeamMember: async () => false };
  const clock = (): Date => new Date(at(0));
  const log = (entry: Record<string, unknown>): void => { logs.push(entry); };
  const auth = createAuth({ db, ui: { accounts: ['octo-lead'], team: null, publicUrl: 'https://visto.example.test' }, signIn, checks, clock, log });
  const api: ApiDeps = {
    db, clock, dryRun: true, reviewPlaces: 2, withdrawPlaces: 2, holds: () => true, paused: async () => null,
    pullRequestUrl: (ref) => `https://github.example.test/${ref.owner}/${ref.repo}/pull/${ref.number}`,
  };
  const route = createUiRoute({ auth, api, files: FILES, log });
  const send: Harness['send'] = (method, path, sent = {}) => route({
    method, path, query: sent.query ?? '', body: Buffer.alloc(0),
    headers: { host: 'visto.example.test', ...(sent.cookie === undefined ? {} : { cookie: sent.cookie }), ...(sent.csrf === undefined ? {} : { 'x-visto-csrf': sent.csrf }) },
  });
  return {
    db: real, api, logs, statements, failing, send,
    async signIn() {
      const started = await send('GET', '/api/auth/start');
      const state = new URL(String(started.headers.location)).searchParams.get('state') ?? '';
      const back = await send('GET', '/api/auth/callback', { query: `code=code-1&state=${state}`, cookie: String(started.headers['set-cookie']).split(';')[0] });
      const set = back.headers['set-cookie'];
      return { started, back, cookie: (Array.isArray(set) ? set[0] ?? '' : '').split(';')[0] ?? '' };
    },
  };
}

test('a person signs in, reads who they are, the activity and the reviews, and signs out', async () => {
  const h = await harness();
  await savePullRequest(h.db, {
    ref: REF, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feature-branch', headSha: HEAD, draft: false,
    state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0), title: 'Cache the tax table per region',
  });
  await enqueueJob(h.db, {
    ref: REF, reason: 'opened', headSha: HEAD, runAt: at(0), now: at(0), delivery: null, replace: false,
    trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: '99',
  });
  await recordRun(h.db, {
    ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: true, headSha: HEAD, baseSha: HEAD, baseBranch: 'main',
    outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 30, body: '', comments: [],
    result: { findings: [{ severity: 'major' }], verdict: { threshold: 70 } },
    usage: { calls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0.084 }, startedAt: at(-700), finishedAt: at(-659),
  });

  const { started, back, cookie } = await h.signIn();
  assert.equal(started.status, 302);
  assert.match(String(started.headers.location), /^https:\/\/github\.example\.test\/login\/oauth\/authorize\?state=[A-Za-z0-9_-]{43}&/);
  assert.deepEqual([back.status, back.headers.location], [302, '/ui/']);
  const id = /^__Host-visto_session=([A-Za-z0-9_-]{43})$/.exec(cookie)?.[1] ?? '';
  assert.notEqual(id, '');

  const who = await h.send('GET', '/api/me', { cookie });
  assert.deepEqual({ ...who, body: JSON.parse(String(who.body)) }, {
    status: 200, headers: JSON_HEADERS,
    body: { login: 'octo-lead', csrf: tokenOf(id), mode: 'dry_run', repositories: ['acme/shop'] },
  });

  const now = await h.send('GET', '/api/activity', { cookie });
  assert.deepEqual([now.status, now.headers], [200, JSON_HEADERS]);
  const expected = await activity(h.api);
  assert.equal(expected.jobs.length, 1);
  assert.deepEqual(JSON.parse(String(now.body)), expected);

  const recent = await h.send('GET', '/api/reviews', { cookie });
  assert.deepEqual([recent.status, recent.headers], [200, JSON_HEADERS]);
  const listed = await reviews(h.api, new URLSearchParams(''));
  assert.equal(listed === 'bad_request' ? 0 : listed.reviews.length, 1);
  assert.deepEqual(JSON.parse(String(recent.body)), listed);
  const filtered = await h.send('GET', '/api/reviews', { cookie, query: 'repo=Acme%2FShop&outcome=&q=%237' });
  assert.deepEqual(JSON.parse(String(filtered.body)), listed);
  assert.deepEqual(await h.send('GET', '/api/reviews', { cookie, query: 'outcome=nope' }), error(400, 'bad_request'));

  assert.deepEqual(await h.send('POST', '/api/auth/signout', { cookie }), error(403, 'csrf'));
  assert.deepEqual(await h.send('POST', '/api/auth/signout', { cookie, csrf: tokenOf('Z'.repeat(43)) }), error(403, 'csrf'));
  assert.equal((await h.send('GET', '/api/me', { cookie })).status, 200);
  assert.deepEqual(await h.send('POST', '/api/auth/signout', { cookie, csrf: tokenOf(id) }), {
    status: 204, headers: { 'set-cookie': SESSION_CLEARED, 'cache-control': 'no-store', ...SECURITY }, body: '',
  });
  assert.deepEqual(await h.send('GET', '/api/me', { cookie }), error(401, 'signed_out'));
  await h.db.close();
});

test('without a session every read is signed_out, and the sign-in routes are open', async () => {
  const h = await harness();
  const cookies = [undefined, `__Host-visto_session=${'Z'.repeat(43)}`, '__Host-visto_session=short', 'other=1'];
  for (const path of ['/api/me', '/api/activity', '/api/reviews']) {
    for (const cookie of cookies) {
      assert.deepEqual(await h.send('GET', path, cookie === undefined ? {} : { cookie }), error(401, 'signed_out'), `${path} ${String(cookie)}`);
    }
  }
  // Signing out needs a session first, whatever token is sent.
  assert.deepEqual(await h.send('POST', '/api/auth/signout', { csrf: tokenOf('Z'.repeat(43)) }), error(401, 'signed_out'));
  assert.deepEqual(await h.send('GET', '/api/reviews', { query: 'outcome=nope' }), error(401, 'signed_out'));

  const started = await h.send('GET', '/api/auth/start');
  assert.equal(started.status, 302);
  assert.match(String(started.headers.location), /^https:\/\/github\.example\.test\/login\/oauth\/authorize\?/);
  const back = await h.send('GET', '/api/auth/callback', { query: 'code=code-1&state=x' });
  assert.deepEqual([back.status, back.headers.location], [302, '/ui/signin?error=state']);

  // A path the API does not know, or a known one with another method, reads nothing.
  h.statements.length = 0;
  for (const path of ['/api/nope', '/api', '/api/', '/api/me/', '/api/auth', '/api/ME', '/api/reviews/9001']) {
    assert.deepEqual(await h.send('GET', path), error(404, 'not_found'), path);
  }
  for (const [method, path, allow] of [
    ['POST', '/api/me', 'GET'], ['PUT', '/api/activity', 'GET'], ['DELETE', '/api/reviews', 'GET'], ['HEAD', '/api/me', 'GET'],
    ['POST', '/api/auth/start', 'GET'], ['POST', '/api/auth/callback', 'GET'], ['GET', '/api/auth/signout', 'POST'], ['get', '/api/me', 'GET'],
  ] as const) {
    assert.deepEqual(await h.send(method, path, { cookie: `__Host-visto_session=${'Z'.repeat(43)}` }), error(405, 'method_not_allowed', { allow }), `${method} ${path}`);
  }
  assert.deepEqual(h.statements, []);

  // The files are open too: '/' goes to /ui/, and /ui/... is answered from them.
  assert.deepEqual(await h.send('GET', '/'), { status: 302, headers: { location: '/ui/', 'cache-control': 'no-store', ...SECURITY }, body: '' });
  assert.deepEqual(await h.send('POST', '/'), { status: 405, headers: { ...PLAIN_HEADERS, allow: 'GET' }, body: 'method_not_allowed' });
  assert.deepEqual(await h.send('GET', '/ui'), { status: 302, headers: { location: '/ui/', 'cache-control': 'no-store', ...SECURITY }, body: '' });
  for (const path of ['/ui/', '/ui/activity']) {
    assert.deepEqual(await h.send('GET', path), { status: 200, headers: { 'content-type': INDEX.type, 'cache-control': 'no-store', ...SECURITY }, body: INDEX.body }, path);
  }
  assert.deepEqual(h.statements, []);
  await h.db.close();
});

test('a handler that fails is internal_error, logged with its route and short code only', async () => {
  const h = await harness();
  const { cookie } = await h.signIn();
  const id = /^__Host-visto_session=(.*)$/.exec(cookie)?.[1] ?? '';
  const before = h.logs.length;
  for (const [method, path, text] of [
    ['GET', '/api/me', "select distinct owner || '/' || repo"],
    ['GET', '/api/activity', 'from visto_ai.jobs j'],
    ['GET', '/api/reviews', 'from visto_ai.review_runs r'],
    ['POST', '/api/auth/signout', 'delete from visto_ai.ui_sessions where id_hash'],
  ] as const) {
    h.failing.text = text;
    assert.deepEqual(await h.send(method, path, { cookie, csrf: tokenOf(id) }), error(500, 'internal_error'), path);
  }
  // A failure whose text is no short code is logged as internal_error, and its text is nowhere.
  h.failing.error = new Error('connect failed for postgres://u:p@db.example.test/d');
  h.failing.text = 'from visto_ai.jobs j';
  assert.deepEqual(await h.send('GET', '/api/activity', { cookie }), error(500, 'internal_error'));
  assert.deepEqual(h.logs.slice(before), [
    { event: 'ui_failed', route: 'me', reason: 'db_down' },
    { event: 'ui_failed', route: 'activity', reason: 'db_down' },
    { event: 'ui_failed', route: 'reviews', reason: 'db_down' },
    { event: 'ui_failed', route: 'signout', reason: 'db_down' },
    { event: 'ui_failed', route: 'activity', reason: 'internal_error' },
  ]);
  // The session the failed sign-out left still reads.
  h.failing.text = null;
  assert.equal((await h.send('GET', '/api/me', { cookie })).status, 200);
  await h.db.close();
});

test('a path the table of methods knows but no case answers is not found, and reads nothing, even signed in', async () => {
  const h = await harness();
  const { cookie } = await h.signIn();
  const id = /^__Host-visto_session=(.*)$/.exec(cookie)?.[1] ?? '';
  // The table as a later change might leave it: a path written there, its case forgotten.
  const methods = METHODS as Map<string, string>;
  methods.set('/api/later', 'GET');
  try {
    h.statements.length = 0;
    assert.deepEqual(await h.send('GET', '/api/later', { cookie, csrf: tokenOf(id) }), error(404, 'not_found'));
    assert.deepEqual(h.statements, []);
  } finally {
    methods.delete('/api/later');
  }
  assert.deepEqual([...METHODS.keys()].includes('/api/later'), false);
  await h.db.close();
});
