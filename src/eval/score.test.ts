import assert from 'node:assert/strict';
import test from 'node:test';

import type { Side } from '../forge/types.ts';
import type { Severity } from '../engine/types.ts';
import type { CaseResult, EvalCase, Label, LabelKind, ReplayFinding } from './score.ts';
import { METRICS, assignMatches, eligible, scoreCase, summarize } from './score.ts';

const HEAD = 'd'.repeat(40);

function fnd(side: Side, line: number, severity: Severity = 'major', path = 'a.ts'): ReplayFinding {
  return { path, line, side, severity, body: 'text' };
}
function lbl(side: Side, line: number | null, kind: LabelKind = 'valid', extra: Partial<Label> = {}): Label {
  return { comment_id: '', path: 'a.ts', line, side, severity: 'major', label: kind, ...extra };
}
function mkCase(labels: Label[], pr = 1): EvalCase {
  return { repo: 'acme/shop', pr_number: pr, head_sha: HEAD, compare_base: 'e'.repeat(40), title: '', body: '', branch: '', base_branch: '', author: '', labels };
}
function ok(findings: ReplayFinding[], extra: Partial<CaseResult> = {}): CaseResult {
  return { key: 'k', status: 'ok', failure_stage: null, failure_reason: null, total_cost: 0, total_tokens: 0, duration_ms: 0, findings, ...extra };
}
function failed(cost: number): CaseResult {
  return ok([], { status: 'failed', failure_stage: 'model', failure_reason: 'timeout', total_cost: cost });
}
function run(c: EvalCase, r: CaseResult) {
  return { score: scoreCase(c, r), result: r };
}
function sum(entries: ReturnType<typeof run>[]) {
  return summarize('x', entries.map((e) => e.score), entries.map((e) => e.result));
}

test('tolerance is three lines, inclusive; side must match', () => {
  assert.equal(eligible(fnd('RIGHT', 13), lbl('RIGHT', 10)), true);
  assert.equal(eligible(fnd('RIGHT', 14), lbl('RIGHT', 10)), false);
  assert.equal(eligible(fnd('RIGHT', 7), lbl('RIGHT', 10)), true);
  assert.equal(eligible(fnd('LEFT', 10), lbl('RIGHT', 10)), false);
  assert.equal(eligible(fnd('RIGHT', 10, 'major', 'b.ts'), lbl('RIGHT', 10)), false);
});

test('a label tolerance overrides the default', () => {
  assert.equal(eligible(fnd('RIGHT', 15), lbl('RIGHT', 10, 'valid', { tolerance: 5 })), true);
  assert.equal(eligible(fnd('RIGHT', 11), lbl('RIGHT', 10, 'valid', { tolerance: 0 })), false);
});

test('a label with no line matches anywhere in its file', () => {
  assert.equal(eligible(fnd('LEFT', 999), { ...lbl('RIGHT', 10), line: null }), true);
  assert.equal(eligible(fnd('LEFT', 999, 'major', 'z.ts'), { ...lbl('RIGHT', 10), line: null }), false);
});

test('more matches beats nearer matches', () => {
  // labels at 10 and 13; findings at 12 and 14: nearest-first would strand one label
  assert.equal(assignMatches([fnd('RIGHT', 12), fnd('RIGHT', 14)], [lbl('RIGHT', 10), lbl('RIGHT', 13)]).size, 2);
  const m = assignMatches([fnd('RIGHT', 12), fnd('RIGHT', 14)], [lbl('RIGHT', 10), lbl('RIGHT', 13)]);
  assert.deepEqual([...m], [[0, 0], [1, 1]]);
});

test('one finding per label: the nearer label wins', () => {
  const labels = [lbl('RIGHT', 12, 'valid'), lbl('RIGHT', 13, 'invalid')];
  const m = assignMatches([fnd('RIGHT', 12)], labels);
  assert.deepEqual([...m], [[0, 0]]);
  const s = sum([run(mkCase(labels), ok([fnd('RIGHT', 12)]))]);
  assert.equal(s.valid_recall, 1);
  assert.equal(s.invalid_repeat_rate, 0);
});

test('whole-file labels take what the line labels leave', () => {
  const labels = [lbl('RIGHT', 12), lbl('RIGHT', 13, 'invalid'), lbl('RIGHT', null, 'escaped')];
  const sc = scoreCase(mkCase(labels), ok([fnd('RIGHT', 14, 'minor'), fnd('RIGHT', 11)]));
  assert.deepEqual(sc.labels.map((l) => [l.matched, l.matched_severity]), [[true, 'major'], [true, 'minor'], [false, '']]);
});

test('ties go to the lower label index, then the lower finding index', () => {
  // one finding at 11, labels at 10 and 12 are both distance 1: the lower label wins
  assert.deepEqual([...assignMatches([fnd('RIGHT', 11)], [lbl('RIGHT', 10), lbl('RIGHT', 12)])], [[0, 0]]);
  // one label at 11, findings at 10 and 12: the lower finding wins
  assert.deepEqual([...assignMatches([fnd('RIGHT', 10), fnd('RIGHT', 12)], [lbl('RIGHT', 11)])], [[0, 0]]);
  // two whole-file labels, one finding: the lower label wins
  assert.deepEqual([...assignMatches([fnd('RIGHT', 1)], [lbl('RIGHT', null), lbl('RIGHT', null)])], [[0, 0]]);
});

