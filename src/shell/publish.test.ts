import test from 'node:test';
import assert from 'node:assert/strict';
import { fitBody, renderReview } from '../engine/render/body.ts';
import type { FileScore } from '../engine/score/types.ts';
import type { ReviewResult } from '../engine/types.ts';
import type { ApprovalCode } from '../approval/rule.ts';
import type { ApprovalThreads } from '../config/load.ts';
import { approvalParagraph } from '../approval/text.ts';
import type { StoredComment } from '../db/review-comments.ts';
import type { Association, ForgeAccess, ForgeApprovals, ForgeWriter, LivePullRequest, OwnReviewState, PostedComment, ReviewDraft, ReviewThread } from '../forge/types.ts';
import type { StoredRun } from '../db/review-runs.ts';
import { publishRun } from './publish.ts';
import type { ApprovalContext, PublishDeps, PublishOutcome } from './publish.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const LIVE: LivePullRequest = {
  info: { ref: REF, title: 'Add things', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'merge000', headSha: 'h1', draft: false },
  state: 'open',
};
const USAGE = { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.5 };
const okResult = (): ReviewResult => ({
  status: 'ok', failure: null, mode: 'full', overview: 'Looks fine.',
  findings: [{ path: 'a.ts', side: 'RIGHT', line: 3, severity: 'minor', body: 'A note.', quote: 'x', requestedLine: null }],
  unplaced: [], beyondDiff: [], coverage: { reviewed: ['a.ts'], notReviewed: [] }, usage: USAGE, models: ['m'], providers: [],
  dependencies: { model: 'ok' }, audit: [], scores: [], verdict: { threshold: 70, needsHuman: false, highest: 35 }, teamFileInvalid: null,
});
const lineUrl = (): string => 'https://forge.example.test/line';
const rendered = renderReview(okResult(), { trigger: 'automatic', requestedBy: null, lineUrl, inline: true });
const run: StoredRun = {
  id: 4, ref: REF, job: 1, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'merge000', baseBranch: null,
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: rendered.body, comments: rendered.comments, result: okResult(), usage: USAGE, startedAt: at(0), finishedAt: at(1),
  published: false, reviewId: null, publishedAt: null, inlineDropped: false, publishTriedAt: null,
};

interface Options {
  live?: LivePullRequest | Error | null;
  own?: Array<{ id: string; commit: string; state?: OwnReviewState }> | Error;
  posted?: PostedComment[] | Error;
  posts?: Array<{ id: string } | Error>;
  run?: StoredRun;
  /** The ids of the reviews the database holds as published; none when not given. */
  known?: ReadonlySet<string>;
  resumed?: boolean;
  hold?: boolean;
  /** What listThreads answers, or the Error it rejects with; no thread when not given. */
  threads?: unknown;
  /** What the branch's rule answers, whatever its shape, or the Error it rejects with; 'dismissed' when the key is not given. */
  rule?: unknown;
  approval?: ApprovalContext;
  ownRun?: boolean;
  trigger?: 'automatic' | 'manual';
  requestedBy?: string | null;
  /** The read of the pull request is put in the calls too. */
  readsLive?: boolean;
}

function harness(options: Options = {}) {
  const calls: unknown[][] = [];
  const drafts: ReviewDraft[] = [];
  const posts = [...(options.posts ?? [])];
  const live = options.live === undefined ? LIVE : options.live;
  const forge = {
    readPullRequest: async () => {
      if (options.readsLive === true) calls.push(['readPullRequest']);
      if (live instanceof Error) throw live;
      return live;
    },
  } as unknown as ForgeAccess;
  const approvals: ForgeApprovals = {
    staleApprovals: async (_ref, _installation, branch) => {
      calls.push(['staleApprovals', branch]);
      const rule = 'rule' in options ? options.rule : 'dismissed';
      if (rule instanceof Error) throw rule;
      return rule as 'dismissed' | 'kept';
    },
    readReview: () => Promise.reject(new Error('not_expected')),
    dismissReview: () => Promise.reject(new Error('not_expected')),
  };
  const writer: ForgeWriter = {
    publishReview: async (_ref, _installation, draft) => {
      calls.push(['publishReview', draft.commit, draft.body, draft.comments.length]);
      drafts.push(draft);
      const next = posts.shift() ?? { id: '501' };
      if (next instanceof Error) throw next;
      return next;
    },
    listOwnReviews: async () => {
      calls.push(['listOwnReviews']);
      const own = options.own ?? [];
      if (own instanceof Error) throw own;
      return own;
    },
    listReviewComments: async () => {
      calls.push(['listReviewComments']);
      const posted = options.posted ?? [{ id: '9001', path: 'a.ts', side: 'RIGHT', line: 3, body: 'x' }];
      if (posted instanceof Error) throw posted;
      return posted;
    },
    react: async () => { calls.push(['react']); },
    comment: async () => { calls.push(['comment']); },
    listThreads: async () => {
      calls.push(['listThreads']);
      const threads = options.threads === undefined ? [] : options.threads;
      if (threads instanceof Error) throw threads;
      return threads as ReviewThread[];
    },
    replyToThread: () => Promise.reject(new Error('not_expected')),
    editThreadComment: () => Promise.reject(new Error('not_expected')),
    resolveThread: () => Promise.reject(new Error('not_expected')),
  };
  const deps: PublishDeps = { forge, writer, approvals, lineUrl, commentUrl: (_ref: unknown, id: string) => `https://forge.example.test/c/${id}` };
  return {
    calls, drafts, deps,
    args: {
      ref: REF, installation: '99', run: options.run ?? run, trigger: options.trigger ?? 'automatic' as const, requestedBy: options.requestedBy ?? null,
      known: options.known ?? new Set<string>(), resumed: options.resumed ?? false, hold: options.hold ?? false,
      ...(options.approval === undefined ? {} : { approval: options.approval }), ...(options.ownRun === undefined ? {} : { ownRun: options.ownRun }),
    },
  };
}

