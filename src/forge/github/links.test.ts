import test from 'node:test';
import assert from 'node:assert/strict';
import { githubCommentUrl, githubLineUrl, githubPullRequestUrl, githubReviewUrl } from './links.ts';
import type { PullRequestInfo } from '../types.ts';

const pr: PullRequestInfo = {
  ref: { service: 'github', owner: 'acme', repo: 'shop', number: 1 },
  title: 'T', description: '', author: 'dev-one',
  baseBranch: 'main', headBranch: 'feature', baseSha: 'base000', headSha: 'head111', draft: false,
};

test('github links', () => {
  assert.equal(githubLineUrl(pr, { path: 'src/a b.ts', previousPath: null }, { side: 'RIGHT', first: 40, last: 58 }), 'https://github.com/acme/shop/blob/' + pr.headSha + '/src/a%20b.ts#L40-L58');
  assert.equal(githubLineUrl(pr, { path: 'new/a.ts', previousPath: 'old/a.ts' }, { side: 'LEFT', first: 12, last: 12 }), 'https://github.com/acme/shop/blob/' + pr.baseSha + '/old/a.ts#L12');
});
test('a RIGHT span of a renamed file links the new path at the head', () => {
  assert.equal(githubLineUrl(pr, { path: 'new/a.ts', previousPath: 'old/a.ts' }, { side: 'RIGHT', first: 3, last: 4 }), 'https://github.com/acme/shop/blob/head111/new/a.ts#L3-L4');
});
test('a LEFT span without a previous path uses the path, and each segment is encoded', () => {
  assert.equal(githubLineUrl(pr, { path: 'a#b/c?d.ts', previousPath: null }, { side: 'LEFT', first: 1, last: 2 }), 'https://github.com/acme/shop/blob/base000/a%23b/c%3Fd.ts#L1-L2');
});
test('parentheses in a path are encoded so the markdown link holds', () => {
  assert.equal(githubLineUrl(pr, { path: 'src/a(1).ts', previousPath: null }, { side: 'RIGHT', first: 1, last: 1 }), 'https://github.com/acme/shop/blob/head111/src/a%281%29.ts#L1');
});
test('a comment link names the pull request and the comment, and a comment id that is not digits is refused', () => {
  const ref = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
  assert.equal(githubCommentUrl(ref, '9001'), 'https://github.com/acme/shop/pull/7#discussion_r9001');
  assert.throws(() => githubCommentUrl(ref, '9001/x'), /^Error: github_bad_path$/);
});
test('a review link and a pull request link', () => {
  const ref = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
  assert.equal(githubReviewUrl(ref, '501'), 'https://github.com/acme/shop/pull/7#pullrequestreview-501');
  assert.equal(githubPullRequestUrl(ref), 'https://github.com/acme/shop/pull/7');
  assert.throws(() => githubReviewUrl(ref, '501/x'), /^Error: github_bad_path$/);
});
