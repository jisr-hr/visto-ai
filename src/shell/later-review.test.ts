import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../db/testing.ts';
import { claimJob, enqueueJob, getJob, unfinishedJobs } from '../db/jobs.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { listRuns } from '../db/review-runs.ts';
import { review } from '../engine/review.ts';
import { markerOf } from '../engine/render/thread-reply.ts';
import { SUBMIT_REVIEW } from '../engine/model/submit-review.ts';
import type { ModelRequest, ReviewDeps } from '../engine/types.ts';
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
      settingsFor: () => ({ primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: [], baseBranches: [] }),
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
