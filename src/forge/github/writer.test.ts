import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubWriter } from './writer.ts';
import type { AppAuth } from './app-auth.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const auth: AppAuth = { appToken: () => 'jwt', installationToken: async (id) => `tok-${id}` };
const info = { read: async () => ({ botLogin: 'visto-test[bot]', permissions: {}, events: [] }) };
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
/** Answers by "<METHOD> <path and query>"; an unknown one is 404. Records each request's method, path, Authorization header and JSON body. */
function github(routes: Record<string, () => Response>) {
  const seen: Array<{ method: string; path: string; authorization: string | null; body?: unknown }> = [];
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = String(url).replace('https://api.github.com', '');
    const entry: (typeof seen)[number] = { method, path, authorization: new Headers(init?.headers).get('authorization') };
    if (typeof init?.body === 'string') entry.body = JSON.parse(init.body);
    seen.push(entry);
    return (routes[`${method} ${path}`] ?? (() => json({ message: 'Not Found' }, 404)))();
  };
  return { seen, writer: createGithubWriter({ auth, info, fetch: stub as typeof fetch }) };
}

const DRAFT = { commit: 'head222', body: 'Review text', comments: [{ path: 'a.ts', side: 'RIGHT' as const, line: 3, body: '**[major]** note' }] };
const REVIEWS = 'POST /repos/acme/shop/pulls/7/reviews';

