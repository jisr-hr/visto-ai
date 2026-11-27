import assert from 'node:assert/strict';
import test from 'node:test';

import { countAt } from '../backtest/metrics.ts';
import { blockKey, liveCases, storedScores } from './labels.ts';
import type { LiveComment, LiveFile, LivePull, LiveRun } from './labels.ts';

const stored = (path: string, diffHash: string, blocks: Array<[string, string, number, [number, number][]]>): Record<string, unknown> => ({
  path, diffHash, changedLines: 20, finalScore: 55, fileLevel: null,
  blocks: blocks.map(([id, hunkHash, score, right]) => ({
    id, hunkHash, changedLines: 10, entry: { score, category: 'other', reason: 'invented' }, lines: { RIGHT: right, LEFT: [[5, 9]] },
  })),
});
const files = (value: unknown[]): LiveFile[] => {
  const out = storedScores(value);
  assert.notEqual(out, null);
  return out!;
};
const PATH = 'src/cart/price.ts';
const runA: LiveRun = { id: 11, head: 'A', scores: files([stored(PATH, 'dA', [['B1', 'h1', 55, [[38, 51]]], ['B2', 'h2', 20, [[60, 70]]]])]) };
const runB: LiveRun = { id: 12, head: 'B', scores: files([stored(PATH, 'dB', [['B1', 'h9', 55, [[38, 51]]], ['B2', 'h2', 20, [[60, 70]]]])]) };

const comment = (id: string, over: Partial<LiveComment> = {}): LiveComment => ({
  id, author: 'octo-guest', path: PATH, side: 'RIGHT', line: 40, startLine: null, fileLevel: false, commit: 'A', replyTo: null, ...over,
});
const pull = (comments: LiveComment[], over: Partial<LivePull> = {}): LivePull => ({
  number: 128, author: 'octo-dev', threshold: 70, last: runB,
  atHead: new Map([['A', runA], ['B', runB]]), comments, findingThreads: new Set(['c-1']), ...over,
});

test('a comment on a block of the run that scored its commit labels that block, strict when the last run no longer holds its lines', () => {
  const r = liveCases([pull([comment('x1')])]);
  assert.equal(r.labelled.length, 1);
  const c = r.labelled[0]!;
  assert.equal(c.key, '128:11');
  assert.deepEqual(c.labels.blocks.get(blockKey(PATH, 'B1')), { loose: true, strict: true });
  assert.deepEqual(c.labels.blocks.get(blockKey(PATH, 'B2')), { loose: false, strict: false });
  assert.deepEqual(c.labels.files.get(PATH), { loose: true, strict: true });
  assert.deepEqual(c.labels.comments, { counted: 0, off_head: 0, outside_diff: 0, in_bot_thread: 0 });
  assert.equal(c.labels.final_missing, 0);
  assert.deepEqual([...r.strict], [128]);
  const second = liveCases([pull([comment('x2', { line: 61 })])]).labelled[0]!;
  assert.deepEqual(second.labels.blocks.get(blockKey(PATH, 'B2')), { loose: true, strict: false });
  assert.deepEqual(second.labels.blocks.get(blockKey(PATH, 'B1')), { loose: false, strict: false });
});

test("a comment on a head whose only run found nothing new labels that run's blocks", () => {
  const found = { ...runA, id: 13, head: 'A2' };
  const r = liveCases([pull([comment('x1', { commit: 'A2' })], { atHead: new Map([['A2', found], ['B', runB]]) })]);
  assert.equal(r.labelled[0]!.key, '128:13');
  assert.deepEqual(r.labelled[0]!.labels.blocks.get(blockKey(PATH, 'B1')), { loose: true, strict: true });
});

test('a comment on a commit no run scored labels its file in the last run, never strictly', () => {
  const r = liveCases([pull([comment('x1', { commit: 'C' }), comment('x2', { commit: null })])]);
  assert.equal(r.labelled.length, 1);
  const c = r.labelled[0]!;
  assert.equal(c.key, '128:12');
  assert.deepEqual(c.labels.files.get(PATH), { loose: true, strict: false });
  for (const b of ['B1', 'B2']) assert.deepEqual(c.labels.blocks.get(blockKey(PATH, b)), { loose: false, strict: false });
  assert.equal(r.strict.size, 0);
});