test('a review is posted pinned to the commit it was computed for', async () => {
  const h = harness();
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '501', body: run.body, inlineDropped: false, notesDropped: false, adopted: false });
  assert.deepEqual(h.calls, [['listOwnReviews'], ['publishReview', 'h1', run.body, 1]]);
});
test('a review an earlier attempt already posted is adopted, and nothing is posted', async () => {
  const h = harness({ own: [{ id: '480', commit: 'h1' }] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '480', body: run.body, inlineDropped: false, notesDropped: false, adopted: true });
  assert.equal(h.calls.some((c) => c[0] === 'publishReview'), false);
});
test('an adopted review that was posted without its inline comments is recorded as such', async () => {
  const h = harness({ own: [{ id: '480', commit: 'h1' }], posted: [] });
  const out = await publishRun(h.deps, h.args);
  assert.equal(out.kind, 'published');
  if (out.kind !== 'published') return;
  assert.deepEqual([out.reviewId, out.adopted, out.inlineDropped, out.body !== run.body], ['480', true, true, true]);
});
test('a review on another commit does not stop the post', async () => {
  const h = harness({ own: [{ id: '401', commit: 'h0' }], known: new Set(['401']) });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '501', body: run.body, inlineDropped: false, notesDropped: false, adopted: false });
  assert.deepEqual(h.calls, [['listOwnReviews'], ['publishReview', 'h1', run.body, 1]]);
});
test('only a review on this commit that the database does not know is adopted', async () => {
  const unknown = harness({ own: [{ id: '401', commit: 'h1' }] });
  assert.deepEqual(await publishRun(unknown.deps, unknown.args), { kind: 'published', reviewId: '401', body: run.body, inlineDropped: false, notesDropped: false, adopted: true });
  assert.equal(unknown.calls.some((c) => c[0] === 'publishReview'), false);
  const known = harness({ own: [{ id: '401', commit: 'h1' }], known: new Set(['401']) });
  assert.deepEqual(await publishRun(known.deps, known.args), { kind: 'published', reviewId: '501', body: run.body, inlineDropped: false, notesDropped: false, adopted: false });
  assert.deepEqual(known.calls, [['listOwnReviews'], ['publishReview', 'h1', run.body, 1]]);
});
test('nothing is posted for a head or a base that moved, or on a pull request that is closed or gone', async () => {
  const cases: Array<[LivePullRequest | null, PublishOutcome]> = [
    [{ ...LIVE, info: { ...LIVE.info, headSha: 'h2' } }, { kind: 'moved', head: 'h2' }],
    [{ ...LIVE, info: { ...LIVE.info, baseSha: 'merge999' } }, { kind: 'moved', head: 'h1' }],
    [{ ...LIVE, state: 'closed' }, { kind: 'closed' }], [{ ...LIVE, state: 'merged' }, { kind: 'closed' }], [null, { kind: 'closed' }],
  ];
  for (const [live, expected] of cases) {
    const h = harness({ live });
    assert.deepEqual(await publishRun(h.deps, h.args), expected);
    assert.deepEqual(h.calls, []);
  }
});
test('a run with no base moved: its base never equals the live one', async () => {
  const h = harness({ run: { ...run, baseSha: null } });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'moved', head: 'h1' });
  assert.deepEqual(h.calls, []);
});
test('when the inline comments are refused, the review is posted with their text in its body, still pinned', async () => {
  const h = harness({ posts: [new Error('review_rejected'), { id: '502' }] });
  const out = await publishRun(h.deps, h.args);
  assert.equal(out.kind, 'published');
  if (out.kind !== 'published') return;
  assert.deepEqual([out.reviewId, out.inlineDropped, out.adopted, out.body !== run.body], ['502', true, false, true]);
  assert.deepEqual(h.calls.slice(1), [['publishReview', 'h1', run.body, 1], ['publishReview', 'h1', out.body, 0]]);
});
test("the fallback's body is the review rendered without inline comments", async () => {
  const h = harness({ posts: [new Error('review_rejected'), { id: '502' }] });
  const out = await publishRun(h.deps, h.args);
  assert.equal(out.kind, 'published');
  if (out.kind !== 'published') return;
  assert.equal(out.body, renderReview(okResult(), { trigger: 'automatic', requestedBy: null, lineUrl, inline: false }).body);
});
test('a review the git service refuses twice, or refuses with no inline comment, is rejected', async () => {
  const twice = harness({ posts: [new Error('review_rejected'), new Error('review_rejected')] });
  assert.deepEqual(await publishRun(twice.deps, twice.args), { kind: 'rejected' });
  const bare = harness({ posts: [new Error('review_rejected')], run: { ...run, comments: [] } });
  assert.deepEqual(await publishRun(bare.deps, bare.args), { kind: 'rejected' });
  assert.equal(bare.calls.filter((c) => c[0] === 'publishReview').length, 1);
});
test('any other failure says so with its code, and a post that failed is not repeated', async () => {
  const cases: Array<[Options, string]> = [
    [{ live: new Error('github_502') }, 'github_502'], [{ own: new Error('github_network') }, 'github_network'],
    [{ own: [{ id: '480', commit: 'h1' }], posted: new Error('github_502') }, 'github_502'],
    [{ posts: [new Error('github_502')] }, 'github_502'], [{ posts: [new Error('Something private')] }, 'internal_error'],
    [{ posts: [new Error('review_rejected'), new Error('github_network')] }, 'github_network'],
  ];
  for (const [options, code] of cases) {
    const h = harness(options);
    assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'failed', code });
    assert.equal(h.calls.filter((c) => c[0] === 'publishReview').length, options?.posts?.length ?? 0);
  }
});
test("the body-only form links each finding already discussed to its earlier thread", async () => {
  const result: ReviewResult = { ...okResult(), alreadyDiscussed: [{ path: 'a.ts', side: 'RIGHT', line: 3, severity: 'major', body: 'Raised before.', commentId: '8001', resolved: false, settled: false }] };
  const h = harness({ posts: [new Error('review_rejected'), { id: '502' }], run: { ...run, result } });
  const out = await publishRun(h.deps, h.args);
  assert.equal(out.kind, 'published');
  if (out.kind !== 'published') return;
  assert.equal(out.inlineDropped, true);
  assert.ok(out.body.includes('## Already discussed'));
  assert.ok(out.body.includes('(https://forge.example.test/c/8001)'));
});

const NOTE = { path: 'a.ts', side: 'RIGHT', line: 5, body: '**Human review:** line 5, 80% `logic`', note: 'hash5' } as const;
const FINDING = (rendered.comments as unknown[])[0];
const withNote: StoredRun = { ...run, comments: [FINDING, NOTE] };
const bodyOnlyText = renderReview(okResult(), { trigger: 'automatic', requestedBy: null, lineUrl, inline: false }).body;
const postCount = (calls: unknown[][]): number => calls.filter((c) => c[0] === 'publishReview').length;

