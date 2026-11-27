import { loadMigrations, MIGRATIONS_DIR, migrate } from './db/migrate.ts';
import { beat, readHeartbeat } from './db/heartbeat.ts';
import { markDismissFailed, standingApprovals } from './db/approvals.ts';
import { askGate, askWithdraw, deleteFinishedJobs } from './db/jobs.ts';
import type { Job } from './db/jobs.ts';
import { getPullRequest } from './db/pull-requests.ts';
import type { Db, InstanceLock } from './db/types.ts';
import { approvalUseOf, gateUseOf, githubSignInOn, repoSettingsFor } from './config/load.ts';
import type { ServiceConfig } from './config/load.ts';
import type { ModelClient, ReviewDeps, ReviewInput, ReviewResult } from './engine/types.ts';
import { alertSinksOf, notifiersOf } from './extensions/load.ts';
import type { LoadedExtension } from './extensions/types.ts';
import type { AppIdentity, ForgeAccess, ForgeApprovals, ForgeChecks, ForgeSignIn, ForgeWriter, HookDeliveries, PullRequestRef, Source, WebhookReader } from './forge/types.ts';
import { runWithdrawJob, sweepWithdraw } from './approval/withdraw.ts';
import type { WithdrawJobDeps } from './approval/withdraw.ts';
import { gatingOf } from './gate/gating.ts';
import { runGateJob } from './gate/job.ts';
import type { GateJobDeps } from './gate/job.ts';
import { createKeyedLock } from './gate/lock.ts';
import { askWaiting, sweepGate } from './gate/sweep.ts';
import { ALERT_TIMEOUT_MS, createAlerts } from './shell/alerts.ts';
import type { Alert } from './shell/alerts.ts';
import { codeOf, isShortCode } from './shell/codes.ts';
import { dryApprovals, dryChecks, dryWriter } from './shell/dry-writer.ts';
import { createExtensionHealth } from './shell/extension-health.ts';
import { createExtensionRoutes } from './shell/extension-routes.ts';
import { createListener } from './shell/http.ts';
import type { RequestLike, ResponseLike } from './shell/http.ts';
import { createMcpHealth } from './shell/mcp-health.ts';
import { checkModelKey, createModelHealth } from './shell/model-health.ts';
import type { KeyCheck } from './shell/model-health.ts';
import { createNightly } from './shell/judge.ts';
import { createLearning, LEARN_MS } from './shell/learning.ts';
import { createMemoryHealth } from './shell/memory-health.ts';
import { recordsMemory } from './shell/memory.ts';
import { receive } from './shell/receive.ts';
import { recoverJobs } from './shell/recovery.ts';
import { runRedelivery } from './shell/redelivery.ts';
import { runReviewJob } from './shell/review-job.ts';
import type { ReviewJobDeps } from './shell/review-job.ts';
import { createRunner } from './shell/runner.ts';
import type { Settings } from './shell/settings.ts';
import { createSpendGuard } from './shell/spend.ts';
import { createAccountChanges } from './ui/accounts.ts';
import { createAuth } from './ui/auth.ts';
import type { UiFiles } from './ui/files.ts';
import { createPasswordAuth } from './ui/password-auth.ts';
import type { PasswordCost } from './ui/passwords.ts';
import { createUiRoute } from './ui/route.ts';

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
  /** The branch's rule on stale approvals, a review's state and its dismissal. In dry run, and when absent, approvals that refuse every call are given instead. */
  approvals?: ForgeApprovals;
  /** What the app is allowed to do; asked once at start. */
  appInfo: AppIdentity;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** A repeating timer. Returns its cancel. `work` never rejects; what it returns is there for a test to wait on. */
  every: (ms: number, work: () => Promise<void>) => () => void;
  /** Absent: the settings are `config`, which never changes. Given: `config` is `settings.atStart`. */
  settings?: Settings;
  /** The engine's dependencies for one review, from the settings it runs on (the service always gives them). */
  engineDeps: (source: Source, settings?: ServiceConfig) => ReviewDeps;
  review: (input: ReviewInput, deps: ReviewDeps) => Promise<ReviewResult>;
  lineUrl: ReviewJobDeps['lineUrl'];
  commentUrl: ReviewJobDeps['commentUrl'];
  /** The modules loaded at start; [] when the config names none. */
  extensions: LoadedExtension[];
  /** Links a notice carries: to one review of a pull request, and to the pull request. */
  reviewUrl: (ref: PullRequestRef, reviewId: string) => string;
  pullRequestUrl: (ref: PullRequestRef) => string;
  /** The review model's client; the judge's calls go through it. Read only with learning on. */
  model: ModelClient;
  /** Fresh random text for data markers. Read only with learning on. */
  token: () => string;
  /**
   * Sign-in at the git service, the built files, and the cost of every password hash (absent: the production cost); absent: the
   * UI is off whatever the config says. `signIn` null: no GitHub sign-in whatever the file says.
   */
  ui?: { signIn: ForgeSignIn | null; files: UiFiles; passwordCost?: PasswordCost };
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
/** The places of the withdraw runner. */
export const WITHDRAW_CONCURRENCY = 2;

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

