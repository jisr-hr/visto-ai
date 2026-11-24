import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRequest, ModelResponse, Usage } from '../../engine/types.ts';
import { ProviderError } from '../../engine/model/errors.ts';
import {
  askMatches, judgeSummary, matchCase, matchMessages, MATCH_RULES, MATCH_TOOL, readMatches, SUBMIT_MATCHES,
  type JudgedFinding, type MatchReference,
} from './match.ts';

const TOKEN = 't0k';
const usage = (cost: number): Usage => ({ calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 5, cost });
const ZERO: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
const response = (over: Partial<ModelResponse> = {}): ModelResponse =>
  ({ toolName: null, toolArguments: null, text: null, model: 'm', provider: null, usage: usage(0.01), ...over });
const called = (args: string | null): ModelResponse => response({ toolName: SUBMIT_MATCHES, toolArguments: args });
const FINDING = { line: 12, body: 'The total is computed before the discount.' };
const REFS: MatchReference[] = [
  { startLine: 4, line: 6, text: 'Apply the discount first.' },
  { startLine: null, line: 9, text: 'Rename this helper.' },
  { startLine: 3, line: 3, text: 'Same line twice.' },
  { startLine: null, line: null, text: 'No line.' },
];

type Step = ModelResponse | Error;
function model(steps: Step[]) {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request: ModelRequest): Promise<ModelResponse> => {
      requests.push(structuredClone(request));
      const step = steps.shift();
      if (step === undefined) throw new Error('no more steps');
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

test('readMatches turns numbers into indices and drops duplicates', () => {
  assert.deepEqual(readMatches('{"matches":[2,2,1]}', 3), { ok: true, value: { matches: [0, 1], reason: '' } });
});

test('readMatches refuses a number out of range', () => {
  assert.equal(readMatches('{"matches":[4]}', 3).ok, false);
  assert.equal(readMatches('{"matches":[0]}', 3).ok, false);
});

test('readMatches refuses a non-integer, not json, and no matches field', () => {
  assert.equal(readMatches('{"matches":[1.5]}', 3).ok, false);
  assert.equal(readMatches('not json', 3).ok, false);
  assert.equal(readMatches('{"reason":"x"}', 3).ok, false);
  assert.equal(readMatches(null, 3).ok, false);
  assert.equal(readMatches('[1]', 3).ok, false);
});

test('readMatches keeps the reason', () => {
  assert.deepEqual(readMatches('{"matches":[],"reason":"Different concern."}', 2),
    { ok: true, value: { matches: [], reason: 'Different concern.' } });
});

test('the tool requires matches and reason', () => {
  assert.equal(MATCH_TOOL.function.name, SUBMIT_MATCHES);
  assert.deepEqual(MATCH_TOOL.function.parameters.required, ['matches', 'reason']);
});

test('matchMessages numbers the references from 1 between markers and shows their lines', () => {
  const [system, user] = matchMessages('src/cart.ts', FINDING, REFS, TOKEN);
  assert.equal(system!.content, MATCH_RULES);
  const text = user!.content;
  assert.match(text, /File:\n<<<data t0k path>>>\nsrc\/cart\.ts\n<<<end t0k>>>/);
  assert.match(text, /Comment at line 12:\n<<<data t0k finding>>>\nThe total is computed before the discount\.\n<<<end t0k>>>/);
  assert.match(text, /Reference 1, lines 4-6:\n<<<data t0k reference_1>>>\nApply the discount first\./);
  assert.match(text, /Reference 2, line 9:\n<<<data t0k reference_2>>>/);
  assert.match(text, /Reference 3, line 3:\n<<<data t0k reference_3>>>/);
  assert.match(text, /Reference 4, lines not given:\n<<<data t0k reference_4>>>/);
});

test('matchMessages cuts long texts and strips the token', () => {
  const long = 'x'.repeat(5000);
  const text = matchMessages('a.ts', { line: 1, body: long }, [{ startLine: null, line: 1, text: `t0k${long}` }], TOKEN)[1]!.content;
  assert.ok(text.length < 5000);
  assert.equal((text.match(/t0k/g) ?? []).length, 6);
});

test('askMatches answers on the first valid call', async () => {
  const m = model([called('{"matches":[1],"reason":"Same."}')]);
  const out = await askMatches(m, 'a.ts', FINDING, REFS, TOKEN, false, 1000);
  assert.deepEqual(out, { ok: true, value: { matches: [0], reason: 'Same.' }, usage: usage(0.01) });
  assert.equal(m.requests.length, 1);
});

test('askMatches retries once, then fails with invalid_output', async () => {
  const m = model([called('{"matches":[9]}'), called('nope')]);
  const out = await askMatches(m, 'a.ts', FINDING, REFS, TOKEN, false, 1000);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.code, 'invalid_output');
    assert.equal(out.usage.calls, 2);
    assert.ok(Math.abs(out.usage.cost - 0.02) < 1e-9);
  }
  assert.equal(m.requests.length, 2);
  const retry = m.requests[1]!.messages;
  assert.equal(retry.at(-2)!.role, 'assistant');
  assert.equal(retry.at(-2)!.content, '{"matches":[9]}');
  assert.match(retry.at(-1)!.content, /rejected/);
});

