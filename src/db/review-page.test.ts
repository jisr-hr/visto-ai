import test from 'node:test';
import assert from 'node:assert/strict';
import type { PullRequestFacts, PullRequestRef } from '../forge/types.ts';
import { markDismissed, markDismissFailed, markStoodAtMerge } from './approvals.ts';
import { recordFeedback } from './feedback.ts';
import { recordEvaluation } from './gate.ts';
import type { Evaluation } from './gate.ts';
import { recordActivity } from './human-activity.ts';
import type { Activity } from './human-activity.ts';
import { askWithdraw, claimJob, enqueueJob, requeueJob } from './jobs.ts';
import { savePullRequest } from './pull-requests.ts';
import { recordComments } from './review-comments.ts';
import { gateAt, laterVerdicts, approvalsUpTo, pendingWithdrawal, pullRuns, runComments, runFeedback, runOf, threadEvents } from './review-page.ts';
import { markPublished, recordRun } from './review-runs.ts';
import type { RunRecord } from './review-runs.ts';
import { testDb } from './testing.ts';
import type { Db } from './types.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const date = (seconds: number): Date => new Date(at(seconds));
const REF: PullRequestRef = { service: 'github', owner: 'acme', repo: 'shop', number: 128 };
const HEAD_A = '3f9c2e1a7b04' + 'a'.repeat(28);
const HEAD_B = '9a1e5c07b3d2' + 'b'.repeat(28);

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: HEAD_A, baseSha: 'b1', baseBranch: 'main',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [], result: { findings: [] },
  usage: { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.5 },
  startedAt: at(0), finishedAt: at(90), ...over,
});
const publish = (db: Db, id: number, more: { approved?: boolean; approvalCode?: string | null; body?: string } = {}): Promise<boolean> =>
  markPublished(db, id, { reviewId: `r-${id}`, publishedAt: at(100 + id), body: more.body ?? 'text', inlineDropped: false, ...more });
const facts = (): PullRequestFacts => ({
  ref: REF, title: 'Round prices before tax', author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'fix/round-prices', headSha: HEAD_A,
  draft: false, state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0),
});
const activity = (kind: Activity['kind'], sourceId: string, replyTo: string | null, seconds: number, author = 'octo-lead'): Activity => ({
  ref: REF, kind, sourceId, author, association: null, state: null, body: '', path: null, side: null, line: null, startLine: null, fileLevel: null,
  commit: null, replyTo, thread: null, at: at(seconds), delivery: null,
});
const evaluation = (headSha: string, seconds: number, state: Evaluation['state'], blocking: number, refusedInline: number): Evaluation => ({
  ref: REF, headSha, at: at(seconds), mode: 'enforce', state, code: null, run: null,
  counts: { blocking, clearedByReview: 0, clearedByReply: 0, silentResolves: 0, unknownThreads: 0, findings: 0, notReviewed: 0, withoutThread: 0, refusedInline },
});

test('a run is read with its pull request, its job, its place among the runs of its pull request, and the end of its body only when it was decided', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const first = await recordRun(db, run());
  const job = (await enqueueJob(db, {
    ref: REF, reason: 'command', headSha: HEAD_A, runAt: at(0), now: at(0), delivery: null, replace: false,
    trigger: 'manual', requestedBy: 'octo-dev', commentId: null, association: null, installation: null,
  }))!;
  const second = await recordRun(db, run({ job, trigger: 'manual' }));
  const third = await recordRun(db, run({ startedAt: at(200), finishedAt: at(260) }));
  const row = (await runOf(db, second))!;
  assert.equal(row.id, second);
  assert.equal(row.title, 'Round prices before tax');
  assert.equal(row.author, 'octo-dev');
  assert.equal(row.head_branch, 'fix/round-prices');
  assert.equal(row.pr_base_branch, 'main');
  assert.equal(row.base_branch, 'main');
  assert.equal(row.job_reason, 'command');
  assert.equal(row.job_requested_by, 'octo-dev');
  assert.equal(row.ordinal, 2);
  assert.equal(row.runs, 3);
  assert.equal(row.body_tail, null);
  assert.equal(row.cost, 0.5);
  assert.deepEqual([row.started_at, row.finished_at], [date(0), date(90)]);
  assert.equal((await runOf(db, first))!.job_reason, null);
  assert.equal((await runOf(db, third))!.ordinal, 3);

  const long = 'p'.repeat(4960) + '\n\n**Not approved automatically:** x';
  await publish(db, third, { approvalCode: 'needs_human', body: long });
  const decided = (await runOf(db, third))!;
  assert.equal(decided.body_tail, long.slice(-4000));
  assert.equal(decided.body_tail!.length, 4000);
  assert.equal(decided.approval_code, 'needs_human');
  assert.equal(decided.published, true);
  assert.deepEqual(decided.published_at, date(100 + third));

  const other = await recordRun(db, run({ ref: { ...REF, number: 500 } }));
  const bare = (await runOf(db, other))!;
  assert.deepEqual([bare.title, bare.author, bare.head_branch, bare.pr_base_branch], [null, null, null, null]);
  assert.equal(bare.ordinal, 1);
  assert.equal(bare.runs, 1);

  const full = await recordRun(db, run({ result: { scores: { files: [] }, audit: { a: 1 }, overview: 'o', acceptance: { a: 1 }, providers: ['p'] } }));
  assert.deepEqual((await runOf(db, full))!.result, { scores: { files: [] } });
  const seven = await recordRun(db, run({ result: 7 }));
  const list = await recordRun(db, run({ result: [1, 2] }));
  assert.equal((await runOf(db, seven))!.result, null);
  assert.equal((await runOf(db, list))!.result, null);
  assert.equal(await runOf(db, 999999), null);
  await db.close();
});

