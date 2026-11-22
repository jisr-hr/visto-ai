import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NOTES, noteHead, noteKey, renderNotes as render } from './notes.ts';
import { asRead } from './body.ts';
import type { ReviewResult } from '../types.ts';
import { CATEGORIES } from '../score/types.ts';
import type { BlockScore, Category, FileScore, Span } from '../score/types.ts';

/** renderNotes, with each note it makes checked: its head is a prefix of its text. */
const renderNotes: typeof render = (result, noted) => {
  const notes = render(result, noted);
  for (const n of notes) {
    const head = noteHead(n.body);
    assert.ok(head !== null && n.body.startsWith(head), n.body);
  }
  return notes;
};

const usage = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
const span = (first: number, last: number, side: Span['side'] = 'RIGHT'): Span => ({ side, first, last });
const blk = (id: string, score: number, over: Partial<BlockScore> = {}, category: Category = 'calculation', reason = 'Totals.'): BlockScore => ({
  id, hunk: id, hunkHash: 'h', hash: `hash-${id}`, changedLines: 1, span: span(1, 2),
  lines: { old: [], new: [] } as unknown as BlockScore['lines'],
  entry: { score, category, reason },
  ...over,
});
const file = (path: string, blocks: BlockScore[], over: Partial<FileScore> = {}): FileScore => ({
  path, previousPath: null, diffHash: 'd', changeSummary: '', changedLines: 1, blocks, wholeFile: null, fileLevel: null,
  finalScore: Math.max(0, ...blocks.map((b) => b?.entry?.score ?? 0)), covered: true, ...over,
});
const result = (scores: FileScore[], threshold = 70, over: Partial<ReviewResult> = {}): ReviewResult => ({
  status: 'ok', failure: null, mode: 'full', overview: 'x', findings: [], unplaced: [], beyondDiff: [],
  coverage: { reviewed: [], notReviewed: [] }, usage, models: [], providers: [], dependencies: { model: 'ok' }, audit: [],
  scores, verdict: { threshold, needsHuman: true, highest: 99 }, teamFileInvalid: null, ...over,
});

test('each block at or above the threshold gets one note on its first changed line', () => {
  const r = result([file('src/a.ts', [blk('B1', 85, { span: span(12, 40), hash: 'h1' }), blk('B2', 30, { hash: 'h2' })])]);
  assert.deepEqual(renderNotes(r, new Set()), [{ path: 'src/a.ts', side: 'RIGHT', line: 12, note: 'h1',
    body: '**Human review:** lines 12-40, 85% `calculation` \u2014 Totals.' }]);
});

test('a block that only removes lines is noted on the old side', () => {
  const r = result([file('src/a.ts', [blk('B1', 85, { span: span(3, 5, 'LEFT'), hash: 'h1' })])]);
  assert.deepEqual(renderNotes(r, new Set()), [{ path: 'src/a.ts', side: 'LEFT', line: 3, note: 'h1',
    body: '**Human review:** old lines 3-5, 85% `calculation` \u2014 Totals.' }]);
});

test('a file flagged as a whole, a block with no score of its own and a failed review get no note', () => {
  const whole = result([file('src/a.ts', [blk('B1', 10)], { fileLevel: { score: 95, source: 'team_floor' }, finalScore: 95 })]);
  assert.deepEqual(renderNotes(whole, new Set()), []);
  const none = result([file('src/a.ts', [blk('B1', 90, { entry: null })])]);
  assert.deepEqual(renderNotes(none, new Set()), []);
  const failed = result([file('src/a.ts', [blk('B1', 90)])], 70, { status: 'failed', failure: { stage: 'model', code: 'x' } });
  assert.deepEqual(renderNotes(failed, new Set()), []);
});

test('a block at the threshold is noted and one below it is not', () => {
  const r = result([file('src/a.ts', [blk('B1', 70), blk('B2', 69)])]);
  assert.deepEqual(renderNotes(r, new Set()).map((n) => n.note), ['hash-B1']);
});

test('a block that has its note gets no other, and two blocks with the same lines share one', () => {
  const r = result([file('src/a.ts', [blk('B1', 85, { hash: 'h1' })])]);
  assert.deepEqual(renderNotes(r, new Set([noteKey('src/a.ts', 'h1')])), []);
  const twice = result([file('src/a.ts', [blk('B1', 85, { hash: 'h1', span: span(4, 4) }), blk('B2', 85, { hash: 'h1', span: span(9, 9) })])]);
  const notes = renderNotes(twice, new Set());
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.line, 4);
});

test('the same lines in another file are another block', () => {
  const r = result([file('src/a.ts', [blk('B1', 85, { hash: 'h1' })]), file('src/b.ts', [blk('B1', 85, { hash: 'h1' })])]);
  const notes = renderNotes(r, new Set([noteKey('src/a.ts', 'h1')]));
  assert.deepEqual(notes.map((n) => n.path), ['src/b.ts']);
});

