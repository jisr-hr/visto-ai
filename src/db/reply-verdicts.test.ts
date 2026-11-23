import test from 'node:test';
import assert from 'node:assert/strict';
import type { PullRequestRef } from '../forge/types.ts';
import { testDb } from './testing.ts';
import type { Db } from './types.ts';
import { recordActivity } from './human-activity.ts';
import type { Activity } from './human-activity.ts';
import { recordComments } from './review-comments.ts';
import type { StoredComment } from './review-comments.ts';
import { markPublished, recordRun } from './review-runs.ts';
import type { RunRecord } from './review-runs.ts';
import { laterVerdict, lessonsMadeSince, noteVerdict, repliesToJudge } from './reply-verdicts.ts';
import type { Verdict } from './reply-verdicts.ts';

const REF: PullRequestRef = { service: 'github', owner: 'acme', repo: 'shop', number: 7 };
const SINCE = '2026-03-01T00:00:00.000Z';
const BEFORE = '2026-03-20T00:00:00.000Z';
const T1 = '2026-03-02T10:00:00.000Z';
const T2 = '2026-03-03T10:00:00.000Z';
const T3 = '2026-03-04T10:00:00.000Z';
const ms = (iso: string, delta: number): string => new Date(Date.parse(iso) + delta).toISOString();
const FINDINGS = [{ path: 'src/billing/tax.ts', side: 'RIGHT', line: 12, severity: 'major', quote: 'total = round(sum)', body: 'Rounds before the discount.' }];

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'b1', baseBranch: 'main',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [], result: { findings: FINDINGS },
  usage: { calls: 1, inputTokens: 1000, outputTokens: 200, cachedTokens: 0, cost: 0.01 },
  startedAt: T1, finishedAt: ms(T1, 60_000), ...over,
});
const posted = (over: Partial<StoredComment> = {}): StoredComment => ({
  commentId: 'c-1', path: 'src/billing/tax.ts', side: 'RIGHT', line: 12, severity: 'major', quote: 'total = round(sum)', ...over,
});
const reply = (over: Partial<Activity> = {}): Activity => ({
  ref: REF, kind: 'inline_comment', sourceId: 'r-1', author: 'octo-lead', association: 'member', state: null,
  body: 'We round half up here on purpose.', path: 'src/billing/tax.ts', side: 'RIGHT', line: 12, startLine: null, fileLevel: false,
  commit: 'h1', replyTo: 'c-1', thread: null, at: T2, delivery: 'd-1', ...over,
});
const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  ref: REF, reply: 'r-1', finding: 'c-1', classification: null, outcome: 'unjudged', attempts: 1, judgedAt: T1, ...over,
});
const replies = async (db: Db, limit = 100, maxAttempts = 3, since = SINCE, before = BEFORE): Promise<string[]> =>
  (await repliesToJudge(db, since, before, limit, maxAttempts)).map((r) => r.reply);

/** A run with finding c-1 posted, and note c-2. Returns the run's id. */
async function withFinding(db: Db): Promise<number> {
  const id = await recordRun(db, run());
  await recordComments(db, id, REF, [posted(), posted({ commentId: 'c-2', severity: 'note', quote: 'tax = rate * total' })]);
  return id;
}
async function publishedRun(db: Db, startedAt: string, result: unknown, number = 7, published = true): Promise<number> {
  const id = await recordRun(db, run({ ref: { ...REF, number }, startedAt, finishedAt: ms(startedAt, 60_000), result }));
  if (published) await markPublished(db, id, { reviewId: `rv-${id}`, publishedAt: ms(startedAt, 60_000), body: 'text', inlineDropped: false });
  return id;
}

test('a reply under a finding is queued with its finding, and nothing else is', async () => {
  const db = await testDb();
  await withFinding(db);
  await recordActivity(db, reply());
  await recordActivity(db, reply({ sourceId: 'r-2', replyTo: 'c-2' }));
  await recordActivity(db, reply({ sourceId: 'r-3', replyTo: null }));
  await recordActivity(db, reply({ sourceId: 'r-4', replyTo: 'c-9' }));
  await recordActivity(db, reply({ sourceId: 'g-1', kind: 'general_comment', path: null, side: null, line: null, fileLevel: null }));
  await recordActivity(db, reply({ sourceId: 'v-1', kind: 'review', state: 'commented', path: null, side: null, line: null, fileLevel: null }));
  assert.deepEqual(await repliesToJudge(db, SINCE, BEFORE, 100, 3), [{
    ref: REF, reply: 'r-1', association: 'member', body: 'We round half up here on purpose.', at: T2,
    finding: 'c-1', path: 'src/billing/tax.ts', side: 'RIGHT', line: 12, severity: 'major', quote: 'total = round(sum)',
    findings: FINDINGS, attempts: 0,
  }]);
  await db.close();
});

