import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { enqueueJob } from '../db/jobs.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { recordRun } from '../db/review-runs.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { insertAccount } from '../db/ui-accounts.ts';
import type { AccountRow, Role } from '../db/ui-accounts.ts';
import type { ForgeChecks, ForgeSignIn, PullRequestRef } from '../forge/types.ts';
import type { UiAnswer } from '../shell/http.ts';
import { createAccountChanges } from './accounts.ts';
import { activity, reviews } from './api.ts';
import type { ApiDeps } from './api.ts';
import { createAuth } from './auth.ts';
import type { UiFile, UiFiles } from './files.ts';
import { createPasswordAuth } from './password-auth.ts';
import { hashPassword } from './passwords.ts';
import { createUiRoute, METHODS } from './route.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const REF: PullRequestRef = { service: 'github', owner: 'acme', repo: 'shop', number: 7 };
const HEAD = 'a41c09e2b7d3f00dbabe0123456789abcdef0123';
const tokenOf = (id: string): string => createHash('sha256').update('csrf:' + id).digest('base64url');
const COST = { log2N: 4, r: 1, p: 1 };
const ORIGIN = 'https://visto.example.test';
const JSON_TYPE = 'application/json';
const PASSWORD = 'a long password of mine';
const OTHER = 'another long password';

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

interface Sent { query?: string; cookie?: string; csrf?: string; body?: string; origin?: string; type?: string }
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

