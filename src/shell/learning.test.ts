import test from 'node:test';
import assert from 'node:assert/strict';
import type { PullRequestFacts, PullRequestRef } from '../forge/types.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { recordActivity } from '../db/human-activity.ts';
import type { Activity } from '../db/human-activity.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { recordRun } from '../db/review-runs.ts';
import type { RunRecord } from '../db/review-runs.ts';
import { recordComments } from '../db/review-comments.ts';
import { addRecords } from '../db/memory-records.ts';
import { pullRequestsToLearn, readLearning } from '../db/learning.ts';
import { createLearning, LEARN_ATTEMPTS, learnOnce, STALE_AFTER_MS, WORK } from './learning.ts';

const REF: PullRequestRef = { service: 'github', owner: 'acme', repo: 'shop', number: 7 };
const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-02T10:00:00.000Z';
const T3 = '2026-03-03T10:00:00.000Z';
const CLOSED = '2026-03-10T12:00:00.000Z';
const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
const SHORT_CODE = /^[a-z][a-z0-9_]{0,39}$/;

const refOf = (number: number): PullRequestRef => ({ ...REF, number });
const facts = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref: REF, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feature', headSha: 'c1',
  draft: false, state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '55',
  updatedAt: T1, ...over,
});
const closed = (over: Partial<PullRequestFacts> = {}): PullRequestFacts =>
  facts({ state: 'closed', closedAt: CLOSED, updatedAt: CLOSED, ...over });
const comment = (over: Partial<Activity> = {}): Activity => ({
  ref: REF, kind: 'inline_comment', sourceId: 'c-1', author: 'octo-lead', association: 'member', state: null,
  body: 'check the rounding here', path: 'src/billing/tax.ts', side: 'RIGHT', line: 12, startLine: null, fileLevel: false,
  commit: 'c1', replyTo: null, thread: null, at: T2, delivery: 'd-1', ...over,
});
const block = (hash: string, right: Array<[number, number]>, score: number, category = 'refactor') => ({
  id: 'B1', hunk: 'B1', hunkHash: hash, hash, changedLines: 3, span: { side: 'RIGHT', first: right[0]![0], last: right[0]![1] },
  lines: { LEFT: [], RIGHT: right }, entry: { score, category, reason: 'moves a helper' },
});
const scoredResult = (blocks: unknown[], threshold = 70, path = 'src/billing/tax.ts') => ({
  scores: [{ path, previousPath: null, diffHash: 'd', changeSummary: '', changedLines: 3, blocks, wholeFile: null, fileLevel: null, finalScore: 0, covered: true }],
  verdict: { threshold },
});
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'c1', baseSha: 'b1', baseBranch: null,
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [], result: {},
  usage: { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 },
  startedAt: T1, finishedAt: T1, ...over,
});

interface Row { number: number; source_ref: string; created_at: Date; expires_at: Date; missed: boolean; category: string | null; excerpt: string; comment: string | null; status: string }
const records = async (db: Db): Promise<Row[]> =>
  db.query<Row>('select number, source_ref, created_at, expires_at, missed, category, excerpt, comment, status from visto_ai.memory_records order by number, source_ref');
const refs = async (db: Db): Promise<string[]> => (await records(db)).map((r) => r.source_ref);
const work = async (db: Db): Promise<number[]> => (await pullRequestsToLearn(db, 100, null, LEARN_ATTEMPTS)).map((p) => p.ref.number);
const fixed = (iso: string) => () => new Date(iso);
const attemptsOf = async (db: Db, number: number): Promise<number> =>
  (await db.query<{ n: number }>('select learn_attempts as n from visto_ai.pull_requests where number = $1', [number]))[0]!.n;

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
/** A Db whose transaction for that pull request rejects at its last statement, after it wrote what it wrote. */
function failingFor(db: Db, number: number): Db {
  return wrap(db, {
    transaction: <T,>(work: (tx: Db) => Promise<T>) => db.transaction((tx) => work(wrap(tx, {
      query: async <R,>(text: string, params?: unknown[]) => {
        if (text.includes('learn_attempts = 0') && params?.[3] === number) throw new Error('injected');
        return tx.query<R>(text, params);
      },
    }))),
  });
}
/** A Db on which every pass rejects at its first statement; the row of the work can still be read. */
function passFails(db: Db, failing: () => boolean = () => true): Db {
  return wrap(db, {
    query: async <R,>(text: string, params?: unknown[]) => {
      if (failing() && text.includes('learn_attempts < $1')) throw new Error('db_down');
      return db.query<R>(text, params);
    },
  });
}

