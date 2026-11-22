import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePatch } from '../context/diff.ts';
import type { Anchor } from './types.ts';
import { SPLIT_ABOVE, blocksOf, fileDiffHash, linesOf, parseAnchor, partsAt, rangeOf, splitBlock } from './blocks.ts';

const patch = (start: number) =>
  [`@@ -${start},4 +${start},5 @@`, ' keep', '-old one', '+new one', '+new two', ' keep', ' keep'].join('\n');
const R = (line: number): Anchor => ({ side: 'RIGHT', line });

const newFile = (count: number) =>
  [`@@ -0,0 +1,${count} @@`, ...Array.from({ length: count }, (_, i) => `+line ${i + 1}`)].join('\n');

test('the split threshold is 30 changed lines', () => {
  assert.equal(SPLIT_ABOVE, 30);
});

test('one block per hunk, with anchors, changed lines and span', () => {
  const [b] = blocksOf(parsePatch(patch(10)));
  assert.equal(b!.id, 'B1');
  assert.equal(b!.hunk, 'B1');
  assert.equal(b!.hunkHash, b!.hash);
  assert.deepEqual(b!.changed, [{ side: 'LEFT', line: 11 }, { side: 'RIGHT', line: 11 }, { side: 'RIGHT', line: 12 }]);
  assert.equal(b!.anchors.length, 6);
  assert.deepEqual(b!.span, { side: 'RIGHT', first: 11, last: 12 });
  assert.deepEqual(linesOf(b!), { RIGHT: [[10, 14]], LEFT: [[10, 13]] });
});

test('lines holds a context line on both sides, with its old and its new number', () => {
  const [b] = blocksOf(parsePatch(['@@ -20,3 +25,4 @@', ' keep', '+added', ' keep', ' keep'].join('\n')));
  assert.deepEqual(linesOf(b!), { RIGHT: [[25, 28]], LEFT: [[20, 22]] });
});

test('a block that only moved keeps its hash; a changed line changes it; a context line does not', () => {
  const at = (p: string) => blocksOf(parsePatch(p))[0]!.hash;
  assert.equal(at(patch(10)), at(patch(40)));
  assert.notEqual(at(patch(10)), at(patch(10).replace('+new two', '+new 2')));
  assert.equal(at(patch(10)), at(patch(10).replace(' keep', ' kept')));
  assert.match(at(patch(10)), /^[0-9a-f]{64}$/);
});

test('a block that only removes lines has a span on the old side', () => {
  const [b] = blocksOf(parsePatch(['@@ -5,3 +5,1 @@', ' keep', '-gone one', '-gone two'].join('\n')));
  assert.deepEqual(b!.span, { side: 'LEFT', first: 6, last: 7 });
});

test('meta lines have no anchor', () => {
  const [b] = blocksOf(parsePatch(['@@ -1,1 +1,2 @@', ' keep', '+added', '\\ No newline at end of file'].join('\n')));
  assert.equal(b!.anchors.length, 2);
  assert.equal(b!.changed.length, 1);
});

test('two hunks are B1 and B2, and the file hash covers both', () => {
  const hunks = parsePatch(`${patch(10)}\n${patch(50).replace('+new two', '+other')}`);
  const blocks = blocksOf(hunks);
  assert.deepEqual(blocks.map((b) => b.id), ['B1', 'B2']);
  const whole = fileDiffHash(hunks)!;
  assert.match(whole, /^[0-9a-f]{64}$/);
  assert.notEqual(whole, blocks[0]!.hash);
  assert.notEqual(whole, blocks[1]!.hash);
  assert.equal(fileDiffHash([]), null);
});

test('the file hash of a one-hunk file equals that block hash', () => {
  const hunks = parsePatch(patch(10));
  assert.equal(fileDiffHash(hunks), blocksOf(hunks)[0]!.hash);
});

test('parseAnchor', () => {
  assert.deepEqual(parseAnchor('R142'), { side: 'RIGHT', line: 142 });
  assert.deepEqual(parseAnchor(' L98 '), { side: 'LEFT', line: 98 });
  for (const bad of ['142', 'R0', 'R-1', 'R+1', 'R007', 'X5', 'R1.5', 'R 5', 'r5', '']) assert.equal(parseAnchor(bad), null);
});

