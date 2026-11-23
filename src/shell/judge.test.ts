import test from 'node:test';
import assert from 'node:assert/strict';
import type { Association, PullRequestFacts, PullRequestRef } from '../forge/types.ts';
import type { ModelClient, ModelRequest, ModelResponse } from '../engine/types.ts';
import { ProviderError } from '../engine/model/errors.ts';
import type { ProviderErrorKind } from '../engine/model/errors.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { recordActivity } from '../db/human-activity.ts';
import type { Activity } from '../db/human-activity.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { markPublished, recordRun } from '../db/review-runs.ts';
import type { RunRecord } from '../db/review-runs.ts';
import { recordComments } from '../db/review-comments.ts';
import type { StoredComment } from '../db/review-comments.ts';
import { addRecords } from '../db/memory-records.ts';
import { noteLearning, readLearning, startLearning } from '../db/learning.ts';
import { restates } from '../memory/judge.ts';
import { createNightly, JUDGE_STRANGERS, judgeOnce, LESSONS_PER_RUN, NIGHT_RETRY_MS, WORK_LESSONS } from './judge.ts';
import type { Judged, Nightly } from './judge.ts';

const REF: PullRequestRef = { service: 'github', owner: 'acme', repo: 'shop', number: 7 };
const PATH = 'src/billing/tax.ts';
const NOW = '2026-03-11T00:05:00.000Z';
const RUN_AT = '2026-03-09T10:00:00.000Z';
const REPLY_AT = '2026-03-10T14:00:00.000Z';
const DAY_MS = 24 * 3_600_000;
const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
const SHORT_CODE = /^[a-z][a-z0-9_]{0,39}$/;
const FINDING = { path: PATH, side: 'RIGHT', line: 12, severity: 'major', quote: 'total = round(sum)', body: 'Rounds before the discount is taken off.' };
const BODY = 'We round half up here on purpose, as the invoices require it.';
const QUOTE = 'round half up here on purpose';
const LESSON = 'A rounding finding on invoice totals is wrong: invoices round half up on purpose.';

const facts = (number = 7): PullRequestFacts => ({
  ref: { ...REF, number }, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feature', headSha: 'h1',
  draft: false, state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '55', updatedAt: RUN_AT,
});
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'b1', baseBranch: 'main',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [], result: { findings: [FINDING] },
  usage: { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 },
  startedAt: RUN_AT, finishedAt: plus(RUN_AT, 60_000), ...over,
});
const posted = (over: Partial<StoredComment> = {}): StoredComment => ({
  commentId: 'c-1', path: PATH, side: 'RIGHT', line: 12, severity: 'major', quote: 'total = round(sum)', ...over,
});
let delivery = 0;
const reply = (over: Partial<Activity> = {}): Activity => ({
  ref: REF, kind: 'inline_comment', sourceId: 'r-1', author: 'octo-lead', association: 'member', state: null,
  body: BODY, path: PATH, side: 'RIGHT', line: 12, startLine: null, fileLevel: false,
  commit: 'h1', replyTo: 'c-1', thread: null, at: REPLY_AT, delivery: `d-${(delivery += 1)}`, ...over,
});

/** A pull request 7, its run with one finding on src/billing/tax.ts, and its posted comment c-1. */
async function setup(result: unknown = { findings: [FINDING] }): Promise<Db> {
  const db = await testDb();
  await savePullRequest(db, facts());
  const id = await recordRun(db, run({ result }));
  await recordComments(db, id, REF, [posted()]);
  return db;
}
const by = (sourceId: string, author: string, association: Association | null, over: Partial<Activity> = {}): Activity =>
  reply({ sourceId, author, association, ...over });

type Answer = ModelResponse | Error;
const usage = (cost = 0.25) => ({ calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, cost });
const verdict = (args: Record<string, unknown>, cost = 0.25): ModelResponse =>
  ({ toolName: 'submit_verdict', toolArguments: JSON.stringify(args), text: null, model: 'm', provider: null, usage: usage(cost) });
const prose = (cost = 0.25): ModelResponse => ({ toolName: null, toolArguments: null, text: 'It looks fine to me.', model: 'm', provider: null, usage: usage(cost) });
const pushback = (lesson: string | null = LESSON, quote: string | null = QUOTE): ModelResponse =>
  verdict({ classification: 'valid_pushback', lesson, quote });
const noise = (): ModelResponse => verdict({ classification: 'noise', lesson: null, quote: null });
const failure = (kind: ProviderErrorKind): Error => new ProviderError(kind, 'injected', null, null);

/** A model that answers by the number of its request (0 first), and records each request. */
function modelOf(answer: (i: number, request: ModelRequest) => Answer): { model: ModelClient; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    model: {
      complete: async (request) => {
        requests.push(request);
        const a = answer(requests.length - 1, request);
        if (a instanceof Error) throw a;
        return a;
      },
    },
  };
}

interface Deps { db: Db; clock?: () => Date; model: ModelClient; auto?: boolean; timeoutMs?: number; paused?: () => Promise<string | null>; noteUsage?: (u: { inputTokens: number; outputTokens: number; cost: number }) => void; log?: (e: Record<string, unknown>) => void; stopping?: () => boolean; replies?: number }
const judge = (d: Deps): Promise<Judged> => judgeOnce({
  db: d.db, clock: d.clock ?? (() => new Date(NOW)), model: d.model, token: () => 'tok123', auto: d.auto ?? false,
  timeoutMs: d.timeoutMs ?? 60_000, paused: d.paused ?? (async () => null),
  ...(d.noteUsage === undefined ? {} : { noteUsage: d.noteUsage }), ...(d.log === undefined ? {} : { log: d.log }),
  ...(d.stopping === undefined ? {} : { stopping: d.stopping }), ...(d.replies === undefined ? {} : { replies: d.replies }),
});
const at = (iso: string) => () => new Date(iso);

interface VerdictRow { reply: string; classification: string | null; outcome: string; attempts: number }
const verdicts = async (db: Db): Promise<VerdictRow[]> =>
  db.query<VerdictRow>('select reply, classification, outcome, attempts from visto_ai.reply_verdicts order by reply');
interface CallRow { number: number; reply: string; calls: number; input_tokens: number; output_tokens: number; cost: number }
const calls = async (db: Db): Promise<CallRow[]> =>
  db.query<CallRow>('select number, reply, calls, input_tokens, output_tokens, cost::float8 as cost from visto_ai.judge_calls order by id');
