import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { UiConfig } from '../config/load.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { deleteAccount, insertAccount } from '../db/ui-accounts.ts';
import { createSession } from '../db/ui-sessions.ts';
import type { ForgeChecks, ForgeSignIn, SignedIn } from '../forge/types.ts';
import type { UiAnswer } from '../shell/http.ts';
import {
  CSRF_HEADER, MAX_LIVE_STATES, SESSION_COOKIE, SESSION_MS, STATE_COOKIE, STATE_MS, SWEEP_MS, cookiesOf, createAuth, csrfOk,
} from './auth.ts';
import type { Auth, AuthDeps, Session } from './auth.ts';
import { hashPassword } from './passwords.ts';
import type { PasswordCost } from './passwords.ts';

const at = (seconds: number): Date => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000);
const iso = (seconds: number): string => at(seconds).toISOString();
const hex = (value: string): string => createHash('sha256').update(value).digest('hex');
const challengeOf = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');
const tokenOf = (id: string): string => createHash('sha256').update('csrf:' + id).digest('base64url');

const PUBLIC_URL = 'https://visto.example.test';
const BACK = 'https://visto.example.test/api/auth/callback';
const CLIENT_SECRET = 'client-secret-for-tests-only';
const TEAM = 'acme/reviewers';

// Rule 3 and call 17, written out here apart from the code.
const SECURITY = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; "
    + "manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
};
const stateCookie = (state: string, verifier: string): string =>
  `__Host-visto_oauth=${state}.${verifier}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
const STATE_CLEARED = '__Host-visto_oauth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
const sessionCookie = (id: string): string => `__Host-visto_session=${id}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`;
const SESSION_CLEARED = '__Host-visto_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict';

const toGithub = (state: string, verifier: string): UiAnswer => ({
  status: 302, body: '',
  headers: {
    'set-cookie': stateCookie(state, verifier), location: `https://github.test/authorize?state=${state}&challenge=${challengeOf(verifier)}`,
    'cache-control': 'no-store', ...SECURITY,
  },
});
const letIn = (id: string): UiAnswer => ({
  status: 302, body: '', headers: { 'set-cookie': [sessionCookie(id), STATE_CLEARED], location: '/ui/', 'cache-control': 'no-store', ...SECURITY },
});
const refused = (code: string): UiAnswer => ({
  status: 302, body: '', headers: { 'set-cookie': STATE_CLEARED, location: `/ui/signin?error=${code}`, 'cache-control': 'no-store', ...SECURITY },
});
const START_FAILED: UiAnswer = { status: 302, body: '', headers: { location: '/ui/signin?error=failed', 'cache-control': 'no-store', ...SECURITY } };
const BUSY: UiAnswer = {
  status: 503, body: '{"error":"busy"}', headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY },
};
const SIGNED_OUT: UiAnswer = { status: 204, body: '', headers: { 'set-cookie': SESSION_CLEARED, 'cache-control': 'no-store', ...SECURITY } };
const signin = (outcome: string, reason: string | null = null): Record<string, unknown> => ({ event: 'ui_signin', way: 'github', outcome, reason });
const signins = (logs: Record<string, unknown>[]) => logs.filter((e) => e.event === 'ui_signin');

// The n-th value random gives: 'a' 43 times, then 'b' 43 times, and so on.
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
const nth = (n: number): string => LETTERS[n]!.repeat(43);
const [A, B, C, D, E, F] = [nth(0), nth(1), nth(2), nth(3), nth(4), nth(5)];
const OTHER = 'Z'.repeat(43);

const USERS: Record<string, SignedIn | Error> = {
  'code-1': { login: 'octo-lead', isBot: false },
  'code-2': new Error('oauth_refused'),
  'code-3': { login: 'octo-dev', isBot: false },
  'code-4': { login: 'octo-guest', isBot: false },
  'code-5': { login: 'octo-ci', isBot: true },
};

// Every answer (but the set-cookie and location of its own step) and every log line of every test, and every secret any of them
// was given: the last test reads them.
const SEEN: unknown[] = [];
const SECRETS = new Set<string>([CLIENT_SECRET, OTHER, ...Object.keys(USERS), 'octo-lead', 'octo-dev', 'octo-guest', 'octo-ci']);
function seen(answer: UiAnswer): UiAnswer {
  const headers = Object.fromEntries(Object.entries(answer.headers).filter(([name]) => name !== 'set-cookie' && name !== 'location'));
  SEEN.push({ status: answer.status, headers, body: String(answer.body) });
  return answer;
}

type Ui = AuthDeps['ui'];
interface Fakes {
  users?: Record<string, SignedIn | Error>;
  /** By organisation: an installation, null (not installed), or an Error it rejects with. */
  installations?: Record<string, string | null | Error>;
  /** By "<installation> <team> <login>"; false when not given; 'never' never settles. */
  members?: Record<string, boolean | Error | 'never'>;
}
interface Harness {
  /** The database as it is, for the test's own reads and writes. */
  db: Db;
  logs: Record<string, unknown>[];
  calls: unknown[][];
  /** Every statement the auth ran, with the clock's time then. */
  statements: Array<{ at: string; text: string }>;
  /** A statement holding this text rejects. */
  failing: { text: string | null };
  clock: { now: Date };
  auth: Auth;
  /** Another service on the same database, clock and GitHub, given another config. */
  with(ui: Partial<Ui>): Auth;
  /** A start and the way back with `code`, the browser sending the cookie the start set; the session id when one was made. */
  signIn(code: string, auth?: Auth): Promise<{ answer: UiAnswer; id: string | null }>;
}

/** What a browser sends back of the cookies an answer set. */
function sent(answer: UiAnswer): Record<string, string> {
  const set = answer.headers['set-cookie'];
  const lines = set === undefined ? [] : Array.isArray(set) ? set : [set];
  return cookiesOf(lines.map((line) => line.split(';')[0]).join('; '));
}

