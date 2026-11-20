import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubmitReview, submitReviewTool, submitReviewWithThreadsTool, SUBMIT_REVIEW } from './submit-review.ts';

const ok = { overview: 'Changes src/a.ts.', findings: [{ path: 'src/a.ts', side: 'RIGHT', line: 3, severity: 'major', body: 'Breaks on empty input.', quote: 'x()', beyond_diff: false }], files: [{ path: 'src/a.ts', change_summary: 'Adds a guard.', blocks: [{ id: 'B1', score: 45, category: 'fix', reason: 'Changes when the job runs.' }] }] };

function reasonOf(value: unknown): string {
  const r = parseSubmitReview(JSON.stringify(value));
  assert.ok(!r.ok);
  return r.reason;
}

test('accepts a valid answer', () => assert.equal(parseSubmitReview(JSON.stringify(ok)).ok, true));
test('zero findings is valid', () => assert.equal(parseSubmitReview(JSON.stringify({ overview: 'x', findings: [], files: [] })).ok, true));
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
  assert.deepEqual([...p.required].sort(), ['files', 'findings', 'overview']);
  assert.equal(p.additionalProperties, false);
  assert.ok(!('$schema' in p));
});
test('a whitespace-only overview, body or path is invalid', () => {
  assert.match(reasonOf({ ...ok, overview: '   ' }), /^overview: /);
  const a = structuredClone(ok); a.findings[0]!.body = '   ';
  assert.match(reasonOf(a), /^findings\[0\]\.body: /);
  const b = structuredClone(ok); b.findings[0]!.path = ' \t ';
  assert.match(reasonOf(b), /^findings\[0\]\.path: /);
});
test('overview, body and path are trimmed; quote is kept verbatim', () => {
  const t = structuredClone(ok);
  t.overview = '  Changes src/a.ts.  ';
  t.findings[0]!.path = ' src/a.ts ';
  t.findings[0]!.body = '  Breaks on empty input.  ';
  t.findings[0]!.quote = '    return x;';
  const r = parseSubmitReview(JSON.stringify(t));
  assert.ok(r.ok);
  assert.equal(r.value.overview, 'Changes src/a.ts.');
  assert.equal(r.value.findings[0]!.path, 'src/a.ts');
  assert.equal(r.value.findings[0]!.body, 'Breaks on empty input.');
  assert.equal(r.value.findings[0]!.quote, '    return x;');
});
test('the JSON schema still gives overview, body and path a minimum length of 1', () => {
  const p = submitReviewTool.function.parameters as { properties: { overview: { type: string; minLength: number }; findings: { items: { properties: Record<string, { type: string; minLength: number }> } } } };
  assert.deepEqual([p.properties.overview.type, p.properties.overview.minLength], ['string', 1]);
  for (const k of ['path', 'body']) assert.deepEqual([p.properties.findings.items.properties[k]!.type, p.properties.findings.items.properties[k]!.minLength], ['string', 1]);
});

test('a reason is one line and at most 200 characters', () => {
  const reason = reasonOf({ overview: 'o', findings: [], files: [], [`k\n${'k'.repeat(499)}`]: 1 });
  assert.equal(reason.length, 200);
  assert.doesNotMatch(reason, /\n/);
  assert.match(reason, /unexpected key k k/);
});

const withBlock = (block: Record<string, unknown>) => ({ ...ok, files: [{ path: 'src/a.ts', change_summary: 'Adds a guard.', blocks: [block] }] });
function parsed(value: unknown) {
  const r = parseSubmitReview(JSON.stringify(value));
  assert.ok(r.ok);
  return r.value;
}

