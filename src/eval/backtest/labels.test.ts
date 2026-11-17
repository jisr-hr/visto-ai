import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileContext } from '../../engine/context/build.ts';
import { parsePatch } from '../../engine/context/diff.ts';
import { reconcileScores } from '../../engine/reconcile/scores.ts';
import { blocksOf } from '../../engine/score/blocks.ts';
import { parseRepoFile } from '../../engine/score/floors.ts';
import { scorePlan } from '../../engine/score/rules.ts';
import type { FileScore } from '../../engine/score/types.ts';
import type { ChangedFile } from '../../engine/types.ts';
import type { HistoryActivity, HistoryCase } from '../history/file.ts';
import { labelCase } from './labels.ts';

// Two hunks: B1 anchors RIGHT 10-14, B2 anchors RIGHT 51-53.
const hunk1 = (changed: string) => ['@@ -10,4 +10,5 @@', ' keep', '-old one', `+${changed}`, '+new two', ' keep', ' keep'].join('\n');
const hunk2 = ['@@ -50,3 +51,3 @@', ' keep', '-old', '+new', ' keep'].join('\n');
const patchA = `${hunk1('new one')}\n${hunk2}`;
const patchB = `${hunk1('other one')}\n${hunk2}`;
const fortyAdded = ['@@ -0,0 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`)].join('\n');

function ctx(path: string, text: string, extra: Partial<ChangedFile> = {}): FileContext {
  const file: ChangedFile = { path, previousPath: null, status: 'modified', additions: 3, deletions: 1, patch: text, ...extra };
  const hunks = parsePatch(text);
  return { file, hunks, ranges: null, diffText: null, full: null, test: null, skip: null, blocks: blocksOf(hunks), plan: scorePlan(file, null) };
}

function scoresOf(files: [string, string][]): FileScore[] {
  const contexts = files.map(([path, text]) => ctx(path, text));
  const value = { overview: 'o', findings: [], files: [] };
  return reconcileScores([{ value, files: files.map(([p]) => p) }], contexts, new Set(), parseRepoFile(null)).scores;
}

const bare: Omit<HistoryCase, 'final_files' | 'activity'> = {
  version: 1, repo: 'acme/shop', pr_number: 1, title: 't', body: '', author: 'ann', branch: 'f', base_branch: 'main',
  merged_at: '2026-01-02T00:00:00Z', review_head: 'head1', review_base: 'base1', review_at: '2026-01-01T00:00:00Z',
  reviewed_by_person: true, final_head: 'head2', final_base: 'base1',
};

const note = (id: string, extra: Partial<HistoryActivity> = {}): HistoryActivity => ({
  kind: 'inline', id, author: 'bob', bot: false, association: 'member', at: '2026-01-01T01:00:00Z', body: 'x',
  commit: 'head1', path: 'src/a.ts', side: 'RIGHT', line: 11, ...extra,
});

const same = (path: string, patch: string) => ({ path, previous_path: null, status: 'modified' as const, patch });
const caseOf = (activity: HistoryActivity[], final: HistoryCase['final_files'] = [same('src/a.ts', patchA), same('src/b.ts', patchA)]): HistoryCase =>
  ({ ...bare, final_files: final, activity });
const scores = () => scoresOf([['src/a.ts', patchA], ['src/b.ts', patchA]]);
const A1 = 'src/a.ts\nB1';
const A2 = 'src/a.ts\nB2';
const none = { loose: false, strict: false };

test('a comment on a changed line of the replayed head labels its block', () => {
  const l = labelCase(caseOf([note('c1')]), scores());
  assert.equal(l.blocks.get(A1)!.loose, true);
  assert.equal(l.blocks.get(A2)!.loose, false);
  assert.equal(l.files.get('src/a.ts')!.loose, true);
  assert.equal(l.files.get('src/b.ts')!.loose, false);
  assert.deepEqual(l.comments, { counted: 1, off_head: 0, outside_diff: 0 });
  assert.equal(l.blocks.size, 4);
  assert.equal(l.files.size, 2);
});

test('a comment on a context line of a block counts', () => {
  const l = labelCase(caseOf([note('c1', { line: 51 })]), scores());
  assert.equal(l.blocks.get(A2)!.loose, true);
  assert.equal(l.blocks.get(A1)!.loose, false);
});

test('a comment on the old side matches the old lines', () => {
  const l = labelCase(caseOf([note('c1', { side: 'LEFT', line: 51 })]), scores());
  assert.equal(l.blocks.get(A2)!.loose, true);
  assert.equal(l.blocks.get(A1)!.loose, false);
});

test('a multi-line comment labels every block it touches', () => {
  const l = labelCase(caseOf([note('c1', { start_line: 12, line: 52 })]), scores());
  assert.equal(l.blocks.get(A1)!.loose, true);
  assert.equal(l.blocks.get(A2)!.loose, true);
  assert.equal(l.comments.counted, 1);
});

test('a comment on another commit counts for the file only', () => {
  const l = labelCase(caseOf([note('c1', { commit: 'head0' })]), scores());
  assert.deepEqual(l.blocks.get(A1), none);
  assert.equal(l.files.get('src/a.ts')!.loose, true);
  assert.equal(l.comments.off_head, 1);
  assert.equal(l.comments.counted, 0);
});

test('a comment on a line outside every block, and a file-level comment, count for the file only', () => {
  const l = labelCase(caseOf([note('c1', { line: 30 }), note('c2', { file_level: true, line: null }), note('c3', { path: 'src/b.ts', line: null })]), scores());
  for (const key of [A1, A2]) assert.deepEqual(l.blocks.get(key), none);
  assert.equal(l.files.get('src/a.ts')!.loose, true);
  assert.equal(l.files.get('src/b.ts')!.loose, true);
  assert.deepEqual(l.comments, { counted: 0, off_head: 0, outside_diff: 0 });
});

test('the author, a bot, and a person replying inside a bot thread do not count', () => {
  const l = labelCase(caseOf([
    note('c1', { author: 'ann' }),
    note('c2', { author: 'ci', bot: true }),
    note('c3', { path: 'src/b.ts', author: 'bob', reply_to: 'c2' }),
    { ...note('c4'), kind: 'comment' },
    { ...note('c5'), kind: 'review' },
  ]), scores());
  for (const [, v] of l.blocks) assert.deepEqual(v, none);
  for (const [, v] of l.files) assert.deepEqual(v, none);
  assert.deepEqual(l.comments, { counted: 0, off_head: 0, outside_diff: 0 });
});

test('a person replying inside a person thread counts', () => {
  const l = labelCase(caseOf([note('c1', { author: 'cat' }), note('c2', { reply_to: 'c1', line: 52 })]), scores());
  assert.equal(l.blocks.get(A2)!.loose, true);
  assert.equal(l.comments.counted, 2);
});

test('a reply deep in a bot thread does not count, a loop is treated as no bot, a missing parent is a first comment', () => {
  const l = labelCase(caseOf([
    note('c1', { author: 'ci', bot: true, line: 30 }),
    note('c2', { reply_to: 'c1', line: 30 }),
    note('c3', { reply_to: 'c2', line: 51 }),
    note('l1', { reply_to: 'l2', path: 'src/b.ts', line: 11 }),
    note('l2', { reply_to: 'l1', path: 'src/b.ts', line: 11 }),
    note('m1', { reply_to: 'gone', path: 'src/b.ts', line: 52 }),
  ]), scores());
  assert.equal(l.blocks.get(A2)!.loose, false);
  assert.equal(l.blocks.get('src/b.ts\nB1')!.loose, true);
  assert.equal(l.blocks.get('src/b.ts\nB2')!.loose, true);
  assert.equal(l.comments.counted, 3);
});

test('strict: the block changed before the merge', () => {
  const l = labelCase(
    caseOf([note('c1', { line: 11 }), note('c2', { line: 52 }), note('c3', { path: 'src/b.ts', line: 11 })], [same('src/a.ts', patchB), same('src/b.ts', patchA)]),
    scores(),
  );
  assert.deepEqual(l.blocks.get(A1), { loose: true, strict: true });
  assert.deepEqual(l.blocks.get(A2), { loose: true, strict: false });
  assert.deepEqual(l.files.get('src/a.ts'), { loose: true, strict: true });
  assert.deepEqual(l.files.get('src/b.ts'), { loose: true, strict: false });
});

test('a path missing from the final files, or with no patch, counts as changed', () => {
  const act = [note('c1'), note('c2', { path: 'src/b.ts' })];
  const missing = labelCase(caseOf(act, []), scores());
  assert.deepEqual(missing.blocks.get(A1), { loose: true, strict: true });
  assert.deepEqual(missing.files.get('src/b.ts'), { loose: true, strict: true });
  const nulled = labelCase(caseOf(act, [{ path: 'src/a.ts', previous_path: null, status: 'removed', patch: null }, same('src/b.ts', patchA)]), scores());
  assert.deepEqual(nulled.blocks.get(A1), { loose: true, strict: true });
  assert.deepEqual(nulled.files.get('src/b.ts'), { loose: true, strict: false });
});

test('a part of a split block is strict by its hunk', () => {
  const value = {
    overview: 'o', findings: [],
    files: [{ path: 'src/new.ts', change_summary: 's', blocks: [{ id: 'B1', parts: [
      { first: 'R1', last: 'R20', score: 30, category: 'test' },
      { first: 'R21', last: 'R40', score: 80, category: 'data_model', reason: 'Adds a table.' },
    ] }] }],
  };
  const c = ctx('src/new.ts', fortyAdded, { status: 'added', additions: 40, deletions: 0 });
  const s = reconcileScores([{ value, files: ['src/new.ts'] }], [c], new Set(), parseRepoFile(null)).scores;
  assert.deepEqual(s[0]!.blocks.map((x) => x.id), ['B1.1', 'B1.2']);
  const act = [note('c1', { path: 'src/new.ts', line: 3 })];
  const l = labelCase({ ...bare, final_files: [same('src/new.ts', fortyAdded)], activity: act }, s);
  assert.deepEqual(l.blocks.get('src/new.ts\nB1.1'), { loose: true, strict: false });
  assert.deepEqual(l.blocks.get('src/new.ts\nB1.2'), none);
  const changed = fortyAdded.replace('+line 30', '+line thirty');
  const l2 = labelCase({ ...bare, final_files: [same('src/new.ts', changed)], activity: act }, s);
  assert.deepEqual(l2.blocks.get('src/new.ts\nB1.1'), { loose: true, strict: true });
});

test('a comment on a path outside the diff is counted apart', () => {
  const l = labelCase(caseOf([note('c1', { path: 'src/zzz.ts' })]), scores());
  assert.equal(l.comments.outside_diff, 1);
  assert.equal(l.comments.counted, 0);
  for (const [, v] of l.files) assert.deepEqual(v, none);
});
