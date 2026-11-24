import type { PullRequestFacts, PullRequestRef } from '../forge/types.ts';
import { storable, storableOrNull } from './text.ts';
import type { Db } from './types.ts';

/**
 * Inserts or updates. false, and nothing written, when the stored facts are newer (a later updatedAt).
 * `reverts`: a number is stored, absent stores null, and 'kept' leaves what is stored (null for a pull request not stored before).
 */
export async function savePullRequest(db: Db, facts: PullRequestFacts): Promise<boolean> {
  const rows = await db.query(
    `insert into visto_ai.pull_requests
       (service, owner, repo, number, author, author_is_bot, base_branch, head_branch, head_sha,
        draft, state, merged_at, closed_at, merge_commit, installation, updated_at, reverts)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz, $14, $15, $16::timestamptz, $17::integer)
     on conflict (service, owner, repo, number) do update set
       author = excluded.author, author_is_bot = excluded.author_is_bot,
       base_branch = excluded.base_branch, head_branch = excluded.head_branch, head_sha = excluded.head_sha,
       draft = excluded.draft, state = excluded.state,
       merged_at = excluded.merged_at, closed_at = excluded.closed_at, merge_commit = excluded.merge_commit,
       installation = coalesce(excluded.installation, visto_ai.pull_requests.installation),
       updated_at = excluded.updated_at,
       reverts = case when $18::boolean then visto_ai.pull_requests.reverts else excluded.reverts end
     where visto_ai.pull_requests.updated_at <= excluded.updated_at
     returning number`,
    [
      facts.ref.service, storable(facts.ref.owner).toLowerCase(), storable(facts.ref.repo).toLowerCase(), facts.ref.number,
      storable(facts.author), facts.authorIsBot,
      storable(facts.baseBranch), storable(facts.headBranch), storable(facts.headSha),
      facts.draft, facts.state, facts.mergedAt, facts.closedAt, storableOrNull(facts.mergeCommit),
      storableOrNull(facts.installation), facts.updatedAt,
      typeof facts.reverts === 'number' ? facts.reverts : null, facts.reverts === 'kept',
    ]);
  return rows.length === 1;
}

interface Row {
  author: string; author_is_bot: boolean; base_branch: string; head_branch: string; head_sha: string;
  draft: boolean; state: PullRequestFacts['state'];
  merged_at: Date | null; closed_at: Date | null; merge_commit: string | null;
  installation: string | null; updated_at: Date;
}

export async function getPullRequest(db: Db, ref: PullRequestRef): Promise<PullRequestFacts | null> {
  const owner = storable(ref.owner).toLowerCase();
  const repo = storable(ref.repo).toLowerCase();
  const rows = await db.query<Row>(
    `select author, author_is_bot, base_branch, head_branch, head_sha, draft, state,
            merged_at, closed_at, merge_commit, installation, updated_at
     from visto_ai.pull_requests
     where service = $1 and owner = $2 and repo = $3 and number = $4`,
    [ref.service, owner, repo, ref.number]);
  const r = rows[0];
  if (r === undefined) return null;
  return {
    ref: { service: ref.service, owner, repo, number: ref.number },
    author: r.author, authorIsBot: r.author_is_bot,
    baseBranch: r.base_branch, headBranch: r.head_branch, headSha: r.head_sha,
    draft: r.draft, state: r.state,
    mergedAt: r.merged_at === null ? null : r.merged_at.toISOString(),
    closedAt: r.closed_at === null ? null : r.closed_at.toISOString(),
    mergeCommit: r.merge_commit, installation: r.installation,
    updatedAt: r.updated_at.toISOString(),
  };
}

/**
 * What a pull request stored as merged reverts: the number stored for it, whether the pull request named is stored, and that one's merge time,
 * null when it is not stored as merged. null when the pull request is not stored as merged, or names none.
 */
export async function revertOf(db: Db, ref: PullRequestRef): Promise<{ reverted: number; stored: boolean; revertedMergedAt: string | null } | null> {
  const rows = await db.query<{ reverted: number; stored: boolean; merged: Date | null }>(
    `select p.reverts as reverted,
            r.number is not null as stored,
            case when r.state = 'merged' then coalesce(r.closed_at, r.merged_at, r.updated_at) end as merged
     from visto_ai.pull_requests p
     left join visto_ai.pull_requests r
       on r.service = p.service and r.owner = p.owner and r.repo = p.repo and r.number = p.reverts
     where p.service = $1 and p.owner = $2 and p.repo = $3 and p.number = $4
       and p.state = 'merged' and p.reverts is not null`,
    [ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number]);
  const r = rows[0];
  if (r === undefined) return null;
  return { reverted: r.reverted, stored: r.stored, revertedMergedAt: r.merged === null ? null : r.merged.toISOString() };
}

/** Every stored pull request whose state is open, with its base branch. */
export async function openPullRequests(db: Db): Promise<Array<{ ref: PullRequestRef; baseBranch: string; installation: string | null }>> {
  const rows = await db.query<{ service: 'github'; owner: string; repo: string; number: number; base_branch: string; installation: string | null }>(
    `select service, owner, repo, number, base_branch, installation from visto_ai.pull_requests
     where state = 'open'
     order by service, owner, repo, number`);
  return rows.map((r) => ({
    ref: { service: r.service, owner: r.owner, repo: r.repo, number: r.number }, baseBranch: r.base_branch, installation: r.installation,
  }));
}
