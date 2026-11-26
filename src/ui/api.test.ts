import test from 'node:test';
import assert from 'node:assert/strict';
import { askWithdraw, claimJob, enqueueJob, markStage, requeueJob } from '../db/jobs.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { markPublished, recordRun } from '../db/review-runs.ts';
import type { RunRecord } from '../db/review-runs.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import type { PullRequestFacts, PullRequestRef } from '../forge/types.ts';
import { activity, me, reviews } from './api.ts';
import type { ApiDeps } from './api.ts';
import type { Activity, ActivityJob, Me, RecentReview, Reviews, Withdrawal } from './api-types.ts';
import type { Session } from './auth.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const pr = (number: number, repo = 'shop'): PullRequestRef => ({ service: 'github', owner: 'acme', repo, number });
const HEAD = 'a41c09e2b7d3f00dbabe0123456789abcdef0123';
const STORED = '17f0c3a9e5b2c0ffee0123456789abcdef012345';
const BASE = 'b0b0b0b0c1c1c1c1d2d2d2d2e3e3e3e3f4f4f4f4';
const SESSION: Session = { login: 'octo-lead', idHash: 'h-a', csrf: 'q7Jv0bW2m3n4o5p6q7r8s9t0u1v2w3x4y5z6A7B8C9D' };
const urlOf = (ref: PullRequestRef): string => `https://github.example.test/${ref.owner}/${ref.repo}/pull/${ref.number}`;

function deps(db: Db, more: Partial<ApiDeps> = {}): ApiDeps {
  return {
    db, clock: () => new Date(at(0)), dryRun: false, reviewPlaces: 2, withdrawPlaces: 2,
    holds: () => true, paused: async () => null, pullRequestUrl: urlOf, ...more,
  };
}

const facts = (ref: PullRequestRef, more: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref, author: 'octo-guest', authorIsBot: false, baseBranch: 'main', headBranch: 'feature-branch', headSha: STORED,
  draft: false, state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0), ...more,
});

type Enqueued = Partial<Pick<Parameters<typeof enqueueJob>[1], 'reason' | 'headSha' | 'runAt' | 'now' | 'trigger' | 'requestedBy' | 'commentId' | 'association' | 'installation' | 'delivery'>>;
async function enqueue(db: Db, ref: PullRequestRef, more: Enqueued = {}): Promise<number> {
  const id = await enqueueJob(db, {
    ref, reason: 'opened', headSha: HEAD, runAt: at(0), now: at(0), delivery: null, replace: false,
    trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null, ...more,
  });
  return id!;
}
/** A review job running since `seconds`. */
async function running(db: Db, ref: PullRequestRef, seconds: number): Promise<number> {
  const id = await enqueue(db, ref, { runAt: at(-300), now: at(-300) });
  await claimJob(db, id, at(seconds));
  return id;
}

const RESULT = { findings: [{ severity: 'major' }], verdict: { threshold: 70 } };
async function run(db: Db, ref: PullRequestRef, more: Partial<RunRecord> = {}): Promise<number> {
  return recordRun(db, {
    ref, job: null, trigger: 'automatic', mode: 'full', dryRun: true, headSha: HEAD, baseSha: BASE, baseBranch: 'main',
    outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 30, body: '', comments: [], result: RESULT,
    usage: { calls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0.084 }, startedAt: at(-700), finishedAt: at(-659), ...more,
  });
}

test('me holds the login, the token, the mode and the repositories seen', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(pr(7)));
  await savePullRequest(db, facts(pr(8)));
  await savePullRequest(db, facts({ service: 'github', owner: 'Acme', repo: 'Billing', number: 3 }));
  assert.deepEqual(await me(deps(db, { dryRun: true }), SESSION), {
    login: 'octo-lead', csrf: 'q7Jv0bW2m3n4o5p6q7r8s9t0u1v2w3x4y5z6A7B8C9D', mode: 'dry_run', repositories: ['acme/billing', 'acme/shop'],
  });
  assert.equal((await me(deps(db), SESSION)).mode, 'live');
  await db.close();
});

