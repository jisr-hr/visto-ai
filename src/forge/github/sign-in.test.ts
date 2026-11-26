import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppAuth } from './app-auth.ts';
import { createGithubSignIn } from './sign-in.ts';

const CLIENT_ID = 'Iv1.0123456789abcdef';
const SECRET = 'client-secret-for-tests-only';
const BACK = 'https://visto.example.test/api/auth/callback';
const VERIFIER = 'v'.repeat(43);
const EXCHANGE = 'POST https://github.com/login/oauth/access_token';
const USER = 'GET https://api.github.com/user';
const auth: AppAuth = { appToken: () => 'jwt', installationToken: async () => 'unused' };
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
const TOKEN = () => json({ access_token: 't-1', token_type: 'bearer', scope: '' });
const PERSON = () => json({ login: 'octo-lead', id: 1, type: 'User' });

interface Seen { method: string; url: string; headers: Record<string, string>; redirect?: string; body?: string }
/** Answers by "<METHOD> <url>"; an unknown one is 404. Records each request. */
function github(routes: Record<string, () => Response>, opts: { webBase?: string; apiBase?: string } = {}) {
  const seen: Seen[] = [];
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const entry: Seen = { method, url: String(url), headers: Object.fromEntries(new Headers(init?.headers)) };
    if (init?.redirect) entry.redirect = init.redirect;
    if (init?.body !== undefined) entry.body = String(init.body);
    seen.push(entry);
    return (routes[`${method} ${String(url)}`] ?? (() => json({ message: 'Not Found' }, 404)))();
  };
  return { seen, signIn: createGithubSignIn({ clientId: CLIENT_ID, clientSecret: SECRET, auth, fetch: stub as typeof fetch, ...opts }) };
}
const down = (): Response => { throw new Error(`down ${SECRET} t-1`); };

test('the authorize address names the client, the way back, the state and the challenge, and lets nobody sign up', () => {
  const { signIn, seen } = github({});
  assert.equal(signIn.authorizeUrl('s-1', 'c-1', BACK),
    'https://github.com/login/oauth/authorize?client_id=Iv1.0123456789abcdef&redirect_uri=https%3A%2F%2Fvisto.example.test%2Fapi%2Fauth%2Fcallback&state=s-1&code_challenge=c-1&code_challenge_method=S256&allow_signup=false');
  assert.equal(github({}, { webBase: 'https://github.example.test//' }).signIn.authorizeUrl('s-1', 'c-1', BACK).split('?')[0], 'https://github.example.test/login/oauth/authorize');
  assert.deepEqual(seen, []);
});

test('a code is exchanged once, with its verifier in form parameters, for a token that reads the account, and the token is not kept', async () => {
  const { signIn, seen } = github({ [EXCHANGE]: TOKEN, [USER]: PERSON });
  const answer = await signIn.signedIn('code-1', VERIFIER, BACK);
  assert.deepEqual(answer, { login: 'octo-lead', isBot: false });
  assert.deepEqual(seen, [
    {
      method: 'POST', url: 'https://github.com/login/oauth/access_token', redirect: 'manual',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'visto-ai' },
      body: `client_id=Iv1.0123456789abcdef&client_secret=client-secret-for-tests-only&code=code-1&redirect_uri=https%3A%2F%2Fvisto.example.test%2Fapi%2Fauth%2Fcallback&code_verifier=${VERIFIER}`,
    },
    {
      method: 'GET', url: 'https://api.github.com/user',
      headers: { authorization: 'Bearer t-1', 'x-github-api-version': '2022-11-28', 'user-agent': 'visto-ai', accept: 'application/vnd.github+json' },
    },
  ]);
  const text = JSON.stringify(answer);
  assert.ok(!text.includes('t-1') && !text.includes(SECRET));
  // a second sign-in exchanges its own code: nothing of the first is kept
  await signIn.signedIn('code-2', VERIFIER, BACK);
  assert.deepEqual(seen.map((s) => [s.method, s.url]), [['POST', 'https://github.com/login/oauth/access_token'], ['GET', 'https://api.github.com/user'],
    ['POST', 'https://github.com/login/oauth/access_token'], ['GET', 'https://api.github.com/user']]);
  assert.ok(seen[2]?.body?.includes('&code=code-2&'));
});

test("GitHub's refusal of a code is oauth_refused, and no account is read", async () => {
  const { signIn, seen } = github({ [EXCHANGE]: () => json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }), [USER]: PERSON });
  await assert.rejects(signIn.signedIn('code-1', VERIFIER, BACK), /^Error: oauth_refused$/);
  assert.equal(seen.length, 1);
});

