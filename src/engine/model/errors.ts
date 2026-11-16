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

function detailOf(status: number, body: unknown): string {
  const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' ? body.error.message : '';
  const line = message.replace(/\s+/g, ' ').trim().slice(0, 200);
  return line === '' ? `status ${status}` : line;
}

export function classify(status: number, body: unknown, retryAfterHeader: string | null): ProviderError | null {
  const make = (kind: ProviderErrorKind, retry: number | null = null): ProviderError =>
    new ProviderError(kind, `${kind}: ${detailOf(status, body)}`, status, retry);
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
