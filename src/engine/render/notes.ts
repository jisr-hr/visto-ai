import type { Side } from '../../forge/types.ts';
import type { ReviewResult } from '../types.ts';
import { asRead, blockLabel, scoreTail } from './body.ts';

export interface NoteComment { path: string; side: Side; line: number; body: string; note: string }   // note: the hash of the block it is for
export const MAX_NOTES = 50;
export const noteKey = (path: string, hash: string): string => `${path}\n${hash}`;

type Candidate = NoteComment & { score: number; fileIndex: number; blockIndex: number };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isScore = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 100;

/** The inline notes of a review: one for each block at or above the threshold that has none yet, highest scores first, at most MAX_NOTES. */
export function renderNotes(result: ReviewResult, noted: ReadonlySet<string>): NoteComment[] {
  if (!isObject(result) || result.status !== 'ok' || !Array.isArray(result.scores)) return [];
  const threshold = isObject(result.verdict) ? result.verdict.threshold : undefined;
  if (typeof threshold !== 'number' || Number.isNaN(threshold)) return [];
  const seen = new Set<string>();
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
      const key = noteKey(path, block.hash);
      if (noted.has(key) || seen.has(key)) return;
      seen.add(key);
      const tail = block.origin === 'other_pull_request' ? scoreTail({ ...entry, reason: '' } as never) : scoreTail(entry as never);
      found.push({
        path, side: span.side, line: span.first as number, note: block.hash,
        body: asRead(`**Human review:** ${blockLabel(span as never)}, ${entry.score}% ${tail}`),
        score: entry.score, fileIndex, blockIndex,
      });
    });
  });
  return found
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.fileIndex - b.fileIndex || a.blockIndex - b.blockIndex)
    .slice(0, MAX_NOTES)
    .map(({ path, side, line, body, note }) => ({ path, side, line, body, note }));
}