interface LessonDbRow { kind: string; source_ref: string; number: number; path: string; directory: string; lesson: string; excerpt: string; comment: string; created_at: Date; expires_at: Date; category: string | null; reason: string | null; missed: boolean }
const lessons = async (db: Db): Promise<LessonDbRow[]> =>
  db.query<LessonDbRow>(`select kind, source_ref, number, path, directory, lesson, excerpt, comment, created_at, expires_at, category, reason, missed
                         from visto_ai.memory_records where kind = 'lesson' order by id`);
const done = (over: Partial<Judged> = {}): Judged =>
  ({ judged: 0, lessons: 0, givenUp: 0, failed: 0, calls: 0, cost: 0, more: false, end: 'done', complete: true, ...over });

/** A Db that passes everything to `db`, with some of it replaced. */
function wrap(db: Db, over: Partial<Db>): Db {
  return {
    query: <R,>(text: string, params?: unknown[]) => db.query<R>(text, params),
    script: (sql) => db.script(sql),
    transaction: <T,>(work: (tx: Db) => Promise<T>) => db.transaction(work),
    close: () => db.close(),
    ...over,
  };
}

test('a member\'s reply that shows the finding was wrong becomes a lesson, live from the day after the reply', async () => {
  const db = await setup();
  await recordActivity(db, reply());
  const { model, requests } = modelOf(() => pushback());
  const judged = await judge({ db, model });
  assert.deepEqual(judged, done({ judged: 1, lessons: 1, calls: 1, cost: 0.25 }));
  assert.equal(requests.length, 1);
  assert.deepEqual(await verdicts(db), [{ reply: 'r-1', classification: 'valid_pushback', outcome: 'lesson', attempts: 0 }]);
  const [l, ...rest] = await lessons(db);
  assert.deepEqual(rest, []);
  assert.equal(l!.source_ref, '7:r-1');
  assert.equal(l!.number, 7);
  assert.equal(l!.path, PATH);
  assert.equal(l!.directory, 'src/billing');
  assert.equal(l!.lesson, LESSON);
  assert.equal(l!.excerpt, QUOTE);
  assert.equal(l!.comment, 'r-1');
  assert.equal(l!.category, null);
  assert.equal(l!.reason, null);
  assert.equal(l!.missed, false);
  assert.equal(l!.created_at.toISOString(), '2026-03-11T00:00:00.000Z');
  assert.equal(l!.expires_at.toISOString(), plus('2026-03-11T00:00:00.000Z', 90 * DAY_MS));
  assert.deepEqual(await calls(db), [{ number: 7, reply: 'r-1', calls: 1, input_tokens: 100, output_tokens: 10, cost: 0.25 }]);
  const row = await readLearning(db, WORK_LESSONS);
  assert.equal(row!.ranAt, NOW);
  assert.equal(row!.examined, 1);
  assert.equal(row!.added, 1);
  await db.close();
});

test('the author\'s reply counts when the author has access', async () => {
  const db = await setup();
  await recordActivity(db, by('r-1', 'octo-dev', 'collaborator'));
  const { model } = modelOf(() => pushback());
  assert.equal((await judge({ db, model })).lessons, 1);
  assert.deepEqual(await verdicts(db), [{ reply: 'r-1', classification: 'valid_pushback', outcome: 'lesson', attempts: 0 }]);
  assert.equal((await lessons(db)).length, 1);
  await db.close();
});

test('a stranger\'s reply is judged, its verdict stored, and no lesson made', async () => {
  const db = await setup();
  await recordActivity(db, by('r-1', 'octo-guest', 'none'));
  const { model } = modelOf(() => pushback());
  assert.deepEqual(await judge({ db, model }), done({ judged: 1, calls: 1, cost: 0.25 }));
  assert.deepEqual(await verdicts(db), [{ reply: 'r-1', classification: 'valid_pushback', outcome: 'no_access', attempts: 0 }]);
  assert.deepEqual(await lessons(db), []);
  assert.equal((await calls(db)).length, 1);
  await db.close();
});

test('a run takes at most twenty strangers\' replies, and the rest wait', async () => {
  const db = await setup();
  for (let i = 0; i < 30; i += 1) {
    const id = `s-${String(i).padStart(2, '0')}`;
    await recordActivity(db, by(id, `octo-guest${i}`, i < 3 ? null : 'none', { at: plus('2026-03-10T01:00:00.000Z', i * 60_000) }));
  }
  for (let i = 0; i < 5; i += 1) await recordActivity(db, by(`m-${i}`, 'octo-lead', 'member', { at: plus('2026-03-10T12:00:00.000Z', i * 60_000) }));
  const { model, requests } = modelOf(() => noise());
  const first = await judge({ db, model });
  assert.equal(requests.length, 5 + JUDGE_STRANGERS);
  assert.deepEqual({ ...first, cost: 0 }, done({ judged: 25, calls: 25, more: true }));
  const sent = requests.map((r) => r.messages[1]!.content);
  assert.ok(sent.slice(0, 5).every((c) => c.includes('We round half up')));
  const judgedIds = (await verdicts(db)).map((v) => v.reply);
  assert.equal(judgedIds.filter((x) => x.startsWith('m-')).length, 5);
  assert.equal(judgedIds.filter((x) => x.startsWith('s-')).length, 20);
  assert.ok(!judgedIds.includes('s-20') && !judgedIds.includes('s-29'));
  const next = await judge({ db, model, clock: at('2026-03-12T00:05:00.000Z') });
  assert.equal(next.judged, 10);
  assert.equal(next.more, false);
  assert.equal((await verdicts(db)).length, 35);
  await db.close();

  const many = await setup();
  await recordActivity(many, by('s-0', 'octo-guest', 'none', { at: '2026-03-10T01:00:00.000Z' }));
  for (let i = 0; i < 100; i += 1) await recordActivity(many, by(`m-${String(i).padStart(3, '0')}`, 'octo-lead', 'member', { at: plus('2026-03-10T02:00:00.000Z', i * 1000) }));
  const busy = modelOf(() => noise());
  const r = await judge({ db: many, model: busy.model });
  assert.equal(busy.requests.length, 100);
  assert.equal(r.more, true);
  assert.ok(!(await verdicts(many)).some((v) => v.reply === 's-0'));
  await many.close();

  const quoting = await setup();
  await recordActivity(quoting, by('s-00', 'octo-guest', 'none', { body: '> it is intended', at: '2026-03-10T01:00:00.000Z' }));
  for (let i = 1; i <= 20; i += 1) {
    await recordActivity(quoting, by(`s-${String(i).padStart(2, '0')}`, 'octo-guest', 'none', { at: plus('2026-03-10T01:00:00.000Z', i * 60_000) }));
  }
  const q = modelOf(() => noise());
  const out = await judge({ db: quoting, model: q.model });
  assert.equal(q.requests.length, JUDGE_STRANGERS - 1);
  assert.equal(out.judged, JUDGE_STRANGERS);
  assert.equal(out.more, true);
  assert.ok(!(await verdicts(quoting)).some((v) => v.reply === 's-20'));
  await quoting.close();
});

