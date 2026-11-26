import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import {
  MAX_ACCOUNTS, accountById, countAccounts, countingAdminsBesides, deleteAccount, insertAccount, passwordAccount, setOwnPassword,
  setRole as writeRole,
} from '../db/ui-accounts.ts';
import type { AccountKind, AccountRow, Role } from '../db/ui-accounts.ts';
import { createSession } from '../db/ui-sessions.ts';
import { ONE_TIME_MS, accountOf, createAccountChanges } from './accounts.ts';
import type { AccountChanges, AccountsDeps, Actor, Refusal } from './accounts.ts';
import { hashPassword, verifyPassword } from './passwords.ts';
import type { PasswordCost } from './passwords.ts';

const at = (seconds: number): Date => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000);
const iso = (seconds: number): string => at(seconds).toISOString();
// Call 4: every hash of these tests is made at COST.
const COST: PasswordCost = { log2N: 4, r: 1, p: 1 };
const MINE = 'a long password of mine';
const ANOTHER = 'another long password';
const COMMAND: Actor = { by: 'command' };
/** 20 characters of the alphabet of call 12, written out here apart from the code. */
const ONE_TIME = /^[23456789abcdefghjkmnpqrstuvwxyz]{20}$/;
const LOCK = 'lock table visto_ai.ui_accounts in share row exclusive mode';
/** The error every failing statement rejects with. */
const DOWN = new Error('db_down');

// Each statement of the store by what it does, found by a part of its text; the first that matches.
const LABELS: Array<[string, string]> = [
  ['lock', LOCK],
  ['actor', 'from visto_ai.ui_sessions s join visto_ai.ui_accounts a on a.id = s.account_id'],
  ['admins', "where role = 'admin' and (kind = 'github' or one_time_until is null) and id <> $1"],
  ['count', 'select count(*)::int as n from visto_ai.ui_accounts'],
  ['delete', 'delete from visto_ai.ui_accounts where id = $1'],
  ['end_sessions', 'delete from visto_ai.ui_sessions where account_id = $1'],
  ['by_id', 'from visto_ai.ui_accounts where id = $1'],
  ['by_name', "from visto_ai.ui_accounts where kind = 'password' and name = $1"],
  ['by_login', "from visto_ai.ui_accounts where kind = 'github' and lower(name) = lower($1)"],
  ['insert', 'insert into visto_ai.ui_accounts ('],
  ['record', 'insert into visto_ai.ui_account_changes '],
  ['set_role', 'update visto_ai.ui_accounts set role = $2 where id = $1'],
  ['set_one_time', 'update visto_ai.ui_accounts set password_hash = $2, one_time_until = $3::timestamptz, failed_tries = 0, wait_until = null'],
  ['list', 'from visto_ai.ui_accounts order by lower(name), kind, id limit $1'],
];
const labelOf = (text: string): string => LABELS.find(([, part]) => text.includes(part))?.[0] ?? text;

interface Harness {
  /** The database as it is, for the test's own reads and writes. */
  db: Db;
  /** Every statement the changes ran: its text, its parameters, and its transaction's number from 1, or 0 outside any. */
  statements: Array<{ tx: number; text: string; params: unknown[] }>;
  /** A statement holding this text rejects with DOWN. */
  failing: { text: string | null };
  logs: Record<string, unknown>[];
  clock: { now: Date };
  changes: AccountChanges;
  /** Another object on the same database, spy, clock and log. */
  another(more?: Partial<AccountsDeps>): AccountChanges;
}

async function harness(): Promise<Harness> {
  const db = await testDb();
  // The object the test reads and sets: the spy and the clock read it as the test leaves it.
  const h: Omit<Harness, 'changes' | 'another'> = { db, statements: [], failing: { text: null }, logs: [], clock: { now: at(0) } };
  let transactions = 0;
  const spy = (inner: Db, tx: number): Db => ({
    query: (text, params) => {
      h.statements.push({ tx, text, params: params ?? [] });
      if (h.failing.text !== null && text.includes(h.failing.text)) return Promise.reject(DOWN);
      return inner.query(text, params);
    },
    script: (sql) => inner.script(sql),
    close: () => inner.close(),
    transaction: (work) => inner.transaction((t) => work(spy(t, transactions += 1))),
  });
  const log = (entry: Record<string, unknown>): void => { h.logs.push(entry); };
  const another = (more: Partial<AccountsDeps> = {}): AccountChanges =>
    createAccountChanges({ db: spy(db, 0), clock: () => h.clock.now, log, cost: COST, ...more });
  return Object.assign(h, { changes: another(), another });
}

