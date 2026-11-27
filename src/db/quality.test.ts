import test from 'node:test';
import assert from 'node:assert/strict';
import type { PullRequestFacts, PullRequestRef } from '../forge/types.ts';
import { markDismissed } from './approvals.ts';
import { recordFeedback } from './feedback.ts';
import { recordActivity } from './human-activity.ts';
import type { Activity } from './human-activity.ts';
import type { RepoKey } from './memory-records.ts';
import { savePullRequest } from './pull-requests.ts';
import {
  auditedPulls, closedPulls, feedbackCounts, feedbackReasons, findingThreads, inlineCommentsOf, mergedReverts, okRuns, runScores,
} from './quality.ts';
import { recordComments } from './review-comments.ts';
import { markPublished, recordRun } from './review-runs.ts';
import type { RunRecord } from './review-runs.ts';
import { testDb } from './testing.ts';
import type { Db } from './types.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const DAY = 86400;
const SINCE = at(-30 * DAY);
const SHOP: RepoKey = { service: 'github', owner: 'acme', repo: 'shop' };
const HEAD_A = '3f9c2e1a7b04' + 'a'.repeat(28);
const HEAD_B = '9a1e5c07b3d2' + 'b'.repeat(28);
const refOf = (number: number, repo = 'shop'): PullRequestRef => ({ service: 'github', owner: 'acme', repo, number });

const facts = (number: number, state: PullRequestFacts['state'], closed: number | null, over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref: refOf(number), author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feature/cart', headSha: HEAD_A, draft: false, state,
  mergedAt: state === 'merged' && closed !== null ? at(closed) : null,
  // GitHub closes a merged pull request a moment after it merges it: the close read is the merge.
  closedAt: state !== 'open' && closed !== null ? at(state === 'merged' ? closed + 5 : closed) : null,
  mergeCommit: null, installation: null, updatedAt: at(0), ...over,
});
const run = (number: number, over: Partial<RunRecord> = {}): RunRecord => ({
  ref: refOf(number), job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: HEAD_A, baseSha: 'base-1', baseBranch: 'main',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 30,
  body: 'BODY-TEXT', comments: [], result: { scores: [] },
  usage: { calls: 1, inputTokens: 10, outputTokens: 10, cachedTokens: 0, cost: 0.01 },
  startedAt: at(-DAY), finishedAt: at(-DAY + 60), ...over,
});
const inline = (number: number, sourceId: string, seconds: number, over: Partial<Activity> = {}): Activity => ({
  ref: refOf(number), kind: 'inline_comment', sourceId, author: 'octo-guest', association: null, state: null, body: 'COMMENT-TEXT',
  path: 'src/cart/discount.ts', side: 'RIGHT', line: 40, startLine: 38, fileLevel: false, commit: HEAD_A, replyTo: null, thread: null,
  at: at(seconds), delivery: null, ...over,
});
function recording(inner: Db): { db: Db; sent: string[] } {
  const sent: string[] = [];
  const db: Db = {
    query: (text, params) => { sent.push(text); return inner.query(text, params); },
    script: (sql) => inner.script(sql), close: () => inner.close(), transaction: (work) => inner.transaction(work),
  };
  return { db, sent };
}

test('the closed pull requests of a window are read newest first, and an open one or one closed before is not', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(119, 'merged', -3 * DAY));
  await savePullRequest(db, facts(120, 'closed', -DAY));
  await savePullRequest(db, facts(121, 'open', null));
  await savePullRequest(db, facts(118, 'closed', -40 * DAY));
  await savePullRequest(db, { ...facts(122, 'closed', -2 * DAY), ref: refOf(122, 'web') });
  const want = [
    { number: 120, author: 'octo-dev', closed_at: new Date(at(-DAY)) },
    { number: 119, author: 'octo-dev', closed_at: new Date(at(-3 * DAY)) },
  ];
  assert.deepEqual(await closedPulls(db, SHOP, SINCE, 10), want);
  assert.deepEqual(await closedPulls(db, { service: 'github', owner: 'Acme', repo: 'Shop' }, SINCE, 10), want);
  assert.deepEqual(await closedPulls(db, SHOP, SINCE, 1), want.slice(0, 1));
  assert.deepEqual(await closedPulls(db, SHOP, at(-2 * DAY), 10), want.slice(0, 1));
  await db.close();
});

