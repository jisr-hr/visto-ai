import pg from 'pg';
import type { Db } from './types.ts';

export interface ClientLike { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>; release(): void }
export interface PoolLike extends Pick<ClientLike, 'query'> {
  connect(): Promise<ClientLike>; end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
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
  pool.on('error', (error) => {
    const code = (error as { code?: unknown }).code;
    log({ event: 'database_error', error: error.name, code: typeof code === 'string' ? code : null });
  });
  return over(pool, {
    transaction: async (work) => {
      const client = await pool.connect();
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
          // the original failure is the one to report
        }
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  });
}

export function postgresDb(url: string, log: Log): Db {
  return postgresDbFrom(new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000 }), log);
}