test('a review with notes is posted with them', async () => {
  const h = harness({ run: withNote });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '501', body: run.body, inlineDropped: false, notesDropped: false, adopted: false });
  assert.equal(postCount(h.calls), 1);
  assert.deepEqual(h.drafts[0]?.comments, [FINDING, NOTE]);
});
test('refused with notes, the review is posted again without them and the findings stay inline', async () => {
  const h = harness({ run: withNote, posts: [new Error('review_rejected'), { id: '502' }] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '502', body: run.body, inlineDropped: false, notesDropped: true, adopted: false });
  assert.equal(postCount(h.calls), 2);
  assert.equal(h.drafts[1]?.body, run.body);
  assert.deepEqual(h.drafts[1]?.comments, [FINDING]);
});
test('refused again, it is posted as body only', async () => {
  const h = harness({ run: withNote, posts: [new Error('review_rejected'), new Error('review_rejected'), { id: '503' }] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '503', body: bodyOnlyText, inlineDropped: true, notesDropped: true, adopted: false });
  assert.equal(postCount(h.calls), 3);
  assert.deepEqual(h.drafts[2], { commit: 'h1', body: bodyOnlyText, comments: [] });
});
test('a review with notes and no finding is posted without them when refused', async () => {
  const onlyNote: StoredRun = { ...run, comments: [NOTE] };
  const once = harness({ run: onlyNote, posts: [new Error('review_rejected'), { id: '502' }] });
  assert.deepEqual(await publishRun(once.deps, once.args), { kind: 'published', reviewId: '502', body: run.body, inlineDropped: false, notesDropped: true, adopted: false });
  assert.deepEqual(once.drafts[1], { commit: 'h1', body: run.body, comments: [] });
  const twice = harness({ run: onlyNote, posts: [new Error('review_rejected'), new Error('review_rejected')] });
  assert.deepEqual(await publishRun(twice.deps, twice.args), { kind: 'rejected' });
  assert.equal(postCount(twice.calls), 2);
});
test('a review with no note is retried as today', async () => {
  const h = harness({ posts: [new Error('review_rejected'), { id: '502' }] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '502', body: bodyOnlyText, inlineDropped: true, notesDropped: false, adopted: false });
  assert.equal(postCount(h.calls), 2);
  assert.deepEqual(h.drafts[1], { commit: 'h1', body: bodyOnlyText, comments: [] });
});
test('an error that is not a refusal ends the publication at once', async () => {
  const h = harness({ run: withNote, posts: [new Error('review_rejected'), new Error('github_502'), { id: '503' }] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'failed', code: 'github_502' });
  assert.equal(postCount(h.calls), 2);
});
test('an adopted review whose listed comments are not the notes has lost its notes', async () => {
  const h = harness({ run: withNote, own: [{ id: '480', commit: 'h1' }], posted: [{ id: '9001', path: 'a.ts', side: 'RIGHT', line: 3, body: 'x' }] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '480', body: run.body, inlineDropped: false, notesDropped: true, adopted: true });
  assert.equal(postCount(h.calls), 0);
});
test('an adopted review that holds only the note has lost its findings', async () => {
  const h = harness({ run: withNote, own: [{ id: '480', commit: 'h1' }], posted: [{ id: '9002', path: 'a.ts', side: 'RIGHT', line: 5, body: NOTE.body }] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '480', body: bodyOnlyText, inlineDropped: true, notesDropped: false, adopted: true });
  assert.equal(postCount(h.calls), 0);
});
test('an adopted review with nothing listed has lost its notes and its findings', async () => {
  const h = harness({ run: withNote, own: [{ id: '480', commit: 'h1' }], posted: [] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '480', body: bodyOnlyText, inlineDropped: true, notesDropped: true, adopted: true });
  assert.equal(postCount(h.calls), 0);
});
test('an adopted review whose comment list was cut short drops nothing', async () => {
  const h = harness({ run: withNote, own: [{ id: '480', commit: 'h1' }] });
  h.deps.writer.listReviewComments = async () => null;
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '480', body: run.body, inlineDropped: false, notesDropped: false, adopted: true });
  assert.equal(postCount(h.calls), 0);
});
test('a comment list that is not a list is posted as the body alone', async () => {
  const h = harness({ run: { ...run, comments: { 0: FINDING } } });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '501', body: run.body, inlineDropped: false, notesDropped: false, adopted: false });
  assert.equal(postCount(h.calls), 1);
  assert.deepEqual(h.drafts[0]?.comments, []);
});
test('an entry of the comment list that is not an object is dropped', async () => {
  const h = harness({ run: { ...run, comments: [FINDING, 'x', null, 7] } });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '501', body: run.body, inlineDropped: false, notesDropped: false, adopted: false });
  assert.equal(postCount(h.calls), 1);
  assert.deepEqual(h.drafts[0]?.comments, [FINDING]);
});
test('a review a later start publishes goes without its notes', async () => {
  const h = harness({ run: withNote, resumed: true });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '501', body: run.body, inlineDropped: false, notesDropped: true, adopted: false });
  assert.equal(postCount(h.calls), 1);
  assert.deepEqual(h.drafts[0]?.comments, [FINDING]);
});
test('a review a later start publishes that is refused is posted as body only', async () => {
  const h = harness({ run: withNote, resumed: true, posts: [new Error('review_rejected'), { id: '502' }] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '502', body: bodyOnlyText, inlineDropped: true, notesDropped: true, adopted: false });
  assert.equal(postCount(h.calls), 2);
  assert.deepEqual(h.drafts[1], { commit: 'h1', body: bodyOnlyText, comments: [] });
});
test('a review a later start publishes that GitHub already holds is adopted', async () => {
  const h = harness({ run: withNote, resumed: true, own: [{ id: '480', commit: 'h1' }],
    posted: [{ id: '9001', path: 'a.ts', side: 'RIGHT', line: 3, body: 'x' }, { id: '9002', path: 'a.ts', side: 'RIGHT', line: 5, body: NOTE.body }] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '480', body: run.body, inlineDropped: false, notesDropped: false, adopted: true });
  assert.equal(postCount(h.calls), 0);
});
test('a held review that GitHub does not list is not posted', async () => {
  const h = harness({ run: withNote, resumed: true, hold: true });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'unlisted' });
  assert.deepEqual(h.calls, [['listOwnReviews']]);
});
test('a held review that GitHub lists is adopted all the same', async () => {
  const h = harness({ resumed: true, hold: true, own: [{ id: '480', commit: 'h1' }] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '480', body: run.body, inlineDropped: false, notesDropped: false, adopted: true });
  assert.equal(postCount(h.calls), 0);
});
test('a held review is not listed by a review the database knows, nor by one on another commit', async () => {
  for (const [own, known] of [[{ id: '401', commit: 'h1' }, ['401']], [{ id: '470', commit: 'h0' }, []]] as const) {
    const h = harness({ resumed: true, hold: true, own: [own], known: new Set(known) });
    assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'unlisted' }, own.id);
    assert.equal(postCount(h.calls), 0);
  }
});
test('a held review of a pull request that closed or moved ends as closed or moved', async () => {
  const closed = harness({ resumed: true, hold: true, live: { ...LIVE, state: 'closed' } });
  assert.deepEqual(await publishRun(closed.deps, closed.args), { kind: 'closed' });
  const moved = harness({ resumed: true, hold: true, live: { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } } });
  assert.deepEqual(await publishRun(moved.deps, moved.args), { kind: 'moved', head: 'h2' });
});

const REASON_NOTE = { path: 'a.ts', side: 'RIGHT', line: 5, body: '**Human review:** line 5, 80% `calculation` \u2014 Totals are rounded twice.', note: 'hash5' } as const;
const withReasonNote: StoredRun = { ...run, comments: [FINDING, REASON_NOTE] };
test('at adoption a note GitHub gave back with its reason changed is a note GitHub holds', async () => {
  const b = REASON_NOTE.body;
  for (const body of [b.replace('twice', 'twicE'), b.replace('twice', 'twce'), b.slice(0, -10), b.replace('\u2014', '-')]) {
    const h = harness({ run: withReasonNote, own: [{ id: '480', commit: 'h1' }],
      posted: [{ id: '9001', path: 'a.ts', side: 'RIGHT', line: 3, body: 'x' }, { id: '9002', path: 'a.ts', side: 'RIGHT', line: 5, body }] });
    assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '480', body: run.body, inlineDropped: false, notesDropped: false, adopted: true }, body);
    assert.equal(postCount(h.calls), 0);
  }
});
test('at adoption a comment that only begins as a note does, with another label, is no note of the run', async () => {
  for (const body of ['**Human review:** line 6, 80% `calculation` \u2014 Totals are rounded twice.', '**Human review:** line 5, 81% `calculation`', '**Human review:**']) {
    const h = harness({ run: withReasonNote, own: [{ id: '480', commit: 'h1' }],
      posted: [{ id: '9001', path: 'a.ts', side: 'RIGHT', line: 3, body: 'x' }, { id: '9002', path: 'a.ts', side: 'RIGHT', line: 5, body }] });
    const out = await publishRun(h.deps, h.args);
    assert.equal(out.kind === 'published' && out.notesDropped, true, body);
  }
});

