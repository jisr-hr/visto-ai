import { loadMigrations, MIGRATIONS_DIR, migrate } from './migrate.ts';
import { pgliteDb } from './pglite.ts';
import type { Db } from './types.ts';

export async function testDb(): Promise<Db> {
  const db = await pgliteDb();
  await migrate(db, loadMigrations(MIGRATIONS_DIR));
  return db;
}
