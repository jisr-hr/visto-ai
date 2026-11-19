import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { enqueueJob, claimJob, finishJob, getJob, unfinishedJobs } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { listRuns } from '../db/review-runs.ts';
import type { RepoSettings } from '../config/load.ts';
import type { LivePullRequest, Source } from '../forge/types.ts';
import { review } from '../engine/review.ts';
import { SUBMIT_REVIEW } from '../engine/model/submit-review.ts';
import type { ModelClient, ModelResponse, ReviewDeps, ReviewInput, ReviewResult } from '../engine/types.ts';
import { runReviewJob } from './review-job.ts';
import type { ReviewJobDeps } from './review-job.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

let db: Db;
beforeEach(async () => { db = await testDb(); });
afterEach(async () => { await db.close(); });

const LIMITS = { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 240 };
const SETTINGS: RepoSettings = { primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: ['dependabot[bot]'], baseBranches: [] };
const LIVE: LivePullRequest = {
  info: { ref: REF, title: 'Add things', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'merge000', headSha: 'h1', draft: false },
  state: 'open',
};
/** The same pull request against another base: a test that runs two reviews in one database uses it for the second, which would otherwise be dropped as already reviewed. */
const OTHER_BASE: LivePullRequest = { ...LIVE, info: { ...LIVE.info, baseSha: 'merge999' } };
const USAGE = { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.5 };
const NO_CALLS = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
/** A result as the engine returns it for a finished review, with one finding. */
const okResult = (over: Partial<ReviewResult> = {}): ReviewResult => ({
  status: 'ok', failure: null, mode: 'full', overview: 'Looks fine.',
  findings: [{ path: 'a.ts', side: 'RIGHT', line: 3, severity: 'minor', body: 'A note.', quote: 'x', requestedLine: null }],
  unplaced: [], beyondDiff: [], coverage: { reviewed: ['a.ts'], notReviewed: [] }, usage: USAGE, models: ['m'], providers: [],
  dependencies: { model: 'ok' }, audit: [], scores: [], verdict: { threshold: 70, needsHuman: false, highest: 35 }, teamFileInvalid: null, ...over,
});
const failed = (stage: 'context' | 'model', code: string, over: Partial<ReviewResult> = {}): ReviewResult => okResult({
  status: 'failed', failure: { stage, code }, overview: '', findings: [], coverage: { reviewed: [], notReviewed: [] },
  verdict: { threshold: 70, needsHuman: true, highest: 100 }, ...over,
});

interface Options {
  live?: LivePullRequest | Error | null; result?: ReviewResult; settings?: RepoSettings; stored?: boolean;
  recordFailures?: number; lostAnswer?: boolean;
}

async function harness(options: Options = {}) {
  if (options.stored !== false) {
    await savePullRequest(db, {
      ref: REF, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: 'h1', draft: false, state: 'open',
      mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0),
    });
  }
  await enqueueJob(db, { ref: REF, reason: 'opened', headSha: 'h1', runAt: at(0), now: at(0), delivery: 'd1', replace: true });
  const jobs = await unfinishedJobs(db);
  const job = (await claimJob(db, jobs.find((j) => j.status === 'pending')!.id, at(0)))!;
  const inputs: ReviewInput[] = [];
  const healthCalls: Array<'auth' | 'no_credit' | null> = [];
  const spendCalls: unknown[] = [];
  const slept: number[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const live = options.live === undefined ? LIVE : options.live;
  let failuresLeft = options.recordFailures ?? 0;
  let lost = options.lostAnswer === true;
  const wrapped: Db = {
    query: (text, params) => db.query(text, params),
    script: (sql) => db.script(sql),
    close: () => db.close(),
    transaction: async (work) => {
      if (failuresLeft > 0) { failuresLeft -= 1; throw new Error('db_down'); }
      const done = await db.transaction(work);
      if (lost) { lost = false; throw new Error('db_down'); }
      return done;
    },
  };
  const deps: ReviewJobDeps = {
    db: wrapped,
    forge: {
      readPullRequest: () => (live instanceof Error ? Promise.reject(live) : Promise.resolve(live)),
      sourceFor: () => Promise.resolve({} as Source),
    },
    clock: () => new Date(at(0)),
    log: (e) => { logged.push(e); },
    sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
    settingsFor: () => options.settings ?? SETTINGS,
    limits: LIMITS,
    dryRun: true,
    engineDeps: () => ({}) as ReviewDeps,
    review: (input) => { inputs.push(input); return Promise.resolve(options.result ?? okResult()); },
    lineUrl: () => 'https://git.example.test/x',
    health: { reviewed: (code) => { healthCalls.push(code); } },
    spend: { noteRun: (usage) => { spendCalls.push(usage); } },
  };
  return { job: job as Job, deps, inputs, healthCalls, spendCalls, slept, logged };
}

