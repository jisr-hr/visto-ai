// The store of alerts and of each dependency's state, told by the alerts and the health objects (the UI plan's Overview; calls 6 to 13).
// Every write is queued on one chain and never in the way: a write that fails or is too many is logged once, without any value, and dropped.
import { clearAlerts, pruneAlerts, storeAlert, writeHealth } from '../db/status.ts';
import type { HealthKind } from '../db/status.ts';
import { storable } from '../db/text.ts';
import type { Db } from '../db/types.ts';
import { codeOf, isShortCode } from './codes.ts';

export const SEEN_WRITE_MS = 60_000;
export const ALERT_KEEP_MS = 30 * 86_400_000;
export const RECENT_MS = 7 * 86_400_000;
export const MAX_WAITING = 200;
const MAX_MISSING = 50;
const MAX_TEXT = 200;
const EPOCH = '1970-01-01T00:00:00.000Z';
const DAY_MS = 86_400_000;

export interface HealthNote {
  kind: HealthKind; name: string; part: string; ok: boolean; code: string | null;
  missing?: ReadonlyArray<{ feature: string; missing: string }>;
}

export interface StatusStore {
  /** An alert as raised (call 6): queued; never throws. */
  alerted(code: string, details: Record<string, string | number | boolean | null>): void;
  /** What a dependency was just seen to do (call 13): queued; never throws. */
  noted(note: HealthNote): void;
  /** A start's check read the app (call 10): its state, then every open feature_off cleared; queued; never throws. */
  appChecked(lacking: ReadonlyArray<{ feature: string; missing: string }>): void;
  /** Deletes the alerts past keeping (call 11): queued, not waited for; never throws. */
  prune(): void;
  /** Resolves when nothing is queued or under way. */
  settled(): Promise<void>;
  /** From now on every write told is dropped, unlogged (call 13): the service calls it once the queue settled, before the database closes. */
  close(): void;
}

const OPENERS: Record<string, true> = { model_error: true, mcp_error: true, extension_error: true, memory_error: true };
const CLOSERS: Record<string, true> = { model_ok: true, mcp_ok: true, extension_ok: true, memory_ok: true };
const SPEND: Record<string, true> = { spend_80: true, spend_limit: true };
/** The details an alert keeps (call 6's allowlist), stored and shown alike. */
export const KEPT_DETAILS: readonly string[] = ['reason', 'seen_by', 'server', 'extension', 'part', 'spent', 'limit', 'hours', 'feature', 'missing', 'failed', 'complete', 'repo', 'number'];

/** An alert's key (call 7). */
export function alertKey(code: string, details: Record<string, unknown>): string {
  const read = (name: string): string => (details[name] === undefined || details[name] === null ? '' : String(details[name]));
  switch (code) {
    case 'mcp_error': return read('server');
    case 'extension_error': return `${read('extension')}/${read('part')}`;
    case 'feature_off': return `${read('feature')}:${read('missing')}`;
    case 'dismissal_failed':
    case 'stale_approval_merged': return `${read('repo')}#${read('number')}`.toLowerCase();
    default: return '';
  }
}

/** The allowlisted details: a string cut at 200 characters, a finite number or a boolean; anything else is left out. */
export function keptDetails(details: Record<string, unknown>): Record<string, string | number | boolean> {
  const kept: Record<string, string | number | boolean> = {};
  for (const name of KEPT_DETAILS) {
    const value = details[name];
    if (typeof value === 'string') kept[name] = storable(value.slice(0, MAX_TEXT));
    else if (typeof value === 'number' && Number.isFinite(value)) kept[name] = value;
    else if (typeof value === 'boolean') kept[name] = value;
  }
  return kept;
}

function pairOf(note: HealthNote): { code: string; key: string } | null {
  switch (note.kind) {
    case 'model': return { code: 'model_error', key: '' };
    case 'memory': return { code: 'memory_error', key: '' };
    case 'mcp': return { code: 'mcp_error', key: note.name };
    case 'extension': return { code: 'extension_error', key: `${note.name}/${note.part}` };
    default: return null;
  }
}

