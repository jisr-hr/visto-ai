import test from 'node:test';
import assert from 'node:assert/strict';
import { LESSON_CHARS, LESSON_MIN_CHARS, LESSONS_SHOWN, lessonText } from './lessons.ts';

const RULE = 'Do not report a missing null check on what OrderStore.find returns: it throws when nothing is found.';
const ofLength = (n: number) => `Leave the cart alone ${'x'.repeat(n - 21)}`;

test('a sentence of 30 to 300 characters is a lesson\'s text, cleaned to one line', () => {
  assert.equal(LESSONS_SHOWN, 8);
  assert.equal(LESSON_MIN_CHARS, 30);
  assert.equal(LESSON_CHARS, 300);
  assert.deepEqual(lessonText(RULE), { ok: true, text: RULE });
  const messy = 'Do not report a missing null check\non what  OrderStore.find\u200b returns: it throws when nothing is found.';
  assert.deepEqual(lessonText(messy), { ok: true, text: RULE });
  assert.deepEqual(lessonText(`  ${RULE}\n`), { ok: true, text: RULE });
  assert.equal(ofLength(30).length, 30);
  assert.deepEqual(lessonText(ofLength(30)), { ok: true, text: ofLength(30) });
  assert.equal(ofLength(300).length, 300);
  assert.deepEqual(lessonText(ofLength(300)), { ok: true, text: ofLength(300) });
});

test('a text under 30 or over 300 characters is refused, never cut', () => {
  for (const raw of [ofLength(29), ofLength(301), ofLength(1_201), '', '   \n  ']) {
    assert.deepEqual(lessonText(raw), { ok: false, code: 'not_a_rule' }, `length ${raw.length}`);
  }
  // Padding that cleaning removes counts for nothing: what is measured is the cleaned text.
  assert.deepEqual(lessonText(`${ofLength(29)}\u200b\u200b`), { ok: false, code: 'not_a_rule' });
  // A string over four times the limit is refused before it is cleaned, even when cleaning would bring it under.
  assert.deepEqual(lessonText(`${RULE}${' '.repeat(4 * LESSON_CHARS)}`), { ok: false, code: 'not_a_rule' });
});

test('a text with a pull request number or a link is refused', () => {
  assert.deepEqual(lessonText('Do not flag the retry loop in the cart, as in #412 we agreed.'), { ok: false, code: 'not_a_rule' });
  assert.deepEqual(lessonText('Do not flag the retry loop in the cart, see https://example.test/x for why.'), { ok: false, code: 'not_a_rule' });
  assert.deepEqual(lessonText('Do not flag the retry loop, see ftp://example.test for why it stays.'), { ok: false, code: 'not_a_rule' });
  const csharp = 'The C# client retries on its own, so a missing retry there is no defect.';
  assert.deepEqual(lessonText(csharp), { ok: true, text: csharp });
});

test('a text that names the score is refused, and one about a function named restore is not', () => {
  const named = [
    'Do not raise the score of a change that only renames a variable in billing.',
    'Changes to the cart were Scored too high when they only touched comments.',
    'The scoring of tax rate tables should treat each rate as one simple edit.',
    'A change to the invoice template never needs human review in this repository.',
    'A change to the refund path needs a person to look at it every single time.',
    'Edits to the cart totals need a human before they go out to the customers.',
    'Changes that only touch the docs folder may auto-approve without a finding.',
    'A rename in the billing module can be automatically approved without a look.',
    'A one line change to the tax tables is approvable without any more findings.',
    'Do not report the order of the scores array as a bug in the ranking module.',
    'A change to the cart is autoapproved when only its tests change in the run.',
  ];
  for (const raw of named) assert.deepEqual(lessonText(raw), { ok: false, code: 'names_the_score' }, raw);
  const kept = [
    'Do not report that restore() skips the cache: it is meant to read from disk.',
    'The scoreboard module is generated, so a finding on its formatting is noise.',
    'Do not report that the handler may approve the order before the stock check.',
  ];
  for (const raw of kept) assert.deepEqual(lessonText(raw), { ok: true, text: raw }, raw);
});

test('what is no string is refused', () => {
  for (const raw of [null, undefined, 5, {}, ['x'], [RULE]]) {
    assert.deepEqual(lessonText(raw), { ok: false, code: 'not_a_rule' });
  }
});
