import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { parseArgs } from 'node:util';
import shipped from './app-manifest.json' with { type: 'json' };
import { isObject, jsonOf } from './http.ts';

export interface Manifest {
  name: string; url: string; description: string; public: boolean;
  hook_attributes: { url: string; active: boolean }; redirect_url?: string;
  default_permissions: Record<string, string>; default_events: string[];
}

/** The shipped manifest with this deployment's webhook URL and the address GitHub sends the browser back to. */
export function manifestFor(webhookUrl: string, redirectUrl: string): Manifest {
  return {
    name: shipped.name, url: shipped.url, description: shipped.description, public: shipped.public,
    hook_attributes: { url: webhookUrl, active: shipped.hook_attributes.active },
    redirect_url: redirectUrl,
    default_permissions: { ...shipped.default_permissions },
    default_events: [...shipped.default_events],
  };
}

const attr = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const settingsBase = (org: string | null): string => (org === null ? 'https://github.com/settings/apps' : `https://github.com/organizations/${org}/settings/apps`);

/** The page whose one form posts the manifest to GitHub: for an organisation when `org` is given, else for the signed-in account. */
export function formPage(manifest: Manifest, opts: { org: string | null; state: string }): string {
  const action = `${settingsBase(opts.org)}/new?state=${encodeURIComponent(opts.state)}`;
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>Create the Visto AI app</title></head><body>',
    '<p>This sends the app manifest to GitHub, where you confirm the new app.</p>',
    `<form method="post" action="${attr(action)}">`,
    `<input type="hidden" name="manifest" value="${attr(JSON.stringify(manifest))}">`,
    '<button type="submit">Create the app on GitHub</button>',
    '</form>',
    '</body></html>',
    '',
  ].join('\n');
}

export interface CreatedApp { id: number; slug: string; name: string; owner: string; htmlUrl: string; pem: string; webhookSecret: string | null }

