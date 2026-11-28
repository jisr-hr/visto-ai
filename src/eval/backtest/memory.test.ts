import assert from 'node:assert/strict';
import test from 'node:test';

import { stripControl } from '../../engine/context/untrusted.ts';
import type { HistorySource, MergedPullRequest } from '../../forge/types.ts';
import { revertedNumber } from '../../memory/reverts.ts';
import { historyKey } from '../history/file.ts';
import type { HistoryActivity, HistoryCase } from '../history/file.ts';
import { importPullRequest } from '../history/import.ts';
import type { LessonsFile } from '../lessons/lessons-file.ts';
import type { SimLesson } from '../lessons/nights.ts';
import { historyMemory, memoryCount, personComments } from './memory.ts';

const TAX = 'src/billing/tax.ts';
const signal = new AbortController().signal;

const comment = (id: string, path: string, at: string, over: Partial<HistoryActivity> = {}): HistoryActivity => ({
  kind: 'inline', id, author: 'octo-lead', bot: false, association: 'member', at, body: 'Check the rounding here.',
  commit: 'c0ffee000000', path, side: 'RIGHT', line: 3, ...over,
});

function mkCase(pr: number, files: string[], mergedAt: string, activity: HistoryActivity[] = [], over: Partial<HistoryCase> = {}): HistoryCase {
  return {
    version: 1, repo: 'acme/shop', pr_number: pr, title: 'Change things', body: 'Changes things.', author: 'octo-dev', branch: 'topic',
    base_branch: 'main', merged_at: mergedAt, review_head: `head${pr}`.padEnd(12, '0'), review_base: 'base0000',
    review_at: mergedAt, reviewed_by_person: true, final_head: 'final000', final_base: 'base0000',
    final_files: files.map((path) => ({ path, previous_path: null, status: 'modified' as const, patch: '@@ -1,1 +1,2 @@\n a\n+b' })),
    activity, ...over,
  };
}

const linesOf = async (memory: ReturnType<typeof historyMemory>, c: HistoryCase, asOf: string, files = c.final_files.map((f) => f.path)) =>
  (await memory.of(c).blocks(files.map((path) => ({ path, previousPath: null })), new Date(asOf), signal)).pullRequest;

test('a case is never shown a record made from itself', async () => {
  const own = mkCase(7, [TAX], '2026-03-05T12:00:00Z', [comment('c1', TAX, '2026-03-04T10:00:00Z')], { review_at: '2026-03-04T09:00:00Z' });
  const memory = historyMemory([own]);
  for (const at of ['2026-03-04T09:00:00Z', '2026-03-05T12:00:00Z', '2027-03-05T12:00:00Z']) assert.deepEqual(await linesOf(memory, own, at), [], at);
  assert.equal(memory.records(own), 0);
  const unreviewed = mkCase(8, [TAX], '2026-03-06T12:00:00Z', [comment('c2', TAX, '2026-03-06T11:00:00Z')], { reviewed_by_person: false });
  const both = historyMemory([unreviewed]);
  for (const at of [unreviewed.review_at, unreviewed.merged_at, '2027-03-06T12:00:00Z']) assert.deepEqual(await linesOf(both, unreviewed, at), [], at);
  assert.equal(both.records(unreviewed), 0);
});

test('a case is shown what an earlier-merged pull request left, and nothing from one merged after its date', async () => {
  const a = mkCase(7, [TAX], '2026-03-01T12:00:00Z', [comment('a1', TAX, '2026-02-28T10:00:00Z')]);
  const c = mkCase(9, [TAX], '2026-03-20T12:00:00Z', [comment('c1', TAX, '2026-03-19T10:00:00Z')]);
  const b = mkCase(8, [TAX], '2026-03-12T12:00:00Z', [], { review_at: '2026-03-10T12:00:00Z' });
  const memory = historyMemory([a, b, c]);
  assert.deepEqual(await linesOf(memory, b, b.review_at), [
    { ref: `7:file:${TAX}`, near: false, path: TAX, day: '2026-03-01', category: null, missed: false },
  ]);
  assert.equal(memory.records(b), 1);
});