async function harness(ui: Partial<Ui> = {}, fakes: Fakes = {}): Promise<Harness> {
  const db = await testDb();
  const logs: Record<string, unknown>[] = [];
  const calls: unknown[][] = [];
  const statements: Array<{ at: string; text: string }> = [];
  const failing: { text: string | null } = { text: null };
  const clock = { now: at(0) };
  const users = fakes.users ?? USERS;
  const spy = (inner: Db): Db => ({
    query: (text, params) => {
      statements.push({ at: clock.now.toISOString(), text });
      if (failing.text !== null && text.includes(failing.text)) return Promise.reject(new Error(`down ${CLIENT_SECRET}`));
      return inner.query(text, params);
    },
    script: (sql) => inner.script(sql),
    close: () => inner.close(),
    transaction: (work) => inner.transaction((tx) => work(spy(tx))),
  });
  const signIn: ForgeSignIn = {
    authorizeUrl(state, challenge, redirectUri) {
      calls.push(['authorizeUrl', state, challenge, redirectUri]);
      return `https://github.test/authorize?state=${state}&challenge=${challenge}`;
    },
    async signedIn(code, verifier, redirectUri) {
      calls.push(['signedIn', code, verifier, redirectUri]);
      const user = users[code];
      if (user === undefined) throw new Error('oauth_refused');
      if (user instanceof Error) throw user;
      return user;
    },
    async orgInstallation(org) {
      calls.push(['orgInstallation', org]);
      const found = fakes.installations?.[org];
      if (found instanceof Error) throw found;
      return found ?? null;
    },
  };
  const checks: Pick<ForgeChecks, 'isTeamMember'> = {
    async isTeamMember(installation, team, login) {
      calls.push(['isTeamMember', installation, team, login]);
      const found = fakes.members?.[`${installation} ${team} ${login}`];
      if (found instanceof Error) throw found;
      if (found === 'never') return new Promise<boolean>(() => {});
      return found ?? false;
    },
  };
  let given = 0;
  const random = (): string => {
    if (given >= LETTERS.length) throw new Error('random_exhausted');
    const value = nth(given++);
    SECRETS.add(value).add(tokenOf(value));
    return value;
  };
  const log = (entry: Record<string, unknown>): void => { logs.push(entry); SEEN.push(entry); };
  const recorded = (auth: Auth): Auth => ({
    start: async () => seen(await auth.start()),
    finish: async (query, cookies) => seen(await auth.finish(query, cookies)),
    sessionOf: (cookies) => auth.sessionOf(cookies),
    signOut: async (session) => seen(await auth.signOut(session)),
  });
  const made = (over: Partial<Ui>): Auth => recorded(createAuth({
    db: spy(db), ui: { accounts: ['octo-lead'], teams: [], publicUrl: PUBLIC_URL, ...over }, signIn, checks, clock: () => clock.now, log, random,
  }));
  const auth = made(ui);
  return {
    db, logs, calls, statements, failing, clock, auth, with: made,
    async signIn(code, through = auth) {
      const started = await through.start();
      const state = new URL(String(started.headers.location)).searchParams.get('state') ?? '';
      const answer = await through.finish(new URLSearchParams({ code, state }), sent(started));
      const set = answer.headers['set-cookie'];
      const id = Array.isArray(set) ? (/^__Host-visto_session=([^;]*);/.exec(set[0] ?? '')?.[1] ?? null) : null;
      return { answer, id };
    },
  };
}

const states = async (db: Db): Promise<unknown[]> =>
  (await db.query<{ state_hash: string; verifier_hash: string; expires_at: Date }>('select * from visto_ai.ui_states order by state_hash'))
    .map((r) => ({ ...r, expires_at: r.expires_at.toISOString() }));
const sessions = async (db: Db): Promise<unknown[]> =>
  (await db.query<{ id_hash: string; login: string; via: string; created_at: Date; last_used_at: Date; expires_at: Date }>(
    'select id_hash, login, via, created_at, last_used_at, expires_at from visto_ai.ui_sessions order by created_at, id_hash'))
    .map((r) => ({ ...r, created_at: r.created_at.toISOString(), last_used_at: r.last_used_at.toISOString(), expires_at: r.expires_at.toISOString() }));
const count = async (db: Db, table: 'ui_sessions' | 'ui_states'): Promise<number> =>
  (await db.query<{ n: number }>(`select count(*)::int as n from visto_ai.${table}`))[0]!.n;
const named = (calls: unknown[][], name: string): unknown[][] => calls.filter((c) => c[0] === name);
const cookie = (id: string): Record<string, string> => cookiesOf(`${SESSION_COOKIE}=${id}`);

test('the start stores a state and a verifier for ten minutes, sets both in one cookie, and sends the browser to GitHub with the challenge', async () => {
  assert.deepEqual([SESSION_COOKIE, STATE_COOKIE, SESSION_MS, STATE_MS], ['__Host-visto_session', '__Host-visto_oauth', 43_200_000, 600_000]);
  const h = await harness();
  assert.deepEqual(await h.auth.start(), toGithub(A, B));
  assert.deepEqual(h.calls, [['authorizeUrl', A, challengeOf(B), BACK]]);
  assert.deepEqual(await states(h.db), [{ state_hash: hex(A), verifier_hash: hex(B), expires_at: iso(600) }]);
  assert.deepEqual(signins(h.logs), []);
  await h.db.close();
});

