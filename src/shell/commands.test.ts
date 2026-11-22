import test from 'node:test';
import assert from 'node:assert/strict';
import { commandOf, commandText, failureText, mayCommand, refusalText, skipReasonOf } from './commands.ts';

test('/review is a command on the first line that is not empty, in any case, alone or followed by text', () => {
  for (const body of ['/review', '  /Review  ', '\n\n/REVIEW\nthanks', '/review please', '/review\tnow']) assert.equal(commandOf(body), 'review');
});
test('anything else is not a command', () => {
  for (const body of ['', 'please /review', '/reviews', '/reviewed', 'thanks\n/review', '/ review']) assert.equal(commandOf(body), null);
});
test('the answers are one fixed sentence with a short code', () => {
  assert.equal(refusalText('octo-dev', 'not_allowed'), '@octo-dev The review was not started (`not_allowed`).');
  assert.equal(failureText('octo-dev', 'review_failed'), '@octo-dev The review did not finish (`review_failed`).');
  assert.equal(refusalText(null, 'closed'), 'The review was not started (`closed`).');
  assert.equal(refusalText('not a login', 'closed'), 'The review was not started (`closed`).');
  assert.equal(failureText('octo-dev', 'Something long went wrong'), '@octo-dev The review did not finish (`internal_error`).');
});

test('a body with CRLF line ends or a leading byte-order mark is read the same way', () => {
  assert.equal(commandOf('\r\n\r\n/review\r\nthanks'), 'review');
  assert.equal(commandOf('\ufeff/review'), 'review');
});
test('/review followed by a no-break space is not a command', () => {
  assert.equal(commandOf('/review\u00a0now'), null);
});
test('a login of 39 characters is written, one of 40 or with a trailing newline is not', () => {
  const l39 = 'a'.repeat(39);
  assert.equal(refusalText(l39, 'closed'), `@${l39} The review was not started (\`closed\`).`);
  assert.equal(refusalText('a'.repeat(40), 'closed'), 'The review was not started (`closed`).');
  assert.equal(refusalText('octo-dev\n', 'closed'), 'The review was not started (`closed`).');
});
test('a code of 40 characters is written, one of 41 gives internal_error', () => {
  const c40 = 'a'.repeat(40);
  assert.equal(refusalText(null, c40), `The review was not started (\`${c40}\`).`);
  assert.equal(refusalText(null, 'a'.repeat(41)), 'The review was not started (`internal_error`).');
});
test('an owner, a member or a collaborator may command the service, and nobody else', () => {
  for (const association of ['owner', 'member', 'collaborator']) assert.equal(mayCommand(association), true);
  for (const association of [null, '', 'none', 'contributor', 'first_time_contributor', 'Owner', ' member']) assert.equal(mayCommand(association), false, String(association));
});

test('/done and /ai-review-skip are commands on the first line that is not empty, in any case', () => {
  for (const body of ['/done', '/DONE', '/Done please', '\n/done', '  /done', '/done\nmore', '/done\r\nmore', '/done\tnow']) assert.equal(commandOf(body), 'done', body);
  for (const body of ['/donezo', 'all good\n/done', '/ done', '/done\u00a0now']) assert.equal(commandOf(body), null, body);
  for (const body of ['/ai-review-skip hotfix, checked by hand', '/ai-review-skip', '/AI-Review-Skip\tx', '\n/ai-review-skip\nlater']) assert.equal(commandOf(body), 'skip', body);
  for (const body of ['/ai-review-skipper x', 'x /ai-review-skip y', 'thanks\n/ai-review-skip y']) assert.equal(commandOf(body), null, body);
});
test('the reason of a skip is the rest of its line', () => {
  assert.equal(skipReasonOf('/ai-review-skip hotfix, checked by hand'), 'hotfix, checked by hand');
  assert.equal(skipReasonOf('\n  /ai-review-skip \t urgent fix  \nsecond line'), 'urgent fix');
  assert.equal(skipReasonOf('/ai-review-skip'), '');
  assert.equal(skipReasonOf('/ai-review-skip   '), '');
  assert.equal(skipReasonOf('/ai-review-skip\nreason on the next line'), '');
  assert.equal(skipReasonOf('/done'), '');
  assert.equal(skipReasonOf('/review now'), '');
  assert.equal(skipReasonOf('/ai-review-skipper x'), '');
});
test('the sentence of a command is written with any text', () => {
  assert.equal(commandText('octo-lead', 'X', 'closed'), '@octo-lead X (`closed`).');
  assert.equal(commandText(null, 'X', 'closed'), 'X (`closed`).');
  assert.equal(commandText('octo-lead', 'X', 'It broke'), '@octo-lead X (`internal_error`).');
  assert.equal(refusalText('octo-dev', 'closed'), '@octo-dev The review was not started (`closed`).');
  assert.equal(failureText('octo-dev', 'review_failed'), '@octo-dev The review did not finish (`review_failed`).');
});
