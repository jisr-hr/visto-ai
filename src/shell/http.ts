import type { RouteRequest } from '../extensions/types.ts';
import type { HttpAnswer } from './receive.ts';

export const MAX_BODY_BYTES = 25 * 1024 * 1024;
export const MAX_IN_FLIGHT = 20;
export const EXTENSION_BODY_BYTES = 1024 * 1024;
export const EXTENSION_IN_FLIGHT = 10;        // the places of one module
export interface CheckedAnswer { status: number; headers: Record<string, string>; body: string }
/**
 * One module's route. `answer` resolves at the latest when the handler's limit passes, and never rejects.
 * `settled` resolves when the promise the handler returned has settled, which can be later, and never rejects.
 */
export type ExtensionRoute = (request: RouteRequest) => { answer: Promise<CheckedAnswer>; settled: Promise<void> };

export interface RequestLike extends AsyncIterable<Buffer> {
  method?: string | undefined; url?: string | undefined; headers: Record<string, string | string[] | undefined>;
}
export interface ResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body: string): unknown;
}

const HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
const PREFIX = '/extensions/';
const MODULE_FAILED: CheckedAnswer = { status: 500, headers: {}, body: 'internal_error' };

export function createListener(
  routes: {
    webhook: (headers: Record<string, string | undefined>, body: Buffer) => Promise<HttpAnswer>;
    extensions?: ReadonlyMap<string, ExtensionRoute>;   // by module name; absent reads as none
  },
  limits: { maxBodyBytes?: number; maxInFlight?: number; maxExtensionBodyBytes?: number; maxExtensionInFlight?: number } = {},
): { listener: (req: RequestLike, res: ResponseLike) => void; idle: () => Promise<void> } {
  const maxBody = limits.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxInFlight = limits.maxInFlight ?? MAX_IN_FLIGHT;
  const maxExtensionBody = limits.maxExtensionBodyBytes ?? EXTENSION_BODY_BYTES;
  const maxExtensionInFlight = limits.maxExtensionInFlight ?? EXTENSION_IN_FLIGHT;
  const handling = new Set<Promise<void>>();
  let webhooks = 0;
  const taken = new Map<string, number>();   // places in use, by module name

  function answer(res: ResponseLike, a: HttpAnswer, close = false): void {
    try {
      res.writeHead(a.status, close ? { ...HEADERS, connection: 'close' } : { ...HEADERS });
      res.end(a.body);
    } catch {
      // the caller is gone: nothing is owed
    }
  }

  function firstValues(headers: RequestLike['headers']): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(headers)) out[k] = Array.isArray(v) ? v[0] : v;
    return out;
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
    // First values under lower-case names (call 33); defined, not assigned, so no name reaches the prototype.
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (Object.hasOwn(headers, lower)) continue;
      Object.defineProperty(headers, lower, { value: Array.isArray(v) ? v[0] : v, enumerable: true, writable: true, configurable: true });
    }
    const request: RouteRequest = { method: req.method ?? '', path: rest === '' ? '/' : rest, query, headers, body: read.body };
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
