// A module's route part, run under its limit, with its answer checked before the listener writes it (11.3, call 23).
import { withLimit } from '../extensions/limit.ts';
import type { LoadedExtension, RouteRequest } from '../extensions/types.ts';
import type { CheckedAnswer, ExtensionRoute } from './http.ts';

export const ROUTE_TIMEOUT_MS = 10_000;

const FAILED: CheckedAnswer = { status: 500, headers: {}, body: 'internal_error' };
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE = 2_000;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
// Printable ASCII only: no control character, and nothing the runtime would refuse to write.
const HEADER_VALUE = /^[\x20-\x7e]*$/;
const OWNED = new Set([
  'connection', 'content-length', 'transfer-encoding', 'cache-control', 'x-content-type-options',
  'keep-alive', 'upgrade', 'trailer', 'te', 'date',
]);

/** The answer as the listener may write it, or null. Read field by field: a getter that throws is a wrong shape. */
function check(value: unknown): CheckedAnswer | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const { status, headers, body } = value as Record<string, unknown>;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) return null;
    if (body !== undefined && typeof body !== 'string') return null;
    const out: Record<string, string> = {};
    if (headers !== undefined) {
      if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return null;
      const entries = Object.entries(headers as Record<string, unknown>);
      if (entries.length > MAX_HEADERS) return null;
      for (const [name, v] of entries) {
        if (!HEADER_NAME.test(name)) return null;
        if (typeof v !== 'string' || v.length > MAX_HEADER_VALUE || !HEADER_VALUE.test(v)) return null;
        const lower = name.toLowerCase();
        if (!OWNED.has(lower)) out[lower] = v;
      }
    }
    return { status, headers: out, body: body ?? '' };
  } catch {
    return null;
  }
}

/** One route for each module that has the part, by its name. A module with no `route` has no entry. `noted` is told how each handled request went. */
export function createExtensionRoutes(extensions: LoadedExtension[], deps: {
  log: (entry: Record<string, unknown>) => void;
  noted?: (extension: string, ok: boolean, code: string) => void;
  timeoutMs?: number;
}): Map<string, ExtensionRoute> {
  const limit = deps.timeoutMs ?? ROUTE_TIMEOUT_MS;
  const routes = new Map<string, ExtensionRoute>();

  function decided(name: string, code: 'ok' | 'threw' | 'timeout' | 'bad_answer'): void {
    if (code !== 'ok') {
      try { deps.log({ event: 'extension_route_failed', extension: name, code }); } catch { /* a log that throws changes nothing */ }
    }
    try { deps.noted?.(name, code === 'ok', code); } catch { /* a noted that throws changes nothing */ }
  }

  for (const extension of extensions) {
    const { name, parts } = extension;
    const handler = parts.route;
    if (typeof handler !== 'function') continue;
    routes.set(name, (request: RouteRequest) => {
      let markSettled: () => void = () => undefined;
      const settled = new Promise<void>((resolve) => { markSettled = () => resolve(); });
      let signalSeen: AbortSignal | null = null;
      const attempt = withLimit(limit, (signal) => {
        signalSeen = signal;
        let returned: unknown;
        try {
          returned = handler.call(parts, request, signal);
        } catch (error) {
          markSettled();
          throw error;
        }
        // The place stays taken until the handler's own promise settles, however late (rule 4).
        const running = Promise.resolve(returned);
        running.then(markSettled, markSettled);
        return running;
      });
      const answer = attempt.then(
        (value) => {
          const checked = check(value);
          decided(name, checked === null ? 'bad_answer' : 'ok');
          return checked ?? FAILED;
        },
        () => {
          decided(name, (signalSeen as AbortSignal | null)?.aborted === true ? 'timeout' : 'threw');
          return FAILED;
        },
      );
      return { answer, settled };
    });
  }
  return routes;
}
