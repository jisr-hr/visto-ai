import test from 'node:test';
import assert from 'node:assert/strict';
import type { PullRequestFacts, PullRequestRef } from '../forge/types.ts';
import { testDb } from './testing.ts';
import type { Db } from './types.ts';
import { recordActivity } from './human-activity.ts';
import type { Activity } from './human-activity.ts';
import { savePullRequest } from './pull-requests.ts';
import { inlineComments, markLearned, noteLearnFailure, noteLearning, pullRequestsToLearn, readLearning, startLearning } from './learning.ts';

const REF: PullRequestRef = { service: 'github', owner: 'acme', repo: 'shop', number: 7 };
const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-02T10:00:00.000Z';
const T3 = '2026-03-03T10:00:00.000Z';
const CLOSED = '2026-03-10T12:00:00.000Z';

const facts = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref: REF, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feature', headSha: 'aaa111',
  draft: false, state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '55',
  updatedAt: T1, ...over,
});
const closed = (over: Partial<PullRequestFacts> = {}): PullRequestFacts =>
  facts({ state: 'closed', closedAt: CLOSED, updatedAt: CLOSED, ...over });
const comment = (over: Partial<Activity> = {}): Activity => ({
  ref: REF, kind: 'inline_comment', sourceId: 'c-1', author: 'octo-lead', association: 'member', state: null,
  body: 'check the rounding here', path: 'src/billing/tax.ts', side: 'RIGHT', line: 12, startLine: null, fileLevel: false,
  commit: 'aaa111', replyTo: null, thread: null, at: T2, delivery: 'd-1', ...over,
});
const numbers = async (db: Db, after: PullRequestRef | null = null, limit = 10, maxAttempts = 3): Promise<number[]> =>
  (await pullRequestsToLearn(db, limit, after, maxAttempts)).map((p) => p.ref.number);
const learnedAt = async (db: Db, number = 7): Promise<string | null> =>
  (await db.query<{ t: Date | null }>('select learned_at as t from visto_ai.pull_requests where number = $1', [number]))[0]!.t?.toISOString() ?? null;

test('the row of a work is made once, and a second start changes nothing', async () => {
  const db = await testDb();
  const zero = { examined: 0, added: 0, retired: 0, failed: 0 };
  assert.deepEqual(await readLearning(db, 'signals'), null);
  assert.deepEqual(await startLearning(db, 'signals', T1), { since: T1, ranAt: null, ...zero });
  assert.deepEqual(await startLearning(db, 'signals', T2), { since: T1, ranAt: null, ...zero });
  assert.deepEqual(await readLearning(db, 'signals'), { since: T1, ranAt: null, ...zero });
  assert.deepEqual(await readLearning(db, 'lessons'), null);
  await db.close();
});

test('a completed pass moves ran_at and raises the totals', async () => {
  const db = await testDb();
  await startLearning(db, 'signals', T1);
  await noteLearning(db, 'signals', T2, { examined: 2, added: 1, retired: 0, failed: 0 });
  await noteLearning(db, 'signals', T3, { examined: 1, added: 1, retired: 3, failed: 1 });
  assert.deepEqual(await readLearning(db, 'signals'), { since: T1, ranAt: T3, examined: 3, added: 2, retired: 3, failed: 1 });
  await db.close();
});

test('a completed pass with no row makes it', async () => {
  const db = await testDb();
  await noteLearning(db, 'signals', T2, { examined: 4, added: 2, retired: 1, failed: 0 });
  assert.deepEqual(await readLearning(db, 'signals'), { since: T2, ranAt: T2, examined: 4, added: 2, retired: 1, failed: 0 });
  await db.close();
});

test('a closed pull request not yet learned has work, and one learned since its close has none', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await savePullRequest(db, facts({ ref: { ...REF, number: 8 } }));
  await savePullRequest(db, facts({ ref: { ...REF, number: 9 }, state: 'merged', mergedAt: CLOSED, closedAt: CLOSED, updatedAt: CLOSED }));
  const work = await pullRequestsToLearn(db, 10, null, 3);
  assert.deepEqual(work, [
    { ref: REF, author: 'octo-dev', closedAt: CLOSED },
    { ref: { ...REF, number: 9 }, author: 'octo-dev', closedAt: CLOSED },
  ]);
  await markLearned(db, REF, [], T1, CLOSED);
  await markLearned(db, { ...REF, number: 9 }, [], '2026-03-11T00:00:00.000Z', CLOSED);
  assert.deepEqual(await numbers(db), []);
  await db.close();
});

