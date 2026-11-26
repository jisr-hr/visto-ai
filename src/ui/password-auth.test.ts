import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { insertAccount, setOneTime, wrongTry } from '../db/ui-accounts.ts';
import type { AccountKind, Role } from '../db/ui-accounts.ts';
import { createSession, deleteSessionsOf, readSession } from '../db/ui-sessions.ts';
import type { UiAnswer } from '../shell/http.ts';
import type { Session } from './auth.ts';
import { WAIT_MS, WRONG_TRIES, createPasswordAuth } from './password-auth.ts';
import type { PasswordAuth } from './password-auth.ts';
import { hashPassword, verifyPassword } from './passwords.ts';
import type { PasswordCost } from './passwords.ts';

const at = (seconds: number): Date => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000);
const iso = (seconds: number): string => at(seconds).toISOString();
const hex = (value: string): string => createHash('sha256').update(value).digest('hex');
const tokenOf = (id: string): string => createHash('sha256').update('csrf:' + id).digest('base64url');

// Call 4: every hash of these tests is made at COST.
const COST: PasswordCost = { log2N: 4, r: 1, p: 1 };
const MINE = 'a long password of mine';
const ANOTHER = 'another long password';
const WRONG = 'not the password at all';
const ONE_TIME = '23456789abcdefghjkmn';
const ONE_TIME_2 = 'pqrstuvwxyz23456789a';
const THIRD = 'a third long password';
const SECRETS = [MINE, ANOTHER, WRONG, ONE_TIME, ONE_TIME_2, THIRD];

// The headers of the first plan (call 17 there), written out here apart from the code.
const SECURITY = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; "
    + "manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
};
const answer = (status: number, value: unknown, extra: Record<string, string> = {}): UiAnswer => ({
  status, headers: { ...extra, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY }, body: JSON.stringify(value),
});
const error = (status: number, code: string): UiAnswer => answer(status, { error: code });
// The session cookie of GitHub sign-in in the first plan.
const sessionCookie = (id: string): string => `__Host-visto_session=${id}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`;
const signedIn = (id: string): UiAnswer => answer(200, { next: 'signed_in' }, { 'set-cookie': sessionCookie(id) });
const CHOOSE = answer(200, { next: 'choose_password' });
const REFUSED = error(401, 'refused');
const EXPIRED = error(401, 'expired');
const INTERNAL = error(500, 'internal_error');
const WRONG_PASSWORD = error(400, 'wrong_password');
const CHANGED: UiAnswer = { status: 204, headers: { 'cache-control': 'no-store', ...SECURITY }, body: '' };
const signin = (outcome: string, reason: string | null = null): Record<string, unknown> => ({ event: 'ui_signin', way: 'password', outcome, reason });
const changed = (role: Role): Record<string, unknown> => ({ event: 'ui_account', change: 'password_changed', role });

// The n-th value random gives: 'a' 43 times, then 'b' 43 times, and so on.
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
const nth = (n: number): string => LETTERS[n]!.repeat(43);
const [A, B, C] = [nth(0), nth(1), nth(2)];

/** The error every failing statement rejects with. */
const DOWN = new Error('db_down');

// Every answer, log line and error of every test: the last test reads them.
const SEEN: unknown[] = [];

interface Harness {
  /** The database as it is, for the test's own reads and writes. */
  db: Db;
  logs: Record<string, unknown>[];
  /** Every statement the password sign-in ran, with the clock's time then and whether it ran inside a transaction. */
  statements: Array<{ at: string; text: string; tx: boolean }>;
  /** A statement holding this text rejects with DOWN. */
  failing: { text: string | null };
  /** Every verify, as [password, stored]. */
  verifies: Array<[string, string]>;
  /** The number of statements run when each verify resolved. */
  verified: number[];
  /** Called once, inside the next verify, before it resolves. */
  during: (() => Promise<unknown>) | null;
  /** Called once, when the password sign-in begins its next transaction, before the transaction's first statement. */
  atTransaction: (() => Promise<unknown>) | null;
  clock: { now: Date };
  auth: PasswordAuth;
  /** Another object on the same database, clock, log and verify. */
  another(cost?: PasswordCost): PasswordAuth;
}

function recorded(auth: PasswordAuth): PasswordAuth {
  const seen = (a: UiAnswer): UiAnswer => { SEEN.push({ status: a.status, headers: a.headers, body: String(a.body) }); return a; };
  return {
    signIn: async (body) => seen(await auth.signIn(body)),
    firstPassword: async (body) => seen(await auth.firstPassword(body)),
    change: async (session, body) => {
      try {
        return seen(await auth.change(session, body));
      } catch (e) {
        SEEN.push(String(e));
        throw e;
      }
    },
  };
}

async function harness(): Promise<Harness> {
  const db = await testDb();
  // The object the test reads and sets: the spy and the verify below read it as the test leaves it.
  const h: Omit<Harness, 'auth' | 'another'> = {
    db, logs: [], statements: [], failing: { text: null }, verifies: [], verified: [], during: null, atTransaction: null, clock: { now: at(0) },
  };
  const spy = (inner: Db, tx: boolean): Db => ({
    query: (text, params) => {
      h.statements.push({ at: h.clock.now.toISOString(), text, tx });
      if (h.failing.text !== null && text.includes(h.failing.text)) return Promise.reject(DOWN);
      return inner.query(text, params);
    },
    script: (sql) => inner.script(sql),
    close: () => inner.close(),
    // PGlite runs one transaction at a time: what the test commits here is committed before this one begins.
    transaction: async (work) => {
      const first = h.atTransaction;
      if (first !== null) {
        h.atTransaction = null;
        await first();
      }
      return inner.transaction((t) => work(spy(t, true)));
    },
  });
  const verify = async (password: string, stored: string): Promise<boolean> => {
    h.verifies.push([password, stored]);
    const during = h.during;
    if (during !== null) {
      h.during = null;
      await during();
    }
    const ok = await verifyPassword(password, stored);
    h.verified.push(h.statements.length);
    return ok;
  };
  let given = 0;
  const random = (): string => nth(given++);
  const log = (entry: Record<string, unknown>): void => { h.logs.push(entry); SEEN.push(entry); };
  const another = (cost: PasswordCost = COST): PasswordAuth =>
    recorded(createPasswordAuth({ db: spy(db, false), clock: () => h.clock.now, log, random, cost, verify }));
  return Object.assign(h, { auth: another(), another });
}

/** A password account made by the command at at(0); a one-time password's when `oneTimeUntil` is given. */
async function account(db: Db, name: string, role: Role, password: string, oneTimeUntil: string | null = null): Promise<{ id: number; hash: string }> {
  const hash = await hashPassword(password, COST);
  const row = await insertAccount(db, { kind: 'password', name, role, passwordHash: hash, oneTimeUntil, at: iso(0), by: 'command', byName: null, signedInAt: null });
  assert.ok(row !== null, name);
  return { id: row.id, hash };
}
const session = (id: string, accountId: number, login: string, role: Role, kind: AccountKind = 'password'): Session =>
  ({ login, idHash: hex(id), csrf: tokenOf(id), accountId, kind, role });

