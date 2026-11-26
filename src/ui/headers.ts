// The headers every answer of the UI's group carries (call 17), and the answers built on them.
import type { UiAnswer } from '../shell/http.ts';

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; "
  + "manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
});

// What a caller adds comes first: it never replaces the type, the cache or a security header.

export function plain(status: number, body: string): UiAnswer {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS }, body };
}

export function json(status: number, value: unknown, extra: Record<string, string | string[]> = {}): UiAnswer {
  return {
    status,
    headers: { ...extra, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS },
    body: JSON.stringify(value),
  };
}

export function redirect(location: string, extra: Record<string, string | string[]> = {}): UiAnswer {
  return { status: 302, headers: { ...extra, location, 'cache-control': 'no-store', ...SECURITY_HEADERS }, body: '' };
}