test('a running job this service does not hold reads as stopped, and a pending one\'s old stage is not read', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(pr(1), { title: 'Cache the tax table per region' }));
  await savePullRequest(db, facts(pr(9)));
  const stopped = await running(db, pr(1), -90);
  const plain = await running(db, pr(2), -80);
  const judging = await running(db, pr(3), -70);
  await markStage(db, judging, { stage: 'judging_threads', batch: 1, batches: 3, threadsDue: 2 }, at(-65));
  const reviewing = await running(db, pr(4), -60);
  await markStage(db, reviewing, { stage: 'reviewing', batch: 2, batches: 3 }, at(-55));
  const publishing = await running(db, pr(5), -50);
  await markStage(db, publishing, { stage: 'publishing' }, at(-45));
  await db.query(`update visto_ai.jobs set batch = 3, batches = 3, threads_due = 1 where id = $1`, [publishing]);
  const odd = await running(db, pr(11), -40);
  await db.query(`update visto_ai.jobs set stage = 'thinking', batch = 1, batches = 2 where id = $1`, [odd]);
  // A push's job as receiving stores it, with a stage left on it by hand.
  const push = await enqueue(db, pr(6), { reason: 'synchronize', runAt: at(180), now: at(0) });
  await db.query(`update visto_ai.jobs set stage = 'reviewing', batch = 1, batches = 2, threads_due = 1 where id = $1`, [push]);
  const reopened = await enqueue(db, pr(7), { reason: 'reopened', headSha: '', runAt: at(180), now: at(0) });
  const due = await enqueue(db, pr(8), { runAt: at(0), now: at(-5), requestedBy: 'octo-guest' });
  const manual = await enqueue(db, pr(9), { reason: 'command', headSha: '', runAt: at(-1), now: at(-1), trigger: 'manual', requestedBy: 'octo-dev' });

  const asked: PullRequestRef[] = [];
  const holds = (ref: PullRequestRef): boolean => { asked.push(ref); return ref.number !== 1; };
  const answer = await activity(deps(db, { holds }));
  const job = (id: number, number: number, more: Partial<ActivityJob>): ActivityJob => ({
    job: id, repository: 'acme/shop', number, title: null, url: urlOf(pr(number)), head: HEAD.slice(0, 12),
    stage: 'queued', batch: null, batches: null, threadsDue: null, startedAt: null, runAt: at(0), askedBy: { reason: 'opened', login: null }, ...more,
  });
  assert.deepEqual(answer.jobs, [
    job(stopped, 1, { title: 'Cache the tax table per region', stage: 'stopped', startedAt: at(-90), runAt: at(-300) }),
    job(plain, 2, { stage: 'preparing', startedAt: at(-80), runAt: at(-300) }),
    job(judging, 3, { stage: 'judging_threads', batch: 1, batches: 3, threadsDue: 2, startedAt: at(-70), runAt: at(-300) }),
    job(reviewing, 4, { stage: 'reviewing', batch: 2, batches: 3, startedAt: at(-60), runAt: at(-300) }),
    job(publishing, 5, { stage: 'publishing', startedAt: at(-50), runAt: at(-300) }),
    job(odd, 11, { stage: 'preparing', startedAt: at(-40), runAt: at(-300) }),
    job(manual, 9, { head: STORED.slice(0, 12), runAt: at(-1), askedBy: { reason: 'command', login: 'octo-dev' } }),
    job(due, 8, {}),
    job(push, 6, { stage: 'waiting', runAt: at(180), askedBy: { reason: 'synchronize', login: null } }),
    job(reopened, 7, { head: null, stage: 'retrying', runAt: at(180), askedBy: { reason: 'reopened', login: null } }),
  ]);
  assert.deepEqual(asked, [1, 2, 3, 4, 5, 11].map((n) => pr(n)));
  assert.ok(asked.every((ref) => ref.service === 'github'));

  // The push's job put back by requeueJob to now + 60 s is waiting to try again.
  await claimJob(db, push, at(180));
  assert.equal(await requeueJob(db, push, at(240), at(180), false), 'requeued');
  const later = await activity(deps(db, { clock: () => new Date(at(180)) }));
  assert.deepEqual(later.jobs.find((j) => j.job === push), job(push, 6, { stage: 'retrying', runAt: at(240), askedBy: { reason: 'synchronize', login: null } }));
  await db.close();
});

