import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubHistorySource } from './history-source.ts';
import type { RepoRef } from '../types.ts';

interface Call { url: string; method: string | undefined }

let calls: Call[] = [];
let responses: Array<Response | Error> = [];

const queue = (...r: Array<Response | Error>): void => {
  responses.push(...r);
};

const stubFetch = ((input: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(input), method: init?.method });
  const next = responses.shift();
  if (next === undefined) return Promise.reject(new Error('no response queued'));
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next);
}) as typeof fetch;

const source = () => createGithubHistorySource({ token: 't', fetch: stubFetch });
const repo: RepoRef = { owner: 'acme', repo: 'shop' };
const window = { since: '2026-03-01', until: '2026-04-01' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const pull = (number: number, mergedAt: string | null, updatedAt: string, extra: Record<string, unknown> = {}) => ({
  number, title: `Change ${number}`, body: 'Does a thing', user: { login: 'dev-one', type: 'User' },
  base: { ref: 'main', sha: `base${number}` }, head: { ref: `feature-${number}`, sha: `head${number}` },
  merged_at: mergedAt, updated_at: updatedAt, ...extra,
});

const message = (text: string) => (e: Error) => e.message === text;

test.beforeEach(() => {
  calls = [];
  responses = [];
});

test('keeps merged pull requests inside the window and stops at the first one updated before it', async () => {
  const filler = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => pull(from + i, '2026-02-20T00:00:00Z', '2026-03-05T00:00:00Z'));
  const first = [
    pull(9, '2026-04-01T00:00:00Z', '2026-05-09T00:00:00Z'), // merged after the window
    pull(8, null, '2026-05-08T00:00:00Z'), // closed without merging
    pull(7, '2026-03-20T10:00:00Z', '2026-03-21T00:00:00Z'),
    pull(6, '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z', { body: null, user: null }),
    ...filler(500, 96), // merged before the window but updated inside it: skipped, listing goes on
  ];
  const second = [
    pull(5, '2026-03-15T00:00:00Z', '2026-03-16T00:00:00Z'),
    pull(4, '2026-02-10T00:00:00Z', '2026-02-28T23:59:59Z'), // updated before the window: the listing ends here
    pull(3, '2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z'),
  ];
  queue(json(first), json(second));
  const out = await source().listMergedPullRequests(repo, window, 50);
  assert.deepEqual(out.pullRequests.map((p) => p.number), [7, 6, 5]);
  assert.equal(out.pageLimitReached, false);
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /\/repos\/acme\/shop\/pulls\?state=closed&sort=updated&direction=desc&per_page=100&page=1$/);
  assert.match(calls[1]!.url, /page=2$/);
  assert.deepEqual(out.pullRequests[0], {
    number: 7, title: 'Change 7', description: 'Does a thing', author: 'dev-one', authorIsBot: false,
    baseBranch: 'main', headBranch: 'feature-7', baseSha: 'base7', headSha: 'head7', mergedAt: '2026-03-20T10:00:00Z',
  });
  assert.equal(out.pullRequests[1]!.description, '');
  assert.equal(out.pullRequests[1]!.author, 'ghost');
  assert.equal(out.pullRequests[1]!.authorIsBot, false);
});

test('the window start is midnight UTC and the end is exclusive', async () => {
  queue(json([
    pull(4, '2026-03-31T23:59:59Z', '2026-04-02T00:00:00Z'),
    pull(3, '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z'),
    pull(2, '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z'),
    pull(1, '2026-02-28T23:59:59Z', '2026-03-01T00:00:00Z'),
    pull(0, '2026-03-10T00:00:00Z', '2026-02-28T23:59:59Z'),
  ]));
  const out = await source().listMergedPullRequests(repo, window, 50);
  assert.deepEqual(out.pullRequests.map((p) => p.number), [4, 2]);
});

test('stops at the limit', async () => {
  queue(json([
    pull(3, '2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z'),
    pull(2, '2026-03-09T00:00:00Z', '2026-03-10T00:00:00Z'),
    pull(1, '2026-03-08T00:00:00Z', '2026-03-09T00:00:00Z'),
  ]));
  const out = await source().listMergedPullRequests(repo, window, 2);
  assert.deepEqual(out.pullRequests.map((p) => p.number), [3, 2]);
  assert.equal(out.pageLimitReached, false);
});

test('stops after 20 pages without an error', async () => {
  for (let i = 0; i < 20; i += 1) {
    queue(json(Array.from({ length: 100 }, (_, j) => pull(i * 100 + j, null, '2026-03-20T00:00:00Z'))));
  }
  assert.deepEqual(await source().listMergedPullRequests(repo, window, 50), { pullRequests: [], pageLimitReached: true });
  assert.equal(calls.length, 20);
});

test('a twentieth page that is not full ends the listing without reaching the page limit', async () => {
  for (let i = 0; i < 20; i += 1) {
    queue(json(Array.from({ length: i === 19 ? 40 : 100 }, (_, j) => pull(i * 100 + j, null, '2026-03-20T00:00:00Z'))));
  }
  assert.deepEqual(await source().listMergedPullRequests(repo, window, 50), { pullRequests: [], pageLimitReached: false });
});

