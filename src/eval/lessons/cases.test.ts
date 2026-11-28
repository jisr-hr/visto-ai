import assert from 'node:assert/strict';
import test from 'node:test';

import type { EvalCase } from '../cases.ts';
import type { HistoryCase } from '../history/file.ts';
import { labelOf, lessonCases } from './cases.ts';
import type { ExportedFinding, ExportedLater, ExportedReply, FindingsFile } from './findings.ts';
import type { LessonsFile } from './lessons-file.ts';
import type { SimLesson, SimVerdict } from './nights.ts';

const TAX = 'src/billing/tax.ts';
const TEXT = 'Invoices round half up on purpose, so a finding on the rounding of a total is wrong.';

const reply = (id: string, order: number, association: ExportedReply['association'], at = '2026-03-05T10:00:00.000Z'): ExportedReply => ({ id, order, association, body: 'secret reply', at });
const later = (run: number, verdict: string): ExportedLater => ({ run, started_at: '2026-03-06T10:00:00.000Z', published_at: '2026-03-06T10:01:00.000Z', verdict });
const finding = (over: Partial<ExportedFinding> = {}): ExportedFinding => ({
  repo: 'acme/shop', pr_number: 7,
  run: { id: 1, head_sha: 'head7aaaaaaaa1', base_sha: 'base7aaaaaaaa', started_at: '2026-03-04T10:00:00.000Z' },
  comment_id: 'c-1', path: TAX, side: 'RIGHT', line: 10, severity: 'major', finding: 'Rounds too early.', replies: [], later: [], ...over,
});
const verdict = (reply: string, classification: SimVerdict['classification'], over: Partial<SimVerdict> = {}): SimVerdict => ({
  repo: 'acme/shop', number: 7, reply, finding: 'c-1', classification, outcome: 'none', attempts: 1, night: '2026-03-06T00:00:00.000Z', ...over,
});
const mapOf = (...vs: SimVerdict[]): Map<string, SimVerdict> => new Map(vs.map((v) => [v.reply, v]));

const history = (repo: string, number: number, over: Partial<HistoryCase> = {}): HistoryCase => ({
  version: 1, repo, pr_number: number, title: `title ${number}`, body: `body ${number}`, author: 'ana', branch: `feat-${number}`, base_branch: 'main',
  merged_at: '2026-03-30T10:00:00.000Z', review_head: `rh${number}`, review_base: `rb${number}`, review_at: '2026-03-04T10:00:00.000Z', reviewed_by_person: true,
  final_head: `fh${number}`, final_base: `fb${number}`, final_files: [{ path: TAX, previous_path: null, status: 'modified', patch: null }], activity: [], ...over,
});
const lessonsFile = (verdicts: SimVerdict[], lessons: SimLesson[] = [], sha = 'a'.repeat(64)): LessonsFile => ({
  version: 1, findings_file: 'f.jsonl', findings_sha256: sha, exported_at: '2026-03-20T08:00:00.000Z',
  setting: { model: 'vendor/model-a', fallbacks: [], toolChoice: 'forced' }, rules_sha256: 'b'.repeat(64),
  complete: true, end: null, nights: 19, first_night: null, last_night: null, cost: 0, verdicts, lessons,
});
const lesson = (over: Partial<SimLesson> = {}): SimLesson => ({
  ref: '8:r9', repo: 'acme/shop', number: 8, reply: 'r9', path: TAX, text: TEXT,
  createdAt: '2026-03-01T00:00:00.000Z', madeAt: '2026-03-01T00:00:00.000Z', expiresAt: '2026-05-30T00:00:00.000Z', ...over,
});
const file = (findings: ExportedFinding[]): FindingsFile => ({ exported_at: '2026-03-20T08:00:00.000Z', findings });

// A finding on pull request `n` at run `id` that a member answered with a valid pushback (label: invalid).
const invalid = (n: number, id: number, over: Partial<ExportedFinding> = {}, rid = `r-${n}-${id}`): [ExportedFinding, SimVerdict] => [
  finding({ pr_number: n, comment_id: `c-${n}-${id}`, run: { id, head_sha: `head${n}`.padEnd(12, `${id}`), base_sha: `base${n}`, started_at: '2026-03-04T10:00:00.000Z' }, replies: [reply(rid, 1, 'member')], ...over }),
  verdict(rid, 'valid_pushback', { number: n, finding: `c-${n}-${id}` }),
];

