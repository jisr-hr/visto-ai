import type { CheckWrite, ForgeChecks, OwnCheck, PullRequestRef } from '../types.ts';
import type { AppAuth } from './app-auth.ts';
import { createGithubHttp, isObject, jsonOf } from './http.ts';

export const MAX_CHECK_PAGES = 10;
export const MAX_TITLE_CHARS = 255;
export const MAX_SUMMARY_CHARS = 60_000;

const PAGE_SIZE = 100;
const JSON_ACCEPT = 'application/vnd.github+json';
const STATUSES = new Set<string>(['queued', 'in_progress', 'completed']);

const bad = (): Error => new Error('github_bad_response');
const badPath = (): Error => new Error('github_bad_path');
const wholeNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function digits(value: string): string {
  if (!/^[0-9]+$/.test(value)) throw badPath();
  return value;
}
function commitOf(value: string): string {
  if (!/^[A-Za-z0-9]{1,64}$/.test(value)) throw badPath();
  return value;
}
const namePart = (value: string): boolean => /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..';
const cut = (text: string, max: number): string => text.slice(0, max).toWellFormed();
const textOr = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

export function createGithubChecks(opts: { auth: AppAuth; appId: string; fetch: typeof fetch; apiBase?: string; webBase?: string }): ForgeChecks {
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const webBase = (opts.webBase ?? 'https://github.com').replace(/\/+$/, '');

  // The repository's name is checked before a token is asked for.
  const probe = createGithubHttp({ token: '', fetch: opts.fetch, apiBase });
  async function httpFor(installation: string, ref?: PullRequestRef) {
    if (ref !== undefined) probe.repoUrl(ref);
    const token = await opts.auth.installationToken(installation);
    return { token, http: createGithubHttp({ token, fetch: opts.fetch, apiBase }) };
  }

  // The only place a write is sent. Once, whatever came back; a redirect is not followed.
  async function write(method: 'POST' | 'PATCH', token: string, url: string, body: unknown): Promise<Response> {
    try {
      return await opts.fetch(url, {
        method,
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'visto-ai',
          Accept: JSON_ACCEPT,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('github_network');
    }
  }

  async function getJson(http: ReturnType<typeof createGithubHttp>, url: string): Promise<unknown> {
    const res = await http.send('GET', url, JSON_ACCEPT);
    if (!res.ok) throw new Error(`github_${res.status}`);
    return jsonOf(res);
  }

  return {
    async findCheck(ref: PullRequestRef, installation: string, commit: string, name: string): Promise<OwnCheck | null> {
      digits(installation);
      const appId = digits(opts.appId);
      commitOf(commit);
      const { http } = await httpFor(installation, ref);
      const url = `${http.repoUrl(ref)}/commits/${commit}/check-runs?check_name=${encodeURIComponent(name)}&app_id=${appId}&per_page=100`;
      const body = await getJson(http, url);
      if (!isObject(body) || !Array.isArray(body.check_runs)) throw bad();
      let newest: Record<string, unknown> | null = null;
      for (const item of body.check_runs as unknown[]) {
        if (!isObject(item)) throw bad();
        if (item.name !== name || !isObject(item.app) || String(item.app.id) !== appId) continue;
        if (!wholeNumber(item.id)) throw bad();
        if (newest === null || item.id > (newest.id as number)) newest = item;
      }
      if (newest === null) return null;
      const status = newest.status;
      if (typeof status !== 'string' || !STATUSES.has(status)) throw bad();
      const output = isObject(newest.output) ? newest.output : {};
      return {
        id: String(newest.id),
        status: status as OwnCheck['status'],
        conclusion: typeof newest.conclusion === 'string' ? newest.conclusion : null,
        title: textOr(output.title, ''),
        summary: textOr(output.summary, ''),
      };
    },

    async writeCheck(ref: PullRequestRef, installation: string, check: CheckWrite): Promise<{ id: string }> {
      if ((check.status === 'completed') !== (check.conclusion !== null)) throw new Error('bad_check');
      digits(installation);
      commitOf(check.commit);
      if (check.id !== null) digits(check.id);
      const { token, http } = await httpFor(installation, ref);
      const repo = http.repoUrl(ref);
      const body: Record<string, unknown> = {
        name: check.name,
        ...(check.id === null ? { head_sha: check.commit } : {}),
        status: check.status,
        output: { title: cut(check.title, MAX_TITLE_CHARS), summary: cut(check.summary, MAX_SUMMARY_CHARS) },
        external_id: String(ref.number),
        details_url: `${webBase}/${ref.owner}/${ref.repo}/pull/${ref.number}`,
        ...(check.conclusion === null ? {} : { conclusion: check.conclusion }),
      };
      const res = check.id === null
        ? await write('POST', token, `${repo}/check-runs`, body)
        : await write('PATCH', token, `${repo}/check-runs/${check.id}`, body);
      if (!res.ok) throw new Error(`github_${res.status}`);
      const answer = await jsonOf(res);
      if (!isObject(answer) || !wholeNumber(answer.id)) throw bad();
      if (check.id !== null && String(answer.id) !== check.id) throw bad();
      if (answer.status !== check.status) throw new Error('check_not_rewritten');
      return { id: String(answer.id) };
    },

    async greenChecks(ref: PullRequestRef, installation: string, commit: string, names: string[]): Promise<string[]> {
      digits(installation);
      commitOf(commit);
      if (names.length === 0) return [];
      const { http } = await httpFor(installation, ref);
      const repo = http.repoUrl(ref);

      const statusBody = await getJson(http, `${repo}/commits/${commit}/status?per_page=100`);
      if (!isObject(statusBody) || !Array.isArray(statusBody.statuses)) throw bad();
      // Only the first page is read: a list cut short could hide a failing status, so it is never accepted.
      if (typeof statusBody.total_count !== 'number' || statusBody.total_count > statusBody.statuses.length) throw bad();
      const states = new Map<string, string>();
      for (const item of statusBody.statuses as unknown[]) {
        if (!isObject(item) || typeof item.context !== 'string' || typeof item.state !== 'string') throw bad();
        states.set(item.context, item.state);
      }

      // The newest run (highest id) of each name.
      const runs = new Map<string, { id: number; green: boolean }>();
      for (let page = 1; ; page += 1) {
        const body = await getJson(http, `${repo}/commits/${commit}/check-runs?per_page=${PAGE_SIZE}&page=${page}`);
        if (!isObject(body) || !Array.isArray(body.check_runs)) throw bad();
        for (const item of body.check_runs as unknown[]) {
          if (!isObject(item) || typeof item.name !== 'string' || !wholeNumber(item.id)) throw bad();
          const known = runs.get(item.name);
          if (known === undefined || item.id > known.id) {
            runs.set(item.name, { id: item.id, green: item.status === 'completed' && item.conclusion === 'success' });
          }
        }
        if (body.check_runs.length < PAGE_SIZE) break;
        if (page >= MAX_CHECK_PAGES) throw new Error('github_too_many_pages');
      }

      return names.filter((name) => {
        const state = states.get(name);
        const run = runs.get(name);
        if (state === undefined && run === undefined) return false;
        return (state === undefined || state === 'success') && (run === undefined || run.green);
      });
    },

    async isTeamMember(installation: string, team: string, login: string): Promise<boolean> {
      digits(installation);
      const parts = team.split('/');
      if (parts.length !== 2 || !namePart(parts[0]!) || !namePart(parts[1]!)) throw badPath();
      if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw badPath();
      const { http } = await httpFor(installation);
      const res = await http.send('GET', `${apiBase}/orgs/${parts[0]}/teams/${parts[1]}/memberships/${login}`, JSON_ACCEPT);
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`github_${res.status}`);
      const body = await jsonOf(res);
      if (!isObject(body)) throw bad();
      return body.state === 'active';
    },
  };
}
