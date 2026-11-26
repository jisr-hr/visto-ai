import test from 'node:test';
import assert from 'node:assert/strict';
import type { PullRequestFacts, PullRequestRef } from '../forge/types.ts';
import { activityJobs, countReviews, recentReviews, waitingWithdrawals } from './activity.ts';
import type { ReviewFilters } from './activity.ts';
import { askGate, askWithdraw, claimJob, enqueueJob, finishJob, markStage, requeueJob } from './jobs.ts';
import { savePullRequest } from './pull-requests.ts';
import { markPublished, recordRun } from './review-runs.ts';
import type { RunRecord } from './review-runs.ts';
import { testDb } from './testing.ts';
import type { Db } from './types.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const date = (seconds: number): Date => new Date(at(seconds));
const pr = (number: number, repo = 'shop'): PullRequestRef => ({ service: 'github', owner: 'acme', repo, number });
const HEAD = 'a41c09e2b7d3f00dbabe0123456789abcdef0123';
const STORED = '17f0c3a9e5b2c0ffee0123456789abcdef012345';

const facts = (ref: PullRequestRef, more: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feature', headSha: STORED,
  draft: false, state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0), ...more,
});

async function enqueue(db: Db, ref: PullRequestRef, more: { reason?: string; headSha?: string; runAt?: string; now?: string } = {}): Promise<number> {
  const id = await enqueueJob(db, {
    ref, reason: more.reason ?? 'opened', headSha: more.headSha ?? HEAD, runAt: more.runAt ?? at(0), now: more.now ?? at(0), delivery: null,
    replace: false, trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null,
  });
  return id!;
}

test('the activity reads running review jobs first, then the pending by when they may start, with the title, the stored head and the creation time', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(pr(7), { title: 'Cache the tax table per region' }));
  await savePullRequest(db, facts(pr(8)));
  // Two running jobs: the one with the higher id started first.
  const later = await enqueue(db, pr(7), { reason: 'synchronize', runAt: at(-200), now: at(-380) });
  await claimJob(db, later, at(-50));
  await markStage(db, later, { stage: 'reviewing', batch: 2, batches: 3 }, at(-40));
  const earlier = await enqueue(db, pr(12), { runAt: at(-300), now: at(-300) });
  await claimJob(db, earlier, at(-100));
  // Two pending: the one with the lower id may start later.
  const second = await enqueue(db, pr(8), { runAt: at(60), now: at(0) });
  const first = await enqueue(db, pr(9), { reason: 'reopened', headSha: '', runAt: at(0), now: at(-10) });
  // A gate job and a finished review job are not listed.
  await askGate(db, pr(10), at(-5));
  const finished = await enqueue(db, pr(11), { runAt: at(-30), now: at(-30) });
  await claimJob(db, finished, at(-20));
  await finishJob(db, finished, 'done', 'reviewed', at(-10));

  const rows = await activityJobs(db, 200);
  assert.deepEqual(rows.map((r) => r.id), [earlier, later, first, second]);
  assert.deepEqual(rows[1], {
    id: later, owner: 'acme', repo: 'shop', number: 7, reason: 'synchronize', head_sha: HEAD, trigger: 'automatic', requested_by: null,
    status: 'running', run_at: date(-200), starts: 1, started_at: date(-50), created_at: date(-380), stage: 'reviewing', batch: 2, batches: 3,
    threads_due: null, title: 'Cache the tax table per region', stored_head: STORED,
  });
  assert.deepEqual(rows[2], {
    id: first, owner: 'acme', repo: 'shop', number: 9, reason: 'reopened', head_sha: '', trigger: 'automatic', requested_by: null,
    status: 'pending', run_at: date(0), starts: 0, started_at: null, created_at: date(-10), stage: null, batch: null, batches: null,
    threads_due: null, title: null, stored_head: null,
  });
  assert.deepEqual([rows[3]!.title, rows[3]!.stored_head, rows[3]!.created_at], [null, STORED, date(0)]);
  assert.deepEqual((await activityJobs(db, 2)).map((r) => r.id), [earlier, later]);
  await db.close();
});

