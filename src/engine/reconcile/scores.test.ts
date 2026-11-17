import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileContext } from '../context/build.ts';
import { parsePatch } from '../context/diff.ts';
import type { RawBlock, RawFile, RawPart, SubmitReviewArgs } from '../model/submit-review.ts';
import { parseRepoFile } from '../score/floors.ts';
import type { TeamFloors } from '../score/floors.ts';
import { blocksOf } from '../score/blocks.ts';
import { scorePlan } from '../score/rules.ts';
import type { FileScore } from '../score/types.ts';
import type { ChangedFile } from '../types.ts';
import { reconcileScores, verdictOf } from './scores.ts';

const patch = (start: number) =>
  [`@@ -${start},4 +${start},5 @@`, ' keep', '-old one', '+new one', '+new two', ' keep', ' keep'].join('\n');
const twoHunks = `${patch(10)}\n${['@@ -50,3 +51,3 @@', ' keep', '-old', '+new', ' keep'].join('\n')}`;
const fortyAdded = ['@@ -0,0 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`)].join('\n');

function ctx(path: string, text: string | null, extra: Partial<ChangedFile> = {}): FileContext {
  const file: ChangedFile = { path, previousPath: null, status: 'modified', additions: 3, deletions: 1, patch: text, ...extra };
  const hunks = text === null ? [] : parsePatch(text);
  const skip = text !== null ? null : file.status === 'renamed' && file.previousPath !== null ? 'unchanged' : 'no_diff';
  return { file, hunks, ranges: null, diffText: null, full: null, test: null, skip, blocks: blocksOf(hunks), plan: scorePlan(file, skip) };
}

const b = (id: string, score: number, category = 'fix', reason?: string): RawBlock =>
  reason === undefined ? { id, score, category } : { id, score, category, reason };
const part = (first: string, last: string, score: number, category: string, reason?: string): RawPart =>
  reason === undefined ? { first, last, score, category } : { first, last, score, category, reason };
const file = (path: string, blocks: RawBlock[]): RawFile => ({ path, change_summary: 'Summary.', blocks });

const run = (
  files: RawFile[],
  contexts: FileContext[],
  options: { notRead?: string[]; floors?: TeamFloors; batch?: string[] } = {},
) => {
  const value: SubmitReviewArgs = { overview: 'o', findings: [], files };
  const batch = options.batch ?? contexts.map((c) => c.file.path);
  return reconcileScores([{ value, files: batch }], contexts, new Set(options.notRead ?? []), options.floors ?? parseRepoFile(null));
};

test('every block scored: the file takes the highest', () => {
  const [s] = run([file('src/a.ts', [b('B1', 20, 'rename'), b('B2', 75, 'business_rule', 'Changes who may refund.')])], [ctx('src/a.ts', twoHunks)]).scores;
  assert.equal(s!.finalScore, 75);
  assert.equal(s!.fileLevel, null);
  assert.equal(s!.covered, true);
  assert.deepEqual(s!.blocks.map((x) => x.entry?.score), [20, 75]);
  assert.equal(s!.changedLines, 5);
  assert.equal(s!.changeSummary, 'Summary.');
  assert.match(s!.diffHash!, /^[0-9a-f]{64}$/);
});

test('a skipped block counts as 100 and the file is not covered', () => {
  const out = run([file('src/a.ts', [b('B1', 20, 'rename')])], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(out.scores[0]!.finalScore, 100);
  assert.equal(out.scores[0]!.covered, false);
  assert.ok(out.audit.some((a) => a.stage === 'reconcile' && a.action === 'block_not_scored' && a.subject === 'src/a.ts B2'));
});

test('a whole-file score stands for blocks with none', () => {
  const [s] = run([{ ...file('pnpm-lock.yaml', []), score: 72, category: 'dependency', reason: 'Moves a library to a new major version.' }], [ctx('pnpm-lock.yaml', twoHunks)]).scores;
  assert.deepEqual(s!.fileLevel, { score: 72, source: 'whole_file' });
  assert.equal(s!.finalScore, 72);
  assert.equal(s!.covered, true);
  assert.deepEqual(s!.wholeFile, { score: 72, category: 'dependency', reason: 'Moves a library to a new major version.' });
});

test('a whole-file score adds no block_not_scored entries', () => {
  const out = run([{ ...file('src/a.ts', []), score: 30, category: 'refactor' }], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.audit.filter((a) => a.action === 'block_not_scored').length, 0);
});

test('a block above the whole-file score still counts', () => {
  const [s] = run([{ ...file('src/a.ts', [b('B1', 80, 'business_rule', 'Changes a limit.')]), score: 45, category: 'refactor', reason: 'Reorders the checks.' }], [ctx('src/a.ts', twoHunks)]).scores;
  assert.equal(s!.finalScore, 80);
  assert.deepEqual(s!.fileLevel, { score: 45, source: 'whole_file' });
  assert.equal(s!.covered, true);
});

test('a file the model returned nothing for is 100, not_scored', () => {
  const out = run([], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(out.scores[0]!.finalScore, 100);
  assert.equal(out.scores[0]!.covered, false);
  assert.equal(out.scores[0]!.changeSummary, '');
  assert.equal(out.scores[0]!.wholeFile, null);
});

test('a file that was not read is 100 even with an entry', () => {
  const out = run([file('src/a.ts', [b('B1', 10, 'formatting'), b('B2', 10, 'formatting')])], [ctx('src/a.ts', twoHunks)], { notRead: ['src/a.ts'] });
  assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(out.scores[0]!.covered, false);
});

test('bad values cost one block', () => {
  const out = run([file('src/a.ts', [b('B1', 45.5, 'fix', 'x'), b('B2', 101, 'fix', 'x')])], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => x.entry), [null, null]);
  assert.equal(out.audit.filter((a) => a.action === 'score_invalid').length, 2);
});

test('negative and non-finite scores are invalid', () => {
  const out = run([file('src/a.ts', [b('B1', -1), b('B2', Number.NaN)])], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => x.entry), [null, null]);
  assert.equal(out.audit.filter((a) => a.action === 'score_invalid').length, 2);
});

test('an unknown category is stored as other', () => {
  const out = run([file('src/a.ts', [b('B1', 10, 'nonsense'), b('B2', 10, 'fix')])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.entry!.category, 'other');
  assert.equal(out.scores[0]!.blocks[1]!.entry!.category, 'fix');
  assert.equal(out.audit.length, 0);
});

test('a reason is cleaned to one line, and a missing one at 70 is kept and recorded', () => {
  const out = run([file('src/a.ts', [b('B1', 70, 'permission'), b('B2', 45, 'fix', 'first line\nsecond line')])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.entry!.reason, '');
  assert.equal(out.scores[0]!.blocks[1]!.entry!.reason, 'first line second line');
  assert.deepEqual(out.audit.filter((a) => a.action === 'reason_missing').map((a) => a.subject), ['src/a.ts B1']);
});

test('a missing reason below 40 is not recorded', () => {
  const out = run([file('src/a.ts', [b('B1', 39), b('B2', 5)])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.audit.length, 0);
});

test('change_summary is cleaned to one line of at most 300 characters', () => {
  const [s] = run([{ ...file('src/a.ts', [b('B1', 5), b('B2', 5)]), change_summary: `${'x'.repeat(400)}\nmore` }], [ctx('src/a.ts', twoHunks)]).scores;
  assert.equal(s!.changeSummary.length, 300);
});

test('a block id that is not in the file, or seen twice, is recorded and ignored', () => {
  const out = run([file('src/a.ts', [b('B1', 10), b('B9', 99), b('B1', 90), b('B2', 20)])], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => x.entry?.score), [10, 20]);
  assert.deepEqual(out.audit.map((a) => [a.action, a.subject]), [['block_not_in_file', 'src/a.ts B9'], ['block_duplicate', 'src/a.ts B1']]);
});

test('an item with neither score nor parts leaves its block alone and adds nothing of its own', () => {
  const out = run([file('src/a.ts', [{ id: 'B1' }, b('B2', 10)])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.entry, null);
  assert.deepEqual(out.audit.map((a) => a.action), ['block_not_scored']);
});

test('a long block is split into parts, each a block of its own', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', parts: [part('R1', 'R20', 30, 'test'), part('R21', 'R40', 80, 'data_model', 'Adds a table.')] }])], [ctx('src/new.ts', fortyAdded, { status: 'added', additions: 40, deletions: 0 })]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.hunk, x.entry?.score]), [['B1.1', 'B1', 30], ['B1.2', 'B1', 80]]);
  assert.equal(out.scores[0]!.blocks[0]!.changedLines, 20);
  assert.deepEqual(out.scores[0]!.blocks[0]!.lines, { RIGHT: [[1, 20]], LEFT: [] });
  assert.equal(out.scores[0]!.finalScore, 80);
  assert.equal(out.scores[0]!.covered, true);
});

test('a dropped part leaves its lines without a score', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', parts: [part('R1', 'R20', 30, 'test'), part('R15', 'R30', 80, 'data_model', 'Adds a table.')] }])], [ctx('src/new.ts', fortyAdded, { status: 'added', additions: 40, deletions: 0 })]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.entry?.score ?? null]), [['B1.1', 30], ['B1.rest', null]]);
  assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(out.scores[0]!.covered, false);
  assert.ok(out.audit.some((a) => a.action === 'part_invalid' && a.subject === 'src/new.ts B1'));
});

test('a part with bad anchors or a bad score is dropped', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', parts: [part('X1', 'R20', 30, 'test'), part('R1', 'R20', 130, 'test'), part('R21', 'R40', 80, 'data_model', 'Adds a table.')] }])], [ctx('src/new.ts', fortyAdded, { status: 'added', additions: 40, deletions: 0 })]);
  assert.equal(out.audit.filter((a) => a.action === 'part_invalid').length, 2);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.entry?.score ?? null]), [['B1.1', 80], ['B1.rest', null]]);
});