test('a comment written after the case\'s date is not shown', async () => {
  const a = mkCase(7, [TAX], '2026-03-01T12:00:00Z', [comment('a1', TAX, '2026-03-15T10:00:00Z')]);
  const b = mkCase(8, [TAX], '2026-03-12T12:00:00Z', [], { review_at: '2026-03-10T12:00:00Z' });
  const memory = historyMemory([a, b]);
  assert.deepEqual(await linesOf(memory, b, '2026-03-10T12:00:00Z'), []);
  assert.equal(memory.records(b), 0);
  assert.deepEqual((await linesOf(memory, b, '2026-03-16T00:00:00Z')).map((l) => [l.ref, l.day]), [[`7:file:${TAX}`, '2026-03-15']]);
});

test('a record older than 180 days at the case\'s date is not shown', async () => {
  const a = mkCase(7, [TAX], '2026-01-01T00:00:00Z', [comment('a1', TAX, '2025-12-31T10:00:00Z')]);
  const day179 = mkCase(8, [TAX], '2026-06-30T00:00:00Z', [], { review_at: '2026-06-29T23:59:59Z' });
  const day180 = mkCase(9, [TAX], '2026-06-30T00:00:00Z', [], { review_at: '2026-06-30T00:00:00Z' });
  const memory = historyMemory([a, day179, day180]);
  assert.equal((await linesOf(memory, day179, day179.review_at)).length, 1);
  assert.equal(memory.records(day179), 1);
  assert.deepEqual(await linesOf(memory, day180, day180.review_at), []);
  assert.equal(memory.records(day180), 0);
});

test('the author\'s own comments, a stranger\'s and a bot\'s thread leave nothing', async () => {
  const a = mkCase(7, [TAX], '2026-03-01T12:00:00Z', [
    comment('a1', TAX, '2026-02-28T10:00:00Z', { author: 'octo-dev', association: 'member' }),
    comment('a2', TAX, '2026-02-28T10:01:00Z', { author: 'octo-guest', association: 'none' }),
    comment('a3', TAX, '2026-02-28T10:02:00Z', { author: 'ci-bot', bot: true, association: 'none' }),
    comment('a4', TAX, '2026-02-28T10:03:00Z', { reply_to: 'a3' }),
    comment('a5', TAX, '2026-02-28T10:04:00Z', { reply_to: 'not-held' }),
  ]);
  const b = mkCase(8, [TAX], '2026-03-12T12:00:00Z');
  const memory = historyMemory([a, b]);
  assert.deepEqual(await linesOf(memory, b, b.review_at), []);
  assert.equal(memory.records(b), 0);
});

test('another repository\'s pull requests are never shown', async () => {
  const other = mkCase(7, [TAX], '2026-03-01T12:00:00Z', [comment('a1', TAX, '2026-02-28T10:00:00Z')], { repo: 'acme/shop-admin' });
  const same = mkCase(6, [TAX], '2026-03-01T12:00:00Z', [comment('a2', TAX, '2026-02-28T10:00:00Z')], { repo: 'Acme/Shop' });
  const b = mkCase(8, [TAX], '2026-03-12T12:00:00Z');
  const memory = historyMemory([other, same, b]);
  assert.deepEqual((await linesOf(memory, b, b.review_at)).map((l) => l.ref), [`6:file:${TAX}`]);
  assert.equal(memory.records(b), 1);
});

test('memory comes from every case of the memory file, also from one the run does not start and from one the history file does not hold', async () => {
  const a = mkCase(5, [TAX], '2026-03-01T12:00:00Z', [comment('a1', TAX, '2026-02-28T10:00:00Z')]);
  const elsewhere = mkCase(6, ['src/billing/fees.ts'], '2026-03-02T12:00:00Z', [comment('e1', 'src/billing/fees.ts', '2026-03-02T10:00:00Z')]);
  const b = mkCase(8, [TAX], '2026-03-12T12:00:00Z');
  // The memory file holds a, elsewhere and b; the run starts b alone, from a history file that holds b only.
  const memory = historyMemory([a, elsewhere, b]);
  const runCase = { ...b };
  assert.deepEqual((await linesOf(memory, runCase, b.review_at)).map((l) => l.ref), [`5:file:${TAX}`]);
  assert.deepEqual((await linesOf(memory, runCase, b.review_at, ['src/billing/new.ts'])).map((l) => [l.ref, l.near]), [
    ['6:file:src/billing/fees.ts', true], [`5:file:${TAX}`, true],
  ]);
  assert.equal(memory.records(runCase), 2);
});

