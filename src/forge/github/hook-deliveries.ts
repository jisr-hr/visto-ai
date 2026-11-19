import type { HookDeliveries, HookDelivery } from '../types.ts';
import type { AppAuth } from './app-auth.ts';
import { isObject, jsonOf } from './http.ts';

export const MAX_DELIVERY_PAGES = 10;

const nextLinkOf = (header: string | null): string | null => {
  for (const entry of (header ?? '').split(',')) {
    const found = /^\s*<([^>]*)>\s*;.*\brel="?next"?/.exec(entry);
    if (found !== null) return found[1]!;
  }
  return null;
};

function deliveryOf(item: unknown): HookDelivery {
  if (!isObject(item) || typeof item.id !== 'number' || !Number.isInteger(item.id) || typeof item.guid !== 'string'
    || typeof item.delivered_at !== 'string' || typeof item.status_code !== 'number') throw new Error('github_bad_response');
  const time = Date.parse(item.delivered_at);
  if (Number.isNaN(time)) throw new Error('github_bad_response');
  return { id: String(item.id), guid: item.guid, at: new Date(time).toISOString(), ok: item.status_code >= 200 && item.status_code < 400 };
}

export function createGithubHookDeliveries(opts: { auth: AppAuth; fetch: typeof fetch; apiBase?: string }): HookDeliveries {
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const listing = `${apiBase}/app/hook/deliveries?`;

  async function send(method: string, url: string): Promise<Response> {
    try {
      return await opts.fetch(url, {
        method,
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
  }

  async function listSince(since: string): Promise<{ deliveries: HookDelivery[]; complete: boolean }> {
    const from = Date.parse(since);
    const deliveries: HookDelivery[] = [];
    let url: string = `${listing}per_page=100`;
    for (let page = 1; ; page += 1) {
      const res = await send('GET', url);
      if (!res.ok) throw new Error(`github_${res.status}`);
      const body = await jsonOf(res);
      if (!Array.isArray(body)) throw new Error('github_bad_response');
      const items = body.map(deliveryOf);
      deliveries.push(...items.filter((d) => Date.parse(d.at) >= from));
      const last = items[items.length - 1];
      const next = nextLinkOf(res.headers.get('link'));
      if (next === null || (last !== undefined && Date.parse(last.at) < from)) return { deliveries, complete: true };
      if (!next.startsWith(listing) || page >= MAX_DELIVERY_PAGES) return { deliveries, complete: false };
      url = next;
    }
  }

  async function redeliver(id: string): Promise<void> {
    if (!/^[0-9]+$/.test(id)) throw new Error('github_bad_path');
    const res = await send('POST', `${apiBase}/app/hook/deliveries/${id}/attempts`);
    if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) throw new Error('github_rate_limited');
    if (res.status < 200 || res.status >= 300) throw new Error(`github_${res.status}`);
  }

  return { listSince, redeliver };
}
