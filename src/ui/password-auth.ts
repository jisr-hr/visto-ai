// Password sign-in, the first password chosen after a one-time password, and changing one's own password (the password design
// 4.3, 4.5 and 4.8; calls 13 to 17 and 24). Every refusal of a sign-in reads alike and runs exactly one verify: the account's
// hash for a wrong password, the hash made at start for the rest. A session is made only inside the transaction whose first
// statement is guarded by the hash that was verified, so a reset or a change committed meanwhile wins. No answer, log line or
// error holds a name, a password, a one-time password, a hash or a session id, but the cookie the sign-in itself sets.
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/types.ts';
import { accountById, passwordAccount, recordChange, rightTry, setOwnPassword, signedInAt, wrongTry } from '../db/ui-accounts.ts';
import type { AccountRow } from '../db/ui-accounts.ts';
import { createSession, deleteExpired, deleteSessionsOf } from '../db/ui-sessions.ts';
import { codeOf } from '../shell/codes.ts';
import type { UiAnswer } from '../shell/http.ts';
import type { SignInStep } from './api-types.ts';
import { SESSION_MS, SWEEP_MS, hashOf, sessionCookie } from './auth.ts';
import type { Session } from './auth.ts';
import { SECURITY_HEADERS, json } from './headers.ts';
import { NAME, PASSWORD_COST, hashPassword, passwordLengthOk, verifyPassword } from './passwords.ts';
import type { PasswordCost } from './passwords.ts';

/** Wrong passwords in a row that start the wait; `wrongTry` counts them in the store. */
export const WRONG_TRIES = 5;
export const WAIT_MS = 15 * 60_000;
export interface PasswordAuthDeps {
  db: Db; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  random?: () => string;                                       // a session id: 32 random bytes in base64url; absent: randomBytes(32)
  cost?: PasswordCost;                                         // every hash it makes, the hash made at start included; absent: PASSWORD_COST
  verify?: (password: string, stored: string) => Promise<boolean>;   // absent: verifyPassword (a test records what is compared)
}
export interface PasswordAuth {
  signIn(body: Record<string, unknown>): Promise<UiAnswer>;                     // POST /api/auth/password, after the origin and JSON checks; never rejects
  firstPassword(body: Record<string, unknown>): Promise<UiAnswer>;              // POST /api/auth/first-password, after the same; never rejects
  change(session: Session, body: Record<string, unknown>): Promise<UiAnswer>;   // POST /api/me/password, after the token check; rejects on a failure
}

/** Rule 2: the most characters each field of a body may hold. */
const LIMITS = { name: 200, password: 1024, oneTimePassword: 1024, current: 1024 };
type Field = keyof typeof LIMITS;

/** The body's fields when it has exactly `keys`, each a string within its limit; null for anything else. */
function fieldsOf<K extends Field>(body: Record<string, unknown>, keys: readonly K[]): Record<K, string> | null {
  if (Object.keys(body).length !== keys.length) return null;
  const fields: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = Object.hasOwn(body, key) ? body[key] : undefined;
    if (typeof value !== 'string' || value.length > LIMITS[key]) return null;
    fields[key] = value;
  }
  return fields as Record<K, string>;
}

/** A time as an ISO string; a clock that gives no time throws here, before any statement. */
const iso = (ms: number): string => new Date(ms).toISOString();
const waits = (row: AccountRow, now: number): boolean => row.wait_until !== null && row.wait_until.getTime() > now;
const step = (next: SignInStep['next']): SignInStep => ({ next });

type Outcome = 'ok' | 'choose' | 'refused' | 'expired' | 'already_chosen' | 'bad_request' | 'failed';
interface Ending { answer: UiAnswer; outcome: Outcome; reason: string | null }
const ending = (answer: UiAnswer, outcome: Outcome, reason: string | null = null): Ending => ({ answer, outcome, reason });
const refused = (): Ending => ending(json(401, { error: 'refused' }), 'refused');
const badRequest = (code: string): Ending => ending(json(400, { error: code }), 'bad_request', code);
const signedIn = (id: string): Ending => ending(json(200, step('signed_in'), { 'set-cookie': sessionCookie(id) }), 'ok');
const wrongPassword = (): UiAnswer => json(400, { error: 'wrong_password' });