// Automatic approval.
const LIVE_OK: LivePullRequest = { ...LIVE, info: { ...LIVE.info, fromFork: false } };
const commentUrl = (id: string): string => `https://forge.example.test/c/${id}`;
const fileScore = (path: string, finalScore: number, over: Partial<FileScore> = {}): FileScore => ({
  path, previousPath: null, diffHash: 'd1', changeSummary: '', changedLines: 3, blocks: [], wholeFile: null, fileLevel: null, finalScore, covered: true, ...over,
});
/** A result every stored condition of approval holds for: one file covered at 35, one minor finding, threshold 70. */
const approvable = (over: Partial<ReviewResult> = {}): ReviewResult => ({ ...okResult(), scores: [fileScore('a.ts', 35)], ...over });
/** A run of `result`, recorded as a job with that trigger and requester renders it. */
const recordedWith = (result: ReviewResult, meta: { trigger?: 'automatic' | 'manual'; requestedBy?: string | null } = {}): StoredRun => {
  const trigger = meta.trigger ?? 'automatic';
  const r = renderReview(result, { trigger, requestedBy: meta.requestedBy ?? null, lineUrl, inline: true, commentUrl });
  return { ...run, trigger, result, body: r.body, comments: r.comments };
};
const RUN_OK = recordedWith(approvable());
/** An earlier review of the pull request, published as review 480. */
const EARLIER: StoredRun = { ...RUN_OK, id: 3, job: 2, published: true, reviewId: '480', publishedAt: at(0) };
const ctx = (over: Partial<ApprovalContext> = {}): ApprovalContext => ({ rule: 'strict', clearByReply: true, threshold: 70, runs: [RUN_OK], stored: [], drawn: () => false, ...over });
const para = (decided: ApprovalCode, more: { code?: string; rule?: ApprovalThreads } = {}): string =>
  approvalParagraph(decided, { head: 'h1', threshold: 70, rule: more.rule ?? 'strict', ...(more.code === undefined ? {} : { code: more.code }) });
/** The body this job renders for `result` with the paragraph `p`. */
const withPara = (result: ReviewResult, p: string, inline = true): string =>
  renderReview(result, { trigger: 'automatic', requestedBy: null, lineUrl, inline, commentUrl, approval: p }).body;
/** Approval on: an approvable run on a pull request from the repository itself, the read of the pull request in the calls. */
const onHarness = (options: Options = {}) => harness({ run: RUN_OK, live: LIVE_OK, approval: ctx(), readsLive: true, ...options });
/** An open thread of the app's own, opened by review 480 with comment `commentId`. */
const appThread = (commentId: string, body = '**\\[major]** Check it.'): ReviewThread => ({
  id: `PRRT_${commentId}`, path: 'a.ts', side: 'RIGHT', line: 3, resolved: false, resolvedByApp: false,
  comments: [{ id: commentId, node: `N${commentId}`, author: 'visto-test[bot]', authorIsBot: true, byApp: true, reviewId: '480', body, at: at(0) }],
});
const STORED_MAJOR: StoredComment & { run: number } = { commentId: '8001', path: 'a.ts', side: 'RIGHT', line: 3, severity: 'major', quote: 'x', run: 3 };
const names = (calls: unknown[][]): unknown[] => calls.map((c) => c[0]);
const REJECTED = (): Error => new Error('review_rejected');
/** A job that did not record the run: asked by someone else, or automatic. */
const JOBS = [{ trigger: 'manual', requestedBy: 'octo-dev' }, { trigger: 'automatic', requestedBy: null }] as const;
/** The app's major thread 8001, resolved, with one reply of `author`, whose access GitHub reports as `association`. */
const repliedThread = (author: string, association: Association): ReviewThread => {
  const t = appThread('8001');
  const reply = { id: '9001', node: 'N9001', author, authorIsBot: false, byApp: false, reviewId: null, body: 'Meant to be so.', at: at(5), association };
  return { ...t, resolved: true, comments: [t.comments[0]!, reply] };
};

test('with approval off the reads and the post are what they were', async () => {
  // The first test of this file, with the approvals at hand and ownRun said or not: the same reads, the same draft, no event, no approval key.
  for (const ownRun of [undefined, true, false]) {
    const h = harness({ readsLive: true, ...(ownRun === undefined ? {} : { ownRun }) });
    assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '501', body: run.body, inlineDropped: false, notesDropped: false, adopted: false }, String(ownRun));
    assert.deepEqual(h.calls, [['readPullRequest'], ['listOwnReviews'], ['publishReview', 'h1', run.body, 1]], String(ownRun));
    assert.deepEqual(h.drafts, [{ commit: 'h1', body: run.body, comments: run.comments }], String(ownRun));
  }
  // A run every condition would hold for is still a comment, with its recorded body.
  const ok = harness({ run: RUN_OK, live: LIVE_OK, readsLive: true });
  assert.deepEqual(await publishRun(ok.deps, ok.args), { kind: 'published', reviewId: '501', body: RUN_OK.body, inlineDropped: false, notesDropped: false, adopted: false });
  assert.deepEqual(ok.calls, [['readPullRequest'], ['listOwnReviews'], ['publishReview', 'h1', RUN_OK.body, 1]]);
  assert.deepEqual(ok.drafts, [{ commit: 'h1', body: RUN_OK.body, comments: RUN_OK.comments }]);
  // "a review with no note is retried as today": the same two drafts.
  for (const ownRun of [undefined, false]) {
    const r = harness({ posts: [REJECTED(), { id: '502' }], ...(ownRun === undefined ? {} : { ownRun }) });
    assert.deepEqual(await publishRun(r.deps, r.args), { kind: 'published', reviewId: '502', body: bodyOnlyText, inlineDropped: true, notesDropped: false, adopted: false });
    assert.deepEqual(r.drafts, [{ commit: 'h1', body: run.body, comments: run.comments }, { commit: 'h1', body: bodyOnlyText, comments: [] }]);
  }
});

test('an approvable review is posted as an approval that ends with the approved paragraph, after the threads and the rule were read', async () => {
  const h = onHarness();
  const body = withPara(approvable(), para('approved'));
  assert.ok(body.endsWith(`\n\n${para('approved')}`));
  assert.deepEqual(await publishRun(h.deps, h.args), {
    kind: 'published', reviewId: '501', body, inlineDropped: false, notesDropped: false, adopted: false, approval: { approved: true, code: 'approved', dismissed: false },
  });
  assert.deepEqual(h.calls, [['readPullRequest'], ['listOwnReviews'], ['listThreads'], ['staleApprovals', 'main'], ['publishReview', 'h1', body, 1]]);
  assert.deepEqual(h.drafts, [{ commit: 'h1', body, comments: RUN_OK.comments, event: 'approve' }]);
  // The rule is read on the live base branch.
  const other = onHarness({ live: { ...LIVE_OK, info: { ...LIVE_OK.info, baseBranch: 'release/1.0' } } });
  await publishRun(other.deps, other.args);
  assert.deepEqual(other.calls.find((c) => c[0] === 'staleApprovals'), ['staleApprovals', 'release/1.0']);
  // A minor's thread the database did not hold is tied to its finding from the threads, and holds nothing back.
  const minorBody = (EARLIER.comments as Array<{ body: string }>)[0]!.body;
  const repaired = onHarness({ approval: ctx({ runs: [EARLIER, RUN_OK] }), threads: [appThread('8002', minorBody)] });
  const out = await publishRun(repaired.deps, repaired.args);
  assert.equal(out.kind === 'published' && out.approval?.code, 'approved');
  // Not tied (its review is no run's), it is the app's thread with no stored finding: open.
  const untied = onHarness({ approval: ctx({ runs: [{ ...EARLIER, reviewId: '479' }, RUN_OK] }), threads: [appThread('8002', minorBody)] });
  const held = await publishRun(untied.deps, untied.args);
  assert.equal(held.kind === 'published' && held.approval?.code, 'open_thread');
});