test('each other classification is stored with the outcome none, and a refused lesson with its code', async () => {
  const db = await setup();
  const answers: ModelResponse[] = [
    verdict({ classification: 'confirmed_fix', lesson: null, quote: null }),
    verdict({ classification: 'invalid_pushback', lesson: null, quote: null }),
    verdict({ classification: 'question', lesson: null, quote: null }),
    noise(),
    pushback(null, null),
    pushback(LESSON, 'this is not what the reply said'),
    pushback('A finding that lowers the score of invoice rounding is wrong here.'),
  ];
  for (let i = 0; i < answers.length; i += 1) await recordActivity(db, reply({ sourceId: `r-${i}`, at: plus(REPLY_AT, i * 60_000) }));
  const { model } = modelOf((i) => answers[i]!);
  const judged = await judge({ db, model });
  assert.equal(judged.judged, 7);
  assert.equal(judged.lessons, 0);
  assert.deepEqual((await verdicts(db)).map((v) => [v.reply, v.classification, v.outcome]), [
    ['r-0', 'confirmed_fix', 'none'],
    ['r-1', 'invalid_pushback', 'none'],
    ['r-2', 'question', 'none'],
    ['r-3', 'noise', 'none'],
    ['r-4', 'valid_pushback', 'no_rule'],
    ['r-5', 'valid_pushback', 'quote_not_in_reply'],
    ['r-6', 'valid_pushback', 'names_the_score'],
  ]);
  assert.deepEqual(await lessons(db), []);
  await db.close();
});

test('no lesson is made when a later published review kept the finding open or found it fixed', async () => {
  for (const [kept, startedAt, outcome] of [
    ['open', '2026-03-10T15:00:00.000Z', 'review_disagreed'],
    ['fixed', '2026-03-10T15:00:00.000Z', 'review_disagreed'],
    ['answered', '2026-03-10T15:00:00.000Z', 'lesson'],
    ['open', '2026-03-10T13:00:00.000Z', 'lesson'],
  ] as const) {
    const db = await setup();
    await recordActivity(db, reply());
    const later = await recordRun(db, run({ headSha: 'h2', startedAt, finishedAt: plus(startedAt, 60_000), result: { findings: [], threadVerdicts: [{ commentId: 'c-1', verdict: kept }] } }));
    await markPublished(db, later, { reviewId: 'rv-2', publishedAt: plus(startedAt, 60_000), body: 'text', inlineDropped: false });
    const { model } = modelOf(() => pushback());
    await judge({ db, model });
    assert.deepEqual(await verdicts(db), [{ reply: 'r-1', classification: 'valid_pushback', outcome, attempts: 0 }], `${kept} at ${startedAt}`);
    assert.equal((await lessons(db)).length, outcome === 'lesson' ? 1 : 0);
    await db.close();
  }
});

test('a lesson that restates a standing one is not made, a switched-off one included', async () => {
  const standing = 'Invoices round half up on purpose, so rounding findings on totals are wrong.';
  assert.ok(restates(LESSON, [standing]));
  for (const [status, expiresAt, outcome] of [
    ['active', '2026-05-01T00:00:00.000Z', 'restates'],
    ['disabled', '2026-05-01T00:00:00.000Z', 'restates'],
    ['active', '2026-03-10T00:00:00.000Z', 'lesson'],
  ] as const) {
    const db = await setup();
    await addRecords(db, { service: 'github', owner: 'acme', repo: 'shop' }, [{
      kind: 'lesson', sourceRef: '6:r-0', number: 6, path: PATH, directory: 'src/billing', category: null, reason: null, missed: false,
      excerpt: 'an invented quote here', comment: 'r-0', createdAt: '2026-02-01T00:00:00.000Z', expiresAt, lesson: standing,
    }]);
    await db.query("update visto_ai.memory_records set status = $1 where source_ref = '6:r-0'", [status]);
    await recordActivity(db, reply());
    const { model } = modelOf(() => pushback());
    await judge({ db, model });
    assert.deepEqual(await verdicts(db), [{ reply: 'r-1', classification: 'valid_pushback', outcome, attempts: 0 }], `${status} until ${expiresAt}`);
    assert.equal((await lessons(db)).length, outcome === 'lesson' ? 2 : 1);
    await db.close();
  }
});

test('a reply the judge gives no verdict for is tried on three nights and then left alone', async () => {
  const db = await setup();
  await recordActivity(db, reply());
  const { model, requests } = modelOf(() => prose(0.5));
  const nights = ['2026-03-11T00:05:00.000Z', '2026-03-12T00:05:00.000Z', '2026-03-13T00:05:00.000Z', '2026-03-14T00:05:00.000Z'];
  const first = await judge({ db, model, clock: at(nights[0]!) });
  assert.deepEqual(first, done({ failed: 1, calls: 2, cost: 1 }));
  assert.deepEqual(await verdicts(db), [{ reply: 'r-1', classification: null, outcome: 'unjudged', attempts: 1 }]);
  await judge({ db, model, clock: at(nights[1]!) });
  const third = await judge({ db, model, clock: at(nights[2]!) });
  assert.equal(third.givenUp, 1);
  assert.equal(third.failed, 1);
  assert.deepEqual(await verdicts(db), [{ reply: 'r-1', classification: null, outcome: 'unjudged', attempts: 3 }]);
  assert.equal(requests.length, 6);
  const fourth = await judge({ db, model, clock: at(nights[3]!) });
  assert.equal(requests.length, 6);
  assert.deepEqual(fourth, done());
  assert.deepEqual(await calls(db), [1, 2, 3].map(() => ({ number: 7, reply: 'r-1', calls: 2, input_tokens: 200, output_tokens: 20, cost: 1 })));
  await db.close();
});