interface Row { password_hash: string; one_time_until: string | null; failed_tries: number; wait_until: string | null; last_sign_in_at: string | null }
async function rowOf(db: Db, id: number): Promise<Row> {
  const rows = await db.query<{ password_hash: string; one_time_until: Date | null; failed_tries: number; wait_until: Date | null; last_sign_in_at: Date | null }>(
    'select password_hash, one_time_until, failed_tries, wait_until, last_sign_in_at from visto_ai.ui_accounts where id = $1', [id]);
  const r = rows[0]!;
  return {
    password_hash: r.password_hash, one_time_until: r.one_time_until?.toISOString() ?? null, failed_tries: r.failed_tries,
    wait_until: r.wait_until?.toISOString() ?? null, last_sign_in_at: r.last_sign_in_at?.toISOString() ?? null,
  };
}
const sessions = async (db: Db): Promise<unknown[]> =>
  (await db.query<{ id_hash: string; login: string; via: string; account_id: number; created_at: Date; last_used_at: Date; expires_at: Date }>(
    'select id_hash, login, via, account_id, created_at, last_used_at, expires_at from visto_ai.ui_sessions order by created_at, id_hash'))
    .map((r) => ({ ...r, created_at: r.created_at.toISOString(), last_used_at: r.last_used_at.toISOString(), expires_at: r.expires_at.toISOString() }));
const changesOf = (db: Db): Promise<unknown[]> =>
  db.query('select by_kind, by_name, change, account_kind, account_name, role from visto_ai.ui_account_changes order by id');
const sessionRow = (id: string, accountId: number, login: string, seconds = 0): unknown => ({
  id_hash: hex(id), login, via: 'password', account_id: accountId, created_at: iso(seconds), last_used_at: iso(seconds), expires_at: iso(seconds + 43200),
});
/** A reset committed by Task 3's statements: another one-time password, and every session of the account ended. */
const reset = (db: Db, id: number, hash: string): Promise<void> => db.transaction(async (tx) => {
  await setOneTime(tx, id, hash, iso(259200));
  await deleteSessionsOf(tx, id, null);
});
const RIGHT_TRY = 'update visto_ai.ui_accounts set failed_tries = 0, wait_until = null where id = $1 and password_hash = $2';
const SET_OWN = 'update visto_ai.ui_accounts set password_hash = $2, one_time_until = null, failed_tries = 0, wait_until = null';
/** A statement as [the guarded write it is, or its text; whether it ran inside a transaction]. */
const guarded = (s: { text: string; tx: boolean }): [string, boolean] => [[RIGHT_TRY, SET_OWN].find((p) => s.text.startsWith(p)) ?? s.text, s.tx];

test('a right password makes a session of twelve hours with the cookie of GitHub sign-in, and writes the last sign-in', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin', MINE);
  assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: MINE }), signedIn(A));
  assert.deepEqual(await sessions(h.db), [sessionRow(A, admin.id, 'octo-admin')]);
  assert.equal((await rowOf(h.db, admin.id)).last_sign_in_at, iso(0));
  assert.deepEqual(h.logs, [signin('ok')]);
  assert.deepEqual(h.verifies, [[MINE, admin.hash]]);

  // A name typed with a capital and a space after it is the same name.
  h.clock.now = at(5);
  assert.deepEqual(await h.auth.signIn({ name: 'Octo-Admin ', password: MINE }), signedIn(B));
  assert.deepEqual(await sessions(h.db), [sessionRow(A, admin.id, 'octo-admin'), sessionRow(B, admin.id, 'octo-admin', 5)]);
  assert.equal((await rowOf(h.db, admin.id)).last_sign_in_at, iso(5));
  assert.deepEqual(h.logs, [signin('ok'), signin('ok')]);
  await h.db.close();
});

test('a wrong password, a name that does not exist, a name of another shape and an account that waits are refused alike, each after one verify, the unknown and the waiting against the hash made at start', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin', MINE);
  const viewer = await account(h.db, 'octo-viewer', 'viewer', ANOTHER);
  await h.db.query('update visto_ai.ui_accounts set wait_until = $2::timestamptz where id = $1', [viewer.id, iso(900)]);
  const lead = await insertAccount(h.db, {
    kind: 'github', name: 'octo-lead', role: 'admin', passwordHash: null, oneTimeUntil: null, at: iso(0), by: 'command', byName: null, signedInAt: null,
  });
  assert.ok(lead !== null);

  const tries: Array<[Record<string, unknown>, string | null]> = [
    [{ name: 'octo-admin', password: WRONG }, admin.hash],
    [{ name: 'octo-nobody', password: MINE }, null],
    [{ name: 'octo admin!', password: MINE }, null],
    [{ name: 'octo-lead', password: MINE }, null],
    [{ name: 'octo-viewer', password: ANOTHER }, null],
  ];
  const starts: string[] = [];
  for (const [body, hash] of tries) {
    assert.deepEqual(await h.auth.signIn(body), REFUSED);
    const made = h.verifies.splice(0);
    assert.equal(made.length, 1, JSON.stringify(body));
    assert.equal(made[0]![0], body.password);
    if (hash === null) starts.push(made[0]![1]);
    else assert.equal(made[0]![1], hash);
  }
  assert.equal(new Set(starts).size, 1);
  assert.equal(starts.length, 4);
  const rows = await h.db.query<{ password_hash: string | null }>('select password_hash from visto_ai.ui_accounts');
  assert.ok(rows.every((r) => r.password_hash !== starts[0]));
  assert.ok(starts[0]!.startsWith('scrypt$4$1$1$'));
  assert.deepEqual(h.logs, tries.map(() => signin('refused')));
  // Only the wrong password is counted: the account that waits is not tried.
  assert.deepEqual([(await rowOf(h.db, admin.id)).failed_tries, (await rowOf(h.db, viewer.id)).failed_tries], [1, 0]);
  assert.deepEqual(await sessions(h.db), []);

  // The same refusals at the first password: one verify each, of the one-time password sent, against the hash made at start.
  const firsts: Array<Record<string, unknown>> = [
    { name: 'octo-nobody', oneTimePassword: ONE_TIME, password: MINE },
    { name: 'octo-lead', oneTimePassword: ONE_TIME, password: MINE },
    { name: 'octo-viewer', oneTimePassword: ANOTHER, password: THIRD },
    { name: 'octo admin!', oneTimePassword: ONE_TIME, password: MINE },
  ];
  for (const body of firsts) {
    assert.deepEqual(await h.auth.firstPassword(body), REFUSED, JSON.stringify(body));
    assert.deepEqual(h.verifies.splice(0), [[body.oneTimePassword, starts[0]]], JSON.stringify(body));
  }
  assert.deepEqual(h.logs, [...tries, ...firsts].map(() => signin('refused')));
  assert.deepEqual([(await rowOf(h.db, admin.id)).failed_tries, (await rowOf(h.db, viewer.id)).failed_tries], [1, 0]);
  assert.deepEqual([await sessions(h.db), await changesOf(h.db)], [[], []]);
  await h.db.close();
});

