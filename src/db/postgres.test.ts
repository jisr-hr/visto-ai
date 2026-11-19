import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INSTANCE_LOCK_KEY, POOL_OPTIONS, postgresDbFrom, takeInstanceLockOn } from './postgres.ts';
import type { ClientLike, PoolLike } from './postgres.ts';

function fakePool(options: { failOn?: string; rows?: unknown[] } = {}) {
  const clientState = { listener: null as ((e: Error) => void) | null, removed: false, removedAtRelease: [] as boolean[], releaseArgs: [] as unknown[][] };
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
      const client: ClientLike = {
        query: (text) => run(text),
        release: (...args: unknown[]) => { released[index] = true; clientState.releaseArgs.push(args); clientState.removedAtRelease.push(clientState.removed); },
        on: (_event, listener) => { clientState.listener = listener; clientState.removed = false; return client; },
        off: (_event, listener) => { if (listener === clientState.listener) clientState.removed = true; return client; },
      };
      return client;
    },
    end: async () => { state.ended = true; },
    on: (_event, listener) => { state.onError = listener; return pool; },
  };
  return { pool, statements, released, state, clientState };
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

test('a transaction listens for errors on its client, and the listener never throws or logs the message', async () => {
  const f = fakePool();
  const logs: Record<string, unknown>[] = [];
  const db = postgresDbFrom(f.pool, (entry) => logs.push(entry));
  await db.transaction(async () => {
    assert.notEqual(f.clientState.listener, null);
    assert.equal(f.clientState.removed, false);
    const error = Object.assign(new Error('do-not-log-this'), { code: '57P01' });
    f.clientState.listener!(error);
    assert.deepEqual(logs, [{ event: 'database_error', error: error.name, code: '57P01' }]);
    assert.ok(!JSON.stringify(logs).includes('do-not-log-this'));
  });
  assert.deepEqual(f.clientState.removedAtRelease, [true]);
});

test('the client error listener is removed before release when the work rejects', async () => {
  const f = fakePool();
  const db = postgresDbFrom(f.pool, () => {});
  await assert.rejects(() => db.transaction(async () => { throw new Error('x'); }));
  assert.notEqual(f.clientState.listener, null);
  assert.deepEqual(f.clientState.removedAtRelease, [true]);
});

test('a client whose rollback rejects is destroyed, and the caller gets the work error', async () => {
  const f = fakePool({ failOn: 'rollback' });
  const db = postgresDbFrom(f.pool, () => {});
  const error = new Error('work failed');
  await assert.rejects(() => db.transaction(async () => { throw error; }), (e) => e === error);
  assert.deepEqual(f.clientState.releaseArgs, [[true]]);
});

test('a client with a normal rollback is released once, without destroying it', async () => {
  const f = fakePool();
  const db = postgresDbFrom(f.pool, () => {});
  await assert.rejects(() => db.transaction(async () => { throw new Error('x'); }));
  assert.equal(f.clientState.releaseArgs.length, 1);
  assert.ok(f.clientState.releaseArgs[0]!.length === 0 || f.clientState.releaseArgs[0]![0] === undefined);
});
test('the pool bounds a statement and keeps its connections alive', () => {
  assert.deepEqual(POOL_OPTIONS, { max: 5, connectionTimeoutMillis: 5000, statement_timeout: 15000, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
});

function fakeClient(held: boolean | Error) {
  const listeners: Record<'error' | 'end', Array<(e?: Error) => void>> = { error: [], end: [] };
  const calls: string[] = [];
  const emit = (event: 'error' | 'end'): void => { for (const l of listeners[event]) l(event === 'error' ? new Error('gone') : undefined); };
  return {
    calls, emit,
    connect: async (): Promise<void> => { calls.push('connect'); },
    query: async (text: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
      calls.push(`${text} ${JSON.stringify(params)}`);
      if (held instanceof Error) throw held;
      return { rows: [{ held }] };
    },
    // Like the real client: closing it emits `end`.
    end: async (): Promise<void> => { calls.push('end'); emit('end'); },
    on: (event: 'error' | 'end', listener: (e?: Error) => void): void => { listeners[event].push(listener); },
  };
}

test('the lock is taken with one statement on its own connection', async () => {
  const client = fakeClient(true);
  assert.notEqual(await takeInstanceLockOn(client, () => {}), null);
  assert.deepEqual(client.calls, ['connect', `select pg_try_advisory_lock($1) as held [${INSTANCE_LOCK_KEY}]`]);
});
test('when another instance holds the lock the answer is null, the connection is closed, and that is not a loss', async () => {
  const client = fakeClient(false);
  let lost = 0;
  assert.equal(await takeInstanceLockOn(client, () => { lost += 1; }), null);
  assert.deepEqual([client.calls.at(-1), lost], ['end', 0]);
});
test('a statement that fails rejects, the connection is closed, and that is not a loss', async () => {
  const client = fakeClient(new Error('boom'));
  let lost = 0;
  await assert.rejects(takeInstanceLockOn(client, () => { lost += 1; }), /boom/);
  assert.deepEqual([client.calls.at(-1), lost], ['end', 0]);
});
test('losing the connection after the lock was taken calls onLost once', async () => {
  const client = fakeClient(true);
  let lost = 0;
  await takeInstanceLockOn(client, () => { lost += 1; });
  client.emit('error');
  client.emit('end');
  assert.equal(lost, 1);
});
test('release closes the connection and is not a loss', async () => {
  const client = fakeClient(true);
  let lost = 0;
  const lock = await takeInstanceLockOn(client, () => { lost += 1; });
  await lock!.release();
  assert.deepEqual([client.calls.at(-1), lost], ['end', 0]);
});