test('while 1,000 states are live a start answers busy and stores nothing, and expired rows are deleted at most once a minute', async () => {
  assert.deepEqual([SWEEP_MS, MAX_LIVE_STATES], [60_000, 1000]);
  const h = await harness();
  const store = (prefix: string, n: number, expires: number): Promise<unknown> => h.db.query(
    `insert into visto_ai.ui_states (state_hash, verifier_hash, expires_at)
     select $1::text || g::text, 'v-' || g::text, $2::timestamptz from generate_series(1, $3::int) g`, [prefix, iso(expires), n]);
  await store('live-', 1000, 600);
  await store('old-', 2, 0);
  await h.db.query(`insert into visto_ai.ui_accounts (kind, name, role, made_at, made_by_kind) values ('github', 'octo-lead', 'viewer', $1::timestamptz, 'sign_in')`, [iso(-1)]);
  await h.db.query(`insert into visto_ai.ui_sessions (id_hash, login, via, account_id, created_at, last_used_at, expires_at)
    values ('old-session', 'octo-lead', 'account', (select id from visto_ai.ui_accounts), $1::timestamptz, $1::timestamptz, $1::timestamptz)`, [iso(-1)]);

  assert.deepEqual(await h.auth.start(), BUSY);
  assert.deepEqual([await count(h.db, 'ui_states'), await count(h.db, 'ui_sessions')], [1000, 0]);
  await store('later-', 1, 20);
  h.clock.now = at(30);
  assert.deepEqual(await h.auth.start(), BUSY);
  assert.equal(await count(h.db, 'ui_states'), 1001);
  h.clock.now = at(60);
  assert.deepEqual(await h.auth.start(), BUSY);
  assert.equal(await count(h.db, 'ui_states'), 1000);
  assert.deepEqual(h.statements.filter((s) => s.text.includes('expires_at <= $1')).map((s) => s.at), [iso(0), iso(0), iso(60), iso(60)]);
  assert.deepEqual(h.calls, []);

  // One under the cap, a start goes through; the cap is reached again.
  await h.db.query(`delete from visto_ai.ui_states where state_hash = 'live-1'`);
  h.clock.now = at(61);
  assert.deepEqual(await h.auth.start(), toGithub(A, B));
  assert.deepEqual(await h.auth.start(), BUSY);
  assert.equal(await count(h.db, 'ui_states'), 1000);
  await h.db.close();
});

test('the way back with the right state and verifier and a named account makes a session of twelve hours and sends the browser to /ui/', async () => {
  const h = await harness({ accounts: ['Octo-Lead'] });
  const started = await h.auth.start();
  assert.deepEqual(sent(started), { [STATE_COOKIE]: `${A}.${B}` });
  const answer = await h.auth.finish(new URLSearchParams({ code: 'code-1', state: A }), sent(started));
  assert.deepEqual(answer, letIn(C));
  assert.deepEqual(named(h.calls, 'signedIn'), [['signedIn', 'code-1', B, BACK]]);
  assert.deepEqual(await sessions(h.db), [
    { id_hash: hex(C), login: 'octo-lead', via: 'account', created_at: iso(0), last_used_at: iso(0), expires_at: iso(43200) },
  ]);
  assert.deepEqual(await states(h.db), []);
  assert.deepEqual(signins(h.logs), [signin('ok')]);
  await h.db.close();
});

test('a state is taken once: the same way back again is refused as state', async () => {
  const h = await harness();
  const started = await h.auth.start();
  const query = new URLSearchParams({ code: 'code-1', state: A });
  assert.deepEqual(await h.auth.finish(query, sent(started)), letIn(C));
  assert.deepEqual(await h.auth.finish(query, sent(started)), refused('state'));
  assert.equal(await count(h.db, 'ui_sessions'), 1);
  assert.equal(named(h.calls, 'signedIn').length, 1);
  assert.deepEqual(signins(h.logs), [signin('ok'), signin('state')]);
  await h.db.close();
});

test('a way back whose state or verifier differs from its cookie, has none, or has expired is refused as state, makes no session and clears the cookie', async () => {
  const h = await harness();
  const back = (query: Record<string, string>, cookies: Record<string, string>): Promise<UiAnswer> =>
    h.auth.finish(new URLSearchParams(query), cookies);
  const oauth = (value: string): Record<string, string> => cookiesOf(`${STATE_COOKIE}=${value}`);

  // A state from another browser: the first browser's cookie, the second's state. Neither state is taken.
  const first = await h.auth.start();
  const second = await h.auth.start();
  assert.deepEqual([sent(first), sent(second)], [{ [STATE_COOKIE]: `${A}.${B}` }, { [STATE_COOKIE]: `${C}.${D}` }]);
  assert.deepEqual(await back({ code: 'code-1', state: C }, sent(first)), refused('state'));
  assert.equal(await count(h.db, 'ui_states'), 2);
  // The cookie's state other than the query's; the cookie's verifier other than the one stored (the state is then taken).
  assert.deepEqual(await back({ code: 'code-1', state: A }, oauth(`${OTHER}.${B}`)), refused('state'));
  assert.deepEqual(await back({ code: 'code-1', state: A }, oauth(`${A}.${OTHER}`)), refused('state'));
  assert.deepEqual(await back({ code: 'code-1', state: A }, sent(first)), refused('state'));
  // No cookie; a cookie with no '.'; a part of another length; no state; no code; a code written empty.
  assert.deepEqual(await back({ code: 'code-1', state: C }, {}), refused('state'));
  assert.deepEqual(await back({ code: 'code-1', state: C }, oauth(`${C}${D}`)), refused('state'));
  assert.deepEqual(await back({ code: 'code-1', state: C }, oauth(`${C}.${D}x`)), refused('state'));
  assert.deepEqual(await back({ code: 'code-1' }, sent(second)), refused('state'));
  assert.deepEqual(await back({ state: C }, sent(second)), refused('state'));
  assert.deepEqual(await back({ code: '', state: C }, sent(second)), refused('state'));
  assert.deepEqual(await states(h.db), [{ state_hash: hex(C), verifier_hash: hex(D), expires_at: iso(600) }]);
  // Taken at its expiry.
  h.clock.now = at(600);
  assert.deepEqual(await back({ code: 'code-1', state: C }, sent(second)), refused('state'));
  assert.equal(await count(h.db, 'ui_states'), 0);
  // GitHub sends the person back with an error.
  h.clock.now = at(601);
  const third = await h.auth.start();
  assert.deepEqual(sent(third), { [STATE_COOKIE]: `${E}.${F}` });
  assert.deepEqual(await back({ error: 'access_denied', state: E }, sent(third)), refused('denied'));
  assert.deepEqual(await back({ error: 'access_denied', code: 'code-1', state: E }, sent(third)), refused('denied'));
  assert.equal(await count(h.db, 'ui_states'), 1);

  assert.equal(await count(h.db, 'ui_sessions'), 0);
  assert.deepEqual(named(h.calls, 'signedIn'), []);
  assert.deepEqual(signins(h.logs), [...Array.from({ length: 11 }, () => signin('state')), signin('denied'), signin('denied')]);
  await h.db.close();
});

