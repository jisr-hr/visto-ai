import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { enqueueJob, claimJob, finishJob, getJob, requeueJob, unfinishedJobs } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { listRuns, markPublished, recordRun } from '../db/review-runs.ts';
import { recordBlockScores } from '../db/block-scores.ts';
import type { RunRecord } from '../db/review-runs.ts';
import { listComments, recordComments } from '../db/review-comments.ts';
import type { StoredComment } from '../db/review-comments.ts';
import { GATE_OFF, type RepoSettings } from '../config/load.ts';
import type { ForgeApprovals, ForgeWriter, LivePullRequest, OwnReviewState, PostedComment, PullRequestRef, ReviewDraft, ReviewThread, Source } from '../forge/types.ts';
import { markDismissed } from '../db/approvals.ts';
import type { ApprovalCode } from '../approval/rule.ts';
import { approvalParagraph } from '../approval/text.ts';
import { review } from '../engine/review.ts';
import { fitBody, renderReview } from '../engine/render/body.ts';
import { renderNotes } from '../engine/render/notes.ts';
import { shownOf } from '../engine/score/shown.ts';
import type { BlockScore } from '../engine/score/types.ts';
import { SUBMIT_REVIEW } from '../engine/model/submit-review.ts';
import type { Memory, MemoryStatus, ModelClient, ModelResponse, ReviewDeps, ReviewInput, ReviewProgress, ReviewResult, ThreadVerdict } from '../engine/types.ts';
import { runReviewJob } from './review-job.ts';
import type { ReviewJobDeps } from './review-job.ts';
import type { Notifier } from './notify.ts';
import { createExtensionHealth } from './extension-health.ts';
import { createMcpHealth } from './mcp-health.ts';
import { createMemoryHealth } from './memory-health.ts';
import type { MemoryHealth } from './memory-health.ts';
import type { ReviewNotice } from '../extensions/types.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const AUTOMATIC = { trigger: 'automatic' as const, requestedBy: null, commentId: null, association: null, installation: null };

let db: Db;
beforeEach(async () => { db = await testDb(); });
afterEach(async () => { await db.close(); });

const LIMITS = { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 240 };
const SETTINGS: RepoSettings = { primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: ['dependabot[bot]'], baseBranches: [], newHead: null, inlineNotes: false, gate: GATE_OFF };
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
  /** The time the clock reads; at(0) when not given. */
  now?: string;
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
  /** The job is a manual one, from a /review comment. */
  manual?: boolean;
  /** A manual job's reason; 'command' when not given. */
  reason?: string;
  /** A manual job's comment; '31' when not given. */
  commentId?: string | null;
  /** A manual job's requester; 'octo-lead' when not given. */
  requestedBy?: string;
  /** The association of a manual job's requester; 'member' when not given. */
  association?: string | null;
  /** react and comment reject. */
  writeFails?: boolean;
  /** The first n statements that finish the job reject. */
  finishFailures?: number;
  /** What listThreads answers, one answer for each call, the last one repeated; an Error rejects. [] when none is given. */
  threads?: Array<ReviewThread[] | Error>;
  /** What canResolve answers; true when not given. */
  canResolve?: boolean;
  /** replyToThread, editThreadComment and resolveThread reject. */
  threadWriteFails?: boolean;
  /** listReviewComments answers the comments each review was posted with, each with an id of its own; `posted` is then not used. */
  echo?: boolean;
  /** With echo: the text GitHub gives back for each posted comment, from the text it was posted with. */
  echoText?: (body: string) => string;
  /** The notifiers a published review is told to, with GitHub's links; no `notice` at all when not given. */
  notifiers?: Notifier[];
  /** With notifiers: the limit of each, in milliseconds. */
  noticeTimeoutMs?: number;
}

/** The next id an echoed comment gets: never one another echoed comment had. */
let echoedId = 9100;

