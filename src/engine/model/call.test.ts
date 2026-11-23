import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, ModelClient, ModelRequest, ModelResponse, Usage } from '../types.ts';
import { callBatch } from './call.ts';
import { ProviderError } from './errors.ts';
import { SUBMIT_REVIEW, submitReviewTool, submitReviewWithThreadsTool, submitToolFor } from './submit-review.ts';

const usage = (calls = 1): Usage => ({ calls, inputTokens: 100, outputTokens: 10, cachedTokens: 5, cost: 0.5 });
const toolCall = (args: unknown, model = 'm', provider: string | null = null): ModelResponse =>
  ({ toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify(args), text: null, model, provider, usage: usage() });
const prose = (text: string): ModelResponse => ({ toolName: null, toolArguments: null, text, model: 'm', provider: null, usage: usage() });

function stubModel(...steps: Array<ModelResponse | Error>): ModelClient & { requests: ModelRequest[]; calls: number } {
  const requests: ModelRequest[] = [];
  const stub = {
    requests,
    calls: 0,
    complete(request: ModelRequest): Promise<ModelResponse> {
      requests.push(request);
      stub.calls += 1;
      const step = steps[requests.length - 1];
      if (step === undefined) return Promise.reject(new Error('stub exhausted'));
      return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
    },
  };
  return stub;
}

const finding = { path: 'src/a.ts', side: 'RIGHT', line: 3, severity: 'minor', body: 'Off by one.', quote: '', beyond_diff: false };
const valid = { overview: 'Looks fine.', findings: [finding], files: [] };
const ungrounded = { overview: 'A long article about city gardens and soil.', findings: [], files: [] };
const UNGROUNDED = 'ungrounded: the overview must name at least one changed file by its path';
const messages: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
const args = { messages, effort: 'elevated' as const, timeoutMs: 1234, prPaths: ['src/a.ts'] };

test('a valid answer needs one call', async () => {
  const model = stubModel(toolCall(valid));
  const r = await callBatch(args, model);
  assert.ok(r.ok);
  assert.equal(model.calls, 1);
  assert.equal(r.value.overview, 'Looks fine.');
  assert.deepEqual(r.audit, []);
  assert.equal(r.usage.calls, 1);
});

test('every request forces submit_review with the given effort and timeout', async () => {
  const model = stubModel(prose('no'), toolCall(valid));
  await callBatch(args, model);
  for (const request of model.requests) {
    assert.deepEqual(request.tools, [submitReviewTool]);
    assert.equal(request.forcedTool, SUBMIT_REVIEW);
    assert.equal(request.effort, 'elevated');
    assert.equal(request.timeoutMs, 1234);
  }
});

test('prose is retried once with the reason, then succeeds', async () => {
  const model = stubModel(prose('I reviewed it.'), toolCall(valid));
  const r = await callBatch(args, model);
  assert.equal(r.ok, true);
  assert.match(model.requests[1]!.messages.at(-1)!.content, /rejected: not_a_tool_call/);
  assert.equal(r.usage.calls, 2);
  assert.equal(r.usage.inputTokens, 200);
  assert.equal(r.usage.cost, 1);
  assert.deepEqual(r.audit, [{ stage: 'model', action: 'retry', subject: 'batch', reason: 'not_a_tool_call' }]);
});

test('the retry appends the rejected answer and the reason to the same messages', async () => {
  const model = stubModel(prose('I reviewed it.'), toolCall(valid));
  await callBatch(args, model);
  assert.deepEqual(model.requests[0]!.messages, messages);
  assert.deepEqual(model.requests[1]!.messages, [
    ...messages,
    { role: 'assistant', content: 'I reviewed it.' },
    { role: 'user', content: 'Your answer was rejected: not_a_tool_call. Call submit_review again.' },
  ]);
});

test('a rejected answer is cut to 2000 characters, the reason to 200', async () => {
  const model = stubModel(prose('x'.repeat(5000)), toolCall(valid));
  await callBatch(args, model);
  assert.equal(model.requests[1]!.messages.at(-2)!.content.length, 2000);
  const long = { overview: 'o', findings: [], files: [], ['k'.repeat(500)]: 1 };
  const second = stubModel(toolCall(long), toolCall(valid));
  await callBatch(args, second);
  const reply = second.requests[1]!.messages.at(-1)!.content;
  const reason = /^Your answer was rejected: (.*)\. Call submit_review again\.$/.exec(reply)![1]!;
  assert.equal(reason.length, 200);
  assert.match(reason, /^: unexpected key kkk/);
});

test('the retry audit entry carries the cut reason', async () => {
  const long = { overview: 'o', findings: [], files: [], ['k'.repeat(500)]: 1 };
  const r = await callBatch(args, stubModel(toolCall(long), toolCall(valid)));
  assert.equal(r.audit[0]!.action, 'retry');
  assert.equal(r.audit[0]!.reason.length, 200);
});

