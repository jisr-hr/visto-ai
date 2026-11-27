import test from 'node:test';
import assert from 'node:assert/strict';
import { markDismissed, markDismissFailed, markStoodAtMerge } from '../db/approvals.ts';
import { recordFeedback } from '../db/feedback.ts';
import { recordEvaluation } from '../db/gate.ts';
import type { Evaluation } from '../db/gate.ts';
import { recordActivity } from '../db/human-activity.ts';
import type { Activity } from '../db/human-activity.ts';
import { askWithdraw, claimJob, enqueueJob, requeueJob } from '../db/jobs.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { recordComments } from '../db/review-comments.ts';
import { markPublished, recordRun } from '../db/review-runs.ts';
import type { RunRecord } from '../db/review-runs.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import type { PullRequestFacts, PullRequestRef } from '../forge/types.ts';
import type { ApiDeps } from './api.ts';
import type {
  ApprovalEntry, FeedbackReason, GateShown, OneReview, PullReview, PullReviews, ReviewDependency, ReviewFile, ReviewFinding,
} from './api-types.ts';
import { APPROVALS_SHOWN, FEEDBACK_LOGIN, REASONS_SHOWN, pullReviews, review } from './review.ts';
import { FINDINGS_SHOWN } from './review-result.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const REF: PullRequestRef = { service: 'github', owner: 'acme', repo: 'shop', number: 128 };
const urlOf = (ref: PullRequestRef): string => `https://github.example.test/${ref.owner}/${ref.repo}/pull/${ref.number}`;
const HEAD_A = '3f9c2e1a7b04' + 'a'.repeat(28);
const HEAD_B = '9a1e5c07b3d2' + 'b'.repeat(28);

function deps(db: Db, more: Partial<ApiDeps> = {}): ApiDeps {
  return {
    db, clock: () => new Date(at(0)), dryRun: false, reviewPlaces: 2, withdrawPlaces: 2,
    holds: () => true, paused: async () => null, pullRequestUrl: urlOf, ...more,
  };
}
function recording(inner: Db): { db: Db; sent: string[] } {
  const sent: string[] = [];
  const db: Db = {
    query: (text, params) => { sent.push(text); return inner.query(text, params); },
    script: (sql) => inner.script(sql), close: () => inner.close(), transaction: (work) => inner.transaction(work),
  };
  return { db, sent };
}

const facts = (ref: PullRequestRef = REF): PullRequestFacts => ({
  ref, title: 'Round prices before tax', author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'fix/round-prices', headSha: HEAD_A,
  draft: false, state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0),
});
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: HEAD_A, baseSha: 'b1', baseBranch: 'main',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [], result: { findings: [] },
  usage: { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.5 },
  startedAt: at(0), finishedAt: at(90), ...over,
});
type More = { approved?: boolean; approvalCode?: string | null; body?: string };
const publish = (db: Db, id: number, more: More = {}): Promise<boolean> =>
  markPublished(db, id, { reviewId: `r-${id}`, publishedAt: at(100 + id), body: more.body ?? 'text', inlineDropped: false, ...more });
const activity = (kind: Activity['kind'], sourceId: string, replyTo: string | null, seconds: number, author = 'octo-lead'): Activity => ({
  ref: REF, kind, sourceId, author, association: null, state: null, body: 'REPLY-TEXT', path: null, side: null, line: null, startLine: null, fileLevel: null,
  commit: null, replyTo, thread: null, at: at(seconds), delivery: null,
});
const evaluation = (headSha: string, seconds: number, state: Evaluation['state'], blocking: number, refusedInline: number): Evaluation => ({
  ref: REF, headSha, at: at(seconds), mode: 'enforce', state, code: null, run: null,
  counts: { blocking, clearedByReview: 0, clearedByReply: 0, silentResolves: 0, unknownThreads: 0, findings: 0, notReviewed: 0, withoutThread: 0, refusedInline },
});
const finding = (more: Record<string, unknown> = {}) => ({
  severity: 'major', path: 'src/cart/price.ts', side: 'RIGHT', line: 42, quote: 'round(line)', body: 'Rounding each line before tax can move an order total by a cent per line.', ...more,
});
const LEAD = '**Not approved automatically:** ';
const PARAGRAPH = 'a part of this change is at or above 70%, so a person should review it.';
async function job(db: Db, reason: string, requestedBy: string | null): Promise<number> {
  return (await enqueueJob(db, {
    ref: REF, reason, headSha: HEAD_A, runAt: at(0), now: at(0), delivery: null, replace: false,
    trigger: 'manual', requestedBy, commentId: null, association: null, installation: null,
  }))!;
}
const ok = async <T>(value: Promise<T | null>): Promise<T> => { const got = await value; assert.notEqual(got, null); return got as T; };