/** The statements run since the last call, by label, each outside a transaction marked so; those inside are in one transaction. */
function taken(h: Harness): string[] {
  const all = h.statements.splice(0);
  assert.ok(new Set(all.filter((s) => s.tx !== 0).map((s) => s.tx)).size <= 1, 'one transaction');
  return all.map((s) => (s.tx === 0 ? 'outside ' : '') + labelOf(s.text));
}

/** The answer when it is no refusal. */
function ok<T extends object>(value: T | Refusal): T {
  assert.ok(typeof value !== 'string', `refused: ${String(value)}`);
  return value;
}

/** A password account made by the command at at(0): its password chosen, or a one-time password's ending at at(259200). */
async function account(db: Db, name: string, role: Role, oneTime = false): Promise<AccountRow> {
  const row = await insertAccount(db, {
    kind: 'password', name, role, passwordHash: await hashPassword(MINE, COST), oneTimeUntil: oneTime ? iso(259200) : null,
    at: iso(0), by: 'command', byName: null, signedInAt: null,
  });
  assert.ok(row !== null, name);
  return row;
}
async function github(db: Db, login: string, role: Role): Promise<AccountRow> {
  const row = await insertAccount(db, {
    kind: 'github', name: login, role, passwordHash: null, oneTimeUntil: null, at: iso(0), by: 'sign_in', byName: null, signedInAt: iso(0),
  });
  assert.ok(row !== null, login);
  return row;
}
/** A session of the account until `until`, as the actor the route passes. */
async function signedIn(db: Db, row: AccountRow, idHash: string, until = iso(43200)): Promise<Actor> {
  await createSession(db, { idHash, login: row.name, via: row.kind === 'github' ? 'account' : 'password', accountId: row.id, at: iso(0), expiresAt: until });
  return { by: 'session', idHash };
}

const records = async (db: Db): Promise<unknown[]> =>
  (await db.query<{ at: Date }>('select at, by_kind, by_name, change, account_kind, account_name, role from visto_ai.ui_account_changes order by id'))
    .map((r) => ({ ...r, at: r.at.toISOString() }));
const record = (seconds: number, by: [string, string | null], change: string, account: [AccountKind, string], role: Role | null): unknown =>
  ({ at: iso(seconds), by_kind: by[0], by_name: by[1], change, account_kind: account[0], account_name: account[1], role });
const logged = (change: string, role: Role | null): Record<string, unknown> => ({ event: 'ui_account', change, role });
const sessionsOf = async (db: Db, id: number): Promise<string[]> =>
  (await db.query<{ id_hash: string }>('select id_hash from visto_ai.ui_sessions where account_id = $1 order by id_hash', [id])).map((r) => r.id_hash);
/** Every row of the three tables, as text: what a change could have written. */
const everything = async (db: Db): Promise<string> => JSON.stringify([
  await db.query('select * from visto_ai.ui_accounts order by id'),
  await db.query('select * from visto_ai.ui_account_changes order by id'),
  await db.query('select * from visto_ai.ui_sessions order by id_hash'),
]);

test('an admin makes a password account with a one-time password answered once and stored only as its hash, for 72 hours', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin');
  const actor = await signedIn(h.db, admin, 'h-admin');
  assert.equal(ONE_TIME_MS, 72 * 3600 * 1000);

  const made = ok(await h.changes.make(actor, 'octo-viewer', 'viewer'));
  assert.match(made.oneTimePassword, ONE_TIME);
  const row = await accountById(h.db, made.account.id);
  assert.deepEqual(made.account, row);
  assert.ok(row !== null && row.password_hash !== null);
  assert.equal(await verifyPassword(made.oneTimePassword, row.password_hash), true);
  assert.deepEqual(
    [row.kind, row.name, row.role, row.one_time_until?.toISOString(), row.failed_tries, row.wait_until, row.made_at.toISOString(),
      row.made_by_kind, row.made_by_name, row.last_sign_in_at],
    ['password', 'octo-viewer', 'viewer', iso(259200), 0, null, iso(0), 'password', 'octo-admin', null]);
  assert.equal(made.expiresAt, iso(259200));
  assert.deepEqual(await records(h.db), [record(0, ['password', 'octo-admin'], 'made', ['password', 'octo-viewer'], 'viewer')]);
  assert.deepEqual(h.logs, [logged('made', 'viewer')]);

  // The one-time password is in no row, record, statement or log line: only its hash was written.
  const seen = await everything(h.db) + JSON.stringify(h.statements) + JSON.stringify(h.logs);
  assert.ok(!seen.includes(made.oneTimePassword));
  assert.ok(seen.includes(row.password_hash));
  assert.deepEqual(taken(h), ['lock', 'actor', 'count', 'insert', 'record']);
  await h.db.close();
});

