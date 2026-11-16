import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubmitReview, submitReviewTool, SUBMIT_REVIEW } from './submit-review.ts';

const ok = { overview: 'Changes src/a.ts.', findings: [{ path: 'src/a.ts', side: 'RIGHT', line: 3, severity: 'major', body: 'Breaks on empty input.', quote: 'x()', beyond_diff: false }] };

function reasonOf(value: unknown): string {
  const r = parseSubmitReview(JSON.stringify(value));
  assert.ok(!r.ok);
  return r.reason;
}

test('accepts a valid answer', () => assert.equal(parseSubmitReview(JSON.stringify(ok)).ok, true));
test('zero findings is valid', () => assert.equal(parseSubmitReview(JSON.stringify({ overview: 'x', findings: [] })).ok, true));
test('a finding without a severity is invalid and the reason names it', () => {
  const bad = structuredClone(ok); delete (bad.findings[0] as Record<string, unknown>).severity;
  const r = parseSubmitReview(JSON.stringify(bad));
  assert.ok(!r.ok && r.reason.includes('findings[0].severity'));
});
test('nit is not a severity', () => {
  const bad = structuredClone(ok); bad.findings[0]!.severity = 'nit';
  assert.equal(parseSubmitReview(JSON.stringify(bad)).ok, false);
});
test('the reason is one line with path and expectation', () => {
  const bad = structuredClone(ok); bad.findings.push({ ...ok.findings[0]!, severity: 'nit' });
  assert.equal(reasonOf(bad), 'findings[1].severity: expected one of blocker|major|minor');
});
test('not JSON', () => {
  const r = parseSubmitReview('I reviewed it.');
  assert.ok(!r.ok && r.reason === 'not_json');
});
test('a leading severity tag is stripped from the body', () => {
  const t = structuredClone(ok); t.findings[0]!.body = '**[major]** Breaks on empty input.';
  const r = parseSubmitReview(JSON.stringify(t));
  assert.ok(r.ok && r.value.findings[0]!.body === 'Breaks on empty input.');
});
test('a [nit] tag is stripped too', () => {
  const t = structuredClone(ok); t.findings[0]!.body = '[nit] Breaks on empty input.';
  const r = parseSubmitReview(JSON.stringify(t));
  assert.ok(r.ok && r.value.findings[0]!.body === 'Breaks on empty input.');
});
test('a body empty after its tag is stripped is invalid', () => {
  const t = structuredClone(ok); t.findings[0]!.body = '[major]';
  assert.match(reasonOf(t), /^findings\[0\]\.body: /);
});
test('an extra key on the answer or on a finding is invalid', () => {
  assert.match(reasonOf({ ...ok, extra: 1 }), /^: |^extra|unrecognized/i);
  const t = structuredClone(ok) as { findings: Record<string, unknown>[] }; t.findings[0]!.extra = 1;
  assert.match(reasonOf(t), /^findings\[0\]/);
});
test('line must be a positive integer, path and overview non-empty', () => {
  const a = structuredClone(ok); a.findings[0]!.line = 0;
  assert.match(reasonOf(a), /^findings\[0\]\.line: /);
  const b = structuredClone(ok); b.findings[0]!.line = 1.5;
  assert.match(reasonOf(b), /^findings\[0\]\.line: /);
  const c = structuredClone(ok); c.findings[0]!.path = '';
  assert.match(reasonOf(c), /^findings\[0\]\.path: /);
  assert.match(reasonOf({ ...ok, overview: '' }), /^overview: /);
});
test('side must be LEFT or RIGHT', () => {
  const a = structuredClone(ok); (a.findings[0] as Record<string, unknown>).side = 'MIDDLE';
  assert.match(reasonOf(a), /^findings\[0\]\.side: /);
});
test('a non-object answer is invalid', () => assert.equal(parseSubmitReview('[]').ok, false));
test('the tool definition is a JSON schema with the required fields', () => {
  assert.equal(submitReviewTool.function.name, SUBMIT_REVIEW);
  const p = submitReviewTool.function.parameters as { required: string[]; additionalProperties: unknown };
  assert.deepEqual([...p.required].sort(), ['findings', 'overview']);
  assert.equal(p.additionalProperties, false);
  assert.ok(!('$schema' in p));
});
