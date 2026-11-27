/** Text Postgres will store: no NUL character, and a broken surrogate pair replaced by U+FFFD. */
export function storable(text: string): string {
  return text.replaceAll(String.fromCharCode(0), '').toWellFormed();
}

/** `storable` for a value that may be absent. */
export function storableOrNull(text: string | null): string | null {
  return text === null ? null : storable(text);
}

/** `value` with every string in it, keys included, passed through storable(). */
export function storableValue(value: unknown): unknown {
  if (typeof value === 'string') return storable(value);
  if (Array.isArray(value)) return value.map(storableValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, x]) => [storable(k), storableValue(x)]));
  }
  return value;
}

/** JSON text Postgres accepts as jsonb: storableValue(value) as JSON. */
export function storableJson(value: unknown): string {
  return JSON.stringify(storableValue(value));
}