test('a provider failure counts no attempt, and three in a row end the run for now', async () => {
  const db = await setup();
  for (let i = 0; i < 5; i += 1) await recordActivity(db, reply({ sourceId: `r-${i}`, at: plus(REPLY_AT, i * 60_000) }));
  const { model, requests } = modelOf(() => failure('timeout'));
  const judged = await judge({ db, model });
  assert.equal(requests.length, 3);
  assert.deepEqual(judged, done({ failed: 3, end: 'timeout', complete: false }));
  assert.deepEqual(await verdicts(db), []);
  assert.deepEqual(await calls(db), []);
  const row = await readLearning(db, WORK_LESSONS);
  assert.equal(row!.ranAt, null);
  assert.equal(row!.failed, 3);
  await db.close();

  const again = await setup();
  for (let i = 0; i < 5; i += 1) await recordActivity(again, reply({ sourceId: `r-${i}`, at: plus(REPLY_AT, i * 60_000) }));
  const mixed = modelOf((i) => (i === 2 ? noise() : failure('provider')));
  const out = await judge({ db: again, model: mixed.model });
  assert.equal(mixed.requests.length, 5);
  assert.deepEqual(out, done({ judged: 1, failed: 4, calls: 1, cost: 0.25 }));
  await again.close();
});

test('a rejected key ends the run at once', async () => {
  for (const kind of ['auth', 'no_credit'] as const) {
    const db = await setup();
    for (let i = 0; i < 3; i += 1) await recordActivity(db, reply({ sourceId: `r-${i}`, at: plus(REPLY_AT, i * 60_000) }));
    const { model, requests } = modelOf(() => failure(kind));
    const judged = await judge({ db, model });
    assert.equal(requests.length, 1);
    assert.equal(judged.end, kind);
    assert.equal(judged.complete, false);
    assert.deepEqual(await verdicts(db), []);
    assert.equal((await readLearning(db, WORK_LESSONS))!.ranAt, null);
    await db.close();
  }
});

test('with reviews paused for the daily limit the run makes no call', async () => {
  const db = await setup();
  for (let i = 0; i < 2; i += 1) await recordActivity(db, reply({ sourceId: `r-${i}`, at: plus(REPLY_AT, i * 60_000) }));
  const { model, requests } = modelOf(() => noise());
  const judged = await judge({ db, model, paused: async () => 'spend_limit' });
  assert.equal(requests.length, 0);
  assert.deepEqual(judged, done({ end: 'spend_limit', complete: false }));
  let asked = 0;
  const second = await judge({ db, model, paused: async () => (asked++ === 0 ? null : 'spend_limit') });
  assert.equal(requests.length, 1);
  assert.equal(second.judged, 1);
  assert.equal(second.end, 'spend_limit');
  assert.equal((await verdicts(db)).length, 1);
  const paused = await judge({ db, model, paused: async () => 'paused_for_model' });
  assert.equal(paused.end, 'model_error');
  assert.equal(requests.length, 1);
  await assert.rejects(judge({ db, model, paused: async () => { throw new Error('db_down'); } }), /db_down/);
  assert.equal(requests.length, 1);
  await db.close();
});

test('every answered call is one row of judge_calls, written with its verdict or not at all', async () => {
  const db = await setup();
  const other = await recordRun(db, run({ headSha: 'h0', result: {} }));
  await recordComments(db, other, REF, [posted({ commentId: 'c-2', line: 30 })]);
  for (let i = 0; i < 3; i += 1) await recordActivity(db, reply({ sourceId: `r-${i}`, at: plus(REPLY_AT, i * 60_000) }));
  await recordActivity(db, reply({ sourceId: 'r-quote', body: '> only a quote', at: plus(REPLY_AT, 5 * 60_000) }));
  await recordActivity(db, reply({ sourceId: 'r-lost', replyTo: 'c-2', at: plus(REPLY_AT, 6 * 60_000) }));
  const costs = [0.125, 0.25, 0.5];
  const { model } = modelOf((i) => verdict({ classification: 'question', lesson: null, quote: null }, costs[i]));
  const told: unknown[] = [];
  const judged = await judge({ db, model, noteUsage: (u) => { told.push(u); } });
  const rows = await calls(db);
  assert.deepEqual(rows.map((r) => r.reply), ['r-0', 'r-1', 'r-2']);
  assert.equal(rows.reduce((s, r) => s + r.cost, 0), judged.cost);
  assert.equal(judged.cost, 0.875);
  assert.equal(judged.calls, 3);
  assert.deepEqual(told, costs.map((cost) => ({ inputTokens: 100, outputTokens: 10, cost })));
  const throwing = await setup();
  await recordActivity(throwing, reply());
  const t = modelOf(() => noise());
  const out = await judge({ db: throwing, model: t.model, noteUsage: () => { throw new Error('boom'); } });
  assert.equal(out.judged, 1);
  assert.equal((await calls(throwing)).length, 1);
  await throwing.close();
  await db.close();
});

test('a reply whose finding cannot be read is retired with no call', async () => {
  for (const result of [{ findings: [FINDING, { ...FINDING, body: 'Another text.' }] }, {}]) {
    const db = await setup(result);
    await recordActivity(db, reply());
    const { model, requests } = modelOf(() => noise());
    const judged = await judge({ db, model });
    assert.deepEqual(judged, done({ givenUp: 1 }));
    assert.equal(requests.length, 0);
    assert.deepEqual(await verdicts(db), [{ reply: 'r-1', classification: null, outcome: 'finding_unknown', attempts: 3 }]);
    assert.deepEqual(await calls(db), []);
    await db.close();
  }
});

test('a reply with no words of its writer\'s own is noise, with no call', async () => {
  const db = await setup();
  const bodies = ['   \u200b  ', '> it is intended, see the spec', '```\nconst total = roundHalfUp(sum);\n```'];
  for (let i = 0; i < bodies.length; i += 1) await recordActivity(db, reply({ sourceId: `r-${i}`, body: bodies[i]!, at: plus(REPLY_AT, i * 60_000) }));
  const { model, requests } = modelOf(() => noise());
  const judged = await judge({ db, model });
  assert.deepEqual(judged, done({ judged: 3 }));
  assert.equal(requests.length, 0);
  assert.deepEqual((await verdicts(db)).map((v) => [v.classification, v.outcome, v.attempts]), [0, 1, 2].map(() => ['noise', 'no_own_words', 0]));
  assert.deepEqual(await calls(db), []);
  await db.close();

  const sent = await setup();
  await recordActivity(sent, reply({ body: '> a stranger says it is intended\n\nAgreed.' }));
  const s = modelOf(() => noise());
  await judge({ db: sent, model: s.model });
  assert.equal(s.requests.length, 1);
  const content = s.requests[0]!.messages[1]!.content;
  assert.ok(content.includes('Agreed.'));
  assert.ok(!content.includes('a stranger says it is intended'));
  await sent.close();
});

/** Replies r-00 .. that each make a lesson of their own: the model writes a text with its request's number. */
const ownLesson = (i: number): ModelResponse => pushback(`Note ${i}: a tax line here may round on purpose.`);