test('the close time of a pull request with no close date is its merge, then its last update', async () => {
  const db = await testDb();
  await savePullRequest(db, facts({ state: 'merged', mergedAt: T2, closedAt: null, updatedAt: T3 }));
  await savePullRequest(db, facts({ ref: { ...REF, number: 8 }, state: 'closed', mergedAt: null, closedAt: null, updatedAt: T3 }));
  assert.deepEqual((await pullRequestsToLearn(db, 10, null, 3)).map((p) => p.closedAt), [T2, T3]);
  await db.close();
});

test('a pull request closed again after it was learned has work again', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await markLearned(db, REF, [], CLOSED, CLOSED);
  assert.deepEqual(await numbers(db), []);
  await savePullRequest(db, facts({ updatedAt: '2026-03-11T00:00:00.000Z' }));
  assert.deepEqual(await numbers(db), []);
  const again = '2026-03-12T00:00:00.000Z';
  await savePullRequest(db, closed({ closedAt: again, updatedAt: again }));
  assert.deepEqual(await pullRequestsToLearn(db, 10, null, 3), [{ ref: REF, author: 'octo-dev', closedAt: again }]);
  await db.close();
});

test('an inline comment not yet looked at gives its pull request work, open or closed, and a general comment gives none', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  await savePullRequest(db, closed({ ref: { ...REF, number: 8 } }));
  await savePullRequest(db, facts({ ref: { ...REF, number: 9 } }));
  await markLearned(db, { ...REF, number: 8 }, [], CLOSED, CLOSED);
  assert.deepEqual(await numbers(db), []);
  await recordActivity(db, comment());
  await recordActivity(db, comment({ ref: { ...REF, number: 8 }, sourceId: 'c-8' }));
  await recordActivity(db, comment({ ref: { ...REF, number: 9 }, kind: 'general_comment', sourceId: 'g-9', path: null, side: null, line: null, fileLevel: null }));
  const work = await pullRequestsToLearn(db, 10, null, 3);
  assert.deepEqual(work, [
    { ref: REF, author: 'octo-dev', closedAt: null },
    { ref: { ...REF, number: 8 }, author: 'octo-dev', closedAt: CLOSED },
  ]);
  await markLearned(db, REF, ['c-1'], T3, null);
  await markLearned(db, { ...REF, number: 8 }, ['c-8'], T3, null);
  assert.deepEqual(await numbers(db), []);
  await db.close();
});

test('a comment whose pull request is not stored gives no work', async () => {
  const db = await testDb();
  await recordActivity(db, comment());
  assert.deepEqual(await numbers(db), []);
  await db.close();
});

test('the comments of a pull request are read oldest first, inline ones only, with whether each was looked at', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const late = comment({ sourceId: 'c-2', at: T3, replyTo: 'c-1', thread: 't-1', body: 'and here' });
  const early = comment({ sourceId: 'c-1', at: T2, thread: 't-1' });
  await recordActivity(db, late);
  await recordActivity(db, early);
  await recordActivity(db, comment({ kind: 'general_comment', sourceId: 'g-1', path: null, side: null, line: null, fileLevel: null }));
  await recordActivity(db, comment({ ref: { ...REF, number: 8 }, sourceId: 'c-8' }));
  await markLearned(db, REF, ['c-2'], T3, null);
  assert.deepEqual(await inlineComments(db, { ...REF, owner: 'Acme', repo: 'Shop' }), [
    { comment: early, learned: false },
    { comment: late, learned: true },
  ]);
  await db.close();
});

