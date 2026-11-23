import type { AlertNotice } from '../extensions/types.ts';
import { withLimit } from '../extensions/limit.ts';

/** `details` never has a key named `event`, `code` or `at`: the log entry keeps those for itself. */
export type Alert = (code: string, details?: Record<string, string | number | boolean | null>) => void;

export const ALERT_TIMEOUT_MS = 5_000;

type Log = (entry: Record<string, unknown>) => void;

export interface AlertSink { name: string; alert(notice: AlertNotice, signal: AbortSignal): Promise<void> }

/** `alert` never throws and returns at once. `settled` resolves when no post and no sink is under way.
 *  Each sink is told every alert with its own copy, under `sinkTimeoutMs` (absent: ALERT_TIMEOUT_MS); one that fails is logged and raises no alert, or it would be told of itself. */
export function createAlerts(deps: {
  webhook: string | null; fetch: typeof fetch; clock: () => Date; log: Log;
  sinks?: AlertSink[]; sinkTimeoutMs?: number;
}): { alert: Alert; settled(): Promise<void> } {
  const sinks = deps.sinks ?? [];
  const sinkTimeoutMs = deps.sinkTimeoutMs ?? ALERT_TIMEOUT_MS;
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

  async function tell(sink: AlertSink, notice: AlertNotice): Promise<void> {
    let given: AbortSignal | null = null;
    try {
      await withLimit(sinkTimeoutMs, (signal) => { given = signal; return sink.alert(structuredClone(notice), signal); });
    } catch {
      // the signal aborts only when the limit passed first
      const reason = (given as AbortSignal | null)?.aborted === true ? 'timeout' : 'threw';
      safeLog({ event: 'alert_failed', code: notice.code, extension: sink.name, reason });
    }
  }

  function track(p: Promise<void>): void {
    const tracked = p.finally(() => { pending.delete(tracked); });
    pending.add(tracked);
  }

  function alert(code: string, details: Record<string, string | number | boolean | null> = {}): void {
    safeLog({ event: 'alert', code, ...details });
    if (deps.webhook !== null) track(post(deps.webhook, code, details));
    if (sinks.length === 0) return;
    let notice: AlertNotice;
    try {
      notice = { code, at: deps.clock().toISOString(), details: structuredClone(details) };
    } catch {
      return;
    }
    for (const sink of sinks) track(tell(sink, notice));
  }

  async function settled(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending]);
  }

  return { alert, settled };
}
