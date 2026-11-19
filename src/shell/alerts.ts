/** `details` never has a key named `event`, `code` or `at`: the log entry keeps those for itself. */
export type Alert = (code: string, details?: Record<string, string | number | boolean | null>) => void;

export const ALERT_TIMEOUT_MS = 5_000;

type Log = (entry: Record<string, unknown>) => void;

/** `alert` never throws and returns at once. `settled` resolves when no post is under way. */
export function createAlerts(deps: { webhook: string | null; fetch: typeof fetch; clock: () => Date; log: Log }): { alert: Alert; settled(): Promise<void> } {
  const pending = new Set<Promise<void>>();

  function safeLog(entry: Record<string, unknown>): void {
    try { deps.log(entry); } catch { /* a logger that throws stops nothing */ }
  }

  async function post(webhook: string, code: string, details: Record<string, string | number | boolean | null>): Promise<void> {
    let status: number | null = null;
    try {
      const res = await deps.fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'visto-ai', code, at: deps.clock().toISOString(), details }),
        redirect: 'manual',
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      });
      status = res.status;
      if (res.status >= 200 && res.status <= 299) return;
    } catch {
      status = null;
    }
    safeLog({ event: 'alert_failed', code, status });
  }

  function alert(code: string, details: Record<string, string | number | boolean | null> = {}): void {
    safeLog({ event: 'alert', code, ...details });
    if (deps.webhook === null) return;
    const p = post(deps.webhook, code, details).finally(() => { pending.delete(p); });
    pending.add(p);
  }

  async function settled(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending]);
  }

  return { alert, settled };
}
