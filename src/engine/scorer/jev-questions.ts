export const SIGNALS = {
  calculation: { ask: 'Does it change how an amount of money, a duration, a balance or a count is computed?', yes: 'A formula, a rate, a rounding rule or the inputs of a computation of money, time, balance or count change.', no: 'No computation of money, time, balance or count changes.' },
  domain_rule: { ask: 'Does it change a rule of the business: who qualifies, what is allowed, or which case gets which outcome?', yes: 'A condition, a default or a branch that decides a business outcome changes.', no: 'No business outcome is decided differently.' },
  service_contract: { ask: 'Does it add or change something that other modules or services call: a function signature, an endpoint, an event or a stored format?', yes: 'A name, a parameter, a return value or a payload that callers outside this file rely on is added or changed.', no: 'Nothing that callers outside this file rely on changes.' },
  access_scope: { ask: 'Does it change, on the server, which records or actions a user may reach?', yes: 'Server-side code that grants, denies or filters by permission, role or tenant changes.', no: 'No server-side permission, role or tenant check changes.' },
  persisted_schema: { ask: 'Does it change a database table, column, index or constraint?', yes: 'A migration or a schema definition adds, removes or alters a table, column, index or constraint.', no: 'No database table, column, index or constraint changes.' },
  security: { ask: 'Does it change authentication, session handling, secrets, encryption or security configuration?', yes: 'Code or configuration for authentication, sessions, secrets, encryption or security settings changes.', no: 'None of those change.' },
  irreversible: { ask: 'Does it delete or rewrite stored data in a way that cannot be undone?', yes: 'Stored data is deleted or rewritten with no way back.', no: 'No stored data is deleted or rewritten irreversibly.' },
  dependency: { ask: 'Does it add a dependency or change the version of one?', yes: 'A dependency is added, removed or moved to another version.', no: 'No dependency or version changes.' },
  weakens: { ask: 'Does it remove, skip or loosen a test, an assertion, a lint rule, a type check or a CI step?', yes: 'A test, an assertion or a check is removed, skipped or made less strict.', no: 'No test, assertion or check is removed, skipped or loosened.' },
  display_only: { ask: 'Does it change only what the user sees: text, labels, translations, layout, styling, or which screen is shown?', yes: 'Only what is displayed changes.', no: 'Something other than what is displayed changes.' },
  declarations_only: { ask: 'Does it consist only of type declarations, imports, exports or constants, with no executable logic?', yes: 'Only declarations, imports, exports or constants.', no: 'It contains executable logic.' },
  mechanical: { ask: 'Is it only a rename, a move, formatting or generated output?', yes: 'Only a rename, a move, formatting or generated output.', no: 'It changes behaviour or content.' },
  test_code: { ask: 'Is it test code?', yes: 'It is part of a test.', no: 'It is not test code.' },
} as const;

export type SignalName = keyof typeof SIGNALS;
export const SIGNAL_NAMES = Object.keys(SIGNALS) as SignalName[];

export interface NoulQuestion { type: 'noul'; instructions: string; criteria: { true: string; false: string } }

export const WHOLE_PREFIX = 'file';
export const WHOLE_LEAD = 'This file moved to another directory and its content did not change. Judge the move itself.';

export function blockLead(id: string): string {
  return `Look only at block ${id}: the lines under the header "### Block ${id}", up to the next block header or the end of the diff.`;
}

export function questionsFor(prefix: string, lead: string): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  for (const name of SIGNAL_NAMES) {
    questions[`${prefix}_${name}`] = {
      type: 'noul',
      instructions: `${lead} ${SIGNALS[name].ask}`,
      criteria: { true: SIGNALS[name].yes, false: SIGNALS[name].no },
    };
  }
  return questions;
}
