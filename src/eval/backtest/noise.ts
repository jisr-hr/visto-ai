import type { FileScore } from '../../engine/score/types.ts';
import { highestScore, share } from './metrics.ts';
import type { CaseScores } from './metrics.ts';

export interface NoiseRow { threshold: number; blocks_flipped: number | null; blocks_n: number; prs_flipped: number | null; prs_n: number }

// A hunk's score is the highest effective score of the blocks that came from it, so a hunk split
// in one run and whole in the other still compares as one.
function hunkScores(scores: readonly FileScore[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of scores) {
    for (const b of f.blocks) {
      const key = `${f.path}\n${b.hunk}`;
      const effective = Math.max(b.entry?.score ?? 0, f.fileLevel?.score ?? 0);
      out.set(key, Math.max(out.get(key) ?? 0, effective));
    }
  }
  return out;
}

export function scoreNoise(a: CaseScores[], b: CaseScores[], thresholds: number[]): NoiseRow[] {
  const second = new Map(b.filter((c) => c.status === 'ok').map((c) => [c.key, c]));
  const pairs: { highest: [number, number]; hunks: [number, number][] }[] = [];
  for (const first of a) {
    const other = second.get(first.key);
    if (first.status !== 'ok' || other === undefined) continue;
    const x = hunkScores(first.scores);
    const y = hunkScores(other.scores);
    const hunks: [number, number][] = [];
    for (const [key, score] of x) {
      const match = y.get(key);
      if (match !== undefined) hunks.push([score, match]);
    }
    pairs.push({ highest: [highestScore(first.scores), highestScore(other.scores)], hunks });
  }
  const hunks = pairs.flatMap((p) => p.hunks);
  return thresholds.map((t) => {
    const crosses = ([x, y]: [number, number]): boolean => x >= t !== y >= t;
    return {
      threshold: t,
      blocks_flipped: share(hunks.filter(crosses).length, hunks.length), blocks_n: hunks.length,
      prs_flipped: share(pairs.filter((p) => crosses(p.highest)).length, pairs.length), prs_n: pairs.length,
    };
  });
}

export interface MoveRow { threshold: number; blocks_raised: number; blocks_lowered: number; blocks_n: number; prs_raised: number; prs_lowered: number; prs_n: number }

/** How many blocks and pull requests present in both runs cross each threshold from `a` to `b`: upward, and downward. */
export function scoreMoves(a: CaseScores[], b: CaseScores[], thresholds: number[]): MoveRow[] {
  const second = new Map(b.filter((c) => c.status === 'ok').map((c) => [c.key, c]));
  const prs: [number, number][] = [];
  const hunks: [number, number][] = [];
  for (const first of a) {
    const other = second.get(first.key);
    if (first.status !== 'ok' || other === undefined) continue;
    const y = hunkScores(other.scores);
    for (const [key, score] of hunkScores(first.scores)) {
      const match = y.get(key);
      if (match !== undefined) hunks.push([score, match]);
    }
    prs.push([highestScore(first.scores), highestScore(other.scores)]);
  }
  return thresholds.map((t) => {
    const raised = ([x, y]: [number, number]): boolean => x < t && y >= t;
    const lowered = ([x, y]: [number, number]): boolean => x >= t && y < t;
    return {
      threshold: t,
      blocks_raised: hunks.filter(raised).length, blocks_lowered: hunks.filter(lowered).length, blocks_n: hunks.length,
      prs_raised: prs.filter(raised).length, prs_lowered: prs.filter(lowered).length, prs_n: prs.length,
    };
  });
}
