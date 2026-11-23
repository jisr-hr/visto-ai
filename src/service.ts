import { loadMigrations, MIGRATIONS_DIR, migrate } from './db/migrate.ts';
import { beat, readHeartbeat } from './db/heartbeat.ts';
import { askGate, deleteFinishedJobs } from './db/jobs.ts';
import type { Job } from './db/jobs.ts';
import { getPullRequest } from './db/pull-requests.ts';
import type { Db, InstanceLock } from './db/types.ts';
import { gateUseOf, repoSettingsFor } from './config/load.ts';
import type { ServiceConfig } from './config/load.ts';
import type { ReviewDeps, ReviewInput, ReviewResult } from './engine/types.ts';
import { alertSinksOf, notifiersOf } from './extensions/load.ts';
import type { LoadedExtension } from './extensions/types.ts';
import type { AppIdentity, ForgeAccess, ForgeChecks, ForgeWriter, HookDeliveries, PullRequestRef, Source, WebhookReader } from './forge/types.ts';
import { gatingOf } from './gate/gating.ts';
import { runGateJob } from './gate/job.ts';
import type { GateJobDeps } from './gate/job.ts';
import { createKeyedLock } from './gate/lock.ts';
import { askWaiting, sweepGate } from './gate/sweep.ts';
import { ALERT_TIMEOUT_MS, createAlerts } from './shell/alerts.ts';
import type { Alert } from './shell/alerts.ts';
import { codeOf, isShortCode } from './shell/codes.ts';
import { dryChecks, dryWriter } from './shell/dry-writer.ts';
import { createExtensionHealth } from './shell/extension-health.ts';
import { createExtensionRoutes } from './shell/extension-routes.ts';
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
  /** The check runs, statuses and team membership the gate reads and writes. In dry run the gate is given checks that refuse every call instead. */
  checks: ForgeChecks;
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
  /** The modules loaded at start; [] when the config names none. */
  extensions: LoadedExtension[];
  /** Links a notice carries: to one review of a pull request, and to the pull request. */
  reviewUrl: (ref: PullRequestRef, reviewId: string) => string;
  pullRequestUrl: (ref: PullRequestRef) => string;
}
export const STOP_WAIT_MS = 10_000;
export const CLOSE_WAIT_MS = 5_000;
export const TICK_MS = 5_000;
export const BEAT_MS = 60_000;
export const UPKEEP_MS = 300_000;
export const DRAIN_WAIT_MS = 600_000;
export const LOOKBACK_MARGIN_MS = 120_000;
export const JOB_KEEP_MS = 14 * 86_400_000;
/** The places of the gate's runner. */
export const GATE_CONCURRENCY = 4;

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

/** What the gate is given to reach GitHub: in dry run, checks and a writer whose every call rejects; else the ones given. */
export function gateForge(dryRun: boolean, checks: ForgeChecks, writer: ForgeWriter): { checks: ForgeChecks; writer: ForgeWriter } {
  return dryRun ? { checks: dryChecks(), writer: dryWriter() } : { checks, writer };
}

