// Memory's answers (UI design 1 item 3, 3.3 item 7; calls 30 to 33 and 35): the learned records with their words and places,
// and the switch of one. Each is built field by field into the shapes of api-types.ts: no source reference, comment id, category or reason leaves.
import { countShown, memoryCounts, shownRecord, shownRecords, switchRecord } from '../db/memory-records.ts';
import type { MemoryFilter, ShownRow } from '../db/memory-records.ts';
import { readLearning } from '../db/learning.ts';
import { WORK } from '../shell/learning.ts';
import type { MemoryKind, MemoryRecordShown, MemoryView } from './api-types.ts';
import type { InsightDeps } from './insight.ts';
import { clip } from './review-result.ts';

export const MEMORY_PAGE = 50;
export const TEXT_CHARS = 1000;
const KINDS: ReadonlySet<string> = new Set<MemoryKind>(['human_signal', 'revert', 'lesson']);
const REPO = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/;
const ID_MAX = 2_147_483_647;
const NUL = String.fromCharCode(0);

function shown(row: ShownRow): MemoryRecordShown {
  const text = row.kind === 'human_signal' ? row.excerpt : row.kind === 'lesson' ? (row.lesson ?? '') : '';
  return {
    id: row.id, kind: row.kind, repository: `${row.owner}/${row.repo}`, number: row.number, text: clip(text, TEXT_CHARS),
    path: row.path, directory: row.directory,
    by: row.kind === 'human_signal' ? row.by : null, reverted: row.kind === 'revert' ? row.reverted : null,
    createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), on: row.status === 'active',
  };
}

/** The filter a query holds, or null when it is malformed. A parameter written empty reads as absent. */
function filterOf(query: URLSearchParams): MemoryFilter | null {
  const kind = query.get('kind') ?? '';
  const repo = (query.get('repo') ?? '').toLowerCase();
  const q = (query.get('q') ?? '').trim();
  const before = query.get('before') ?? '';
  if (kind !== '' && !KINDS.has(kind)) return null;
  if (repo !== '' && !REPO.test(repo)) return null;
  if (q.length > 100 || q.includes(NUL)) return null;
  if (before !== '' && (!/^\d{1,10}$/.test(before) || Number(before) > ID_MAX)) return null;
  const slash = repo.indexOf('/');
  return {
    repo: repo === '' ? null : { service: 'github', owner: repo.slice(0, slash), repo: repo.slice(slash + 1) },
    kind: kind === '' ? null : (kind as MemoryKind),
    text: q === '' ? null : '%' + q.replaceAll(/[\\%_]/g, (c) => '\\' + c) + '%',
    before: before === '' ? null : Number(before),
  };
}

export async function memory(deps: InsightDeps, query: URLSearchParams): Promise<MemoryView | 'bad_request'> {
  const filter = filterOf(query);
  if (filter === null) return 'bad_request';
  const now = deps.clock().toISOString();
  const rows = await shownRecords(deps.db, filter, now, MEMORY_PAGE + 1);
  const total = await countShown(deps.db, filter, now);
  const counts = await memoryCounts(deps.db, now);
  const state = await readLearning(deps.db, WORK);
  const page = rows.slice(0, MEMORY_PAGE);
  return {
    now, learning: { on: deps.started.learning, ranAt: state?.ranAt ?? null },
    counts: {
      signals: counts.signals, signalRepositories: counts.signal_repositories, reverts: counts.reverts, lessons: counts.lessons, off: counts.off,
    },
    total, records: page.map(shown), next: rows.length > MEMORY_PAGE ? page[MEMORY_PAGE - 1]!.id : null,
  };
}

/** The body of a switch: exactly the key `on`, a boolean. */
export function switchOf(body: Record<string, unknown>): { on: boolean } | null {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'on' || typeof body['on'] !== 'boolean') return null;
  return { on: body['on'] };
}

/** The record after the switch; null when it is not there or expired. A switch to the state it is in changes and logs nothing. */
export async function switchMemory(
  deps: InsightDeps & { log: (entry: Record<string, unknown>) => void }, id: number, on: boolean, by: string,
): Promise<MemoryRecordShown | null> {
  const now = deps.clock().toISOString();
  const changed = await switchRecord(deps.db, id, on, by, now);
  const row = await shownRecord(deps.db, id, now);
  if (row === null) return null;
  if (changed) deps.log({ event: 'memory_switch', record: id, on });
  return shown(row);
}
