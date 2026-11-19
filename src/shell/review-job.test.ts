import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { enqueueJob, claimJob, finishJob, getJob, requeueJob, unfinishedJobs } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { listRuns, markPublished } from '../db/review-runs.ts';
import { listComments } from '../db/review-comments.ts';
import type { RepoSettings } from '../config/load.ts';
import type { ForgeWriter, LivePullRequest, PostedComment, Source } from '../forge/types.ts';
import { review } from '../engine/review.ts';
import { renderReview } from '../engine/render/body.ts';
import type { BlockScore } from '../engine/score/types.ts';
import { SUBMIT_REVIEW } from '../engine/model/submit-review.ts';
import type { ModelClient, ModelResponse, ReviewDeps, ReviewInput, ReviewResult } from '../engine/types.ts';
import { runReviewJob } from './review-job.ts';
import type { ReviewJobDeps } from './review-job.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const AUTOMATIC = { trigger: 'automatic' as const, requestedBy: null, commentId: null, association: null, installation: null };

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
/** A finished review with one block at or above the threshold: its body links that block's lines. */
const flaggedResult = (): ReviewResult => okResult({
  scores: [{
    path: 'a.ts', previousPath: null, diffHash: 'd', changeSummary: '', changedLines: 1, wholeFile: null, fileLevel: null, finalScore: 80, covered: true,
    blocks: [{
      id: 'B1', hunk: 'B1', hunkHash: 'h', hash: 'h', changedLines: 1, span: { side: 'RIGHT', first: 3, last: 3 },
      lines: { old: [], new: [] } as unknown as BlockScore['lines'], entry: { score: 80, category: 'calculation', reason: '' },
    }],
  }],
  verdict: { threshold: 70, needsHuman: true, highest: 80 },
});
/** What the git service answers for the inline comments of okResult's review. */
const POSTED: PostedComment[] = [{
  id: '9001', path: 'a.ts', side: 'RIGHT', line: 3,
  body: renderReview(okResult(), { trigger: 'automatic', requestedBy: null, lineUrl: () => 'https://git.example.test/x', inline: true }).comments[0]!.body,
}];

interface Options {
  live?: LivePullRequest | Error | null; result?: ReviewResult; settings?: RepoSettings; stored?: boolean;
  recordFailures?: number; lostAnswer?: boolean; failQuery?: string;
  /** The job is on its second start: claimed, put back and claimed again. */
  secondStart?: boolean;
  /** The time the clock reads once the review has been called; at(0) before. */
  afterReview?: string;
  dryRun?: boolean;
  /** What listOwnReviews answers, one answer for each call, the last one repeated; an Error rejects. [] when none is given. */
  own?: Array<Array<{ id: string; commit: string }> | Error>;
  /** What each publishReview answers, in turn; { id: '501' } once they are used up. */
  posts?: Array<{ id: string } | Error>;
  /** What listReviewComments answers. */
  posted?: PostedComment[] | Error | null;
  /** What readPullRequest answers from its second call on. */
  liveAfter?: LivePullRequest;
  /** The job's head and the live head. */
  head?: string;
  /** Another pull request number, with its own stored facts. */
  pullRequest?: number;
  /** Claims that job again; nothing is enqueued. */
  reuseJob?: number;
  /** The first n transactions that hold markPublished's statement reject. */
  markFailures?: number;
  /** lineUrl throws, and the review's body needs a link. */
  renderThrows?: boolean;
}

