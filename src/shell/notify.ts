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
    return { name: notifier.name, ok: false, code: failureCode(error) };
  }
}

/** The error's message when it is a short code other than `ok`, else notifier_failed. A value that throws when it is read is notifier_failed. */
function failureCode(error: unknown): string {
  try {
    const message: unknown = error instanceof Error ? error.message : '';
    return typeof message === 'string' && message !== 'ok' && isShortCode(message) ? message : 'notifier_failed';
  } catch {
    return 'notifier_failed';
  }
}

/** Calls every notifier once, all at the same time, each under `timeoutMs` (absent: NOTICE_TIMEOUT_MS), with its own copy of the notice and its own signal. Never rejects. One outcome for each, in their order. */
export async function sendNotice(notifiers: Notifier[], notice: ReviewNotice, timeoutMs: number = NOTICE_TIMEOUT_MS): Promise<Array<{ name: string; ok: boolean; code: string }>> {
  return Promise.all(notifiers.map((notifier) => tell(notifier, notice, timeoutMs)));
}