test('the runs that did not fail are read as ids, nothing-new ones included, and no result is read', async () => {
  const inner = await testDb();
  const first = await recordRun(inner, run(119, { startedAt: at(-3 * DAY) }));
  const nothingNew = await recordRun(inner, run(119, { startedAt: at(-2 * DAY), result: { nothingToDo: true, scores: [] } }));
  await recordRun(inner, run(119, { headSha: HEAD_B, outcome: 'failed', failureStage: 'model', failureCode: 'model_timeout', result: {} }));
  const other = await recordRun(inner, run(120, { headSha: HEAD_B }));
  await recordRun(inner, { ...run(119), ref: refOf(119, 'web') });
  const { db, sent } = recording(inner);
  assert.deepEqual(await okRuns(db, SHOP, [119], 10), [
    { id: nothingNew, number: 119, head_sha: HEAD_A, started_at: new Date(at(-2 * DAY)) },
    { id: first, number: 119, head_sha: HEAD_A, started_at: new Date(at(-3 * DAY)) },
  ]);
  assert.deepEqual((await okRuns(db, SHOP, [119, 120], 10)).map((r) => r.id), [other, nothingNew, first]);
  assert.deepEqual((await okRuns(db, SHOP, [119, 120], 2)).map((r) => r.id), [other, nothingNew]);
  assert.deepEqual(await okRuns(db, SHOP, [], 10), []);
  assert.equal(sent.length, 4);
  for (const text of sent) assert.ok(!text.includes('result'), text);
  await inner.close();
});

test('scores are read for the ids given, and a stored result over the size is read as null', async () => {
  const db = await testDb();
  const scores = [{ path: 'src/cart/discount.ts', diffHash: 'd1', changedLines: 4, finalScore: 55, fileLevel: null, blocks: [] }];
  const id = await recordRun(db, run(119, { result: { scores, overview: 'OVERVIEW-TEXT' } }));
  const older = await recordRun(db, run(119, { result: { findings: [] } }));
  await recordRun(db, run(119, { result: { scores } }));
  assert.deepEqual(await runScores(db, [id], 10), [{ id, scores: null }]);
  assert.deepEqual(await runScores(db, [id], 2 * 1024 * 1024), [{ id, scores }]);
  const both = await runScores(db, [id, older], 2 * 1024 * 1024);
  assert.deepEqual(both.sort((a, b) => a.id - b.id), [{ id, scores }, { id: older, scores: null }]);
  assert.deepEqual(await runScores(db, [], 2 * 1024 * 1024), []);
  await db.close();
});