/**
 * Takes the lock, migrates, recovers, then listens; the work that follows listening is not waited for.
 * `settled` resolves when the work that follows listening has had its first try: the key check, the app check, the redelivery attempt and, when that worked, the first beat.
 * `stop` drains both runners (at most DRAIN_WAIT_MS between them), closes the listener and waits for requests in flight (at most STOP_WAIT_MS),
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
  // In dry run no module is told of a review or an alert (11.1); its providers and routes still work.
  const notifiers = notifiersOf(deps.extensions);
  const sinks = alertSinksOf(deps.extensions);
  const { alert, settled: alertsSettled } = createAlerts({
    webhook: config.alerts?.webhook ?? null, fetch: deps.fetch, clock, log: say,
    ...(config.dryRun || sinks.length === 0 ? {} : { sinks }),
  });
  const health = createModelHealth(alert);
  const extensionHealth = deps.extensions.length === 0 ? null : createExtensionHealth(alert);
  const spend = createSpendGuard({ db, limit: config.limits.spendPerDay, clock, alert });
  const reviewDeps: ReviewJobDeps = {
    db, forge: deps.forge, clock, log: say, sleep: deps.sleep, settingsFor,
    limits: {
      inputTokensPerCall: config.limits.inputTokensPerCall, batchesPerReview: config.limits.batchesPerReview,
      modelTimeoutSeconds: config.model.timeoutSeconds,
    },
    dryRun: config.dryRun, writer: config.dryRun ? dryWriter() : deps.writer, engineDeps: deps.engineDeps, review: deps.review, lineUrl: deps.lineUrl, health, spend,
    commentUrl: deps.commentUrl, canResolve: () => deps.appInfo.canResolve(),
    ...(config.dryRun || notifiers.length === 0 ? {} : { notice: { notifiers, reviewUrl: deps.reviewUrl, pullRequestUrl: deps.pullRequestUrl } }),
    ...(extensionHealth === null ? {} : { extensionHealth }),
  };
  // gate_check_failed is raised once for each reason in a run of the service.
  const raisedGate = new Set<string>();
  const gateAlert: Alert = (code, details) => {
    const key = `${code}:${String(details?.reason ?? null)}`;
    if (raisedGate.has(key)) return;
    raisedGate.add(key);
    alert(code, details);
  };
  /** Why reviews do not start now, as the short code the gate jobs are given; null when they do. */
  async function pauseCode(): Promise<string | null> {
    if (health.paused(clock())) return 'model_error';
    return (await spend.level()) === 'limit' ? 'spend_limit' : null;
  }
  /** Whether the gate is in use here: out of dry run, with some repository's gate enabled. */
  const gateLive = !config.dryRun && gateUseOf(config).check;
  /** The pause the review runner's last pass saw; null at start. */
  let pauseSeen: string | null = null;
  /** When the pause begins, ends or changes, the checks of the waiting reviews are asked for. A failure is logged, and the next pass tries again. */
  async function mayStartReview(): Promise<boolean> {
    const code = await pauseCode();
    if (gateLive && code !== pauseSeen) {
      try {
        await askWaiting(db, settingsFor, clock().toISOString());
        pauseSeen = code;
        void gateRunner.tick();
      } catch (error) {
        say({ event: 'gate_ask_failed', reason: codeOf(error) });
      }
    }
    return code === null;
  }
  const runner = createRunner({
    db, kind: 'review', concurrency: config.limits.queueConcurrency, clock, log: say,
    mayStart: mayStartReview,
    run: (job) => runReviewJob(job, reviewDeps),
    onLeft: reviewLeft,
  });
  const gateDeps: GateJobDeps = {
    db, forge: deps.forge, ...gateForge(config.dryRun, deps.checks, deps.writer),
    clock, log: say, settingsFor, dryRun: config.dryRun,
    paused: pauseCode,
    reviewing: (ref) => runner.holds(ref),
    commentUrl: deps.commentUrl, alert: gateAlert, lock: createKeyedLock(),
    onQueued: () => { tickBoth(); },
  };
  // Never paused with the reviews.
  const gateRunner = createRunner({
    db, kind: 'gate', concurrency: GATE_CONCURRENCY, clock, log: say,
    mayStart: async () => true,
    run: (job) => runGateJob(job, gateDeps),
    onLeft: async (_job, how) => {
      if (how !== 'ended') gateAlert('gate_check_failed', { reason: how });
    },
  });
  function tickBoth(): void {
    void runner.tick();
    void gateRunner.tick();
  }
  /** A review job has left its runner, however it left: the check of a gated pull request is asked for. With the gate off nothing is read. */
  async function reviewLeft(job: Job): Promise<void> {
    if (config.dryRun) return;
    const settings = settingsFor(`${job.ref.owner}/${job.ref.repo}`);
    if (!settings.gate.enabled) return;
    const stored = await getPullRequest(db, job.ref);
    if (stored !== null && gatingOf(settings, stored.baseBranch) === 'off') return;
    await askGate(db, job.ref, clock().toISOString(), undefined, { installation: job.installation });
    void gateRunner.tick();
  }
  const { listener, idle } = createListener({
    webhook: (headers, body) => receive({
      db, reader: deps.reader, clock, log: say, settingsFor, onQueued: tickBoth, dryRun: config.dryRun, appId: config.app.id,
    }, headers, body),
    // With no module that has a route the map is empty, and every address under /extensions/ is answered as any unknown one.
    extensions: createExtensionRoutes(deps.extensions, {
      log: say,
      ...(extensionHealth === null ? {} : { noted: (name: string, ok: boolean, code: string) => { extensionHealth.noted(name, 'route', ok, code); } }),
    }),
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
    // The checks the record and the config disagree on, or that a review left under way, are asked for.
    if (gateLive) say({ event: 'gate_sweep', asked: await sweepGate(db, settingsFor, clock().toISOString()) });
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

  if (config.dryRun && notifiers.length + sinks.length > 0) {
    say({ event: 'extensions_quiet', reason: 'dry_run', notifiers: notifiers.length, sinks: sinks.length });
  }

  // A repository in bypass is said at each start.
  if (!config.dryRun && gateUseOf(config).bypass) {
    say({ event: 'gate_bypass' });
    alert('gate_bypass');
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
    const lacking = await deps.appInfo.lacks(config.dryRun, gateUseOf(config));
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

  every(TICK_MS, async () => { await Promise.all([runner.tick(), gateRunner.tick()]); });
  every(UPKEEP_MS, upkeep);
  tickBoth();
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
      if (await within(DRAIN_WAIT_MS, Promise.all([runner.drain(), gateRunner.drain()])) === 'timeout') {
        say({ event: 'drain_timeout', running: runner.running() + gateRunner.running() });
      }
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
