import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../ui/passwords.ts';
import type { PasswordCost } from '../ui/passwords.ts';
import { testDb } from './testing.ts';
import type { Db } from './types.ts';
import {
  MAX_ACCOUNTS, accountById, actorOf, countAccounts, countingAdminsBesides, deleteAccount, githubAccount, githubSignIn, insertAccount,
  listAccounts, passwordAccount, recordChange, rightTry, setOneTime, setOwnPassword, setRole, signedInAt, underLock, wrongTry,
} from './ui-accounts.ts';
import type { AccountKind, AccountRow, Role } from './ui-accounts.ts';
import { createSession, deleteSession } from './ui-sessions.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
// Call 4: every hash of these tests is made at COST.
const COST: PasswordCost = { log2N: 4, r: 1, p: 1 };
const hashOf = (password: string): Promise<string> => hashPassword(password, COST);

/** An account made by the command at at(0), with no sign-in yet. */
const make = (db: Db, kind: AccountKind, name: string, role: Role, passwordHash: string | null, oneTimeUntil: string | null = null): Promise<AccountRow | null> =>
  insertAccount(db, { kind, name, role, passwordHash, oneTimeUntil, at: at(0), by: 'command', byName: null, signedInAt: null });
const made = async (db: Db, kind: AccountKind, name: string, role: Role, passwordHash: string | null, oneTimeUntil: string | null = null): Promise<AccountRow> => {
  const row = await make(db, kind, name, role, passwordHash, oneTimeUntil);
  assert.ok(row !== null, name);
  return row;
};
const changes = async (db: Db): Promise<unknown[]> =>
  (await db.query<{ at: Date }>('select at, by_kind, by_name, change, account_kind, account_name, role from visto_ai.ui_account_changes order by id'))
    .map((r) => ({ ...r, at: r.at.toISOString() }));
const iso = (time: Date | null): string | null => time?.toISOString() ?? null;

test("a password account's name is unique, and a GitHub account's letter case aside, the two kinds apart", async () => {
  const db = await testDb();
  const hash = await hashOf('a long password of mine');
  const admin = await made(db, 'password', 'octo-admin', 'admin', hash);
  assert.deepEqual(
    { ...admin, made_at: iso(admin.made_at) },
    {
      id: admin.id, kind: 'password', name: 'octo-admin', role: 'admin', password_hash: hash, one_time_until: null, failed_tries: 0, wait_until: null,
      made_at: at(0), made_by_kind: 'command', made_by_name: null, last_sign_in_at: null,
    });
  assert.equal(await make(db, 'password', 'octo-admin', 'viewer', hash), null);
  const lead = await made(db, 'github', 'Octo-Lead', 'viewer', null);
  assert.equal(await make(db, 'github', 'octo-lead', 'admin', null), null);
  const beside = await made(db, 'password', 'octo-lead', 'viewer', hash);
  assert.deepEqual([beside.kind, beside.name], ['password', 'octo-lead']);
  assert.equal(await countAccounts(db), 3);

  // Each is found by its kind: a password name as it is written, a GitHub login letter case aside.
  assert.equal((await passwordAccount(db, 'octo-admin'))?.id, admin.id);
  assert.equal(await passwordAccount(db, 'Octo-Admin'), null);
  assert.equal((await passwordAccount(db, 'octo-lead'))?.id, beside.id);
  assert.equal((await githubAccount(db, 'OCTO-LEAD'))?.id, lead.id);
  assert.equal(await githubAccount(db, 'octo-admin'), null);
  assert.equal((await accountById(db, lead.id))?.name, 'Octo-Lead');
  assert.equal(await accountById(db, 9999), null);
  assert.deepEqual((await listAccounts(db, 10)).map((r) => [r.kind, r.name]), [['password', 'octo-admin'], ['github', 'Octo-Lead'], ['password', 'octo-lead']]);
  assert.deepEqual((await listAccounts(db, 2)).map((r) => r.name), ['octo-admin', 'Octo-Lead']);
  await db.close();
});