test('parts on a short block are not a split: the highest part stands', () => {
  const out = run([file('src/a.ts', [{ id: 'B1', parts: [part('R11', 'R11', 30, 'rename'), part('R12', 'R12', 75, 'calculation', 'Changes rounding.')] }, b('B2', 10, 'formatting')])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.id, 'B1');
  assert.equal(out.scores[0]!.blocks[0]!.entry!.score, 75);
  assert.ok(out.audit.some((a) => a.action === 'split_ignored' && a.subject === 'src/a.ts B1'));
});

test('on a tie between parts of a short block the first stands', () => {
  const out = run([file('src/a.ts', [{ id: 'B1', parts: [part('R11', 'R11', 50, 'fix', 'First.'), part('R12', 'R12', 50, 'refactor', 'Second.')] }, b('B2', 10)])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.entry!.category, 'fix');
});

test('parts are ignored when the item also has a score', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', score: 20, category: 'test', parts: [part('R1', 'R20', 90, 'test', 'x')] }])], [ctx('src/new.ts', fortyAdded, { status: 'added', additions: 40, deletions: 0 })]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.entry?.score]), [['B1', 20]]);
});

test('a rename inside its directory scores 30 by rule and is covered', () => {
  const [s] = run([], [ctx('src/new-name.ts', null, { status: 'renamed', previousPath: 'src/old-name.ts', additions: 0, deletions: 0 })]).scores;
  assert.deepEqual(s!.fileLevel, { score: 30, source: 'rule_rename' });
  assert.equal(s!.finalScore, 30);
  assert.equal(s!.covered, true);
  assert.equal(s!.diffHash, null);
  assert.equal(s!.changedLines, 0);
  assert.equal(s!.previousPath, 'src/old-name.ts');
});

test('an image scores 10 by rule', () => {
  const [s] = run([], [ctx('img/logo.png', null, { status: 'added', additions: 0, deletions: 0 })]).scores;
  assert.deepEqual(s!.fileLevel, { score: 10, source: 'rule_asset' });
  assert.equal(s!.covered, true);
});

test('a floor beats a rule, on the old path too', () => {
  const floors = parseRepoFile('human_review:\n  - db/migrate/\n');
  const rename = ctx('db/migrate/002_b.sql', null, { status: 'renamed', previousPath: 'db/migrate/001_a.sql', additions: 0, deletions: 0 });
  assert.deepEqual(run([], [rename], { floors }).scores[0]!.fileLevel, { score: 100, source: 'team_floor' });
  const moved = ctx('src/001_a.sql', null, { status: 'renamed', previousPath: 'db/migrate/001_a.sql', additions: 0, deletions: 0 });
  const [s] = run([{ ...file('src/001_a.sql', []), score: 20, category: 'rename' }], [moved], { floors }).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'team_floor' });
  assert.equal(s!.finalScore, 100);
});