/** The links a notice is given, as the service builds them for its git service. */
const reviewUrlOf = (ref: PullRequestRef, reviewId: string): string => `https://git.example.test/${ref.owner}/${ref.repo}/pull/${ref.number}#review-${reviewId}`;
const pullRequestUrlOf = (ref: PullRequestRef): string => `https://git.example.test/${ref.owner}/${ref.repo}/pull/${ref.number}`;

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
  } else if (options.manual === true) {
    await enqueueJob(db, {
      ref, reason: options.reason ?? 'command', headSha: '', runAt: at(0), now: at(0), delivery: 'd1', replace: true, trigger: 'manual',
      requestedBy: options.requestedBy ?? 'octo-lead', commentId: 'commentId' in options ? options.commentId ?? null : '31',
      association: 'association' in options ? options.association ?? null : 'member', installation: '99',
    });
    const jobs = await unfinishedJobs(db);
    job = (await claimJob(db, jobs.find((j) => j.status === 'pending' && j.ref.number === ref.number)!.id, at(0)))!;
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
  /** The engine's dependencies each review was given, beside its input. */
  const engines: ReviewDeps[] = [];
  const healthCalls: Array<'auth' | 'no_credit' | null> = [];
  const healthTimes: string[] = [];
  let reviewCalled = false;
  const spendCalls: unknown[] = [];
  const slept: number[] = [];
  const logged: Array<Record<string, unknown>> = [];
  /** What the health of the modules was told, as ['noted', extension, part, ok, code]. */
  const noted: unknown[][] = [];
  /** What the health of the MCP servers was told, as ['noted', server, ok, code]. */
  const mcpNoted: unknown[][] = [];
  const live = options.live === undefined ? (head === 'h1' ? LIVE : { ...LIVE, info: { ...LIVE.info, headSha: head } }) : options.live;
  let reads = 0;
  const writes: unknown[][] = [];
  const posts = [...(options.posts ?? [])];
  const owns = [...(options.own ?? [])];
  const threadAnswers = [...(options.threads ?? [])];
  const threadWrite = (): void => { if (options.threadWriteFails === true) throw new Error('github_502'); };
  /** Every draft publishReview was given, as it was given. */
  const drafts: ReviewDraft[] = [];
  /** With echo: the comments of each posted review, by its id. */
  const echoes = new Map<string, PostedComment[]>();
  const writer: ForgeWriter = {
    publishReview: async (_ref, _installation, draft) => {
      writes.push(['publishReview', draft.commit, draft.body, draft.comments.length]);
      drafts.push(structuredClone(draft));
      const next = posts.shift() ?? { id: '501' };
      if (next instanceof Error) throw next;
      echoes.set(next.id, draft.comments.map((c) => ({ id: String(echoedId++), path: c.path, side: c.side, line: c.line, body: options.echoText?.(c.body) ?? c.body })));
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
      if (options.echo === true) return echoes.get(reviewId) ?? [];
      const posted = options.posted === undefined ? POSTED : options.posted;
      if (posted instanceof Error) throw posted;
      return posted;
    },
    react: async (_ref, _installation, commentId, reaction) => {
      writes.push(['react', commentId, reaction]);
      if (options.writeFails === true) throw new Error('github_502');
    },
    comment: async (_ref, _installation, body) => {
      writes.push(['comment', body]);
      if (options.writeFails === true) throw new Error('github_502');
    },
    listThreads: async () => {
      writes.push(['listThreads']);
      const threads = (threadAnswers.length > 1 ? threadAnswers.shift() : threadAnswers[0]) ?? [];
      if (threads instanceof Error) throw threads;
      return threads;
    },
    replyToThread: async (_installation, threadId, body) => { writes.push(['replyToThread', threadId, body]); threadWrite(); },
    editThreadComment: async (_installation, node, body) => { writes.push(['editThreadComment', node, body]); threadWrite(); },
    resolveThread: async (_installation, threadId) => { writes.push(['resolveThread', threadId]); threadWrite(); },
  };
  let finishFailuresLeft = options.finishFailures ?? 0;
  /** Whether this statement is one that finishes the job, and is to reject. */
  const finishFails = (text: string): boolean => {
    if (finishFailuresLeft > 0 && text.includes('set status = $2, outcome = $3')) { finishFailuresLeft -= 1; return true; }
    return false;
  };
  let markFailuresLeft = options.markFailures ?? 0;
  let failuresLeft = options.recordFailures ?? 0;
  let lost = options.lostAnswer === true;
  let queryFails = options.failQuery !== undefined;
  const wrapped: Db = {
    query: (text, params) => {
      if (queryFails && text.includes(options.failQuery!)) { queryFails = false; return Promise.reject(new Error('Something private broke')); }
      if (finishFails(text)) return Promise.reject(new Error('db_down'));
      return db.query(text, params);
    },
    script: (sql) => db.script(sql),
    close: () => db.close(),
    transaction: async (work) => {
      if (failuresLeft > 0) { failuresLeft -= 1; throw new Error('db_down'); }
      const done = await db.transaction((tx) => work({
        query: (text, params) => {
          if (markFailuresLeft > 0 && text.includes('set published = true')) { markFailuresLeft -= 1; return Promise.reject(new Error('db_down')); }
          if (finishFails(text)) return Promise.reject(new Error('db_down'));
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
    clock: () => new Date(reviewCalled && options.afterReview !== undefined ? options.afterReview : options.now ?? at(0)),
    log: (e) => { logged.push(e); },
    sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
    settingsFor: () => options.settings ?? SETTINGS,
    limits: LIMITS,
    dryRun: options.dryRun ?? true,
    writer,
    engineDeps: () => ({}) as ReviewDeps,
    review: (input, engine) => {
      inputs.push(input);
      engines.push(engine);
      reviewCalled = true;
      return Promise.resolve(options.result ?? (options.renderThrows === true ? flaggedResult() : okResult({ mode: input.mode ?? 'full' })));
    },
    lineUrl: () => { if (options.renderThrows === true) throw new Error('no_link'); return 'https://git.example.test/x'; },
    commentUrl: (_ref, commentId) => `https://git.example.test/c/${commentId}`,
    canResolve: () => Promise.resolve(options.canResolve ?? true),
    health: { reviewed: (code, when) => { healthCalls.push(code); healthTimes.push(when.toISOString()); } },
    spend: { noteRun: (usage) => { spendCalls.push(usage); } },
    extensionHealth: { noted: (...args) => { noted.push(['noted', ...args]); } },
    mcpHealth: { noted: (...args) => { mcpNoted.push(['noted', ...args]); } },
  };
  if (options.notifiers !== undefined) {
    deps.notice = { notifiers: options.notifiers, reviewUrl: reviewUrlOf, pullRequestUrl: pullRequestUrlOf, timeoutMs: options.noticeTimeoutMs };
  }
  return { job, deps, inputs, engines, healthCalls, healthTimes, spendCalls, slept, logged, writes, drafts, noted, mcpNoted, get reads() { return reads; } };
}
const live = (options: Options = {}) => harness({ dryRun: false, ...options });
/** A job a /review comment stored: by octo-lead, comment 31, through installation 99; out of dry run unless given. */
const manualJob = (options: Options = {}) => harness({ dryRun: false, ...options, manual: true });

/** The finding of the review published at h0, and what it rendered. */
const MAJOR = { path: 'src/a.ts', side: 'RIGHT' as const, line: 12, severity: 'major' as const, body: 'A check is missing.', quote: 'y', requestedLine: null };
const EARLIER_RESULT = okResult({ findings: [MAJOR] });
const EARLIER = renderReview(EARLIER_RESULT, { trigger: 'automatic', requestedBy: null, lineUrl: () => 'https://git.example.test/x', inline: true });
const STORED_8001: StoredComment = { commentId: '8001', path: 'src/a.ts', side: 'RIGHT', line: 12, severity: 'major', quote: 'y' };
/** A live run recorded and not published: by default at h1 against merge000, with okResult and its rendered text. */
const recorded = (over: Partial<RunRecord> = {}): Promise<number> => {
  const result = (over.result as ReviewResult | undefined) ?? okResult();
  const text = renderReview(result, { trigger: 'automatic', requestedBy: null, lineUrl: () => 'https://git.example.test/x', inline: true });
  return recordRun(db, {
    ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'merge000', baseBranch: null, outcome: 'ok', failureStage: null, failureCode: null,
    needsHuman: false, highestScore: 35, body: text.body, comments: text.comments, result, usage: USAGE, startedAt: at(-3600), finishedAt: at(-3500), ...over,
  });
};
/** A review published as 401: its run at h0 against merge000 on the base branch main, a full review, and its comment 8001 stored, unless told otherwise. */
async function published(over: {
  head?: string; comments?: StoredComment[]; pullRequest?: number; baseBranch?: string | null; mode?: RunRecord['mode']; result?: unknown; reviewId?: string;
} = {}): Promise<number> {
  const ref = over.pullRequest === undefined ? REF : { ...REF, number: over.pullRequest };
  const id = await recorded({
    ref, headSha: over.head ?? 'h0', result: over.result ?? EARLIER_RESULT, baseBranch: over.baseBranch === undefined ? 'main' : over.baseBranch, mode: over.mode ?? 'full',
  });
  await markPublished(db, id, { reviewId: over.reviewId ?? '401', publishedAt: at(-3400), body: EARLIER.body, inlineDropped: false });
  await recordComments(db, id, ref, over.comments ?? [STORED_8001]);
  return id;
}
/** The thread of comment 8001, with one reply by octo-dev. */
const THREAD: ReviewThread = {
  id: 'PRRT_1', path: 'src/a.ts', side: 'RIGHT', line: 12, resolved: false, resolvedByApp: false,
  comments: [
    { id: '8001', node: 'PRRC_1', author: 'visto-test[bot]', authorIsBot: true, byApp: true, reviewId: '401', body: EARLIER.comments[0]!.body, at: at(-3400) },
    { id: '8002', node: 'PRRC_2', author: 'octo-dev', authorIsBot: false, byApp: false, reviewId: null, body: 'The caller checks it.', at: at(-100) },
  ],
};
const VERDICT: ThreadVerdict = { threadId: 'PRRT_1', commentId: '8001', verdict: 'answered', reply: 'The guard is in the caller.', fileChanged: false };
const REPLY = '**Answered.** The guard is in the caller.\n\n<!-- visto-ai: review=501 head=h1 -->';

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
  assert.deepEqual(await listComments(db, REF), [{ commentId: '9001', path: 'a.ts', side: 'RIGHT', line: 3, severity: 'minor', quote: 'x', blockHash: null, run: stored!.id }]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.published, entry.review, entry.publish, entry.publish_code, entry.resumed, entry.adopted], [true, '501', 'published', null, false, false]);
  assert.deepEqual(h.logged.find((e) => e.event === 'readback'), { event: 'readback', job: h.job.id, run: stored!.id, posted: 1, stored: 1, notes: 0, notes_missing: 0 });
});
test('in dry run nothing is ever written to the git service', async () => {
  const h = await harness();
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.writes, (await listRuns(db, REF))[0]!.published, (await getJob(db, h.job.id))?.outcome], [[], false, 'reviewed']);
});
test('a pull request that already has its review is not reviewed again at the same head, and a later head is reviewed against it', async () => {
  const first = await live();
  await runReviewJob(first.job, first.deps);
  const same = await live();
  await runReviewJob(same.job, same.deps);
  const later = await live({ head: 'h2' });
  await runReviewJob(later.job, later.deps);
  assert.deepEqual(
    [(await getJob(db, same.job.id))?.outcome, (await getJob(db, later.job.id))?.outcome, same.inputs.length, later.inputs.length, (await listRuns(db, REF)).length],
    ['already_reviewed', 'published', 0, 1, 2]);
  assert.equal(later.inputs[0]!.earlier?.head, 'h1');
});
test('when the post cannot be made the review stays stored and the job is put back with its start counted', async () => {
  const h = await live({ posts: [new Error('github_502')] });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([stored!.outcome, stored!.published, j?.status, j?.runAt, j?.starts], ['ok', false, 'pending', at(900), 1]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.publish, entry.publish_code, entry.requeued], ['failed', 'github_502', true]);
});
test('a publication that failed waits 15 minutes, whatever its code: the start after it posts a review only once it is that old', async () => {
  for (const [code, number] of [['github_502', 8], ['github_500', 9], ['github_network', 10], ['github_403', 11], ['internal_error', 12]] as const) {
    const h = await live({ pullRequest: number, posts: [new Error(code)] });
    await runReviewJob(h.job, h.deps);
    const j = await getJob(db, h.job.id);
    assert.deepEqual([j?.status, j?.runAt, j?.starts], ['pending', at(900), 1], code);
  }
});
test('a later start that finds its young recorded review unlisted posts nothing and waits until the review is 15 minutes old', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const early = await live({ reuseJob: before.job.id, now: at(5) });
  await runReviewJob(early.job, early.deps);
  const j = await getJob(db, early.job.id);
  // The run was recorded at at(0): the wait ends at at(900), not 15 minutes after this start. The start is given back.
  assert.deepEqual([j?.status, j?.outcome, j?.runAt, j?.starts], ['pending', null, at(900), 1]);
  assert.deepEqual([early.writes.map((w) => w[0]), early.inputs.length, (await listRuns(db, REF))[0]!.published], [['listOwnReviews'], 0, false]);
  const entry = early.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.publish, entry.publish_code, entry.published, entry.requeued, entry.resumed, entry.adopted], ['unlisted', null, false, true, true, false]);
});
test('a recorded review waits to the second: one short of 15 minutes old it is held, at 15 minutes it is posted', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const early = await live({ reuseJob: before.job.id, now: at(899) });
  await runReviewJob(early.job, early.deps);
  assert.deepEqual([(await getJob(db, early.job.id))?.status, early.writes.filter((w) => w[0] === 'publishReview').length], ['pending', 0]);
  const due = await live({ reuseJob: before.job.id, now: at(900) });
  await runReviewJob(due.job, due.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.published, stored!.reviewId, (await getJob(db, due.job.id))?.outcome, due.writes.filter((w) => w[0] === 'publishReview').length], [true, '501', 'published', 1]);
});
test('a recorded review dated after the clock waits 15 minutes from this start, not longer', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const early = await live({ reuseJob: before.job.id, now: at(-100) });
  await runReviewJob(early.job, early.deps);
  const j = await getJob(db, early.job.id);
  assert.deepEqual([j?.status, j?.runAt, early.writes.filter((w) => w[0] === 'publishReview').length], ['pending', at(800), 0]);
});
test('a /review that meets a young recorded review waits too, and is told nothing', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const command = await manualJob({ now: at(5) });
  await runReviewJob(command.job, command.deps);
  const j = await getJob(db, command.job.id);
  assert.deepEqual([j?.status, j?.trigger, j?.runAt, j?.starts, command.inputs.length], ['pending', 'manual', at(900), 0, 0]);
  assert.deepEqual(command.writes.filter((w) => w[0] !== 'listOwnReviews'), [['react', '31', 'eyes']]);
});
test('a wait whose place a newer job took ends the job as superseded, and a command is told so', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const command = await manualJob({ now: at(5) });
  const list = command.deps.writer.listOwnReviews;
  let newer: number | null = null;
  command.deps.writer = {
    ...command.deps.writer,
    listOwnReviews: async (ref, installation) => {
      newer = await enqueueJob(db, { ref: REF, reason: 'synchronize', headSha: 'h2', runAt: at(100), now: at(1), delivery: 'd9', replace: false, ...AUTOMATIC });
      return list(ref, installation);
    },
  };
  await runReviewJob(command.job, command.deps);
  assert.equal((await getJob(db, command.job.id))?.outcome, 'superseded');
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.id, j.status]), [[newer, 'pending']]);
  assert.deepEqual(command.writes.slice(-2), [['react', '31', 'confused'], ['comment', '@octo-lead The review did not finish (`superseded`).']]);
  assert.equal(command.writes.some((w) => w[0] === 'publishReview'), false);
});
test('a later start that may post writes the time first, so a start right after its failed post is held as well', async () => {
  const posts = (h: { writes: unknown[][] }): number => h.writes.filter((w) => w[0] === 'publishReview').length;
  const before = await live({ posts: [new Error('github_403')] });
  await runReviewJob(before.job, before.deps);
  assert.equal((await listRuns(db, REF))[0]!.publishTriedAt, null);
  // The second start comes when the review is 15 minutes old: it posts, and GitHub answers with an error again.
  const second = await live({ reuseJob: before.job.id, now: at(900), posts: [new Error('github_502')] });
  await runReviewJob(second.job, second.deps);
  let j = await getJob(db, second.job.id);
  assert.deepEqual([j?.status, j?.runAt, (await listRuns(db, REF))[0]!.publishTriedAt, posts(second)], ['pending', at(1800), at(900), 1]);
  // A /review five seconds later: the review is older than 15 minutes, its last post is not.
  const command = await manualJob({ now: at(905) });
  await runReviewJob(command.job, command.deps);
  j = await getJob(db, command.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts, posts(command), (await listRuns(db, REF))[0]!.publishTriedAt], ['pending', at(1800), 0, 0, at(900)]);
  const due = await live({ reuseJob: command.job.id, now: at(1800) });
  await runReviewJob(due.job, due.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.published, stored!.reviewId, stored!.publishTriedAt, posts(due), (await getJob(db, due.job.id))?.outcome], [true, '501', at(1800), 1, 'published']);
});
test('a held start writes no time, and a first start writes none', async () => {
  const first = await live();
  await runReviewJob(first.job, first.deps);
  assert.deepEqual([(await listRuns(db, REF))[0]!.published, (await listRuns(db, REF))[0]!.publishTriedAt], [true, null]);
  const before = await live({ pullRequest: 8, posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const early = await live({ pullRequest: 8, reuseJob: before.job.id, now: at(5) });
  await runReviewJob(early.job, early.deps);
  assert.equal((await listRuns(db, { ...REF, number: 8 }))[0]!.publishTriedAt, null);
});
test('when the time of a later post cannot be written, nothing is posted and the job is put back', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const again = await live({ reuseJob: before.job.id, now: at(900) });
  const query = again.deps.db.query;
  again.deps.db = { ...again.deps.db, query: (text, params) => (text.includes('set publish_tried_at') ? Promise.reject(new Error('db_down')) : query(text, params)) };
  await runReviewJob(again.job, again.deps);
  const j = await getJob(db, again.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts, again.writes, again.slept, (await listRuns(db, REF))[0]!.published], ['pending', at(1800), 2, [], [1000, 5000], false]);
  const entry = again.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.publish, entry.publish_code, entry.requeued], ['failed', 'record_failed', true]);
});
test('after a server error, the next start adopts the review GitHub holds and posts nothing', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const again = await live({ reuseJob: before.job.id, own: [[{ id: '501', commit: 'h1' }]] });
  await runReviewJob(again.job, again.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([stored!.published, stored!.reviewId, again.inputs.length, again.writes.filter((w) => w[0] === 'publishReview').length], [true, '501', 0, 0]);
  assert.equal(again.logged.find((e) => e.event === 'review')!.adopted, true);
});
test('the next start publishes the stored review without calling the model, and tells no guard', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const again = await live({ reuseJob: before.job.id, now: at(900) });
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
test('a review posted on an earlier head that the database never learned of, and has no run for, is logged and does not stop the review', async () => {
  const h = await live({ head: 'h2', own: [[{ id: '470', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome, h.inputs.length, (await listRuns(db, REF)).length, h.writes.filter((w) => w[0] === 'publishReview').length],
    ['done', 'published', 1, 1, 1]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'unknown_review'), [{ event: 'unknown_review', job: h.job.id, review: '470' }]);
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
test('a review of its own that appears on another commit while the review runs does not stop the post', async () => {
  const h = await live({ own: [[], [{ id: '470', commit: 'h0' }]] });
  await runReviewJob(h.job, h.deps);
  const runs = await listRuns(db, REF);
  assert.deepEqual([h.inputs.length, runs.length, runs[0]!.outcome, runs[0]!.published, runs[0]!.reviewId, h.writes.filter((w) => w[0] === 'publishReview').length],
    [1, 1, 'ok', true, '501', 1]);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'published']);
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
test('a /review from a member is accepted, reviewed as requested, and published', async () => {
  const h = await manualJob();
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.writes.map((w) => w[0]), ['listOwnReviews', 'react', 'listOwnReviews', 'publishReview', 'listReviewComments']);
  assert.deepEqual(h.writes[1], ['react', '31', 'eyes']);
  assert.deepEqual([h.inputs[0]!.trigger, (await listRuns(db, REF))[0]!.trigger, (await getJob(db, h.job.id))?.outcome], ['manual', 'manual', 'published']);
  assert.equal((await listRuns(db, REF))[0]!.body.includes('requested by @octo-lead'), true);
});
test('a /review from someone without access is refused before anything is read, and the head still gets its job', async () => {
  for (const [association, number] of [['none', 7], [null, 8], ['contributor', 9]] as const) {
    const h = await manualJob({ association, pullRequest: number });
    await runReviewJob(h.job, h.deps);
    assert.deepEqual(h.writes, [['react', '31', 'confused'], ['comment', '@octo-lead The review was not started (`not_allowed`).']]);
    assert.deepEqual([h.reads, h.inputs.length, (await getJob(db, h.job.id))?.outcome], [0, 0, 'refused']);
    const left = (await unfinishedJobs(db)).filter((j) => j.ref.number === number);
    assert.deepEqual(left.map((j) => [j.trigger, j.reason, j.headSha, j.status]), [['automatic', 'opened', 'h1', 'pending']]);
  }
});
test('a /review from someone without access on a head whose paid review failed stores no job, in dry run and out of it', async () => {
  for (const [dryRun, number] of [[true, 7], [false, 8]] as const) {
    const first = await harness({ dryRun, pullRequest: number, result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
    await runReviewJob(first.job, first.deps);
    assert.equal((await getJob(db, first.job.id))?.outcome, 'failed');
    const h = await manualJob({ dryRun, association: 'none', pullRequest: number });
    await runReviewJob(h.job, h.deps);
    assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.inputs.length], ['refused', 0]);
    assert.deepEqual((await unfinishedJobs(db)).filter((j) => j.ref.number === number), []);
  }
});
test('a stranger\'s command that superseded the head\'s job gives the head its job back, and its start posts the recorded review', async () => {
  const STRANGER = { ref: REF, reason: 'command', headSha: '', runAt: at(1), now: at(1), delivery: 'd8', replace: false,
    trigger: 'manual' as const, requestedBy: 'octo-dev', commentId: '32', association: 'none', installation: '99' };
  const first = await live({ posts: [new Error('github_502')] });
  const post = first.deps.writer.publishReview;
  let command: number | null = null;
  first.deps.writer = { ...first.deps.writer, publishReview: async (ref, installation, draft) => { command = await enqueueJob(db, STRANGER); return post(ref, installation, draft); } };
  await runReviewJob(first.job, first.deps);
  assert.equal((await getJob(db, first.job.id))?.outcome, 'superseded');
  const refused = await manualJob({ reuseJob: command!, association: 'none' });
  await runReviewJob(refused.job, refused.deps);
  assert.equal((await getJob(db, command!))?.outcome, 'refused');
  const waiting = await unfinishedJobs(db);
  assert.deepEqual(waiting.map((j) => [j.trigger, j.headSha, j.status]), [['automatic', 'h1', 'pending']]);
  // The job the head got back starts at once and finds the review young: it waits, and posts it once it is 15 minutes old.
  const early = await live({ reuseJob: waiting[0]!.id });
  await runReviewJob(early.job, early.deps);
  assert.deepEqual([(await getJob(db, early.job.id))?.status, early.writes.filter((w) => w[0] === 'publishReview').length], ['pending', 0]);
  const again = await live({ reuseJob: waiting[0]!.id, now: at(900) });
  await runReviewJob(again.job, again.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([again.inputs.length, (await getJob(db, again.job.id))?.outcome, stored!.published, (await listRuns(db, REF)).length], [0, 'published', true, 1]);
  assert.deepEqual(again.writes.filter((w) => w[0] === 'publishReview'), [['publishReview', 'h1', stored!.body, 1]]);

  // in dry run: a read that fails, a put-back superseded by a stranger's waiting command, and the refusal stores the head's job again
  const dry = await harness({ pullRequest: 8, live: new Error('github_502') });
  const waits = (await enqueueJob(db, { ...STRANGER, ref: { ...REF, number: 8 } }))!;
  await runReviewJob(dry.job, dry.deps);
  assert.equal((await getJob(db, dry.job.id))?.outcome, 'superseded');
  const no = await manualJob({ dryRun: true, pullRequest: 8, reuseJob: waits, association: 'none' });
  await runReviewJob(no.job, no.deps);
  assert.deepEqual((await unfinishedJobs(db)).filter((j) => j.ref.number === 8).map((j) => [j.trigger, j.headSha, j.status]), [['automatic', 'h1', 'pending']]);
});
test('a /review on a closed pull request is refused with no eyes first, and one on a head that has its review re-checks it', async () => {
  const closed = await manualJob({ live: { ...LIVE, state: 'closed' } });
  await runReviewJob(closed.job, closed.deps);
  assert.deepEqual(closed.writes, [['react', '31', 'confused'], ['comment', '@octo-lead The review was not started (`closed`).']]);
  const first = await live({ pullRequest: 8 });
  await runReviewJob(first.job, first.deps);
  const second = await manualJob({ pullRequest: 8, own: [[{ id: '501', commit: 'h1' }]] });
  await runReviewJob(second.job, second.deps);
  assert.deepEqual(second.writes.filter((w) => w[0] === 'react'), [['react', '31', 'eyes']]);
  assert.deepEqual([second.inputs.length, second.inputs[0]!.mode, (await getJob(db, second.job.id))?.outcome], [1, 'recheck', 'published']);
});
test('a /review on a head whose review only the git service knows of is refused before anything is paid; one on another commit does not stop it', async () => {
  const h = await manualJob({ own: [[{ id: '470', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.writes, [['listOwnReviews'], ['react', '31', 'confused'], ['comment', '@octo-lead The review was not started (`already_reviewed`).']]);
  assert.deepEqual([h.inputs.length, (await getJob(db, h.job.id))?.outcome], [0, 'refused']);
  const other = await manualJob({ pullRequest: 8, own: [[{ id: '470', commit: 'h0' }]] });
  await runReviewJob(other.job, other.deps);
  assert.deepEqual([other.inputs.length, (await getJob(db, other.job.id))?.outcome, other.writes.filter((w) => w[0] === 'publishReview').length], [1, 'published', 1]);
});
test('a draft, an ignored author and a filtered base branch do not stop a /review, and the live head is the one reviewed', async () => {
  const h = await manualJob({ live: { ...LIVE, info: { ...LIVE.info, draft: true, author: 'dependabot[bot]', headSha: 'h9' } }, settings: { ...SETTINGS, baseBranches: ['release'] } });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, (await listRuns(db, REF))[0]!.headSha], ['published', 'h9']);
});
test('a head that moves under a /review starts it over once, as a new job', async () => {
  const moved = { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } };
  const first = await manualJob({ liveAfter: moved });
  await runReviewJob(first.job, first.deps);
  assert.deepEqual([(await getJob(db, first.job.id))?.outcome, first.writes.some((w) => w[0] === 'comment')], ['head_moved', false]);
  const [retry] = await unfinishedJobs(db);
  assert.deepEqual([retry!.trigger, retry!.reason, retry!.requestedBy, retry!.commentId, retry!.association, retry!.runAt], ['manual', 'command_retry', 'octo-lead', '31', 'member', at(0)]);
  const second = await manualJob({ reuseJob: retry!.id, live: moved, liveAfter: { ...LIVE, info: { ...LIVE.info, headSha: 'h3' } } });
  await runReviewJob(second.job, second.deps);
  assert.deepEqual([(await getJob(db, second.job.id))?.outcome, second.writes.at(-1)], ['head_moved', ['comment', '@octo-lead The review did not finish (`head_moved`).']]);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.trigger, j.headSha, j.runAt]), [['automatic', 'h3', at(180)]]);
});
test('a /review whose review fails, or whose publication is refused, says so', async () => {
  const failedRun = await manualJob({ result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(failedRun.job, failedRun.deps);
  assert.deepEqual(failedRun.writes.slice(-2), [['react', '31', 'confused'], ['comment', '@octo-lead The review did not finish (`review_failed`).']]);
  const refused = await manualJob({ pullRequest: 8, posts: [new Error('review_rejected'), new Error('review_rejected')] });
  await runReviewJob(refused.job, refused.deps);
  assert.deepEqual(refused.writes.at(-1), ['comment', '@octo-lead The review did not finish (`publish_rejected`).']);
});
test('a /review put back while another job waits is superseded and says so', async () => {
  const early = await manualJob({ live: new Error('github_502') });
  const waiting = await enqueueJob(db, { ref: REF, reason: 'synchronize', headSha: 'h2', runAt: at(100), now: at(1), delivery: 'd9', replace: false, ...AUTOMATIC });
  await runReviewJob(early.job, early.deps);
  assert.deepEqual([(await getJob(db, early.job.id))?.outcome, (await getJob(db, waiting!))?.status], ['superseded', 'pending']);
  assert.deepEqual(early.writes, [['react', '31', 'confused'], ['comment', '@octo-lead The review did not finish (`superseded`).']]);
  const late = await manualJob({ pullRequest: 8, posts: [new Error('github_502')] });
  const post = late.deps.writer.publishReview;
  late.deps.writer = {
    ...late.deps.writer,
    publishReview: async (ref, installation, draft) => {
      await enqueueJob(db, { ref: { ...REF, number: 8 }, reason: 'synchronize', headSha: 'h2', runAt: at(100), now: at(1), delivery: 'd10', replace: false, ...AUTOMATIC });
      return post(ref, installation, draft);
    },
  };
  await runReviewJob(late.job, late.deps);
  assert.equal((await getJob(db, late.job.id))?.outcome, 'superseded');
  assert.deepEqual(late.writes.slice(-2), [['react', '31', 'confused'], ['comment', '@octo-lead The review did not finish (`superseded`).']]);
});
test('a /review whose text could not be rendered says so', async () => {
  const h = await manualJob({ renderThrows: true });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'render_failed');
  assert.deepEqual(h.writes.slice(-2), [['react', '31', 'confused'], ['comment', '@octo-lead The review did not finish (`render_failed`).']]);
});
test('a /review whose publication finds a review of its own on another commit is published', async () => {
  const h = await manualJob({ own: [[], [{ id: '470', commit: 'h0' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.inputs.length, h.writes.filter((w) => w[0] === 'publishReview').length], ['published', 1, 1]);
  assert.equal(h.writes.some((w) => w[0] === 'react' && w[2] === 'confused'), false);
});
test('in dry run a /review writes nothing, whether it is honoured, refused or fails', async () => {
  const ok = await manualJob({ dryRun: true });
  await runReviewJob(ok.job, ok.deps);
  const stranger = await manualJob({ dryRun: true, association: 'none', pullRequest: 8 });
  await runReviewJob(stranger.job, stranger.deps);
  const closed = await manualJob({ dryRun: true, pullRequest: 9, live: { ...LIVE, state: 'closed' } });
  await runReviewJob(closed.job, closed.deps);
  const failing = await manualJob({ dryRun: true, pullRequest: 10, result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(failing.job, failing.deps);
  assert.deepEqual([ok.writes, stranger.writes, closed.writes, failing.writes], [[], [], [], []]);
  assert.deepEqual(
    [(await getJob(db, ok.job.id))?.outcome, (await getJob(db, stranger.job.id))?.outcome, (await getJob(db, closed.job.id))?.outcome, (await getJob(db, failing.job.id))?.outcome, stranger.inputs.length],
    ['reviewed', 'refused', 'refused', 'failed', 0]);
});
test('a refusal is recorded before it is answered, and an answer that cannot be written changes nothing', async () => {
  const h = await manualJob({ association: 'none', writeFails: true });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.logged.filter((e) => e.event === 'answer_failed').length], ['refused', 2]);
  const unrecorded = await manualJob({ association: 'none', pullRequest: 8, finishFailures: 3 });
  await runReviewJob(unrecorded.job, unrecorded.deps);
  assert.deepEqual([unrecorded.writes, (await getJob(db, unrecorded.job.id))?.status], [[], 'running']);
});
test('what is recorded is what was rendered, and a resumed start posts exactly that', async () => {
  const NUL = String.fromCharCode(0);
  const text = [`see @${NUL}victim and <${NUL}!-- hidden and &${NUL}#64;victim`, `\`\`${NUL}\``, '@victim', `${NUL}## Overall`, `end ${String.fromCharCode(0xd800)}`].join('\n');
  const result = okResult({ overview: text, findings: [{ ...okResult().findings[0]!, body: text }] });
  const expected = renderReview(result, { trigger: 'automatic', requestedBy: null, lineUrl: () => 'https://git.example.test/x', inline: true });
  const before = await live({ result, posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const [stored] = await listRuns(db, REF);
  assert.equal(stored!.body, expected.body);
  assert.deepEqual(stored!.comments, expected.comments);
  const again = await live({ reuseJob: before.job.id, now: at(900) });
  await runReviewJob(again.job, again.deps);
  assert.deepEqual(again.writes.filter((w) => w[0] === 'publishReview'), [['publishReview', 'h1', expected.body, 1]]);
});
test('a push after a published review is reviewed in full with its threads, published, and the verdict written into the thread', async () => {
  await published();
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]], result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs[0]!.earlier?.head, 'h0');
  assert.deepEqual(h.inputs[0]!.earlier?.threads.map((t) => [t.id, t.commentId, t.severity, t.settled, t.replies.length]), [['PRRT_1', '8001', 'major', false, 1]]);
  assert.deepEqual(h.writes.map((w) => w[0]), ['listOwnReviews', 'listThreads', 'listOwnReviews', 'publishReview', 'listReviewComments', 'listThreads', 'replyToThread', 'resolveThread']);
  assert.deepEqual(h.writes[6], ['replyToThread', 'PRRT_1', REPLY]);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
  assert.deepEqual(h.logged.filter((e) => e.event === 'thread_followup').map((e) => [e.review, e.replied, e.resolved, e.failed, e.missing, e.changed]), [['501', 1, 1, 0, 0, 0]]);
});
test('a thread someone wrote in after it was judged is left as it is, and the log counts it as changed', async () => {
  await published();
  const later: ReviewThread = { ...THREAD, comments: [...THREAD.comments, { ...THREAD.comments[1]!, id: '8003', node: 'PRRC_3', body: 'Wait, it is a bug.' }] };
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD], [later]], result: okResult({ threadVerdicts: [{ ...VERDICT, replies: 1 }], threadsDue: 1 }) });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.writes.some((w) => w[0] === 'replyToThread' || w[0] === 'resolveThread'), false);
  assert.deepEqual(h.logged.filter((e) => e.event === 'thread_followup').map((e) => [e.replied, e.resolved, e.missing, e.changed]), [[0, 0, 0, 1]]);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('a later review posts the finding its thread already raised with the link to that thread', async () => {
  await published();
  const discussed = { path: 'src/a.ts', side: 'RIGHT' as const, line: 12, severity: 'major' as const, body: 'A check is missing.', commentId: '8001', resolved: false, settled: false };
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]], result: okResult({ alreadyDiscussed: [discussed], threadsDue: 1 }) });
  await runReviewJob(h.job, h.deps);
  const posts = h.writes.filter((w) => w[0] === 'publishReview');
  assert.equal(posts.length, 1);
  assert.ok(String(posts[0]![2]).includes('## Already discussed'));
  assert.ok(String(posts[0]![2]).includes('(https://git.example.test/c/8001)'));
});
test('a first review reads no thread and is told of no earlier state', async () => {
  const h = await live();
  await runReviewJob(h.job, h.deps);
  assert.equal(h.writes.some((w) => w[0] === 'listThreads'), false);
  assert.equal(h.inputs[0]!.earlier, null);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('a head and base that are already reviewed are not reviewed again by a push, and a command re-checks them', async () => {
  await published({ head: 'h1' });
  const push = await live();
  await runReviewJob(push.job, push.deps);
  const j = await getJob(db, push.job.id);
  assert.deepEqual([j?.status, j?.outcome, push.inputs.length], ['dropped', 'already_reviewed', 0]);
  const command = await manualJob({ own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(command.job, command.deps);
  assert.deepEqual([(await getJob(db, command.job.id))?.outcome, command.inputs.length, command.inputs[0]!.mode], ['published', 1, 'recheck']);
  assert.equal(command.writes.some((w) => w[0] === 'comment'), false);
});
test('a /review on a later head is honoured', async () => {
  await published();
  const h = await manualJob({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.writes.some((w) => w[0] === 'react' && w[2] === 'eyes'), true);
  assert.equal(h.inputs[0]!.earlier?.head, 'h0');
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('threads that cannot be read fail the start before anything is paid', async () => {
  await published();
  const h = await live({ threads: [new Error('github_502')] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs.length, 0);
  const failedRuns = (await listRuns(db, REF)).filter((r) => r.outcome === 'failed');
  assert.deepEqual(failedRuns.map((r) => [r.failureStage, r.failureCode]), [['prepare', 'github_502']]);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.runAt, j?.starts], ['pending', at(60), 1]);
  assert.equal(h.writes.some((w) => w[0] === 'publishReview'), false);
});
test('a review the database lost track of is adopted into its recorded run, and the push is then reviewed against it', async () => {
  const lostRun = await recorded({ headSha: 'h0', result: EARLIER_RESULT });
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(h.job, h.deps);
  const adopted = (await listRuns(db, REF)).find((r) => r.id === lostRun)!;
  assert.deepEqual([adopted.published, adopted.reviewId, adopted.publishedAt, adopted.body, adopted.inlineDropped], [true, '401', at(0), EARLIER.body, false]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'adopted_late'), [{ event: 'adopted_late', job: h.job.id, run: lostRun, review: '401' }]);
  assert.deepEqual(h.writes.slice(0, 3), [['listOwnReviews'], ['listReviewComments', '401'], ['listThreads']]);
  assert.equal(h.inputs[0]!.earlier?.head, 'h0');
  assert.equal(h.inputs[0]!.earlier?.threads.length, 1);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('a review of ours with no recorded run is logged and the pull request is reviewed without it', async () => {
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.logged.filter((e) => e.event === 'unknown_review'), [{ event: 'unknown_review', job: h.job.id, review: '401' }]);
  assert.equal(h.inputs[0]!.earlier, null);
  assert.equal(h.writes.some((w) => w[0] === 'listThreads'), false);
  assert.equal(h.writes.filter((w) => w[0] === 'publishReview').length, 1);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('a comment the read-back missed is stored from its thread before the review', async () => {
  const run = await published({ comments: [] });
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual((await listComments(db, REF)).filter((c) => c.commentId === '8001'), [{ ...STORED_8001, blockHash: null, run }]);
  assert.equal(h.inputs[0]!.earlier?.threads.length, 1);
});
test('no verdict kept, no second read of the threads', async () => {
  await published();
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.writes.filter((w) => w[0] === 'listThreads').length, 1);
  assert.equal(h.logged.some((e) => e.event === 'thread_followup'), false);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('without the permission the thread is answered and not resolved', async () => {
  await published();
  const h = await live({ threads: [[THREAD]], canResolve: false, result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.writes.filter((w) => w[0] === 'replyToThread' || w[0] === 'resolveThread'), [['replyToThread', 'PRRT_1', REPLY]]);
  const resolving = await live({ pullRequest: 8, threads: [[THREAD]], result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  resolving.deps.canResolve = () => Promise.reject(new Error('github_502'));
  await published({ pullRequest: 8 });
  await runReviewJob(resolving.job, resolving.deps);
  assert.deepEqual(resolving.writes.filter((w) => w[0] === 'replyToThread' || w[0] === 'resolveThread'), [['replyToThread', 'PRRT_1', REPLY]]);
});
test('a follow-up that fails leaves the job published', async () => {
  await published();
  const h = await live({ threads: [[THREAD]], threadWriteFails: true, result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
  assert.deepEqual(h.logged.filter((e) => e.event === 'thread_followup').map((e) => [e.replied, e.resolved, e.failed]), [[0, 0, 1]]);
  await published({ pullRequest: 8 });
  const unread = await live({ pullRequest: 8, threads: [[THREAD], new Error('github_502')], result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  await runReviewJob(unread.job, unread.deps);
  assert.deepEqual(unread.logged.filter((e) => e.event === 'thread_followup_failed'), [{ event: 'thread_followup_failed', job: unread.job.id, reason: 'github_502' }]);
  const j = await getJob(db, unread.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'published']);
  assert.equal(unread.writes.some((w) => w[0] === 'replyToThread'), false);
});
test('a recorded review that is published by a later start writes its verdicts too', async () => {
  await published();
  await recorded({ result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs.length, 0);
  assert.deepEqual(h.writes.map((w) => w[0]), ['listOwnReviews', 'publishReview', 'listReviewComments', 'listThreads', 'replyToThread', 'resolveThread']);
  assert.deepEqual(h.writes[4], ['replyToThread', 'PRRT_1', REPLY]);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
  // the review was posted already: publishRun adopts it, and its verdicts are written under its id
  const ref8 = { ...REF, number: 8 };
  await published({ pullRequest: 8 });
  await recorded({ ref: ref8, result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  const adopted = await live({ pullRequest: 8, own: [[{ id: '502', commit: 'h1' }, { id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(adopted.job, adopted.deps);
  assert.equal(adopted.writes.some((w) => w[0] === 'publishReview'), false);
  assert.deepEqual(adopted.writes.filter((w) => w[0] === 'replyToThread'), [['replyToThread', 'PRRT_1', REPLY.replace('review=501', 'review=502')]]);
  assert.deepEqual(adopted.logged.filter((e) => e.event === 'thread_followup').map((e) => e.review), ['502']);
});
test('a retargeted pull request at a head already reviewed is reviewed and posted, not adopted', async () => {
  await published({ head: 'h1' });
  const h = await live({ live: OTHER_BASE, own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs.length, 1);
  assert.equal(h.writes.filter((w) => w[0] === 'publishReview').length, 1);
  const newest = (await listRuns(db, REF)).at(-1)!;
  assert.deepEqual([newest.baseSha, newest.published, newest.reviewId], ['merge999', true, '501']);
});
test('in dry run a later head is reviewed as before, and nothing is read or written', async () => {
  await published();
  const h = await harness({ dryRun: true });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.writes, []);
  assert.equal(h.inputs[0]!.earlier, null);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'reviewed');
});
test('the review entry counts the threads that were due, the verdicts and the duplicates', async () => {
  await published();
  const h = await live({ threads: [[THREAD]], result: okResult({ threadVerdicts: [VERDICT], threadsDue: 1 }) });
  await runReviewJob(h.job, h.deps);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.threads_due, entry.verdicts, entry.duplicates], [1, 1, 0]);
  await recorded({ ref: { ...REF, number: 8 } });
  const resumed = await live({ pullRequest: 8 });
  await runReviewJob(resumed.job, resumed.deps);
  const stored = resumed.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([stored.resumed, stored.threads_due, stored.verdicts, stored.duplicates], [true, 0, 0, 0]);
});

/** The rows of block_scores, oldest first. */
const blockRows = (): Promise<Array<{ run: number; number: number; path: string; hash: string; score: number; category: string; reason: string; scored_by: string; scored_at: Date }>> =>
  db.query('select run, number, path, hash, score, category, reason, scored_by, scored_at from visto_ai.block_scores order by id');
/** A finished review with flaggedResult's one scored block. */
const scoredResult = (over: Partial<ReviewResult> = {}): ReviewResult => okResult({ scores: flaggedResult().scores, verdict: flaggedResult().verdict, ...over });
const OWN_401 = [[{ id: '401', commit: 'h0' }]];

test('a push after a review is reviewed incrementally, with the history of the earlier runs', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401 });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs[0]!.mode, h.inputs[0]!.history?.lastReview?.head, h.inputs[0]!.history?.by], ['incremental', 'h0', 'model']);
  assert.deepEqual([(await listRuns(db, REF)).at(-1)!.mode, (await listRuns(db, REF)).at(-1)!.baseBranch], ['incremental', 'main']);
});
test('a later review is given the rows of the newest published review, and a dry run none', async () => {
  const kept = { criterion: 'Orders above the limit are refused.', status: 'met', note: 'In src/orders/limit.ts:42.', from: 'review' };
  await published({ head: 'h0', result: okResult({ findings: [MAJOR], acceptance: [kept as never] }) });
  await published({ head: 'h0', mode: 'recheck', reviewId: '402', comments: [], result: okResult({ acceptance: [{ ...kept, status: 'not_met', note: 'Not refused.' } as never] }) });
  await published({ head: 'h0', reviewId: '403', comments: [], result: okResult() });
  await recorded({ headSha: 'h0', result: okResult({ acceptance: [{ ...kept, note: 'Never published.' } as never] }) });
  const h = await live({ own: [[{ id: '403', commit: 'h0' }, { id: '402', commit: 'h0' }, { id: '401', commit: 'h0' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.inputs[0]!.earlierAcceptance, [{ ...kept, status: 'not_met', note: 'Not refused.' }]);
  const first = await live({ pullRequest: 8 });
  await runReviewJob(first.job, first.deps);
  assert.deepEqual(first.inputs[0]!.earlierAcceptance, []);
  const dry = await harness({ dryRun: true });
  await runReviewJob(dry.job, dry.deps);
  assert.equal('earlierAcceptance' in dry.inputs[0]!, false);
});
test('a repository set to full is reviewed in full at every head, with its history', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401, settings: { ...SETTINGS, newHead: 'full' } });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs[0]!.mode, h.inputs[0]!.history?.lastReview?.head], ['full', 'h0']);
  assert.equal((await listRuns(db, REF)).at(-1)!.mode, 'full');
});
test('a first review is a full review with an empty history', async () => {
  const h = await live();
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs[0]!.mode, 'full');
  assert.deepEqual([h.inputs[0]!.history?.files, h.inputs[0]!.history?.lastReview, h.inputs[0]!.history?.shown], [[], null, null]);
  assert.equal((await listRuns(db, REF))[0]!.mode, 'full');
});
test('a pull request moved to another base branch is reviewed in full', async () => {
  await published({ baseBranch: 'main' });
  const h = await live({ own: OWN_401, live: { ...LIVE, info: { ...LIVE.info, baseBranch: 'release' } } });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs[0]!.mode, 'full');
  assert.deepEqual([(await listRuns(db, REF)).at(-1)!.mode, (await listRuns(db, REF)).at(-1)!.baseBranch], ['full', 'release']);
});
test('a review stored before base branches were kept is followed by one full review', async () => {
  await published({ baseBranch: null });
  const h = await live({ own: OWN_401 });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs[0]!.mode, 'full');
  const next = await live({ head: 'h2', own: [[{ id: '501', commit: 'h1' }, { id: '401', commit: 'h0' }]] });
  await runReviewJob(next.job, next.deps);
  assert.equal(next.inputs[0]!.mode, 'incremental');
});
test('a /review on a head that has its review is a re-check, not a refusal', async () => {
  await published({ head: 'h1' });
  const h = await manualJob({ own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.writes.some((w) => w[0] === 'react' && w[2] === 'eyes'), true);
  assert.equal(h.writes.some((w) => w[0] === 'react' && w[2] === 'confused'), false);
  assert.equal(h.writes.some((w) => w[0] === 'comment' && String(w[1]).includes('was not started')), false);
  assert.deepEqual([h.inputs[0]!.mode, h.inputs[0]!.history?.lastReview?.head, (await getJob(db, h.job.id))?.outcome], ['recheck', 'h1', 'published']);
  assert.equal((await listRuns(db, REF)).at(-1)!.mode, 'recheck');
});
test('a /review on a head whose review was stored before this plan is a re-check too', async () => {
  const old: Record<string, unknown> = { ...EARLIER_RESULT };
  delete old['mode'];
  await published({ head: 'h1', baseBranch: null, result: old });
  const h = await manualJob({ own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs[0]!.mode, (await getJob(db, h.job.id))?.outcome], ['recheck', 'published']);
});
test('a push on a head that has its review is still dropped', async () => {
  await published({ head: 'h1' });
  const h = await live({ own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.status, (await getJob(db, h.job.id))?.outcome, h.inputs.length], ['dropped', 'already_reviewed', 0]);
});
test('a /review on a head with a review the database does not know is still refused', async () => {
  await published({ head: 'h1' });
  const h = await manualJob({ own: [[{ id: '470', commit: 'h1' }, { id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs.length, (await getJob(db, h.job.id))?.outcome], [0, 'refused']);
  assert.deepEqual(h.writes.at(-1), ['comment', '@octo-lead The review was not started (`already_reviewed`).']);
});
test('a /review on a reviewed head does not post a leftover row of the review that is already there', async () => {
  const leftover = await recorded({ headSha: 'h1', baseBranch: 'main' });
  await published({ head: 'h1' });
  const h = await manualJob({ own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs.length, h.inputs[0]!.mode, (await getJob(db, h.job.id))?.outcome], [1, 'recheck', 'published']);
  const runs = await listRuns(db, REF);
  assert.equal(runs.find((r) => r.id === leftover)!.published, false);
  assert.deepEqual([runs.length, runs.at(-1)!.published, runs.at(-1)!.mode], [3, true, 'recheck']);
});
test('a /review on a reviewed head publishes a stored review newer than the published one, as it was recorded', async () => {
  await published({ head: 'h1' });
  const waiting = await recorded({ headSha: 'h1', baseBranch: 'main', mode: 'incremental', result: okResult({ mode: 'incremental', since: 'h0' }) });
  const stored = (await listRuns(db, REF)).find((r) => r.id === waiting)!;
  const h = await manualJob({ own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs.length, (await getJob(db, h.job.id))?.outcome], [0, 'published']);
  const posts = h.writes.filter((w) => w[0] === 'publishReview');
  assert.deepEqual(posts, [['publishReview', 'h1', stored.body, 1]]);
  assert.equal(String(posts[0]![2]).split('\n')[0], stored.body.split('\n')[0]);
  const after = (await listRuns(db, REF)).find((r) => r.id === waiting)!;
  assert.deepEqual([after.published, after.mode], [true, 'incremental']);
});
test('a review the engine threw on is stored with the mode that was decided', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401 });
  h.deps.review = () => Promise.reject(new Error('boom'));
  await runReviewJob(h.job, h.deps);
  const run = (await listRuns(db, REF)).at(-1)!;
  assert.deepEqual([run.outcome, run.failureStage, run.mode], ['failed', 'engine', 'incremental']);
});
test('a re-check is not the last review: the next push is planned from the review before it', async () => {
  await published({ head: 'h0', result: okResult({ overview: 'First.' }) });
  const recheck = okResult({ mode: 'recheck', overview: 'Second.', scores: flaggedResult().scores, verdict: flaggedResult().verdict });
  await published({ head: 'h0', mode: 'recheck', reviewId: '402', comments: [], result: recheck });
  const h = await live({ own: [[{ id: '402', commit: 'h0' }, { id: '401', commit: 'h0' }]] });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs[0]!.history?.lastReview?.overview, 'First.');
  assert.equal(h.inputs[0]!.history?.shown, shownOf(recheck));
  assert.notEqual(shownOf(recheck), shownOf(okResult({ overview: 'First.' })));
});
test('with a scorer in force the history and the stored scores are the scorer\'s', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401, result: scoredResult({ mode: 'incremental' }) });
  h.deps.engineDeps = () => ({ scorer: { score: () => Promise.reject(new Error('not_expected')) } }) as unknown as ReviewDeps;
  await runReviewJob(h.job, h.deps);
  assert.equal(h.inputs[0]!.history?.by, 'scorer');
  assert.deepEqual((await blockRows()).map((r) => [r.hash, r.scored_by]), [['h', 'scorer']]);
});
test('with nothing new a push is finished without a review', async () => {
  await published({ head: 'h0' });
  const nothing = okResult({ nothingToDo: true, mode: 'incremental' });
  const h = await live({ own: OWN_401, threads: [[THREAD]], result: nothing });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.status, (await getJob(db, h.job.id))?.outcome], ['done', 'nothing_new']);
  const run = (await listRuns(db, REF)).at(-1)!;
  assert.deepEqual([run.outcome, run.body, run.comments, run.published, run.mode], ['ok', '', [], false, 'incremental']);
  assert.equal(h.writes.some((w) => w[0] === 'publishReview'), false);
  assert.equal(h.writes.filter((w) => w[0] === 'listThreads').length, 1);
  assert.equal(h.writes.some((w) => w[0] === 'react' || w[0] === 'comment'), false);
});
test('a second start on a head that had nothing new publishes nothing', async () => {
  await published({ head: 'h0' });
  const nothing = okResult({ nothingToDo: true, mode: 'incremental' });
  const first = await live({ own: OWN_401, result: nothing });
  await runReviewJob(first.job, first.deps);
  const again = await live({ own: OWN_401, result: nothing });
  await runReviewJob(again.job, again.deps);
  assert.deepEqual([again.inputs.length, (await getJob(db, again.job.id))?.outcome], [1, 'nothing_new']);
  assert.equal(again.writes.some((w) => w[0] === 'publishReview'), false);
});
test('with nothing new a command gets its review', async () => {
  await published({ head: 'h0' });
  const h = await manualJob({ own: OWN_401, result: okResult({ nothingToDo: true, mode: 'incremental' }) });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
  assert.equal(h.writes.filter((w) => w[0] === 'publishReview').length, 1);
});
test('a review with no model call that is not nothing new is published', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401, result: okResult({ mode: 'incremental', usage: NO_CALLS, coverage: { reviewed: [], notReviewed: [{ path: 'logo.bin', reason: 'no_diff' }] } }) });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
});
test('the scores a run gave are stored for other pull requests', async () => {
  const h = await live({ result: scoredResult() });
  await runReviewJob(h.job, h.deps);
  const [run] = await listRuns(db, REF);
  assert.deepEqual((await blockRows()).map((r) => [r.run, r.number, r.path, r.hash, r.score, r.category, r.reason, r.scored_by, r.scored_at.toISOString()]),
    [[run!.id, 7, 'a.ts', 'h', 80, 'calculation', '', 'model', run!.finishedAt]]);
});
test('a failure to store the scores changes nothing, and they are stored once', async () => {
  const h = await live({ result: scoredResult() });
  let attempts = 0;
  const inner = h.deps.db;
  h.deps.db = {
    ...inner,
    query: (text, params) => {
      if (text.includes('insert into visto_ai.block_scores')) { attempts += 1; return Promise.reject(new Error('Something private broke')); }
      return inner.query(text, params);
    },
  };
  await runReviewJob(h.job, h.deps);
  const runs = await listRuns(db, REF);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, runs.length, attempts, (await blockRows()).length], ['published', 1, 1, 0]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'scores_store_failed'), [{ event: 'scores_store_failed', job: h.job.id, run: runs[0]!.id, reason: 'internal_error' }]);
});
test('the scores of a run whose text could not be rendered are stored, and a resumed run stores none again', async () => {
  const unrendered = await live({ renderThrows: true });
  await runReviewJob(unrendered.job, unrendered.deps);
  assert.equal((await getJob(db, unrendered.job.id))?.outcome, 'render_failed');
  assert.deepEqual((await blockRows()).map((r) => [r.number, r.hash]), [[7, 'h']]);
  const before = await live({ pullRequest: 8, result: scoredResult(), posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const again = await live({ pullRequest: 8, reuseJob: before.job.id, now: at(900) });
  await runReviewJob(again.job, again.deps);
  assert.deepEqual([again.inputs.length, (await getJob(db, again.job.id))?.outcome], [0, 'published']);
  assert.deepEqual((await blockRows()).map((r) => [r.number, r.hash]), [[7, 'h'], [8, 'h']]);
});
test('the scores of a push with nothing new are stored', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401, result: scoredResult({ nothingToDo: true, mode: 'incremental' }) });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'nothing_new');
  assert.deepEqual((await blockRows()).map((r) => [r.run, r.hash]), [[(await listRuns(db, REF)).at(-1)!.id, 'h']]);
});
test('the engine can look up scores other pull requests stored in the last 30 days', async () => {
  const other = { ...REF, number: 8 };
  const day = 86_400;
  await recordBlockScores(db, 1, other, 'model', [{ path: 'src/a.ts', hash: 'k1', around: 's1', score: 60, category: 'calculation', reason: 'Totals.' }], at(-29 * day));
  await recordBlockScores(db, 2, other, 'model', [{ path: 'src/a.ts', hash: 'k2', around: 's1', score: 50, category: 'fix', reason: 'Old.' }], at(-31 * day));
  await recordBlockScores(db, 3, other, 'model', [{ path: 'src/a.ts', hash: 'k3', around: 's1', score: 40, category: 'made_up', reason: 'Odd.' }], at(-29 * day));
  const h = await live();
  await runReviewJob(h.job, h.deps);
  const lookUp = h.engines[0]!.reusableScores!;
  assert.deepEqual(await lookUp([{ path: 'src/a.ts', hash: 'k1', around: 's1' }, { path: 'src/a.ts', hash: 'k2', around: 's1' }, { path: 'src/a.ts', hash: 'k3', around: 's1' }]), [
    { path: 'src/a.ts', hash: 'k1', around: 's1', entry: { score: 60, category: 'calculation', reason: 'Totals.' } },
    { path: 'src/a.ts', hash: 'k3', around: 's1', entry: { score: 40, category: 'other', reason: 'Odd.' } },
  ]);
});
test('the engine looks up and stores scores with their surroundings', async () => {
  const other = { ...REF, number: 8 };
  await recordBlockScores(db, 1, other, 'model', [
    { path: 'src/a.ts', hash: 'k1', around: 's1', score: 60, category: 'calculation', reason: 'Totals.' },
    { path: 'src/a.ts', hash: 'k1', around: 's2', score: 90, category: 'billing', reason: 'Elsewhere.' },
    { path: 'src/a.ts', hash: 'k1', around: null, score: 95, category: 'billing', reason: 'Old.' },
  ], at(-60));
  const withAround = scoredResult();
  withAround.scores[0]!.blocks[0]!.around = 's9';
  const h = await live({ result: withAround });
  await runReviewJob(h.job, h.deps);
  const lookUp = h.engines[0]!.reusableScores!;
  assert.deepEqual(await lookUp([{ path: 'src/a.ts', hash: 'k1', around: 's1' }, { path: 'src/a.ts', hash: 'k1', around: 's3' }]), [
    { path: 'src/a.ts', hash: 'k1', around: 's1', entry: { score: 60, category: 'calculation', reason: 'Totals.' } },
  ]);
  const rows = await db.query<{ number: number; hash: string; around: string | null }>('select number, hash, around from visto_ai.block_scores where number = 7 order by id');
  assert.deepEqual(rows, [{ number: 7, hash: 'h', around: 's9' }]);
});
test('in dry run nothing of this happens', async () => {
  await published({ head: 'h0' });
  const h = await harness({ dryRun: true, result: scoredResult() });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(['mode' in h.inputs[0]!, 'history' in h.inputs[0]!, 'reusableScores' in h.engines[0]!], [false, false, false]);
  assert.deepEqual(await blockRows(), []);
  assert.equal((await listRuns(db, REF)).at(-1)!.mode, 'full');
});
test('the review entry says the mode, the count and whether nothing was new', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401 });
  await runReviewJob(h.job, h.deps);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.mode, entry.blocking_on_unchanged, entry.nothing_new], ['incremental', null, false]);
  await published({ head: 'h0', pullRequest: 8 });
  const full = await live({ pullRequest: 8, own: OWN_401, settings: { ...SETTINGS, newHead: 'full' }, result: okResult({ blockingOnUnchanged: 2 }) });
  await runReviewJob(full.job, full.deps);
  const later = full.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([later.mode, later.blocking_on_unchanged, later.nothing_new], ['full', 2, false]);
  const nothing = await live({ pullRequest: 9, result: okResult({ nothingToDo: true, mode: 'incremental' }) });
  await runReviewJob(nothing.job, nothing.deps);
  assert.equal(nothing.logged.find((e) => e.event === 'review')!.nothing_new, true);
});
test('a review with nothing new whose text cannot be rendered still ends as nothing new', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401, renderThrows: true, result: { ...flaggedResult(), nothingToDo: true, mode: 'incremental' } });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'nothing_new');
  assert.equal(h.logged.some((e) => e.event === 'render_failed'), true);
  assert.equal(h.writes.some((w) => w[0] === 'publishReview'), false);
});
test('a review adopted late is the last review the mode is worked out from', async () => {
  await recorded({ headSha: 'h0', result: EARLIER_RESULT, baseBranch: 'main' });
  const h = await live({ own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs[0]!.mode, h.inputs[0]!.history?.lastReview?.head], ['incremental', 'h0']);
});
test('a write tried again that finds the job finished stores no scores under the run that was rolled back', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401, result: scoredResult({ nothingToDo: true, mode: 'incremental' }) });
  const inner = h.deps.db;
  let first = true;
  h.deps.db = {
    ...inner,
    transaction: async (work) => {
      let recordedRun = false;
      try {
        return await inner.transaction(async (tx) => {
          const out = await work({ ...tx, query: (text, params) => { if (text.includes('insert into visto_ai.review_runs')) recordedRun = true; return tx.query(text, params); } });
          if (first && recordedRun) throw new Error('db_down');
          return out;
        });
      } catch (error) {
        // Rolled back; before the write is tried again another start finishes the job.
        if (first && recordedRun) { first = false; await finishJob(db, h.job.id, 'done', 'nothing_new', at(0)); }
        throw error;
      }
    },
  };
  await runReviewJob(h.job, h.deps);
  assert.equal(first, false);
  assert.deepEqual(await blockRows(), []);
  assert.equal(h.logged.some((e) => e.event === 'scores_store_failed'), false);
});
test('the review entry says nothing was new only when the job ended so', async () => {
  await published({ head: 'h0' });
  const h = await manualJob({ own: OWN_401, result: okResult({ nothingToDo: true, mode: 'incremental' }) });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
  assert.equal(h.logged.find((e) => e.event === 'review')!.nothing_new, false);
});

