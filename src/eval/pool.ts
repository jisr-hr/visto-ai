// Runs cases a few at a time and stops starting new ones once the spend reaches the limit.
// The work function never throws; a throw from onResult (a failed write) ends the run: no new case
// starts, started cases settle, and the pool rejects with that error.
export async function runPool<C, R extends { total_cost: number }>(
  cases: C[], opts: { concurrency: number; maxCost: number }, work: (c: C) => Promise<R>, onResult: (r: R, index: number) => void,
): Promise<{ stoppedByCost: boolean; notStarted: number }> {
  let next = 0;
  let started = 0;
  let spent = 0;
  let stoppedByCost = false;
  let failure: { error: unknown } | null = null;

  async function worker(): Promise<void> {
    for (;;) {
      if (failure !== null || next >= cases.length) return;
      if (spent >= opts.maxCost) { stoppedByCost = true; return; }
      const index = next;
      next += 1;
      started += 1;
      const result = await work(cases[index]!);
      spent += result.total_cost;
      try {
        onResult(result, index);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return { stoppedByCost, notStarted: cases.length - started };
}
