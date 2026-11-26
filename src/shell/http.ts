import type { RouteRequest } from '../extensions/types.ts';
import { SECURITY_HEADERS } from '../ui/headers.ts';
import type { HttpAnswer } from './receive.ts';

export const MAX_BODY_BYTES = 25 * 1024 * 1024;
export const MAX_IN_FLIGHT = 20;
export const EXTENSION_BODY_BYTES = 1024 * 1024;
export const EXTENSION_IN_FLIGHT = 10;        // the places of one module
export const UI_BODY_BYTES = 64 * 1024;
export const UI_FILES_IN_FLIGHT = 16;    // '/', '/ui', '/ui/...'
export const UI_SIGNIN_IN_FLIGHT = 2;    // '/api/auth/start', '/api/auth/callback', '/api/auth/password', '/api/auth/first-password'
export const UI_API_IN_FLIGHT = 4;       // every other '/api' path, '/api/auth/ways' among them
export interface CheckedAnswer { status: number; headers: Record<string, string>; body: string }
/** A request of the UI's route group. `path` is the URL before '?', `query` what follows the first '?'; neither is decoded. */
export interface UiRequest { method: string; path: string; query: string; headers: Record<string, string | undefined>; body: Buffer }
export interface UiAnswer { status: number; headers: Record<string, string | string[]>; body: string | Buffer }   // a list: one header line for each value (set-cookie)
export type UiRoute = (request: UiRequest) => Promise<UiAnswer>;
/**
 * One module's route. `answer` resolves at the latest when the handler's limit passes, and never rejects.
 * `settled` resolves when the promise the handler returned has settled, which can be later, and never rejects.
 */
export type ExtensionRoute = (request: RouteRequest) => { answer: Promise<CheckedAnswer>; settled: Promise<void> };

export interface RequestLike extends AsyncIterable<Buffer> {
  method?: string | undefined; url?: string | undefined; headers: Record<string, string | string[] | undefined>;
}
/**
 * `statusMessage`, `getHeaderNames`, `removeHeader` and `destroy` are Node's: the reason phrase a refused head leaves behind, the
 * headers it may leave set, and closing the connection.
 */
export interface ResponseLike {
  writeHead(status: number, headers: Record<string, string | string[]>): unknown;
  end(body: string | Buffer): unknown;
  statusMessage?: string | undefined;
  getHeaderNames?(): string[];
  removeHeader?(name: string): unknown;
  destroy?(): unknown;
}

const HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
const PREFIX = '/extensions/';
const MODULE_FAILED: CheckedAnswer = { status: 500, headers: {}, body: 'internal_error' };
const INTERNAL_ERROR = 'internal_error';

/**
 * The three parts of the UI's group, each with places of its own (call 17; the password design's call 22): the four routes that
 * sign in share theirs, so a flood of password tries holds sign-in off and never the rest of the API.
 */
type UiPart = 'files' | 'signIn' | 'api';
const SIGN_IN_PATHS: ReadonlySet<string> = new Set(['/api/auth/start', '/api/auth/callback', '/api/auth/password', '/api/auth/first-password']);
function uiPart(path: string): UiPart | null {
  if (path === '/' || path === '/ui' || path.startsWith('/ui/')) return 'files';
  if (SIGN_IN_PATHS.has(path)) return 'signIn';
  if (path === '/api' || path.startsWith('/api/')) return 'api';
  return null;
}

