import type { HttpAnswer } from './receive.ts';

export const MAX_BODY_BYTES = 25 * 1024 * 1024;
export const MAX_IN_FLIGHT = 20;

export interface RequestLike extends AsyncIterable<Buffer> {
  method?: string | undefined; url?: string | undefined; headers: Record<string, string | string[] | undefined>;
}
export interface ResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body: string): unknown;
}

const HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };

export function createListener(
  routes: { webhook: (headers: Record<string, string | undefined>, body: Buffer) => Promise<HttpAnswer> },
  limits: { maxBodyBytes?: number; maxInFlight?: number } = {},
): { listener: (req: RequestLike, res: ResponseLike) => void; idle: () => Promise<void> } {
  const maxBody = limits.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxInFlight = limits.maxInFlight ?? MAX_IN_FLIGHT;
  const handling = new Set<Promise<void>>();
  let webhooks = 0;

  function answer(res: ResponseLike, a: HttpAnswer): void {
    try {
      res.writeHead(a.status, { ...HEADERS });
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
  async function readBody(req: RequestLike): Promise<{ body: Buffer } | { tooLarge: true } | { failed: true }> {
    const declared = firstValues(req.headers)['content-length'];
    if (declared !== undefined && /^\d+$/.test(declared.trim()) && Number(declared) > maxBody) return { tooLarge: true };
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += piece.length;
        if (total > maxBody) return { tooLarge: true };
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
      const read = await readBody(req);
      if ('failed' in read) return;
      if ('tooLarge' in read) return answer(res, { status: 413, body: 'payload_too_large' });
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

  async function serve(req: RequestLike, res: ResponseLike): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
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