test('a closed pull request with a comment by a person with access gets its signal, dated by its close', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await recordActivity(db, comment());
  const learned = await learnOnce({ db, clock: fixed(plus(CLOSED, HOUR_MS)) });
  assert.deepEqual(learned, { pullRequests: 1, examined: 1, added: 1, retired: 0, failed: 0, more: false });
  const [r, ...rest] = await records(db);
  assert.deepEqual(rest, []);
  assert.equal(r!.source_ref, '7:file:src/billing/tax.ts');
  assert.equal(r!.created_at.toISOString(), CLOSED);
  assert.equal(r!.expires_at.toISOString(), plus(CLOSED, 180 * DAY_MS));
  assert.equal(r!.excerpt, 'check the rounding here');
  assert.equal(r!.comment, 'c-1');
  assert.equal(r!.missed, false);
  const [kind] = await db.query<{ kind: string }>('select kind from visto_ai.memory_records');
  assert.equal(kind!.kind, 'human_signal');
  await db.close();
});

test('two passes over the same pull request make each record once', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await recordActivity(db, comment());
  await learnOnce({ db, clock: fixed(plus(CLOSED, HOUR_MS)) });
  assert.deepEqual(await work(db), []);
  const second = await learnOnce({ db, clock: fixed(plus(CLOSED, 2 * HOUR_MS)) });
  assert.deepEqual(second, { pullRequests: 0, examined: 0, added: 0, retired: 0, failed: 0, more: false });
  assert.equal((await records(db)).length, 1);
  await db.close();
});

test('two passes started together make each record once', async () => {
  // The in-process database runs the two one after the other: this shows the outcome, the unique key holds the race (Task 2).
  const db = await testDb();
  await savePullRequest(db, closed());
  await recordActivity(db, comment());
  const clock = fixed(plus(CLOSED, HOUR_MS));
  const [a, b] = await Promise.all([learnOnce({ db, clock }), learnOnce({ db, clock })]);
  assert.equal(a.added + b.added, 1);
  assert.equal((await records(db)).length, 1);
  await db.close();
});

test('a pull request that closed while nothing ran is learned by the first pass', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await recordActivity(db, comment({ at: plus(CLOSED, -HOUR_MS) }));
  await recordActivity(db, comment({ sourceId: 'c-2', path: 'src/cart/cart.ts', at: plus(CLOSED, -2 * HOUR_MS) }));
  const learned = await learnOnce({ db, clock: fixed(plus(CLOSED, 2 * DAY_MS)) });
  assert.equal(learned.added, 2);
  assert.deepEqual((await records(db)).map((r) => [r.source_ref, r.created_at.toISOString()]), [
    ['7:file:src/billing/tax.ts', CLOSED],
    ['7:file:src/cart/cart.ts', CLOSED],
  ]);
  await db.close();
});

test('in an open pull request only a miss is recorded, and the rest at the close', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  await recordRun(db, run({ result: scoredResult([block('h-low', [[10, 14]], 35), block('h-high', [[20, 24]], 80)]) }));
  await recordActivity(db, comment({ sourceId: 'c-1', line: 12, at: T2 }));
  await recordActivity(db, comment({ sourceId: 'c-2', line: 22, at: T3 }));
  const first = await learnOnce({ db, clock: fixed(plus(T3, HOUR_MS)) });
  assert.deepEqual(first, { pullRequests: 1, examined: 2, added: 1, retired: 0, failed: 0, more: false });
  const [miss, ...none] = await records(db);
  assert.deepEqual(none, []);
  assert.equal(miss!.source_ref, '7:h-low:src/billing/tax.ts');
  assert.equal(miss!.missed, true);
  assert.equal(miss!.category, 'refactor');
  assert.equal(miss!.created_at.toISOString(), T2);
  assert.deepEqual(await work(db), []);
  await savePullRequest(db, closed());
  const second = await learnOnce({ db, clock: fixed(plus(CLOSED, HOUR_MS)) });
  assert.deepEqual(second, { pullRequests: 1, examined: 0, added: 1, retired: 0, failed: 0, more: false });
  assert.deepEqual((await records(db)).map((r) => [r.source_ref, r.missed]), [
    ['7:h-high:src/billing/tax.ts', false],
    ['7:h-low:src/billing/tax.ts', true],
  ]);
  await db.close();
});

