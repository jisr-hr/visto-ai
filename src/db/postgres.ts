import pg from 'pg';
import type { Db, InstanceLock } from './types.ts';

export interface ClientLike { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>; release(destroy?: boolean): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
}
export interface PoolLike extends Pick<ClientLike, 'query'> {
  connect(): Promise<ClientLike>; end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
export const POOL_OPTIONS = {
  max: 5, connectionTimeoutMillis: 5000, statement_timeout: 15000, keepAlive: true, keepAliveInitialDelayMillis: 10000,
} as const;
type Log = (entry: Record<string, unknown>) => void;

function over(runner: Pick<ClientLike, 'query'>, rest: Pick<Db, 'transaction' | 'close'>): Db {
  return {
    query: async <Row>(text: string, params?: unknown[]) => (await runner.query(text, params)).rows as Row[],
    script: async (sql) => { await runner.query(sql); },
    ...rest,
  };
}

/** The Db over a pool. A client taken for a transaction is always released. */
export function postgresDbFrom(pool: PoolLike, log: Log): Db {
  // An idle client that loses its connection emits `error` on the pool; with no listener that ends the process.
  const onError = (error: Error): void => {
    try {
      const code = (error as { code?: unknown }).code;
      log({ event: 'database_error', error: error.name, code: typeof code === 'string' ? code : null });
    } catch {
      // a logger that fails must not end the process
    }
  };
  pool.on('error', onError);
  return over(pool, {
    transaction: async (work) => {
      const client = await pool.connect();
      // The pool drops its own listener while a client is checked out; an unhandled `error` would end the process.
      client.on('error', onError);
      let destroy = false;
      try {
        await client.query('begin');
        const tx = over(client, {
          transaction: () => Promise.reject(new Error('nested_transaction')),
          close: () => Promise.resolve(),
        });
        const result = await work(tx);
        await client.query('commit');
        return result;
      } catch (error) {
        try {
          await client.query('rollback');
        } catch {
          // the original failure is the one to report; this client may hold an open transaction
          destroy = true;
        }
        throw error;
      } finally {
        client.off('error', onError);
        client.release(destroy ? true : undefined);
      }
    },
    close: () => pool.end(),
  });
}

export function postgresDb(url: string, log: Log): Db {
  return postgresDbFrom(new pg.Pool({ connectionString: url, ...POOL_OPTIONS }), log);
}

export interface LockClientLike {
  connect(): Promise<unknown>;
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
  on(event: 'error' | 'end', listener: (error?: Error) => void): unknown;
}
export const INSTANCE_LOCK_KEY = 5684201;

/**
 * Takes the deployment's lock on `client`, which it connects and owns. null, with the client closed, when another
 * instance holds it. `onLost` is called once, and only when the connection ends or fails after the lock was taken
 * and before `release` was called.
 */
export async function takeInstanceLockOn(client: LockClientLike, onLost: () => void): Promise<InstanceLock | null> {
  let taken = false;
  let released = false;
  let lost = false;
  // A real client emits `end` after its own `end()`, so only a close between "taken" and "released" is a loss.
  const onClose = (): void => {
    if (!taken || released || lost) return;
    lost = true;
    onLost();
  };
  client.on('error', onClose);
  client.on('end', onClose);
  try {
    await client.connect();
    const rows = (await client.query('select pg_try_advisory_lock($1) as held', [INSTANCE_LOCK_KEY])).rows as Array<{ held: boolean }>;
    if (rows[0]?.held !== true) {
      await client.end();
      return null;
    }
  } catch (error) {
    try {
      await client.end();
    } catch {
      // the original failure is the one to report
    }
    throw error;
  }
  taken = true;
  return {
    release: async () => {
      released = true;
      await client.end();
    },
  };
}

/** The same over a connection of its own to `url`. */
export function takeInstanceLock(url: string, onLost: () => void): Promise<InstanceLock | null> {
  return takeInstanceLockOn(
    new pg.Client({ connectionString: url, keepAlive: true, keepAliveInitialDelayMillis: 10_000, connectionTimeoutMillis: 5000 }),
    onLost,
  );
}
