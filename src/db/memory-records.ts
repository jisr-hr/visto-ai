import { storable, storableJson } from './text.ts';
import type { Db } from './types.ts';

export interface RepoKey { service: 'github'; owner: string; repo: string }
export type RecordKind = 'human_signal' | 'revert' | 'lesson';
export interface NewRecord {
  kind: RecordKind;
  sourceRef: string;            // what it was made from; unique for a repository and a kind
  number: number;               // the pull request it came from
  path: string | null; directory: string | null;
  category: string | null; reason: string | null;   // of the block's score, when the review had scored it
  missed: boolean;              // the review had left that code below the threshold
  excerpt: string;              // the start of what the person wrote; '' when there is none
  comment: string | null;       // the id of the comment the excerpt came from
  createdAt: string; expiresAt: string;
  lesson?: string | null;       // a lesson's text; absent reads as null
  reverted?: number | null;     // of a record of a revert: the pull request that was reverted; absent reads as null
}
/** What a lookup reads of a record: never its excerpt or its reason. */
export interface LiveRow { id: number; sourceRef: string; number: number; path: string | null; directory: string | null; category: string | null; missed: boolean; createdAt: string }
/** What a read of lessons hands back: never the quote. */
export interface LessonRow { id: number; sourceRef: string; number: number; path: string; lesson: string; createdAt: string }
/** What a read of reverts hands back. */
export interface RevertRow { id: number; sourceRef: string; number: number; reverted: number; path: string; directory: string; createdAt: string }

const lowered = (repo: RepoKey): RepoKey => ({
  service: repo.service, owner: storable(repo.owner).toLowerCase(), repo: storable(repo.repo).toLowerCase(),
});

/** Adds the records not yet stored (same repository, kind and source reference). One already stored is left as it is, whatever its status. Returns how many were added. */
export async function addRecords(db: Db, repo: RepoKey, records: NewRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  const r = lowered(repo);
  const rows = records.map((x) => ({
    kind: x.kind, source_ref: x.sourceRef, number: x.number, path: x.path, directory: x.directory,
    category: x.category, reason: x.reason, missed: x.missed, excerpt: x.excerpt, comment: x.comment,
    created_at: x.createdAt, expires_at: x.expiresAt, lesson: x.lesson ?? null, reverted: x.reverted ?? null,
  }));
  const added = await db.query(
    `insert into visto_ai.memory_records
       (service, owner, repo, kind, source_ref, created_at, expires_at, number, path, directory, category, reason, missed, excerpt, comment, lesson, reverted)
     select $1, $2, $3, s.kind, s.source_ref, s.created_at, s.expires_at, s.number, s.path, s.directory, s.category, s.reason, s.missed, s.excerpt, s.comment, s.lesson, s.reverted
     from jsonb_to_recordset($4::jsonb) as s(kind text, source_ref text, number integer, path text, directory text, category text,
                                              reason text, missed boolean, excerpt text, comment text, created_at timestamptz, expires_at timestamptz,
                                              lesson text, reverted integer)
     on conflict (service, owner, repo, kind, source_ref) do nothing
     returning id`,
    [r.service, r.owner, r.repo, storableJson(rows)]);
  return added.length;
}

interface LiveDbRow {
  id: number; source_ref: string; number: number; path: string | null; directory: string | null;
  category: string | null; missed: boolean; created_at: unknown;
}

// A time as the driver hands it back, as an ISO time; null for one that cannot be read as one (-infinity, a date before the year 1, ...).
export function isoOf(value: unknown): string | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  try {
    return value.toISOString();
  } catch {
    return null;
  }
}

/**
 * The repository's records of that kind live at `at`: status active, made at or before it, expiring after it. Newest first (made, then id), at most `limit`.
 * `except`: a pull request whose records are left out, so that they take no place in the limit. A row whose time cannot be read is passed over.
 */
export async function liveRecords(db: Db, repo: RepoKey, kind: RecordKind, at: string, limit: number, except?: number): Promise<LiveRow[]> {
  const r = lowered(repo);
  const rows = await db.query<LiveDbRow>(
    `select id, source_ref, number, path, directory, category, missed, created_at
     from visto_ai.memory_records
     where service = $1 and owner = $2 and repo = $3 and kind = $4
       and status = 'active' and created_at <= $5::timestamptz and expires_at > $5::timestamptz
       and ($7::integer is null or number <> $7::integer)
     order by created_at desc, id desc
     limit $6`,
    [r.service, r.owner, r.repo, kind, at, limit, except ?? null]);
  const out: LiveRow[] = [];
  for (const x of rows) {
    const createdAt = isoOf(x.created_at);
    if (createdAt === null) continue;
    out.push({ id: x.id, sourceRef: x.source_ref, number: x.number, path: x.path, directory: x.directory, category: x.category, missed: x.missed, createdAt });
  }
  return out;
}

/**
 * `liveRecords` in one transaction of its own that first sets its statement limit to `ms` milliseconds. `local`: the limit ends with the
 * transaction, and no other query of the pool is held to it. A `set` takes no bound parameter, so `ms` is written into the statement, only
 * once it is a whole number above 0; anything else rejects with Error('bad_statement_limit') before any statement.
 */
