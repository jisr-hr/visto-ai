import assert from 'node:assert/strict';
import test from 'node:test';

import { measure } from './metrics.ts';
import type { CaseScores } from './metrics.ts';
import { A, B, block, C, file, labels, strict } from './test-cases.ts';

test('at 70', () => {
  const n = measure([A, B, C], 70);
  assert.equal(n.threshold, 70);
  assert.equal(n.safety_blocks_n, 2);
  assert.equal(n.safety_blocks, 0.5);
  assert.equal(n.safety_blocks_loose_n, 3);
  assert.equal(n.safety_blocks_loose, 0.667);
  assert.equal(n.safety_files_n, 2);
  assert.equal(n.safety_files, 0); // A's file reaches 80 and C's is floored to 100
  assert.equal(n.safety_files_loose_n, 3);
  assert.equal(n.safety_files_loose, 0.333); // only B's file stays under 70
  assert.equal(n.benefit, 0.333);
  assert.equal(n.benefit_n, 3);
  assert.equal(n.focus_n, 2);
});

test('at 40, B needs a person and its labelled block is flagged', () => {
  const n = measure([A, B, C], 40);
  assert.equal(n.benefit, 0);
  assert.equal(n.safety_blocks, 0.5);
  assert.equal(n.safety_blocks_loose_n, 3);
  assert.equal(n.safety_blocks_loose, 0.333);
  assert.equal(n.focus_n, 3);
});

test('focus counts all lines of a file flagged as a whole', () => {
  // A flags its 10-line block of 15; C flags its floored file's 8 lines of 20. 18 of 35.
  const n = measure([A, B, C], 70);
  assert.equal(n.focus, 0.514);
});

test('own uses each case threshold', () => {
  const n = measure([A, B, C], 'own');
  assert.equal(n.threshold, 'own');
  assert.equal(n.benefit, 0);
  assert.equal(n.focus_n, 3);
  assert.equal(n.focus, 0.509); // 10 + 8 + 10 of 55
  assert.equal(n.safety_blocks_loose, 0.333); // B's labelled block is flagged at its own 40
});

test('a failed case is left out, and an empty count gives null', () => {
  const n = measure([{ ...A, status: 'failed' }], 70);
  for (const [k, v] of Object.entries(n)) {
    if (k === 'threshold') continue;
    if (k.endsWith('_n')) assert.equal(v, 0, k);
    else assert.equal(v, null, k);
  }
});

test('a pull request with no files does not need a person', () => {
  const empty: CaseScores = { key: 'e', threshold: 70, status: 'ok', scores: [], labels: labels([]) };
  const n = measure([empty], 70);
  assert.equal(n.benefit, 1);
  assert.equal(n.focus_n, 0);
  assert.equal(n.focus, null);
});

test('a block with no score of its own is measured as 0 unless its file is flagged', () => {
  const c: CaseScores = {
    key: 'n', threshold: 70, status: 'ok',
    scores: [file('n.ts', [block('B1', null, 4)], 4), file('f.ts', [block('B1', null, 6)], 6, 100)],
    labels: labels([['n.ts', 'B1', strict], ['f.ts', 'B1', strict]]),
  };
  const n = measure([c], 70);
  assert.equal(n.safety_blocks_n, 2);
  assert.equal(n.safety_blocks, 0.5);
  assert.equal(n.focus, 0.6);
});
