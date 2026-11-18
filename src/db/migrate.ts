import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './types.ts';

export interface Migration { name: string; sql: string }

export const MIGRATIONS_DIR: string = join(import.meta.dirname, 'migrations');

export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => ({ name: file.slice(0, -'.sql'.length), sql: readFileSync(join(dir, file), 'utf8') }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Applies what is not yet applied, in name order. Returns the names applied now. */
export async function migrate(db: Db, migrations: Migration[]): Promise<string[]> {
  await db.script(
    `create schema if not exists visto_ai;
     create table if not exists visto_ai.schema_migrations (name text primary key, applied_at timestamptz not null default now());`);
  const known = new Set(migrations.map((m) => m.name));
  const done = new Set((await db.query<{ name: string }>('select name from visto_ai.schema_migrations')).map((r) => r.name));
  for (const name of done) {
    if (!known.has(name)) throw new Error(`unknown_migration_applied: ${name}`);
  }
  const applied: string[] = [];
  for (const m of [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (done.has(m.name)) continue;
    await db.transaction(async (tx) => {
      await tx.script(m.sql);
      await tx.query('insert into visto_ai.schema_migrations (name) values ($1)', [m.name]);
    });
    applied.push(m.name);
  }
  return applied;
}
