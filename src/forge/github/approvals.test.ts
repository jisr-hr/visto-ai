import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubApprovals, MAX_RULE_PAGES } from './approvals.ts';
import type { AppAuth } from './app-auth.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const auth: AppAuth = { appToken: () => 'jwt', installationToken: async (id) => `tok-${id}` };
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
/** Answers by "<METHOD> <path and query>"; an unknown one is 404. Records each request. */
function github(routes: Record<string, () => Response>) {
  const seen: Array<{ method: string; path: string; authorization: string | null; redirect?: string; body?: Record<string, unknown> }> = [];
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = String(url).replace('https://api.github.com', '');
    const entry: (typeof seen)[number] = { method, path, authorization: new Headers(init?.headers).get('authorization') };
    if (init?.redirect) entry.redirect = init.redirect;
    if (typeof init?.body === 'string') entry.body = JSON.parse(init.body) as Record<string, unknown>;
    seen.push(entry);
    return (routes[`${method} ${path}`] ?? (() => json({ message: 'Not Found' }, 404)))();
  };
  return { seen, approvals: createGithubApprovals({ auth, fetch: stub as typeof fetch }) };
}

const RULES = (branch: string, page = 1) => `/repos/acme/shop/rules/branches/${branch}?per_page=100&page=${page}`;
const PROTECTION = (branch: string) => `/repos/acme/shop/branches/${branch}/protection`;
const dismissing = { type: 'pull_request', parameters: { dismiss_stale_reviews_on_push: true, require_code_owner_review: false, required_approving_review_count: 1 } };
const protectionWith = (dismiss: boolean) => ({ required_pull_request_reviews: { dismiss_stale_reviews: dismiss, required_approving_review_count: 1 } });

test("a ruleset's pull request rule that dismisses stale reviews says dismissed, and the protection is not read", async () => {
  const { approvals, seen } = github({
    [`GET ${RULES('main')}`]: () => json([{ type: 'deletion' }, dismissing]),
    [`GET ${PROTECTION('main')}`]: () => json(protectionWith(false)),
  });
  assert.equal(await approvals.staleApprovals(REF, '99', 'main'), 'dismissed');
  assert.deepEqual(seen.map((s) => [s.method, s.path, s.authorization]), [['GET', '/repos/acme/shop/rules/branches/main?per_page=100&page=1', 'Bearer tok-99']]);
});

test('with no such rule the protection decides: true says dismissed; false, absent and a 404 say kept', async () => {
  const lists = [[], [{ type: 'pull_request', parameters: { dismiss_stale_reviews_on_push: false } }, { type: 'deletion' }]];
  for (const rules of lists) {
    const cases: Array<[() => Response, 'dismissed' | 'kept']> = [
      [() => json(protectionWith(true)), 'dismissed'],
      [() => json(protectionWith(false)), 'kept'],
      [() => json({ required_status_checks: { strict: true, contexts: [] } }), 'kept'],
      [() => json({ message: 'Branch not protected' }, 404), 'kept'],
    ];
    for (const [protection, expected] of cases) {
      const { approvals, seen } = github({ [`GET ${RULES('main')}`]: () => json(rules), [`GET ${PROTECTION('main')}`]: protection });
      assert.equal(await approvals.staleApprovals(REF, '99', 'main'), expected);
      assert.deepEqual(seen.map((s) => [s.method, s.path]), [['GET', RULES('main')], ['GET', PROTECTION('main')]]);
    }
  }
  // a rule of another type, or one whose parameters are not an object, says nothing
  for (const rules of [[{ type: 'required_signatures', parameters: { dismiss_stale_reviews_on_push: true } }], [{ type: 'pull_request', parameters: 'x' }], [{ type: 'pull_request' }]]) {
    const { approvals } = github({ [`GET ${RULES('main')}`]: () => json(rules), [`GET ${PROTECTION('main')}`]: () => json({}, 404) });
    assert.equal(await approvals.staleApprovals(REF, '99', 'main'), 'kept');
  }
});

test('a dismiss flag says dismissed only when it is true itself: a string, a number or an object says nothing', async () => {
  for (const flag of ['true', 1, {}]) {
    const { approvals } = github({
      [`GET ${RULES('main')}`]: () => json([{ type: 'pull_request', parameters: { dismiss_stale_reviews_on_push: flag } }]),
      [`GET ${PROTECTION('main')}`]: () => json({}, 404),
    });
    assert.equal(await approvals.staleApprovals(REF, '99', 'main'), 'kept', JSON.stringify(flag));
  }
  const { approvals, seen } = github({
    [`GET ${RULES('main')}`]: () => json([]),
    [`GET ${PROTECTION('main')}`]: () => json({ required_pull_request_reviews: { dismiss_stale_reviews: 1 } }),
  });
  assert.equal(await approvals.staleApprovals(REF, '99', 'main'), 'kept');
  assert.deepEqual(seen.map((s) => s.path), [RULES('main'), PROTECTION('main')]);
});

