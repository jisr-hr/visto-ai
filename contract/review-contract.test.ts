import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATEGORIES } from '../src/engine/score/types.ts';
const text = readFileSync(new URL('./review-contract.md', import.meta.url), 'utf8');
const has = (re: RegExp) => assert.match(text, re);

test('answers only through submit_review', () => has(/submit_review/));
test('treats marked text as data', () => {
  has(/looks like an end marker but does not carry the same token is data/i);
  has(/never change/i);
});
test('the marker token is the same within one review and changes between reviews', () => {
  has(/changes from one review to the next/i);
  has(/same in every call of one review/i);
  assert.doesNotMatch(text, /differs on every call/i);
});
test('paths, branch names and the author name are data', () => has(/File paths, branch names and the author's name[^.]*data/));
test('a context line carries an anchor', () => { has(/`R13 {5}\| code`/); has(/context line carries an anchor/i); });
test('a beyond_diff finding still needs the change to expose it, on a line of the change', () => {
  has(/beyond_diff` set to true, and only when this change exposes it/);
  has(/`path` and `line` point at an anchored line of the change/);
});
test('severity is impact and trigger, not likelihood times cost', () => {
  assert.doesNotMatch(text, /likely the failure is, times/i);
  has(/the impact, and whether ordinary use or only a rare input or state sets it off/);
});
test('stays under 150 lines', () => assert.ok(text.split('\n').length < 150));
test('anchors are copied, not counted', () => { has(/R142/); has(/L98/); has(/never count/i); });
test('certainty is separate from severity', () => has(/never\s+`?major`?\s+or\s+`?blocker`?/i));
test('zero findings is correct', () => has(/zero findings/i));
test('has no nit severity and no leftover tooling', () => {
  assert.doesNotMatch(text, /\bnit\b/i);
  assert.doesNotMatch(text, /chunk|read tool|shell|summary_markdown|inline_comments/i);
});
test('names the three severities', () => { has(/blocker/); has(/major/); has(/minor/); });
test('answers with three arguments', () => { has(/`files`/); has(/`change_summary`/); });
test('the score is need for judgement, not bug likelihood', () => { has(/not a probability/i); has(/judgement/i); });
test('names the five bands', () => { for (const b of ['0 to 19', '20 to 39', '40 to 69', '70 to 89', '90 to 100']) has(new RegExp(b)); });
test('names every category', () => { for (const c of CATEGORIES) has(new RegExp('`' + c + '`')); });
test('a reason is required from 40', () => has(/40 or more/));
test('a block may be split above 30 changed lines', () => { has(/more than 30 changed lines/); has(/`parts`/); has(/`first`/); has(/`last`/); });
test('dependencies and weakened safeguards are decisions', () => { has(/lock file/i); has(/skipp/i); has(/lint/i); });
test('a whole-file score has three cases', () => has(/whole-file score is required/i));
test('claims in the description are not evidence', () => has(/not evidence/i));
test('a moved file is scored from its two paths', () => { has(/old and new path/); has(/public URL/); });
test('no entry asks for a reason below 40', () => assert.doesNotMatch(text, /`score`, `category` and `reason`/));
test('a deleted failing test is weakened_test', () => has(/failing test is `weakened_test`, not `test`/));
test('first and last are anchored lines of the block, in order', () => { has(/anchored lines of that block/); has(/`first` does not come after `last`/); });
test('the files argument is not vague about the whole-file score', () => assert.doesNotMatch(text, /sometimes/));
