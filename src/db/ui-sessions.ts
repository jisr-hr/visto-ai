import { storable } from './text.ts';
import type { Db } from './types.ts';

/** A session's last use is written again once the stored one is this old: a read every few seconds writes once a minute. */
const LAST_USE_STEP_MS = 60_000;

/** `via`: 'account', or the team's "org/slug" as the file wrote it (call 11). */
export async function createSession(db: Db, s: { idHash: string; login: string; via: string; at: string; expiresAt: string }): Promise<void> {
  await db.query(
    `insert into visto_ai.ui_sessions (id_hash, login, via, created_at, last_used_at, expires_at)
     values ($1, $2, $3, $4::timestamptz, $4::timestamptz, $5::timestamptz)`,
    [s.idHash, storable(s.login), storable(s.via), s.at, s.expiresAt]);
}

/** The session's login and way in while it has not expired; its last use is written when the stored last use is 60 seconds old or more. */
export async function readSession(db: Db, idHash: string, now: string): Promise<{ login: string; via: string } | null> {
  const rows = await db.query<{ login: string; via: string; last_used_at: Date }>(
    `select login, via, last_used_at from visto_ai.ui_sessions where id_hash = $1 and expires_at > $2::timestamptz`,
    [idHash, now]);
  const r = rows[0];
  if (r === undefined) return null;
  if (Date.parse(now) - r.last_used_at.getTime() >= LAST_USE_STEP_MS) {
    await db.query(`update visto_ai.ui_sessions set last_used_at = $2::timestamptz where id_hash = $1`, [idHash, now]);
  }
  return { login: r.login, via: r.via };
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