test("GitHub's refusal, an account not named, a bot, and a team that cannot be read are refused each with its own code", async () => {
  const alone = await harness({ accounts: ['octo-lead', 'octo-ci'] });
  assert.deepEqual((await alone.signIn('code-2')).answer, refused('github'));
  assert.deepEqual((await alone.signIn('code-4')).answer, refused('not_allowed'));
  assert.deepEqual((await alone.signIn('code-5')).answer, refused('not_allowed'));
  assert.deepEqual(signins(alone.logs), [signin('github', 'oauth_refused'), signin('not_allowed'), signin('not_allowed')]);
  assert.equal(await count(alone.db, 'ui_sessions'), 0);
  await alone.db.close();

  // A bot is not let in by its team either, which is not read for it.
  const bots = await harness({ accounts: [], teams: [TEAM] }, { installations: { acme: '99' }, members: { '99 acme/reviewers octo-ci': true } });
  assert.deepEqual((await bots.signIn('code-5')).answer, refused('not_allowed'));
  assert.deepEqual([...named(bots.calls, 'orgInstallation'), ...named(bots.calls, 'isTeamMember')], []);
  await bots.db.close();

  const team = (installations: Fakes['installations'], members: Fakes['members'] = {}): Promise<Harness> =>
    harness({ accounts: ['octo-lead'], teams: [TEAM] }, { installations, members });
  const none = await team({ acme: null });
  assert.deepEqual((await none.signIn('code-3')).answer, refused('unverified'));
  assert.deepEqual(named(none.calls, 'isTeamMember'), []);
  const down = await team({ acme: new Error('github_502') });
  assert.deepEqual((await down.signIn('code-3')).answer, refused('unverified'));
  const unread = await team({ acme: '99' }, { '99 acme/reviewers octo-dev': new Error('github_403') });
  assert.deepEqual((await unread.signIn('code-3')).answer, refused('unverified'));
  const odd = await team({ acme: '99' }, { '99 acme/reviewers octo-dev': new Error(`odd ${CLIENT_SECRET}`) });
  assert.deepEqual((await odd.signIn('code-3')).answer, refused('unverified'));
  assert.deepEqual(signins([...none.logs, ...down.logs, ...unread.logs, ...odd.logs]), [
    signin('unverified', 'not_installed'), signin('unverified', 'github_502'), signin('unverified', 'github_403'), signin('unverified', 'internal_error'),
  ]);
  for (const h of [none, down, unread, odd]) {
    assert.equal(await count(h.db, 'ui_sessions'), 0);
    await h.db.close();
  }
});

test("an active member of the team is let in through the organisation's installation; a member who is not active is not", async () => {
  const h = await harness({ accounts: [], teams: [TEAM] }, {
    installations: { acme: '99', Acme: '99' },
    members: { '99 acme/reviewers octo-dev': true, '99 acme/reviewers octo-guest': false, '99 Acme/Reviewers octo-dev': true },
  });
  const member = await h.signIn('code-3');
  assert.deepEqual(member.answer, letIn(C));
  assert.deepEqual(h.calls.filter((c) => c[0] === 'orgInstallation' || c[0] === 'isTeamMember'),
    [['orgInstallation', 'acme'], ['isTeamMember', '99', 'acme/reviewers', 'octo-dev']]);
  assert.deepEqual((await h.signIn('code-4')).answer, refused('not_allowed'));
  // The way in is the team as the file writes it.
  const written = await h.signIn('code-3', h.with({ accounts: [], teams: ['Acme/Reviewers'] }));
  assert.deepEqual(written.answer, letIn(nth(7)));
  assert.deepEqual(h.calls.slice(-2), [['orgInstallation', 'Acme'], ['isTeamMember', '99', 'Acme/Reviewers', 'octo-dev']]);
  assert.deepEqual((await sessions(h.db)).map((r) => r as { id_hash: string; login: string; via: string }).map((r) => [r.id_hash, r.login, r.via]).sort(),
    [[hex(C), 'octo-dev', 'acme/reviewers'], [hex(nth(7)), 'octo-dev', 'Acme/Reviewers']].sort());
  assert.deepEqual(signins(h.logs), [signin('ok'), signin('not_allowed'), signin('ok')]);
  await h.db.close();
});

test('with several teams every one is read, a member of any is let in through the first written that says yes, and a team not read refuses only when none says yes', async () => {
  const OTHER = 'acme/platform';
  const h = await harness({ accounts: [], teams: [TEAM, OTHER] }, {
    installations: { acme: '99' },
    members: { [`99 ${OTHER} octo-dev`]: true },
  });
  assert.deepEqual((await h.signIn('code-3')).answer, letIn(C));
  assert.deepEqual(named(h.calls, 'isTeamMember'), [['isTeamMember', '99', TEAM, 'octo-dev'], ['isTeamMember', '99', OTHER, 'octo-dev']]);
  assert.deepEqual((await sessions(h.db)).map((r) => (r as { via: string }).via), [OTHER]);
  assert.deepEqual((await h.signIn('code-4')).answer, refused('not_allowed'));
  // A member of both is let in through the first team written.
  const both = await harness({ accounts: [], teams: [TEAM, OTHER] }, {
    installations: { acme: '99' }, members: { [`99 ${TEAM} octo-dev`]: true, [`99 ${OTHER} octo-dev`]: true },
  });
  assert.deepEqual((await both.signIn('code-3')).answer, letIn(C));
  assert.deepEqual((await sessions(both.db)).map((r) => (r as { via: string }).via), [TEAM]);
  // A team that cannot be read: a yes from another still lets in; with no yes the sign-in is unverified, never not_allowed.
  const broken = await harness({ accounts: [], teams: [TEAM, OTHER] }, {
    installations: { acme: '99' }, members: { [`99 ${TEAM} octo-dev`]: new Error('github_403'), [`99 ${OTHER} octo-dev`]: true, [`99 ${TEAM} octo-guest`]: new Error('github_403') },
  });
  assert.deepEqual((await broken.signIn('code-3')).answer, letIn(C));
  assert.deepEqual((await broken.signIn('code-4')).answer, refused('unverified'));
  assert.deepEqual(signins([...h.logs, ...both.logs, ...broken.logs]), [
    signin('ok'), signin('not_allowed'), signin('ok'), signin('ok'), signin('unverified', 'github_403'),
  ]);
  for (const x of [h, both, broken]) await x.db.close();
});

