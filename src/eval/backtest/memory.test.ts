import assert from 'node:assert/strict';
import test from 'node:test';

import type { HistoryActivity, HistoryCase } from '../history/file.ts';
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