test('a finding is labelled by the first decisive reply of a person with access, else by a later verdict of fixed', () => {
  const f = (replies: ExportedReply[], laters: ExportedLater[] = []): ExportedFinding => finding({ replies, later: laters });
  assert.equal(labelOf(f([reply('a', 1, 'member'), reply('b', 2, 'member')]), mapOf(verdict('a', 'valid_pushback'), verdict('b', 'confirmed_fix'))), 'invalid');
  assert.equal(labelOf(f([reply('a', 1, 'none'), reply('b', 2, 'member')]), mapOf(verdict('a', 'valid_pushback'), verdict('b', 'confirmed_fix'))), 'valid');
  assert.equal(labelOf(f([reply('a', 1, 'member')]), mapOf(verdict('a', 'question'))), null);
  assert.equal(labelOf(f([], [later(2, 'open'), later(3, 'fixed')]), mapOf()), 'valid');
  assert.equal(labelOf(f([], [later(2, 'fixed'), later(3, 'open')]), mapOf()), null);
  assert.equal(labelOf(f([reply('a', 1, 'member')]), mapOf(verdict('a', 'invalid_pushback'))), 'valid');
  // the order of the reply decides, not its place in the list; a null association is no access; a reply with no verdict labels nothing
  assert.equal(labelOf(f([reply('b', 2, 'owner'), reply('a', 1, 'collaborator')]), mapOf(verdict('a', 'confirmed_fix'), verdict('b', 'valid_pushback'))), 'valid');
  assert.equal(labelOf(f([reply('a', 1, null)]), mapOf(verdict('a', 'valid_pushback'))), null);
  assert.equal(labelOf(f([reply('a', 1, 'member')]), mapOf()), null);
  assert.equal(labelOf(f([reply('a', 1, 'member')], [later(2, 'fixed')]), mapOf(verdict('a', 'question'))), 'valid');
  assert.equal(labelOf(f([reply('a', 1, 'member')], [later(2, 'fixed')]), mapOf(verdict('a', 'valid_pushback'))), 'invalid');
});

test('a published run of a pull request in the history file with a labelled finding is one dated case at its head', () => {
  const a = finding({ comment_id: 'c-1', path: TAX, line: 10, severity: 'major', replies: [reply('r-1', 1, 'member')] });
  const b = finding({ comment_id: 'c-2', path: 'src/cart.ts', side: 'LEFT', line: null, severity: 'minor', replies: [], later: [later(2, 'fixed')] });
  const c = finding({ comment_id: 'c-3', replies: [reply('r-3', 2, 'member')] });
  const out = lessonCases([history('acme/shop', 7)], file([a, b, c]), lessonsFile([verdict('r-1', 'confirmed_fix'), verdict('r-3', 'question', { finding: 'c-3' })]));
  assert.equal(out.cases.length, 1);
  const expected: EvalCase = {
    repo: 'acme/shop', pr_number: 7, head_sha: 'head7aaaaaaaa1', compare_base: 'base7aaaaaaaa', title: 'title 7', body: 'body 7', branch: 'feat-7', base_branch: 'main', author: 'ana',
    review_at: '2026-03-04T10:00:00.000Z', review_round: 1,
    labels: [
      { comment_id: 'c-1', path: TAX, line: 10, side: 'RIGHT', severity: 'major', label: 'valid' },
      { comment_id: 'c-2', path: 'src/cart.ts', line: null, side: 'LEFT', severity: 'minor', label: 'valid' },
    ],
  };
  assert.deepEqual(out.cases[0], expected);
  assert.deepEqual(out.labels, { valid: 2, invalid: 0 });
  assert.deepEqual(out.rows, [{ key: 'acme/shop#7@head7aaaaaaa', shown: 0, invalid: 0, valid: 2 }]);
  assert.deepEqual(out.skipped, { not_in_history: 0, no_base: 0, same_head: 0 });
});

test('a pull request held twice in the history file is read from its first case, and a run with no labelled finding is no case', () => {
  const [f, v] = invalid(7, 1);
  const out = lessonCases([history('acme/shop', 7, { title: 'first' }), history('acme/shop', 7, { title: 'second' })], file([f, finding({ pr_number: 7, comment_id: 'x', run: { ...f.run, id: 2, head_sha: 'other' } })]), lessonsFile([v]));
  assert.deepEqual(out.cases.map((c) => c.title), ['first']);
  assert.deepEqual(out.skipped, { not_in_history: 0, no_base: 0, same_head: 0 });
});

