// The one reader of a time in the memory part. A leaf: it imports nothing, so every module of the memory part can use it.

// An ISO time that names its zone: Z, or an offset of hours and minutes. A time with no zone would be read in the
// host's own zone, and give another day on another machine.
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const FIRST_TIME = Date.parse('0001-01-01T00:00:00Z');   // the database takes no time before the year 1

/**
 * The one reader of a time in the memory part: an ISO time that names its zone, as milliseconds; null for anything
 * else, a time with no zone included, one before the year 1, one whose day as written is not a day of the calendar
 * (2026-02-30), and one that cannot be written back as YYYY-MM-DD.
 */
export function readTime(value: unknown): number | null {
  if (typeof value !== 'string' || !ZONED_TIME.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < FIRST_TIME) return null;
  const day = value.slice(0, 10);
  const written = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(written) || new Date(written).toISOString().slice(0, 10) !== day) return null;
  return /^\d{4}-\d{2}-\d{2}T/.test(new Date(ms).toISOString()) ? ms : null;
}
