import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import manifest from './app-manifest.json' with { type: 'json' };
import { convert as exchange, envLines, fillFile, formPage, manifestFor, releaseFile, reserveFile, run } from './create-app.ts';
import type { Io } from './create-app.ts';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB\n-----END RSA PRIVATE KEY-----\n';
const PEM_ONE_LINE = '-----BEGIN RSA PRIVATE KEY-----\\nAAAA\\nBBBB\\n-----END RSA PRIVATE KEY-----\\n';
const SECRET = 'hook-secret-value';
const CLIENT_SECRET = 'client-secret-value';
const CODE = 'abc';
const RANDOMS = ['0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210'];
const NAME = 'Visto AI Acme';
const ARGS = ['--webhook-url', 'https://reviews.example.test/webhooks/github', '--out', '/keys/visto.env', '--name', NAME];
/** The second try's wait, which no test really waits. */
const noWait = async (): Promise<void> => {};
/** The exchange with no real wait before its second try. */
const convert = (code: string, deps: { fetch: typeof fetch; apiBase?: string }) => exchange(code, { sleep: noWait, ...deps });

const appBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 123, slug: 'visto-ai-acme', name: 'Visto AI Acme', owner: { login: 'acme' }, html_url: 'https://github.com/apps/visto-ai-acme',
  pem: PEM, webhook_secret: SECRET, client_secret: CLIENT_SECRET, ...over,
});
const answer = (status: number, body: unknown = appBody()): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

const decodeAttr = (s: string): string => s.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
const actionOf = (page: string): string => decodeAttr(/action="([^"]*)"/.exec(page)?.[1] ?? '');
const fieldOf = (page: string): unknown => JSON.parse(decodeAttr(/name="manifest" value="([^"]*)"/.exec(page)?.[1] ?? 'null'));

function stubFetch(answers: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = answers.shift();
    if (next === undefined) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

type Answer = { status: number; headers: Record<string, string>; body: string; exit: number | null };
type Handler = (request: { method: string; url: string; host: string }) => Promise<Answer>;

const FD = 7;

function world(opts: { reserve?: boolean; answers?: Array<Response | Error>; fetch?: typeof fetch } = {}) {
  const lines: string[] = [];
  const stub = stubFetch(opts.answers ?? [answer(201)]);
  if (opts.fetch !== undefined) stub.fetch = opts.fetch;
  const calls = { reserve: [] as string[], fill: [] as Array<[string, string]>, release: [] as string[], listen: 0, close: 0, sleep: [] as number[], fds: [] as Array<number | null> };
  /** The path each descriptor the fake reserved was opened for. */
  const opened = new Map<number, string>();
  let handler: Handler | undefined;
  let stop: (() => void) | undefined;
  let r = 0;
  const io: Io = {
    out: (line) => { lines.push(line); },
    fetch: stub.fetch,
    random: () => RANDOMS[r++ % 2] ?? '',
    reserve: (p) => { calls.reserve.push(p); if (opts.reserve === false) return null; opened.set(FD, p); return FD; },
    fill: (fd, text) => { calls.fds.push(fd); calls.fill.push([opened.get(fd) ?? '?', text]); },
    release: (fd, p) => { calls.fds.push(fd); calls.release.push(p); },
    sleep: async (ms) => { calls.sleep.push(ms); },
    listen: async (h) => { calls.listen += 1; handler = h; return { port: 4010, close: async () => { calls.close += 1; } }; },
    onStop: (h) => { stop = h; },
  };
  return { io, lines, calls, fetchCalls: stub.calls, handler: () => handler, stop: () => { if (stop === undefined) throw new Error('no stop handler'); stop(); } };
}

const ADDRESS = /http:\/\/127\.0\.0\.1:4010\/([0-9a-f]{32})/;

/** Starts the command and waits until it has printed its address. */
async function start(argv: string[], w: ReturnType<typeof world>) {
  let ended: number | undefined;
  const running = run(argv, w.io).then((code) => { ended = code; return code; });
  for (let i = 0; i < 100 && ended === undefined && !w.lines.some((l) => ADDRESS.test(l)); i += 1) await new Promise(setImmediate);
  const token = w.lines.map((l) => ADDRESS.exec(l)?.[1]).find((t) => t !== undefined) ?? '';
  const ask = (method: string, url: string, host = '127.0.0.1:4010'): Promise<Answer> => {
    const h = w.handler();
    if (h === undefined) throw new Error('not listening');
    return h({ method, url, host });
  };
  const page = token === '' ? '' : (await ask('GET', `/${token}`)).body;
  const state = page === '' ? '' : (new URL(actionOf(page)).searchParams.get('state') ?? '');
  const settle = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await new Promise(setImmediate); };
  return { running, token, state, page, ask, settle, ended: () => ended };
}

const visible = (lines: string[]): string => lines.join('\n');

