import type { Span } from '../../engine/score/types.ts';
import type { PullRequestInfo, PullRequestRef } from '../types.ts';

const GITHUB_WEB = 'https://github.com';

const encodePath = (path: string): string => path.split('/').map((segment) => encodeURIComponent(segment).replaceAll('(', '%28').replaceAll(')', '%29')).join('/');

/** A link to the lines of a span: on the head for a RIGHT span, on the base (under the old path) for a LEFT one. */
export function githubLineUrl(pr: PullRequestInfo, file: { path: string; previousPath: string | null }, span: Span): string {
  const left = span.side === 'LEFT';
  const sha = left ? pr.baseSha : pr.headSha;
  const path = left ? (file.previousPath ?? file.path) : file.path;
  const lines = span.first === span.last ? `L${span.first}` : `L${span.first}-L${span.last}`;
  return `${GITHUB_WEB}/${pr.ref.owner}/${pr.ref.repo}/blob/${sha}/${encodePath(path)}#${lines}`;
}

/** A link to one review comment of a pull request. */
export function githubCommentUrl(ref: PullRequestRef, commentId: string): string {
  if (!/^[0-9]+$/.test(commentId)) throw new Error('github_bad_path');
  return `${GITHUB_WEB}/${ref.owner}/${ref.repo}/pull/${ref.number}#discussion_r${commentId}`;
}

/** A link to one review of a pull request. */
export function githubReviewUrl(ref: PullRequestRef, reviewId: string): string {
  if (!/^[0-9]+$/.test(reviewId)) throw new Error('github_bad_path');
  return `${githubPullRequestUrl(ref)}#pullrequestreview-${reviewId}`;
}

/** A link to a pull request. */
export function githubPullRequestUrl(ref: PullRequestRef): string {
  return `${GITHUB_WEB}/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}
