import assert from 'node:assert/strict';
import test from 'node:test';
import type { LineTexts, Ranges } from '../context/diff.ts';
import type { RawFinding, Side } from '../types.ts';
import { normalizePath, place } from './placement.ts';

const base = { path: 'src/a.ts', severity: 'major', body: 'Something is off.', quote: 'x = 1' } as const;
const f = (side: Side, line: number): RawFinding => ({ ...base, side, line, beyond_diff: false });
const ranges: Ranges = { RIGHT: [[10, 13]], LEFT: [[11, 11]] };
const multi: Ranges = { RIGHT: [[1, 3], [40, 42]], LEFT: [] };
const wide: Ranges = { RIGHT: [[10, 20]], LEFT: [[1, 2]] };

function landing(r: ReturnType<typeof place>): string {
  assert.ok('placed' in r, 'expected a placed finding');
  return `${r.placed.side}:${r.placed.line}:${r.placed.requestedLine}`;
}

test('inside a range', () =>
  assert.deepEqual(place(f('RIGHT', 12), ranges), { placed: { ...base, side: 'RIGHT', line: 12, requestedLine: null }, how: 'as_given' }));

test('two lines below the hunk moves up and remembers the line', () => {
  const r = place(f('RIGHT', 15), ranges);
  assert.ok('placed' in r && r.placed.line === 13 && r.placed.requestedLine === 15);
});

test('four lines away is not placed', () => {
  const r = place(f('RIGHT', 17), ranges);
  assert.ok('unplaced' in r && r.unplaced.reason === 'line_not_in_diff');
  assert.equal(r.unplaced.line, 17);
});

test('never moved to the other side', () => {
  assert.equal(landing(place(f('LEFT', 12), ranges)), 'LEFT:11:12');
  const none = place(f('LEFT', 2), multi);
  assert.ok('unplaced' in none && none.unplaced.reason === 'line_not_in_diff');
  assert.equal(none.unplaced.side, 'LEFT');
});

test('same line is in range on one side and not the other', () => {
  assert.equal(landing(place(f('RIGHT', 15), wide)), 'RIGHT:15:null');
  assert.ok('unplaced' in place(f('LEFT', 15), wide));
  assert.equal(landing(place(f('LEFT', 1), wide)), 'LEFT:1:null');
  assert.ok('unplaced' in place(f('RIGHT', 1), wide));
});

test('a file with no diff', () => {
  const r = place(f('RIGHT', 1), null);
  assert.ok('unplaced' in r && r.unplaced.reason === 'file_has_no_patch');
});

test('range bounds are inclusive, over every range of a side', () => {
  assert.equal(landing(place(f('RIGHT', 10), wide)), 'RIGHT:10:null');
  assert.equal(landing(place(f('RIGHT', 20), wide)), 'RIGHT:20:null');
  assert.equal(landing(place(f('RIGHT', 41), multi)), 'RIGHT:41:null');
  assert.equal(landing(place(f('RIGHT', 1), multi)), 'RIGHT:1:null');
  assert.ok('unplaced' in place(f('RIGHT', 6), wide));
  assert.ok('unplaced' in place(f('RIGHT', 24), wide));
  assert.ok('unplaced' in place(f('RIGHT', 20), multi));
});

test('nearest edge wins backward and forward', () => {
  assert.equal(landing(place(f('RIGHT', 23), wide)), 'RIGHT:20:23');
  assert.equal(landing(place(f('RIGHT', 45), multi)), 'RIGHT:42:45');
  assert.equal(landing(place(f('RIGHT', 8), wide)), 'RIGHT:10:8');
  assert.equal(landing(place(f('RIGHT', 13), { RIGHT: [[10, 20]], LEFT: [] })), 'RIGHT:13:null');
});

test('a later range can win', () => {
  assert.equal(landing(place(f('RIGHT', 38), multi)), 'RIGHT:40:38');
});

test('exactly three lines away still moves', () => {
  assert.equal(landing(place(f('RIGHT', 16), ranges)), 'RIGHT:13:16');
  assert.equal(landing(place(f('RIGHT', 7), ranges)), 'RIGHT:10:7');
});

test('a tie keeps the earlier range', () => {
  const r: Ranges = { RIGHT: [[1, 4], [10, 12]], LEFT: [] };
  assert.equal(landing(place(f('RIGHT', 7), r)), 'RIGHT:4:7');
});

test('a LEFT line moves within LEFT', () => {
  assert.equal(landing(place(f('LEFT', 4), wide)), 'LEFT:2:4');
});

test('other fields are carried through', () => {
  const r = place(f('RIGHT', 15), ranges);
  assert.ok('placed' in r);
  assert.deepEqual(
    { path: r.placed.path, severity: r.placed.severity, body: r.placed.body, quote: r.placed.quote },
    { path: base.path, severity: base.severity, body: base.body, quote: base.quote },
  );
});

