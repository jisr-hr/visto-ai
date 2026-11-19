import test from 'node:test';
import assert from 'node:assert/strict';
import { commandOf, failureText, refusalText } from './commands.ts';

test('/review is a command on the first line that is not empty, in any case, alone or followed by text', () => {
  for (const body of ['/review', '  /Review  ', '\n\n/REVIEW\nthanks', '/review please', '/review\tnow']) assert.equal(commandOf(body), 'review');
});
test('anything else is not a command', () => {
  for (const body of ['', 'please /review', '/reviews', '/reviewed', 'thanks\n/review', '/ review', '/done']) assert.equal(commandOf(body), null);
});
test('the answers are one fixed sentence with a short code', () => {
  assert.equal(refusalText('octo-dev', 'not_allowed'), '@octo-dev The review was not started (`not_allowed`).');
  assert.equal(failureText('octo-dev', 'review_failed'), '@octo-dev The review did not finish (`review_failed`).');
  assert.equal(refusalText(null, 'closed'), 'The review was not started (`closed`).');
  assert.equal(refusalText('not a login', 'closed'), 'The review was not started (`closed`).');
  assert.equal(failureText('octo-dev', 'Something long went wrong'), '@octo-dev The review did not finish (`internal_error`).');
});