const NOTES_ON: RepoSettings = { ...SETTINGS, inlineNotes: true, gate: GATE_OFF };
/** A finished review, with okResult's finding, whose file a.ts has one block for each [hash, score, line] given. */
const blocksResult = (blocks: Array<[string, number, number]>, over: Partial<ReviewResult> = {}): ReviewResult => {
  const highest = Math.max(...blocks.map(([, score]) => score));
  return okResult({
    scores: [{
      path: 'a.ts', previousPath: null, diffHash: 'd', changeSummary: '', changedLines: blocks.length, wholeFile: null, fileLevel: null, finalScore: highest, covered: true,
      blocks: blocks.map(([hash, score, line], i): BlockScore => ({
        id: `B${i + 1}`, hunk: `B${i + 1}`, hunkHash: hash, hash, changedLines: 1, span: { side: 'RIGHT', first: line, last: line },
        lines: { old: [], new: [] } as unknown as BlockScore['lines'], entry: { score, category: 'calculation', reason: 'Totals.' },
      })),
    }],
    verdict: { threshold: 70, needsHuman: highest >= 70, highest },
    ...over,
  });
};
/** The entries of a list of comments, posted or recorded, that are notes. */
const notesIn = (comments: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(comments) ? comments as unknown[] : []).filter((c): c is Record<string, unknown> => typeof (c as { note?: unknown } | null)?.note === 'string');
/** The hashes of the blocks the notes among these comments are for. */
const notedBlocks = (comments: unknown): unknown[] => notesIn(comments).map((c) => c.note);
/** A stored note for the block `hash` of a.ts. */
const noteRow = (hash: string, commentId = '8100'): StoredComment => ({ commentId, path: 'a.ts', side: 'RIGHT', line: 10, severity: 'note', quote: '', blockHash: hash });
/** The rendered finding's comments and notes of a result, as a run records them. */
const recordedComments = (result: ReviewResult): unknown[] => [
  ...renderReview(result, { trigger: 'automatic', requestedBy: null, lineUrl: () => 'https://git.example.test/x', inline: true }).comments,
  ...renderNotes(result, new Set()),
];
/** The threads a review's draft opened on the pull request, one for each of its comments, their ids from `firstId` on. */
const threadsOf = (draft: ReviewDraft, reviewId: string, firstId: number): ReviewThread[] => draft.comments.map((c, i) => ({
  id: `PRRT_${firstId + i}`, path: c.path, side: c.side, line: c.line, resolved: false, resolvedByApp: false,
  comments: [{ id: String(firstId + i), node: `PRRC_${firstId + i}`, author: 'visto-test[bot]', authorIsBot: true, byApp: true, reviewId, body: c.body, at: at(-100) }],
}));
const noteRows = async (number = 7): Promise<Array<[string, string | null | undefined, number]>> =>
  (await listComments(db, { ...REF, number })).filter((c) => c.severity === 'note').map((c) => [c.path, c.blockHash, c.run]);

