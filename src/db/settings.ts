// The store of settings: the database's part (what the UI or the file last set), the file's part at the last start, and the
// record of changes (the UI design 4.3 and 4.4; calls 13, 16 and 17). A scope, a path and a name go in through storable(), a
// value through storableJson(); nothing here logs.
import { storable, storableJson } from './text.ts';
import type { Db } from './types.ts';

export type Source = 'config.yml' | 'ui';
export interface SettingRow { scope: string; path: string; value: unknown; set_by: Source; set_by_name: string | null; set_at: Date }
export interface ChangeRow {
  id: number; at: Date; by: Source; by_name: string | null; scope: string; path: string;
  /** The value's JSON text; null: not written. */
  before: string | null; after: string | null;
}

/** The first statement of a transaction that reads the settings and then writes them: it conflicts with itself and with every write, not with reads. */
export async function lockSettings(tx: Db): Promise<void> {
  await tx.query('lock table visto_ai.settings in share row exclusive mode');
}

export function readSettings(db: Db): Promise<SettingRow[]> {
  return db.query<SettingRow>('select scope, path, value, set_by, set_by_name, set_at from visto_ai.settings order by scope, path');
}

export function readFileSettings(db: Db): Promise<Array<{ scope: string; path: string; value: unknown }>> {
  return db.query('select scope, path, value from visto_ai.settings_file order by scope, path');
}

export async function writeSetting(
  db: Db, s: { scope: string; path: string; value: unknown; by: Source; name: string | null; at: string },
): Promise<void> {
  await db.query(
    `insert into visto_ai.settings (scope, path, value, set_by, set_by_name, set_at) values ($1, $2, $3::jsonb, $4, $5, $6::timestamptz)
     on conflict (scope, path) do update set value = excluded.value, set_by = excluded.set_by, set_by_name = excluded.set_by_name, set_at = excluded.set_at`,
    [storable(s.scope), storable(s.path), storableJson(s.value), s.by, s.name === null ? null : storable(s.name), s.at]);
}

/** Whether a row was there to delete. */
export async function deleteSetting(db: Db, scope: string, path: string): Promise<boolean> {
  const rows = await db.query('delete from visto_ai.settings where scope = $1 and path = $2 returning scope', [storable(scope), storable(path)]);
  return rows.length > 0;
}

/** The file's part, as of this start, replaced whole. */
export async function replaceFileSettings(db: Db, rows: ReadonlyArray<{ scope: string; path: string; value: unknown }>): Promise<void> {
  await db.query('delete from visto_ai.settings_file');
  for (const r of rows) {
    await db.query('insert into visto_ai.settings_file (scope, path, value) values ($1, $2, $3::jsonb)', [storable(r.scope), storable(r.path), storableJson(r.value)]);
  }
}

/** `before` / `after` undefined: not written. Returns the id of the record. */
export async function recordSettingChange(
  db: Db, c: { at: string; by: Source; name: string | null; scope: string; path: string; before: unknown; after: unknown },
): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `insert into visto_ai.setting_changes (at, by, by_name, scope, path, old_value, new_value)
     values ($1::timestamptz, $2, $3, $4, $5, $6::jsonb, $7::jsonb) returning id`,
    [c.at, c.by, c.name === null ? null : storable(c.name), storable(c.scope), storable(c.path),
      c.before === undefined ? null : storableJson(c.before), c.after === undefined ? null : storableJson(c.after)]);
  return rows[0]!.id;
}

/** The id of the newest change, 0 when there is none. */
export async function settingsVersion(db: Db): Promise<number> {
  const rows = await db.query<{ version: number }>('select coalesce(max(id), 0)::int as version from visto_ai.setting_changes');
  return rows[0]!.version;
}

/** Newest first; `before`: the id to page from (older ones only), or null. */
export function readSettingChanges(db: Db, before: number | null, limit: number): Promise<ChangeRow[]> {
  return db.query<ChangeRow>(
    `select id, at, by, by_name, scope, path, old_value::text as before, new_value::text as after
     from visto_ai.setting_changes where ($1::integer is null or id < $1::integer) order by id desc limit $2`,
    [before, limit]);
}
