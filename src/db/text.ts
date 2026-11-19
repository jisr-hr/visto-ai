/** Text Postgres will store: no NUL character, and a broken surrogate pair replaced by U+FFFD. */
export function storable(text: string): string {
  return text.replaceAll(String.fromCharCode(0), '').toWellFormed();
}

/** `storable` for a value that may be absent. */
export function storableOrNull(text: string | null): string | null {
  return text === null ? null : storable(text);
}

/** JSON text Postgres accepts as jsonb: every string in `value`, keys included, passed through storable(). */
export function storableJson(value: unknown): string {
  const clean = (v: unknown): unknown => {
    if (typeof v === 'string') return storable(v);
    if (Array.isArray(v)) return v.map(clean);
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [storable(k), clean(x)]));
    }
    return v;
  };
  return JSON.stringify(clean(value));
}