test('a miss recorded while the pull request was open is not made again at the close, and keeps its date', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  await recordRun(db, run({ result: scoredResult([block('h-low', [[10, 14]], 35)]) }));
  await recordActivity(db, comment({ at: T2 }));
  await learnOnce({ db, clock: fixed(T3) });
  await savePullRequest(db, closed());
  const atClose = await learnOnce({ db, clock: fixed(plus(CLOSED, HOUR_MS)) });
  assert.equal(atClose.added, 0);
  assert.equal(atClose.pullRequests, 1);
  assert.deepEqual((await records(db)).map((r) => [r.source_ref, r.created_at.toISOString()]), [['7:h-low:src/billing/tax.ts', T2]]);
  assert.deepEqual(await work(db), []);
  await db.close();
});

test('a comment that arrives on a pull request already learned is learned by the next pass', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await recordActivity(db, comment());
  await learnOnce({ db, clock: fixed(plus(CLOSED, HOUR_MS)) });
  const late = plus(CLOSED, DAY_MS);
  await recordActivity(db, comment({ sourceId: 'c-2', path: 'src/cart/cart.ts', at: late }));
  assert.deepEqual(await work(db), [7]);
  const next = await learnOnce({ db, clock: fixed(plus(late, HOUR_MS)) });
  assert.deepEqual(next, { pullRequests: 1, examined: 1, added: 1, retired: 0, failed: 0, more: false });
  const cart = (await records(db)).find((r) => r.source_ref === '7:file:src/cart/cart.ts');
  assert.equal(cart!.created_at.toISOString(), late);
  assert.deepEqual(await work(db), []);
  await db.close();
});

test('a pull request reopened and closed again is learned again, and nothing is made twice', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await recordActivity(db, comment());
  await learnOnce({ db, clock: fixed(plus(CLOSED, HOUR_MS)) });
  await savePullRequest(db, facts({ updatedAt: plus(CLOSED, DAY_MS) }));
  const again = plus(CLOSED, 3 * DAY_MS);
  await savePullRequest(db, closed({ closedAt: again, updatedAt: again }));
  assert.deepEqual(await work(db), [7]);
  const second = await learnOnce({ db, clock: fixed(plus(again, HOUR_MS)) });
  assert.deepEqual(second, { pullRequests: 1, examined: 0, added: 0, retired: 0, failed: 0, more: false });
  assert.deepEqual((await records(db)).map((r) => [r.source_ref, r.created_at.toISOString()]), [['7:file:src/billing/tax.ts', CLOSED]]);
  assert.deepEqual(await work(db), []);
  await db.close();
});

test('a pull request that was looked at is not selected again', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await savePullRequest(db, closed({ ref: refOf(8) }));
  await recordActivity(db, comment({ ref: refOf(8), sourceId: 'c-8', author: 'octo-dev', association: 'owner' }));
  await savePullRequest(db, facts({ ref: refOf(9) }));
  await recordActivity(db, comment({ ref: refOf(9), sourceId: 'c-9' }));
  assert.deepEqual(await work(db), [7, 8, 9]);
  const learned = await learnOnce({ db, clock: fixed(plus(CLOSED, HOUR_MS)) });
  assert.deepEqual(learned, { pullRequests: 3, examined: 2, added: 0, retired: 0, failed: 0, more: false });
  assert.deepEqual(await work(db), []);
  assert.deepEqual(await records(db), []);
  await db.close();
});

test('a comment whose pull request is not stored waits, and stops nothing', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await recordActivity(db, comment());
  await recordActivity(db, comment({ ref: refOf(8), sourceId: 'c-8' }));
  await learnOnce({ db, clock: fixed(plus(CLOSED, HOUR_MS)) });
  assert.deepEqual(await refs(db), ['7:file:src/billing/tax.ts']);
  const [waiting] = await db.query<{ learned_at: Date | null }>("select learned_at from visto_ai.human_activity where source_id = 'c-8'");
  assert.equal(waiting!.learned_at, null);
  await savePullRequest(db, closed({ ref: refOf(8) }));
  await learnOnce({ db, clock: fixed(plus(CLOSED, 2 * HOUR_MS)) });
  assert.deepEqual(await refs(db), ['7:file:src/billing/tax.ts', '8:file:src/billing/tax.ts']);
  await db.close();
});

