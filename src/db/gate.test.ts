import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import { evaluatedUnstored, lastEvaluation, NO_COUNTS, recordEvaluation, recordSkip, skipOf } from './gate.ts';
import { askGate } from './jobs.ts';
import { savePullRequest } from './pull-requests.ts';
import type { Evaluation, Skip } from './gate.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const evaluation = (over: Partial<Evaluation> = {}): Evaluation => ({
  ref: { ...REF, owner: 'Acme' }, headSha: 'h1', at: at(0), mode: 'enforce', state: 'waiting', code: null, run: null, counts: NO_COUNTS, ...over,
});
const skip = (over: Partial<Skip> = {}): Skip => ({
  ref: { ...REF, owner: 'Acme' }, headSha: 'h1', actor: 'octo-lead', reason: 'hotfix', commentId: '41', at: at(0), ...over,
});

test('an evaluation is stored with its counts, and the newest is read back for its pull request', async () => {
  const db = await testDb();
  const counts = { blocking: 1, clearedByReview: 2, clearedByReply: 3, silentResolves: 4, unknownThreads: 5, findings: 6, notReviewed: 7, withoutThread: 8, refusedInline: 9 };
  await recordEvaluation(db, evaluation());
  await recordEvaluation(db, evaluation({ headSha: 'h2', at: at(5), mode: 'shadow', state: 'failed', code: 'github_502', run: 4, counts }));
  await recordEvaluation(db, evaluation({ ref: { ...REF, number: 8, repo: 'Shop' }, state: 'passed' }));
  assert.deepEqual(await lastEvaluation(db, REF), { headSha: 'h2', mode: 'shadow', state: 'failed', code: 'github_502' });
  assert.deepEqual(await lastEvaluation(db, { ...REF, number: 8 }), { headSha: 'h1', mode: 'enforce', state: 'passed', code: null });
  assert.equal(await lastEvaluation(db, { ...REF, number: 9 }), null);
  const [row] = await db.query(
    `select owner, run, blocking, cleared_by_review, cleared_by_reply, silent_resolves, unknown_threads, findings, not_reviewed, without_thread, refused_inline
     from visto_ai.gate_evaluations where head_sha = 'h2'`);
  assert.deepEqual(row, { owner: 'acme', run: 4, blocking: 1, cleared_by_review: 2, cleared_by_reply: 3, silent_resolves: 4, unknown_threads: 5, findings: 6, not_reviewed: 7, without_thread: 8, refused_inline: 9 });
  await db.close();
});
test('a skip is stored once for a comment, and the newest skip of a head is the one read', async () => {
  const db = await testDb();
  assert.equal(await recordSkip(db, skip()), true);
  assert.equal(await recordSkip(db, skip({ reason: 'again' })), false);
  assert.equal(await recordSkip(db, skip({ commentId: '42', actor: 'octo-dev', reason: `late${String.fromCharCode(0)} fix`, at: at(9) })), true);
  assert.deepEqual(await skipOf(db, REF, 'h1'), { actor: 'octo-dev', reason: 'late fix' });
  assert.equal(await skipOf(db, REF, 'h2'), null);
  assert.equal(await skipOf(db, { ...REF, number: 8 }, 'h1'), null);
  await db.close();
});

test('the pull requests with no stored row come with their newest evaluation\'s state and their newest job\'s installation', async () => {
  const db = await testDb();
  const ref = (number: number) => ({ ...REF, number });
  const doneJob = async (number: number, installation: string | null, seconds: number): Promise<void> => {
    const id = (await askGate(db, ref(number), at(seconds), undefined, { installation }))!;
    await db.query("update visto_ai.jobs set status = 'done' where id = $1", [id]);
  };
  // 7: three rows, the newest says blocked; jobs 11, 12 and then one with none: 12 is the newest with one.
  await recordEvaluation(db, evaluation({ ref: ref(7), state: 'passed' }));
  await recordEvaluation(db, evaluation({ ref: ref(7), state: 'waiting', at: at(5) }));
  await recordEvaluation(db, evaluation({ ref: ref(7), state: 'blocked', at: at(9) }));
  await doneJob(7, '11', 0);
  await doneJob(7, '12', 1);
  await doneJob(7, null, 2);
  // 5: two rows, the newest says bypassed, and no job with an installation.
  await recordEvaluation(db, evaluation({ ref: ref(5), state: 'failed', code: 'github_502' }));
  await recordEvaluation(db, evaluation({ ref: ref(5), state: 'bypassed' }));
  await doneJob(5, null, 0);
  // 6: rows and a job, but a stored row: not listed.
  await recordEvaluation(db, evaluation({ ref: ref(6), state: 'passed' }));
  await doneJob(6, '13', 0);
  await savePullRequest(db, {
    ref: ref(6), author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: 'h1', draft: false, state: 'open',
    mergedAt: null, closedAt: null, mergeCommit: null, installation: '13', updatedAt: at(0),
  });
  // A job of another pull request with an installation does not count for 5.
  await doneJob(8, '14', 0);
  assert.deepEqual(await evaluatedUnstored(db), [
    { ref: ref(5), state: 'bypassed', installation: null },
    { ref: ref(7), state: 'blocked', installation: '12' },
  ]);
  await db.close();
});
