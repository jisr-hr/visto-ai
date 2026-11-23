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
}
/** What a lookup reads of a record: never its excerpt or its reason. */
export interface LiveRow { id: number; sourceRef: string; number: number; path: string | null; directory: string | null; category: string | null; missed: boolean; createdAt: string }

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
    created_at: x.createdAt, expires_at: x.expiresAt,
  }));
  const added = await db.query(
    `insert into visto_ai.memory_records
       (service, owner, repo, kind, source_ref, created_at, expires_at, number, path, directory, category, reason, missed, excerpt, comment)
     select $1, $2, $3, s.kind, s.source_ref, s.created_at, s.expires_at, s.number, s.path, s.directory, s.category, s.reason, s.missed, s.excerpt, s.comment
     from jsonb_to_recordset($4::jsonb) as s(kind text, source_ref text, number integer, path text, directory text, category text,
                                              reason text, missed boolean, excerpt text, comment text, created_at timestamptz, expires_at timestamptz)
     on conflict (service, owner, repo, kind, source_ref) do nothing
     returning id`,
    [r.service, r.owner, r.repo, storableJson(rows)]);
  return added.length;
}

interface LiveDbRow {
  id: number; source_ref: string; number: number; path: string | null; directory: string | null;
  category: string | null; missed: boolean; created_at: Date;
}

/** The repository's records of that kind live at `at`: status active, made at or before it, expiring after it. Newest first (made, then id), at most `limit`. */
export async function liveRecords(db: Db, repo: RepoKey, kind: RecordKind, at: string, limit: number): Promise<LiveRow[]> {
  const r = lowered(repo);
  const rows = await db.query<LiveDbRow>(
    `select id, source_ref, number, path, directory, category, missed, created_at
     from visto_ai.memory_records
     where service = $1 and owner = $2 and repo = $3 and kind = $4
       and status = 'active' and created_at <= $5::timestamptz and expires_at > $5::timestamptz
     order by created_at desc, id desc
     limit $6`,
    [r.service, r.owner, r.repo, kind, at, limit]);
  return rows.map((x) => ({
    id: x.id, sourceRef: x.source_ref, number: x.number, path: x.path, directory: x.directory,
    category: x.category, missed: x.missed, createdAt: x.created_at.toISOString(),
  }));
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