test('memory-count counts without a model and without the network', async () => {
  const saved = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => { fetches += 1; return Promise.reject(new Error('no_network')); };
  try {
    const earlier = mkCase(5, [TAX, 'src/cart/add.ts'], '2026-03-01T12:00:00Z', [
      comment('a1', TAX, '2026-02-28T10:00:00Z'), comment('a2', 'src/cart/add.ts', '2026-02-28T10:05:00Z'),
    ]);
    const quiet = mkCase(6, ['src/cart/add.ts'], '2026-03-05T12:00:00Z');
    const commented = mkCase(7, [TAX, 'docs/readme.md'], '2026-03-06T12:00:00Z', [comment('c1', TAX, '2026-03-06T10:00:00Z', { commit: 'head7' })]);
    const count = await memoryCount([earlier, quiet, commented], historyMemory([earlier, quiet, commented]));
    assert.deepEqual({ cases: count.cases, with_lines: count.with_lines, with_labelled_line: count.with_labelled_line }, { cases: 3, with_lines: 2, with_labelled_line: 1 });
    assert.deepEqual(count.rows, [
      { key: 'acme/shop#5@head50000000', records: 0, lines: 0, changed: 0, near: 0, labelled_files: 2, labelled_with_line: 0 },
      { key: 'acme/shop#6@head60000000', records: 2, lines: 1, changed: 1, near: 0, labelled_files: 0, labelled_with_line: 0 },
      { key: 'acme/shop#7@head70000000', records: 2, lines: 1, changed: 1, near: 0, labelled_files: 1, labelled_with_line: 1 },
    ]);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = saved;
  }
});

test('a pull request\'s signals are dated by its merge, not by its review', async () => {
  const a = mkCase(7, [TAX], '2026-03-12T12:00:00Z', [comment('a1', TAX, '2026-03-02T10:00:00Z')], { review_at: '2026-03-01T12:00:00Z' });
  const b = mkCase(8, [TAX], '2026-03-14T12:00:00Z', [], { review_at: '2026-03-10T12:00:00Z' });
  const memory = historyMemory([a, b]);
  assert.deepEqual(await linesOf(memory, b, b.review_at), []);
  assert.equal(memory.records(b), 0);
  assert.deepEqual((await linesOf(memory, b, '2026-03-13T00:00:00Z')).map((l) => [l.ref, l.day]), [[`7:file:${TAX}`, '2026-03-12']]);
});

test('a signal made at exactly the time asked is shown, and one a millisecond later is not', async () => {
  const at = '2026-03-10T12:00:00.000Z';
  const a = mkCase(7, [TAX], at, [comment('a1', TAX, '2026-03-09T10:00:00Z')]);
  const later = mkCase(6, ['src/billing/fees.ts'], '2026-03-10T12:00:00.001Z', [comment('l1', 'src/billing/fees.ts', '2026-03-09T10:00:00Z')]);
  const b = mkCase(8, [TAX, 'src/billing/fees.ts'], at, [], { review_at: at });
  const memory = historyMemory([a, later, b]);
  assert.deepEqual((await linesOf(memory, b, at)).map((l) => l.ref), [`7:file:${TAX}`]);
  assert.equal(memory.records(b), 1);
});

test('a case\'s inline activity is read as the comments the signal rule takes, the missing fields as null', () => {
  const bare: HistoryActivity = { kind: 'inline', id: 'p1', author: 'octo-lead', bot: false, association: 'member', at: '2026-03-02T10:00:00Z', body: 'Look here.', path: TAX };
  const bot: HistoryActivity = { ...comment('p2', TAX, '2026-03-02T10:05:00Z', { author: 'ci-bot', bot: true, association: 'none', file_level: true, start_line: 2, reply_to: 'p1' }) };
  const review: HistoryActivity = { kind: 'review', id: 'r1', author: 'octo-lead', bot: false, association: 'member', at: '2026-03-02T11:00:00Z', body: 'Fine.', state: 'approved' };
  const c = mkCase(7, [TAX], '2026-03-03T12:00:00Z', [bare, review, bot]);
  assert.deepEqual(personComments(c), [
    { id: 'p1', author: 'octo-lead', bot: false, association: 'member', at: '2026-03-02T10:00:00Z', body: 'Look here.', path: TAX, side: null, line: null, startLine: null, fileLevel: false, commit: null, replyTo: null },
    { id: 'p2', author: 'ci-bot', bot: true, association: 'none', at: '2026-03-02T10:05:00Z', body: 'Check the rounding here.', path: TAX, side: 'RIGHT', line: 3, startLine: 2, fileLevel: true, commit: 'c0ffee000000', replyTo: 'p1' },
  ]);
});

