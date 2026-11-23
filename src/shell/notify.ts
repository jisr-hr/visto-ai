import type { ReviewNotice } from '../extensions/types.ts';
import { withLimit } from '../extensions/limit.ts';
import { isShortCode } from './codes.ts';

export const NOTICE_TIMEOUT_MS = 10_000;

export interface Notifier { name: string; notify(notice: ReviewNotice, signal: AbortSignal): Promise<void> }

async function tell(notifier: Notifier, notice: ReviewNotice, timeoutMs: number): Promise<{ name: string; ok: boolean; code: string }> {
  let given: AbortSignal | null = null;
  try {
    const copy = structuredClone(notice);
    await withLimit(timeoutMs, (signal) => { given = signal; return notifier.notify(copy, signal); });
    return { name: notifier.name, ok: true, code: 'ok' };
  } catch (error) {
    // the signal aborts only when the limit passed first
    if ((given as AbortSignal | null)?.aborted === true) return { name: notifier.name, ok: false, code: 'timeout' };
    const message = error instanceof Error ? error.message : '';
    return { name: notifier.name, ok: false, code: isShortCode(message) ? message : 'notifier_failed' };
  }
}

/** Calls every notifier once, all at the same time, each under `timeoutMs` (absent: NOTICE_TIMEOUT_MS), with its own copy of the notice and its own signal. Never rejects. One outcome for each, in their order. */
export async function sendNotice(notifiers: Notifier[], notice: ReviewNotice, timeoutMs: number = NOTICE_TIMEOUT_MS): Promise<Array<{ name: string; ok: boolean; code: string }>> {
  return Promise.all(notifiers.map((notifier) => tell(notifier, notice, timeoutMs)));
}
