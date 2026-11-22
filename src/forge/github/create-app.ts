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

/** The shipped manifest with this deployment's webhook URL, the address GitHub sends the browser back to, and the app's name. */
export function manifestFor(webhookUrl: string, redirectUrl: string, name: string): Manifest {
  return {
    name, url: shipped.url, description: shipped.description, public: shipped.public,
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
// What a key and a secret may hold, so that neither can add a line or a variable to the env file.
// A line break is \n or \r\n: a lone \r is no part of a key.
const PEM_TEXT = /^(?:[A-Za-z0-9+/= -]|\r?\n)*$/;
const SECRET_TEXT = /^[!-~]+$/;

const TRY_MS = 20_000;
const RETRY_WAIT_MS = 2000;

/**
 * Exchanges the code GitHub sent back for the app it created. Each try is given TRY_MS (a timeout is github_network);
 * the second try starts RETRY_WAIT_MS after the first failed.
 */
export async function convert(code: string, deps: {
  fetch: typeof fetch; sleep(ms: number): Promise<void>; apiBase?: string;
  /** The signal that ends a try after `ms`. */
  timeout?: (ms: number) => AbortSignal;
}): Promise<CreatedApp> {
  const apiBase = (deps.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const timeout = deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
  let res: Response | undefined;
  for (let attempt = 0; res === undefined; attempt += 1) {
    const last = attempt === 1;
    if (attempt > 0) await deps.sleep(RETRY_WAIT_MS);
    let answer: Response;
    try {
      answer = await deps.fetch(`${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'visto-ai' },
        signal: timeout(TRY_MS),
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
    || !filled(body.html_url) || typeof body.pem !== 'string' || !body.pem.startsWith('-----BEGIN') || !PEM_TEXT.test(body.pem)) throw new Error('github_bad_response');
  const secret = body.webhook_secret;
  if (secret !== undefined && secret !== null && (typeof secret !== 'string' || (secret !== '' && !SECRET_TEXT.test(secret)))) throw new Error('github_bad_response');
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

/** Creates the file, empty, readable and writable by this user only, and answers its open descriptor. Null when it exists or cannot be created. */
export function reserveFile(path: string): number | null {
  let fd: number;
  try {
    fd = fs.openSync(path, 'wx', 0o600);
  } catch {
    return null;
  }
  try {
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return fd;
}

/**
 * Writes the text through the descriptor the reservation opened, then closes it; nothing is opened by the path again.
 * Throws `file_moved` when the path no longer names that file (deleted or replaced meanwhile): the text is then in no file a name leads to.
 */
export function fillFile(fd: number, path: string, text: string): void {
  try {
    fs.writeFileSync(fd, text);
    const held = fs.fstatSync(fd);
    let named: fs.Stats | null;
    try {
      named = fs.statSync(path);
    } catch {
      named = null;
    }
    if (named === null || named.dev !== held.dev || named.ino !== held.ino) throw new Error('file_moved');
  } finally {
    fs.closeSync(fd);
  }
}

/** Closes the reservation's descriptor, when it is still open, and removes the file. */
export function releaseFile(fd: number | null, path: string): void {
  if (fd !== null) {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
  }
  fs.rmSync(path, { force: true });
}

/** A text from GitHub as it is printed: every character outside printable ASCII is a question mark. */
const shown = (value: string): string => value.replace(/[^ -~]/g, '?');

export interface Session {
  manifest: Manifest; org: string | null; state: string; token: string; port: number;
  fetch: typeof fetch; sleep(ms: number): Promise<void>; fill(text: string): void; out(line: string): void;
  taken: boolean;                // a valid way back has been handled: no other is
}

type Answer = { status: number; headers: Record<string, string>; body: string; exit: number | null };
type Request = { method: string; url: string; host: string };

const text = (status: number, body: string): Answer => ({ status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: body + '\n', exit: null });
const html = (body: string): Answer => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body, exit: null });
const DONE = '<!doctype html>\n<html><head><meta charset="utf-8"><title>Visto AI</title></head><body><p>Done here. Go back to the terminal.</p></body></html>\n';
const CODE = /^[A-Za-z0-9_-]{1,200}$/;

const noKeyLines = (org: string | null): string[] => [
  'An app may now exist on GitHub with no private key in anyone\'s hands.',
  `Its settings are at ${settingsBase(org)}: generate a private key and a webhook secret there, or delete the app.`,
];
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
      app = await convert(code, { fetch: session.fetch, sleep: session.sleep });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      throw new Error(SHORT_CODE.test(message) ? message : 'github_network');
    }
    try {
      session.fill(envLines(app));
    } catch {
      throw new Error('write_failed');
    }
    session.out(`Created the app ${shown(app.name)}, owned by ${shown(app.owner)}.`);
    if (session.org !== null && app.owner.toLowerCase() !== session.org.toLowerCase()) {
      session.out(`The account ${shown(app.owner)} owns the app: it is not the organisation ${session.org} that --org named.`);
    }
    session.out(`Its id, for app.id in the config: ${app.id}`);
    session.out(`Its slug: ${shown(app.slug)}`);
    session.out(`Install it at: ${shown(app.htmlUrl)}/installations/new`);
    if (app.webhookSecret === null) session.out("GitHub gave no webhook secret: set one by hand in the app's settings, and the same value as WEBHOOK_SECRET.");
    exit = 0;
  } catch (error) {
    session.out(`failed: ${(error as Error).message}`);
    for (const line of noKeyLines(session.org)) session.out(line);
    exit = 1;
  }
  return { status: 303, headers: { location: '/done', 'content-type': 'text/plain; charset=utf-8' }, body: 'see /done\n', exit };
}

export interface Io {
  out(line: string): void; fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  random(): string;                                   // 32 hex characters of fresh randomness
  /** Creates the file and answers its open descriptor, or null. */
  reserve(path: string): number | null;
  /** Writes through the descriptor and closes it, whatever happens; throws `file_moved` when the path no longer names that file. */
  fill(fd: number, path: string, text: string): void;
  /** Closes the descriptor when it is not null, and removes the file. */
  release(fd: number | null, path: string): void;
  /** Starts listening on this machine only and answers with the port BEFORE any request is handled. */
  listen(handler: (request: Request) => Promise<Answer>): Promise<{ port: number; close(): Promise<void> }>;
  /** Calls the handler when the command is stopped (Ctrl-C, a closed terminal or a termination signal). */
  onStop(handler: () => void): void;
}

const USAGE = 'usage: app:create --webhook-url <https url> --out <file> --name <app name> [--org <login>]';
const ORG = /^[A-Za-z0-9-]{1,39}$/;
// An app's name: 1 to 34 letters, digits, spaces, hyphens, dots or underscores, not all spaces.
const NAME = /^(?=.*[^ ])[A-Za-z0-9 ._-]{1,34}$/;

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
    values = parseArgs({ args: argv, options: { 'webhook-url': { type: 'string' }, out: { type: 'string' }, name: { type: 'string' }, org: { type: 'string' } }, strict: true }).values;
  } catch {
    io.out(USAGE);
    return 2;
  }
  const webhookUrl = values['webhook-url'];
  const out = values.out;
  const org = values.org ?? null;
  const name = values.name;
  if (webhookUrl === undefined || !isWebhookUrl(webhookUrl) || out === undefined || out === '' || name === undefined || !NAME.test(name)
    || (org !== null && !ORG.test(org))) {
    io.out(USAGE);
    return 2;
  }
  const fd = io.reserve(out);
  if (fd === null) {
    io.out(`the file ${out} exists or cannot be created: nothing was done`);
    return 2;
  }
  let open = true;                   // the reservation's descriptor is still ours to close
  let written = false;
  let released = false;
  let decided = false;               // the outcome is printed: a stop adds nothing to it
  const release = (): void => {
    if (written || released) return;
    released = true;
    const held = open ? fd : null;
    open = false;
    io.release(held, out);
  };
  // A fill after the release writes nothing.
  const fill = (t: string): void => {
    if (released || !open) throw new Error('released');
    open = false;
    try {
      io.fill(fd, out, t);
    } catch (error) {
      // The path names another file, or none: it is not ours to remove.
      if (error instanceof Error && error.message === 'file_moved') released = true;
      throw error;
    }
    written = true;
  };
  let listenFailed = false;
  const held: { session?: Session } = {};
  io.onStop(() => {
    if (written) return;
    if (held.session?.taken === true && !decided) {
      io.out('stopped before the app\'s key was written');
      for (const line of noKeyLines(org)) io.out(line);
    }
    release();
  });
  try {
    const state = io.random();
    const token = io.random();
    let finish: (exit: number) => void = () => {};
    const finished = new Promise<number>((resolve) => { finish = resolve; });
    const server = await io.listen(async (request) => {
      if (held.session === undefined) return text(503, 'not ready');
      const answer = await handle(request, held.session);
      if (answer.exit !== null) finish(answer.exit);
      return answer;
    }).catch((error: unknown) => {
      listenFailed = true;
      throw error;
    });
    held.session = {
      manifest: manifestFor(webhookUrl, `http://127.0.0.1:${server.port}/created`, name), org, state, token, port: server.port,
      fetch: io.fetch, sleep: io.sleep, fill, out: io.out, taken: false,
    };
    io.out(`Open this address in a browser on this machine: http://127.0.0.1:${server.port}/${token}`);
    const exit = await finished;
    decided = true;
    if (exit === 0) io.out(`The app's secrets are in ${out}.`);
    await server.close();
    return exit;
  } catch {
    // Nothing of the error is printed: only whether it was the listener's own failure.
    io.out(`failed: ${listenFailed ? 'listen_failed' : 'internal_error'}`);
    return 1;
  } finally {
    release();
  }
}

/** Writes one line to the standard output at once, so that an exit right after loses nothing; a closed output loses the line. */
function writeLine(line: string): void {
  const bytes = Buffer.from(`${line}\n`);
  let done = 0;
  while (done < bytes.length) {
    try {
      done += fs.writeSync(1, bytes, done);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') return;
    }
  }
}

if (import.meta.main) {
  const io: Io = {
    out: writeLine,
    fetch,
    sleep: (ms) => new Promise((done) => { setTimeout(done, ms); }),
    random: () => randomBytes(16).toString('hex'),
    reserve: reserveFile,
    fill: fillFile,
    release: releaseFile,
    onStop: (handler) => {
      // The exit stays: a server left to close would let an exchange in flight fill the file after the stop was printed.
      const stop = (): void => { handler(); process.exit(130); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      process.once('SIGHUP', stop);
    },
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
    writeLine('failed: internal_error');
    process.exitCode = 1;
  }
}
