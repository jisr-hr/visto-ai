import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileContext } from '../context/build.ts';
import { commentableRanges, parsePatch } from '../context/diff.ts';
import type { Ranges } from '../context/diff.ts';
import type { SubmitReviewArgs } from '../model/submit-review.ts';
import type { RawFinding } from '../types.ts';
import { reconcile } from './index.ts';

const ranges: Ranges = { RIGHT: [[10, 13]], LEFT: [[11, 11]] };
const raw = (path: string, line: number, extra: Partial<RawFinding> = {}): RawFinding => ({
  path, side: 'RIGHT', line, severity: 'minor', body: `note ${path}:${line}`, quote: '', beyond_diff: false, ...extra,
});
const ctxWith = (path: string, r: Ranges | null): FileContext => ({
  file: { path, previousPath: null, status: 'modified', additions: 1, deletions: 0, patch: r ? 'p' : null },
  hunks: [], ranges: r, diffText: null, full: null, test: null, skip: r ? null : 'no_diff',
  blocks: [], plan: r ? { kind: 'model' } : { kind: 'none', reason: 'no_diff' }, hidden: false,
}) as FileContext;
const ctxs = [ctxWith('src/a.ts', ranges), ctxWith('src/b.ts', ranges), ctxWith('img/logo.bin', null)];
const allFiles = ctxs.map((c) => c.file.path);
const answerIn = (files: string[], overview: string, ...findings: RawFinding[]): { value: SubmitReviewArgs; files: string[] } =>
  ({ value: { overview, findings, files: [] }, files });
const answer = (overview: string, ...findings: RawFinding[]): { value: SubmitReviewArgs; files: string[] } => answerIn(allFiles, overview, ...findings);

test('prefixes normalise; unknown paths are dropped with an audit entry', () => {
  const out = reconcile([answer('o', raw('a/src/a.ts', 12), raw('other/x.ts', 1))], ctxs);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0]!.path, 'src/a.ts');
  assert.deepEqual(out.audit, [{ stage: 'reconcile', action: 'dropped', subject: 'other/x.ts', reason: 'path_not_in_pull_request' }]);
  assert.equal(out.unplaced.length, 0);
});

test('beyond_diff items are set apart and never placed', () => {
  const item = raw('src/a.ts', 500, { beyond_diff: true });
  const out = reconcile([answer('o', item)], ctxs);
  assert.deepEqual(out.beyondDiff, [item]);
  assert.equal(out.findings.length, 0);
  assert.equal(out.unplaced.length, 0);
  assert.equal(out.audit.length, 0);
});

test('beyond_diff on a path outside the pull request is dropped', () => {
  const item = raw('nowhere.ts', 1, { beyond_diff: true });
  const out = reconcile([answer('o', item)], ctxs);
  assert.deepEqual(out.beyondDiff, []);
  assert.deepEqual(out.audit, [{ stage: 'reconcile', action: 'dropped', subject: 'nowhere.ts', reason: 'path_not_in_pull_request' }]);
});

test('a surviving beyond_diff item carries the normalised path', () => {
  const out = reconcile([answer('o', raw('b/src/a.ts', 500, { beyond_diff: true }))], ctxs);
  assert.deepEqual(out.beyondDiff, [raw('b/src/a.ts', 500, { beyond_diff: true, path: 'src/a.ts' })]);
});

test('a finding on a file of another batch is dropped', () => {
  const out = reconcile([
    answerIn(['src/a.ts'], 'o', raw('src/b.ts', 12, { severity: 'blocker' }), raw('src/b.ts', 12, { beyond_diff: true }), raw('src/a.ts', 12)),
  ], ctxs);
  assert.deepEqual(out.findings.map((f) => f.path), ['src/a.ts']);
  assert.deepEqual(out.beyondDiff, []);
  assert.deepEqual(out.audit, [
    { stage: 'reconcile', action: 'dropped', subject: 'src/b.ts', reason: 'path_not_in_batch' },
    { stage: 'reconcile', action: 'dropped', subject: 'src/b.ts', reason: 'path_not_in_batch' },
  ]);
});

