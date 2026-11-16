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

const STATUS = new Map<string, FileStatus>([['added', 'added'], ['removed', 'removed'], ['renamed', 'renamed']]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
      let body: unknown;
      try {
        body = JSON.parse(await res.text());
      } catch {
        throw new Error('github_bad_response');
      }
      if (!isObject(body) || !Array.isArray(body.files)) throw new Error('github_bad_response');
      const files: unknown[] = body.files;
      if (!files.every((f) => isObject(f) && typeof f.filename === 'string')) throw new Error('github_bad_response');
      if (files.length >= MAX_LISTED_FILES) throw new Error('too_many_files');
      return (files as CompareFile[]).map((f): ChangedFile => ({
        path: f.filename,
        previousPath: f.previous_filename ?? null,
        status: STATUS.get(f.status ?? '') ?? 'modified',
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        patch: f.patch ?? null,
      }));
    },

    async getFileContent(pr, path, sha) {
      if (path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new Error('github_bad_path');
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