/** `github` false: a route with GitHub sign-in off, and auth given no sign-in. */
async function harness(github = true): Promise<Harness> {
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
  const auth = createAuth({ db, ui: { accounts: ['octo-lead'], team: null, publicUrl: 'https://visto.example.test' }, signIn: github ? signIn : null, checks, clock, log });
  const api: ApiDeps = {
    db, clock, dryRun: true, reviewPlaces: 2, withdrawPlaces: 2, holds: () => true, paused: async () => null,
    pullRequestUrl: (ref) => `https://github.example.test/${ref.owner}/${ref.repo}/pull/${ref.number}`,
  };
  const route = createUiRoute({
    auth, passwords: createPasswordAuth({ db, clock, log, cost: COST }), accounts: createAccountChanges({ db, clock, log, cost: COST }), api, files: FILES,
    ui: { publicUrl: 'https://visto.example.test', github }, log,
  });
  const send: Harness['send'] = (method, path, sent = {}) => route({
    method, path, query: sent.query ?? '', body: sent.body === undefined ? Buffer.alloc(0) : Buffer.from(sent.body),
    headers: {
      host: 'visto.example.test', ...(sent.cookie === undefined ? {} : { cookie: sent.cookie }), ...(sent.csrf === undefined ? {} : { 'x-visto-csrf': sent.csrf }),
      ...(sent.origin === undefined ? {} : { origin: sent.origin }), ...(sent.type === undefined ? {} : { 'content-type': sent.type }),
    },
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
    body: { name: 'octo-lead', kind: 'github', role: 'viewer', csrf: tokenOf(id), mode: 'dry_run', repositories: ['acme/shop'] },
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

test('a session read that rejects is internal_error, not a sign-out, logged once with its route and no text of the error', async () => {
  const h = await harness();
  const { cookie } = await h.signIn();
  const before = h.logs.length;
  h.failing.error = new Error('connect failed for postgres://u:p@db.example.test/d');
  h.failing.text = 'select s.via, s.last_used_at';
  assert.deepEqual(await h.send('GET', '/api/me', { cookie }), error(500, 'internal_error'));
  assert.deepEqual(h.logs.slice(before), [{ event: 'ui_failed', route: 'me', reason: 'internal_error' }]);
  assert.ok(!JSON.stringify(h.logs).includes('postgres'));
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

// -- password sign-in, the accounts and the roles (the password design 4.3 and 4.5) ------------------------------------

const NO_CONTENT: UiAnswer = { status: 204, headers: { 'cache-control': 'no-store', ...SECURITY }, body: '' };
const ONE_TIME = 'k7m2q9xh4wz8r3bt6pn5';
const ONE_TIME_SHAPE = /^[23456789abcdefghjkmnpqrstuvwxyz]{20}$/;
const SESSION_ID_OF = /^__Host-visto_session=([A-Za-z0-9_-]{43})$/;

/** A password account made by statements, an hour before the clock: its password chosen (PASSWORD), or a one-time password until `until`. */
async function account(h: Harness, name: string, role: Role, oneTime?: { password: string; until: string }): Promise<AccountRow> {
  const made = await insertAccount(h.db, {
    kind: 'password', name, role, passwordHash: await hashPassword(oneTime?.password ?? PASSWORD, COST), oneTimeUntil: oneTime?.until ?? null,
    at: at(-3600), by: 'command', byName: null, signedInAt: null,
  });
  assert.notEqual(made, null);
  return made!;
}

/** A GitHub account made by statements, as its first sign-in half an hour before the clock makes it. */
async function githubRow(h: Harness, login: string): Promise<AccountRow> {
  const made = await insertAccount(h.db, {
    kind: 'github', name: login, role: 'viewer', passwordHash: null, oneTimeUntil: null, at: at(-1800), by: 'sign_in', byName: null, signedInAt: at(-1800),
  });
  assert.notEqual(made, null);
  return made!;
}

/** The cookie an answer sets, as a browser sends it back, and the session id in it ('' for none). */
function cookieOf(answer: UiAnswer): { cookie: string; id: string } {
  const set = answer.headers['set-cookie'];
  const cookie = String((Array.isArray(set) ? set[0] : set) ?? '').split(';')[0] ?? '';
  return { cookie, id: SESSION_ID_OF.exec(cookie)?.[1] ?? '' };
}

/** A password sign-in from the UI's own page: its answer, and the cookie it set. */
async function passwordSignIn(h: Harness, name: string, password = PASSWORD): Promise<{ answer: UiAnswer; cookie: string; id: string }> {
  const answer = await h.send('POST', '/api/auth/password', { origin: ORIGIN, type: JSON_TYPE, body: JSON.stringify({ name, password }) });
  return { answer, ...cookieOf(answer) };
}

test('a password account signs in, reads who it is with its role, and an admin reads the accounts', async () => {
  const h = await harness();
  const admin = await account(h, 'octo-admin', 'admin');
  const lead = await githubRow(h, 'octo-lead');
  const { answer, cookie, id } = await passwordSignIn(h, 'octo-admin');
  assert.notEqual(id, '');
  assert.deepEqual(answer, {
    status: 200, headers: { 'set-cookie': `__Host-visto_session=${id}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`, ...JSON_HEADERS },
    body: JSON.stringify({ next: 'signed_in' }),
  });

  const who = await h.send('GET', '/api/me', { cookie });
  assert.deepEqual({ ...who, body: JSON.parse(String(who.body)) }, {
    status: 200, headers: JSON_HEADERS,
    body: { name: 'octo-admin', kind: 'password', role: 'admin', csrf: tokenOf(id), mode: 'dry_run', repositories: [] },
  });

  const listed = await h.send('GET', '/api/accounts', { cookie });
  assert.deepEqual([listed.status, listed.headers], [200, JSON_HEADERS]);
  assert.deepEqual(JSON.parse(String(listed.body)), {
    now: at(0), accounts: [
      { id: admin.id, kind: 'password', name: 'octo-admin', role: 'admin', password: 'set', waitsUntil: null, madeAt: at(-3600),
        madeBy: { kind: 'command', name: null }, lastSignInAt: at(0), you: true },
      { id: lead.id, kind: 'github', name: 'octo-lead', role: 'viewer', password: null, waitsUntil: null, madeAt: at(-1800),
        madeBy: { kind: 'sign_in', name: null }, lastSignInAt: at(-1800), you: false },
    ],
  });
  assert.ok(!String(listed.body).includes('scrypt$'));

  // A right one-time password asks for a password and sets no cookie; the first password then signs in.
  await account(h, 'octo-new', 'viewer', { password: ONE_TIME, until: at(3600) });
  const asked = await passwordSignIn(h, 'octo-new', ONE_TIME);
  assert.deepEqual(asked.answer, { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ next: 'choose_password' }) });
  const chosen = await h.send('POST', '/api/auth/first-password', {
    origin: ORIGIN, type: JSON_TYPE, body: JSON.stringify({ name: 'octo-new', oneTimePassword: ONE_TIME, password: OTHER }),
  });
  const after = cookieOf(chosen);
  assert.notEqual(after.id, '');
  assert.deepEqual([chosen.status, chosen.body], [200, JSON.stringify({ next: 'signed_in' })]);
  const now = JSON.parse(String((await h.send('GET', '/api/me', { cookie: after.cookie })).body)) as Record<string, unknown>;
  assert.deepEqual([now.name, now.kind, now.role], ['octo-new', 'password', 'viewer']);
  assert.equal((await passwordSignIn(h, 'octo-new', OTHER)).answer.status, 200);
  await h.db.close();
});

test('a viewer is refused every admin route as forbidden, whatever it sends, and a change without the token is csrf first', async () => {
  const h = await harness();
  const admin = await account(h, 'octo-admin', 'admin');
  const viewer = await account(h, 'octo-viewer', 'viewer');
  const { cookie, id } = await passwordSignIn(h, 'octo-viewer');
  const csrf = tokenOf(id);
  const changes: Array<[string, Record<string, unknown>]> = [
    ['/api/accounts/new', { name: 'octo-new', role: 'admin' }], ['/api/accounts/role', { id: viewer.id, role: 'admin' }],
    ['/api/accounts/reset', { id: admin.id }], ['/api/accounts/remove', { id: admin.id }],
  ];
  h.statements.length = 0;
  let requests = 0;
  const send = (method: string, path: string, sent: Sent): Promise<UiAnswer> => { requests += 1; return h.send(method, path, sent); };
  assert.deepEqual(await send('GET', '/api/accounts', { cookie }), error(403, 'forbidden'));
  for (const [path, body] of changes) {
    const good = JSON.stringify(body);
    assert.deepEqual(await send('POST', path, { cookie, csrf, type: JSON_TYPE, body: good }), error(403, 'forbidden'), path);
    assert.deepEqual(await send('POST', path, { cookie, type: JSON_TYPE, body: good }), error(403, 'csrf'), path);
    assert.deepEqual(await send('POST', path, { cookie, csrf: tokenOf('Z'.repeat(43)), type: JSON_TYPE, body: good }), error(403, 'csrf'), path);
    // The role before the body.
    assert.deepEqual(await send('POST', path, { cookie, csrf, type: 'text/plain', body: 'x' }), error(403, 'forbidden'), path);
    assert.deepEqual(await send('POST', path, { cookie, csrf, type: JSON_TYPE, body: '[]' }), error(403, 'forbidden'), path);
  }
  // No statement on the accounts but the session read, once a request.
  const read = h.statements.filter((text) => text.includes('ui_accounts'));
  assert.equal(read.length, requests);
  assert.ok(read.every((text) => text.includes('from visto_ai.ui_sessions s join visto_ai.ui_accounts a on a.id = s.account_id')));
  // Without a session, each is signed_out first.
  assert.deepEqual(await h.send('GET', '/api/accounts'), error(401, 'signed_out'));
  for (const [path, body] of changes) {
    assert.deepEqual(await h.send('POST', path, { csrf, type: JSON_TYPE, body: JSON.stringify(body) }), error(401, 'signed_out'), path);
  }
  assert.deepEqual(await h.db.query('select name, role from visto_ai.ui_accounts order by name'), [
    { name: 'octo-admin', role: 'admin' }, { name: 'octo-viewer', role: 'viewer' },
  ]);
  await h.db.close();
});

test('the password sign-in and the first password need the public origin and JSON, and say so before reading anything', async () => {
  const h = await harness();
  await account(h, 'octo-admin', 'admin');
  const bodies: Array<[string, string]> = [
    ['/api/auth/password', JSON.stringify({ name: 'octo-admin', password: PASSWORD })],
    ['/api/auth/first-password', JSON.stringify({ name: 'octo-admin', oneTimePassword: PASSWORD, password: OTHER })],
  ];
  h.statements.length = 0;
  const before = h.logs.length;
  for (const [path, good] of bodies) {
    for (const origin of [undefined, 'https://other.example.test', 'https://visto.example.test/', 'null', 'http://visto.example.test', 'HTTPS://VISTO.EXAMPLE.TEST']) {
      const sent: Sent = { type: JSON_TYPE, body: good, ...(origin === undefined ? {} : { origin }) };
      assert.deepEqual(await h.send('POST', path, sent), error(403, 'origin'), `${path} ${String(origin)}`);
    }
    // The origin before the type: a form posted from another site is refused as such.
    assert.deepEqual(await h.send('POST', path, { origin: 'https://other.example.test', type: 'application/x-www-form-urlencoded', body: 'a=1' }), error(403, 'origin'), path);
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', undefined, 'text/json', 'application/jsonp', 'application/json-patch+json']) {
      const sent: Sent = { origin: ORIGIN, body: good, ...(type === undefined ? {} : { type }) };
      assert.deepEqual(await h.send('POST', path, sent), error(415, 'not_json'), `${path} ${String(type)}`);
    }
    for (const body of ['[]', 'null', '7', '{', '', '"text"', '[{"name":"octo-admin"}]']) {
      assert.deepEqual(await h.send('POST', path, { origin: ORIGIN, type: JSON_TYPE, body }), error(400, 'bad_request'), `${path} ${body}`);
    }
  }
  assert.deepEqual(h.statements, []);
  assert.deepEqual(h.logs.slice(before), []);

  // With a charset, and in capitals, the body is read.
  const read = await h.send('POST', '/api/auth/password', { origin: ORIGIN, type: 'application/json; charset=utf-8', body: bodies[0]![1] });
  assert.deepEqual([read.status, read.body], [200, JSON.stringify({ next: 'signed_in' })]);
  const capitals = await h.send('POST', '/api/auth/first-password', { origin: ORIGIN, type: 'Application/JSON', body: bodies[1]![1] });
  assert.deepEqual(capitals, error(409, 'already_chosen'));
  assert.notDeepEqual(h.statements, []);
  await h.db.close();
});

test('a role changed takes effect at the next request of the session it was changed for', async () => {
  const h = await harness();
  await account(h, 'octo-admin', 'admin');
  const viewer = await account(h, 'octo-viewer', 'viewer');
  const a = await passwordSignIn(h, 'octo-admin');
  const v = await passwordSignIn(h, 'octo-viewer');
  const change = (path: string, body: Record<string, unknown>): Promise<UiAnswer> =>
    h.send('POST', path, { cookie: a.cookie, csrf: tokenOf(a.id), type: JSON_TYPE, body: JSON.stringify(body) });
  const roleOf = async (): Promise<unknown> => (JSON.parse(String((await h.send('GET', '/api/me', { cookie: v.cookie })).body)) as Record<string, unknown>).role;

  assert.deepEqual(await h.send('GET', '/api/accounts', { cookie: v.cookie }), error(403, 'forbidden'));
  const made = await change('/api/accounts/role', { id: viewer.id, role: 'admin' });
  assert.deepEqual({ ...made, body: JSON.parse(String(made.body)) }, {
    status: 200, headers: JSON_HEADERS,
    body: { account: {
      id: viewer.id, kind: 'password', name: 'octo-viewer', role: 'admin', password: 'set', waitsUntil: null, madeAt: at(-3600),
      madeBy: { kind: 'command', name: null }, lastSignInAt: at(0), you: false,
    } },
  });
  assert.equal(await roleOf(), 'admin');
  assert.equal((await h.send('GET', '/api/accounts', { cookie: v.cookie })).status, 200);

  assert.equal((await change('/api/accounts/role', { id: viewer.id, role: 'viewer' })).status, 200);
  assert.deepEqual(await h.send('GET', '/api/accounts', { cookie: v.cookie }), error(403, 'forbidden'));
  assert.equal(await roleOf(), 'viewer');

  assert.deepEqual(await change('/api/accounts/remove', { id: viewer.id }), NO_CONTENT);
  assert.deepEqual(await h.send('GET', '/api/accounts', { cookie: v.cookie }), error(401, 'signed_out'));
  assert.deepEqual(await h.send('GET', '/api/me', { cookie: v.cookie }), error(401, 'signed_out'));
  assert.equal((await h.send('GET', '/api/accounts', { cookie: a.cookie })).status, 200);
  await h.db.close();
});

test('with GitHub sign-in off the ways say so, and the start and the way back are not found', async () => {
  const off = await harness(false);
  await account(off, 'octo-admin', 'admin');
  off.statements.length = 0;
  assert.deepEqual(await off.send('GET', '/api/auth/ways'), { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ github: false }) });
  assert.deepEqual(await off.send('GET', '/api/auth/start'), error(404, 'not_found'));
  assert.deepEqual(await off.send('GET', '/api/auth/callback', { query: 'code=code-1&state=x' }), error(404, 'not_found'));
  assert.deepEqual(await off.send('POST', '/api/auth/ways'), error(405, 'method_not_allowed', { allow: 'GET' }));
  assert.deepEqual(off.statements, []);
  assert.deepEqual(off.logs, []);
  // Password sign-in is there all the same.
  assert.equal((await passwordSignIn(off, 'octo-admin')).answer.status, 200);
  await off.db.close();

  const on = await harness();
  assert.deepEqual(await on.send('GET', '/api/auth/ways'), { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ github: true }) });
  assert.equal((await on.send('GET', '/api/auth/start')).status, 302);
  await on.db.close();
});