test('the limit reached on the twentieth full page is not the page limit', async () => {
  for (let i = 0; i < 20; i += 1) {
    queue(json(Array.from({ length: 100 }, (_, j) => pull(i * 100 + j, i === 19 && j === 99 ? '2026-03-19T00:00:00Z' : null, '2026-03-20T00:00:00Z'))));
  }
  const out = await source().listMergedPullRequests(repo, window, 1);
  assert.deepEqual([out.pullRequests.length, out.pageLimitReached], [1, false]);
});

test('a bot author is flagged', async () => {
  queue(json([
    pull(2, '2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z', { user: { login: 'dependabot[bot]', type: 'User' } }),
    pull(1, '2026-03-09T00:00:00Z', '2026-03-10T00:00:00Z', { user: { login: 'release-helper', type: 'Bot' } }),
  ]));
  const out = await source().listMergedPullRequests(repo, window, 50);
  assert.deepEqual(out.pullRequests.map((p) => p.authorIsBot), [true, true]);
});

test('a bad window is refused before any request', async () => {
  await assert.rejects(source().listMergedPullRequests(repo, { since: 'yesterday', until: '2026-04-01' }, 5), message('bad_window'));
  assert.equal(calls.length, 0);
});

const review = (id: number, state: string, extra: Record<string, unknown> = {}) => ({
  id, user: { login: 'dev-two', type: 'User' }, author_association: 'MEMBER', state,
  commit_id: 'abc123', submitted_at: '2026-03-02T00:00:00Z', body: 'Looks fine', ...extra,
});

test('reviews: bots, pending, states, associations and nulls', async () => {
  queue(json([
    review(1, 'APPROVED', { user: { login: 'dependabot[bot]', type: 'User' } }),
    review(2, 'CHANGES_REQUESTED', { user: { login: 'review-helper', type: 'Bot' }, author_association: 'OWNER' }),
    review(3, 'PENDING'),
    review(4, 'DISMISSED', { author_association: 'CONTRIBUTOR', body: null, commit_id: null }),
    review(5, 'SOMETHING_NEW', { author_association: 'COLLABORATOR' }),
    review(6, 'COMMENTED', { user: null }),
  ]));
  const out = await source().listReviews(repo, 12);
  assert.match(calls[0]!.url, /\/repos\/acme\/shop\/pulls\/12\/reviews\?per_page=100&page=1$/);
  assert.deepEqual(out.map((r) => [r.id, r.author, r.authorIsBot, r.association, r.state]), [
    ['1', 'dependabot[bot]', true, 'member', 'approved'],
    ['2', 'review-helper', true, 'owner', 'changes_requested'],
    ['4', 'dev-two', false, 'none', 'dismissed'],
    ['5', 'dev-two', false, 'collaborator', 'commented'],
    ['6', 'ghost', false, 'member', 'commented'],
  ]);
  assert.equal(out[2]!.body, '');
  assert.equal(out[2]!.commit, null);
  assert.equal(out[0]!.commit, 'abc123');
  assert.equal(out[0]!.at, '2026-03-02T00:00:00Z');
});

const inline = (id: number, extra: Record<string, unknown> = {}) => ({
  id, user: { login: 'dev-two', type: 'User' }, author_association: 'COLLABORATOR', created_at: '2026-03-03T00:00:00Z',
  original_commit_id: 'orig111', path: 'src/cart.ts', side: 'RIGHT', original_line: 12, original_start_line: null,
  subject_type: 'line', in_reply_to_id: undefined, body: 'Why?', ...extra,
});

test('inline comments keep the original commit and line, file level, replies and the default side', async () => {
  queue(json([
    inline(1, { line: null, original_line: 42, original_start_line: 40, side: 'LEFT' }),
    inline(2, { subject_type: 'file', original_line: null, side: undefined }),
    inline(3, { in_reply_to_id: 1, body: null }),
  ]));
  const out = await source().listInlineComments(repo, 12);
  assert.match(calls[0]!.url, /\/repos\/acme\/shop\/pulls\/12\/comments\?per_page=100&page=1$/);
  assert.deepEqual(out[0], {
    id: '1', author: 'dev-two', authorIsBot: false, association: 'collaborator', at: '2026-03-03T00:00:00Z',
    commit: 'orig111', path: 'src/cart.ts', side: 'LEFT', line: 42, startLine: 40, fileLevel: false, replyTo: null, body: 'Why?',
  });
  assert.equal(out[1]!.fileLevel, true);
  assert.equal(out[1]!.line, null);
  assert.equal(out[1]!.side, 'RIGHT');
  assert.equal(out[2]!.replyTo, '1');
  assert.equal(out[2]!.body, '');
});