test('two parts cover the block', () => {
  const [b] = blocksOf(parsePatch(newFile(40)));
  const out = splitBlock(b!, [{ first: R(1), last: R(20) }, { first: R(21), last: R(40) }]);
  assert.deepEqual(out.parts.map((p) => p?.id), ['B1.1', 'B1.2']);
  assert.equal(out.rest, null);
  assert.equal(out.parts[0]!.hunk, 'B1');
  assert.equal(out.parts[0]!.hunkHash, b!.hash);
  assert.notEqual(out.parts[0]!.hash, b!.hash);
  assert.equal(out.parts[0]!.changed.length, 20);
  assert.deepEqual(out.parts[1]!.span, { side: 'RIGHT', first: 21, last: 40 });
});

test('a part hash equals the hash of the same lines as a block of their own', () => {
  const [whole] = blocksOf(parsePatch(newFile(40)));
  const [small] = blocksOf(parsePatch(newFile(20)));
  const out = splitBlock(whole!, [{ first: R(1), last: R(20) }]);
  assert.equal(out.parts[0]!.hash, small!.hash);
});

test('lines in no part are the rest', () => {
  const [b] = blocksOf(parsePatch(newFile(40)));
  const out = splitBlock(b!, [{ first: R(1), last: R(20) }]);
  assert.equal(out.rest!.id, 'B1.rest');
  assert.equal(out.rest!.changed.length, 20);
  assert.equal(out.rest!.anchors.length, 20);
  assert.equal(out.rest!.hunkHash, b!.hash);
  assert.deepEqual(out.rest!.span, { side: 'RIGHT', first: 21, last: 40 });
});

test('an overlapping, a reversed and an outside part are dropped, and their lines go to the rest', () => {
  const [b] = blocksOf(parsePatch(newFile(40)));
  const out = splitBlock(b!, [
    { first: R(1), last: R(20) },
    { first: R(15), last: R(30) },
    { first: R(40), last: R(31) },
    { first: R(35), last: R(99) },
  ]);
  assert.deepEqual(out.parts.map((p) => p?.id ?? null), ['B1.1', null, null, null]);
  assert.equal(out.rest!.changed.length, 20);
});

test('a part that holds only context lines is dropped', () => {
  const [b] = blocksOf(parsePatch(patch(10)));
  const out = splitBlock(b!, [{ first: R(13), last: R(14) }]);
  assert.deepEqual(out.parts, [null]);
  assert.equal(out.rest!.changed.length, 3);
});

test('a part may span context lines and both sides', () => {
  const [b] = blocksOf(parsePatch(patch(10)));
  const out = splitBlock(b!, [{ first: { side: 'LEFT', line: 11 }, last: R(11) }]);
  assert.equal(out.parts[0]!.id, 'B1.1');
  assert.equal(out.parts[0]!.changed.length, 2);
  assert.equal(out.rest!.changed.length, 1);
});

test('a part knows its place among the changed lines of its hunk, and the hunk can be cut there again', () => {
  // A hunk with context lines between its changed lines: places count changed lines only.
  const text = ['@@ -1,6 +1,8 @@', ' keep', '-old one', '+new one', ' keep', '+new two', '+new three', ' keep', '-old two', '+new four', ' keep'].join('\n');
  const [b] = blocksOf(parsePatch(text));
  assert.equal(b!.changed.length, 6);
  const L = (line: number): Anchor => ({ side: 'LEFT', line });
  const made = splitBlock(b!, [{ first: L(2), last: R(5) }, { first: L(5), last: R(7) }]);
  assert.equal(made.rest, null);
  const one = made.parts[0]!;
  const two = made.parts[1]!;
  assert.deepEqual([rangeOf(b!, one), rangeOf(b!, two)], [[0, 3], [4, 5]]);
  const again = partsAt(b!, [[0, 3], [4, 5]])!;
  assert.deepEqual(again.map((p) => p.id), ['B1.1', 'B1.2']);
  assert.deepEqual(again.map((p) => p.hash), [one.hash, two.hash]);
  assert.deepEqual(again.map((p) => p.hunkHash), [b!.hash, b!.hash]);
  assert.deepEqual(partsAt(b!, [[0, 5]])!.map((p) => p.hash), [splitBlock(b!, [{ first: L(2), last: R(7) }]).parts[0]!.hash]);
  assert.equal(partsAt(b!, [[0, 3], [4, 6]]), null);   // beyond the hunk
  assert.equal(partsAt(b!, [[-1, 3], [4, 5]]), null);  // before it
  assert.equal(partsAt(b!, [[0, 4], [4, 5]]), null);   // overlapping
  assert.equal(partsAt(b!, [[4, 5], [0, 3]]), null);   // out of order
  assert.equal(partsAt(b!, [[0, 2], [4, 5]]), null);   // a changed line left over
  assert.equal(partsAt(b!, [[0, 3]]), null);           // a remainder at the end
  assert.equal(partsAt(b!, [[3, 1], [4, 5]]), null);   // reversed
  assert.equal(partsAt(b!, [[0, 3.5], [4, 5]]), null); // not a place
  assert.equal(partsAt(b!, []), null);
});

