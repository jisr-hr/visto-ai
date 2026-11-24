// The one rule that chooses what a review is shown of a repository's records (7.4): the lines on and near
// the changed files, and the lists of the directories and kinds of change where people stepped in most.
// Pure: no database, no clock, no input or output. The service and the eval both run it, so they cannot disagree.
// A line carries only what the service computed: a printable path, a day, a category, whether it was a miss.
import type { Memory, MemoryBlocks, MemoryCount, MemoryLessons, MemoryLine } from '../engine/types.ts';
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
import { LESSONS_READ, lessonsFor, newestLessons, type LiveLesson } from './lessons.ts';
import { readTime } from './time.ts';

// The one reader of a time in the memory part lives in a module of its own; its importers keep reading it from here.
export { readTime };

export const RECORDS_READ = 5_000;            // live records of one repository that are read
export const REVERTS_READ = 1_000;            // live records of reverts of one repository that are read

export interface LiveRecord {
  ref: string; number: number; path: string; directory: string; category: string | null; missed: boolean; createdAt: string;
  reverted?: number;   // on a record of a revert: the pull request that was reverted; absent on a signal
}
export interface RecordSource {
  /** The repository's signals live at `at`, in any order; RECORDS_READ + 1 at most, the newest when there are more. May reject. */
  live(at: Date): Promise<LiveRecord[]>;
  /** The repository's lessons live at `at`, in any order; LESSONS_READ + 1 at most, the newest when there are more. May reject. Absent: the repository has no lessons. */
  lessons?(at: Date): Promise<LiveLesson[]>;
  /** The repository's records of reverts live at `at`, each with `reverted`, in any order; REVERTS_READ + 1 at most, the newest when there are more. May reject. Absent: the repository has none. */
  reverts?(at: Date): Promise<LiveRecord[]>;
}
type File = { path: string; previousPath: string | null };