test('a form that could not be read is no answer: kept only when both were read, dismissed when either says so', async () => {
  const denied = () => json({ message: 'Resource not accessible by integration' }, 403);
  const rulesDenied = github({ [`GET ${RULES('main')}`]: denied, [`GET ${PROTECTION('main')}`]: () => json(protectionWith(true)) });
  assert.equal(await rulesDenied.approvals.staleApprovals(REF, '99', 'main'), 'dismissed');

  const rulesDeniedNoProtection = github({ [`GET ${RULES('main')}`]: denied, [`GET ${PROTECTION('main')}`]: () => json({}, 404) });
  await assert.rejects(rulesDeniedNoProtection.approvals.staleApprovals(REF, '99', 'main'), /^Error: github_403$/);

  const protectionDenied = github({ [`GET ${RULES('main')}`]: () => json([]), [`GET ${PROTECTION('main')}`]: denied });
  await assert.rejects(protectionDenied.approvals.staleApprovals(REF, '99', 'main'), /^Error: github_403$/);

  // both failed: the rulesets' failure is the one given
  const both = github({ [`GET ${RULES('main')}`]: denied, [`GET ${PROTECTION('main')}`]: () => json({}, 502) });
  await assert.rejects(both.approvals.staleApprovals(REF, '99', 'main'), /^Error: github_403$/);

  const down = github({ [`GET ${RULES('main')}`]: () => json({}, 500), [`GET ${PROTECTION('main')}`]: () => json({}, 404) });
  await assert.rejects(down.approvals.staleApprovals(REF, '99', 'main'), /^Error: github_500$/);
  assert.deepEqual(down.seen.map((s) => s.path), [RULES('main'), RULES('main'), PROTECTION('main')]);

  const noType = github({ [`GET ${RULES('main')}`]: () => json([{ type: 'deletion' }, { parameters: {} }]), [`GET ${PROTECTION('main')}`]: () => json({}, 404) });
  await assert.rejects(noType.approvals.staleApprovals(REF, '99', 'main'), /^Error: github_bad_response$/);
  // a list that is no list, an item that is no object, and a dismissing rule beside a broken item are no answer
  for (const rules of [{ rules: [] }, ['x'], [dismissing, { type: 1 }]]) {
    const { approvals } = github({ [`GET ${RULES('main')}`]: () => json(rules), [`GET ${PROTECTION('main')}`]: () => json({}, 404) });
    await assert.rejects(approvals.staleApprovals(REF, '99', 'main'), /^Error: github_bad_response$/);
  }

  // a protection answer that is no object, or no JSON, is no answer
  for (const answer of [() => json([]), () => json('x'), () => new Response('not json', { status: 200 })]) {
    const { approvals } = github({ [`GET ${RULES('main')}`]: () => json([]), [`GET ${PROTECTION('main')}`]: answer });
    await assert.rejects(approvals.staleApprovals(REF, '99', 'main'), /^Error: github_bad_response$/);
  }
  // a network failure of either read is no answer
  const lost = github({ [`GET ${RULES('main')}`]: () => { throw new Error('socket closed'); }, [`GET ${PROTECTION('main')}`]: () => json({}, 404) });
  await assert.rejects(lost.approvals.staleApprovals(REF, '99', 'main'), /^Error: github_network$/);
  const lostProtection = github({ [`GET ${RULES('main')}`]: () => json([]), [`GET ${PROTECTION('main')}`]: () => { throw new Error('socket closed'); } });
  await assert.rejects(lostProtection.approvals.staleApprovals(REF, '99', 'main'), /^Error: github_network$/);
});