test('the run ends at ten lessons, and a second run on the same day makes none', async () => {
  const db = await setup();
  for (let i = 0; i < 12; i += 1) await recordActivity(db, reply({ sourceId: `r-${String(i).padStart(2, '0')}`, at: plus(REPLY_AT, i * 60_000) }));
  let n = 0;
  const { model, requests } = modelOf(() => ownLesson(n++));
  const first = await judge({ db, model });
  assert.equal(first.lessons, LESSONS_PER_RUN);
  assert.equal(first.end, 'lesson_cap');
  assert.equal(first.complete, true);
  assert.equal(requests.length, 10);
  const second = await judge({ db, model, clock: at('2026-03-11T18:00:00.000Z') });
  assert.equal(requests.length, 10);
  assert.equal(second.end, 'lesson_cap');
  assert.equal(second.lessons, 0);
  const next = await judge({ db, model, clock: at('2026-03-12T00:05:00.000Z') });
  assert.equal(next.lessons, 2);
  assert.equal(next.end, 'done');
  assert.equal((await lessons(db)).length, 12);
  await db.close();
});

test('a run that goes on past midnight still counts from the day it started', async () => {
  const db = await setup();
  for (let i = 0; i < 11; i += 1) await recordActivity(db, reply({ sourceId: `r-${String(i).padStart(2, '0')}`, at: plus(REPLY_AT, i * 60_000) }));
  let now = '2026-03-11T23:58:00.000Z';
  const { model, requests } = modelOf((i) => {
    if (i === 9) now = '2026-03-12T00:01:00.000Z';
    return ownLesson(i);
  });
  const judged = await judge({ db, model, clock: () => new Date(now) });
  assert.equal(requests.length, 10);
  assert.equal(judged.lessons, 10);
  assert.equal(judged.end, 'lesson_cap');
  assert.equal((await verdicts(db)).length, 10);
  await db.close();
});

test('a run judges the replies written before its day, and none older than ninety days', async () => {
  const db = await setup();
  await recordActivity(db, reply({ sourceId: 'r-new', at: '2026-03-11T00:01:00.000Z' }));
  await recordActivity(db, reply({ sourceId: 'r-old', at: '2025-12-01T10:00:00.000Z' }));
  const { model, requests } = modelOf(() => noise());
  assert.deepEqual(await judge({ db, model }), done());
  assert.equal(requests.length, 0);
  const next = await judge({ db, model, clock: at('2026-03-12T00:05:00.000Z') });
  assert.equal(next.judged, 1);
  assert.deepEqual((await verdicts(db)).map((v) => v.reply), ['r-new']);
  await db.close();
});

test('replies beyond the run\'s size wait, and the run says so', async () => {
  const db = await setup();
  for (let i = 0; i < 3; i += 1) await recordActivity(db, reply({ sourceId: `r-${i}`, at: plus(REPLY_AT, i * 60_000) }));
  const { model } = modelOf(() => noise());
  const first = await judge({ db, model, replies: 2 });
  assert.equal(first.judged, 2);
  assert.equal(first.more, true);
  assert.equal(first.complete, true);
  const next = await judge({ db, model, replies: 2, clock: at('2026-03-12T00:05:00.000Z') });
  assert.equal(next.judged, 1);
  assert.equal(next.more, false);
  assert.deepEqual((await verdicts(db)).map((v) => v.reply), ['r-0', 'r-1', 'r-2']);
  await db.close();
});

test('a run told to stop judges no further reply, and sends no statement after the stop', async () => {
  const db = await setup();
  await startLearning(db, WORK_LESSONS, '2026-03-01T00:00:00.000Z');
  for (let i = 0; i < 3; i += 1) await recordActivity(db, reply({ sourceId: `r-${i}`, at: plus(REPLY_AT, i * 60_000) }));
  let stop = false;
  const after: string[] = [];
  const watched = wrap(db, {
    query: <R,>(text: string, params?: unknown[]) => { if (stop) after.push(text); return db.query<R>(text, params); },
    transaction: <T,>(work: (tx: Db) => Promise<T>) => { if (stop) after.push('transaction'); return db.transaction(work); },
  });
  const { model, requests } = modelOf((i) => {
    if (i === 1) stop = true;
    return noise();
  });
  const entries: Array<Record<string, unknown>> = [];
  const judged = await judge({ db: watched, model, stopping: () => stop, log: (e) => entries.push(e) });
  assert.equal(requests.length, 2);
  assert.deepEqual(judged, done({ judged: 1, calls: 2, cost: 0.5, end: 'stopped', complete: false }));
  assert.deepEqual(after, []);
  assert.equal((await verdicts(db)).length, 1);
  assert.equal((await calls(db)).length, 1);
  const row = await readLearning(db, WORK_LESSONS);
  assert.equal(row!.ranAt, null);
  assert.deepEqual([row!.examined, row!.added, row!.retired, row!.failed], [0, 0, 0, 0]);
  assert.deepEqual(entries.filter((e) => e.event === 'lessons').map((e) => [e.judged, e.end]), [[1, 'stopped']]);

  const quiet: string[] = [];
  const counting = wrap(db, {
    query: <R,>(text: string, params?: unknown[]) => { quiet.push(text); return db.query<R>(text, params); },
    transaction: <T,>(work: (tx: Db) => Promise<T>) => { quiet.push('transaction'); return db.transaction(work); },
  });
  const before = await judge({ db: counting, model, stopping: () => true });
  assert.deepEqual(before, done({ end: 'stopped', complete: false, more: false }));
  assert.equal(requests.length, 2);
  assert.ok(!quiet.includes('transaction'));
  assert.ok(quiet.every((q) => !q.includes('visto_ai.learning')));
  await db.close();
});

test('a transaction that fails ends the run, and the next run judges that reply again and nothing twice', async () => {
  const db = await setup();
  for (let i = 0; i < 2; i += 1) await recordActivity(db, reply({ sourceId: `r-${i}`, at: plus(REPLY_AT, i * 60_000) }));
  let n = 0;
  const failing = wrap(db, {
    transaction: <T,>(work: (tx: Db) => Promise<T>) => (++n === 2 ? Promise.reject(new Error('db_down')) : db.transaction(work)),
  });
  const { model, requests } = modelOf(() => noise());
  const entries: Array<Record<string, unknown>> = [];
  await assert.rejects(judge({ db: failing, model, log: (e) => entries.push(e) }), /db_down/);
  assert.deepEqual(entries, [{ event: 'lessons_failed', reason: 'db_down' }]);
  assert.deepEqual((await verdicts(db)).map((v) => v.reply), ['r-0']);
  assert.equal(await readLearning(db, WORK_LESSONS), null);
  assert.equal(requests.length, 2);
  const next = await judge({ db, model });
  assert.equal(requests.length, 3);
  assert.equal(next.judged, 1);
  assert.deepEqual((await verdicts(db)).map((v) => v.reply), ['r-0', 'r-1']);
  assert.deepEqual((await calls(db)).map((c) => c.reply), ['r-0', 'r-1']);
  await db.close();
});

