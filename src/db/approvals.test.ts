import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import type { Db } from './types.ts';
import { markPublished, recordRun } from './review-runs.ts';
import type { RunRecord } from './review-runs.ts';
import {
  clearDismissFailure, failedDismissal, failedDismissals, hasStandingApproval, markDismissed, markDismissFailed, markStoodAtMerge,
  newestApprovalStands, newestWasApproval, standingApprovals,
} from './approvals.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const UPPER = { ...REF, owner: 'Acme', repo: 'Shop' };
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'merge000', baseBranch: 'main',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [], result: { findings: [] },
  usage: { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.0375 },
  startedAt: at(0), finishedAt: at(90), ...over,
});
/** Records a run and posts it, as an approval or as a comment; with no review id it is left unpublished. */
const posted = async (db: Db, reviewId: string | null, approved: boolean, over: Partial<RunRecord> = {}): Promise<number> => {
  const id = await recordRun(db, run(over));
  if (reviewId !== null) {
    await markPublished(db, id, { reviewId, publishedAt: at(95), body: 'posted text', inlineDropped: false, approved, approvalCode: approved ? 'approved' : 'rule_off' });
  }
  return id;
};
const pr = (number: number): Partial<RunRecord> => ({ ref: { ...REF, number } });

test('standing approvals are the published live approvals not dismissed, lowest run first', async () => {
  const db = await testDb();
  const live = await posted(db, '501', true);
  await posted(db, '502', true, { dryRun: true });
  const unpublished = await posted(db, null, false);
  await db.query('update visto_ai.review_runs set approved = true where id = $1', [unpublished]);
  await posted(db, '503', false);
  const dismissed = await posted(db, '504', true);
  assert.equal(await markDismissed(db, dismissed, at(100), 'git_service'), true);
  await posted(db, '505', true, pr(8));
  const first = { run: live, reviewId: '501', headSha: 'h1', baseBranch: 'main', failure: null };
  assert.deepEqual(await standingApprovals(db, UPPER), [first]);
  assert.deepEqual(await Promise.all([hasStandingApproval(db, UPPER), hasStandingApproval(db, UPPER, '501'), hasStandingApproval(db, UPPER, '999')]), [true, true, false]);
  assert.deepEqual(await Promise.all(['502', '503', '504', '505'].map((id) => hasStandingApproval(db, REF, id))), [false, false, false, false]);

  const later = await posted(db, '506', true, { headSha: 'h2', baseBranch: 'release/1.0' });
  assert.equal(await markDismissFailed(db, later, 'github_403'), true);
  assert.deepEqual(await standingApprovals(db, REF), [first, { run: later, reviewId: '506', headSha: 'h2', baseBranch: 'release/1.0', failure: 'github_403' }]);
  assert.deepEqual([await standingApprovals(db, { ...REF, number: 9 }), await hasStandingApproval(db, { ...REF, number: 9 })], [[], false]);
  await db.close();
});
test('a dismissal is marked once and clears the failure, and a failure is first only once', async () => {
  const db = await testDb();
  const id = await posted(db, '501', true);
  const comment = await posted(db, '502', false, { headSha: 'h2' });
  assert.deepEqual([await failedDismissal(db, REF), await failedDismissals(db)], [null, []]);
  assert.equal(await markDismissFailed(db, id, 'github_502'), true);
  assert.equal(await markDismissFailed(db, id, 'github_403'), false);
  assert.equal(await markDismissFailed(db, comment, 'github_403'), false);
  assert.equal(await failedDismissal(db, UPPER), 'github_403');
  assert.deepEqual(await failedDismissals(db), [REF]);
  assert.equal(await markDismissed(db, id, at(200), 'app'), true);
  assert.equal(await markDismissed(db, id, at(300), 'git_service'), false);
  assert.equal(await markDismissed(db, comment, at(300), 'app'), false);
  assert.deepEqual([await failedDismissal(db, REF), await failedDismissals(db)], [null, []]);
  assert.deepEqual(await db.query('select id, dismissed_at, dismissed_by, dismiss_failure from visto_ai.review_runs order by id'), [
    { id, dismissed_at: new Date(at(200)), dismissed_by: 'app', dismiss_failure: null },
    { id: comment, dismissed_at: null, dismissed_by: null, dismiss_failure: null },
  ]);
  assert.equal(await markDismissFailed(db, id, 'github_403'), false);
  assert.equal(await failedDismissal(db, REF), null);

  // The newest failed run's code is read; each pull request is listed once, in order; a dry run is never listed.
  const older = await posted(db, '503', true, { headSha: 'h3' });
  const newer = await posted(db, '504', true, { headSha: 'h4' });
  const web = { service: 'github', owner: 'acme', repo: 'web', number: 3 } as const;
  const other = await posted(db, '505', true, { ref: web });
  const eight = await posted(db, '506', true, pr(8));
  const dry = await posted(db, '507', true, { ...pr(9), dryRun: true });
  for (const [failed, code] of [[newer, 'github_502'], [older, 'github_403'], [other, 'github_404'], [eight, 'github_403'], [dry, 'github_403']] as const) {
    assert.equal(await markDismissFailed(db, failed, code), true);
  }
  assert.equal(await failedDismissal(db, REF), 'github_502');
  assert.equal(await failedDismissal(db, { ...REF, number: 9 }), null);
  assert.deepEqual(await failedDismissals(db), [REF, { ...REF, number: 8 }, web]);
  await db.close();
});
test('the failure read is the newest standing approval that carries one, not the newest standing approval', async () => {
  const db = await testDb();
  const older = await posted(db, '501', true);
  await posted(db, '502', true, { headSha: 'h2' });
  assert.equal(await markDismissFailed(db, older, 'github_403'), true);
  assert.equal(await failedDismissal(db, REF), 'github_403');
  await db.close();
});
test('a merge under a standing approval is marked once, and a dismissed approval is never marked', async () => {
  const db = await testDb();
  const standing = await posted(db, '501', true);
  const dismissed = await posted(db, '502', true, { headSha: 'h2' });
  assert.equal(await markDismissed(db, dismissed, at(100), 'app'), true);
  const comment = await posted(db, '503', false, { headSha: 'h2' });
  assert.equal(await markStoodAtMerge(db, standing, at(200)), true);
  assert.equal(await markStoodAtMerge(db, standing, at(300)), false);
  assert.equal(await markStoodAtMerge(db, dismissed, at(200)), false);
  assert.equal(await markStoodAtMerge(db, comment, at(200)), false);
  assert.deepEqual(await db.query('select id, stood_at_merge from visto_ai.review_runs order by id'), [
    { id: standing, stood_at_merge: new Date(at(200)) }, { id: dismissed, stood_at_merge: null }, { id: comment, stood_at_merge: null },
  ]);
  await db.close();
});
test('the newest published run says whether its approval stands, and whether it was one', async () => {
  const db = await testDb();
  // 7: nothing published.
  await posted(db, null, false);
  // 8: an approval, then a comment.
  await posted(db, '501', true, pr(8));
  await posted(db, '502', false, { ...pr(8), headSha: 'h2' });
  // 9: a comment, then an approval; a run not posted yet after them is not read.
  await posted(db, '503', false, pr(9));
  await posted(db, '504', true, { ...pr(9), headSha: 'h2' });
  await posted(db, null, false, { ...pr(9), headSha: 'h3' });
  // 10: an approval that stands, then a newer approval dismissed.
  await posted(db, '505', true, pr(10));
  const dismissed = await posted(db, '506', true, { ...pr(10), headSha: 'h2' });
  assert.equal(await markDismissed(db, dismissed, at(100), 'git_service'), true);
  // 11: a comment, then a dry approval; 12: an approval, then a dry comment.
  await posted(db, '507', false, pr(11));
  await posted(db, '508', true, { ...pr(11), headSha: 'h2', dryRun: true });
  await posted(db, '509', true, pr(12));
  await posted(db, '510', false, { ...pr(12), headSha: 'h2', dryRun: true });
  const read = async (number: number): Promise<boolean[]> =>
    [await newestApprovalStands(db, { ...UPPER, number }), await newestWasApproval(db, { ...UPPER, number })];
  assert.deepEqual(await Promise.all([7, 8, 9, 10, 11, 12].map(read)), [
    [false, false], [false, false], [true, true], [false, true], [false, false], [true, true],
  ]);
  await db.close();
});

