import type { HookDelivery, HookDeliveries } from '../forge/types.ts';

export const MAX_REDELIVERIES = 200;
export const PACE_MS = 200;
export const RATE_LIMIT_WAIT_MS = 60_000;

const SHORT_CODE = /^[a-z][a-z0-9_]*$/;
const codeOf = (err: unknown): string =>
  err instanceof Error && err.message.length <= 40 && SHORT_CODE.test(err.message) ? err.message : 'internal_error';

/** Ids to send again: for each guid none of whose attempts was ok, its latest attempt; oldest first; at most `cap`. */
export function pickRedeliveries(deliveries: HookDelivery[], cap: number = MAX_REDELIVERIES): string[] {
  const latest = new Map<string, HookDelivery>();
  const done = new Set<string>();
  for (const d of deliveries) {
    if (d.ok) done.add(d.guid);
    const held = latest.get(d.guid);
    if (held === undefined || Date.parse(d.at) > Date.parse(held.at)) latest.set(d.guid, d);
  }
  return [...latest.values()]
    .filter((d) => !done.has(d.guid))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(0, cap)
    .map((d) => d.id);
}

/** Lists, picks and asks. A delivery left out by the cap counts as failed. Never rejects. */
export async function runRedelivery(
  deps: { hooks: HookDeliveries; sleep: (ms: number) => Promise<void>; log: (entry: Record<string, unknown>) => void },
  since: string,
): Promise<{ picked: number; requested: number; failed: number; complete: boolean; code: string | null }> {
  let listed = 0;
  let picked = 0;
  let requested = 0;
  let failed = 0;
  let complete = false;
  let code: string | null = null;
  try {
    const listing = await deps.hooks.listSince(since);
    listed = listing.deliveries.length;
    complete = listing.complete;
    const needed = pickRedeliveries(listing.deliveries, Number.POSITIVE_INFINITY);
    const ids = needed.slice(0, MAX_REDELIVERIES);
    const leftOut = needed.length - ids.length;       // past the cap: not asked for, so counted as failed
    picked = ids.length;
    failed = leftOut;
    for (const [index, id] of ids.entries()) {
      if (index > 0) await deps.sleep(PACE_MS);
      try {
        try {
          await deps.hooks.redeliver(id);
        } catch (err) {
          if (codeOf(err) !== 'github_rate_limited') throw err;
          await deps.sleep(RATE_LIMIT_WAIT_MS);
          await deps.hooks.redeliver(id);
        }
        requested += 1;
      } catch (err) {
        if (codeOf(err) === 'github_rate_limited') {
          code = 'github_rate_limited';
          failed = leftOut + picked - requested;
          break;
        }
        failed += 1;
      }
    }
  } catch (err) {
    code = codeOf(err);
  }
  deps.log({ event: 'redelivery', listed, picked, requested, failed, complete, code });
  return { picked, requested, failed, complete, code };
}