// Reverts (calls 20, 21, 23). A is 7, the pull request that gets reverted; B is 9, which reverts it; C is 8, under review.
const ADD = 'src/cart/add.ts';
const OLD = 'src/cart/old.ts';
const SHOP = { owner: 'acme', repo: 'shop' };
const revertCase = (pr: number, reverted: number, mergedAt: string, over: Partial<HistoryCase> = {}): HistoryCase =>
  mkCase(pr, ['src/cart/undo.ts'], mergedAt, [], { body: `Reverts acme/shop#${reverted}`, ...over });
function revertedA(over: Partial<HistoryCase> = {}): HistoryCase {
  const a = mkCase(7, [TAX, ADD], '2026-03-05T12:00:00Z', [comment('a1', TAX, '2026-03-04T10:00:00Z')], over);
  a.final_files[1] = { ...a.final_files[1]!, previous_path: OLD, status: 'renamed' };
  return a;
}
const B = (over: Partial<HistoryCase> = {}) => revertCase(9, 7, '2026-03-10T12:00:00Z', over);
const C = (over: Partial<HistoryCase> = {}) => mkCase(8, [TAX, OLD], '2026-03-12T12:00:00Z', [], { review_at: '2026-03-11T12:00:00Z', ...over });
const revertedLine = (path: string) => ({ ref: `9:reverts:7:${path}`, near: false, path, day: '2026-03-10', category: null, missed: false, reverted: true });
const revertedOf = async (memory: ReturnType<typeof historyMemory>, c: HistoryCase, asOf: string) =>
  (await linesOf(memory, c, asOf)).filter((l) => l.reverted === true);

test('a memory file that names no revert gives the memory it gave', async () => {
  const earlier = mkCase(5, [TAX, 'src/cart/add.ts'], '2026-03-01T12:00:00Z', [
    comment('a1', TAX, '2026-02-28T10:00:00Z'), comment('a2', 'src/cart/add.ts', '2026-02-28T10:05:00Z'),
  ]);
  const quiet = mkCase(6, ['src/cart/add.ts'], '2026-03-05T12:00:00Z');
  const commented = mkCase(7, [TAX, 'docs/readme.md'], '2026-03-06T12:00:00Z', [comment('c1', TAX, '2026-03-06T10:00:00Z', { commit: 'head7' })]);
  const cases = [earlier, quiet, commented];
  const memory = historyMemory(cases);
  assert.deepEqual(await linesOf(memory, earlier, earlier.review_at), []);
  assert.deepEqual(await linesOf(memory, quiet, quiet.review_at), [
    { ref: '5:file:src/cart/add.ts', near: false, path: 'src/cart/add.ts', day: '2026-03-01', category: null, missed: false },
  ]);
  assert.deepEqual(await linesOf(memory, commented, commented.review_at), [
    { ref: `5:file:${TAX}`, near: false, path: TAX, day: '2026-03-01', category: null, missed: false },
  ]);
  assert.deepEqual(memory.reverts(), { named: 0, held: 0 });
  const count = await memoryCount(cases, memory);
  assert.deepEqual(count.reverts, { named: 0, held: 0, cases: 0, rows: [] });
  assert.deepEqual(count.rows, [
    { key: 'acme/shop#5@head50000000', records: 0, lines: 0, changed: 0, near: 0, labelled_files: 2, labelled_with_line: 0 },
    { key: 'acme/shop#6@head60000000', records: 2, lines: 1, changed: 1, near: 0, labelled_files: 0, labelled_with_line: 0 },
    { key: 'acme/shop#7@head70000000', records: 2, lines: 1, changed: 1, near: 0, labelled_files: 1, labelled_with_line: 1 },
  ]);
});

test('a case after a revert is shown the reverted files, dated by the merge of the revert', async () => {
  const a = revertedA();
  const c = C();
  const expected = [
    { ref: `7:file:${TAX}`, near: false, path: TAX, day: '2026-03-05', category: null, missed: false },
    revertedLine(TAX), revertedLine(OLD),
  ];
  const memory = historyMemory([a, B(), c]);
  const files = [{ path: TAX, previousPath: null }, { path: OLD, previousPath: null }];
  assert.deepEqual((await memory.of(c).blocks(files, new Date(c.review_at), signal)).pullRequest, expected);
  assert.deepEqual(memory.reverts(), { named: 1, held: 1 });
  assert.equal(memory.records(c), 1);
  const twice = historyMemory([a, B(), B({ body: 'Reverts acme/shop#5' }), c]);
  assert.deepEqual((await twice.of(c).blocks(files, new Date(c.review_at), signal)).pullRequest, expected);
  assert.deepEqual(twice.reverts(), { named: 1, held: 1 });
});