test('a published review reads with every part the page shows', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const earlier = await recordRun(db, run({ headSha: HEAD_B, startedAt: at(-900), finishedAt: at(-800) }));
  await publish(db, earlier, { approved: true, approvalCode: 'approved' });
  await markDismissFailed(db, earlier, 'github_403');
  const withdraw = (await askWithdraw(db, REF, at(-5)))!;
  await claimJob(db, withdraw, at(-4));
  await requeueJob(db, withdraw, at(52), at(-3), false, 'github_403');
  const asked = await job(db, 'command', 'octo-dev');
  const price = { path: 'src/cart/price.ts', finalScore: 74, fileLevel: null, blocks: [{
    entry: { score: 74, category: 'calculation', reason: 'Changes the amount every order total is built from.' }, span: { side: 'RIGHT', first: 38, last: 51 },
  }, { entry: { score: 10, category: 'style', reason: 'Low.' }, span: { side: 'RIGHT', first: 1, last: 2 } }] };
  const lock = { path: 'package-lock.json', finalScore: 100, fileLevel: { score: 100, source: 'not_scored' }, blocks: [] };
  const result = {
    scores: [price, lock], coverage: { reviewed: ['src/cart/price.ts', 'src/cart/tax.ts'], notReviewed: [{ path: 'package-lock.json', reason: 'too_large' }] },
    verdict: { threshold: 70 }, findings: [finding()], unplaced: [finding({ severity: 'minor', path: 'src/cart/tax.ts', body: 'A minor.' })],
    threadVerdicts: [{ commentId: 'c-0', verdict: 'fixed' }, { commentId: 'c-00', verdict: 'open' }], threadsDue: 3, alreadyDiscussed: ['x'],
    dependencies: { model: 'ok', memory: { status: 'ok', lines: 2 }, mcp: { docs: { status: 'error', code: 'mcp_timeout', calls: 0 } } },
    models: ['vendor/model-a'],
  };
  const id = await recordRun(db, run({
    job: asked, trigger: 'manual', mode: 'incremental', result, startedAt: at(-760), finishedAt: at(-720),
    usage: { calls: 3, inputTokens: 38412, outputTokens: 2118, cachedTokens: 21900, cost: 0.084 },
  }));
  await publish(db, id, { approvalCode: 'needs_human', body: `Review.\n\n${LEAD}${PARAGRAPH}` });
  await recordComments(db, id, REF, [{ commentId: 'c-1', path: 'src/cart/price.ts', side: 'RIGHT', line: 42, severity: 'major', quote: 'round(line)' }]);
  await recordActivity(db, activity('thread_resolved', 'd-1', 'c-1', 30));
  await recordEvaluation(db, evaluation(HEAD_A, 20, 'blocked', 1, 0));
  await recordFeedback(db, { run: id, login: 'octo-dev', vote: 'up', reason: null, extension: 'example', at: at(10) });
  await recordFeedback(db, { run: id, login: 'octo-lead', vote: 'up', reason: null, extension: 'example', at: at(11) });
  await recordFeedback(db, { run: id, login: 'octo-guest', vote: 'down', reason: 'The minor on tax.ts repeats what we settled.', extension: 'example', at: at(12) });
  const { db: spied, sent } = recording(db);
  const answer = await ok(review(deps(spied), id));
  assert.ok(sent.length <= 9, `${sent.length} statements`);
  const placed: ReviewFinding = { kind: 'placed', severity: 'major', path: 'src/cart/price.ts', side: 'RIGHT', line: 42, body: finding().body, thread: { state: 'resolved', by: 'octo-lead' } };
  const files: ReviewFile[] = [
    { path: 'src/cart/price.ts', score: 74, notReviewed: null, source: null, reason: 'Changes the amount every order total is built from.',
      category: null, blocks: 2, highest: { side: 'RIGHT', first: 38, last: 51 }, kept: null, raisedFrom: null },
    { path: 'package-lock.json', score: 100, notReviewed: 'too_large', source: 'not_scored', reason: '', category: null, blocks: 0, highest: null, kept: null, raisedFrom: null },
  ];
  assert.deepEqual(answer, {
    now: at(0), run: id, ordinal: 2, runs: 2,
    pullRequest: { repository: 'acme/shop', number: 128, title: 'Round prices before tax', author: 'octo-dev', headBranch: 'fix/round-prices', baseBranch: 'main', url: urlOf(REF) },
    head: HEAD_A.slice(0, 12), askedBy: { reason: 'command', login: 'octo-dev' },
    mode: 'incremental', posting: 'published', failure: null, startedAt: at(-760), finishedAt: at(-720), publishedAt: at(100 + id),
    approval: { decision: 'not_approved', code: 'needs_human', text: PARAGRAPH },
    gate: { mode: 'enforce', state: 'blocked', code: null, blocking: 1 }, threshold: 70,
    files, filesCut: 0, read: { files: 2, reviewed: 2 },
    findings: [placed, { kind: 'unplaced', severity: 'minor', path: 'src/cart/tax.ts', side: 'RIGHT', line: 42, body: 'A minor.', thread: { state: 'none', by: null } }],
    findingsCut: 0, counts: { blocker: 0, major: 1, minor: 1 }, earlier: { cleared: 1, open: 1, unjudged: 1, discussed: 1 },
    usage: { models: ['vendor/model-a'], calls: 3, inputTokens: 38412, cachedTokens: 21900, outputTokens: 2118, cost: 0.084 },
    approvals: [{ run: earlier, ordinal: 1, head: HEAD_B.slice(0, 12), state: 'withdrawal_failed', code: 'github_403', retryAt: at(52), stoodAtMerge: false }],
    dependencies: [
      { kind: 'model', name: null, status: 'ok', code: null, count: null }, { kind: 'memory', name: null, status: 'ok', code: null, count: 2 },
      { kind: 'mcp', name: 'docs', status: 'error', code: 'mcp_timeout', count: 0 },
    ],
    feedback: { helpful: 2, notHelpful: 1, reasons: [{ reason: 'The minor on tax.ts repeats what we settled.', login: 'octo-guest' }] },
  } satisfies OneReview);
  await db.close();
});