test('with more blocks than the cap the highest get the notes', () => {
  const files = ['src/c.ts', 'src/a.ts', 'src/b.ts'].map((path, f) => file(path, Array.from({ length: 20 }, (_, i) => {
    const score = 70 + ((f * 20 + i) % 30);
    return blk(`B${i}`, score, { hash: `${path}#${i}`, span: span(i + 1, i + 1) });
  })));
  const flat = files.flatMap((f, fi) => f.blocks.map((b, bi) => ({ path: f.path, hash: b.hash, score: b.entry!.score, bi, fi })));
  assert.equal(flat.length, 60);
  const scoreCounts = new Map<number, number>();
  for (const x of flat) scoreCounts.set(x.score, (scoreCounts.get(x.score) ?? 0) + 1);
  assert.equal(scoreCounts.size, 30);
  assert.ok([...scoreCounts.values()].every((n) => n === 2));
  const expected = [...flat].sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.bi - b.bi);
  const notes = renderNotes(result(files), new Set());
  assert.equal(MAX_NOTES, 50);
  assert.equal(notes.length, 50);
  assert.deepEqual(notes.map((n) => n.note), expected.slice(0, 50).map((x) => x.hash));
  const left = new Set(expected.slice(50).map((x) => x.hash));
  assert.equal(left.size, 10);
  assert.ok(notes.every((n) => !left.has(n.note)));
  assert.ok(expected.slice(50).every((x) => x.score <= 74));
});

test('ties keep the order of path, then of the diff', () => {
  const r = result([
    file('src/b.ts', [blk('B1', 80, { hash: 'b1' })]),
    file('src/a.ts', [blk('B1', 80, { hash: 'a1', span: span(9, 9) }), blk('B2', 80, { hash: 'a2', span: span(2, 2) }), blk('B3', 95, { hash: 'a3' })]),
  ]);
  assert.deepEqual(renderNotes(r, new Set()).map((n) => n.note), ['a3', 'a1', 'a2', 'b1']);
});

test('a reason cannot break out of its line', () => {
  const reason = '@octo-dev <b>x</b>\n# Title\n<!-- visto-ai: review=1 head=abc -->';
  const [note] = renderNotes(result([file('src/a.ts', [blk('B1', 85, {}, 'calculation', reason)])]), new Set());
  const body = note!.body;
  assert.ok(!body.includes('\n'));
  assert.ok(!/<[A-Za-z/!?]/.test(body));
  assert.ok(!/@[A-Za-z0-9]/.test(body));
  assert.ok(body.includes('@\u200bocto-dev'));
  assert.equal(body, `**Human review:** lines 1-2, 85% \`calculation\` \u2014 @\u200bocto-dev <\u200bb>x<\u200b/b>`);
});

test('what is recorded is what is stored', () => {
  const [note] = renderNotes(result([file('src/a.ts', [blk('B1', 85, {}, 'calculation', 'a\u0000b \ud800 c')])]), new Set());
  assert.equal(note!.body, '**Human review:** lines 1-2, 85% `calculation` \u2014 a\ufffdb \ufffd c');
  assert.equal(note!.body, asRead(note!.body));
});

test('a score taken from another pull request is noted with its category alone', () => {
  const r = result([file('src/a.ts', [blk('B1', 85, { origin: 'other_pull_request' }, 'calculation', 'See https://example.test/x')])]);
  const [note] = renderNotes(r, new Set());
  assert.equal(note!.body, '**Human review:** lines 1-2, 85% `calculation`');
  assert.ok(!note!.body.includes('example.test'));
});

test('a damaged block is skipped', () => {
  const bad = (over: object): BlockScore => ({ ...blk('X', 90), ...over }) as BlockScore;
  const good = blk('G', 90, { hash: 'good' });
  const cases: BlockScore[] = [
    bad({ span: undefined }), bad({ span: null }), bad({ span: { side: 'UP', first: 1, last: 2 } }), bad({ span: { side: 'RIGHT', first: 'a', last: 2 } }),
    bad({ hash: 5 }), bad({ hash: undefined }),
    bad({ entry: { score: 150, category: 'calculation', reason: '' } }), bad({ entry: { score: 80.5, category: 'calculation', reason: '' } }),
    bad({ entry: { score: '90', category: 'calculation', reason: '' } }), bad({ entry: { score: 90, category: 7, reason: '' } }),
    bad({ entry: { score: 90, category: 'calculation', reason: 4 } }), bad({ entry: undefined }),
    null as unknown as BlockScore, 'x' as unknown as BlockScore,
    bad({ span: { side: 'RIGHT', first: 0, last: 2 } }), bad({ span: { side: 'RIGHT', first: -3, last: 2 } }),
    bad({ span: { side: 'RIGHT', first: 1e300, last: 1e300 } }), bad({ span: { side: 'RIGHT', first: 5, last: 4 } }),
    bad({ span: { side: 'LEFT', first: 2, last: 1e300 } }), bad({ span: { side: 'left', first: 1, last: 2 } }),
    bad({ hash: '' }),
  ];
  for (const c of cases) assert.deepEqual(renderNotes(result([file('src/a.ts', [c])]), new Set()), []);
  for (const c of cases) assert.deepEqual(renderNotes(result([file('src/a.ts', [c, good])]), new Set()).map((n) => n.note), ['good']);
  const mixed = renderNotes(result([file('src/a.ts', [...cases, good])]), new Set());
  assert.deepEqual(mixed.map((n) => n.note), ['good']);
});