test("the author's own comments and replies in the app's finding threads are not counted, and a reply under a note is", () => {
  const r = liveCases([pull([
    comment('a1', { author: 'octo-dev' }), comment('a2', { author: 'Octo-Dev' }),
    comment('r1', { replyTo: 'c-1' }),
    comment('r2', { replyTo: 'r1' }),
  ])]);
  assert.equal(r.labelled.length, 0);
  for (const replyTo of ['n-1', 'gone']) {
    assert.equal(liveCases([pull([comment('p1', { replyTo })])]).labelled.length, 1, replyTo);
  }
  const loop = liveCases([pull([comment('l1', { replyTo: 'l2' }), comment('l2', { replyTo: 'l1' })])]);
  assert.equal(loop.labelled.length, 1);
});

test('a file-level comment, one on lines of no block, and one on a path the run does not hold label the file only or nothing', () => {
  const only = (c: LiveComment): ReturnType<typeof liveCases> => liveCases([pull([c])]);
  for (const c of [comment('f1', { fileLevel: true }), comment('f2', { line: null }), comment('f3', { line: 200 })]) {
    const run = only(c).labelled[0]!;
    assert.equal(run.labels.files.get(PATH)!.loose, true, c.id);
    for (const b of ['B1', 'B2']) assert.equal(run.labels.blocks.get(blockKey(PATH, b))!.loose, false, c.id);
  }
  assert.equal(only(comment('p1', { path: 'other.ts' })).labelled.length, 0);
  assert.equal(only(comment('p2', { path: null })).labelled.length, 0);
  const left = only(comment('s1', { side: 'LEFT', line: 6 })).labelled[0]!;
  assert.equal(left.labels.blocks.get(blockKey(PATH, 'B1'))!.loose, true);
  assert.equal(only(comment('s2', { side: 'LEFT', line: 40 })).labelled[0]!.labels.blocks.get(blockKey(PATH, 'B1'))!.loose, false);
  const range = only(comment('s3', { startLine: 30, line: 39 })).labelled[0]!;
  assert.equal(range.labels.blocks.get(blockKey(PATH, 'B1'))!.loose, true);
});

test("benefit and focus are measured on each last run, safety on each labelled run, by the backtest's own code", () => {
  const empty = pull([], { number: 9, last: null });
  const r = liveCases([pull([comment('x1')]), empty]);
  assert.equal(r.pulls.length, 1);
  assert.equal(r.pulls[0]!.key, '128');
  assert.equal(r.pulls[0]!.scores, runB.scores);
  assert.equal(countAt(r.pulls, 70).prs, 1);
  assert.equal(countAt(r.labelled, 70).blocks, 1);
  assert.equal(countAt(r.labelled, 70).blocksLeft, 1);
});

test('a stored score is reduced to what is measured, and one of another shape is not measured and never throws', () => {
  const good = stored(PATH, 'dA', [['B1', 'h1', 55, [[1, 2]]]]);
  const oneBlock = (block: Record<string, unknown>): Record<string, unknown> => ({ ...good, blocks: [block] });
  const base = { id: 'B1', hunkHash: 'h', changedLines: 1, entry: null, lines: { RIGHT: [], LEFT: [] } };
  const bad: unknown[] = [
    null, 'x', [{ path: 'a' }], { ...good, finalScore: '70' }, { ...good, changedLines: -1 }, { ...good, diffHash: 3 },
    { ...good, fileLevel: { score: Number.NaN } },
    oneBlock({ id: base.id, hunkHash: base.hunkHash, changedLines: 1, entry: null }),
    oneBlock({ ...base, lines: { RIGHT: [[1]], LEFT: [] } }),
    oneBlock({ ...base, entry: 'x' }),
  ];
  for (const b of bad) assert.equal(storedScores(Array.isArray(b) ? b : [b]), null);
  assert.equal(storedScores(null), null);
  assert.equal(storedScores('x'), null);
  assert.deepEqual(storedScores([]), []);
  const extras = { ...good, changeSummary: 'invented summary', fileLevel: { score: 60, source: 'x' } };
  ((good.blocks as Record<string, unknown>[])[0] as Record<string, unknown>).span = { side: 'RIGHT' };
  const out = storedScores([extras])!;
  assert.deepEqual(Object.keys(out[0]!).sort(), ['blocks', 'changedLines', 'diffHash', 'fileLevel', 'finalScore', 'path']);
  assert.deepEqual(out[0]!.fileLevel, { score: 60 });
  assert.deepEqual(Object.keys(out[0]!.blocks[0]!).sort(), ['changedLines', 'entry', 'hunkHash', 'id', 'lines']);
  assert.deepEqual(out[0]!.blocks[0]!.entry, { score: 55 });
  const absent: Record<string, unknown> = { id: 'B1', hunkHash: 'h', changedLines: 1, lines: { RIGHT: [], LEFT: [] } };
  assert.equal(storedScores([oneBlock(absent)])![0]!.blocks[0]!.entry, null);
});