/** Real engine dependencies around one changed file and a model that answers the forced call with no findings. */
function engineDepsWithStubs(): ReviewDeps {
  const source: Source = {
    listFiles: () => Promise.resolve([{
      path: 'a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,2 @@\n head\n+const a = 1;',
    }]),
    getFileContent: () => Promise.resolve(null),
    getDefaultBranchFile: () => Promise.resolve(null),
  };
  const model: ModelClient = {
    complete: (): Promise<ModelResponse> => Promise.resolve({
      toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify({ overview: 'a.ts is fine.', findings: [], files: [] }), text: null, model: 'm', provider: null,
      usage: { calls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0.1 },
    }),
  };
  return { source, model, contract: 'You review pull requests.', clock: () => new Date(0), token: () => 'abcdef0123456789', log: () => {} };
}

test('a review is run on the live pull request, recorded with what would be posted, and its job ends as reviewed', async () => {
  const h = await harness();
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual(
    [stored!.job, stored!.trigger, stored!.mode, stored!.dryRun, stored!.headSha, stored!.baseSha, stored!.outcome, stored!.needsHuman, stored!.highestScore],
    [h.job.id, 'automatic', 'full', true, 'h1', 'merge000', 'ok', false, 35]);
  assert.deepEqual(stored!.usage, USAGE);
  assert.match(stored!.body, /Human review/);
  assert.deepEqual((stored!.result as ReviewResult).findings, okResult().findings);
  assert.equal((stored!.comments as unknown[]).length, 1);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'reviewed']);
  assert.deepEqual(h.inputs, [{
    pullRequest: LIVE.info, trigger: 'automatic', repoConfig: { primaryBranches: ['main'], scoreThreshold: 70 }, limits: LIMITS, asOf: new Date(at(0)), earlier: null,
  }]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual(
    [entry.repo, entry.number, entry.head, entry.outcome, entry.dry_run, entry.findings, entry.cost, entry.requeued],
    ['acme/shop', 7, 'h1', 'ok', true, 1, 0.5, false]);
});
test('a job is dropped, with no model call and no run, when the pull request is gone, closed, a draft or by an ignored author', async () => {
  const cases: Array<[LivePullRequest | null, string]> = [
    [null, 'not_found'], [{ ...LIVE, state: 'closed' }, 'closed'], [{ ...LIVE, state: 'merged' }, 'closed'],
    [{ ...LIVE, info: { ...LIVE.info, draft: true } }, 'draft'],
    [{ ...LIVE, info: { ...LIVE.info, author: 'dependabot[bot]' } }, 'ignored_author'],
  ];
  for (const [live, reason] of cases) {
    const h = await harness({ live });
    await runReviewJob(h.job, h.deps);
    const j = await getJob(db, h.job.id);
    assert.deepEqual([j?.status, j?.outcome, h.inputs.length, (await listRuns(db, REF)).length], ['dropped', reason, 0, 0]);
    assert.deepEqual(h.logged.at(-1), { event: 'job', job: h.job.id, repo: 'acme/shop', number: 7, outcome: 'dropped', reason });
  }
});
test('a base branch outside the filter drops the job', async () => {
  const h = await harness({ settings: { ...SETTINGS, baseBranches: ['release'] } });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'base_filtered');
});
test('a pull request the service has no installation for is dropped', async () => {
  const h = await harness({ stored: false });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'no_installation');
});
test('a job whose head has moved is dropped, and the live head gets a job due after the quiet period', async () => {
  const h = await harness({ live: { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } } });
  await runReviewJob(h.job, h.deps);
  const old = await getJob(db, h.job.id);
  assert.deepEqual([old?.status, old?.outcome, h.inputs.length], ['dropped', 'stale_head', 0]);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.headSha, j.reason, j.runAt, j.starts, j.status]), [['h2', 'opened', at(180), 0, 'pending']]);
});
test('a job whose head has moved leaves the job the newer head already has', async () => {
  const h = await harness({ live: { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } } });
  const own = (await enqueueJob(db, { ref: REF, reason: 'synchronize', headSha: 'h2', runAt: at(100), now: at(1), delivery: 'd9', replace: true }))!;
  await runReviewJob(h.job, h.deps);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.id, j.reason, j.runAt]), [[own, 'synchronize', at(100)]]);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'stale_head');
});
test('a head that already has a finished review against the same base is not reviewed again', async () => {
  const first = await harness();
  await runReviewJob(first.job, first.deps);
  const again = await harness();
  await runReviewJob(again.job, again.deps);
  assert.deepEqual([(await getJob(db, again.job.id))?.outcome, again.inputs.length, (await listRuns(db, REF)).length], ['already_reviewed', 0, 1]);
  const retargeted = await harness({ live: OTHER_BASE });
  await runReviewJob(retargeted.job, retargeted.deps);
  assert.deepEqual([(await getJob(db, retargeted.job.id))?.outcome, (await listRuns(db, REF)).length], ['reviewed', 2]);
});
test('a pull request that cannot be read is recorded as a failed run, and the job is tried again in a minute with its start counted', async () => {
  const h = await harness({ live: new Error('github_502') });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual(
    [stored!.outcome, stored!.failureStage, stored!.failureCode, stored!.headSha, stored!.baseSha, stored!.needsHuman, stored!.highestScore, stored!.usage.cost],
    ['failed', 'prepare', 'github_502', 'h1', null, true, 100, 0]);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts, h.inputs.length], ['pending', at(60), 1, 0]);
  assert.equal(h.logged.find((e) => e.event === 'review')!.requeued, true);
});
test('an error that is not a short code is recorded as internal_error and its message is logged nowhere', async () => {
  const h = await harness({ live: new Error('Something private went wrong') });
  await runReviewJob(h.job, h.deps);
  assert.equal((await listRuns(db, REF))[0]!.failureCode, 'internal_error');
  assert.equal(JSON.stringify(h.logged).includes('private'), false);
});
test('a failure of the git service inside the engine is tried again too; any other failure before the model is not', async () => {
  const again = await harness({ result: failed('context', 'github_network', { usage: NO_CALLS }) });
  await runReviewJob(again.job, again.deps);
  let j = await getJob(db, again.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts], ['pending', at(60), 1]);
  await finishJob(db, again.job.id, 'dropped', 'test_over', at(1));
  const final = await harness({ result: failed('context', 'too_many_files', { usage: NO_CALLS }) });
  await runReviewJob(final.job, final.deps);
  j = await getJob(db, final.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'failed']);
});
test('a failed review is recorded with its stage and code and is not run again', async () => {
  const h = await harness({ result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([stored!.outcome, stored!.failureStage, stored!.failureCode, j?.status, j?.outcome, h.healthCalls], ['failed', 'model', 'timeout', 'done', 'failed', []]);
});
test('a refused key records the run and puts the job back for when the pause is over; the start is given back only when the run cost nothing', async () => {
  const free = await harness({ result: failed('model', 'auth', { dependencies: { model: 'error' }, usage: { ...USAGE, cost: 0 } }) });
  await runReviewJob(free.job, free.deps);
  let j = await getJob(db, free.job.id);
  assert.deepEqual([free.healthCalls, j?.status, j?.runAt, j?.starts, (await listRuns(db, REF)).at(-1)!.failureCode], [['auth'], 'pending', at(300), 0, 'auth']);
  await finishJob(db, free.job.id, 'dropped', 'test_over', at(1));
  const paid = await harness({ result: failed('model', 'no_credit', { dependencies: { model: 'error' } }) });
  await runReviewJob(paid.job, paid.deps);
  j = await getJob(db, paid.job.id);
  assert.deepEqual([paid.healthCalls, j?.status, j?.runAt, j?.starts], [['no_credit'], 'pending', at(300), 1]);
});
test('a review the model answered tells the health so, and one that made no model call says nothing', async () => {
  const answered = await harness();
  await runReviewJob(answered.job, answered.deps);
  assert.deepEqual(answered.healthCalls, [null]);
  const silent = await harness({ live: OTHER_BASE, result: okResult({ usage: NO_CALLS, findings: [] }) });
  await runReviewJob(silent.job, silent.deps);
  assert.deepEqual([silent.healthCalls, silent.spendCalls.length], [[], 1]);
});
test('a model answer the database would refuse is still recorded', async () => {
  const NUL = String.fromCharCode(0);
  const h = await harness({ result: okResult({ findings: [{ ...okResult().findings[0]!, body: `a${NUL}b` }], overview: `o${NUL}` }) });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await listRuns(db, REF)).length, (await getJob(db, h.job.id))?.status], [1, 'done']);
});
test('recording is tried three times; then the cost is in the log and the job is left running', async () => {
  const twice = await harness({ recordFailures: 2 });
  await runReviewJob(twice.job, twice.deps);
  assert.deepEqual([(await listRuns(db, REF)).length, twice.slept, (await getJob(db, twice.job.id))?.status], [1, [1000, 5000], 'done']);
  const always = await harness({ live: OTHER_BASE, recordFailures: 3 });
  await runReviewJob(always.job, always.deps);
  const entry = always.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.outcome, entry.cost, (await getJob(db, always.job.id))?.status, (await listRuns(db, REF)).length], ['record_failed', 0.5, 'running', 1]);
});
test('a record that was committed but looked failed is not written twice', async () => {
  const h = await harness({ lostAnswer: true });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await listRuns(db, REF)).length, (await getJob(db, h.job.id))?.status, h.slept], [1, 'done', [1000]]);
});
test('nothing the job does can make it reject', async () => {
  const broken = await harness();
  broken.deps.review = () => Promise.reject(new Error('boom'));
  broken.deps.log = () => { throw new Error('log'); };
  await runReviewJob(broken.job, broken.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.failureStage, stored!.failureCode, (await getJob(db, broken.job.id))?.status], ['engine', 'internal_error', 'done']);
});
test('the engine itself runs under the job', async () => {
  const h = await harness();
  h.deps.review = review;
  h.deps.engineDeps = () => engineDepsWithStubs();
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.outcome, (stored!.result as ReviewResult).coverage.reviewed], ['ok', ['a.ts']]);
});