test('a case is never shown its own revert, nor the revert it made, nor one merged after its date', async () => {
  const a = revertedA();
  const b = B({ reviewed_by_person: false });
  const memory = historyMemory([a, b, C()]);
  for (const at of [a.review_at, a.merged_at, '2027-03-05T12:00:00Z', '2026-03-10T12:00:00Z', '2026-03-11T00:00:00Z']) {
    assert.deepEqual(await revertedOf(memory, a, at), [], at);
  }
  for (const at of [b.review_at, b.merged_at]) {
    assert.deepEqual(await (await memory.of(b).blocks([{ path: TAX, previousPath: null }, { path: 'src/cart/undo.ts', previousPath: null }], new Date(at), signal)).pullRequest.filter((l) => l.reverted === true), [], at);
  }
  const early = C({ review_at: '2026-03-09T00:00:00Z' });
  assert.deepEqual(await revertedOf(memory, early, early.review_at), []);
  const exact = C({ review_at: '2026-03-10T12:00:00Z' });
  assert.deepEqual(await revertedOf(memory, exact, exact.review_at), [revertedLine(TAX), revertedLine(OLD)]);
});

test('a revert whose pull request the file does not hold, or that was merged before the one it names, leaves nothing', async () => {
  const c = C();
  const alone = historyMemory([B(), c]);
  assert.deepEqual(alone.reverts(), { named: 1, held: 0 });
  assert.deepEqual(await revertedOf(alone, c, c.review_at), []);
  const later = historyMemory([revertedA({ merged_at: '2026-03-12T12:00:00Z' }), B(), c]);
  assert.deepEqual(later.reverts(), { named: 1, held: 0 });
  assert.deepEqual(await revertedOf(later, c, '2026-03-13T00:00:00Z'), []);
  const itself = historyMemory([revertedA(), revertCase(9, 9, '2026-03-10T12:00:00Z'), c]);
  assert.deepEqual(itself.reverts(), { named: 1, held: 0 });
  assert.deepEqual(await revertedOf(itself, c, c.review_at), []);
  const second = historyMemory([revertedA(), B({ body: 'Undo the change.\nReverts acme/shop#7' }), c]);
  assert.deepEqual(second.reverts(), { named: 0, held: 0 });
  assert.deepEqual(await revertedOf(second, c, c.review_at), []);
});

test('a revert is not shown 180 days after its merge', async () => {
  const memory = historyMemory([revertedA(), B(), C()]);
  const last = C({ review_at: '2026-09-06T11:59:59Z' });
  assert.deepEqual(await revertedOf(memory, last, last.review_at), [revertedLine(TAX), revertedLine(OLD)]);
  const gone = C({ review_at: '2026-09-06T12:00:00Z' });
  assert.deepEqual(await revertedOf(memory, gone, gone.review_at), []);
});

test('another repository\'s revert is never shown, and a reference to another repository names nothing', async () => {
  const c = C();
  const elsewhere = historyMemory([revertedA({ repo: 'acme/other' }), B({ repo: 'acme/other', body: 'Reverts acme/other#7' }), c]);
  assert.deepEqual(elsewhere.reverts(), { named: 1, held: 1 });
  assert.deepEqual(await revertedOf(elsewhere, c, c.review_at), []);
  const across = historyMemory([revertedA(), B({ body: 'Reverts acme/other#7' }), c]);
  assert.deepEqual(across.reverts(), { named: 0, held: 0 });
  assert.deepEqual(await revertedOf(across, c, c.review_at), []);
});

const mergedPr = (number: number, description: string): MergedPullRequest => ({
  number, title: 'Change things', description, author: 'octo-dev', authorIsBot: false,
  baseBranch: 'main', headBranch: 'topic', baseSha: 'base0000', headSha: `head${number}`.padEnd(12, '0'), mergedAt: '2026-03-10T12:00:00Z',
});
const importSource: HistorySource = {
  listMergedPullRequests: () => Promise.resolve({ pullRequests: [], pageLimitReached: false }),
  listReviews: () => Promise.resolve([]), listInlineComments: () => Promise.resolve([]), listGeneralComments: () => Promise.resolve([]),
  pullRequest: async () => null,
  compare: () => Promise.resolve({ mergeBase: 'base0000', files: [] }),
};
async function importedBody(description: string): Promise<string> {
  const out = await importPullRequest(SHOP, mergedPr(9, description), importSource);
  assert.ok('case' in out);
  return out.case.body;
}

