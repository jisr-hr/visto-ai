import type { LineTexts, Range, Ranges } from '../context/diff.ts';
import type { Finding, RawFinding, Side, UnplacedFinding } from '../types.ts';

const SNAP_WINDOW = 3;
const PATH_PREFIXES = [/^\.\//, /^\//, /^[ab]\//];

/** The path as the pull request knows it, or null when none matches. `known` is a Set, so inherited properties never match. */
export function normalizePath(path: string, known: ReadonlySet<string>): string | null {
  if (known.has(path)) return path;
  for (const prefix of PATH_PREFIXES) {
    const stripped = path.replace(prefix, '');
    if (stripped !== path && known.has(stripped)) return stripped;
  }
  return null;
}

function inRanges(ranges: Range[], line: number): boolean {
  return ranges.some(([start, end]) => line >= start && line <= end);
}

/** The nearest range edge within SNAP_WINDOW of a line outside every range, or null. The earlier range wins a tie. */
function nearestEdge(ranges: Range[], line: number): number | null {
  let best: number | null = null;
  let bestDistance = SNAP_WINDOW + 1;
  for (const [start, end] of ranges) {
    const candidate = line < start ? start : end;
    const distance = Math.abs(candidate - line);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Every commentable line whose text is the quote, both trimmed: RIGHT first, each side in line order. None for a blank quote. */
export function quoteMatches(quote: string, texts: LineTexts): { side: Side; line: number }[] {
  const wanted = quote.trim();
  if (wanted === '') return [];
  const matches: { side: Side; line: number }[] = [];
  for (const side of ['RIGHT', 'LEFT'] as const) {
    const lines = [...texts[side].entries()].filter(([, text]) => text.trim() === wanted).map(([line]) => line);
    for (const line of lines.sort((a, b) => a - b)) matches.push({ side, line });
  }
  return matches;
}

const OTHER_SIDE: Record<Side, Side> = { RIGHT: 'LEFT', LEFT: 'RIGHT' };

/** The line of `lines` nearest `to`; the earlier on a tie. `lines` is in ascending order and not empty. */
function nearestLine(lines: number[], to: number): number {
  let best = lines[0]!;
  for (const line of lines) if (Math.abs(line - to) < Math.abs(best - to)) best = line;
  return best;
}

export type Placement = { placed: Finding; how: 'as_given' | 'quote' | 'line' } | { unplaced: UnplacedFinding };

/**
 * The quote decides first: a given line whose text is the quote is kept; otherwise the nearest line of the
 * file whose text is the quote, on the finding's side and then on the other. Only then the line rules.
 */
export function place(f: RawFinding, ranges: Ranges | null, texts: LineTexts | null = null): Placement {
  const rest = { path: f.path, side: f.side, line: f.line, severity: f.severity, body: f.body, quote: f.quote };
  if (ranges === null) return { unplaced: { ...rest, reason: 'file_has_no_patch' } };
  if (texts !== null && f.quote.trim() !== '') {
    if (texts[f.side].get(f.line)?.trim() === f.quote.trim()) return { placed: { ...rest, requestedLine: null }, how: 'as_given' };
    const matches = quoteMatches(f.quote, texts);
    for (const side of [f.side, OTHER_SIDE[f.side]]) {
      const lines = matches.filter((m) => m.side === side).map((m) => m.line);
      if (lines.length > 0) return { placed: { ...rest, side, line: nearestLine(lines, f.line), requestedLine: null }, how: 'quote' };
    }
  }
  const own = ranges[f.side];
  if (inRanges(own, f.line)) return { placed: { ...rest, requestedLine: null }, how: 'line' };
  const edge = nearestEdge(own, f.line);
  if (edge === null) return { unplaced: { ...rest, reason: 'line_not_in_diff' } };
  return { placed: { ...rest, line: edge, requestedLine: f.line }, how: 'line' };
}