test('a pull request whose transaction fails is passed over, and the others are learned', async () => {
  const db = await testDb();
  for (const number of [7, 8, 9]) {
    await savePullRequest(db, closed({ ref: refOf(number) }));
    await recordActivity(db, comment({ ref: refOf(number), sourceId: `c-${number}` }));
  }
  const logged: Array<Record<string, unknown>> = [];
  const now = plus(CLOSED, HOUR_MS);
  const learned = await learnOnce({ db: failingFor(db, 8), clock: fixed(now), log: (e) => { logged.push(e); } });
  assert.deepEqual(learned, { pullRequests: 2, examined: 2, added: 2, retired: 0, failed: 1, more: false });
  assert.deepEqual(await refs(db), ['7:file:src/billing/tax.ts', '9:file:src/billing/tax.ts']);
  const row = await readLearning(db, WORK);
  assert.equal(row!.ranAt, now);
  assert.equal(row!.failed, 1);
  const failed = logged.find((e) => e['event'] === 'learning_pr_failed')!;
  assert.deepEqual({ ...failed, reason: undefined }, { event: 'learning_pr_failed', repo: 'acme/shop', number: 8, reason: undefined, attempts: 1 });
  assert.match(String(failed['reason']), SHORT_CODE);
  assert.equal(logged.some((e) => e['event'] === 'learning_pr_given_up'), false);
  // Nothing of 8 was written: no record, no mark on its comment, no learned time.
  const [c8] = await db.query<{ learned_at: Date | null }>("select learned_at from visto_ai.human_activity where source_id = 'c-8'");
  assert.equal(c8!.learned_at, null);
  const [p8] = await db.query<{ learned_at: Date | null }>('select learned_at from visto_ai.pull_requests where number = 8');
  assert.equal(p8!.learned_at, null);
  assert.equal(await attemptsOf(db, 8), 1);
  assert.deepEqual(await work(db), [8]);
  await db.close();
});

test('a pull request that fails three passes running is given up, and a success in between starts the count again', async () => {
  const db = await testDb();
  await savePullRequest(db, closed({ ref: refOf(8) }));
  await recordActivity(db, comment({ ref: refOf(8), sourceId: 'c-8' }));
  const failing = failingFor(db, 8);
  for (let pass = 1; pass <= 3; pass += 1) {
    const logged: Array<Record<string, unknown>> = [];
    await learnOnce({ db: failing, clock: fixed(plus(CLOSED, pass * HOUR_MS)), log: (e) => { logged.push(e); } });
    assert.equal(await attemptsOf(db, 8), pass);
    const failed = logged.find((e) => e['event'] === 'learning_pr_failed')!;
    assert.equal(failed['attempts'], pass);
    const givenUp = logged.filter((e) => e['event'] === 'learning_pr_given_up');
    if (pass < 3) assert.deepEqual(givenUp, []);
    else assert.deepEqual(givenUp, [{ event: 'learning_pr_given_up', repo: 'acme/shop', number: 8, reason: failed['reason'] }]);
  }
  const fourth: Array<Record<string, unknown>> = [];
  const learned = await learnOnce({ db: failing, clock: fixed(plus(CLOSED, 4 * HOUR_MS)), log: (e) => { fourth.push(e); } });
  assert.deepEqual(learned, { pullRequests: 0, examined: 0, added: 0, retired: 0, failed: 0, more: false });
  assert.deepEqual(fourth, []);
  assert.equal(await attemptsOf(db, 8), 3);
  await db.close();

  const other = await testDb();
  await savePullRequest(other, closed({ ref: refOf(8) }));
  await recordActivity(other, comment({ ref: refOf(8), sourceId: 'c-8' }));
  await learnOnce({ db: failingFor(other, 8), clock: fixed(plus(CLOSED, HOUR_MS)) });
  await learnOnce({ db: failingFor(other, 8), clock: fixed(plus(CLOSED, 2 * HOUR_MS)) });
  assert.equal(await attemptsOf(other, 8), 2);
  const plain = await learnOnce({ db: other, clock: fixed(plus(CLOSED, 3 * HOUR_MS)) });
  assert.equal(plain.added, 1);
  assert.equal(await attemptsOf(other, 8), 0);
  await other.close();
});