export function createListener(
  routes: {
    webhook: (headers: Record<string, string | undefined>, body: Buffer) => Promise<HttpAnswer>;
    extensions?: ReadonlyMap<string, ExtensionRoute>;   // by module name; absent reads as none
    ui?: UiRoute;                                       // absent: '/', '/ui/...' and '/api/...' are answered as any unknown path
  },
  limits: {
    maxBodyBytes?: number; maxInFlight?: number; maxExtensionBodyBytes?: number; maxExtensionInFlight?: number;
    maxUiBodyBytes?: number; maxUiFilesInFlight?: number; maxUiSignInInFlight?: number; maxUiApiInFlight?: number;
  } = {},
): { listener: (req: RequestLike, res: ResponseLike) => void; idle: () => Promise<void> } {
  const maxBody = limits.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxInFlight = limits.maxInFlight ?? MAX_IN_FLIGHT;
  const maxExtensionBody = limits.maxExtensionBodyBytes ?? EXTENSION_BODY_BYTES;
  const maxExtensionInFlight = limits.maxExtensionInFlight ?? EXTENSION_IN_FLIGHT;
  const maxUiBody = limits.maxUiBodyBytes ?? UI_BODY_BYTES;
  const uiPlaces: Record<UiPart, number> = {
    files: limits.maxUiFilesInFlight ?? UI_FILES_IN_FLIGHT,
    signIn: limits.maxUiSignInInFlight ?? UI_SIGNIN_IN_FLIGHT,
    api: limits.maxUiApiInFlight ?? UI_API_IN_FLIGHT,
  };
  const handling = new Set<Promise<void>>();
  let webhooks = 0;
  const taken = new Map<string, number>();   // places in use, by module name
  const uiTaken: Record<UiPart, number> = { files: 0, signIn: 0, api: 0 };

  /** Writes one answer; false when it could not be (Node refused it, or the caller is gone, and nothing more is owed). */
  function write(res: ResponseLike, status: number, headers: Record<string, string | string[]>, body: string | Buffer): boolean {
    try {
      res.writeHead(status, headers);
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }

  /** A plain answer: today's two headers, then `extra` (the UI group's security headers), then `connection: close` when asked. */
  function answer(res: ResponseLike, a: HttpAnswer, close = false, extra: Readonly<Record<string, string>> = {}): void {
    write(res, a.status, close ? { ...HEADERS, ...extra, connection: 'close' } : { ...HEADERS, ...extra }, a.body);
  }

  function firstValues(headers: RequestLike['headers']): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(headers)) out[k] = Array.isArray(v) ? v[0] : v;
    return out;
  }

  /** First values under lower-case names (call 33); defined, not assigned, so no name reaches the prototype. */
  function lowerFirstValues(given: RequestLike['headers']): Record<string, string | undefined> {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(given)) {
      const lower = k.toLowerCase();
      if (Object.hasOwn(headers, lower)) continue;
      Object.defineProperty(headers, lower, { value: Array.isArray(v) ? v[0] : v, enumerable: true, writable: true, configurable: true });
    }
    return headers;
  }

  /** The body, or why there is none: over the limit, or the stream failed. */
  async function readBody(req: RequestLike, cap: number): Promise<{ body: Buffer } | { tooLarge: true } | { failed: true }> {
    const declared = firstValues(req.headers)['content-length'];
    if (declared !== undefined && /^\d+$/.test(declared.trim()) && Number(declared) > cap) return { tooLarge: true };
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      // Driven by hand: leaving a for-await loop early would call return(), which destroys a real
      // request's socket before the 413 can be written.
      const it = req[Symbol.asyncIterator]();
      for (;;) {
        const next = await it.next();
        if (next.done) break;
        const piece = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        total += piece.length;
        if (total > cap) return { tooLarge: true };
        chunks.push(piece);
      }
    } catch {
      return { failed: true };
    }
    return { body: Buffer.concat(chunks) };
  }

  async function webhook(req: RequestLike, res: ResponseLike): Promise<void> {
    if (webhooks >= maxInFlight) return answer(res, { status: 503, body: 'busy' });
    webhooks += 1;
    try {
      const read = await readBody(req, maxBody);
      if ('failed' in read) return;
      if ('tooLarge' in read) return answer(res, { status: 413, body: 'payload_too_large' }, true);
      let result: HttpAnswer;
      try {
        result = await routes.webhook(firstValues(req.headers), read.body);
      } catch {
        result = { status: 500, body: 'internal_error' };
      }
      answer(res, result);
    } finally {
      webhooks -= 1;
    }
  }

  /** A module's answer: its headers over the default type, and the two the service owns set last. */
  function answerModule(res: ResponseLike, a: CheckedAnswer): void {
    try {
      res.writeHead(a.status, {
        'content-type': HEADERS['content-type'], ...a.headers,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      });
      res.end(a.body);
    } catch {
      // the caller is gone: nothing is owed
    }
  }

  /** A request for a module that has a route. Its place is given back once: unread, or when the handler settled. */
  async function extension(req: RequestLike, res: ResponseLike, name: string, route: ExtensionRoute, rest: string, query: string): Promise<void> {
    const inUse = taken.get(name) ?? 0;
    if (inUse >= maxExtensionInFlight) return answer(res, { status: 503, body: 'busy' });
    taken.set(name, inUse + 1);
    let given = false;
    const giveBack = (): void => {
      if (given) return;
      given = true;
      const left = (taken.get(name) ?? 1) - 1;
      if (left > 0) taken.set(name, left); else taken.delete(name);
    };
    let read: Awaited<ReturnType<typeof readBody>>;
    try {
      read = await readBody(req, maxExtensionBody);
    } catch {
      read = { failed: true };
    }
    if ('failed' in read) return giveBack();
    if ('tooLarge' in read) { giveBack(); return answer(res, { status: 413, body: 'payload_too_large' }, true); }
    const request: RouteRequest = { method: req.method ?? '', path: rest === '' ? '/' : rest, query, headers: lowerFirstValues(req.headers), body: read.body };
    // Both read inside the guard: a route that returns no object, or one whose fields throw, gives its place back.
    let settled: Promise<void>;
    let answered: Promise<CheckedAnswer>;
    try {
      const handled = route(request);
      settled = handled.settled;
      answered = handled.answer;
    } catch {
      giveBack();
      return answerModule(res, MODULE_FAILED);
    }
    // Not awaited: the caller is answered at the handler's limit, the place waits for the handler itself.
    Promise.resolve(settled).then(giveBack, giveBack);
    let result: CheckedAnswer;
    try {
      result = await answered;
    } catch {
      result = MODULE_FAILED;
    }
    answerModule(res, result);
  }

  /**
   * The UI's answer, written with exactly its headers: a list is handed to Node as it is, which writes one line for each value.
   * One Node refuses (a header value with CR or LF, a status out of range) or none at all is answered 500 in its place, as
   * nothing was sent; when even that cannot be written, the connection is closed rather than left open.
   */
  function answerUi(res: ResponseLike, a: UiAnswer): void {
    try {
      res.writeHead(a.status, a.headers);
      res.end(a.body);
      return;
    } catch {
      // refused, or no answer: the 500 below
    }
    res.statusMessage = undefined;   // the refused head's reason phrase ('OK') would stand on the 500
    // Its own length and `connection: close`: a length the refused head gave stays with Node and would stand on the 500 too.
    const headers = { ...HEADERS, ...SECURITY_HEADERS, 'content-length': String(Buffer.byteLength(INTERNAL_ERROR)), connection: 'close' };
    try {
      for (const name of res.getHeaderNames?.() ?? []) res.removeHeader?.(name);   // what the refused head left set
      res.writeHead(500, headers);
      res.end(INTERNAL_ERROR);
    } catch {
      res.destroy?.();
    }
  }

  /**
   * A request of the UI's group. Its place, in its own part, is taken before the body is read and given back once the route settled.
   * Every answer written here carries the security headers (call 17).
   */
  async function ui(req: RequestLike, res: ResponseLike, route: UiRoute, part: UiPart, path: string, query: string): Promise<void> {
    if (uiTaken[part] >= uiPlaces[part]) return answer(res, { status: 503, body: 'busy' }, false, SECURITY_HEADERS);
    uiTaken[part] += 1;
    try {
      const read = await readBody(req, maxUiBody);
      if ('failed' in read) return;
      if ('tooLarge' in read) return answer(res, { status: 413, body: 'payload_too_large' }, true, SECURITY_HEADERS);
      let result: UiAnswer;
      try {
        result = await route({ method: req.method ?? '', path, query, headers: lowerFirstValues(req.headers), body: read.body });
      } catch {
        return answer(res, { status: 500, body: 'internal_error' }, false, SECURITY_HEADERS);
      }
      answerUi(res, result);
    } finally {
      uiTaken[part] -= 1;
    }
  }

  async function serve(req: RequestLike, res: ResponseLike): Promise<void> {
    const url = req.url ?? '';
    const path = url.split('?')[0] ?? '';
    if (path.startsWith(PREFIX)) {
      const after = path.slice(PREFIX.length);
      const slash = after.indexOf('/');
      const name = slash === -1 ? after : after.slice(0, slash);
      const route = routes.extensions?.get(name);
      if (route !== undefined) {
        const mark = url.indexOf('?');
        return extension(req, res, name, route, slash === -1 ? '' : after.slice(slash), mark === -1 ? '' : url.slice(mark + 1));
      }
    }
    if (path === '/webhooks/github') {
      if (req.method !== 'POST') return answer(res, { status: 405, body: 'method_not_allowed' });
      return webhook(req, res);
    }
    if (path === '/healthz') {
      if (req.method !== 'GET') return answer(res, { status: 405, body: 'method_not_allowed' });
      return answer(res, { status: 200, body: 'ok' });
    }
    const part = uiPart(path);
    if (routes.ui !== undefined && part !== null) {
      const mark = url.indexOf('?');
      return ui(req, res, routes.ui, part, path, mark === -1 ? '' : url.slice(mark + 1));
    }
    return answer(res, { status: 404, body: 'not_found' });
  }

  function listener(req: RequestLike, res: ResponseLike): void {
    const p: Promise<void> = serve(req, res)
      .catch(() => answer(res, { status: 500, body: 'internal_error' }))
      .then(() => { handling.delete(p); });
    handling.add(p);
  }

  async function idle(): Promise<void> {
    while (handling.size > 0) await Promise.all([...handling]);
  }

  return { listener, idle };
}