test('each overview is cut to 4,000 characters before they are joined', () => {
  const out = reconcile([answer('y'.repeat(80_000)), answer('two')], ctxs);
  assert.equal(out.overview, `${'y'.repeat(3_999)}\u2026\n\ntwo`);
  assert.equal(reconcile([answer('z'.repeat(4_000))], ctxs).overview, 'z'.repeat(4_000));
});

test('overviews of several batches are joined', () => {
  assert.equal(reconcile([answer('one'), answer('two')], ctxs).overview, 'one\n\ntwo');
});

test('overviews are trimmed and empty ones skipped', () => {
  assert.equal(reconcile([answer('  one \n'), answer('   '), answer('two')], ctxs).overview, 'one\n\ntwo');
  assert.equal(reconcile([], ctxs).overview, '');
});

test('a moved finding is audited and remembers its line', () => {
  const out = reconcile([answer('o', raw('src/a.ts', 15))], ctxs);
  assert.equal(out.findings[0]!.line, 13);
  assert.equal(out.findings[0]!.requestedLine, 15);
  assert.deepEqual(out.audit, [{ stage: 'reconcile', action: 'moved', subject: 'src/a.ts:15', reason: 'to 13' }]);
});

test('a finding inside a range has no audit entry', () => {
  const out = reconcile([answer('o', raw('src/a.ts', 12))], ctxs);
  assert.equal(out.findings[0]!.requestedLine, null);
  assert.equal(out.audit.length, 0);
});

test('a file with no patch and a far line go to unplaced with the normalised path', () => {
  const out = reconcile([answer('o', raw('./img/logo.bin', 1), raw('b/src/b.ts', 99))], ctxs);
  assert.equal(out.findings.length, 0);
  assert.deepEqual(out.unplaced.map((u) => `${u.path}:${u.reason}`), ['img/logo.bin:file_has_no_patch', 'src/b.ts:line_not_in_diff']);
});

test('order follows the answers, then the findings inside each', () => {
  const out = reconcile([
    answer('o', raw('src/b.ts', 11), raw('src/a.ts', 10)),
    answer('p', raw('src/a.ts', 12)),
  ], ctxs);
  assert.deepEqual(out.findings.map((x) => `${x.path}:${x.line}`), ['src/b.ts:11', 'src/a.ts:10', 'src/a.ts:12']);
});

test('a path named like an object property is dropped, not looked up', () => {
  const out = reconcile([answer('o', raw('toString', 1))], ctxs);
  assert.equal(out.findings.length, 0);
  assert.equal(out.audit[0]!.reason, 'path_not_in_pull_request');
});

// A file with real hunks: RIGHT 10-13 and LEFT 11, as `ranges`.
const hunked = (path: string, patch: string): FileContext => {
  const hunks = parsePatch(patch);
  return { ...ctxWith(path, commentableRanges(hunks)), hunks };
};
const qPatch = '@@ -10,3 +10,4 @@\n a = 0\n-old\n+total = a + b\n+return total\n b = 1';

test('a finding moved by its quote is audited as placed_by_quote, not as moved', () => {
  const contexts = [hunked('src/q.ts', qPatch)];
  const out = reconcile([answerIn(['src/q.ts'], 'o', raw('src/q.ts', 10, { quote: 'return total' }))], contexts);
  assert.deepEqual(out.findings.map((x) => [x.path, x.side, x.line, x.requestedLine]), [['src/q.ts', 'RIGHT', 12, null]]);
  assert.deepEqual(out.audit, [{ stage: 'reconcile', action: 'placed_by_quote', subject: 'src/q.ts:RIGHT:10', reason: 'to RIGHT:12' }]);
});
