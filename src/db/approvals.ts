import type { PullRequestRef } from '../forge/types.ts';
import { storable } from './text.ts';
import type { Db } from './types.ts';

/** A standing approval: a run published, not a dry run, posted as an approval, and not dismissed. */
export interface Standing {
  run: number; reviewId: string; headSha: string; baseBranch: string | null;
  failure: string | null;               // the code of the last failed withdrawal, while it stands
}

const keyOf = (ref: PullRequestRef): [string, string, string, number] =>
  [ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number];

/** The pull request's standing approvals, lowest run first. */
export async function standingApprovals(db: Db, ref: PullRequestRef): Promise<Standing[]> {
  const rows = await db.query<{ run: number; review_id: string; head_sha: string; base_branch: string | null; dismiss_failure: string | null }>(
    `select id as run, review_id, head_sha, base_branch, dismiss_failure from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number = $4
       and published and not dry_run and approved and dismissed_at is null and review_id is not null
     order by id`,
    keyOf(ref));
  return rows.map((r) => ({ run: r.run, reviewId: r.review_id, headSha: r.head_sha, baseBranch: r.base_branch, failure: r.dismiss_failure }));
}

/** Whether the pull request has a standing approval; with `reviewId`, one posted as that review. */
export async function hasStandingApproval(db: Db, ref: PullRequestRef, reviewId?: string): Promise<boolean> {
  const rows = await db.query(
    `select 1 from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number = $4
       and published and not dry_run and approved and dismissed_at is null and ($5::text is null or review_id = $5)
     limit 1`,
    [...keyOf(ref), reviewId === undefined ? null : storable(reviewId)]);
  return rows.length === 1;
}

/** Whether the newest published run of the pull request that is not a dry run is an approval not dismissed. */
export async function newestApprovalStands(db: Db, ref: PullRequestRef): Promise<boolean> {
  const rows = await db.query<{ stands: boolean }>(
    `select approved and dismissed_at is null as stands from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number = $4 and published and not dry_run
     order by id desc limit 1`,
    keyOf(ref));
  return rows[0]?.stands === true;
}

/** Whether the newest published run of the pull request that is not a dry run was posted as an approval, dismissed since or not. */
export async function newestWasApproval(db: Db, ref: PullRequestRef): Promise<boolean> {
  const rows = await db.query<{ approved: boolean }>(
    `select approved from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number = $4 and published and not dry_run
     order by id desc limit 1`,
    keyOf(ref));
  return rows[0]?.approved === true;
}

/** Records an approval as dismissed, by the app or by the git service, and clears its failure. false when it is no approval or was already marked. */
export async function markDismissed(db: Db, run: number, at: string, by: 'app' | 'git_service'): Promise<boolean> {
  const rows = await db.query(
    `update visto_ai.review_runs set dismissed_at = $2::timestamptz, dismissed_by = $3, dismiss_failure = null
     where id = $1 and approved and dismissed_at is null
     returning id`,
    [run, at, by]);
  return rows.length === 1;
}

/** Records the code of a failed withdrawal on an approval not dismissed. true when no failure was recorded on it before; false too when it is no such approval. */
export async function markDismissFailed(db: Db, run: number, code: string): Promise<boolean> {
  const rows = await db.query<{ first: boolean }>(
    `update visto_ai.review_runs r set dismiss_failure = $2
     from (select id, dismiss_failure as old from visto_ai.review_runs where id = $1 and approved and dismissed_at is null) b
     where r.id = b.id
     returning b.old is null as first`,
    [run, storable(code)]);
  return rows[0]?.first === true;
}

/** Clears the recorded failure of an approval not dismissed, which a later withdraw job found holding. true when a failure was cleared. */
export async function clearDismissFailure(db: Db, run: number): Promise<boolean> {
  const rows = await db.query(
    `update visto_ai.review_runs set dismiss_failure = null
     where id = $1 and approved and dismissed_at is null and dismiss_failure is not null
     returning id`,
    [run]);
  return rows.length === 1;
}

/** Records that an approval not dismissed still stood at a merge. true the first time; never on a dismissed run or one that is no approval. */
export async function markStoodAtMerge(db: Db, run: number, at: string): Promise<boolean> {
  const rows = await db.query(
    `update visto_ai.review_runs set stood_at_merge = $2::timestamptz
     where id = $1 and approved and dismissed_at is null and stood_at_merge is null
     returning id`,
    [run, at]);
  return rows.length === 1;
}

/** The code recorded on the newest standing approval of the pull request whose withdrawal failed; null when none has one. */
export async function failedDismissal(db: Db, ref: PullRequestRef): Promise<string | null> {
  const rows = await db.query<{ dismiss_failure: string }>(
    `select dismiss_failure from visto_ai.review_runs
     where service = $1 and owner = $2 and repo = $3 and number = $4
       and published and not dry_run and approved and dismissed_at is null and dismiss_failure is not null
     order by id desc limit 1`,
    keyOf(ref));
  return rows[0]?.dismiss_failure ?? null;
}

/** Every pull request with a standing approval whose withdrawal failed, once each, in order. */
export async function failedDismissals(db: Db): Promise<PullRequestRef[]> {
  const rows = await db.query<{ service: 'github'; owner: string; repo: string; number: number }>(
    `select distinct service, owner, repo, number from visto_ai.review_runs
     where published and not dry_run and approved and dismissed_at is null and dismiss_failure is not null
     order by service, owner, repo, number`);
  return rows.map((r) => ({ service: r.service, owner: r.owner, repo: r.repo, number: r.number }));
}
