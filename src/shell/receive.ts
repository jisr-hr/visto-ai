import type { RepoSettings } from '../config/load.ts';
import { hasStandingApproval } from '../db/approvals.ts';
import { recordActivity } from '../db/human-activity.ts';
import { askGate, askWithdraw, enqueueJob } from '../db/jobs.ts';
import { getPullRequest, savePullRequest } from '../db/pull-requests.ts';
import { recordDelivery } from '../db/deliveries.ts';
import type { Db } from '../db/types.ts';
import type { PullRequestRef, WebhookReader } from '../forge/types.ts';
import { gatingOf } from '../gate/gating.ts';
import { captureOf } from './capture.ts';
import { commandOf, mayCommand } from './commands.ts';
import { triggerOf } from './triggers.ts';

/** How long a thread event or a reply waits for the next one before the check is looked at. */
export const GATE_SETTLE_MS = 3_000;

export interface HttpAnswer { status: number; body: string }
export interface ReceiveDeps {
  db: Db; reader: WebhookReader; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  settingsFor: (fullName: string) => RepoSettings;   // "owner/name"
  /** Called after the commit, once per delivery that stored or replaced a review job, stored a gate job or moved a waiting one's time, or asked for a withdraw job; also when the delivery itself is recorded as ignored. */
  onQueued: () => void;
  /** In dry run no gate job and no withdraw job is stored: /done is a /review, the skip and a re-run are nothing. */
  dryRun: boolean;
  /** The service's own app id: a re-run of any other app's check is not ours. */
  appId: string;
  /** Called after the commit, once for a delivery that stored an inline comment by a person, or a pull request event whose action is `closed`; absent when learning is off. */
  onLearn?: () => void;
}

/** job: the review job; gate: a gate job was stored or took this delivery's time; withdraw: a withdraw job was asked for. */
interface Queued { job: 'queued' | 'delayed' | null; skip: string | null; command: 'review' | 'done' | 'skip' | 'rerun' | null; gate: boolean; withdraw: boolean }