test('a name taken, a name of another shape and the 1,001st account are refused, and nothing is made', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin');
  const actor = await signedIn(h.db, admin, 'h-admin');
  ok(await h.changes.make(actor, 'octo-viewer', 'viewer'));
  h.statements.length = 0;
  h.logs.length = 0;
  const before = await everything(h.db);

  assert.equal(await h.changes.make(actor, 'octo-viewer', 'admin'), 'name_taken');
  assert.deepEqual(taken(h), ['lock', 'actor', 'count', 'insert']);
  for (const name of ['Octo', '', '-octo', 'octo viewer', 'a'.repeat(40)]) {
    assert.equal(await h.changes.make(actor, name, 'viewer'), 'bad_name', name);
    assert.deepEqual(taken(h), [], name);
  }
  // A cap of its own is read: two accounts are there.
  assert.equal(await h.another({ max: 2 }).make(actor, 'octo-new', 'viewer'), 'full');
  assert.deepEqual(taken(h), ['lock', 'actor', 'count']);
  assert.equal(await everything(h.db), before);

  // 1,000 accounts of both kinds: the 1,001st is refused.
  await h.db.query(
    `insert into visto_ai.ui_accounts (kind, name, role, made_at, made_by_kind)
     select 'github', 'octo-user-' || g::text, 'viewer', $1::timestamptz, 'sign_in' from generate_series(1, 998) g`, [iso(0)]);
  assert.equal(await countAccounts(h.db), MAX_ACCOUNTS);
  const full = await everything(h.db);
  assert.equal(await h.changes.make(actor, 'octo-new', 'viewer'), 'full');
  assert.deepEqual(taken(h), ['lock', 'actor', 'count']);
  assert.equal(await everything(h.db), full);
  assert.equal(await passwordAccount(h.db, 'octo-new'), null);
  assert.equal((await records(h.db)).length, 1);
  assert.deepEqual(h.logs, []);
  await h.db.close();
});

test('a role is changed and recorded; the role it has already changes nothing', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin');
  const actor = await signedIn(h.db, admin, 'h-admin');
  const viewer = await account(h.db, 'octo-viewer', 'viewer');

  const up = ok(await h.changes.setRole(actor, { id: viewer.id }, 'admin'));
  assert.deepEqual(up, { account: { ...viewer, role: 'admin' }, made: false, changed: true });
  assert.deepEqual(await accountById(h.db, viewer.id), up.account);
  assert.deepEqual(taken(h), ['lock', 'actor', 'by_id', 'set_role', 'record']);
  const first = [record(0, ['password', 'octo-admin'], 'role', ['password', 'octo-viewer'], 'admin')];
  assert.deepEqual(await records(h.db), first);
  assert.deepEqual(h.logs, [logged('role', 'admin')]);

  // The role it has already: the row, and no statement after the read.
  h.clock.now = at(5);
  assert.deepEqual(await h.changes.setRole(actor, { id: viewer.id }, 'admin'), { account: up.account, made: false, changed: false });
  assert.deepEqual(taken(h), ['lock', 'actor', 'by_id']);
  assert.deepEqual(await records(h.db), first);
  assert.deepEqual(h.logs, [logged('role', 'admin')]);

  // An admin made a viewer while another admin counts.
  assert.deepEqual(await h.changes.setRole(actor, { id: viewer.id }, 'viewer'), { account: viewer, made: false, changed: true });
  assert.deepEqual(taken(h), ['lock', 'actor', 'by_id', 'admins', 'set_role', 'record']);
  assert.deepEqual(await records(h.db), [...first, record(5, ['password', 'octo-admin'], 'role', ['password', 'octo-viewer'], 'viewer')]);
  assert.deepEqual(h.logs, [logged('role', 'admin'), logged('role', 'viewer')]);

  assert.equal(await h.changes.setRole(actor, { id: 9999 }, 'admin'), 'not_found');
  assert.deepEqual(taken(h), ['lock', 'actor', 'by_id']);
  assert.equal((await records(h.db)).length, 2);
  await h.db.close();
});

