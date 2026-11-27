// The store of alerts and of each dependency's state (the UI plan's Overview; calls 2, 7 to 11). A key, a code, a name and a part
// go in through storable(), the details and the missing list through storableJson(); nothing here logs.
import { storable, storableJson } from './text.ts';
import type { Db } from './types.ts';

/** The alerts that open when a dependency fails and clear when it works again. */
export const PAIR_OPENERS: readonly string[] = ['model_error', 'mcp_error', 'extension_error', 'memory_error'];
/** The alerts of spend: one a UTC day. */
export const SPEND_ALERTS: readonly string[] = ['spend_80', 'spend_limit'];

export type AlertDetails = Record<string, string | number | boolean>;
export interface AlertRow { id: number; code: string; key: string; details: unknown; raised_at: Date; cleared_at: Date | null }

/** Stores one alert; false when `dedupeSince` is given and a row of its code and key raised at or after it is not cleared. */
export async function storeAlert(
  db: Db, a: { code: string; key: string; details: AlertDetails; at: string; dedupeSince: string | null },
): Promise<boolean> {
  const rows = await db.query(
    `insert into visto_ai.alerts (code, key, details, raised_at)
     select $1, $2, $3::jsonb, $4::timestamptz
     where $5::timestamptz is null or not exists (
       select 1 from visto_ai.alerts where code = $1 and key = $2 and cleared_at is null and raised_at >= $5::timestamptz)
     returning id`,
    [storable(a.code), storable(a.key), storableJson(a.details), a.at, a.dedupeSince]);
  return rows.length === 1;
}

/** Clears the open rows of a code, of one key or (key null) of every key; how many. */
export async function clearAlerts(db: Db, code: string, key: string | null, at: string): Promise<number> {
  const rows = await db.query(
    `update visto_ai.alerts set cleared_at = $3::timestamptz
     where code = $1 and ($2::text is null or key = $2) and cleared_at is null
     returning id`,
    [storable(code), key === null ? null : storable(key), at]);
  return rows.length;
}

/** The open alerts (call 8), newest first; `dayStart` is the start of the clock's UTC day. */
export function openAlerts(db: Db, dayStart: string, limit: number): Promise<AlertRow[]> {
  return db.query<AlertRow>(
    `select a.id, a.code, a.key, a.details, a.raised_at, a.cleared_at from visto_ai.alerts a
     where (a.code in ('model_error', 'mcp_error', 'extension_error', 'memory_error', 'feature_off') and a.cleared_at is null)
        or (a.code in ('spend_80', 'spend_limit') and a.cleared_at is null and a.raised_at >= $1::timestamptz)
        or (a.code = 'dismissal_failed'
            and a.id = (select max(b.id) from visto_ai.alerts b where b.code = 'dismissal_failed' and b.key = a.key)
            and exists (select 1 from visto_ai.review_runs r
                        where r.owner || '/' || r.repo || '#' || r.number = a.key
                          and r.approved and r.published and not r.dry_run and r.dismissed_at is null and r.dismiss_failure is not null))
     order by a.raised_at desc, a.id desc
     limit $2`,
    [dayStart, limit]);
}

/** The alerts raised since `since`, but those of `except`, newest first. */
export function recentAlerts(db: Db, since: string, except: readonly number[], limit: number): Promise<AlertRow[]> {
  return db.query<AlertRow>(
    `select id, code, key, details, raised_at, cleared_at from visto_ai.alerts
     where raised_at >= $1::timestamptz and id not in (select (jsonb_array_elements_text($2::jsonb))::int)
     order by raised_at desc, id desc
     limit $3`,
    [since, JSON.stringify(except), limit]);
}

/** Deletes the alerts raised before `before` that are not open but by their day; how many. */
export async function pruneAlerts(db: Db, before: string): Promise<number> {
  const rows = await db.query(
    `delete from visto_ai.alerts a
     where a.raised_at < $1::timestamptz
       and not (a.code in ('model_error', 'mcp_error', 'extension_error', 'memory_error', 'feature_off') and a.cleared_at is null)
       and not (a.code = 'dismissal_failed' and exists (select 1 from visto_ai.review_runs r
                where r.owner || '/' || r.repo || '#' || r.number = a.key
                  and r.approved and r.published and not r.dry_run and r.dismissed_at is null and r.dismiss_failure is not null))
     returning id`,
    [before]);
  return rows.length;
}

export type HealthKind = 'model' | 'scorer' | 'memory' | 'extension' | 'mcp' | 'app';
export interface HealthRow {
  kind: HealthKind; name: string; part: string; status: 'ok' | 'failing'; code: string | null; missing: unknown; since: Date; seen_at: Date;
}

/** One dependency's state: `since` stays while its status holds and becomes `at` when it changes; an older write changes nothing. */
export async function writeHealth(
  db: Db, h: { kind: HealthKind; name: string; part: string; ok: boolean; code: string | null; missing: unknown; at: string },
): Promise<void> {
  await db.query(
    `insert into visto_ai.dependency_health (kind, name, part, status, code, missing, since, seen_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $7::timestamptz)
     on conflict (kind, name, part) do update set
       since = case when visto_ai.dependency_health.status = excluded.status then visto_ai.dependency_health.since else excluded.since end,
       status = excluded.status, code = excluded.code, missing = excluded.missing, seen_at = excluded.seen_at
     where visto_ai.dependency_health.seen_at <= excluded.seen_at`,
    [h.kind, storable(h.name), storable(h.part), h.ok ? 'ok' : 'failing', h.code === null ? null : storable(h.code),
      h.missing === null || h.missing === undefined ? null : storableJson(h.missing), h.at]);
}

export function readHealth(db: Db): Promise<HealthRow[]> {
  return db.query<HealthRow>(
    'select kind, name, part, status, code, missing, since, seen_at from visto_ai.dependency_health order by kind, name, part');
}