test('with inline notes on, a review is posted with a note for each flagged block', async () => {
  const result = blocksResult([['hA', 85, 10], ['hB', 30, 20]]);
  const h = await live({ settings: NOTES_ON, result, echo: true });
  await runReviewJob(h.job, h.deps);
  const [draft] = h.drafts;
  assert.equal(draft!.comments.length, result.findings.length + 1);
  const note = draft!.comments.at(-1)!;
  assert.ok(note.body.startsWith('**Human review:**'));
  assert.deepEqual(notedBlocks(draft!.comments), ['hA']);
  const [run] = await listRuns(db, REF);
  assert.deepEqual((run!.comments as unknown[]).at(-1), renderNotes(result, new Set())[0]);
  assert.equal(((run!.comments as unknown[]).at(-1) as { body: string }).body, note.body);
});
test('with inline notes on, the read-back stores the note with its block', async () => {
  const h = await live({ settings: NOTES_ON, result: blocksResult([['hA', 85, 10], ['hB', 30, 20]]), echo: true });
  await runReviewJob(h.job, h.deps);
  const [run] = await listRuns(db, REF);
  assert.deepEqual(await noteRows(), [['a.ts', 'hA', run!.id]]);
});
test('with inline notes off nothing is noted', async () => {
  const result = blocksResult([['hA', 85, 10]]);
  const expected = renderReview(result, { trigger: 'automatic', requestedBy: null, lineUrl: () => 'https://git.example.test/x', inline: true }).comments;
  const h = await live({ result, echo: true });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.drafts.map((d) => d.comments), [expected]);
  assert.deepEqual((await listRuns(db, REF))[0]!.comments, expected);
  assert.deepEqual((await listComments(db, REF)).map((c) => c.severity), ['minor']);
});
test('a block that has its note is not noted again at the next review', async () => {
  await published({ comments: [STORED_8001, noteRow('hA')] });
  const h = await live({ settings: NOTES_ON, result: blocksResult([['hA', 85, 10], ['hB', 90, 20]]), echo: true });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(notedBlocks(h.drafts[0]!.comments), ['hB']);
});
test('notes GitHub refused are stored as no note, and the log says they were dropped', async () => {
  const first = await live({ settings: NOTES_ON, result: blocksResult([['hA', 85, 10]]), echo: true, posts: [new Error('review_rejected'), { id: '501' }] });
  await runReviewJob(first.job, first.deps);
  assert.deepEqual(first.drafts.map((d) => notedBlocks(d.comments)), [['hA'], []]);
  assert.deepEqual(await noteRows(), []);
  assert.equal(first.logged.find((e) => e.event === 'review')!.notes_dropped, true);
  const line = first.logged.find((e) => e.event === 'readback')!;
  assert.deepEqual([line.notes, line.notes_missing], [0, 0]);
});
test('notes GitHub refused are given at the next review', async () => {
  const result = blocksResult([['hA', 85, 10]]);
  const first = await live({ settings: NOTES_ON, result, echo: true, posts: [new Error('review_rejected'), { id: '501' }] });
  await runReviewJob(first.job, first.deps);
  const next = await live({ head: 'h2', settings: NOTES_ON, result, echo: true, posts: [{ id: '502' }] });
  await runReviewJob(next.job, next.deps);
  assert.deepEqual(notedBlocks(next.drafts[0]!.comments), ['hA']);
});
test('in dry run the notes are recorded and nothing is posted', async () => {
  const h = await harness({ settings: NOTES_ON, result: blocksResult([['hA', 85, 10]]) });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.writes, []);
  const [run] = await listRuns(db, REF);
  assert.deepEqual([run!.dryRun, run!.published, notedBlocks(run!.comments)], [true, false, ['hA']]);
});
test('a failed review records no note', async () => {
  const flagged = blocksResult([['hA', 85, 10]]);
  const h = await live({ settings: NOTES_ON, result: { ...flagged, status: 'failed', failure: { stage: 'model', code: 'timeout' }, dependencies: { model: 'error' } } });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual((await listRuns(db, REF))[0]!.comments, []);
  assert.equal(h.logged.find((e) => e.event === 'review')!.notes, 0);
});
test('a push that tells nothing new records no note', async () => {
  await published({ head: 'h0' });
  const h = await live({ own: OWN_401, settings: NOTES_ON, result: blocksResult([['hA', 85, 10]], { nothingToDo: true, mode: 'incremental' }) });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'nothing_new');
  assert.deepEqual((await listRuns(db, REF)).at(-1)!.comments, []);
  assert.equal(h.logged.find((e) => e.event === 'review')!.notes, 0);
});
test('the review entry counts the notes', async () => {
  const result = blocksResult([['hA', 85, 10]]);
  const on = await live({ settings: NOTES_ON, result, echo: true });
  await runReviewJob(on.job, on.deps);
  const onEntry = on.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([onEntry.notes, onEntry.notes_dropped], [1, false]);
  const off = await live({ pullRequest: 8, result, echo: true });
  await runReviewJob(off.job, off.deps);
  const offEntry = off.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([offEntry.notes, offEntry.notes_dropped], [0, false]);
});
test('the review entry has no notes_dropped when nothing was published', async () => {
  const h = await harness({ settings: NOTES_ON, result: blocksResult([['hA', 85, 10]]) });
  await runReviewJob(h.job, h.deps);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.notes, entry.notes_dropped], [1, null]);
});
test('the read-back line counts the notes stored and none missing', async () => {
  const h = await live({ settings: NOTES_ON, result: blocksResult([['hA', 85, 10]]), echo: true });
  await runReviewJob(h.job, h.deps);
  const [run] = await listRuns(db, REF);
  assert.deepEqual(h.logged.find((e) => e.event === 'readback'), { event: 'readback', job: h.job.id, run: run!.id, posted: 2, stored: 2, notes: 1, notes_missing: 0 });
});
test('the read-back line counts a note GitHub gave back changed as missing', async () => {
  const changed: PostedComment = { id: '9301', path: 'a.ts', side: 'RIGHT', line: 10, body: '**Human review:** line 10, changed' };
  const h = await live({ settings: NOTES_ON, result: blocksResult([['hA', 85, 10]]), posted: [...POSTED, changed] });
  await runReviewJob(h.job, h.deps);
  const [run] = await listRuns(db, REF);
  assert.deepEqual(h.logged.find((e) => e.event === 'readback'), { event: 'readback', job: h.job.id, run: run!.id, posted: 2, stored: 1, notes: 0, notes_missing: 1 });
});
test('a note whose read-back failed is known from its thread and is not posted again', async () => {
  const first = await live({ settings: NOTES_ON, result: blocksResult([['hA', 85, 10]]), posted: null, posts: [{ id: '501' }] });
  await runReviewJob(first.job, first.deps);
  assert.deepEqual(await listComments(db, REF), []);
  const [run] = await listRuns(db, REF);
  const next = await live({
    head: 'h2', settings: NOTES_ON, result: blocksResult([['hA', 85, 10], ['hB', 90, 20]]), threads: [threadsOf(first.drafts[0]!, '501', 7000)], echo: true, posts: [{ id: '502' }],
  });
  await runReviewJob(next.job, next.deps);
  assert.deepEqual(notedBlocks(next.drafts[0]!.comments), ['hB']);
  assert.deepEqual((await noteRows()).filter(([, , r]) => r === run!.id), [['a.ts', 'hA', run!.id]]);
});
test('a note whose read-back failed is known from its thread when recording the repair throws too', async () => {
  const first = await live({ settings: NOTES_ON, result: blocksResult([['hA', 85, 10]]), posted: null, posts: [{ id: '501' }] });
  await runReviewJob(first.job, first.deps);
  const next = await live({
    head: 'h2', settings: NOTES_ON, result: blocksResult([['hA', 85, 10], ['hB', 90, 20]]), threads: [threadsOf(first.drafts[0]!, '501', 7000)], echo: true, posts: [{ id: '502' }],
    failQuery: 'insert into visto_ai.review_comments',
  });
  await runReviewJob(next.job, next.deps);
  assert.equal(next.logged.some((e) => e.event === 'repair_failed'), true);
  assert.deepEqual(notedBlocks(next.drafts[0]!.comments), ['hB']);
});
test('an adopted review has its notes read back', async () => {
  const result = blocksResult([['hA', 85, 10]]);
  const comments = recordedComments(result) as Array<{ path: string; side: 'LEFT' | 'RIGHT'; line: number; body: string }>;
  const runId = await recorded({ result, comments });
  const posted = comments.map((c, i) => ({ id: String(9201 + i), path: c.path, side: c.side, line: c.line, body: c.body }));
  const h = await live({ settings: NOTES_ON, own: [[{ id: '502', commit: 'h1' }]], posted });
  await runReviewJob(h.job, h.deps);
  assert.equal(h.writes.some((w) => w[0] === 'publishReview'), false);
  assert.deepEqual((await listComments(db, REF)).map((c) => [c.commentId, c.severity, c.blockHash, c.run]), [['9201', 'minor', null, runId], ['9202', 'note', 'hA', runId]]);
  const line = h.logged.find((e) => e.event === 'readback')!;
  assert.deepEqual([line.stored, line.notes, line.notes_missing], [2, 1, 0]);
});
test('a review a later start publishes is posted without its notes', async () => {
  const result = blocksResult([['hA', 85, 10]]);
  await recorded({ result, comments: recordedComments(result) });
  const h = await live({ settings: NOTES_ON, echo: true });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.drafts.map((d) => d.comments), [renderReview(result, { trigger: 'automatic', requestedBy: null, lineUrl: () => 'https://git.example.test/x', inline: true }).comments]);
  const entry = h.logged.find((e) => e.event === 'review')!;
  assert.deepEqual([entry.resumed, entry.notes, entry.notes_dropped], [true, 1, true]);
});
test('the note a later start did not post is given at the next review', async () => {
  const result = blocksResult([['hA', 85, 10]]);
  await recorded({ result, comments: recordedComments(result) });
  const h = await live({ settings: NOTES_ON, echo: true });
  await runReviewJob(h.job, h.deps);
  const next = await live({ head: 'h2', settings: NOTES_ON, result, echo: true, posts: [{ id: '502' }] });
  await runReviewJob(next.job, next.deps);
  assert.deepEqual(notedBlocks(next.drafts[0]!.comments), ['hA']);
});
test('a review whose text could not be rendered records no note', async () => {
  const h = await live({ settings: NOTES_ON, renderThrows: true });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'render_failed');
  assert.deepEqual((await listRuns(db, REF))[0]!.comments, []);
  assert.equal(h.logged.find((e) => e.event === 'review')!.notes, 0);
});
test('notes switched off and on again are not repeated', async () => {
  await published({ comments: [STORED_8001, noteRow('hA')] });
  const off = await live({ result: blocksResult([['hA', 85, 10]]), echo: true });
  await runReviewJob(off.job, off.deps);
  assert.deepEqual(notedBlocks(off.drafts[0]!.comments), []);
  const on = await live({ head: 'h2', settings: NOTES_ON, result: blocksResult([['hA', 85, 10], ['hB', 90, 20]]), echo: true, posts: [{ id: '502' }] });
  await runReviewJob(on.job, on.deps);
  assert.deepEqual(notedBlocks(on.drafts[0]!.comments), ['hB']);
});
test('a note GitHub gives back with its reason changed is posted once, over three reviews', async () => {
  const result = blocksResult([['hA', 85, 10]]);
  const echoText = (body: string): string => body.replace('Totals.', 'Totals, changed.');
  const heads: Array<[string, string]> = [['h1', '501'], ['h2', '502'], ['h3', '503']];
  const posted: unknown[][] = [];
  for (const [head, id] of heads) {
    const h = await live({ head, settings: NOTES_ON, result, echo: true, echoText, posts: [{ id }] });
    await runReviewJob(h.job, h.deps);
    posted.push(notedBlocks(h.drafts[0]!.comments));
    assert.equal(h.logged.find((e) => e.event === 'readback')!.notes_missing, 0, head);
  }
  assert.deepEqual(posted, [['hA'], [], []]);
  assert.deepEqual((await noteRows()).map(([path, hash]) => [path, hash]), [['a.ts', 'hA']]);
});

/** A result with one flagged block whose hash cannot be read while notes are rendered: anything else reads it as hA. */
const notesThrowResult = (over: Partial<ReviewResult> = {}): ReviewResult => {
  const result = blocksResult([['hA', 85, 10]], over);
  Object.defineProperty(result.scores[0]!.blocks[0]!, 'hash', {
    enumerable: true,
    get: () => { if (new Error().stack?.includes('renderNotes') === true) throw new Error('Something private'); return 'hA'; },
  });
  return result;
};
test('notes that cannot be rendered are logged, with no text, and the review goes without them', async () => {
  const h = await live({ settings: NOTES_ON, result: notesThrowResult(), echo: true });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.logged.filter((e) => e.event === 'notes_failed'), [{ event: 'notes_failed', job: h.job.id }]);
  assert.deepEqual(notedBlocks(h.drafts[0]!.comments), []);
  assert.equal(h.drafts[0]!.comments.length, 1);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
  assert.ok(!JSON.stringify(h.logged).includes('Something private'));
});
test('a result whose status is not ok is given no note by the job: notes are not even rendered for it', async () => {
  const result = blocksResult([['hA', 85, 10]], { failure: { stage: 'model', code: 'timeout' }, dependencies: { model: 'error' } });
  // Its status cannot be read while notes are rendered: anything else reads it as failed.
  Object.defineProperty(result, 'status', {
    enumerable: true,
    get: () => { if (new Error().stack?.includes('renderNotes') === true) throw new Error('Something private'); return 'failed'; },
  });
  const h = await live({ settings: NOTES_ON, result });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.logged.filter((e) => e.event === 'notes_failed'), []);
  assert.deepEqual((await listRuns(db, REF))[0]!.comments, []);
});

const GATED: RepoSettings = { ...SETTINGS, gate: { ...GATE_OFF, enabled: true, branches: ['main'] } };
const SHADOW: RepoSettings = { ...SETTINGS, gate: { ...GATED.gate, mode: 'shadow' } };
const REPLY_OFF = (settings: RepoSettings): RepoSettings => ({ ...settings, gate: { ...settings.gate, clearByReply: false } });
const MOVED: LivePullRequest = { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } };
const MOVED_AGAIN: LivePullRequest = { ...LIVE, info: { ...LIVE.info, headSha: 'h3' } };
const pendingOf = async (number: number): Promise<Job[]> => (await unfinishedJobs(db)).filter((j) => j.ref.number === number && j.status === 'pending');

test('a push\'s job for a pull request that became gated is dropped', async () => {
  for (const [settings, number] of [[GATED, 7], [{ ...GATED, gate: { ...GATED.gate, mode: 'bypass' as const } }, 8]] as const) {
    await published({ pullRequest: number });
    const h = await live({ settings, pullRequest: number, own: OWN_401 });
    await runReviewJob(h.job, h.deps);
    const job = await getJob(db, h.job.id);
    assert.deepEqual([job?.status, job?.outcome, h.inputs.length, h.writes], ['dropped', 'gated', 0, []]);
    assert.deepEqual(h.logged, [{ event: 'job', job: h.job.id, repo: 'acme/shop', number, outcome: 'dropped', reason: 'gated' }]);
    assert.equal((await listRuns(db, { ...REF, number })).length, 1);
  }
  assert.deepEqual(await db.query("select id from visto_ai.jobs where kind = 'gate'"), []);
});
test('in shadow a push\'s job reviews and publishes as before', async () => {
  const entries = async (settings: RepoSettings, number: number): Promise<unknown[]> => {
    await published({ pullRequest: number });
    const h = await live({ settings, pullRequest: number, own: OWN_401 });
    await runReviewJob(h.job, h.deps);
    assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.inputs[0]!.mode], ['published', 'incremental']);
    return h.logged.map((e) => ({ ...e, job: null, number: null, run: null }));
  };
  assert.deepEqual(await entries(SHADOW, 8), await entries(SETTINGS, 9));
});
test('a gated pull request gets a full review at a new head unless the repository says otherwise', async () => {
  const modeOf = async (settings: RepoSettings, number: number): Promise<unknown[]> => {
    await published({ pullRequest: number });
    const h = await manualJob({ reason: 'done', settings, pullRequest: number, own: OWN_401 });
    await runReviewJob(h.job, h.deps);
    return [h.inputs[0]!.mode, (await listRuns(db, { ...REF, number })).at(-1)!.mode, (await getJob(db, h.job.id))?.outcome];
  };
  assert.deepEqual(await modeOf(GATED, 7), ['full', 'full', 'published']);
  assert.deepEqual(await modeOf({ ...GATED, newHead: 'incremental' }, 8), ['incremental', 'incremental', 'published']);
  assert.deepEqual(await modeOf({ ...GATED, gate: { ...GATED.gate, mode: 'bypass' } }, 9), ['full', 'full', 'published']);
  assert.deepEqual(await modeOf(SHADOW, 10), ['incremental', 'incremental', 'published']);
  assert.deepEqual(await modeOf(SETTINGS, 11), ['incremental', 'incremental', 'published']);
  assert.deepEqual(await modeOf({ ...GATED, gate: { ...GATED.gate, branches: ['release'] } }, 12), ['incremental', 'incremental', 'published']);
});
test('a /done on the head and base of the last review is a re-check', async () => {
  await published({ head: 'h1' });
  const h = await manualJob({ reason: 'done', settings: GATED, own: [[{ id: '401', commit: 'h1' }]] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.inputs[0]!.mode, (await listRuns(db, REF)).at(-1)!.mode, (await getJob(db, h.job.id))?.outcome], ['recheck', 'recheck', 'published']);
});
test('with clearing by reply off a resolved thread with a person\'s reply is judged again', async () => {
  const RESOLVED: ReviewThread = { ...THREAD, resolved: true };
  const settledUnder = async (settings: RepoSettings, number: number): Promise<unknown> => {
    await published({ pullRequest: number });
    const h = await manualJob({ reason: 'done', settings, pullRequest: number, own: OWN_401, threads: [[RESOLVED]] });
    await runReviewJob(h.job, h.deps);
    return h.inputs[0]!.earlier?.threads.map((t) => [t.id, t.resolved, t.settled]);
  };
  assert.deepEqual(await settledUnder(REPLY_OFF(GATED), 7), [['PRRT_1', true, false]]);
  assert.deepEqual(await settledUnder(REPLY_OFF({ ...GATED, gate: { ...GATED.gate, mode: 'bypass' } }), 8), [['PRRT_1', true, false]]);
  assert.deepEqual(await settledUnder(GATED, 9), [['PRRT_1', true, true]]);
  assert.deepEqual(await settledUnder(REPLY_OFF(SHADOW), 10), [['PRRT_1', true, true]]);
  assert.deepEqual(await settledUnder(REPLY_OFF(SETTINGS), 11), [['PRRT_1', true, true]]);
  assert.deepEqual(await settledUnder(REPLY_OFF({ ...GATED, gate: { ...GATED.gate, branches: ['release'] } }), 12), [['PRRT_1', true, true]]);
});
test('with approval on the earlier state is judged under the thread rule in force, the live author and clearing by reply', async () => {
  // The reply is by octo-dev, the live author, as a member: under the strict rule only being the author keeps it from closing the thread.
  const RESOLVED: ReviewThread = { ...THREAD, resolved: true, comments: [THREAD.comments[0]!, { ...THREAD.comments[1]!, association: 'member' }] };
  const under = async (settings: RepoSettings, number: number): Promise<unknown> => {
    await published({ pullRequest: number });
    const h = await manualJob({ reason: 'done', settings, pullRequest: number, own: OWN_401, threads: [[RESOLVED]] });
    await runReviewJob(h.job, h.deps);
    return h.inputs[0]!.earlier?.threads.map((t) => [t.id, t.settled, 'closedForApproval' in t ? t.closedForApproval : 'absent']);
  };
  const approving = (threads: 'strict' | 'gate', enabled = true): RepoSettings => ({ ...SETTINGS, approval: { enabled, threads, auditShare: 0 } });
  // The reply is the live author's own: it closes nothing under the strict rule.
  assert.deepEqual(await under(approving('strict'), 7), [['PRRT_1', false, false]]);
  assert.deepEqual(await under(approving('gate'), 8), [['PRRT_1', true, true]]);
  assert.deepEqual(await under(REPLY_OFF(approving('gate')), 9), [['PRRT_1', false, false]]);
  // Approval written but off, and not written: what it was.
  assert.deepEqual(await under(approving('strict', false), 10), [['PRRT_1', true, 'absent']]);
  assert.deepEqual(await under(SETTINGS, 11), [['PRRT_1', true, 'absent']]);
});
test('a /done review and a re-run start over once when the head moved, with the fields of who asked', async () => {
  const done = await manualJob({ reason: 'done', settings: GATED, liveAfter: MOVED });
  await runReviewJob(done.job, done.deps);
  assert.deepEqual([(await getJob(db, done.job.id))?.outcome, done.writes.some((w) => w[0] === 'comment' || w[0] === 'react')], ['head_moved', false]);
  const [retry, ...others] = await pendingOf(7);
  assert.deepEqual(others, []);
  assert.deepEqual([retry!.kind, retry!.trigger, retry!.reason, retry!.headSha, retry!.requestedBy, retry!.commentId, retry!.association, retry!.installation, retry!.runAt],
    ['review', 'manual', 'done_retry', '', 'octo-lead', '31', 'member', '99', at(0)]);

  const rerun = await manualJob({ reason: 'rerun', settings: GATED, pullRequest: 8, requestedBy: 'octo-dev', commentId: null, association: null, liveAfter: MOVED });
  await runReviewJob(rerun.job, rerun.deps);
  assert.equal((await getJob(db, rerun.job.id))?.outcome, 'head_moved');
  const [again] = await pendingOf(8);
  assert.deepEqual([again!.trigger, again!.reason, again!.requestedBy, again!.commentId, again!.association, again!.installation],
    ['manual', 'rerun_retry', 'octo-dev', null, null, '99']);

  // A retry whose head moved again does not start over: the live head gets a push's job, and the one who asked is told.
  const second = await manualJob({ reuseJob: retry!.id, settings: GATED, live: MOVED, liveAfter: MOVED_AGAIN });
  await runReviewJob(second.job, second.deps);
  assert.deepEqual([(await getJob(db, second.job.id))?.outcome, second.writes.at(-1)], ['head_moved', ['comment', '@octo-lead The review did not finish (`head_moved`).']]);
  assert.deepEqual((await pendingOf(7)).map((j) => [j.trigger, j.reason, j.headSha, j.runAt]), [['automatic', 'synchronize', 'h3', at(180)]]);
  const third = await manualJob({ reuseJob: again!.id, settings: GATED, pullRequest: 8, live: MOVED, liveAfter: MOVED_AGAIN });
  await runReviewJob(third.job, third.deps);
  assert.deepEqual([(await getJob(db, third.job.id))?.outcome, third.writes.filter((w) => w[0] === 'comment' || w[0] === 'react')], ['head_moved', []]);
  assert.deepEqual((await pendingOf(8)).map((j) => [j.trigger, j.reason, j.headSha]), [['automatic', 'synchronize', 'h3']]);
  assert.equal(third.logged.some((e) => e.event === 'answer_failed'), false);
});
test('a push\'s job already waiting when a /done review ends head_moved is replaced by the done_retry', async () => {
  const done = await manualJob({ reason: 'done', settings: GATED, liveAfter: MOVED });
  const push = (await enqueueJob(db, { ref: REF, reason: 'synchronize', headSha: 'h2', runAt: at(180), now: at(1), delivery: 'd9', replace: true, ...AUTOMATIC }))!;
  await runReviewJob(done.job, done.deps);
  assert.equal((await getJob(db, done.job.id))?.outcome, 'head_moved');
  assert.deepEqual((await pendingOf(7)).map((j) => [j.id, j.trigger, j.reason, j.headSha, j.requestedBy, j.runAt]), [[push, 'manual', 'done_retry', '', 'octo-lead', at(0)]]);
});
/** The head the service stores for the pull request moves on, as a push's event after the job started would move it; `at` is when GitHub says it was updated. */
const moveStored = (number: number, head = 'h2', updatedAt = at(5)) =>
  db.query('update visto_ai.pull_requests set head_sha = $2, updated_at = $3::timestamptz where number = $1', [number, head, updatedAt]);
const TIMEOUT = () => failed('model', 'timeout', { dependencies: { model: 'error' } });
/** What the job told the one who asked about its end: a comment or a confused reaction (the eyes of an accepted command are not). */
const endAnswers = (writes: unknown[][]): unknown[][] => writes.filter((w) => w[0] === 'comment' || (w[0] === 'react' && w[2] === 'confused'));