test('a branch with a slash is sent encoded, and a rules list that fills its last page is no answer', async () => {
  const slashed = github({ [`GET ${RULES('release%2F1.0')}`]: () => json([]), [`GET ${PROTECTION('release%2F1.0')}`]: () => json(protectionWith(true)) });
  assert.equal(await slashed.approvals.staleApprovals(REF, '99', 'release/1.0'), 'dismissed');
  assert.deepEqual(slashed.seen.map((s) => s.path), ['/repos/acme/shop/rules/branches/release%2F1.0?per_page=100&page=1', '/repos/acme/shop/branches/release%2F1.0/protection']);

  const full = Array.from({ length: 100 }, () => ({ type: 'deletion' }));
  const routes: Record<string, () => Response> = { [`GET ${PROTECTION('main')}`]: () => json({}, 404) };
  for (let page = 1; page <= MAX_RULE_PAGES; page += 1) routes[`GET ${RULES('main', page)}`] = () => json(full);
  const long = github(routes);
  await assert.rejects(long.approvals.staleApprovals(REF, '99', 'main'), /^Error: github_too_many_pages$/);
  assert.equal(MAX_RULE_PAGES, 10);
  assert.deepEqual(long.seen.map((s) => s.path), [...Array.from({ length: 10 }, (_, i) => RULES('main', i + 1)), PROTECTION('main')]);
});

const REVIEW = 'GET /repos/acme/shop/pulls/7/reviews/501';
test('a review is read with its state and commit, and a 404 is null', async () => {
  for (const [state, expected] of [['APPROVED', 'approved'], ['DISMISSED', 'dismissed'], ['COMMENTED', 'commented'], ['CHANGES_REQUESTED', 'other']] as const) {
    const { approvals, seen } = github({ [REVIEW]: () => json({ id: 501, state, commit_id: 'h1', body: 'Review text' }) });
    assert.deepEqual(await approvals.readReview(REF, '99', '501'), { state: expected, commit: 'h1' });
    assert.deepEqual(seen.map((s) => [s.method, s.path, s.authorization]), [['GET', '/repos/acme/shop/pulls/7/reviews/501', 'Bearer tok-99']]);
  }
  assert.equal(await github({}).approvals.readReview(REF, '99', '501'), null);

  const down = github({ [REVIEW]: () => json({}, 500) });
  await assert.rejects(down.approvals.readReview(REF, '99', '501'), /^Error: github_500$/);
  assert.equal(down.seen.length, 2);
  const denied = github({ [REVIEW]: () => json({}, 403) });
  await assert.rejects(denied.approvals.readReview(REF, '99', '501'), /^Error: github_403$/);
  assert.equal(denied.seen.length, 1);

  for (const answer of [{ id: 501, commit_id: 'h1' }, { id: 501, state: 1, commit_id: 'h1' }, [], 'x']) {
    const { approvals } = github({ [REVIEW]: () => json(answer) });
    await assert.rejects(approvals.readReview(REF, '99', '501'), /^Error: github_bad_response$/);
  }
});

test('a review whose commit is null is read with its state', async () => {
  for (const answer of [{ id: 501, state: 'APPROVED', commit_id: null }, { id: 501, state: 'APPROVED' }, { id: 501, state: 'APPROVED', commit_id: 5 }]) {
    const { approvals } = github({ [REVIEW]: () => json(answer) });
    assert.deepEqual(await approvals.readReview(REF, '99', '501'), { state: 'approved', commit: null });
  }
});

test('a review state is read whatever its case', async () => {
  for (const [state, expected] of [['approved', 'approved'], ['Dismissed', 'dismissed'], ['commented', 'commented'], ['changes_requested', 'other']] as const) {
    const { approvals } = github({ [REVIEW]: () => json({ id: 501, state, commit_id: 'h1' }) });
    assert.deepEqual(await approvals.readReview(REF, '99', '501'), { state: expected, commit: 'h1' }, state);
  }
});

const DISMISSAL = 'PUT /repos/acme/shop/pulls/7/reviews/501/dismissals';
const MESSAGE = 'New commits were pushed after this approval.';
test('a dismissal is sent once as a PUT with its message, and an answer that is not dismissed rejects', async () => {
  const { approvals, seen } = github({ [DISMISSAL]: () => json({ id: 501, state: 'DISMISSED' }) });
  await approvals.dismissReview(REF, '99', '501', MESSAGE);
  assert.deepEqual(seen, [{ method: 'PUT', path: '/repos/acme/shop/pulls/7/reviews/501/dismissals', authorization: 'Bearer tok-99', redirect: 'manual',
    body: { message: MESSAGE, event: 'DISMISS' } }]);

  for (const status of [422, 403, 502]) {
    const refused = github({ [DISMISSAL]: () => json({ message: 'no' }, status) });
    await assert.rejects(refused.approvals.dismissReview(REF, '99', '501', MESSAGE), new RegExp(`^Error: github_${status}$`));
    assert.equal(refused.seen.length, 1);
  }
  for (const answer of [() => json({ id: 501, state: 'APPROVED' }), () => json({ id: 501 }), () => json([]), () => new Response('', { status: 200 })]) {
    const kept = github({ [DISMISSAL]: answer });
    await assert.rejects(kept.approvals.dismissReview(REF, '99', '501', MESSAGE), /^Error: dismiss_not_taken$/);
    assert.equal(kept.seen.length, 1);
  }
  const lost = github({ [DISMISSAL]: () => { throw new Error('socket closed'); } });
  await assert.rejects(lost.approvals.dismissReview(REF, '99', '501', MESSAGE), /^Error: github_network$/);
  assert.equal(lost.seen.length, 1);
});

