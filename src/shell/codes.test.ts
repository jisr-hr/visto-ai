import test from 'node:test';
import assert from 'node:assert/strict';
import { codeOf, isShortCode } from './codes.ts';

test('a short code is a lower-case letter, then lower-case letters, digits and underscores, at most 40 in all', () => {
  for (const text of ['a', 'github_502', 'x'.repeat(40)]) assert.equal(isShortCode(text), true, text);
  for (const text of ['', '1a', '_a', 'Github', 'a-b', 'a b', 'a\n', 'x'.repeat(41)]) assert.equal(isShortCode(text), false, text);
});
test("an error's code is its message when that is a short code, else internal_error", () => {
  assert.equal(codeOf(new Error('github_502')), 'github_502');
  assert.equal(codeOf(new Error('Something private broke')), 'internal_error');
  assert.equal(codeOf(new Error('x'.repeat(41))), 'internal_error');
  assert.equal(codeOf('github_502'), 'internal_error');
  assert.equal(codeOf({ message: 'github_502' }), 'internal_error');
  assert.equal(codeOf(null), 'internal_error');
});
