import type { Side } from '../../forge/types.ts';
import type { ReviewResult } from '../types.ts';
import { asRead, blockLabel, scoreTail } from './body.ts';

export interface NoteComment { path: string; side: Side; line: number; body: string; note: string }   // note: the hash of the block it is for
export const MAX_NOTES = 50;
export const noteKey = (path: string, hash: string): string => `${path}\n${hash}`;

type Candidate = NoteComment & { score: number; fileIndex: number; blockIndex: number };

/** The words every note begins with. */
const NOTE_OPEN = '**Human review:** ';
// The service's own words up to the category: the opening, the block's label (blockLabel's form) and the score.
const HEAD_LEAD = new RegExp(`^${NOTE_OPEN.replace(/[*]/g, '\\$&')}(?:old )?(?:line [0-9]+|lines [0-9]+-[0-9]+), [0-9]{1,3}% `);

/**
 * The part of a note's text the service wrote itself: from its start up to and including the category's code span.
 * Null for a text that is not a note's.
 */
export function noteHead(body: string): string | null {
  if (typeof body !== 'string') return null;
  const lead = HEAD_LEAD.exec(body)?.[0];
  if (lead === undefined) return null;
  const rest = body.slice(lead.length);
  const fence = /^`+/.exec(rest)?.[0];
  if (fence === undefined) return null;
  // A code span closes at the next run of exactly as many backticks.
  const closing = new RegExp(`(?<!\`)${fence}(?!\`)`, 'g');
  closing.lastIndex = fence.length;
  const close = closing.exec(rest);
  return close === null ? null : lead + rest.slice(0, close.index + fence.length);
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isScore = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 100;

/** The inline notes of a review: one for each block at or above the threshold that has none yet, highest scores first, at most MAX_NOTES. */
export function renderNotes(result: ReviewResult, noted: ReadonlySet<string>): NoteComment[] {
  if (!isObject(result) || result.status !== 'ok' || !Array.isArray(result.scores)) return [];
  const threshold = isObject(result.verdict) ? result.verdict.threshold : undefined;
  if (typeof threshold !== 'number' || Number.isNaN(threshold)) return [];
  const found: Candidate[] = [];
  (result.scores as unknown[]).forEach((file, fileIndex) => {
    if (!isObject(file) || typeof file.path !== 'string' || !Array.isArray(file.blocks)) return;
    const path = file.path;
    (file.blocks as unknown[]).forEach((block, blockIndex) => {
      if (!isObject(block) || typeof block.hash !== 'string' || block.hash === '' || !isObject(block.span) || !isObject(block.entry)) return;
      const { span, entry } = block;
      if ((span.side !== 'LEFT' && span.side !== 'RIGHT') || !Number.isSafeInteger(span.first) || !Number.isSafeInteger(span.last) || (span.first as number) < 1 || (span.last as number) < (span.first as number)) return;
      if (!isScore(entry.score) || typeof entry.category !== 'string' || typeof entry.reason !== 'string') return;
      if (entry.score < threshold) return;
      if (noted.has(noteKey(path, block.hash))) return;
      const tail = block.origin === 'other_pull_request' ? scoreTail({ ...entry, reason: '' } as never) : scoreTail(entry as never);
      found.push({
        path, side: span.side, line: span.first as number, note: block.hash,
        body: asRead(`${NOTE_OPEN}${blockLabel(span as never)}, ${entry.score}% ${tail}`),
        score: entry.score, fileIndex, blockIndex,
      });
    });
  });
  // Sorted first, so that of two blocks with the same lines the higher one keeps the note.
  const seen = new Set<string>();
  return found
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.fileIndex - b.fileIndex || a.blockIndex - b.blockIndex)
    .filter((n) => {
      const key = noteKey(n.path, n.note);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_NOTES)
    .map(({ path, side, line, body, note }) => ({ path, side, line, body, note }));
}