test('a run finds its history case by repository in lower case and number, and no other', () => {
  const [f, v] = invalid(7, 1);
  const out = lessonCases([history('acme/web', 7, { title: 'web' }), history('Acme/Shop', 8, { title: 'eight' }), history('Acme/Shop', 7, { title: 'shop' })], file([f]), lessonsFile([v]));
  assert.equal(out.cases.length, 1);
  assert.equal(out.cases[0]!.title, 'shop');
  assert.equal(out.cases[0]!.body, 'body 7');
  assert.equal(lessonCases([history('acme/web', 7)], file([f]), lessonsFile([v])).skipped.not_in_history, 1);
});

test('a run with no base, a second run at the same head and a pull request not in the history file make no case, and are counted', () => {
  const [a, va] = invalid(7, 1);
  const [b, vb] = invalid(7, 2, { run: { ...a.run, id: 2 } }, 'r-b');           // same head as run 1
  const [c, vc] = invalid(8, 3, { run: { ...a.run, id: 3, base_sha: null } }, 'r-c');
  const [d, vd] = invalid(9, 4, {}, 'r-d');
  const [e, ve] = invalid(7, 5, { run: { ...a.run, id: 5, head_sha: 'head7second0' } }, 'r-e');
  const out = lessonCases([history('acme/shop', 7), history('acme/shop', 8)], file([a, b, c, d, e]), lessonsFile([va, vb, vc, vd, ve]));
  assert.deepEqual(out.skipped, { not_in_history: 1, no_base: 1, same_head: 1 });
  assert.deepEqual(out.cases.map((x) => [x.head_sha, x.review_round]), [[a.run.head_sha, 1], ['head7second0', 2]]);
  // a run with no labelled finding is not looked at, and so is not counted
  const quiet = finding({ pr_number: 9, run: { ...a.run, id: 6 } });
  assert.deepEqual(lessonCases([], file([quiet]), lessonsFile([])).skipped, { not_in_history: 0, no_base: 0, same_head: 0 });
});

test('a case is never shown a lesson made from a reply on its own pull request or on its own day', () => {
  const [f, v] = invalid(7, 1);                                              // run on 2026-03-04T10:00
  const own = lesson({ ref: '7:r1', number: 7, reply: 'r1', createdAt: '2026-03-03T00:00:00.000Z', madeAt: '2026-03-03T00:00:00.000Z' });
  const sameDay = lesson({ ref: '8:r2', number: 8, reply: 'r2', createdAt: '2026-03-05T00:00:00.000Z', madeAt: '2026-03-05T00:00:00.000Z' });
  const rows = (lessons: SimLesson[]): number[] => lessonCases([history('acme/shop', 7)], file([f]), lessonsFile([v], lessons)).rows.map((r) => r.shown);
  assert.deepEqual(rows([own, sameDay]), [0]);
  assert.deepEqual(rows([own, sameDay, lesson({ ref: '8:r9', createdAt: '2026-03-04T00:00:00.000Z', madeAt: '2026-03-04T00:00:00.000Z' })]), [1]);
  assert.deepEqual(rows([lesson({ expiresAt: '2026-03-04T10:00:00.000Z' })]), [0]);
  assert.deepEqual(rows([lesson({ repo: 'acme/web' })]), [0]);
  assert.deepEqual(rows([lesson({ path: 'docs/unrelated.md' })]), [0]);
});

test('the counts of the cases shown a lesson hold their own invalid labels', () => {
  const [a, va] = invalid(7, 1);
  const [b, vb] = invalid(8, 2, { run: { ...a.run, id: 2, head_sha: 'head8aaaaaaa', started_at: '2026-03-04T10:00:00.000Z' } }, 'r-b');
  const ok = finding({ pr_number: 9, comment_id: 'c-9', run: { ...a.run, id: 3, head_sha: 'head9aaaaaaa', started_at: '2026-02-01T10:00:00.000Z' }, later: [later(4, 'fixed')] });
  const out = lessonCases([history('acme/shop', 7), history('acme/shop', 8), history('acme/shop', 9)], file([a, b, ok]), lessonsFile([va, vb], [lesson({ number: 20 })]));
  assert.equal(out.cases.length, 3);
  assert.deepEqual(out.rows.map((r) => r.shown), [1, 1, 0]);
  assert.equal(out.shown_cases, 2);
  assert.equal(out.shown_invalid, 2);
  assert.deepEqual(out.labels, { valid: 1, invalid: 2 });
});
