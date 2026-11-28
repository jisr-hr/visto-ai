import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { ConfigError, contractFile, githubSignInOn, parseDocument, readYaml, serviceConfig } from './config/load.ts';
import type { DeploymentConfig, McpServerConfig } from './config/load.ts';
import { loadMigrations, MIGRATIONS_DIR, migrate } from './db/migrate.ts';
import { postgresDb, takeInstanceLock } from './db/postgres.ts';
import type { InstanceLock } from './db/types.ts';
import { createModelClient } from './engine/model/client.ts';
import { review } from './engine/review.ts';
import { createJevScorer } from './engine/scorer/jev.ts';
import type { McpServer, ModelClient, ReviewDeps, Scorer } from './engine/types.ts';
import { contextProvidersOf, errorNameOf, loadExtensions } from './extensions/load.ts';
import type { LoadedExtension } from './extensions/types.ts';
import { createGithubAccess } from './forge/github/access.ts';
import { createAppAuth } from './forge/github/app-auth.ts';
import { createAppInfo } from './forge/github/app-info.ts';
import { createGithubApprovals } from './forge/github/approvals.ts';
import { createGithubChecks } from './forge/github/checks.ts';
import { createGithubHookDeliveries } from './forge/github/hook-deliveries.ts';
import { githubCommentUrl, githubLineUrl, githubPullRequestUrl, githubReviewUrl } from './forge/github/links.ts';
import { createGithubSignIn } from './forge/github/sign-in.ts';
import { createGithubWebhookReader } from './forge/github/webhook.ts';
import { createGithubWriter } from './forge/github/writer.ts';
import { createMcpServers } from './mcp/client.ts';
import { startService } from './service.ts';
import type { Listening } from './service.ts';
import { createFeedback } from './shell/feedback.ts';
import type { RequestLike, ResponseLike } from './shell/http.ts';
import { startSettings } from './shell/settings.ts';
import type { Settings } from './shell/settings.ts';
import { loadUiFiles } from './ui/files.ts';

// Node's default lets a caller take five minutes to send a request, and each such caller holds one of the 20 places.
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEADERS_TIMEOUT_MS = 10_000;

/** The time limit of one call to GitHub, its body included (call 50). */
export const GITHUB_CALL_MS = 60_000;

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * The engine's MCP servers: one for each the config names, on the fetch given, which is the platform's and not GitHub's with its
 * time limit (the engine has limits of its own for each step). No key at all when the config names none. Nothing is asked here.
 */
export function mcpServersOf(configs: McpServerConfig[], fetchFn: typeof fetch): { mcpServers?: McpServer[] } {
  return configs.length === 0 ? {} : { mcpServers: createMcpServers(configs, { fetch: fetchFn }) };
}

/**
 * The engine's dependencies but the source, as the service gives them to every review. `fetch` is the platform's, not GitHub's
 * with its time limit: the model, the scorer and the MCP servers keep their own. The tool choice and the servers are there only
 * when the config writes them.
 */
export function engineBase(
  config: DeploymentConfig,
  io: { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; clock: () => Date; log: (entry: Record<string, unknown>) => void },
): Omit<ReviewDeps, 'source'> {
  const { fetch: fetchFn, sleep } = io;
  return {
    model: createModelClient(config.model, { fetch: fetchFn, sleep }),
    contract: readFileSync(join(import.meta.dirname, '..', 'contract', contractFile(config)), 'utf8'),
    clock: io.clock,
    token: () => randomBytes(8).toString('hex'),
    log: io.log,
    ...(config.scorer === null ? {} : { scorer: createJevScorer(config.scorer, { fetch: fetchFn, sleep }) }),
    ...(config.model.toolChoice === 'auto' ? { toolChoice: 'auto' as const } : {}),
    // Opened for each review, in dry run too: a call only reads.
    ...mcpServersOf(config.mcpServers, fetchFn),
  };
}

/** The model client and, with a scorer, the scorer of `config`; made for each review. */
export function clientsFor(
  config: DeploymentConfig, io: { fetch: typeof fetch; sleep: (ms: number) => Promise<void> },
): { model: ModelClient; scorer?: Scorer } {
  return {
    model: createModelClient(config.model, io),
    ...(config.scorer === null ? {} : { scorer: createJevScorer(config.scorer, io) }),
  };
}

/**
 * Whether the start's sync is told the UI is on (call 13): the file writes `ui.publicUrl`. A file that passed has `ui` exactly
 * then (GitHub sign-in needs the address too), and the service turns the UI on from the same `ui`.
 */
