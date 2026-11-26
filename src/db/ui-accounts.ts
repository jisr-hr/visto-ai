// Accounts of both kinds, the record of their changes, and the lock every change that can lower the number of admins runs
// under (the password design 4.2, 4.4, 4.5 and 4.8; calls 7, 8, 10, 17 and 18). A name is stored through storable(); nothing
// here logs.
import { storable, storableOrNull } from './text.ts';
import type { Db } from './types.ts';

/** At most this many accounts, of both kinds (4.2). */
export const MAX_ACCOUNTS = 1000;
export type AccountKind = 'password' | 'github';
export type Role = 'admin' | 'viewer';
/** Who made a change: a password account, a GitHub account, the command, or a GitHub sign-in that made its own row. */
export type ByKind = 'password' | 'github' | 'command' | 'sign_in';
export type Change = 'made' | 'role' | 'reset' | 'removed' | 'password_changed';
export interface AccountRow {
  id: number; kind: AccountKind; name: string; role: Role; password_hash: string | null; one_time_until: Date | null;
  failed_tries: number; wait_until: Date | null; made_at: Date; made_by_kind: ByKind; made_by_name: string | null; last_sign_in_at: Date | null;
}
export interface Actor { id: number; kind: AccountKind; name: string; role: Role }

/** The columns of an account row, in its order. */
const A = 'id, kind, name, role, password_hash, one_time_until, failed_tries, wait_until, made_at, made_by_kind, made_by_name, last_sign_in_at';
const LOCK = 'lock table visto_ai.ui_accounts in share row exclusive mode';

/** One transaction whose first statement is the lock (call 8): it conflicts with itself and with every write, not with reads. */
export function underLock<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(LOCK);
    return work(tx);
  });
}

async function one(db: Db, text: string, params: unknown[]): Promise<AccountRow | null> {
  return (await db.query<AccountRow>(text, params))[0] ?? null;
}

export function passwordAccount(db: Db, name: string): Promise<AccountRow | null> {
  return one(db, `select ${A} from visto_ai.ui_accounts where kind = 'password' and name = $1`, [storable(name)]);
}

export function accountById(db: Db, id: number): Promise<AccountRow | null> {
  return one(db, `select ${A} from visto_ai.ui_accounts where id = $1`, [id]);
}

/** The GitHub account of `login`, letter case aside. */
export function githubAccount(db: Db, login: string): Promise<AccountRow | null> {
  return one(db, `select ${A} from visto_ai.ui_accounts where kind = 'github' and lower(name) = lower($1)`, [storable(login)]);
}

export function listAccounts(db: Db, limit: number): Promise<AccountRow[]> {
  return db.query<AccountRow>(`select ${A} from visto_ai.ui_accounts order by lower(name), kind, id limit $1`, [limit]);
}

export async function countAccounts(db: Db): Promise<number> {
  return (await db.query<{ n: number }>('select count(*)::int as n from visto_ai.ui_accounts'))[0]?.n ?? 0;
}