test('a built-in floor wins a tie with the rule and the whole-file score', () => {
  const [s] = run([{ ...file('.github/workflows/ci.yml', []), score: 100, category: 'security_configuration', reason: 'Changes CI.' }], [ctx('.github/workflows/ci.yml', twoHunks)]).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'builtin_floor' });
});

test('an unusable team file puts every file at 100 with its own source', () => {
  const [s] = run([file('src/a.ts', [b('B1', 5), b('B2', 5)])], [ctx('src/a.ts', twoHunks)], { floors: parseRepoFile('nonsense: 1') }).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'team_file_invalid' });
});

test('a moved file needs its whole-file score', () => {
  const moved = () => ctx('lib/a.ts', null, { status: 'renamed', previousPath: 'src/a.ts', additions: 0, deletions: 0 });
  const withScore = run([{ ...file('lib/a.ts', []), score: 60, category: 'structure', reason: 'Moves the file.' }], [moved()]).scores[0]!;
  assert.deepEqual(withScore.fileLevel, { score: 60, source: 'whole_file' });
  assert.equal(withScore.covered, true);
  const without = run([file('lib/a.ts', [])], [moved()]).scores[0]!;
  assert.deepEqual(without.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(without.covered, false);
});

test('a file with no diff and no rule is 100 and not covered', () => {
  const [s] = run([], [ctx('docs/big.bin', null, { status: 'modified' })]).scores;
  assert.deepEqual(s!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(s!.covered, false);
});

test('scores for another batch or another pull request are dropped', () => {
  const contexts = [ctx('src/a.ts', twoHunks), ctx('src/b.ts', twoHunks)];
  const out = run([file('src/a.ts', [b('B1', 5), b('B2', 5)]), file('src/b.ts', [b('B1', 5), b('B2', 5)]), file('elsewhere.ts', [])], contexts, { batch: ['src/a.ts'] });
  assert.equal(out.scores[0]!.finalScore, 5);
  assert.equal(out.scores[1]!.finalScore, 100);
  assert.deepEqual(out.audit.map((a) => [a.action, a.subject]), [['score_path_not_in_batch', 'src/b.ts'], ['score_path_not_in_pull_request', 'elsewhere.ts']]);
});

test('the first entry counts, a later one is a duplicate, and prefixes normalise', () => {
  const contexts = [ctx('src/a.ts', twoHunks)];
  const out = run([file('a/src/a.ts', [b('B1', 5), b('B2', 5)]), file('src/a.ts', [b('B1', 90), b('B2', 90)])], contexts);
  assert.equal(out.scores[0]!.finalScore, 5);
  assert.deepEqual(out.audit.map((a) => [a.action, a.subject]), [['score_duplicate', 'src/a.ts']]);
});

test('an entry in a batch that did not hold the file does not hide a later one that did', () => {
  const contexts = [ctx('src/a.ts', twoHunks)];
  const value = (n: number): SubmitReviewArgs => ({ overview: 'o', findings: [], files: [file('src/a.ts', [b('B1', n), b('B2', n)])] });
  const out = reconcileScores([{ value: value(90), files: [] }, { value: value(7), files: ['src/a.ts'] }], contexts, new Set(), parseRepoFile(null));
  assert.equal(out.scores[0]!.finalScore, 7);
});

test('one score per context, in the order of the contexts', () => {
  const out = run([], [ctx('src/z.ts', twoHunks), ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores.map((s) => s.path), ['src/z.ts', 'src/a.ts']);
});

test('the verdict', () => {
  const score = (finalScore: number): FileScore => ({ path: 'p', previousPath: null, diffHash: null, changeSummary: '', changedLines: 0, blocks: [], wholeFile: null, fileLevel: null, finalScore, covered: true });
  assert.deepEqual(verdictOf([score(69)], 70), { threshold: 70, needsHuman: false, highest: 69 });
  assert.deepEqual(verdictOf([score(69), score(70)], 70), { threshold: 70, needsHuman: true, highest: 70 });
  assert.deepEqual(verdictOf([], 70), { threshold: 70, needsHuman: false, highest: 0 });
});
