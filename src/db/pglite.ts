import { PGlite } from '@electric-sql/pglite';
import type { Db } from './types.ts';

type Runner = Pick<PGlite, 'query' | 'exec'>;

function over(runner: Runner, rest: Pick<Db, 'transaction' | 'close'>): Db {
  return {
    query: async <Row>(text: string, params?: unknown[]) => (await runner.query<Row>(text, params)).rows,
    script: async (sql) => { await runner.exec(sql); },
    ...rest,
  };
}

export async function pgliteDb(): Promise<Db> {
  const pg = await PGlite.create();
  return over(pg, {
    transaction: (work) => pg.transaction((tx) => work(over(tx, {
      transaction: () => Promise.reject(new Error('nested_transaction')),
      close: () => Promise.resolve(),
    }))),
    close: () => pg.close(),
  });
}