test('a line the cut of a history file may have shortened, or a reference that lies past it, is found neither by the rule on the description nor in the file', async () => {
  const past = '\n'.repeat(4_100) + 'Reverts acme/shop#7';
  const atCut = ' '.repeat(3_980) + '\nReverts acme/shop#7';
  const overCut = ' '.repeat(3_980) + '\nReverts acme/shop#71';
  assert.deepEqual([atCut.length, overCut.length], [4_000, 4_001]);
  for (const description of [past, atCut, overCut]) {
    assert.equal(revertedNumber(description, SHOP), null);
    assert.equal(revertedNumber(await importedBody(description), SHOP), null);
  }
  assert.equal(revertedNumber('Reverts acme/shop#7', SHOP), 7);
  assert.equal(revertedNumber(await importedBody('Reverts acme/shop#7'), SHOP), 7);
  assert.equal(revertedNumber('Reverts acme/shop#7 because it broke', SHOP), null);
  assert.equal(revertedNumber(await importedBody('Reverts acme/shop#7 because it broke'), SHOP), null);
});

test('a file is read as its importer left it: what the importer stripped is not seen there', async () => {
  // The difference calls 2 and 20 name, held so that nobody takes it for agreement. The importer now keeps a description
  // as it was sent, but a file made by an earlier import may still hold one with its invisible characters and every line
  // end but the line feed stripped, as stripControl strips them; the backtest reads what the file holds.
  const earlierImport = (description: string): string => stripControl(description).text.slice(0, 4_000);
  const zeroWidth = `Reverts acme/shop#7${String.fromCodePoint(0x200b)}`;
  const carriage = 'Reverts acme/shop#7\r3';
  assert.equal(revertedNumber(zeroWidth, SHOP), null);
  assert.equal(revertedNumber(earlierImport(zeroWidth), SHOP), 7);
  assert.equal(revertedNumber(carriage, SHOP), 7);
  assert.equal(revertedNumber(earlierImport(carriage), SHOP), 73);
  const c = C();
  const strippedB = historyMemory([revertedA(), B({ body: earlierImport(zeroWidth) }), c]);
  assert.deepEqual(strippedB.reverts(), { named: 1, held: 1 });
  assert.deepEqual(await revertedOf(strippedB, c, c.review_at), [revertedLine(TAX), revertedLine(OLD)]);
});

test('the count says how many reverts the file names, how many it holds, and which cases would be shown a reverted line', async () => {
  const saved = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => { fetches += 1; return Promise.reject(new Error('no_network')); };
  try {
    const c = C();
    const d = revertCase(12, 99, '2026-03-11T12:00:00Z');
    const cases = [revertedA(), B(), c, d];
    const count = await memoryCount(cases, historyMemory(cases));
    assert.deepEqual(count.reverts, { named: 2, held: 1, cases: 1, rows: [{ key: historyKey(c), lines: 2 }] });
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = saved;
  }
});

test('the count\'s numbers of lines count the signals\' lines only, and its reverted lines only in the reverts', async () => {
  // A is 7 and changes tax.ts; B is 9 and reverts it; C is 8, changes tax.ts, and a member commented on it.
  const a = mkCase(7, [TAX], '2026-03-05T12:00:00Z');
  const c = mkCase(8, [TAX], '2026-03-12T12:00:00Z', [comment('c1', TAX, '2026-03-11T10:00:00Z', { commit: 'head8' })], { review_at: '2026-03-11T12:00:00Z' });
  const cases = [a, B(), c];
  const memory = historyMemory(cases);
  assert.deepEqual(await revertedOf(memory, c, c.review_at), [revertedLine(TAX)]);
  const count = await memoryCount(cases, memory);
  assert.deepEqual(count.rows.find((r) => r.key === historyKey(c)), {
    key: historyKey(c), records: 0, lines: 0, changed: 0, near: 0, labelled_files: 1, labelled_with_line: 0,
  });
  assert.deepEqual({ with_lines: count.with_lines, with_labelled_line: count.with_labelled_line }, { with_lines: 0, with_labelled_line: 0 });
  assert.deepEqual(count.reverts, { named: 1, held: 1, cases: 1, rows: [{ key: historyKey(c), lines: 1 }] });
});