test('a dry run is not decided, posts nothing, and its findings are not posted', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const id = await recordRun(db, run({ dryRun: true, result: { findings: [finding()] } }));
  const { db: spied, sent } = recording(db);
  const answer = await ok(review(deps(spied), id));
  assert.deepEqual(answer.approval, { decision: 'dry_run', code: null, text: null });
  assert.equal(answer.posting, 'dry_run');
  assert.equal(answer.publishedAt, null);
  assert.deepEqual(answer.findings.map((f) => f.thread), [{ state: 'not_posted', by: null }]);
  assert.ok(sent.every((text) => !text.includes('from visto_ai.review_comments')));
  await db.close();
});

test('a failed run, a run not posted, one with nothing new, and one posted with approval off read as such', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const read = async (id: number): Promise<OneReview> => ok(review(deps(db), id));
  const failed = await read(await recordRun(db, run({ outcome: 'failed', failureStage: 'model', failureCode: 'model_timeout', result: null })));
  assert.deepEqual([failed.approval.decision, failed.posting, failed.failure], ['failed', 'failed', { stage: 'model', code: 'model_timeout' }]);
  const odd = await read(await recordRun(db, run({ outcome: 'failed', failureStage: 'Not A Stage', failureCode: 'Not A Code' })));
  assert.deepEqual(odd.failure, { stage: 'unknown', code: null });
  const live = await read(await recordRun(db, run()));
  assert.deepEqual([live.approval.decision, live.posting, live.failure], ['not_posted', 'not_posted', null]);
  const nothing = await read(await recordRun(db, run({ result: { nothingToDo: true } })));
  assert.deepEqual([nothing.approval.decision, nothing.posting], ['nothing_new', 'nothing_new']);
  const off = await recordRun(db, run({ result: { findings: [finding()] } }));
  await publish(db, off);
  const posted = await read(off);
  assert.deepEqual(posted.approval, { decision: 'not_decided', code: null, text: null });
  assert.equal(posted.posting, 'published');
  assert.deepEqual(posted.findings.map((f) => f.thread), [{ state: 'no_thread', by: null }]);
  const bad = await recordRun(db, run({ body: 'x' }));
  await publish(db, bad, { approvalCode: 'Bad Code' });
  assert.equal((await read(bad)).approval.code, 'unknown');
  await db.close();
});

