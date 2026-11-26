// Making, re-roling, resetting and removing accounts, for the API and for the command alike (the password design 4.2, 4.3,
// 4.6 and 4.8; calls 8 to 10, 12 and 24). The one-time password is drawn and hashed before the lock; then each change runs
// inside underLock: the actor read again there, the target, the rule, the change and its record, and one ui_account line once
// it has committed. A refusal reads and writes nothing after the step that refused, and is not logged. No line holds a name,
// a login, a password or a hash.
import type { Db } from '../db/types.ts';
import {
  MAX_ACCOUNTS, accountById, actorOf, countAccounts, countingAdminsBesides, deleteAccount, githubAccount, insertAccount, listAccounts,
  passwordAccount, recordChange, setOneTime, setRole as writeRole, underLock,
} from '../db/ui-accounts.ts';
import type { AccountRow, ByKind, Change, Role } from '../db/ui-accounts.ts';
import { deleteSessionsOf } from '../db/ui-sessions.ts';
import type { Account } from './api-types.ts';
import { NAME, PASSWORD_COST, hashPassword, oneTimePassword } from './passwords.ts';
import type { PasswordCost } from './passwords.ts';

/** How long a one-time password holds: 72 hours (call 12). */
export const ONE_TIME_MS = 72 * 3_600_000;
/** Who makes a change: a session, read again under the lock, or the command. */
export type Actor = { by: 'session'; idHash: string } | { by: 'command' };
export type Refusal = 'signed_out' | 'forbidden' | 'not_found' | 'bad_name' | 'bad_login' | 'name_taken' | 'full' | 'last_admin' | 'github_account' | 'own_account';
export interface Made { account: AccountRow; oneTimePassword: string; expiresAt: string }
export interface AccountsDeps { db: Db; clock: () => Date; log: (entry: Record<string, unknown>) => void; cost?: PasswordCost; max?: number }
export interface AccountChanges {
  list(): Promise<AccountRow[]>;                                   // at most MAX_ACCOUNTS
  make(actor: Actor, name: string, role: Role): Promise<Made | Refusal>;
  /** `made`: the row was made by this call; `changed`: a row there before had another role, now written; both false: it had the role already. */
  setRole(actor: Actor, target: { id: number } | { github: string }, role: Role): Promise<{ account: AccountRow; made: boolean; changed: boolean } | Refusal>;
  reset(actor: Actor, target: { id: number } | { name: string }): Promise<Made | Refusal>;
  remove(actor: Actor, id: number): Promise<AccountRow | Refusal>;
}

/** A GitHub login as GitHub allows it. */
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

/** A time as an ISO string; a clock that gives no time throws here, before any statement. */
const iso = (ms: number): string => new Date(ms).toISOString();

/** Who the record names: the actor's id (null for the command), its kind and its name. */
interface By { id: number | null; by: ByKind; byName: string | null }
/** What a change under the lock gives back, and the line logged once it has committed (none when nothing was written). */
interface Done<T> { value: T; line: { change: Change; role: Role | null } | null }
type Roled = { account: AccountRow; made: boolean; changed: boolean };

/** The API's view of a row: never its hash; `you` when its id is `you`. */
export function accountOf(row: AccountRow, now: Date, you: number | null): Account {
  const at = now.getTime();
  const password = row.kind === 'github' ? null
    : row.one_time_until === null ? 'set'
      : row.one_time_until.getTime() > at ? 'one_time' : 'expired';
  return {
    id: row.id, kind: row.kind, name: row.name, role: row.role, password,
    waitsUntil: row.wait_until !== null && row.wait_until.getTime() > at ? row.wait_until.toISOString() : null,
    madeAt: row.made_at.toISOString(), madeBy: { kind: row.made_by_kind, name: row.made_by_name },
    lastSignInAt: row.last_sign_in_at?.toISOString() ?? null, you: you !== null && row.id === you,
  };
}