test('the requester of a /review or a /done is shown, and never that of a re-run of the check', async () => {
  const db = await testDb();
  const reasons = ['command', 'command_retry', 'done', 'done_retry', 'rerun', 'rerun_retry'];
  for (const [i, reason] of reasons.entries()) {
    await enqueue(db, pr(i + 1), { reason, headSha: '', runAt: at(-1), now: at(-1), trigger: 'manual', requestedBy: 'octo-dev' });
  }
  const answer = await activity(deps(db));
  assert.deepEqual(answer.jobs.map((j) => [j.number, j.askedBy]), [
    [1, { reason: 'command', login: 'octo-dev' }], [2, { reason: 'command_retry', login: 'octo-dev' }],
    [3, { reason: 'done', login: 'octo-dev' }], [4, { reason: 'done_retry', login: 'octo-dev' }],
    [5, { reason: 'rerun', login: null }], [6, { reason: 'rerun_retry', login: null }],
  ]);
  assert.ok(!JSON.stringify(answer.jobs.slice(4)).includes('octo-dev'));
  await db.close();
});

test('the pause is told only as spend_limit or model_error', async () => {
  const db = await testDb();
  const id = (await askWithdraw(db, pr(10), at(-20), '99'))!;
  await claimJob(db, id, at(-20));
  await requeueJob(db, id, at(52), at(-10), false, 'github_403');
  const told = async (code: string | null): Promise<Activity['paused']> => (await activity(deps(db, { paused: async () => code }))).paused;
  assert.equal(await told('spend_limit'), 'spend_limit');
  assert.equal(await told('model_error'), 'model_error');
  assert.equal(await told('other_code'), null);
  assert.equal(await told(null), null);
  assert.deepEqual(await activity(deps(db, { reviewPlaces: 3 })), {
    now: at(0), places: { reviews: 3, withdrawals: 2 }, paused: null, jobs: [],
    withdrawals: [{ repository: 'acme/shop', number: 10, code: 'github_403', runAt: at(52) }],
  });
  await db.close();
});

const titles = (answer: Reviews | 'bad_request'): Array<string | null> => {
  assert.notEqual(answer, 'bad_request');
  return (answer as Reviews).reviews.map((r) => r.title);
};

test('the search takes percent, underscore and backslash as themselves, an empty parameter is absent, and a malformed one is bad_request', async () => {
  const db = await testDb();
  const named = ['100% done', 'a_b', 'c\\d', 'abc'];
  for (const [i, title] of named.entries()) {
    await savePullRequest(db, facts(pr(i + 1), { title }));
    await run(db, pr(i + 1));
  }
  await run(db, pr(40, 'billing'), { outcome: 'failed', failureStage: 'model', failureCode: 'model_timeout' });
  const d = deps(db);
  const ask = (params: Record<string, string> | string): Promise<Reviews | 'bad_request'> => reviews(d, new URLSearchParams(params));
  assert.deepEqual(titles(await ask({ q: '%' })), ['100% done']);
  assert.deepEqual(titles(await ask({ q: '_' })), ['a_b']);
  assert.deepEqual(titles(await ask({ q: '\\' })), ['c\\d']);
  assert.deepEqual(titles(await ask({ q: '  ABC  ' })), ['abc']);
  assert.deepEqual(titles(await ask({ q: '#2' })), ['a_b']);
  assert.deepEqual(titles(await ask({ q: '3' })), ['c\\d']);
  assert.deepEqual(titles(await ask({ q: '   ' })), [null, 'abc', 'c\\d', 'a_b', '100% done']);
  assert.deepEqual(titles(await ask({ q: 'x'.repeat(100) })), []);
  assert.deepEqual(titles(await ask({ repo: 'Acme/Billing' })), [null]);
  assert.deepEqual(titles(await ask({ outcome: 'failed' })), [null]);

  assert.deepEqual(await ask('repo=&outcome=&before=&q='), await ask(''));
  assert.equal((await ask('repo=&outcome=&before=&q=') as Reviews).total, 5);
  for (const bad of [
    { repo: 'acme' } as Record<string, string>, { repo: 'acme/shop/x' }, { repo: 'acme/sh op' }, { outcome: 'all' }, { outcome: 'audit' }, { outcome: 'constructor' },
    { before: 'x' }, { before: '-1' }, { before: '2147483648' }, { before: '12345678901' }, { q: 'x'.repeat(101) },
  ]) assert.equal(await ask(bad), 'bad_request', JSON.stringify(bad));
  assert.equal(await ask('outcome=failed&outcome=approved'), 'bad_request');
  await db.close();
});