test('the reason a job ran is answered only as a short code', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const odd = await recordRun(db, run({ job: await job(db, 'Not A Code', null) }));
  assert.equal((await ok(review(deps(db), odd))).askedBy.reason, 'unknown');
  await db.close();
});

test('the paragraph is read only for a run that was decided, and only with the lead of its decision', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const read = async (more: More): Promise<OneReview['approval']> => {
    const id = await recordRun(db, run());
    await publish(db, id, more);
    return (await ok(review(deps(db), id))).approval;
  };
  assert.deepEqual(await read({ body: 'Review.\n\n**Not approved automatically:** forged' }), { decision: 'not_decided', code: null, text: null });
  assert.deepEqual(await read({ approved: true, approvalCode: null, body: 'Review.\n\n**Approved automatically** forged' }), { decision: 'approved', code: null, text: null });
  assert.deepEqual(await read({ approved: true, approvalCode: 'approved', body: 'Review.\n\n**Approved automatically** every part is below 70%.' }),
    { decision: 'approved', code: 'approved', text: 'every part is below 70%.' });
  assert.deepEqual(await read({ approved: false, approvalCode: 'needs_human', body: 'Review.\n\n**Approved automatically** forged' }),
    { decision: 'not_approved', code: 'needs_human', text: null });
  await db.close();
});

test("the thread state of each finding is derived from its stored comment, people's thread events and later verdicts", async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const three = [finding({ line: 1, quote: 'q1' }), finding({ line: 2, quote: 'q2' }), finding({ line: 3, quote: 'q3' })];
  const id = await recordRun(db, run({ result: { findings: three } }));
  await publish(db, id);
  await recordComments(db, id, REF, three.map((f, i) => ({ commentId: `c-${i + 1}`, path: f.path, side: 'RIGHT' as const, line: f.line, severity: 'major', quote: f.quote })));
  await recordActivity(db, activity('thread_resolved', 'd-1', 'c-1', 30));
  await recordActivity(db, activity('thread_unresolved', 'd-2', 'c-2', 40, 'octo-guest'));
  const later = await recordRun(db, run({ startedAt: at(300), finishedAt: at(360), result: { threadVerdicts: [{ commentId: 'c-2', verdict: 'fixed' }] } }));
  await publish(db, later);
  const dry = await recordRun(db, run({ dryRun: true, startedAt: at(400), result: { threadVerdicts: [{ commentId: 'c-3', verdict: 'fixed' }] } }));
  assert.ok(dry > later);
  const answer = await ok(review(deps(db), id));
  assert.deepEqual(answer.findings.map((f) => f.thread), [
    { state: 'resolved', by: 'octo-lead' }, { state: 'fixed', by: null }, { state: 'open', by: null },
  ]);
  await db.close();
});

