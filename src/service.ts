import { loadMigrations, MIGRATIONS_DIR, migrate } from './db/migrate.ts';
import { beat, readHeartbeat } from './db/heartbeat.ts';
import { deleteFinishedJobs } from './db/jobs.ts';
import type { Db, InstanceLock } from './db/types.ts';
import { repoSettingsFor } from './config/load.ts';
import type { ServiceConfig } from './config/load.ts';
import type { ReviewDeps, ReviewInput, ReviewResult } from './engine/types.ts';
import type { AppIdentity, ForgeAccess, ForgeWriter, HookDeliveries, Source, WebhookReader } from './forge/types.ts';
import { ALERT_TIMEOUT_MS, createAlerts } from './shell/alerts.ts';
import { isShortCode } from './shell/codes.ts';
import { dryWriter } from './shell/dry-writer.ts';
import { createListener } from './shell/http.ts';
import type { RequestLike, ResponseLike } from './shell/http.ts';
import { checkModelKey, createModelHealth } from './shell/model-health.ts';
import type { KeyCheck } from './shell/model-health.ts';
import { receive } from './shell/receive.ts';
import { recoverJobs } from './shell/recovery.ts';
import { runRedelivery } from './shell/redelivery.ts';
import { runReviewJob } from './shell/review-job.ts';
import type { ReviewJobDeps } from './shell/review-job.ts';
import { createRunner } from './shell/runner.ts';
import { createSpendGuard } from './shell/spend.ts';

export interface Listening { close(): Promise<void> }
export interface ServiceDeps {
  db: Db; reader: WebhookReader; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  listen: (listener: (req: RequestLike, res: ResponseLike) => void, port: number) => Promise<Listening>;
  /** null when another instance holds the lock. */
  takeLock: () => Promise<InstanceLock | null>;
  forge: ForgeAccess; hooks: HookDeliveries;
  /** What writes to the git service. In dry run the review job is given a writer that refuses every call instead. */
  writer: ForgeWriter;
  /** What the app is allowed to do; asked once at start. */
  appInfo: AppIdentity;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** A repeating timer. Returns its cancel. `work` never rejects; what it returns is there for a test to wait on. */
  every: (ms: number, work: () => Promise<void>) => () => void;
  engineDeps: (source: Source) => ReviewDeps;
  review: (input: ReviewInput, deps: ReviewDeps) => Promise<ReviewResult>;
  lineUrl: ReviewJobDeps['lineUrl'];
  commentUrl: ReviewJobDeps['commentUrl'];
}
export const STOP_WAIT_MS = 10_000;
export const CLOSE_WAIT_MS = 5_000;
export const TICK_MS = 5_000;
export const BEAT_MS = 60_000;
export const UPKEEP_MS = 300_000;
export const DRAIN_WAIT_MS = 600_000;
export const LOOKBACK_MARGIN_MS = 120_000;
export const JOB_KEEP_MS = 14 * 86_400_000;

/** The error's name and, when it is a string, its code. Never its message. */
function why(error: unknown): { error: string; code: string | null } {
  const o = typeof error === 'object' && error !== null ? error as { name?: unknown; code?: unknown } : {};
  return { error: typeof o.name === 'string' ? o.name : 'unknown', code: typeof o.code === 'string' ? o.code : null };
}

/** The error's message when it is a short code, else null. */
function reasonOf(error: unknown): string | null {
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  return typeof message === 'string' && isShortCode(message) ? message : null;
}

