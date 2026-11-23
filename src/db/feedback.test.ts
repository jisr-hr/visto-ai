import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import { recordFeedback } from './feedback.ts';
import type { Feedback } from './feedback.ts';
import { markPublished, recordRun } from './review-runs.ts';
import type { RunRecord } from './review-runs.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'b1', baseBranch: null,
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [], result: { findings: [] },
  usage: { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 },
  startedAt: at(0), finishedAt: at(9), ...over,
});
const publish = async (db: Awaited<ReturnType<typeof testDb>>, over: Partial<RunRecord> = {}): Promise<number> => {
  const id = await recordRun(db, run(over));
  await markPublished(db, id, { reviewId: 'r1', publishedAt: at(1), body: 'text', inlineDropped: false });
  return id;
};
const answer = (runId: number, over: Partial<Feedback> = {}): Feedback => ({ run: runId, login: 'octo-dev', vote: 'up', reason: null, extension: 'chat', at: at(20), ...over });
const rows = (db: Awaited<ReturnType<typeof testDb>>): Promise<Array<Record<string, unknown>>> =>
  db.query('select id, run, service, owner, repo, number, login, vote, reason, extension, at from visto_ai.review_feedback order by id');

test('an answer is stored for a published run, with the repository and the number of that run', async () => {
  const db = await testDb();
  const id = await publish(db);
  assert.equal(await recordFeedback(db, answer(id)), true);
  const [row] = await rows(db);
  assert.deepEqual([row!['run'], row!['service'], row!['owner'], row!['repo'], row!['number'], row!['login'], row!['vote'], row!['reason'], row!['extension']],
    [id, 'github', 'acme', 'shop', 7, 'octo-dev', 'up', null, 'chat']);
  assert.equal(new Date(String(row!['at'])).toISOString(), at(20));
  await db.close();
});
test('a second answer of the same person replaces the first, and another person stands beside it', async () => {
  const db = await testDb();
  const id = await publish(db);
  await recordFeedback(db, answer(id));
  const [first] = await rows(db);
  assert.equal(await recordFeedback(db, answer(id, { vote: 'down', reason: 'noisy', at: at(40) })), true);
  const after = await rows(db);
  assert.equal(after.length, 1);
  assert.deepEqual([after[0]!['id'], after[0]!['vote'], after[0]!['reason']], [first!['id'], 'down', 'noisy']);
  assert.equal(new Date(String(after[0]!['at'])).toISOString(), at(40));
  await recordFeedback(db, answer(id, { login: 'octo-lead' }));
  assert.equal((await rows(db)).length, 2);
  await db.close();
});
test('nothing is stored for a run that is not published, or that does not exist', async () => {
  const db = await testDb();
  const recorded = await recordRun(db, run());
  const dry = await recordRun(db, run({ dryRun: true }));
  assert.equal(await recordFeedback(db, answer(recorded)), false);
  assert.equal(await recordFeedback(db, answer(dry)), false);
  assert.equal(await recordFeedback(db, answer(recorded + 1000)), false);
  assert.equal((await rows(db)).length, 0);
  await db.close();
});
test('nothing is stored for a dry run even when a stamp of publication was written on it', async () => {
  const db = await testDb();
  const dry = await publish(db, { dryRun: true });
  assert.equal(await recordFeedback(db, answer(dry)), false);
  assert.equal((await rows(db)).length, 0);
  await db.close();
});
test('the table refuses a vote that is neither up nor down', async () => {
  const db = await testDb();
  await assert.rejects(db.query(
    `insert into visto_ai.review_feedback (run, service, owner, repo, number, login, vote, extension, at)
     values (1, 'github', 'acme', 'shop', 7, 'octo-dev', 'maybe', 'chat', now())`));
  await db.close();
});