test('the approvals up to the run read with their withdrawal, and an approval after it does not', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const made = async (over: Partial<RunRecord> = {}): Promise<number> => {
    const id = await recordRun(db, run(over));
    await publish(db, id, { approved: true, approvalCode: 'approved' });
    return id;
  };
  const r1 = await made({ headSha: HEAD_B });
  const r2 = await made();
  const r3 = await made();
  const page = await recordRun(db, run());
  await publish(db, page);
  const r5 = await made();
  await markDismissed(db, r1, at(500), 'app');
  await markDismissed(db, r2, at(501), 'git_service');
  await markStoodAtMerge(db, r3, at(502));
  const { db: spied, sent } = recording(db);
  const answer = await ok(review(deps(spied), page));
  assert.deepEqual(answer.approvals, [
    { run: r3, ordinal: 3, head: HEAD_A.slice(0, 12), state: 'stands', code: null, retryAt: null, stoodAtMerge: true },
    { run: r2, ordinal: 2, head: HEAD_A.slice(0, 12), state: 'dismissed_on_github', code: null, retryAt: null, stoodAtMerge: false },
    { run: r1, ordinal: 1, head: HEAD_B.slice(0, 12), state: 'withdrawn', code: null, retryAt: null, stoodAtMerge: false },
  ] satisfies ApprovalEntry[]);
  assert.ok(!answer.approvals.some((a) => a.run === r5));
  assert.ok(sent.every((text) => !text.includes("kind = 'withdraw'")));
  await db.close();

  const other = await testDb();
  await savePullRequest(other, facts());
  const a = await recordRun(other, run());
  await publish(other, a, { approved: true, approvalCode: 'approved' });
  await markDismissFailed(other, a, 'Not A Code');
  const wait = (await askWithdraw(other, REF, at(-5)))!;
  await claimJob(other, wait, at(-4));
  await requeueJob(other, wait, at(52), at(-3), false, 'github_403');
  const b = await recordRun(other, run());
  const odd = (await ok(review(deps(other), b))).approvals;
  assert.deepEqual(odd.map((x) => [x.state, x.code, x.retryAt]), [['withdrawal_failed', 'unknown', at(52)]]);
  await other.close();
});

test('a run whose result is of another shape still reads', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  for (const result of [null, { scores: 'x', findings: [7] }]) {
    const id = await recordRun(db, run({ result }));
    const answer = await ok(review(deps(db), id));
    assert.deepEqual([answer.files, answer.findings, answer.dependencies, answer.threshold], [[], [], [], null]);
    assert.deepEqual(answer.counts, { blocker: 0, major: 0, minor: 0 });
  }
  await db.close();
});

test('only the bounded findings are answered, with the rest counted, and no quote', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const many = Array.from({ length: FINDINGS_SHOWN + 5 }, (_, i) => finding({ severity: 'minor', line: i + 1, quote: `QUOTE-TEXT-${i}` }));
  const id = await recordRun(db, run({ result: { findings: many } }));
  const answer = await ok(review(deps(db), id));
  assert.equal(answer.findings.length, FINDINGS_SHOWN);
  assert.equal(answer.findingsCut, 5);
  assert.equal(answer.counts.minor, FINDINGS_SHOWN + 5);
  assert.ok(!JSON.stringify(answer).includes('QUOTE-TEXT'));
  assert.ok(answer.findings.every((f) => !('quote' in f)));
  assert.ok(APPROVALS_SHOWN === 20 && REASONS_SHOWN === 20);
  await db.close();
});