/** The counting admins but `id`: the GitHub ones, and the password ones that chose their password (4.2). */
export async function countingAdminsBesides(db: Db, id: number): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from visto_ai.ui_accounts where role = 'admin' and (kind = 'github' or one_time_until is null) and id <> $1`, [id]);
  return rows[0]?.n ?? 0;
}

/** null when the name is taken in its kind. */
export function insertAccount(db: Db, a: {
  kind: AccountKind; name: string; role: Role; passwordHash: string | null; oneTimeUntil: string | null;
  at: string; by: ByKind; byName: string | null; signedInAt: string | null;
}): Promise<AccountRow | null> {
  return one(db,
    `insert into visto_ai.ui_accounts (kind, name, role, password_hash, one_time_until, made_at, made_by_kind, made_by_name, last_sign_in_at)
     values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9::timestamptz)
     on conflict do nothing returning ${A}`,
    [a.kind, storable(a.name), a.role, a.passwordHash, a.oneTimeUntil, a.at, a.by, storableOrNull(a.byName), a.signedInAt]);
}

export function setRole(db: Db, id: number, role: Role): Promise<AccountRow | null> {
  return one(db, `update visto_ai.ui_accounts set role = $2 where id = $1 returning ${A}`, [id, role]);
}

/** A one-time password's hash and its end on a password account, its count and its wait cleared. */
export function setOneTime(db: Db, id: number, hash: string, until: string): Promise<AccountRow | null> {
  return one(db,
    `update visto_ai.ui_accounts set password_hash = $2, one_time_until = $3::timestamptz, failed_tries = 0, wait_until = null
     where id = $1 and kind = 'password' returning ${A}`,
    [id, hash, until]);
}

/**
 * Sets a password chosen by its account, only over the hash that was verified and while the account does not wait at `now`, the
 * service's clock; false when the row's hash is another now or it waits.
 */
export async function setOwnPassword(db: Db, id: number, hash: string, verified: string, now: string): Promise<boolean> {
  const rows = await db.query(
    `update visto_ai.ui_accounts set password_hash = $2, one_time_until = null, failed_tries = 0, wait_until = null
     where id = $1 and kind = 'password' and password_hash = $3 and (wait_until is null or wait_until <= $4::timestamptz) returning id`,
    [id, hash, verified, now]);
  return rows.length === 1;
}

/** Deletes the account, and its sessions with it (on delete cascade); the row it was, or null. */
export function deleteAccount(db: Db, id: number): Promise<AccountRow | null> {
  return one(db, `delete from visto_ai.ui_accounts where id = $1 returning ${A}`, [id]);
}

/** A wrong password: the fifth in a row starts the wait `waitUntil` (the clock plus 15 minutes) and counts again from none (call 14). */
export async function wrongTry(db: Db, id: number, waitUntil: string): Promise<void> {
  await db.query(
    `update visto_ai.ui_accounts set
       failed_tries = case when failed_tries + 1 >= 5 then 0 else failed_tries + 1 end,
       wait_until = case when failed_tries + 1 >= 5 then $2::timestamptz else wait_until end
     where id = $1 and kind = 'password'`,
    [id, waitUntil]);
}

/**
 * Clears the count and the wait only while the row's hash is still `verified` and the account does not wait at `now`, the service's
 * clock (call 17); false when it is another now or it waits, and nothing is written.
 */
export async function rightTry(db: Db, id: number, verified: string, now: string): Promise<boolean> {
  const rows = await db.query(
    'update visto_ai.ui_accounts set failed_tries = 0, wait_until = null where id = $1 and password_hash = $2 and (wait_until is null or wait_until <= $3::timestamptz) returning id',
    [id, verified, now]);
  return rows.length === 1;
}

export async function signedInAt(db: Db, id: number, at: string): Promise<void> {
  await db.query('update visto_ai.ui_accounts set last_sign_in_at = $2::timestamptz where id = $1', [id, at]);
}

/** One row of the record of changes (4.8): the names as text, so it outlives the accounts; `role` is the new one, null for a removal. */
export async function recordChange(db: Db, c: {
  at: string; by: ByKind; byName: string | null; change: Change; kind: AccountKind; name: string; role: Role | null;
}): Promise<void> {
  await db.query(
    `insert into visto_ai.ui_account_changes (at, by_kind, by_name, change, account_kind, account_name, role)
     values ($1::timestamptz, $2, $3, $4, $5, $6, $7)`,
    [c.at, c.by, storableOrNull(c.byName), c.change, c.kind, storable(c.name), c.role]);
}

/** The account of a session that has not expired; null when there is none. */
export async function actorOf(db: Db, idHash: string, now: string): Promise<Actor | null> {
  const rows = await db.query<Actor>(
    `select a.id, a.kind, a.name, a.role
     from visto_ai.ui_sessions s join visto_ai.ui_accounts a on a.id = s.account_id
     where s.id_hash = $1 and s.expires_at > $2::timestamptz`,
    [idHash, now]);
  return rows[0] ?? null;
}

/** The GitHub account of `login`, letter case aside, its name written as GitHub writes it now and its last sign-in `at`. */
function signInOf(db: Db, login: string, at: string): Promise<AccountRow | null> {
  return one(db,
    `update visto_ai.ui_accounts set name = $1, last_sign_in_at = $2::timestamptz
     where kind = 'github' and lower(name) = lower($1) returning ${A}`,
    [storable(login), at]);
}

/** Call 18: the GitHub account of `login`, its name and last sign-in written; made as a viewer when there is none. */
export async function githubSignIn(db: Db, login: string, at: string, max: number): Promise<{ account: AccountRow; made: boolean } | 'full'> {
  const found = await signInOf(db, login, at);
  if (found !== null) return { account: found, made: false };
  return underLock(db, async (tx) => {
    // Another sign-in of the same login may have made it while this one waited for the lock.
    const again = await signInOf(tx, login, at);
    if (again !== null) return { account: again, made: false };
    if (await countAccounts(tx) >= max) return 'full';
    const account = await insertAccount(tx, {
      kind: 'github', name: login, role: 'viewer', passwordHash: null, oneTimeUntil: null, at, by: 'sign_in', byName: null, signedInAt: at,
    });
    // Under the lock, with no row of that login found, the name cannot be taken: should it be, nothing is made.
    if (account === null) throw new Error('account_taken');
    await recordChange(tx, { at, by: 'sign_in', byName: null, change: 'made', kind: 'github', name: login, role: 'viewer' });
    return { account, made: true };
  });
}