export function uiOnOf(config: DeploymentConfig): boolean {
  return config.ui !== undefined;
}

/**
 * A fetch whose every call ends within `limitMs`, its body included: the answer is read whole inside the limit, so a
 * call that hangs rejects, which the adapters read as `github_network`. A signal the caller passes still aborts it.
 */
export function boundedFetch(inner: typeof fetch, limitMs: number = GITHUB_CALL_MS): typeof fetch {
  return async (input, init) => {
    const limit = AbortSignal.timeout(limitMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, limit]) : limit;
    let stop!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { stop = reject; });
    aborted.catch(() => { /* raced below */ });
    const onAbort = (): void => { stop(signal.reason); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await Promise.race([inner(input, { ...init, signal }), aborted]);
      const body = await Promise.race([res.arrayBuffer(), aborted]);
      return new Response(NULL_BODY.has(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
}

class UsageError extends Error {}

/** One log line for a rejected promise nobody handled, with the error's name when it is the platform's own, else null. Never throws. */
export function rejectionHandler(log: (entry: Record<string, unknown>) => void): (reason: unknown) => void {
  return (reason) => {
    try {
      log({ event: 'unhandled_rejection', error: errorNameOf(reason) });
    } catch {
      // a logger that throws changes nothing
    }
  };
}

/**
 * With a module loaded, a promise a part started and left behind cannot end the service: the handler is registered and
 * returned. With none, nothing is registered and the platform's default stands; null is returned.
 */
export function guardRejections(
  extensions: LoadedExtension[], log: (entry: Record<string, unknown>) => void, register: (handler: (reason: unknown) => void) => void,
): ((reason: unknown) => void) | null {
  if (extensions.length === 0) return null;
  const handler = rejectionHandler(log);
  register(handler);
  return handler;
}

/**
 * Takes the instance lock, then loads the modules. Rejects with Error('another_instance_running') when another instance holds the lock, and `load` is then not called.
 * When `load` rejects, the lock is released and the rejection passed on; a release that fails changes nothing.
 */
export async function lockThenLoad(takeLock: () => Promise<InstanceLock | null>, load: () => Promise<LoadedExtension[]>): Promise<{ lock: InstanceLock; extensions: LoadedExtension[] }> {
  const lock = await takeLock();
  if (lock === null) throw new Error('another_instance_running');
  try {
    return { lock, extensions: await load() };
  } catch (error) {
    try {
      await lock.release();
    } catch {
      // the loader's failure is the one to report
    }
    throw error;
  }
}

/**
 * The steps after the instance lock, in this order: the migrations, the settings of this start, then the engine's base from them.
 * A step that rejects or throws releases the lock and closes the database, each once and each failure of those swallowed, and its
 * error is passed on; no step after it runs.
 */
export async function afterLock<B>(lock: InstanceLock, db: { close(): Promise<void> }, steps: {
  migrate: () => Promise<unknown>; settings: () => Promise<Settings>; base: (settings: Settings) => B;
}): Promise<{ settings: Settings; base: B }> {
  try {
    await steps.migrate();
    const settings = await steps.settings();
    return { settings, base: steps.base(settings) };
  } catch (error) {
    try {
      await lock.release();
    } catch {
      // the step's failure is the one to report
    }
    try {
      await db.close();
    } catch {
      // the step's failure is the one to report
    }
    throw error;
  }
}

/** A start that failed: each issue of a ConfigError as `config: <issue>`, then `start_failed`; any other error `start_failed` alone. */
export function startFailed(error: unknown, out: (line: string) => void): void {
  // Issues name keys and variables, never values; a clash's sentence names the settings saved in the UI.
  if (error instanceof ConfigError) for (const issue of error.issues) out(`config: ${issue}`);
  out('start_failed');
}

export function createServer(listener: (req: RequestLike, res: ResponseLike) => void): Server {
  return createHttpServer({ requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: HEADERS_TIMEOUT_MS }, listener);
}

function configPath(argv: string[]): string {
  if (argv.length === 2 && argv[0] === '--config' && !argv[1]!.startsWith('--')) return argv[1]!;
  throw new UsageError('usage: main --config <path>');
}

/** The error's name, its string code, and the short code its message starts with (up to a colon), or null. Never its message. */
export function describeFailure(error: unknown): { error: string; code: string | null; reason: string | null } {
  const o = typeof error === 'object' && error !== null ? error as { name?: unknown; code?: unknown; message?: unknown } : {};
  const reason = typeof o.message === 'string' ? /^([a-z][a-z0-9_]{0,39})(:|$)/.exec(o.message)?.[1] ?? null : null;
  return { error: typeof o.name === 'string' ? o.name : 'unknown', code: typeof o.code === 'string' ? o.code : null, reason };
}

function log(entry: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/** The code the process ends with after a restart asked from the UI: its supervisor (a restart policy) starts it again. */
export const RESTART_CODE = 75;

/**
 * Runs `start` and stops what it started on the first signal, also one that arrives before `start` has resolved.
 * A second signal calls exit(1). A start that rejects logs { event: 'start_failed', ...describeFailure } and resolves 1.
 * Resolves 0 after a stop. `start` is given `restart`, which stops the service the same way and resolves RESTART_CODE; it is
 * asked once, and a signal before the stop has ended wins (0). A restart after a signal changes nothing.
 */
// PM-drain: the first signal stops the service cleanly, a second one ends the process at once.
export function runUntilSignal(
  start: (restart: () => void) => Promise<{ stop(): Promise<void> }>,
  signals: { on(listener: () => void): void; off(listener: () => void): void },
  exit: (code: number) => void,
  log: (entry: Record<string, unknown>) => void,
): Promise<number> {
  return new Promise<number>((resolve) => {
    let count = 0;
    let service: { stop(): Promise<void> } | null = null;
    // What a clean stop ends with, once a signal (0) or a restart (RESTART_CODE) has asked for one; read when the stop ends.
    let ending: number | null = null;
    let stopping = false;
    const finish = (code: number): void => { signals.off(onSignal); resolve(code); };
    const stop = (running: { stop(): Promise<void> }): void => {
      if (stopping) return;
      stopping = true;
      running.stop().then(
        () => ending ?? 0,
        (error: unknown) => { log({ event: 'stop_failed', ...describeFailure(error) }); return 1; },
      ).then(finish);
    };
    function onSignal(): void {
      count += 1;
      if (count > 1) { exit(1); return; }
      log({ event: 'stopping' });
      ending = 0;
      if (service !== null) stop(service);
    }
    function restart(): void {
      if (ending !== null) return;
      log({ event: 'restarting' });
      ending = RESTART_CODE;
      if (service !== null) stop(service);
    }
    signals.on(onSignal);
    start(restart).then(
      (started) => {
        service = started;
        if (ending !== null) stop(started);
      },
      (error: unknown) => {
        log({ event: 'start_failed', ...describeFailure(error) });
        finish(1);
      },
    );
  });
}

export async function main(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<number> {
  let config;
  let configDir: string;
  /** config.yml's document as read at this start: checked alone here, then synced with the database after the lock. */
  let file: unknown;
  try {
    const path = configPath(argv);
    // A module's relative path starts at the folder of the config file.
    configDir = dirname(resolve(path));
    try {
      file = readYaml(readFileSync(path, 'utf8'));
      // The file alone, as before: one that fails is refused here, and nothing of the settings is touched.
      config = serviceConfig(parseDocument(file, env));
    } catch (error) {
      const fileError = error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string' && typeof (error as NodeJS.ErrnoException).syscall === 'string';
      if (fileError) throw new UsageError('usage: cannot read --config');
      throw error;
    }
  } catch (error) {
    if (error instanceof UsageError) { out(error.message); return 2; }
    // Issues name keys and variables, never values.
    if (error instanceof ConfigError) { for (const issue of error.issues) out(`config: ${issue}`); return 2; }
    out('start_failed');
    log({ event: 'start_failed', ...describeFailure(error) });
    return 1;
  }

  let server: Server | null = null;
  const signals = {
    on: (listener: () => void): void => { process.on('SIGTERM', listener); process.on('SIGINT', listener); },
    off: (listener: () => void): void => { process.off('SIGTERM', listener); process.off('SIGINT', listener); },
  };
  const code = await runUntilSignal(async (restart) => {
    try {
      const { fetch } = globalThis;
      // Every GitHub adapter is given the fetch with a time limit; the model, the scorer, the MCP servers and the alerts keep their own.
      const github = boundedFetch(fetch);
      const clock = (): Date => new Date();
      const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });
      // A key that cannot be read throws here and fails the start.
      const auth = createAppAuth({ appId: config.app.id, privateKey: config.app.privateKey, fetch: github, clock });
      const info = createAppInfo({ auth, fetch: github });
      // Every adapter is made before the lock is taken. After it, a module that does not load (lockThenLoad) and each step of
      // afterLock (the migrations, the settings, the engine's base) release it and close the database when they fail.
      const reader = createGithubWebhookReader(config.app.webhookSecret);
      const forge = createGithubAccess({ auth, fetch: github });
      const hooks = createGithubHookDeliveries({ auth, fetch: github });
      const writer = createGithubWriter({ auth, info, fetch: github });
      const checks = createGithubChecks({ auth, appId: config.app.id, fetch: github });
      const approvals = createGithubApprovals({ auth, fetch: github });
      // With the UI named in the file: the built files, read once here (call 17), and, with GitHub sign-in on, sign-in through
      // the app, which alone is given the client secret; with it off, password sign-in alone.
      const uiConfig = config.ui;
      const ui = uiConfig === undefined ? undefined : {
        signIn: githubSignInOn(uiConfig) ? createGithubSignIn({ clientId: uiConfig.clientId, clientSecret: uiConfig.clientSecret, auth, fetch: github }) : null,
        files: loadUiFiles(join(import.meta.dirname, '..', 'ui', 'dist')),
      };
      // The database object is made before the modules, so the function a module reports feedback through exists when
      // it is set up; it connects when first used, and the service migrates it once it has started.
      const db = postgresDb(config.database.url, log);
      const reportFeedback = createFeedback({ db, clock, log });
      let lock: InstanceLock;
      let extensions: LoadedExtension[];
      try {
        // No module is set up by an instance that is about to be refused (call 1).
        ({ lock, extensions } = await lockThenLoad(
          () => takeInstanceLock(config.database.url, () => {
            log({ event: 'instance_lock_lost' });
            process.exit(1);
          }),
          () => loadExtensions(config.extensions, { configDir, log, reportFeedback }),
        ));
      } catch (error) {
        try {
          await db.close();
        } catch {
          // the start failure is the one to report
        }
        throw error;
      }
      guardRejections(extensions, log, (handler) => { process.on('unhandledRejection', handler); });
      // Before anything reads a setting (call 13): the migrations, then the sync of the file with the database (a clash refuses
      // the start), then the engine's base from the settings this start runs on.
      const { settings, base } = await afterLock(lock, db, {
        migrate: () => migrate(db, loadMigrations(MIGRATIONS_DIR)),
        settings: () => startSettings({
          // The environment is given to the check only, never stored.
          db, file, check: (document) => serviceConfig(parseDocument(document, env)), clock, log, uiOn: uiOnOf(config),
        }),
        base: (started) => engineBase(started.atStart, { fetch, sleep, clock, log }),
      });
      const providers = contextProvidersOf(extensions);
      const engine = { ...base, ...(providers.length === 0 ? {} : { contextProviders: providers }) };
      return await startService(settings.atStart, {
        db,
        reader,
        clock,
        log,
        // Taken above; the service releases it when it stops or fails.
        takeLock: () => Promise.resolve(lock),
        forge,
        hooks,
        appInfo: info,
        writer,
        checks,
        approvals,
        fetch,
        sleep,
        every: (ms, work) => {
          const timer = setInterval(() => { void work(); }, ms);
          timer.unref();
          return () => { clearInterval(timer); };
        },
        settings,
        // A save that leaves a setting read at start waiting stops the service and ends the process with RESTART_CODE.
        restart,
        // Each review's model client and scorer are made from the settings it runs on (call 19).
        engineDeps: (source, c) => ({ source, ...engine, ...clientsFor(c ?? settings.atStart, { fetch, sleep }) }),
        // The judge's calls go through a model client made as the reviews' are, with its fallbacks, prices and request extras,
        // from the settings in force at each call.
        model: { complete: (request) => createModelClient(settings.inForce().model, { fetch, sleep }).complete(request) },
        token: base.token,
        review,
        lineUrl: githubLineUrl,
        commentUrl: githubCommentUrl,
        extensions,
        reviewUrl: githubReviewUrl,
        pullRequestUrl: githubPullRequestUrl,
        ...(ui === undefined ? {} : { ui }),
        listen: (listener, port) => new Promise<Listening>((resolve, reject) => {
          const listening = createServer(listener);
          server = listening;
          listening.once('error', reject);
          listening.listen(port, () => {
            listening.off('error', reject);
            listening.on('error', (error) => { log({ event: 'server_error', ...describeFailure(error) }); });
            log({ event: 'listening', port });
            resolve({
              close: () => { listening.close(); listening.closeIdleConnections(); return Promise.resolve(); },
            });
          });
        }),
      });
    } catch (error) {
      startFailed(error, out);
      throw error;
    }
  }, signals, (exitCode) => process.exit(exitCode), log);
  (server as Server | null)?.closeAllConnections();
  return code;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.env, (line) => { process.stdout.write(line + '\n'); }));
}