/** The db with each statement sent to it recorded, with its parameters. */
function recording(inner: Db): { db: Db; sent: Array<{ text: string; params: unknown[] }> } {
  const sent: Array<{ text: string; params: unknown[] }> = [];
  const db: Db = {
    query: (text, params) => { sent.push({ text, params: params ?? [] }); return inner.query(text, params); },
    script: (sql) => inner.script(sql),
    close: () => inner.close(),
    transaction: (work) => inner.transaction(work),
  };
  return { db, sent };
}
const NUL = String.fromCharCode(0);

test('a search or a repository holding a NUL is bad_request, and no statement is sent', async () => {
  const db = await testDb();
  const { db: spied, sent } = recording(db);
  for (const name of ['q', 'repo']) {
    for (const value of [NUL, `ab${NUL}cd`, `acme/sh${NUL}op`]) {
      assert.equal(await reviews(deps(spied), new URLSearchParams({ [name]: value })), 'bad_request', `${name} ${JSON.stringify(value)}`);
    }
  }
  assert.deepEqual(sent, []);
  await db.close();
});

test('needs_person lists and counts the audit sample too, approved only the approved, failed only the failed', async () => {
  const db = await testDb();
  const approved = await run(db, pr(1), { dryRun: false });
  await markPublished(db, approved, { reviewId: 'rv-1', publishedAt: at(-600), body: 'posted', inlineDropped: false, approved: true, approvalCode: 'approved' });
  const audit = await run(db, pr(2), { dryRun: false, needsHuman: true });
  await markPublished(db, audit, { reviewId: 'rv-2', publishedAt: at(-600), body: 'posted', inlineDropped: false, approved: false, approvalCode: 'audit_sample' });
  await run(db, pr(3), { needsHuman: true });
  await run(db, pr(4));
  await run(db, pr(5), { outcome: 'failed', failureStage: 'model', failureCode: 'model_timeout' });
  await run(db, pr(6), { dryRun: false, needsHuman: true });
  await run(db, pr(7), { result: { ...RESULT, nothingToDo: true } });
  const d = deps(db);
  const asked = async (query: string): Promise<[string[], number]> => {
    const answer = await reviews(d, new URLSearchParams(query)) as Reviews;
    return [answer.reviews.map((r) => r.outcome), answer.total];
  };
  assert.deepEqual(await asked(''), [['nothing_new', 'not_posted', 'failed', 'reviewed', 'needs_person', 'audit', 'approved'], 7]);
  assert.deepEqual(await asked('outcome=needs_person'), [['needs_person', 'audit'], 2]);
  assert.deepEqual(await asked('outcome=approved'), [['approved'], 1]);
  assert.deepEqual(await asked('outcome=failed'), [['failed'], 1]);
  await db.close();
});

test('a number is searched up to 9 digits, before is at most 2147483647, and an owner and a name are at most 100 characters each', async () => {
  const db = await testDb();
  const long = { service: 'github', owner: 'o'.repeat(100), repo: 'r'.repeat(100), number: 6 } as const;
  for (const [ref, title] of [
    [pr(123456789), 'Round prices before tax'], [pr(1234567890), 'Cache the tax table per region'], [pr(4), 'Bump the schema to 1234567890'],
    [pr(5), 'Match #* in the paths'], [long, 'Name the long repository'],
  ] as Array<[PullRequestRef, string]>) {
    await savePullRequest(db, facts(ref, { title }));
    await run(db, ref);
  }
  const { db: spied, sent } = recording(db);
  const d = deps(spied);
  const ask = (params: Record<string, string>): Promise<Reviews | 'bad_request'> => reviews(d, new URLSearchParams(params));
  /** The numbers found, and the number each statement was given ($5). */
  const searched = async (q: string): Promise<[number[], unknown[]]> => {
    sent.length = 0;
    const answer = await ask({ q });
    assert.notEqual(answer, 'bad_request', q);
    return [(answer as Reviews).reviews.map((r) => r.number), sent.map((s) => s.params[4])];
  };
  assert.deepEqual(await searched('123456789'), [[4, 123456789], [123456789, 123456789]]);
  assert.deepEqual(await searched('#123456789'), [[123456789], [123456789, 123456789]]);
  assert.deepEqual(await searched('1234567890'), [[4], [null, null]]);
  assert.deepEqual(await searched('#1234567890'), [[], [null, null]]);
  assert.deepEqual(await searched('#*'), [[5], [null, null]]);
  assert.deepEqual(await searched('#'), [[5], [null, null]]);

  assert.equal((await ask({ before: '2147483647' }) as Reviews).reviews.length, 5);
  assert.equal(await ask({ before: '2147483648' }), 'bad_request');

  assert.deepEqual((await ask({ repo: `${'o'.repeat(100)}/${'r'.repeat(100)}` }) as Reviews).reviews.map((r) => r.number), [6]);
  assert.equal((await ask({ repo: `acme/${'r'.repeat(100)}` }) as Reviews).total, 0);
  for (const repo of [`acme/${'r'.repeat(101)}`, `${'o'.repeat(101)}/shop`]) assert.equal(await ask({ repo }), 'bad_request', repo);
  await db.close();
});