test('five wrong passwords in a row make the account wait 15 minutes by the clock, even for the right one; then it signs in, and a right one clears the count', async () => {
  assert.deepEqual([WRONG_TRIES, WAIT_MS], [5, 900_000]);
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin', MINE);
  for (let i = 0; i < 4; i += 1) assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: WRONG }), REFUSED);
  assert.deepEqual([(await rowOf(h.db, admin.id)).failed_tries, (await rowOf(h.db, admin.id)).wait_until], [4, null]);
  assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: MINE }), signedIn(A));
  assert.equal((await rowOf(h.db, admin.id)).failed_tries, 0);

  for (let i = 0; i < 5; i += 1) assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: WRONG }), REFUSED);
  assert.deepEqual([(await rowOf(h.db, admin.id)).failed_tries, (await rowOf(h.db, admin.id)).wait_until], [0, iso(900)]);
  h.clock.now = at(899);
  h.verifies.length = 0;
  assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: MINE }), REFUSED);
  assert.equal(h.verifies.length, 1);
  assert.notEqual(h.verifies[0]![1], admin.hash);
  assert.deepEqual([(await rowOf(h.db, admin.id)).failed_tries, (await rowOf(h.db, admin.id)).wait_until], [0, iso(900)]);

  h.clock.now = at(900);
  assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: MINE }), signedIn(B));
  assert.deepEqual([(await rowOf(h.db, admin.id)).failed_tries, (await rowOf(h.db, admin.id)).wait_until], [0, null]);
  assert.deepEqual(h.logs, [
    ...Array.from({ length: 4 }, () => signin('refused')), signin('ok'), ...Array.from({ length: 6 }, () => signin('refused')), signin('ok'),
  ]);
  await h.db.close();
});

test('five wrong one-time passwords at the first password, or five wrong current passwords at a change, make the account wait 15 minutes by the clock', async () => {
  const h = await harness();
  const fresh = await account(h.db, 'octo-new', 'viewer', ONE_TIME, iso(259200));
  const admin = await account(h.db, 'octo-admin', 'admin', MINE);
  const s = session(A, admin.id, 'octo-admin', 'admin');
  h.clock.now = at(100);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(await h.auth.firstPassword({ name: 'octo-new', oneTimePassword: ONE_TIME_2, password: MINE }), REFUSED);
    assert.deepEqual(await h.auth.change(s, { current: WRONG, password: ANOTHER }), WRONG_PASSWORD);
  }
  for (const id of [fresh.id, admin.id]) {
    const row = await rowOf(h.db, id);
    assert.deepEqual([row.failed_tries, row.wait_until], [0, iso(1000)]);
  }
  assert.deepEqual(h.logs, Array.from({ length: 5 }, () => signin('refused')));
  await h.db.close();
});

test('a right one-time password asks for a password and makes no session; an expired one is refused as expired', async () => {
  const h = await harness();
  const fresh = await account(h.db, 'octo-new', 'viewer', ONE_TIME, iso(259200));
  assert.deepEqual(await h.auth.signIn({ name: 'octo-new', password: WRONG }), REFUSED);
  assert.equal((await rowOf(h.db, fresh.id)).failed_tries, 1);
  // The right one clears the count, and its answer sets no cookie.
  assert.deepEqual(await h.auth.signIn({ name: 'octo-new', password: ONE_TIME }), CHOOSE);
  assert.equal((await rowOf(h.db, fresh.id)).failed_tries, 0);
  h.clock.now = at(259199);
  assert.deepEqual(await h.auth.signIn({ name: 'octo-new', password: ONE_TIME }), CHOOSE);
  assert.deepEqual(await sessions(h.db), []);
  assert.equal((await rowOf(h.db, fresh.id)).last_sign_in_at, null);

  h.clock.now = at(259200);
  assert.deepEqual(await h.auth.signIn({ name: 'octo-new', password: ONE_TIME }), EXPIRED);
  assert.deepEqual(await h.auth.signIn({ name: 'octo-new', password: WRONG }), REFUSED);
  assert.deepEqual((await rowOf(h.db, fresh.id)).one_time_until, iso(259200));
  assert.deepEqual(await sessions(h.db), []);
  assert.deepEqual(h.logs, [signin('refused'), signin('choose'), signin('choose'), signin('expired'), signin('refused')]);

  // The first password at the same time, exactly 72 hours after the one-time password was made: expired too, and nothing is made.
  assert.deepEqual(await h.auth.firstPassword({ name: 'octo-new', oneTimePassword: ONE_TIME, password: MINE }), EXPIRED);
  const row = await rowOf(h.db, fresh.id);
  assert.deepEqual([row.password_hash, row.one_time_until, row.last_sign_in_at], [fresh.hash, iso(259200), null]);
  assert.deepEqual([await sessions(h.db), await changesOf(h.db)], [[], []]);
  assert.deepEqual(h.logs, [signin('refused'), signin('choose'), signin('choose'), signin('expired'), signin('refused'), signin('expired')]);
  await h.db.close();
});

test('the first password signs in, ends the one-time password, is recorded and logged, and needs the one-time password again', async () => {
  const h = await harness();
  const fresh = await account(h.db, 'octo-new', 'viewer', ONE_TIME, iso(259200));
  assert.deepEqual(await h.auth.firstPassword({ name: 'octo-new', oneTimePassword: ONE_TIME_2, password: MINE }), REFUSED);
  assert.deepEqual(h.verifies.splice(0), [[ONE_TIME_2, fresh.hash]]);
  assert.deepEqual([(await rowOf(h.db, fresh.id)).failed_tries, (await rowOf(h.db, fresh.id)).password_hash], [1, fresh.hash]);
  assert.deepEqual(await sessions(h.db), []);

  h.clock.now = at(10);
  assert.deepEqual(await h.auth.firstPassword({ name: 'Octo-New', oneTimePassword: ONE_TIME, password: MINE }), signedIn(A));
  assert.deepEqual(h.verifies.splice(0), [[ONE_TIME, fresh.hash]]);
  const row = await rowOf(h.db, fresh.id);
  assert.deepEqual([row.one_time_until, row.failed_tries, row.wait_until, row.last_sign_in_at], [null, 0, null, iso(10)]);
  assert.equal(await verifyPassword(MINE, row.password_hash), true);
  assert.equal(await verifyPassword(ONE_TIME, row.password_hash), false);
  assert.ok(row.password_hash.startsWith('scrypt$4$1$1$'));
  assert.deepEqual(await sessions(h.db), [sessionRow(A, fresh.id, 'octo-new', 10)]);
  assert.deepEqual(await changesOf(h.db), [
    { by_kind: 'password', by_name: 'octo-new', change: 'password_changed', account_kind: 'password', account_name: 'octo-new', role: 'viewer' },
  ]);
  assert.deepEqual(h.logs, [signin('refused'), changed('viewer'), signin('ok')]);

  // The one-time password is over: it signs in no more, the new one does.
  assert.deepEqual(await h.auth.signIn({ name: 'octo-new', password: ONE_TIME }), REFUSED);
  assert.deepEqual(await h.auth.signIn({ name: 'octo-new', password: MINE }), signedIn(B));
  await h.db.close();
});