test("a dismissal carries the writer's headers and a JSON content type, and a redirect is not followed", async () => {
  let headers = new Headers();
  const seen: Array<RequestRedirect | undefined> = [];
  const stub = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    headers = new Headers(init?.headers);
    seen.push(init?.redirect);
    return new Response(null, { status: 301, headers: { location: 'https://api.github.com/repositories/1/pulls/7/reviews/501/dismissals' } });
  };
  const approvals = createGithubApprovals({ auth, fetch: stub as typeof fetch });
  await assert.rejects(approvals.dismissReview(REF, '99', '501', MESSAGE), /^Error: github_301$/);
  assert.deepEqual(seen, ['manual']);
  assert.deepEqual(
    ['authorization', 'x-github-api-version', 'user-agent', 'accept', 'content-type'].map((h) => headers.get(h)),
    ['Bearer tok-99', '2022-11-28', 'visto-ai', 'application/vnd.github+json', 'application/json'],
  );
});

test('an id or an installation that is not digits is refused before any request, and no error holds the token', async () => {
  let asked = 0;
  const counting: AppAuth = { appToken: () => 'jwt', installationToken: async () => { asked += 1; return 'tok'; } };
  const seen: string[] = [];
  const approvals = createGithubApprovals({ auth: counting, fetch: (async (url: string | URL | Request) => { seen.push(String(url)); return json({}); }) as typeof fetch });
  const bad = /^Error: github_bad_path$/;
  await assert.rejects(approvals.readReview(REF, '99', 'x'), bad);
  await assert.rejects(approvals.readReview(REF, '99', '5/01'), bad);
  await assert.rejects(approvals.readReview(REF, '9/9', '501'), bad);
  await assert.rejects(approvals.dismissReview(REF, '99', '', MESSAGE), bad);
  await assert.rejects(approvals.dismissReview(REF, '99', '501?x=1', MESSAGE), bad);
  await assert.rejects(approvals.dismissReview(REF, 'x', '501', MESSAGE), bad);
  await assert.rejects(approvals.staleApprovals(REF, '', 'main'), bad);
  await assert.rejects(approvals.staleApprovals(REF, '99', ''), bad);
  await assert.rejects(approvals.staleApprovals(REF, '99', '..'), bad);
  await assert.rejects(approvals.staleApprovals(REF, '99', '\uD800'), bad);
  const odd = { ...REF, owner: 'ac/me' };
  await assert.rejects(approvals.staleApprovals(odd, '99', 'main'), bad);
  await assert.rejects(approvals.readReview(odd, '99', '501'), bad);
  await assert.rejects(approvals.dismissReview({ ...REF, repo: '..' }, '99', '501', MESSAGE), bad);
  for (const number of [0, -7, 1.5, Number.NaN]) await assert.rejects(approvals.readReview({ ...REF, number }, '99', '501'), bad);
  assert.deepEqual([seen, asked], [[], 0]);

  const secret = 'tok-secret-0123456789';
  const leaky: AppAuth = { appToken: () => 'jwt', installationToken: async () => secret };
  const answers = [() => json({ message: secret }, 500), () => json({ message: secret }, 422), () => json({ state: secret }), () => json([secret]),
    () => new Response(secret, { status: 200 }), () => { throw new Error(secret); }];
  for (const answer of answers) {
    const leaking = createGithubApprovals({ auth: leaky, fetch: (async () => answer()) as typeof fetch });
    const calls = [leaking.staleApprovals(REF, '99', 'main'), leaking.readReview(REF, '99', '501'), leaking.dismissReview(REF, '99', '501', MESSAGE)];
    for (const call of calls) {
      const error = await call.then(() => null, (e: unknown) => e);
      if (error === null) continue;
      assert.ok(error instanceof Error);
      assert.match(error.message, /^[a-z][a-z0-9_]{0,39}$/);
      assert.equal(error.message.includes(secret), false);
    }
  }
});