export function createAccountChanges(deps: AccountsDeps): AccountChanges {
  const cost = deps.cost ?? PASSWORD_COST;
  const max = deps.max ?? MAX_ACCOUNTS;

  /** Rule 1: the work under the lock; its line logged after the commit, and none for a refusal or a failure. */
  async function locked<T>(work: (tx: Db) => Promise<Done<T> | Refusal>): Promise<T | Refusal> {
    const done = await underLock(deps.db, work);
    if (typeof done === 'string') return done;
    if (done.line !== null) deps.log({ event: 'ui_account', change: done.line.change, role: done.line.role });
    return done.value;
  }

  /** Under the lock: a session's account as it is now, which must be an admin's; the command reads nothing. */
  async function whoIs(tx: Db, actor: Actor, at: string): Promise<By | Refusal> {
    if (actor.by === 'command') return { id: null, by: 'command', byName: null };
    const found = await actorOf(tx, actor.idHash, at);
    if (found === null) return 'signed_out';
    if (found.role !== 'admin') return 'forbidden';
    return { id: found.id, by: found.kind, byName: found.name };
  }

  /** A new one-time password and its hash, made before the lock (rule 1). */
  async function drawn(): Promise<{ oneTime: string; hash: string }> {
    const oneTime = oneTimePassword();
    return { oneTime, hash: await hashPassword(oneTime, cost) };
  }

  /** Rule 3, for a row read under the lock: the role it has already writes nothing; the last counting admin stays one. */
  async function rerole(tx: Db, by: By, row: AccountRow, role: Role, at: string): Promise<Done<Roled> | Refusal> {
    if (row.role === role) return { value: { account: row, made: false, changed: false }, line: null };
    if (row.role === 'admin' && await countingAdminsBesides(tx, row.id) === 0) return 'last_admin';
    const account = await writeRole(tx, row.id, role);
    if (account === null) return 'not_found';
    await recordChange(tx, { at, by: by.by, byName: by.byName, change: 'role', kind: account.kind, name: account.name, role });
    return { value: { account, made: false, changed: true }, line: { change: 'role', role } };
  }

  return {
    list: () => listAccounts(deps.db, MAX_ACCOUNTS),

    async make(actor, name, role) {
      if (!NAME.test(name)) return 'bad_name';
      const now = deps.clock().getTime();
      const at = iso(now);
      const until = iso(now + ONE_TIME_MS);
      const { oneTime, hash } = await drawn();
      return locked(async (tx) => {
        const by = await whoIs(tx, actor, at);
        if (typeof by === 'string') return by;
        if (await countAccounts(tx) >= max) return 'full';
        const account = await insertAccount(tx, {
          kind: 'password', name, role, passwordHash: hash, oneTimeUntil: until, at, by: by.by, byName: by.byName, signedInAt: null,
        });
        if (account === null) return 'name_taken';
        await recordChange(tx, { at, by: by.by, byName: by.byName, change: 'made', kind: 'password', name: account.name, role });
        return { value: { account, oneTimePassword: oneTime, expiresAt: until }, line: { change: 'made', role } };
      });
    },

    async setRole(actor, target, role) {
      if (!('id' in target) && !LOGIN.test(target.github)) return 'bad_login';
      const at = iso(deps.clock().getTime());
      return locked(async (tx) => {
        const by = await whoIs(tx, actor, at);
        if (typeof by === 'string') return by;
        if ('id' in target) {
          const row = await accountById(tx, target.id);
          return row === null ? 'not_found' : rerole(tx, by, row, role, at);
        }
        const row = await githubAccount(tx, target.github);
        if (row !== null) return rerole(tx, by, row, role, at);
        if (await countAccounts(tx) >= max) return 'full';
        const account = await insertAccount(tx, {
          kind: 'github', name: target.github, role, passwordHash: null, oneTimeUntil: null, at, by: by.by, byName: by.byName, signedInAt: null,
        });
        // Under the lock, with no row of that login found, the name cannot be taken: should it be, nothing is made.
        if (account === null) throw new Error('account_taken');
        await recordChange(tx, { at, by: by.by, byName: by.byName, change: 'made', kind: 'github', name: account.name, role });
        return { value: { account, made: true, changed: false }, line: { change: 'made', role } };
      });
    },

    async reset(actor, target) {
      const now = deps.clock().getTime();
      const at = iso(now);
      const until = iso(now + ONE_TIME_MS);
      const { oneTime, hash } = await drawn();
      return locked(async (tx) => {
        const by = await whoIs(tx, actor, at);
        if (typeof by === 'string') return by;
        const row = 'id' in target ? await accountById(tx, target.id) : await passwordAccount(tx, target.name);
        if (row === null) return 'not_found';
        if (row.kind === 'github') return 'github_account';
        // Call 9: an admin resets another's password, never their own, in the UI.
        if (row.id === by.id) return 'own_account';
        const account = await setOneTime(tx, row.id, hash, until);
        if (account === null) return 'not_found';
        await deleteSessionsOf(tx, row.id, null);
        await recordChange(tx, { at, by: by.by, byName: by.byName, change: 'reset', kind: 'password', name: account.name, role: account.role });
        return { value: { account, oneTimePassword: oneTime, expiresAt: until }, line: { change: 'reset', role: account.role } };
      });
    },

    async remove(actor, id) {
      const at = iso(deps.clock().getTime());
      return locked(async (tx) => {
        const by = await whoIs(tx, actor, at);
        if (typeof by === 'string') return by;
        const row = await accountById(tx, id);
        if (row === null) return 'not_found';
        if (row.role === 'admin' && await countingAdminsBesides(tx, row.id) === 0) return 'last_admin';
        // Its sessions go with it (on delete cascade).
        const gone = await deleteAccount(tx, row.id);
        if (gone === null) return 'not_found';
        await recordChange(tx, { at, by: by.by, byName: by.byName, change: 'removed', kind: gone.kind, name: gone.name, role: null });
        return { value: gone, line: { change: 'removed', role: null } };
      });
    },
  };
}
