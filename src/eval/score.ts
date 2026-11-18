// Scores a replayed review against engineer-judged labels. Ported from the
// predecessor so that metric names and meanings line up between the two.
import type { Severity } from '../engine/types.ts';
import type { Side } from '../forge/types.ts';
import { caseKey } from './cases.ts';
import type { EvalCase, Label } from './cases.ts';

export { caseKey } from './cases.ts';
export type { EvalCase, Label, LabelKind } from './cases.ts';

export interface ReplayFinding { path: string; line: number; side: Side; severity: Severity; body: string }
export interface CaseResult {
  key: string; status: 'ok' | 'failed'; failure_stage: string | null; failure_reason: string | null; total_cost: number; total_tokens: number; duration_ms: number;
  calls: number; cached_tokens: number; models: string[]; unplaced: number; files_reviewed: number; not_reviewed: Record<string, number>; // count by reason
  findings: ReplayFinding[];
  highest_score: number | null; needs_human: boolean | null; // null when the case failed in the eval itself
}
export interface CaseScore { key: string; status: 'ok' | 'failed'; comment_count: number; blocking_count: number; labels: (Label & { matched: boolean; matched_severity: string })[]; unmatched: ReplayFinding[] }
export type Summary = { label: string } & Record<string, number | string | null>;

const DEFAULT_TOLERANCE = 3;

function isBlocking(severity: string): boolean {
  return severity === 'major' || severity === 'blocker';
}

export const METRICS: { name: string; better: 'higher' | 'lower' | null }[] = [
  { name: 'cases', better: null },
  { name: 'failed_cases', better: 'lower' },
  { name: 'valid_labels', better: null },
  { name: 'valid_recall', better: 'higher' },
  { name: 'valid_blocking_kept', better: 'higher' },
  { name: 'invalid_labels', better: null },
  { name: 'invalid_repeat_rate', better: 'lower' },
  { name: 'invalid_blocking_rate', better: 'lower' },
  { name: 'escaped_labels', better: null },
  { name: 'escaped_recall', better: 'higher' },
  { name: 'first_labels', better: null },
  { name: 'first_recall', better: 'higher' },
  { name: 'late_labels', better: null },
  { name: 'late_recall', better: 'higher' },
  { name: 'late_blocking_recall', better: 'higher' },
  { name: 'late_same_head_labels', better: null },
  { name: 'late_same_head_recall', better: 'higher' },
  { name: 'late_first_head_labels', better: null },
  { name: 'late_first_head_recall', better: 'higher' },
  { name: 'comments_per_case', better: null },
  { name: 'blocking_per_case', better: null },
  { name: 'zero_comment_rate', better: null },
  { name: 'total_cost', better: 'lower' },
  { name: 'median_duration_s', better: 'lower' },
];

export function eligible(finding: ReplayFinding, label: Label): boolean {
  if (finding.path !== label.path) return false;
  if (label.line === null) return true;
  if (finding.side !== label.side) return false;
  return Math.abs(finding.line - label.line) <= (label.tolerance ?? DEFAULT_TOLERANCE);
}

// One finding answers at most one label, and one label takes at most one
// finding. Among one-to-one assignments this picks one matching the most
// labels, then the smallest total line distance (a whole-file pair costs more
// than any set of line pairs), then label order, then finding order.
//
// Min-cost maximum bipartite matching by successive shortest augmenting paths:
// each round, Bellman-Ford finds the cheapest path from a free label to a free
// finding through the residual graph (an unmatched pair costs +c, giving a
// matched pair back costs -c) and flips it. Each round adds one match at the
// least extra cost. Cases are small, so the cost per round does not matter.
export function assignMatches(findings: ReplayFinding[], labels: Label[]): Map<number, number> {
  const nL = labels.length;
  const nF = findings.length;
  // distance is -1 for a whole-file pair, null when the pair is not eligible.
  const distance = labels.map((label) => findings.map((finding): number | null => {
    if (!eligible(finding, label)) return null;
    return label.line === null ? -1 : Math.abs(finding.line - label.line);
  }));
  // Integer cost tiers: distance outweighs tie order. A whole-file pair costs
  // more than every line pair of a matching combined; the tie term (label
  // index, then finding index) is smaller than one unit of distance.
  const lineDistances = distance.flat().filter((d): d is number => d !== null && d >= 0);
  const maxDistance = Math.max(0, ...lineDistances);
  const wholeFile = (maxDistance + 1) * (nL + 1);
  const tieUnit = nL * nL * Math.max(nF, 1) + 1;
  const cost: (number | null)[][] = distance.map((row, li) => row.map((d, fi) => (d === null ? null : (d < 0 ? wholeFile : d) * tieUnit + li * nF + fi)));
  const costOf = (li: number, fi: number): number | null => cost[li]![fi]!;

  const findingOf: number[] = new Array<number>(nL).fill(-1);
  const labelOf: number[] = new Array<number>(nF).fill(-1);
  for (;;) {
    // dist[li]: cheapest residual path from any free label to label li;
    // via[li]: the (label, finding) step that reached it.
    const dist: number[] = findingOf.map((fi) => (fi === -1 ? 0 : Infinity));
    const via: ([number, number] | null)[] = new Array<[number, number] | null>(nL).fill(null);
    for (let pass = 0, changed = true; changed && pass <= nL; pass += 1) {
      changed = false;
      for (let li = 0; li < nL; li += 1) {
        if (dist[li] === Infinity) continue;
        for (let fi = 0; fi < nF; fi += 1) {
          const lj = labelOf[fi]!;
          const c = costOf(li, fi);
          if (c === null || lj === -1 || lj === li) continue;
          const d = dist[li]! + c - costOf(lj, fi)!;
          if (d < dist[lj]!) { dist[lj] = d; via[lj] = [li, fi]; changed = true; }
        }
      }
    }
    // The cheapest step from a reached label to a free finding ends the path.
    let end: { li: number; fi: number; d: number } | null = null;
    for (let li = 0; li < nL; li += 1) {
      for (let fi = 0; fi < nF; fi += 1) {
        const c = costOf(li, fi);
        if (dist[li] === Infinity || c === null || labelOf[fi] !== -1) continue;
        if (!end || dist[li]! + c < end.d) end = { li, fi, d: dist[li]! + c };
      }
    }
    if (!end) break;
    // Flip the path: each label on it takes the finding after it and gives its
    // old finding to the label before it, back to a free label.
    let li = end.li;
    let fi = end.fi;
    for (;;) {
      const previous = findingOf[li]!;
      findingOf[li] = fi;
      labelOf[fi] = li;
      const step = via[li];
      if (!step) break;
      li = step[0];
      fi = previous;
    }
  }
  const matches = new Map<number, number>();
  findingOf.forEach((fi, li) => { if (fi !== -1) matches.set(li, fi); });
  return matches;
}