const filled = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Exchanges the code GitHub sent back for the app it created. */
export async function convert(code: string, deps: { fetch: typeof fetch; apiBase?: string }): Promise<CreatedApp> {
  const apiBase = (deps.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  let res: Response | undefined;
  for (let attempt = 0; res === undefined; attempt += 1) {
    const last = attempt === 1;
    let answer: Response;
    try {
      answer = await deps.fetch(`${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'visto-ai' },
      });
    } catch {
      if (last) throw new Error('github_network');
      continue;
    }
    if (answer.status >= 500 && !last) continue;
    res = answer;
  }
  if (!res.ok) throw new Error(`github_${res.status}`);
  const body = await jsonOf(res);
  if (!isObject(body) || !Number.isInteger(body.id) || !filled(body.slug) || !filled(body.name) || !isObject(body.owner) || !filled(body.owner.login)
    || !filled(body.html_url) || typeof body.pem !== 'string' || !body.pem.startsWith('-----BEGIN')) throw new Error('github_bad_response');
  const secret = body.webhook_secret;
  if (secret !== undefined && secret !== null && typeof secret !== 'string') throw new Error('github_bad_response');
  return {
    id: body.id as number, slug: body.slug, name: body.name, owner: body.owner.login, htmlUrl: body.html_url, pem: body.pem,
    webhookSecret: filled(secret) ? secret : null,
  };
}

/** The lines of an env file that hold the app's secrets; the key on one line, each line break written as backslash-n. */
export function envLines(app: { pem: string; webhookSecret: string | null }): string {
  const lines = [`APP_PRIVATE_KEY=${app.pem.replace(/\r?\n/g, '\\n')}`];
  if (app.webhookSecret !== null) lines.push(`WEBHOOK_SECRET=${app.webhookSecret}`);
  return lines.join('\n') + '\n';
}

/** Creates the file, empty, readable and writable by this user only. False when it exists or cannot be created. */
export function reserveFile(path: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(path, 'wx', 0o600);
  } catch {
    return false;
  }
  try {
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

export interface Session {
  manifest: Manifest; org: string | null; state: string; token: string; port: number;
  fetch: typeof fetch; fill(text: string): void; out(line: string): void;
  taken: boolean;                // a valid way back has been handled: no other is
}

type Answer = { status: number; headers: Record<string, string>; body: string; exit: number | null };
type Request = { method: string; url: string; host: string };

const text = (status: number, body: string): Answer => ({ status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: body + '\n', exit: null });
const html = (body: string): Answer => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body, exit: null });
const DONE = '<!doctype html>\n<html><head><meta charset="utf-8"><title>Visto AI</title></head><body><p>Done here. Go back to the terminal.</p></body></html>\n';
const CODE = /^[A-Za-z0-9_-]{1,200}$/;
const SHORT_CODE = /^github_[a-z0-9_]+$/;

/** One request to the local page. `exit` is the command's exit code once it is decided, else null. */
export async function handle(request: Request, session: Session): Promise<Answer> {
  if (request.host !== `127.0.0.1:${session.port}` && request.host !== `localhost:${session.port}`) return text(400, 'bad request');
  let url: URL;
  try {
    url = new URL(request.url, 'http://127.0.0.1');
  } catch {
    return text(400, 'bad request');
  }
  const known = [`/${session.token}`, '/created', '/done'];
  if (!known.includes(url.pathname)) return text(404, 'not found');
  if (request.method !== 'GET') return { ...text(405, 'method not allowed'), headers: { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' } };
  if (url.pathname === '/done') return html(DONE);
  if (url.pathname !== '/created') return html(formPage(session.manifest, { org: session.org, state: session.state }));

  if (session.taken) return text(409, 'already done');
  const code = url.searchParams.get('code') ?? '';
  if (url.searchParams.get('state') !== session.state || !CODE.test(code)) return text(400, 'bad request');
  session.taken = true;
  let exit: number;
  try {
    let app: CreatedApp;
    try {
      app = await convert(code, { fetch: session.fetch });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      throw new Error(SHORT_CODE.test(message) ? message : 'github_network');
    }
    try {
      session.fill(envLines(app));
    } catch {
      throw new Error('write_failed');
    }
    session.out(`Created the app ${app.name}, owned by ${app.owner}.`);
    session.out(`Its id, for app.id in the config: ${app.id}`);
    session.out(`Its slug: ${app.slug}`);
    session.out(`Install it at: ${app.htmlUrl}/installations/new`);
    if (app.webhookSecret === null) session.out("GitHub gave no webhook secret: set one by hand in the app's settings, and the same value as WEBHOOK_SECRET.");
    exit = 0;
  } catch (error) {
    session.out(`failed: ${(error as Error).message}`);
    session.out('An app may now exist on GitHub with no private key in anyone\'s hands.');
    session.out(`Its settings are at ${settingsBase(session.org)}: generate a private key and a webhook secret there, or delete the app.`);
    exit = 1;
  }
  return { status: 303, headers: { location: '/done', 'content-type': 'text/plain; charset=utf-8' }, body: 'see /done\n', exit };
}

export interface Io {
  out(line: string): void; fetch: typeof fetch;
  random(): string;                                   // 32 hex characters of fresh randomness
  reserve(path: string): boolean; fill(path: string, text: string): void; release(path: string): void;
  /** Starts listening on this machine only and answers with the port BEFORE any request is handled. */
  listen(handler: (request: Request) => Promise<Answer>): Promise<{ port: number; close(): Promise<void> }>;
}

const USAGE = 'usage: app:create --webhook-url <https url> --out <file> [--org <login>]';
const ORG = /^[A-Za-z0-9-]{1,39}$/;

function isWebhookUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname !== '';
  } catch {
    return false;
  }
}

export async function run(argv: string[], io: Io): Promise<number> {
  let values;
  try {
    values = parseArgs({ args: argv, options: { 'webhook-url': { type: 'string' }, out: { type: 'string' }, org: { type: 'string' } }, strict: true }).values;
  } catch {
    io.out(USAGE);
    return 2;
  }
  const webhookUrl = values['webhook-url'];
  const out = values.out;
  const org = values.org ?? null;
  if (webhookUrl === undefined || !isWebhookUrl(webhookUrl) || out === undefined || out === '' || (org !== null && !ORG.test(org))) {
    io.out(USAGE);
    return 2;
  }
  if (!io.reserve(out)) {
    io.out(`the file ${out} exists or cannot be created: nothing was done`);
    return 2;
  }
  let written = false;
  try {
    const state = io.random();
    const token = io.random();
    const held: { session?: Session } = {};
    let finish: (exit: number) => void = () => {};
    const finished = new Promise<number>((resolve) => { finish = resolve; });
    const server = await io.listen(async (request) => {
      if (held.session === undefined) return text(503, 'not ready');
      const answer = await handle(request, held.session);
      if (answer.exit !== null) finish(answer.exit);
      return answer;
    });
    held.session = {
      manifest: manifestFor(webhookUrl, `http://127.0.0.1:${server.port}/created`), org, state, token, port: server.port,
      fetch: io.fetch, fill: (t) => { io.fill(out, t); written = true; }, out: io.out, taken: false,
    };
    io.out(`Open this address in a browser on this machine: http://127.0.0.1:${server.port}/${token}`);
    const exit = await finished;
    if (exit === 0) io.out(`The app's secrets are in ${out}.`);
    await server.close();
    return exit;
  } finally {
    if (!written) io.release(out);
  }
}

if (import.meta.main) {
  const io: Io = {
    out: (line) => { console.log(line); },
    fetch,
    random: () => randomBytes(16).toString('hex'),
    reserve: reserveFile,
    fill: (path, t) => { fs.writeFileSync(path, t, { mode: 0o600 }); },
    release: (path) => { fs.rmSync(path, { force: true }); },
    listen: (handler) => new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const request = { method: req.method ?? '', url: req.url ?? '', host: req.headers.host ?? '' };
        handler(request).then((answer) => {
          res.writeHead(answer.status, answer.headers);
          res.end(answer.body);
        }, () => {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('error\n');
        });
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('listen_failed'));
          return;
        }
        resolve({
          port: address.port,
          // A moment's grace, so that the browser's request for /done is still answered.
          close: () => new Promise((done) => { setTimeout(() => { server.close(() => done()); server.closeAllConnections(); }, 1000); }),
        });
      });
    }),
  };
  try {
    process.exitCode = await run(process.argv.slice(2), io);
  } catch {
    console.log('failed: listen_failed');
    process.exitCode = 1;
  }
}
