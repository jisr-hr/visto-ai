import { loadMigrations, MIGRATIONS_DIR, migrate } from './db/migrate.ts';
import type { Db } from './db/types.ts';
import { repoSettingsFor } from './config/load.ts';
import type { ServiceConfig } from './config/load.ts';
import type { WebhookReader } from './forge/types.ts';
import { createListener } from './shell/http.ts';
import type { RequestLike, ResponseLike } from './shell/http.ts';
import { receive } from './shell/receive.ts';

export interface Listening { close(): Promise<void> }
export interface ServiceDeps {
  db: Db; reader: WebhookReader; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  listen: (listener: (req: RequestLike, res: ResponseLike) => void, port: number) => Promise<Listening>;
}
export const STOP_WAIT_MS = 10_000;
export const CLOSE_WAIT_MS = 5_000;

/** Migrates, then listens. `stop` closes the listener, waits for requests in flight (at most STOP_WAIT_MS), then closes the database (waiting at most CLOSE_WAIT_MS). */
export async function startService(config: ServiceConfig, deps: ServiceDeps): Promise<{ stop(): Promise<void> }> {
  const { db } = deps;
  let listening: Listening;
  const { listener, idle } = createListener({ webhook: (headers, body) => receive({
      ...deps, settingsFor: (name) => repoSettingsFor(config, name), onQueued: () => {},   // until the runner exists
    }, headers, body) });
  try {
    await migrate(db, loadMigrations(MIGRATIONS_DIR));
    listening = await deps.listen(listener, config.server.port);
  } catch (error) {
    try {
      await db.close();
    } catch {
      // the start failure is the one to report
    }
    throw error;
  }
  let stopping: Promise<void> | null = null;
  // A logger that throws must not change how stop ends.
  function say(entry: Record<string, unknown>): void {
    try {
      deps.log(entry);
    } catch {
      // nothing to do
    }
  }
  function why(error: unknown): { error: string; code: string | null } {
    const o = typeof error === 'object' && error !== null ? error as { name?: unknown; code?: unknown } : {};
    return { error: typeof o.name === 'string' ? o.name : 'unknown', code: typeof o.code === 'string' ? o.code : null };
  }
  async function stopOnce(): Promise<void> {
    try {
      try {
        await listening.close();
      } catch (error) {
        say({ event: 'listener_close_failed', ...why(error) });
      }
      let timer: NodeJS.Timeout | undefined;
      const patience = new Promise<void>((done) => { timer = setTimeout(done, STOP_WAIT_MS); });
      try {
        await Promise.race([idle(), patience]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await closeDb();
    }
  }
  async function closeDb(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const patience = new Promise<'timeout'>((done) => { timer = setTimeout(() => { done('timeout'); }, CLOSE_WAIT_MS); });
    try {
      const outcome = await Promise.race([db.close().then(() => 'closed' as const), patience]);
      if (outcome === 'timeout') say({ event: 'database_close_timeout' });
    } catch (error) {
      say({ event: 'database_close_failed', ...why(error) });
    } finally {
      clearTimeout(timer);
    }
  }
  return { stop: () => (stopping ??= stopOnce()) };
}
