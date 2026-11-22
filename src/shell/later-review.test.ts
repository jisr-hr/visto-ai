import test from 'node:test';
import assert from 'node:assert/strict';
import { GATE_OFF } from '../config/load.ts';
import { testDb } from '../db/testing.ts';
import { claimJob, enqueueJob, getJob, unfinishedJobs } from '../db/jobs.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { listRuns } from '../db/review-runs.ts';
import { review } from '../engine/review.ts';
import { markerOf } from '../engine/render/thread-reply.ts';
import { SUBMIT_REVIEW } from '../engine/model/submit-review.ts';
import type { ModelRequest, ReviewDeps, ReviewResult } from '../engine/types.ts';
import type { ForgeWriter, ReviewThread, Source } from '../forge/types.ts';
import { runReviewJob } from './review-job.ts';
import type { ReviewJobDeps } from './review-job.ts';

// The real engine under the real job, on a real database, against a small fake of the git service that keeps reviews and threads.
const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const REASON = 'The caller checks a first, as the reply says.';

test('a later review shows the thread to the model, lists what it already raised, and writes its verdict into the thread', async () => {
  const db = await testDb();
  try {
    let now = Date.parse('2026-03-01T10:00:00.000Z');
    const iso = (): string => new Date(now).toISOString();
    const gh = { head: 'aaaa111', reviews: [] as Array<{ id: string; commit: string; body: string }>, threads: [] as ReviewThread[], nextReview: 501, nextComment: 9001 };
    const appComment = (body: string, reviewId: string | null) => {
      const id = String(gh.nextComment++);
      return { id, node: `PRRC_${id}`, author: 'visto-test[bot]', authorIsBot: true, byApp: true, reviewId, body, at: iso() };
    };
    const writer: ForgeWriter = {
      publishReview: async (_ref, _installation, draft) => {
        const id = String(gh.nextReview++);
        gh.reviews.unshift({ id, commit: draft.commit, body: draft.body });
        for (const c of draft.comments) {
          gh.threads.push({ id: `PRRT_${gh.threads.length + 1}`, path: c.path, side: c.side, line: c.line, resolved: false, resolvedByApp: false, comments: [appComment(c.body, id)] });
        }
        return { id };
      },
      listOwnReviews: async () => gh.reviews.map((r) => ({ id: r.id, commit: r.commit })),
      listReviewComments: async (_ref, _installation, reviewId) => gh.threads
        .filter((t) => t.comments[0]!.reviewId === reviewId)
        .map((t) => ({ id: t.comments[0]!.id, path: t.path, side: t.side, line: t.line!, body: t.comments[0]!.body })),
      react: async () => {},
      comment: async () => {},
      listThreads: async () => structuredClone(gh.threads),
      replyToThread: async (_installation, threadId, body) => { gh.threads.find((t) => t.id === threadId)!.comments.push(appComment(body, null)); },
      editThreadComment: async () => { throw new Error('not_expected'); },
      resolveThread: async (_installation, threadId) => {
        const t = gh.threads.find((x) => x.id === threadId)!;
        t.resolved = true;
        t.resolvedByApp = true;
      },
    };

    const requests: ModelRequest[] = [];
    let answer: unknown = null;
    const engineDeps = (): ReviewDeps => {
      const source: Source = {
        listFiles: async () => [{
          path: 'src/a.ts', previousPath: null, status: 'modified', additions: 3, deletions: 0,
          patch: `@@ -1,1 +1,4 @@\n head\n+const a = 1;\n+const b = total(a); // ${gh.head}\n+export { b };`,
        }],
        getFileContent: async () => null,
        getDefaultBranchFile: async () => null,
      };
      return {
        source, contract: 'You review pull requests.', clock: () => new Date(now), token: () => 'abcdef0123456789', log: () => {},
        model: {
          complete: async (request) => {
            requests.push(request);
            return { toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify(answer), text: null, model: 'm', provider: null, usage: { calls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0.1 } };
          },
        },
      };
    };
    const deps: ReviewJobDeps = {
      db,
      forge: {
        readPullRequest: async () => ({
          info: { ref: REF, title: 'Add a total', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'base000', headSha: gh.head, draft: false },
          state: 'open',
        }),
        sourceFor: async () => ({}) as Source,
      },
      clock: () => new Date(now), log: () => {}, sleep: async () => {},
      settingsFor: () => ({ primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: [], baseBranches: [], newHead: null, inlineNotes: false, gate: GATE_OFF }),
      limits: { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 240 },
      dryRun: false, writer, engineDeps, review,
      lineUrl: () => 'https://git.example.test/x',
      commentUrl: (_ref, commentId) => `https://git.example.test/c/${commentId}`,
      canResolve: async () => true,
      health: { reviewed: () => {} },
      spend: { noteRun: () => {} },
    };
    await savePullRequest(db, {
      ref: REF, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: gh.head, draft: false, state: 'open',
      mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: iso(),
    });
    const runJob = async (): Promise<string | null | undefined> => {
      now += 600_000;
      await enqueueJob(db, {
        ref: REF, reason: 'synchronize', headSha: gh.head, runAt: iso(), now: iso(), delivery: null, replace: true,
        trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null,
      });
      const pending = (await unfinishedJobs(db)).find((j) => j.status === 'pending')!;
      const job = (await claimJob(db, pending.id, iso()))!;
      await runReviewJob(job, deps);
      return (await getJob(db, job.id))?.outcome;
    };
    const finding = { path: 'src/a.ts', side: 'RIGHT', line: 3, severity: 'major', body: 'total() is called before a is checked.', beyond_diff: false };

    // The first review, published with one finding, stored in the database; then a person replies in its thread.
    answer = { overview: 'src/a.ts adds a total.', findings: [{ ...finding, quote: `const b = total(a); // ${gh.head}` }], files: [] };
    assert.equal(await runJob(), 'published');
    assert.equal(gh.threads.length, 1);
    const first = gh.threads[0]!;
    first.comments.push({ id: '9500', node: 'PRRC_9500', author: 'octo-dev', authorIsBot: false, byApp: false, reviewId: null, body: 'The caller checks a first.', at: iso() });

    // A push. The model answers the thread and raises a major finding within 3 lines of it.
    gh.head = 'bbbb222';
    requests.length = 0;
    answer = {
      overview: 'src/a.ts adds a total.', files: [],
      findings: [{ ...finding, line: 4, quote: 'export { b };', body: 'b is exported unchecked.' }],
      thread_verdicts: [{ thread_id: 'T1', verdict: 'answered', reply: REASON }],
    };
    assert.equal(await runJob(), 'published');

    const lastUser = requests.at(-1)!.messages.at(-1)!.content;
    assert.ok(lastUser.includes('### Thread T1'));
    const secondId = gh.reviews[0]!.id;
    assert.equal(gh.reviews.length, 2);
    assert.equal(gh.threads.length, 1); // the finding already raised is not posted again
    const { body } = gh.reviews[0]!;
    assert.equal((await listRuns(db, REF)).find((r) => r.reviewId === secondId)?.body, body);
    assert.ok(body.includes('## Already discussed'));
    assert.ok(body.includes(`(https://git.example.test/c/${first.comments[0]!.id})`));
    assert.equal(first.comments.at(-1)!.body, `**Answered.** ${REASON}\n\n${markerOf(secondId, 'bbbb222')}`);
    assert.equal(first.resolved, true);
  } finally {
    await db.close();
  }
});