test('a database that does not answer at all fails the pass, and counts no attempt', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await recordActivity(db, comment());
  const down = wrap(db, {
    query: () => Promise.reject(new Error('db_down')),
    transaction: () => Promise.reject(new Error('db_down')),
  });
  const logged: Array<Record<string, unknown>> = [];
  await assert.rejects(learnOnce({ db: down, clock: fixed(plus(CLOSED, HOUR_MS)), log: (e) => { logged.push(e); } }));
  assert.deepEqual(logged, [{ event: 'learning_failed', reason: 'db_down' }]);
  assert.equal(await attemptsOf(db, 7), 0);
  assert.equal(await readLearning(db, WORK), null);

  // A transaction that rejects and a count of the attempt that rejects too: the database is not answering.
  const half = wrap(db, {
    query: async <R,>(text: string, params?: unknown[]) => {
      if (text.includes('learn_attempts + 1')) throw new Error('db_down');
      return db.query<R>(text, params);
    },
    transaction: () => Promise.reject(new Error('db_down')),
  });
  await assert.rejects(learnOnce({ db: half, clock: fixed(plus(CLOSED, HOUR_MS)) }));
  assert.equal(await attemptsOf(db, 7), 0);
  assert.equal(await readLearning(db, WORK), null);
  await db.close();
});

test('a run with a result that cannot be read does not stop the pass', async () => {
  const db = await testDb();
  const results: unknown[] = [
    {},
    { scores: 'x', verdict: { threshold: 70 } },
    { scores: [{ path: 'src/billing/tax.ts', blocks: [{ hash: 'h-1', entry: { score: 30, category: 'refactor', reason: 'r' } }] }], verdict: { threshold: 70 } },
    { scores: [{ path: 'src/billing/tax.ts', blocks: 'none' }, 'junk', null], verdict: 'x' },
  ];
  for (let i = 0; i < results.length; i += 1) {
    const ref = refOf(7 + i);
    await savePullRequest(db, closed({ ref }));
    await recordRun(db, run({ ref, result: results[i] }));
    await recordActivity(db, comment({ ref, sourceId: `c-${7 + i}` }));
  }
  await savePullRequest(db, closed({ ref: refOf(20) }));
  await recordActivity(db, comment({ ref: refOf(20), sourceId: 'c-20', path: 'src/cart/cart.ts' }));
  const learned = await learnOnce({ db, clock: fixed(plus(CLOSED, HOUR_MS)) });
  assert.deepEqual(learned, { pullRequests: 5, examined: 5, added: 5, retired: 0, failed: 0, more: false });
  assert.deepEqual(await refs(db), [
    '7:file:src/billing/tax.ts', '8:file:src/billing/tax.ts', '9:file:src/billing/tax.ts', '10:file:src/billing/tax.ts', '20:file:src/cart/cart.ts',
  ]);
  await db.close();
});

test('a reply in the thread of a note makes a signal, and a reply in the thread of a finding makes none', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  const runId = await recordRun(db, run());
  await recordComments(db, runId, REF, [
    { commentId: 'n-1', path: 'src/billing/tax.ts', side: 'RIGHT', line: 12, severity: 'note', quote: '', blockHash: 'h-1' },
    { commentId: 'f-1', path: 'src/cart/cart.ts', side: 'RIGHT', line: 4, severity: 'major', quote: '' },
  ]);
  await recordActivity(db, comment({ sourceId: 'c-1', replyTo: 'n-1', thread: 'n-1' }));
  await recordActivity(db, comment({ sourceId: 'c-2', replyTo: 'f-1', thread: 'f-1', path: 'src/cart/cart.ts', line: 4 }));
  const learned = await learnOnce({ db, clock: fixed(plus(CLOSED, HOUR_MS)) });
  assert.equal(learned.examined, 2);
  assert.deepEqual(await refs(db), ['7:file:src/billing/tax.ts']);
  await db.close();
});

test('the scores of a dry run count', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await recordRun(db, run({ dryRun: true, result: scoredResult([block('h-low', [[10, 14]], 35, 'billing')]) }));
  await recordActivity(db, comment());
  await learnOnce({ db, clock: fixed(plus(CLOSED, HOUR_MS)) });
  const [r] = await records(db);
  assert.equal(r!.source_ref, '7:h-low:src/billing/tax.ts');
  assert.equal(r!.category, 'billing');
  assert.equal(r!.missed, true);
  await db.close();
});

