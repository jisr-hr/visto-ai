import type { PullRequestInfo, Source } from '../types.ts';
import { changedFilesOf, createGithubHttp, jsonOf, ReadOnlyViolation } from './http.ts';

export { ReadOnlyViolation };

const MAX_CONTENT_CHARS = 2_000_000;
const BINARY_SCAN_BYTES = 8000;

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

export function createGithubReadSource(opts: { token: string; fetch: typeof fetch; apiBase?: string }): Source {
  const http = createGithubHttp(opts);
  const { send } = http;
  const repoUrl = (pr: PullRequestInfo): string => http.repoUrl(pr.ref);

  async function readText(pr: PullRequestInfo, path: string, query: string): Promise<string | null> {
    if (path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new Error('github_bad_path');
    const res = await send('GET', `${repoUrl(pr)}/contents/${encodePath(path)}${query}`, 'application/vnd.github.raw+json');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`github_${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.subarray(0, BINARY_SCAN_BYTES).includes(0)) return null;
    const text = new TextDecoder().decode(bytes);
    return text.length > MAX_CONTENT_CHARS ? null : text;
  }

  return {
    async listFiles(pr) {
      const url = `${repoUrl(pr)}/compare/${encodeURIComponent(pr.baseSha)}...${encodeURIComponent(pr.headSha)}?per_page=1`;
      const res = await send('GET', url, 'application/vnd.github+json');
      if (!res.ok) throw new Error(`github_${res.status}`);
      return changedFilesOf(await jsonOf(res));
    },

    async getFileContent(pr, path, sha) {
      return readText(pr, path, `?ref=${encodeURIComponent(sha)}`);
    },

    // With no ref, GitHub serves the repository's default branch.
    async getDefaultBranchFile(pr, path) {
      return readText(pr, path, '');
    },
  };
}
