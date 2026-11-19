import type { Db } from './types.ts';

/** When the service was last known alive. null before the first beat. */
export async function readHeartbeat(db: Db): Promise<string | null> {
  const rows = await db.query<{ alive_at: Date }>('select alive_at from visto_ai.heartbeat where only_row');
  return rows[0] === undefined ? null : rows[0].alive_at.toISOString();
}

export async function beat(db: Db, now: string): Promise<void> {
  await db.query(
    `insert into visto_ai.heartbeat (only_row, alive_at) values (true, $1::timestamptz)
     on conflict (only_row) do update set alive_at = excluded.alive_at`,
    [now]);
}
