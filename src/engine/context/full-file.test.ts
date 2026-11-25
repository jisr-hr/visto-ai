import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePatch } from './diff.ts';
import { fullFileContext, fullFileLines, numberLines } from './full-file.ts';

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n');

test('numbering', () => assert.equal(numberLines('a\nb', 141), '   141| a\n   142| b'));

test('a short file is shown whole, with no phantom last line', () => {
  const f = fullFileContext('a\nb\n', [])!;
  assert.deepEqual([f.kind, f.totalLines, f.text], ['full', 2, '     1| a\n     2| b']);
});

test('a file of exactly 1200 lines is still shown whole', () => {
  const f = fullFileContext(lines(1200), [])!;
  assert.deepEqual([f.kind, f.totalLines], ['full', 1200]);
});

test('a long file is excerpted around each hunk, 150 lines each way', () => {
  const f = fullFileContext(lines(2000), parsePatch('@@ -1000,1 +1000,1 @@\n-x\n+y'))!;
  assert.equal(f.kind, 'excerpt');
  assert.match(f.text, /^@@ lines 850-1150 of 2000 @@\n {3}850\| l850/);
  assert.doesNotMatch(f.text, /l849\b/);
});

test('an excerpt is clamped to the file and a deletion hunk counts one line', () => {
  const f = fullFileContext(lines(2000), parsePatch('@@ -5,2 +4,0 @@\n-x\n-y'))!;
  assert.match(f.text, /^@@ lines 1-154 of 2000 @@/);
});

test('distant excerpts stay separate, joined by a line of dots', () => {
  const f = fullFileContext(lines(2000), parsePatch('@@ -100,1 +100,1 @@\n-x\n+y\n@@ -1500,1 +1500,1 @@\n-x\n+y'))!;
  assert.equal(f.text.match(/@@ lines/g)!.length, 2);
  assert.match(f.text, /\n\.\.\.\n@@ lines 1350-1650 of 2000 @@/);
});

test('touching excerpts merge', () => {
  const f = fullFileContext(lines(2000), parsePatch('@@ -500,1 +500,1 @@\n-x\n+y\n@@ -700,1 +700,1 @@\n-x\n+y'))!;
  assert.equal(f.text.match(/@@ lines/g)!.length, 1);
  assert.match(f.text, /^@@ lines 350-850 of 2000 @@/);
});

test('a long file with no hunks has no context', () => {
  assert.equal(fullFileContext(Array(1300).fill('x').join('\n'), []), null);
});

test('fullFileLines reads back the numbered lines of a full file and of its excerpts', () => {
  const full = fullFileContext('a\n  b|c\nd\n', [])!;
  assert.deepEqual([...fullFileLines(full)], [[1, 'a'], [2, '  b|c'], [3, 'd']]);
  const excerpt = fullFileContext(lines(1300), [{ header: '', oldStart: 600, newStart: 600, newLength: 1, lines: [] }])!;
  const read = fullFileLines(excerpt);
  assert.equal(excerpt.kind, 'excerpt');
  assert.equal(read.get(450), 'l450');
  assert.equal(read.get(750), 'l750');
  assert.equal(read.has(449), false);
  assert.equal(read.has(751), false);
});