/** 00:00:00.000 UTC of the day `at` lies in. */
export function dayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(CATEGORIES);

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
  // A record on a changed file, or on the previous path of one, is never near: it is on a file the pull request changes.
  const changed = new Set<string>();
  for (const file of files) {
    changed.add(file.path);
    if (file.previousPath !== null) changed.add(file.previousPath);
  }
  const elsewhere = usable.filter((entry) => !changed.has(entry.record.path));
  const nearFiles: MemoryLine[] = [];
  for (const file of without) {
    const segments = file.path.split('/');
    // From the directory the file is in up to the first segment of its path; never the root.
    for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
      const directory = segments.slice(0, depth).join('/');
      if (directory === '') continue;
      const under = elsewhere.filter((entry) => {
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

/** The reverted lines for these files from these records of reverts: for each file, in the order given, the newest record on its path or its old path, on a path that no file before it took. `names`: the records passed over because their path is not printable. Pure. */
export function revertedLinesFor(files: File[], reverts: LiveRecord[]): { lines: MemoryLine[]; names: number } {
  let names = 0;
  const usable: Array<{ record: LiveRecord; ms: number }> = [];
  for (const entry of dated(reverts)) {
    if (printable(entry.record.path)) usable.push(entry);
    else names += 1;
  }
  // A path that already has its reverted line is taken: the engine keeps one for a path, so a file goes on to a path that has none.
  const taken = new Set<string>();
  const lines: MemoryLine[] = [];
  for (const file of files) {
    // One line for a file at most, and so a record is one line at most; a reverted line is never near (call 12).
    const entry = usable.find((e) => !taken.has(e.record.path) && (e.record.path === file.path || (file.previousPath !== null && e.record.path === file.previousPath)));
    if (entry === undefined) continue;
    taken.add(entry.record.path);
    lines.push({ ref: entry.record.ref, near: false, path: entry.record.path, day: new Date(entry.ms).toISOString().slice(0, 10), category: null, missed: false, reverted: true });
  }
  return { lines, names };
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

// The entries of other pull requests, the newest `limit` of them; `cut` when there were more.
function kept<T extends { number: number; createdAt: string }>(entries: T[], own: number, limit: number, newest: (list: T[]) => T[]): { records: T[]; cut: boolean } {
  const others = entries.filter((entry) => entry.number !== own);
  if (others.length <= limit) return { records: others, cut: false };
  // The entries that have no time sort last: they are the first left out, and the choice would pass over them anyway.
  const withTime = newest(others);
  const without = others.filter((entry) => readTime(entry.createdAt) === null);
  return { records: [...withTime, ...without].slice(0, limit), cut: true };
}
const keptRecords = (records: LiveRecord[], own: number) => kept(records, own, RECORDS_READ, (list) => dated(list).map((entry) => entry.record));
// A record of a revert counts only with a reverted pull request; one made by, or of, the pull request under review is dropped before the limit.
const keptReverts = (reverts: LiveRecord[], own: number) =>
  kept((Array.isArray(reverts) ? reverts : []).filter((r) => typeof r === 'object' && r !== null && Number.isInteger(r.reverted) && r.reverted! >= 1 && r.reverted !== own),
    own, REVERTS_READ, (list) => dated(list).map((entry) => entry.record));
// An entry that is no object is passed over before anything of it is read.
const keptLessons = (lessons: LiveLesson[], own: number) =>
  kept(lessons.filter((lesson) => typeof lesson === 'object' && lesson !== null), own, LESSONS_READ, (list) => newestLessons(list).map((entry) => entry.lesson));

/** A memory over one repository's records, for a review of the pull request `own`. */
export function createMemory(source: RecordSource, own: number): Memory {
  const memory: Memory = {
    async blocks(files, asOf, signal): Promise<MemoryBlocks> {
      const now = keptRecords(await source.live(asOf), own);
      // The reverts are read once, as of the review, never for the day; a review that stopped waiting costs no read of them.
      let reverts: { records: LiveRecord[]; cut: boolean } = { records: [], cut: false };
      // With no files no reverted line can be shown, so nothing is asked of the reverts.
      if (typeof source.reverts === 'function' && files.length > 0) {
        signal.throwIfAborted();
        reverts = keptReverts(await source.reverts(asOf), own);
      }
      // The signals' lines are chosen as if no revert existed; the reverted lines stand after them, and the limit cuts them first (call 12).
      const lines = linesFor(files, now.records);
      const reverted = revertedLinesFor(files, reverts.records);
      const all = [...lines.lines, ...reverted.lines];
      const shown = all.slice(0, MEMORY_LINES);
      const names = lines.names + reverted.names;
      const records = now.cut || reverts.cut;
      // Nothing is shown, and the answer still says what was passed over: the unprintable records, and the reads' limits.
      if (shown.length === 0) {
        return { repository: { directories: [], categories: [] }, pullRequest: [], cut: { directories: 0, categories: 0, lines: 0, names, records } };
      }
      // A review that stopped waiting costs no second read.
      signal.throwIfAborted();
      const day = keptRecords(await source.live(dayStart(asOf)), own);
      const counts = countsOf(day.records);
      return {
        repository: { directories: counts.directories, categories: counts.categories },
        pullRequest: shown,
        cut: {
          directories: counts.cut.directories,
          categories: counts.cut.categories,
          lines: lines.cut + (all.length - shown.length),
          names: names + counts.names,
          records: records || day.cut,
        },
      };
    },
  };
  // Only a source that has lessons gives a memory that has them: without, a review is what it was.
  if (typeof source.lessons !== 'function') return memory;
  memory.lessons = async (files, asOf): Promise<MemoryLessons> => {
    const read = keptLessons(await source.lessons!(asOf), own);
    const chosen = lessonsFor(files, read.records);
    return { lessons: chosen.lessons, cut: { lessons: chosen.cut, names: chosen.names, records: read.cut } };
  };
  return memory;
}