/**
 * The real engine under the real job, for a pull request of two files. `patches` gives each file's patch at a head; the model answers
 * whatever `answer` holds and every request is kept. Each `runJob` claims a job for the current head and runs it.
 */
async function twoFiles(patches: (head: string) => Record<string, string>) {
  const db = await testDb();
  let now = Date.parse('2026-03-01T10:00:00.000Z');
  const iso = (): string => new Date(now).toISOString();
  const gh = { head: 'aaaa111', reviews: [] as Array<{ id: string; commit: string }>, nextReview: 501 };
  const writer: ForgeWriter = {
    publishReview: async (_ref, _installation, draft) => {
      const id = String(gh.nextReview++);
      gh.reviews.unshift({ id, commit: draft.commit });
      return { id };
    },
    listOwnReviews: async () => gh.reviews.map((r) => ({ id: r.id, commit: r.commit })),
    listReviewComments: async () => [],
    react: async () => {},
    comment: async () => {},
    listThreads: async () => [],
    replyToThread: async () => { throw new Error('not_expected'); },
    editThreadComment: async () => { throw new Error('not_expected'); },
    resolveThread: async () => { throw new Error('not_expected'); },
  };
  const requests: ModelRequest[] = [];
  const state = { answer: null as unknown };
  const engineDeps = (): ReviewDeps => {
    const source: Source = {
      listFiles: async () => Object.entries(patches(gh.head)).map(([path, patch]) => ({ path, previousPath: null, status: 'modified' as const, additions: 1, deletions: 0, patch })),
      getFileContent: async () => null,
      getDefaultBranchFile: async () => null,
    };
    return {
      source, contract: 'You review pull requests.', clock: () => new Date(now), token: () => 'abcdef0123456789', log: () => {},
      model: {
        complete: async (request) => {
          requests.push(request);
          return { toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify(state.answer), text: null, model: 'm', provider: null, usage: { calls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0.1 } };
        },
      },
    };
  };
  const deps: ReviewJobDeps = {
    db,
    forge: {
      readPullRequest: async () => ({
        info: { ref: REF, title: 'Add a total', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'base000', headSha: gh.head, draft: false },
        state: 'open',
      }),
      sourceFor: async () => ({}) as Source,
    },
    clock: () => new Date(now), log: () => {}, sleep: async () => {},
    settingsFor: () => ({ primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: [], baseBranches: [], newHead: null, inlineNotes: false, gate: GATE_OFF }),
    limits: { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 240 },
    dryRun: false, writer, engineDeps, review,
    lineUrl: () => 'https://git.example.test/x',
    commentUrl: (_ref, commentId) => `https://git.example.test/c/${commentId}`,
    canResolve: async () => true,
    health: { reviewed: () => {} },
    spend: { noteRun: () => {} },
  };
  await savePullRequest(db, {
    ref: REF, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: gh.head, draft: false, state: 'open',
    mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: iso(),
  });
  const runJob = async (): Promise<string | null | undefined> => {
    now += 600_000;
    await enqueueJob(db, {
      ref: REF, reason: 'synchronize', headSha: gh.head, runAt: iso(), now: iso(), delivery: null, replace: true,
      trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null,
    });
    const pending = (await unfinishedJobs(db)).find((j) => j.status === 'pending')!;
    const job = (await claimJob(db, pending.id, iso()))!;
    await runReviewJob(job, deps);
    return (await getJob(db, job.id))?.outcome;
  };
  return { db, gh, requests, state, runJob };
}

