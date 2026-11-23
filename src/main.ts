import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { ConfigError, contractFile, loadConfig, serviceConfig } from './config/load.ts';
import { postgresDb, takeInstanceLock } from './db/postgres.ts';
import type { InstanceLock } from './db/types.ts';
import { createModelClient } from './engine/model/client.ts';
import { review } from './engine/review.ts';
import { createJevScorer } from './engine/scorer/jev.ts';
import { contextProvidersOf, loadExtensions } from './extensions/load.ts';
import type { LoadedExtension } from './extensions/types.ts';
import { createGithubAccess } from './forge/github/access.ts';
import { createAppAuth } from './forge/github/app-auth.ts';
import { createAppInfo } from './forge/github/app-info.ts';
import { createGithubChecks } from './forge/github/checks.ts';
import { createGithubHookDeliveries } from './forge/github/hook-deliveries.ts';
import { githubCommentUrl, githubLineUrl, githubPullRequestUrl, githubReviewUrl } from './forge/github/links.ts';
import { createGithubWebhookReader } from './forge/github/webhook.ts';
import { createGithubWriter } from './forge/github/writer.ts';
import { startService } from './service.ts';
import type { Listening } from './service.ts';
import { createFeedback } from './shell/feedback.ts';
import type { RequestLike, ResponseLike } from './shell/http.ts';

// Node's default lets a caller take five minutes to send a request, and each such caller holds one of the 20 places.
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEADERS_TIMEOUT_MS = 10_000;

/** The time limit of one call to GitHub, its body included (call 50). */
export const GITHUB_CALL_MS = 60_000;

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

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

/**
 * Runs `start` and stops what it started on the first signal, also one that arrives before `start` has resolved.
 * A second signal calls exit(1). A start that rejects logs { event: 'start_failed', ...describeFailure } and resolves 1.
 * Resolves 0 after a stop.
 */
// PM-drain: the first signal stops the service cleanly, a second one ends the process at once.
export function runUntilSignal(
  start: () => Promise<{ stop(): Promise<void> }>,
  signals: { on(listener: () => void): void; off(listener: () => void): void },
  exit: (code: number) => void,
  log: (entry: Record<string, unknown>) => void,
): Promise<number> {
  return new Promise<number>((resolve) => {
    let count = 0;
    let service: { stop(): Promise<void> } | null = null;
    const finish = (code: number): void => { signals.off(onSignal); resolve(code); };
    const stop = (running: { stop(): Promise<void> }): void => {
      running.stop().then(
        () => 0,
        (error: unknown) => { log({ event: 'stop_failed', ...describeFailure(error) }); return 1; },
      ).then(finish);
    };
    function onSignal(): void {
      count += 1;
      if (count > 1) { exit(1); return; }
      log({ event: 'stopping' });
      if (service !== null) stop(service);
    }
    signals.on(onSignal);
    start().then(
      (started) => {
        service = started;
        if (count > 0) stop(started);
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
  try {
    const path = configPath(argv);
    // A module's relative path starts at the folder of the config file.
    configDir = dirname(resolve(path));
    try {
      config = serviceConfig(loadConfig(path, env));
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
  const code = await runUntilSignal(async () => {
    try {
      const { fetch } = globalThis;
      // Every GitHub adapter is given the fetch with a time limit; the model, the scorer and the alerts keep their own.
      const github = boundedFetch(fetch);
      const clock = (): Date => new Date();
      const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });
      // A key that cannot be read throws here and fails the start.
      const auth = createAppAuth({ appId: config.app.id, privateKey: config.app.privateKey, fetch: github, clock });
      const info = createAppInfo({ auth, fetch: github });
      const base = {
        model: createModelClient(config.model, { fetch, sleep }),
        contract: readFileSync(join(import.meta.dirname, '..', 'contract', contractFile(config)), 'utf8'),
        clock,
        token: () => randomBytes(8).toString('hex'),
        log,
        ...(config.scorer === null ? {} : { scorer: createJevScorer(config.scorer, { fetch, sleep }) }),
      };
      // Every adapter is made before the lock is taken: from the lock on, nothing throws before the service holds it.
      const reader = createGithubWebhookReader(config.app.webhookSecret);
      const forge = createGithubAccess({ auth, fetch: github });
      const hooks = createGithubHookDeliveries({ auth, fetch: github });
      const writer = createGithubWriter({ auth, info, fetch: github });
      const checks = createGithubChecks({ auth, appId: config.app.id, fetch: github });
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
      const providers = contextProvidersOf(extensions);
      const engine = { ...base, ...(providers.length === 0 ? {} : { contextProviders: providers }) };
      return await startService(config, {
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
        fetch,
        sleep,
        every: (ms, work) => {
          const timer = setInterval(() => { void work(); }, ms);
          timer.unref();
          return () => { clearInterval(timer); };
        },
        engineDeps: (source) => ({ source, ...engine }),
        review,
        lineUrl: githubLineUrl,
        commentUrl: githubCommentUrl,
        extensions,
        reviewUrl: githubReviewUrl,
        pullRequestUrl: githubPullRequestUrl,
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
      out('start_failed');
      throw error;
    }
  }, signals, (exitCode) => process.exit(exitCode), log);
  (server as Server | null)?.closeAllConnections();
  return code;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.env, (line) => { process.stdout.write(line + '\n'); }));
}