test('the manifest carries the webhook address and the way back', () => {
  const m = manifestFor('https://reviews.example.test/webhooks/github', 'http://127.0.0.1:4010/created', NAME);
  assert.deepEqual(m.hook_attributes, { url: 'https://reviews.example.test/webhooks/github', active: true });
  assert.equal(m.redirect_url, 'http://127.0.0.1:4010/created');
  assert.deepEqual([m.name, m.url, m.description, m.public], [NAME, manifest.url, manifest.description, false]);
  assert.equal(manifest.name, 'visto-ai');
  assert.deepEqual(m.default_permissions, manifest.default_permissions);
  assert.deepEqual(m.default_events, manifest.default_events);
  assert.equal(manifest.hook_attributes.url, 'https://example.invalid/webhooks/github');
  assert.equal('redirect_url' in manifest, false);
});

test('the page posts the manifest to the account', () => {
  const m = manifestFor('https://reviews.example.test/webhooks/github', 'http://127.0.0.1:4010/created', NAME);
  const page = formPage(m, { org: null, state: RANDOMS[0] ?? '' });
  assert.equal(actionOf(page), `https://github.com/settings/apps/new?state=${RANDOMS[0]}`);
  assert.match(page, /<form method="post" action="/);
  assert.equal(page.match(/<form/g)?.length, 1);
  assert.equal(page.match(/<input/g)?.length, 1);
  assert.match(page, /<input type="hidden" name="manifest" value="/);
  assert.equal(page.match(/<button/g)?.length, 1);
  assert.deepEqual(fieldOf(page), m);
});

test('the page posts the manifest to the organisation', () => {
  const m = manifestFor('https://reviews.example.test/webhooks/github', 'http://127.0.0.1:4010/created', NAME);
  const page = formPage(m, { org: 'acme', state: RANDOMS[0] ?? '' });
  assert.equal(actionOf(page), `https://github.com/organizations/acme/settings/apps/new?state=${RANDOMS[0]}`);
  assert.deepEqual(fieldOf(page), m);
});

test('the manifest in the page is escaped for an attribute', () => {
  const m = { ...manifestFor('https://reviews.example.test/webhooks/github', 'http://127.0.0.1:4010/created', NAME), description: 'Says "hi" <b>&</b>' };
  const page = formPage(m, { org: null, state: RANDOMS[0] ?? '' });
  const raw = /name="manifest" value="([^"]*)"/.exec(page)?.[1] ?? '';
  assert.ok(!raw.includes('<') && !raw.includes('>') && !raw.includes('"'));
  assert.ok(raw.includes('&quot;') && raw.includes('&lt;') && raw.includes('&gt;') && raw.includes('&amp;'));
  assert.deepEqual(fieldOf(page), m);
});

test('the page has no script', () => {
  const m = manifestFor('https://reviews.example.test/webhooks/github', 'http://127.0.0.1:4010/created', NAME);
  assert.ok(!/<script/i.test(formPage(m, { org: 'acme', state: RANDOMS[0] ?? '' })));
});

test('the code is exchanged for the app', async () => {
  const stub = stubFetch([answer(201)]);
  const app = await convert(CODE, { fetch: stub.fetch, apiBase: 'https://api.example.test' });
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.url, `https://api.example.test/app-manifests/${CODE}/conversions`);
  assert.equal(stub.calls[0]?.init?.method, 'POST');
  const headers = stub.calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.Accept, 'application/vnd.github+json');
  assert.equal(headers['User-Agent'], 'visto-ai');
  assert.ok(!Object.keys(headers).some((k) => k.toLowerCase() === 'authorization'));
  assert.deepEqual(app, { id: 123, slug: 'visto-ai-acme', name: 'Visto AI Acme', owner: 'acme', htmlUrl: 'https://github.com/apps/visto-ai-acme', pem: PEM, webhookSecret: SECRET });
});

test('the exchange goes to GitHub when no other address is given', async () => {
  const stub = stubFetch([answer(201)]);
  await convert(CODE, { fetch: stub.fetch });
  assert.equal(stub.calls[0]?.url, `https://api.github.com/app-manifests/${CODE}/conversions`);
});

test('an answer without a key is refused as a bad response', async () => {
  for (const body of [appBody({ pem: undefined }), appBody({ pem: 'not a key' })]) {
    await assert.rejects(convert(CODE, { fetch: stubFetch([answer(201, body)]).fetch }), { message: 'github_bad_response' });
  }
});

test('an answer that is not JSON is refused as a bad response', async () => {
  await assert.rejects(convert(CODE, { fetch: stubFetch([answer(201, 'not json')]).fetch }), { message: 'github_bad_response' });
});

test('an answer missing what names the app is refused as a bad response', async () => {
  for (const over of [{ id: 1.5 }, { id: '123' }, { slug: '' }, { name: undefined }, { owner: {} }, { html_url: undefined }]) {
    await assert.rejects(convert(CODE, { fetch: stubFetch([answer(201, appBody(over))]).fetch }), { message: 'github_bad_response' }, JSON.stringify(over));
  }
});

