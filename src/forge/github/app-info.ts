import type { AppIdentity, AppInfo, FeatureOff, GateNeeds } from '../types.ts';
import type { AppAuth } from './app-auth.ts';
import { isObject, jsonOf } from './http.ts';

const READ = new Set(['read', 'write', 'admin']);
const WRITE = new Set(['write', 'admin']);

/** What the app lacks, one entry for each permission or event a feature needs and the app has not got. */
export function missingFor(info: AppInfo, dryRun: boolean, gate?: GateNeeds): FeatureOff[] {
  const missing: FeatureOff[] = [];
  const need = (feature: FeatureOff['feature'], permission: string, level: 'read' | 'write'): void => {
    if (!(level === 'read' ? READ : WRITE).has(info.permissions[permission] ?? '')) missing.push({ feature, missing: `${permission}:${level}` });
  };
  const subscribe = (feature: FeatureOff['feature'], event: string): void => {
    if (!info.events.includes(event)) missing.push({ feature, missing: `event:${event}` });
  };
  need('reviews', 'pull_requests', 'read');
  need('reviews', 'contents', 'read');
  subscribe('reviews', 'pull_request');
  if (!dryRun) need('publishing', 'pull_requests', 'write');
  if (!dryRun) need('resolving', 'contents', 'write');
  if (!dryRun) need('commands', 'issues', 'write');
  subscribe('commands', 'issue_comment');
  for (const event of ['pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread', 'issue_comment']) subscribe('capture', event);
  if (!dryRun && gate !== undefined) {
    if (gate.check) {
      need('gate', 'checks', 'write');
      subscribe('gate', 'check_run');
    }
    if (gate.statuses) need('gate', 'statuses', 'read');
    if (gate.members) need('gate', 'members', 'read');
  }
  return missing;
}

export function createAppInfo(opts: { auth: AppAuth; fetch: typeof fetch; apiBase?: string }): AppIdentity {
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  let kept: AppInfo | undefined;
  let running: Promise<AppInfo> | undefined;

  async function fetchInfo(): Promise<AppInfo> {
    let res: Response;
    try {
      res = await opts.fetch(`${apiBase}/app`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${opts.auth.appToken()}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'visto-ai',
          Accept: 'application/vnd.github+json',
        },
      });
    } catch {
      throw new Error('github_network');
    }
    if (!res.ok) throw new Error(`github_${res.status}`);
    const body = await jsonOf(res);
    if (!isObject(body) || typeof body.slug !== 'string' || body.slug === '' || !isObject(body.permissions)
      || !Array.isArray(body.events) || !body.events.every((e) => typeof e === 'string')) throw new Error('github_bad_response');
    const permissions: Record<string, string> = {};
    for (const [name, level] of Object.entries(body.permissions)) {
      if (typeof level !== 'string') throw new Error('github_bad_response');
      permissions[name] = level;
    }
    return { botLogin: `${body.slug}[bot]`, permissions, events: body.events as string[] };
  }

  function read(): Promise<AppInfo> {
    if (kept !== undefined) return Promise.resolve(kept);
    if (running !== undefined) return running;
    const started = fetchInfo().then((info) => (kept = info)).finally(() => { running = undefined; });
    running = started;
    return started;
  }

  return {
    read,
    lacks: async (dryRun, gate) => missingFor(await read(), dryRun, gate),
    canResolve: async () => WRITE.has((await read()).permissions.contents ?? ''),
  };
}