test('a first password that is too short, too long, or the one-time password itself is refused before any verify', async () => {
  const h = await harness();
  const fresh = await account(h.db, 'octo-new', 'viewer', ONE_TIME, iso(259200));
  const first = (password: string): Promise<UiAnswer> => h.auth.firstPassword({ name: 'octo-new', oneTimePassword: ONE_TIME, password });
  assert.deepEqual(await first('a'.repeat(11)), error(400, 'password_length'));
  assert.deepEqual(await first('a'.repeat(129)), error(400, 'password_length'));
  // Task 2's fix: a new password holding U+0000 is refused as one of the wrong length.
  assert.deepEqual(await first('a long password\0 of mine'), error(400, 'password_length'));
  assert.deepEqual(await first(ONE_TIME), error(400, 'same_password'));
  assert.deepEqual([h.statements, h.verifies], [[], []]);
  assert.deepEqual(h.logs, [
    signin('bad_request', 'password_length'), signin('bad_request', 'password_length'), signin('bad_request', 'password_length'),
    signin('bad_request', 'same_password'),
  ]);
  assert.deepEqual((await rowOf(h.db, fresh.id)).password_hash, fresh.hash);
  await h.db.close();
});

test('a first password for an account that chose its own already is refused as already_chosen', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin', MINE);
  assert.deepEqual(await h.auth.firstPassword({ name: 'octo-admin', oneTimePassword: MINE, password: ANOTHER }), error(409, 'already_chosen'));
  assert.deepEqual(h.verifies, [[MINE, admin.hash]]);
  const row = await rowOf(h.db, admin.id);
  assert.deepEqual([row.password_hash, row.one_time_until, row.last_sign_in_at], [admin.hash, null, null]);
  assert.deepEqual([await sessions(h.db), await changesOf(h.db)], [[], []]);
  assert.deepEqual(h.logs, [signin('already_chosen')]);
  await h.db.close();
});

test('a first password whose one-time password was reset meanwhile is refused', async () => {
  const h = await harness();
  const fresh = await account(h.db, 'octo-new', 'viewer', ONE_TIME, iso(100));
  const other = await hashPassword(ONE_TIME_2, COST);
  h.during = () => reset(h.db, fresh.id, other);
  assert.deepEqual(await h.auth.firstPassword({ name: 'octo-new', oneTimePassword: ONE_TIME, password: MINE }), REFUSED);
  assert.equal(h.during, null);
  const row = await rowOf(h.db, fresh.id);
  assert.deepEqual([row.password_hash, row.one_time_until], [other, iso(259200)]);
  // After the verify, only the guarded right try ran, and it wrote nothing.
  assert.deepEqual(h.statements.slice(h.verified.at(-1)).map((s) => s.text.startsWith(RIGHT_TRY)), [true]);
  assert.deepEqual([await sessions(h.db), await changesOf(h.db)], [[], []]);
  assert.deepEqual(h.logs, [signin('refused')]);

  // A reset committed after the right try, while the new hash is made and before the guarded write: refused, and nothing written.
  const third = await hashPassword(ONE_TIME, COST);
  h.atTransaction = () => reset(h.db, fresh.id, third);
  assert.deepEqual(await h.auth.firstPassword({ name: 'octo-new', oneTimePassword: ONE_TIME_2, password: MINE }), REFUSED);
  assert.equal(h.atTransaction, null);
  assert.deepEqual(h.verifies.at(-1), [ONE_TIME_2, other]);
  const again = await rowOf(h.db, fresh.id);
  assert.deepEqual([again.password_hash, again.one_time_until, again.last_sign_in_at], [third, iso(259200), null]);
  assert.deepEqual(h.statements.slice(h.verified.at(-1)).map(guarded), [[RIGHT_TRY, false], [SET_OWN, true]]);
  assert.deepEqual([await sessions(h.db), await changesOf(h.db)], [[], []]);
  assert.deepEqual(h.logs, [signin('refused'), signin('refused')]);
  await h.db.close();
});

test('a reset committed while a sign-in verifies makes no session', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin', MINE);
  const other = await hashPassword(ONE_TIME_2, COST);
  h.during = () => reset(h.db, admin.id, other);
  const refused = await h.auth.signIn({ name: 'octo-admin', password: MINE });
  assert.deepEqual(refused, REFUSED);
  assert.equal(refused.headers['set-cookie'], undefined);
  assert.deepEqual(await sessions(h.db), []);
  const row = await rowOf(h.db, admin.id);
  assert.deepEqual([row.password_hash, row.last_sign_in_at], [other, null]);
  const after = h.statements.slice(h.verified.at(-1));
  assert.deepEqual(after.map((s) => [s.text.startsWith(RIGHT_TRY), s.tx]), [[true, true]]);
  assert.deepEqual(h.logs, [signin('refused')]);
  await h.db.close();
});

test("a change of one's own password while another sign-in verifies makes no session", async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin', MINE);
  assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: MINE }), signedIn(A));
  const s = session(A, admin.id, 'octo-admin', 'admin');
  let made: UiAnswer | null = null;
  h.during = async () => { made = await h.auth.change(s, { current: MINE, password: ANOTHER }); };
  assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: MINE }), REFUSED);
  assert.deepEqual(made, CHANGED);
  assert.deepEqual(await sessions(h.db), [sessionRow(A, admin.id, 'octo-admin')]);
  assert.equal(await verifyPassword(ANOTHER, (await rowOf(h.db, admin.id)).password_hash), true);
  assert.deepEqual(h.logs, [signin('ok'), changed('admin'), signin('refused')]);
  await h.db.close();
});

