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

  // A file at a commit that is binary or too large is null: there is nothing to show. The team's
  // file on the default branch is different: only a 404 means no file, and anything else is
  // returned as text so that the parser can refuse it and every file goes to a person.
  async function readText(pr: PullRequestInfo, path: string, query: string, asText: boolean): Promise<string | null> {
    if (path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new Error('github_bad_path');
    const res = await send('GET', `${repoUrl(pr)}/contents/${encodePath(path)}${query}`, 'application/vnd.github.raw+json');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`github_${res.status}`);
    let body: ArrayBuffer;
    try {
      body = await res.arrayBuffer();
    } catch {
      throw new Error('github_network');                // the body broke while it was read
    }
    const bytes = new Uint8Array(body);
    if (!asText && bytes.subarray(0, BINARY_SCAN_BYTES).includes(0)) return null;
    const text = new TextDecoder().decode(bytes);
    if (text.length <= MAX_CONTENT_CHARS) return text;
    return asText ? text.slice(0, MAX_CONTENT_CHARS) : null;
  }

  return {
    async listFiles(pr) {
      const url = `${repoUrl(pr)}/compare/${encodeURIComponent(pr.baseSha)}...${encodeURIComponent(pr.headSha)}?per_page=1`;
      const res = await send('GET', url, 'application/vnd.github+json');
      if (!res.ok) throw new Error(`github_${res.status}`);
      return changedFilesOf(await jsonOf(res));
    },

    async getFileContent(pr, path, sha) {
      return readText(pr, path, `?ref=${encodeURIComponent(sha)}`, false);
    },

    // With no ref, GitHub serves the repository's default branch.
    async getDefaultBranchFile(pr, path) {
      return readText(pr, path, '', true);
    },
  };
}
