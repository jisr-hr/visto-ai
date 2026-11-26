// What every page of a signed-in person reads (Task 10, rule 3): the API (a read of it answered 401 shows the sign-in page),
// who is signed in, the latest Activity the layout read, and whether its last read failed.
import { createContext, useContext } from 'react';
import type { Api } from './api.ts';
import type { Activity, ActivityJob, Me } from './api-types.ts';

export interface AppContextValue { api: Api; me: Me; activity: Activity | null; activityFailed: boolean }

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === null) throw new Error('useApp is read outside the app.');
  return value;
}

const RUNNING: ReadonlySet<string> = new Set(['waiting', 'preparing', 'reviewing', 'judging_threads', 'publishing', 'stopped']);

/**
 * The counts of "In review now" (call 19): running counts every job that runs, is stopped or waits for pushes to settle; queued
 * counts the due ones and those waiting to try again. A stage this frontend does not know is in neither.
 */
export function reviewCounts(jobs: readonly ActivityJob[]): { running: number; queued: number } {
  let running = 0;
  let queued = 0;
  for (const job of jobs) {
    if (RUNNING.has(job.stage)) running += 1;
    else if (job.stage === 'queued' || job.stage === 'retrying') queued += 1;
  }
  return { running, queued };
}
