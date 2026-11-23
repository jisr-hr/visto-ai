import type { Alert } from './alerts.ts';
import { isShortCode } from './codes.ts';

export interface McpHealth {
  /** How one server did in one review. */
  noted(server: string, ok: boolean, code: string): void;
}

/** One state for each server, in this process: an alert at the first failure, and one at the first success after it. */
export function createMcpHealth(alert: Alert): McpHealth {
  const failing = new Map<string, boolean>();

  function raise(code: string, details: Record<string, string>): void {
    try { alert(code, details); } catch { /* an alert that throws changes nothing */ }
  }

  return {
    noted(server, ok, code) {
      const wasFailing = failing.get(server) === true;
      failing.set(server, !ok);
      if (!ok && !wasFailing) raise('mcp_error', { server, reason: isShortCode(code) ? code : 'internal_error' });
      else if (ok && wasFailing) raise('mcp_ok', { server });
    },
  };
}
