import type { ChangedFile, FileStatus, RepoRef } from '../types.ts';

export class ReadOnlyViolation extends Error {}

interface CompareFile {
  filename: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

export const MAX_LISTED_FILES = 300;
const PAGE_SIZE = 100;

const STATUS = new Map<string, FileStatus>([['added', 'added'], ['removed', 'removed'], ['renamed', 'renamed']]);

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const NAME = /^[A-Za-z0-9_.-]+$/;
const isName = (name: string): boolean => NAME.test(name) && name !== '.' && name !== '..';

/** The files of a compare response; 300 or more means GitHub may have cut the list. */
export function changedFilesOf(body: unknown): ChangedFile[] {
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
}

export async function jsonOf(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text());
  } catch {
    throw new Error('github_bad_response');
  }
}

export function createGithubHttp(opts: { token: string; fetch: typeof fetch; apiBase?: string }) {
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');

  // The only place a request is sent. Anything but GET is refused.
  // A 5xx status or a network failure is retried once, immediately.
  async function send(method: string, url: string, accept: string): Promise<Response> {
    if (method !== 'GET') throw new ReadOnlyViolation('read_only');
    for (let attempt = 0; ; attempt += 1) {
      const last = attempt === 1;
      let res: Response;
      try {
        res = await opts.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${opts.token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'visto-ai',
            Accept: accept,
          },
        });
      } catch {
        if (last) throw new Error('github_network');
        continue;
      }
      if (res.status < 500 || last) return res;
    }
  }

  const repoUrl = (ref: RepoRef): string => {
    if (!isName(ref.owner) || !isName(ref.repo)) throw new Error('github_bad_path');
    return `${apiBase}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  };

  // Yields one page of items at a time, so a caller can stop early. It throws
  // once page `maxPages` is full, because more may follow that it would not read.
  async function* pages(url: string, maxPages: number): AsyncGenerator<unknown[]> {
    const joiner = url.includes('?') ? '&' : '?';
    for (let page = 1; ; page += 1) {
      const res = await send('GET', `${url}${joiner}per_page=${PAGE_SIZE}&page=${page}`, 'application/vnd.github+json');
      if (!res.ok) throw new Error(`github_${res.status}`);
      const body = await jsonOf(res);
      if (!Array.isArray(body)) throw new Error('github_bad_response');
      yield body;
      if (body.length < PAGE_SIZE) return;
      if (page >= maxPages) throw new Error('github_too_many_pages');
    }
  }

  async function paged(url: string, maxPages: number): Promise<unknown[]> {
    const all: unknown[] = [];
    for await (const items of pages(url, maxPages)) all.push(...items);
    return all;
  }

  return { send, repoUrl, pages, paged };
}