test('a login GitHub writes in another letter case than the file is let in, and its session reads back', async () => {
  const h = await harness({ accounts: ['octo-lead'] }, { users: { 'code-6': { login: 'Octo-Lead', isBot: false } } });
  const { answer, id } = await h.signIn('code-6');
  assert.deepEqual(answer, letIn(C));
  assert.deepEqual((await sessions(h.db)).map((r) => [(r as { login: string }).login, (r as { via: string }).via]), [['Octo-Lead', 'account']]);
  assert.deepEqual(await h.auth.sessionOf(cookie(id!)), { login: 'Octo-Lead', idHash: hex(C), csrf: tokenOf(C), accountId: 1, kind: 'github', role: 'viewer' });
  assert.deepEqual(signins(h.logs), [signin('ok')]);
  await h.db.close();
});

test('a refusal of the sign-in or of the installation read whose message is no short code is logged as internal_error, never its message', async () => {
  const odd = new Error(`odd ${CLIENT_SECRET}`);
  const h = await harness({ accounts: [], teams: [TEAM] }, { users: { ...USERS, 'code-7': odd }, installations: { acme: odd } });
  assert.deepEqual((await h.signIn('code-7')).answer, refused('github'));
  assert.deepEqual((await h.signIn('code-3')).answer, refused('unverified'));
  assert.deepEqual(named(h.calls, 'orgInstallation'), [['orgInstallation', 'acme']]);
  assert.deepEqual(signins(h.logs), [signin('github', 'internal_error'), signin('unverified', 'internal_error')]);
  assert.ok(!JSON.stringify(h.logs).includes('odd'));
  assert.ok(!JSON.stringify(h.logs).includes(CLIENT_SECRET));
  await h.db.close();
});

/** One turn of the event loop, which mock timers of setTimeout leave as it is. */
const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

test('a team read that answers nothing within 10 seconds is unverified as github_network, and the way back ends then, giving its place back', async (t) => {
  const h = await harness({ accounts: [], teams: [TEAM] }, { installations: { acme: '99' }, members: { '99 acme/reviewers octo-dev': 'never' } });
  const started = await h.auth.start();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer: UiAnswer | null = null;
  const back = h.auth.finish(new URLSearchParams({ code: 'code-3', state: A }), sent(started)).then((a) => { answer = a; });
  for (let i = 0; i < 1000 && named(h.calls, 'isTeamMember').length === 0; i += 1) await turn();
  assert.deepEqual(named(h.calls, 'isTeamMember'), [['isTeamMember', '99', TEAM, 'octo-dev']]);
  t.mock.timers.tick(9_999);
  for (let i = 0; i < 50; i += 1) await turn();
  assert.equal(answer, null);
  t.mock.timers.tick(1);
  for (let i = 0; i < 1000 && answer === null; i += 1) await turn();
  assert.deepEqual(answer, refused('unverified'));
  await back;
  assert.deepEqual(signins(h.logs), [signin('unverified', 'github_network')]);
  assert.equal(await count(h.db, 'ui_sessions'), 0);
  await h.db.close();
});

test("the team read's limit leaves no timer running once the read has answered or failed", async () => {
  const timers = (): number => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const h = await harness({ accounts: [], teams: [TEAM] }, {
    installations: { acme: '99' }, members: { '99 acme/reviewers octo-dev': true, '99 acme/reviewers octo-guest': new Error('github_403') },
  });
  const before = timers();
  assert.deepEqual((await h.signIn('code-3')).answer, letIn(C));
  assert.deepEqual((await h.signIn('code-4')).answer, refused('unverified'));
  assert.equal(timers(), before);
  assert.deepEqual(signins(h.logs), [signin('ok'), signin('unverified', 'github_403')]);
  await h.db.close();
});

test('a session is read by its cookie, and stops being one when it expires or is signed out', async () => {
  const h = await harness();
  const { id } = await h.signIn('code-1');
  assert.equal(id, C);
  const session = await h.auth.sessionOf(cookie(C));
  assert.deepEqual(session, { login: 'octo-lead', idHash: hex(C), csrf: tokenOf(C), accountId: 1, kind: 'github', role: 'viewer' });

  h.clock.now = at(10);
  const second = await h.signIn('code-1');
  assert.equal(second.id, F);
  const other = await h.auth.sessionOf(cookie(F));
  assert.ok(other !== null);
  assert.deepEqual(await h.auth.signOut(other), SIGNED_OUT);
  assert.equal(await h.auth.sessionOf(cookie(F)), null);
  assert.equal(await count(h.db, 'ui_sessions'), 1);

  h.clock.now = at(43199);
  assert.deepEqual(await h.auth.sessionOf(cookie(C)), session);
  h.clock.now = at(43200);
  assert.equal(await h.auth.sessionOf(cookie(C)), null);

  h.clock.now = at(10);
  const before = h.statements.length;
  for (const shape of [C.slice(1), `${C}c`, `${C.slice(1)}=`, `${C.slice(1)}.`, `${C.slice(1)}+`, '']) {
    assert.equal(await h.auth.sessionOf(cookie(shape)), null);
  }
  assert.equal(await h.auth.sessionOf({}), null);
  assert.equal(await h.auth.sessionOf(cookiesOf(`${STATE_COOKIE}=${C}`)), null);
  assert.equal(h.statements.length, before);
  await h.db.close();
});