test('a full answer parses', () => assert.deepEqual(parsed(ok).files[0]!.blocks[0], { id: 'B1', score: 45, category: 'fix', reason: 'Changes when the job runs.' }));
test('files is required', () => assert.match(reasonOf({ overview: 'o', findings: [] }), /^files: /));
test('files may be empty', () => assert.deepEqual(parsed({ overview: 'o', findings: [], files: [] }).files, []));
test('a score written as text is rejected, naming where', () => assert.match(reasonOf(withBlock({ id: 'B1', score: '45', category: 'fix' })), /^files\[0\]\.blocks\[0\]\.score: /));
test('an unknown key inside files is ignored', () => {
  const t = withBlock({ id: 'B1', score: 45, category: 'fix', extra: 1 }) as { files: Record<string, unknown>[] };
  t.files[0]!.note = 'x';
  const v = parsed(t);
  assert.deepEqual(v.files[0]!.blocks[0], { id: 'B1', score: 45, category: 'fix' });
  assert.ok(!('note' in v.files[0]!));
});
test('a block may carry parts instead of a score', () => {
  const part = { first: 'R1', last: 'R20', score: 30, category: 'test' };
  assert.deepEqual(parsed(withBlock({ id: 'B1', parts: [part] })).files[0]!.blocks[0], { id: 'B1', parts: [part] });
});
test('a part needs first, last, category and a numeric score', () => {
  const part = { first: 'R1', last: 'R20', score: 30, category: 'test' };
  assert.match(reasonOf(withBlock({ id: 'B1', parts: [{ ...part, score: 'high' }] })), /^files\[0\]\.blocks\[0\]\.parts\[0\]\.score: /);
  assert.match(reasonOf(withBlock({ id: 'B1', parts: [{ ...part, first: 3 }] })), /^files\[0\]\.blocks\[0\]\.parts\[0\]\.first: /);
});
test('blocks defaults to empty', () => assert.deepEqual(parsed({ ...ok, files: [{ path: 'src/a.ts', change_summary: 'Renamed.' }] }).files[0]!.blocks, []));
test('a file path must be non-empty after trimming, a block id non-empty', () => {
  assert.match(reasonOf({ ...ok, files: [{ path: '  ', change_summary: 's', blocks: [] }] }), /^files\[0\]\.path: /);
  assert.match(reasonOf(withBlock({ id: '' })), /^files\[0\]\.blocks\[0\]\.id: /);
});
test('a file may carry its own score, category and reason', () => {
  const v = parsed({ ...ok, files: [{ path: 'src/a.ts', change_summary: 's', score: 10, category: 'docs', reason: 'r', blocks: [] }] });
  assert.deepEqual([v.files[0]!.score, v.files[0]!.category, v.files[0]!.reason], [10, 'docs', 'r']);
});
test('the tool schema names files', () => assert.ok(JSON.stringify(submitReviewTool).includes('"files"')));
test('the tool description asks for one entry for each file', () => assert.match(submitReviewTool.function.description, /one entry for each file\.$/));
test('an unknown key in a finding is still rejected', () => {
  const t = structuredClone(ok) as { findings: Record<string, unknown>[] }; t.findings[0]!.extra = 1;
  assert.match(reasonOf(t), /^findings\[0\]: unexpected key extra/);
});

test('null for an optional field of a file is read as the field being absent', () => {
  const v = parsed({ ...ok, files: [{ path: 'src/a.ts', change_summary: 's', score: null, category: null, reason: null, blocks: [] }] });
  assert.deepEqual([v.files[0]!.score, v.files[0]!.category, v.files[0]!.reason], [undefined, undefined, undefined]);
});
test('null for an optional field of a block is read as the field being absent', () => {
  const v = parsed(withBlock({ id: 'B1', score: 45, category: 'fix', reason: null, parts: null }));
  const block = v.files[0]!.blocks[0]!;
  assert.deepEqual([block.score, block.category, block.reason, block.parts], [45, 'fix', undefined, undefined]);
  const bare = parsed(withBlock({ id: 'B1', score: null, category: null })).files[0]!.blocks[0]!;
  assert.deepEqual([bare.score, bare.category], [undefined, undefined]);
});
test('null for the reason of a part is read as the reason being absent', () => {
  const v = parsed(withBlock({ id: 'B1', score: null, parts: [{ first: 'R1', last: 'R20', score: 30, category: 'test', reason: null }] }));
  const block = v.files[0]!.blocks[0]!;
  assert.equal(block.score, undefined);
  assert.equal(block.parts![0]!.reason, undefined);
  assert.equal(block.parts![0]!.score, 30);
});
test('null is still refused for a required field of a part, and in findings', () => {
  assert.match(reasonOf(withBlock({ id: 'B1', parts: [{ first: 'R1', last: 'R20', score: null, category: 'test' }] })), /^files\[0\]\.blocks\[0\]\.parts\[0\]\.score: /);
  const t = structuredClone(ok) as { findings: Record<string, unknown>[] }; t.findings[0]!.quote = null;
  assert.match(reasonOf(t), /^findings\[0\]\.quote: /);
});

test('the tool of a first review does not know thread verdicts, and the other tool does', () => {
  assert.ok(!JSON.stringify(submitReviewTool).includes('thread_verdicts'));
  assert.ok(JSON.stringify(submitReviewWithThreadsTool).includes('thread_verdicts'));
  assert.equal(submitReviewWithThreadsTool.function.name, submitReviewTool.function.name);
});
test('with threads, verdicts are read when given and are an empty list when absent or null; without, an answer that carries them is refused as it is today', () => {
  const verdicts = [{ thread_id: 'T1', verdict: 'fixed', reply: 'Line 3 now guards it.' }, { thread_id: 'T2', verdict: 'open' }];
  const given = parseSubmitReview(JSON.stringify({ ...ok, thread_verdicts: verdicts }), true);
  assert.ok(given.ok);
  assert.deepEqual(given.value.thread_verdicts, verdicts);
  const absent = parseSubmitReview(JSON.stringify(ok), true);
  assert.ok(absent.ok);
  assert.deepEqual(absent.value.thread_verdicts, []);
  const none = parseSubmitReview(JSON.stringify({ ...ok, thread_verdicts: null }), true);
  assert.ok(none.ok);
  assert.deepEqual(none.value.thread_verdicts, []);
  const refused = parseSubmitReview(JSON.stringify({ ...ok, thread_verdicts: verdicts }));
  assert.ok(!refused.ok);
  assert.ok(refused.reason.includes('unexpected key thread_verdicts'));
  assert.ok(!('thread_verdicts' in (parseSubmitReview(JSON.stringify(ok)) as { value: object }).value));
});