test('scoreCase reports counts, labels, unmatched findings in order', () => {
  const labels = [lbl('RIGHT', 12, 'valid', { comment_id: 'a' }), lbl('RIGHT', 40, 'invalid', { comment_id: 'b' }), lbl('RIGHT', null, 'escaped', { path: 'b.ts', comment_id: 'c' })];
  const findings = [fnd('RIGHT', 13), fnd('RIGHT', 41, 'minor'), fnd('RIGHT', 1, 'blocker', 'c.ts'), fnd('RIGHT', 90, 'minor', 'a.ts')];
  const sc = scoreCase(mkCase(labels), ok(findings));
  assert.equal(sc.status, 'ok');
  assert.equal(sc.comment_count, 4);
  assert.equal(sc.blocking_count, 2);
  assert.deepEqual(sc.labels.map((l) => [l.comment_id, l.matched, l.matched_severity]), [['a', true, 'major'], ['b', true, 'minor'], ['c', false, '']]);
  assert.deepEqual(sc.unmatched, [findings[2], findings[3]]);
});

test('blocking recall needs a blocking match', () => {
  const c = mkCase([lbl('RIGHT', 5, 'valid'), lbl('RIGHT', 50, 'late')]);
  const s = sum([run(c, ok([fnd('RIGHT', 5, 'minor'), fnd('RIGHT', 50, 'minor')]))]);
  assert.equal(s.valid_recall, 1);
  assert.equal(s.valid_blocking_kept, 0);
  assert.equal(s.late_recall, 1);
  assert.equal(s.late_blocking_recall, 0);
  const t = sum([run(c, ok([fnd('RIGHT', 5, 'blocker'), fnd('RIGHT', 50, 'major')]))]);
  assert.equal(t.valid_blocking_kept, 1);
  assert.equal(t.late_blocking_recall, 1);
});

test('a minor label is outside the blocking denominators', () => {
  const c = mkCase([lbl('RIGHT', 5, 'valid', { severity: 'minor' })]);
  const s = sum([run(c, ok([fnd('RIGHT', 5)]))]);
  assert.equal(s.valid_recall, 1);
  assert.equal(s.valid_blocking_kept, null);
});

test('invalid labels: repeat rate and blocking rate', () => {
  const c = mkCase([lbl('RIGHT', 5, 'invalid'), lbl('RIGHT', 50, 'invalid'), lbl('RIGHT', 90, 'invalid')]);
  const s = sum([run(c, ok([fnd('RIGHT', 5, 'major'), fnd('RIGHT', 50, 'minor')]))]);
  assert.equal(s.invalid_labels, 3);
  assert.equal(s.invalid_repeat_rate, 0.667);
  assert.equal(s.invalid_blocking_rate, 0.333);
});

test('failed cases are counted and costed but not scored', () => {
  const c = mkCase([lbl('RIGHT', 5, 'valid')]);
  const good = run(c, ok([fnd('RIGHT', 5)], { total_cost: 0.1, duration_ms: 60_000 }));
  const bad = run(c, failed(0.05));
  const s = sum([good, bad]);
  assert.equal(s.cases, 2);
  assert.equal(s.failed_cases, 1);
  assert.equal(s.total_cost, 0.15);
  assert.equal(s.valid_labels, 1);
  assert.equal(s.valid_recall, 1);
  assert.equal(s.comments_per_case, 1);
  assert.equal(s.median_duration_s, 60);
});

test('a failed case scores no labels and no findings', () => {
  const sc = scoreCase(mkCase([lbl('RIGHT', 5)]), failed(0));
  assert.equal(sc.status, 'failed');
  assert.equal(sc.comment_count, 0);
});

test('first and late recall are separate; late subsets by same_head and first_head', () => {
  const c = mkCase([
    lbl('RIGHT', 5, 'first'),
    lbl('RIGHT', 40, 'late', { same_head: true, first_head: true }),
    lbl('RIGHT', 80, 'late', { same_head: true }),
    lbl('RIGHT', 120, 'late', { same_head: false, first_head: false }),
    lbl('RIGHT', 160, 'escaped'),
  ]);
  const s = sum([run(c, ok([fnd('RIGHT', 5), fnd('RIGHT', 40), fnd('RIGHT', 120)]))]);
  assert.equal(s.first_labels, 1);
  assert.equal(s.first_recall, 1);
  assert.equal(s.late_labels, 3);
  assert.equal(s.late_recall, 0.667);
  assert.equal(s.late_same_head_labels, 2);
  assert.equal(s.late_same_head_recall, 0.5);
  assert.equal(s.late_first_head_labels, 1);
  assert.equal(s.late_first_head_recall, 1);
  assert.equal(s.escaped_labels, 1);
  assert.equal(s.escaped_recall, 0);
});