/** 'done' when `work` settles first, 'timeout' when `ms` pass first. Rejects when `work` does. */
async function within(ms: number, work: Promise<unknown>): Promise<'done' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const patience = new Promise<'timeout'>((done) => { timer = setTimeout(() => { done('timeout'); }, ms); });
  try {
    return await Promise.race([work.then(() => 'done' as const), patience]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Takes the lock, migrates, recovers, then listens; the work that follows listening is not waited for.
 * `settled` resolves when the work that follows listening has had its first try: the key check, the app check, the redelivery attempt and, when that worked, the first beat.
 * `stop` drains the runner (at most DRAIN_WAIT_MS), closes the listener and waits for requests in flight (at most STOP_WAIT_MS),
 * beats once more, waits for alerts, closes the database and releases the lock. It never rejects.
 */
export async function startService(config: ServiceConfig, deps: ServiceDeps): Promise<{ stop(): Promise<void>; settled: Promise<void> }> {
  const { db, clock } = deps;
  // A logger that throws must change nothing.
  function say(entry: Record<string, unknown>): void {
    try {
      deps.log(entry);
    } catch {
      // nothing to do
    }
  }
  const settingsFor = (name: string) => repoSettingsFor(config, name);
  const { alert, settled: alertsSettled } = createAlerts({ webhook: config.alerts?.webhook ?? null, fetch: deps.fetch, clock, log: say });
  const health = createModelHealth(alert);
  const spend = createSpendGuard({ db, limit: config.limits.spendPerDay, clock, alert });
  const reviewDeps: ReviewJobDeps = {
    db, forge: deps.forge, clock, log: say, sleep: deps.sleep, settingsFor,
    limits: {
      inputTokensPerCall: config.limits.inputTokensPerCall, batchesPerReview: config.limits.batchesPerReview,
      modelTimeoutSeconds: config.model.timeoutSeconds,
    },
    dryRun: config.dryRun, writer: config.dryRun ? dryWriter() : deps.writer, engineDeps: deps.engineDeps, review: deps.review, lineUrl: deps.lineUrl, health, spend,
    commentUrl: deps.commentUrl, canResolve: () => deps.appInfo.canResolve(),
  };
  const runner = createRunner({
    db, kind: 'review', concurrency: config.limits.queueConcurrency, clock, log: say,
    mayStart: async () => !health.paused(clock()) && (await spend.level()) !== 'limit',
    run: (job) => runReviewJob(job, reviewDeps),
  });
  const { listener, idle } = createListener({
    webhook: (headers, body) => receive({ db, reader: deps.reader, clock, log: say, settingsFor, onQueued: () => { void runner.tick(); } }, headers, body),
  });

  // 1 to 4: the lock, the migrations, the recovery, the listener.
  let lock: InstanceLock | null;
  try {
    lock = await deps.takeLock();
  } catch (error) {
    await closeQuietly();
    throw error;
  }
  if (lock === null) {
    await closeQuietly();
    throw new Error('another_instance_running');
  }
  const held = lock;
  let listening: Listening;
  try {
    await migrate(db, loadMigrations(MIGRATIONS_DIR));
    await recoverJobs(db, clock(), say);
    listening = await deps.listen(listener, config.server.port);
  } catch (error) {
    try {
      await held.release();
    } catch {
      // the start failure is the one to report
    }
    await closeQuietly();
    throw error;
  }
  async function closeQuietly(): Promise<void> {
    try {
      await db.close();
    } catch {
      // the start failure is the one to report
    }
  }

  // 5 to 8: what follows listening.
  let stopping: Promise<void> | null = null;
  let ending = false;                      // stop has begun
  const cancels: Array<() => void> = [];
  function every(ms: number, work: () => Promise<void>): void {
    if (!ending) cancels.push(deps.every(ms, work));
  }
  async function guarded(event: string, step: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      say({ event, step, ...why(error), ...(event === 'start_step_failed' ? { reason: reasonOf(error) } : {}) });
    }
  }

  let lastCheck: KeyCheck | null = null;
  async function keyCheck(): Promise<void> {
    if (ending) return;
    const result = await checkModelKey(config.model, { fetch: deps.fetch });
    if (ending) return;
    health.checked(result, clock());
    if (result !== lastCheck) say({ event: 'model_check', result });
    lastCheck = result;
  }

  async function appCheck(): Promise<void> {
    if (ending) return;
    const lacking = await deps.appInfo.lacks(config.dryRun);
    if (ending) return;
    if (lacking.length === 0) say({ event: 'app_check', missing: 0 });
    for (const { feature, missing } of lacking) {
      say({ event: 'feature_off', feature, missing });
      alert('feature_off', { feature, missing });
    }
  }

  let since: string | null | undefined;    // undefined until the heartbeat has been read; null on a first start
  let through = false;                     // an attempt of the redelivery got through
  let alerted = false;
  let beating = false;
  let redelivering = false;                // an attempt of the redelivery is under way
  /** True when the attempt got through the deliveries. */
  async function redeliver(): Promise<boolean> {
    if (since === undefined) {
      const last = await readHeartbeat(db);
      since = last === null ? null : new Date(Date.parse(last) - LOOKBACK_MARGIN_MS).toISOString();
    }
    if (since === null) return true;
    if (ending) return false;
    const result = await runRedelivery({ hooks: deps.hooks, sleep: deps.sleep, log: say }, since);
    if (ending) return false;
    if (!alerted && (result.code !== null || result.failed > 0 || !result.complete)) {
      alerted = true;
      alert('redelivery_failed', { reason: result.code ?? 'partial', failed: result.failed, complete: result.complete });
    }
    return result.code === null;
  }
  async function beatOnce(event: string): Promise<void> {
    await guarded(event, 'heartbeat', () => beat(db, clock().toISOString()));
  }
  /** A call that comes while an attempt is under way does nothing. */
  async function redeliveryThenBeat(event: string): Promise<void> {
    if (ending || through || redelivering) return;
    let ok = false;
    redelivering = true;
    try {
      await guarded(event, 'redelivery', async () => { ok = await redeliver(); });
    } finally {
      redelivering = false;
    }
    if (!ok || ending) return;
    through = true;
    beating = true;
    await beatOnce(event);
    every(BEAT_MS, async () => { if (!ending) await beatOnce('beat_failed'); });
  }
  async function upkeep(): Promise<void> {
    if (ending) return;
    await guarded('upkeep_failed', 'key_check', keyCheck);
    if (ending) return;
    await guarded('upkeep_failed', 'delete_finished', async () => {
      await deleteFinishedJobs(db, new Date(clock().getTime() - JOB_KEEP_MS).toISOString());
    });
    await redeliveryThenBeat('upkeep_failed');
  }

  every(TICK_MS, () => runner.tick());
  every(UPKEEP_MS, upkeep);
  void runner.tick();
  const settled = (async () => {
    await guarded('start_step_failed', 'key_check', keyCheck);
    await guarded('start_step_failed', 'app_check', appCheck);
    await redeliveryThenBeat('start_step_failed');
  })();

  async function stopOnce(): Promise<void> {
    ending = true;
    for (const cancel of cancels) {
      try {
        cancel();
      } catch {
        // a timer that cannot be cancelled does nothing more: its work sees the stop
      }
    }
    try {
      if (await within(DRAIN_WAIT_MS, runner.drain()) === 'timeout') say({ event: 'drain_timeout', running: runner.running() });
    } catch (error) {
      say({ event: 'drain_failed', ...why(error) });
    }
    try {
      await listening.close();
    } catch (error) {
      say({ event: 'listener_close_failed', ...why(error) });
    }
    try {
      await within(STOP_WAIT_MS, idle());
    } catch {
      // idle never rejects
    }
    if (beating) {
      try {
        await beat(db, clock().toISOString());
      } catch (error) {
        say({ event: 'beat_failed', ...why(error) });
      }
    }
    try {
      await within(ALERT_TIMEOUT_MS, alertsSettled());
    } catch {
      // settled never rejects
    }
    try {
      if (await within(CLOSE_WAIT_MS, db.close()) === 'timeout') say({ event: 'database_close_timeout' });
    } catch (error) {
      say({ event: 'database_close_failed', ...why(error) });
    }
    try {
      if (await within(CLOSE_WAIT_MS, held.release()) === 'timeout') say({ event: 'instance_lock_release_timeout' });
    } catch (error) {
      say({ event: 'instance_lock_release_failed', ...why(error) });
    }
  }
  return {
    stop: () => (stopping ??= stopOnce()),
    settled,
  };
}
