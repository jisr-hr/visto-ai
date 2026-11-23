import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../db/testing.ts';
import { markPublished, recordRun } from '../db/review-runs.ts';
import type { RunRecord } from '../db/review-runs.ts';
import type { Db } from '../db/types.ts';
import { createFeedback, LOGIN_MAX_CHARS, REASON_MAX_CHARS } from './feedback.ts';
import type { FeedbackAnswer } from '../extensions/types.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'b1', baseBranch: null,
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [], result: { findings: [] },
  usage: { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 },
  startedAt: at(0), finishedAt: at(9), ...over,
});
async function setup(over: Partial<RunRecord> = {}, publish = true) {
  const db = await testDb();
  const id = await recordRun(db, run(over));
  if (publish) await markPublished(db, id, { reviewId: 'r1', publishedAt: at(1), body: 'text', inlineDropped: false });
  const logged: Array<Record<string, unknown>> = [];
  const report = createFeedback({ db, clock: () => new Date(at(30)), log: (e) => { logged.push(e); } });
  const rows = (): Promise<Array<Record<string, unknown>>> => db.query('select run, login, vote, reason, extension, at from visto_ai.review_feedback order by id');
  return { db, id, report, logged, rows };
}
const raw = (x: unknown): FeedbackAnswer => x as FeedbackAnswer;