test('each refusal posts a comment that ends with its paragraph, and reads no further than it needed', async () => {
  const NOT_COVERED = recordedWith(okResult());
  const upToLive = ['readPullRequest', 'listOwnReviews', 'publishReview'];
  const upToThreads = ['readPullRequest', 'listOwnReviews', 'listThreads', 'publishReview'];
  const upToRule = ['readPullRequest', 'listOwnReviews', 'listThreads', 'staleApprovals', 'publishReview'];
  const cases: Array<[Options, ApprovalCode, string | undefined, unknown[]]> = [
    [{ run: NOT_COVERED, approval: ctx({ runs: [NOT_COVERED] }) }, 'not_covered', undefined, upToLive],
    [{ live: { ...LIVE_OK, info: { ...LIVE_OK.info, draft: true, fromFork: true } } }, 'draft', undefined, upToLive],
    [{ live: { ...LIVE_OK, info: { ...LIVE_OK.info, fromFork: true } } }, 'from_fork', undefined, upToLive],
    [{ live: LIVE }, 'origin_unknown', undefined, upToLive],
    [{ approval: ctx({ runs: [EARLIER, RUN_OK], stored: [STORED_MAJOR] }), threads: [appThread('8001')] }, 'open_thread', undefined, upToThreads],
    [{ rule: 'kept' }, 'rule_off', undefined, upToRule],
    [{ rule: new Error('github_403') }, 'rule_unreadable', 'github_403', upToRule],
    [{ rule: new Error('Something private') }, 'rule_unreadable', 'internal_error', upToRule],
  ];
  for (const [options, code, shown, reads] of cases) {
    const h = onHarness(options);
    const recorded = options.run ?? RUN_OK;
    const p = para(code, shown === undefined ? {} : { code: shown });
    const body = withPara(recorded.result as ReviewResult, p);
    assert.ok(body.endsWith(`\n\n${p}`), code);
    assert.deepEqual(await publishRun(h.deps, h.args), {
      kind: 'published', reviewId: '501', body, inlineDropped: false, notesDropped: false, adopted: false, approval: { approved: false, code, dismissed: false },
    }, code);
    assert.deepEqual(names(h.calls), reads, code);
    assert.deepEqual(h.drafts, [{ commit: 'h1', body, comments: recorded.comments }], code);
  }
  assert.ok(para('rule_unreadable', { code: 'github_403' }).includes('(`github_403`)'));
  // With no approvals at hand the rule cannot be read.
  const bare = onHarness();
  delete bare.deps.approvals;
  const out = await publishRun(bare.deps, bare.args);
  assert.equal(out.kind === 'published' && out.body, withPara(approvable(), para('rule_unreadable', { code: 'internal_error' })));
  assert.deepEqual(out.kind === 'published' && out.approval, { approved: false, code: 'rule_unreadable', dismissed: false });
  assert.deepEqual(names(bare.calls), upToThreads);
});

test('a thread list that cannot be read is threads_unreadable, never no thread', async () => {
  const cases: Array<[unknown, string]> = [[new Error('github_502'), 'github_502'], [{}, 'internal_error'], [null, 'internal_error'], [new Error('Something private'), 'internal_error']];
  for (const [threads, shown] of cases) {
    const h = onHarness({ threads });
    const body = withPara(approvable(), para('threads_unreadable', { code: shown }));
    assert.deepEqual(await publishRun(h.deps, h.args), {
      kind: 'published', reviewId: '501', body, inlineDropped: false, notesDropped: false, adopted: false, approval: { approved: false, code: 'threads_unreadable', dismissed: false },
    }, shown);
    assert.deepEqual(names(h.calls), ['readPullRequest', 'listOwnReviews', 'listThreads', 'publishReview'], shown);
    assert.equal('event' in h.drafts[0]!, false);
  }
});

test('a stored finding whose thread is gone is open_thread, and the rule is not read', async () => {
  for (const rule of ['strict', 'gate'] as const) {
    const h = onHarness({ approval: ctx({ rule, runs: [EARLIER, RUN_OK], stored: [STORED_MAJOR] }), threads: [] });
    const body = withPara(approvable(), approvalParagraph('open_thread', { head: 'h1', threshold: 70, rule }));
    assert.deepEqual(await publishRun(h.deps, h.args), {
      kind: 'published', reviewId: '501', body, inlineDropped: false, notesDropped: false, adopted: false, approval: { approved: false, code: 'open_thread', dismissed: false },
    }, rule);
    assert.deepEqual(names(h.calls), ['readPullRequest', 'listOwnReviews', 'listThreads', 'publishReview'], rule);
  }
});

test('runs or comments that could not be read are record_unreadable, and the review is still posted', async () => {
  for (const over of [{ runs: null }, { stored: null }, { runs: null, stored: null }]) {
    const h = onHarness({ approval: ctx(over) });
    const body = withPara(approvable(), para('record_unreadable'));
    assert.deepEqual(await publishRun(h.deps, h.args), {
      kind: 'published', reviewId: '501', body, inlineDropped: false, notesDropped: false, adopted: false, approval: { approved: false, code: 'record_unreadable', dismissed: false },
    }, JSON.stringify(over));
    assert.deepEqual(names(h.calls), ['readPullRequest', 'listOwnReviews', 'publishReview']);
    assert.deepEqual(h.drafts, [{ commit: 'h1', body, comments: RUN_OK.comments }]);
  }
});

test('an approval GitHub refuses is posted once more as a comment with the refused paragraph, and then as today', async () => {
  const approved = withPara(approvable(), para('approved'));
  const refused = para('refused', { code: 'review_rejected' });
  const asComment = withPara(approvable(), refused);
  const bodyOnly = withPara(approvable(), refused, false);
  const outcome = { approval: { approved: false, code: 'refused', dismissed: false }, adopted: false };
  // Refused once: the same comments, as a comment.
  const once = onHarness({ posts: [REJECTED(), { id: '502' }] });
  assert.deepEqual(await publishRun(once.deps, once.args), { kind: 'published', reviewId: '502', body: asComment, inlineDropped: false, notesDropped: false, ...outcome });
  assert.deepEqual(once.drafts, [
    { commit: 'h1', body: approved, comments: RUN_OK.comments, event: 'approve' },
    { commit: 'h1', body: asComment, comments: RUN_OK.comments },
  ]);
  assert.deepEqual(names(once.calls), ['readPullRequest', 'listOwnReviews', 'listThreads', 'staleApprovals', 'publishReview', 'publishReview']);
  // Refused twice: the body alone, with no comment.
  const twice = onHarness({ posts: [REJECTED(), REJECTED(), { id: '503' }] });
  assert.deepEqual(await publishRun(twice.deps, twice.args), { kind: 'published', reviewId: '503', body: bodyOnly, inlineDropped: true, notesDropped: false, ...outcome });
  assert.deepEqual(twice.drafts, [
    { commit: 'h1', body: approved, comments: RUN_OK.comments, event: 'approve' },
    { commit: 'h1', body: asComment, comments: RUN_OK.comments },
    { commit: 'h1', body: bodyOnly, comments: [] },
  ]);
  // With notes: every comment as an approval, then as a comment, then without the notes, then the body alone; never an approval again.
  const noted: StoredRun = { ...RUN_OK, comments: [FINDING, NOTE] };
  const four = onHarness({ run: noted, approval: ctx({ runs: [noted] }), posts: [REJECTED(), REJECTED(), REJECTED(), { id: '504' }] });
  assert.deepEqual(await publishRun(four.deps, four.args), { kind: 'published', reviewId: '504', body: bodyOnly, inlineDropped: true, notesDropped: true, ...outcome });
  assert.deepEqual(four.drafts, [
    { commit: 'h1', body: approved, comments: [FINDING, NOTE], event: 'approve' },
    { commit: 'h1', body: asComment, comments: [FINDING, NOTE] },
    { commit: 'h1', body: asComment, comments: [FINDING] },
    { commit: 'h1', body: bodyOnly, comments: [] },
  ]);
  // Refused with no inline comment at all: rejected, as today.
  const bare: StoredRun = { ...RUN_OK, comments: [] };
  const none = onHarness({ run: bare, approval: ctx({ runs: [bare] }), posts: [REJECTED(), REJECTED()] });
  assert.deepEqual(await publishRun(none.deps, none.args), { kind: 'rejected' });
  assert.deepEqual(none.drafts.map((d) => d.event), ['approve', undefined]);
});