test("a row's checks refuse a password account with no hash and a GitHub account with one, or with a wait", async () => {
  const db = await testDb();
  const hash = await hashOf('a long password of mine');
  const insert = (kind: string, passwordHash: string | null, waitUntil: string | null): Promise<unknown> => db.query(
    `insert into visto_ai.ui_accounts (kind, name, role, password_hash, wait_until, made_at, made_by_kind)
     values ($1, 'octo-new', 'viewer', $2, $3::timestamptz, $4::timestamptz, 'command')`, [kind, passwordHash, waitUntil, at(0)]);
  await assert.rejects(insert('password', null, null));
  await assert.rejects(insert('github', hash, null));
  await assert.rejects(insert('github', null, at(900)));
  assert.equal(await countAccounts(db), 0);
  await insert('github', null, null);
  await insert('password', hash, at(900));
  assert.equal(await countAccounts(db), 2);
  await db.close();
});

test('a GitHub sign-in makes its account a viewer once, by sign_in, then keeps its role and writes its name as GitHub writes it', async () => {
  const db = await testDb();
  const first = await githubSignIn(db, 'Octo-Lead', at(0), MAX_ACCOUNTS);
  assert.ok(first !== 'full');
  assert.equal(first.made, true);
  assert.deepEqual(
    [first.account.kind, first.account.name, first.account.role, first.account.made_by_kind, first.account.made_by_name,
      iso(first.account.made_at), iso(first.account.last_sign_in_at), first.account.password_hash],
    ['github', 'Octo-Lead', 'viewer', 'sign_in', null, at(0), at(0), null]);
  const record = [{ at: at(0), by_kind: 'sign_in', by_name: null, change: 'made', account_kind: 'github', account_name: 'Octo-Lead', role: 'viewer' }];
  assert.deepEqual(await changes(db), record);

  assert.equal((await setRole(db, first.account.id, 'admin'))?.role, 'admin');
  const again = await githubSignIn(db, 'octo-lead', at(9), MAX_ACCOUNTS);
  assert.ok(again !== 'full');
  assert.deepEqual(
    [again.made, again.account.id, again.account.role, again.account.name, iso(again.account.made_at), iso(again.account.last_sign_in_at)],
    [false, first.account.id, 'admin', 'octo-lead', at(0), at(9)]);
  assert.deepEqual(await changes(db), record);
  assert.equal(await countAccounts(db), 1);
  await db.close();
});

test('a GitHub sign-in with 1,000 accounts and none of its own is full, and one that has its row still signs in', async () => {
  assert.equal(MAX_ACCOUNTS, 1000);
  const db = await testDb();
  await db.query(
    `insert into visto_ai.ui_accounts (kind, name, role, made_at, made_by_kind)
     select 'github', 'octo-user-' || g::text, 'viewer', $1::timestamptz, 'sign_in' from generate_series(1, 999) g`, [at(0)]);
  const lead = await githubSignIn(db, 'octo-lead', at(0), MAX_ACCOUNTS);
  assert.ok(lead !== 'full' && lead.made);
  assert.equal(await countAccounts(db), 1000);
  const before = await changes(db);

  assert.equal(await githubSignIn(db, 'octo-dev', at(5), MAX_ACCOUNTS), 'full');
  assert.equal(await githubAccount(db, 'octo-dev'), null);
  const back = await githubSignIn(db, 'octo-lead', at(5), MAX_ACCOUNTS);
  assert.ok(back !== 'full');
  assert.deepEqual([back.made, back.account.id, iso(back.account.last_sign_in_at)], [false, lead.account.id, at(5)]);
  assert.equal(await countAccounts(db), 1000);
  assert.deepEqual(await changes(db), before);

  // One under the cap, it is made.
  await db.query(`delete from visto_ai.ui_accounts where name = 'octo-user-1'`);
  const dev = await githubSignIn(db, 'octo-dev', at(6), MAX_ACCOUNTS);
  assert.ok(dev !== 'full' && dev.made);
  assert.equal(await countAccounts(db), 1000);
  await db.close();
});