test('a good answer is stored, and logged without the login and the reason', async () => {
  const h = await setup();
  assert.deepEqual(await h.report('chat', { run: h.id, login: 'octo-dev', vote: 'down', reason: 'too noisy to read' }), { ok: true });
  assert.deepEqual(h.logged, [{ event: 'feedback', extension: 'chat', run: h.id, vote: 'down', outcome: 'stored' }]);
  const text = JSON.stringify(h.logged);
  assert.equal(text.includes('octo-dev') || text.includes('too noisy'), false);
  const [row] = await h.rows();
  assert.equal(new Date(String(row!['at'])).toISOString(), at(30));
  assert.equal(row!['extension'], 'chat');
  await h.db.close();
});
test('the login is trimmed, loses one leading @ and is lower-cased, so two spellings are one person', async () => {
  const h = await setup();
  await h.report('chat', { run: h.id, login: ' @Octo-Dev ', vote: 'up' });
  await h.report('chat', { run: h.id, login: 'octo-dev', vote: 'down' });
  const rows = await h.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!['login'], rows[0]!['vote']], ['octo-dev', 'down']);
  await h.db.close();
});
test('what is refused as bad_answer, with nothing stored', async () => {
  const h = await setup();
  const ok = { run: h.id, login: 'octo-dev', vote: 'up' };
  const bad: unknown[] = [
    null, 'x', undefined, 5, [],
    { ...ok, run: 0 }, { ...ok, run: 1.5 }, { ...ok, run: '12' }, { ...ok, run: 2147483648 }, { ...ok, run: -3 }, { ...ok, run: Number.NaN },
    { ...ok, login: '' }, { ...ok, login: '   ' }, { ...ok, login: '@' }, { ...ok, login: 'a b' }, { ...ok, login: 'a\nb' }, { ...ok, login: 'a\u0000b' },
    { ...ok, login: 'a'.repeat(LOGIN_MAX_CHARS + 1) }, { ...ok, login: 5 }, { ...ok, login: undefined },
    { ...ok, vote: 'maybe' }, { ...ok, vote: 'UP' }, { ...ok, vote: undefined },
    { ...ok, reason: 5 }, { ...ok, reason: {} },
  ];
  for (const b of bad) assert.deepEqual(await h.report('chat', raw(b)), { ok: false, code: 'bad_answer' }, JSON.stringify(b));
  assert.equal((await h.rows()).length, 0);
  assert.equal(h.logged.every((e) => e['outcome'] === 'bad_answer'), true);
  assert.equal(h.logged.length, bad.length);
  await h.db.close();
});
test('a login of the longest size is accepted, and an answer whose fields throw when read is refused', async () => {
  const h = await setup();
  assert.deepEqual(await h.report('chat', { run: h.id, login: 'a'.repeat(LOGIN_MAX_CHARS), vote: 'up' }), { ok: true });
  const trap = { get run(): number { throw new Error('boom'); } };
  assert.deepEqual(await h.report('chat', raw(trap)), { ok: false, code: 'bad_answer' });
  assert.equal(JSON.stringify(h.logged).includes('boom'), false);
  await h.db.close();
});
test('a long reason is cut at 1,000 characters, an empty one is stored as none, and a NUL is removed', async () => {
  const h = await setup();
  const NUL = String.fromCharCode(0);
  await h.report('chat', { run: h.id, login: 'a', vote: 'up', reason: 'x'.repeat(REASON_MAX_CHARS + 50) });
  await h.report('chat', { run: h.id, login: 'b', vote: 'up', reason: '   ' });
  await h.report('chat', { run: h.id, login: 'c', vote: 'up', reason: `  a${NUL}b  ` });
  await h.report('chat', raw({ run: h.id, login: 'd', vote: 'up', reason: null }));
  // a pair of characters that straddles the cut is not split
  await h.report('chat', { run: h.id, login: 'e', vote: 'up', reason: 'y'.repeat(REASON_MAX_CHARS - 1) + '\u{1F600}' });
  const by = Object.fromEntries((await h.rows()).map((r) => [String(r['login']), r['reason']]));
  assert.equal(String(by['a']).length, REASON_MAX_CHARS);
  assert.equal(by['b'], null);
  assert.equal(by['c'], 'ab');
  assert.equal(by['d'], null);
  assert.equal(by['e'], 'y'.repeat(REASON_MAX_CHARS - 1));
  await h.db.close();
});
test('an unknown run, an unpublished run and a dry run answer unknown_run', async () => {
  const h = await setup({}, false);
  const dry = await recordRun(h.db, run({ dryRun: true }));
  for (const id of [h.id, dry, h.id + 1000]) {
    assert.deepEqual(await h.report('chat', { run: id, login: 'octo-dev', vote: 'up' }), { ok: false, code: 'unknown_run' });
  }
  assert.equal((await h.rows()).length, 0);
  assert.deepEqual(h.logged.map((e) => e['outcome']), ['unknown_run', 'unknown_run', 'unknown_run']);
  await h.db.close();
});
test('a database that fails answers store_failed, and nothing is thrown', async () => {
  const logged: Array<Record<string, unknown>> = [];
  const db = { query: async () => { throw new Error('connection to 10.0.0.5 refused'); } } as unknown as Db;
  const report = createFeedback({ db, clock: () => new Date(at(30)), log: (e) => { logged.push(e); } });
  assert.deepEqual(await report('chat', { run: 3, login: 'octo-dev', vote: 'up' }), { ok: false, code: 'store_failed' });
  assert.deepEqual(logged, [{ event: 'feedback', extension: 'chat', run: 3, vote: 'up', outcome: 'store_failed' }]);
  assert.equal(JSON.stringify(logged).includes('10.0.0.5'), false);
});
test('a logger that throws changes nothing, and a bad answer logs no run and no vote', async () => {
  const h = await setup();
  const report = createFeedback({ db: h.db, clock: () => new Date(at(30)), log: () => { throw new Error('log down'); } });
  assert.deepEqual(await report('chat', { run: h.id, login: 'octo-dev', vote: 'up' }), { ok: true });
  assert.deepEqual(await report('chat', raw({ run: 'x', login: 'octo-dev', vote: 'up' })), { ok: false, code: 'bad_answer' });
  const report2 = createFeedback({ db: h.db, clock: () => new Date(at(30)), log: (e) => { h.logged.push(e); } });
  await report2('chat', raw({ run: 'x', login: 'octo-dev', vote: 'sideways' }));
  assert.deepEqual(h.logged, [{ event: 'feedback', extension: 'chat', run: null, vote: null, outcome: 'bad_answer' }]);
  await h.db.close();
});
test('a login with a hidden character, a broken pair, or a length over the limit once lower-cased is refused', async () => {
  const h = await setup();
  const bad = ['\u200b', 'ab\u202e', 'a\ud800', 'a\ud801', '\u0130'.repeat(LOGIN_MAX_CHARS)];
  for (const login of bad) {
    assert.deepEqual(await h.report('chat', { run: h.id, login, vote: 'up' }), { ok: false, code: 'bad_answer' }, JSON.stringify(login));
  }
  assert.equal((await h.rows()).length, 0);
  assert.deepEqual(await h.report('chat', { run: h.id, login: '\u0130'.repeat(50), vote: 'up' }), { ok: true });
  await h.db.close();
});
test('a reason cut at the limit keeps no trailing space', async () => {
  const h = await setup();
  await h.report('chat', { run: h.id, login: 'a', vote: 'up', reason: 'x'.repeat(REASON_MAX_CHARS - 1) + ' y' });
  const [row] = await h.rows();
  assert.equal(row!['reason'], 'x'.repeat(REASON_MAX_CHARS - 1));
  await h.db.close();
});