test('a manual review that fails, cannot be rendered or is refused while the stored head moved starts over once, and says nothing: the retry answers', async () => {
  const fails = await manualJob({ reason: 'done', settings: GATED, result: TIMEOUT() });
  await moveStored(7);
  await runReviewJob(fails.job, fails.deps);
  assert.equal((await getJob(db, fails.job.id))?.outcome, 'failed');
  assert.deepEqual((await pendingOf(7)).map((j) => [j.kind, j.trigger, j.reason, j.headSha, j.requestedBy, j.commentId, j.association, j.installation, j.runAt]),
    [['review', 'manual', 'done_retry', '', 'octo-lead', '31', 'member', '99', at(0)]]);
  assert.deepEqual(endAnswers(fails.writes), []);

  // Not gated: a /review starts over too.
  const unrendered = await manualJob({ pullRequest: 8, renderThrows: true });
  await moveStored(8);
  await runReviewJob(unrendered.job, unrendered.deps);
  assert.equal((await getJob(db, unrendered.job.id))?.outcome, 'render_failed');
  assert.deepEqual((await pendingOf(8)).map((j) => [j.trigger, j.reason, j.requestedBy, j.commentId]), [['manual', 'command_retry', 'octo-lead', '31']]);
  assert.deepEqual(endAnswers(unrendered.writes), []);

  const rejected = await manualJob({ reason: 'rerun', settings: GATED, pullRequest: 9, requestedBy: 'octo-dev', commentId: null, association: null,
    posts: [new Error('review_rejected'), new Error('review_rejected')] });
  await moveStored(9);
  await runReviewJob(rejected.job, rejected.deps);
  assert.equal((await getJob(db, rejected.job.id))?.outcome, 'publish_rejected');
  assert.deepEqual((await pendingOf(9)).map((j) => [j.trigger, j.reason, j.requestedBy, j.commentId, j.association]), [['manual', 'rerun_retry', 'octo-dev', null, null]]);

  // A /review on the second try of its review: the retry starts over, says nothing, and the retry's failure is the one answer.
  const twice = await manualJob({ pullRequest: 10, result: TIMEOUT(), secondStart: true });
  await moveStored(10);
  await runReviewJob(twice.job, twice.deps);
  assert.deepEqual(endAnswers(twice.writes), []);
  const [retry] = await pendingOf(10);
  const again = await manualJob({ reuseJob: retry!.id, pullRequest: 10, result: TIMEOUT(), live: { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } } });
  await runReviewJob(again.job, again.deps);
  assert.deepEqual(again.writes.filter((w) => w[0] === 'comment'), [['comment', '@octo-lead The review did not finish (`review_failed`).']]);
  assert.deepEqual(await pendingOf(10), []);
});
test('a manual review that fails at the stored head, with no stored row, as a retry, or a push\'s that fails, does not start over', async () => {
  const unmoved = await manualJob({ reason: 'done', settings: GATED, result: TIMEOUT() });
  await runReviewJob(unmoved.job, unmoved.deps);
  assert.equal((await getJob(db, unmoved.job.id))?.outcome, 'failed');
  assert.deepEqual(await pendingOf(7), []);
  assert.deepEqual(unmoved.writes.filter((w) => w[0] === 'comment'), [['comment', '@octo-lead The review did not finish (`review_failed`).']]);

  // A stored head merely behind the reviewed one (its row not updated since the job started) starts no second review of the same head.
  const behind = await manualJob({ pullRequest: 11, result: TIMEOUT(), head: 'h2' });
  await moveStored(11, 'h1', at(-60));
  await runReviewJob(behind.job, behind.deps);
  assert.equal((await getJob(db, behind.job.id))?.outcome, 'failed');
  assert.deepEqual(await pendingOf(11), []);
  assert.deepEqual(behind.writes.filter((w) => w[0] === 'comment'), [['comment', '@octo-lead The review did not finish (`review_failed`).']]);

  const unknown = await manualJob({ settings: GATED, pullRequest: 8, stored: false, result: TIMEOUT() });
  await runReviewJob(unknown.job, unknown.deps);
  assert.deepEqual(await pendingOf(8), []);

  const retry = await manualJob({ reason: 'done_retry', settings: GATED, pullRequest: 9, result: TIMEOUT() });
  await moveStored(9);
  await runReviewJob(retry.job, retry.deps);
  assert.equal((await getJob(db, retry.job.id))?.outcome, 'failed');
  assert.deepEqual(await pendingOf(9), []);

  const push = await harness({ dryRun: false, pullRequest: 10, result: TIMEOUT() });
  await moveStored(10);
  await runReviewJob(push.job, push.deps);
  assert.deepEqual(await pendingOf(10), []);
});
test('a re-run and its retry are not asked who commented, get no reaction and no sentence, and the review names who asked', async () => {
  for (const [reason, number] of [['rerun', 7], ['rerun_retry', 8]] as const) {
    const h = await manualJob({ reason, settings: GATED, pullRequest: number, requestedBy: 'octo-dev', commentId: null, association: null });
    await runReviewJob(h.job, h.deps);
    assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.inputs.length], ['published', 1], reason);
    assert.deepEqual(h.writes.filter((w) => w[0] === 'react' || w[0] === 'comment'), [], reason);
    assert.equal(h.logged.some((e) => e.event === 'answer_failed'), false, reason);
    assert.ok((await listRuns(db, { ...REF, number }))[0]!.body.includes('**Full review** requested by @octo-dev.'), reason);
  }
  // A re-run whose review fails is told nothing either, and nothing is logged for the comment it does not have.
  const failing = await manualJob({ reason: 'rerun', settings: GATED, pullRequest: 9, requestedBy: 'octo-dev', commentId: null, association: null,
    result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(failing.job, failing.deps);
  assert.deepEqual([(await getJob(db, failing.job.id))?.outcome, failing.writes.filter((w) => w[0] === 'react' || w[0] === 'comment')], ['failed', []]);
  assert.equal(failing.logged.some((e) => e.event === 'answer_failed'), false);
  // Every other manual job is still asked who commented.
  const stranger = await manualJob({ reason: 'done', settings: GATED, pullRequest: 10, association: 'none' });
  await runReviewJob(stranger.job, stranger.deps);
  assert.deepEqual([(await getJob(db, stranger.job.id))?.outcome, stranger.reads], ['refused', 0]);
});
test('a /done job and its retry get no second eyes, and a failure is answered', async () => {
  for (const [reason, number] of [['done', 7], ['done_retry', 8]] as const) {
    const h = await manualJob({ reason, settings: GATED, pullRequest: number });
    await runReviewJob(h.job, h.deps);
    assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.writes.filter((w) => w[0] === 'react' || w[0] === 'comment')], ['published', []], reason);
  }
  const failing = await manualJob({ reason: 'done', settings: GATED, pullRequest: 9, result: failed('model', 'timeout', { dependencies: { model: 'error' } }) });
  await runReviewJob(failing.job, failing.deps);
  assert.deepEqual(failing.writes.filter((w) => w[0] === 'react' || w[0] === 'comment'),
    [['react', '31', 'confused'], ['comment', '@octo-lead The review did not finish (`review_failed`).']]);
  const closed = await manualJob({ reason: 'done', settings: GATED, pullRequest: 10, live: { ...LIVE, state: 'closed' } });
  await runReviewJob(closed.job, closed.deps);
  assert.deepEqual(closed.writes, [['react', '31', 'confused'], ['comment', '@octo-lead The review was not started (`closed`).']]);
});

// ---- Notices to the modules, and the health of their parts ----

type Harness = Awaited<ReturnType<typeof harness>>;
type Calls = unknown[][];
/** A notifier that pushes ['notify', name, notice] for each call, then does what `then` says; resolves at once when not given. */
const notifier = (name: string, calls: Calls, then?: (notice: ReviewNotice, signal: AbortSignal) => Promise<void>): Notifier => ({
  name,
  notify: (notice, signal) => { calls.push(['notify', name, notice]); return then === undefined ? Promise.resolve() : then(notice, signal); },
});
/** How many runs have their notice stamp. */
const stamped = async (): Promise<number> =>
  (await db.query<{ n: number }>('select count(*)::int as n from visto_ai.review_runs where notified_at is not null'))[0]!.n;
const reviewLine = (h: Harness): Record<string, unknown> => h.logged.find((e) => e.event === 'review')!;
const noticeLines = (h: Harness): Array<Record<string, unknown>> => h.logged.filter((e) => e.event === 'notice' || e.event === 'notice_failed');
const BLOCKER = { path: 'a.ts', side: 'RIGHT' as const, line: 3, severity: 'blocker' as const, body: 'This breaks the total.', quote: 'x', requestedLine: null };
const EXTENSIONS = { tickets: { status: 'ok' as const, code: 'ok' }, wiki: { status: 'error' as const, code: 'timeout' } };

test('a published review is told to every notifier once, as the last thing the job does, with what a message needs', async () => {
  const calls: Calls = [];
  const atCall: Array<{ writes: unknown[]; reviewLogged: boolean }> = [];
  const minor = okResult().findings[0]!;
  const h: Harness = await live({
    // the unplaced major is not one of the findings placed on the diff, and is not counted
    result: okResult({
      findings: [BLOCKER, minor, { ...minor, line: 4 }], verdict: { threshold: 70, needsHuman: true, highest: 85 },
      unplaced: [{ path: 'a.ts', side: 'RIGHT', line: 40, severity: 'major', body: 'Off the diff.', quote: 'z', reason: 'line_not_in_diff' }],
    }),
    notifiers: [notifier('chat', calls, async () => { atCall.push({ writes: h.writes.map((w) => w[0]), reviewLogged: h.logged.some((e) => e.event === 'review') }); })],
  });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual(calls, [['notify', 'chat', {
    run: stored!.id, repository: 'acme/shop', number: 7, title: LIVE.info.title, author: 'octo-dev', headSha: 'h1', mode: 'full', trigger: 'automatic',
    reviewUrl: reviewUrlOf(REF, '501'), pullRequestUrl: pullRequestUrlOf(REF), needsHuman: true, highestScore: 85,
    findings: { blocker: 1, major: 0, minor: 2 }, body: stored!.body,
  }]]);
  assert.equal(stored!.body, h.drafts[0]!.body);
  assert.deepEqual(atCall, [{ writes: ['listOwnReviews', 'listOwnReviews', 'publishReview', 'listReviewComments'], reviewLogged: true }]);
  assert.deepEqual(noticeLines(h), [{ event: 'notice', job: h.job.id, run: stored!.id, review: '501', sent: true, results: { chat: 'ok' } }]);
  assert.equal(h.logged.at(-1)!.event, 'notice');
  assert.deepEqual(h.noted, [['noted', 'chat', 'notify', true, 'ok']]);
});
test('the stamp is written before the notifier is called', async () => {
  const calls: Calls = [];
  const atCall: number[] = [];
  const h = await live({ notifiers: [notifier('chat', calls, async () => { atCall.push(await stamped()); })] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([calls.length, atCall], [1, [1]]);
});
test('a review that a later start publishes, and one it finds already posted, are told once', async () => {
  const calls: Calls = [];
  const runId = await recorded({ trigger: 'manual', mode: 'incremental' });
  const later = await live({ notifiers: [notifier('chat', calls)] });
  await runReviewJob(later.job, later.deps);
  assert.deepEqual([later.inputs.length, (await getJob(db, later.job.id))?.outcome], [0, 'published']);
  const shown = (): unknown[][] => calls.map((c) => { const n = c[2] as ReviewNotice; return [n.run, n.number, n.trigger, n.mode, n.reviewUrl, n.body]; });
  assert.deepEqual(shown(), [[runId, 7, 'manual', 'incremental', reviewUrlOf(REF, '501'), (await listRuns(db, REF))[0]!.body]]);

  // the review was posted already: the publication adopts it
  const ref8 = { ...REF, number: 8 };
  const adoptedId = await recorded({ ref: ref8 });
  const adopted = await live({ pullRequest: 8, own: [[{ id: '502', commit: 'h1' }]], notifiers: [notifier('chat', calls)] });
  await runReviewJob(adopted.job, adopted.deps);
  assert.equal(adopted.writes.some((w) => w[0] === 'publishReview'), false);
  assert.equal(reviewLine(adopted).adopted, true);
  assert.deepEqual(shown().slice(1), [[adoptedId, 8, 'automatic', 'full', reviewUrlOf(ref8, '502'), (await listRuns(db, ref8))[0]!.body]]);

  // a further start for the same head tells nobody again
  const third = await live({ pullRequest: 8, notifiers: [notifier('chat', calls)] });
  await runReviewJob(third.job, third.deps);
  assert.deepEqual([(await getJob(db, third.job.id))?.outcome, calls.length, noticeLines(third)], ['already_reviewed', 2, []]);
});
test('a run adopted late is told once, with its own head and body and the present title', async () => {
  const calls: Calls = [];
  const writesAtCall: unknown[][] = [];
  const lostRun = await recorded({ headSha: 'h0', result: EARLIER_RESULT });
  const h: Harness = await live({
    own: [[{ id: '401', commit: 'h0' }]], threads: [[THREAD]], live: { ...LIVE, info: { ...LIVE.info, title: 'Add things, renamed' } },
    notifiers: [notifier('chat', calls, async () => { writesAtCall.push(h.writes.map((w) => w[0])); })],
  });
  await runReviewJob(h.job, h.deps);
  const newest = (await listRuns(db, REF)).find((r) => r.id !== lostRun)!;
  assert.deepEqual(calls.map((c) => { const n = c[2] as ReviewNotice; return [n.run, n.headSha, n.title, n.reviewUrl, n.body, n.findings]; }), [
    [lostRun, 'h0', 'Add things, renamed', reviewUrlOf(REF, '401'), EARLIER.body, { blocker: 0, major: 1, minor: 0 }],
    [newest.id, 'h1', 'Add things, renamed', reviewUrlOf(REF, '501'), newest.body, { blocker: 0, major: 0, minor: 1 }],
  ]);
  // told right after its read-back, before the live head is reviewed
  assert.deepEqual(writesAtCall[0], ['listOwnReviews', 'listReviewComments']);
  assert.deepEqual(noticeLines(h).map((e) => [e.event, e.run, e.review, e.sent]), [['notice', lostRun, '401', true], ['notice', newest.id, '501', true]]);
});
test('a re-check is told like any other review', async () => {
  const calls: Calls = [];
  await published({ head: 'h1' });
  const h = await manualJob({ own: [[{ id: '401', commit: 'h1' }]], notifiers: [notifier('chat', calls)] });
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'published');
  assert.deepEqual(calls.map((c) => { const n = c[2] as ReviewNotice; return [n.mode, n.trigger, n.reviewUrl]; }), [['recheck', 'manual', reviewUrlOf(REF, '501')]]);
});
test('nothing is told in dry run, nor for a review that was not published', async () => {
  const calls: Calls = [];
  const told = (): Notifier[] => [notifier('chat', calls)];
  const jobs: Array<[Harness, string]> = [];
  const run = async (h: Harness, outcome: string): Promise<void> => { await runReviewJob(h.job, h.deps); jobs.push([h, outcome]); };
  await run(await harness({ notifiers: told() }), 'reviewed');
  await run(await live({ pullRequest: 8, result: failed('model', 'timeout', { dependencies: { model: 'error' } }), notifiers: told() }), 'failed');
  await run(await live({ pullRequest: 9, result: okResult({ nothingToDo: true, mode: 'incremental' }), notifiers: told() }), 'nothing_new');
  await run(await live({ pullRequest: 10, posts: [new Error('review_rejected'), new Error('review_rejected')], notifiers: told() }), 'publish_rejected');
  const before = await live({ pullRequest: 11, posts: [new Error('github_502')], notifiers: told() });
  await run(before, '');
  await run(await live({ pullRequest: 11, reuseJob: before.job.id, now: at(5), notifiers: told() }), '');
  await run(await live({ pullRequest: 12, liveAfter: { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } }, notifiers: told() }), 'head_moved');
  await run(await live({ pullRequest: 13, liveAfter: { ...LIVE, state: 'closed' }, notifiers: told() }), 'closed');
  await run(await live({ pullRequest: 14, renderThrows: true, notifiers: told() }), 'render_failed');
  await run(await live({ pullRequest: 15, notifiers: [] }), 'published');
  await run(await live({ pullRequest: 16 }), 'published');
  for (const [h, outcome] of jobs) {
    if (outcome !== '') assert.equal((await getJob(db, h.job.id))?.outcome, outcome);
    assert.deepEqual(noticeLines(h), [], outcome);
  }
  assert.equal(((await getJob(db, before.job.id))?.status), 'pending');
  assert.deepEqual([calls, await stamped()], [[], 0]);
});
test('a notifier that throws or hangs changes nothing of the job', async () => {
  const verdicts = okResult({ threadVerdicts: [VERDICT], threadsDue: 1 });
  await published({ pullRequest: 8 });
  const plain = await live({ pullRequest: 8, threads: [[THREAD]], result: verdicts });
  await runReviewJob(plain.job, plain.deps);

  await published();
  const calls: Calls = [];
  let pagerSignal: AbortSignal | null = null;
  const h = await live({
    threads: [[THREAD]], result: verdicts, noticeTimeoutMs: 5,
    notifiers: [
      notifier('chat', calls, () => Promise.reject(new Error('chat_unreachable'))),
      notifier('pager', calls, (_notice, signal) => { pagerSignal = signal; return new Promise<void>(() => {}); }),
    ],
  });
  await runReviewJob(h.job, h.deps);
  const j = await getJob(db, h.job.id);
  assert.deepEqual([j?.status, j?.outcome], ['done', 'published']);
  assert.equal(h.writes.some((w) => w[0] === 'listReviewComments'), true);
  assert.deepEqual(h.writes.filter((w) => w[0] === 'replyToThread'), [['replyToThread', 'PRRT_1', REPLY]]);
  const same = (x: Harness): Record<string, unknown> => ({ ...reviewLine(x), job: 0, number: 0 });
  assert.deepEqual(same(h), same(plain));
  assert.deepEqual(noticeLines(h).map((e) => e.results), [{ chat: 'chat_unreachable', pager: 'timeout' }]);
  assert.deepEqual(h.noted, [['noted', 'chat', 'notify', false, 'chat_unreachable'], ['noted', 'pager', 'notify', false, 'timeout']]);
  assert.equal((pagerSignal as AbortSignal | null)?.aborted, true);
  assert.deepEqual([calls.length, noticeLines(plain)], [2, []]);

  // a health and a logger that throw change nothing either
  const throwing = await live({ pullRequest: 9, notifiers: [notifier('chat', calls)] });
  throwing.deps.extensionHealth = { noted: () => { throw new Error('health_down'); } };
  const log = throwing.deps.log;
  throwing.deps.log = (e) => { if (e.event === 'notice') throw new Error('log_down'); log(e); };
  await runReviewJob(throwing.job, throwing.deps);
  assert.deepEqual([(await getJob(db, throwing.job.id))?.outcome, calls.length], ['published', 3]);
});
test('a stamp that cannot be written, and one already taken, send nothing and change nothing', async () => {
  const calls: Calls = [];
  const failing = await live({ failQuery: 'set notified_at', notifiers: [notifier('chat', calls)] });
  await runReviewJob(failing.job, failing.deps);
  const [run7] = await listRuns(db, REF);
  assert.deepEqual([(await getJob(db, failing.job.id))?.outcome, run7!.published, calls.length], ['published', true, 0]);
  assert.deepEqual(noticeLines(failing), [{ event: 'notice_failed', job: failing.job.id, run: run7!.id, reason: 'internal_error' }]);

  const ref8 = { ...REF, number: 8 };
  const id8 = await recorded({ ref: ref8 });
  await db.query('update visto_ai.review_runs set notified_at = $2::timestamptz where id = $1', [id8, at(-100)]);
  const taken = await live({ pullRequest: 8, notifiers: [notifier('chat', calls)] });
  await runReviewJob(taken.job, taken.deps);
  assert.deepEqual([(await getJob(db, taken.job.id))?.outcome, (await listRuns(db, ref8))[0]!.published, calls.length], ['published', true, 0]);
  assert.deepEqual(noticeLines(taken), [{ event: 'notice', job: taken.job.id, run: id8, sent: false }]);
});
test('a notice that cannot be built writes no stamp and calls nobody', async () => {
  const calls: Calls = [];
  const h = await live({ notifiers: [notifier('chat', calls)] });
  h.deps.notice = { ...h.deps.notice!, reviewUrl: () => { throw new Error('github_bad_path'); } };
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, stored!.published, calls.length, await stamped()], ['published', true, 0, 0]);
  assert.deepEqual(noticeLines(h), [{ event: 'notice_failed', job: h.job.id, run: stored!.id, reason: 'github_bad_path' }]);
});
test('the health is told how each provider did, in dry run too, and the review line carries the statuses', async () => {
  const result = okResult({ dependencies: { model: 'ok', extensions: EXTENSIONS } });
  const told = [['noted', 'tickets', 'context', true, 'ok'], ['noted', 'wiki', 'context', false, 'timeout']];
  const dry = await harness({ result });
  await runReviewJob(dry.job, dry.deps);
  assert.deepEqual([dry.noted, reviewLine(dry).extensions], [told, EXTENSIONS]);
  const out = await live({ pullRequest: 8, result });
  await runReviewJob(out.job, out.deps);
  assert.deepEqual([out.noted, reviewLine(out).extensions, (await getJob(db, out.job.id))?.outcome], [told, EXTENSIONS, 'published']);
  // a review an earlier start recorded tells nothing, and its line carries what it stored
  await recorded({ ref: { ...REF, number: 9 }, result });
  const resumed = await live({ pullRequest: 9 });
  await runReviewJob(resumed.job, resumed.deps);
  assert.deepEqual([resumed.inputs.length, resumed.noted, reviewLine(resumed).extensions, reviewLine(resumed).resumed], [0, [], EXTENSIONS, true]);
});
test('a review of a fork, where no provider was asked, tells the health nothing', async () => {
  const alerts: unknown[][] = [];
  const health = createExtensionHealth((code, details) => { alerts.push([code, details]); });
  const failing = { tickets: { status: 'error' as const, code: 'provider_failed' } };
  const steps: Array<[number, ReviewResult['dependencies']['extensions']]> = [
    [31, failing],                                                   // the repository's own pull request: the provider throws
    [32, { tickets: { status: 'skipped', code: 'from_fork' } }],     // a fork: the provider is not asked
    [33, { tickets: { status: 'skipped', code: 'origin_unknown' } }], // an origin the read does not say: not asked either
    [34, failing],                                                   // the next review of its own: still failing
  ];
  for (const [number, extensions] of steps) {
    const h = await harness({ pullRequest: number, result: okResult({ dependencies: { model: 'ok', extensions: extensions! } }) });
    await runReviewJob(h.job, { ...h.deps, extensionHealth: health });
  }
  assert.deepEqual(alerts, [['extension_error', { extension: 'tickets', part: 'context', reason: 'provider_failed' }]]);
  // A module's own skipped, with a code of its own, is told as today.
  const own = await harness({ pullRequest: 35, result: okResult({ dependencies: { model: 'ok', extensions: { tickets: { status: 'skipped', code: 'no_ticket' } } } }) });
  await runReviewJob(own.job, own.deps);
  assert.deepEqual(own.noted, [['noted', 'tickets', 'context', true, 'no_ticket']]);
});
test('a result with no statuses, or damaged ones, tells the health nothing and logs none', async () => {
  const cases: Array<[unknown, unknown, number]> = [[undefined, null, 7], ['x', null, 8], [{ tickets: 5, wiki: { status: 'ok' } }, {}, 9]];
  for (const [extensions, expected, number] of cases) {
    const dependencies = (extensions === undefined ? { model: 'ok' } : { model: 'ok', extensions }) as unknown as ReviewResult['dependencies'];
    const h = await harness({ pullRequest: number, result: okResult({ dependencies }) });
    await runReviewJob(h.job, h.deps);
    assert.deepEqual([h.noted, reviewLine(h).extensions], [[], expected], String(number));
  }
  // a stored result that is damaged, and a failed run with no result
  await recorded({ ref: { ...REF, number: 10 }, result: okResult({ dependencies: { model: 'ok', extensions: 'x' } as unknown as ReviewResult['dependencies'] }) });
  const stored = await live({ pullRequest: 10 });
  await runReviewJob(stored.job, stored.deps);
  assert.deepEqual([stored.noted, reviewLine(stored).extensions], [[], null]);
  const unread = await live({ pullRequest: 11, live: new Error('github_502') });
  await runReviewJob(unread.job, unread.deps);
  assert.deepEqual([unread.noted, reviewLine(unread).extensions], [[], null]);
});

test('a notifier that throws a value that cannot be read is one notice line with notifier_failed', async () => {
  const calls: Calls = [];
  const badMessage = Object.create(Error.prototype, { message: { get() { throw new Error('boom'); } } }) as Error;
  const badProto = new Proxy({}, { getPrototypeOf() { throw new Error('boom'); } });
  const h = await live({
    noticeTimeoutMs: 5,
    notifiers: [notifier('chat', calls, () => Promise.reject(badMessage)), notifier('pager', calls, () => Promise.reject(badProto))],
  });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, calls.length], ['published', 2]);
  const lines = noticeLines(h);
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0]?.event, lines[0]?.sent, lines[0]?.results], ['notice', true, { chat: 'notifier_failed', pager: 'notifier_failed' }]);
});
test('a notice whose sending rejects is one notice_failed line, and the job ends as it would have', async () => {
  const calls: Calls = [];
  const h = await live({ notifiers: [notifier('chat', calls)] });
  h.deps.notice = { ...h.deps.notice!, send: () => Promise.reject(new Error('send_broke')) };
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, stored!.published, calls.length, h.noted], ['published', true, 0, []]);
  assert.deepEqual(noticeLines(h), [{ event: 'notice_failed', job: h.job.id, run: stored!.id, reason: 'send_broke' }]);
});
test('a publication that could not be recorded tells nobody and takes no stamp', async () => {
  const calls: Calls = [];
  const h = await live({ markFailures: 3, notifiers: [notifier('chat', calls)] });
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([reviewLine(h).outcome, calls, await stamped(), noticeLines(h)], ['record_failed', [], 0, []]);
});
test('a notice carries the body that was published and stored, also when GitHub refused the inline comments', async () => {
  const calls: Calls = [];
  const h = await live({ posts: [new Error('review_rejected'), { id: '502' }], posted: [], notifiers: [notifier('chat', calls)] });
  await runReviewJob(h.job, h.deps);
  const [stored] = await listRuns(db, REF);
  const first = h.writes.filter((w) => w[0] === 'publishReview')[0]![2];
  assert.equal(stored!.inlineDropped, true);
  assert.notEqual(stored!.body, first);
  assert.deepEqual(calls.map((c) => [(c[2] as ReviewNotice).body, (c[2] as ReviewNotice).reviewUrl]), [[stored!.body, reviewUrlOf(REF, '502')]]);
});