test('marking names the comments it marks, and a closed pull request is marked at its close', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await recordActivity(db, comment({ sourceId: 'c-1' }));
  await recordActivity(db, comment({ sourceId: 'c-2' }));
  await recordActivity(db, comment({ kind: 'general_comment', sourceId: 'c-2', path: null, side: null, line: null, fileLevel: null }));
  await recordActivity(db, comment({ ref: { ...REF, number: 8 }, sourceId: 'c-3' }));
  await markLearned(db, REF, ['c-1', 'c-3'], '2026-03-09T00:00:00.000Z', CLOSED);
  const marks = await db.query<{ number: number; kind: string; source_id: string; learned_at: Date | null }>(
    'select number, kind, source_id, learned_at from visto_ai.human_activity order by number, source_id, kind');
  assert.deepEqual(marks.map((m) => [m.number, m.kind, m.source_id, m.learned_at?.toISOString() ?? null]), [
    [7, 'inline_comment', 'c-1', '2026-03-09T00:00:00.000Z'],
    [7, 'general_comment', 'c-2', null],
    [7, 'inline_comment', 'c-2', null],
    [8, 'inline_comment', 'c-3', null],
  ]);
  assert.equal(await learnedAt(db), CLOSED);
  const later = '2026-03-11T00:00:00.000Z';
  await markLearned(db, REF, ['c-1', 'c-2'], later, CLOSED);
  assert.equal(await learnedAt(db), CLOSED);
  const again = await db.query<{ source_id: string; learned_at: Date }>(
    "select source_id, learned_at from visto_ai.human_activity where number = 7 and kind = 'inline_comment' order by source_id");
  assert.deepEqual(again.map((m) => [m.source_id, m.learned_at.toISOString()]), [['c-1', '2026-03-09T00:00:00.000Z'], ['c-2', later]]);
  await markLearned(db, REF, [], '2026-03-12T00:00:00.000Z', null);
  assert.equal(await learnedAt(db), CLOSED);
  await db.close();
});

test('the pull requests with work come in a fixed order, after the one named, no more than the limit', async () => {
  const db = await testDb();
  for (const number of [12, 3, 8]) await savePullRequest(db, closed({ ref: { ...REF, number } }));
  await savePullRequest(db, closed({ ref: { ...REF, repo: 'web', number: 1 } }));
  await savePullRequest(db, closed({ ref: { ...REF, owner: 'zeta', number: 1 } }));
  assert.deepEqual(await numbers(db, null, 2), [3, 8]);
  assert.deepEqual(await numbers(db, { ...REF, number: 8 }, 2), [12, 1]);
  const rest = await pullRequestsToLearn(db, 10, { ...REF, number: 12 }, 3);
  assert.deepEqual(rest.map((p) => `${p.ref.owner}/${p.ref.repo}#${p.ref.number}`), ['acme/web#1', 'zeta/shop#1']);
  assert.deepEqual(await numbers(db, { ...REF, owner: 'ACME', repo: 'SHOP', number: 8 }, 1), [12]);
  assert.deepEqual(await numbers(db, { ...REF, owner: 'zeta', number: 1 }), []);
  await db.close();
});

test('a failed attempt is counted, a pull request at the limit of attempts is left out, and marking it starts the count again', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  assert.equal(await noteLearnFailure(db, REF), 1);
  assert.equal(await noteLearnFailure(db, REF), 2);
  assert.equal(await noteLearnFailure(db, { ...REF, owner: 'ACME' }), 3);
  assert.deepEqual(await numbers(db, null, 10, 3), []);
  assert.deepEqual(await numbers(db, null, 10, 4), [7]);
  await markLearned(db, REF, [], T1, null);
  assert.deepEqual(await db.query('select learn_attempts from visto_ai.pull_requests'), [{ learn_attempts: 0 }]);
  assert.deepEqual(await numbers(db, null, 10, 3), [7]);
  assert.equal(await noteLearnFailure(db, { ...REF, number: 99 }), 0);
  await db.close();
});

test('two passes noted out of order leave the later time, and the totals still add up', async () => {
  const db = await testDb();
  await noteLearning(db, 'signals', '2026-03-02T10:00:00.010Z', { examined: 1, added: 1, retired: 0, failed: 0 });
  await noteLearning(db, 'signals', '2026-03-02T10:00:00.005Z', { examined: 2, added: 0, retired: 1, failed: 1 });
  assert.deepEqual(await readLearning(db, 'signals'), { since: '2026-03-02T10:00:00.010Z', ranAt: '2026-03-02T10:00:00.010Z', examined: 3, added: 1, retired: 1, failed: 1 });
  await db.close();
});

test('a closed pull request is marked learned for its close, never for a later now', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await markLearned(db, REF, [], '2026-03-10T12:10:00.000Z', CLOSED);
  assert.equal(await learnedAt(db), CLOSED);
  await markLearned(db, REF, [], '2026-03-12T00:00:00.000Z', null);
  assert.equal(await learnedAt(db), CLOSED);
  await db.close();
});
