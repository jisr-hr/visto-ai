import type { Alert } from './alerts.ts';

export const PAUSE_MS = 300_000;
export const KEY_CHECK_TIMEOUT_MS = 10_000;

export type KeyCheck = 'ok' | 'auth' | 'no_credit' | 'unknown';

/** Asks the model endpoint whether the key works. Never rejects. */
export async function checkModelKey(model: { baseUrl: string; apiKey: string; extraHeaders: Record<string, string> }, io: { fetch: typeof fetch }): Promise<KeyCheck> {
  const extra = Object.entries(model.extraHeaders).filter(([name]) => name.toLowerCase() !== 'authorization');
  try {
    const res = await io.fetch(`${model.baseUrl.replace(/\/+$/, '')}/key`, {
      method: 'GET',
      headers: { ...Object.fromEntries(extra), Authorization: `Bearer ${model.apiKey}` },
      signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
    });
    if (res.status === 401) return 'auth';
    if (res.status === 402) return 'no_credit';
    if (res.status !== 200) return 'unknown';
    try {
      const body: unknown = JSON.parse(await res.text());
      const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
      const left = typeof data === 'object' && data !== null ? (data as { limit_remaining?: unknown }).limit_remaining : undefined;
      return typeof left === 'number' && left <= 0 ? 'no_credit' : 'ok';
    } catch {
      return 'ok';
    }
  } catch {
    return 'unknown';
  }
}

export interface ModelHealth {
  paused(now: Date): boolean;
  /** What a key check found. */
  checked(result: KeyCheck, now: Date): void;
  /** How a review ended: `auth` or `no_credit`, or null when the model answered it. */
  reviewed(code: 'auth' | 'no_credit' | null, now: Date): void;
}

export function createModelHealth(alert: Alert, note?: (ok: boolean, code: 'auth' | 'no_credit' | null) => void): ModelHealth {
  let failure: { code: 'auth' | 'no_credit'; seenBy: 'review' | 'check' } | null = null;
  let pausedUntil = 0;
  let trusted = true;

  function tell(): void {
    try { note?.(failure === null, failure === null ? null : failure.code); } catch { /* a note that throws changes nothing */ }
  }

  function clear(): void {
    failure = null;
    pausedUntil = 0;
    alert('model_ok');
  }

  return {
    paused: (now) => now.getTime() < pausedUntil,
    checked(result, now) {
      if (result === 'auth' || result === 'no_credit') {
        if (failure === null && trusted) {
          failure = { code: result, seenBy: 'check' };
          pausedUntil = now.getTime() + PAUSE_MS;
          alert('model_error', { reason: result, seen_by: 'check' });
        }
      } else if (result === 'ok' && failure !== null && failure.seenBy === 'check') {
        clear();
      }
      if (result !== 'unknown') tell();
    },
    reviewed(code, now) {
      if (code !== null) {
        const isNew = failure === null || failure.code !== code;
        failure = { code, seenBy: 'review' };
        pausedUntil = now.getTime() + PAUSE_MS;
        if (isNew) alert('model_error', { reason: code, seen_by: 'review' });
      } else if (failure !== null) {
        if (failure.seenBy === 'check') trusted = false;
        clear();
      }
      tell();
    },
  };
}