test('the admins that count are the GitHub ones and the password ones that chose their password, the account changed aside', async () => {
  const db = await testDb();
  const hash = await hashOf('a long password of mine');
  const a = await made(db, 'password', 'octo-admin', 'admin', hash);
  const b = await made(db, 'password', 'octo-new', 'admin', hash, at(259200));
  const c = await made(db, 'github', 'octo-lead', 'admin', null);
  const viewer = await made(db, 'password', 'octo-viewer', 'viewer', hash);
  assert.deepEqual(
    [await countingAdminsBesides(db, a.id), await countingAdminsBesides(db, c.id), await countingAdminsBesides(db, b.id),
      await countingAdminsBesides(db, viewer.id)],
    [1, 1, 2, 2]);
  await db.close();
});

test("every change runs after the lock, as its transaction's first statement", async () => {
  const db = await testDb();
  const seen: Array<{ inside: boolean; text: string }> = [];
  const spy = (inner: Db, inside: boolean): Db => ({
    query: (text, params) => { seen.push({ inside, text }); return inner.query(text, params); },
    script: (sql) => inner.script(sql),
    close: () => inner.close(),
    transaction: (work) => inner.transaction((tx) => work(spy(tx, true))),
  });
  const LOCK = 'lock table visto_ai.ui_accounts in share row exclusive mode';
  assert.equal(await underLock(spy(db, false), async (tx) => { await tx.query('select 1 as n'); return 'done'; }), 'done');
  assert.deepEqual(seen, [{ inside: true, text: LOCK }, { inside: true, text: 'select 1 as n' }]);

  // Work that rejects is rolled back, the lock first all the same.
  seen.length = 0;
  await assert.rejects(underLock(spy(db, false), async (tx) => {
    await tx.query(`insert into visto_ai.ui_accounts (kind, name, role, made_at, made_by_kind) values ('github', 'octo-dev', 'viewer', now(), 'sign_in')`);
    throw new Error('later_step');
  }), /^Error: later_step$/);
  assert.deepEqual(seen.map((s) => [s.inside, s.text.startsWith(LOCK)]), [[true, true], [true, false]]);
  assert.equal(await countAccounts(db), 0);

  // A GitHub row is made under it: the look-up first, then the lock, the look-up again, the count, the row and its record.
  seen.length = 0;
  const signedIn = await githubSignIn(spy(db, false), 'octo-lead', at(0), MAX_ACCOUNTS);
  assert.ok(signedIn !== 'full' && signedIn.made);
  const UPDATE = 'update visto_ai.ui_accounts set name = $1';
  const COUNT = 'select count(*)::int as n from visto_ai.ui_accounts';
  const prefixes = [UPDATE, LOCK, COUNT, 'insert into visto_ai.ui_accounts ', 'insert into visto_ai.ui_account_changes '];
  assert.deepEqual(seen.map((s) => [s.inside, prefixes.find((p) => s.text.startsWith(p)) ?? s.text]), [
    [false, UPDATE], [true, LOCK], [true, UPDATE], [true, COUNT], [true, 'insert into visto_ai.ui_accounts '], [true, 'insert into visto_ai.ui_account_changes '],
  ]);
  // One that has its row takes no lock.
  seen.length = 0;
  assert.ok(await githubSignIn(spy(db, false), 'octo-lead', at(1), MAX_ACCOUNTS) !== 'full');
  assert.deepEqual(seen.map((s) => s.inside), [false]);
  await db.close();
});

test('a wrong try is counted, the fifth starts the wait it is given and counts again from none, and a right one clears both only over the hash it verified', async () => {
  const db = await testDb();
  const hash = await hashOf('a long password of mine');
  const other = await hashOf('another long password');
  const { id } = await made(db, 'password', 'octo-admin', 'admin', hash);
  const state = async (): Promise<[number, string | null]> => {
    const row = await accountById(db, id);
    return [row!.failed_tries, iso(row!.wait_until)];
  };
  for (let i = 1; i <= 4; i += 1) await wrongTry(db, id, at(i * 100));
  assert.deepEqual(await state(), [4, null]);
  await wrongTry(db, id, at(900));
  assert.deepEqual(await state(), [0, at(900)]);
  await wrongTry(db, id, at(1000));
  await wrongTry(db, id, at(1100));
  assert.deepEqual(await state(), [2, at(900)]);
  assert.equal(await rightTry(db, id, other), false);
  assert.deepEqual(await state(), [2, at(900)]);
  assert.equal(await rightTry(db, id, hash), true);
  assert.deepEqual(await state(), [0, null]);

  const lead = await made(db, 'github', 'octo-lead', 'admin', null);
  for (let i = 1; i <= 5; i += 1) await wrongTry(db, lead.id, at(900));
  const after = await accountById(db, lead.id);
  assert.deepEqual([after!.failed_tries, after!.wait_until], [0, null]);
  assert.equal(await rightTry(db, lead.id, hash), false);
  await db.close();
});

