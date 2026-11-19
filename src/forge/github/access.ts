import type { ForgeAccess, LivePullRequest, PullRequestRef } from '../types.ts';
import type { AppAuth } from './app-auth.ts';
import { createGithubHttp, isObject, jsonOf } from './http.ts';
import { authorOf } from './objects.ts';
import { createGithubReadSource } from './read-source.ts';

const bad = (): Error => new Error('github_bad_response');

function objectAt(v: unknown, key: string): Record<string, unknown> {
  if (!isObject(v) || !isObject(v[key])) throw bad();
  return v[key];
}

function textOf(v: unknown): string {
  if (typeof v !== 'string') throw bad();
  return v;
}

export function createGithubAccess(opts: { auth: AppAuth; fetch: typeof fetch; apiBase?: string }): ForgeAccess {
  const httpFor = async (installation: string) => {
    const token = await opts.auth.installationToken(installation);
    return createGithubHttp({ token, fetch: opts.fetch, ...(opts.apiBase === undefined ? {} : { apiBase: opts.apiBase }) });
  };

  return {
    async readPullRequest(ref: PullRequestRef, installation: string): Promise<LivePullRequest | null> {
      const http = await httpFor(installation);
      const repo = http.repoUrl(ref);
      const res = await http.send('GET', `${repo}/pulls/${ref.number}`, 'application/vnd.github+json');
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`github_${res.status}`);
      const body = await jsonOf(res);
      if (!isObject(body)) throw bad();
      const base = objectAt(body, 'base');
      const head = objectAt(body, 'head');
      const { draft, merged, state } = body;
      if (typeof draft !== 'boolean' || typeof merged !== 'boolean') throw bad();
      if (state !== 'open' && state !== 'closed') throw bad();
      if (body.body !== null && typeof body.body !== 'string') throw bad();
      const baseSha = textOf(base.sha);
      const headSha = textOf(head.sha);
      const info = {
        ref, title: textOf(body.title), description: body.body ?? '', author: authorOf(body.user).author,
        baseBranch: textOf(base.ref), headBranch: textOf(head.ref), baseSha, headSha, draft,
      };
      if (merged || state !== 'open') return { info, state: merged ? 'merged' : 'closed' };
      // The engine reads a file's old side at the merge base, not at the base branch's tip.
      const url = `${repo}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}?per_page=1`;
      const compare = await http.send('GET', url, 'application/vnd.github+json');
      if (!compare.ok) throw new Error(`github_${compare.status}`);
      info.baseSha = textOf(objectAt(await jsonOf(compare), 'merge_base_commit').sha);
      return { info, state: 'open' };
    },

    async sourceFor(installation: string) {
      const token = await opts.auth.installationToken(installation);
      return createGithubReadSource({ token, fetch: opts.fetch, ...(opts.apiBase === undefined ? {} : { apiBase: opts.apiBase }) });
    },
  };
}