test('the last admin cannot be made a viewer or removed, and an admin who has not chosen a password does not count', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin');
  const a = await signedIn(h.db, admin, 'h-admin');
  assert.equal(await h.changes.setRole(a, { id: admin.id }, 'viewer'), 'last_admin');
  assert.deepEqual(taken(h), ['lock', 'actor', 'by_id', 'admins']);
  assert.equal(await h.changes.remove(a, admin.id), 'last_admin');
  assert.deepEqual(taken(h), ['lock', 'actor', 'by_id', 'admins']);

  // An admin with a one-time password does not count until it chooses its own.
  const fresh = ok(await h.changes.make(a, 'octo-new', 'admin'));
  assert.equal(await h.changes.setRole(a, { id: admin.id }, 'viewer'), 'last_admin');
  assert.equal(await h.changes.remove(a, admin.id), 'last_admin');
  assert.ok(fresh.account.password_hash !== null);
  assert.equal(await setOwnPassword(h.db, fresh.account.id, await hashPassword(ANOTHER, COST), fresh.account.password_hash), true);
  assert.equal(ok(await h.changes.setRole(a, { id: admin.id }, 'viewer')).changed, true);

  // octo-new is the last now, for its own session and for the command alike.
  const n = await signedIn(h.db, fresh.account, 'h-new');
  assert.equal(await h.changes.setRole(n, { id: fresh.account.id }, 'viewer'), 'last_admin');
  assert.equal(await h.changes.remove(n, fresh.account.id), 'last_admin');
  assert.equal(await h.changes.setRole(COMMAND, { id: fresh.account.id }, 'viewer'), 'last_admin');

  // A GitHub admin counts: octo-new can step down, and then octo-lead is the last.
  const lead = ok(await h.changes.setRole(COMMAND, { github: 'octo-lead' }, 'admin'));
  assert.equal(lead.made, true);
  assert.equal(ok(await h.changes.setRole(n, { id: fresh.account.id }, 'viewer')).changed, true);
  assert.equal(await h.changes.setRole(COMMAND, { github: 'octo-lead' }, 'viewer'), 'last_admin');
  assert.equal(await h.changes.remove(COMMAND, lead.account.id), 'last_admin');
  assert.equal(await countingAdminsBesides(h.db, -1), 1);

  assert.deepEqual(await records(h.db), [
    record(0, ['password', 'octo-admin'], 'made', ['password', 'octo-new'], 'admin'),
    record(0, ['password', 'octo-admin'], 'role', ['password', 'octo-admin'], 'viewer'),
    record(0, ['command', null], 'made', ['github', 'octo-lead'], 'admin'),
    record(0, ['password', 'octo-new'], 'role', ['password', 'octo-new'], 'viewer'),
  ]);
  assert.deepEqual(h.logs, [logged('made', 'admin'), logged('role', 'viewer'), logged('made', 'admin'), logged('role', 'viewer')]);
  await h.db.close();
});

test('two admins making each other viewers at once leave one admin', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin');
  const other = await account(h.db, 'octo-viewer', 'admin');
  const a = await signedIn(h.db, admin, 'h-admin');
  const b = await signedIn(h.db, other, 'h-viewer');

  const answers = await Promise.all([h.changes.setRole(a, { id: other.id }, 'viewer'), h.changes.setRole(b, { id: admin.id }, 'viewer')]);
  const done = answers.filter((x) => typeof x !== 'string');
  assert.equal(done.length, 1);
  assert.deepEqual(answers.filter((x) => typeof x === 'string'), ['forbidden']);
  const [won] = done;
  assert.ok(won !== undefined);
  assert.deepEqual(await accountById(h.db, won.account.id), won.account);
  assert.equal(won.account.role, 'viewer');
  assert.equal(await countingAdminsBesides(h.db, -1), 1);

  // Each in its own transaction, the lock first: the second read its actor again once the first had committed.
  const byTx = new Map<number, string[]>();
  for (const s of h.statements) byTx.set(s.tx, [...(byTx.get(s.tx) ?? []), labelOf(s.text)]);
  assert.deepEqual([...byTx.entries()].sort(([x], [y]) => x - y).map(([, labels]) => labels), [
    ['lock', 'actor', 'by_id', 'admins', 'set_role', 'record'],
    ['lock', 'actor'],
  ]);
  assert.equal((await records(h.db)).length, 1);
  assert.deepEqual(h.logs, [logged('role', 'viewer')]);
  await h.db.close();
});