// The keys of each answer, held to api-types.ts by the type check.
const KEYS = (shape: object): string[] => Object.keys(shape).sort();
const keysOf = (value: object): string[] => Object.keys(value).sort();
const ONE: Record<keyof OneReview, true> = {
  now: true, run: true, ordinal: true, runs: true, pullRequest: true, head: true, askedBy: true, mode: true, posting: true, failure: true,
  startedAt: true, finishedAt: true, publishedAt: true, approval: true, gate: true, threshold: true, files: true, filesCut: true, read: true,
  findings: true, findingsCut: true, counts: true, earlier: true, usage: true, approvals: true, dependencies: true, feedback: true,
};
const PULL: Record<keyof OneReview['pullRequest'], true> = { repository: true, number: true, title: true, author: true, headBranch: true, baseBranch: true, url: true };
const ASKED: Record<keyof OneReview['askedBy'], true> = { reason: true, login: true };
const FAILURE: Record<keyof NonNullable<OneReview['failure']>, true> = { stage: true, code: true };
const APPROVAL: Record<keyof OneReview['approval'], true> = { decision: true, code: true, text: true };
const GATE: Record<keyof GateShown, true> = { mode: true, state: true, code: true, blocking: true };
const FILE: Record<keyof ReviewFile, true> = {
  path: true, score: true, notReviewed: true, source: true, reason: true, category: true, blocks: true, highest: true, kept: true, raisedFrom: true,
};
const READ: Record<keyof OneReview['read'], true> = { files: true, reviewed: true };
const FINDING: Record<keyof ReviewFinding, true> = { kind: true, severity: true, path: true, side: true, line: true, body: true, thread: true };
const THREAD: Record<keyof ReviewFinding['thread'], true> = { state: true, by: true };
const COUNTS: Record<keyof OneReview['counts'], true> = { blocker: true, major: true, minor: true };
const EARLIER: Record<keyof OneReview['earlier'], true> = { cleared: true, open: true, unjudged: true, discussed: true };
const USAGE: Record<keyof OneReview['usage'], true> = { models: true, calls: true, inputTokens: true, cachedTokens: true, outputTokens: true, cost: true };
const APPROVAL_ENTRY: Record<keyof ApprovalEntry, true> = { run: true, ordinal: true, head: true, state: true, code: true, retryAt: true, stoodAtMerge: true };
const DEPENDENCY: Record<keyof ReviewDependency, true> = { kind: true, name: true, status: true, code: true, count: true };
const FEEDBACK: Record<keyof OneReview['feedback'], true> = { helpful: true, notHelpful: true, reasons: true };
const REASON: Record<keyof FeedbackReason, true> = { reason: true, login: true };
const PULLS: Record<keyof PullReviews, true> = { now: true, total: true, reviews: true };
const PULL_REVIEW: Record<keyof PullReview, true> = { run: true, ordinal: true, at: true };

