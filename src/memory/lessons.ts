// The one rule that chooses which of a repository's lessons a review is shown (7.4, call 18): those on a changed
// file, then those that share leading directories with one, the deeper first, then those of a changed file's type.
// Pure: no database, no clock, no input or output. The service and the eval both run it, so they cannot disagree.
import type { MemoryLesson } from '../engine/types.ts';
import { MEMORY_NAME } from '../engine/context/memory.ts';
import { LESSONS_SHOWN, lessonText } from '../engine/context/lessons.ts';
import { readTime } from './select.ts';

export const LESSON_DAYS = 90;
export const LESSONS_READ = 1_000;         // live lessons of one repository that are read

export interface LiveLesson { ref: string; number: number; path: string; text: string; createdAt: string }
type File = { path: string; previousPath: string | null };

const TYPE = /^[A-Za-z0-9]{1,10}$/;

/** What follows the last dot of the file's name, in lower case; '' when the name has none, begins with its only dot, or what follows is not 1 to 10 letters or digits. */
export function fileType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  const type = name.slice(dot + 1);
  return TYPE.test(type) ? type.toLowerCase() : '';
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** Newest first: later `createdAt` as `readTime` reads it first, then the smaller `ref` by code unit. A lesson whose `createdAt` is no time is left out. */
export function newestLessons(lessons: LiveLesson[]): Array<{ lesson: LiveLesson; ms: number }> {
  const out: Array<{ lesson: LiveLesson; ms: number }> = [];
  for (const lesson of lessons) {
    const ms = readTime(lesson.createdAt);
    if (ms !== null) out.push({ lesson, ms });
  }
  // The other fields only break a tie two lessons with one reference would leave, so that no order of the source shows.
  return out.sort((a, b) => b.ms - a.ms || byCodeUnit(text(a.lesson.ref), text(b.lesson.ref))
    || a.lesson.number - b.lesson.number || byCodeUnit(text(a.lesson.path), text(b.lesson.path))
    || byCodeUnit(text(a.lesson.text), text(b.lesson.text)) || byCodeUnit(text(a.lesson.createdAt), text(b.lesson.createdAt)));
}

const directories = (path: string): string[] => path.split('/').slice(0, -1);

// The number of leading directories two paths share.
function shared(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/** The lessons for these files; `cut`: how many the limit of LESSONS_SHOWN left out; `names`: the lessons passed over for a path that is not printable or a text that is refused. Pure. */
export function lessonsFor(files: File[], lessons: LiveLesson[]): { lessons: MemoryLesson[]; cut: number; names: number } {
  const paths: string[] = [];
  for (const file of files) {
    paths.push(file.path);
    if (file.previousPath !== null) paths.push(file.previousPath);
  }
  const changed = new Set(paths);
  const types = new Set(paths.map(fileType).filter((type) => type !== ''));
  const dirs = paths.map(directories);

  let names = 0;
  // Rank 0: on a file; 1: a shared directory, `depth` deep; 2: a shared type. The sort is stable over newest first.
  const ranked: Array<{ shown: MemoryLesson; rank: number; depth: number }> = [];
  for (const { lesson, ms } of newestLessons(lessons)) {
    const path: unknown = lesson.path;
    const clean = lessonText(lesson.text);
    if (typeof path !== 'string' || !MEMORY_NAME.test(path) || !clean.ok) {
      names += 1;
      continue;
    }
    let rank: number;
    let depth = 0;
    if (changed.has(path)) rank = 0;
    else {
      const own = directories(path);
      for (const d of dirs) depth = Math.max(depth, shared(own, d));
      if (depth > 0) rank = 1;
      else if (fileType(path) !== '' && types.has(fileType(path))) rank = 2;
      else continue;
    }
    const why = rank === 0 ? 'file' : rank === 1 ? 'directory' : 'type';
    ranked.push({ shown: { ref: lesson.ref, why, path, day: new Date(ms).toISOString().slice(0, 10), text: clean.text }, rank, depth });
  }
  ranked.sort((a, b) => a.rank - b.rank || b.depth - a.depth);
  return { lessons: ranked.slice(0, LESSONS_SHOWN).map((r) => r.shown), cut: Math.max(0, ranked.length - LESSONS_SHOWN), names };
}