test("a reset gives a new one-time password, clears the wait, and ends every session of the account; a GitHub account and one's own are refused", async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin');
  const a = await signedIn(h.db, admin, 'h-admin');
  const viewer = await account(h.db, 'octo-viewer', 'viewer');
  await signedIn(h.db, viewer, 'h-viewer-1');
  await signedIn(h.db, viewer, 'h-viewer-2');
  await h.db.query('update visto_ai.ui_accounts set failed_tries = 3, wait_until = $2::timestamptz where id = $1', [viewer.id, iso(900)]);

  h.clock.now = at(60);
  const reset = ok(await h.changes.reset(a, { id: viewer.id }));
  assert.match(reset.oneTimePassword, ONE_TIME);
  const row = await accountById(h.db, viewer.id);
  assert.deepEqual(reset.account, row);
  assert.ok(row !== null && row.password_hash !== null);
  assert.equal(await verifyPassword(reset.oneTimePassword, row.password_hash), true);
  assert.equal(await verifyPassword(MINE, row.password_hash), false);
  assert.deepEqual([row.one_time_until?.toISOString(), row.failed_tries, row.wait_until, row.role], [iso(60 + 259200), 0, null, 'viewer']);
  assert.equal(reset.expiresAt, iso(60 + 259200));
  assert.deepEqual(await sessionsOf(h.db, viewer.id), []);
  assert.deepEqual(await sessionsOf(h.db, admin.id), ['h-admin']);
  assert.deepEqual(await records(h.db), [record(60, ['password', 'octo-admin'], 'reset', ['password', 'octo-viewer'], 'viewer')]);
  assert.deepEqual(h.logs, [logged('reset', 'viewer')]);
  assert.ok(!(JSON.stringify(h.statements) + JSON.stringify(h.logs)).includes(reset.oneTimePassword));
  assert.deepEqual(taken(h), ['lock', 'actor', 'by_id', 'set_one_time', 'end_sessions', 'record']);

  const lead = await github(h.db, 'octo-lead', 'viewer');
  const before = await everything(h.db);
  assert.equal(await h.changes.reset(a, { id: lead.id }), 'github_account');
  assert.deepEqual(taken(h), ['lock', 'actor', 'by_id']);
  assert.equal(await h.changes.reset(a, { id: admin.id }), 'own_account');
  assert.deepEqual(taken(h), ['lock', 'actor', 'by_id']);
  assert.equal(await h.changes.reset(a, { id: 9999 }), 'not_found');
  assert.deepEqual(taken(h), ['lock', 'actor', 'by_id']);
  assert.equal(await everything(h.db), before);
  assert.deepEqual(h.logs, [logged('reset', 'viewer')]);
  await h.db.close();
});

test('removing an account deletes its row and its sessions at once, and the record keeps its name', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin');
  const a = await signedIn(h.db, admin, 'h-admin');
  const viewer = await account(h.db, 'octo-viewer', 'viewer');
  await signedIn(h.db, viewer, 'h-viewer-1');
  await signedIn(h.db, viewer, 'h-viewer-2');

  h.clock.now = at(30);
  assert.deepEqual(await h.changes.remove(a, viewer.id), viewer);
  assert.deepEqual(taken(h), ['lock', 'actor', 'by_id', 'delete', 'record']);
  assert.equal(await accountById(h.db, viewer.id), null);
  assert.deepEqual(await sessionsOf(h.db, viewer.id), []);
  assert.deepEqual(await sessionsOf(h.db, admin.id), ['h-admin']);
  const removed = [record(30, ['password', 'octo-admin'], 'removed', ['password', 'octo-viewer'], null)];
  assert.deepEqual(await records(h.db), removed);
  assert.deepEqual(h.logs, [logged('removed', null)]);

  assert.equal(await h.changes.remove(a, viewer.id), 'not_found');
  assert.deepEqual(taken(h), ['lock', 'actor', 'by_id']);
  assert.deepEqual(await records(h.db), removed);

  // An admin is removed while another counts.
  const other = await account(h.db, 'octo-new', 'admin');
  assert.deepEqual(await h.changes.remove(a, other.id), other);
  assert.deepEqual(taken(h), ['lock', 'actor', 'by_id', 'admins', 'delete', 'record']);
  assert.deepEqual(await records(h.db), [...removed, record(30, ['password', 'octo-admin'], 'removed', ['password', 'octo-new'], null)]);
  assert.deepEqual(h.logs, [logged('removed', null), logged('removed', null)]);
  await h.db.close();
});