const scoreOf = (result: unknown, path: string): number | undefined =>
  (result as ReviewResult).scores.find((f) => f.path === path)?.blocks[0]?.entry?.score;
const PATCH_B = '@@ -1,1 +1,2 @@\n head\n+export const rate = 0.2;';

test('two reviews of one pull request: the second is incremental, asks for no score the first gave, and gives the unchanged file the same score', async () => {
  const t = await twoFiles((head) => ({ 'src/a.ts': `@@ -1,1 +1,2 @@\n head\n+const a = total(1); // ${head}`, 'src/b.ts': PATCH_B }));
  try {
    t.state.answer = {
      overview: 'src/a.ts adds a total and src/b.ts a rate.', findings: [],
      files: [
        { path: 'src/a.ts', change_summary: 'Adds a total.', blocks: [{ id: 'B1', score: 30, category: 'calculation', reason: 'A total.' }] },
        { path: 'src/b.ts', change_summary: 'Adds a rate.', blocks: [{ id: 'B1', score: 45, category: 'business_rule', reason: 'A rate.' }] },
      ],
    };
    assert.equal(await t.runJob(), 'published');
    assert.equal(t.requests.length, 1);
    assert.ok(t.requests[0]!.messages.at(-1)!.content.includes('src/b.ts'));

    t.gh.head = 'bbbb222';
    t.requests.length = 0;
    t.state.answer = {
      overview: 'src/a.ts changes again.', findings: [],
      files: [{ path: 'src/a.ts', change_summary: 'Changes the total.', blocks: [{ id: 'B1', score: 35, category: 'calculation', reason: 'Another total.' }] }],
    };
    assert.equal(await t.runJob(), 'published');
    assert.equal(t.requests.length, 1);
    const asked = t.requests[0]!.messages.at(-1)!.content;
    assert.ok(asked.includes('src/a.ts'));
    assert.equal(asked.includes('src/b.ts'), false);

    const [first, second] = await listRuns(t.db, REF);
    assert.deepEqual([first!.mode, second!.mode, second!.published], ['full', 'incremental', true]);
    assert.deepEqual([scoreOf(first!.result, 'src/b.ts'), scoreOf(second!.result, 'src/b.ts')], [45, 45]);
    const rows = await t.db.query<{ run: number; path: string; score: number }>('select run, path, score from visto_ai.block_scores order by id');
    assert.deepEqual(rows.filter((r) => r.run === first!.id).map((r) => [r.path, r.score]), [['src/a.ts', 30], ['src/b.ts', 45]]);
    assert.deepEqual(rows.filter((r) => r.path === 'src/b.ts').map((r) => r.run), [first!.id]);
  } finally {
    await t.db.close();
  }
});

