import type { Category } from '../score/types.ts';
import type { ScoredItem } from '../types.ts';
import type { SignalName } from './jev-questions.ts';

export type Answers = Record<SignalName, number>;

type Soft = 'calculation' | 'domain_rule' | 'service_contract';
type Hard = 'access_scope' | 'persisted_schema' | 'security' | 'irreversible' | 'dependency' | 'weakens';
type Lowering = 'display_only' | 'declarations_only' | 'mechanical' | 'test_code';

const SOFT: Soft[] = ['calculation', 'domain_rule', 'service_contract'];
const HARD: Hard[] = ['access_scope', 'persisted_schema', 'security', 'irreversible', 'dependency', 'weakens'];
const LOWERING: Lowering[] = ['display_only', 'declarations_only', 'mechanical', 'test_code'];

const CATEGORY: Record<Soft | Hard, Category> = {
  calculation: 'calculation',
  domain_rule: 'business_rule',
  service_contract: 'public_contract',
  access_scope: 'permission',
  persisted_schema: 'data_model',
  security: 'security_configuration',
  irreversible: 'migration',
  dependency: 'dependency',
  weakens: 'weakened_test',
};

const SENTENCE: Record<Soft | Hard, string> = {
  calculation: 'Changes how an amount of money, a duration, a balance or a count is computed',
  domain_rule: 'Changes a rule of the business',
  service_contract: 'Adds or changes something that other modules or services call',
  access_scope: 'Changes, on the server, which records or actions a user may reach',
  persisted_schema: 'Changes a database table, column, index or constraint',
  security: 'Changes authentication, session handling, secrets, encryption or security configuration',
  irreversible: 'Deletes or rewrites stored data in a way that cannot be undone',
  dependency: 'Adds a dependency or changes the version of one',
  weakens: 'Removes, skips or loosens a test, an assertion or a check',
};

const WHY: Record<Lowering, string> = {
  display_only: 'it changes only what the user sees',
  declarations_only: 'it holds only declarations',
  mechanical: 'it is only a rename, a move, formatting or generated output',
  test_code: 'it is test code',
};

const percent = (x: number): number => Math.round(100 * x);

/** The first name holding the highest answer. */
function highest<N extends SignalName>(names: N[], p: Answers): N {
  let best = names[0]!;
  for (const name of names) if (p[name] > p[best]) best = name;
  return best;
}

export function combine(p: Answers): ScoredItem {
  // Test code does not lower the score of a change that weakens a test.
  const lowering = (name: Lowering): number => (name === 'test_code' && p.weakens >= 0.5 ? 0 : p[name]);
  let lowerName: Lowering = LOWERING[0]!;
  for (const name of LOWERING) if (lowering(name) > lowering(lowerName)) lowerName = name;
  const lower = lowering(lowerName);

  const hard = highest(HARD, p);
  const soft = highest(SOFT, p);
  const loweredSoft = p[soft] * (1 - lower);
  const hardWins = p[hard] >= loweredSoft;
  const winner = hardWins ? hard : soft;
  const score = percent(hardWins ? p[hard] : loweredSoft);

  const category: Category = score >= 50 ? CATEGORY[winner] : p.test_code >= 0.5 ? 'test' : 'other';
  let reason = `${SENTENCE[winner]}: ${percent(p[winner])}% likely.`;
  if (!hardWins && percent(lower) >= 1) reason += ` Lowered by ${percent(lower)}%: ${WHY[lowerName]}.`;
  return { score, category, reason };
}