test('the withdrawals waiting are the pending withdraw jobs with a start, with their code', async () => {
  const db = await testDb();
  const id = (await askWithdraw(db, pr(7), at(0), '99'))!;
  assert.deepEqual(await waitingWithdrawals(db, 50), []);
  await claimJob(db, id, at(0));
  assert.deepEqual(await waitingWithdrawals(db, 50), []);
  assert.equal(await requeueJob(db, id, at(52), at(1), false, 'github_403'), 'requeued');
  // A review job put back is no withdrawal.
  const review = await enqueue(db, pr(8));
  await claimJob(db, review, at(0));
  await requeueJob(db, review, at(30), at(1), false);
  // One put back with no code, due earlier.
  const other = (await askWithdraw(db, pr(9, 'web'), at(0)))!;
  await claimJob(db, other, at(0));
  await requeueJob(db, other, at(20), at(1), false);

  assert.deepEqual(await waitingWithdrawals(db, 50), [
    { owner: 'acme', repo: 'web', number: 9, retry_code: null, run_at: date(20) },
    { owner: 'acme', repo: 'shop', number: 7, retry_code: 'github_403', run_at: date(52) },
  ]);
  assert.equal((await waitingWithdrawals(db, 1)).length, 1);
  await db.close();
});

const NONE: ReviewFilters = { since: at(-30 * 86_400), repository: null, kinds: null, title: null, number: null, before: null };
const RESULT = { findings: [{ severity: 'blocker' }, { severity: 'major' }, { severity: 'major' }, { severity: 'minor' }], verdict: { threshold: 70 } };

async function run(db: Db, ref: PullRequestRef, more: Partial<RunRecord> = {}): Promise<number> {
  return recordRun(db, {
    ref, job: null, trigger: 'automatic', mode: 'full', dryRun: true, headSha: HEAD, baseSha: STORED, baseBranch: 'main',
    outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 30, body: '', comments: [], result: RESULT,
    usage: { calls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0.084 }, startedAt: at(-100), finishedAt: at(-59), ...more,
  });
}
const published = (approved: boolean, approvalCode: string | null): Parameters<typeof markPublished>[2] =>
  ({ reviewId: 'r-1', publishedAt: at(-50), body: 'posted', inlineDropped: false, approved, approvalCode });

test('each run reads as its outcome, the first that holds', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(pr(1), { title: 'Round prices before tax' }));
  const ids: number[] = [];
  ids.push(await run(db, pr(1), { outcome: 'failed', failureStage: 'model', failureCode: 'model_timeout', needsHuman: true, dryRun: false, highestScore: 0 }));
  ids.push(await run(db, pr(2), { dryRun: false, result: { ...RESULT, nothingToDo: true } }));
  ids.push(await run(db, pr(3), { dryRun: false, result: { ...RESULT, nothingToDo: true } }));
  await markPublished(db, ids[2]!, published(true, 'approved'));
  ids.push(await run(db, pr(4), { dryRun: false, needsHuman: true }));
  await markPublished(db, ids[3]!, published(false, 'audit_sample'));
  ids.push(await run(db, pr(5), { dryRun: false, needsHuman: true }));
  await markPublished(db, ids[4]!, published(true, 'approved'));
  ids.push(await run(db, pr(6), { dryRun: false, needsHuman: true }));
  ids.push(await run(db, pr(7), { needsHuman: true }));
  ids.push(await run(db, pr(8)));
  ids.push(await run(db, pr(9), { result: {} }));
  ids.push(await run(db, pr(10), { result: { findings: { severity: 'blocker' }, verdict: { threshold: '70' } } }));

  const rows = await recentReviews(db, NONE, 26);
  assert.deepEqual(rows.map((r) => r.id), [...ids].reverse());
  assert.deepEqual(rows.map((r) => [r.number, r.kind, r.blockers, r.majors, r.minors, r.threshold]).reverse(), [
    [1, 'failed', 1, 2, 1, 70],
    [2, 'nothing_new', 1, 2, 1, 70],
    [3, 'approved', 1, 2, 1, 70],
    [4, 'audit', 1, 2, 1, 70],
    [5, 'approved', 1, 2, 1, 70],
    [6, 'not_posted', 1, 2, 1, 70],
    [7, 'needs_person', 1, 2, 1, 70],
    [8, 'reviewed', 1, 2, 1, 70],
    [9, 'reviewed', 0, 0, 0, null],
    [10, 'reviewed', 0, 0, 0, null],
  ]);
  assert.deepEqual(rows.at(-1), {
    id: ids[0], owner: 'acme', repo: 'shop', number: 1, title: 'Round prices before tax', mode: 'full', dry_run: false,
    failure_code: 'model_timeout', highest_score: 0, cost: 0.084, started_at: date(-100), finished_at: date(-59),
    threshold: 70, blockers: 1, majors: 2, minors: 1, kind: 'failed',
  });
  await db.close();
});