test('an answer that is not a success is refused by its status, with one call', async () => {
  const stub = stubFetch([answer(422, { message: 'nope' })]);
  await assert.rejects(convert(CODE, { fetch: stub.fetch }), { message: 'github_422' });
  assert.equal(stub.calls.length, 1);
});

test('a failed network call is tried once more', async () => {
  const stub = stubFetch([new Error('down'), answer(201)]);
  assert.equal((await convert(CODE, { fetch: stub.fetch })).id, 123);
  assert.equal(stub.calls.length, 2);
});

test('a server error is tried once more', async () => {
  const stub = stubFetch([answer(502, 'bad gateway'), answer(201)]);
  assert.equal((await convert(CODE, { fetch: stub.fetch })).id, 123);
  assert.equal(stub.calls.length, 2);
});

test('two server errors are refused by their status after two calls', async () => {
  const stub = stubFetch([answer(502, 'bad gateway'), answer(502, 'bad gateway')]);
  await assert.rejects(convert(CODE, { fetch: stub.fetch }), { message: 'github_502' });
  assert.equal(stub.calls.length, 2);
});

test('two failed network calls are github_network, and the error holds nothing of the address', async () => {
  const code = 'secret-code-123';
  const stub = stubFetch([new Error(`failed https://api.github.com/app-manifests/${code}/conversions`), new Error(`failed ${code}`)]);
  const error = await convert(code, { fetch: stub.fetch }).then(() => undefined, (e: unknown) => e as Error);
  assert.equal(error?.message, 'github_network');
  assert.equal(error?.cause, undefined);
  assert.ok(!String(error?.stack).includes(code));
  assert.equal(stub.calls.length, 2);
});

test('the secrets file holds the key on one line and the secret', () => {
  assert.deepEqual(envLines({ pem: PEM, webhookSecret: SECRET }).split('\n'), [`APP_PRIVATE_KEY=${PEM_ONE_LINE}`, `WEBHOOK_SECRET=${SECRET}`, '']);
});

test('a key with CRLF line breaks is written on one line too', () => {
  assert.equal(envLines({ pem: PEM.replaceAll('\n', '\r\n'), webhookSecret: null }), `APP_PRIVATE_KEY=${PEM_ONE_LINE}\n`);
});

test('with no secret the file holds the key alone', () => {
  assert.equal(envLines({ pem: PEM, webhookSecret: null }), `APP_PRIVATE_KEY=${PEM_ONE_LINE}\n`);
});

test('a reserved file is empty, for this user only, and is not reserved twice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visto-create-app-'));
  try {
    const file = path.join(dir, 'app.env');
    const fd = reserveFile(file);
    assert.equal(typeof fd, 'number');
    fs.closeSync(fd!);
    const stat = fs.statSync(file);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.size, 0);
    fs.writeFileSync(file, 'kept');
    assert.equal(reserveFile(file), null);
    assert.equal(fs.readFileSync(file, 'utf8'), 'kept');
    assert.equal(reserveFile(path.join(dir, 'missing', 'app.env')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the way back with the right state fills the file and ends the command', async () => {
  const w = world();
  const s = await start(ARGS, w);
  assert.ok(s.token !== '' && s.state !== '');
  const back = await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  assert.equal(back.status, 303);
  assert.equal(back.headers.location, '/done');
  assert.equal(back.exit, 0);
  assert.equal(await s.running, 0);
  assert.equal(w.fetchCalls.length, 1);
  assert.deepEqual(w.calls.fill, [['/keys/visto.env', envLines({ pem: PEM, webhookSecret: SECRET })]]);
  assert.deepEqual(w.calls.release, []);
  assert.equal(w.calls.close, 1);
});

test('a finished command prints what names the app and where it is installed', async () => {
  const w = world();
  const s = await start(ARGS, w);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
  const text = visible(w.lines);
  for (const part of ['Visto AI Acme', 'acme', '123', 'app.id', 'visto-ai-acme', 'https://github.com/apps/visto-ai-acme/installations/new', '/keys/visto.env']) assert.ok(text.includes(part), part);
});

test('a finished command prints neither the key, the secret, the code nor the state', async () => {
  const w = world();
  const code = 'the-code-from-github';
  const s = await start(ARGS, w);
  await s.ask('GET', `/created?code=${code}&state=${s.state}`);
  await s.running;
  const text = visible(w.lines);
  for (const part of ['BEGIN RSA', 'AAAA', SECRET, CLIENT_SECRET, code, s.state]) assert.ok(!text.includes(part), part);
});

test('the done page has no code in its address and sends back to the terminal', async () => {
  const w = world();
  const s = await start(ARGS, w);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  const done = await s.ask('GET', '/done');
  assert.equal(done.status, 200);
  assert.match(done.body, /terminal/);
  assert.ok(!done.body.includes(CODE + '&') && !done.body.includes(s.state));
  await s.running;
});

