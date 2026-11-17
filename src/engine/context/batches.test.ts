import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens, packBatches, unitTokens } from './batches.ts';
import type { FileContext } from './build.ts';
import { fileSection } from './section.ts';

const text = (tokens: number): string => 'x'.repeat(tokens * 3);

function ctx(path: string, diff: number, extra: { full?: number; test?: number } = {}): FileContext {
  return {
    file: { path, previousPath: null, status: 'modified', additions: 1, deletions: 0, patch: '' },
    hunks: [],
    ranges: { RIGHT: [], LEFT: [] },
    diffText: text(diff),
    full: extra.full === undefined ? null : { kind: 'full', totalLines: 1, text: text(extra.full) },
    test: extra.test === undefined ? null : { path: `${path}.test`, text: text(extra.test) },
    skip: null,
    blocks: [],
    plan: { kind: 'model' },
  };
}

// The size of a section beyond its texts: heading, status lines and wrappers.
const overhead = unitTokens(ctx('a', 0));

test('unitTokens is the size of the rendered section, with a 16-character marker', () => {
  const c = ctx('a', 4, { full: 5, test: 6 });
  assert.equal(unitTokens(c), estimateTokens(`${fileSection(c, 9999, 9999, '0123456789abcdef')}\n\n`));
  assert.ok(unitTokens(c) > 4 + 5 + 6);
  assert.ok(unitTokens({ ...c, test: null }) < unitTokens(c));
});
test('next-fit packing keeps priority order and never splits a file', () => {
  const budget = 2 * overhead + 100;
  const { batches } = packBatches([ctx('a', 60), ctx('b', 60), ctx('c', 30)], budget, 6);
  assert.deepEqual(batches.map((b) => b.files.map((f) => f.file.path)), [['a'], ['b', 'c']]);
  assert.deepEqual(batches.map((b) => b.tokens), [unitTokens(ctx('a', 60)), unitTokens(ctx('b', 60)) + unitTokens(ctx('c', 30))]);
});
test('a unit too big for a call sheds its test, then its full file', () => {
  const budget = unitTokens(ctx('a', 40, { full: 50 }));
  const { batches, audit } = packBatches([ctx('a', 40, { full: 50, test: 50 })], budget, 6);
  assert.equal(batches[0]!.files[0]!.test, null);
  assert.notEqual(batches[0]!.files[0]!.full, null);
  assert.deepEqual(audit, [{ stage: 'context', action: 'test_file_cut', subject: 'a', reason: 'over_call_budget' }]);
  const second = packBatches([ctx('a', 40, { full: 70, test: 50 })], budget, 6);
  assert.deepEqual(second.audit.map((e) => e.action), ['test_file_cut', 'full_file_cut']);
  assert.equal(second.batches[0]!.files[0]!.full, null);
});
test('packing does not mutate its input', () => {
  const input = ctx('a', 40, { full: 50, test: 50 });
  packBatches([input], unitTokens(ctx('a', 40)), 6);
  assert.notEqual(input.test, null);
});
test('a diff larger than a whole call is not reviewed, and the rest is', () => {
  const { batches, notReviewed, audit } = packBatches([ctx('big.min.js', 500, { test: 5 }), ctx('b', 10)], overhead + 100, 6);
  assert.deepEqual(notReviewed, [{ path: 'big.min.js', reason: 'too_large' }]);
  assert.equal(batches[0]!.files[0]!.file.path, 'b');
  assert.deepEqual(audit, []);
});
test('files past the batch limit are named', () => {
  const budget = overhead + 100;
  const { notReviewed } = packBatches([ctx('a', 90), ctx('b', 90), ctx('c', 90), ctx('d', 5)], budget, 2);
  assert.deepEqual(notReviewed, [{ path: 'c', reason: 'over_batch_limit' }, { path: 'd', reason: 'over_batch_limit' }]);
});
test('a file skipped for no diff or for size is named with that reason', () => {
  const none: FileContext = { ...ctx('n', 1), ranges: null, diffText: null, skip: 'no_diff', plan: { kind: 'none', reason: 'no_diff' } };
  const huge: FileContext = { ...ctx('h', 1), ranges: null, diffText: null, skip: 'too_large', plan: { kind: 'none', reason: 'too_large' } };
  const { batches, notReviewed, audit } = packBatches([none, huge, ctx('b', 10)], overhead + 100, 6);
  assert.deepEqual(notReviewed, [{ path: 'n', reason: 'no_diff' }, { path: 'h', reason: 'too_large' }]);
  assert.deepEqual(audit, []);
  assert.equal(batches.length, 1);
});
test('an unchanged file is audited once and is not listed as not reviewed', () => {
  const same: FileContext = { ...ctx('s', 1), ranges: null, diffText: null, skip: 'unchanged', plan: { kind: 'none', reason: 'unchanged' } };
  const { batches, notReviewed, audit } = packBatches([same, ctx('b', 10)], overhead + 100, 6);
  assert.deepEqual(notReviewed, []);
  assert.deepEqual(audit, [{ stage: 'context', action: 'skipped', subject: 's', reason: 'unchanged' }]);
  assert.deepEqual(batches.map((b) => b.files.map((f) => f.file.path)), [['b']]);
});