test('an expired record is retired, and the pass counts it', async () => {
  const db = await testDb();
  const now = '2026-09-01T00:00:00.000Z';
  await addRecords(db, { service: 'github', owner: 'acme', repo: 'shop' }, [
    { kind: 'human_signal', sourceRef: '3:file:src/billing/tax.ts', number: 3, path: 'src/billing/tax.ts', directory: 'src/billing', category: null, reason: null, missed: false, excerpt: '', comment: 'c-3', createdAt: T1, expiresAt: plus(now, -HOUR_MS) },
    { kind: 'human_signal', sourceRef: '4:file:src/billing/tax.ts', number: 4, path: 'src/billing/tax.ts', directory: 'src/billing', category: null, reason: null, missed: false, excerpt: '', comment: 'c-4', createdAt: T1, expiresAt: plus(now, HOUR_MS) },
  ]);
  const logged: Array<Record<string, unknown>> = [];
  const learned = await learnOnce({ db, clock: fixed(now), log: (e) => { logged.push(e); } });
  assert.deepEqual(learned, { pullRequests: 0, examined: 0, added: 0, retired: 1, failed: 0, more: false });
  assert.deepEqual((await records(db)).map((r) => [r.number, r.status]), [[3, 'expired'], [4, 'active']]);
  assert.deepEqual(logged, [{ event: 'learning', pull_requests: 0, examined: 0, added: 0, retired: 1, failed: 0, more: false }]);
  assert.equal((await readLearning(db, WORK))!.retired, 1);
  await db.close();
});

test('a pass writes when it ran and what it added, and a pass that rejects writes nothing', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  await recordActivity(db, comment());
  const first = plus(CLOSED, HOUR_MS);
  await learnOnce({ db, clock: fixed(first) });
  assert.deepEqual(await readLearning(db, WORK), { since: first, ranAt: first, examined: 1, added: 1, retired: 0, failed: 0 });
  // A pass that commits a pull request, then meets a database that does not answer: the commit stays, the row does not move.
  await savePullRequest(db, closed({ ref: refOf(8) }));
  await recordActivity(db, comment({ ref: refOf(8), sourceId: 'c-8' }));
  const late = wrap(db, {
    query: async <R,>(text: string, params?: unknown[]) => {
      if (text.includes("set status = 'expired'")) throw new Error('db_down');
      return db.query<R>(text, params);
    },
  });
  const logged: Array<Record<string, unknown>> = [];
  await assert.rejects(learnOnce({ db: late, clock: fixed(plus(CLOSED, 2 * HOUR_MS)), log: (e) => { logged.push(e); } }));
  assert.deepEqual(logged, [{ event: 'learning_failed', reason: 'db_down' }]);
  assert.deepEqual(await readLearning(db, WORK), { since: first, ranAt: first, examined: 1, added: 1, retired: 0, failed: 0 });
  assert.deepEqual(await refs(db), ['7:file:src/billing/tax.ts', '8:file:src/billing/tax.ts']);
  await db.close();
});

test('more work than one pass takes is left for the next, and the pass says so', async () => {
  const db = await testDb();
  for (const number of [7, 8, 9, 10, 11]) await savePullRequest(db, closed({ ref: refOf(number) }));
  const first = await learnOnce({ db, clock: fixed(plus(CLOSED, HOUR_MS)), batch: 2, batches: 2 });
  assert.deepEqual(first, { pullRequests: 4, examined: 0, added: 0, retired: 0, failed: 0, more: true });
  assert.deepEqual(await work(db), [11]);
  const next = await learnOnce({ db, clock: fixed(plus(CLOSED, 2 * HOUR_MS)), batch: 2, batches: 2 });
  assert.deepEqual(next, { pullRequests: 1, examined: 0, added: 0, retired: 0, failed: 0, more: false });
  await db.close();
});

test('a pass that is told to stop reads no further pull request', async () => {
  const db = await testDb();
  for (const number of [7, 8, 9]) await savePullRequest(db, closed({ ref: refOf(number) }));
  let stop = false;
  const counted = wrap(db, {
    transaction: async <T,>(work: (tx: Db) => Promise<T>) => {
      const out = await db.transaction(work);
      stop = true;
      return out;
    },
  });
  const learned = await learnOnce({ db: counted, clock: fixed(plus(CLOSED, HOUR_MS)), stopping: () => stop });
  assert.equal(learned.pullRequests, 1);
  assert.deepEqual(await work(db), [8, 9]);
  assert.equal((await readLearning(db, WORK))!.ranAt, plus(CLOSED, HOUR_MS));
  const none = await learnOnce({ db, clock: fixed(plus(CLOSED, 2 * HOUR_MS)), stopping: () => true });
  assert.equal(none.pullRequests, 0);
  assert.deepEqual(await work(db), [8, 9]);
  await db.close();
});

