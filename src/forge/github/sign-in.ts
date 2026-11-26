import type { ForgeSignIn, SignedIn } from '../types.ts';
import type { AppAuth } from './app-auth.ts';
import { isObject, jsonOf } from './http.ts';

const CODE = /^[A-Za-z0-9_-]{1,100}$/;
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

const bad = (): Error => new Error('github_bad_response');

// Sign-in through the app's own user authorization, with PKCE. No call is retried, and no error says more than its short code:
// the client secret, the code, the verifier and the user's token never leave this file but in GitHub's own requests.
export function createGithubSignIn(opts: { clientId: string; clientSecret: string; auth: AppAuth; fetch: typeof fetch; webBase?: string; apiBase?: string }): ForgeSignIn {
  const webBase = (opts.webBase ?? 'https://github.com').replace(/\/+$/, '');
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');

  // Sent once; a failure to reach GitHub says only that.
  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await opts.fetch(url, init);
    } catch {
      throw new Error('github_network');
    }
  }
  const apiHeaders = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'visto-ai',
    Accept: 'application/vnd.github+json',
  });

  // The code is exchanged once for a user token; a redirect is not followed.
  async function exchange(code: string, verifier: string, redirectUri: string): Promise<string> {
    const form = new URLSearchParams([
      ['client_id', opts.clientId],
      ['client_secret', opts.clientSecret],
      ['code', code],
      ['redirect_uri', redirectUri],
      ['code_verifier', verifier],
    ]);
    const res = await send(`${webBase}/login/oauth/access_token`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'visto-ai' },
      body: form.toString(),
    });
    if (res.status !== 200) throw new Error(`github_${res.status}`);
    const body = await jsonOf(res);
    if (!isObject(body)) throw bad();
    if (typeof body.error === 'string') throw new Error('oauth_refused');
    if (typeof body.access_token !== 'string' || body.access_token === '') throw bad();
    return body.access_token;
  }

  return {
    authorizeUrl(state: string, challenge: string, redirectUri: string): string {
      const query = new URLSearchParams([
        ['client_id', opts.clientId],
        ['redirect_uri', redirectUri],
        ['state', state],
        ['code_challenge', challenge],
        ['code_challenge_method', 'S256'],
        ['allow_signup', 'false'],
      ]);
      return `${webBase}/login/oauth/authorize?${query.toString()}`;
    },

    // The token reads the account once and is dropped with this call.
    async signedIn(code: string, verifier: string, redirectUri: string): Promise<SignedIn> {
      if (!CODE.test(code)) throw new Error('oauth_bad_code');
      if (!VERIFIER.test(verifier)) throw new Error('oauth_bad_verifier');
      const token = await exchange(code, verifier, redirectUri);
      const res = await send(`${apiBase}/user`, { method: 'GET', headers: apiHeaders(token) });
      if (!res.ok) throw new Error(`github_${res.status}`);
      const body = await jsonOf(res);
      if (!isObject(body) || typeof body.login !== 'string' || !LOGIN.test(body.login) || typeof body.type !== 'string') throw bad();
      return { login: body.login, isBot: body.type !== 'User' };
    },

    async orgInstallation(org: string): Promise<string | null> {
      if (!LOGIN.test(org)) throw new Error('github_bad_path');
      const res = await send(`${apiBase}/orgs/${org}/installation`, { method: 'GET', headers: apiHeaders(opts.auth.appToken()) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`github_${res.status}`);
      const body = await jsonOf(res);
      if (!isObject(body) || typeof body.id !== 'number' || !Number.isSafeInteger(body.id) || body.id <= 0) throw bad();
      return String(body.id);
    },
  };
}