test('a run with nothing to judge completes, writes its row and logs its line', async () => {
  const db = await setup();
  const { model } = modelOf(() => noise());
  const entries: Array<Record<string, unknown>> = [];
  assert.deepEqual(await judge({ db, model, log: (e) => entries.push(e) }), done());
  assert.deepEqual(entries, [{ event: 'lessons', judged: 0, lessons: 0, given_up: 0, failed: 0, calls: 0, cost: 0, more: false, end: 'done' }]);
  assert.equal((await readLearning(db, WORK_LESSONS))!.ranAt, NOW);
  const throwing = await judge({ db, model, log: () => { throw new Error('boom'); } });
  assert.equal(throwing.end, 'done');
  await db.close();
});

test('under auto the requests name no tool, under forced they name submit_verdict, and each has the time limit the run was given', async () => {
  for (const auto of [true, false]) {
    const db = await setup();
    await recordActivity(db, reply());
    const { model, requests } = modelOf(() => prose());
    await judge({ db, model, auto, timeoutMs: 240_000 });
    assert.equal(requests.length, 2);
    for (const r of requests) {
      assert.equal(r.forcedTool, auto ? null : 'submit_verdict');
      assert.deepEqual(r.tools.map((t) => t.function.name), ['submit_verdict']);
      assert.equal(r.timeoutMs, 240_000);
    }
    await db.close();
  }
});

test('no entry of a run holds a reply\'s words, a lesson\'s text, a quote, a path or a login', async () => {
  const entries: Array<Record<string, unknown>> = [];
  const db = await setup();
  await recordActivity(db, reply());
  await recordActivity(db, by('r-2', 'octo-guest', 'none', { at: plus(REPLY_AT, 60_000) }));
  const { model } = modelOf(() => pushback());
  assert.equal((await judge({ db, model, log: (e) => entries.push(e) })).lessons, 1);
  await recordActivity(db, reply({ sourceId: 'r-3', at: '2026-03-11T10:00:00.000Z' }));
  const failing = wrap(db, { transaction: () => Promise.reject(new Error(`no table for ${BODY}`)) });
  await assert.rejects(judge({ db: failing, model, log: (e) => entries.push(e), clock: at('2026-03-12T00:05:00.000Z') }));
  assert.deepEqual(entries.map((e) => e.event), ['lessons', 'lessons_failed']);
  assert.equal(entries[1]!.reason, 'internal_error');
  for (const e of entries) {
    for (const value of Object.values(e)) {
      assert.ok(typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && SHORT_CODE.test(value)), String(value));
    }
  }
  await db.close();
});

// The schedule, the row and the alert (Task 7).

const HOUR_MS = 3_600_000;
const NOON = '2026-03-11T12:00:00.000Z';
const ZEROS = { examined: 0, added: 0, retired: 0, failed: 0 };
const QUEUE = (text: string): boolean => text.includes('from visto_ai.human_activity h') && text.includes('visto_ai.reply_verdicts v');
const READ_ROW = (text: string): boolean => text.includes('select since, ran_at');

/** Settles as `work` does, or rejects after `ms` of the test's own: a limit that is not applied fails rather than hangs. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('bounded')), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
function held(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const turns = async (n = 5): Promise<void> => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** A Db that counts its statements and the reads of the queue (one for each run started); `fail` may replace a statement. */
function counted(db: Db, fail: (text: string) => Promise<never> | null = () => null): { db: Db; stats: { statements: number; queues: number } } {
  const stats = { statements: 0, queues: 0 };
  return {
    stats,
    db: wrap(db, {
      query: <R,>(text: string, params?: unknown[]) => {
        stats.statements += 1;
        if (QUEUE(text)) stats.queues += 1;
        return (fail(text) as Promise<R[]> | null) ?? db.query<R>(text, params);
      },
      transaction: <T,>(work: (tx: Db) => Promise<T>) => {
        stats.statements += 1;
        return db.transaction(work);
      },
    }),
  };
}

interface NightDeps { db: Db; clock: () => Date; model?: ModelClient; paused?: () => Promise<string | null>; log?: (e: Record<string, unknown>) => void; alert?: (code: string, details?: Record<string, string | number | boolean | null>) => void; rowWaitMs?: number }
const nightly = (d: NightDeps): Nightly => createNightly({
  db: d.db, clock: d.clock, log: d.log ?? (() => {}), alert: d.alert ?? (() => {}),
  model: d.model ?? modelOf(() => noise()).model, token: () => 'tok123', auto: false, timeoutMs: 60_000,
  paused: d.paused ?? (async () => null), ...(d.rowWaitMs === undefined ? {} : { rowWaitMs: d.rowWaitMs }),
});
const tickAndWait = async (n: Nightly): Promise<void> => {
  await bounded(n.tick(), 5_000);
  await bounded(n.idle(), 5_000);
};

test('start makes the row once and logs what it holds', async () => {
  const db = await testDb();
  const logged: Array<Record<string, unknown>> = [];
  let now = NOW;
  const n = nightly({ db, clock: () => new Date(now), log: (e) => { logged.push(e); } });
  await n.start();
  now = NOON;
  await n.start();
  const state = { event: 'lessons_state', since: NOW, last_ran: null, judged: 0, lessons: 0, given_up: 0, failed: 0 };
  assert.deepEqual(logged, [state, state]);
  await noteLearning(db, WORK_LESSONS, NOON, { examined: 4, added: 1, retired: 2, failed: 3 });
  await n.start();
  assert.deepEqual(logged[2], { event: 'lessons_state', since: NOW, last_ran: NOON, judged: 4, lessons: 1, given_up: 2, failed: 3 });
  const down = nightly({ db: wrap(db, { query: () => Promise.reject(new Error('db_down')) }), clock: () => new Date(now) });
  await assert.rejects(down.start());
  n.stop();
  await db.close();
});