test('a right password whose verify began before the wait makes no session, and the wait holds', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin', MINE);
  for (let i = 0; i < 4; i += 1) assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: WRONG }), REFUSED);
  h.verifies.length = 0;
  // The fifth wrong one, sent at the same time, is verified and counted while the right one verifies.
  let fifth: UiAnswer | null = null;
  h.during = async () => { fifth = await h.auth.signIn({ name: 'octo-admin', password: WRONG }); };
  const refused = await h.auth.signIn({ name: 'octo-admin', password: MINE });
  assert.deepEqual([refused, fifth], [REFUSED, REFUSED]);
  assert.equal(refused.headers['set-cookie'], undefined);
  // Both read the row before the wait began, and verified against its hash.
  assert.deepEqual(h.verifies, [[MINE, admin.hash], [WRONG, admin.hash]]);
  const row = await rowOf(h.db, admin.id);
  assert.deepEqual([row.failed_tries, row.wait_until, row.last_sign_in_at], [0, iso(900), null]);
  assert.deepEqual(await sessions(h.db), []);
  // After the right one's verify, only its guarded right try ran, inside the transaction, and it wrote nothing.
  assert.deepEqual(h.statements.slice(h.verified.at(-1)).map(guarded), [[RIGHT_TRY, true]]);
  assert.deepEqual(h.logs, Array.from({ length: 6 }, () => signin('refused')));

  // A one-time password's account the same way: the right one-time password asks for nothing once the fifth wrong one, verified
  // while it verified, started the wait.
  const fresh = await account(h.db, 'octo-new', 'viewer', ONE_TIME, iso(259200));
  for (let i = 0; i < 4; i += 1) assert.deepEqual(await h.auth.signIn({ name: 'octo-new', password: WRONG }), REFUSED);
  h.verifies.length = 0;
  let fifthOneTime: UiAnswer | null = null;
  h.during = async () => { fifthOneTime = await h.auth.signIn({ name: 'octo-new', password: WRONG }); };
  assert.deepEqual(await h.auth.signIn({ name: 'octo-new', password: ONE_TIME }), REFUSED);
  assert.deepEqual(fifthOneTime, REFUSED);
  assert.deepEqual(h.verifies, [[ONE_TIME, fresh.hash], [WRONG, fresh.hash]]);
  const waiting = await rowOf(h.db, fresh.id);
  assert.deepEqual([waiting.password_hash, waiting.one_time_until, waiting.failed_tries, waiting.wait_until], [fresh.hash, iso(259200), 0, iso(900)]);
  assert.deepEqual(h.statements.slice(h.verified.at(-1)).map(guarded), [[RIGHT_TRY, false]]);
  assert.deepEqual([await sessions(h.db), await changesOf(h.db)], [[], []]);
  assert.deepEqual(h.logs, Array.from({ length: 12 }, () => signin('refused')));
  await h.db.close();
});

test('a first password whose verify began before the wait, or whose wait began before its guarded write, is refused', async () => {
  const h = await harness();
  const fresh = await account(h.db, 'octo-new', 'viewer', ONE_TIME, iso(259200));
  const wrong = { name: 'octo-new', oneTimePassword: ONE_TIME_2, password: MINE };
  const right = { name: 'octo-new', oneTimePassword: ONE_TIME, password: MINE };
  for (let i = 0; i < 4; i += 1) assert.deepEqual(await h.auth.firstPassword(wrong), REFUSED);
  h.verifies.length = 0;
  let fifth: UiAnswer | null = null;
  h.during = async () => { fifth = await h.auth.firstPassword(wrong); };
  assert.deepEqual(await h.auth.firstPassword(right), REFUSED);
  assert.deepEqual(fifth, REFUSED);
  assert.deepEqual(h.verifies.splice(0), [[ONE_TIME, fresh.hash], [ONE_TIME_2, fresh.hash]]);
  let row = await rowOf(h.db, fresh.id);
  assert.deepEqual([row.password_hash, row.one_time_until, row.failed_tries, row.wait_until], [fresh.hash, iso(259200), 0, iso(900)]);
  assert.deepEqual(h.statements.slice(h.verified.at(-1)).map(guarded), [[RIGHT_TRY, false]]);

  // At the wait's end it does not wait. Five wrong ones counted after its right try, while the new hash is made, start another
  // wait before the guarded write, which then writes nothing.
  h.clock.now = at(900);
  h.atTransaction = async () => { for (let i = 0; i < 5; i += 1) await wrongTry(h.db, fresh.id, iso(1800)); };
  assert.deepEqual(await h.auth.firstPassword(right), REFUSED);
  assert.equal(h.atTransaction, null);
  assert.deepEqual(h.verifies.splice(0), [[ONE_TIME, fresh.hash]]);
  row = await rowOf(h.db, fresh.id);
  assert.deepEqual([row.password_hash, row.one_time_until, row.failed_tries, row.wait_until], [fresh.hash, iso(259200), 0, iso(1800)]);
  assert.deepEqual(h.statements.slice(h.verified.at(-1)).map(guarded), [[RIGHT_TRY, false], [SET_OWN, true]]);
  assert.deepEqual([await sessions(h.db), await changesOf(h.db)], [[], []]);
  assert.deepEqual(h.logs, Array.from({ length: 7 }, () => signin('refused')));
  await h.db.close();
});

test('a change whose verify began before the wait, or whose wait began before its guarded write, is wrong_password and changes nothing', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin', MINE);
  for (const [i, id] of [A, B].entries()) {
    await createSession(h.db, { idHash: hex(id), login: 'octo-admin', via: 'password', accountId: admin.id, at: iso(i), expiresAt: iso(i + 43200) });
  }
  const s = session(A, admin.id, 'octo-admin', 'admin');
  const wrong = { current: WRONG, password: ANOTHER };
  const right = { current: MINE, password: ANOTHER };
  for (let i = 0; i < 4; i += 1) assert.deepEqual(await h.auth.change(s, wrong), WRONG_PASSWORD);
  h.verifies.length = 0;
  let fifth: UiAnswer | null = null;
  h.during = async () => { fifth = await h.auth.change(s, wrong); };
  assert.deepEqual(await h.auth.change(s, right), WRONG_PASSWORD);
  assert.deepEqual(fifth, WRONG_PASSWORD);
  assert.deepEqual(h.verifies.splice(0), [[MINE, admin.hash], [WRONG, admin.hash]]);
  let row = await rowOf(h.db, admin.id);
  assert.deepEqual([row.password_hash, row.failed_tries, row.wait_until], [admin.hash, 0, iso(900)]);
  assert.deepEqual(h.statements.slice(h.verified.at(-1)).map(guarded), [[RIGHT_TRY, false]]);

  // At the wait's end it does not wait; a wait begun after its right try, before the guarded write, refuses the write.
  h.clock.now = at(900);
  h.atTransaction = async () => { for (let i = 0; i < 5; i += 1) await wrongTry(h.db, admin.id, iso(1800)); };
  assert.deepEqual(await h.auth.change(s, right), WRONG_PASSWORD);
  assert.equal(h.atTransaction, null);
  assert.deepEqual(h.verifies.splice(0), [[MINE, admin.hash]]);
  row = await rowOf(h.db, admin.id);
  assert.deepEqual([row.password_hash, row.failed_tries, row.wait_until], [admin.hash, 0, iso(1800)]);
  assert.deepEqual(h.statements.slice(h.verified.at(-1)).map(guarded), [[RIGHT_TRY, false], [SET_OWN, true]]);
  assert.deepEqual(await sessions(h.db), [sessionRow(A, admin.id, 'octo-admin'), sessionRow(B, admin.id, 'octo-admin', 1)]);
  assert.deepEqual([await changesOf(h.db), h.logs], [[], []]);
  await h.db.close();
});

