import type { BlockScore, FileScore } from '../../engine/score/types.ts';
import type { Label, Labels } from './labels.ts';
import { blockKey } from './labels.ts';
import type { CaseScores } from './metrics.ts';

export function block(id: string, score: number | null, changedLines: number, hunk = id): BlockScore {
  return {
    id, hunk, hunkHash: `h-${hunk}`, hash: `x-${id}`, changedLines,
    span: { side: 'RIGHT', first: 1, last: changedLines }, lines: { LEFT: [], RIGHT: [] },
    entry: score === null ? null : { score, category: 'other', reason: '' },
  };
}

export function file(path: string, blocks: BlockScore[], changedLines: number, floor: number | null = null): FileScore {
  const own = Math.max(0, ...blocks.map((b) => b.entry?.score ?? 0));
  return {
    path, previousPath: null, diffHash: `d-${path}`, changeSummary: '', changedLines, blocks, wholeFile: null,
    fileLevel: floor === null ? null : { score: floor, source: 'team_floor' },
    finalScore: Math.max(own, floor ?? 0), covered: true,
  };
}

export function labels(blocks: [string, string, Label][], files: [string, Label][] = []): Labels {
  return {
    blocks: new Map(blocks.map(([path, id, l]) => [blockKey(path, id), l])),
    files: new Map(files),
    comments: { counted: 0, off_head: 0, outside_diff: 0, in_bot_thread: 0 },
    final_missing: 0,
  };
}

export const strict: Label = { loose: true, strict: true };
export const looseOnly: Label = { loose: true, strict: false };
export const none: Label = { loose: false, strict: false };

// Line counts: A has 10 + 5 changed lines (15 in all); B has 10 + 10 (20); C's floored file has 8 and
// its second file 12 (20). Case C also pins the floored file as flagged whole.
export const A: CaseScores = {
  key: 'a', threshold: 70, status: 'ok',
  scores: [file('a.ts', [block('B1', 80, 10), block('B2', 30, 5)], 15)],
  labels: labels([['a.ts', 'B1', none], ['a.ts', 'B2', strict]], [['a.ts', strict]]),
};
export const B: CaseScores = {
  key: 'b', threshold: 40, status: 'ok',
  scores: [file('b.ts', [block('B1', 45, 10), block('B2', 10, 10)], 20)],
  labels: labels([['b.ts', 'B1', looseOnly], ['b.ts', 'B2', none]], [['b.ts', looseOnly]]),
};
export const C: CaseScores = {
  key: 'c', threshold: 70, status: 'ok',
  scores: [file('c1.ts', [block('B1', 20, 8)], 8, 100), file('c2.ts', [block('B2', 50, 12)], 12)],
  labels: labels([['c1.ts', 'B1', strict], ['c2.ts', 'B2', none]], [['c1.ts', strict], ['c2.ts', none]]),
};

