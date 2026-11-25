import type { Hunk } from './diff.ts';

export interface FullFile { kind: 'full' | 'excerpt'; totalLines: number; text: string }

const MAX_FULL_LINES = 1200;
const MARGIN = 150;

export function numberLines(text: string, firstLine = 1): string {
  return text
    .split('\n')
    .map((line, i) => `${String(firstLine + i).padStart(6)}| ${line}`)
    .join('\n');
}

function excerptRanges(hunks: Hunk[], total: number): Array<[number, number]> {
  const widened = hunks
    .map((h): [number, number] => [
      Math.max(1, h.newStart - MARGIN),
      Math.min(total, h.newStart + Math.max(h.newLength, 1) - 1 + MARGIN),
    ])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of widened) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const NUMBERED_ROW = /^ *(\d+)\| ([^\n]*)$/;

/** The lines a full file or its excerpts show, by line number, read back from the numbered text. */
export function fullFileLines(full: FullFile): Map<number, string> {
  const lines = new Map<number, string>();
  for (const row of full.text.split('\n')) {
    const match = NUMBERED_ROW.exec(row);
    if (match !== null) lines.set(Number(match[1]), match[2]!);
  }
  return lines;
}

export function fullFileContext(content: string, hunks: Hunk[]): FullFile | null {
  const lines = content.replace(/\n$/, '').split('\n');
  const totalLines = lines.length;
  if (totalLines <= MAX_FULL_LINES) {
    return { kind: 'full', totalLines, text: numberLines(lines.join('\n')) };
  }
  const ranges = excerptRanges(hunks, totalLines);
  if (ranges.length === 0) return null;
  const sections = ranges.map(
    ([start, end]) =>
      `@@ lines ${start}-${end} of ${totalLines} @@\n${numberLines(lines.slice(start - 1, end).join('\n'), start)}`,
  );
  return { kind: 'excerpt', totalLines, text: sections.join('\n...\n') };
}