test('a session stops being one when the way it was let in no longer holds, with accounts and a team both named', async () => {
  const h = await harness({ accounts: ['octo-lead'], teams: [TEAM] }, { installations: { acme: '99' }, members: { '99 acme/reviewers octo-dev': true } });
  const lead = await h.signIn('code-1');
  const dev = await h.signIn('code-3');
  assert.deepEqual([lead.answer, dev.answer], [letIn(C), letIn(F)]);
  assert.deepEqual((await sessions(h.db)).map((r) => [(r as { login: string }).login, (r as { via: string }).via]).sort(),
    [['octo-dev', TEAM], ['octo-lead', 'account']]);
  const read = async (auth: Auth): Promise<Array<string | null>> =>
    [(await auth.sessionOf(cookie(C)))?.login ?? null, (await auth.sessionOf(cookie(F)))?.login ?? null];

  assert.deepEqual(await read(h.auth), ['octo-lead', 'octo-dev']);
  assert.deepEqual(await read(h.with({ accounts: [], teams: [TEAM] })), [null, 'octo-dev']);
  assert.deepEqual(await read(h.with({ accounts: ['octo-lead'], teams: ['acme/other'] })), ['octo-lead', null]);
  assert.deepEqual(await read(h.with({ accounts: ['octo-lead'], teams: ['ACME/Reviewers'] })), ['octo-lead', 'octo-dev']);
  // With several teams, a session holds while the team that let it in is still among them.
  assert.deepEqual(await read(h.with({ accounts: ['octo-lead'], teams: ['acme/other', TEAM] })), ['octo-lead', 'octo-dev']);
  assert.deepEqual(await read(h.with({ accounts: ['OCTO-LEAD'], teams: [] })), ['octo-lead', null]);
  assert.deepEqual(await read(h.with({ accounts: ['octo-dev'], teams: [] })), [null, null]);
  // The rows are left.
  assert.equal(await count(h.db, 'ui_sessions'), 2);
  await h.db.close();
});

const MADE = { event: 'ui_account', change: 'made', role: 'viewer' };
// Call 4: every hash of these tests is made at COST.
const COST: PasswordCost = { log2N: 4, r: 1, p: 1 };
const accountsOf = async (db: Db): Promise<unknown[]> =>
  (await db.query<{ last_sign_in_at: Date | null }>('select id, kind, name, role, made_by_kind, made_by_name, last_sign_in_at from visto_ai.ui_accounts order by id'))
    .map((r) => ({ ...r, last_sign_in_at: r.last_sign_in_at?.toISOString() ?? null }));
const changesOf = (db: Db): Promise<unknown[]> =>
  db.query('select by_kind, by_name, change, account_kind, account_name, role from visto_ai.ui_account_changes order by id');
const LEAD_MADE = [{ by_kind: 'sign_in', by_name: null, change: 'made', account_kind: 'github', account_name: 'octo-lead', role: 'viewer' }];

test("a GitHub sign-in makes the account a viewer at its first sign-in, logs it once, and the session reads the row's role at each request", async () => {
  const h = await harness();
  assert.deepEqual((await h.signIn('code-1')).answer, letIn(C));
  assert.deepEqual(h.logs, [MADE, signin('ok')]);
  assert.deepEqual(await accountsOf(h.db), [
    { id: 1, kind: 'github', name: 'octo-lead', role: 'viewer', made_by_kind: 'sign_in', made_by_name: null, last_sign_in_at: iso(0) },
  ]);
  assert.deepEqual(await changesOf(h.db), LEAD_MADE);
  assert.equal((await h.auth.sessionOf(cookie(C)))?.role, 'viewer');
  await h.db.query(`update visto_ai.ui_accounts set role = 'admin' where name = 'octo-lead'`);
  assert.deepEqual(await h.auth.sessionOf(cookie(C)), { login: 'octo-lead', idHash: hex(C), csrf: tokenOf(C), accountId: 1, kind: 'github', role: 'admin' });

  h.clock.now = at(10);
  assert.deepEqual((await h.signIn('code-1')).answer, letIn(F));
  assert.deepEqual(h.logs.slice(2), [signin('ok')]);
  assert.equal((await h.auth.sessionOf(cookie(F)))?.role, 'admin');
  assert.deepEqual((await accountsOf(h.db)).map((r) => (r as { last_sign_in_at: string }).last_sign_in_at), [iso(10)]);
  assert.deepEqual(await changesOf(h.db), LEAD_MADE);
  await h.db.close();
});

test('a GitHub row made whose session cannot be made is still logged as made, then failed', async () => {
  const h = await harness();
  h.failing.text = 'insert into visto_ai.ui_sessions';
  assert.deepEqual((await h.signIn('code-1')).answer, refused('failed'));
  assert.deepEqual(h.logs, [MADE, signin('failed')]);
  h.failing.text = null;
  assert.deepEqual((await accountsOf(h.db)).map((r) => (r as { name: string }).name), ['octo-lead']);
  assert.deepEqual(await changesOf(h.db), LEAD_MADE);
  assert.equal(await count(h.db, 'ui_sessions'), 0);
  await h.db.close();

  // A row whose record cannot be written is not made, nor logged as made.
  const other = await harness();
  other.failing.text = 'insert into visto_ai.ui_account_changes';
  assert.deepEqual((await other.signIn('code-1')).answer, refused('failed'));
  assert.deepEqual(other.logs, [signin('failed')]);
  other.failing.text = null;
  assert.deepEqual([await accountsOf(other.db), await changesOf(other.db), await count(other.db, 'ui_sessions')], [[], [], 0]);
  await other.db.close();
});