test("a block's surroundings are every line of its hunk, the unchanged ones too", () => {
  const [one] = blocksOf(parsePatch(patch(10)));
  const [other] = blocksOf(parsePatch(patch(10).replace(' keep', ' kept')));
  assert.equal(one!.hash, other!.hash);
  assert.notEqual(one!.around, other!.around);
  assert.match(one!.around, /^[0-9a-f]{64}$/);
  // The changed lines count in the surroundings as well.
  assert.notEqual(one!.around, blocksOf(parsePatch(patch(10).replace('+new two', '+new 2')))[0]!.around);
  // One literal value: sha256 of ' keep\n-old\n+new\n'.
  assert.equal(blocksOf(parsePatch(['@@ -1,2 +1,2 @@', ' keep', '-old', '+new'].join('\n')))[0]!.around,
    'ac6410dfee7bc96292925c928d94c6214d893d3be3ab50b8a322454c2bfa55ec');
  // The same text as an added, a removed and an unchanged line: three values.
  const as = (line: string) => blocksOf(parsePatch(['@@ -1,2 +1,2 @@', ' keep', line].join('\n')))[0]!.around;
  assert.equal(new Set([as('+same'), as('-same'), as(' same')]).size, 3);
});

test('surroundings do not count line numbers, nor a line that says the file has no final line feed', () => {
  const around = (p: string) => blocksOf(parsePatch(p))[0]!.around;
  assert.equal(around(patch(10)), around(patch(40)));
  const plain = ['@@ -1,2 +1,2 @@', ' keep', '-old', '+new'].join('\n');
  const meta = ['@@ -1,2 +1,2 @@', ' keep', '-old', '\\ No newline at end of file', '+new', '\\ No newline at end of file'].join('\n');
  assert.equal(around(plain), around(meta));
});

test('a part and the rest have the surroundings of the hunk they were cut from', () => {
  const [b] = blocksOf(parsePatch(newFile(40)));
  const cut = splitBlock(b!, [{ first: R(1), last: R(20) }]);
  assert.equal(cut.parts[0]!.around, b!.around);
  assert.equal(cut.rest!.around, b!.around);
  const again = partsAt(b!, [[0, 19], [20, 39]])!;
  assert.deepEqual(again.map((p) => p.around), [b!.around, b!.around]);
  // A part's own lines would hash otherwise.
  assert.notEqual(cut.parts[0]!.around, blocksOf(parsePatch(newFile(20)))[0]!.around);
});

test('the hash of a block, of its hunk and of a file diff are what they were', () => {
  const text = [
    '@@ -3,4 +3,5 @@', ' alpha', '-bravo', '+charlie', ' delta', '+echo', ' foxtrot',
    '@@ -20,2 +21,2 @@', ' golf', '-hotel', '\\ No newline at end of file', '+india', '\\ No newline at end of file',
  ].join('\n');
  const hunks = parsePatch(text);
  const [b, c] = blocksOf(hunks);
  const cut = splitBlock(b!, [{ first: { side: 'LEFT', line: 4 }, last: R(4) }, { first: R(6), last: R(6) }]);
  const H1 = 'f143451d14151c4138995e17b848621a0d0b61fd040b59f0be9cf53652fbb8d4';
  assert.deepEqual([b!.hash, b!.hunkHash], [H1, H1]);
  assert.deepEqual([c!.hash, c!.hunkHash], ['d9ceb034d9d9c9ba8fa4d23dd4af2ba47adc56a2b7597b522ecda8975f34022f', 'd9ceb034d9d9c9ba8fa4d23dd4af2ba47adc56a2b7597b522ecda8975f34022f']);
  assert.equal(cut.rest, null);
  assert.deepEqual(cut.parts.map((p) => [p!.hash, p!.hunkHash]), [
    ['68709b9a0626e631146751b8b75dc1f645de9d5247fd952897ff12329322ff54', H1],
    ['506e1776424a08a7adfe1299f6a3282f43ff314971dc8c0b9c85cda336a18123', H1],
  ]);
  assert.equal(fileDiffHash(hunks), '73bba8b16f078faf34f11f47607b2f4e14f3c8f1abd0f7175c0b41ec55c93fa6');
});