test('a recorded failure is cleared once, and never on a dismissed run', async () => {
  const db = await testDb();
  const id = await posted(db, '501', true);
  assert.equal(await clearDismissFailure(db, id), false);
  assert.equal(await markDismissFailed(db, id, 'github_403'), true);
  assert.equal(await clearDismissFailure(db, id), true);
  assert.equal(await clearDismissFailure(db, id), false);
  // The approval still stands, with no failure.
  assert.deepEqual(await standingApprovals(db, UPPER), [{ run: id, reviewId: '501', headSha: 'h1', baseBranch: 'main', failure: null }]);
  assert.deepEqual(await failedDismissals(db), []);

  // A dismissed run, and a comment, each carrying a failure written by statement: left as they are.
  const dismissed = await posted(db, '502', true, { headSha: 'h2' });
  const comment = await posted(db, '503', false, { headSha: 'h3' });
  await db.query("update visto_ai.review_runs set dismissed_at = $2::timestamptz, dismissed_by = 'app' where id = $1", [dismissed, at(100)]);
  await db.query("update visto_ai.review_runs set dismiss_failure = 'github_502' where id = any($1::integer[])", [[dismissed, comment]]);
  assert.deepEqual([await clearDismissFailure(db, dismissed), await clearDismissFailure(db, comment)], [false, false]);
  assert.deepEqual(await db.query('select id, dismiss_failure from visto_ai.review_runs order by id'), [
    { id, dismiss_failure: null }, { id: dismissed, dismiss_failure: 'github_502' }, { id: comment, dismiss_failure: 'github_502' },
  ]);
  await db.close();
});
