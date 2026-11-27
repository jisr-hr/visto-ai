// The Overview's and dependency health's answers (UI design 1 item 1, 3.3 items 3 to 5, 3.4; calls 8, 12, 14 to 18, 22). Each is built
// field by field into the shapes of api-types.ts: no config, no secret, no stored result and no text a person wrote leaves.
import { repoSettingsFor } from '../config/load.ts';
import { approvalCounts, judgeCostPerDay, reviewedRepositories, reviewsPerDay, reviewTotals } from '../db/overview.ts';
import { spentSince } from '../db/review-runs.ts';
import { openAlerts, readHealth, recentAlerts } from '../db/status.ts';
import type { AlertRow, HealthRow } from '../db/status.ts';
import { RECENT_MS, keptDetails } from '../shell/status-store.ts';
import type {
  AlertShown, DependencyKind, DependencyPart, DependencyShown, DependencyStatus, Health, Overview, OverviewQuality, QualityState, WindowDays,
} from './api-types.ts';
import { windowStart } from './insight.ts';
import type { InsightDeps } from './insight.ts';
import { QUALITY_WAIT_MS, approvalShort, qualityKey, qualityOf } from './quality.ts';
import type { Measured } from './quality.ts';

export const QUALITY_ON_OVERVIEW = 20;
/** Repositories not kept that one Overview request measures. */
export const COLD_PER_OVERVIEW = 2;
export const OPEN_SHOWN = 50;
/** As many recent alerts as the Overview shows. */
export const RECENT_SHOWN = 5;
const MISSING_SHOWN = 50;
const TEXT_SHOWN = 200;
const DAY_MS = 86_400_000;
const WINDOWS: ReadonlyMap<string, WindowDays> = new Map<string, WindowDays>([['', 30], ['7', 7], ['30', 30], ['90', 90]]);

/** The start of the clock's UTC day. */
const dayStart = (now: Date): string => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

/** One repository's row: what the cache keeps, else (while the request's cold budget lasts) its measuring, else `computing`. */
async function qualityRow(deps: InsightDeps, name: string, days: WindowDays, cold: { left: number }): Promise<OverviewQuality> {
  const threshold = repoSettingsFor(deps.inForce(), name).scoreThreshold;
  let measured: Measured | null = deps.quality.kept(qualityKey(name, days, threshold));
  if (measured === null && cold.left > 0) {
    cold.left -= 1;
    try {
      measured = await qualityOf(deps, name, days, QUALITY_WAIT_MS);
    } catch {
      measured = { state: 'failed' };
    }
  }
  const state: QualityState = measured === null ? 'computing' : measured.state;
  const row: OverviewQuality = {
    repository: name, threshold, state,
    safety: null, benefit: null, focus: null, reverts: null, approval: approvalShort(deps, name),
  };
  if (measured !== null && measured.state === 'ready') {
    const current = measured.quality.rows.find((r) => r.current);
    if (current !== undefined) {
      row.safety = { share: current.safetyBlocks.share, part: current.safetyBlocks.part, of: current.safetyBlocks.of };
      row.benefit = { share: current.benefit.share, part: current.benefit.part, of: current.benefit.of };
      row.focus = { share: current.focus.share, part: current.focus.part, of: current.focus.of };
    }
    row.reverts = { merged: measured.quality.reverts.merged, approved: measured.quality.reverts.approved };
  }
  return row;
}

export async function overview(deps: InsightDeps, query: URLSearchParams): Promise<Overview | 'bad_request'> {
  const days = WINDOWS.get(query.get('days') ?? '');
  if (days === undefined) return 'bad_request';
  const now = deps.clock();
  const since = windowStart(now, days);
  const today = dayStart(now);
  const totals = await reviewTotals(deps.db, since);
  const today$ = await spentSince(deps.db, today);
  const approvals = await approvalCounts(deps.db, since);
  const runDays = await reviewsPerDay(deps.db, since);
  const judgeDays = await judgeCostPerDay(deps.db, since);
  const names = await reviewedRepositories(deps.db, since, QUALITY_ON_OVERVIEW);

  const byDay = new Map(runDays.map((d) => [d.day, d]));
  const judged = new Map(judgeDays.map((d) => [d.day, d.cost]));
  const start = Date.parse(since);
  const perDay: Overview['perDay'] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
    const row = byDay.get(day);
    perDay.push({ day, published: row?.published ?? 0, failed: row?.failed ?? 0, other: row?.other ?? 0, cost: (row?.cost ?? 0) + (judged.get(day) ?? 0) });
  }

  const quality: OverviewQuality[] = [];
  const cold = { left: COLD_PER_OVERVIEW };
  for (const name of names) quality.push(await qualityRow(deps, name, days, cold));

  return {
    now: now.toISOString(), days, repositories: totals.repositories,
    reviews: {
      total: totals.total, published: totals.published, dryRun: totals.dry_run, failed: totals.failed,
      nothingNew: totals.nothing_new, notPosted: totals.not_posted,
    },
    spend: { today: today$, limit: deps.inForce().limits.spendPerDay },
    approvals: { approved: approvals.approved, audited: approvals.audited },
    perDay, quality, qualityCut: Math.max(0, totals.repositories - QUALITY_ON_OVERVIEW),
  };
}