test('the queue holds the replies written from since up to, and not at, before', async () => {
  const db = await testDb();
  await withFinding(db);
  await recordActivity(db, reply({ sourceId: 'r-1', at: SINCE }));
  await recordActivity(db, reply({ sourceId: 'r-2', at: ms(BEFORE, -1) }));
  await recordActivity(db, reply({ sourceId: 'r-3', at: BEFORE }));
  await recordActivity(db, reply({ sourceId: 'r-4', at: ms(SINCE, -1) }));
  assert.deepEqual(await replies(db), ['r-1', 'r-2']);
  await db.close();
});

test('replies by people with access come first, then the oldest, and no more than the limit', async () => {
  const db = await testDb();
  await withFinding(db);
  await recordActivity(db, reply({ sourceId: 'r-stranger', author: 'octo-guest', association: 'none', at: '2026-03-02T09:00:00.000Z' }));
  await recordActivity(db, reply({ sourceId: 'r-unknown', author: 'octo-guest', association: null, at: '2026-03-02T09:30:00.000Z' }));
  await recordActivity(db, reply({ sourceId: 'r-member', author: 'octo-lead', association: 'member', at: '2026-03-02T10:00:00.000Z' }));
  await recordActivity(db, reply({ sourceId: 'r-owner', author: 'octo-dev', association: 'owner', at: '2026-03-02T11:00:00.000Z' }));
  assert.deepEqual(await replies(db, 3), ['r-member', 'r-owner', 'r-stranger']);
  assert.deepEqual(await replies(db, 10), ['r-member', 'r-owner', 'r-stranger', 'r-unknown']);
  await db.close();
});

test('a reply with a classification leaves the queue, and one without stays until its attempts reach the limit', async () => {
  const db = await testDb();
  await withFinding(db);
  await recordActivity(db, reply());
  await recordActivity(db, reply({ sourceId: 'r-2', at: T3 }));
  await noteVerdict(db, verdict({ classification: 'noise', outcome: 'none' }));
  assert.deepEqual(await replies(db), ['r-2']);
  await noteVerdict(db, verdict({ reply: 'r-2', attempts: 2 }));
  const [queued] = await repliesToJudge(db, SINCE, BEFORE, 100, 3);
  assert.deepEqual([queued!.reply, queued!.attempts], ['r-2', 2]);
  await noteVerdict(db, verdict({ reply: 'r-2', attempts: 3 }));
  assert.deepEqual(await replies(db, 100, 3), []);
  assert.deepEqual(await replies(db, 100, 4), ['r-2']);
  await db.close();
});

test('a verdict that has a classification is never written again, and one that has none is replaced', async () => {
  const db = await testDb();
  const row = async (): Promise<unknown[]> =>
    db.query('select service, owner, repo, number, reply, finding, classification, outcome, attempts, judged_at from visto_ai.reply_verdicts');
  const stored = (classification: string | null, outcome: string, attempts: number, judgedAt: string): unknown => ({
    service: 'github', owner: 'acme', repo: 'shop', number: 7, reply: 'r-1', finding: 'c-1', classification, outcome, attempts, judged_at: new Date(judgedAt),
  });
  await noteVerdict(db, verdict({ classification: null, outcome: 'unjudged', attempts: 1, judgedAt: T1 }));
  assert.deepEqual(await row(), [stored(null, 'unjudged', 1, T1)]);
  await noteVerdict(db, verdict({ classification: 'valid_pushback', outcome: 'lesson', attempts: 1, judgedAt: T2 }));
  assert.deepEqual(await row(), [stored('valid_pushback', 'lesson', 1, T2)]);
  await noteVerdict(db, verdict({ classification: 'noise', outcome: 'none', attempts: 5, judgedAt: T3 }));
  assert.deepEqual(await row(), [stored('valid_pushback', 'lesson', 1, T2)]);
  await db.close();
});

test('the lessons made since a time are counted by when they were judged', async () => {
  const db = await testDb();
  await noteVerdict(db, verdict({ reply: 'r-1', classification: 'valid_pushback', outcome: 'lesson', judgedAt: ms(T2, -1) }));
  await noteVerdict(db, verdict({ reply: 'r-2', classification: 'valid_pushback', outcome: 'lesson', judgedAt: T2 }));
  await noteVerdict(db, verdict({ reply: 'r-3', classification: 'valid_pushback', outcome: 'lesson', judgedAt: T3 }));
  await noteVerdict(db, verdict({ reply: 'r-4', classification: 'valid_pushback', outcome: 'review_disagreed', judgedAt: T3 }));
  assert.equal(await lessonsMadeSince(db, T2), 2);
  await db.close();
});

test('the later verdict is that of the newest published run started after the reply', async () => {
  const db = await testDb();
  const kept = (commentId: string, v: string): unknown => ({ findings: [], threadVerdicts: [{ commentId, verdict: v }] });
  await publishedRun(db, ms(T2, -1000), kept('c-1', 'open'));
  await publishedRun(db, ms(T2, 1000), kept('c-1', 'answered'));
  await publishedRun(db, ms(T2, 2000), kept('c-1', 'open'), 7, false);
  assert.equal(await laterVerdict(db, REF, 'c-1', T2), 'answered');
  await publishedRun(db, ms(T2, 3000), kept('c-5', 'fixed'));
  assert.equal(await laterVerdict(db, REF, 'c-1', T2), 'answered');
  assert.equal(await laterVerdict(db, REF, 'c-1', ms(T2, 3000)), null);
  await publishedRun(db, ms(T2, 4000), kept('c-1', 'fixed'), 9);
  assert.equal(await laterVerdict(db, { ...REF, number: 8 }, 'c-1', T2), null);
  assert.equal(await laterVerdict(db, REF, 'c-1', T2), 'answered');
  await db.close();
});

