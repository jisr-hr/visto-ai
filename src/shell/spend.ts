import { spentSince } from '../db/review-runs.ts';
import type { Db } from '../db/types.ts';
import type { Alert } from './alerts.ts';

export const WARN_SHARE = 0.8;
export type SpendLevel = 'ok' | 'warn' | 'limit';

export function createSpendGuard(deps: { db: Db; limit: number; clock: () => Date; alert: Alert }): {
  /** Today's level, from the cost of the runs recorded since the start of the UTC day. Rejects when the database does. */
  level(): Promise<SpendLevel>;
  /** One run's usage: tokens with no cost raise `cost_unknown`, once per process. */
  noteRun(usage: { inputTokens: number; outputTokens: number; cost: number }): void;
} {
  let day = '';
  let warned = false;
  let limited = false;
  let costWarned = false;

  return {
    async level() {
      const now = deps.clock();
      const today = now.toISOString().slice(0, 10);
      if (today !== day) { day = today; warned = false; limited = false; }
      const spent = await spentSince(deps.db, `${today}T00:00:00.000Z`);
      const details = { spent: Math.round(spent * 100) / 100, limit: deps.limit };
      if (spent >= deps.limit) {
        if (!limited) deps.alert('spend_limit', details);
        limited = true;
        warned = true;
        return 'limit';
      }
      if (spent >= WARN_SHARE * deps.limit) {
        if (!warned) deps.alert('spend_80', details);
        warned = true;
        return 'warn';
      }
      return 'ok';
    },
    noteRun(usage) {
      if (costWarned || usage.cost > 0 || usage.inputTokens + usage.outputTokens === 0) return;
      costWarned = true;
      deps.alert('cost_unknown');
    },
  };
}
