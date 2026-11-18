import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postgresDbFrom } from './postgres.ts';
import type { ClientLike, PoolLike } from './postgres.ts';

function fakePool(options: { failOn?: string; rows?: unknown[] } = {}) {
  const statements: string[] = [];
  const released: boolean[] = [];
  const state = { ended: false, onError: null as ((e: Error) => void) | null, clients: 0 };
  const run = async (text: string): Promise<{ rows: unknown[] }> => {
    statements.push(text);
    if (text === options.failOn) throw new Error('boom');
    return { rows: options.rows ?? [] };
  };
  const pool: PoolLike = {
    query: (text) => run(text),
    connect: async () => {
      const index = released.length;
      released.push(false);
      state.clients += 1;
      const client: ClientLike = { query: (text) => run(text), release: () => { released[index] = true; } };
      return client;
    },
    end: async () => { state.ended = true; },
    on: (_event, listener) => { state.onError = listener; return pool; },
  };
  return { pool, statements, released, state };
}

test('query returns the rows of the pool', async () => {
  const f = fakePool({ rows: [{ a: 1 }] });
  const db = postgresDbFrom(f.pool, () => {});
  assert.deepEqual(await db.query('select 1'), [{ a: 1 }]);
});

test('a transaction runs on one client between begin and commit and releases it', async () => {
  const f = fakePool();
  const db = postgresDbFrom(f.pool, () => {});
  const result = await db.transaction(async (tx) => { await tx.query('select 1'); return 'done'; });
  assert.equal(result, 'done');
  assert.deepEqual(f.statements, ['begin', 'select 1', 'commit']);
  assert.deepEqual(f.released, [true]);
  assert.equal(f.state.clients, 1);
});

test('a transaction whose work rejects rolls back, releases the client and rejects with the same error', async () => {
  const f = fakePool();
  const db = postgresDbFrom(f.pool, () => {});
  const error = new Error('work failed');
  await assert.rejects(() => db.transaction(async () => { throw error; }), (e) => e === error);
  assert.deepEqual(f.statements, ['begin', 'rollback']);
  assert.deepEqual(f.released, [true]);
});

test('when commit rejects the client is still released and the rejection reaches the caller', async () => {
  const f = fakePool({ failOn: 'commit' });
  const db = postgresDbFrom(f.pool, () => {});
  await assert.rejects(() => db.transaction(async () => 1), { message: 'boom' });
  assert.deepEqual(f.released, [true]);
});

test('a nested transaction is refused', async () => {
  const f = fakePool();
  const db = postgresDbFrom(f.pool, () => {});
  await assert.rejects(() => db.transaction((tx) => tx.transaction(async () => 1)), { message: 'nested_transaction' });
  assert.deepEqual(f.released, [true]);
});

test('close ends the pool', async () => {
  const f = fakePool();
  await postgresDbFrom(f.pool, () => {}).close();
  assert.equal(f.state.ended, true);
});

test('an idle client error is logged by name and code only and does not throw', () => {
  const f = fakePool();
  const entries: Record<string, unknown>[] = [];
  postgresDbFrom(f.pool, (entry) => entries.push(entry));
  assert.notEqual(f.state.onError, null);
  const error = Object.assign(new Error('do-not-log-this'), { code: '57P01' });
  f.state.onError!(error);
  assert.deepEqual(entries, [{ event: 'database_error', error: error.name, code: '57P01' }]);
});
