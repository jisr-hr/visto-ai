import type { FileScore } from '../../engine/score/types.ts';
import { blockKey } from './labels.ts';
import type { Labels } from './labels.ts';

export const THRESHOLDS = [20, 40, 70, 90];

export interface ScoredBlock { id: string; changedLines: number; entry: { score: number } | null }
export interface ScoredFile { path: string; changedLines: number; finalScore: number; fileLevel: { score: number } | null; blocks: readonly ScoredBlock[] }

/** The backtest's cases hold the engine's whole FileScore (the default); the measuring below reads only what a ScoredFile holds. */
export interface CaseScores<F extends ScoredFile = FileScore> { key: string; threshold: number; status: 'ok' | 'failed'; scores: readonly F[]; labels: Labels }

export interface Numbers {
  threshold: number | 'own';
  safety_blocks: number | null; safety_blocks_n: number;
  safety_blocks_loose: number | null; safety_blocks_loose_n: number;
  safety_files: number | null; safety_files_n: number;
  safety_files_loose: number | null; safety_files_loose_n: number;
  benefit: number | null; benefit_n: number;
  focus: number | null; focus_n: number;
}

export interface Counts {
  blocks: number; blocksLeft: number; looseBlocks: number; looseBlocksLeft: number;
  files: number; filesLeft: number; looseFiles: number; looseFilesLeft: number;
  prs: number; prsClear: number; focusPrs: number; flaggedLines: number; totalLines: number;
}

export const share = (part: number, whole: number): number | null => (whole === 0 ? null : Number((part / whole).toFixed(3)));

/** The highest final score of a pull request; 0 when it has no files. */
export const highestScore = (scores: readonly ScoredFile[]): number => Math.max(0, ...scores.map((f) => f.finalScore));

const fileFlagged = (f: ScoredFile, t: number): boolean => (f.fileLevel?.score ?? 0) >= t;

/** Whether `measure` flags a block for a person at `t`: its file's whole-file level, or its own score, at or above `t`. */
export function blockFlagged(file: ScoredFile, block: ScoredBlock, t: number): boolean {
  return fileFlagged(file, t) || (block.entry?.score ?? 0) >= t;
}

/** The counts `measure` divides, at one threshold. */
export function countAt(cases: readonly CaseScores<ScoredFile>[], threshold: number | 'own'): Counts {
  const n: Counts = {
    blocks: 0, blocksLeft: 0, looseBlocks: 0, looseBlocksLeft: 0,
    files: 0, filesLeft: 0, looseFiles: 0, looseFilesLeft: 0,
    prs: 0, prsClear: 0, focusPrs: 0, flaggedLines: 0, totalLines: 0,
  };

  for (const c of cases) {
    if (c.status !== 'ok') continue;
    const t = threshold === 'own' ? c.threshold : threshold;
    n.prs += 1;
    const needsPerson = highestScore(c.scores) >= t;
    if (!needsPerson) n.prsClear += 1;
    else n.focusPrs += 1;

    for (const f of c.scores) {
      const whole = fileFlagged(f, t);
      let flaggedInFile = 0;
      for (const b of f.blocks) {
        const flagged = blockFlagged(f, b, t);
        if (flagged) flaggedInFile += b.changedLines;
        const label = c.labels.blocks.get(blockKey(f.path, b.id));
        if (label?.loose === true) { n.looseBlocks += 1; if (!flagged) n.looseBlocksLeft += 1; }
        if (label?.strict === true) { n.blocks += 1; if (!flagged) n.blocksLeft += 1; }
      }
      const label = c.labels.files.get(f.path);
      const left = f.finalScore < t;
      if (label?.loose === true) { n.looseFiles += 1; if (left) n.looseFilesLeft += 1; }
      if (label?.strict === true) { n.files += 1; if (left) n.filesLeft += 1; }
      if (needsPerson) {
        n.flaggedLines += whole ? f.changedLines : flaggedInFile;
        n.totalLines += f.changedLines;
      }
    }
  }
  return n;
}

/** Each count of `a` and `b` added: countAt of two lists of cases, added, is countAt of both. */
export function addCounts(a: Counts, b: Counts): Counts {
  return {
    blocks: a.blocks + b.blocks, blocksLeft: a.blocksLeft + b.blocksLeft,
    looseBlocks: a.looseBlocks + b.looseBlocks, looseBlocksLeft: a.looseBlocksLeft + b.looseBlocksLeft,
    files: a.files + b.files, filesLeft: a.filesLeft + b.filesLeft,
    looseFiles: a.looseFiles + b.looseFiles, looseFilesLeft: a.looseFilesLeft + b.looseFilesLeft,
    prs: a.prs + b.prs, prsClear: a.prsClear + b.prsClear, focusPrs: a.focusPrs + b.focusPrs,
    flaggedLines: a.flaggedLines + b.flaggedLines, totalLines: a.totalLines + b.totalLines,
  };
}

export function measure(cases: readonly CaseScores<ScoredFile>[], threshold: number | 'own'): Numbers {
  const c = countAt(cases, threshold);
  return {
    threshold,
    safety_blocks: share(c.blocksLeft, c.blocks), safety_blocks_n: c.blocks,
    safety_blocks_loose: share(c.looseBlocksLeft, c.looseBlocks), safety_blocks_loose_n: c.looseBlocks,
    safety_files: share(c.filesLeft, c.files), safety_files_n: c.files,
    safety_files_loose: share(c.looseFilesLeft, c.looseFiles), safety_files_loose_n: c.looseFiles,
    benefit: share(c.prsClear, c.prs), benefit_n: c.prs,
    focus: share(c.flaggedLines, c.totalLines), focus_n: c.focusPrs,
  };
}