const MCP = {
  docs: { status: 'ok' as const, code: 'ok', calls: 3 },
  wiki: { status: 'error' as const, code: 'call_timeout', calls: 1 },
  notes: { status: 'skipped' as const, code: 'no_room', calls: 0 },
};
/** The keys of the review line as they are with no MCP server, in order. */
const REVIEW_LINE_KEYS = [
  'event', 'job', 'repo', 'number', 'head', 'trigger', 'mode', 'dry_run', 'outcome', 'failure_stage', 'failure_code', 'needs_human', 'highest', 'findings',
  'calls', 'cost', 'duration_ms', 'requeued', 'published', 'review', 'publish', 'publish_code', 'resumed', 'adopted', 'threads_due', 'verdicts', 'duplicates',
  'blocking_on_unchanged', 'nothing_new', 'notes', 'notes_dropped', 'extensions',
];
test('with no server the review line and the alerts are those of before', async () => {
  const alerts: unknown[][] = [];
  const health = createMcpHealth((code, details) => { alerts.push([code, details]); });
  for (const [number, dryRun] of [[7, true], [8, false]] as const) {
    const h = await harness({ pullRequest: number, dryRun });
    await runReviewJob(h.job, h.deps);
    assert.deepEqual([Object.keys(reviewLine(h)), h.mcpNoted], [REVIEW_LINE_KEYS, []], String(number));
    const real = await harness({ pullRequest: number + 10, dryRun });
    await runReviewJob(real.job, { ...real.deps, mcpHealth: health });
    // with no health at all, as the service builds the job when no server is named
    const none = await harness({ pullRequest: number + 20, dryRun });
    delete none.deps.mcpHealth;
    await runReviewJob(none.job, none.deps);
    const same = (x: Harness): Record<string, unknown> => ({ ...reviewLine(x), job: 0, number: 0, duration_ms: 0 });
    assert.deepEqual([same(real), same(none)], [same(h), same(h)], String(number));
  }
  // a stored result written before this plan, read by a later start
  await recorded({ ref: { ...REF, number: 30 }, result: okResult() });
  const resumed = await live({ pullRequest: 30 });
  await runReviewJob(resumed.job, resumed.deps);
  assert.deepEqual([Object.keys(reviewLine(resumed)), resumed.mcpNoted, reviewLine(resumed).resumed], [REVIEW_LINE_KEYS, [], true]);
  assert.deepEqual(alerts, []);
});
test('the health is told how each server did, in dry run too, and the review line carries the map', async () => {
  const result = okResult({ dependencies: { model: 'ok', mcp: MCP } });
  const told = [['noted', 'docs', true, 'ok'], ['noted', 'wiki', false, 'call_timeout']];
  const dry = await harness({ result });
  await runReviewJob(dry.job, dry.deps);
  assert.deepEqual([dry.mcpNoted, reviewLine(dry).mcp], [told, MCP]);
  const keys = Object.keys(reviewLine(dry));
  assert.deepEqual(keys.slice(keys.indexOf('extensions')), ['extensions', 'mcp']);
  const out = await live({ pullRequest: 8, result });
  await runReviewJob(out.job, out.deps);
  assert.deepEqual([out.mcpNoted, reviewLine(out).mcp, (await getJob(db, out.job.id))?.outcome], [told, MCP, 'published']);
  // a review an earlier start recorded tells nothing, and its line carries what it stored
  await recorded({ ref: { ...REF, number: 9 }, result });
  const resumed = await live({ pullRequest: 9 });
  await runReviewJob(resumed.job, resumed.deps);
  assert.deepEqual([resumed.inputs.length, resumed.mcpNoted, reviewLine(resumed).mcp, reviewLine(resumed).resumed], [0, [], MCP, true]);
});
test('a skipped server tells the health nothing: a failing server stays failing across a fork', async () => {
  const alerts: unknown[][] = [];
  const health = createMcpHealth((code, details) => { alerts.push([code, details]); });
  const steps: Array<[number, Record<string, { status: 'ok' | 'skipped' | 'error'; code: string; calls: number }>]> = [
    [41, { docs: { status: 'error', code: 'tool_not_listed', calls: 0 } }],
    [42, { docs: { status: 'skipped', code: 'from_fork', calls: 0 } }],
    [43, { docs: { status: 'skipped', code: 'no_room', calls: 0 } }],
    [44, { docs: { status: 'error', code: 'model_refused_tools', calls: 0 } }],
    [45, { docs: { status: 'ok', code: 'ok', calls: 1 } }],
  ];
  for (const [number, mcp] of steps) {
    const h = await harness({ pullRequest: number, result: okResult({ dependencies: { model: 'ok', mcp } }) });
    await runReviewJob(h.job, { ...h.deps, mcpHealth: health });
  }
  assert.deepEqual(alerts, [['mcp_error', { server: 'docs', reason: 'tool_not_listed' }], ['mcp_ok', { server: 'docs' }]]);
});
test('a damaged map tells the health nothing it cannot read', async () => {
  const damaged = {
    docs: 5, wiki: { status: 'ok', code: 'ok' }, 'Bad Name': { status: 'ok', code: 'ok', calls: 0 }, ok1: { status: 'fine', code: 'ok', calls: 0 },
    ok2: { status: 'error', code: 'Not A Code', calls: 0 }, ok3: { status: 'ok', code: 'ok', calls: -1 }, ok4: { status: 'ok', code: 'ok', calls: 1.5 },
    ok5: null, ok6: [],
  };
  const cases: Array<[unknown, boolean, unknown, number]> = [['x', false, undefined, 7], [null, false, undefined, 8], [[], false, undefined, 9], [damaged, true, {}, 10]];
  for (const [mcp, present, expected, number] of cases) {
    const dependencies = { model: 'ok', mcp } as unknown as ReviewResult['dependencies'];
    const h = await harness({ pullRequest: number, result: okResult({ dependencies }) });
    await runReviewJob(h.job, h.deps);
    assert.deepEqual([h.mcpNoted, 'mcp' in reviewLine(h), reviewLine(h).mcp], [[], present, expected], String(number));
  }
  // a stored result that is damaged
  await recorded({ ref: { ...REF, number: 11 }, result: okResult({ dependencies: { model: 'ok', mcp: 'x' } as unknown as ReviewResult['dependencies'] }) });
  const stored = await live({ pullRequest: 11 });
  await runReviewJob(stored.job, stored.deps);
  assert.deepEqual([stored.mcpNoted, 'mcp' in reviewLine(stored)], [[], false]);
});
test('a health that throws changes nothing of the job', async () => {
  const result = okResult({ dependencies: { model: 'ok', mcp: MCP } });
  const plain = await live({ pullRequest: 7, result });
  await runReviewJob(plain.job, plain.deps);
  const throwing = await live({ pullRequest: 8, result });
  throwing.deps.mcpHealth = { noted: () => { throw new Error('health_down'); } };
  await runReviewJob(throwing.job, throwing.deps);
  const same = (x: Harness): Record<string, unknown> => ({ ...reviewLine(x), job: 0, number: 0, duration_ms: 0 });
  assert.deepEqual(same(throwing), same(plain));
  assert.equal((await getJob(db, throwing.job.id))?.outcome, 'published');
});

/** A memory that only says it was given, and the refs it was made for. */
const givenMemory = (): { memory: Memory; memoryFor: (ref: PullRequestRef) => Memory; refs: PullRequestRef[] } => {
  const refs: PullRequestRef[] = [];
  const memory: Memory = { blocks: () => Promise.reject(new Error('not_asked')) };
  return { memory, refs, memoryFor: (ref) => { refs.push(ref); return memory; } };
};
/** Tells into `told`, as [ok, code]. */
const memoryHealthInto = (told: unknown[][]): Pick<MemoryHealth, 'noted'> => ({ noted: (...args) => { told.push(args); } });

test('with learning off the engine is given no memory, and the review line and the alerts are those of before', async () => {
  const alerts: unknown[][] = [];
  const health = createMemoryHealth((code, details) => { alerts.push([code, details]); });
  for (const [number, dryRun] of [[7, true], [8, false]] as const) {
    const h = await harness({ pullRequest: number, dryRun });
    await runReviewJob(h.job, h.deps);
    assert.equal(h.engines.length, 1);
    assert.equal('memory' in h.engines[0]!, false, String(number));
    assert.deepEqual(Object.keys(h.engines[0]!), dryRun ? [] : ['reusableScores'], String(number));
    assert.deepEqual(Object.keys(reviewLine(h)), REVIEW_LINE_KEYS, String(number));
    // a health given with no memory is told nothing by a result with no memory
    const told = await harness({ pullRequest: number + 10, dryRun });
    await runReviewJob(told.job, { ...told.deps, memoryHealth: health });
    const same = (x: Harness): Record<string, unknown> => ({ ...reviewLine(x), job: 0, number: 0, duration_ms: 0 });
    assert.deepEqual(same(told), same(h), String(number));
  }
  // a stored result written before this plan, read by a later start
  await recorded({ ref: { ...REF, number: 30 }, result: okResult() });
  const resumed = await live({ pullRequest: 30 });
  await runReviewJob(resumed.job, resumed.deps);
  assert.deepEqual([Object.keys(reviewLine(resumed)), reviewLine(resumed).resumed], [REVIEW_LINE_KEYS, true]);
  assert.deepEqual(alerts, []);
});

test('with learning on the engine is given the repository\'s memory, in dry run too', async () => {
  for (const [number, dryRun] of [[7, true], [8, false]] as const) {
    const given = givenMemory();
    const h = await harness({ pullRequest: number, dryRun });
    h.deps.engineDeps = () => ({ contract: 'x' }) as ReviewDeps;
    await runReviewJob(h.job, { ...h.deps, memoryFor: given.memoryFor });
    assert.deepEqual(given.refs, [{ ...REF, number }], String(number));
    assert.equal(h.engines.length, 1);
    assert.equal(h.engines[0]!.memory, given.memory, String(number));
    // beside what it is given today
    assert.deepEqual(Object.keys(h.engines[0]!).sort(), dryRun ? ['contract', 'memory'] : ['contract', 'memory', 'reusableScores'], String(number));
  }
});

test('the review line carries how memory did, and the health is told', async () => {
  const cases: Array<[MemoryStatus, unknown[][]]> = [
    [{ status: 'ok', code: 'ok', lines: 2 }, [[true, 'ok']]],
    [{ status: 'empty', code: 'no_records', lines: 0 }, [[true, 'no_records']]],
    [{ status: 'error', code: 'timeout', lines: 0 }, [[false, 'timeout']]],
    [{ status: 'skipped', code: 'no_room', lines: 0 }, []],
  ];
  let number = 40;
  for (const [memory, expected] of cases) {
    for (const dryRun of [true, false]) {
      number += 1;
      const told: unknown[][] = [];
      const h = await harness({ pullRequest: number, dryRun, result: okResult({ dependencies: { model: 'ok', memory } }) });
      await runReviewJob(h.job, { ...h.deps, memoryHealth: memoryHealthInto(told) });
      assert.deepEqual([told, reviewLine(h).memory], [expected, memory], `${memory.status} ${dryRun}`);
      const keys = Object.keys(reviewLine(h));
      assert.deepEqual(keys.slice(keys.indexOf('extensions')), ['extensions', 'memory']);
    }
  }
  // after mcp
  const both = await harness({ pullRequest: 60, result: okResult({ dependencies: { model: 'ok', mcp: MCP, memory: { status: 'ok', code: 'ok', lines: 1 } } }) });
  await runReviewJob(both.job, both.deps);
  const keys = Object.keys(reviewLine(both));
  assert.deepEqual(keys.slice(keys.indexOf('extensions')), ['extensions', 'mcp', 'memory']);
  // a review an earlier start recorded tells nothing, and its line carries what it stored
  const memory: MemoryStatus = { status: 'error', code: 'lookup_failed', lines: 0 };
  await recorded({ ref: { ...REF, number: 61 }, result: okResult({ dependencies: { model: 'ok', memory } }) });
  const told: unknown[][] = [];
  const resumed = await live({ pullRequest: 61 });
  await runReviewJob(resumed.job, { ...resumed.deps, memoryHealth: memoryHealthInto(told) });
  assert.deepEqual([resumed.inputs.length, told, reviewLine(resumed).memory, reviewLine(resumed).resumed], [0, [], memory, true]);
});

test('a damaged status is not logged, and a health that throws changes nothing', async () => {
  const damaged: unknown[] = [
    'x', null, [], 5,
    { status: 'fine', code: 'ok', lines: 0 },
    { status: 'ok', code: 'Not A Code', lines: 0 },
    { status: 'ok', code: 5, lines: 0 },
    { status: 'ok', code: 'ok', lines: -1 },
    { status: 'ok', code: 'ok', lines: 1.5 },
    { status: 'ok', code: 'ok' },
    { status: 'error', code: 'a'.repeat(41), lines: 0 },
  ];
  let number = 70;
  for (const memory of damaged) {
    number += 1;
    const told: unknown[][] = [];
    const dependencies = { model: 'ok', memory } as unknown as ReviewResult['dependencies'];
    const h = await harness({ pullRequest: number, result: okResult({ dependencies }) });
    await runReviewJob(h.job, { ...h.deps, memoryHealth: memoryHealthInto(told) });
    assert.deepEqual([told, 'memory' in reviewLine(h)], [[], false], JSON.stringify(memory));
    assert.deepEqual(Object.keys(reviewLine(h)), REVIEW_LINE_KEYS, JSON.stringify(memory));
  }
  // a stored result that is damaged
  await recorded({ ref: { ...REF, number: 90 }, result: okResult({ dependencies: { model: 'ok', memory: 'x' } as unknown as ReviewResult['dependencies'] }) });
  const stored = await live({ pullRequest: 90 });
  await runReviewJob(stored.job, stored.deps);
  assert.equal('memory' in reviewLine(stored), false);
  // a health that throws
  const result = okResult({ dependencies: { model: 'ok', memory: { status: 'error', code: 'timeout', lines: 0 } } });
  const plain = await live({ pullRequest: 91, result });
  await runReviewJob(plain.job, plain.deps);
  const throwing = await live({ pullRequest: 92, result });
  await runReviewJob(throwing.job, { ...throwing.deps, memoryHealth: { noted: () => { throw new Error('health_down'); } } });
  const same = (x: Harness): Record<string, unknown> => ({ ...reviewLine(x), job: 0, number: 0, duration_ms: 0 });
  assert.deepEqual(same(throwing), same(plain));
  assert.equal((await getJob(db, throwing.job.id))?.outcome, 'published');
});

test('a memory health that returns a rejected promise leaves no rejection unhandled, and changes nothing', async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    const result = okResult({ dependencies: { model: 'ok', memory: { status: 'error', code: 'timeout', lines: 0 } } });
    const plain = await live({ pullRequest: 93, result });
    await runReviewJob(plain.job, plain.deps);
    const rejecting = await live({ pullRequest: 94, result });
    let calls = 0;
    const noted = (() => { calls += 1; return Promise.reject(new Error('health_down')); }) as unknown as MemoryHealth['noted'];
    await runReviewJob(rejecting.job, { ...rejecting.deps, memoryHealth: { noted } });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const same = (x: Harness): Record<string, unknown> => ({ ...reviewLine(x), job: 0, number: 0, duration_ms: 0 });
    assert.deepEqual([calls, unhandled, same(rejecting)], [1, [], same(plain)]);
    assert.equal((await getJob(db, rejecting.job.id))?.outcome, 'published');
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('with learning off the review line and the alerts are those of before', async () => {
  const alerts: unknown[][] = [];
  const health = createMemoryHealth((code, details) => { alerts.push([code, details]); });
  for (const [number, dryRun] of [[100, true], [101, false]] as const) {
    const h = await harness({ pullRequest: number, dryRun });
    await runReviewJob(h.job, { ...h.deps, memoryHealth: health });
    assert.equal(h.engines.length, 1);
    assert.equal('memory' in h.engines[0]!, false, String(number));
    assert.deepEqual(Object.keys(reviewLine(h)), REVIEW_LINE_KEYS, String(number));
    assert.equal('memory' in reviewLine(h), false, String(number));
  }
  assert.deepEqual(alerts, []);
});

test('a status with no lessons part logs as it did, and a damaged part is not logged', async () => {
  const signals: MemoryStatus = { status: 'ok', code: 'ok', lines: 2 };
  let number = 110;
  for (const lessons of [undefined, 'x', { status: 'fine' }, { status: 'fine', code: 'ok', shown: 0 }, { status: 'ok', code: 'ok', shown: -1 }, { status: 'ok', code: 'ok', shown: 1.5 }, { status: 'ok', code: 'Not A Code', shown: 0 }, null, []]) {
    number += 1;
    const memory = lessons === undefined ? signals : { ...signals, lessons };
    const dependencies = { model: 'ok', memory } as unknown as ReviewResult['dependencies'];
    const told: unknown[][] = [];
    const h = await harness({ pullRequest: number, result: okResult({ dependencies }) });
    await runReviewJob(h.job, { ...h.deps, memoryHealth: memoryHealthInto(told) });
    assert.deepEqual(reviewLine(h).memory, signals, JSON.stringify(lessons));
    assert.deepEqual(Object.keys(reviewLine(h).memory as object), ['status', 'code', 'lines'], JSON.stringify(lessons));
    assert.deepEqual(told, [[true, 'ok']], JSON.stringify(lessons));
  }
  // a stored result written before this plan, read by a later start
  await recorded({ ref: { ...REF, number: 130 }, result: okResult({ dependencies: { model: 'ok', memory: signals } }) });
  const resumed = await live({ pullRequest: 130 });
  await runReviewJob(resumed.job, resumed.deps);
  assert.deepEqual([reviewLine(resumed).memory, reviewLine(resumed).resumed], [signals, true]);
});

test('the review line carries how each part of memory did', async () => {
  const memory: MemoryStatus = { status: 'skipped', code: 'second_scorer', lines: 0, lessons: { status: 'ok', code: 'ok', shown: 3 } };
  for (const [number, dryRun] of [[140, true], [141, false]] as const) {
    const h = await harness({ pullRequest: number, dryRun, result: okResult({ dependencies: { model: 'ok', memory } }) });
    await runReviewJob(h.job, h.deps);
    assert.deepEqual(reviewLine(h).memory, memory, String(number));
    const keys = Object.keys(reviewLine(h));
    assert.deepEqual(keys.slice(keys.indexOf('extensions')), ['extensions', 'memory']);
  }
  // a part with a key too many is logged with its three keys, and nothing else of it
  const extra = { status: 'ok', code: 'ok', lines: 1, lessons: { status: 'ok', code: 'ok', shown: 2, text: 'octo-lead wrote src/billing/tax.ts' } };
  const wide = await harness({ pullRequest: 143, result: okResult({ dependencies: { model: 'ok', memory: extra } as unknown as ReviewResult['dependencies'] }) });
  await runReviewJob(wide.job, wide.deps);
  assert.deepEqual(reviewLine(wide).memory, { status: 'ok', code: 'ok', lines: 1, lessons: { status: 'ok', code: 'ok', shown: 2 } });
  assert.deepEqual(Object.keys((reviewLine(wide).memory as { lessons: object }).lessons), ['status', 'code', 'shown']);
  assert.equal(JSON.stringify(reviewLine(wide)).includes('octo-lead'), false);
  // a review an earlier start recorded: its line carries what it stored
  await recorded({ ref: { ...REF, number: 142 }, result: okResult({ dependencies: { model: 'ok', memory } }) });
  const resumed = await live({ pullRequest: 142 });
  await runReviewJob(resumed.job, resumed.deps);
  assert.deepEqual([reviewLine(resumed).memory, reviewLine(resumed).resumed], [memory, true]);
});

test('the health is told once for a review: an error of either part is a failure, and both skipped tells nothing', async () => {
  const cases: Array<[MemoryStatus, unknown[][]]> = [
    [{ status: 'ok', code: 'ok', lines: 2, lessons: { status: 'error', code: 'timeout', shown: 0 } }, [[false, 'timeout']]],
    [{ status: 'skipped', code: 'second_scorer', lines: 0, lessons: { status: 'ok', code: 'ok', shown: 2 } }, [[true, 'ok']]],
    [{ status: 'error', code: 'lookup_failed', lines: 0, lessons: { status: 'ok', code: 'ok', shown: 2 } }, [[false, 'lookup_failed']]],
    [{ status: 'skipped', code: 'no_room', lines: 0, lessons: { status: 'skipped', code: 'no_room', shown: 0 } }, []],
    [{ status: 'error', code: 'timeout', lines: 0, lessons: { status: 'error', code: 'lookup_failed', shown: 0 } }, [[false, 'timeout']]],
    [{ status: 'skipped', code: 'second_scorer', lines: 0, lessons: { status: 'empty', code: 'no_lessons', shown: 0 } }, [[true, 'no_lessons']]],
    // the code of the first part that was asked
    [{ status: 'ok', code: 'ok', lines: 2, lessons: { status: 'empty', code: 'no_lessons', shown: 0 } }, [[true, 'ok']]],
  ];
  let number = 150;
  for (const [memory, expected] of cases) {
    for (const dryRun of [true, false]) {
      number += 1;
      const told: unknown[][] = [];
      const h = await harness({ pullRequest: number, dryRun, result: okResult({ dependencies: { model: 'ok', memory } }) });
      await runReviewJob(h.job, { ...h.deps, memoryHealth: memoryHealthInto(told) });
      assert.deepEqual(told, expected, `${JSON.stringify(memory)} ${dryRun}`);
    }
  }
  // a review an earlier start recorded tells nothing
  const memory: MemoryStatus = { status: 'ok', code: 'ok', lines: 1, lessons: { status: 'error', code: 'timeout', shown: 0 } };
  await recorded({ ref: { ...REF, number: 170 }, result: okResult({ dependencies: { model: 'ok', memory } }) });
  const told: unknown[][] = [];
  const resumed = await live({ pullRequest: 170 });
  await runReviewJob(resumed.job, { ...resumed.deps, memoryHealth: memoryHealthInto(told) });
  assert.deepEqual([resumed.inputs.length, told], [0, []]);
});

// The second scorer's state (the UI plan's Overview, call 12).
/** An engine that holds a scorer; the scorer is never asked, as the review is the harness's. */
const SCORED = (): ReviewDeps => ({ scorer: { score: () => Promise.reject(new Error('not_expected')) } }) as unknown as ReviewDeps;
const scorerAudit = (action: string, reason: string, subject = 'a.ts') => ({ stage: 'scorer', action, subject, reason });

test('with a second scorer, the review job notes how it did from the audit, and without one notes nothing', async () => {
  const cases: Array<[string, Partial<ReviewResult>, boolean, unknown[][]]> = [
    ['a file failed', { audit: [scorerAudit('file_failed', 'timeout')] }, true, [[false, 'timeout']]],
    ['the first of two', { audit: [scorerAudit('file_not_asked', 'stopped', 'b.ts'), scorerAudit('file_failed', 'timeout')] }, true, [[false, 'stopped']]],
    ['no scorer entry, calls 2', { audit: [{ stage: 'context', action: 'file_failed', subject: 'a.ts', reason: 'timeout' }] }, true, [[true, 'ok']]],
    ['another action', { audit: [scorerAudit('file_scored', 'timeout')] }, true, [[true, 'ok']]],
    ['no call', { audit: [], usage: NO_CALLS }, true, []],
    ['a reason that is no code', { audit: [scorerAudit('file_failed', 'Not A Code')] }, true, [[true, 'ok']]],
    ['a reason that is no code, then one that is', { audit: [scorerAudit('file_failed', 'Not A Code'), scorerAudit('file_failed', 'timeout', 'b.ts')] }, true, [[false, 'timeout']]],
    ['a reason that is no code, no call', { audit: [scorerAudit('file_failed', 'Not A Code')], usage: NO_CALLS }, true, []],
    ['no scorer in the engine', { audit: [scorerAudit('file_failed', 'timeout')] }, false, []],
    ['no scorer in the engine, calls 2', { audit: [] }, false, []],
  ];
  let number = 300;
  for (const [label, over, scored, expected] of cases) {
    for (const dryRun of [true, false]) {
      number += 1;
      const told: unknown[][] = [];
      const h = await harness({ pullRequest: number, dryRun, result: okResult(over) });
      if (scored) h.deps.engineDeps = SCORED;
      await runReviewJob(h.job, { ...h.deps, scorerHealth: { noted: (...args) => { told.push(args); } } });
      assert.deepEqual(told, expected, `${label} ${dryRun}`);
    }
  }
  // A review an earlier start recorded tells nothing.
  await recorded({ ref: { ...REF, number: 340 }, result: okResult({ audit: [scorerAudit('file_failed', 'timeout')] }) });
  const told: unknown[][] = [];
  const resumed = await live({ pullRequest: 340 });
  resumed.deps.engineDeps = SCORED;
  await runReviewJob(resumed.job, { ...resumed.deps, scorerHealth: { noted: (...args) => { told.push(args); } } });
  assert.deepEqual([resumed.inputs.length, told], [0, []]);
  // A health that throws changes nothing of the job.
  const result = okResult({ audit: [scorerAudit('file_failed', 'timeout')] });
  const plain = await live({ pullRequest: 341, result });
  plain.deps.engineDeps = SCORED;
  await runReviewJob(plain.job, plain.deps);
  const throwing = await live({ pullRequest: 342, result });
  throwing.deps.engineDeps = SCORED;
  await runReviewJob(throwing.job, { ...throwing.deps, scorerHealth: { noted: () => { throw new Error('health_down'); } } });
  const same = (x: Harness): Record<string, unknown> => ({ ...reviewLine(x), job: 0, number: 0, duration_ms: 0 });
  assert.deepEqual(same(throwing), same(plain));
  assert.equal((await getJob(db, throwing.job.id))?.outcome, 'published');
});

// Automatic approval.
const APPROVING: RepoSettings = { ...SETTINGS, approval: { enabled: true, threads: 'strict', auditShare: 0 } };
/** The pull request, from the repository itself: with an approvable result, every live condition of approval holds. */
const LIVE_OK: LivePullRequest = { ...LIVE, info: { ...LIVE.info, fromFork: false } };
const liveAt = (head: string): LivePullRequest => ({ ...LIVE_OK, info: { ...LIVE_OK.info, headSha: head } });
/** A result every stored condition of approval holds for: its one file covered at 35 with one block at 35, one minor finding, threshold 70. */
const approvable = (over: Partial<ReviewResult> = {}): ReviewResult => {
  const file = flaggedResult().scores[0]!;
  return okResult({ scores: [{ ...file, finalScore: 35, blocks: file.blocks.map((b) => ({ ...b, entry: { score: 35, category: 'calculation', reason: '' } })) }], ...over });
};
/** The app's own reviews as the git service lists them, each with its state, for the harness's `own`. */
const ownReviews = (...reviews: Array<{ id: string; commit: string; state?: OwnReviewState }>): Array<Array<{ id: string; commit: string; state?: OwnReviewState }>> => [reviews];
/** The paragraph a review of `head` ends with, under the strict rule and the threshold 70. */
const paragraphOf = (code: ApprovalCode, head = 'h1'): string => approvalParagraph(code, { head, threshold: 70, rule: 'strict' });
const LINKS = { lineUrl: () => 'https://git.example.test/x', commentUrl: (id: string) => `https://git.example.test/c/${id}` };

/** Gives the harness's deps an approvals fake whose branch rule answers `rule`, and an onWithdraw that counts its calls. */
function approving(h: Harness, rule: 'dismissed' | 'kept' = 'dismissed'): { calls: unknown[][]; woken: () => number } {
  const calls: unknown[][] = [];
  let woken = 0;
  const approvals: ForgeApprovals = {
    staleApprovals: async (_ref, _installation, branch) => { calls.push(['staleApprovals', branch]); return rule; },
    readReview: async () => { calls.push(['readReview']); throw new Error('not_expected'); },
    dismissReview: async () => { calls.push(['dismissReview']); throw new Error('not_expected'); },
  };
  h.deps.approvals = approvals;
  h.deps.onWithdraw = () => { woken += 1; };
  return { calls, woken: () => woken };
}
/** The approval columns of a pull request's runs, lowest id first. */
const approvalRows = (number = 7) => db.query<{ id: number; head_sha: string; approved: boolean; approval_code: string | null; dismissed_at: Date | null; dismissed_by: string | null }>(
  'select id, head_sha, approved, approval_code, dismissed_at, dismissed_by from visto_ai.review_runs where number = $1 order by id', [number]);
/** The withdraw jobs of a pull request, lowest id first. */
const withdrawJobs = (number = 7) => db.query<{ status: string; run_at: Date; installation: string | null }>(
  "select status, run_at, installation from visto_ai.jobs where kind = 'withdraw' and number = $1 order by id", [number]);
/** The pending withdraw jobs end, as their runner would end them: the next harness of the pull request then claims its own job. */
const withdrawRan = () => db.query("update visto_ai.jobs set status = 'done', outcome = 'kept' where kind = 'withdraw' and status = 'pending'");
/** An approval of review `reviewId` at `head`, posted by an earlier job and standing. */
async function standing(head = 'h0', reviewId = '401', number = 7): Promise<number> {
  const id = await recorded({ ref: { ...REF, number }, headSha: head, baseBranch: 'main' });
  await markPublished(db, id, { reviewId, publishedAt: at(-3400), body: 'Approved earlier.', inlineDropped: false, approved: true, approvalCode: 'approved' });
  return id;
}
/** Every statement the job runs from now on, those of its transactions included, in the order it runs them. */
function statementsOf(h: Harness): string[] {
  const seen: string[] = [];
  const spy = (inner: Db): Db => ({
    query: (text, params) => { seen.push(text); return inner.query(text, params); },
    script: (sql) => inner.script(sql),
    close: () => inner.close(),
    transaction: (work) => inner.transaction((tx) => work(spy(tx))),
  });
  h.deps.db = spy(h.deps.db);
  return seen;
}
/** The statement of listRuns. */
const isListRuns = (text: string): boolean => text.includes('from visto_ai.review_runs') && /number = \$4\s+order by id$/.test(text);
/** The statements that serve approval alone: the runs and comments read for the decision, the newest review's reading, a standing approval, a withdraw job. */
const approvalStatements = (statements: string[]): string[] => statements.filter((s) => isListRuns(s) || s.includes('select run, comment_id')
  || s.includes('select approved from') || s.includes('approved and dismissed_at is null') || s.includes("'withdraw'"));

test('with approval off the job records, posts and logs what it did', async () => {
  /** One review of an approvable result under `settings`, with the approvals fake and onWithdraw given or not. */
  const runOf = async (number: number, settings: RepoSettings, fakes: boolean): Promise<unknown> => {
    const h = await live({ pullRequest: number, settings, live: LIVE_OK, result: approvable() });
    const seen = fakes ? approving(h) : { calls: [], woken: () => 0 };
    await runReviewJob(h.job, h.deps);
    const line = reviewLine(h);
    assert.deepEqual(['approved' in line, 'approval' in line, seen.calls, seen.woken(), await withdrawJobs(number)], [false, false, [], 0, []], String(number));
    return {
      drafts: h.drafts, writes: h.writes, outcome: (await getJob(db, h.job.id))?.outcome,
      rows: (await approvalRows(number)).map((r) => [r.approved, r.approval_code, r.dismissed_at, r.dismissed_by]),
      logged: h.logged.map((e) => ({ ...e, job: null, run: null, number: null })),
    };
  };
  const bare = await runOf(8, SETTINGS, false) as { drafts: ReviewDraft[]; rows: unknown[]; outcome: string };
  assert.deepEqual([bare.outcome, 'event' in bare.drafts[0]!, bare.rows], ['published', false, [[false, null, null, null]]]);
  // The review as it was rendered and recorded: no paragraph, so nothing was decided.
  const rendered = renderReview(approvable(), { trigger: 'automatic', requestedBy: null, inline: true, ...LINKS });
  assert.deepEqual(bare.drafts, [{ commit: 'h1', body: rendered.body, comments: rendered.comments }]);
  assert.equal(rendered.body.includes('automatically'), false);
  // With the approvals at hand, and with approval written but off: the same drafts, rows and lines.
  assert.deepEqual(await runOf(9, SETTINGS, true), bare);
  assert.deepEqual(await runOf(10, { ...SETTINGS, approval: { enabled: false, threads: 'strict', auditShare: 0 } }, true), bare);
});

test('an approval is recorded with its code, and a withdraw job is stored with it', async () => {
  const h = await live({ settings: APPROVING, live: LIVE_OK, result: approvable() });
  const seen = approving(h);
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([h.drafts.length, h.drafts[0]!.event, seen.calls], [1, 'approve', [['staleApprovals', 'main']]]);
  assert.ok(h.drafts[0]!.body.endsWith(`\n\n${paragraphOf('approved')}`));
  const [run] = await listRuns(db, REF);
  assert.deepEqual([run!.published, run!.reviewId, run!.body], [true, '501', h.drafts[0]!.body]);
  assert.deepEqual((await approvalRows()).map((r) => [r.approved, r.approval_code, r.dismissed_at, r.dismissed_by]), [[true, 'approved', null, null]]);
  // A push may have landed since the decision: the withdraw job, which reads the live head, is stored with the approval, due at once.
  assert.deepEqual((await withdrawJobs()).map((j) => [j.status, j.run_at.toISOString(), j.installation]), [['pending', at(0), '99']]);
  assert.equal(seen.woken(), 1);
  const line = reviewLine(h);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, line.published, line.approved, line.approval], ['published', true, true, 'approved']);
  // An onWithdraw that throws changes nothing.
  const loud = await live({ pullRequest: 8, settings: APPROVING, live: LIVE_OK, result: approvable() });
  approving(loud);
  loud.deps.onWithdraw = () => { throw new Error('Something private broke'); };
  await runReviewJob(loud.job, loud.deps);
  assert.deepEqual([(await getJob(db, loud.job.id))?.outcome, (await withdrawJobs(8)).length, reviewLine(loud).approval], ['published', 1, 'approved']);
});