test('the repositories of reverts are compared in lower case: in the reference, in the pull requests held, and in the groups', async () => {
  // The reference names the repository in another case than the file's cases do, and the other way.
  for (const [cases, reference] of [['acme/shop', 'Acme/Shop'], ['Acme/Shop', 'acme/shop']] as const) {
    const c = C({ repo: cases });
    const memory = historyMemory([revertedA({ repo: cases }), B({ repo: cases, body: `Reverts ${reference}#7` }), c]);
    assert.deepEqual(memory.reverts(), { named: 1, held: 1 }, cases);
    assert.deepEqual(await revertedOf(memory, c, c.review_at), [revertedLine(TAX), revertedLine(OLD)], cases);
  }
  // A pull request held twice under two letter cases is one.
  const c = C();
  const twice = historyMemory([revertedA(), B(), B({ repo: 'ACME/SHOP' }), c]);
  assert.deepEqual(twice.reverts(), { named: 1, held: 1 });
  // The reverts of a repository reach its cases whatever the case of either.
  for (const [made, shown] of [['Acme/Shop', 'acme/shop'], ['acme/shop', 'Acme/Shop'], ['ACME/shop', 'acme/SHOP']] as const) {
    const under = C({ repo: shown });
    const memory = historyMemory([revertedA({ repo: made }), B({ repo: made }), under]);
    assert.deepEqual(memory.reverts(), { named: 1, held: 1 }, `${made} ${shown}`);
    assert.deepEqual(await revertedOf(memory, under, under.review_at), [revertedLine(TAX), revertedLine(OLD)], `${made} ${shown}`);
  }
});

test('with more reverts live at a case\'s date than are read, the newest are kept, though the file holds them oldest first', async () => {
  // Six reverts of six pull requests, oldest first: 1 + 300 + 300 + 300 + 100 + 1 = 1,002 records, more than REVERTS_READ + 1.
  const sizes = [1, 300, 300, 300, 100, 1];
  const cases: HistoryCase[] = [];
  sizes.forEach((size, k) => {
    const paths = k === 0 ? ['src/cart/oldest.ts'] : k === sizes.length - 1 ? [TAX] : Array.from({ length: size }, (_, i) => `src/r${k}/f${i}.ts`);
    cases.push(mkCase(k + 1, paths, '2026-03-01T12:00:00Z'));
    cases.push(revertCase(101 + k, k + 1, `2026-03-0${k + 2}T12:00:00Z`));
  });
  const x = mkCase(500, [TAX, 'src/cart/oldest.ts'], '2026-03-09T12:00:00Z');
  cases.push(x);
  const memory = historyMemory(cases);
  assert.deepEqual(memory.reverts(), { named: 6, held: 6 });
  const blocks = await memory.of(x).blocks([{ path: TAX, previousPath: null }, { path: 'src/cart/oldest.ts', previousPath: null }], new Date(x.review_at), signal);
  assert.deepEqual(blocks.pullRequest.filter((l) => l.reverted === true).map((l) => l.ref), [`106:reverts:6:${TAX}`]);
  assert.equal(blocks.cut.records, true);
});