test('the models and providers that answered are listed in call order', async () => {
  const r = await callBatch(args, stubModel(toolCall(ungrounded, 'vendor/a', 'Up One'), toolCall(valid, 'vendor/b', null)));
  assert.ok(r.ok);
  assert.deepEqual([r.models, r.providers], [['vendor/a', 'vendor/b'], ['Up One']]);
  const failed = await callBatch(args, stubModel(toolCall(ungrounded, 'vendor/a', 'Up One'), new ProviderError('timeout', 't', null, null)));
  assert.ok(!failed.ok);
  assert.deepEqual([failed.models, failed.providers], [['vendor/a'], ['Up One']]);
});

test('a finding path is normalised before it grounds an answer', async () => {
  const onPrefixed = { overview: 'A short summary.', findings: [{ ...finding, path: 'a/src/a.ts' }], files: [] };
  const r = await callBatch(args, stubModel(toolCall(onPrefixed)));
  assert.ok(r.ok);
});

test('only the files of the batch ground an answer', async () => {
  const other = { overview: 'The change to src/b.ts looks right.', findings: [], files: [] };
  const r = await callBatch({ ...args, prPaths: ['src/a.ts'] }, stubModel(toolCall(other), toolCall(other)));
  assert.ok(!r.ok && r.code === 'invalid_output' && r.reason === UNGROUNDED);
});

test('a missing answer is shown as (no answer); a tool call shows its arguments', async () => {
  const empty: ModelResponse = { toolName: null, toolArguments: null, text: null, model: 'm', provider: null, usage: usage() };
  const a = stubModel(empty, toolCall(valid));
  await callBatch(args, a);
  assert.equal(a.requests[1]!.messages.at(-2)!.content, '(no answer)');
  const b = stubModel(toolCall(ungrounded), toolCall(valid));
  await callBatch(args, b);
  assert.equal(b.requests[1]!.messages.at(-2)!.content, JSON.stringify(ungrounded));
});

test('a call to another tool counts as not_a_tool_call', async () => {
  const other: ModelResponse = { ...toolCall(valid), toolName: 'something_else' };
  const model = stubModel(other, toolCall(valid));
  const r = await callBatch(args, model);
  assert.ok(r.ok);
  assert.match(model.requests[1]!.messages.at(-1)!.content, /rejected: not_a_tool_call/);
});

test('a schema failure is retried with the schema reason', async () => {
  const model = stubModel(toolCall({ overview: 'x' }), toolCall(valid));
  const r = await callBatch(args, model);
  assert.ok(r.ok);
  assert.match(model.requests[1]!.messages.at(-1)!.content, /rejected: findings/);
  assert.equal(r.audit[0]!.reason.startsWith('findings'), true);
});

test('two invalid answers end the batch', async () => {
  const r = await callBatch(args, stubModel(toolCall(ungrounded), toolCall(ungrounded)));
  assert.ok(!r.ok && r.code === 'invalid_output' && r.reason === UNGROUNDED);
  assert.equal(r.usage.calls, 2);
  assert.deepEqual(r.audit, [
    { stage: 'model', action: 'retry', subject: 'batch', reason: UNGROUNDED },
    { stage: 'model', action: 'failed', subject: 'batch', reason: 'invalid_output' },
  ]);
});

test('the reason of a failed batch is the last rejection', async () => {
  const r = await callBatch(args, stubModel(toolCall(ungrounded), prose('again')));
  assert.ok(!r.ok && r.reason === 'not_a_tool_call');
  assert.equal(r.audit[0]!.reason, UNGROUNDED);
});

test('a provider error is returned, not thrown, and not retried here', async () => {
  const model = stubModel(new ProviderError('timeout', 't', null, null));
  const r = await callBatch(args, model);
  assert.ok(!r.ok && r.code === 'timeout' && r.reason === 't');
  assert.equal(model.calls, 1);
  assert.equal(r.usage.calls, 0);
  assert.deepEqual(r.audit, [{ stage: 'model', action: 'failed', subject: 'batch', reason: 'timeout' }]);
});

test('a provider error on the retry keeps the usage of the first call', async () => {
  const r = await callBatch(args, stubModel(prose('no'), new ProviderError('rate_limited', 'slow down', 429, 1000)));
  assert.ok(!r.ok && r.code === 'rate_limited' && r.reason === 'slow down');
  assert.equal(r.usage.calls, 1);
  assert.deepEqual(r.audit.map((e) => e.action), ['retry', 'failed']);
});

test('an error that is not a provider error is not caught', async () => {
  await assert.rejects(callBatch(args, stubModel(new TypeError('bug'))), TypeError);
});

