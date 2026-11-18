export interface Control { stopped: boolean; error: unknown; failed: boolean }

export async function inPool<T>(count: number, width: number, ctl: Control, work: (index: number) => Promise<T>): Promise<Array<T | undefined>> {
  const results: Array<T | undefined> = new Array<T | undefined>(count).fill(undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count && !ctl.stopped) {
      const index = next;
      next += 1;
      results[index] = await work(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, count) }, worker));
  return results;
}
