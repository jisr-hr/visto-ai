export type ProviderErrorKind = 'auth' | 'no_credit' | 'rate_limited' | 'timeout' | 'provider';

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  status: number | null;
  retryAfterMs: number | null;
  constructor(kind: ProviderErrorKind, message: string, status: number | null, retryAfterMs: number | null) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const DEFAULT_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function retryAfterMs(header: string | null): number {
  if (header === null || !/^\d+$/.test(header.trim())) return DEFAULT_RETRY_MS;
  return Math.min(Number(header.trim()) * 1000, MAX_RETRY_MS);
}

function detailOf(status: number, body: unknown, secret: string): string {
  const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' ? body.error.message : '';
  const hidden = secret === '' ? message : message.replaceAll(secret, '[redacted]');
  const line = hidden.replace(/\s+/g, ' ').trim().slice(0, 200);
  return line === '' ? `status ${status}` : line;
}

export function classify(status: number, body: unknown, retryAfterHeader: string | null, secret = ''): ProviderError | null {
  const make = (kind: ProviderErrorKind, retry: number | null = null): ProviderError =>
    new ProviderError(kind, `${kind}: ${detailOf(status, body, secret)}`, status, retry);
  if (status === 401) return make('auth');
  if (status === 402) return make('no_credit');
  if (status === 429) return make('rate_limited', retryAfterMs(retryAfterHeader));
  if (status === 408 || status === 504) return make('timeout');
  if (status < 200 || status > 299) return make('provider');
  if (!isRecord(body) || isRecord(body.error)) return make('provider');
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return make('provider');
  const first: unknown = choices[0];
  if (isRecord(first) && first.finish_reason === 'error') return make('provider');
  return null;
}

// Node's fetch stops waiting for headers or body after its own limit, whatever signal it is given.
const UNDICI_TIMEOUTS = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

export function isTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  return isRecord(err.cause) && typeof err.cause.code === 'string' && UNDICI_TIMEOUTS.has(err.cause.code);
}