test('a viewer, a removed session and an expired one change nothing, read again under the lock', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin');
  await signedIn(h.db, admin, 'h-admin');
  const viewer = await account(h.db, 'octo-viewer', 'viewer');
  const v = await signedIn(h.db, viewer, 'h-viewer');
  // The route read octo-lead's session as an admin's; it was made a viewer before its change took the lock.
  const lead = await github(h.db, 'octo-lead', 'admin');
  const demoted = await signedIn(h.db, lead, 'h-lead');
  await writeRole(h.db, lead.id, 'viewer');
  // octo-new's account was removed, and its session with it.
  const gone = await account(h.db, 'octo-new', 'admin');
  const removed = await signedIn(h.db, gone, 'h-new');
  await deleteAccount(h.db, gone.id);
  const expired = await signedIn(h.db, admin, 'h-old', iso(100));
  const none: Actor = { by: 'session', idHash: 'h-none' };
  h.clock.now = at(100);
  const before = await everything(h.db);

  const calls: Array<(actor: Actor) => Promise<unknown>> = [
    (actor) => h.changes.make(actor, 'octo-made', 'viewer'),
    (actor) => h.changes.setRole(actor, { id: viewer.id }, 'admin'),
    (actor) => h.changes.setRole(actor, { github: 'octo-dev' }, 'admin'),
    (actor) => h.changes.reset(actor, { id: viewer.id }),
    (actor) => h.changes.remove(actor, viewer.id),
  ];
  const tries: Array<[Actor, Refusal]> = [[v, 'forbidden'], [demoted, 'forbidden'], [removed, 'signed_out'], [expired, 'signed_out'], [none, 'signed_out']];
  for (const [actor, code] of tries) {
    for (const call of calls) {
      assert.equal(await call(actor), code);
      assert.deepEqual(taken(h), ['lock', 'actor']);
    }
  }
  assert.equal(await everything(h.db), before);
  assert.deepEqual(h.logs, []);
  await h.db.close();
});