test('the printed address is the one that answers, and only it', async () => {
  const w = world();
  const s = await start(ARGS, w);
  assert.equal(w.lines.filter((l) => ADDRESS.test(l)).length, 1);
  const page = await s.ask('GET', `/${s.token}`);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'] ?? '', /^text\/html/);
  assert.equal(actionOf(page.body), `https://github.com/settings/apps/new?state=${s.state}`);
  assert.equal((fieldOf(page.body) as { redirect_url: string }).redirect_url, 'http://127.0.0.1:4010/created');
  assert.equal(page.exit, null);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
});

test('the root of the page is not found', async () => {
  const w = world();
  const s = await start(ARGS, w);
  assert.equal((await s.ask('GET', '/')).status, 404);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
});

test('another token is not found', async () => {
  const w = world();
  const s = await start(ARGS, w);
  assert.equal((await s.ask('GET', `/${'1'.repeat(32)}`)).status, 404);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
});

test('the printed address holds the token and nothing of the state', async () => {
  const w = world();
  const s = await start(ARGS, w);
  assert.ok(!visible(w.lines).includes(s.state));
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
});

test('the page under localhost is served too', async () => {
  const w = world();
  const s = await start(ARGS, w);
  assert.equal((await s.ask('GET', `/${s.token}`, 'localhost:4010')).status, 200);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
});

test('a request under another host name is refused', async () => {
  const w = world();
  const s = await start(ARGS, w);
  for (const host of ['evil.example.test:4010', '127.0.0.1:4011', '']) {
    assert.equal((await s.ask('GET', `/${s.token}`, host)).status, 400, host);
    const back = await s.ask('GET', `/created?code=${CODE}&state=${s.state}`, host);
    assert.equal(back.status, 400, host);
    assert.equal(back.exit, null);
  }
  assert.equal(w.fetchCalls.length, 0);
  assert.deepEqual(w.calls.fill, []);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
});

test('a wrong state changes nothing', async () => {
  const w = world();
  const s = await start(ARGS, w);
  const back = await s.ask('GET', `/created?code=${CODE}&state=${'9'.repeat(32)}`);
  assert.deepEqual([back.status, back.exit], [400, null]);
  await s.settle();
  assert.deepEqual([w.fetchCalls.length, w.calls.fill.length, s.ended()], [0, 0, undefined]);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  assert.equal(await s.running, 0);
});

test('a missing state changes nothing', async () => {
  const w = world();
  const s = await start(ARGS, w);
  const back = await s.ask('GET', `/created?code=${CODE}`);
  assert.deepEqual([back.status, back.exit], [400, null]);
  await s.settle();
  assert.deepEqual([w.fetchCalls.length, w.calls.fill.length, s.ended()], [0, 0, undefined]);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  assert.equal(await s.running, 0);
});

test('a code of another shape changes nothing', async () => {
  const w = world();
  const s = await start(ARGS, w);
  for (const code of ['', 'a/b', 'a.b', 'x'.repeat(201), '%20']) {
    const back = await s.ask('GET', `/created?code=${encodeURIComponent(code)}&state=${s.state}`);
    assert.deepEqual([back.status, back.exit], [400, null], code);
  }
  const noCode = await s.ask('GET', `/created?state=${s.state}`);
  assert.deepEqual([noCode.status, noCode.exit], [400, null]);
  await s.settle();
  assert.deepEqual([w.fetchCalls.length, w.calls.fill.length, s.ended()], [0, 0, undefined]);
  await s.ask('GET', `/created?code=${'x'.repeat(200)}&state=${s.state}`);
  assert.equal(await s.running, 0);
});

test('the way back is taken once', async () => {
  const w = world({ answers: [answer(201), answer(201)] });
  const s = await start(ARGS, w);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  const again = await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  assert.deepEqual([again.status, again.exit], [409, null]);
  assert.equal(w.fetchCalls.length, 1);
  assert.equal(w.calls.fill.length, 1);
  assert.equal(await s.running, 0);
});

test('a failed exchange writes nothing, releases the file and says what to do', async () => {
  const w = world({ answers: [answer(422, { message: 'nope' })] });
  const s = await start(ARGS, w);
  const back = await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  assert.deepEqual([back.status, back.headers.location, back.exit], [303, '/done', 1]);
  assert.equal(await s.running, 1);
  assert.deepEqual(w.calls.fill, []);
  assert.deepEqual(w.calls.release, ['/keys/visto.env']);
  const text = visible(w.lines);
  assert.ok(text.includes('github_422'));
  assert.ok(text.includes('https://github.com/settings/apps'));
  assert.ok(!text.includes('organizations'));
  assert.ok(!text.includes(s.state) && !text.includes(`code=${CODE}`));
});

test('a failed exchange for an organisation points at its settings', async () => {
  const w = world({ answers: [answer(422, { message: 'nope' })] });
  const s = await start([...ARGS, '--org', 'acme'], w);
  assert.equal(actionOf(s.page), `https://github.com/organizations/acme/settings/apps/new?state=${s.state}`);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  assert.equal(await s.running, 1);
  assert.ok(visible(w.lines).includes('https://github.com/organizations/acme/settings/apps'));
});

