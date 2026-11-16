import type { ChangedFile, FileStatus, PullRequestInfo, Source } from '../types.ts';

export class ReadOnlyViolation extends Error {}

interface CompareFile {
  filename: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

const MAX_LISTED_FILES = 300;
const MAX_CONTENT_CHARS = 2_000_000;
const BINARY_SCAN_BYTES = 8000;

const STATUS: Record<string, FileStatus> = { added: 'added', removed: 'removed', renamed: 'renamed' };

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

export function createGithubReadSource(opts: { token: string; fetch: typeof fetch; apiBase?: string }): Source {
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');

  // The only place a request is sent. Anything but GET is refused.
  async function send(method: string, url: string, accept: string): Promise<Response> {
    if (method !== 'GET') throw new ReadOnlyViolation('read_only');
    try {
      return await opts.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ai-score-reviewer',
          Accept: accept,
        },
      });
    } catch {
      throw new Error('github_network');
    }
  }

  const repoUrl = (pr: PullRequestInfo): string =>
    `${apiBase}/repos/${encodeURIComponent(pr.ref.owner)}/${encodeURIComponent(pr.ref.repo)}`;

  return {
    async listFiles(pr) {
      const url = `${repoUrl(pr)}/compare/${encodeURIComponent(pr.baseSha)}...${encodeURIComponent(pr.headSha)}?per_page=1`;
      const res = await send('GET', url, 'application/vnd.github+json');
      if (!res.ok) throw new Error(`github_${res.status}`);
      const body = (await res.json()) as { files?: CompareFile[] };
      const files = body.files ?? [];
      if (files.length >= MAX_LISTED_FILES) throw new Error('too_many_files');
      return files.map((f): ChangedFile => ({
        path: f.filename,
        previousPath: f.previous_filename ?? null,
        status: STATUS[f.status ?? ''] ?? 'modified',
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        patch: f.patch ?? null,
      }));
    },

    async getFileContent(pr, path, sha) {
      const url = `${repoUrl(pr)}/contents/${encodePath(path)}?ref=${encodeURIComponent(sha)}`;
      const res = await send('GET', url, 'application/vnd.github.raw+json');
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`github_${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.subarray(0, BINARY_SCAN_BYTES).includes(0)) return null;
      const text = new TextDecoder().decode(bytes);
      return text.length > MAX_CONTENT_CHARS ? null : text;
    },
  };
}
