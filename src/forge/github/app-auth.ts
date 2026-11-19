import { createPrivateKey, createSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { isObject, jsonOf } from './http.ts';

export interface AppAuth {
  /** A token signed as the app, for the app's own endpoints. */
  appToken(): string;
  /** A token for one installation: the cached one while it has 10 minutes or more left, else a new one. */
  installationToken(installation: string): Promise<string>;
}

const MINUTE_MS = 60_000;
const REUSE_MARGIN_MS = 10 * MINUTE_MS;
const DEFAULT_LIFETIME_MS = 60 * MINUTE_MS;

const b64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

export function createAppAuth(opts: { appId: string; privateKey: string; fetch: typeof fetch; clock: () => Date; apiBase?: string }): AppAuth {
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  let key: KeyObject;
  try {
    key = createPrivateKey(opts.privateKey);
  } catch {
    throw new Error('bad_private_key');
  }

  function appToken(): string {
    const now = Math.floor(opts.clock().getTime() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: opts.appId }));
    const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key);
    return `${head}.${body}.${b64url(signature)}`;
  }

  // A 5xx status or a network failure is retried once, immediately.
  async function post(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const last = attempt === 1;
      let res: Response;
      try {
        res = await opts.fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${appToken()}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'visto-ai',
            Accept: 'application/vnd.github+json',
          },
        });
      } catch {
        if (last) throw new Error('github_network');
        continue;
      }
      if (res.status < 500 || last) return res;
    }
  }

  const cache = new Map<string, { token: string; expiresAt: number }>();
  const minting = new Map<string, Promise<string>>();

  async function mint(installation: string): Promise<string> {
    const res = await post(`${apiBase}/app/installations/${installation}/access_tokens`);
    if (!res.ok) throw new Error(`github_${res.status}`);
    const body = await jsonOf(res);
    if (!isObject(body) || typeof body.token !== 'string' || body.token === '') throw new Error('github_bad_response');
    const stated = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN;
    const expiresAt = Number.isNaN(stated) ? opts.clock().getTime() + DEFAULT_LIFETIME_MS : stated;
    cache.set(installation, { token: body.token, expiresAt });
    return body.token;
  }

  function installationToken(installation: string): Promise<string> {
    if (!/^[0-9]+$/.test(installation)) return Promise.reject(new Error('github_bad_path'));
    const cached = cache.get(installation);
    if (cached !== undefined && cached.expiresAt - opts.clock().getTime() >= REUSE_MARGIN_MS) return Promise.resolve(cached.token);
    const running = minting.get(installation);
    if (running !== undefined) return running;
    const started = mint(installation).finally(() => minting.delete(installation));
    minting.set(installation, started);
    return started;
  }

  return { appToken, installationToken };
}
