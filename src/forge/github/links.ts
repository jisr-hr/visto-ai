import type { Span } from '../../engine/score/types.ts';
import type { PullRequestInfo } from '../types.ts';

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
