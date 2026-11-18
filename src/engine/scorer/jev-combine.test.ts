import assert from 'node:assert/strict';
import test from 'node:test';

import { CATEGORIES } from '../score/types.ts';
import { type Answers, combine } from './jev-combine.ts';
import { SIGNAL_NAMES } from './jev-questions.ts';

const p = (over: Partial<Answers>): Answers =>
  ({ ...Object.fromEntries(SIGNAL_NAMES.map((name) => [name, 0])), ...over }) as Answers;

test('a hard answer is never lowered', () => {
  assert.deepEqual(combine(p({ persisted_schema: 0.9, declarations_only: 0.6 })), {
    score: 90, category: 'data_model', reason: 'Changes a database table, column, index or constraint: 90% likely.',
  });
});

test('a lowering answer lowers a soft one and says so', () => {
  assert.deepEqual(combine(p({ domain_rule: 0.8, display_only: 0.75 })), {
    score: 20, category: 'other',
    reason: 'Changes a rule of the business: 80% likely. Lowered by 75%: it changes only what the user sees.',
  });
});

test('a soft answer alone wins with no lowered clause', () => {
  assert.deepEqual(combine(p({ domain_rule: 0.6 })), {
    score: 60, category: 'business_rule', reason: 'Changes a rule of the business: 60% likely.',
  });
});

test('ties: the hard answer beats a soft one, and the first in order beats the rest', () => {
  const hard = combine(p({ service_contract: 0.6, access_scope: 0.6 }));
  assert.equal(hard.category, 'permission');
  assert.equal(hard.score, 60);
  assert.equal(combine(p({ calculation: 0.7, domain_rule: 0.7 })).category, 'calculation');
});

test('test code lowers a soft answer and names the category test below 50', () => {
  const item = combine(p({ domain_rule: 0.8, test_code: 0.9 }));
  assert.equal(item.score, 8);
  assert.equal(item.category, 'test');
  assert.match(item.reason, /Lowered by 90%: it is test code\.$/);
});

test('test code does not lower once a test is weakened', () => {
  assert.deepEqual(combine(p({ weakens: 0.7, test_code: 0.9, domain_rule: 0.5 })), {
    score: 70, category: 'weakened_test', reason: 'Removes, skips or loosens a test, an assertion or a check: 70% likely.',
  });
  assert.deepEqual(combine(p({ weakens: 0.6, domain_rule: 0.9, test_code: 0.8 })), {
    score: 90, category: 'business_rule', reason: 'Changes a rule of the business: 90% likely.',
  });
});

test('all zeros give 0, other, and the first hard answer as the reason', () => {
  assert.deepEqual(combine(p({})), {
    score: 0, category: 'other',
    reason: 'Changes, on the server, which records or actions a user may reach: 0% likely.',
  });
});

test('a lowering answer that rounds to 0% adds no lowered clause', () => {
  assert.deepEqual(combine(p({ domain_rule: 1, mechanical: 0.004 })), {
    score: 100, category: 'business_rule', reason: 'Changes a rule of the business: 100% likely.',
  });
});

test('every category combine can return is a known category', () => {
  const names = SIGNAL_NAMES.filter((name) => !['display_only', 'declarations_only', 'mechanical', 'test_code'].includes(name));
  const returned = [combine(p({})), combine(p({ test_code: 0.9 }))];
  for (const name of names) returned.push(combine(p({ [name]: 0.9 })));
  for (const item of returned) assert.ok((CATEGORIES as readonly string[]).includes(item.category), item.category);
});