test('a password is set only over the hash that was verified', async () => {
  const db = await testDb();
  const [h1, h2, h3] = [await hashOf('a long password of mine'), await hashOf('another long password'), await hashOf('a third long password')];
  const { id } = await made(db, 'password', 'octo-new', 'viewer', h1, at(259200));
  await wrongTry(db, id, at(900));
  assert.equal(await setOwnPassword(db, id, h2, h1), true);
  const set = await accountById(db, id);
  assert.deepEqual([set!.password_hash, set!.one_time_until, set!.failed_tries], [h2, null, 0]);
  assert.equal(await setOwnPassword(db, id, h3, h1), false);
  assert.equal((await accountById(db, id))!.password_hash, h2);

  // A one-time password set over it is the row's hash from then on, its end written, its count and wait cleared.
  for (let i = 1; i <= 5; i += 1) await wrongTry(db, id, at(900));
  const reset = await setOneTime(db, id, h3, at(259200));
  assert.deepEqual([reset!.password_hash, iso(reset!.one_time_until), reset!.failed_tries, reset!.wait_until], [h3, at(259200), 0, null]);
  assert.equal(await setOwnPassword(db, id, h1, h2), false);
  const lead = await made(db, 'github', 'octo-lead', 'viewer', null);
  assert.equal(await setOneTime(db, lead.id, h3, at(259200)), null);
  assert.equal(await setOwnPassword(db, lead.id, h3, h1), false);
  await db.close();
});

test('an actor is read with its session, and an expired or deleted session reads none', async () => {
  const db = await testDb();
  const hash = await hashOf('a long password of mine');
  const admin = await made(db, 'password', 'octo-admin', 'admin', hash);
  await createSession(db, { idHash: 'h-a', login: 'octo-admin', via: 'password', accountId: admin.id, at: at(0), expiresAt: at(43200) });
  await createSession(db, { idHash: 'h-b', login: 'octo-admin', via: 'password', accountId: admin.id, at: at(0), expiresAt: at(43200) });
  const actor = { id: admin.id, kind: 'password', name: 'octo-admin', role: 'admin' };
  assert.deepEqual(await actorOf(db, 'h-a', at(43199)), actor);
  assert.equal(await actorOf(db, 'h-a', at(43200)), null);
  assert.equal(await actorOf(db, 'h-none', at(10)), null);
  assert.equal(await deleteSession(db, 'h-b'), true);
  assert.equal(await actorOf(db, 'h-b', at(10)), null);
  await signedInAt(db, admin.id, at(5));
  assert.equal(iso((await accountById(db, admin.id))!.last_sign_in_at), at(5));
  assert.equal((await deleteAccount(db, admin.id))?.name, 'octo-admin');
  assert.equal(await actorOf(db, 'h-a', at(10)), null);
  assert.equal(await deleteAccount(db, admin.id), null);
  await db.close();
});

test('a change is recorded with who made it, what, to whom and the new role, as text that outlives the account', async () => {
  const db = await testDb();
  const hash = await hashOf('a long password of mine');
  await made(db, 'password', 'octo-admin', 'admin', hash);
  const viewer = await made(db, 'password', 'octo-viewer', 'viewer', hash);
  await recordChange(db, { at: at(30), by: 'password', byName: 'octo-admin', change: 'role', kind: 'password', name: 'octo-viewer', role: 'admin' });
  const record = [{ at: at(30), by_kind: 'password', by_name: 'octo-admin', change: 'role', account_kind: 'password', account_name: 'octo-viewer', role: 'admin' }];
  assert.deepEqual(await changes(db), record);
  await deleteAccount(db, viewer.id);
  assert.deepEqual(await changes(db), record);
  await db.close();
});
