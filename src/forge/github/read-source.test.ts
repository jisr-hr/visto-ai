import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubReadSource } from './read-source.ts';
import type { PullRequestInfo } from '../types.ts';

interface Call { url: string; method: string; headers: Record<string, string> }

let calls: Call[] = [];
let responses: Array<Response | Error> = [];

const queue = (...r: Array<Response | Error>): void => {
  responses.push(...r);
};

const stubFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of new Headers(init?.headers).entries()) headers[k.toLowerCase()] = v;
  calls.push({ url: String(input), method: init?.method ?? 'GET', headers });
  const next = responses.shift();
  if (next === undefined) return Promise.reject(new Error('no response queued'));
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next);
}) as typeof fetch;

const source = (apiBase?: string) =>
  createGithubReadSource({ token: 't', fetch: stubFetch, ...(apiBase === undefined ? {} : { apiBase }) });

const pr: PullRequestInfo = {
  ref: { service: 'github', owner: 'acme', repo: 'shop', number: 1 },
  title: 'T', description: '', author: 'dev-one',
  baseBranch: 'main', headBranch: 'feature', baseSha: 'base000', headSha: 'head111', draft: false,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test.beforeEach(() => {
  calls = [];
  responses = [];
});

test('lists files from the frozen base to the head', async () => {
  queue(json({ files: [{ filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' }] }));
  const files = await source().listFiles(pr);
  assert.match(calls[0]!.url, /\/repos\/acme\/shop\/compare\/base000\.\.\.head111\?per_page=1$/);
  assert.equal(calls[0]!.url.startsWith('https://api.github.com/'), true);
  assert.deepEqual(files[0], { path: 'src/a.ts', previousPath: null, status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' });
  assert.equal(calls.length, 1);
});

test('every request carries the auth, version and agent headers', async () => {
  queue(json({ files: [] }), new Response('x', { status: 200 }));
  await source().listFiles(pr);
  await source().getFileContent(pr, 'a.ts', 'head111');
  for (const c of calls) {
    assert.equal(c.headers.authorization, 'Bearer t');
    assert.equal(c.headers['x-github-api-version'], '2022-11-28');
    assert.equal(c.headers['user-agent'], 'ai-score-reviewer');
  }
  assert.equal(calls[0]!.headers.accept, 'application/vnd.github+json');
});

test('a renamed file keeps its old path; a missing patch is null', async () => {
  queue(json({ files: [
    { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0 },
    { filename: 'src/b.ts', status: 'added', additions: 3, deletions: 0, patch: '+x' },
    { filename: 'src/c.ts', status: 'removed', additions: 0, deletions: 4 },
  ] }));
  const files = await source().listFiles(pr);
  assert.deepEqual(files.map((f) => [f.path, f.previousPath, f.status, f.patch]), [
    ['src/new.ts', 'src/old.ts', 'renamed', null],
    ['src/b.ts', null, 'added', '+x'],
    ['src/c.ts', null, 'removed', null],
  ]);
});

test('changed, copied and unknown statuses map to modified; missing counts are 0', async () => {
  queue(json({ files: [
    { filename: 'a', status: 'changed' },
    { filename: 'b', status: 'copied' },
    { filename: 'c', status: 'unchanged' },
    { filename: 'd' },
  ] }));
  const files = await source().listFiles(pr);
  assert.deepEqual(files.map((f) => f.status), ['modified', 'modified', 'modified', 'modified']);
  assert.deepEqual(files.map((f) => [f.additions, f.deletions]), [[0, 0], [0, 0], [0, 0], [0, 0]]);
});

test('files keep the order the API gave', async () => {
  queue(json({ files: [{ filename: 'z', status: 'added' }, { filename: 'a', status: 'added' }, { filename: 'm', status: 'added' }] }));
  assert.deepEqual((await source().listFiles(pr)).map((f) => f.path), ['z', 'a', 'm']);
});

test('300 files is refused, 299 is not', async () => {
  const mk = (n: number) => json({ files: Array.from({ length: n }, (_, i) => ({ filename: `f${i}`, status: 'added' })) });
  queue(mk(300));
  await assert.rejects(source().listFiles(pr), (e: Error) => e.message === 'too_many_files');
  queue(mk(299));
  assert.equal((await source().listFiles(pr)).length, 299);
});

test('content is fetched raw at the commit, with the path encoded', async () => {
  queue(new Response('hello', { status: 200 }));
  const text = await source().getFileContent(pr, 'src/a b/c#.ts', 'head111');
  assert.equal(text, 'hello');
  assert.match(calls[0]!.url, /\/contents\/src\/a%20b\/c%23\.ts\?ref=head111$/);
  assert.equal(calls[0]!.headers.accept, 'application/vnd.github.raw+json');
});

test('the commit id is encoded too; a trailing slash on apiBase is removed', async () => {
  queue(new Response('x', { status: 200 }));
  const odd: PullRequestInfo = { ...pr, ref: { service: 'github', owner: 'acme-co', repo: 'shop.web_2', number: 1 } };
  await source('https://example.test/api/').getFileContent(odd, 'x.ts', 'sha/1');
  assert.equal(calls[0]!.url, 'https://example.test/api/repos/acme-co/shop.web_2/contents/x.ts?ref=sha%2F1');
});

test('an owner or repository name outside the allowed form is refused before any request', async () => {
  const bad: Array<[string, string]> = [['..', 'shop'], ['.', 'shop'], ['acme', '..'], ['a/b', 'shop'], ['acme', 'c d'], ['', 'shop'], ['acme', 'sh%2Fop']];
  for (const [owner, repo] of bad) {
    const odd: PullRequestInfo = { ...pr, ref: { service: 'github', owner, repo, number: 1 } };
    await assert.rejects(source().listFiles(odd), (e: Error) => e.message === 'github_bad_path', `${owner}/${repo}`);
    await assert.rejects(source().getFileContent(odd, 'a.ts', 'head111'), (e: Error) => e.message === 'github_bad_path', `${owner}/${repo}`);
  }
  assert.equal(calls.length, 0);
});

test('a 5xx or a network failure is retried once, for both calls', async () => {
  queue(new Response('', { status: 502 }), json({ files: [] }));
  assert.deepEqual(await source().listFiles(pr), []);
  assert.equal(calls.length, 2);
  queue(new Response('', { status: 502 }), new Response('hello', { status: 200 }));
  assert.equal(await source().getFileContent(pr, 'a.ts', 'head111'), 'hello');
  assert.equal(calls.length, 4);
  queue(new TypeError('fetch failed'), new Response('again', { status: 200 }));
  assert.equal(await source().getFileContent(pr, 'a.ts', 'head111'), 'again');
  assert.equal(calls.length, 6);
});

test('a second 5xx is reported after two requests', async () => {
  queue(new Response('', { status: 502 }), new Response('', { status: 502 }));
  await assert.rejects(source().listFiles(pr), (e: Error) => e.message === 'github_502');
  assert.equal(calls.length, 2);
  queue(new Response('', { status: 503 }), new Response('', { status: 502 }));
  await assert.rejects(source().getFileContent(pr, 'a.ts', 'head111'), (e: Error) => e.message === 'github_502');
  assert.equal(calls.length, 4);
});

test('a 4xx is not retried', async () => {
  queue(new Response('', { status: 403 }), json({ files: [] }));
  await assert.rejects(source().listFiles(pr), (e: Error) => e.message === 'github_403');
  assert.equal(calls.length, 1);
});

test('absent and binary content are null', async () => {
  queue(new Response('nope', { status: 404 }), new Response('ab\0cd', { status: 200 }));
  assert.equal(await source().getFileContent(pr, 'a.ts', 'head111'), null);
  assert.equal(await source().getFileContent(pr, 'b.png', 'head111'), null);
});

test('a NUL byte after the first 8,000 bytes does not make it binary', async () => {
  queue(new Response('a'.repeat(8000) + '\0', { status: 200 }));
  assert.notEqual(await source().getFileContent(pr, 'a.txt', 'head111'), null);
});

test('content over 2,000,000 characters is null; exactly 2,000,000 is returned', async () => {
  queue(new Response('a'.repeat(2_000_001), { status: 200 }), new Response('a'.repeat(2_000_000), { status: 200 }));
  assert.equal(await source().getFileContent(pr, 'big.txt', 'head111'), null);
  assert.equal((await source().getFileContent(pr, 'ok.txt', 'head111'))!.length, 2_000_000);
});

test('a failure names the status and hides the body', async () => {
  queue(new Response('secret detail', { status: 500 }), new Response('secret detail', { status: 500 }));
  await assert.rejects(source().listFiles(pr), (e: Error) => e.message === 'github_500');
  queue(new Response('secret detail', { status: 403 }));
  await assert.rejects(source().getFileContent(pr, 'a.ts', 'head111'), (e: Error) => e.message === 'github_403');
  queue(new Response('gone', { status: 404 }));
  await assert.rejects(source().listFiles(pr), (e: Error) => e.message === 'github_404');
});

test('the token is absent from every error, even when the body echoes it', async () => {
  const token = 'tok-secret-value';
  const s = createGithubReadSource({ token, fetch: stubFetch });
  const echo = () => new Response(`bad credentials: Bearer ${token}`, { status: 401 });
  queue(echo(), echo(), new TypeError(`fetch failed for ${token}`), new TypeError(`fetch failed for ${token}`));
  const attempts = [
    () => s.listFiles(pr),
    () => s.getFileContent(pr, 'a.ts', 'head111'),
    () => s.listFiles(pr),
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt(), (e: Error) => {
      assert.equal(e.message.includes(token), false);
      assert.equal((e.stack ?? '').includes(token), false);
      assert.equal(String(e.cause ?? '').includes(token), false);
      return true;
    });
  }
});

test('a rejected fetch becomes github_network', async () => {
  queue(new TypeError('fetch failed'), new TypeError('fetch failed'));
  await assert.rejects(source().listFiles(pr), (e: Error) => e.message === 'github_network');
  assert.equal(calls.length, 2);
});

test('only GET is ever sent', async () => {
  queue(json({ files: [] }), new Response('x', { status: 200 }), new Response('', { status: 404 }));
  await source().listFiles(pr);
  await source().getFileContent(pr, 'a.ts', 'head111');
  await source().getFileContent(pr, 'b.ts', 'head111');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.method === 'GET'));
});

test('a 200 body that is not JSON gives github_bad_response and leaks nothing', async () => {
  queue(new Response('<html>marker-xyz detail</html>', { status: 200 }));
  await assert.rejects(source().listFiles(pr), (e: Error) => {
    assert.equal(e.message, 'github_bad_response');
    assert.equal(e.message.includes('marker-xyz'), false);
    assert.equal((e.stack ?? '').includes('marker-xyz'), false);
    assert.equal(e.cause, undefined);
    return true;
  });
});

test('a malformed compare response is github_bad_response, never an empty list', async () => {
  const bodies: unknown[] = [
    { files: {} }, {}, null, 5, [], { files: 'x' },
    { files: [null] }, { files: [{ status: 'added' }] }, { files: [{ filename: 3 }] },
  ];
  for (const b of bodies) {
    queue(json(b));
    await assert.rejects(source().listFiles(pr), (e: Error) => e.message === 'github_bad_response' && e.cause === undefined);
  }
});

test('odd content paths are refused before any request', async () => {
  for (const p of ['../../orgs/acme/members', 'src//a.ts', './a.ts', '/a.ts', 'a/./b', 'a/..', '']) {
    await assert.rejects(source().getFileContent(pr, p, 'head111'), (e: Error) => e.message === 'github_bad_path');
  }
  assert.equal(calls.length, 0);
});

test('a status named like an inherited property maps to modified', async () => {
  queue(json({ files: [{ filename: 'a', status: 'constructor' }, { filename: 'b', status: 'toString' }] }));
  assert.deepEqual((await source().listFiles(pr)).map((f) => f.status), ['modified', 'modified']);
});