export function scoreCase(c: EvalCase, r: CaseResult): CaseScore {
  const matches = assignMatches(r.findings, c.labels);
  const matchedFindings = new Set(matches.values());
  return {
    key: caseKey(c),
    status: r.status,
    comment_count: r.findings.length,
    blocking_count: r.findings.filter((f) => isBlocking(f.severity)).length,
    labels: c.labels.map((label, li) => {
      const fi = matches.get(li);
      const finding = fi === undefined ? undefined : r.findings[fi];
      return { ...label, matched: finding !== undefined, matched_severity: finding ? finding.severity : '' };
    }),
    unmatched: r.findings.filter((_, fi) => !matchedFindings.has(fi)),
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator ? Number((numerator / denominator).toFixed(3)) : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Number(value.toFixed(1));
}

type ScoredLabel = CaseScore['labels'][number];

// Failed cases are counted and costed but not scored: a candidate that fails
// more often must not look more precise. failed_cases makes that visible.
export function summarize(label: string, scores: CaseScore[], results: CaseResult[]): Summary {
  const ok = scores.filter((s) => s.status === 'ok');
  const labels = ok.flatMap((s) => s.labels);
  const kind = (k: string): ScoredLabel[] => labels.filter((l) => l.label === k);
  const valid = kind('valid');
  const invalid = kind('invalid');
  const escaped = kind('escaped');
  const first = kind('first');
  const late = kind('late');
  const blocking = (ls: ScoredLabel[]): ScoredLabel[] => ls.filter((l) => isBlocking(l.severity));
  const hits = (ls: ScoredLabel[]): number => ls.filter((l) => l.matched).length;
  const blockingHits = (ls: ScoredLabel[]): number => ls.filter((l) => l.matched && isBlocking(l.matched_severity)).length;
  const validBlocking = blocking(valid);
  const lateBlocking = blocking(late);
  const lateSameHead = late.filter((l) => l.same_head === true);
  const lateFirstHead = late.filter((l) => l.first_head === true);
  return {
    label,
    cases: scores.length,
    failed_cases: scores.length - ok.length,
    valid_labels: valid.length,
    valid_recall: rate(hits(valid), valid.length),
    valid_blocking_kept: rate(blockingHits(validBlocking), validBlocking.length),
    invalid_labels: invalid.length,
    invalid_repeat_rate: rate(hits(invalid), invalid.length),
    invalid_blocking_rate: rate(blockingHits(invalid), invalid.length),
    escaped_labels: escaped.length,
    escaped_recall: rate(hits(escaped), escaped.length),
    first_labels: first.length,
    first_recall: rate(hits(first), first.length),
    late_labels: late.length,
    late_recall: rate(hits(late), late.length),
    late_blocking_recall: rate(blockingHits(lateBlocking), lateBlocking.length),
    late_same_head_labels: lateSameHead.length,
    late_same_head_recall: rate(hits(lateSameHead), lateSameHead.length),
    late_first_head_labels: lateFirstHead.length,
    late_first_head_recall: rate(hits(lateFirstHead), lateFirstHead.length),
    comments_per_case: rate(ok.reduce((n, s) => n + s.comment_count, 0), ok.length),
    blocking_per_case: rate(ok.reduce((n, s) => n + s.blocking_count, 0), ok.length),
    zero_comment_rate: rate(ok.filter((s) => s.comment_count === 0).length, ok.length),
    total_cost: Number(results.reduce((n, r) => n + r.total_cost, 0).toFixed(4)),
    median_duration_s: median(results.filter((r) => r.status === 'ok').map((r) => r.duration_ms / 1000)),
  };
}