test('a page is 25 runs, next is the 25th when a 26th came, and a run reads as the screens show it', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(pr(128), { title: 'Round prices before tax' }));
  const shown = await run(db, pr(128), {
    mode: 'incremental', dryRun: false, needsHuman: true, highestScore: 74, startedAt: at(-761), finishedAt: at(-720),
    result: { findings: [{ severity: 'major' }], verdict: { threshold: 70 } },
  });
  await markPublished(db, shown, { reviewId: 'rv-77', publishedAt: at(-719), body: 'posted', inlineDropped: false, approved: false, approvalCode: null });
  const failed = await run(db, pr(2), { outcome: 'failed', failureStage: 'model', failureCode: 'model_timeout', highestScore: 0, result: {} });
  const kept = await run(db, pr(3), { highestScore: 55, result: { ...RESULT, nothingToDo: true } });
  const ids: number[] = [];
  for (let i = 0; i < 23; i += 1) ids.push(await run(db, pr(200 + i)));

  const first = await reviews(deps(db), new URLSearchParams()) as Reviews;
  assert.deepEqual([first.now, first.windowDays, first.total, first.reviews.length], [at(0), 30, 26, 25]);
  assert.equal(first.next, first.reviews[24]!.run);
  assert.equal(first.next, failed);
  const rest = await reviews(deps(db), new URLSearchParams({ before: String(first.next) })) as Reviews;
  assert.deepEqual([rest.total, rest.next], [26, null]);
  assert.deepEqual(rest.reviews, [{
    run: shown, repository: 'acme/shop', number: 128, title: 'Round prices before tax', outcome: 'needs_person', failureCode: null,
    highest: 74, threshold: 70, findings: { blocker: 0, major: 1, minor: 0 }, mode: 'incremental', dryRun: false,
    cost: 0.084, tookMs: 41000, at: at(-720),
  }]);
  const byRun = new Map(first.reviews.map((r) => [r.run, r]));
  assert.deepEqual(
    [byRun.get(failed)!.outcome, byRun.get(failed)!.highest, byRun.get(failed)!.threshold, byRun.get(failed)!.failureCode],
    ['failed', null, null, 'model_timeout']);
  assert.deepEqual([byRun.get(kept)!.outcome, byRun.get(kept)!.highest], ['nothing_new', null]);
  assert.deepEqual([byRun.get(ids[0]!)!.outcome, byRun.get(ids[0]!)!.highest], ['reviewed', 30]);
  // The window starts 30 days before the clock.
  const month = await reviews(deps(db, { clock: () => new Date(Date.parse(at(-761)) + 30 * 86_400_000) }), new URLSearchParams()) as Reviews;
  assert.equal(month.total, 26);
  const after = await reviews(deps(db, { clock: () => new Date(Date.parse(at(-761)) + 30 * 86_400_000 + 1) }), new URLSearchParams()) as Reviews;
  assert.equal(after.total, 25);
  // Exactly 25 runs in the window: one page, and no next.
  assert.deepEqual([after.reviews.length, after.next], [25, null]);
  await db.close();
});

