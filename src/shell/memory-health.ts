import type { Alert } from './alerts.ts';
import { isShortCode } from './codes.ts';

export interface MemoryHealth {
  /** How memory did in one review. */
  noted(ok: boolean, code: string): void;
}

/** One state, in this process: an alert at the first failure, and one at the first success after it. */
export function createMemoryHealth(alert: Alert): MemoryHealth {
  let failing = false;

  function raise(code: string, details?: Record<string, string>): void {
    try {
      const out: unknown = alert(code, details);
      // An alert that returns a rejected promise changes nothing either.
      if (typeof out === 'object' && out !== null) Promise.resolve(out).catch(() => {});
    } catch { /* an alert that throws changes nothing */ }
  }

  return {
    noted(ok, code) {
      const wasFailing = failing;
      failing = !ok;
      if (!ok && !wasFailing) raise('memory_error', { reason: typeof code === 'string' && isShortCode(code) ? code : 'internal_error' });
      else if (ok && wasFailing) raise('memory_ok');
    },
  };
}
