import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const text = readFileSync(new URL('./review-contract.md', import.meta.url), 'utf8');
const has = (re: RegExp) => assert.match(text, re);

test('answers only through submit_review', () => has(/submit_review/));
test('treats marked text as data', () => { has(/data/i); has(/never change/i); });
test('anchors are copied, not counted', () => { has(/R142/); has(/L98/); has(/never count/i); });
test('certainty is separate from severity', () => has(/never\s+`?major`?\s+or\s+`?blocker`?/i));
test('zero findings is correct', () => has(/zero findings/i));
test('has no nit severity and no leftover tooling', () => {
  assert.doesNotMatch(text, /\bnit\b/i);
  assert.doesNotMatch(text, /chunk|read tool|shell|summary_markdown|inline_comments/i);
});
test('names the three severities', () => { has(/blocker/); has(/major/); has(/minor/); });