test('a review is posted once, as a comment pinned to its commit, with the installation token', async () => {
  const { writer, seen } = github({ [REVIEWS]: () => json({ id: 501 }) });
  assert.deepEqual(await writer.publishReview(REF, '99', DRAFT), { id: '501' });
  assert.deepEqual(seen, [{ method: 'POST', path: '/repos/acme/shop/pulls/7/reviews', authorization: 'Bearer tok-99',
    body: { commit_id: 'head222', body: 'Review text', event: 'COMMENT', comments: DRAFT.comments } }]);
});
test('a review with no inline comment is sent without the comments key', async () => {
  const { writer, seen } = github({ [REVIEWS]: () => json({ id: 501 }) });
  await writer.publishReview(REF, '99', { ...DRAFT, comments: [] });
  assert.deepEqual(seen[0]!.body, { commit_id: 'head222', body: 'Review text', event: 'COMMENT' });
});
test('a refusal of the content has its own code, and nothing is ever sent twice', async () => {
  for (const [status, code] of [[422, 'review_rejected'], [502, 'github_502'], [403, 'github_403']] as const) {
    const { writer, seen } = github({ [REVIEWS]: () => json({ message: 'no' }, status) });
    await assert.rejects(writer.publishReview(REF, '99', DRAFT), new RegExp(`^Error: ${code}$`));
    assert.equal(seen.length, 1);
  }
  const down = github({ [REVIEWS]: () => { throw new Error('socket closed'); } });
  await assert.rejects(down.writer.publishReview(REF, '99', DRAFT), /^Error: github_network$/);
  assert.equal(down.seen.length, 1);
});
test('a successful answer without a whole-number id is a bad response', async () => {
  for (const answer of [{}, { id: 'x' }, { id: 1.5 }]) {
    const { writer } = github({ [REVIEWS]: () => json(answer) });
    await assert.rejects(writer.publishReview(REF, '99', DRAFT), /^Error: github_bad_response$/);
  }
});
test("the app's own reviews are listed, newest first: by its own account, with a body", async () => {
  const review = (id: number, login: string, type: string, commit: string, body: string, at: string) =>
    ({ id, user: { login, type }, commit_id: commit, body, submitted_at: at, state: 'COMMENTED' });
  const { writer } = github({ 'GET /repos/acme/shop/pulls/7/reviews?per_page=100&page=1': () => json([
    review(1, 'visto-test[bot]', 'Bot', 'head111', 'old', '2026-03-01T09:00:00Z'),
    review(2, 'visto-test[bot]', 'Bot', 'head222', '', '2026-03-01T10:05:00Z'),
    review(3, 'other-app[bot]', 'Bot', 'head222', 'text', '2026-03-01T10:06:00Z'),
    review(4, 'visto-test[bot]', 'User', 'head222', 'text', '2026-03-01T10:07:00Z'),
    review(5, 'visto-test[bot]', 'Bot', 'head222', 'text', '2026-03-01T10:08:00Z'),
  ]) });
  assert.deepEqual(await writer.listOwnReviews(REF, '99'), [{ id: '5', commit: 'head222' }, { id: '1', commit: 'head111' }]);
});
test('a review without a readable time sorts last, and ties keep the order given', async () => {
  const review = (id: number, at: unknown) => ({ id, user: { login: 'visto-test[bot]', type: 'Bot' }, commit_id: `c${id}`, body: 'text', submitted_at: at });
  const { writer } = github({ 'GET /repos/acme/shop/pulls/7/reviews?per_page=100&page=1': () => json([
    review(1, null), review(2, '2026-03-01T09:00:00Z'), review(3, 'not a time'), review(4, '2026-03-01T09:00:00Z'), review(5, '2026-03-01T10:00:00Z'),
  ]) });
  assert.deepEqual((await writer.listOwnReviews(REF, '99')).map((r) => r.id), ['5', '2', '4', '1', '3']);
});
test('a review list that fills its last page rejects', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, user: { login: 'visto-test[bot]', type: 'Bot' }, commit_id: 'c', body: 'text', submitted_at: '2026-03-01T09:00:00Z' }));
  const routes = Object.fromEntries(Array.from({ length: 10 }, (_, p) => [`GET /repos/acme/shop/pulls/7/reviews?per_page=100&page=${p + 1}`, () => json(full)]));
  await assert.rejects(github(routes).writer.listOwnReviews(REF, '99'), /^Error: github_too_many_pages$/);
});
test("a review's comments are read from the pull request's list, with the line they sit on", async () => {
  const comment = (id: number, reviewId: number, line: number | null, original: number | null) =>
    ({ id, pull_request_review_id: reviewId, path: 'a.ts', side: 'RIGHT', line, original_line: original, body: 'note' });
  const { writer } = github({ 'GET /repos/acme/shop/pulls/7/comments?per_page=100&page=1': () => json([comment(9001, 501, 3, 3), comment(9002, 500, 4, 4), comment(9003, 501, null, 8), comment(9004, 501, null, null)]) });
  assert.deepEqual(await writer.listReviewComments(REF, '99', '501'), [
    { id: '9001', path: 'a.ts', side: 'RIGHT', line: 3, body: 'note' },
    { id: '9003', path: 'a.ts', side: 'RIGHT', line: 8, body: 'note' },
    { id: '9004', path: 'a.ts', side: 'RIGHT', line: null, body: 'note' },
  ]);
});
test('a comment list that was cut short answers null', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, pull_request_review_id: 501, path: 'a.ts', side: 'RIGHT', line: 1, original_line: 1, body: 'n' }));
  const routes = Object.fromEntries(Array.from({ length: 25 }, (_, p) => [`GET /repos/acme/shop/pulls/7/comments?per_page=100&page=${p + 1}`, () => json(full)]));
  assert.equal(await github(routes).writer.listReviewComments(REF, '99', '501'), null);
});
test('a comment list that fails for another reason still rejects', async () => {
  await assert.rejects(github({ 'GET /repos/acme/shop/pulls/7/comments?per_page=100&page=1': () => json({}, 500) }).writer.listReviewComments(REF, '99', '501'), /^Error: github_500$/);
});
test('a reaction and a general comment are posted to the pull request', async () => {
  const { writer, seen } = github({
    'POST /repos/acme/shop/issues/comments/31/reactions': () => json({ id: 1 }, 201),
    'POST /repos/acme/shop/issues/7/comments': () => json({ id: 2 }, 201),
  });
  await writer.react(REF, '99', '31', 'eyes');
  await writer.comment(REF, '99', 'text');
  assert.deepEqual(seen.map((s) => [s.path, s.body]), [['/repos/acme/shop/issues/comments/31/reactions', { content: 'eyes' }], ['/repos/acme/shop/issues/7/comments', { body: 'text' }]]);
});
test('a post carries the read side headers and a JSON content type, and a failed one is not repeated', async () => {
  let headers = new Headers();
  const stub = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => { headers = new Headers(init?.headers); return json({}, 500); };
  const writer = createGithubWriter({ auth, info, fetch: stub as typeof fetch });
  await assert.rejects(writer.comment(REF, '99', 'text'), /^Error: github_500$/);
  assert.deepEqual(
    ['authorization', 'x-github-api-version', 'user-agent', 'accept', 'content-type'].map((h) => headers.get(h)),
    ['Bearer tok-99', '2022-11-28', 'visto-ai', 'application/vnd.github+json', 'application/json'],
  );
});
test('an id that is not digits is refused before any request', async () => {
  const { writer, seen } = github({});
  await assert.rejects(writer.react(REF, '99', '3/1', 'eyes'), /^Error: github_bad_path$/);
  await assert.rejects(writer.listReviewComments(REF, '99', 'x'), /^Error: github_bad_path$/);
  await assert.rejects(writer.publishReview(REF, '9/9', DRAFT), /^Error: github_bad_path$/);
  assert.equal(seen.length, 0);
});
test('a redirect is not followed: a post answered 301 rejects github_301 after one request', async () => {
  const seen: Array<RequestRedirect | undefined> = [];
  const stub = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push(init?.redirect);
    return new Response(null, { status: 301, headers: { location: 'https://api.github.com/repositories/1/pulls/7/reviews' } });
  };
  const writer = createGithubWriter({ auth, info, fetch: stub as typeof fetch });
  await assert.rejects(writer.publishReview(REF, '99', DRAFT), /^Error: github_301$/);
  assert.deepEqual(seen, ['manual']);
});
test('an error the writer throws holds nothing of the token: each message is a short code', async () => {
  const secret = 'tok-secret-0123456789';
  const leaky: AppAuth = { appToken: () => 'jwt', installationToken: async () => secret };
  const answers = [() => json({ message: secret }, 500), () => json({ message: secret }, 422), () => json({ id: secret }), () => { throw new Error(secret); }];
  for (const answer of answers) {
    const writer = createGithubWriter({ auth: leaky, info, fetch: (async () => answer()) as typeof fetch });
    const calls = [
      writer.publishReview(REF, '99', DRAFT), writer.listOwnReviews(REF, '99'), writer.listReviewComments(REF, '99', '501'),
      writer.react(REF, '99', '31', 'eyes'), writer.comment(REF, '99', 'text'),
    ];
    for (const call of calls) {
      const error = await call.then(() => null, (e: unknown) => e);
      if (error === null) continue;
      assert.ok(error instanceof Error);
      assert.match(error.message, /^[a-z][a-z0-9_]{0,39}$/);
      assert.equal(error.message.includes(secret), false);
    }
  }
});