test("changing one's own password needs the current one, ends the other sessions and keeps this one", async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin', MINE);
  assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: MINE }), signedIn(A));
  assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: MINE }), signedIn(B));
  const s = session(A, admin.id, 'octo-admin', 'admin');
  h.verifies.length = 0;

  h.clock.now = at(20);
  assert.deepEqual(await h.auth.change(s, { current: MINE, password: ANOTHER }), CHANGED);
  assert.deepEqual(h.verifies.splice(0), [[MINE, admin.hash]]);
  assert.deepEqual(await sessions(h.db), [sessionRow(A, admin.id, 'octo-admin')]);
  assert.equal((await readSession(h.db, hex(A), iso(20)))?.accountId, admin.id);
  const row = await rowOf(h.db, admin.id);
  assert.equal(await verifyPassword(ANOTHER, row.password_hash), true);
  assert.deepEqual([row.one_time_until, row.failed_tries, row.wait_until], [null, 0, null]);
  assert.deepEqual(await changesOf(h.db), [
    { by_kind: 'password', by_name: 'octo-admin', change: 'password_changed', account_kind: 'password', account_name: 'octo-admin', role: 'admin' },
  ]);
  assert.deepEqual(h.logs, [signin('ok'), signin('ok'), changed('admin')]);

  // A wrong current password is a wrong try.
  assert.deepEqual(await h.auth.change(s, { current: MINE, password: THIRD }), WRONG_PASSWORD);
  assert.deepEqual(h.verifies.splice(0), [[MINE, row.password_hash]]);
  assert.deepEqual([(await rowOf(h.db, admin.id)).failed_tries, (await rowOf(h.db, admin.id)).password_hash], [1, row.password_hash]);
  // A new password of the wrong length is refused before anything is read.
  const statements = h.statements.length;
  assert.deepEqual(await h.auth.change(s, { current: ANOTHER, password: 'a'.repeat(11) }), error(400, 'password_length'));
  assert.deepEqual([h.statements.length, h.verifies.length], [statements, 0]);
  // An account that waits: the hash made at start is verified, never its own.
  await h.db.query('update visto_ai.ui_accounts set wait_until = $2::timestamptz where id = $1', [admin.id, iso(900)]);
  assert.deepEqual(await h.auth.change(s, { current: ANOTHER, password: THIRD }), WRONG_PASSWORD);
  const waited = h.verifies.splice(0);
  assert.equal(waited.length, 1);
  assert.equal(waited[0]![0], ANOTHER);
  assert.notEqual(waited[0]![1], row.password_hash);
  assert.ok(waited[0]![1].startsWith('scrypt$4$1$1$'));
  assert.deepEqual([(await rowOf(h.db, admin.id)).failed_tries, (await rowOf(h.db, admin.id)).password_hash], [1, row.password_hash]);
  // A session whose account is gone.
  assert.deepEqual(await h.auth.change(session(C, 9999, 'octo-gone', 'admin'), { current: ANOTHER, password: THIRD }), error(401, 'signed_out'));
  assert.deepEqual(h.logs, [signin('ok'), signin('ok'), changed('admin')]);
  assert.equal((await changesOf(h.db)).length, 1);

  // At the wait's end it does not wait. A reset committed after the right try, while the new hash is made and before the guarded
  // write: wrong_password, and the change writes nothing (the reset itself ends every session of the account).
  h.clock.now = at(900);
  const one = await hashPassword(ONE_TIME, COST);
  h.atTransaction = () => reset(h.db, admin.id, one);
  assert.deepEqual(await h.auth.change(s, { current: ANOTHER, password: THIRD }), WRONG_PASSWORD);
  assert.equal(h.atTransaction, null);
  assert.deepEqual(h.verifies.splice(0), [[ANOTHER, row.password_hash]]);
  assert.deepEqual(h.statements.slice(h.verified.at(-1)).map(guarded), [[RIGHT_TRY, false], [SET_OWN, true]]);
  const afterReset = await rowOf(h.db, admin.id);
  assert.deepEqual([afterReset.password_hash, afterReset.one_time_until], [one, iso(259200)]);
  assert.deepEqual(h.logs, [signin('ok'), signin('ok'), changed('admin')]);
  assert.equal((await changesOf(h.db)).length, 1);
  await h.db.close();
});

test('a GitHub session cannot change a password', async () => {
  const h = await harness();
  const lead = session(A, 1, 'octo-lead', 'admin', 'github');
  assert.deepEqual(await h.auth.change(lead, { current: MINE, password: ANOTHER }), error(409, 'github_account'));
  assert.deepEqual(await h.auth.change(lead, {}), error(409, 'github_account'));
  assert.deepEqual([h.statements, h.verifies, h.logs], [[], [], []]);
  await h.db.close();
});

test('a body of the wrong shape is bad_request, and nothing is read', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin', MINE);
  const BAD = error(400, 'bad_request');
  const signIns: Array<Record<string, unknown>> = [
    {}, { name: 'x' }, { password: MINE }, { name: 7, password: 'x' }, { name: 'octo-admin', password: null }, { name: 'octo-admin', password: MINE, extra: 1 },
    { name: 'a'.repeat(201), password: MINE }, { name: 'octo-admin', password: 'p'.repeat(1025) }, JSON.parse('{"name":"octo-admin","password":"x","__proto__":1}'),
  ];
  for (const body of signIns) assert.deepEqual(await h.auth.signIn(body), BAD, JSON.stringify(body));
  const firsts: Array<Record<string, unknown>> = [
    {}, { name: 'octo-new', password: MINE }, { name: 'octo-new', oneTimePassword: ONE_TIME, password: MINE, extra: 1 },
    { name: 'octo-new', oneTimePassword: 7, password: MINE }, { name: 'a'.repeat(201), oneTimePassword: ONE_TIME, password: MINE },
    { name: 'octo-new', oneTimePassword: 'o'.repeat(1025), password: MINE }, { name: 'octo-new', oneTimePassword: ONE_TIME, password: 'p'.repeat(1025) },
  ];
  for (const body of firsts) assert.deepEqual(await h.auth.firstPassword(body), BAD, JSON.stringify(body));
  const s = session(A, admin.id, 'octo-admin', 'admin');
  const changes: Array<Record<string, unknown>> = [
    {}, { current: MINE }, { current: MINE, password: ANOTHER, extra: 1 }, { current: 7, password: ANOTHER }, { current: 'c'.repeat(1025), password: ANOTHER },
    { current: MINE, password: 'p'.repeat(1025) }, { name: 'octo-admin', password: ANOTHER },
  ];
  for (const body of changes) assert.deepEqual(await h.auth.change(s, body), BAD, JSON.stringify(body));
  assert.deepEqual([h.statements, h.verifies], [[], []]);
  assert.deepEqual(h.logs, [...signIns, ...firsts].map(() => signin('bad_request', 'bad_request')));

  // At the bounds the body holds: a name of 200 characters is no account, a password of 1,024 a wrong one.
  assert.deepEqual(await h.auth.signIn({ name: 'a'.repeat(200), password: MINE }), REFUSED);
  assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: 'p'.repeat(1024) }), REFUSED);
  assert.equal(h.verifies.length, 2);
  await h.db.close();
});