test('askMatches recovers on the retry', async () => {
  const m = model([response({ text: 'hello' }), called('{"matches":[]}')]);
  const out = await askMatches(m, 'a.ts', FINDING, REFS, TOKEN, false, 1000);
  assert.equal(out.ok, true);
  assert.equal(m.requests[1]!.messages.at(-2)!.content, 'hello');
});

test('askMatches answers a provider error with its kind', async () => {
  const err = new ProviderError('timeout', 'timeout', null, null);
  const out = await askMatches(model([err]), 'a.ts', FINDING, REFS, TOKEN, false, 1000);
  assert.deepEqual(out, { ok: false, code: 'timeout', usage: ZERO });
});

test('askMatches passes on any other error', async () => {
  await assert.rejects(askMatches(model([new Error('boom')]), 'a.ts', FINDING, REFS, TOKEN, false, 1000), /boom/);
});

test('askMatches forces the tool unless auto', async () => {
  const forced = model([called('{"matches":[]}')]);
  await askMatches(forced, 'a.ts', FINDING, REFS, TOKEN, false, 777);
  assert.equal(forced.requests[0]!.forcedTool, SUBMIT_MATCHES);
  assert.equal(forced.requests[0]!.timeoutMs, 777);
  assert.deepEqual(forced.requests[0]!.tools, [MATCH_TOOL]);
  const auto = model([called('{"matches":[]}')]);
  await askMatches(auto, 'a.ts', FINDING, REFS, TOKEN, true, 1000);
  assert.equal(auto.requests[0]!.forcedTool, null);
});

test('askMatches reads the call among toolCalls', async () => {
  const r = response({ toolCalls: [
    { id: '1', name: 'other', arguments: '{}' }, { id: '2', name: SUBMIT_MATCHES, arguments: '{"matches":[2]}' },
  ] });
  const out = await askMatches(model([r]), 'a.ts', FINDING, REFS, TOKEN, false, 1000);
  assert.equal(out.ok && out.value.matches[0], 1);
});

test('matchCase counts a finding only when the matching can give it a reference of its own', () => {
  const out = matchCase([{ matched: [0] }, { matched: [0] }, { matched: [1, 2] }, { matched: [] }], 3);
  assert.deepEqual(out, { counted: [true, false, true, false], covered: 3 });
});

test('matchCase does not depend on the order of findings', () => {
  assert.equal(matchCase([{ matched: [0, 1] }, { matched: [0] }, { matched: [1] }], 2).counted.filter(Boolean).length, 2);
  assert.equal(matchCase([{ matched: [0] }, { matched: [1] }, { matched: [0, 1] }], 2).counted.filter(Boolean).length, 2);
});

const judged = (counted: boolean, over: Partial<JudgedFinding> = {}): JudgedFinding =>
  ({ path: 'a.ts', line: 1, extra: false, matched: counted ? [0] : [], counted, judge: 'asked', reason: null, ...over });
const okRow = (findings: JudgedFinding[], references: number, covered: number) => ({ status: 'ok' as const, findings, references, covered });

test('judgeSummary computes precision, recall and f1 and leaves failed cases out', () => {
  const rows = [
    okRow([judged(true), judged(true), judged(false), judged(false, { judge: 'failed' })], 5, 3),
    { status: 'failed' as const, findings: [judged(true)], references: 9, covered: 9 },
  ];
  const s = judgeSummary('run', rows, { calls: 7, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0.5 });
  assert.deepEqual(s, {
    label: 'run', cases: 2, failed_cases: 1, findings: 4, references: 5, matched_findings: 2, covered_references: 3,
    precision: 0.5, recall: 0.6, f1: 0.545, judge_calls: 7, judge_failed: 1, judge_cost: 0.5,
  });
});

test('judgeSummary on empty denominators', () => {
  const none = judgeSummary('a', [], ZERO);
  assert.deepEqual([none.precision, none.recall, none.f1], [null, null, null]);
  const noFindings = judgeSummary('b', [okRow([], 3, 0)], ZERO);
  assert.deepEqual([noFindings.precision, noFindings.recall, noFindings.f1], [null, 0, 0]);
  const noneCounted = judgeSummary('c', [okRow([judged(false)], 2, 0)], ZERO);
  assert.deepEqual([noneCounted.precision, noneCounted.recall, noneCounted.f1], [0, 0, 0]);
  const noRefs = judgeSummary('d', [okRow([judged(false)], 0, 0)], ZERO);
  assert.deepEqual([noRefs.precision, noRefs.recall, noRefs.f1], [0, null, 0]);
});
