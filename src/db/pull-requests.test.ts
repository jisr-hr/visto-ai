import test from 'node:test';
import assert from 'node:assert/strict';
import type { PullRequestFacts } from '../forge/types.ts';
import { testDb } from './testing.ts';
import { getPullRequest, openPullRequests, revertOf, savePullRequest } from './pull-requests.ts';

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
test('the open pull requests are listed with their base branch and installation', async () => {
  const db = await testDb();
  await savePullRequest(db, facts({ ref: { ...ref, owner: 'Acme' }, baseBranch: 'release' }));
  await savePullRequest(db, facts({ ref: { ...ref, number: 8 }, state: 'closed', closedAt: '2026-03-01T11:00:00.000Z' }));
  await savePullRequest(db, facts({ ref: { ...ref, number: 9 }, state: 'merged', mergedAt: '2026-03-01T11:00:00.000Z' }));
  assert.deepEqual(await openPullRequests(db), [{ ref, baseBranch: 'release', installation: '55' }]);
  await db.close();
});

const revertsColumn = async (db: Awaited<ReturnType<typeof testDb>>, number = 7): Promise<number | null | undefined> =>
  (await db.query<{ reverts: number | null }>('select reverts from visto_ai.pull_requests where number = $1', [number]))[0]?.reverts;
const t = (n: number): string => `2026-03-0${n}T10:00:00.000Z`;
const mergedFacts = (over: Partial<PullRequestFacts> = {}): PullRequestFacts =>
  facts({ state: 'merged', mergedAt: t(3), closedAt: t(3), mergeCommit: 'fff999', updatedAt: t(3), ...over });

