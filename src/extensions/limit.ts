/** Runs `work` with a signal that aborts after `ms`. Rejects with Error('timeout') when `ms` pass first. A throw of `work`, also one made before it returns a promise, is the rejection. The timer holds no process open. */
export function withLimit<T>(ms: number, work: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, ms);
    timer.unref();
    let running: Promise<T>;
    try {
      running = Promise.resolve(work(controller.signal));
    } catch (error) {
      running = Promise.reject(error);
    }
    running.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