test('an app with no webhook secret is written with its key alone, and the command says so', async () => {
  const w = world({ answers: [answer(201, appBody({ webhook_secret: null }))] });
  const s = await start(ARGS, w);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  assert.equal(await s.running, 0);
  assert.deepEqual(w.calls.fill, [['/keys/visto.env', `APP_PRIVATE_KEY=${PEM_ONE_LINE}\n`]]);
  assert.match(visible(w.lines), /webhook secret/i);
});

test('an app with a webhook secret does not ask for one by hand', async () => {
  const w = world();
  const s = await start(ARGS, w);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
  assert.doesNotMatch(visible(w.lines), /by hand/);
});

test('bad arguments stop the command before anything is created', async () => {
  const cases = [
    ['--webhook-url', 'http://reviews.example.test/webhooks/github', '--out', '/keys/visto.env'],
    ['--webhook-url', 'https:', '--out', '/keys/visto.env'],
    ['--webhook-url', 'not a url', '--out', '/keys/visto.env'],
    [...ARGS, '--org', 'acme/shop'],
    [...ARGS, '--org', 'a'.repeat(40)],
    [...ARGS, '--org', ''],
    ['--out', '/keys/visto.env'],
    ['--webhook-url', 'https://reviews.example.test/webhooks/github'],
    [...ARGS, '--other', 'x'],
    [...ARGS, 'extra'],
    ARGS.slice(0, 4),
    [...ARGS.slice(0, 4), '--name', ''],
    [...ARGS.slice(0, 4), '--name', '   '],
    [...ARGS.slice(0, 4), '--name', 'a'.repeat(35)],
    [...ARGS.slice(0, 4), '--name', 'acme/visto'],
    [...ARGS.slice(0, 4), '--name', 'Visto\nAI'],
    [...ARGS.slice(0, 4), '--name', 'Visto \u00e9'],
    [...ARGS.slice(0, 4), '--name', 'Visto:AI'],
  ];
  for (const argv of cases) {
    const w = world();
    assert.equal(await run(argv, w.io), 2, argv.join(' '));
    assert.ok(w.lines.length > 0 && w.lines.every((l) => l.startsWith('usage: ')), argv.join(' '));
    assert.deepEqual([w.calls.reserve.length, w.calls.listen], [0, 0], argv.join(' '));
  }
});

test('an organisation of 39 letters, digits or hyphens is taken', async () => {
  const w = world();
  const s = await start([...ARGS, '--org', `Acme-9${'a'.repeat(33)}`], w);
  assert.equal(w.calls.listen, 1);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  assert.equal(await s.running, 0);
});

test('a file that exists, or cannot be created, stops the command before it listens', async () => {
  const w = world({ reserve: false });
  assert.equal(await run(ARGS, w.io), 2);
  assert.deepEqual(w.calls.reserve, ['/keys/visto.env']);
  assert.equal(w.calls.listen, 0);
  assert.equal(w.fetchCalls.length, 0);
  assert.ok(visible(w.lines).includes('/keys/visto.env'));
});

test('the file is reserved before the command listens', async () => {
  const w = world();
  const order: string[] = [];
  const reserve = w.io.reserve;
  const listen = w.io.listen;
  w.io.reserve = (p) => { order.push('reserve'); return reserve(p); };
  w.io.listen = (h) => { order.push('listen'); return listen(h); };
  const s = await start(ARGS, w);
  assert.deepEqual(order, ['reserve', 'listen']);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
});

test('another path is not found', async () => {
  const w = world();
  const s = await start(ARGS, w);
  assert.equal((await s.ask('GET', '/favicon.ico')).status, 404);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
});

test('another method is refused', async () => {
  const w = world();
  const s = await start(ARGS, w);
  assert.equal((await s.ask('POST', `/${s.token}`)).status, 405);
  const back = await s.ask('POST', `/created?code=${CODE}&state=${s.state}`);
  assert.equal(back.status, 405);
  assert.equal(w.fetchCalls.length, 0);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
});

/** A fetch that waits until the test lets it answer. */
function heldFetch() {
  const calls: string[] = [];
  const waiting: Array<(res: Response) => void> = [];
  const fetch = ((url: string | URL | Request) => {
    calls.push(String(url));
    return new Promise<Response>((resolve) => { waiting.push(resolve); });
  }) as typeof globalThis.fetch;
  /** Answers every call still waiting, each with a response of its own made by `res`. */
  return { fetch, calls, answer: (res: () => Response) => { for (const resolve of waiting.splice(0)) resolve(res()); } };
}

test('stopped while waiting, the file is released and nothing else is printed', async () => {
  const w = world();
  const s = await start(ARGS, w);
  const before = [...w.lines];
  w.stop();
  assert.deepEqual(w.calls.release, ['/keys/visto.env']);
  assert.deepEqual(w.lines, before);
  assert.equal(w.fetchCalls.length, 0);
  assert.equal(s.ended(), undefined);
});

