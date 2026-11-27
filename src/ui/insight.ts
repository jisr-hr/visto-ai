// What the reads of the Overview, Repositories and Memory are given (the plan "The UI's Overview, Repositories and Memory"),
// and the start of their windows.
import type { DeploymentConfig } from '../config/load.ts';
import type { Db } from '../db/types.ts';
import type { QualityWindow } from './api-types.ts';
import type { QualityCache } from './quality.ts';

/** What is read once, of the config the service started with. */
export interface StartedWith {
  dryRun: boolean; learning: boolean; scorer: boolean;
  extensions: ReadonlyArray<{ name: string; parts: ReadonlyArray<'context' | 'notify' | 'alert' | 'route'> }>;
  mcpServers: readonly string[];
}
/** `inForce`: the settings the service runs on now. `quality`: the service's one cache of score quality. */
export interface InsightDeps { db: Db; clock: () => Date; inForce: () => DeploymentConfig; started: StartedWith; quality: QualityCache }

const EPOCH = '1970-01-01T00:00:00.000Z';

/** The start of a window: of `days` UTC days, today the last; `all` is the epoch. */
export function windowStart(now: Date, days: QualityWindow): string {
  if (days === 'all') return EPOCH;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1))).toISOString();
}
