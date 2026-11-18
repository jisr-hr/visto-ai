import { recordActivity } from '../db/human-activity.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { recordDelivery } from '../db/deliveries.ts';
import type { Db } from '../db/types.ts';
import type { WebhookReader } from '../forge/types.ts';
import { captureOf } from './capture.ts';

export interface HttpAnswer { status: number; body: string }
export interface ReceiveDeps {
  db: Db; reader: WebhookReader; clock: () => Date; log: (entry: Record<string, unknown>) => void;
}

interface Who { delivery: string | null; name: string | null; action: string | null }
const NOBODY: Who = { delivery: null, name: null, action: null };

/** The error's name and, when it is a string, its code. Never its message. */
function describe(err: unknown): { error: string; code: string | null } {
  const o = typeof err === 'object' && err !== null ? err as { name?: unknown; code?: unknown } : {};
  return {
    error: typeof o.name === 'string' ? o.name : 'unknown',
    code: typeof o.code === 'string' ? o.code : null,
  };
}

/** One webhook: read it, store what it says in one transaction with its delivery id, then answer. Never rejects. */
export async function receive(
  deps: ReceiveDeps, headers: Record<string, string | undefined>, body: Buffer,
): Promise<HttpAnswer> {
  const note = (who: Who, outcome: string, reason: string | null, extra: Record<string, unknown> = {}): void => {
    try {
      deps.log({ event: 'webhook', ...who, outcome, reason, ...extra });
    } catch {
      // a logger that fails changes nothing
    }
  };
  let who = NOBODY;
  try {
    const reading = deps.reader.read(headers, body);
    if (!reading.ok) {
      note(NOBODY, 'rejected', reading.reason);
      return reading.reason === 'bad_signature'
        ? { status: 401, body: 'invalid_signature' }
        : { status: 400, body: reading.reason };
    }
    who = { delivery: reading.delivery, name: reading.name, action: reading.action };
    const capture = captureOf(reading.event, reading.delivery, deps.clock());
    let stored: boolean;
    try {
      stored = await deps.db.transaction(async (tx) => {
        const fresh = await recordDelivery(tx, {
          id: reading.delivery, name: reading.name, action: reading.action,
          outcome: capture.outcome, reason: capture.outcome === 'ignored' ? capture.reason : null,
        });
        if (!fresh) return false;
        if (capture.outcome === 'handled') {
          if (capture.pullRequest) await savePullRequest(tx, capture.pullRequest);
          if (capture.activity) await recordActivity(tx, capture.activity);
        }
        return true;
      });
    } catch (err) {
      note(who, 'failed', 'storage_unavailable', describe(err));
      return { status: 503, body: 'storage_unavailable' };
    }
    if (!stored) {
      note(who, 'duplicate', null);
      return { status: 202, body: 'duplicate' };
    }
    if (capture.outcome === 'ignored') {
      note(who, 'ignored', capture.reason);
      return { status: 202, body: 'ignored' };
    }
    note(who, 'accepted', null);
    return { status: 202, body: 'accepted' };
  } catch (err) {
    note(who, 'failed', 'internal_error', describe(err));
    return { status: 500, body: 'internal_error' };
  }
}