test('a case\'s own records of reverts take no place among those read, as the service\'s read leaves them out first', async () => {
  // The case under review made a revert of 150 files and was reverted itself: 300 records of its own, live at its date and the newest.
  const own = [
    mkCase(590, Array.from({ length: 150 }, (_, i) => `src/own/m${i}.ts`), '2026-03-01T12:00:00Z'),
    revertCase(700, 600, '2026-03-08T18:00:00Z'),
  ];
  const x = mkCase(600, Array.from({ length: 150 }, (_, i) => `src/own/x${i}.ts`), '2026-03-08T12:00:00Z', [], {
    body: 'Reverts acme/shop#590', review_at: '2026-03-09T12:00:00Z',
  });
  const files = [{ path: TAX, previousPath: null }, { path: 'src/cart/oldest.ts', previousPath: null }];
  // Other reverts, oldest first: the oldest on src/cart/oldest.ts and the newest on TAX.
  const others = (fifth: number): HistoryCase[] => {
    const sizes = [1, 300, 300, 300, fifth, 1];
    const cases: HistoryCase[] = [];
    sizes.forEach((size, k) => {
      const paths = k === 0 ? ['src/cart/oldest.ts'] : k === sizes.length - 1 ? [TAX] : Array.from({ length: size }, (_, i) => `src/r${k}/f${i}.ts`);
      cases.push(mkCase(k + 1, paths, '2026-03-01T12:00:00Z'));
      cases.push(revertCase(101 + k, k + 1, `2026-03-0${k + 2}T12:00:00Z`));
    });
    return cases;
  };
  // The oracle is the service's read: the case's own left out first, then the newest REVERTS_READ + 1, of which the shared code keeps REVERTS_READ.
  // 1 + 300 + 300 + 300 + 98 + 1 = REVERTS_READ other records: every one is read, the oldest too, and nothing is cut.
  const read = historyMemory([...others(98), ...own, x]);
  assert.deepEqual(read.reverts(), { named: 8, held: 8 });
  const all = await read.of(x).blocks(files, new Date(x.review_at), signal);
  assert.deepEqual(all.pullRequest.map((l) => l.ref), [`106:reverts:6:${TAX}`, '101:reverts:1:src/cart/oldest.ts']);
  assert.equal(all.cut.records, false);
  // One more, REVERTS_READ + 1 other records: the read is cut, and the oldest is the one left out.
  const cut = historyMemory([...others(99), ...own, x]);
  const some = await cut.of(x).blocks(files, new Date(x.review_at), signal);
  assert.deepEqual(some.pullRequest.map((l) => l.ref), [`106:reverts:6:${TAX}`]);
  assert.equal(some.cut.records, true);
});

// ---- lessons as of each case (plan "evals with lessons", task 7) ----
const LESSON_TEXT = 'Discounts apply before tax in this shop, so a finding on the order of the two is wrong.';
const lessonOf = (number: number, madeAt: string, over: Partial<SimLesson> = {}): SimLesson => ({
  ref: `${number}:r${number}`, repo: 'acme/shop', number, reply: `r${number}`, path: TAX, text: LESSON_TEXT,
  createdAt: madeAt, madeAt, expiresAt: '2026-09-01T00:00:00.000Z', ...over,
});
const lessonsFileOf = (lessons: SimLesson[]): LessonsFile => ({
  version: 1, findings_file: 'findings.jsonl', findings_sha256: 'a'.repeat(64), exported_at: '2026-03-20T08:00:00.000Z',
  setting: { model: 'vendor/model-a', fallbacks: [], toolChoice: 'forced' }, rules_sha256: 'b'.repeat(64),
  complete: true, end: null, nights: 1, first_night: null, last_night: null, cost: 0, verdicts: [], lessons,
});

test('a backtest case is shown the lessons live at its date, of other pull requests of its repository', async () => {
  const c = mkCase(7, [TAX], '2026-03-05T12:00:00Z');
  const file = lessonsFileOf([
    lessonOf(8, '2026-03-04T00:00:00.000Z'), lessonOf(7, '2026-03-04T00:00:00.000Z'), lessonOf(9, '2026-03-06T00:00:00.000Z'),
    lessonOf(10, '2026-03-04T00:00:00.000Z', { repo: 'acme/web' }),
  ]);
  const memory = historyMemory([], file).of(c);
  const shown = await memory.lessons!([{ path: TAX, previousPath: null }], new Date(c.review_at), signal);
  assert.deepEqual(shown.lessons.map((l) => l.ref), ['8:r8']);
  // without lessons the memory has none to ask
  assert.equal(historyMemory([]).of(c).lessons, undefined);
});

test('memoryCount with lessons counts the cases shown a lesson and those of them with a labelled file', async () => {
  const labelled = mkCase(7, [TAX], '2026-03-05T12:00:00Z', [comment('c1', TAX, '2026-03-05T10:00:00Z', { author: 'octo-lead', commit: 'head70000000' })]);
  const plain = mkCase(8, [TAX], '2026-03-05T13:00:00Z');
  const elsewhere = mkCase(9, ['docs/readme.md'], '2026-03-05T14:00:00Z');
  const file = lessonsFileOf([lessonOf(11, '2026-03-04T00:00:00.000Z')]);
  const cases = [labelled, plain, elsewhere];
  const count = await memoryCount(cases, historyMemory([]), file);
  assert.equal(count.lessons!.cases, 3 - 1);
  assert.equal(count.lessons!.with_labelled_file, 1);
  assert.deepEqual(count.lessons!.rows, [{ key: historyKey(labelled), lessons: 1 }, { key: historyKey(plain), lessons: 1 }]);
  assert.equal((await memoryCount(cases, historyMemory([]))).lessons, undefined);
});
