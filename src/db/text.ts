/** Text Postgres will store: no NUL character, and a broken surrogate pair replaced by U+FFFD. */
export function storable(text: string): string {
  return text.replaceAll(String.fromCharCode(0), '').toWellFormed();
}

/** `storable` for a value that may be absent. */
export function storableOrNull(text: string | null): string | null {
  return text === null ? null : storable(text);
}