test('stopped after a valid way back and before the exchange answered, the file is released and the command says what to do', async () => {
  const held = heldFetch();
  const w = world({ fetch: held.fetch });
  const s = await start(ARGS, w);
  void s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.settle();
  assert.equal(held.calls.length, 1);
  w.stop();
  assert.deepEqual(w.calls.release, ['/keys/visto.env']);
  assert.deepEqual(w.calls.fill, []);
  const text = visible(w.lines);
  assert.match(text, /may now exist on GitHub with no private key/);
  assert.ok(text.includes('https://github.com/settings/apps:'));
  assert.match(text, /generate a private key and a webhook secret there, or delete the app/);
  assert.ok(!text.includes(s.state) && !text.includes(`code=${CODE}`));
});

test('stopped after a valid way back for an organisation, the command points at its settings', async () => {
  const held = heldFetch();
  const w = world({ fetch: held.fetch });
  const s = await start([...ARGS, '--org', 'acme'], w);
  void s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.settle();
  w.stop();
  assert.deepEqual(w.calls.release, ['/keys/visto.env']);
  assert.ok(visible(w.lines).includes('https://github.com/organizations/acme/settings/apps'));
});

test('stopped after the key was written, nothing is released', async () => {
  const w = world();
  const s = await start(ARGS, w);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  assert.equal(await s.running, 0);
  const before = [...w.lines];
  w.stop();
  assert.deepEqual(w.calls.release, []);
  assert.deepEqual(w.lines, before);
});

test('the stop handler is registered once the file is reserved, and not before', async () => {
  const refused = world({ reserve: false });
  assert.equal(await run(ARGS, refused.io), 2);
  assert.throws(() => refused.stop(), /no stop handler/);
  const w = world();
  const s = await start(ARGS, w);
  assert.doesNotThrow(() => w.stop());
  void s;
});

const secretCases: Array<[string, string]> = [['a line break', 'x\nINJ=1'], ['a space', 'x y'], ['a non-ASCII character', 'x\u00e9']];
for (const [what, secret] of secretCases) {
  test(`a webhook secret with ${what} is refused as a bad response`, async () => {
    await assert.rejects(convert(CODE, { fetch: stubFetch([answer(201, appBody({ webhook_secret: secret }))]).fetch }), { message: 'github_bad_response' });
  });
}

test('a key with a NUL is refused as a bad response', async () => {
  await assert.rejects(convert(CODE, { fetch: stubFetch([answer(201, appBody({ pem: PEM.replace('AAAA', 'AA\u0000A') }))]).fetch }), { message: 'github_bad_response' });
});

test('a key with another variable after a line break is still written on one line', async () => {
  const pem = PEM.replace('AAAA\n', 'AAAA\nINJ=1\n');
  const app = await convert(CODE, { fetch: stubFetch([answer(201, appBody({ pem }))]).fetch });
  assert.deepEqual(envLines(app).split('\n'), [`APP_PRIVATE_KEY=${PEM_ONE_LINE.replace('AAAA\\n', 'AAAA\\nINJ=1\\n')}`, `WEBHOOK_SECRET=${SECRET}`, '']);
});

test('an ordinary key and secret still pass', async () => {
  const secret = '!#$%&()*+,-./0123456789:;<=>?@AZ[]^_`az{|}~';
  const app = await convert(CODE, { fetch: stubFetch([answer(201, appBody({ webhook_secret: secret }))]).fetch });
  assert.deepEqual([app.pem, app.webhookSecret], [PEM, secret]);
});

test('a prefix of the right state is refused', async () => {
  const w = world();
  const s = await start(ARGS, w);
  const back = await s.ask('GET', `/created?code=${CODE}&state=${s.state.slice(0, -1)}`);
  assert.deepEqual([back.status, back.exit, w.fetchCalls.length], [400, null, 0]);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
});

test('the right host followed by more characters is refused', async () => {
  const w = world();
  const s = await start(ARGS, w);
  assert.equal((await s.ask('GET', `/${s.token}`, '127.0.0.1:40100')).status, 400);
  assert.equal((await s.ask('GET', `/${s.token}`, 'localhost:4010.example.test')).status, 400);
  const back = await s.ask('GET', `/created?code=${CODE}&state=${s.state}`, '127.0.0.1:4010x');
  assert.deepEqual([back.status, w.fetchCalls.length], [400, 0]);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
});

test("the owner's login is in the lines printed on success", async () => {
  const w = world({ answers: [answer(201, appBody({ owner: { login: 'octo-org' } }))] });
  const s = await start(ARGS, w);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.running;
  assert.ok(visible(w.lines).includes('octo-org'));
});

test('an empty webhook secret counts as none', async () => {
  const app = await convert(CODE, { fetch: stubFetch([answer(201, appBody({ webhook_secret: '' }))]).fetch });
  assert.equal(app.webhookSecret, null);
  assert.equal(envLines(app), `APP_PRIVATE_KEY=${PEM_ONE_LINE}\n`);
});

