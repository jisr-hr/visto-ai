export interface KeyedLock { run<T>(key: string, work: () => Promise<T>): Promise<T> }

/** Runs the work of one key one at a time, in the order asked. A work that rejects does not hold the next. `keys`: how many keys it holds now. */
export function createKeyedLock(): KeyedLock & { keys(): number } {
  // One chain for each key: the end of the last work asked for it. Forgotten when nothing waits on it.
  const tails = new Map<string, Promise<void>>();
  return {
    keys: () => tails.size,
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const before = tails.get(key) ?? Promise.resolve();
      const result = before.then(() => work());
      const tail = result.then(() => undefined, () => undefined);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
  };
}