test('expired sessions are deleted at a password sign-in or a first password, at most once a minute between them, and after the body holds', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin', MINE);
  await account(h.db, 'octo-new', 'viewer', ONE_TIME, iso(259200));
  await createSession(h.db, { idHash: 'old-session', login: 'octo-admin', via: 'password', accountId: admin.id, at: iso(-43200), expiresAt: iso(0) });
  await h.db.query(`insert into visto_ai.ui_states (state_hash, verifier_hash, expires_at) values ('old-state', 'v', $1::timestamptz)`, [iso(0)]);
  const sweeps = (): string[] => h.statements.filter((s) => s.text.includes('expires_at <= $1')).map((s) => s.at);

  assert.deepEqual(await h.auth.signIn({ name: 'octo-nobody', password: MINE }), REFUSED);
  assert.deepEqual(await h.db.query('select (select count(*)::int from visto_ai.ui_sessions) as s, (select count(*)::int from visto_ai.ui_states) as t'), [{ s: 0, t: 0 }]);
  h.clock.now = at(30);
  assert.deepEqual(await h.auth.firstPassword({ name: 'octo-new', oneTimePassword: ONE_TIME_2, password: MINE }), REFUSED);
  h.clock.now = at(60);
  assert.deepEqual(await h.auth.signIn({ name: 'octo-nobody', password: MINE }), REFUSED);
  h.clock.now = at(90);
  assert.deepEqual(await h.auth.firstPassword({ name: 'octo-new', oneTimePassword: ONE_TIME_2, password: MINE }), REFUSED);
  assert.deepEqual(sweeps(), [iso(0), iso(0), iso(60), iso(60)]);

  h.clock.now = at(200);
  assert.deepEqual(await h.auth.signIn({}), error(400, 'bad_request'));
  assert.deepEqual(await h.auth.firstPassword({ name: 'octo-new', oneTimePassword: ONE_TIME, password: 'a'.repeat(11) }), error(400, 'password_length'));
  assert.deepEqual(sweeps(), [iso(0), iso(0), iso(60), iso(60)]);
  // Another object keeps its own time of the last sweep.
  await h.another().signIn({ name: 'octo-nobody', password: MINE });
  assert.deepEqual(sweeps(), [iso(0), iso(0), iso(60), iso(60), iso(200), iso(200)]);
  await h.db.close();
});

test('a database step that fails answers internal_error, logs failed with its code, and makes no session', async () => {
  const set = async (h: Harness): Promise<{ admin: { id: number; hash: string }; fresh: { id: number; hash: string } }> => {
    const admin = await account(h.db, 'octo-admin', 'admin', MINE);
    const fresh = await account(h.db, 'octo-new', 'viewer', ONE_TIME, iso(259200));
    await createSession(h.db, { idHash: hex(nth(20)), login: 'octo-admin', via: 'password', accountId: admin.id, at: iso(0), expiresAt: iso(43200) });
    await createSession(h.db, { idHash: hex(nth(21)), login: 'octo-admin', via: 'password', accountId: admin.id, at: iso(0), expiresAt: iso(43200) });
    return { admin, fresh };
  };
  type Way = (auth: PasswordAuth, s: Session) => Promise<UiAnswer>;
  const signIns: Way[] = [
    (auth) => auth.signIn({ name: 'octo-admin', password: WRONG }),
    (auth) => auth.signIn({ name: 'octo-admin', password: MINE }),
    (auth) => auth.signIn({ name: 'octo-new', password: ONE_TIME }),
    (auth) => auth.firstPassword({ name: 'octo-new', oneTimePassword: ONE_TIME, password: ANOTHER }),
  ];
  const changes: Way[] = [
    (auth, s) => auth.change(s, { current: WRONG, password: ANOTHER }),
    (auth, s) => auth.change(s, { current: MINE, password: ANOTHER }),
  ];

  // The statements of each way, in order, read from a run on another database that does not fail (the change last, as it
  // changes the password the sign-ins use).
  const probe = await harness();
  const probed = await set(probe);
  const ps = session(nth(20), probed.admin.id, 'octo-admin', 'admin');
  const texts: string[][] = [];
  for (const way of [...signIns, ...changes]) {
    const before = probe.statements.length;
    await way(probe.another(), ps);
    texts.push(probe.statements.slice(before).map((s) => s.text));
  }
  await probe.db.close();
  const signInTexts = texts.slice(0, signIns.length);
  const [wrongChange = [], rightChange = []] = texts.slice(signIns.length);
  assert.deepEqual([...signInTexts.map((t) => t.length), wrongChange.length, rightChange.length], [4, 6, 4, 8, 2, 5]);

  const h = await harness();
  const { admin, fresh } = await set(h);
  const s = session(nth(20), admin.id, 'octo-admin', 'admin');
  const before = async (): Promise<unknown[]> => [await rowOf(h.db, admin.id), await rowOf(h.db, fresh.id), await sessions(h.db), await changesOf(h.db)];
  const kept = await before();
  let step = 0;
  for (const [i, way] of signIns.entries()) {
    for (const text of signInTexts[i]!) {
      h.clock.now = at(60 * ++step);
      h.failing.text = text;
      const logs = h.logs.length;
      assert.deepEqual(await way(h.auth, s), INTERNAL, text);
      assert.deepEqual(h.logs.slice(logs), [signin('failed', 'db_down')], text);
      h.failing.text = null;
    }
  }
  for (const [i, way] of changes.entries()) {
    for (const text of (i === 0 ? wrongChange : rightChange)) {
      h.failing.text = text;
      const logs = h.logs.length;
      await assert.rejects(way(h.auth, s), (e) => e === DOWN, text);
      assert.equal(h.logs.length, logs, text);
      h.failing.text = null;
    }
  }
  assert.deepEqual(await before(), kept);

  // The hash made at start rejects bad_cost: a request that needs it fails, as one does whose new hash rejects.
  const bad = h.another({ log2N: 3, r: 1, p: 1 });
  h.logs.length = 0;
  assert.deepEqual(await bad.signIn({ name: 'octo-nobody', password: MINE }), INTERNAL);
  assert.deepEqual(await bad.firstPassword({ name: 'octo-new', oneTimePassword: ONE_TIME, password: ANOTHER }), INTERNAL);
  await assert.rejects(bad.change(s, { current: MINE, password: ANOTHER }), /^Error: bad_cost$/);
  assert.deepEqual(h.logs, [signin('failed', 'bad_cost'), signin('failed', 'bad_cost')]);
  // A clock that gives no time fails before any statement.
  h.clock.now = new Date(Number.NaN);
  const statements = h.statements.length;
  assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: MINE }), INTERNAL);
  await assert.rejects(h.auth.change(s, { current: MINE, password: ANOTHER }));
  assert.equal(h.statements.length, statements);
  assert.deepEqual(h.logs.at(-1), signin('failed', 'internal_error'));
  assert.deepEqual(await before(), kept);
  await h.db.close();
});

