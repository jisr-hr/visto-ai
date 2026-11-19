export interface Db {
  /** One statement with numbered parameters ($1, $2, ...). Returns its rows. */
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<Row[]>;
  /** A script of several statements, without parameters. For migrations. */
  script(sql: string): Promise<void>;
  /** Runs `work` in one transaction: committed when it resolves, rolled back when it rejects. Calling it on `tx` rejects with Error('nested_transaction'). */
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface InstanceLock { release(): Promise<void> }
