import test from 'node:test';
import assert from 'node:assert/strict';
import { storable, storableJson, storableValue } from './text.ts';

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
test('storableJson cleans every string, keys included, and leaves other values alone', () => {
  const NUL = String.fromCharCode(0);
  assert.equal(storableJson({ [`k${NUL}`]: [`v${NUL}`, 1, true, null, { n: 0.5 }] }), '{"k":["v",1,true,null,{"n":0.5}]}');
});
test('a value is stored with every string cleaned, keys included', () => {
  const NUL = String.fromCharCode(0);
  assert.deepEqual(storableValue({ ['a' + NUL]: ['b' + NUL, 1, null] }), { a: ['b', 1, null] });
});