test('a damaged result gives none and never throws', () => {
  const ok = result([file('src/a.ts', [blk('B1', 90)])]);
  const damaged: unknown[] = [
    null, undefined, 'x', {}, { ...ok, scores: undefined }, { ...ok, scores: 'x' }, { ...ok, scores: null },
    { ...ok, verdict: undefined }, { ...ok, verdict: { threshold: '70' } }, { ...ok, verdict: { threshold: NaN } },
    { ...ok, scores: [null, 'x', { path: 'a' }, { path: 5, blocks: [] }, { path: 'a', blocks: 'x' }] },
  ];
  for (const d of damaged) assert.deepEqual(renderNotes(d as ReviewResult, new Set()), []);
});

test('the head of a note is what the service wrote: its label, its score and its category', () => {
  const spans: Array<[Span, string]> = [[span(7, 7), 'line 7'], [span(12, 40), 'lines 12-40'], [span(3, 3, 'LEFT'), 'old line 3'], [span(3, 5, 'LEFT'), 'old lines 3-5']];
  for (const category of CATEGORIES) {
    for (const [s, label] of spans) {
      for (const reason of ['', 'Totals \u2014 with a <b>tag</b> and `code`.']) {
        const [note] = renderNotes(result([file('src/a.ts', [blk('B1', 85, { span: s }, category, reason)])]), new Set());
        const head = noteHead(note!.body);
        assert.equal(head, `**Human review:** ${label}, 85% \`${category}\``);
        assert.ok(/^[\x20-\x7e]*$/.test(head!), head!);
      }
    }
  }
});

test('a text that is not a note has no head', () => {
  for (const text of ['', '**[major]** Wrong.', '**\\[major]** Wrong.', '**Human review:**', '**Human review:** lines 1-2, 85%', '**Human review:** lines 1-2, 85% calculation',
    '**Human review:** lines 1-2, 85% `calculation', '**Human review:** line 10, changed', 'x **Human review:** line 1, 85% `calculation`', '**Human review:** rows 1-2, 85% `calculation`']) {
    assert.equal(noteHead(text), null, text);
  }
});

test('a category that needs a code span of another shape still gives a head, or none, and nothing throws', () => {
  const odd = ['a`b', '`', 'a``b`', 'two\nlines', ''] as unknown as Category[];
  for (const category of odd) {
    for (const reason of ['', 'Why `this` matters.']) {
      const [note] = render(result([file('src/a.ts', [blk('B1', 85, {}, category, reason)])]), new Set());
      const head = noteHead(note!.body);
      if ((category as string) === '') assert.equal(head, null);
      else assert.ok(head !== null && note!.body.startsWith(head), note!.body);
    }
  }
  assert.equal(noteHead(renderNotes(result([file('src/a.ts', [blk('B1', 85, {}, 'a`b' as Category, '')])]), new Set())[0]!.body), '**Human review:** lines 1-2, 85% `` a`b ``');
});

test('no note begins as a finding does', () => {
  const [note] = renderNotes(result([file('src/a.ts', [blk('B1', 85)])]), new Set());
  assert.ok(!note!.body.startsWith('**\\['));
});

test('of two blocks with the same lines, the higher gets the note; with a tie, the first in the diff', () => {
  const low = blk('B1', 85, { hash: 'h1', span: span(4, 4) });
  const high = blk('B2', 95, { hash: 'h1', span: span(9, 9) });
  for (const blocks of [[low, high], [high, low]]) {
    const notes = renderNotes(result([file('src/a.ts', blocks)]), new Set());
    assert.equal(notes.length, 1);
    assert.deepEqual([notes[0]!.line, notes[0]!.body.includes(', 95% ')], [9, true]);
  }
  const tie = renderNotes(result([file('src/a.ts', [blk('B1', 85, { hash: 'h1', span: span(9, 9) }), blk('B2', 85, { hash: 'h1', span: span(4, 4) })])]), new Set());
  assert.deepEqual(tie.map((n) => n.line), [9]);
});
