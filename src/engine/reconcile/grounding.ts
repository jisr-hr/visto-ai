import type { SubmitReviewArgs } from '../model/submit-review.ts';

// Ported from PM-quality: the rules for what counts as a mention of a pull request file.

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function basenameOf(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] ?? '';
}

function stemOf(basename: string): string {
  const dot = basename.indexOf('.');
  return dot > 0 ? basename.slice(0, dot) : basename;
}

// `refund_request_service` -> `RefundRequestService`, so an answer that names the class still counts.
function camelize(stem: string): string {
  const parts = stem.split(/[_-]+/).filter(Boolean);
  if (parts.length < 2) return '';
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

// A token counts only when it is not glued to word characters. A path separator is allowed on the
// left, so a shortened path still counts.
function mentions(text: string, token: string): boolean {
  if (token.length < 3) return false;
  return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(token)}(?![A-Za-z0-9_-])`, 'i').test(text);
}

function pathIsMentioned(text: string, filePath: string): boolean {
  if (text.includes(filePath)) return true;
  const basename = basenameOf(filePath);
  if (mentions(text, basename)) return true;
  const stem = stemOf(basename);
  if (stem.length >= 6 && mentions(text, stem)) return true;
  const camel = camelize(stem);
  return camel.length >= 6 && mentions(text, camel);
}

export function isGrounded(answer: SubmitReviewArgs, prPaths: string[]): boolean {
  if (prPaths.length === 0) return true;
  if (answer.findings.some((finding) => prPaths.includes(finding.path))) return true;
  const text = [answer.overview, ...answer.findings.map((finding) => finding.body)].join('\n');
  const paths = prPaths.filter((path) => path !== '');
  return paths.some((path) => pathIsMentioned(text, path));
}