test('a stored result with no list of verdicts, or a damaged one, holds none and throws nothing', async () => {
  const db = await testDb();
  for (const result of [{}, { threadVerdicts: 'x' }, { threadVerdicts: [5, null, {}] }, null, 'x']) {
    await publishedRun(db, ms(T2, 1000), result);
    assert.equal(await laterVerdict(db, REF, 'c-1', T2), null, JSON.stringify(result));
  }
  await db.close();
});

test('the owner and the name of a repository are compared in lower case', async () => {
  const db = await testDb();
  const upper: PullRequestRef = { ...REF, owner: 'Acme', repo: 'Shop' };
  await noteVerdict(db, verdict({ ref: upper }));
  assert.deepEqual(await db.query('select owner, repo from visto_ai.reply_verdicts'), [{ owner: 'acme', repo: 'shop' }]);
  await publishedRun(db, ms(T2, 1000), { threadVerdicts: [{ commentId: 'c-1', verdict: 'fixed' }] });
  assert.equal(await laterVerdict(db, upper, 'c-1', T2), 'fixed');
  await db.close();
});

test('of two later published runs that kept the same thread, the newer one gives the verdict, and a run started at the reply is not later', async () => {
  const db = await testDb();
  const kept = (v: string): unknown => ({ findings: [], threadVerdicts: [{ commentId: 'c-1', verdict: v }] });
  await publishedRun(db, T2, kept('answered'));
  assert.equal(await laterVerdict(db, REF, 'c-1', T2), null);
  await publishedRun(db, ms(T2, 1000), kept('open'));
  await publishedRun(db, ms(T2, 2000), kept('fixed'));
  assert.equal(await laterVerdict(db, REF, 'c-1', T2), 'fixed');
  await db.close();
});

test('a run of another owner\'s repository of the same name and number is never the later verdict', async () => {
  const db = await testDb();
  const other = async (): Promise<void> => {
    const id = await recordRun(db, run({ ref: { ...REF, owner: 'octo' }, startedAt: ms(T2, 5000), result: { threadVerdicts: [{ commentId: 'c-1', verdict: 'fixed' }] } }));
    await markPublished(db, id, { reviewId: `rv-${id}`, publishedAt: ms(T2, 6000), body: 'text', inlineDropped: false });
  };
  await other();
  assert.equal(await laterVerdict(db, REF, 'c-1', T2), null);
  await publishedRun(db, ms(T2, 1000), { threadVerdicts: [{ commentId: 'c-1', verdict: 'answered' }] });
  await other();
  assert.equal(await laterVerdict(db, REF, 'c-1', T2), 'answered');
  await db.close();
});

test('a reply on another pull request or another repository that names a posted comment of this one is not queued', async () => {
  const db = await testDb();
  await withFinding(db);
  await recordActivity(db, reply());
  await recordActivity(db, reply({ sourceId: 'r-pr8', ref: { ...REF, number: 8 } }));
  await recordActivity(db, reply({ sourceId: 'r-web', ref: { ...REF, repo: 'web' } }));
  await recordActivity(db, reply({ sourceId: 'r-octo', ref: { ...REF, owner: 'octo' } }));
  assert.deepEqual(await replies(db), ['r-1']);
  await db.close();
});

test('a collaborator\'s reply sorts with those of people with access', async () => {
  const db = await testDb();
  await withFinding(db);
  await recordActivity(db, reply({ sourceId: 'r-stranger', author: 'octo-guest', association: 'none', at: '2026-03-02T09:00:00.000Z' }));
  await recordActivity(db, reply({ sourceId: 'r-collab', author: 'octo-dev', association: 'collaborator', at: '2026-03-02T10:00:00.000Z' }));
  assert.deepEqual(await replies(db), ['r-collab', 'r-stranger']);
  await db.close();
});

test('the queue is in the order the replies were written, and two written at the same instant in the order they were stored', async () => {
  const db = await testDb();
  await withFinding(db);
  await recordActivity(db, reply({ sourceId: 'r-late', at: '2026-03-02T11:00:00.000Z' }));
  await recordActivity(db, reply({ sourceId: 'r-early', at: '2026-03-02T09:00:00.000Z' }));
  await recordActivity(db, reply({ sourceId: 'r-tie-1', at: '2026-03-02T10:00:00.000Z' }));
  await recordActivity(db, reply({ sourceId: 'r-tie-2', at: '2026-03-02T10:00:00.000Z' }));
  assert.deepEqual(await replies(db), ['r-early', 'r-tie-1', 'r-tie-2', 'r-late']);
  await db.close();
});