test('each account route answers each refusal with its status and code', async () => {
  const h = await harness();
  const admin = await account(h, 'octo-admin', 'admin');
  const lead = await githubRow(h, 'octo-lead');
  const a = await passwordSignIn(h, 'octo-admin');
  const csrf = tokenOf(a.id);
  const post = (path: string, body: unknown, cookie = a.cookie, token = csrf): Promise<UiAnswer> =>
    h.send('POST', path, { cookie, csrf: token, type: JSON_TYPE, body: JSON.stringify(body) });

  assert.deepEqual(await post('/api/accounts/new', { name: 'Octo', role: 'viewer' }), error(400, 'bad_name'));
  const made = await post('/api/accounts/new', { name: 'octo-new', role: 'viewer' });
  const madeBody = JSON.parse(String(made.body)) as { account: { id: number }; oneTimePassword: string; expiresAt: string };
  assert.match(madeBody.oneTimePassword, ONE_TIME_SHAPE);
  assert.deepEqual({ ...made, body: madeBody }, {
    status: 201, headers: JSON_HEADERS,
    body: {
      account: {
        id: madeBody.account.id, kind: 'password', name: 'octo-new', role: 'viewer', password: 'one_time', waitsUntil: null, madeAt: at(0),
        madeBy: { kind: 'password', name: 'octo-admin' }, lastSignInAt: null, you: false,
      },
      oneTimePassword: madeBody.oneTimePassword, expiresAt: at(72 * 3600),
    },
  });
  const made2 = madeBody.account.id;
  assert.deepEqual(await post('/api/accounts/new', { name: 'octo-new', role: 'admin' }), error(409, 'name_taken'));
  assert.deepEqual(await post('/api/accounts/role', { id: 9999, role: 'admin' }), error(404, 'not_found'));
  assert.deepEqual(await post('/api/accounts/role', { id: 2147483647, role: 'admin' }), error(404, 'not_found'));

  // Bodies that are not of the route's shape.
  for (const [path, body] of [
    ['/api/accounts/role', { id: 'x', role: 'admin' }], ['/api/accounts/role', { id: 0, role: 'admin' }], ['/api/accounts/role', { id: -1, role: 'admin' }],
    ['/api/accounts/role', { id: 2147483648, role: 'admin' }], ['/api/accounts/role', { id: 1.5, role: 'admin' }], ['/api/accounts/role', { id: made2, role: 'owner' }],
    ['/api/accounts/role', { id: made2 }], ['/api/accounts/role', { id: made2, role: 'admin', name: 'octo-new' }], ['/api/accounts/role', { id: made2, role: null }],
    ['/api/accounts/new', { name: 'x'.repeat(201), role: 'viewer' }], ['/api/accounts/new', { name: 7, role: 'viewer' }], ['/api/accounts/new', { name: 'octo-dev' }],
    ['/api/accounts/new', { name: 'octo-dev', role: 'viewer', id: 3 }], ['/api/accounts/new', { name: 'octo-dev', role: 'Admin' }], ['/api/accounts/new', {}],
    ['/api/accounts/reset', { id: String(made2) }], ['/api/accounts/reset', {}], ['/api/accounts/reset', { id: made2, role: 'viewer' }],
    ['/api/accounts/remove', { id: [made2] }], ['/api/accounts/remove', { id: made2, name: 'octo-new' }], ['/api/accounts/remove', { id: true }],
  ] as Array<[string, unknown]>) {
    assert.deepEqual(await post(path, body), error(400, 'bad_request'), `${path} ${JSON.stringify(body)}`);
  }
  // A name of 200 characters is of the shape, and refused by the rule of a name.
  assert.deepEqual(await post('/api/accounts/new', { name: 'x'.repeat(200), role: 'viewer' }), error(400, 'bad_name'));
  assert.deepEqual(await post('/api/accounts/new', { name: 'octo-dev', role: 'viewer' }, a.cookie, 'wrong'), error(403, 'csrf'));
  assert.deepEqual(await h.send('POST', '/api/accounts/new', { cookie: a.cookie, csrf, type: 'text/plain', body: '{"name":"octo-dev","role":"viewer"}' }), error(415, 'not_json'));

  assert.deepEqual(await post('/api/accounts/role', { id: admin.id, role: 'viewer' }), error(409, 'last_admin'));
  assert.deepEqual(await post('/api/accounts/remove', { id: admin.id }), error(409, 'last_admin'));
  assert.deepEqual(await post('/api/accounts/reset', { id: lead.id }), error(409, 'github_account'));
  assert.deepEqual(await post('/api/accounts/reset', { id: admin.id }), error(409, 'own_account'));
  assert.deepEqual(await post('/api/accounts/reset', { id: 9999 }), error(404, 'not_found'));
  const reset = await post('/api/accounts/reset', { id: made2 });
  const resetBody = JSON.parse(String(reset.body)) as { account: Record<string, unknown>; oneTimePassword: string; expiresAt: string };
  assert.deepEqual([reset.status, reset.headers, resetBody.account.id, resetBody.account.password, resetBody.expiresAt], [200, JSON_HEADERS, made2, 'one_time', at(72 * 3600)]);
  assert.match(resetBody.oneTimePassword, ONE_TIME_SHAPE);
  assert.notEqual(resetBody.oneTimePassword, madeBody.oneTimePassword);
  assert.deepEqual(await post('/api/accounts/remove', { id: made2 }), NO_CONTENT);
  assert.deepEqual(await post('/api/accounts/remove', { id: made2 }), error(404, 'not_found'));

  // Changing one's own password: a GitHub session has none to change; a password session changes its own.
  const { cookie } = await h.signIn();
  const github = SESSION_ID_OF.exec(cookie)?.[1] ?? '';
  assert.notEqual(github, '');
  assert.deepEqual(await post('/api/me/password', { current: PASSWORD, password: OTHER }, cookie, tokenOf(github)), error(409, 'github_account'));
  assert.deepEqual(await post('/api/me/password', { current: PASSWORD, password: OTHER }, a.cookie, 'wrong'), error(403, 'csrf'));
  assert.deepEqual(await h.send('POST', '/api/me/password', { cookie: a.cookie, csrf, type: 'text/plain', body: '{}' }), error(415, 'not_json'));
  assert.deepEqual(await h.send('POST', '/api/me/password', { cookie: a.cookie, csrf, type: JSON_TYPE, body: '[]' }), error(400, 'bad_request'));
  assert.deepEqual(await post('/api/me/password', { current: OTHER, password: OTHER }), error(400, 'wrong_password'));
  assert.deepEqual(await post('/api/me/password', { current: PASSWORD, password: OTHER }), NO_CONTENT);
  assert.deepEqual(await h.send('POST', '/api/me/password', { csrf, type: JSON_TYPE, body: '{}' }), error(401, 'signed_out'));
  assert.equal((await passwordSignIn(h, 'octo-admin', OTHER)).answer.status, 200);
  await h.db.close();
});