test("the comments of a run are its findings', in the order stored, never its notes", async () => {
  const db = await testDb();
  const id = await recordRun(db, run());
  await recordComments(db, id, REF, [
    { commentId: 'c-1', path: 'src/price.ts', side: 'RIGHT', line: 12, severity: 'major', quote: 'round(x)' },
    { commentId: 'c-2', path: 'src/price.ts', side: 'RIGHT', line: 20, severity: 'note', quote: 'note text', blockHash: 'h' },
    { commentId: 'c-3', path: 'src/tax.ts', side: 'LEFT', line: null, severity: 'minor', quote: 'tax()' },
  ]);
  const other = await recordRun(db, run());
  await recordComments(db, other, REF, [{ commentId: 'c-4', path: 'src/price.ts', side: 'RIGHT', line: 1, severity: 'major', quote: 'x' }]);
  await recordComments(db, id, { ...REF, number: REF.number + 1 }, [{ commentId: 'c-5', path: 'src/price.ts', side: 'RIGHT', line: 2, severity: 'major', quote: 'y' }]);
  assert.deepEqual(await runComments(db, REF, id), [
    { comment_id: 'c-1', path: 'src/price.ts', side: 'RIGHT', line: 12, severity: 'major', quote: 'round(x)' },
    { comment_id: 'c-3', path: 'src/tax.ts', side: 'LEFT', line: null, severity: 'minor', quote: 'tax()' },
  ]);
  await db.close();
});

test('thread events are read for those first comments only, oldest first', async () => {
  const db = await testDb();
  await recordActivity(db, activity('thread_resolved', 'd-1', 'c-1', 20));
  await recordActivity(db, activity('thread_unresolved', 'd-2', 'c-1', 10));
  await recordActivity(db, activity('thread_resolved', 'd-3', 'c-9', 15));
  await recordActivity(db, activity('inline_comment', 'd-4', 'c-1', 12));
  assert.deepEqual(await threadEvents(db, REF, ['c-1']), [
    { reply_to: 'c-1', kind: 'thread_unresolved', author: 'octo-lead', at: date(10) },
    { reply_to: 'c-1', kind: 'thread_resolved', author: 'octo-lead', at: date(20) },
  ]);
  const seen: string[] = [];
  const spy: Db = { ...db, query: async (text, params) => { seen.push(text); return db.query(text, params); } };
  assert.deepEqual(await threadEvents(spy, REF, []), []);
  assert.deepEqual(seen, []);
  await db.close();
});

test('the verdicts later published runs kept are read for those first comments only', async () => {
  const db = await testDb();
  const keep = async (verdicts: unknown[], over: Partial<RunRecord> = {}): Promise<number> => {
    const id = await recordRun(db, run({ result: { threadVerdicts: verdicts }, ...over }));
    if (over.dryRun !== true) await publish(db, id);
    return id;
  };
  await keep([{ commentId: 'c-1', verdict: 'open' }], { startedAt: at(10) });
  const page = await keep([]);
  const later = await keep([{ commentId: 'c-1', verdict: 'fixed' }, 'x', { commentId: 'c-2', verdict: 'open' }], { startedAt: at(300), finishedAt: at(360) });
  await keep([{ commentId: 'c-1', verdict: 'answered' }], { dryRun: true, startedAt: at(400) });
  assert.deepEqual(await laterVerdicts(db, REF, page, ['c-1']), [{ run: later, started_at: date(300), comment_id: 'c-1', verdict: 'fixed' }]);
  const seen: string[] = [];
  const spy: Db = { ...db, query: async (text, params) => { seen.push(text); return db.query(text, params); } };
  assert.deepEqual(await laterVerdicts(spy, REF, page, []), []);
  assert.deepEqual(seen, []);
  await db.close();
});