test('a push that changes nothing in the diff ends as nothing new, with no model call', async () => {
  const t = await twoFiles(() => ({ 'src/a.ts': '@@ -1,1 +1,2 @@\n head\n+const a = total(1);', 'src/b.ts': PATCH_B }));
  try {
    t.state.answer = {
      overview: 'src/a.ts adds a total and src/b.ts a rate.', findings: [],
      files: [
        { path: 'src/a.ts', change_summary: 'Adds a total.', blocks: [{ id: 'B1', score: 30, category: 'calculation', reason: 'A total.' }] },
        { path: 'src/b.ts', change_summary: 'Adds a rate.', blocks: [{ id: 'B1', score: 45, category: 'business_rule', reason: 'A rate.' }] },
      ],
    };
    assert.equal(await t.runJob(), 'published');
    t.gh.head = 'bbbb222';
    assert.equal(await t.runJob(), 'nothing_new');
    assert.deepEqual([t.requests.length, t.gh.reviews.length], [1, 1]);
    const last = (await listRuns(t.db, REF)).at(-1)!;
    assert.deepEqual([last.mode, last.body, last.published, (last.result as ReviewResult).nothingToDo], ['incremental', '', false, true]);
  } finally {
    await t.db.close();
  }
});

/**
 * The real engine under the real job, with inline notes on, against a fake of the git service that keeps every review and the threads of
 * what it was posted with, so that the next start reads them. `patches` gives each file's patch at a head; the model answers whatever
 * `answer` holds and every request is kept. `runJob` runs an automatic job for the current head, or with `manual` a /review.
 */