test('a hash made at start that rejected is made again by the next request, and until it is made every name is answered alike, before anything is read', async () => {
  const h = await harness();
  await account(h.db, 'octo-admin', 'admin', MINE);
  await account(h.db, 'octo-new', 'viewer', ONE_TIME, iso(259200));
  const viewer = await account(h.db, 'octo-viewer', 'viewer', ANOTHER);
  await h.db.query('update visto_ai.ui_accounts set wait_until = $2::timestamptz where id = $1', [viewer.id, iso(900)]);
  const lead = await insertAccount(h.db, {
    kind: 'github', name: 'octo-lead', role: 'admin', passwordHash: null, oneTimeUntil: null, at: iso(0), by: 'command', byName: null, signedInAt: null,
  });
  assert.ok(lead !== null);
  /** A cost read out of bounds once, by the hash made at start, and as COST after: that hash rejects bad_cost once. */
  const rejectingOnce = (): PasswordCost => {
    let reads = 0;
    return { get log2N() { reads += 1; return reads === 1 ? 3 : COST.log2N; }, r: COST.r, p: COST.p };
  };
  type Way = (auth: PasswordAuth) => Promise<UiAnswer>;
  // Each way, and its answer once the hash made at start is made.
  const ways: Array<[string, Way, UiAnswer]> = [
    ['a known name with a wrong password', (auth) => auth.signIn({ name: 'octo-admin', password: WRONG }), REFUSED],
    ['a known name with its password', (auth) => auth.signIn({ name: 'octo-admin', password: MINE }), signedIn(A)],
    ['a name that does not exist', (auth) => auth.signIn({ name: 'octo-nobody', password: MINE }), REFUSED],
    ['a name of another shape', (auth) => auth.signIn({ name: 'octo admin!', password: MINE }), REFUSED],
    ['a GitHub login', (auth) => auth.signIn({ name: 'octo-lead', password: MINE }), REFUSED],
    ['an account that waits', (auth) => auth.signIn({ name: 'octo-viewer', password: ANOTHER }), REFUSED],
    ['a first password of a known name', (auth) => auth.firstPassword({ name: 'octo-new', oneTimePassword: ONE_TIME_2, password: MINE }), REFUSED],
    ['a first password of a name that does not exist', (auth) => auth.firstPassword({ name: 'octo-nobody', oneTimePassword: ONE_TIME, password: MINE }), REFUSED],
  ];
  /** The answer of `way` on `auth`, and the statements, verifies and log lines it made. */
  const made = async (way: Way, auth: PasswordAuth): Promise<[UiAnswer, unknown[], unknown[], unknown[]]> => {
    const [statements, verifies, logs] = [h.statements.length, h.verifies.length, h.logs.length];
    const answered = await way(auth);
    return [answered, h.statements.slice(statements), h.verifies.slice(verifies), h.logs.slice(logs)];
  };

  // The first request meets the attempt that rejected: 500 whatever the name, nothing read or verified; the next ones answer as usual.
  for (const [what, way, usual] of ways) {
    const auth = h.another(rejectingOnce());
    assert.deepEqual(await made(way, auth), [INTERNAL, [], [], [signin('failed', 'bad_cost')]], what);
    const [again] = await made(way, auth);
    assert.deepEqual(again, usual, what);
    assert.deepEqual(await auth.signIn({ name: 'octo-nobody', password: MINE }), REFUSED, what);
    assert.ok(h.verifies.at(-1)![1].startsWith('scrypt$4$1$1$'), what);
  }

  // A hash made at start that always rejects: made again at each request, and every name answered 500 before anything is read.
  const never = h.another({ log2N: 3, r: 1, p: 1 });
  for (const [what, way] of ways) {
    for (let i = 0; i < 2; i += 1) assert.deepEqual(await made(way, never), [INTERNAL, [], [], [signin('failed', 'bad_cost')]], `${what} ${i}`);
  }
  await h.db.close();
});

test('no answer, log line, row or error holds a password, a one-time password, a hash or a name, but the hash in its own column', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin', MINE);
  await account(h.db, 'octo-new', 'viewer', ONE_TIME, iso(259200));
  await h.auth.signIn({ name: 'octo-admin', password: WRONG });
  assert.deepEqual(await h.auth.signIn({ name: 'octo-admin', password: MINE }), signedIn(A));
  await h.auth.signIn({ name: 'octo-new', password: ONE_TIME });
  assert.deepEqual(await h.auth.firstPassword({ name: 'octo-new', oneTimePassword: ONE_TIME, password: ANOTHER }), signedIn(B));
  assert.deepEqual(await h.auth.change(session(A, admin.id, 'octo-admin', 'admin'), { current: MINE, password: THIRD }), CHANGED);

  // The hash made at start: once per object, at COST, in no row.
  const startOf = async (auth: PasswordAuth, name: string): Promise<string> => {
    assert.deepEqual(await auth.signIn({ name, password: WRONG }), REFUSED);
    return h.verifies.at(-1)![1];
  };
  const first = await startOf(h.auth, 'octo-nobody');
  h.clock.now = at(120);
  assert.equal(await startOf(h.auth, 'Octo-Nobody'), first);
  const second = h.another();
  const other = await startOf(second, 'octo-nobody');
  assert.equal(await startOf(second, 'octo nobody'), other);
  assert.notEqual(other, first);
  for (const start of [first, other]) assert.ok(start.startsWith('scrypt$4$1$1$'));
  const hashes = (await h.db.query<{ password_hash: string }>('select password_hash from visto_ai.ui_accounts')).map((r) => r.password_hash);
  assert.ok(!hashes.includes(first) && !hashes.includes(other));

  // The rows of sessions and of the record of changes: no password and no hash.
  const rows = JSON.stringify([await h.db.query('select * from visto_ai.ui_sessions'), await h.db.query('select * from visto_ai.ui_account_changes')]);
  for (const secret of [...SECRETS, 'scrypt$']) assert.ok(!rows.includes(secret), `a row holds ${secret.slice(0, 8)}`);

  // Every answer, log line and error of this file.
  assert.ok(SEEN.length >= 150);
  const said = JSON.stringify(SEEN);
  for (const secret of [...SECRETS, 'scrypt$']) assert.ok(!said.includes(secret), `an answer or a log line holds ${secret.slice(0, 8)}`);
  assert.ok(!said.toLowerCase().includes('octo'), 'an answer or a log line holds a name');
  await h.db.close();
});
