import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubAccess } from './access.ts';
import type { AppAuth } from './app-auth.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const auth: AppAuth = { appToken: () => 'jwt', installationToken: async (id) => `tok-${id}` };
const PULL = {
  number: 7, title: 'Add things', body: null, state: 'open', merged: false, draft: false,
  user: { login: 'octo-dev', type: 'User' }, base: { ref: 'main', sha: 'base111', repo: { id: 501 } }, head: { ref: 'feat', sha: 'head222', repo: { id: 501 } },
};
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
/** Answers by "<path and query>"; an unknown one is 404. Records each request's path and Authorization header. */
function github(routes: Record<string, () => Response>) {
  const seen: Array<{ path: string; authorization: string | null }> = [];
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = String(url).replace('https://api.github.com', '');
    seen.push({ path, authorization: new Headers(init?.headers).get('authorization') });
    return (routes[path] ?? (() => json({ message: 'Not Found' }, 404)))();
  };
  return { seen, access: createGithubAccess({ auth, fetch: stub as typeof fetch }) };
}
const PULL_PATH = '/repos/acme/shop/pulls/7';
const COMPARE_PATH = '/repos/acme/shop/compare/base111...head222?per_page=1';

test('an open pull request is read with the merge base as its base, using the installation token', async () => {
  const { access, seen } = github({ [PULL_PATH]: () => json(PULL), [COMPARE_PATH]: () => json({ merge_base_commit: { sha: 'merge000' }, files: [] }) });
  assert.deepEqual(await access.readPullRequest(REF, '99'), {
    info: { ref: REF, title: 'Add things', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'merge000', headSha: 'head222', draft: false, fromFork: false },
    state: 'open',
  });
  assert.deepEqual(seen, [{ path: PULL_PATH, authorization: 'Bearer tok-99' }, { path: COMPARE_PATH, authorization: 'Bearer tok-99' }]);
});
test('a merged or closed pull request is read without the merge base', async () => {
  const { access, seen } = github({ [PULL_PATH]: () => json({ ...PULL, state: 'closed', merged: true }) });
  const live = await access.readPullRequest(REF, '99');
  assert.deepEqual([live?.state, live?.info.baseSha, seen.length], ['merged', 'base111', 1]);
});
test('a pull request that is not there is null', async () => {
  assert.equal(await github({}).access.readPullRequest(REF, '99'), null);
});
test('a refusal rejects with the status as its code', async () => {
  const { access } = github({ [PULL_PATH]: () => json({ message: 'Forbidden' }, 403) });
  await assert.rejects(access.readPullRequest(REF, '99'), /^Error: github_403$/);
});
test('an answer of another shape is refused', async () => {
  for (const broken of [{ ...PULL, draft: undefined }, { ...PULL, state: 'weird' }, { ...PULL, head: { ref: 'feat' } }]) {
    await assert.rejects(github({ [PULL_PATH]: () => json(broken) }).access.readPullRequest(REF, '99'), /^Error: github_bad_response$/);
  }
});
test('a compare answer with no merge base is refused', async () => {
  const { access } = github({ [PULL_PATH]: () => json(PULL), [COMPARE_PATH]: () => json({ files: [] }) });
  await assert.rejects(access.readPullRequest(REF, '99'), /^Error: github_bad_response$/);
});
test('sourceFor reads with that installation token', async () => {
  const { access, seen } = github({ '/repos/acme/shop/contents/a.ts?ref=head222': () => new Response('x') });
  const source = await access.sourceFor('99');
  const info = { ref: REF, title: '', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'merge000', headSha: 'head222', draft: false };
  assert.equal(await source.getFileContent(info, 'a.ts', 'head222'), 'x');
  assert.equal(seen[0]!.authorization, 'Bearer tok-99');
});

test('the read says whether a pull request comes from a fork, and a fork whose repository is gone is still one', async () => {
  const compare = { [COMPARE_PATH]: () => json({ merge_base_commit: { sha: 'merge000' }, files: [] }) };
  const cases: Array<[string, { base: Record<string, unknown>; head: Record<string, unknown> }, boolean]> = [
    ['same repository', { base: PULL.base, head: PULL.head }, false],
    ['another repository', { base: PULL.base, head: { ...PULL.head, repo: { id: 502 } } }, true],
    ['a deleted fork', { base: PULL.base, head: { ...PULL.head, repo: null } }, true],
    ['no repository said', { base: { ref: 'main', sha: 'base111' }, head: { ref: 'feat', sha: 'head222' } }, true],
    ['ids that are not numbers', { base: { ...PULL.base, repo: {} }, head: { ...PULL.head, repo: {} } }, true],
  ];
  for (const [name, sides, fromFork] of cases) {
    for (const closed of [false, true]) {
      const pull = { ...PULL, ...sides, ...(closed ? { state: 'closed', merged: true } : {}) };
      const live = await github({ [PULL_PATH]: () => json(pull), ...compare }).access.readPullRequest(REF, '99');
      assert.equal(live?.info.fromFork, fromFork, `${name}, ${closed ? 'merged' : 'open'}`);
    }
  }
});