test('a second way back while the first exchange is waiting is refused and starts no exchange', async () => {
  const held = heldFetch();
  const w = world({ fetch: held.fetch });
  const s = await start(ARGS, w);
  const first = s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  await s.settle();
  // The first exchange is held until the end: a second way back that started an exchange of its own would wait on it too.
  let again: Answer | undefined;
  void s.ask('GET', `/created?code=${CODE}&state=${s.state}`).then((a) => { again = a; });
  await s.settle();
  try {
    assert.deepEqual([again?.status, again?.exit], [409, null]);
    assert.equal(held.calls.length, 1);
  } finally {
    held.answer(() => answer(201));
  }
  assert.equal((await first).exit, 0);
  assert.equal(await s.running, 0);
});

test('the name given is the app name the manifest asks for, at its longest too', async () => {
  for (const name of [NAME, 'a'.repeat(34), 'visto_ai.acme-2', ' x ']) {
    const w = world();
    const s = await start([...ARGS.slice(0, 4), '--name', name], w);
    assert.equal((fieldOf(s.page) as { name: string }).name, name);
    await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
    assert.equal(await s.running, 0);
  }
});

test('the key is written through the descriptor the reservation opened, and nothing is opened by its path again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visto-create-app-'));
  try {
    const file = path.join(dir, 'app.env');
    const fd = reserveFile(file);
    assert.equal(typeof fd, 'number');
    fs.chmodSync(file, 0o644);
    const other = path.join(dir, 'other.env');
    fs.writeFileSync(other, '');
    fs.chmodSync(other, 0o640);
    const before = fs.statSync(other);
    fs.renameSync(other, file);
    fillFile(fd!, 'APP_PRIVATE_KEY=x\n');
    const after = fs.statSync(file);
    assert.equal(fs.readFileSync(file, 'utf8'), '');
    assert.deepEqual([after.ino, after.size, after.mode & 0o777, after.mtimeMs], [before.ino, 0, 0o640, before.mtimeMs]);
    assert.throws(() => fs.fstatSync(fd!), /EBADF/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a reserved file is written whole through its descriptor, and a released one is closed and gone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visto-create-app-'));
  try {
    const file = path.join(dir, 'app.env');
    const fd = reserveFile(file)!;
    fillFile(fd, envLines({ pem: PEM, webhookSecret: SECRET }));
    assert.equal(fs.readFileSync(file, 'utf8'), envLines({ pem: PEM, webhookSecret: SECRET }));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const gone = path.join(dir, 'gone.env');
    const fd2 = reserveFile(gone)!;
    releaseFile(fd2, gone);
    assert.equal(fs.existsSync(gone), false);
    assert.throws(() => fs.fstatSync(fd2), /EBADF/);
    assert.equal(reserveFile(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the reservation is handed through to the fill, and a fill after a release writes nothing', async () => {
  const w = world();
  const s = await start(ARGS, w);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  assert.equal(await s.running, 0);
  assert.deepEqual(w.calls.fds, [FD]);
  const held = heldFetch();
  const late = world({ fetch: held.fetch });
  const t = await start(ARGS, late);
  void t.ask('GET', `/created?code=${CODE}&state=${t.state}`);
  await t.settle();
  late.stop();
  held.answer(() => answer(201));
  await t.settle();
  assert.deepEqual(late.calls.fill, []);
  assert.deepEqual(late.calls.release, ['/keys/visto.env']);
  assert.ok(!visible(late.lines).includes('Created the app'));
});

test('what GitHub sent is printed with every character outside printable ASCII replaced', async () => {
  const w = world({ answers: [answer(201, appBody({
    name: 'Visto\u001b[31m AI\nInjected: yes', owner: { login: 'acme\r' }, slug: 'visto-\u00e9', html_url: 'https://github.com/apps/visto\u0007',
  }))] });
  const s = await start(ARGS, w);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  assert.equal(await s.running, 0);
  assert.ok(w.lines.every((l) => /^[ -~]*$/.test(l)), JSON.stringify(w.lines));
  const text = visible(w.lines);
  for (const part of ['Visto?[31m AI?Injected: yes', 'acme?', 'visto-?', 'https://github.com/apps/visto?/installations/new']) assert.ok(text.includes(part), part);
});

test('with --org, an app another account owns is said, and the command still ends with 0', async () => {
  const w = world({ answers: [answer(201, appBody({ owner: { login: 'octo-dev' } }))] });
  const s = await start([...ARGS, '--org', 'acme'], w);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  assert.equal(await s.running, 0);
  const said = w.lines.filter((l) => l.includes('not the organisation'));
  assert.equal(said.length, 1);
  assert.ok(said[0]!.includes('octo-dev') && said[0]!.includes('acme'));
  for (const [org, owner] of [['acme', 'acme'], ['Acme', 'aCME']] as const) {
    const same = world({ answers: [answer(201, appBody({ owner: { login: owner } }))] });
    const t = await start([...ARGS, '--org', org], same);
    await t.ask('GET', `/created?code=${CODE}&state=${t.state}`);
    assert.equal(await t.running, 0);
    assert.ok(!visible(same.lines).includes('not the organisation'), org);
  }
  const none = world({ answers: [answer(201, appBody({ owner: { login: 'octo-dev' } }))] });
  const u = await start(ARGS, none);
  await u.ask('GET', `/created?code=${CODE}&state=${u.state}`);
  assert.equal(await u.running, 0);
  assert.ok(!visible(none.lines).includes('not the organisation'));
});

/** A fetch that never answers, but rejects as soon as the signal it is given is aborted. */
function silentFetch() {
  const signals: Array<AbortSignal | null | undefined> = [];
  const fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (signal === null || signal === undefined) { reject(new Error('no signal')); return; }
      if (signal.aborted) reject(signal.reason as Error);
      else signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    });
  }) as typeof globalThis.fetch;
  return { fetch, signals };
}

