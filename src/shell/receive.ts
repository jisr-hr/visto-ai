import type { RepoSettings } from '../config/load.ts';
import { recordActivity } from '../db/human-activity.ts';
import { enqueueJob } from '../db/jobs.ts';
import { getPullRequest, savePullRequest } from '../db/pull-requests.ts';
import { recordDelivery } from '../db/deliveries.ts';
import type { Db } from '../db/types.ts';
import type { WebhookReader } from '../forge/types.ts';
import { captureOf } from './capture.ts';
import { commandOf } from './commands.ts';
import { triggerOf } from './triggers.ts';

export interface HttpAnswer { status: number; body: string }
export interface ReceiveDeps {
  db: Db; reader: WebhookReader; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  settingsFor: (fullName: string) => RepoSettings;   // "owner/name"
  onQueued: () => void;                              // called after the commit, once per delivery that stored or replaced a job
}

interface Queued { job: 'queued' | 'delayed' | null; skip: string | null; command: 'review' | null }

/** Associations that may replace a pending job with a command. */
const HAS_ACCESS = new Set<string>(['owner', 'member', 'collaborator']);

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
    let stored: Queued | null;
    try {
      stored = await deps.db.transaction(async (tx): Promise<Queued | null> => {
        const fresh = await recordDelivery(tx, {
          id: reading.delivery, name: reading.name, action: reading.action,
          outcome: capture.outcome, reason: capture.outcome === 'ignored' ? capture.reason : null,
        });
        if (!fresh) return null;
        const queued: Queued = { job: null, skip: null, command: null };
        if (capture.outcome === 'handled') {
          if (capture.pullRequest) {
            const newest = await savePullRequest(tx, capture.pullRequest);
            if (reading.event.kind === 'pull_request') {
              // An older event judges the stored facts and only fills a gap; the newest replaces the pending job.
              const current = newest ? capture.pullRequest : await getPullRequest(tx, capture.pullRequest.ref) ?? capture.pullRequest;
              const ref = current.ref;
              const trigger = triggerOf(reading.event.action, current, deps.settingsFor(`${ref.owner}/${ref.repo}`));
              if (trigger.kind === 'skip') queued.skip = trigger.reason;
              if (trigger.kind === 'queue') {
                const now = deps.clock();
                const id = await enqueueJob(tx, {
                  ref, reason: trigger.reason, headSha: trigger.headSha,
                  runAt: new Date(now.getTime() + trigger.delaySeconds * 1000).toISOString(),
                  now: now.toISOString(), delivery: reading.delivery, replace: newest,
                  trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null,
                });
                if (id !== null) queued.job = trigger.delaySeconds > 0 ? 'delayed' : 'queued';
              }
            }
          }
          if (capture.activity) await recordActivity(tx, capture.activity);
          if (reading.event.kind === 'general_comment' && commandOf(reading.event.comment.body) === 'review') {
            const { ref, installation, comment } = reading.event;
            const now = deps.clock().toISOString();
            const id = await enqueueJob(tx, {
              ref, reason: 'command', headSha: '', runAt: now, now, delivery: reading.delivery,
              replace: HAS_ACCESS.has(comment.association),
              trigger: 'manual', requestedBy: comment.author, commentId: comment.id, association: comment.association, installation,
            });
            queued.command = 'review';
            if (id !== null) queued.job = 'queued';
          }
        }
        return queued;
      });
    } catch (err) {
      note(who, 'failed', 'storage_unavailable', describe(err));
      return { status: 503, body: 'storage_unavailable' };
    }
    if (stored === null) {
      note(who, 'duplicate', null);
      return { status: 202, body: 'duplicate' };
    }
    if (capture.outcome === 'ignored') {
      note(who, 'ignored', capture.reason);
      return { status: 202, body: 'ignored' };
    }
    if (reading.event.kind === 'pull_request') {
      note(who, 'accepted', null, { job: stored.job, skip: stored.skip });
      if (stored.job !== null) {
        try {
          deps.onQueued();
        } catch {
          // a wake-up that fails changes nothing
        }
      }
    } else if (stored.command !== null) {
      note(who, 'accepted', null, { command: stored.command, job: stored.job });
      if (stored.job !== null) {
        try {
          deps.onQueued();
        } catch {
          // a wake-up that fails changes nothing
        }
      }
    } else {
      note(who, 'accepted', null);
    }
    return { status: 202, body: 'accepted' };
  } catch (err) {
    note(who, 'failed', 'internal_error', describe(err));
    return { status: 500, body: 'internal_error' };
  }
}
