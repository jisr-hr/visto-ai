import test from 'node:test';
import assert from 'node:assert/strict';
import type { PullRequestFacts } from '../forge/types.ts';
import { testDb } from './testing.ts';
import { getPullRequest, openPullRequests, savePullRequest } from './pull-requests.ts';

const ref = { service: 'github' as const, owner: 'acme', repo: 'shop', number: 7 };
function facts(over: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    ref, author: 'octo-dev', authorIsBot: false,
    baseBranch: 'main', headBranch: 'feature', headSha: 'aaa111',
    draft: false, state: 'open', mergedAt: null, closedAt: null, mergeCommit: null,
    installation: '55', updatedAt: '2026-03-01T10:00:00.000Z', ...over,
  };
}
const firstSeen = async (db: Awaited<ReturnType<typeof testDb>>) =>
  (await db.query<{ t: string }>('select first_seen_at::text as t from visto_ai.pull_requests'))[0]?.t;

test('saved facts are read back equal', async () => {
  const db = await testDb();
  assert.equal(await savePullRequest(db, facts()), true);
  assert.deepEqual(await getPullRequest(db, ref), facts());
  await db.close();
});
test('a later updatedAt replaces the facts and keeps first_seen_at', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const before = await firstSeen(db);
  const later = facts({ headSha: 'bbb222', updatedAt: '2026-03-02T10:00:00.000Z' });
  assert.equal(await savePullRequest(db, later), true);
  assert.deepEqual(await getPullRequest(db, ref), later);
  assert.equal(await firstSeen(db), before);
  await db.close();
});
test('PM-push-order: an earlier updatedAt changes nothing', async () => {
  const db = await testDb();
  await savePullRequest(db, facts({ updatedAt: '2026-03-02T10:00:00.000Z' }));
  const stored = await getPullRequest(db, ref);
  assert.equal(await savePullRequest(db, facts({ headSha: 'old000', draft: true, updatedAt: '2026-03-01T10:00:00.000Z' })), false);
  assert.deepEqual(await getPullRequest(db, ref), stored);
  await db.close();
});
test('the same updatedAt with a changed headSha: the later arrival wins', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  assert.equal(await savePullRequest(db, facts({ headSha: 'bbb222' })), true);
  assert.equal((await getPullRequest(db, ref))?.headSha, 'bbb222');
  await db.close();
});
test('a null installation keeps the stored one', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  await savePullRequest(db, facts({ installation: null, updatedAt: '2026-03-02T10:00:00.000Z' }));
  assert.equal((await getPullRequest(db, ref))?.installation, '55');
  await db.close();
});
test('owner and repository are compared without regard to letter case', async () => {
  const db = await testDb();
  await savePullRequest(db, facts());
  const mixed = { ...ref, owner: 'Acme', repo: 'Shop' };
  assert.equal(await savePullRequest(db, facts({ ref: mixed, headSha: 'ccc333', updatedAt: '2026-03-02T10:00:00.000Z' })), true);
  const got = await getPullRequest(db, mixed);
  assert.equal(got?.ref.owner, 'acme');
  assert.equal(got?.ref.repo, 'shop');
  assert.equal(got?.headSha, 'ccc333');
  assert.deepEqual(await db.query('select count(*)::int as n from visto_ai.pull_requests'), [{ n: 1 }]);
  await db.close();
});
test('an unknown pull request is null', async () => {
  const db = await testDb();
  assert.equal(await getPullRequest(db, ref), null);
  await db.close();
});
test('a merged pull request keeps its merge facts', async () => {
  const db = await testDb();
  const merged = facts({ state: 'merged', mergedAt: '2026-03-03T09:00:00.000Z', closedAt: '2026-03-03T09:00:00.000Z', mergeCommit: 'fff999', updatedAt: '2026-03-03T09:00:00.000Z' });
  await savePullRequest(db, merged);
  assert.deepEqual(await getPullRequest(db, ref), merged);
  await db.close();
});
test('the open pull requests are listed with their base branch', async () => {
  const db = await testDb();
  await savePullRequest(db, facts({ ref: { ...ref, owner: 'Acme' }, baseBranch: 'release' }));
  await savePullRequest(db, facts({ ref: { ...ref, number: 8 }, state: 'closed', closedAt: '2026-03-01T11:00:00.000Z' }));
  await savePullRequest(db, facts({ ref: { ...ref, number: 9 }, state: 'merged', mergedAt: '2026-03-01T11:00:00.000Z' }));
  assert.deepEqual(await openPullRequests(db), [{ ref, baseBranch: 'release' }]);
  await db.close();
});
