import test from 'node:test';
import assert from 'node:assert/strict';
import { storable } from './text.ts';

test('storable removes a NUL character', () => {
  assert.equal(storable('a' + String.fromCharCode(0) + 'b'), 'ab');
});
test('storable replaces a lone surrogate with U+FFFD', () => {
  assert.equal(storable('a' + String.fromCharCode(0xd800) + 'b'), 'a' + String.fromCharCode(0xfffd) + 'b');
});
test('storable keeps a valid surrogate pair and plain text', () => {
  const pair = String.fromCharCode(0xd83d, 0xde00);
  assert.equal(storable('x' + pair), 'x' + pair);
  assert.equal(storable('plain'), 'plain');
});