test('an answer holds no field the screen does not show', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const other: PullRequestRef = { ...REF, number: 129 };
  await savePullRequest(db, facts(other));
  const result = {
    scores: [{ path: 'src/cart/price.ts', finalScore: 80, fileLevel: null, blocks: [{
      entry: { score: 80, category: 'calculation', reason: 'Real reason.' }, span: { side: 'RIGHT', first: 1, last: 2 },
    }, { origin: 'other_pull_request', entry: { score: 30, category: 'calculation', reason: 'OTHER-PR-REASON' }, span: { side: 'RIGHT', first: 3, last: 4 } }] }],
    coverage: { reviewed: ['src/cart/price.ts'], notReviewed: [] }, verdict: { threshold: 70 },
    findings: [finding({ quote: 'QUOTE-TEXT' })], overview: 'OVERVIEW-TEXT', audit: 'AUDIT-TEXT', providers: ['PROVIDER-X'], acceptance: 'CRITERION-TEXT',
    skipped: [{ path: 'a.ts', reason: 'SKIP-TEXT' }], threadVerdicts: [{ commentId: 'c-31', verdict: 'fixed' }], threadsDue: 1,
    dependencies: { model: 'ok' }, models: ['vendor/model-a'],
  };
  const id = await recordRun(db, run({ body: 'BODY-TEXT', result }));
  await publish(db, id, { approved: true, approvalCode: 'approved', body: 'BODY-TEXT\n\n**Approved automatically** every part is below 70%.' });
  await recordComments(db, id, REF, [{ commentId: 'c-31', path: 'src/cart/price.ts', side: 'RIGHT', line: 42, severity: 'major', quote: 'QUOTE-TEXT' }]);
  await recordActivity(db, { ...activity('inline_comment', 'd-9', 'c-31', 20), body: 'REPLY-TEXT' });
  await recordEvaluation(db, evaluation(HEAD_A, 20, 'passed', 0, 0));
  const feed = (login: string, reason: string | null, seconds: number): Promise<boolean> =>
    recordFeedback(db, { run: id, login, vote: 'up', reason, extension: 'example', at: at(seconds) });
  await feed('sam@example.com', 'A REASON', 1);
  await feed('octo-guest', 'B REASON', 2);
  const logins = ['-octo', 'octo-', 'octo--dev', 'a'.repeat(40)];
  for (const [i, login] of logins.entries()) await feed(login, `R${i}`, 10 + i);
  const answer = await ok(review(deps(db), id));
  const pulls = await pullReviews(deps(db), REF);
  assert.deepEqual(keysOf(answer), KEYS(ONE));
  assert.deepEqual(keysOf(answer.pullRequest), KEYS(PULL));
  assert.deepEqual(keysOf(answer.askedBy), KEYS(ASKED));
  assert.deepEqual(keysOf(answer.approval), KEYS(APPROVAL));
  assert.deepEqual(keysOf(answer.gate!), KEYS(GATE));
  assert.deepEqual(keysOf(answer.read), KEYS(READ));
  assert.deepEqual(keysOf(answer.counts), KEYS(COUNTS));
  assert.deepEqual(keysOf(answer.earlier), KEYS(EARLIER));
  assert.deepEqual(keysOf(answer.usage), KEYS(USAGE));
  assert.deepEqual(keysOf(answer.feedback), KEYS(FEEDBACK));
  assert.equal(answer.files.length, 1);
  for (const f of answer.files) assert.deepEqual(keysOf(f), KEYS(FILE));
  assert.equal(answer.findings.length, 1);
  for (const f of answer.findings) { assert.deepEqual(keysOf(f), KEYS(FINDING)); assert.deepEqual(keysOf(f.thread), KEYS(THREAD)); }
  for (const d of answer.dependencies) assert.deepEqual(keysOf(d), KEYS(DEPENDENCY));
  for (const a of answer.approvals) assert.deepEqual(keysOf(a), KEYS(APPROVAL_ENTRY));
  assert.equal(answer.feedback.reasons.length, 6);
  for (const r of answer.feedback.reasons) assert.deepEqual(keysOf(r), KEYS(REASON));
  const failed = await ok(review(deps(db), await recordRun(db, run({ outcome: 'failed', failureStage: 'model', failureCode: 'model_timeout' }))));
  assert.deepEqual(keysOf(failed.failure!), KEYS(FAILURE));
  assert.deepEqual(keysOf(pulls), KEYS(PULLS));
  for (const r of pulls.reviews) assert.deepEqual(keysOf(r), KEYS(PULL_REVIEW));
  const text = JSON.stringify(answer);
  for (const secret of [
    'BODY-TEXT', 'OVERVIEW-TEXT', 'QUOTE-TEXT', 'AUDIT-TEXT', 'PROVIDER-X', 'CRITERION-TEXT', 'OTHER-PR-REASON', 'c-31', 'r-' + id, '"99"', 'b1',
    'REPLY-TEXT', 'SKIP-TEXT', 'sam@example.com',
  ]) assert.ok(!text.includes(secret), `the answer holds ${secret}`);
  const byReason = new Map(answer.feedback.reasons.map((r) => [r.reason, r.login]));
  assert.equal(byReason.get('A REASON'), null);
  assert.equal(byReason.get('B REASON'), 'octo-guest');
  for (let i = 0; i < logins.length; i++) assert.equal(byReason.get(`R${i}`), null);
  assert.ok(FEEDBACK_LOGIN.test('octo-dev') && !FEEDBACK_LOGIN.test('Octo'));
  await db.close();
});

test('the reviews of a pull request are its runs newest first with their place, and none is an empty list', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const a = await recordRun(db, run());
  const b = await recordRun(db, run({ finishedAt: at(120) }));
  const c = await recordRun(db, run({ finishedAt: at(150) }));
  const want: PullReviews = {
    now: at(0), total: 3,
    reviews: [{ run: c, ordinal: 3, at: at(150) }, { run: b, ordinal: 2, at: at(120) }, { run: a, ordinal: 1, at: at(90) }],
  };
  assert.deepEqual(await pullReviews(deps(db), REF), want);
  assert.deepEqual(await pullReviews(deps(db), { ...REF, owner: 'Acme', repo: 'Shop' }), want);
  assert.deepEqual(await pullReviews(deps(db), { ...REF, number: 999 }), { now: at(0), total: 0, reviews: [] });
  await db.close();
});

test('a run that is not stored is none', async () => {
  const db = await testDb();
  assert.equal(await review(deps(db), 999999), null);
  await db.close();
});