test('general comments', async () => {
  queue(json([
    { id: 7, user: { login: 'ci-helper[bot]', type: 'Bot' }, author_association: 'NONE', created_at: '2026-03-04T00:00:00Z', body: 'Build ok' },
    { id: 8, user: null, author_association: 'OWNER', created_at: '2026-03-05T00:00:00Z', body: null },
  ]));
  const out = await source().listGeneralComments(repo, 12);
  assert.match(calls[0]!.url, /\/repos\/acme\/shop\/issues\/12\/comments\?per_page=100&page=1$/);
  assert.deepEqual(out, [
    { id: '7', author: 'ci-helper[bot]', authorIsBot: true, association: 'none', at: '2026-03-04T00:00:00Z', body: 'Build ok' },
    { id: '8', author: 'ghost', authorIsBot: false, association: 'owner', at: '2026-03-05T00:00:00Z', body: '' },
  ]);
});

test('compare returns the merge base and the files; a 404 is null', async () => {
  queue(
    json({ merge_base_commit: { sha: 'mb999' }, files: [{ filename: 'src/a.ts', status: 'added', additions: 3, deletions: 0, patch: '+x' }] }),
    new Response('', { status: 404 }),
  );
  const out = await source().compare(repo, 'base1', 'head1');
  assert.match(calls[0]!.url, /\/repos\/acme\/shop\/compare\/base1\.\.\.head1\?per_page=1$/);
  assert.deepEqual(out, { mergeBase: 'mb999', files: [{ path: 'src/a.ts', previousPath: null, status: 'added', additions: 3, deletions: 0, patch: '+x' }] });
  assert.equal(await source().compare(repo, 'base1', 'gone'), null);
});

test('compare with 300 files throws too_many_files', async () => {
  queue(json({ merge_base_commit: { sha: 'mb' }, files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })) }));
  await assert.rejects(source().compare(repo, 'a', 'b'), message('too_many_files'));
});

test('a list of more than 10 pages throws github_too_many_pages', async () => {
  for (let i = 0; i < 10; i += 1) queue(json(Array.from({ length: 100 }, (_, j) => ({ id: i * 100 + j + 1, user: null, created_at: 't', body: '' }))));
  await assert.rejects(source().listGeneralComments(repo, 1), message('github_too_many_pages'));
  assert.equal(calls.length, 10);
});

test('several pages are joined, the last one short', async () => {
  const full = Array.from({ length: 100 }, (_, j) => ({ id: j + 1, user: null, author_association: 'NONE', created_at: 't', body: '' }));
  queue(json(full), json([{ id: 500, user: null, author_association: 'NONE', created_at: 't', body: 'x' }]));
  assert.equal((await source().listGeneralComments(repo, 1)).length, 101);
  assert.equal(calls.length, 2);
});

test('a response that is not the expected shape is github_bad_response', async () => {
  queue(json({ message: 'nope' }), json([{ user: null, created_at: 't', body: '' }]), new Response('not json', { status: 200 }), json([5]));
  await assert.rejects(source().listGeneralComments(repo, 1), message('github_bad_response'));
  await assert.rejects(source().listGeneralComments(repo, 1), message('github_bad_response'));
  await assert.rejects(source().listReviews(repo, 1), message('github_bad_response'));
  await assert.rejects(source().listInlineComments(repo, 1), message('github_bad_response'));
  queue(json({ files: [] }));
  await assert.rejects(source().compare(repo, 'a', 'b'), message('github_bad_response'));
});

test('failures: status, network, and a bad repository name', async () => {
  queue(new Response('', { status: 403 }), new TypeError('x'), new TypeError('y'));
  await assert.rejects(source().listReviews(repo, 1), message('github_403'));
  await assert.rejects(source().listReviews(repo, 1), message('github_network'));
  await assert.rejects(source().listReviews({ owner: '..', repo: 'shop' }, 1), message('github_bad_path'));
  assert.equal(calls.length, 3);
});

test('every request was a GET', async () => {
  queue(json([]), json([]), json([]), json([]), json({ merge_base_commit: { sha: 'm' }, files: [] }));
  const s = source();
  await s.listMergedPullRequests(repo, window, 5);
  await s.listReviews(repo, 1);
  await s.listInlineComments(repo, 1);
  await s.listGeneralComments(repo, 1);
  await s.compare(repo, 'a', 'b');
  assert.equal(calls.length, 5);
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ['GET']);
});

test('pullRequest returns the merged pull request', async () => {
  queue(json(pull(7, '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', { title: 'Add totals' })));
  const out = await source().pullRequest(repo, 7);
  assert.ok(out !== null);
  assert.equal(out.title, 'Add totals');
  assert.equal(out.mergedAt, '2026-01-02T00:00:00Z');
  assert.ok(calls[0]?.url.endsWith('/repos/acme/shop/pulls/7'));
});

test('pullRequest returns null on 404', async () => {
  queue(json({ message: 'Not Found' }, 404));
  assert.equal(await source().pullRequest(repo, 7), null);
});

test('pullRequest returns null when not merged', async () => {
  queue(json(pull(7, null, '2026-01-03T00:00:00Z')));
  assert.equal(await source().pullRequest(repo, 7), null);
});

test('pullRequest rejects with github_500', async () => {
  queue(new Response('', { status: 500 }), new Response('', { status: 500 })); // a 5xx is retried once
  await assert.rejects(source().pullRequest(repo, 7), message('github_500'));
});