test('a review that does not approve, on a pull request with a standing approval, stores a withdraw job; one with none stores nothing', async () => {
  // The branch keeps stale approvals: this review is a comment, and the approval of h0 still stands.
  await standing();
  const h = await live({ settings: APPROVING, live: LIVE_OK, result: approvable(), own: ownReviews({ id: '401', commit: 'h0', state: 'approved' }) });
  const seen = approving(h, 'kept');
  await runReviewJob(h.job, h.deps);
  assert.equal('event' in h.drafts[0]!, false);
  assert.ok(h.drafts[0]!.body.endsWith(`\n\n${paragraphOf('rule_off')}`));
  assert.deepEqual((await approvalRows()).map((r) => [r.head_sha, r.approved, r.approval_code]), [['h0', true, 'approved'], ['h1', false, 'rule_off']]);
  assert.deepEqual([(await withdrawJobs()).map((j) => [j.status, j.installation]), seen.woken()], [[['pending', '99']], 1]);
  assert.deepEqual([reviewLine(h).approved, reviewLine(h).approval], [false, 'rule_off']);
  // Approval switched off since: the approval that stands is looked at again all the same; nothing is decided.
  await standing('h0', '401', 8);
  const off = await live({ pullRequest: 8, own: ownReviews({ id: '401', commit: 'h0', state: 'approved' }) });
  const offSeen = approving(off);
  await runReviewJob(off.job, off.deps);
  assert.deepEqual([(await withdrawJobs(8)).length, offSeen.woken(), offSeen.calls, 'event' in off.drafts[0]!, 'approved' in reviewLine(off)], [1, 1, [], false, false]);
  // No standing approval: an earlier comment, and an approval dismissed since.
  await published({ pullRequest: 9, comments: [] });
  const after = await standing('h0', '402', 10);
  await markDismissed(db, after, at(-100), 'git_service');
  for (const [number, own] of [[9, '401'], [10, '402']] as const) {
    const none = await live({ pullRequest: number, settings: APPROVING, live: LIVE_OK, result: approvable(), own: [[{ id: own, commit: 'h0' }]] });
    const noneSeen = approving(none, 'kept');
    await runReviewJob(none.job, none.deps);
    assert.deepEqual([(await getJob(db, none.job.id))?.outcome, reviewLine(none).approval, await withdrawJobs(number), noneSeen.woken()], ['published', 'rule_off', [], 0], String(number));
  }
});

test('an adopted approval is recorded as one, and a dismissed one as dismissed by the git service', async () => {
  // An approval posted whose record failed: the job is left running, and no withdraw job is stored without the record.
  const lost = await live({ settings: APPROVING, live: LIVE_OK, result: approvable(), markFailures: 3 });
  const lostSeen = approving(lost);
  await runReviewJob(lost.job, lost.deps);
  assert.deepEqual([lost.drafts[0]!.event, (await listRuns(db, REF))[0]!.published, await withdrawJobs(), lostSeen.woken()], ['approve', false, [], 0]);
  await requeueJob(db, lost.job.id, at(0), at(0), false);        // what start-up recovery does
  // The next start finds it on GitHub as an approval: adopted as one, with no decision of its own, and its withdrawal asked for.
  const again = await live({ reuseJob: lost.job.id, settings: APPROVING, live: LIVE_OK, own: ownReviews({ id: '501', commit: 'h1', state: 'approved' }) });
  const seen = approving(again);
  await runReviewJob(again.job, again.deps);
  assert.deepEqual([again.drafts.length, again.inputs.length, seen.calls], [0, 0, []]);
  assert.deepEqual((await approvalRows()).map((r) => [r.approved, r.approval_code, r.dismissed_at, r.dismissed_by]), [[true, null, null, null]]);
  assert.deepEqual([(await withdrawJobs()).length, seen.woken()], [1, 1]);
  const line = reviewLine(again);
  assert.deepEqual([(await getJob(db, again.job.id))?.outcome, line.adopted, line.approved, line.approval], ['published', true, true, null]);
  // One GitHub holds as dismissed, with approval off: an approval the git service dismissed; nothing stands, nothing is asked.
  const before = await live({ pullRequest: 8, posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const dismissed = await live({ pullRequest: 8, reuseJob: before.job.id, own: ownReviews({ id: '502', commit: 'h1', state: 'dismissed' }) });
  const dismissedSeen = approving(dismissed);
  await runReviewJob(dismissed.job, dismissed.deps);
  assert.deepEqual((await approvalRows(8)).map((r) => [r.approved, r.approval_code, r.dismissed_at?.toISOString(), r.dismissed_by]), [[true, null, at(0), 'git_service']]);
  assert.deepEqual([await withdrawJobs(8), dismissedSeen.woken(), reviewLine(dismissed).approved, reviewLine(dismissed).approval], [[], 0, true, null]);
  // One GitHub holds as a comment: no approval, and the line has neither key.
  const first = await live({ pullRequest: 9, posts: [new Error('github_502')] });
  await runReviewJob(first.job, first.deps);
  const commented = await live({ pullRequest: 9, reuseJob: first.job.id, own: ownReviews({ id: '503', commit: 'h1', state: 'commented' }) });
  approving(commented);
  await runReviewJob(commented.job, commented.deps);
  assert.deepEqual((await approvalRows(9)).map((r) => [r.approved, r.approval_code, r.dismissed_by]), [[false, null, null]]);
  assert.deepEqual([await withdrawJobs(9), 'approved' in reviewLine(commented), 'approval' in reviewLine(commented), reviewLine(commented).adopted], [[], false, false, true]);
});

test('a later start that adopts an approval at another commit records it and asks for its withdrawal', async () => {
  // A review of h0 the database lost track of, which GitHub holds as an approval; the push to h1 is then reviewed against it.
  await recorded({ headSha: 'h0', result: EARLIER_RESULT, baseBranch: 'main' });
  const h = await live({ own: ownReviews({ id: '401', commit: 'h0', state: 'approved' }), threads: [[THREAD]] });
  const seen = approving(h);
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(h.logged.filter((e) => e.event === 'adopted_late').length, 1);
  assert.deepEqual((await approvalRows()).map((r) => [r.head_sha, r.approved, r.approval_code, r.dismissed_by]), [['h0', true, null, null], ['h1', false, null, null]]);
  // Asked at the adoption, and again after the publication of h1, while the approval of h0 still stands: one job, woken twice.
  assert.deepEqual([(await withdrawJobs()).map((j) => [j.status, j.installation]), seen.woken(), seen.calls], [[['pending', '99']], 2, []]);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, 'approved' in reviewLine(h)], ['published', false]);
  // Dismissed on GitHub: recorded so, and nothing stands; a comment: no approval.
  for (const [number, state, row] of [[8, 'dismissed', [true, 'git_service']], [9, 'commented', [false, null]]] as const) {
    await recorded({ ref: { ...REF, number }, headSha: 'h0', result: EARLIER_RESULT, baseBranch: 'main' });
    const later = await live({ pullRequest: number, own: ownReviews({ id: '401', commit: 'h0', state }), threads: [[THREAD]] });
    const laterSeen = approving(later);
    await runReviewJob(later.job, later.deps);
    assert.deepEqual((await approvalRows(number)).map((r) => [r.head_sha, r.approved, r.dismissed_by]), [['h0', ...row], ['h1', false, null]], state);
    assert.deepEqual([await withdrawJobs(number), laterSeen.woken(), (await getJob(db, later.job.id))?.outcome], [[], 0, 'published'], state);
  }
});

test('with approval on, a push that tells nothing new after an approval is published and decided; after a comment it ends nothing_new as before', async () => {
  const first = await live({ settings: APPROVING, live: LIVE_OK, result: approvable() });
  approving(first);
  await runReviewJob(first.job, first.deps);
  const [approval] = await listRuns(db, REF);
  assert.deepEqual([approval!.published, (await approvalRows())[0]!.approved], [true, true]);
  // The push's withdraw job dismissed the approval of h1 before the push's review was computed.
  await markDismissed(db, approval!.id, at(10), 'app');
  await withdrawRan();
  const nothing = approvable({ nothingToDo: true, mode: 'incremental' });
  const push = await live({ head: 'h2', live: liveAt('h2'), settings: APPROVING, own: ownReviews({ id: '501', commit: 'h1', state: 'dismissed' }), posts: [{ id: '502' }], result: nothing });
  const seen = approving(push);
  await runReviewJob(push.job, push.deps);
  assert.deepEqual([(await getJob(db, push.job.id))?.outcome, push.drafts.length, push.drafts[0]!.event, seen.calls], ['published', 1, 'approve', [['staleApprovals', 'main']]]);
  assert.ok(push.drafts[0]!.body.endsWith(`\n\n${paragraphOf('approved', 'h2')}`));
  const newest = (await listRuns(db, REF)).at(-1)!;
  assert.deepEqual([newest.headSha, newest.published, newest.reviewId, newest.body], ['h2', true, '502', push.drafts[0]!.body]);
  assert.deepEqual((await approvalRows()).map((r) => [r.head_sha, r.approved, r.approval_code, r.dismissed_by]), [['h1', true, 'approved', 'app'], ['h2', true, 'approved', null]]);
  // Its scores are kept as any recorded run's are.
  assert.deepEqual((await blockRows()).map((r) => r.run), [approval!.id, newest.id]);
  assert.deepEqual([reviewLine(push).nothing_new, reviewLine(push).approved, reviewLine(push).approval], [false, true, 'approved']);
  // A push's job on the head of the newest review is still dropped.
  await withdrawRan();
  const same = await live({ head: 'h2', live: liveAt('h2'), settings: APPROVING, result: nothing });
  approving(same);
  await runReviewJob(same.job, same.deps);
  assert.deepEqual([(await getJob(db, same.job.id))?.outcome, same.inputs.length], ['already_reviewed', 0]);

  // The newest published review is a comment: the push ends nothing_new, as with approval off; nothing is decided.
  await published({ pullRequest: 8, head: 'h1', comments: [] });
  const quiet = await live({ pullRequest: 8, head: 'h2', live: liveAt('h2'), settings: APPROVING, own: [[{ id: '401', commit: 'h1' }]], result: nothing });
  const quietSeen = approving(quiet);
  await runReviewJob(quiet.job, quiet.deps);
  const ended = (await listRuns(db, { ...REF, number: 8 })).at(-1)!;
  assert.deepEqual([(await getJob(db, quiet.job.id))?.outcome, quiet.drafts.length, ended.body, ended.published, quietSeen.calls], ['nothing_new', 0, '', false, []]);
  assert.deepEqual([reviewLine(quiet).nothing_new, 'approval' in reviewLine(quiet), await withdrawJobs(8)], [true, false, []]);
  // With approval off after an approval: nothing_new as before.
  await standing('h1', '401', 9);
  const off = await live({ pullRequest: 9, head: 'h2', live: liveAt('h2'), own: [[{ id: '401', commit: 'h1' }]], result: nothing });
  approving(off);
  const statements = statementsOf(off);
  await runReviewJob(off.job, off.deps);
  assert.deepEqual([(await getJob(db, off.job.id))?.outcome, off.drafts.length, await withdrawJobs(9)], ['nothing_new', 0, []]);
  // The newest review is not even read with approval off.
  assert.deepEqual(statements.filter((s) => s.includes('select approved from')), []);
});

test('a read of the newest approval that fails before a nothing-new push posts the review as a comment with record_unreadable', async () => {
  // The newest review is a comment: read, the push would end nothing_new. Not read, it is posted, and never as an approval.
  await published({ head: 'h1', comments: [] });
  const h = await live({
    head: 'h2', live: liveAt('h2'), settings: APPROVING, own: [[{ id: '401', commit: 'h1' }]], result: approvable({ nothingToDo: true, mode: 'incremental' }),
    failQuery: 'select approved from',
  });
  const seen = approving(h);
  await runReviewJob(h.job, h.deps);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.drafts.length, 'event' in h.drafts[0]!, seen.calls], ['published', 1, false, []]);
  assert.ok(h.drafts[0]!.body.endsWith(`\n\n${paragraphOf('record_unreadable', 'h2')}`));
  // Decided before the threads were read for it: the only read of the threads is the earlier state's.
  assert.deepEqual(h.writes.map((w) => w[0]), ['listOwnReviews', 'listThreads', 'listOwnReviews', 'publishReview', 'listReviewComments']);
  assert.deepEqual((await approvalRows()).map((r) => [r.head_sha, r.approved, r.approval_code]), [['h1', false, null], ['h2', false, 'record_unreadable']]);
  assert.deepEqual([reviewLine(h).nothing_new, reviewLine(h).approved, reviewLine(h).approval, await withdrawJobs()], [false, false, 'record_unreadable', []]);
  assert.equal(JSON.stringify(h.logged).includes('private'), false);
});

test('runs that cannot be read before the post give record_unreadable, and the review is still posted', async () => {
  // The statement of listRuns: the first read is the record's, the second the one made just before the post.
  const h = await live({ settings: APPROVING, live: LIVE_OK, result: approvable() });
  const seen = approving(h);
  const query = h.deps.db.query;
  let reads = 0;
  h.deps.db = { ...h.deps.db, query: (text, params) => (isListRuns(text) && ++reads === 2 ? Promise.reject(new Error('Something private broke')) : query(text, params)) };
  await runReviewJob(h.job, h.deps);
  assert.equal(reads, 2);
  assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.drafts.length, 'event' in h.drafts[0]!, seen.calls], ['published', 1, false, []]);
  assert.ok(h.drafts[0]!.body.endsWith(`\n\n${paragraphOf('record_unreadable')}`));
  assert.deepEqual(h.writes.map((w) => w[0]), ['listOwnReviews', 'listOwnReviews', 'publishReview', 'listReviewComments']);
  assert.deepEqual((await approvalRows()).map((r) => [r.approved, r.approval_code]), [[false, 'record_unreadable']]);
  assert.deepEqual([reviewLine(h).approval, JSON.stringify(h.logged).includes('private')], ['record_unreadable', false]);
  // The stored comments, which a first review reads only then: the same.
  const comments = await live({ pullRequest: 8, settings: APPROVING, live: LIVE_OK, result: approvable(), failQuery: 'select run, comment_id' });
  const commentsSeen = approving(comments);
  await runReviewJob(comments.job, comments.deps);
  assert.deepEqual([(await getJob(db, comments.job.id))?.outcome, 'event' in comments.drafts[0]!, commentsSeen.calls], ['published', false, []]);
  assert.deepEqual((await approvalRows(8)).map((r) => [r.approved, r.approval_code]), [[false, 'record_unreadable']]);
});