test('an approval that fails for another reason is a failure, as a comment is', async () => {
  const h = onHarness({ posts: [new Error('github_502')] });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'failed', code: 'github_502' });
  assert.equal(postCount(h.calls), 1);
  assert.equal(h.drafts[0]?.event, 'approve');
  // Refused, then failing as a comment: a failure too, and nothing more is sent.
  const then = onHarness({ posts: [REJECTED(), new Error('github_network'), { id: '503' }] });
  assert.deepEqual(await publishRun(then.deps, then.args), { kind: 'failed', code: 'github_network' });
  assert.equal(postCount(then.calls), 2);
});

test('an adopted review keeps what GitHub holds: an approval, a dismissed one, or a comment', async () => {
  const cases: Array<[OwnReviewState | undefined, object]> = [
    ['approved', { approval: { approved: true, code: null, dismissed: false } }],
    ['dismissed', { approval: { approved: true, code: null, dismissed: true } }],
    ['commented', {}], ['other', {}], [undefined, {}],
  ];
  for (const approval of [ctx(), undefined]) {
    for (const [state, key] of cases) {
      const own = [{ id: '480', commit: 'h1', ...(state === undefined ? {} : { state }) }];
      const h = harness({ run: RUN_OK, live: LIVE_OK, readsLive: true, own, ...(approval === undefined ? {} : { approval }) });
      const name = `${state} with approval ${approval === undefined ? 'off' : 'on'}`;
      assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '480', body: RUN_OK.body, inlineDropped: false, notesDropped: false, adopted: true, ...key }, name);
      assert.deepEqual(names(h.calls), ['readPullRequest', 'listOwnReviews', 'listReviewComments'], name);
    }
  }
});

test('a held review is neither decided nor read further', async () => {
  const h = onHarness({ resumed: true, hold: true });
  assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'unlisted' });
  assert.deepEqual(h.calls, [['readPullRequest'], ['listOwnReviews']]);
  // Listed, it is adopted with what GitHub holds, and nothing is decided.
  const listed = onHarness({ resumed: true, hold: true, own: [{ id: '480', commit: 'h1', state: 'approved' }] });
  assert.deepEqual(await publishRun(listed.deps, listed.args), {
    kind: 'published', reviewId: '480', body: RUN_OK.body, inlineDropped: false, notesDropped: false, adopted: true, approval: { approved: true, code: null, dismissed: false },
  });
  assert.deepEqual(names(listed.calls), ['readPullRequest', 'listOwnReviews', 'listReviewComments']);
});

test('when the body cannot be rendered again the recorded body is posted with the paragraph decided now', async () => {
  // Scored under a threshold of 30, its one block at 35 is listed with a link; the threshold in force is 70.
  const blocks: FileScore['blocks'] = [{
    id: 'B1', hunk: 'B1', hunkHash: 'hh1', hash: 'hh1', changedLines: 2, span: { side: 'RIGHT', first: 3, last: 4 },
    lines: { LEFT: [], RIGHT: [[3, 4]] }, entry: { score: 35, category: 'refactor', reason: 'Moves a helper.' },
  }];
  const linked = approvable({ scores: [fileScore('a.ts', 35, { blocks })], verdict: { threshold: 30, needsHuman: false, highest: 35 } });
  const recorded = recordedWith(linked);
  assert.ok(recorded.body.includes('](https://forge.example.test/line)'));
  const h = onHarness({ run: recorded, approval: ctx({ runs: [recorded] }) });
  h.deps.lineUrl = () => { throw new Error('no_link'); };
  const body = fitBody(recorded.body, para('approved'));
  assert.deepEqual(await publishRun(h.deps, h.args), {
    kind: 'published', reviewId: '501', body, inlineDropped: false, notesDropped: false, adopted: false, approval: { approved: true, code: 'approved', dismissed: false },
  });
  assert.deepEqual(h.drafts, [{ commit: 'h1', body, comments: recorded.comments, event: 'approve' }]);
});

test("the prefix never names the current job's requester for a run they did not ask for", async () => {
  const manual = recordedWith(approvable(), { trigger: 'manual', requestedBy: 'octo-lead' });
  assert.ok(manual.body.includes('requested by @octo-lead'));
  const theirs = { run: manual, live: LIVE_OK, ownRun: false, trigger: 'manual', requestedBy: 'octo-dev' } as const;
  // Posted inline with approval on: the recorded body with the paragraph.
  const h = harness({ ...theirs, approval: ctx({ runs: [manual] }) });
  const body = fitBody(manual.body, para('approved'));
  assert.deepEqual(await publishRun(h.deps, h.args), {
    kind: 'published', reviewId: '501', body, inlineDropped: false, notesDropped: false, adopted: false, approval: { approved: true, code: 'approved', dismissed: false },
  });
  assert.equal(h.drafts[0]?.body.includes('@octo-dev'), false);
  // GitHub refuses inline: the body alone is rendered with the run's own trigger and no requester, with approval on and off,
  // whether this job was asked by someone else or is automatic.
  const refused = para('refused', { code: 'review_rejected' });
  for (const job of JOBS) {
    for (const approval of [ctx({ runs: [manual] }), undefined]) {
      const posts = approval === undefined ? { posts: [REJECTED(), { id: '502' }] } : { approval, posts: [REJECTED(), REJECTED(), { id: '503' }] };
      const r = harness({ ...theirs, ...job, ...posts });
      const name = `${job.trigger} job, approval ${approval === undefined ? 'off' : 'on'}`;
      const expected = renderReview(approvable(), { trigger: 'manual', requestedBy: null, lineUrl, inline: false, commentUrl, ...(approval === undefined ? {} : { approval: refused }) }).body;
      assert.ok(expected.startsWith('**Full review** requested.'));
      const out = await publishRun(r.deps, r.args);
      assert.equal(out.kind === 'published' && out.body, expected, name);
      assert.deepEqual(r.drafts.at(-1), { commit: 'h1', body: expected, comments: [] }, name);
      for (const d of r.drafts) assert.equal(d.body.includes('@octo-dev'), false, name);
    }
  }
  // A run this job recorded is its own: its body alone names its requester, as before.
  const mine = recordedWith(approvable(), { trigger: 'manual', requestedBy: 'octo-dev' });
  const own = harness({ run: mine, live: LIVE_OK, trigger: 'manual', requestedBy: 'octo-dev', posts: [REJECTED(), { id: '502' }] });
  const out = await publishRun(own.deps, own.args);
  assert.ok(out.kind === 'published' && out.body.startsWith('**Full review** requested by @octo-dev.'));
});