test('start makes the row once and logs what it holds', async () => {
  const db = await testDb();
  const logged: Array<Record<string, unknown>> = [];
  let now = T1;
  const learning = createLearning({ db, clock: () => new Date(now), log: (e) => { logged.push(e); }, alert: () => {} });
  await learning.start();
  now = T2;
  await learning.start();
  assert.deepEqual(logged, [
    { event: 'learning_state', since: T1, last_ran: null, examined: 0, added: 0, retired: 0, failed: 0 },
    { event: 'learning_state', since: T1, last_ran: null, examined: 0, added: 0, retired: 0, failed: 0 },
  ]);
  const down = createLearning({ db: wrap(db, { query: () => Promise.reject(new Error('db_down')) }), clock: () => new Date(now), log: () => {}, alert: () => {} });
  await assert.rejects(down.start());
  learning.stop();
  await db.close();
});

test('a pass that keeps failing raises learning_stale once after 36 hours, and a restart does not start the count again', async () => {
  const db = await testDb();
  const T = T1;
  let now = T;
  const clock = () => new Date(now);
  const alerts: Array<[string, unknown]> = [];
  const alert = (code: string, details?: unknown) => { alerts.push([code, details]); };
  const failing = passFails(db);
  const learning = createLearning({ db: failing, clock, log: () => {}, alert });
  await learning.start();
  now = plus(T, 35 * HOUR_MS);
  await learning.tick();
  assert.deepEqual(alerts, []);
  now = plus(T, 37 * HOUR_MS);
  await learning.tick();
  assert.deepEqual(alerts, [['learning_stale', { hours: 37 }]]);
  now = plus(T, 38 * HOUR_MS);
  await learning.tick();
  assert.equal(alerts.length, 1);
  learning.stop();
  // A restart: a new Learning over the same row.
  now = plus(T, 39 * HOUR_MS);
  const restarted = createLearning({ db: failing, clock, log: () => {}, alert });
  await restarted.start();
  await restarted.tick();
  assert.deepEqual(alerts, [['learning_stale', { hours: 37 }], ['learning_stale', { hours: 39 }]]);
  restarted.stop();
  await db.close();
});

test('a pass that never settles: the tick returns at its limit, no pass starts on top of it, and learning_stale is raised at 36 hours', async () => {
  const db = await testDb();
  await savePullRequest(db, closed());
  let started = 0;
  const hanging = wrap(db, {
    transaction: <T,>() => {
      started += 1;
      return new Promise<T>(() => {});
    },
  });
  let now = plus(CLOSED, HOUR_MS);
  const logged: Array<Record<string, unknown>> = [];
  const alerts: Array<[string, unknown]> = [];
  const learning = createLearning({ db: hanging, clock: () => new Date(now), log: (e) => { logged.push(e); }, alert: (code, details) => { alerts.push([code, details]); }, passLimitMs: 5 });
  await learning.tick();
  assert.equal(started, 1);
  assert.deepEqual(logged, [{ event: 'learning_failed', reason: 'timeout' }]);
  await learning.tick();
  assert.equal(started, 1);
  learning.wake();
  assert.equal(started, 1);
  now = plus(CLOSED, 38 * HOUR_MS);
  await learning.tick();
  assert.deepEqual(alerts, [['learning_stale', { hours: 37 }]]);
  assert.equal(started, 1);
  learning.stop();
  await db.close();
});