/** One for the service: it makes the hash made at start once, and keeps when it last deleted expired rows. */
export function createPasswordAuth(deps: PasswordAuthDeps): PasswordAuth {
  const random = deps.random ?? ((): string => randomBytes(32).toString('base64url'));
  const cost = deps.cost ?? PASSWORD_COST;
  const verify = deps.verify ?? verifyPassword;
  // Rule 1: begun once, here; a rejection is caught so that it is never unhandled, and every request that needs it then fails
  // with it, as a database step that rejects.
  const atStart = hashPassword(randomBytes(32).toString('base64url'), cost);
  atStart.catch(() => undefined);
  // One time of the last sweep for the sign-in and the first password.
  let sweptAt: number | null = null;

  async function sweep(now: number): Promise<void> {
    if (sweptAt !== null && now - sweptAt < SWEEP_MS) return;
    await deleteExpired(deps.db, iso(now));
    sweptAt = now;
  }

  /** The password account of a typed name, with its name and the hash read; null for none, a name of another shape, or one that waits. */
  async function accountOf(typed: string, now: number): Promise<{ row: AccountRow; name: string; hash: string } | null> {
    const name = typed.trim().toLowerCase();
    if (!NAME.test(name)) return null;
    const row = await passwordAccount(deps.db, name);
    if (row === null || row.password_hash === null || waits(row, now)) return null;
    return { row, name, hash: row.password_hash };
  }

  /** A refusal that costs one verify, against the hash made at start. */
  async function refuseAlike(password: string): Promise<Ending> {
    await verify(password, await atStart);
    return refused();
  }

  /** Rule 6: on the transaction's `tx`, a session of twelve hours and the last sign-in; the session id. */
  async function openSession(tx: Db, accountId: number, name: string, now: number): Promise<string> {
    const id = random();
    await createSession(tx, { idHash: hashOf(id), login: name, via: 'password', accountId, at: iso(now), expiresAt: iso(now + SESSION_MS) });
    await signedInAt(tx, accountId, iso(now));
    return id;
  }

  async function signIn(body: Record<string, unknown>): Promise<Ending> {
    const given = fieldsOf(body, ['name', 'password']);
    if (given === null) return badRequest('bad_request');
    try {
      const now = deps.clock().getTime();
      iso(now);
      await sweep(now);
      const found = await accountOf(given.name, now);
      if (found === null) return await refuseAlike(given.password);
      const { row, name, hash } = found;
      if (!(await verify(given.password, hash))) {
        await wrongTry(deps.db, row.id, iso(now + WAIT_MS));
        return refused();
      }
      if (row.one_time_until !== null) {
        if (!(await rightTry(deps.db, row.id, hash))) return refused();
        if (row.one_time_until.getTime() <= now) return ending(json(401, { error: 'expired' }), 'expired');
        return ending(json(200, step('choose_password')), 'choose');
      }
      // Call 17: the guarded right try first; a hash changed meanwhile writes nothing and makes no session.
      const id = await deps.db.transaction(async (tx) => {
        if (!(await rightTry(tx, row.id, hash))) return null;
        return openSession(tx, row.id, name, now);
      });
      return id === null ? refused() : signedIn(id);
    } catch (error) {
      return ending(json(500, { error: 'internal_error' }), 'failed', codeOf(error));
    }
  }

  async function firstPassword(body: Record<string, unknown>): Promise<Ending> {
    const given = fieldsOf(body, ['name', 'oneTimePassword', 'password']);
    if (given === null) return badRequest('bad_request');
    if (!passwordLengthOk(given.password)) return badRequest('password_length');
    if (given.password === given.oneTimePassword) return badRequest('same_password');
    try {
      const now = deps.clock().getTime();
      iso(now);
      await sweep(now);
      const found = await accountOf(given.name, now);
      if (found === null) return await refuseAlike(given.oneTimePassword);
      const { row, name, hash } = found;
      if (!(await verify(given.oneTimePassword, hash))) {
        await wrongTry(deps.db, row.id, iso(now + WAIT_MS));
        return refused();
      }
      if (!(await rightTry(deps.db, row.id, hash))) return refused();
      if (row.one_time_until === null) return ending(json(409, { error: 'already_chosen' }), 'already_chosen');
      if (row.one_time_until.getTime() <= now) return ending(json(401, { error: 'expired' }), 'expired');
      // The new hash outside any transaction; then the first password only over the one-time password's hash (call 17).
      const chosen = await hashPassword(given.password, cost);
      const id = await deps.db.transaction(async (tx) => {
        if (!(await setOwnPassword(tx, row.id, chosen, hash))) return null;
        await recordChange(tx, { at: iso(now), by: 'password', byName: name, change: 'password_changed', kind: 'password', name, role: row.role });
        return openSession(tx, row.id, name, now);
      });
      if (id === null) return refused();
      deps.log({ event: 'ui_account', change: 'password_changed', role: row.role });
      return signedIn(id);
    } catch (error) {
      return ending(json(500, { error: 'internal_error' }), 'failed', codeOf(error));
    }
  }

  // Rule 8: one ui_signin line for each, its outcome and its short reason only.
  const logged = (work: (body: Record<string, unknown>) => Promise<Ending>) => async (body: Record<string, unknown>): Promise<UiAnswer> => {
    const end = await work(body);
    deps.log({ event: 'ui_signin', way: 'password', outcome: end.outcome, reason: end.reason });
    return end.answer;
  };

  return {
    signIn: logged(signIn),
    firstPassword: logged(firstPassword),

    // Rule 5: a database step or a hash that rejects makes it reject, with no line; the route answers and logs it.
    async change(session, body) {
      if (session.kind === 'github') return json(409, { error: 'github_account' });
      const given = fieldsOf(body, ['current', 'password']);
      if (given === null) return json(400, { error: 'bad_request' });
      if (!passwordLengthOk(given.password)) return json(400, { error: 'password_length' });
      const now = deps.clock().getTime();
      iso(now);
      const row = await accountById(deps.db, session.accountId);
      // A session whose account is gone, or is no password account, is signed out.
      if (row === null || row.kind !== 'password' || row.password_hash === null) return json(401, { error: 'signed_out' });
      const hash = row.password_hash;
      if (waits(row, now)) {
        await verify(given.current, await atStart);
        return wrongPassword();
      }
      if (!(await verify(given.current, hash))) {
        await wrongTry(deps.db, row.id, iso(now + WAIT_MS));
        return wrongPassword();
      }
      if (!(await rightTry(deps.db, row.id, hash))) return wrongPassword();
      const chosen = await hashPassword(given.password, cost);
      const changed = await deps.db.transaction(async (tx) => {
        if (!(await setOwnPassword(tx, row.id, chosen, hash))) return false;
        await deleteSessionsOf(tx, row.id, session.idHash);
        await recordChange(tx, {
          at: iso(now), by: 'password', byName: row.name, change: 'password_changed', kind: 'password', name: row.name, role: row.role,
        });
        return true;
      });
      if (!changed) return wrongPassword();
      deps.log({ event: 'ui_account', change: 'password_changed', role: row.role });
      return { status: 204, headers: { 'cache-control': 'no-store', ...SECURITY_HEADERS }, body: '' };
    },
  };
}