test('a clean pull request answer is retried until the overview names a file', async () => {
  const model = stubModel(toolCall({ overview: 'Looks good to me.', findings: [], files: [] }), toolCall({ overview: 'Looks good; src/cart/total.ts is fine.', findings: [], files: [] }));
  const r = await callBatch({ ...args, prPaths: ['src/cart/total.ts'] }, model);
  assert.ok(r.ok);
  assert.equal(model.calls, 2);
  assert.ok(model.requests[1]!.messages.at(-1)!.content.includes(UNGROUNDED));
});

test('a call of a run with threads is sent the tool that takes verdicts, and its answer is parsed with it', async () => {
  const withVerdicts = { ...valid, thread_verdicts: [{ thread_id: 'T1', verdict: 'open' }] };
  const model = stubModel(toolCall(withVerdicts));
  const r = await callBatch({ ...args, withThreads: true }, model);
  assert.ok(r.ok);
  assert.deepEqual(model.requests[0]!.tools, [submitReviewWithThreadsTool]);
  assert.deepEqual(r.value.thread_verdicts, [{ thread_id: 'T1', verdict: 'open' }]);
  const plain = stubModel(toolCall(withVerdicts), toolCall(withVerdicts));
  const refused = await callBatch(args, plain);
  assert.ok(!refused.ok);
  assert.deepEqual(plain.requests[0]!.tools, [submitReviewTool]);
  assert.equal(plain.calls, 2);
  assert.ok(refused.reason.includes('unexpected key thread_verdicts'));
});

test('a call that shows criteria sends the tool with acceptance, and one that does not sends the tool of today', async () => {
  const rows = { ...valid, acceptance: [{ item: 'A1', status: 'met', note: 'In src/a.ts:3.' }] };
  for (const withThreads of [false, true]) {
    const model = stubModel(toolCall(rows));
    const r = await callBatch({ ...args, withThreads, withAcceptance: true }, model);
    assert.ok(r.ok);
    assert.deepEqual(model.requests[0]!.tools, [submitToolFor(withThreads, true)]);
    assert.deepEqual(r.value.acceptance, rows.acceptance);
    const plain = stubModel(toolCall(valid));
    await callBatch({ ...args, withThreads, withAcceptance: false }, plain);
    assert.deepEqual(plain.requests[0]!.tools, [withThreads ? submitReviewWithThreadsTool : submitReviewTool]);
    const refusing = stubModel(toolCall(rows), toolCall(rows));
    const refused = await callBatch({ ...args, withThreads }, refusing);
    assert.ok(!refused.ok);
    assert.equal(refusing.calls, 2);
    assert.ok(refused.reason.includes('unexpected key acceptance'));
  }
});

test('with the choice not given, and given as forced, the requests are those of before', async () => {
  const retried: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: 'I reviewed it.' },
    { role: 'user', content: 'Your answer was rejected: not_a_tool_call. Call submit_review again.' },
  ];
  for (const choice of [undefined, 'forced' as const]) {
    const model = stubModel(prose('I reviewed it.'), toolCall(valid));
    const r = await callBatch(choice === undefined ? args : { ...args, toolChoice: choice }, model);
    assert.ok(r.ok);
    assert.equal(model.requests.length, 2);
    assert.deepEqual(model.requests[0], { messages, tools: [submitReviewTool], forcedTool: 'submit_review', effort: 'elevated', timeoutMs: 1234 });
    assert.deepEqual(model.requests[1], { messages: retried, tools: [submitReviewTool], forcedTool: 'submit_review', effort: 'elevated', timeoutMs: 1234 });
    for (const request of model.requests) {
      assert.deepEqual(Object.keys(request), ['messages', 'tools', 'forcedTool', 'effort', 'timeoutMs']);
    }
  }
});

test('under auto every request leaves the choice to the model and offers submit_review alone', async () => {
  const forced = stubModel(prose('I reviewed it.'), toolCall(valid));
  await callBatch(args, forced);
  const model = stubModel(prose('I reviewed it.'), toolCall(valid));
  const r = await callBatch({ ...args, toolChoice: 'auto' }, model);
  assert.ok(r.ok);
  assert.equal(model.requests.length, 2);
  for (const request of model.requests) {
    assert.equal(request.forcedTool, null);
    assert.deepEqual(request.tools, [submitReviewTool]);
    assert.equal(request.effort, 'elevated');
    assert.equal(request.timeoutMs, 1234);
  }
  assert.deepEqual(model.requests.map((q) => q.messages), forced.requests.map((q) => q.messages));
});

