import test from 'node:test';
import assert from 'node:assert/strict';
import { pgliteDb } from './pglite.ts';

test('a fresh database answers a query with parameters', async () => {
  const db = await pgliteDb();
  assert.deepEqual(await db.query('select $1::text as t, $2::int as n', ['a', 2]), [{ t: 'a', n: 2 }]);
  await db.close();
});
test('a transaction that rejects leaves nothing behind, one that resolves commits', async () => {
  const db = await pgliteDb();
  await db.script('create table t (n integer); create table u (n integer);');
  await assert.rejects(db.transaction(async (tx) => { await tx.query('insert into t values (1)'); throw new Error('stop'); }), /stop/);
  assert.deepEqual(await db.query('select count(*)::int as n from t'), [{ n: 0 }]);
  assert.equal(await db.transaction(async (tx) => { await tx.query('insert into t values (1)'); return 'done'; }), 'done');
  assert.deepEqual(await db.query('select count(*)::int as n from t'), [{ n: 1 }]);
  assert.deepEqual(await db.query('select count(*)::int as n from u'), [{ n: 0 }]); // the script ran both statements
  await db.close();
});
test('a transaction inside a transaction is refused', async () => {
  const db = await pgliteDb();
  await assert.rejects(db.transaction((tx) => tx.transaction(async () => 1)), /nested_transaction/);
  await db.close();
});
test('a time comes back as a Date, jsonb as an object, a cast count as a number', async () => {
  const db = await pgliteDb();
  const [row] = await db.query<{ at: unknown; j: unknown; n: unknown }>(
    "select '2026-01-02T03:04:05Z'::timestamptz as at, '{\"a\":1}'::jsonb as j, count(*)::int as n");
  assert.ok(row!.at instanceof Date);
  assert.equal((row!.at as Date).toISOString(), '2026-01-02T03:04:05.000Z');
  assert.deepEqual(row!.j, { a: 1 });
  assert.equal(row!.n, 1);
  await db.close();
});
test('two databases share nothing', async () => {
  const [a, b] = [await pgliteDb(), await pgliteDb()];
  await a.script('create table only_in_a (n integer)');
  await assert.rejects(b.query('select * from only_in_a'));
  await a.close();
  await b.close();
});