test('a row that was never written counts from the start of the service', async () => {
  const made = T1;
  for (const readFails of [false, true]) {
    const db = await testDb();
    let now = made;
    const alerts: Array<[string, unknown]> = [];
    const broken = readFails
      ? wrap(db, { query: () => Promise.reject(new Error('db_down')) })
      : passFails(db);
    // An alert that throws, and a log that throws, change nothing.
    const learning = createLearning({
      db: broken, clock: () => new Date(now), log: () => { throw new Error('log'); },
      alert: (code, details) => { alerts.push([code, details]); throw new Error('alert'); },
    });
    now = plus(made, 35 * HOUR_MS);
    await learning.tick();
    assert.deepEqual(alerts, [], `read fails: ${readFails}`);
    now = plus(made, 37 * HOUR_MS);
    await learning.tick();
    assert.deepEqual(alerts, [['learning_stale', { hours: 37 }]], `read fails: ${readFails}`);
    assert.equal(await readLearning(db, WORK), null);
    learning.stop();
    await db.close();
  }
});

test('after a pass that works the alert can be raised again later', async () => {
  const db = await testDb();
  let failing = true;
  let now = T1;
  const alerts: Array<[string, unknown]> = [];
  const learning = createLearning({ db: passFails(db, () => failing), clock: () => new Date(now), log: () => {}, alert: (code, details) => { alerts.push([code, details]); } });
  await learning.start();
  now = plus(T1, 37 * HOUR_MS);
  await learning.tick();
  assert.equal(alerts.length, 1);
  failing = false;
  const worked = plus(T1, 38 * HOUR_MS);
  now = worked;
  await learning.tick();
  assert.equal(alerts.length, 1);
  assert.equal((await readLearning(db, WORK))!.ranAt, worked);
  failing = true;
  now = plus(worked, 35 * HOUR_MS);
  await learning.tick();
  assert.equal(alerts.length, 1);
  now = plus(worked, 37 * HOUR_MS);
  await learning.tick();
  assert.deepEqual(alerts, [['learning_stale', { hours: 37 }], ['learning_stale', { hours: 37 }]]);
  learning.stop();
  await db.close();
});

test('wake returns at once, a wake during a pass makes one more pass, and after stop none starts', async () => {
  const db = await testDb();
  let passes = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const gated = wrap(db, {
    query: async <R,>(text: string, params?: unknown[]) => {
      if (text.includes('learn_attempts < $1')) {
        passes += 1;
        if (passes === 1) await gate;
      }
      return db.query<R>(text, params);
    },
  });
  const learning = createLearning({ db: gated, clock: fixed(T1), log: () => {}, alert: () => {} });
  assert.equal(learning.wake(), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passes, 1);
  learning.wake();
  learning.wake();
  const ticked = learning.tick();
  learning.wake();
  release();
  await ticked;
  await learning.idle();
  assert.equal(passes, 2);
  await learning.tick();
  assert.equal(passes, 3);
  learning.stop();
  learning.wake();
  await learning.tick();
  await learning.idle();
  assert.equal(passes, 3);
  await db.close();
});

test('a pass with nothing to do logs nothing, and no entry holds what a person wrote', async () => {
  const db = await testDb();
  const logged: Array<Record<string, unknown>> = [];
  const log = (e: Record<string, unknown>) => { logged.push(e); };
  await learnOnce({ db, clock: fixed(T1), log });
  const quiet = createLearning({ db, clock: fixed(T1), log, alert: () => {} });
  await quiet.tick();
  quiet.stop();
  assert.deepEqual(logged, []);

  for (const number of [7, 8]) {
    await savePullRequest(db, closed({ ref: refOf(number) }));
    await recordActivity(db, comment({ ref: refOf(number), sourceId: `c-${number}`, body: 'the rounding loses a cent' }));
  }
  for (let pass = 1; pass <= LEARN_ATTEMPTS; pass += 1) {
    await learnOnce({ db: failingFor(db, 8), clock: fixed(plus(CLOSED, pass * HOUR_MS)), log });
  }
  assert.ok(logged.some((e) => e['event'] === 'learning' && e['added'] === 1));
  assert.ok(logged.some((e) => e['event'] === 'learning_pr_given_up'));
  for (const entry of logged) {
    for (const [key, value] of Object.entries(entry)) {
      const ok = typeof value === 'number' || typeof value === 'boolean' || value === 'acme/shop' || (typeof value === 'string' && SHORT_CODE.test(value));
      assert.ok(ok, `${key}: ${String(value)}`);
    }
  }
  const text = JSON.stringify(logged);
  for (const word of ['octo-lead', 'octo-dev', 'src/', 'rounding']) assert.equal(text.includes(word), false, word);
  await db.close();
});

test('the stale limit is 36 hours', () => {
  assert.equal(STALE_AFTER_MS, 36 * HOUR_MS);
});