test("the command makes and resets by name and sets a GitHub login's role, making its row, and is recorded as the command", async () => {
  const h = await harness();
  const made = ok(await h.changes.make(COMMAND, 'octo-admin', 'admin'));
  assert.deepEqual(taken(h), ['lock', 'count', 'insert', 'record']);
  assert.deepEqual([made.account.made_by_kind, made.account.made_by_name, made.account.role], ['command', null, 'admin']);

  h.clock.now = at(10);
  const reset = ok(await h.changes.reset(COMMAND, { name: 'octo-admin' }));
  assert.deepEqual(taken(h), ['lock', 'by_name', 'set_one_time', 'end_sessions', 'record']);
  const row = await accountById(h.db, made.account.id);
  assert.deepEqual(reset.account, row);
  assert.ok(row !== null && row.password_hash !== null);
  assert.equal(await verifyPassword(reset.oneTimePassword, row.password_hash), true);
  assert.equal(await verifyPassword(made.oneTimePassword, row.password_hash), false);
  assert.deepEqual([row.one_time_until?.toISOString(), reset.expiresAt], [iso(10 + 259200), iso(10 + 259200)]);
  assert.equal(await h.changes.reset(COMMAND, { name: 'octo-nobody' }), 'not_found');
  assert.deepEqual(taken(h), ['lock', 'by_name']);

  const lead = ok(await h.changes.setRole(COMMAND, { github: 'octo-lead' }, 'admin'));
  assert.deepEqual(taken(h), ['lock', 'by_login', 'count', 'insert', 'record']);
  assert.deepEqual([lead.made, lead.changed], [true, false]);
  assert.deepEqual(await accountById(h.db, lead.account.id), lead.account);
  const l = lead.account;
  assert.deepEqual(
    [l.kind, l.name, l.role, l.password_hash, l.one_time_until, l.made_at.toISOString(), l.made_by_kind, l.made_by_name, l.last_sign_in_at],
    ['github', 'octo-lead', 'admin', null, null, iso(10), 'command', null, null]);
  // Found again letter case aside, with the role it has already: the row, nothing written.
  assert.deepEqual(await h.changes.setRole(COMMAND, { github: 'Octo-Lead' }, 'admin'), { account: lead.account, made: false, changed: false });
  assert.deepEqual(taken(h), ['lock', 'by_login']);

  const dev = ok(await h.changes.setRole(COMMAND, { github: 'octo-dev' }, 'viewer'));
  assert.deepEqual([dev.made, dev.changed, dev.account.role], [true, false, 'viewer']);
  taken(h);
  assert.deepEqual(await h.changes.setRole(COMMAND, { github: 'octo-dev' }, 'admin'), { account: { ...dev.account, role: 'admin' }, made: false, changed: true });
  assert.deepEqual(taken(h), ['lock', 'by_login', 'set_role', 'record']);
  for (const login of ['octo_lead', '', 'octo lead', 'a'.repeat(40)]) {
    assert.equal(await h.changes.setRole(COMMAND, { github: login }, 'admin'), 'bad_login', login);
    assert.deepEqual(taken(h), [], login);
  }

  assert.deepEqual(await records(h.db), [
    record(0, ['command', null], 'made', ['password', 'octo-admin'], 'admin'),
    record(10, ['command', null], 'reset', ['password', 'octo-admin'], 'admin'),
    record(10, ['command', null], 'made', ['github', 'octo-lead'], 'admin'),
    record(10, ['command', null], 'made', ['github', 'octo-dev'], 'viewer'),
    record(10, ['command', null], 'role', ['github', 'octo-dev'], 'admin'),
  ]);
  assert.deepEqual(h.logs, [logged('made', 'admin'), logged('reset', 'admin'), logged('made', 'admin'), logged('made', 'viewer'), logged('role', 'admin')]);

  // The list reads every account, at most MAX_ACCOUNTS, with no lock.
  assert.deepEqual((await h.changes.list()).map((r) => [r.kind, r.name, r.role]),
    [['password', 'octo-admin', 'admin'], ['github', 'octo-dev', 'admin'], ['github', 'octo-lead', 'admin']]);
  assert.deepEqual(h.statements.map((s) => [s.tx, labelOf(s.text), s.params]), [[0, 'list', [MAX_ACCOUNTS]]]);
  await h.db.close();
});

test('every change takes the lock first', async () => {
  const h = await harness();
  const admin = await account(h.db, 'octo-admin', 'admin');
  const a = await signedIn(h.db, admin, 'h-admin');
  const viewer = await account(h.db, 'octo-viewer', 'viewer');
  const other = await account(h.db, 'octo-new', 'admin');
  await github(h.db, 'octo-lead', 'viewer');

  // Each change that writes, and the statements it runs: every one inside one transaction, the lock its first; every count and
  // every write after it.
  const changes: Array<[() => Promise<unknown>, string[]]> = [
    [() => h.changes.make(a, 'octo-made', 'viewer'), ['actor', 'count', 'insert', 'record']],
    [() => h.changes.make(COMMAND, 'octo-made-2', 'admin'), ['count', 'insert', 'record']],
    [() => h.changes.setRole(a, { id: viewer.id }, 'admin'), ['actor', 'by_id', 'set_role', 'record']],
    [() => h.changes.setRole(a, { id: viewer.id }, 'viewer'), ['actor', 'by_id', 'admins', 'set_role', 'record']],
    [() => h.changes.setRole(COMMAND, { github: 'octo-dev' }, 'viewer'), ['by_login', 'count', 'insert', 'record']],
    [() => h.changes.setRole(COMMAND, { github: 'octo-lead' }, 'admin'), ['by_login', 'set_role', 'record']],
    [() => h.changes.reset(a, { id: viewer.id }), ['actor', 'by_id', 'set_one_time', 'end_sessions', 'record']],
    [() => h.changes.reset(COMMAND, { name: 'octo-viewer' }), ['by_name', 'set_one_time', 'end_sessions', 'record']],
    [() => h.changes.remove(a, viewer.id), ['actor', 'by_id', 'delete', 'record']],
    [() => h.changes.remove(a, other.id), ['actor', 'by_id', 'admins', 'delete', 'record']],
  ];
  for (const [change, after] of changes) {
    const answer = await change();
    assert.ok(typeof answer !== 'string', String(answer));
    const seen = h.statements.splice(0);
    assert.equal(seen[0]?.text, LOCK);
    assert.equal(new Set(seen.map((s) => s.tx)).size, 1);
    assert.notEqual(seen[0]?.tx, 0);
    assert.deepEqual(seen.slice(1).map((s) => labelOf(s.text)), after);
  }
  assert.equal(h.logs.length, changes.length);

  // The one-time password is hashed before the lock: a hash that rejects (a cost out of bounds) runs no statement at all.
  const unhashed = h.another({ cost: { log2N: 16, r: 8, p: 1 } });
  await assert.rejects(unhashed.make(a, 'octo-late', 'viewer'), /^Error: bad_cost$/);
  await assert.rejects(unhashed.reset(a, { id: admin.id }), /^Error: bad_cost$/);
  await assert.rejects(unhashed.reset(COMMAND, { name: 'octo-made' }), /^Error: bad_cost$/);
  assert.deepEqual(taken(h), []);

  // A step that fails after the change is rolled back with it, and nothing is logged: the line comes after the commit.
  h.failing.text = 'insert into visto_ai.ui_account_changes ';
  await assert.rejects(h.changes.make(a, 'octo-late', 'viewer'), DOWN);
  assert.deepEqual(taken(h), ['lock', 'actor', 'count', 'insert', 'record']);
  assert.equal(await passwordAccount(h.db, 'octo-late'), null);
  assert.equal(h.logs.length, changes.length);
  await h.db.close();
});