test('normalizePath: exact match, then one prefix removed', () => {
  const known = new Set(['src/a.ts']);
  assert.equal(normalizePath('src/a.ts', known), 'src/a.ts');
  for (const prefixed of ['./src/a.ts', '/src/a.ts', 'a/src/a.ts', 'b/src/a.ts']) {
    assert.equal(normalizePath(prefixed, known), 'src/a.ts', prefixed);
  }
  assert.equal(normalizePath('other/x.ts', known), null);
});

test('normalizePath prefers an exact match over stripping', () => {
  const known = new Set(['a/src/a.ts', 'src/a.ts']);
  assert.equal(normalizePath('a/src/a.ts', known), 'a/src/a.ts');
});

test('normalizePath removes only one prefix', () => {
  assert.equal(normalizePath('./a/src/a.ts', new Set(['src/a.ts'])), null);
});

test('a path named like an object property is just a path', () => {
  assert.equal(normalizePath('toString', new Set(['src/a.ts'])), null);
  assert.equal(normalizePath('constructor', new Set<string>()), null);
  assert.equal(normalizePath('toString', new Set(['toString'])), 'toString');
});

// The texts of `ranges`: RIGHT 10-13, LEFT 11.
const texts: LineTexts = {
  RIGHT: new Map([[10, 'reset()'], [11, 'total = a + b'], [12, '  return total\r'], [13, 'total = a + b']]),
  LEFT: new Map([[11, 'reset()']]),
};
const leftOnly: LineTexts = { RIGHT: new Map([[10, 'a'], [11, 'b'], [12, 'c'], [13, 'd']]), LEFT: new Map([[11, 'old_total()']]) };
const q = (side: Side, line: number, quote: string): RawFinding => ({ ...f(side, line), quote });
const how = (r: ReturnType<typeof place>): string => ('placed' in r ? `${landing(r)}:${r.how}` : `unplaced:${r.unplaced.reason}`);

test('a quote that is the text of the given line keeps it as given', () => {
  assert.equal(how(place(q('RIGHT', 12, 'return total'), ranges, texts)), 'RIGHT:12:null:as_given');
});

test('a given line that can take a comment keeps the finding, whatever its quote, so the line the model named still decides the mode', () => {
  assert.equal(how(place(q('RIGHT', 10, 'return total'), ranges, texts)), 'RIGHT:10:null:as_given');
});

test('a given line that cannot take a comment gives way to the line its quote names, with no note', () => {
  assert.equal(how(place(q('RIGHT', 30, 'return total'), ranges, texts)), 'RIGHT:12:null:quote');
  assert.equal(how(place(q('RIGHT', 15, 'reset()'), ranges, texts)), 'RIGHT:10:null:quote');
});

const tieTexts: LineTexts = { RIGHT: new Map([[1, 'a'], [2, 'dup'], [3, 'b'], [40, 'c'], [41, 'd'], [42, 'dup']]), LEFT: new Map() };
test('of several lines the quote names, the nearest wins and a tie goes to the earlier', () => {
  assert.equal(how(place(q('RIGHT', 30, 'total = a + b'), ranges, texts)), 'RIGHT:13:null:quote');
  assert.equal(how(place(q('RIGHT', 5, 'total = a + b'), ranges, texts)), 'RIGHT:11:null:quote');
  assert.equal(how(place(q('RIGHT', 22, 'dup'), multi, tieTexts)), 'RIGHT:2:null:quote');
});

test('a quote matches after white space at both ends is trimmed, a carriage return too', () => {
  assert.equal(how(place(q('RIGHT', 30, '    return total\r'), ranges, texts)), 'RIGHT:12:null:quote');
});

test('a quote found only on the other side moves the finding to that side', () => {
  assert.equal(how(place(q('RIGHT', 30, 'old_total()'), ranges, leftOnly)), 'LEFT:11:null:quote');
});

test("a quote on both sides goes to the finding's own side", () => {
  assert.equal(how(place(q('LEFT', 2, 'reset()'), ranges, texts)), 'LEFT:11:null:quote');
  assert.equal(how(place(q('RIGHT', 30, 'reset()'), ranges, texts)), 'RIGHT:10:null:quote');
});

test('an empty or blank quote leaves the line rules', () => {
  assert.equal(how(place(q('RIGHT', 15, ''), ranges, texts)), 'RIGHT:13:15:line');
  assert.equal(how(place(q('RIGHT', 15, '   '), ranges, texts)), 'RIGHT:13:15:line');
});

test('a quote that matches nothing leaves the line rules', () => {
  assert.equal(how(place(q('RIGHT', 12, 'nowhere()'), ranges, texts)), 'RIGHT:12:null:as_given');
  assert.equal(how(place(q('RIGHT', 30, 'nowhere()'), ranges, texts)), 'unplaced:line_not_in_diff');
});

test('no texts keeps the line rules', () => {
  assert.equal(how(place(q('RIGHT', 10, 'return total'), ranges, null)), 'RIGHT:10:null:as_given');
  assert.equal(how(place(q('RIGHT', 30, 'return total'), ranges, null)), 'unplaced:line_not_in_diff');
});