test('a run is due once in a UTC day, and a new nightly over the same row starts none', async () => {
  const plain = await setup();
  await recordActivity(plain, reply());
  const { db, stats } = counted(plain);
  let now = NOW;
  const clock = () => new Date(now);
  const { model, requests } = modelOf(() => noise());
  const n = nightly({ db, clock, model });
  await tickAndWait(n);
  assert.equal(stats.queues, 1);
  assert.equal(requests.length, 1);
  assert.equal((await readLearning(plain, WORK_LESSONS))!.ranAt, NOW);
  for (const t of ['2026-03-11T00:10:00.000Z', '2026-03-11T23:55:00.000Z']) {
    now = t;
    await tickAndWait(n);
  }
  assert.equal(stats.queues, 1);
  n.stop();
  now = NOON;
  const restarted = nightly({ db, clock, model });
  await tickAndWait(restarted);
  assert.equal(stats.queues, 1);
  now = '2026-03-12T00:05:00.000Z';
  await tickAndWait(restarted);
  assert.equal(stats.queues, 2);
  assert.equal((await readLearning(plain, WORK_LESSONS))!.ranAt, now);
  restarted.stop();
  await plain.close();
});

test('after two days down one run is due, and it takes the replies of both', async () => {
  const plain = await setup();
  await noteLearning(plain, WORK_LESSONS, '2026-03-09T00:05:00.000Z', ZEROS);
  await recordActivity(plain, reply({ sourceId: 'r-1', at: '2026-03-09T12:00:00.000Z' }));
  await recordActivity(plain, reply({ sourceId: 'r-2', at: REPLY_AT }));
  const { db, stats } = counted(plain);
  const { model, requests } = modelOf(() => noise());
  const n = nightly({ db, clock: at(NOW), model });
  await tickAndWait(n);
  await tickAndWait(n);
  assert.equal(stats.queues, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual((await verdicts(plain)).map((v) => v.reply), ['r-1', 'r-2']);
  n.stop();
  await plain.close();
});

test('a tick while a run is under way starts no second run', async () => {
  const plain = await setup();
  await recordActivity(plain, reply());
  const { db, stats } = counted(plain);
  const gate = held();
  const requests: ModelRequest[] = [];
  const model: ModelClient = { complete: async (request) => { requests.push(request); await gate.promise; return noise(); } };
  const n = nightly({ db, clock: at(NOW), model });
  await bounded(n.tick(), 5_000);
  while (requests.length === 0) await turns(1);
  await bounded(n.tick(), 5_000);
  await turns();
  assert.equal(stats.queues, 1);
  assert.equal(requests.length, 1);
  let idle = false;
  const waiting = n.idle().then(() => { idle = true; });
  await turns();
  assert.equal(idle, false);
  gate.release();
  await bounded(waiting, 5_000);
  assert.equal(requests.length, 1);
  assert.equal((await verdicts(plain)).length, 1);
  n.stop();
  await plain.close();
});

test('a run cut short is tried again an hour later, not at the next tick', async () => {
  const plain = await setup();
  await recordActivity(plain, reply());
  const { db, stats } = counted(plain);
  let now = NOW;
  const clock = () => new Date(now);
  let asked = 0;
  const n = nightly({ db, clock, paused: async () => { asked += 1; return 'spend_limit'; } });
  await tickAndWait(n);
  assert.equal(asked, 1);
  assert.equal((await readLearning(plain, WORK_LESSONS))!.ranAt, null);
  now = plus(NOW, 5 * 60_000);
  await tickAndWait(n);
  now = plus(NOW, 59 * 60_000);
  await tickAndWait(n);
  assert.equal(stats.queues, 1);
  assert.equal(NIGHT_RETRY_MS, HOUR_MS);
  now = plus(NOW, 61 * 60_000);
  await tickAndWait(n);
  assert.equal(stats.queues, 2);
  assert.equal(asked, 2);
  n.stop();

  // A run that rejected waits the same.
  let rejects = true;
  const broken = counted(plain, (text) => (rejects && QUEUE(text) ? Promise.reject(new Error('db_down')) : null));
  now = '2026-03-12T00:05:00.000Z';
  const entries: Array<Record<string, unknown>> = [];
  const m = nightly({ db: broken.db, clock, log: (e) => { entries.push(e); } });
  await tickAndWait(m);
  assert.equal(broken.stats.queues, 1);
  assert.deepEqual(entries, [{ event: 'lessons_failed', reason: 'db_down' }]);
  rejects = false;
  now = '2026-03-12T00:10:00.000Z';
  await tickAndWait(m);
  assert.equal(broken.stats.queues, 1);
  now = '2026-03-12T01:06:00.000Z';
  await tickAndWait(m);
  assert.equal(broken.stats.queues, 2);
  assert.equal((await readLearning(plain, WORK_LESSONS))!.ranAt, now);
  m.stop();
  await plain.close();
});

test('a run that completes after midnight counts for the new day', async () => {
  const plain = await setup();
  await recordActivity(plain, reply({ at: '2026-03-09T14:00:00.000Z' }));
  const { db, stats } = counted(plain);
  let now = '2026-03-10T23:58:00.000Z';
  const clock = () => new Date(now);
  const { model } = modelOf(() => { now = '2026-03-11T00:03:00.000Z'; return noise(); });
  const n = nightly({ db, clock, model });
  await tickAndWait(n);
  assert.equal(stats.queues, 1);
  assert.equal((await readLearning(plain, WORK_LESSONS))!.ranAt, '2026-03-11T00:03:00.000Z');
  now = NOW;
  await tickAndWait(n);
  assert.equal(stats.queues, 1);
  now = '2026-03-12T00:05:00.000Z';
  await tickAndWait(n);
  assert.equal(stats.queues, 2);
  n.stop();
  await plain.close();
});

test('lessons_stale is raised once after 36 hours without a completed run, and again only after one completed', async () => {
  const db = await setup();
  await recordActivity(db, reply());
  const T = '2026-03-10T00:00:00.000Z';
  let now = T;
  const clock = () => new Date(now);
  const alerts: Array<[string, unknown]> = [];
  let failing = true;
  const n = nightly({ db, clock, paused: async () => (failing ? 'model_error' : null), alert: (code, details) => { alerts.push([code, details]); } });
  await n.start();
  now = plus(T, 35 * HOUR_MS);
  await tickAndWait(n);
  assert.deepEqual(alerts, []);
  now = plus(T, 37 * HOUR_MS);
  await tickAndWait(n);
  assert.deepEqual(alerts, [['lessons_stale', { hours: 37 }]]);
  now = plus(T, 38 * HOUR_MS);
  await tickAndWait(n);
  assert.equal(alerts.length, 1);
  assert.equal((await readLearning(db, WORK_LESSONS))!.ranAt, null);
  failing = false;
  const worked = plus(T, 39 * HOUR_MS);
  now = worked;
  await tickAndWait(n);
  assert.equal((await readLearning(db, WORK_LESSONS))!.ranAt, worked);
  assert.equal(alerts.length, 1);
  failing = true;
  await recordActivity(db, reply({ sourceId: 'r-2', at: plus(T, 40 * HOUR_MS) }));
  now = plus(worked, 35 * HOUR_MS);
  await tickAndWait(n);
  assert.equal(alerts.length, 1);
  now = plus(worked, 37 * HOUR_MS);
  await tickAndWait(n);
  assert.deepEqual(alerts, [['lessons_stale', { hours: 37 }], ['lessons_stale', { hours: 37 }]]);
  n.stop();
  await db.close();
});

test('with no row the 36 hours count from when the nightly was made', async () => {
  const plain = await setup();
  await recordActivity(plain, reply());
  const { db, stats } = counted(plain, (text) => (READ_ROW(text) ? Promise.reject(new Error('db_down')) : null));
  let now = NOW;
  const alerts: Array<[string, unknown]> = [];
  const logged: Array<Record<string, unknown>> = [];
  const n = nightly({ db, clock: () => new Date(now), log: (e) => { logged.push(e); }, alert: (code, details) => { alerts.push([code, details]); } });
  now = plus(NOW, 35 * HOUR_MS);
  await tickAndWait(n);
  assert.deepEqual(alerts, []);
  now = plus(NOW, 37 * HOUR_MS);
  await tickAndWait(n);
  assert.deepEqual(alerts, [['lessons_stale', { hours: 37 }]]);
  assert.deepEqual(logged, [{ event: 'lessons_failed', reason: 'db_down' }, { event: 'lessons_failed', reason: 'db_down' }]);
  assert.equal(stats.queues, 0);
  assert.equal(await readLearning(plain, WORK_LESSONS), null);
  n.stop();
  await plain.close();
});

test('a read of the row that never settles: the tick returns at its limit, starts no run, and lessons_stale is still raised at 36 hours', async () => {
  const plain = await setup();
  await recordActivity(plain, reply());
  await startLearning(plain, WORK_LESSONS, NOW);
  const { db, stats } = counted(plain, (text) => (READ_ROW(text) ? new Promise<never>(() => {}) : null));
  let now = NOW;
  const alerts: Array<[string, unknown]> = [];
  const logged: Array<Record<string, unknown>> = [];
  const n = nightly({ db, clock: () => new Date(now), rowWaitMs: 5, log: (e) => { logged.push(e); }, alert: (code, details) => { alerts.push([code, details]); } });
  await tickAndWait(n);
  assert.deepEqual(logged, [{ event: 'lessons_failed', reason: 'timeout' }]);
  assert.equal(stats.queues, 0);
  now = plus(NOW, 37 * HOUR_MS);
  await tickAndWait(n);
  assert.deepEqual(alerts, [['lessons_stale', { hours: 37 }]]);
  assert.equal(stats.queues, 0);
  n.stop();
  await plain.close();
});

test('after stop no run starts, and the run under way ends without another call or statement', async () => {
  const plain = await setup();
  for (let i = 0; i < 3; i += 1) await recordActivity(plain, reply({ sourceId: `r-${i}`, at: plus(REPLY_AT, i * 60_000) }));
  const { db, stats } = counted(plain);
  const gate = held();
  const requests: ModelRequest[] = [];
  const model: ModelClient = { complete: async (request) => { requests.push(request); await gate.promise; return noise(); } };
  const logged: Array<Record<string, unknown>> = [];
  const n = nightly({ db, clock: at(NOW), model, log: (e) => { logged.push(e); } });
  await bounded(n.tick(), 5_000);
  while (requests.length === 0) await turns(1);
  n.stop();
  const before = stats.statements;
  gate.release();
  await bounded(n.idle(), 5_000);
  assert.equal(requests.length, 1);
  assert.equal(stats.statements, before);
  assert.deepEqual(logged.filter((e) => e.event === 'lessons').map((e) => e.end), ['stopped']);
  await bounded(n.tick(), 5_000);
  await bounded(n.idle(), 5_000);
  assert.equal(stats.statements, before);
  assert.equal(requests.length, 1);
  assert.deepEqual(await verdicts(plain), []);
  await plain.close();
});

test('an alert that returns a rejected promise leaves no unhandled rejection, and the tick goes on', async () => {
  const plain = await setup();
  await startLearning(plain, WORK_LESSONS, NOW);
  const { db, stats } = counted(plain);
  const seen: unknown[] = [];
  const listener = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    let alerts = 0;
    const n = nightly({
      db, clock: at(plus(NOW, 37 * HOUR_MS)),
      alert: (() => { alerts += 1; return Promise.reject(new Error('x')); }) as unknown as () => void,
    });
    await tickAndWait(n);
    await turns(3);
    assert.equal(alerts, 1);
    assert.deepEqual(seen, []);
    assert.equal(stats.queues, 1);
    n.stop();
  } finally {
    process.off('unhandledRejection', listener);
  }
  await plain.close();
});

