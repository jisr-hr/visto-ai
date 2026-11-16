import assert from 'node:assert/strict';
import test from 'node:test';
import { packBatches, unitTokens } from './batches.ts';
import type { FileContext } from './build.ts';

const text = (tokens: number): string => 'x'.repeat(tokens * 3);

function ctx(path: string, diff: number, extra: { full?: number; test?: number } = {}): FileContext {
  return {
    file: { path, previousPath: null, status: 'modified', additions: 1, deletions: 0, patch: '' },
    hunks: [],
    ranges: { RIGHT: [], LEFT: [] },
    diffText: text(diff),
    full: extra.full === undefined ? null : { kind: 'full', totalLines: 1, text: text(extra.full) },
    test: extra.test === undefined ? null : { path: `${path}.test`, text: text(extra.test) },
  };
}

test('unitTokens counts each part', () => {
  assert.deepEqual(unitTokens(ctx('a', 4, { full: 5, test: 6 })), { diff: 4, full: 5, test: 6 });
  assert.deepEqual(unitTokens({ ...ctx('a', 1), diffText: null }), { diff: 0, full: 0, test: 0 });
});
test('next-fit packing keeps priority order and never splits a file', () => {
  const { batches } = packBatches([ctx('a', 60), ctx('b', 60), ctx('c', 30)], 100, 6);
  assert.deepEqual(batches.map((b) => b.files.map((f) => f.file.path)), [['a'], ['b', 'c']]);
  assert.deepEqual(batches.map((b) => b.tokens), [60, 90]);
});
test('a unit too big for a call sheds its test, then its full file', () => {
  const { batches, audit } = packBatches([ctx('a', 40, { full: 50, test: 50 })], 100, 6);
  assert.equal(batches[0]!.files[0]!.test, null);
  assert.notEqual(batches[0]!.files[0]!.full, null);
  assert.equal(audit[0]!.action, 'test_file_cut');
  assert.deepEqual(audit[0], { stage: 'context', action: 'test_file_cut', subject: 'a', reason: 'over_call_budget' });
  const second = packBatches([ctx('a', 40, { full: 70, test: 50 })], 100, 6);
  assert.deepEqual(second.audit.map((e) => e.action), ['test_file_cut', 'full_file_cut']);
  assert.equal(second.batches[0]!.files[0]!.full, null);
});
test('packing does not mutate its input', () => {
  const input = ctx('a', 40, { full: 50, test: 50 });
  packBatches([input], 100, 6);
  assert.notEqual(input.test, null);
});
test('a diff larger than a whole call is not reviewed, and the rest is', () => {
  const { batches, notReviewed, audit } = packBatches([ctx('big.min.js', 500, { test: 5 }), ctx('b', 10)], 100, 6);
  assert.deepEqual(notReviewed, [{ path: 'big.min.js', reason: 'too_large' }]);
  assert.equal(batches[0]!.files[0]!.file.path, 'b');
  assert.deepEqual(audit, []);
});
test('files past the batch limit are named', () => {
  const { notReviewed } = packBatches([ctx('a', 90), ctx('b', 90), ctx('c', 90), ctx('d', 5)], 100, 2);
  assert.deepEqual(notReviewed, [{ path: 'c', reason: 'over_batch_limit' }, { path: 'd', reason: 'over_batch_limit' }]);
});
test('a file with no diff is named', () => {
  const none: FileContext = { ...ctx('n', 1), ranges: null, diffText: null };
  const { batches, notReviewed } = packBatches([none, ctx('b', 10)], 100, 6);
  assert.deepEqual(notReviewed, [{ path: 'n', reason: 'no_diff' }]);
  assert.equal(batches.length, 1);
});