test('under the strict rule the author alone, replying and resolving, closes nothing, and the review is not approved', async () => {
  const on = { approval: ctx({ runs: [EARLIER, RUN_OK], stored: [STORED_MAJOR] }) };
  const open = { approved: false, code: 'open_thread', dismissed: false };
  const byAuthor = onHarness({ ...on, threads: [repliedThread('octo-dev', 'owner')] });
  const out = await publishRun(byAuthor.deps, byAuthor.args);
  assert.deepEqual(out.kind === 'published' && out.approval, open);
  assert.deepEqual(names(byAuthor.calls), ['readPullRequest', 'listOwnReviews', 'listThreads', 'publishReview']);
  assert.deepEqual(byAuthor.drafts, [{ commit: 'h1', body: withPara(approvable(), para('open_thread')), comments: RUN_OK.comments }]);
  // A member who is not the author closes it.
  const byMember = onHarness({ ...on, threads: [repliedThread('octo-lead', 'member')] });
  const closed = await publishRun(byMember.deps, byMember.args);
  assert.deepEqual(closed.kind === 'published' && closed.approval, { approved: true, code: 'approved', dismissed: false });
  // The author is the live pull request's: when it is that member, the same reply closes nothing.
  const theirOwn = onHarness({ ...on, live: { ...LIVE_OK, info: { ...LIVE_OK.info, author: 'octo-lead' } }, threads: [repliedThread('octo-lead', 'member')] });
  const held = await publishRun(theirOwn.deps, theirOwn.args);
  assert.deepEqual(held.kind === 'published' && held.approval, open);
  assert.equal(theirOwn.drafts[0]?.event, undefined);
});

test("under the gate rule with clearing by reply off a person's reply clears nothing, and the review is not approved", async () => {
  const threads = [repliedThread('octo-lead', 'member')];
  const off = onHarness({ approval: ctx({ rule: 'gate', clearByReply: false, runs: [EARLIER, RUN_OK], stored: [STORED_MAJOR] }), threads });
  const out = await publishRun(off.deps, off.args);
  assert.deepEqual(out.kind === 'published' && out.approval, { approved: false, code: 'open_thread', dismissed: false });
  assert.deepEqual(names(off.calls), ['readPullRequest', 'listOwnReviews', 'listThreads', 'publishReview']);
  assert.deepEqual(off.drafts, [{ commit: 'h1', body: withPara(approvable(), para('open_thread', { rule: 'gate' })), comments: RUN_OK.comments }]);
  // With clearing by reply on, the same reply clears it.
  const on = onHarness({ approval: ctx({ rule: 'gate', clearByReply: true, runs: [EARLIER, RUN_OK], stored: [STORED_MAJOR] }), threads });
  const cleared = await publishRun(on.deps, on.args);
  assert.deepEqual(cleared.kind === 'published' && cleared.approval, { approved: true, code: 'approved', dismissed: false });
});

test('a rule answer that is neither dismissed nor kept is no answer, and the review is not approved', async () => {
  const body = withPara(approvable(), para('rule_unreadable', { code: 'internal_error' }));
  for (const answer of ['yes', true, undefined, null, 'DISMISSED', {}]) {
    const h = onHarness({ rule: answer });
    assert.deepEqual(await publishRun(h.deps, h.args), {
      kind: 'published', reviewId: '501', body, inlineDropped: false, notesDropped: false, adopted: false, approval: { approved: false, code: 'rule_unreadable', dismissed: false },
    }, String(answer));
    assert.deepEqual(h.drafts, [{ commit: 'h1', body, comments: RUN_OK.comments }], String(answer));
  }
});

test('a review a later start publishes is approved without its notes', async () => {
  const noted: StoredRun = { ...RUN_OK, comments: [FINDING, NOTE] };
  const h = onHarness({ run: noted, approval: ctx({ runs: [noted] }), resumed: true });
  const body = withPara(approvable(), para('approved'));
  assert.deepEqual(await publishRun(h.deps, h.args), {
    kind: 'published', reviewId: '501', body, inlineDropped: false, notesDropped: true, adopted: false, approval: { approved: true, code: 'approved', dismissed: false },
  });
  assert.deepEqual(h.drafts, [{ commit: 'h1', body, comments: [FINDING], event: 'approve' }]);
});

test('a repair of the stored comments that throws leaves them as read, and the review is still decided and posted', async () => {
  // A thread with no comment: tying the threads to the published runs' findings throws on it, and it cannot be told closed.
  const empty: ReviewThread = { ...appThread('8009'), comments: [] };
  const h = onHarness({ approval: ctx({ runs: [EARLIER, RUN_OK] }), threads: [empty] });
  const body = withPara(approvable(), para('open_thread'));
  assert.deepEqual(await publishRun(h.deps, h.args), {
    kind: 'published', reviewId: '501', body, inlineDropped: false, notesDropped: false, adopted: false, approval: { approved: false, code: 'open_thread', dismissed: false },
  });
  assert.deepEqual(names(h.calls), ['readPullRequest', 'listOwnReviews', 'listThreads', 'publishReview']);
});

test("an adopted review GitHub holds without its inline comments is written, for a run another job recorded, with that run's trigger and no requester", async () => {
  const manual = recordedWith(approvable(), { trigger: 'manual', requestedBy: 'octo-lead' });
  const expected = renderReview(approvable(), { trigger: 'manual', requestedBy: null, lineUrl, inline: false, commentUrl }).body;
  assert.ok(expected.startsWith('**Full review** requested.'));
  for (const job of JOBS) {
    for (const approval of [ctx({ runs: [manual] }), undefined]) {
      const h = harness({
        run: manual, live: LIVE_OK, ownRun: false, ...job, own: [{ id: '480', commit: 'h1', state: 'commented' }], posted: [],
        ...(approval === undefined ? {} : { approval }),
      });
      const name = `${job.trigger} job, approval ${approval === undefined ? 'off' : 'on'}`;
      assert.deepEqual(await publishRun(h.deps, h.args), { kind: 'published', reviewId: '480', body: expected, inlineDropped: true, notesDropped: false, adopted: true }, name);
      assert.equal(postCount(h.calls), 0, name);
    }
  }
});

test('runs or comments handed in as something that is no list could not be read either', async () => {
  const body = withPara(approvable(), para('record_unreadable'));
  for (const over of [{ stored: {} }, { runs: {} }, { stored: 'x' }]) {
    const h = onHarness({ approval: ctx(over as Partial<ApprovalContext>) });
    assert.deepEqual(await publishRun(h.deps, h.args), {
      kind: 'published', reviewId: '501', body, inlineDropped: false, notesDropped: false, adopted: false, approval: { approved: false, code: 'record_unreadable', dismissed: false },
    }, JSON.stringify(over));
    assert.deepEqual(names(h.calls), ['readPullRequest', 'listOwnReviews', 'publishReview'], JSON.stringify(over));
  }
});

// The audit sample.
const AUDITED = { approved: false, code: 'audit_sample', dismissed: false } as const;
/** Approval on, with a draw that answers `answer` and is put in the calls, as ['drawn'], each time it is asked. */
const drawnHarness = (options: Options = {}, over: Partial<ApprovalContext> = {}, answer = false) => {
  const into: { calls: unknown[][] } = { calls: [] };
  const h = onHarness({ ...options, approval: ctx({ ...over, drawn: () => { into.calls.push(['drawn']); return answer; } }) });
  into.calls = h.calls;
  return h;
};

