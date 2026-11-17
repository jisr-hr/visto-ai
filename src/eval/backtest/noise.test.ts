import assert from 'node:assert/strict';
import test from 'node:test';

import { A, B, block, C, file, labels } from './test-cases.ts';
import type { CaseScores } from './metrics.ts';
import { scoreNoise } from './noise.ts';

const A2: CaseScores = { ...A, scores: [file('a.ts', [block('B1', 60, 10), block('B2', 30, 5)], 15)] };

test('noise: a hunk that crosses the threshold between runs is a flip', () => {
  const rows = scoreNoise([A, B, C], [A2, B, C], [70]);
  assert.equal(rows[0]!.threshold, 70);
  assert.equal(rows[0]!.blocks_n, 6);
  assert.equal(rows[0]!.blocks_flipped, 0.167);
  assert.equal(rows[0]!.prs_n, 3);
  assert.equal(rows[0]!.prs_flipped, 0.333);
});

test('noise: a hunk split in one run and whole in the other is still one hunk', () => {
  const split: CaseScores = { ...A, scores: [file('s.ts', [block('B1.1', 30, 20, 'B1'), block('B1.2', 80, 20, 'B1')], 40)] };
  const whole: CaseScores = { ...A, scores: [file('s.ts', [block('B1', 75, 40)], 40)] };
  const rows = scoreNoise([split], [whole], [70]);
  assert.equal(rows[0]!.blocks_n, 1);
  assert.equal(rows[0]!.blocks_flipped, 0);
  assert.equal(rows[0]!.prs_flipped, 0);
});

test('noise: a hunk in one run only is left out, and a file with no blocks only moves the pull request', () => {
  const one: CaseScores = { ...A, scores: [file('a.ts', [block('B1', 80, 10)], 10), file('w.ts', [], 0, 50)] };
  const two: CaseScores = { ...A, scores: [file('a.ts', [block('B1', 80, 10), block('B2', 90, 5)], 15)] };
  const rows = scoreNoise([one], [two], [70]);
  assert.equal(rows[0]!.blocks_n, 1);
  assert.equal(rows[0]!.blocks_flipped, 0);
  assert.equal(rows[0]!.prs_n, 1);
});

test('noise: a file level score counts in a hunk, and failed cases and unmatched keys are left out', () => {
  const low: CaseScores = { ...A, scores: [file('a.ts', [block('B1', 10, 3)], 3, 20)], labels: labels([]) };
  const high: CaseScores = { ...low, scores: [file('a.ts', [block('B1', 10, 3)], 3, 90)] };
  const rows = scoreNoise([low, { ...B, status: 'failed' }, { ...C, key: 'only-a' }], [high, B, { ...C, key: 'only-b' }], [70]);
  assert.equal(rows[0]!.blocks_n, 1);
  assert.equal(rows[0]!.blocks_flipped, 1);
  assert.equal(rows[0]!.prs_n, 1);
  assert.equal(rows[0]!.prs_flipped, 1);
});

test('noise: nothing to compare gives null', () => {
  const rows = scoreNoise([], [], [20, 40]);
  assert.deepEqual(rows, [
    { threshold: 20, blocks_flipped: null, blocks_n: 0, prs_flipped: null, prs_n: 0 },
    { threshold: 40, blocks_flipped: null, blocks_n: 0, prs_flipped: null, prs_n: 0 },
  ]);
});