test('a pull request that names no revert is stored and read back as it was', async () => {
  const db = await testDb();
  assert.equal(await savePullRequest(db, facts()), true);
  assert.equal('reverts' in facts(), false);
  assert.deepEqual(await getPullRequest(db, ref), facts());
  assert.equal(await revertsColumn(db), null);
  assert.equal(await revertOf(db, ref), null);
  await db.close();
});
test('what a pull request says it reverts is stored, and follows its description up to the delivery of its merge', async () => {
  const db = await testDb();
  assert.equal(await savePullRequest(db, facts({ reverts: 7, updatedAt: t(1) })), true);
  assert.equal(await revertsColumn(db), 7);
  assert.equal(await savePullRequest(db, facts({ updatedAt: t(2) })), true);
  assert.equal(await revertsColumn(db), null);
  assert.equal(await savePullRequest(db, facts({ reverts: 6, updatedAt: t(3) })), true);
  assert.equal(await revertsColumn(db), 6);
  assert.equal(await savePullRequest(db, facts({ reverts: 5, updatedAt: t(1) })), false);
  assert.equal(await revertsColumn(db), 6);
  assert.equal(await savePullRequest(db, mergedFacts({ reverts: 6, updatedAt: t(4) })), true);
  assert.equal(await revertsColumn(db), 6);
  assert.equal(await savePullRequest(db, mergedFacts({ updatedAt: t(4) })), true);
  assert.equal(await revertsColumn(db), null);
  await db.close();
  const first = await testDb();
  assert.equal(await savePullRequest(first, mergedFacts({ reverts: 7 })), true);
  assert.equal(await revertsColumn(first), 7);
  await first.close();
});
test('an event that may not say what a merged pull request reverts keeps what is stored, in every order of deliveries', async () => {
  // O(n): an event of the pull request not merged, naming n; M(n): the merge's delivery; K: another event of the merged pull request.
  type Ev = { at: number; saved: boolean; column: number | null } & ({ kind: 'O' | 'M'; n: number | null; state?: 'open' | 'closed' } | { kind: 'K' });
  const event = (e: Ev): PullRequestFacts => {
    if (e.kind === 'K') return mergedFacts({ reverts: 'kept', headSha: `k${e.at}`, updatedAt: t(e.at) });
    const reverts = e.n === null ? {} : { reverts: e.n };
    if (e.kind === 'M') return mergedFacts({ ...reverts, updatedAt: t(e.at) });
    return facts({ ...reverts, state: e.state ?? 'open', closedAt: e.state === 'closed' ? t(e.at) : null, updatedAt: t(e.at) });
  };
  const O = (n: number | null, at: number, saved: boolean, column: number | null, state?: 'open' | 'closed'): Ev => ({ kind: 'O', n, at, saved, column, ...(state === undefined ? {} : { state }) });
  const M = (n: number | null, at: number, saved: boolean, column: number | null): Ev => ({ kind: 'M', n, at, saved, column });
  const K = (at: number, saved: boolean, column: number | null): Ev => ({ kind: 'K', at, saved, column });
  const rows: Array<[string, Ev[]]> = [
    ['O(7) t1, O(6) t2, M(6) t3, K t4', [O(7, 1, true, 7), O(6, 2, true, 6), M(6, 3, true, 6), K(4, true, 6)]],
    ['M(7) t3 first', [M(7, 3, true, 7)]],
    ['M(7) t3, then O(5) t1', [M(7, 3, true, 7), O(5, 1, false, 7)]],
    ['O(-) t1, M(7) t3, M(7) t3 again', [O(null, 1, true, null), M(7, 3, true, 7), M(7, 3, true, 7)]],
    ['O(-) t1, M(-) t3, K t3 naming 7', [O(null, 1, true, null), M(null, 3, true, null), K(3, true, null)]],
    ['O(-) t1, K t5 naming 7, M(-) t3', [O(null, 1, true, null), K(5, true, null), M(null, 3, false, null)]],
    ['O(7) t1, K t5, M(-) t3', [O(7, 1, true, 7), K(5, true, 7), M(null, 3, false, 7)]],
    ['closed O(7) t1, reopened O(7) t2, M(-) t3', [O(7, 1, true, 7, 'closed'), O(7, 2, true, 7), M(null, 3, true, null)]],
    ['O(7) t1, M(-) t1', [O(7, 1, true, 7), M(null, 1, true, null)]],
    ['K t5 first', [K(5, true, null)]],
  ];
  for (const [name, events] of rows) {
    const db = await testDb();
    for (const [i, e] of events.entries()) {
      assert.equal(await savePullRequest(db, event(e)), e.saved, `${name}, event ${i + 1}: saved`);
      assert.equal(await revertsColumn(db), e.column, `${name}, event ${i + 1}: column`);
      if (e.kind === 'K' && e.saved) {
        const stored = await getPullRequest(db, ref);
        assert.equal(stored?.updatedAt, t(e.at), `${name}, event ${i + 1}: updated_at`);
        assert.equal(stored?.state, 'merged', `${name}, event ${i + 1}: state`);
      }
    }
    await db.close();
  }
});

const nine = { ...ref, number: 9 };
const revertAt = '2026-03-10T12:00:00.000Z';
const revertingNine = (over: Partial<PullRequestFacts> = {}): PullRequestFacts =>
  facts({ ref: nine, state: 'merged', mergedAt: revertAt, closedAt: revertAt, mergeCommit: 'eee888', updatedAt: revertAt, reverts: 7, ...over });