// The keys of each answer, held to api-types.ts by the type check: a key missing or added there fails to compile here.
const ME: Record<keyof Me, true> = { login: true, csrf: true, mode: true, repositories: true };
const ACTIVITY: Record<keyof Activity, true> = { now: true, places: true, paused: true, jobs: true, withdrawals: true };
const PLACES: Record<keyof Activity['places'], true> = { reviews: true, withdrawals: true };
const JOB: Record<keyof ActivityJob, true> = {
  job: true, repository: true, number: true, title: true, url: true, head: true, stage: true, batch: true, batches: true, threadsDue: true,
  startedAt: true, runAt: true, askedBy: true,
};
const ASKED_BY: Record<keyof ActivityJob['askedBy'], true> = { reason: true, login: true };
const WITHDRAWAL: Record<keyof Withdrawal, true> = { repository: true, number: true, code: true, runAt: true };
const REVIEWS: Record<keyof Reviews, true> = { now: true, windowDays: true, total: true, reviews: true, next: true };
const REVIEW: Record<keyof RecentReview, true> = {
  run: true, repository: true, number: true, title: true, outcome: true, failureCode: true, highest: true, threshold: true, findings: true,
  mode: true, dryRun: true, cost: true, tookMs: true, at: true,
};
const FINDINGS: Record<keyof RecentReview['findings'], true> = { blocker: true, major: true, minor: true };
const keysOf = (value: object): string[] => Object.keys(value).sort();
const keysIn = (shape: object): string[] => Object.keys(shape).sort();

test('an answer holds no field the screens do not show', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(pr(7), { title: 'Round prices before tax' }));
  const failed = await run(db, pr(7), { body: 'BODY-TEXT', dryRun: false, comments: [{ id: 'c-31', body: 'BODY-TEXT' }], outcome: 'failed', failureStage: 'context', failureCode: 'github_500' });
  const posted = await run(db, pr(7), { body: 'BODY-TEXT', dryRun: false, comments: [{ id: 'c-31', body: 'BODY-TEXT' }] });
  await markPublished(db, posted, { reviewId: 'rv-77', publishedAt: at(-600), body: 'BODY-TEXT', inlineDropped: false, approved: true, approvalCode: 'approved' });
  assert.ok(failed < posted);
  await enqueue(db, pr(7), {
    trigger: 'manual', reason: 'command', requestedBy: 'octo-dev', commentId: 'c-31', association: 'member', installation: '99', delivery: 'd-1',
  });
  const held = await running(db, pr(8), -30);
  await markStage(db, held, { stage: 'judging_threads', batch: 1, batches: 2, threadsDue: 1 }, at(-20));
  const withdraw = (await askWithdraw(db, pr(9), at(-20), '99'))!;
  await claimJob(db, withdraw, at(-20));
  await requeueJob(db, withdraw, at(52), at(-10), false, 'github_403');

  const d = deps(db);
  const answers = { me: await me(d, SESSION), activity: await activity(d), reviews: await reviews(d, new URLSearchParams()) as Reviews };
  assert.deepEqual(keysOf(answers.me), keysIn(ME));
  assert.deepEqual(keysOf(answers.activity), keysIn(ACTIVITY));
  assert.deepEqual(keysOf(answers.activity.places), keysIn(PLACES));
  assert.equal(answers.activity.jobs.length, 2);
  for (const job of answers.activity.jobs) {
    assert.deepEqual(keysOf(job), keysIn(JOB));
    assert.deepEqual(keysOf(job.askedBy), keysIn(ASKED_BY));
  }
  assert.equal(answers.activity.withdrawals.length, 1);
  for (const w of answers.activity.withdrawals) assert.deepEqual(keysOf(w), keysIn(WITHDRAWAL));
  assert.deepEqual(keysOf(answers.reviews), keysIn(REVIEWS));
  assert.equal(answers.reviews.reviews.length, 2);
  for (const r of answers.reviews.reviews) {
    assert.deepEqual(keysOf(r), keysIn(REVIEW));
    assert.deepEqual(keysOf(r.findings), keysIn(FINDINGS));
  }
  for (const [name, answer] of Object.entries(answers)) {
    const text = JSON.stringify(answer);
    for (const secret of ['BODY-TEXT', '"99"', 'c-31', 'member', 'd-1', 'rv-77', 'octo-guest', 'feature-branch', BASE, 'context', 'h-a']) {
      assert.ok(!text.includes(secret), `${name} holds ${secret}`);
    }
  }
  await db.close();
});