test('the view of an account holds no hash, and says whether it chose its password, waits, and is you', async () => {
  const hash = await hashPassword(MINE, COST);
  const row = (more: Partial<AccountRow>): AccountRow => ({
    id: 3, kind: 'password', name: 'octo-viewer', role: 'viewer', password_hash: hash, one_time_until: null, failed_tries: 0, wait_until: null,
    made_at: at(-3600), made_by_kind: 'password', made_by_name: 'octo-admin', last_sign_in_at: at(-120), ...more,
  });
  const KEYS = ['id', 'kind', 'name', 'role', 'password', 'waitsUntil', 'madeAt', 'madeBy', 'lastSignInAt', 'you'];
  const view = (r: AccountRow, now: Date = at(0), you: number | null = null): unknown => {
    const shown = accountOf(r, now, you);
    assert.deepEqual(Object.keys(shown), KEYS);
    assert.ok(!JSON.stringify(shown).includes('scrypt$'));
    return shown;
  };
  const SET = {
    id: 3, kind: 'password', name: 'octo-viewer', role: 'viewer', password: 'set', waitsUntil: null, madeAt: iso(-3600),
    madeBy: { kind: 'password', name: 'octo-admin' }, lastSignInAt: iso(-120), you: false,
  };
  assert.deepEqual(view(row({})), SET);
  assert.deepEqual(view(row({}), at(0), 3), { ...SET, you: true });
  assert.deepEqual(view(row({}), at(0), 4), SET);

  const oneTime = row({ one_time_until: at(259200), last_sign_in_at: null, made_by_kind: 'command', made_by_name: null });
  const ONE = { ...SET, password: 'one_time', lastSignInAt: null, madeBy: { kind: 'command', name: null } };
  assert.deepEqual(view(oneTime), ONE);
  assert.deepEqual(view(oneTime, at(259199)), ONE);
  assert.deepEqual(view(oneTime, at(259200)), { ...ONE, password: 'expired' });

  const waiting = row({ failed_tries: 0, wait_until: at(900) });
  assert.deepEqual(view(waiting), { ...SET, waitsUntil: iso(900) });
  assert.deepEqual(view(waiting, at(899)), { ...SET, waitsUntil: iso(900) });
  assert.deepEqual(view(waiting, at(900)), SET);

  const lead = row({ id: 7, kind: 'github', name: 'octo-lead', role: 'admin', password_hash: null, made_by_kind: 'sign_in', made_by_name: null });
  assert.deepEqual(view(lead, at(0), 7), {
    id: 7, kind: 'github', name: 'octo-lead', role: 'admin', password: null, waitsUntil: null, madeAt: iso(-3600),
    madeBy: { kind: 'sign_in', name: null }, lastSignInAt: iso(-120), you: true,
  });
});
