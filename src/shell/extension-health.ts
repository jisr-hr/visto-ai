import type { Alert } from './alerts.ts';
import { isShortCode } from './codes.ts';

export interface ExtensionHealth {
  /** How one part of one module just did. */
  noted(extension: string, part: 'context' | 'notify' | 'route', ok: boolean, code: string): void;
}

/** One state for each module and part, in this process: an alert at the first failure, and one at the first success after it. */
export function createExtensionHealth(alert: Alert): ExtensionHealth {
  const failing = new Map<string, boolean>();

  function raise(code: string, details: Record<string, string>): void {
    try { alert(code, details); } catch { /* an alert that throws changes nothing */ }
  }

  return {
    noted(extension, part, ok, code) {
      const key = JSON.stringify([extension, part]);
      const wasFailing = failing.get(key) === true;
      failing.set(key, !ok);
      if (!ok && !wasFailing) raise('extension_error', { extension, part, reason: isShortCode(code) ? code : 'internal_error' });
      else if (ok && wasFailing) raise('extension_ok', { extension, part });
    },
  };
}