test('the comments, newest pull requests first, the finding threads, the merged reverts, the audits and the feedback of a repository are read as stored', async () => {
  const db = await testDb();
  // Comments: #120 before #119, each pull request's oldest first; a general comment and another repository's are not read.
  await recordActivity(db, inline(119, '7002', 10, { side: null, line: null, startLine: null, fileLevel: true, commit: null, replyTo: '7001' }));
  await recordActivity(db, inline(119, '7001', 5));
  await recordActivity(db, inline(120, '7003', 20, { path: null, fileLevel: null }));
  await recordActivity(db, { ...inline(119, '7004', 1), kind: 'general_comment', path: null, side: null, line: null, startLine: null, fileLevel: null });
  await recordActivity(db, { ...inline(119, '7005', 1), ref: refOf(119, 'web') });
  const comments = await inlineCommentsOf(db, SHOP, [119, 120], 10);
  assert.deepEqual(comments, [
    { id: '7003', number: 120, author: 'octo-guest', path: null, side: 'RIGHT', line: 40, start_line: 38, file_level: null, commit: HEAD_A, reply_to: null },
    { id: '7001', number: 119, author: 'octo-guest', path: 'src/cart/discount.ts', side: 'RIGHT', line: 40, start_line: 38, file_level: false, commit: HEAD_A, reply_to: null },
    { id: '7002', number: 119, author: 'octo-guest', path: 'src/cart/discount.ts', side: null, line: null, start_line: null, file_level: true, commit: null, reply_to: '7001' },
  ]);
  assert.deepEqual((await inlineCommentsOf(db, SHOP, [119, 120], 2)).map((c) => c.id), ['7003', '7001']);
  assert.deepEqual(await inlineCommentsOf(db, SHOP, [], 10), []);

  // Finding threads: the app's findings, not its notes; another repository's are not read.
  const posted = await recordRun(db, run(119));
  await recordComments(db, posted, refOf(119), [
    { commentId: '9001', path: 'src/cart/discount.ts', side: 'RIGHT', line: 40, severity: 'major', quote: 'QUOTE-TEXT' },
    { commentId: '9002', path: 'src/cart/discount.ts', side: 'RIGHT', line: 60, severity: 'note', quote: '', blockHash: 'h2' },
    { commentId: '9003', path: 'src/cart/discount.ts', side: 'LEFT', line: 9, severity: 'blocker', quote: 'QUOTE-TEXT' },
  ]);
  await recordComments(db, posted, refOf(119, 'web'), [{ commentId: '9004', path: 'a.ts', side: 'RIGHT', line: 1, severity: 'minor', quote: 'q' }]);
  const threads = await findingThreads(db, SHOP, [119, 120]);
  assert.deepEqual(threads.map((t) => [t.number, t.comment_id]).sort(), [[119, '9001'], [119, '9003']]);

  // Merged reverts, newest first: approved only for an approval of the app never withdrawn.
  const approve = async (number: number): Promise<number> => {
    const id = await recordRun(db, run(number));
    await markPublished(db, id, { reviewId: `r-${id}`, publishedAt: at(-5 * DAY), body: 'BODY-TEXT', inlineDropped: false, approved: true, approvalCode: 'approved' });
    return id;
  };
  await approve(128);
  const dismissed = await approve(127);
  await markDismissed(db, dismissed, at(-4 * DAY), 'app');
  await savePullRequest(db, facts(130, 'merged', -2 * DAY, { reverts: 128 }));
  await savePullRequest(db, facts(131, 'merged', -DAY, { reverts: 127 }));
  await savePullRequest(db, facts(132, 'closed', -DAY, { reverts: 126 }));
  await savePullRequest(db, { ...facts(133, 'merged', -DAY, { reverts: 128 }), ref: refOf(133, 'web') });
  assert.deepEqual(await mergedReverts(db, SHOP, 1000), [
    { number: 131, reverts: 127, merged_at: new Date(at(-DAY)), approved: false },
    { number: 130, reverts: 128, merged_at: new Date(at(-2 * DAY)), approved: true },
  ]);
  assert.deepEqual((await mergedReverts(db, SHOP, 1)).map((r) => r.number), [131]);

  // Audits: a published run drawn for the audit; another code, or another repository, is not one.
  const drawn = await recordRun(db, run(129));
  await markPublished(db, drawn, { reviewId: 'r-a', publishedAt: at(-DAY), body: 'BODY-TEXT', inlineDropped: false, approvalCode: 'audit_sample' });
  await markPublished(db, await recordRun(db, run(129)), { reviewId: 'r-b', publishedAt: at(-DAY), body: 'BODY-TEXT', inlineDropped: false, approvalCode: 'audit_sample' });
  const elsewhere = await recordRun(db, { ...run(140), ref: refOf(140, 'web') });
  await markPublished(db, elsewhere, { reviewId: 'r-c', publishedAt: at(-DAY), body: 'BODY-TEXT', inlineDropped: false, approvalCode: 'audit_sample' });
  assert.deepEqual(await auditedPulls(db, SHOP, [127, 128, 129, 140]), [129]);
  assert.deepEqual(await auditedPulls(db, SHOP, []), []);

  // Feedback of the window: helpful and not; the reasons grouped by their trimmed text, letter case aside, the newest wording.
  const feed = (login: string, vote: 'up' | 'down', reason: string | null, seconds: number, runId = posted): Promise<boolean> =>
    recordFeedback(db, { run: runId, login, vote, reason, extension: 'example', at: at(seconds) });
  await markPublished(db, posted, { reviewId: 'r-p', publishedAt: at(-DAY), body: 'BODY-TEXT', inlineDropped: false });
  assert.ok(await feed('octo-guest', 'down', 'repeats a settled thread', -3600));
  assert.ok(await feed('octo-lead', 'down', ' Repeats a settled thread', -1800));
  assert.ok(await feed('octo-admin', 'down', 'Too long', -1700));
  assert.ok(await feed('octo-dev', 'down', 'x'.repeat(250), -1600));
  assert.ok(await feed('octo-one', 'down', null, -1500));
  assert.ok(await feed('octo-two', 'down', '   ', -1400));
  assert.ok(await feed('octo-three', 'up', 'Repeats a settled thread', -1300));
  assert.ok(await feed('octo-four', 'down', 'Too long', -40 * DAY));
  assert.ok(await feed('octo-five', 'down', 'Too long', -1200, elsewhere));
  assert.deepEqual(await feedbackCounts(db, SHOP, SINCE), { up: 1, down: 6 });
  assert.deepEqual(await feedbackReasons(db, SHOP, SINCE, 5), [
    { reason: 'Repeats a settled thread', count: 2 }, { reason: 'Too long', count: 1 }, { reason: 'x'.repeat(200), count: 1 },
  ]);
  assert.deepEqual(await feedbackReasons(db, SHOP, SINCE, 1), [{ reason: 'Repeats a settled thread', count: 2 }]);
  assert.deepEqual(await feedbackCounts(db, { service: 'github', owner: 'acme', repo: 'none' }, SINCE), { up: 0, down: 0 });
  await db.close();
});
