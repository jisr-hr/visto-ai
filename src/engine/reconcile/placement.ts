import type { Range, Ranges } from '../context/diff.ts';
import type { Finding, RawFinding, UnplacedFinding } from '../types.ts';

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

export function place(f: RawFinding, ranges: Ranges | null): { placed: Finding } | { unplaced: UnplacedFinding } {
  const rest = { path: f.path, side: f.side, line: f.line, severity: f.severity, body: f.body, quote: f.quote };
  if (ranges === null) return { unplaced: { ...rest, reason: 'file_has_no_patch' } };
  const own = ranges[f.side];
  if (inRanges(own, f.line)) return { placed: { ...rest, requestedLine: null } };
  const edge = nearestEdge(own, f.line);
  if (edge === null) return { unplaced: { ...rest, reason: 'line_not_in_diff' } };
  return { placed: { ...rest, line: edge, requestedLine: f.line } };
}