export async function liveRecordsWithin(db: Db, repo: RepoKey, kind: RecordKind, at: string, limit: number, ms: number, except?: number): Promise<LiveRow[]> {
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms <= 0) throw new Error('bad_statement_limit');
  return db.transaction(async (tx) => {
    await tx.query(`set local statement_timeout = ${ms}`);
    return liveRecords(tx, repo, kind, at, limit, except);
  });
}

interface LessonDbRow { id: number; source_ref: string; number: number; path: string; lesson: string; created_at: unknown }

/**
 * The repository's lessons live at `at`: active, made at or before it, expiring after it, with a path and a text. Newest first (made, then id), at most `limit`.
 * `except`: a pull request whose lessons are left out. A row whose time cannot be read is passed over.
 */
export async function liveLessons(db: Db, repo: RepoKey, at: string, limit: number, except?: number): Promise<LessonRow[]> {
  const r = lowered(repo);
  const rows = await db.query<LessonDbRow>(
    `select id, source_ref, number, path, lesson, created_at
     from visto_ai.memory_records
     where service = $1 and owner = $2 and repo = $3 and kind = 'lesson'
       and status = 'active' and created_at <= $4::timestamptz and expires_at > $4::timestamptz
       and path is not null and lesson is not null
       and ($6::integer is null or number <> $6::integer)
     order by created_at desc, id desc
     limit $5`,
    [r.service, r.owner, r.repo, at, limit, except ?? null]);
  const out: LessonRow[] = [];
  for (const x of rows) {
    const createdAt = isoOf(x.created_at);
    if (createdAt === null) continue;
    out.push({ id: x.id, sourceRef: x.source_ref, number: x.number, path: x.path, lesson: x.lesson, createdAt });
  }
  return out;
}

/** `liveLessons` in one transaction that first sets its statement limit to `ms`, as `liveRecordsWithin` does, with the same refusal of a bad `ms`. */
export async function liveLessonsWithin(db: Db, repo: RepoKey, at: string, limit: number, ms: number, except?: number): Promise<LessonRow[]> {
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms <= 0) throw new Error('bad_statement_limit');
  return db.transaction(async (tx) => {
    await tx.query(`set local statement_timeout = ${ms}`);
    return liveLessons(tx, repo, at, limit, except);
  });
}

interface RevertDbRow { id: number; source_ref: string; number: number; reverted: number; path: string; directory: string; created_at: unknown }

/**
 * The repository's records of reverts live at `at`, with a path, a directory and a reverted pull request. Newest first (made, then id), at most `limit`.
 * `except`: a pull request that is shown none of them, the one that made the revert and the one reverted alike. A row whose time cannot be read is passed over.
 */
export async function liveReverts(db: Db, repo: RepoKey, at: string, limit: number, except?: number): Promise<RevertRow[]> {
  const r = lowered(repo);
  const rows = await db.query<RevertDbRow>(
    `select id, source_ref, number, reverted, path, directory, created_at
     from visto_ai.memory_records
     where service = $1 and owner = $2 and repo = $3 and kind = 'revert'
       and status = 'active' and created_at <= $4::timestamptz and expires_at > $4::timestamptz
       and path is not null and directory is not null and reverted is not null
       and ($6::integer is null or (number <> $6::integer and reverted <> $6::integer))
     order by created_at desc, id desc
     limit $5`,
    [r.service, r.owner, r.repo, at, limit, except ?? null]);
  const out: RevertRow[] = [];
  for (const x of rows) {
    const createdAt = isoOf(x.created_at);
    if (createdAt === null) continue;
    out.push({ id: x.id, sourceRef: x.source_ref, number: x.number, reverted: x.reverted, path: x.path, directory: x.directory, createdAt });
  }
  return out;
}

/** `liveReverts` in one transaction that first sets its statement limit to `ms`, as `liveRecordsWithin` does, with the same refusal of a bad `ms`. */
export async function liveRevertsWithin(db: Db, repo: RepoKey, at: string, limit: number, ms: number, except?: number): Promise<RevertRow[]> {
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms <= 0) throw new Error('bad_statement_limit');
  return db.transaction(async (tx) => {
    await tx.query(`set local statement_timeout = ${ms}`);
    return liveReverts(tx, repo, at, limit, except);
  });
}

/** The texts of the repository's lessons that are active or disabled and expire after `at`, newest first, at most `limit`. */
export async function standingLessons(db: Db, repo: RepoKey, at: string, limit: number): Promise<string[]> {
  const r = lowered(repo);
  const rows = await db.query<{ lesson: string }>(
    `select lesson from visto_ai.memory_records
     where service = $1 and owner = $2 and repo = $3 and kind = 'lesson'
       and status in ('active', 'disabled') and expires_at > $4::timestamptz and lesson is not null
     order by created_at desc, id desc
     limit $5`,
    [r.service, r.owner, r.repo, at, limit]);
  return rows.map((x) => x.lesson);
}

