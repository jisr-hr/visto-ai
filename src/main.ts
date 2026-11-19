import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { ConfigError, contractFile, loadConfig, serviceConfig } from './config/load.ts';
import { postgresDb, takeInstanceLock } from './db/postgres.ts';
import { createModelClient } from './engine/model/client.ts';
import { review } from './engine/review.ts';
import { createJevScorer } from './engine/scorer/jev.ts';
import { createGithubAccess } from './forge/github/access.ts';
import { createAppAuth } from './forge/github/app-auth.ts';
import { createGithubHookDeliveries } from './forge/github/hook-deliveries.ts';
import { githubLineUrl } from './forge/github/links.ts';
import { createGithubWebhookReader } from './forge/github/webhook.ts';
import { startService } from './service.ts';
import type { Listening } from './service.ts';
import type { RequestLike, ResponseLike } from './shell/http.ts';

// Node's default lets a caller take five minutes to send a request, and each such caller holds one of the 20 places.
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEADERS_TIMEOUT_MS = 10_000;

class UsageError extends Error {}

export function createServer(listener: (req: RequestLike, res: ResponseLike) => void): Server {
  return createHttpServer({ requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: HEADERS_TIMEOUT_MS }, listener);
}

function configPath(argv: string[]): string {
  if (argv.length === 2 && argv[0] === '--config' && !argv[1]!.startsWith('--')) return argv[1]!;
  throw new UsageError('usage: main --config <path>');
}

/** The error's name and, when it is a string, its code. Never its message. */
function describe(error: unknown): { error: string; code: string | null } {
  const o = typeof error === 'object' && error !== null ? error as { name?: unknown; code?: unknown } : {};
  return { error: typeof o.name === 'string' ? o.name : 'unknown', code: typeof o.code === 'string' ? o.code : null };
}

function log(entry: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export async function main(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<number> {
  let config;
  try {
    const path = configPath(argv);
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
    log({ event: 'start_failed', ...describe(error) });
    return 1;
  }

  let server: Server | null = null;
  let service: Awaited<ReturnType<typeof startService>>;
  try {
    const { fetch } = globalThis;
    const clock = (): Date => new Date();
    const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });
    // A key that cannot be read throws here and fails the start.
    const auth = createAppAuth({ appId: config.app.id, privateKey: config.app.privateKey, fetch, clock });
    const engine = {
      model: createModelClient(config.model, { fetch, sleep }),
      contract: readFileSync(join(import.meta.dirname, '..', 'contract', contractFile(config)), 'utf8'),
      clock,
      token: () => randomBytes(8).toString('hex'),
      log,
      ...(config.scorer === null ? {} : { scorer: createJevScorer(config.scorer, { fetch, sleep }) }),
    };
    service = await startService(config, {
      db: postgresDb(config.database.url, log),
      reader: createGithubWebhookReader(config.app.webhookSecret),
      clock,
      log,
      takeLock: () => takeInstanceLock(config.database.url, () => {
        log({ event: 'instance_lock_lost' });
        process.exit(1);
      }),
      forge: createGithubAccess({ auth, fetch }),
      hooks: createGithubHookDeliveries({ auth, fetch }),
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
      listen: (listener, port) => new Promise<Listening>((resolve, reject) => {
        const listening = createServer(listener);
        server = listening;
        listening.once('error', reject);
        listening.listen(port, () => {
          listening.off('error', reject);
          listening.on('error', (error) => { log({ event: 'server_error', ...describe(error) }); });
          log({ event: 'listening', port });
          resolve({
            close: () => { listening.close(); listening.closeIdleConnections(); return Promise.resolve(); },
          });
        });
      }),
    });
  } catch (error) {
    (server as Server | null)?.closeAllConnections();
    out('start_failed');
    log({ event: 'start_failed', ...describe(error) });
    return 1;
  }

  // PM-drain: the first signal stops the service cleanly, a second one ends the process at once.
  return new Promise<number>((resolve) => {
    let signals = 0;
    const onSignal = (): void => {
      signals += 1;
      if (signals > 1) process.exit(1);
      log({ event: 'stopping' });
      service.stop().then(
        () => 0,
        (error: unknown) => { log({ event: 'stop_failed', ...describe(error) }); return 1; },
      ).then((code) => {
        (server as Server | null)?.closeAllConnections();
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        resolve(code);
      });
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  });
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env, (line) => { process.stdout.write(line + '\n'); });
}
