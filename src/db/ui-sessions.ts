import { storable } from './text.ts';
import type { Db } from './types.ts';
import type { AccountKind, Role } from './ui-accounts.ts';

/** A session's last use is written again once the stored one is this old: a read every few seconds writes once a minute. */
const LAST_USE_STEP_MS = 60_000;

/**
 * `via`: 'account', the team's "org/slug" as the file wrote it (call 11), or 'password'. `login` is the account's name at sign-in,
 * never read back.
 */
export async function createSession(db: Db, s: { idHash: string; login: string; via: string; accountId: number; at: string; expiresAt: string }): Promise<void> {
  await db.query(
    `insert into visto_ai.ui_sessions (id_hash, login, via, account_id, created_at, last_used_at, expires_at)
     values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $6::timestamptz)`,
    [s.idHash, storable(s.login), storable(s.via), s.accountId, s.at, s.expiresAt]);
}

/**
 * The session's way in and its account, kind and role as the row has them now, while it has not expired; `login` is the account's
 * name now. Its last use is written when the stored last use is 60 seconds old or more.
 */
export async function readSession(db: Db, idHash: string, now: string): Promise<{ login: string; via: string; accountId: number; kind: AccountKind; role: Role } | null> {
  const rows = await db.query<{ via: string; last_used_at: Date; account_id: number; kind: AccountKind; name: string; role: Role }>(
    `select s.via, s.last_used_at, a.id as account_id, a.kind, a.name, a.role
     from visto_ai.ui_sessions s join visto_ai.ui_accounts a on a.id = s.account_id
     where s.id_hash = $1 and s.expires_at > $2::timestamptz`,
    [idHash, now]);
  const r = rows[0];
  if (r === undefined) return null;
  if (Date.parse(now) - r.last_used_at.getTime() >= LAST_USE_STEP_MS) {
    await db.query(`update visto_ai.ui_sessions set last_used_at = $2::timestamptz where id_hash = $1`, [idHash, now]);
  }
  return { login: r.name, via: r.via, accountId: r.account_id, kind: r.kind, role: r.role };
}

/** Deletes the account's sessions but `keep` (an id hash) when given; how many. */
export async function deleteSessionsOf(db: Db, accountId: number, keep: string | null): Promise<number> {
  const rows = await db.query(
    'delete from visto_ai.ui_sessions where account_id = $1 and ($2::text is null or id_hash <> $2) returning id_hash', [accountId, keep]);
  return rows.length;
}

export async function deleteSession(db: Db, idHash: string): Promise<boolean> {
  const rows = await db.query(`delete from visto_ai.ui_sessions where id_hash = $1 returning id_hash`, [idHash]);
  return rows.length === 1;
}

export async function saveState(db: Db, s: { stateHash: string; verifierHash: string; expiresAt: string }): Promise<void> {
  await db.query(
    `insert into visto_ai.ui_states (state_hash, verifier_hash, expires_at) values ($1, $2, $3::timestamptz)`,
    [s.stateHash, s.verifierHash, s.expiresAt]);
}

/** Deletes the state; its verifier's hash when it was there and had not expired, else null. A `now` that cannot be read rejects first, taking nothing. */
export async function takeState(db: Db, stateHash: string, now: string): Promise<{ verifierHash: string } | null> {
  const at = Date.parse(now);
  if (Number.isNaN(at)) throw new Error('bad_time');
  const rows = await db.query<{ verifier_hash: string; expires_at: Date }>(
    `delete from visto_ai.ui_states where state_hash = $1 returning verifier_hash, expires_at`, [stateHash]);
  const r = rows[0];
  if (r === undefined || !(r.expires_at.getTime() > at)) return null;
  return { verifierHash: r.verifier_hash };
}

/** How many states have not expired at `now`. */
export async function liveStates(db: Db, now: string): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from visto_ai.ui_states where expires_at > $1::timestamptz`, [now]);
  return rows[0]?.n ?? 0;
}

/** Deletes the sessions and states expired at `now`; how many. */
export async function deleteExpired(db: Db, now: string): Promise<number> {
  const sessions = await db.query(`delete from visto_ai.ui_sessions where expires_at <= $1::timestamptz returning id_hash`, [now]);
  const states = await db.query(`delete from visto_ai.ui_states where expires_at <= $1::timestamptz returning state_hash`, [now]);
  return sessions.length + states.length;
}