test('the reviews of the window are paged by run, filtered by repository, kinds, title or number, and counted', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(pr(103, 'billing'), { title: 'Round the TAX before the total' }));
  await savePullRequest(db, facts(pr(111), { title: 'Cache the tax table per region' }));
  await savePullRequest(db, facts(pr(128), { title: 'Round prices' }));
  const ids: number[] = [];
  for (let i = 1; i <= 30; i += 1) {
    const ref = pr(100 + i, i % 3 === 0 ? 'billing' : 'shop');
    ids.push(await run(db, ref, { outcome: i % 5 === 0 ? 'failed' : 'ok', startedAt: at(-86_400 * (30 - i) - 3_600), finishedAt: at(-86_400 * (30 - i)) }));
  }
  // One that started before the window, stored last.
  await run(db, pr(200), { startedAt: at(-30 * 86_400 - 1), finishedAt: at(-30 * 86_400 + 60) });
  const newest = [...ids].reverse();

  const page = await recentReviews(db, NONE, 26);
  assert.deepEqual(page.map((r) => r.id), newest.slice(0, 26));
  const rest = await recentReviews(db, { ...NONE, before: page[24]!.id }, 26);
  assert.deepEqual(rest.map((r) => r.id), newest.slice(25));

  const billing = await recentReviews(db, { ...NONE, repository: 'acme/billing' }, 26);
  assert.deepEqual(billing.map((r) => r.number), [130, 127, 124, 121, 118, 115, 112, 109, 106, 103]);
  const failed = await recentReviews(db, { ...NONE, kinds: ['failed'] }, 26);
  assert.deepEqual(failed.map((r) => [r.number, r.kind]), [[130, 'failed'], [125, 'failed'], [120, 'failed'], [115, 'failed'], [110, 'failed'], [105, 'failed']]);
  assert.deepEqual((await recentReviews(db, { ...NONE, kinds: ['reviewed', 'failed'] }, 26)).length, 26);
  assert.deepEqual((await recentReviews(db, { ...NONE, title: 'tax' }, 26)).map((r) => r.number), [111, 103]);
  assert.deepEqual((await recentReviews(db, { ...NONE, title: '#128', number: 128 }, 26)).map((r) => r.number), [128]);
  assert.deepEqual((await recentReviews(db, { ...NONE, title: '128', number: 128 }, 26)).map((r) => r.number), [128]);
  assert.deepEqual((await recentReviews(db, { ...NONE, title: 'round', number: 111 }, 26)).map((r) => r.number), [128, 111, 103]);

  assert.equal(await countReviews(db, NONE), 30);
  assert.equal(await countReviews(db, { ...NONE, before: page[24]!.id }), 30);
  assert.equal(await countReviews(db, { ...NONE, repository: 'acme/billing' }), 10);
  assert.equal(await countReviews(db, { ...NONE, kinds: ['failed'] }), 6);
  assert.equal(await countReviews(db, { ...NONE, title: 'tax' }), 2);
  assert.equal(await countReviews(db, { ...NONE, title: '#128', number: 128 }), 1);
  assert.equal(await countReviews(db, { ...NONE, repository: 'acme/billing', kinds: ['failed'] }), 2);
  await db.close();
});