test('a review drawn for the audit sample is posted as a comment that ends with its paragraph, after the threads and the rule were read', async () => {
  const h = onHarness({ approval: ctx({ drawn: () => true }) });
  const body = withPara(approvable(), para('audit_sample'));
  assert.ok(body.endsWith(`\n\n${para('audit_sample')}`));
  assert.deepEqual(await publishRun(h.deps, h.args), {
    kind: 'published', reviewId: '501', body, inlineDropped: false, notesDropped: false, adopted: false, approval: AUDITED,
  });
  assert.deepEqual(h.calls, [['readPullRequest'], ['listOwnReviews'], ['listThreads'], ['staleApprovals', 'main'], ['publishReview', 'h1', body, 1]]);
  assert.deepEqual(h.drafts, [{ commit: 'h1', body, comments: RUN_OK.comments }]);
  // A branch that keeps stale approvals is named, drawn or not.
  const kept = onHarness({ approval: ctx({ drawn: () => true }), rule: 'kept' });
  const out = await publishRun(kept.deps, kept.args);
  assert.deepEqual(out.kind === 'published' && out.approval, { approved: false, code: 'rule_off', dismissed: false });
  assert.equal(out.kind === 'published' && out.body, withPara(approvable(), para('rule_off')));
  assert.equal('event' in kept.drafts[0]!, false);
});

test('the draw is asked once, last, and only when every other condition held', async () => {
  // Approvable: asked once, after the rule was read and before the post.
  const ok = drawnHarness();
  const out = await publishRun(ok.deps, ok.args);
  assert.deepEqual(out.kind === 'published' && out.approval, { approved: true, code: 'approved', dismissed: false });
  assert.deepEqual(names(ok.calls), ['readPullRequest', 'listOwnReviews', 'listThreads', 'staleApprovals', 'drawn', 'publishReview']);
  // An approval GitHub refuses is posted again as a comment: the draw is not asked again.
  const refused = drawnHarness({ posts: [REJECTED(), { id: '502' }] });
  const again = await publishRun(refused.deps, refused.args);
  assert.deepEqual(again.kind === 'published' && again.approval, { approved: false, code: 'refused', dismissed: false });
  assert.deepEqual(names(refused.calls), ['readPullRequest', 'listOwnReviews', 'listThreads', 'staleApprovals', 'drawn', 'publishReview', 'publishReview']);
  // Never asked when a condition before it refused, nor on a path that decides nothing.
  const NOT_COVERED = recordedWith(okResult());
  const cases: Array<[string, Options, Partial<ApprovalContext>, ApprovalCode | 'unlisted' | 'adopted']> = [
    ['runs null', {}, { runs: null }, 'record_unreadable'],
    ['not covered', { run: NOT_COVERED }, { runs: [NOT_COVERED] }, 'not_covered'],
    ['a draft', { live: { ...LIVE_OK, info: { ...LIVE_OK.info, draft: true } } }, {}, 'draft'],
    ['an open thread', { threads: [appThread('8001')] }, { runs: [EARLIER, RUN_OK], stored: [STORED_MAJOR] }, 'open_thread'],
    ["the rule 'kept'", { rule: 'kept' }, {}, 'rule_off'],
    ['the rule rejecting', { rule: new Error('github_403') }, {}, 'rule_unreadable'],
    ['a held review', { resumed: true, hold: true }, {}, 'unlisted'],
    ['an adopted review', { own: [{ id: '480', commit: 'h1', state: 'commented' }] }, {}, 'adopted'],
    ['an adopted approval', { own: [{ id: '480', commit: 'h1', state: 'approved' }] }, {}, 'adopted'],
  ];
  for (const [name, options, over, expected] of cases) {
    const h = drawnHarness(options, over, true);
    const outcome = await publishRun(h.deps, h.args);
    const told = outcome.kind === 'unlisted' ? 'unlisted' : outcome.kind === 'published' && outcome.adopted ? 'adopted' : outcome.kind === 'published' && outcome.approval?.code;
    assert.equal(told, expected, name);
    assert.equal(names(h.calls).includes('drawn'), false, name);
  }
});

test('a draw that throws or answers anything but false is an audit, never an approval', async () => {
  const body = withPara(approvable(), para('audit_sample'));
  const answers: Array<[string, unknown]> = [
    ['throws', () => { throw new Error('Something private'); }], ['true', () => true], ['undefined', () => undefined], ["'false'", () => 'false'],
    ['0', () => 0], ['null', () => null], ['a promise of false', () => Promise.resolve(false)], ['no function', undefined],
  ];
  for (const [name, drawn] of answers) {
    const h = onHarness({ approval: ctx({ drawn: drawn as ApprovalContext['drawn'] }) });
    assert.deepEqual(await publishRun(h.deps, h.args), {
      kind: 'published', reviewId: '501', body, inlineDropped: false, notesDropped: false, adopted: false, approval: AUDITED,
    }, name);
    assert.deepEqual(h.drafts, [{ commit: 'h1', body, comments: RUN_OK.comments }], name);
  }
  // false, and false alone, is an approval.
  const h = onHarness({ approval: ctx({ drawn: () => false }) });
  const approved = withPara(approvable(), para('approved'));
  assert.deepEqual(await publishRun(h.deps, h.args), {
    kind: 'published', reviewId: '501', body: approved, inlineDropped: false, notesDropped: false, adopted: false, approval: { approved: true, code: 'approved', dismissed: false },
  });
  assert.deepEqual(h.drafts, [{ commit: 'h1', body: approved, comments: RUN_OK.comments, event: 'approve' }]);
});

test('when GitHub refuses the comment of an audited review it is posted as today, ending with the audit paragraph', async () => {
  const asComment = withPara(approvable(), para('audit_sample'));
  const bodyOnly = withPara(approvable(), para('audit_sample'), false);
  assert.ok(bodyOnly.endsWith(`\n\n${para('audit_sample')}`));
  const h = drawnHarness({ posts: [REJECTED(), { id: '502' }] }, {}, true);
  assert.deepEqual(await publishRun(h.deps, h.args), {
    kind: 'published', reviewId: '502', body: bodyOnly, inlineDropped: true, notesDropped: false, adopted: false, approval: AUDITED,
  });
  assert.deepEqual(h.drafts, [{ commit: 'h1', body: asComment, comments: RUN_OK.comments }, { commit: 'h1', body: bodyOnly, comments: [] }]);
  assert.equal(names(h.calls).filter((c) => c === 'drawn').length, 1);
  // With notes: every comment, then without the notes, then the body alone; never an approval.
  const noted: StoredRun = { ...RUN_OK, comments: [FINDING, NOTE] };
  const three = drawnHarness({ run: noted, posts: [REJECTED(), REJECTED(), { id: '503' }] }, { runs: [noted] }, true);
  assert.deepEqual(await publishRun(three.deps, three.args), {
    kind: 'published', reviewId: '503', body: bodyOnly, inlineDropped: true, notesDropped: true, adopted: false, approval: AUDITED,
  });
  assert.deepEqual(three.drafts, [
    { commit: 'h1', body: asComment, comments: [FINDING, NOTE] },
    { commit: 'h1', body: asComment, comments: [FINDING] },
    { commit: 'h1', body: bodyOnly, comments: [] },
  ]);
  assert.equal(names(three.calls).filter((c) => c === 'drawn').length, 1);
});
