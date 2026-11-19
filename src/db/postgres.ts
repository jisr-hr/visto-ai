import pg from 'pg';
import type { Db } from './types.ts';

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