export function createStatusStore(deps: { db: Db; clock: () => Date; log: (entry: Record<string, unknown>) => void }): StatusStore {
  const { db } = deps;
  let tail: Promise<void> = Promise.resolve();
  let waiting = 0;
  let closed = false;
  const written = new Map<string, { at: number; ok: boolean; code: string | null; missing: string }>();

  function safeLog(entry: Record<string, unknown>): void {
    try { deps.log(entry); } catch { /* a logger that throws stops nothing */ }
  }

  /** Logs a failure; its code is read inside the guard, so an error whose message cannot be read stops nothing either. */
  function failed(what: string, error: unknown): void {
    try { deps.log({ event: 'status_store_failed', what, reason: codeOf(error) }); } catch { /* nothing more to do */ }
  }

  /** True when the write was queued. A write whose turn comes after the close is not sent (call 13). */
  function enqueue(what: string, work: () => Promise<unknown>): boolean {
    if (closed) return false;
    if (waiting >= MAX_WAITING) {
      safeLog({ event: 'status_store_full', what });
      return false;
    }
    waiting++;
    // The chain never stays rejected: whatever a write does, the next one runs.
    tail = tail.then(async () => {
      try {
        if (!closed) await work();
      } catch (error) {
        failed(what, error);
      } finally {
        waiting--;
      }
    }).catch(() => undefined);
    return true;
  }

  /** The clock's time, or null (logged) when it cannot be read. */
  function now(what: string): Date | null {
    try {
      const at = deps.clock();
      if (Number.isNaN(at.getTime())) throw new Error('clock');
      return at;
    } catch (error) {
      failed(what, error);
      return null;
    }
  }

  function write(note: HealthNote, force: boolean): void {
    const at = now('health');
    if (at === null) return;
    const ok = note.ok;
    const code = ok ? null : (typeof note.code === 'string' && isShortCode(note.code) ? note.code : 'internal_error');
    const missing = (note.missing ?? []).slice(0, MAX_MISSING)
      .map((m) => ({ feature: storable(String(m.feature).slice(0, MAX_TEXT)), missing: storable(String(m.missing).slice(0, MAX_TEXT)) }));
    const missingText = JSON.stringify(missing);
    const key = JSON.stringify([note.kind, note.name, note.part]);
    const last = written.get(key);
    if (!force && last !== undefined && last.ok === ok && last.code === code && last.missing === missingText && at.getTime() - last.at < SEEN_WRITE_MS) return;
    const iso = at.toISOString();
    const entry = { at: at.getTime(), ok, code, missing: missingText };
    const queued = enqueue('health', async () => {
      try {
        await writeHealth(db, { kind: note.kind, name: note.name, part: note.part, ok, code, missing: missing.length === 0 ? null : missing, at: iso });
      } catch (error) {
        if (written.get(key) === entry) written.delete(key);
        throw error;
      }
    });
    if (!queued) return;
    written.set(key, entry);
    const pair = ok ? pairOf(note) : null;
    if (pair === null) return;
    // A clear that fails or is dropped forgets the note, so the next one is written and clears again.
    const forget = (): void => { if (written.get(key) === entry) written.delete(key); };
    const cleared = enqueue('clear', async () => {
      try {
        await clearAlerts(db, pair.code, pair.key, iso);
      } catch (error) {
        forget();
        throw error;
      }
    });
    if (!cleared) forget();
  }

  return {
    alerted(code, details) {
      try {
        if (closed || CLOSERS[code] === true) return;
        const at = now('alert');
        if (at === null) return;
        const kept = keptDetails(details);
        const dedupeSince = OPENERS[code] === true ? EPOCH
          : SPEND[code] === true ? new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS).toISOString() : null;
        const key = alertKey(code, kept);
        const iso = at.toISOString();
        enqueue('alert', () => storeAlert(db, { code, key, details: kept, at: iso, dedupeSince }));
      } catch (error) {
        failed('alert', error);
      }
    },
    noted(note) {
      try { if (!closed) write(note, false); } catch (error) { failed('health', error); }
    },
    appChecked(lacking) {
      try {
        if (closed) return;
        const ok = lacking.length === 0;
        write({ kind: 'app', name: '', part: '', ok, code: ok ? null : 'missing', missing: lacking.slice(0, MAX_MISSING) }, true);
        const at = now('clear');
        if (at === null) return;
        const iso = at.toISOString();
        enqueue('clear', () => clearAlerts(db, 'feature_off', null, iso));
      } catch (error) {
        failed('health', error);
      }
    },
    prune() {
      try {
        if (closed) return;
        const at = now('prune');
        if (at === null) return;
        const before = new Date(at.getTime() - ALERT_KEEP_MS).toISOString();
        enqueue('prune', () => pruneAlerts(db, before));
      } catch (error) {
        failed('prune', error);
      }
    },
    async settled() {
      while (waiting > 0) await tail;
    },
    close() {
      closed = true;
    },
  };
}
