// The one rule of a revert (6.5, 7.2): the reference the first line of a pull request's description carries, the
// files of a stored review, and the records one revert makes. Pure: no database, no clock, no input or output. The
// GitHub event parser, the learning pass and the eval all run it, so the webhook, the database and a history file
// cannot disagree. Nothing of a description leaves here but one number.
import { MEMORY_NAME } from '../engine/context/memory.ts';
import { stripControl } from '../engine/context/untrusted.ts';
import { directoryOf } from './signals.ts';
import { readTime } from './time.ts';

export const REVERT_DAYS = 180;
export const REVERT_DESCRIPTION_CHARS = 4_000;   // of a description that are read: what a history file keeps of one
export const REVERT_FILES = 300;                  // paths one revert records at most

export interface RevertInput {
  number: number;                    // the reverting pull request
  mergedAt: string | null;           // its merge time
  reverted: number;                  // the pull request its description names
  revertedStored: boolean;           // whether that pull request is known at all
  revertedMergedAt: string | null;   // its merge time; null when it is not known as merged
  files: Array<{ path: string; previousPath: string | null }>;   // of the reverted pull request
}
export interface Revert { sourceRef: string; number: number; reverted: number; path: string; directory: string; createdAt: string; expiresAt: string }
export type RevertCode = 'recorded' | 'same' | 'not_stored' | 'not_merged' | 'no_files';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NUMBER = 2_147_483_647;
const BLANK = /^[ \t]*$/;
// The line the revert button writes, from the line's first character: the word, one space, the repository, '#', a
// number with no leading zero, then the end of the line or a character that is no letter, digit or underscore.
const REFERENCE = /^Reverts ([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#([1-9][0-9]{0,9})(?![A-Za-z0-9_])/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isName = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The pull request a description says it reverts: its first line that is not blank is the line the revert button writes, and names this repository. null when it names none. Total: never throws. */
export function revertedNumber(description: unknown, repo: { owner: string; repo: string }): number | null {
  if (typeof description !== 'string') return null;
  const read = stripControl(description).text.slice(0, REVERT_DESCRIPTION_CHARS);
  let start = 0;
  for (const line of read.split('\n')) {
    if (BLANK.test(line)) {
      start += line.length + 1;
      continue;
    }
    const match = REFERENCE.exec(line);
    if (match === null) return null;
    // A reference that ends at the last character read may have lost digits to the cut.
    if (read.length === REVERT_DESCRIPTION_CHARS && start + match[0].length === REVERT_DESCRIPTION_CHARS) return null;
    if (typeof repo?.owner !== 'string' || typeof repo.repo !== 'string') return null;
    if (match[1]!.toLowerCase() !== repo.owner.toLowerCase() || match[2]!.toLowerCase() !== repo.repo.toLowerCase()) return null;
    const number = Number(match[3]);
    return number <= MAX_NUMBER ? number : null;
  }
  return null;
}

/** The files of a stored review, in their order: each path with its old path. Total: what cannot be read is passed over. */
export function revertedFiles(files: unknown): Array<{ path: string; previousPath: string | null }> {
  if (!Array.isArray(files)) return [];
  const read: Array<{ path: string; previousPath: string | null }> = [];
  for (const entry of files) {
    if (!isObject(entry) || !isName(entry.path)) continue;
    read.push({ path: entry.path, previousPath: isName(entry.previousPath) ? entry.previousPath : null });
  }
  return read;
}

// The time of a merge, as milliseconds; null when it is none, or one whose expiry could not be written.
function mergeOf(value: unknown): number | null {
  const ms = readTime(value);
  if (ms === null || !Number.isFinite(new Date(ms + REVERT_DAYS * DAY_MS).getTime())) return null;
  return ms;
}

/** The records of one revert, and the code that says why there are none. Total and pure. */
export function revertsOf(input: RevertInput): { code: RevertCode; records: Revert[] } {
  if (input.reverted === input.number) return { code: 'same', records: [] };
  if (!input.revertedStored) return { code: 'not_stored', records: [] };
  const merged = mergeOf(input.mergedAt);
  const revertedMerged = readTime(input.revertedMergedAt);
  if (merged === null || revertedMerged === null || revertedMerged > merged) return { code: 'not_merged', records: [] };
  const taken = new Set<string>();
  const paths: string[] = [];
  for (const file of Array.isArray(input.files) ? input.files : []) {
    for (const path of [file?.path, file?.previousPath]) {
      if (typeof path !== 'string' || !MEMORY_NAME.test(path) || taken.has(path)) continue;
      taken.add(path);
      paths.push(path);
    }
  }
  if (paths.length === 0) return { code: 'no_files', records: [] };
  const createdAt = new Date(merged).toISOString();
  const expiresAt = new Date(merged + REVERT_DAYS * DAY_MS).toISOString();
  const records = paths.slice(0, REVERT_FILES).map((path): Revert => ({
    sourceRef: `${input.number}:reverts:${input.reverted}:${path}`, number: input.number, reverted: input.reverted,
    path, directory: directoryOf(path), createdAt, expiresAt,
  }));
  return { code: 'recorded', records };
}