async function keptThreads(patches: (head: string) => Record<string, string>) {
  const db = await testDb();
  let now = Date.parse('2026-03-01T10:00:00.000Z');
  const iso = (): string => new Date(now).toISOString();
  const gh = { head: 'aaaa111', reviews: [] as Array<{ id: string; commit: string; body: string }>, threads: [] as ReviewThread[], nextReview: 501, nextComment: 9001 };
  const appComment = (body: string, reviewId: string | null) => {
    const id = String(gh.nextComment++);
    return { id, node: `PRRC_${id}`, author: 'visto-test[bot]', authorIsBot: true, byApp: true, reviewId, body, at: iso() };
  };
  const writer: ForgeWriter = {
    publishReview: async (_ref, _installation, draft) => {
      const id = String(gh.nextReview++);
      gh.reviews.unshift({ id, commit: draft.commit, body: draft.body });
      for (const c of draft.comments) {
        gh.threads.push({ id: `PRRT_${gh.threads.length + 1}`, path: c.path, side: c.side, line: c.line, resolved: false, resolvedByApp: false, comments: [appComment(c.body, id)] });
      }
      return { id };
    },
    listOwnReviews: async () => gh.reviews.map((r) => ({ id: r.id, commit: r.commit })),
    listReviewComments: async (_ref, _installation, reviewId) => gh.threads
      .filter((t) => t.comments[0]!.reviewId === reviewId)
      .map((t) => ({ id: t.comments[0]!.id, path: t.path, side: t.side, line: t.line!, body: t.comments[0]!.body })),
    react: async () => {},
    comment: async () => {},
    listThreads: async () => structuredClone(gh.threads),
    replyToThread: async (_installation, threadId, body) => { gh.threads.find((t) => t.id === threadId)!.comments.push(appComment(body, null)); },
    editThreadComment: async () => { throw new Error('not_expected'); },
    resolveThread: async (_installation, threadId) => {
      const t = gh.threads.find((x) => x.id === threadId)!;
      t.resolved = true;
      t.resolvedByApp = true;
    },
  };
  const requests: ModelRequest[] = [];
  const state = { answer: null as unknown };
  const engineDeps = (): ReviewDeps => {
    const source: Source = {
      listFiles: async () => Object.entries(patches(gh.head)).map(([path, patch]) => ({ path, previousPath: null, status: 'modified' as const, additions: 1, deletions: 0, patch })),
      getFileContent: async () => null,
      getDefaultBranchFile: async () => null,
    };
    return {
      source, contract: 'You review pull requests.', clock: () => new Date(now), token: () => 'abcdef0123456789', log: () => {},
      model: {
        complete: async (request) => {
          requests.push(request);
          return { toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify(state.answer), text: null, model: 'm', provider: null, usage: { calls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0.1 } };
        },
      },
    };
  };
  const deps: ReviewJobDeps = {
    db,
    forge: {
      readPullRequest: async () => ({
        info: { ref: REF, title: 'Add a total', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'base000', headSha: gh.head, draft: false },
        state: 'open',
      }),
      sourceFor: async () => ({}) as Source,
    },
    clock: () => new Date(now), log: () => {}, sleep: async () => {},
    settingsFor: () => ({ primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: [], baseBranches: [], newHead: null, inlineNotes: true, gate: GATE_OFF }),
    limits: { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 240 },
    dryRun: false, writer, engineDeps, review,
    lineUrl: () => 'https://git.example.test/x',
    commentUrl: (_ref, commentId) => `https://git.example.test/c/${commentId}`,
    canResolve: async () => true,
    health: { reviewed: () => {} },
    spend: { noteRun: () => {} },
  };
  await savePullRequest(db, {
    ref: REF, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: gh.head, draft: false, state: 'open',
    mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: iso(),
  });
  const runJob = async (manual = false): Promise<string | null | undefined> => {
    now += 600_000;
    await enqueueJob(db, manual
      ? { ref: REF, reason: 'command', headSha: '', runAt: iso(), now: iso(), delivery: null, replace: true, trigger: 'manual', requestedBy: 'octo-lead', commentId: '31', association: 'member', installation: '99' }
      : { ref: REF, reason: 'synchronize', headSha: gh.head, runAt: iso(), now: iso(), delivery: null, replace: true, trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null });
    const pending = (await unfinishedJobs(db)).find((j) => j.status === 'pending')!;
    const job = (await claimJob(db, pending.id, iso()))!;
    await runReviewJob(job, deps);
    return (await getJob(db, job.id))?.outcome;
  };
  return { db, gh, requests, state, runJob };
}

/** Whether a thread was opened by a note: its first comment is one. */
const isNoteThread = (t: ReviewThread): boolean => t.comments[0]!.body.startsWith('**Human review:**');