test('a tick whose clock cannot be read does nothing, and a logger that throws changes nothing', async () => {
  const plain = await setup();
  await recordActivity(plain, reply());
  const { db, stats } = counted(plain);
  let broken = true;
  const clock = () => { if (broken) throw new Error('clock'); return new Date(NOW); };
  const n = nightly({ db, clock, log: () => { throw new Error('log'); } });
  await tickAndWait(n);
  assert.equal(stats.statements, 0);
  broken = false;
  await tickAndWait(n);
  assert.equal(stats.queues, 1);
  assert.equal((await verdicts(plain)).length, 1);
  n.stop();
  await plain.close();
});

test('with a row that cannot be read, the 36 hours count from the last run this process completed', async () => {
  const plain = await setup();
  let readFails = false;
  const { db } = counted(plain, (text) => (readFails && READ_ROW(text) ? Promise.reject(new Error('db_down')) : null));
  let now = NOW;
  const alerts: Array<[string, unknown]> = [];
  const n = nightly({ db, clock: () => new Date(now), alert: (code, details) => { alerts.push([code, details]); } });
  const worked = plus(NOW, 30 * HOUR_MS);
  now = worked;
  await tickAndWait(n);
  assert.equal((await readLearning(plain, WORK_LESSONS))!.ranAt, worked);
  readFails = true;
  now = plus(worked, 35 * HOUR_MS);
  await tickAndWait(n);
  assert.deepEqual(alerts, []);
  now = plus(worked, 37 * HOUR_MS);
  await tickAndWait(n);
  assert.deepEqual(alerts, [['lessons_stale', { hours: 37 }]]);
  n.stop();
  await plain.close();
});