test('per-case rates, median duration and cost rounding', () => {
  const c = mkCase([]);
  const s = sum([
    run(c, ok([], { duration_ms: 10_000, total_cost: 0.12345 })),
    run(c, ok([fnd('RIGHT', 1, 'major'), fnd('RIGHT', 2, 'minor'), fnd('RIGHT', 3, 'blocker')], { duration_ms: 25_000, total_cost: 0.1 })),
    run(c, ok([fnd('RIGHT', 1, 'minor')], { duration_ms: 31_000, total_cost: 0 })),
  ]);
  assert.equal(s.comments_per_case, 1.333);
  assert.equal(s.blocking_per_case, 0.667);
  assert.equal(s.zero_comment_rate, 0.333);
  assert.equal(s.median_duration_s, 25);
  assert.equal(s.total_cost, 0.2235);
  const even = sum([run(c, ok([], { duration_ms: 1_000 })), run(c, ok([], { duration_ms: 2_000 }))]);
  assert.equal(even.median_duration_s, 1.5);
});

test('a rate with nothing to divide by is null', () => {
  const s = summarize('x', [], []);
  assert.equal(s.valid_recall, null);
  assert.equal(s.comments_per_case, null);
  assert.equal(s.median_duration_s, null);
  assert.equal(s.cases, 0);
  assert.equal(s.total_cost, 0);
  assert.equal(s.label, 'x');
});

test('METRICS lists every summary field, in order, with its direction', () => {
  assert.deepEqual(METRICS.map((m) => m.name), [
    'cases', 'failed_cases', 'valid_labels', 'valid_recall', 'valid_blocking_kept',
    'invalid_labels', 'invalid_repeat_rate', 'invalid_blocking_rate',
    'escaped_labels', 'escaped_recall', 'first_labels', 'first_recall',
    'late_labels', 'late_recall', 'late_blocking_recall',
    'late_same_head_labels', 'late_same_head_recall', 'late_first_head_labels', 'late_first_head_recall',
    'comments_per_case', 'blocking_per_case', 'zero_comment_rate', 'total_cost', 'median_duration_s',
  ]);
  const dir = Object.fromEntries(METRICS.map((m) => [m.name, m.better]));
  assert.equal(dir.failed_cases, 'lower');
  assert.equal(dir.valid_recall, 'higher');
  assert.equal(dir.invalid_repeat_rate, 'lower');
  assert.equal(dir.comments_per_case, null);
  assert.equal(dir.cases, null);
  assert.equal(dir.total_cost, 'lower');
  const s = sum([run(mkCase([]), ok([]))]);
  for (const m of METRICS) assert.ok(m.name in s, m.name);
});

// Deterministic PRNG (mulberry32): the property test is the same on every run.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every one-to-one assignment: the most matched labels and, among those, the
// smallest total line distance of line labels.
function bruteForce(findings: ReplayFinding[], labels: Label[]): { count: number; distance: number } {
  let best = { count: -1, distance: Infinity };
  const used = new Set<number>();
  const walk = (i: number, count: number, distance: number): void => {
    if (i === labels.length) {
      if (count > best.count || (count === best.count && distance < best.distance)) best = { count, distance };
      return;
    }
    walk(i + 1, count, distance);
    const label = labels[i]!;
    findings.forEach((f, fi) => {
      if (used.has(fi) || !eligible(f, label)) return;
      used.add(fi);
      walk(i + 1, count + 1, distance + (label.line === null ? 0 : Math.abs(f.line - label.line)));
      used.delete(fi);
    });
  };
  walk(0, 0, 0);
  return best;
}

test('assignMatches finds a maximum matching, then the closest one (property, fixed seed)', () => {
  const rand = prng(20261001);
  const pick = (n: number): number => Math.floor(rand() * n);
  for (let round = 0; round < 300; round += 1) {
    const labels = Array.from({ length: 1 + pick(5) }, (_, i): Label => lbl(
      pick(5) ? 'RIGHT' : 'LEFT', pick(6) ? 1 + pick(12) : null, 'valid',
      { comment_id: String(i), path: pick(4) ? 'a.ts' : 'b.ts', ...(pick(3) === 0 ? { tolerance: pick(5) } : {}) },
    ));
    const findings = Array.from({ length: pick(6) }, () => fnd(pick(5) ? 'RIGHT' : 'LEFT', 1 + pick(12), 'major', pick(4) ? 'a.ts' : 'b.ts'));
    const matches = assignMatches(findings, labels);
    const chosen = [...matches.values()];
    assert.equal(new Set(chosen).size, chosen.length, `round ${round}: a finding used twice`);
    let distance = 0;
    for (const [li, fi] of matches) {
      const label = labels[li]!;
      const f = findings[fi]!;
      assert.ok(eligible(f, label), `round ${round}: ineligible pair`);
      if (label.line !== null) distance += Math.abs(f.line - label.line);
    }
    const best = bruteForce(findings, labels);
    assert.equal(chosen.length, best.count, `round ${round}: matched ${chosen.length}, maximum is ${best.count}`);
    // Whole-file labels go last, so only line-only rounds pin the distance.
    if (labels.every((l) => l.line !== null)) assert.equal(distance, best.distance, `round ${round}: distance`);
  }
});
