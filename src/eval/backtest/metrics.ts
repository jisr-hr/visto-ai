import type { FileScore } from '../../engine/score/types.ts';
import { blockKey } from './labels.ts';
import type { Labels } from './labels.ts';

export const THRESHOLDS = [20, 40, 70, 90];

export interface CaseScores { key: string; threshold: number; status: 'ok' | 'failed'; scores: FileScore[]; labels: Labels }

export interface Numbers {
  threshold: number | 'own';
  safety_blocks: number | null; safety_blocks_n: number;
  safety_blocks_loose: number | null; safety_blocks_loose_n: number;
  safety_files: number | null; safety_files_n: number;
  safety_files_loose: number | null; safety_files_loose_n: number;
  benefit: number | null; benefit_n: number;
  focus: number | null; focus_n: number;
}

export const share = (part: number, whole: number): number | null => (whole === 0 ? null : Number((part / whole).toFixed(3)));

/** The highest final score of a pull request; 0 when it has no files. */
export const highestScore = (scores: FileScore[]): number => Math.max(0, ...scores.map((f) => f.finalScore));

const fileFlagged = (f: FileScore, t: number): boolean => (f.fileLevel?.score ?? 0) >= t;

export function measure(cases: CaseScores[], threshold: number | 'own'): Numbers {
  let blocks = 0, blocksLeft = 0, looseBlocks = 0, looseBlocksLeft = 0;
  let files = 0, filesLeft = 0, looseFiles = 0, looseFilesLeft = 0;
  let prs = 0, prsClear = 0, focusPrs = 0, flaggedLines = 0, totalLines = 0;

  for (const c of cases) {
    if (c.status !== 'ok') continue;
    const t = threshold === 'own' ? c.threshold : threshold;
    prs += 1;
    const needsPerson = highestScore(c.scores) >= t;
    if (!needsPerson) prsClear += 1;
    else focusPrs += 1;

    for (const f of c.scores) {
      const whole = fileFlagged(f, t);
      let flaggedInFile = 0;
      for (const b of f.blocks) {
        const flagged = whole || (b.entry?.score ?? 0) >= t;
        if (flagged) flaggedInFile += b.changedLines;
        const label = c.labels.blocks.get(blockKey(f.path, b.id));
        if (label?.loose === true) { looseBlocks += 1; if (!flagged) looseBlocksLeft += 1; }
        if (label?.strict === true) { blocks += 1; if (!flagged) blocksLeft += 1; }
      }
      const label = c.labels.files.get(f.path);
      const left = f.finalScore < t;
      if (label?.loose === true) { looseFiles += 1; if (left) looseFilesLeft += 1; }
      if (label?.strict === true) { files += 1; if (left) filesLeft += 1; }
      if (needsPerson) {
        flaggedLines += whole ? f.changedLines : flaggedInFile;
        totalLines += f.changedLines;
      }
    }
  }

  return {
    threshold,
    safety_blocks: share(blocksLeft, blocks), safety_blocks_n: blocks,
    safety_blocks_loose: share(looseBlocksLeft, looseBlocks), safety_blocks_loose_n: looseBlocks,
    safety_files: share(filesLeft, files), safety_files_n: files,
    safety_files_loose: share(looseFilesLeft, looseFiles), safety_files_loose_n: looseFiles,
    benefit: share(prsClear, prs), benefit_n: prs,
    focus: share(flaggedLines, totalLines), focus_n: focusPrs,
  };
}
