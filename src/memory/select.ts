// The one rule that chooses what a review is shown of a repository's records (7.4): the lines on and near
// the changed files, and the lists of the directories and kinds of change where people stepped in most.
// Pure: no database, no clock, no input or output. The service and the eval both run it, so they cannot disagree.
// A line carries only what the service computed: a printable path, a day, a category, whether it was a miss.
import type { Memory, MemoryBlocks, MemoryCount, MemoryLine } from '../engine/types.ts';
import {
  MEMORY_CATEGORIES,
  MEMORY_DIRECTORIES,
  MEMORY_LINES,
  MEMORY_LINES_PER_FILE,
  MEMORY_MIN_PULL_REQUESTS,
  MEMORY_NAME,
  MEMORY_NEAR_PER_FILE,
} from '../engine/context/memory.ts';
import { CATEGORIES } from '../engine/score/types.ts';

export const RECORDS_READ = 5_000;            // live records of one repository that are read

export interface LiveRecord { ref: string; number: number; path: string; directory: string; category: string | null; missed: boolean; createdAt: string }
export interface RecordSource {
  /** The repository's signals live at `at`, in any order; RECORDS_READ + 1 at most, the newest when there are more. May reject. */
  live(at: Date): Promise<LiveRecord[]>;
}
type File = { path: string; previousPath: string | null };

/** 00:00:00.000 UTC of the day `at` lies in. */
export function dayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

// An ISO time that names its zone: Z, or an offset of hours and minutes. A time with no zone would be read in the
// host's own zone, and give another day on another machine.
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(CATEGORIES);

/**
 * The one reader of a time in the memory part: an ISO time that names its zone, as milliseconds; null for anything
 * else, a time with no zone included, and one that cannot be written back as YYYY-MM-DD.
 */
export function readTime(value: unknown): number | null {
  if (typeof value !== 'string' || !ZONED_TIME.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return /^\d{4}-\d{2}-\d{2}T/.test(new Date(ms).toISOString()) ? ms : null;
}

// The time of a record, or null when its `createdAt` is no time.
const timeOf = (record: LiveRecord): number | null => readTime(record.createdAt);

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

// Newest first: later `createdAt` first, then the smaller `ref` by code unit. The rest of the fields only break
// a tie two records with one source reference would leave, so that no order of the source ever shows.
function newestFirst(a: { record: LiveRecord; ms: number }, b: { record: LiveRecord; ms: number }): number {
  if (a.ms !== b.ms) return b.ms - a.ms;
  const x = a.record;
  const y = b.record;
  return byCodeUnit(text(x.ref), text(y.ref)) || x.number - y.number || byCodeUnit(text(x.path), text(y.path))
    || byCodeUnit(text(x.directory), text(y.directory)) || byCodeUnit(text(x.category), text(y.category))
    || Number(x.missed === true) - Number(y.missed === true) || byCodeUnit(text(x.createdAt), text(y.createdAt));
}

// The records that have a time, newest first.
function dated(records: LiveRecord[]): Array<{ record: LiveRecord; ms: number }> {
  const out: Array<{ record: LiveRecord; ms: number }> = [];
  for (const record of records) {
    const ms = timeOf(record);
    if (ms !== null) out.push({ record, ms });
  }
  return out.sort(newestFirst);
}

const printable = (name: unknown): name is string => typeof name === 'string' && MEMORY_NAME.test(name);

/** The lines for these files from these records; `cut`: how many the limit of MEMORY_LINES left out; `names`: the records passed over because their path is not printable. Pure. */
export function linesFor(files: File[], records: LiveRecord[]): { lines: MemoryLine[]; cut: number; names: number } {
  let names = 0;
  const usable: Array<{ record: LiveRecord; ms: number }> = [];
  for (const entry of dated(records)) {
    if (printable(entry.record.path)) usable.push(entry);
    else names += 1;
  }
  const taken = new Set<{ record: LiveRecord; ms: number }>();
  const line = (entry: { record: LiveRecord; ms: number }, near: boolean): MemoryLine => ({
    ref: entry.record.ref,
    near,
    path: entry.record.path,
    day: new Date(entry.ms).toISOString().slice(0, 10),
    category: entry.record.category,
    missed: entry.record.missed,
  });
  const take = (candidates: Array<{ record: LiveRecord; ms: number }>, count: number, near: boolean, into: MemoryLine[]) => {
    let left = count;
    for (const entry of candidates) {
      if (left === 0) break;
      if (taken.has(entry)) continue;
      taken.add(entry);
      into.push(line(entry, near));
      left -= 1;
    }
  };

  const onFiles: MemoryLine[] = [];
  const without: File[] = [];
  for (const file of files) {
    const own = usable.filter((entry) => entry.record.path === file.path || (file.previousPath !== null && entry.record.path === file.previousPath));
    if (own.length === 0) without.push(file);
    take(own, MEMORY_LINES_PER_FILE, false, onFiles);
  }
  const nearFiles: MemoryLine[] = [];
  for (const file of without) {
    const segments = file.path.split('/');
    // From the directory the file is in up to the first segment of its path; never the root.
    for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
      const directory = segments.slice(0, depth).join('/');
      if (directory === '') continue;
      const under = usable.filter((entry) => {
        const d = entry.record.directory;
        return typeof d === 'string' && (d === directory || d.startsWith(`${directory}/`));
      });
      if (under.length === 0) continue;
      take(under, MEMORY_NEAR_PER_FILE, true, nearFiles);
      break;
    }
  }
  const all = [...onFiles, ...nearFiles];
  return { lines: all.slice(0, MEMORY_LINES), cut: Math.max(0, all.length - MEMORY_LINES), names };
}

