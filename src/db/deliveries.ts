import { storable, storableOrNull } from './text.ts';
import type { Db } from './types.ts';

/** false when this id was already recorded: the caller then does nothing else. */
export async function recordDelivery(
  db: Db,
  d: { id: string; name: string; action: string | null; outcome: 'handled' | 'ignored'; reason: string | null },
): Promise<boolean> {
  const rows = await db.query(
    `insert into visto_ai.deliveries (id, name, action, outcome, reason)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do nothing
     returning id`,
    [storable(d.id), storable(d.name), storableOrNull(d.action), d.outcome, storableOrNull(d.reason)]);
  return rows.length === 1;
}
