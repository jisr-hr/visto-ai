import assert from 'node:assert/strict';
import test from 'node:test';

import { blockLead, questionsFor, SIGNAL_NAMES, SIGNALS, WHOLE_LEAD, WHOLE_PREFIX } from './jev-questions.ts';

test('SIGNAL_NAMES lists the thirteen signals in order', () => {
  assert.deepEqual(SIGNAL_NAMES, [
    'calculation', 'domain_rule', 'service_contract', 'access_scope', 'persisted_schema', 'security', 'irreversible',
    'dependency', 'weakens', 'display_only', 'declarations_only', 'mechanical', 'test_code',
  ]);
});

test('blockLead points the model at one block', () => {
  assert.equal(
    blockLead('B2'),
    'Look only at block B2: the lines under the header "### Block B2", up to the next block header or the end of the diff.',
  );
});

test('questionsFor builds one noul question per signal, keyed by prefix and name', () => {
  const questions = questionsFor('B2', blockLead('B2'));
  assert.deepEqual(Object.keys(questions), SIGNAL_NAMES.map((name) => `B2_${name}`));
  for (const name of SIGNAL_NAMES) {
    assert.deepEqual(questions[`B2_${name}`], {
      type: 'noul',
      instructions: `${blockLead('B2')} ${SIGNALS[name].ask}`,
      criteria: { true: SIGNALS[name].yes, false: SIGNALS[name].no },
    });
  }
});

test('the whole-file prefix and lead are set', () => {
  assert.equal(WHOLE_PREFIX, 'file');
  assert.equal(Object.keys(questionsFor(WHOLE_PREFIX, WHOLE_LEAD))[0], 'file_calculation');
});

test('no question text holds "and/or" and every ask ends with a question mark', () => {
  for (const name of SIGNAL_NAMES) {
    const { ask, yes, no } = SIGNALS[name];
    assert.ok(ask.endsWith('?'), name);
    for (const text of [ask, yes, no]) assert.ok(!text.includes('and/or'), name);
  }
});
