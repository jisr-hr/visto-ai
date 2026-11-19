const SHORT_CODE = /^[a-z][a-z0-9_]*$/;

/** A short code: a lower-case letter, then lower-case letters, digits and underscores; at most 40 characters. */
export function isShortCode(text: string): boolean {
  return text.length <= 40 && SHORT_CODE.test(text);
}

/** The error's message when it is a short code, else internal_error. */
export function codeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return isShortCode(message) ? message : 'internal_error';
}