test('a resumed review is decided at its post like a first one, and one another job recorded is posted with its own text', async () => {
  // This job's own run: its first post failed; the later start decides again, and posts the same approval.
  const before = await live({ settings: APPROVING, live: LIVE_OK, result: approvable(), posts: [new Error('github_502')] });
  approving(before);
  await runReviewJob(before.job, before.deps);
  assert.deepEqual([before.drafts[0]!.event, (await getJob(db, before.job.id))?.status, (await approvalRows())[0]!.approved], ['approve', 'pending', false]);
  const again = await live({ reuseJob: before.job.id, now: at(900), settings: APPROVING, live: LIVE_OK });
  const seen = approving(again);
  await runReviewJob(again.job, again.deps);
  assert.deepEqual([again.inputs.length, again.drafts, seen.calls], [0, before.drafts, [['staleApprovals', 'main']]]);
  assert.deepEqual((await approvalRows()).map((r) => [r.approved, r.approval_code]), [[true, 'approved']]);
  assert.deepEqual([(await getJob(db, again.job.id))?.outcome, reviewLine(again).resumed, reviewLine(again).approval], ['published', true, 'approved']);

  // A run octo-lead's /review recorded, posted by octo-dev's: its recorded text, with the paragraph decided now; never octo-dev's name.
  const result = approvable();
  const asked = renderReview(result, { trigger: 'manual', requestedBy: 'octo-lead', inline: true, ...LINKS });
  assert.ok(asked.body.includes('@octo-lead'));
  await recorded({ ref: { ...REF, number: 8 }, job: 4242, trigger: 'manual', result, body: asked.body, comments: asked.comments });
  const other = await manualJob({ pullRequest: 8, requestedBy: 'octo-dev', settings: APPROVING, live: LIVE_OK });
  approving(other);
  await runReviewJob(other.job, other.deps);
  assert.deepEqual([other.inputs.length, other.drafts.length, other.drafts[0]!.event], [0, 1, 'approve']);
  assert.equal(other.drafts[0]!.body, fitBody(asked.body, paragraphOf('approved')));
  assert.equal(other.drafts[0]!.body.includes('@octo-dev'), false);
  // With approval off, refused inline: the body written whole names no one, and nothing is decided.
  await recorded({ ref: { ...REF, number: 9 }, job: 4243, trigger: 'manual', result, body: asked.body, comments: asked.comments });
  const refused = await manualJob({ pullRequest: 9, requestedBy: 'octo-dev', posts: [new Error('review_rejected'), { id: '502' }] });
  await runReviewJob(refused.job, refused.deps);
  const whole = refused.drafts.at(-1)!;
  assert.deepEqual([refused.drafts.length, refused.drafts[0]!.body, whole.comments.length, 'event' in whole], [2, asked.body, 0, false]);
  assert.deepEqual([whole.body.includes('@octo-dev'), whole.body.includes('@octo-lead'), whole.body.startsWith('**Full review** requested.')], [false, false, true]);
  // A run recorded with no job, by an older release, is read as this job's: written again with this job's trigger and requester.
  await recorded({ ref: { ...REF, number: 10 }, result });
  const older = await manualJob({ pullRequest: 10, requestedBy: 'octo-dev', settings: APPROVING, live: LIVE_OK });
  approving(older);
  await runReviewJob(older.job, older.deps);
  assert.equal(older.drafts[0]!.body, renderReview(result, { trigger: 'manual', requestedBy: 'octo-dev', inline: true, ...LINKS, approval: paragraphOf('approved') }).body);
});

test('the decision at the post is made under the thread rule in force and the repository\'s clearing by reply', async () => {
  // The major 8001 of h0, whose thread octo-dev, the author, replied to and resolved: open under the strict rule; closed under the gate's
  // rule with clearing by reply on; open again with it off.
  const RESOLVED: ReviewThread = { ...THREAD, resolved: true };
  const GATE_RULE: RepoSettings = { ...SETTINGS, approval: { enabled: true, threads: 'gate', auditShare: 0 } };
  const cases: Array<[number, RepoSettings, 'strict' | 'gate', ApprovalCode]> = [
    [7, APPROVING, 'strict', 'open_thread'],
    [8, GATE_RULE, 'gate', 'approved'],
    [9, REPLY_OFF(GATE_RULE), 'gate', 'open_thread'],
  ];
  for (const [number, settings, rule, code] of cases) {
    await published({ pullRequest: number });
    const h = await live({ pullRequest: number, settings, live: LIVE_OK, result: approvable(), own: OWN_401, threads: [[RESOLVED]] });
    const seen = approving(h);
    await runReviewJob(h.job, h.deps);
    assert.deepEqual([h.drafts.length, h.drafts[0]!.event, reviewLine(h).approval], [1, code === 'approved' ? 'approve' : undefined, code], String(number));
    // The paragraph names the rule in force; the branch's rule is read only once the threads let it be.
    assert.ok(h.drafts[0]!.body.endsWith(`\n\n${approvalParagraph(code, { head: 'h1', threshold: 70, rule })}`), String(number));
    assert.deepEqual(seen.calls, code === 'approved' ? [['staleApprovals', 'main']] : [], String(number));
    assert.deepEqual((await approvalRows(number)).map((r) => [r.head_sha, r.approved, r.approval_code]), [['h0', false, null], ['h1', code === 'approved', code]], String(number));
  }
});

test('in dry run nothing of approval runs: no read for it, no withdraw job, nothing posted', async () => {
  // A standing approval of h0 on each: out of dry run a review of h1 would be decided and a withdraw job stored after it,
  // and a push that tells nothing new would read the newest review.
  for (const [number, result] of [[7, approvable()], [8, approvable({ nothingToDo: true, mode: 'incremental' })]] as const) {
    await standing('h0', '401', number);
    const h = await harness({ pullRequest: number, settings: APPROVING, live: LIVE_OK, result, own: OWN_401 });
    const seen = approving(h);
    const statements = statementsOf(h);
    await runReviewJob(h.job, h.deps);
    assert.deepEqual([(await getJob(db, h.job.id))?.outcome, h.writes, seen.calls, seen.woken(), await withdrawJobs(number)], ['reviewed', [], [], 0, []], String(number));
    assert.deepEqual(approvalStatements(statements), [], String(number));
    // The spy sees the statements of a transaction: the run is recorded in the one that finishes the job.
    assert.equal(statements.some((s) => s.includes('insert into visto_ai.review_runs')), true, String(number));
    const line = reviewLine(h);
    assert.deepEqual([line.dry_run, line.published, 'approved' in line, 'approval' in line], [true, false, false, false], String(number));
    assert.deepEqual((await approvalRows(number)).map((r) => [r.head_sha, r.approved, r.approval_code]), [['h0', true, 'approved'], ['h1', false, null]], String(number));
  }
});

// The audit sample. Under AUDIT_TEST_KEY acme/shop 7 is drawn above 18.8899, acme/shop 8 above 4.5701; under AUDIT_TEST_KEY_CHANGED acme/shop 8 above 6.8261.
const AUDIT_TEST_KEY = 'audit-key-for-tests-only-0123456789';
const AUDIT_TEST_KEY_CHANGED = 'audit-key-for-tests-only-0123456788';
/** Approval on under the strict rule, with the audit share `share`. */
const auditing = (share: number): RepoSettings => ({ ...SETTINGS, approval: { enabled: true, threads: 'strict', auditShare: share } });
/** The decision of each run of a pull request, lowest id first, as [head, approved, code]. */
const decisions = async (number: number): Promise<unknown[][]> => (await approvalRows(number)).map((r) => [r.head_sha, r.approved, r.approval_code]);
/** One review of an approvable result of pull request `number` at `head`, approval on with the share `share`, the deployment's key `key`. */
async function auditedJob(number: number, share: number, key: string | undefined, more: Options = {}): Promise<{ h: Harness; seen: ReturnType<typeof approving> }> {
  const h = await live({ pullRequest: number, settings: auditing(share), live: LIVE_OK, result: approvable(), ...more });
  const seen = approving(h);
  if (key !== undefined) h.deps.auditKey = key;
  await runReviewJob(h.job, h.deps);
  return { h, seen };
}

test("with a share above 0 the job draws with the deployment's key: one drawn is posted with the audit paragraph and recorded as audit_sample, one not drawn is approved", async () => {
  // Pull request 8, drawn at 5: a comment that ends with the audit paragraph, after the branch's rule was read.
  const drawn = await auditedJob(8, 5, AUDIT_TEST_KEY);
  assert.deepEqual([(await getJob(db, drawn.h.job.id))?.outcome, drawn.h.drafts.length, 'event' in drawn.h.drafts[0]!, drawn.seen.calls], ['published', 1, false, [['staleApprovals', 'main']]]);
  assert.ok(drawn.h.drafts[0]!.body.endsWith(`\n\n${paragraphOf('audit_sample')}`));
  assert.deepEqual((await approvalRows(8)).map((r) => [r.approved, r.approval_code]), [[false, 'audit_sample']]);
  assert.deepEqual([reviewLine(drawn.h).approved, reviewLine(drawn.h).approval], [false, 'audit_sample']);
  // Nothing stands: no withdraw job.
  assert.deepEqual([await withdrawJobs(8), drawn.seen.woken()], [[], 0]);
  // Pull request 7, not drawn at 5: approved.
  const approved = await auditedJob(7, 5, AUDIT_TEST_KEY);
  assert.deepEqual([approved.h.drafts.length, approved.h.drafts[0]!.event], [1, 'approve']);
  assert.ok(approved.h.drafts[0]!.body.endsWith(`\n\n${paragraphOf('approved')}`));
  assert.deepEqual((await approvalRows(7)).map((r) => [r.approved, r.approval_code]), [[true, 'approved']]);
  assert.deepEqual([reviewLine(approved.h).approved, reviewLine(approved.h).approval], [true, 'approved']);

  // Nothing of the draw leaves it: not the key, nor the digest of either identity (whole or its first 8 characters), nor its number.
  const digests = [7, 8].map((n) => createHmac('sha256', AUDIT_TEST_KEY).update(JSON.stringify(['github', 'acme', 'shop', n]), 'utf8').digest());
  assert.deepEqual(digests.map((d) => d.readUInt32BE(0)), [811315780, 196284414]);
  const secrets = [AUDIT_TEST_KEY, ...digests.flatMap((d) => [d.toString('hex'), d.toString('hex').slice(0, 8)]), '811315780', '196284414'];
  const json = (x: unknown): string => JSON.stringify(x, (_key, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
  for (const [number, h] of [[8, drawn.h], [7, approved.h]] as const) {
    const rows = await db.query('select * from visto_ai.review_runs where number = $1 order by id', [number]);
    assert.equal(rows.length, 1, String(number));
    const texts = [...h.logged.map(json), ...h.drafts.map(json), ...rows.map(json)];
    for (const secret of secrets) assert.equal(texts.some((t) => t.includes(secret)), false, `${number}: ${secret.length}`);
  }
});

test('a pull request drawn at one head is drawn at the next', async () => {
  const first = await auditedJob(8, 5, AUDIT_TEST_KEY);
  assert.equal('event' in first.h.drafts[0]!, false);
  assert.deepEqual(await decisions(8), [['h1', false, 'audit_sample']]);
  // A push to h2: drawn again, whatever the head.
  const push = await auditedJob(8, 5, AUDIT_TEST_KEY, { head: 'h2', live: liveAt('h2'), own: ownReviews({ id: '501', commit: 'h1' }), posts: [{ id: '502' }] });
  assert.deepEqual([(await getJob(db, push.h.job.id))?.outcome, push.h.drafts.length, 'event' in push.h.drafts[0]!, push.seen.calls], ['published', 1, false, [['staleApprovals', 'main']]]);
  assert.ok(push.h.drafts[0]!.body.endsWith(`\n\n${paragraphOf('audit_sample', 'h2')}`));
  assert.deepEqual(await decisions(8), [['h1', false, 'audit_sample'], ['h2', false, 'audit_sample']]);
  assert.deepEqual([reviewLine(push.h).approved, reviewLine(push.h).approval], [false, 'audit_sample']);
});

test('a lower share or another key can let a pull request drawn at 5 be approved', async () => {
  // At 4.5, below its number under AUDIT_TEST_KEY: approved.
  const lower = await auditedJob(8, 4.5, AUDIT_TEST_KEY);
  assert.equal(lower.h.drafts[0]!.event, 'approve');
  assert.deepEqual(await decisions(8), [['h1', true, 'approved']]);
  await withdrawRan();
  // A push to h2 at 5 under another key: approved, and the approval of h1, which still stands, is asked to be withdrawn.
  const changed = await auditedJob(8, 5, AUDIT_TEST_KEY_CHANGED, { head: 'h2', live: liveAt('h2'), own: ownReviews({ id: '501', commit: 'h1', state: 'approved' }), posts: [{ id: '502' }] });
  assert.deepEqual([(await getJob(db, changed.h.job.id))?.outcome, changed.h.drafts[0]!.event], ['published', 'approve']);
  assert.ok(changed.h.drafts[0]!.body.endsWith(`\n\n${paragraphOf('approved', 'h2')}`));
  assert.deepEqual(await decisions(8), [['h1', true, 'approved'], ['h2', true, 'approved']]);
  assert.deepEqual([(await withdrawJobs(8)).map((j) => j.status), changed.seen.woken()], [['done', 'pending'], 1]);
});

test('without a key a share above 0 draws every pull request, and a share of 0 draws none', async () => {
  // Pull request 7 is not drawn at 5 under AUDIT_TEST_KEY; without a key it is. Pull request 8 is drawn at 5 under AUDIT_TEST_KEY; at 0 it is not.
  const cases: Array<[number, number, string | undefined, ApprovalCode]> = [[7, 5, undefined, 'audit_sample'], [8, 0, AUDIT_TEST_KEY, 'approved'], [9, 0, undefined, 'approved']];
  for (const [number, share, key, code] of cases) {
    const { h, seen } = await auditedJob(number, share, key);
    const name = `${number} at ${share}`;
    assert.deepEqual([h.drafts.length, h.drafts[0]!.event, seen.calls], [1, code === 'approved' ? 'approve' : undefined, [['staleApprovals', 'main']]], name);
    assert.ok(h.drafts[0]!.body.endsWith(`\n\n${paragraphOf(code)}`), name);
    assert.deepEqual(await decisions(number), [['h1', code === 'approved', code]], name);
    assert.deepEqual([reviewLine(h).approved, reviewLine(h).approval], [code === 'approved', code], name);
  }
});

// The stage of a running review, on its job.
/** What the engine of these tests tells, in turn: batch 1 of 2 holding a due thread, then each batch ended. */
const PROGRESS: ReviewProgress[] = [{ batches: 2, ended: 0, threadsDue: 1 }, { batches: 2, ended: 1, threadsDue: 0 }, { batches: 2, ended: 2, threadsDue: 0 }];
/** The review of `h` tells the engine's progress as `told` says, then answers as the harness's does. */
const telling = (h: Harness, told: ReviewProgress[]): void => {
  h.deps.review = (input, engine) => {
    h.inputs.push(input);
    h.engines.push(engine);
    for (const p of told) engine.progress?.(p);
    return Promise.resolve(okResult({ mode: input.mode ?? 'full' }));
  };
};
const STAGE_WRITE = 'set stage = $2';
/**
 * Watches the statements of a job's database, inside transactions too: the text of each, and the params of each that writes the stage, in order.
 * With `fail`, every statement that writes the stage rejects; with `delayMs`, each of them waits that long first.
 */
function watchStages(deps: ReviewJobDeps, options: { fail?: boolean; delayMs?: number } = {}): { texts: string[]; params: unknown[][] } {
  const texts: string[] = [];
  const params: unknown[][] = [];
  const before = async (text: string, values: unknown[] | undefined): Promise<void> => {
    texts.push(text);
    if (!text.includes(STAGE_WRITE)) return;
    params.push(values ?? []);
    if (options.delayMs !== undefined) await new Promise((resolve) => { setTimeout(resolve, options.delayMs); });
    if (options.fail === true) throw new Error('db_down');
  };
  const inner = deps.db;
  deps.db = {
    query: async (text, values) => { await before(text, values); return inner.query(text, values); },
    script: (sql) => inner.script(sql),
    close: () => inner.close(),
    transaction: (work) => inner.transaction((tx) => work({
      query: async (text, values) => { await before(text, values); return tx.query(text, values); },
      script: (sql) => tx.script(sql),
      close: () => tx.close(),
      transaction: (nested) => tx.transaction(nested),
    })),
  };
  return { texts, params };
}

test('with stages on, the job writes preparing, each stage the engine tells, then publishing, in that order', async () => {
  const h = await live();
  h.deps.stages = true;
  telling(h, PROGRESS);
  // Each write waits a little: the job still waits for the engine's before it records the review.
  const seen = watchStages(h.deps, { delayMs: 5 });
  await runReviewJob(h.job, h.deps);
  const id = h.job.id;
  assert.deepEqual(seen.params, [
    [id, 'preparing', at(0), null, null, null],
    [id, 'judging_threads', at(0), 1, 2, 1],
    [id, 'reviewing', at(0), 2, 2, null],
    [id, 'reviewing', at(0), 2, 2, null],
    [id, 'publishing', at(0), null, null, null],
  ]);
  const writes = seen.texts.flatMap((t, i) => (t.includes(STAGE_WRITE) ? [i] : []));
  const recordAt = seen.texts.findIndex((t) => t.includes('insert into visto_ai.review_runs'));
  assert.ok(recordAt > writes[3]! && recordAt < writes[4]!);
  assert.equal(typeof h.engines[0]!.progress, 'function');
  assert.equal((await getJob(db, id))?.outcome, 'published');
  // Written on its running row: the last stage stays.
  assert.deepEqual(await db.query('select stage, stage_at, batch, batches, threads_due from visto_ai.jobs where id = $1', [id]),
    [{ stage: 'publishing', stage_at: new Date(at(0)), batch: null, batches: null, threads_due: null }]);
});

test('in dry run the job writes no publishing stage', async () => {
  const h = await harness();
  h.deps.stages = true;
  // A progress whose counts are not whole numbers at or above 0 is not written.
  const odd: ReviewProgress[] = [{ batches: -1, ended: 0, threadsDue: 0 }, { batches: 2, ended: 0.5, threadsDue: 0 }, { batches: 2, ended: 0, threadsDue: Number.NaN }];
  telling(h, [...odd, ...PROGRESS]);
  const seen = watchStages(h.deps);
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(seen.params.map((p) => p.slice(1)), [
    ['preparing', at(0), null, null, null], ['judging_threads', at(0), 1, 2, 1], ['reviewing', at(0), 2, 2, null], ['reviewing', at(0), 2, 2, null],
  ]);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'reviewed');
});

test('a stage that cannot be written changes nothing and is not logged', async () => {
  const plain = await live({ pullRequest: 7 });
  telling(plain, PROGRESS);
  await runReviewJob(plain.job, plain.deps);
  const failing = await live({ pullRequest: 8 });
  failing.deps.stages = true;
  telling(failing, PROGRESS);
  const seen = watchStages(failing.deps, { fail: true });
  await runReviewJob(failing.job, failing.deps);
  assert.equal(seen.params.length, 5);
  const same = (x: Harness): Record<string, unknown> => ({ ...reviewLine(x), job: 0, number: 0, duration_ms: 0 });
  assert.deepEqual(same(failing), same(plain));
  assert.deepEqual(failing.drafts, plain.drafts);
  const runOf = async (number: number): Promise<Record<string, unknown>> => {
    const [run] = await listRuns(db, { ...REF, number });
    return { ...run!, id: 0, job: 0, ref: { ...run!.ref, number: 0 } };
  };
  assert.deepEqual(await runOf(8), await runOf(7));
  assert.deepEqual(failing.logged.map((e) => e.event), plain.logged.map((e) => e.event));
  assert.deepEqual([(await getJob(db, failing.job.id))?.outcome, (await getJob(db, plain.job.id))?.outcome], ['published', 'published']);
});

test('with stages off the engine is given no progress and no stage is written', async () => {
  for (const [number, dryRun] of [[7, true], [8, false]] as const) {
    const h = await harness({ pullRequest: number, dryRun });
    const seen = watchStages(h.deps);
    await runReviewJob(h.job, h.deps);
    assert.equal(h.engines.length, 1, String(number));
    assert.equal('progress' in h.engines[0]!, false, String(number));
    assert.ok(seen.texts.length > 0, String(number));
    assert.equal(seen.texts.some((t) => t.includes('set stage')), false, String(number));
  }
});

test('with stages on, a stage written slowly is not overtaken by the next: the row holds the last stage told', async () => {
  const h = await harness();
  h.deps.stages = true;
  // The first stage the engine tells is held until a turn of the event loop has passed: time for the next ones to be written, were they not chained.
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  h.deps.review = async (input, engine) => {
    h.inputs.push(input);
    h.engines.push(engine);
    for (const p of PROGRESS) engine.progress?.(p);
    await new Promise((resolve) => { setImmediate(resolve); });
    open();
    return okResult({ mode: input.mode ?? 'full' });
  };
  const inner = h.deps.db;
  let writes = 0;
  h.deps.db = {
    ...inner,
    query: async (text, values) => {
      if (text.includes(STAGE_WRITE)) {
        writes += 1;
        if (writes === 2) await opened;
      }
      return inner.query(text, values);
    },
  };
  const seen = watchStages(h.deps);
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(seen.params.map((p) => p[1]), ['preparing', 'judging_threads', 'reviewing', 'reviewing']);
  assert.deepEqual(await db.query('select stage, batch, batches, threads_due from visto_ai.jobs where id = $1', [h.job.id]),
    [{ stage: 'reviewing', batch: 2, batches: 2, threads_due: null }]);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'reviewed');
});

test('with stages on, preparing is the first statement the job runs: a job dropped at its first step has written it', async () => {
  const h = await harness({ stored: false });
  h.deps.stages = true;
  const seen = watchStages(h.deps);
  await runReviewJob(h.job, h.deps);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'no_installation');
  assert.equal(seen.texts[0]?.includes(STAGE_WRITE), true);
  assert.deepEqual(seen.params, [[h.job.id, 'preparing', at(0), null, null, null]]);
  assert.deepEqual(await db.query('select stage from visto_ai.jobs where id = $1', [h.job.id]), [{ stage: 'preparing' }]);
});

test('with stages on, the job waits for preparing to be written before its next step', async () => {
  const h = await harness();
  h.deps.stages = true;
  // The first stage's write is held for a while; every statement sent meanwhile is recorded.
  const order: string[] = [];
  const inner = h.deps.db;
  const held = (text: string): string => (text.includes(STAGE_WRITE) ? 'stage' : 'other');
  const watched = (query: Db['query']): Db['query'] => async <Row>(text: string, values?: unknown[]): Promise<Row[]> => {
    order.push(`${held(text)} sent`);
    if (held(text) === 'stage' && order.filter((o) => o === 'stage sent').length === 1) {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    const rows = await query<Row>(text, values);
    if (held(text) === 'stage') order.push('stage written');
    return rows;
  };
  h.deps.db = {
    query: watched((text, values) => inner.query(text, values)),
    script: (sql) => inner.script(sql),
    close: () => inner.close(),
    transaction: (work) => inner.transaction((tx) => work({ ...tx, query: watched((text, values) => tx.query(text, values)) })),
  };
  await runReviewJob(h.job, h.deps);
  assert.deepEqual(order.slice(0, 3), ['stage sent', 'stage written', 'other sent']);
  assert.equal((await getJob(db, h.job.id))?.outcome, 'reviewed');
});

test('with stages on, a later start whose time of posting cannot be written posts nothing and writes no publishing stage', async () => {
  const before = await live({ posts: [new Error('github_502')] });
  await runReviewJob(before.job, before.deps);
  const again = await live({ reuseJob: before.job.id, now: at(900) });
  again.deps.stages = true;
  const query = again.deps.db.query;
  again.deps.db = { ...again.deps.db, query: (text, params) => (text.includes('set publish_tried_at') ? Promise.reject(new Error('db_down')) : query(text, params)) };
  const seen = watchStages(again.deps);
  await runReviewJob(again.job, again.deps);
  assert.deepEqual([seen.params.map((p) => p[1]), again.writes, (await getJob(db, again.job.id))?.status], [['preparing'], [], 'pending']);
  // The start after it writes its time: it writes publishing, then posts.
  const due = await live({ reuseJob: again.job.id, now: at(1800) });
  due.deps.stages = true;
  const posting = watchStages(due.deps);
  await runReviewJob(due.job, due.deps);
  assert.deepEqual([posting.params.map((p) => p[1]), (await getJob(db, due.job.id))?.outcome], [['preparing', 'publishing'], 'published']);
});