test('a GitHub sign-in with 1,000 accounts and none of its own is refused as full', async () => {
  const h = await harness();
  const hash = await hashPassword('a long password of mine', COST);
  await h.db.query(
    `insert into visto_ai.ui_accounts (kind, name, role, password_hash, made_at, made_by_kind)
     select 'password', 'octo-user-' || g::text, 'viewer', $1, $2::timestamptz, 'command' from generate_series(1, 1000) g`, [hash, iso(0)]);
  assert.deepEqual((await h.signIn('code-1')).answer, refused('full'));
  assert.deepEqual(h.logs, [signin('full')]);
  assert.equal(await count(h.db, 'ui_sessions'), 0);
  assert.deepEqual(await h.db.query(`select count(*)::int as n from visto_ai.ui_accounts where kind = 'github'`), [{ n: 0 }]);
  assert.deepEqual(await changesOf(h.db), []);
  await h.db.close();
});

test('with GitHub sign-in off the start and the way back are not found, and read nothing', async () => {
  const db = await testDb();
  const seen: string[] = [];
  const spy: Db = {
    query: (text, params) => { seen.push(text); return db.query(text, params); },
    script: (sql) => { seen.push(sql); return db.script(sql); },
    close: () => db.close(),
    transaction: (work) => { seen.push('transaction'); return db.transaction(work); },
  };
  const logs: Record<string, unknown>[] = [];
  const auth = createAuth({
    db: spy, ui: { accounts: [], teams: [], publicUrl: PUBLIC_URL }, signIn: null,
    checks: { isTeamMember: () => { seen.push('isTeamMember'); return Promise.resolve(true); } },
    clock: () => { seen.push('clock'); return at(0); }, log: (entry) => { logs.push(entry); }, random: () => { seen.push('random'); return A; },
  });
  const NOT_FOUND: UiAnswer = {
    status: 404, body: '{"error":"not_found"}', headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY },
  };
  assert.deepEqual(await auth.start(), NOT_FOUND);
  assert.deepEqual(await auth.finish(new URLSearchParams({ code: 'code-1', state: A }), cookiesOf(`${STATE_COOKIE}=${A}.${B}`)), NOT_FOUND);
  assert.deepEqual(await auth.finish(new URLSearchParams({ error: 'access_denied' }), {}), NOT_FOUND);
  assert.deepEqual([seen, logs], [[], []]);
  await db.close();
});

test("a password session reads by its kind, whatever the file's accounts say, and a removed account's session is none", async () => {
  const h = await harness({ accounts: [] });
  const hash = await hashPassword('a long password of mine', COST);
  const admin = await insertAccount(h.db, {
    kind: 'password', name: 'octo-admin', role: 'admin', passwordHash: hash, oneTimeUntil: null, at: iso(0), by: 'command', byName: null, signedInAt: null,
  });
  assert.ok(admin !== null);
  const id = nth(9);
  await createSession(h.db, { idHash: hex(id), login: 'octo-admin', via: 'password', accountId: admin.id, at: iso(0), expiresAt: iso(43200) });
  const expected = { login: 'octo-admin', idHash: hex(id), csrf: tokenOf(id), accountId: admin.id, kind: 'password', role: 'admin' };
  assert.deepEqual(await h.auth.sessionOf(cookie(id)), expected);
  assert.deepEqual(await h.with({ accounts: ['octo-lead'], teams: [TEAM] }).sessionOf(cookie(id)), expected);

  // A way in of the other kind holds for neither: a password account let in as a named login, a GitHub account as a password.
  const named = nth(10);
  await createSession(h.db, { idHash: hex(named), login: 'octo-admin', via: 'account', accountId: admin.id, at: iso(0), expiresAt: iso(43200) });
  assert.equal(await h.with({ accounts: ['octo-admin'] }).sessionOf(cookie(named)), null);
  const lead = await insertAccount(h.db, {
    kind: 'github', name: 'octo-lead', role: 'admin', passwordHash: null, oneTimeUntil: null, at: iso(0), by: 'command', byName: null, signedInAt: null,
  });
  assert.ok(lead !== null);
  const github = nth(11);
  await createSession(h.db, { idHash: hex(github), login: 'octo-lead', via: 'password', accountId: lead.id, at: iso(0), expiresAt: iso(43200) });
  assert.equal(await h.with({ accounts: ['octo-lead'] }).sessionOf(cookie(github)), null);

  assert.equal((await deleteAccount(h.db, admin.id))?.id, admin.id);
  assert.equal(await h.auth.sessionOf(cookie(id)), null);
  assert.equal(await h.with({ accounts: ['octo-lead'], teams: [TEAM] }).sessionOf(cookie(id)), null);
  await h.db.close();
});

test("the token for changes is the session's own, and another session's or none is refused", () => {
  assert.equal(CSRF_HEADER, 'x-visto-csrf');
  const s: Session = { login: 'octo-lead', idHash: hex(C), csrf: tokenOf(C), accountId: 1, kind: 'github', role: 'viewer' };
  const another: Session = { login: 'octo-lead', idHash: hex(F), csrf: tokenOf(F), accountId: 1, kind: 'github', role: 'viewer' };
  assert.equal(csrfOk(s, s.csrf), true);
  assert.equal(csrfOk(s, another.csrf), false);
  assert.equal(csrfOk(s, undefined), false);
  assert.equal(csrfOk(s, ''), false);
  assert.equal(csrfOk(s, s.csrf.slice(0, 42)), false);
  assert.equal(csrfOk(s, `${s.csrf}x`), false);
  assert.equal(csrfOk(s, C), false);
});

test('cookies are read at their first equals sign, the first of a name is kept, and a name such as __proto__ is a key of its own', () => {
  const read = cookiesOf(' a=1; b=2=3;c=; a=4; d ;__proto__=x; constructor=y');
  assert.deepEqual(read, JSON.parse('{"a":"1","b":"2=3","c":"","__proto__":"x","constructor":"y"}'));
  assert.equal(Object.getPrototypeOf(read), Object.prototype);
  assert.deepEqual(cookiesOf(undefined), {});
  assert.deepEqual(cookiesOf(''), {});
});

