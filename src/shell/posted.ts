import { NOTE, type StoredComment } from '../db/review-comments.ts';
import { noteKey } from '../engine/render/notes.ts';
import type { PostedComment } from '../forge/types.ts';

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The keys (noteKey) of the blocks of a pull request that already have a note. */
export function notedOf(stored: StoredComment[]): Set<string> {
  const keys = new Set<string>();
  for (const s of stored) {
    if (s.severity === NOTE && typeof s.blockHash === 'string' && s.blockHash !== '') keys.add(noteKey(s.path, s.blockHash));
  }
  return keys;
}

/**
 * Ties posted comments to what the run rendered: same path, side and text; each recorded entry is used once.
 * A run records its findings' comments first, one for each finding, then its notes. A note carries a string `note`
 * (the hash of its block) and only stands after the findings' comments: it is never matched as a finding, nor a finding as a note.
 */
export function matchPosted(run: { result: unknown; comments: unknown }, posted: PostedComment[]): StoredComment[] {
  const result = run.result as { findings?: unknown } | null;
  const findings = asArray(result?.findings) as Array<{ severity: string; quote: string } | undefined>;
  const rendered = asArray(run.comments);
  const taken = new Set<number>();
  const matched: StoredComment[] = [];
  for (const c of posted) {
    const i = rendered.findIndex((r, index) => {
      if (taken.has(index) || !isObject(r)) return false;
      const isNote = typeof r['note'] === 'string';
      if (index < findings.length ? isNote || findings[index] === undefined : !isNote) return false;
      return r['path'] === c.path && r['side'] === c.side && r['body'] === c.body;
    });
    if (i < 0) continue;
    taken.add(i);
    if (i < findings.length) {
      matched.push({ commentId: c.id, path: c.path, side: c.side, line: c.line, severity: findings[i]!.severity, quote: findings[i]!.quote });
    } else {
      matched.push({ commentId: c.id, path: c.path, side: c.side, line: c.line, severity: NOTE, quote: '', blockHash: (rendered[i] as { note: string }).note });
    }
  }
  return matched;
}