/** Every active record whose expiry is at or before `now` becomes expired. Returns how many. */
export async function retireExpired(db: Db, now: string): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `with retired as (
       update visto_ai.memory_records set status = 'expired'
       where status = 'active' and expires_at <= $1::timestamptz
       returning 1
     )
     select count(*)::int as n from retired`,
    [now]);
  return rows[0]!.n;
}

// -- what the UI shows of the records, and the switch (the plan "The UI's Overview, Repositories and Memory"; Task 7) --------
/** A record as the screens read it: the commenter of a person's record comes from the stored comment; a time as the driver hands it back. */
export interface ShownRow {
  id: number; owner: string; repo: string; kind: RecordKind; number: number; path: string | null; directory: string | null;
  excerpt: string; lesson: string | null; reverted: number | null; status: 'active' | 'disabled'; created_at: unknown; expires_at: unknown; by: string | null;
}
/** `text`: the ilike pattern, already escaped. */
export interface MemoryFilter { repo: RepoKey | null; kind: RecordKind | null; text: string | null; before: number | null }

/** The records the screens show, of `r`: on or off, not expired at $1. One condition for the read, its count and the counts. */
const SHOWN = `r.status in ('active', 'disabled') and r.expires_at > $1::timestamptz`;

const SHOWN_SELECT = `select r.id, r.owner, r.repo, r.kind, r.number, r.path, r.directory, r.excerpt, r.lesson, r.reverted, r.status, r.created_at, r.expires_at,
       a.author as by
from visto_ai.memory_records r
left join visto_ai.human_activity a
  on r.kind = 'human_signal' and a.service = r.service and a.kind = 'inline_comment' and a.source_id = r.comment
where ${SHOWN}`;

// The search: the path, the directory, the person's words of a record of people stepping in, the lesson; a lesson's quote, kept in
// `excerpt` and shown by no screen, is never searched.
const SHOWN_FILTER = `
  and ($2::text is null or (r.owner = $2 and r.repo = $3)) and ($4::text is null or r.kind = $4)
  and ($5::text is null or r.path ilike $5 escape '\\' or r.directory ilike $5 escape '\\'
       or (r.kind = 'human_signal' and r.excerpt ilike $5 escape '\\') or r.lesson ilike $5 escape '\\')`;

function filterParams(f: MemoryFilter, now: string): unknown[] {
  const r = f.repo === null ? null : lowered(f.repo);
  return [now, r?.owner ?? null, r?.repo ?? null, f.kind, f.text === null ? null : storable(f.text)];
}

/** The records on or off and not expired, newest recorded first (by id), filtered, `before` the id a page stopped at, at most `limit`. */
export async function shownRecords(db: Db, f: MemoryFilter, now: string, limit: number): Promise<ShownRow[]> {
  return db.query<ShownRow>(
    `${SHOWN_SELECT}${SHOWN_FILTER}
  and ($6::integer is null or r.id < $6::integer)
order by r.id desc limit $7`,
    [...filterParams(f, now), f.before, limit]);
}

/** How many records the filter matches; `before` is not read. */
export async function countShown(db: Db, f: MemoryFilter, now: string): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from (
       select r.id
       from visto_ai.memory_records r
       where ${SHOWN}${SHOWN_FILTER}
     ) shown`,
    filterParams(f, now));
  return rows[0]!.n;
}

/** One record as the screens read it, on or off, not expired; null when it is not there. */
export async function shownRecord(db: Db, id: number, now: string): Promise<ShownRow | null> {
  const rows = await db.query<ShownRow>(`${SHOWN_SELECT}\n  and r.id = $2`, [now, id]);
  return rows[0] ?? null;
}

export async function memoryCounts(db: Db, now: string): Promise<{ signals: number; signal_repositories: number; reverts: number; lessons: number; off: number }> {
  const rows = await db.query<{ signals: number; signal_repositories: number; reverts: number; lessons: number; off: number }>(
    `select (count(*) filter (where kind = 'human_signal' and status = 'active'))::int as signals,
            (count(distinct owner || '/' || repo) filter (where kind = 'human_signal' and status = 'active'))::int as signal_repositories,
            (count(*) filter (where kind = 'revert' and status = 'active'))::int as reverts,
            (count(*) filter (where kind = 'lesson' and status = 'active'))::int as lessons,
            (count(*) filter (where status = 'disabled'))::int as off
     from visto_ai.memory_records r where ${SHOWN}`,
    [now]);
  return rows[0]!;
}

/** On: disabled to active; off: active to disabled; only a record not expired; true when it changed. Nothing else of the record changes. */
export async function switchRecord(db: Db, id: number, on: boolean, by: string, now: string): Promise<boolean> {
  const rows = await db.query(
    `update visto_ai.memory_records
     set status = case when $2::boolean then 'active' else 'disabled' end, switched_at = $3::timestamptz, switched_by = $4
     where id = $1 and status in ('active', 'disabled') and expires_at > $3::timestamptz
       and status <> case when $2::boolean then 'active' else 'disabled' end
     returning id`,
    [id, on, now, storable(by)]);
  return rows.length === 1;
}