test('a database step that rejects sends the browser to the sign-in page with failed, and a session read that rejects rejects', async () => {
  const h = await harness();
  h.failing.text = 'expires_at <= $1';
  assert.deepEqual(await h.auth.start(), START_FAILED);
  // The sweep that failed is tried again at the next start.
  h.failing.text = null;
  h.clock.now = at(1);
  const started = await h.auth.start();
  assert.deepEqual(started, toGithub(A, B));
  assert.deepEqual(h.statements.filter((s) => s.text.includes('expires_at <= $1')).map((s) => s.at), [iso(0), iso(1), iso(1)]);
  for (const text of ['count(*)', 'insert into visto_ai.ui_states']) {
    h.failing.text = text;
    assert.deepEqual(await h.auth.start(), START_FAILED);
  }
  h.failing.text = null;
  assert.equal(await count(h.db, 'ui_states'), 1);

  h.failing.text = 'delete from visto_ai.ui_states where state_hash';
  assert.deepEqual(await h.auth.finish(new URLSearchParams({ code: 'code-1', state: A }), sent(started)), refused('failed'));
  h.failing.text = 'insert into visto_ai.ui_sessions';
  const again = await h.auth.start();
  const state = new URL(String(again.headers.location)).searchParams.get('state') ?? '';
  assert.deepEqual(await h.auth.finish(new URLSearchParams({ code: 'code-1', state }), sent(again)), refused('failed'));
  h.failing.text = null;
  const late = await h.auth.start();
  h.clock.now = new Date(Number.NaN);
  const lateState = new URL(String(late.headers.location)).searchParams.get('state') ?? '';
  assert.deepEqual(await h.auth.finish(new URLSearchParams({ code: 'code-1', state: lateState }), sent(late)), refused('failed'));
  assert.deepEqual(await h.auth.start(), START_FAILED);
  assert.deepEqual(signins(h.logs), [signin('failed'), signin('failed'), signin('failed')]);
  assert.equal(await count(h.db, 'ui_sessions'), 0);

  h.clock.now = at(2);
  const { id } = await h.signIn('code-1');
  assert.ok(id !== null);
  // A database that rejects is an error, never a sign-out: the read, and the last use's write once the stored one is a minute old.
  h.failing.text = 'from visto_ai.ui_sessions';
  await assert.rejects(h.auth.sessionOf(cookie(id)), /^Error: down /);
  h.failing.text = 'update visto_ai.ui_sessions set last_used_at';
  h.clock.now = at(62);
  await assert.rejects(h.auth.sessionOf(cookie(id)), /^Error: down /);
  h.failing.text = null;
  // A clock that gives no time reads no session, with no statement.
  const statements = h.statements.length;
  h.clock.now = new Date(Number.NaN);
  assert.equal(await h.auth.sessionOf(cookie(id)), null);
  assert.equal(h.statements.length, statements);
  h.clock.now = at(3);
  assert.equal((await h.auth.sessionOf(cookie(id)))?.login, 'octo-lead');
  await h.db.close();
});

test('no log line or answer holds the code, the state, the verifier, the session id or the client secret, and no row holds any of them in clear', async () => {
  const h = await harness({ accounts: ['octo-lead'], teams: [TEAM] }, { installations: { acme: '99' }, members: { '99 acme/reviewers octo-dev': true } });
  const started = await h.auth.start();
  const stored = await states(h.db);
  assert.deepEqual(stored, [{ state_hash: hex(A), verifier_hash: hex(B), expires_at: iso(600) }]);
  assert.deepEqual(await h.auth.finish(new URLSearchParams({ code: 'code-1', state: A }), sent(started)), letIn(C));
  assert.deepEqual((await h.signIn('code-3')).answer, letIn(F));
  for (const code of ['code-2', 'code-4', 'code-5', 'code-9']) await h.signIn(code);
  await h.auth.finish(new URLSearchParams({ code: 'code-1', state: A }), sent(started));
  await h.auth.finish(new URLSearchParams({ error: 'access_denied', state: A }), sent(started));
  const rows = await sessions(h.db);
  const session = await h.auth.sessionOf(cookie(F));
  assert.ok(session !== null);
  await h.auth.signOut(session);

  // The rows: only hashes, the login, the way in and the times.
  const byHash = (x: unknown, y: unknown): number => ((x as { id_hash: string }).id_hash < (y as { id_hash: string }).id_hash ? -1 : 1);
  assert.deepEqual([...rows].sort(byHash), [
    { id_hash: hex(C), login: 'octo-lead', via: 'account', created_at: iso(0), last_used_at: iso(0), expires_at: iso(43200) },
    { id_hash: hex(F), login: 'octo-dev', via: TEAM, created_at: iso(0), last_used_at: iso(0), expires_at: iso(43200) },
  ].sort(byHash));
  const clearRows = JSON.stringify([stored, rows, await states(h.db)]);
  for (const secret of SECRETS) {
    if (secret.startsWith('octo-')) continue;   // the login is stored
    assert.ok(!clearRows.includes(secret), `a row holds ${secret.slice(0, 8)}`);
  }

  // Every answer and log line of this test and the tests before (this test alone gives 15 answers and 9 log lines).
  assert.ok(SEEN.length >= 24);
  const said = JSON.stringify(SEEN);
  for (const secret of SECRETS) assert.ok(!said.includes(secret), `an answer or a log line holds ${secret.slice(0, 8)}`);

  // AuthDeps names no key that could hold the client secret, and the config's whole `ui`, held in a variable, cannot be given
  // as its `ui`: the type check refuses it.
  const depKeys: Record<keyof AuthDeps, true> = { db: true, ui: true, signIn: true, checks: true, clock: true, log: true, random: true };
  assert.deepEqual(Object.keys(depKeys), ['db', 'ui', 'signIn', 'checks', 'clock', 'log', 'random']);
  const full: UiConfig = {
    accounts: ['octo-lead'], teams: [], publicUrl: 'https://visto.example.test', clientId: 'Iv1.0123456789abcdef', clientSecret: 'client-secret-for-tests-only',
  };
  // @ts-expect-error -- the client secret cannot be handed to sign-in
  const ui: AuthDeps['ui'] = full;
  void ui;
  await h.db.close();
});