test('a merged pull request that names one is told with whether that one is stored and when it was merged', async () => {
  const merged7 = '2026-03-05T09:00:00.000Z';
  const cases: Array<[string, PullRequestFacts | null, { reverted: number; stored: boolean; revertedMergedAt: string | null }]> = [
    ['7 merged', facts({ state: 'merged', mergedAt: merged7, closedAt: merged7, updatedAt: merged7 }), { reverted: 7, stored: true, revertedMergedAt: merged7 }],
    ['7 open', facts(), { reverted: 7, stored: true, revertedMergedAt: null }],
    ['7 closed', facts({ state: 'closed', closedAt: merged7, updatedAt: merged7 }), { reverted: 7, stored: true, revertedMergedAt: null }],
    ['7 not stored', null, { reverted: 7, stored: false, revertedMergedAt: null }],
    ['7 merged with no closed_at', facts({ state: 'merged', mergedAt: merged7, closedAt: null, updatedAt: '2026-03-06T09:00:00.000Z' }), { reverted: 7, stored: true, revertedMergedAt: merged7 }],
    ['7 of another repository', facts({ ref: { ...ref, repo: 'store' }, state: 'merged', mergedAt: merged7, closedAt: merged7, updatedAt: merged7 }), { reverted: 7, stored: false, revertedMergedAt: null }],
    ['7 of another owner', facts({ ref: { ...ref, owner: 'octo' }, state: 'merged', mergedAt: merged7, closedAt: merged7, updatedAt: merged7 }), { reverted: 7, stored: false, revertedMergedAt: null }],
    ['7 merged, closed at another time', facts({ state: 'merged', mergedAt: merged7, closedAt: '2026-03-05T09:30:00.000Z', updatedAt: '2026-03-06T09:00:00.000Z' }), { reverted: 7, stored: true, revertedMergedAt: '2026-03-05T09:30:00.000Z' }],
  ];
  for (const [name, seven, want] of cases) {
    const db = await testDb();
    if (seven !== null) await savePullRequest(db, seven);
    await savePullRequest(db, revertingNine());
    assert.deepEqual(await revertOf(db, nine), want, name);
    assert.deepEqual(await revertOf(db, { ...nine, owner: 'Acme' }), want, `${name}, owner in another case`);
    await db.close();
  }
  const db = await testDb();
  await savePullRequest(db, revertingNine({ reverts: 9 }));
  assert.deepEqual(await revertOf(db, nine), { reverted: 9, stored: true, revertedMergedAt: revertAt });
  await db.close();
});
test('a pull request that is not merged, or names none, reverts nothing', async () => {
  const cases: Array<[string, PullRequestFacts | null]> = [
    ['9 open', facts({ ref: nine, reverts: 7 })],
    ['9 closed', facts({ ref: nine, state: 'closed', closedAt: revertAt, updatedAt: revertAt, reverts: 7 })],
    ['9 merged with none', revertingNine({ reverts: undefined })],
    ['9 not stored', null],
  ];
  for (const [name, f] of cases) {
    const db = await testDb();
    await savePullRequest(db, facts({ state: 'merged', mergedAt: t(5), closedAt: t(5), updatedAt: t(5) }));
    if (f !== null) {
      const { reverts, ...rest } = f;
      await savePullRequest(db, reverts === undefined ? rest : f);
    }
    assert.equal(await revertOf(db, nine), null, name);
    await db.close();
  }
});

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
test('the title is stored with the facts, kept when an event carries none, and replaced only by a newer event\'s', async () => {
  const db = await testDb();
  const title = async (): Promise<string | null | undefined> =>
    (await db.query<{ title: string | null }>('select title from visto_ai.pull_requests where number = 7'))[0]?.title;
  assert.equal(await savePullRequest(db, facts({ title: 'Round prices before tax', updatedAt: at(0) })), true);
  assert.equal(await title(), 'Round prices before tax');
  assert.equal(await savePullRequest(db, facts({ headSha: 'bbb222', updatedAt: at(10) })), true);
  assert.equal(await title(), 'Round prices before tax');
  assert.equal(await savePullRequest(db, facts({ title: 'Round prices', updatedAt: at(5) })), false);
  assert.equal(await title(), 'Round prices before tax');
  assert.equal(await savePullRequest(db, facts({ title: 'Round all prices', updatedAt: at(20) })), true);
  assert.equal(await title(), 'Round all prices');
  const stored = await getPullRequest(db, ref);
  assert.equal(stored === null ? null : 'title' in stored, false);
  await db.close();
});