test('under auto a prose answer is retried once with the reason, and a second one fails the batch as invalid output', async () => {
  const model = stubModel(prose('I reviewed it.'), prose('Still prose.'));
  const r = await callBatch({ ...args, toolChoice: 'auto' }, model);
  assert.equal(model.requests.length, 2);
  assert.deepEqual(model.requests.map((q) => q.forcedTool), [null, null]);
  assert.ok(!r.ok);
  assert.deepEqual({ ok: r.ok, code: r.code, reason: r.reason }, { ok: false, code: 'invalid_output', reason: 'not_a_tool_call' });
  assert.deepEqual(model.requests[1]!.messages.slice(-2), [
    { role: 'assistant', content: 'I reviewed it.' },
    { role: 'user', content: 'Your answer was rejected: not_a_tool_call. Call submit_review again.' },
  ]);
  assert.deepEqual(r.audit, [
    { stage: 'model', action: 'retry', subject: 'batch', reason: 'not_a_tool_call' },
    { stage: 'model', action: 'failed', subject: 'batch', reason: 'invalid_output' },
  ]);
});

const callOf = (id: string, name: string, args: string | null) => ({ id, name, arguments: args });
const withCalls = (...calls: Array<{ id: string; name: string; arguments: string | null }>): ModelResponse => ({
  toolName: calls[0]!.name, toolArguments: calls[0]!.arguments, text: null, model: 'm', provider: null, usage: usage(),
  toolCalls: calls,
  assistant: { role: 'assistant', content: null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) },
});

test('an empty answer is sent back as (no answer) under auto, and as today under forced', async () => {
  const empty = prose('');
  const auto = stubModel(empty, toolCall(valid));
  assert.ok((await callBatch({ ...args, toolChoice: 'auto' }, auto)).ok);
  assert.deepEqual(auto.requests[1]!.messages.at(-2), { role: 'assistant', content: '(no answer)' });
  const forced = stubModel(empty, toolCall(valid));
  assert.ok((await callBatch(args, forced)).ok);
  assert.deepEqual(forced.requests[1]!.messages.at(-2), { role: 'assistant', content: '' });
});

test('under auto the answer is the first call to submit_review, wherever it stands', async () => {
  const one = stubModel(withCalls(callOf('c1', 'docs__search', '{"query":"cart"}'), callOf('c2', SUBMIT_REVIEW, JSON.stringify(valid))));
  const r = await callBatch({ ...args, toolChoice: 'auto' }, one);
  assert.ok(r.ok);
  assert.equal(one.requests.length, 1);
  assert.equal(r.value.overview, 'Looks fine.');
  const other = { ...valid, overview: 'Second answer about src/a.ts.' };
  const two = stubModel(withCalls(callOf('c1', SUBMIT_REVIEW, JSON.stringify(valid)), callOf('c2', SUBMIT_REVIEW, JSON.stringify(other))));
  const first = await callBatch({ ...args, toolChoice: 'auto' }, two);
  assert.ok(first.ok);
  assert.equal(first.value.overview, 'Looks fine.');
  // a first call to submit_review that is invalid is the answer: a valid later one is not read
  const bad = stubModel(withCalls(callOf('c1', SUBMIT_REVIEW, JSON.stringify(ungrounded)), callOf('c2', SUBMIT_REVIEW, JSON.stringify(valid))), toolCall(valid));
  const retried = await callBatch({ ...args, toolChoice: 'auto' }, bad);
  assert.ok(retried.ok);
  assert.equal(bad.requests.length, 2);
  assert.deepEqual(bad.requests[1]!.messages.at(-2), { role: 'assistant', content: JSON.stringify(ungrounded) });
});

test('under auto an answer that calls only another function is not_a_tool_call, and the retry names that function', async () => {
  const model = stubModel(withCalls(callOf('c1', 'docs__search', '{"query":"cart"}')), toolCall(valid));
  const r = await callBatch({ ...args, toolChoice: 'auto' }, model);
  assert.ok(r.ok);
  assert.equal(model.requests.length, 2);
  assert.deepEqual(r.audit, [{ stage: 'model', action: 'retry', subject: 'batch', reason: 'not_a_tool_call' }]);
  assert.deepEqual(model.requests[1]!.messages.slice(-2), [
    { role: 'assistant', content: 'called docs__search with {"query":"cart"}' },
    { role: 'user', content: 'Your answer was rejected: not_a_tool_call. Call submit_review again.' },
  ]);
});

test('under forced an answer with several calls is read from its first call, as today', async () => {
  const model = stubModel(withCalls(callOf('c1', 'docs__search', '{"query":"cart"}'), callOf('c2', SUBMIT_REVIEW, JSON.stringify(valid))), toolCall(valid));
  const r = await callBatch(args, model);
  assert.ok(r.ok);
  assert.equal(model.requests.length, 2);
  assert.deepEqual(model.requests[1]!.messages.at(-2), { role: 'assistant', content: '{"query":"cart"}' });
});
