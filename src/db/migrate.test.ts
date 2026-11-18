import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMigrations, migrate } from './migrate.ts';
import { pgliteDb } from './pglite.ts';
import { testDb } from './testing.ts';

const one = { name: '0001_a', sql: 'create table visto_ai.a (n integer);' };
const two = { name: '0002_b', sql: 'create table visto_ai.b (n integer); insert into visto_ai.b values (1);' };

test('migrations apply in name order, once each', async () => {
  const db = await pgliteDb();
  assert.deepEqual(await migrate(db, [two, one]), ['0001_a', '0002_b']);
  assert.deepEqual(await migrate(db, [two, one]), []);
  assert.deepEqual(await db.query('select name from visto_ai.schema_migrations order by name'), [{ name: '0001_a' }, { name: '0002_b' }]);
  await db.close();
});
test('a migration that fails leaves nothing behind', async () => {
  const db = await pgliteDb();
  await migrate(db, []);
  const bad = { name: '0003_c', sql: 'create table visto_ai.c (n integer); select nope();' };
  await assert.rejects(migrate(db, [bad]));
  assert.deepEqual(await db.query("select to_regclass('visto_ai.c')::text as c"), [{ c: null }]);
  assert.deepEqual(await db.query("select name from visto_ai.schema_migrations where name = '0003_c'"), []);
  await db.close();
});
test('a database ahead of the code is refused', async () => {
  const db = await pgliteDb();
  await migrate(db, [one]);
  await assert.rejects(migrate(db, [two]), /unknown_migration_applied/);
  await db.close();
});
test('migrating nothing creates the schema and its ledger', async () => {
  const db = await pgliteDb();
  await migrate(db, []);
  assert.deepEqual(await db.query('select count(*)::int as n from visto_ai.schema_migrations'), [{ n: 0 }]);
  assert.deepEqual(
    await db.query("select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'visto_ai' and table_name = 'schema_migrations' order by column_name"),
    [
      { column_name: 'applied_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'name', data_type: 'text', is_nullable: 'NO' },
    ]);
  assert.deepEqual(await db.query("select count(*)::int as n from pg_constraint where conrelid = 'visto_ai.schema_migrations'::regclass and contype = 'p'"), [{ n: 1 }]);
  await db.close();
});
test('loadMigrations reads the .sql files in name order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'visto-migrations-'));
  try {
    writeFileSync(join(dir, '0002_b.sql'), 'select 2;');
    writeFileSync(join(dir, '0001_a.sql'), 'select 1;');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, '.gitkeep'), '');
    assert.deepEqual(loadMigrations(dir), [{ name: '0001_a', sql: 'select 1;' }, { name: '0002_b', sql: 'select 2;' }]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test('testDb resolves with the ledger in place', async () => {
  const db = await testDb();
  assert.deepEqual(await db.query('select name from visto_ai.schema_migrations'), [{ name: '0001_receiving' }]);
  await db.close();
});