/** What the review job and the withdraw job are given to reach GitHub's approvals: in dry run, and when none was given, approvals whose every call rejects; else the ones given. */
export function approvalsFor(dryRun: boolean, approvals: ForgeApprovals | undefined): ForgeApprovals {
  return dryRun ? dryApprovals() : approvals ?? dryApprovals();
}

/**
 * Takes the lock, migrates, recovers, then listens; the work that follows listening is not waited for.
 * `settled` resolves when the work that follows listening has had its first try: the key check, the app check, with learning on the learning work's start and the judge's row (the first pass is not waited for, and no run of the judge starts), the redelivery attempt and, when that worked, the first beat.
 * `stop` drains the three runners (at most DRAIN_WAIT_MS between them), closes the listener and waits for requests in flight (at most STOP_WAIT_MS),
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
  // What reviews and events read (call 19): the settings in force, or the config given, which never changes. The start-time
  // settings (dry run, learning, the concurrency, the model's endpoint, time limit and tool choice, the scorer) and every
  // setting that is not editable keep being read from `config`, which is what the settings in force hold for them too.
  const given = deps.settings;
  const inForce = given === undefined ? (): ServiceConfig => config : (): ServiceConfig => given.inForce();
  const settingsFor = (name: string) => repoSettingsFor(inForce(), name);
  // In dry run no module is told of a review or an alert (11.1); its providers and routes still work.
  const notifiers = notifiersOf(deps.extensions);
  const sinks = alertSinksOf(deps.extensions);
  const { alert, settled: alertsSettled } = createAlerts({
    webhook: config.alerts?.webhook ?? null, fetch: deps.fetch, clock, log: say,
    ...(config.dryRun || sinks.length === 0 ? {} : { sinks }),
  });
  const health = createModelHealth(alert);
  const extensionHealth = deps.extensions.length === 0 ? null : createExtensionHealth(alert);
  const mcpHealth = config.mcpServers.length === 0 ? null : createMcpHealth(alert);
  // The daily limit is read at each look.
  const spend = createSpendGuard({ db, limit: () => inForce().limits.spendPerDay, clock, alert });
  // With learning off none of it is made: no pass, no memory, no health (call 17). In dry run it runs (11.1).
  const learning = config.learning ? createLearning({ db, clock, log: say, alert }) : null;
  const memory = config.learning ? { memoryFor: (ref: PullRequestRef) => recordsMemory(db, ref), memoryHealth: createMemoryHealth(alert) } : null;
  // Nothing reaches GitHub's approvals in dry run, nor when the service was given none: each call rejects, and nothing is approved or dismissed.
  const approvals = approvalsFor(config.dryRun, deps.approvals);
  const reviewBase: Omit<ReviewJobDeps, 'settingsFor' | 'limits' | 'engineDeps'> = {
    db, forge: deps.forge, clock, log: say, sleep: deps.sleep,
    dryRun: config.dryRun, writer: config.dryRun ? dryWriter() : deps.writer, review: deps.review, lineUrl: deps.lineUrl, health, spend,
    commentUrl: deps.commentUrl, canResolve: () => deps.appInfo.canResolve(),
    approvals, onWithdraw: () => { void withdrawRunner.tick(); },
    // Each review writes its stage on its job, with the UI off too (call 31).
    stages: true,
    ...(config.dryRun || notifiers.length === 0 ? {} : { notice: { notifiers, reviewUrl: deps.reviewUrl, pullRequestUrl: deps.pullRequestUrl } }),
    ...(extensionHealth === null ? {} : { extensionHealth }),
    ...(mcpHealth === null ? {} : { mcpHealth }),
    ...(memory === null ? {} : memory),
    // The audit key goes to the review job and to nothing else.
    ...(config.auditKey === undefined ? {} : { auditKey: config.auditKey }),
  };
  /**
   * A review job's dependencies on the settings `c`, given when its runner starts it, so that it keeps them to its end (call 20):
   * its repository settings, its limits and its engine (main makes the model client and the scorer from them).
   */
  const reviewDepsAt = (c: ServiceConfig): ReviewJobDeps => ({
    ...reviewBase,
    settingsFor: (name) => repoSettingsFor(c, name),
    limits: { inputTokensPerCall: c.limits.inputTokensPerCall, batchesPerReview: c.limits.batchesPerReview, modelTimeoutSeconds: c.model.timeoutSeconds },
    engineDeps: (source) => deps.engineDeps(source, c),
  });
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
  // With learning on, the judge runs once a day on the learning timer, in dry run too, with the review model, its tool
  // choice and its time limit; its calls count in the day's spend, and it makes none while reviews are paused (calls 15 to 17).
  const nightly = config.learning ? createNightly({
    db, clock, log: say, alert, model: deps.model, token: deps.token,
    auto: config.model.toolChoice === 'auto', timeoutMs: config.model.timeoutSeconds * 1000,
    paused: pauseCode, noteUsage: (usage) => { spend.noteRun(usage); },
  }) : null;
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
    run: (job) => runReviewJob(job, reviewDepsAt(inForce())),
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
  const withdrawDeps: WithdrawJobDeps = {
    db, forge: deps.forge, approvals, clock, log: say, alert, settingsFor, dryRun: config.dryRun,
    onQueued: () => { tickBoth(); },
  };
  // Never paused with the reviews (call 17).
  const withdrawRunner = createRunner({
    db, kind: 'withdraw', concurrency: WITHDRAW_CONCURRENCY, clock, log: say,
    mayStart: async () => true,
    run: (job) => runWithdrawJob(job, withdrawDeps),
    onLeft: withdrawLeft,
  });
  /**
   * A withdraw job the runner dropped, as too old or out of starts, withdrew nothing: the reason is recorded as the failure
   * of each standing approval of its pull request, and raised once when one of these was recorded for the first time or
   * could not be recorded. Out of dry run, a job too old is asked for afresh, and the check of a repository whose gate is
   * enabled is asked for. Each step is caught: one that fails changes nothing else.
   */
  async function withdrawLeft(job: Job, how: 'ended' | 'too_old' | 'attempts_exhausted'): Promise<void> {
    if (how === 'ended') return;
    const repo = `${job.ref.owner}/${job.ref.repo}`;
    // A failure unrecorded is never read as an old one.
    let fresh = false;
    try {
      for (const standing of await standingApprovals(db, job.ref)) {
        try {
          if (await markDismissFailed(db, standing.run, how)) fresh = true;
        } catch {
          // left as it was: the next withdraw job of the pull request records it
          fresh = true;
        }
      }
    } catch {
      // the approvals could not be read, so none could be recorded: the next push, publication or start asks again
      fresh = true;
    }
    if (fresh) {
      try {
        alert('dismissal_failed', { reason: how, repo, number: job.ref.number });
      } catch {
        // an alert that throws changes nothing
      }
    }
    if (config.dryRun) return;
    // The dropped row is finished, so this stores a fresh job: its re-check clears the approvals that hold and withdraws
    // the others. Not for a job out of starts: a crash that repeats would loop.
    if (how === 'too_old') {
      try {
        await askWithdraw(db, job.ref, clock().toISOString(), job.installation);
        void withdrawRunner.tick();
      } catch {
        // the request is lost: the next push, publication or start asks again
      }
    }
    try {
      if (!settingsFor(repo).gate.enabled) return;
      await askGate(db, job.ref, clock().toISOString(), undefined, { installation: job.installation });
      void gateRunner.tick();
    } catch {
      // the request for the check is lost: the next event or start asks again
    }
  }
  /** Every runner looks at its due jobs. */
  function tickBoth(): void {
    void runner.tick();
    void gateRunner.tick();
    void withdrawRunner.tick();
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
  // The UI is on with both the file's `ui` and the service's; with either absent nothing of it is made or read (call 31). GitHub
  // sign-in is on when the file names an account or a team and the service was given a sign-in, which is read only then.
  const ui = config.ui === undefined || deps.ui === undefined ? null : {
    // Who may open it and the address only: the client secret stays with the adapter.
    access: { accounts: config.ui.accounts, team: config.ui.team, publicUrl: config.ui.publicUrl },
    signIn: githubSignInOn(config.ui) ? deps.ui.signIn : null, files: deps.ui.files,
    cost: deps.ui.passwordCost,
  };
  const uiRoute = ui === null ? null : createUiRoute({
    auth: createAuth({ db, ui: ui.access, signIn: ui.signIn, checks: deps.checks, clock, log: say }),
    passwords: createPasswordAuth({ db, clock, log: say, ...(ui.cost === undefined ? {} : { cost: ui.cost }) }),
    accounts: createAccountChanges({ db, clock, log: say, ...(ui.cost === undefined ? {} : { cost: ui.cost }) }),
    api: {
      db, clock, dryRun: config.dryRun, reviewPlaces: config.limits.queueConcurrency, withdrawPlaces: WITHDRAW_CONCURRENCY,
      holds: (ref) => runner.holds(ref), paused: pauseCode, pullRequestUrl: deps.pullRequestUrl,
    },
    files: ui.files, ui: { publicUrl: ui.access.publicUrl, github: ui.signIn !== null }, log: say,
  });
  const { listener, idle } = createListener({
    webhook: (headers, body) => receive({
      db, reader: deps.reader, clock, log: say, settingsFor, onQueued: tickBoth, dryRun: config.dryRun, appId: config.app.id,
      ...(learning === null ? {} : { onLearn: () => { learning.wake(); } }),
    }, headers, body),
    // With no module that has a route the map is empty, and every address under /extensions/ is answered as any unknown one.
    extensions: createExtensionRoutes(deps.extensions, {
      log: say,
      ...(extensionHealth === null ? {} : { noted: (name: string, ok: boolean, code: string) => { extensionHealth.noted(name, 'route', ok, code); } }),
    }),
    // With the UI off, '/', '/ui/...' and '/api/...' are answered as any unknown path.
    ...(uiRoute === null ? {} : { ui: uiRoute }),
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
    // A withdrawal that failed is asked for again on each pull request stored as open (call 22).
    if (!config.dryRun) {
      const asked = await sweepWithdraw(db, clock().toISOString());
      if (asked > 0) say({ event: 'withdraw_sweep', asked });
    }
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

  // How many built files are served; 0 when ui/dist was not built (call 17).
  if (ui !== null) say({ event: 'ui', files: ui.files.size });

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
    // With GitHub sign-in on and a team named, the UI reads its members (call 27); else nothing of it is asked for.
    const lacking = await deps.appInfo.lacks(config.dryRun, gateUseOf(config), approvalUseOf(config), ui !== null && ui.signIn !== null && ui.access.team !== null);
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
  /** The learning work's row and its first pass, which is not waited for, then the judge's row; then their one timer, whether or not the rows could be made. No run of the judge starts here. */
  async function startLearning(): Promise<void> {
    if (learning === null || nightly === null || ending) return;
    await guarded('start_step_failed', 'learning', async () => {
      await learning.start();
      await nightly.start();
    });
    if (ending) return;
    learning.wake();
    every(LEARN_MS, async () => { await Promise.all([learning.tick(), nightly.tick()]); });
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

  every(TICK_MS, async () => { await Promise.all([runner.tick(), gateRunner.tick(), withdrawRunner.tick()]); });
  every(UPKEEP_MS, upkeep);
  tickBoth();
  const settled = (async () => {
    await guarded('start_step_failed', 'key_check', keyCheck);
    await guarded('start_step_failed', 'app_check', appCheck);
    await startLearning();
    await redeliveryThenBeat('start_step_failed');
  })();

  async function stopOnce(): Promise<void> {
    ending = true;
    learning?.stop();
    nightly?.stop();
    for (const cancel of cancels) {
      try {
        cancel();
      } catch {
        // a timer that cannot be cancelled does nothing more: its work sees the stop
      }
    }
    try {
      if (await within(DRAIN_WAIT_MS, Promise.all([runner.drain(), gateRunner.drain(), withdrawRunner.drain()])) === 'timeout') {
        say({ event: 'drain_timeout', running: runner.running() + gateRunner.running() + withdrawRunner.running() });
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
    // A pass or a run under way must not meet a closed database, and one that hangs must not hold the stop: a run told
    // to stop sends no statement after it, so a call of the judge under way is not waited for further.
    if (learning !== null && nightly !== null) {
      try {
        await within(CLOSE_WAIT_MS, Promise.all([learning.idle(), nightly.idle()]));
      } catch {
        // idle never rejects
      }
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