test("the gate's newest evaluation at a head is read, and none is null", async () => {
  const db = await testDb();
  await recordEvaluation(db, evaluation(HEAD_A, 10, 'passed', 0, 0));
  await recordEvaluation(db, evaluation(HEAD_A, 20, 'blocked', 1, 1));
  await recordEvaluation(db, evaluation(HEAD_B, 30, 'passed', 0, 0));
  assert.deepEqual(await gateAt(db, REF, HEAD_A), { mode: 'enforce', state: 'blocked', code: null, blocking: 1, refused_inline: 1 });
  assert.equal(await gateAt(db, REF, 'c'.repeat(40)), null);
  await db.close();
});

test('the approvals up to a run are read newest first with their withdrawal, and a pending withdrawal with its time', async () => {
  const db = await testDb();
  const r1 = await recordRun(db, run());
  const r2 = await recordRun(db, run({ headSha: HEAD_B }));
  const r3 = await recordRun(db, run());
  const r4 = await recordRun(db, run());
  await publish(db, r1, { approved: true, approvalCode: 'approved' });
  await publish(db, r2, { approved: true, approvalCode: 'approved' });
  await publish(db, r3);
  await publish(db, r4, { approved: true, approvalCode: 'approved' });
  await markDismissed(db, r1, at(500), 'app');
  await markDismissFailed(db, r2, 'github_403');
  assert.deepEqual(await approvalsUpTo(db, REF, r3, 20), [
    { run: r2, ordinal: 2, head_sha: HEAD_B, dismissed_at: null, dismissed_by: null, dismiss_failure: 'github_403', stood_at_merge: null },
    { run: r1, ordinal: 1, head_sha: HEAD_A, dismissed_at: date(500), dismissed_by: 'app', dismiss_failure: null, stood_at_merge: null },
  ]);
  assert.equal((await approvalsUpTo(db, REF, r3, 1)).length, 1);
  await markStoodAtMerge(db, r2, at(600));
  assert.deepEqual((await approvalsUpTo(db, REF, r3, 20))[0]!.stood_at_merge, date(600));

  const id = (await askWithdraw(db, REF, at(0)))!;
  assert.equal(await pendingWithdrawal(db, REF), null);
  await claimJob(db, id, at(1));
  assert.equal(await pendingWithdrawal(db, REF), null);
  assert.equal(await requeueJob(db, id, at(52), at(2), false, 'github_403'), 'requeued');
  assert.deepEqual(await pendingWithdrawal(db, REF), { run_at: date(52) });
  await db.close();
});

test('feedback is counted by vote, and the newest reasons are read with their login', async () => {
  const db = await testDb();
  const id = await recordRun(db, run());
  await publish(db, id);
  const vote = (login: string, v: 'up' | 'down', reason: string | null, seconds: number): Promise<boolean> =>
    recordFeedback(db, { run: id, login, vote: v, reason, extension: 'example', at: at(seconds) });
  await vote('octo-dev', 'up', null, 10);
  await vote('octo-lead', 'up', 'Caught a real bug', 20);
  await vote('octo-guest', 'down', 'Too noisy', 30);
  assert.deepEqual(await runFeedback(db, id, 20), {
    up: 2, down: 1,
    reasons: [{ reason: 'Too noisy', login: 'octo-guest' }, { reason: 'Caught a real bug', login: 'octo-lead' }],
  });
  assert.deepEqual((await runFeedback(db, id, 1)).reasons, [{ reason: 'Too noisy', login: 'octo-guest' }]);
  assert.deepEqual(await runFeedback(db, 999999, 20), { up: 0, down: 0, reasons: [] });
  await db.close();
});

test('the runs of a pull request are read newest first with their place and the total', async () => {
  const db = await testDb();
  const a = await recordRun(db, run());
  const b = await recordRun(db, run({ finishedAt: at(120) }));
  const c = await recordRun(db, run({ finishedAt: at(150) }));
  await recordRun(db, run({ ref: { ...REF, number: 129 } }));
  assert.deepEqual(await pullRuns(db, REF, 200), [
    { id: c, finished_at: date(150), ordinal: 3, total: 3 },
    { id: b, finished_at: date(120), ordinal: 2, total: 3 },
    { id: a, finished_at: date(90), ordinal: 1, total: 3 },
  ]);
  assert.deepEqual((await pullRuns(db, REF, 2)).map((r) => [r.id, r.ordinal, r.total]), [[c, 3, 3], [b, 2, 3]]);
  assert.deepEqual(await pullRuns(db, { ...REF, owner: 'Acme', repo: 'Shop' }, 200), await pullRuns(db, REF, 200));
  await db.close();
});