test('a note thread is not shown to the model and gets no reply at the next review', async () => {
  const t = await keptThreads((head) => ({ 'src/a.ts': `@@ -1,1 +1,4 @@\n head\n+const a = 1;\n+const b = total(a); // ${head}\n+export { b };` }));
  try {
    const finding = { path: 'src/a.ts', side: 'RIGHT', line: 3, severity: 'major', body: 'total() is called before a is checked.', beyond_diff: false };
    const files = [{ path: 'src/a.ts', change_summary: 'Adds a total.', blocks: [{ id: 'B1', score: 85, category: 'calculation', reason: 'A total.' }] }];
    t.state.answer = { overview: 'src/a.ts adds a total.', findings: [{ ...finding, quote: `const b = total(a); // ${t.gh.head}` }], files };
    assert.equal(await t.runJob(), 'published');
    assert.deepEqual(t.gh.threads.map(isNoteThread), [false, true]);
    const [findingThread, noteThread] = t.gh.threads;
    findingThread!.comments.push({ id: '9500', node: 'PRRC_9500', author: 'octo-dev', authorIsBot: false, byApp: false, reviewId: null, body: 'The caller checks a first.', at: new Date().toISOString() });

    t.gh.head = 'bbbb222';
    t.requests.length = 0;
    t.state.answer = { overview: 'src/a.ts adds a total.', findings: [], files, thread_verdicts: [{ thread_id: 'T1', verdict: 'answered', reply: REASON }] };
    assert.equal(await t.runJob(), 'published');
    const asked = t.requests.at(-1)!.messages.at(-1)!.content;
    assert.equal(asked.split('### Thread ').length - 1, 1);
    assert.equal(asked.includes(noteThread!.comments[0]!.body), false);
    assert.equal(findingThread!.comments.at(-1)!.body, `**Answered.** ${REASON}\n\n${markerOf(t.gh.reviews[0]!.id, 'bbbb222')}`);
    assert.deepEqual([noteThread!.comments.length, noteThread!.resolved], [1, false]);
    assert.ok(t.gh.reviews[0]!.body.includes('Earlier threads: 1 cleared, 0 still open.'));
  } finally {
    await t.db.close();
  }
});

test('more flagged blocks than the cap get their notes over two reviews', async () => {
  /** Twenty hunks of one added line each, every one its own text. */
  const twenty = (name: string): string => Array.from({ length: 20 }, (_, i) =>
    `@@ -${10 * i + 1},1 +${10 * i + 1 + i},2 @@\n ctx${i}\n+const ${name}${i} = ${i};`).join('\n');
  const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
  const t = await keptThreads(() => Object.fromEntries(paths.map((p, i) => [p, twenty(`v${i}_`)])));
  try {
    t.state.answer = {
      overview: 'src/a.ts, src/b.ts and src/c.ts add constants.', findings: [],
      files: paths.map((path) => ({ path, change_summary: 'Adds constants.', blocks: Array.from({ length: 20 }, (_, i) => ({ id: `B${i + 1}`, score: 85, category: 'calculation', reason: 'A constant.' })) })),
    };
    assert.equal(await t.runJob(), 'published');
    assert.equal(t.gh.threads.filter(isNoteThread).length, 50);
    const calls = t.requests.length;

    // A /review on that head: a re-check, published with the other ten notes and no model call.
    assert.equal(await t.runJob(true), 'published');
    assert.deepEqual([t.gh.reviews.length, t.gh.threads.filter(isNoteThread).length, t.requests.length], [2, 60, calls]);
    const keys = new Set(t.gh.threads.map((th) => `${th.path}:${th.line}`));
    assert.equal(keys.size, 60);

    // A second /review: every block has its note.
    assert.equal(await t.runJob(true), 'published');
    assert.deepEqual([t.gh.reviews.length, t.gh.threads.length], [3, 60]);
    assert.deepEqual((await listRuns(t.db, REF)).map((r) => r.mode), ['full', 'recheck', 'recheck']);
  } finally {
    await t.db.close();
  }
});