// Count desc, then name by code unit; the entries under the minimum are not listed.
function listed(counts: Map<string, Set<number>>, size: number): { list: MemoryCount[]; cut: number } {
  const eligible: MemoryCount[] = [];
  for (const [name, numbers] of counts) {
    if (numbers.size >= MEMORY_MIN_PULL_REQUESTS) eligible.push({ name, pullRequests: numbers.size });
  }
  eligible.sort((a, b) => b.pullRequests - a.pullRequests || byCodeUnit(a.name, b.name));
  return { list: eligible.slice(0, size), cut: Math.max(0, eligible.length - size) };
}

function tally(counts: Map<string, Set<number>>, name: string, number: number): void {
  const numbers = counts.get(name) ?? new Set<number>();
  numbers.add(number);
  counts.set(name, numbers);
}

/** The two lists from these records; `cut`: how many entries each limit left out; `names`: the directories not listed because they are not printable. Pure. */
export function countsOf(records: LiveRecord[]): { directories: MemoryCount[]; categories: MemoryCount[]; cut: { directories: number; categories: number }; names: number } {
  const directories = new Map<string, Set<number>>();
  const categories = new Map<string, Set<number>>();
  for (const { record } of dated(records)) {
    if (typeof record.directory === 'string') tally(directories, record.directory, record.number);
    // Only a category of the engine's list: one it would drop later must not take a place first.
    if (typeof record.category === 'string' && KNOWN_CATEGORIES.has(record.category)) tally(categories, record.category, record.number);
  }
  // A directory that is not printable is never listed; it is counted when its count would have listed it.
  const shown = new Map<string, Set<number>>();
  let names = 0;
  for (const [name, numbers] of directories) {
    if (printable(name)) shown.set(name, numbers);
    else if (numbers.size >= MEMORY_MIN_PULL_REQUESTS) names += 1;
  }
  const d = listed(shown, MEMORY_DIRECTORIES);
  const c = listed(categories, MEMORY_CATEGORIES);
  return { directories: d.list, categories: c.list, cut: { directories: d.cut, categories: c.cut }, names };
}

// The records of other pull requests, the newest RECORDS_READ of them; `cut` when there were more.
function kept(records: LiveRecord[], own: number): { records: LiveRecord[]; cut: boolean } {
  const others = records.filter((record) => record.number !== own);
  if (others.length <= RECORDS_READ) return { records: others, cut: false };
  // The records that have no time sort last: they are the first left out, and linesFor would pass over them anyway.
  const withTime = dated(others).map((entry) => entry.record);
  const without = others.filter((record) => timeOf(record) === null);
  return { records: [...withTime, ...without].slice(0, RECORDS_READ), cut: true };
}

/** A memory over one repository's records, for a review of the pull request `own`. */
export function createMemory(source: RecordSource, own: number): Memory {
  return {
    async blocks(files, asOf, signal): Promise<MemoryBlocks> {
      const now = kept(await source.live(asOf), own);
      const lines = linesFor(files, now.records);
      // Nothing is shown, and the answer still says what was passed over: the unprintable records, and the read's limit.
      if (lines.lines.length === 0) {
        return { repository: { directories: [], categories: [] }, pullRequest: [], cut: { directories: 0, categories: 0, lines: 0, names: lines.names, records: now.cut } };
      }
      // A review that stopped waiting costs no second read.
      signal.throwIfAborted();
      const day = kept(await source.live(dayStart(asOf)), own);
      const counts = countsOf(day.records);
      return {
        repository: { directories: counts.directories, categories: counts.categories },
        pullRequest: lines.lines,
        cut: {
          directories: counts.cut.directories,
          categories: counts.cut.categories,
          lines: lines.cut,
          names: lines.names + counts.names,
          records: now.cut || day.cut,
        },
      };
    },
  };
}