test('a handler of the new routes that fails is internal_error, logged with its route name only', async () => {
  const h = await harness();
  await account(h, 'octo-admin', 'admin');
  const target = await account(h, 'octo-viewer', 'viewer');
  const a = await passwordSignIn(h, 'octo-admin');
  const sent = (body: unknown): Sent => ({ cookie: a.cookie, csrf: tokenOf(a.id), type: JSON_TYPE, body: JSON.stringify(body) });
  const before = h.logs.length;
  for (const [method, path, body, text] of [
    ['POST', '/api/me/password', { current: PASSWORD, password: OTHER }, 'from visto_ai.ui_accounts where id = $1'],
    ['GET', '/api/accounts', null, 'order by lower(name), kind, id'],
    ['POST', '/api/accounts/new', { name: 'octo-new', role: 'viewer' }, 'insert into visto_ai.ui_accounts'],
    ['POST', '/api/accounts/role', { id: target.id, role: 'admin' }, 'update visto_ai.ui_accounts set role'],
    ['POST', '/api/accounts/reset', { id: target.id }, 'one_time_until = $3::timestamptz'],
    ['POST', '/api/accounts/remove', { id: target.id }, 'delete from visto_ai.ui_accounts'],
  ] as Array<[string, string, unknown, string]>) {
    h.failing.text = text;
    assert.deepEqual(await h.send(method, path, body === null ? { cookie: a.cookie } : sent(body)), error(500, 'internal_error'), path);
  }
  // A failure whose text is no short code is logged as internal_error, and its text is nowhere.
  h.failing.error = new Error('connect failed for postgres://u:p@db.example.test/d');
  h.failing.text = 'order by lower(name), kind, id';
  assert.deepEqual(await h.send('GET', '/api/accounts', { cookie: a.cookie }), error(500, 'internal_error'));
  assert.deepEqual(h.logs.slice(before), [
    { event: 'ui_failed', route: 'own_password', reason: 'db_down' },
    { event: 'ui_failed', route: 'accounts', reason: 'db_down' },
    { event: 'ui_failed', route: 'account_new', reason: 'db_down' },
    { event: 'ui_failed', route: 'account_role', reason: 'db_down' },
    { event: 'ui_failed', route: 'account_reset', reason: 'db_down' },
    { event: 'ui_failed', route: 'account_remove', reason: 'db_down' },
    { event: 'ui_failed', route: 'accounts', reason: 'internal_error' },
  ]);

  // The sign-in and the first password answer and log their own failures.
  h.failing.error = new Error('db_down');
  h.failing.text = "from visto_ai.ui_accounts where kind = 'password' and name = $1";
  const mark = h.logs.length;
  assert.deepEqual(await h.send('POST', '/api/auth/password', { origin: ORIGIN, type: JSON_TYPE, body: JSON.stringify({ name: 'octo-admin', password: PASSWORD }) }),
    error(500, 'internal_error'));
  assert.deepEqual(await h.send('POST', '/api/auth/first-password', {
    origin: ORIGIN, type: JSON_TYPE, body: JSON.stringify({ name: 'octo-admin', oneTimePassword: ONE_TIME, password: OTHER }),
  }), error(500, 'internal_error'));
  assert.deepEqual(h.logs.slice(mark), [
    { event: 'ui_signin', way: 'password', outcome: 'failed', reason: 'db_down' },
    { event: 'ui_signin', way: 'password', outcome: 'failed', reason: 'db_down' },
  ]);
  assert.ok(!JSON.stringify(h.logs).includes('postgres'));
  assert.ok(!JSON.stringify(h.logs).includes('octo-'));

  // Nothing was changed by the failures, and the session still reads.
  h.failing.text = null;
  assert.deepEqual(await h.db.query('select name, role, one_time_until from visto_ai.ui_accounts order by name'), [
    { name: 'octo-admin', role: 'admin', one_time_until: null }, { name: 'octo-viewer', role: 'viewer', one_time_until: null },
  ]);
  assert.equal((await h.send('GET', '/api/accounts', { cookie: a.cookie })).status, 200);
  await h.db.close();
});