test('each try of the exchange has 20 seconds, and an exchange that never answers ends as github_network after two', async () => {
  const silent = silentFetch();
  const limits: number[] = [];
  const waits: number[] = [];
  const timeout = (ms: number): AbortSignal => { limits.push(ms); return AbortSignal.abort(new DOMException('timed out', 'TimeoutError')); };
  await assert.rejects(exchange(CODE, { fetch: silent.fetch, sleep: async (ms) => { waits.push(ms); }, timeout }), { message: 'github_network' });
  assert.equal(silent.signals.length, 2);
  assert.ok(silent.signals.every((sig) => sig instanceof AbortSignal));
  assert.deepEqual([limits, waits], [[20_000, 20_000], [2000]]);
});

test('without a time limit given, each try is given a signal of its own', async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => { signals.push(init?.signal); return signals.length === 1 ? answer(502, 'bad') : answer(201); }) as typeof globalThis.fetch;
  assert.equal((await exchange(CODE, { fetch, sleep: noWait })).id, 123);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((sig) => sig instanceof AbortSignal && !sig.aborted));
  assert.notEqual(signals[0], signals[1]);
});

test('the second try starts after a wait of two seconds, asked for once; a first try that answers waits for nothing', async () => {
  for (const first of [new Error('down'), answer(502, 'bad gateway')]) {
    const waits: number[] = [];
    const order: string[] = [];
    const stub = stubFetch([first, answer(201)]);
    const fetch = ((url: string, init?: RequestInit) => { order.push('fetch'); return stub.fetch(url, init); }) as typeof globalThis.fetch;
    assert.equal((await exchange(CODE, { fetch, sleep: async (ms) => { order.push('sleep'); waits.push(ms); } })).id, 123);
    assert.deepEqual([waits, order], [[2000], ['fetch', 'sleep', 'fetch']]);
  }
  const waits: number[] = [];
  await exchange(CODE, { fetch: stubFetch([answer(201)]).fetch, sleep: async (ms) => { waits.push(ms); } });
  await assert.rejects(exchange(CODE, { fetch: stubFetch([answer(422, { message: 'nope' })]).fetch, sleep: async (ms) => { waits.push(ms); } }));
  assert.deepEqual(waits, []);
});

test('the command waits through its own sleep before the second try', async () => {
  const w = world({ answers: [new Error('down'), answer(201)] });
  const s = await start(ARGS, w);
  await s.ask('GET', `/created?code=${CODE}&state=${s.state}`);
  assert.equal(await s.running, 0);
  assert.deepEqual(w.calls.sleep, [2000]);
});

test('a key with a lone carriage return is refused as a bad response; CRLF keys still pass', async () => {
  for (const pem of [PEM.replace('AAAA\n', 'AAAA\r'), PEM.replace('AAAA', 'AA\rAA'), PEM.replace('\n-----END', '\r\r\n-----END')]) {
    await assert.rejects(convert(CODE, { fetch: stubFetch([answer(201, appBody({ pem }))]).fetch }), { message: 'github_bad_response' }, JSON.stringify(pem));
  }
  const crlf = PEM.replaceAll('\n', '\r\n');
  assert.equal((await convert(CODE, { fetch: stubFetch([answer(201, appBody({ pem: crlf }))]).fetch })).pem, crlf);
});

test('a failure that is not the listener\'s is internal_error, and one of the listener is listen_failed', async () => {
  const broken = world();
  broken.io.random = () => { throw new Error('Something private'); };
  assert.equal(await run(ARGS, broken.io), 1);
  assert.deepEqual(broken.lines, ['failed: internal_error']);
  assert.deepEqual(broken.calls.release, ['/keys/visto.env']);
  const deaf = world();
  deaf.io.listen = async () => { throw new Error('listen EADDRINUSE 127.0.0.1'); };
  assert.equal(await run(ARGS, deaf.io), 1);
  assert.deepEqual(deaf.lines, ['failed: listen_failed']);
  assert.deepEqual(deaf.calls.release, ['/keys/visto.env']);
});