test('an answer of the wrong shape, a status that is not 200 and a network failure each reject with a short code holding neither the secret nor the token', async () => {
  const cases: Array<[string, Record<string, () => Response>, string, number, string?, string?]> = [
    ['exchange 401', { [EXCHANGE]: () => json({ message: 'Bad credentials' }, 401) }, 'github_401', 1],
    ['exchange 201', { [EXCHANGE]: () => json({ access_token: 't-1' }, 201) }, 'github_201', 1],
    ['exchange redirected', { [EXCHANGE]: () => new Response('', { status: 302, headers: { location: 'https://elsewhere.example.test/' } }) }, 'github_302', 1],
    ['exchange not JSON', { [EXCHANGE]: () => new Response('access_token=t-1&token_type=bearer') }, 'github_bad_response', 1],
    ['exchange a list', { [EXCHANGE]: () => json(['t-1']) }, 'github_bad_response', 1],
    ['exchange no access_token', { [EXCHANGE]: () => json({ token_type: 'bearer' }) }, 'github_bad_response', 1],
    ['exchange an empty access_token', { [EXCHANGE]: () => json({ access_token: '' }) }, 'github_bad_response', 1],
    ['exchange an access_token not text', { [EXCHANGE]: () => json({ access_token: 1 }) }, 'github_bad_response', 1],
    ['exchange fetch throws', { [EXCHANGE]: down }, 'github_network', 1],
    ['/user 401', { [EXCHANGE]: TOKEN, [USER]: () => json({ message: 'Bad credentials' }, 401) }, 'github_401', 2],
    ['/user 500, not retried', { [EXCHANGE]: TOKEN, [USER]: () => json({}, 500) }, 'github_500', 2],
    ['/user fetch throws', { [EXCHANGE]: TOKEN, [USER]: down }, 'github_network', 2],
    ['/user not JSON', { [EXCHANGE]: TOKEN, [USER]: () => new Response('<html>') }, 'github_bad_response', 2],
    ["/user login 'octo lead'", { [EXCHANGE]: TOKEN, [USER]: () => json({ login: 'octo lead', type: 'User' }) }, 'github_bad_response', 2],
    ['/user login too long', { [EXCHANGE]: TOKEN, [USER]: () => json({ login: 'o'.repeat(40), type: 'User' }) }, 'github_bad_response', 2],
    ['/user no type', { [EXCHANGE]: TOKEN, [USER]: () => json({ login: 'octo-lead' }) }, 'github_bad_response', 2],
    ["code 'a b'", { [EXCHANGE]: TOKEN, [USER]: PERSON }, 'oauth_bad_code', 0, 'a b'],
    ['code empty', { [EXCHANGE]: TOKEN, [USER]: PERSON }, 'oauth_bad_code', 0, ''],
    ['code of 101 characters', { [EXCHANGE]: TOKEN, [USER]: PERSON }, 'oauth_bad_code', 0, 'c'.repeat(101)],
    ['verifier of 42 characters', { [EXCHANGE]: TOKEN, [USER]: PERSON }, 'oauth_bad_verifier', 0, 'code-1', 'v'.repeat(42)],
    ['verifier of 129 characters', { [EXCHANGE]: TOKEN, [USER]: PERSON }, 'oauth_bad_verifier', 0, 'code-1', 'v'.repeat(129)],
    ['verifier with a dot', { [EXCHANGE]: TOKEN, [USER]: PERSON }, 'oauth_bad_verifier', 0, 'code-1', `${'v'.repeat(42)}.`],
  ];
  for (const [name, routes, code, calls, given = 'code-1', verifier = VERIFIER] of cases) {
    const { signIn, seen } = github(routes);
    const error = await signIn.signedIn(given, verifier, BACK).then(() => assert.fail(`${name}: no rejection`), (e: unknown) => e);
    assert.ok(error instanceof Error, name);
    assert.equal(error.message, code, name);
    assert.equal(seen.length, calls, name);
    const text = `${error.message} ${String(error.stack)} ${JSON.stringify(error)}`;
    for (const held of [SECRET, 't-1', 'code-1', VERIFIER]) assert.ok(!text.includes(held), `${name}: holds ${held}`);
  }
});

test('an account that is not a person is a bot', async () => {
  for (const [type, isBot] of [['Bot', true], ['Organization', true], ['User', false]] as const) {
    const { signIn } = github({ [EXCHANGE]: TOKEN, [USER]: () => json({ login: 'octo-lead', type }) });
    assert.deepEqual(await signIn.signedIn('code-1', VERIFIER, BACK), { login: 'octo-lead', isBot }, type);
  }
});

test("the installation of an organisation is read with the app's token, and 404 is none", async () => {
  const INSTALLATION = 'GET https://api.github.com/orgs/acme/installation';
  const found = github({ [INSTALLATION]: () => json({ id: 99, account: { login: 'acme' } }) });
  assert.equal(await found.signIn.orgInstallation('acme'), '99');
  assert.deepEqual(found.seen, [{
    method: 'GET', url: 'https://api.github.com/orgs/acme/installation',
    headers: { authorization: 'Bearer jwt', 'x-github-api-version': '2022-11-28', 'user-agent': 'visto-ai', accept: 'application/vnd.github+json' },
  }]);
  assert.equal(await github({}).signIn.orgInstallation('acme'), null);
  const failed = github({ [INSTALLATION]: () => json({}, 500) });
  await assert.rejects(failed.signIn.orgInstallation('acme'), /^Error: github_500$/);
  assert.equal(failed.seen.length, 1);
  await assert.rejects(github({ [INSTALLATION]: down }).signIn.orgInstallation('acme'), /^Error: github_network$/);
  for (const body of [{ id: '99' }, { id: 0 }, { id: -1 }, { id: 1.5 }, {}, [99], 'x']) {
    await assert.rejects(github({ [INSTALLATION]: () => json(body) }).signIn.orgInstallation('acme'), /^Error: github_bad_response$/, JSON.stringify(body));
  }
  await assert.rejects(github({ [INSTALLATION]: () => new Response('{') }).signIn.orgInstallation('acme'), /^Error: github_bad_response$/);
  for (const org of ['a/b', '', 'o'.repeat(40), 'acme?x=1', '..']) {
    const refused = github({});
    await assert.rejects(refused.signIn.orgInstallation(org), /^Error: github_bad_path$/, org);
    assert.equal(refused.seen.length, 0, org);
  }
  const elsewhere = github({ 'GET https://api.github.example.test/orgs/acme/installation': () => json({ id: 7 }) }, { apiBase: 'https://api.github.example.test/' });
  assert.equal(await elsewhere.signIn.orgInstallation('acme'), '7');
});