// -- health -------------------------------------------------------------------------------------------------------------------
const statusOf = (row: HealthRow | undefined): DependencyStatus => (row === undefined ? 'unknown' : row.status === 'ok' ? 'working' : 'failing');
const iso = (d: Date | undefined): string | null => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);

function missingOf(value: unknown): Array<{ feature: string; missing: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ feature: string; missing: string }> = [];
  for (const item of value) {
    if (out.length >= MISSING_SHOWN) break;
    if (typeof item !== 'object' || item === null) continue;
    const feature = (item as Record<string, unknown>).feature;
    const missing = (item as Record<string, unknown>).missing;
    if (typeof feature === 'string' && typeof missing === 'string') out.push({ feature: feature.slice(0, TEXT_SHOWN), missing: missing.slice(0, TEXT_SHOWN) });
  }
  return out;
}

/** An alert as shown, its details through the store's allowlist again; null for one whose time no ISO time writes (infinity), passed over. */
function alertShown(row: AlertRow, open: boolean): AlertShown | null {
  const raisedAt = iso(row.raised_at);
  if (raisedAt === null) return null;
  const stored = typeof row.details === 'object' && row.details !== null && !Array.isArray(row.details) ? (row.details as Record<string, unknown>) : {};
  return { id: row.id, code: row.code, details: keptDetails(stored), raisedAt, open };
}
const shownOf = (rows: readonly AlertRow[], open: boolean): AlertShown[] =>
  rows.flatMap((row) => { const shown = alertShown(row, open); return shown === null ? [] : [shown]; });

export async function health(deps: InsightDeps): Promise<Health> {
  const now = deps.clock();
  const rows = await readHealth(deps.db);
  const find = (kind: DependencyKind, name: string, part = ''): HealthRow | undefined =>
    rows.find((r) => r.kind === kind && r.name === name && r.part === part);
  const shown = (kind: DependencyKind, name: string | null, model: string | null, row: HealthRow | undefined): DependencyShown => ({
    kind, name, model, status: statusOf(row), code: row?.status === 'failing' ? row.code : null,
    since: iso(row?.since), seenAt: iso(row?.seen_at), parts: [], missing: [],
  });

  const config = deps.inForce();
  const dependencies: DependencyShown[] = [shown('model', null, config.model.model, find('model', ''))];
  if (deps.started.scorer) dependencies.push(shown('scorer', null, config.scorer?.model ?? null, find('scorer', '')));
  if (deps.started.learning) dependencies.push(shown('memory', null, null, find('memory', '')));
  for (const extension of deps.started.extensions) {
    const parts: DependencyPart[] = extension.parts.map((part) => {
      const row = part === 'alert' ? undefined : find('extension', extension.name, part);
      return { part, status: statusOf(row), code: row?.status === 'failing' ? row.code : null, since: iso(row?.since) };
    });
    const partRows = extension.parts.flatMap((part) => (part === 'alert' ? [] : [find('extension', extension.name, part)])).filter((r): r is HealthRow => r !== undefined);
    const failing = partRows.find((r) => r.status === 'failing');
    const decisive = failing ?? partRows.find((r) => r.status === 'ok');
    const seen = partRows.map((r) => r.seen_at.getTime());
    dependencies.push({
      kind: 'extension', name: extension.name, model: null,
      status: failing !== undefined ? 'failing' : decisive !== undefined ? 'working' : 'unknown',
      code: failing?.code ?? null, since: iso(decisive?.since), seenAt: seen.length === 0 ? null : new Date(Math.max(...seen)).toISOString(),
      parts, missing: [],
    });
  }
  for (const server of deps.started.mcpServers) dependencies.push(shown('mcp', server, null, find('mcp', server)));
  const app = find('app', '');
  dependencies.push({ ...shown('app', null, null, app), missing: app === undefined ? [] : missingOf(app.missing) });

  // The recent ones are those not open by the open rule, so an open alert past the ones shown is never read as resolved.
  const today = dayStart(now);
  const open = await openAlerts(deps.db, today, OPEN_SHOWN);
  const recent = await recentAlerts(deps.db, new Date(now.getTime() - RECENT_MS).toISOString(), today, RECENT_SHOWN);
  return { now: now.toISOString(), dependencies, open: shownOf(open, true), recent: shownOf(recent, false) };
}