const GATE_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review', 'synchronize', 'retargeted']);
/** The actions after which a standing approval may no longer hold; a close asks only when it is a merge (calls 5, 20). */
const WITHDRAW_ACTIONS = new Set(['synchronize', 'retargeted', 'reopened']);

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
    const receivedAt = deps.clock();
    const capture = captureOf(reading.event, reading.delivery, receivedAt);
    let stored: Queued | null;
    try {
      stored = await deps.db.transaction(async (tx): Promise<Queued | null> => {
        const fresh = await recordDelivery(tx, {
          id: reading.delivery, name: reading.name, action: reading.action,
          outcome: capture.outcome, reason: capture.outcome === 'ignored' ? capture.reason : null,
        });
        if (!fresh) return null;
        const queued: Queued = { job: null, skip: null, command: null, gate: false, withdraw: false };
        const nowIso = receivedAt.toISOString();
        const settingsOf = (ref: PullRequestRef) => deps.settingsFor(`${ref.owner}/${ref.repo}`);
        // The gate is live for a repository: not in dry run, and its gate enabled.
        const liveFor = (ref: PullRequestRef): boolean => !deps.dryRun && settingsOf(ref).gate.enabled;
        // For a pull request: and its base is gated; a pull request the service does not store counts as gated.
        const liveForStored = async (ref: PullRequestRef): Promise<boolean> => {
          if (!liveFor(ref)) return false;
          const known = await getPullRequest(tx, ref);
          return known === null || gatingOf(settingsOf(ref), known.baseBranch) !== 'off';
        };
        // The sync carries the installation the event came through, when it names one.
        const ask = async (ref: PullRequestRef, installation: string | null | undefined, runAt?: string): Promise<void> => {
          if (await askGate(tx, ref, nowIso, runAt, { installation: installation ?? null }) !== null) queued.gate = true;
        };
        // Out of dry run, a withdraw job due now when the pull request has a standing approval (with `review`, that one),
        // whatever the filters say (call 5). With none, one read and nothing stored.
        const withdraw = async (ref: PullRequestRef, installation: string | null, review?: string): Promise<void> => {
          if (deps.dryRun || !(await hasStandingApproval(tx, ref, review))) return;
          if (await askWithdraw(tx, ref, nowIso, installation) !== null) queued.withdraw = true;
        };
        // A thread event, and a reply, by anyone: also when capture ignores it as a bot's.
        const event = reading.event;
        if ((event.kind === 'thread' || (event.kind === 'inline_comment' && event.comment.replyTo !== null)) && await liveForStored(event.ref)) {
          await ask(event.ref, event.installation, new Date(receivedAt.getTime() + GATE_SETTLE_MS).toISOString());
        }
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
                const now = receivedAt;
                const id = await enqueueJob(tx, {
                  ref, reason: trigger.reason, headSha: trigger.headSha,
                  runAt: new Date(now.getTime() + trigger.delaySeconds * 1000).toISOString(),
                  now: now.toISOString(), delivery: reading.delivery, replace: newest,
                  trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null,
                });
                if (id !== null) queued.job = trigger.delaySeconds > 0 ? 'delayed' : 'queued';
              }
              // The event's own base decides whether its pull request is gated, whatever the trigger decided.
              const own = reading.event.facts;
              if (GATE_ACTIONS.has(reading.event.action) && liveFor(own.ref) && gatingOf(settingsOf(own.ref), own.baseBranch) !== 'off') {
                await ask(own.ref, own.installation);
              }
              // A push, a retarget, a reopening or a merge: the event's own facts, whatever the trigger decided.
              if (WITHDRAW_ACTIONS.has(reading.event.action) || (reading.event.action === 'closed' && own.state === 'merged')) {
                await withdraw(own.ref, own.installation);
              }
            }
          }
          // A dismissed review: only one of the app's own approvals that stands (call 21).
          if (reading.event.kind === 'review_dismissed') {
            await withdraw(reading.event.ref, reading.event.installation, reading.event.review);
          }
          if (capture.activity) await recordActivity(tx, capture.activity);
          const command = reading.event.kind === 'general_comment' ? commandOf(reading.event.comment.body) : null;
          if (reading.event.kind === 'general_comment' && command !== null) {
            const { ref, installation, comment } = reading.event;
            const now = nowIso;
            const manual = {
              runAt: now, now, delivery: reading.delivery, replace: mayCommand(comment.association),
              trigger: 'manual' as const, requestedBy: comment.author, commentId: comment.id, association: comment.association, installation,
            };
            const review = async (reason: string): Promise<void> => {
              if (await enqueueJob(tx, { ref, reason, headSha: '', ...manual }) !== null) queued.job = 'queued';
            };
            const gateCommand = async (reason: 'done' | 'skip', headSha: string): Promise<void> => {
              if (await enqueueJob(tx, { ref, kind: 'gate', reason, headSha, ...manual }) !== null) queued.gate = true;
            };
            if (command === 'review') {
              await review('command');
              queued.command = 'review';
              if (mayCommand(comment.association) && await liveForStored(ref)) await ask(ref, installation);
            } else if (command === 'done' && settingsOf(ref).gate.enabled) {
              if (deps.dryRun) await review('done');
              else await gateCommand('done', '');
              queued.command = 'done';
            } else if (command === 'skip' && liveFor(ref)) {
              // The head the service knew when the comment arrived (call 46); '' when it stores none.
              const known = await getPullRequest(tx, ref);
              await gateCommand('skip', known?.headSha ?? '');
              queued.command = 'skip';
            }
          }
          if (reading.event.kind === 'check_rerun') {
            const e = reading.event;
            // Only a re-run of this app's own check, under the configured name.
            if (liveFor(e.ref) && e.app === deps.appId && e.check === settingsOf(e.ref).gate.checkName) {
              const id = await enqueueJob(tx, {
                ref: e.ref, kind: 'gate', reason: 'rerun', headSha: e.headSha, runAt: nowIso, now: nowIso, delivery: reading.delivery, replace: true,
                trigger: 'manual', requestedBy: e.actor, commentId: null, association: null, installation: e.installation,
              });
              if (id !== null) queued.gate = true;
              queued.command = 'rerun';
            }
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
    const gate = stored.gate ? { gate: true } : {};
    const withdrawn = stored.withdraw ? { withdraw: true } : {};
    const wake = (): void => {
      if (stored.job === null && !stored.gate && !stored.withdraw) return;
      try {
        deps.onQueued();
      } catch {
        // a wake-up that fails changes nothing
      }
    };
    if (capture.outcome === 'ignored') {
      note(who, 'ignored', capture.reason, gate);
      wake();
      return { status: 202, body: 'ignored' };
    }
    // A comment a pass may learn from, or a close: the pass is asked for, after the commit.
    if (deps.onLearn !== undefined && (capture.activity?.kind === 'inline_comment' || (reading.event.kind === 'pull_request' && reading.event.action === 'closed'))) {
      try {
        deps.onLearn();
      } catch {
        // a wake-up that fails changes nothing
      }
    }
    if (reading.event.kind === 'pull_request') note(who, 'accepted', null, { job: stored.job, skip: stored.skip, ...gate, ...withdrawn });
    else if (stored.command !== null) note(who, 'accepted', null, { command: stored.command, job: stored.job, ...gate });
    else note(who, 'accepted', null, { ...gate, ...withdrawn });
    wake();
    return { status: 202, body: 'accepted' };
  } catch (err) {
    note(who, 'failed', 'internal_error', describe(err));
    return { status: 500, body: 'internal_error' };
  }
}