async function harness(options: Options = {}) {
  const ref = options.pullRequest === undefined ? REF : { ...REF, number: options.pullRequest };
  const head = options.head ?? 'h1';
  if (options.stored !== false) {
    await savePullRequest(db, {
      ref, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: head, draft: false, state: 'open',
      mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0),
    });
  }
  let job: Job;
  if (options.reuseJob !== undefined) {
    const again = (await getJob(db, options.reuseJob))!;
    job = (await claimJob(db, again.id, again.runAt))!;
  } else {
    await enqueueJob(db, { ref, reason: 'opened', headSha: head, runAt: at(0), now: at(0), delivery: 'd1', replace: true, ...AUTOMATIC });
    const jobs = await unfinishedJobs(db);
    job = (await claimJob(db, jobs.find((j) => j.status === 'pending' && j.ref.number === ref.number)!.id, at(0)))!;
  }
  if (options.secondStart === true) {
    await requeueJob(db, job.id, at(0), at(0), false);
    job = (await claimJob(db, job.id, at(0)))!;
  }
  const inputs: ReviewInput[] = [];
  const healthCalls: Array<'auth' | 'no_credit' | null> = [];
  const healthTimes: string[] = [];
  let reviewCalled = false;
  const spendCalls: unknown[] = [];
  const slept: number[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const live = options.live === undefined ? (head === 'h1' ? LIVE : { ...LIVE, info: { ...LIVE.info, headSha: head } }) : options.live;
  let reads = 0;
  const writes: unknown[][] = [];
  const posts = [...(options.posts ?? [])];
  const owns = [...(options.own ?? [])];
  const writer: ForgeWriter = {
    publishReview: async (_ref, _installation, draft) => {
      writes.push(['publishReview', draft.commit, draft.body, draft.comments.length]);
      const next = posts.shift() ?? { id: '501' };
      if (next instanceof Error) throw next;
      return next;
    },
    listOwnReviews: async () => {
      writes.push(['listOwnReviews']);
      const own = (owns.length > 1 ? owns.shift() : owns[0]) ?? [];
      if (own instanceof Error) throw own;
      return own;
    },
    listReviewComments: async (_ref, _installation, reviewId) => {
      writes.push(['listReviewComments', reviewId]);
      const posted = options.posted === undefined ? POSTED : options.posted;
      if (posted instanceof Error) throw posted;
      return posted;
    },
    react: async () => { writes.push(['react']); },
    comment: async () => { writes.push(['comment']); },
  };
  let markFailuresLeft = options.markFailures ?? 0;
  let failuresLeft = options.recordFailures ?? 0;
  let lost = options.lostAnswer === true;
  let queryFails = options.failQuery !== undefined;
  const wrapped: Db = {
    query: (text, params) => {
      if (queryFails && text.includes(options.failQuery!)) { queryFails = false; return Promise.reject(new Error('Something private broke')); }
      return db.query(text, params);
    },
    script: (sql) => db.script(sql),
    close: () => db.close(),
    transaction: async (work) => {
      if (failuresLeft > 0) { failuresLeft -= 1; throw new Error('db_down'); }
      const done = await db.transaction((tx) => work({
        query: (text, params) => {
          if (markFailuresLeft > 0 && text.includes('set published = true')) { markFailuresLeft -= 1; return Promise.reject(new Error('db_down')); }
          return tx.query(text, params);
        },
        script: (sql) => tx.script(sql),
        close: () => tx.close(),
        transaction: (inner) => tx.transaction(inner),
      }));
      if (lost) { lost = false; throw new Error('db_down'); }
      return done;
    },
  };
  const deps: ReviewJobDeps = {
    db: wrapped,
    forge: {
      readPullRequest: () => {
        reads += 1;
        const answer = reads > 1 && options.liveAfter !== undefined ? options.liveAfter : live;
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
      sourceFor: () => Promise.resolve({} as Source),
    },
    clock: () => new Date(reviewCalled && options.afterReview !== undefined ? options.afterReview : at(0)),
    log: (e) => { logged.push(e); },
    sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
    settingsFor: () => options.settings ?? SETTINGS,
    limits: LIMITS,
    dryRun: options.dryRun ?? true,
    writer,
    engineDeps: () => ({}) as ReviewDeps,
    review: (input) => {
      inputs.push(input);
      reviewCalled = true;
      return Promise.resolve(options.result ?? (options.renderThrows === true ? flaggedResult() : okResult()));
    },
    lineUrl: () => { if (options.renderThrows === true) throw new Error('no_link'); return 'https://git.example.test/x'; },
    health: { reviewed: (code, when) => { healthCalls.push(code); healthTimes.push(when.toISOString()); } },
    spend: { noteRun: (usage) => { spendCalls.push(usage); } },
  };
  return { job, deps, inputs, healthCalls, healthTimes, spendCalls, slept, logged, writes };
}
const live = (options: Options = {}) => harness({ dryRun: false, ...options });

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
  const own = (await enqueueJob(db, { ref: REF, reason: 'synchronize', headSha: 'h2', runAt: at(100), now: at(1), delivery: 'd9', replace: true, ...AUTOMATIC }))!;
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
test('a job that cannot be read on its second start is tried again 15 minutes later', async () => {
  const h = await harness({ live: new Error('github_502'), secondStart: true });
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts], ['pending', at(900), 2]);
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
test('a refused key records the run and puts the job back for when the pause is over; the start is given back only when no model call was made', async () => {
  const free = await harness({ result: failed('model', 'auth', { dependencies: { model: 'error' }, usage: NO_CALLS }) });
  await runReviewJob(free.job, free.deps);
  let j = await getJob(db, free.job.id);
  assert.deepEqual([free.healthCalls, j?.status, j?.runAt, j?.starts, (await listRuns(db, REF)).at(-1)!.failureCode], [['auth'], 'pending', at(300), 0, 'auth']);
  await finishJob(db, free.job.id, 'dropped', 'test_over', at(1));
  const unpriced = await harness({ result: failed('model', 'auth', { dependencies: { model: 'error' }, usage: { ...USAGE, cost: 0 } }) });
  await runReviewJob(unpriced.job, unpriced.deps);
  j = await getJob(db, unpriced.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts], ['pending', at(300), 1]);
  await finishJob(db, unpriced.job.id, 'dropped', 'test_over', at(1));
  const paid = await harness({ result: failed('model', 'no_credit', { dependencies: { model: 'error' } }) });
  await runReviewJob(paid.job, paid.deps);
  j = await getJob(db, paid.job.id);
  assert.deepEqual([paid.healthCalls, j?.status, j?.runAt, j?.starts], [['no_credit'], 'pending', at(300), 1]);
});
test('a refusal is dated when it is seen, and the pause is counted from then', async () => {
  const h = await harness({ result: failed('model', 'auth', { dependencies: { model: 'error' } }), afterReview: at(400) });
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([h.healthTimes, j?.status, j?.runAt], [[at(400)], 'pending', at(700)]);
});
test('a failure after the review returned never puts the job back: it is left running and the cost is in the log', async () => {
  const broken = { ...okResult() } as Partial<ReviewResult>;
  delete broken.verdict;
  const h = await harness({ result: broken as ReviewResult });
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.starts, (await listRuns(db, REF)).length], ['running', 1, 0]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.outcome, entry.cost, entry.requeued], ['record_failed', 0.5, false]);
  assert.equal(h.logged.some((e) => e.event === 'job'), false);
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
test('a read that fails before the review puts the job back in a minute with its start counted, and writes no run', async () => {
  for (const failQuery of ['visto_ai.pull_requests', 'visto_ai.review_runs']) {
    const h = await harness({ failQuery });
    await runReviewJob(h.job, h.deps);
    const j = await getJob(db, h.job.id);
    assert.deepEqual([j?.status, j?.runAt, j?.starts, h.inputs.length, (await listRuns(db, REF)).length], ['pending', at(60), 1, 0, 0]);
    assert.equal(JSON.stringify(h.logged).includes('private'), false);
    assert.equal(h.logged.at(-1)!.requeued, true);
    await finishJob(db, h.job.id, 'dropped', 'test_over', at(1));
  }
});
test('a finished review is recorded, posted, marked published, and its comments stored', async () => {
  const h = await live();
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.dryRun, stored!.outcome, stored!.published, stored!.reviewId, stored!.inlineDropped], [false, 'ok', true, '501', false]);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'published']);
  assert.deepEqual(await listComments(db, REF), [{ commentId: '9001', path: 'a.ts', side: 'RIGHT', line: 3, severity: 'minor', quote: 'x', run: stored!.id }]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.published, entry.review, entry.publish, entry.publish_code, entry.resumed, entry.adopted], [true, '501', 'published', null, false, false]);
  assert.deepEqual(h.logged.find((e) => e.event === 'readback'), { event: 'readback', job: h.job.id, run: stored!.id, posted: 1, stored: 1 });
});
test('in dry run nothing is ever written to the git service', async () => {
  const h = await harness();
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.writes, (await listRuns(db, REF))[0]!.published, (await getJob(db, h.job.id))?.outcome], [[], false, 'reviewed']);
});
test('a pull request that already has its review is not reviewed again: the same head, or a later one', async () => {
  const first = await live();
  await runReviewJob(first.job, first.deps);
  const same = await live();
  await runReviewJob(same.job, same.deps);
  const later = await live({ head: 'h2' });
  await runReviewJob(later.job, later.deps);
  assert.deepEqual(
    [(await getJob(db, same.job.id))?.outcome, (await getJob(db, later.job.id))?.outcome, same.inputs.length + later.inputs.length, (await listRuns(db, REF)).length],
    ['already_reviewed', 'later_head', 0, 1]);
});
test('when the post cannot be made the review stays stored and the job is put back with its start counted', async () => {
  const h = await live({ posts: [new Error('github_502')] });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([stored!.outcome, stored!.published, j?.status, j?.runAt, j?.starts], ['ok', false, 'pending', at(60), 1]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.publish, entry.publish_code, entry.requeued], ['failed', 'github_502', true]);
});
test('the next start publishes the stored review without calling the model, and tells no guard', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const again = await live({ reuseJob: before.job.id });
  await runReviewJob(again.job, again.deps);
  const runs = await listRuns(db, REF);
  assert.deepEqual([runs.length, runs[0]!.published, runs[0]!.reviewId, again.inputs.length, (await getJob(db, again.job.id))?.outcome], [1, true, '501', 0, 'published']);
  const entry = again.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.resumed, entry.calls, entry.cost, entry.findings, again.healthCalls, again.spendCalls.length], [true, 0, 0, 1, [], 0]);
});
test('a review that was posted but not recorded as such is adopted, not posted again', async () => {
  const lost = await live({ markFailures: 3 });
  await runReviewJob(lost.job, lost.deps);
  assert.deepEqual([(await listRuns(db, REF))[0]!.published, (await getJob(db, lost.job.id))?.status, lost.logged.find((e) => e.event === 'review')!.outcome], [false, 'running', 'record_failed']);
  await requeueJob(db, lost.job.id, at(0), at(0), false);        // what start-up recovery does
  const again = await live({ reuseJob: lost.job.id, own: [[{ id: '501', commit: 'h1' }]] });
  await runReviewJob(again.job, again.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.published, stored!.reviewId, again.inputs.length, again.writes.filter((w) => w[0] === 'publishReview').length], [true, '501', 0, 0]);
});
test('a review posted on an earlier head that the database never learned of stops a second first review', async () => {
  const h = await live({ head: 'h2', own: [[{ id: '470', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome, h.inputs.length, (await listRuns(db, REF)).length, h.writes.filter((w) => w[0] === 'publishReview').length],
    ['dropped', 'later_head', 0, 0, 0]);
});
test('a review of its own on the live head that the database never learned of drops the job before anything is paid', async () => {
  const h = await live({ own: [[{ id: '480', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome, h.inputs.length, (await listRuns(db, REF)).length], ['dropped', 'already_reviewed', 0, 0]);
});
test('when the git service cannot say which reviews the app has, no model call is made and the job is tried again with its start counted', async () => {
  const h = await live({ own: [new Error('github_502')] });
  await runReviewJob(h.job, h.deps);
  const runs = await listRuns(db, REF);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([h.inputs.length, runs.length, runs[0]!.outcome, runs[0]!.failureStage, runs[0]!.failureCode], [0, 1, 'failed', 'prepare', 'github_502']);
  assert.deepEqual([j?.status, j?.runAt, j?.starts], ['pending', at(60), 1]);
});
test('a review of its own that appears on another commit while the review runs stops the post', async () => {
  const h = await live({ own: [[], [{ id: '470', commit: 'h0' }]] });
  await runReviewJob(h.job, h.deps);
  const runs = await listRuns(db, REF);
  assert.deepEqual([h.inputs.length, runs.length, runs[0]!.outcome, runs[0]!.published, h.writes.filter((w) => w[0] === 'publishReview').length],
    [1, 1, 'ok', false, 0]);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'already_reviewed']);
});
test('a resumed start asks for the own reviews once, inside the publication, and dry run never asks', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  assert.deepEqual(before.writes.slice(0, 2), [['listOwnReviews'], ['listOwnReviews']]);
  const again = await live({ reuseJob: before.job.id });
  await runReviewJob(again.job, again.deps);
  assert.equal(again.writes.filter((w) => w[0] === 'listOwnReviews').length, 1);
  const dry = await harness({ pullRequest: 8 });
  await runReviewJob(dry.job, dry.deps);
  assert.deepEqual(dry.writes, []);
});
test('a publication for a run that is already marked still finishes the job', async () => {
  const h = await live();
  const post = h.deps.writer.publishReview;
  h.deps.writer = {
    ...h.deps.writer,
    publishReview: async (ref, installation, draft) => {
      const [run] = await listRuns(db, REF);
      await markPublished(db, run!.id, { reviewId: '400', publishedAt: at(0), body: 'earlier', inlineDropped: false });
      return post(ref, installation, draft);
    },
  };
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome, (await listRuns(db, REF))[0]!.reviewId], ['done', 'published', '400']);
});
test('a failed publication whose place a newer job took leaves the newer job as it is', async () => {
  const h = await live({ posts: [new Error('github_502')] });
  const post = h.deps.writer.publishReview;
  let newer: number | null = null;
  h.deps.writer = {
    ...h.deps.writer,
    publishReview: async (ref, installation, draft) => {
      newer = await enqueueJob(db, { ref: REF, reason: 'synchronize', headSha: 'h1', runAt: at(100), now: at(1), delivery: 'd9', replace: true, ...AUTOMATIC });
      return post(ref, installation, draft);
    },
  };
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'superseded');
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.id, j.reason, j.runAt, j.status]), [[newer, 'synchronize', at(100), 'pending']]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.publish, entry.requeued], ['failed', false]);
});
test('a head or a base that moved while the review ran gets nothing posted and a job of its own', async () => {
  const h = await live({ liveAfter: { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } } });
  await runReviewJob(h.job, h.deps);
  const old = await getJob(db, h.job.id);
  assert.deepEqual([old?.status, old?.outcome, h.writes.filter((w) => w[0] === 'publishReview').length], ['done', 'head_moved', 0]);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.headSha, j.trigger, j.runAt]), [['h2', 'automatic', at(180)]]);
  const based = await live({ pullRequest: 8, liveAfter: OTHER_BASE });
  await runReviewJob(based.job, based.deps);
  assert.equal((await getJob(db, based.job.id))?.outcome, 'head_moved');
});
test('a pull request closed while the review ran, and a review the git service refuses, end the job', async () => {
  const closed = await live({ liveAfter: { ...LIVE, state: 'closed' } });
  await runReviewJob(closed.job, closed.deps);
  assert.equal((await getJob(db, closed.job.id))?.outcome, 'closed');
  const refused = await live({ pullRequest: 8, posts: [new Error('review_rejected'), new Error('review_rejected')] });
  await runReviewJob(refused.job, refused.deps);
  assert.deepEqual([(await getJob(db, refused.job.id))?.outcome, (await listRuns(db, { ...REF, number: 8 }))[0]!.published], ['publish_rejected', false]);
});
test('refused inline comments are recorded as dropped, with the text that was posted', async () => {
  const h = await live({ posts: [new Error('review_rejected'), { id: '502' }], posted: [] });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.published, stored!.reviewId, stored!.inlineDropped, (await listComments(db, REF)).length], [true, '502', true, 0]);
  assert.equal(stored!.body, h.writes.filter((w) => w[0] === 'publishReview').at(-1)![2]);
});
test('a read-back that is cut short or fails is logged and the publication stands', async () => {
  for (const [posted, number] of [[null, 8], [new Error('github_502'), 9]] as const) {
    const h = await live({ posted, pullRequest: number });
    await runReviewJob(h.job, h.deps);
    assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
    assert.equal(h.logged.some((e) => e.event === 'readback_failed'), true);
  }
});
test('a review that failed, or whose text could not be rendered, is recorded and never posted', async () => {
  const failedRun = await live({ result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(failedRun.job, failedRun.deps);
  assert.deepEqual([(await getJob(db, failedRun.job.id))?.outcome, failedRun.writes, (await listRuns(db, REF))[0]!.published], ['failed', [['listOwnReviews']], false]);
  const unrendered = await live({ pullRequest: 8, renderThrows: true });
  await runReviewJob(unrendered.job, unrendered.deps);
  assert.deepEqual([(await getJob(db, unrendered.job.id))?.outcome, unrendered.writes], ['render_failed', [['listOwnReviews']]]);
  const next = await live({ pullRequest: 8 });
  await runReviewJob(next.job, next.deps);
  assert.deepEqual([next.inputs.length, (await getJob(db, next.job.id))?.outcome], [1, 'published']);
});
