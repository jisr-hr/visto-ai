import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, ModelClient, ModelRequest, ModelResponse, ToolCall, ToolDefinition, Usage } from '../types.ts';
import { estimateTokens } from '../context/batches.ts';
import { FINAL_LINE, OPEN_TURNS_PER_CALL, callBatch } from './call.ts';
import type { ToolLoop } from './call.ts';
import { ProviderError } from './errors.ts';
import { SUBMIT_REVIEW, submitReviewTool, submitReviewWithThreadsTool, submitToolFor } from './submit-review.ts';
import { NOT_RUN_CAP, NOT_RUN_CLOSED } from './tools.ts';
import type { ToolOutcome } from './tools.ts';

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

// The loop (Task 8). A stub loop records each run(call, open) and answers from a list of outcomes, by the order of the runs.
const searchDef: ToolDefinition = { type: 'function', function: { name: 'docs__search', description: 'Searches the documentation.', parameters: { type: 'object', properties: { query: { type: 'string' } } } } };
const pageDef: ToolDefinition = { type: 'function', function: { name: 'docs__get_page', description: 'Reads one page.', parameters: { type: 'object', properties: { id: { type: 'string' } } } } };
const search = (id: string, query = 'cart'): ToolCall => callOf(id, 'docs__search', JSON.stringify({ query }));
const submit = (id: string, value: unknown): ToolCall => callOf(id, SUBMIT_REVIEW, JSON.stringify(value));
const calls = (...entries: ToolCall[]): ModelResponse => withCalls(...entries);
const outcomeOf = (id: string, over: Partial<ToolOutcome> = {}): ToolOutcome => ({
  content: `found for ${id}`, audit: { stage: 'tools', action: 'tool_call', subject: 'docs__search', reason: `ok_${id}` }, stop: null, sent: true, ...over,
});

interface StubLoop extends ToolLoop { runs: Array<[string, boolean]>; clock: number; overlapped: boolean }
function stubLoop(outcomes: Array<Partial<ToolOutcome> | ((loop: StubLoop) => Partial<ToolOutcome>)> = [], room = 27_000): StubLoop {
  let running = false;
  const loop: StubLoop = {
    definitions: [searchDef, pageDef],
    room,
    clock: 0,
    runs: [],
    overlapped: false,
    now: () => loop.clock,
    async run(call: ToolCall, open: boolean): Promise<ToolOutcome> {
      if (running) loop.overlapped = true;
      running = true;
      loop.runs.push([call.id, open]);
      const given = outcomes[loop.runs.length - 1];
      const over = typeof given === 'function' ? given(loop) : given ?? {};
      await new Promise((resolve) => setImmediate(resolve));
      running = false;
      if (!open) return outcomeOf(call.id, { content: NOT_RUN_CLOSED, audit: { stage: 'tools', action: 'tool_call_refused', subject: 'docs__search', reason: 'closed' }, sent: false, ...over });
      return outcomeOf(call.id, over);
    },
  };
  return loop;
}
const closed = (reason: string) => ({ stage: 'model', action: 'tools_closed', subject: 'batch', reason });
const final: ChatMessage = { role: 'user', content: FINAL_LINE };
const toolMessage = (id: string, content = `found for ${id}`): ChatMessage => ({ role: 'tool', content, toolCallId: id });
const allTools = [submitReviewTool, searchDef, pageDef];

test('with no tools given the requests are those of before', async () => {
  const retried: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: 'I reviewed it.' },
    { role: 'user', content: 'Your answer was rejected: not_a_tool_call. Call submit_review again.' },
  ];
  for (const choice of [undefined, 'forced' as const, 'auto' as const]) {
    const model = stubModel(prose('I reviewed it.'), toolCall(valid));
    const r = await callBatch(choice === undefined ? args : { ...args, toolChoice: choice }, model);
    assert.ok(r.ok);
    const forcedTool = choice === 'auto' ? null : 'submit_review';
    assert.deepEqual(model.requests, [
      { messages, tools: [submitReviewTool], forcedTool, effort: 'elevated', timeoutMs: 1234 },
      { messages: retried, tools: [submitReviewTool], forcedTool, effort: 'elevated', timeoutMs: 1234 },
    ]);
    assert.equal(model.requests[0]!.messages, messages);
    for (const request of model.requests) assert.deepEqual(Object.keys(request), ['messages', 'tools', 'forcedTool', 'effort', 'timeoutMs']);
    assert.deepEqual(r.audit, [{ stage: 'model', action: 'retry', subject: 'batch', reason: 'not_a_tool_call' }]);
  }
  // an answer that calls another tool, with no tools given, is judged as before: nothing is run and no message is added for it
  const other = stubModel(withCalls(search('c1')), toolCall(valid));
  const r = await callBatch({ ...args, toolChoice: 'auto' }, other);
  assert.ok(r.ok);
  assert.equal(other.requests.length, 2);
  assert.deepEqual(other.requests[1]!.messages, [...messages, { role: 'assistant', content: 'called docs__search with {"query":"cart"}' }, retried[3]!]);
});

test('an open turn offers submit_review and the servers\' tools and leaves the choice to the model', async () => {
  for (const toolChoice of ['forced' as const, 'auto' as const]) {
    const model = stubModel(toolCall(valid));
    await callBatch({ ...args, toolChoice, tools: stubLoop() }, model);
    assert.equal(model.requests.length, 1);
    assert.deepEqual(model.requests[0], { messages, tools: allTools, forcedTool: null, effort: 'elevated', timeoutMs: 1234 });
  }
});

test('a call to submit_review in an open turn ends the call with one request', async () => {
  const loop = stubLoop();
  const model = stubModel(toolCall(valid));
  const r = await callBatch({ ...args, tools: loop }, model);
  assert.ok(r.ok);
  assert.equal(r.value.overview, 'Looks fine.');
  assert.equal(model.requests.length, 1);
  assert.deepEqual(loop.runs, []);
  assert.deepEqual(r.audit, []);
});

test('a tool call is answered: the assistant message as received, then one tool message for each call, in order', async () => {
  const loop = stubLoop();
  const turn = { ...calls(search('c1'), callOf('c2', 'docs__get_page', '{"id":"p1"}')), text: 'Looking.' };
  const model = stubModel(turn, toolCall(valid));
  const r = await callBatch({ ...args, tools: loop }, model);
  assert.ok(r.ok);
  assert.equal(model.requests.length, 2);
  const second = model.requests[1]!;
  assert.deepEqual(second.messages, [
    ...messages,
    { role: 'assistant', content: 'Looking.', wire: turn.assistant },
    toolMessage('c1'),
    toolMessage('c2'),
  ]);
  assert.equal(second.messages[2]!.wire, turn.assistant);
  assert.deepEqual(second.messages.map((m) => Object.keys(m)), [['role', 'content'], ['role', 'content'], ['role', 'content', 'wire'], ['role', 'content', 'toolCallId'], ['role', 'content', 'toolCallId']]);
  assert.deepEqual(second.forcedTool, null);
  assert.deepEqual(loop.runs, [['c1', true], ['c2', true]]);
  assert.equal(loop.overlapped, false);
  assert.deepEqual(r.audit, [outcomeOf('c1').audit, outcomeOf('c2').audit]);
  // an answer with no text is sent back with an empty content
  const quiet = stubModel(calls(search('c1')), toolCall(valid));
  await callBatch({ ...args, tools: stubLoop() }, quiet);
  assert.deepEqual(quiet.requests[1]!.messages[2], { role: 'assistant', content: '', wire: quiet.requests[1]!.messages[2]!.wire });
});

test('each request starts with the messages of the one before it', async () => {
  const model = stubModel(calls(search('c1')), calls(search('c2'), search('c3')), calls(search('c4')), toolCall(valid));
  const r = await callBatch({ ...args, tools: stubLoop() }, model);
  assert.ok(r.ok);
  assert.equal(model.requests.length, 4);
  for (let i = 1; i < model.requests.length; i++) {
    const before = model.requests[i - 1]!.messages;
    const now = model.requests[i]!.messages;
    assert.ok(now.length > before.length);
    before.forEach((m, j) => assert.equal(now[j], m));
  }
  assert.equal(model.requests[0]!.messages.length, 2);
  assert.equal(model.requests[3]!.messages.length, 2 + 2 + 3 + 2);
});

test('submit_review called beside another tool: the other is not run, and a rejected answer is shown by its own arguments', async () => {
  const loop = stubLoop();
  const model = stubModel(calls(search('c1'), submit('c2', valid)));
  const r = await callBatch({ ...args, tools: loop }, model);
  assert.ok(r.ok);
  assert.equal(r.value.overview, 'Looks fine.');
  assert.equal(model.requests.length, 1);
  assert.deepEqual(loop.runs, []);
  assert.deepEqual(r.audit, [{ stage: 'model', action: 'tool_calls_dropped', subject: 'batch', reason: '1' }]);

  const again = stubLoop();
  const retried = stubModel(calls(search('c1'), submit('c2', { overview: 'x' })), toolCall(valid));
  const s = await callBatch({ ...args, tools: again }, retried);
  assert.ok(s.ok);
  assert.deepEqual(again.runs, []);
  assert.equal(retried.requests.length, 2);
  assert.deepEqual(retried.requests[1]!.messages.slice(0, 2), messages);
  assert.deepEqual(retried.requests[1]!.messages[2], { role: 'assistant', content: JSON.stringify({ overview: 'x' }) });
  assert.match(retried.requests[1]!.messages[3]!.content, /^Your answer was rejected: findings/);
  assert.equal(retried.requests[1]!.messages.length, 4);
  assert.equal(retried.requests[1]!.forcedTool, 'submit_review');
  for (const request of retried.requests) for (const m of request.messages) assert.ok(!m.content.includes('{"query":"cart"}'));
  assert.equal(s.audit[0]!.action, 'tool_calls_dropped');
  assert.equal(s.audit[1]!.action, 'retry');
});

const nine = Array.from({ length: 9 }, (_, i) => search(`c${i + 1}`, `q${i + 1}`));
const cappedLoop = () => stubLoop([{}, {}, {}, {}, {}, {}, {}, {}, { content: NOT_RUN_CAP, stop: 'call_cap', sent: false }]);

test('a model that calls nine tools: the ninth is told it was not run, and the next turn must end the call', async () => {
  const loop = cappedLoop();
  const turn = calls(...nine);
  const model = stubModel(turn, toolCall(valid));
  const r = await callBatch({ ...args, tools: loop }, model);
  assert.ok(r.ok);
  assert.equal(model.requests.length, 2);
  assert.deepEqual(loop.runs, nine.map((c) => [c.id, true]));
  const second = model.requests[1]!;
  assert.deepEqual(second.messages, [
    ...messages,
    { role: 'assistant', content: '', wire: turn.assistant },
    ...nine.slice(0, 8).map((c) => toolMessage(c.id)),
    toolMessage('c9', NOT_RUN_CAP),
    final,
  ]);
  assert.deepEqual(second, { messages: second.messages, tools: allTools, forcedTool: 'submit_review', effort: 'elevated', timeoutMs: 1234 });
  assert.deepEqual(r.audit.at(-1), closed('call_cap'));
  assert.equal(r.audit.length, 10);
});

test('after four open turns the next turn must end the call', async () => {
  assert.equal(OPEN_TURNS_PER_CALL, 4);
  const loop = stubLoop();
  const model = stubModel(calls(search('c1')), calls(search('c2')), calls(search('c3')), calls(search('c4')), toolCall(valid));
  const r = await callBatch({ ...args, tools: loop }, model);
  assert.ok(r.ok);
  assert.equal(model.requests.length, 5);
  assert.deepEqual(model.requests.map((q) => q.forcedTool), [null, null, null, null, 'submit_review']);
  assert.deepEqual(model.requests[4]!.messages.at(-1), final);
  assert.equal(model.requests[4]!.messages.filter((m) => m.content === FINAL_LINE).length, 1);
  assert.equal(loop.runs.length, 4);
  assert.deepEqual(r.audit.at(-1), closed('turn_cap'));
});

test('a tool error: the calls after it in the turn are not run, and the next turn must end the call', async () => {
  const loop = stubLoop([{ content: 'The tool call failed (timeout).', stop: 'tool_error' }]);
  const model = stubModel(calls(search('c1'), search('c2'), search('c3')), toolCall(valid));
  const r = await callBatch({ ...args, tools: loop }, model);
  assert.ok(r.ok);
  assert.deepEqual(loop.runs, [['c1', true], ['c2', false], ['c3', false]]);
  const second = model.requests[1]!;
  assert.deepEqual(second.messages.slice(3), [toolMessage('c1', 'The tool call failed (timeout).'), toolMessage('c2', NOT_RUN_CLOSED), toolMessage('c3', NOT_RUN_CLOSED), final]);
  assert.equal(second.forcedTool, 'submit_review');
  assert.equal(model.requests.length, 2);
  assert.deepEqual(r.audit.at(-1), closed('tool_error'));
});

test('when the time of the open turns is up, no further call is run and the next turn must end the call', async () => {
  const timed = { ...args, timeoutMs: 1000 };
  const loop = stubLoop([(l) => { l.clock = 1000; return {}; }]);
  const model = stubModel(calls(search('c1'), search('c2')), toolCall(valid));
  const r = await callBatch({ ...timed, tools: loop }, model);
  assert.ok(r.ok);
  assert.deepEqual(loop.runs, [['c1', true], ['c2', false]]);
  assert.equal(model.requests.length, 2);
  assert.equal(model.requests[1]!.forcedTool, 'submit_review');
  assert.deepEqual(model.requests[1]!.messages.at(-1), final);
  assert.deepEqual(r.audit.at(-1), closed('deadline'));
  // the time passes the limit only after a turn's calls: the next request is closing, not open
  const late = stubLoop([{}, (l) => { l.clock = 1500; return {}; }]);
  const after = stubModel(calls(search('c1'), search('c2')), toolCall(valid));
  const s = await callBatch({ ...timed, tools: late }, after);
  assert.ok(s.ok);
  assert.deepEqual(late.runs, [['c1', true], ['c2', true]]);
  assert.deepEqual(after.requests.map((q) => q.forcedTool), [null, 'submit_review']);
  assert.deepEqual(s.audit.at(-1), closed('deadline'));
  // the time is counted from the start of the call, and the requests keep their own limit
  const started = stubLoop([(l) => { l.clock = 5999; return {}; }]);
  started.clock = 5000;
  const within = stubModel(calls(search('c1')), calls(search('c2')), toolCall(valid));
  await callBatch({ ...timed, tools: started }, within);
  assert.deepEqual(within.requests.map((q) => [q.forcedTool, q.timeoutMs]), [[null, 1000], [null, 1000], [null, 1000]]);
});

test('what the open turns append is counted, and once it fills the room the next turn must end the call', async () => {
  const long = calls(search('c1'), search('c2'));
  const assistant = { ...long.assistant, reasoning_details: [{ type: 'reasoning.text', text: 'r'.repeat(3600) }] };
  const heavy: ModelResponse = { ...long, assistant };
  assert.ok(JSON.stringify(assistant).length >= 3600);
  const loop = stubLoop([], 1000);
  const model = stubModel(heavy, toolCall(valid));
  const r = await callBatch({ ...args, tools: loop }, model);
  assert.ok(r.ok);
  assert.deepEqual(loop.runs, [['c1', false], ['c2', false]]);
  assert.deepEqual(model.requests[1]!.messages.slice(3), [toolMessage('c1', NOT_RUN_CLOSED), toolMessage('c2', NOT_RUN_CLOSED), final]);
  assert.equal(model.requests[1]!.forcedTool, 'submit_review');
  assert.deepEqual(r.audit.at(-1), closed('room'));

  const big = stubLoop([{ content: 'x'.repeat(3300) }], 1000);
  const second = stubModel(calls(search('c1'), search('c2')), toolCall(valid));
  const s = await callBatch({ ...args, tools: big }, second);
  assert.ok(s.ok);
  assert.deepEqual(big.runs, [['c1', true], ['c2', false]]);
  assert.deepEqual(second.requests[1]!.messages.at(-1), final);
  assert.deepEqual(s.audit.at(-1), closed('room'));

  for (const turn of [heavy, calls(search('c1'), search('c2'))]) {
    const roomy = stubLoop([{ content: 'x'.repeat(3300) }]);
    const third = stubModel(turn, toolCall(valid));
    await callBatch({ ...args, tools: roomy }, third);
    assert.deepEqual(roomy.runs, [['c1', true], ['c2', true]]);
    assert.equal(third.requests[1]!.forcedTool, null);
    assert.ok(!third.requests[1]!.messages.includes(final) && third.requests[1]!.messages.every((m) => m.content !== FINAL_LINE));
  }
});

test('a turn whose every call is refused ends the open turns', async () => {
  const refused = { stop: null, sent: false, content: 'Not run: there is no tool of that name.' };
  const loop = stubLoop([refused, { ...refused, content: 'Not run: the arguments were not a JSON object.' }]);
  const model = stubModel(calls(callOf('c1', 'docs__invented', '{}'), callOf('c2', 'docs__search', 'not json')), toolCall(valid));
  const r = await callBatch({ ...args, tools: loop }, model);
  assert.ok(r.ok);
  assert.deepEqual(loop.runs, [['c1', true], ['c2', true]]);
  assert.deepEqual(model.requests[1]!.messages.slice(3), [
    toolMessage('c1', 'Not run: there is no tool of that name.'),
    toolMessage('c2', 'Not run: the arguments were not a JSON object.'),
    final,
  ]);
  assert.equal(model.requests.length, 2);
  assert.equal(model.requests[1]!.forcedTool, 'submit_review');
  assert.deepEqual(r.audit.at(-1), closed('nothing_sent'));

  const mixed = stubLoop([{}, refused]);
  const other = stubModel(calls(search('c1'), callOf('c2', 'docs__invented', '{}')), toolCall(valid));
  const s = await callBatch({ ...args, tools: mixed }, other);
  assert.ok(s.ok);
  assert.equal(other.requests[1]!.forcedTool, null);
  assert.ok(s.audit.every((e) => e.action !== 'tools_closed'));
});

test('the turn that must end the call keeps the tool list: under forced it names submit_review, under auto it names nothing', async () => {
  for (const [toolChoice, forcedTool] of [['forced', 'submit_review'], ['auto', null]] as const) {
    const model = stubModel(calls(...nine), toolCall(valid));
    const r = await callBatch({ ...args, toolChoice, tools: cappedLoop() }, model);
    assert.ok(r.ok);
    assert.equal(model.requests.length, 2);
    assert.deepEqual(model.requests[0]!.tools, allTools);
    assert.deepEqual(model.requests[1]!.tools, model.requests[0]!.tools);
    assert.deepEqual(model.requests.map((q) => q.forcedTool), [null, forcedTool]);
    assert.deepEqual(model.requests[1]!.messages.at(-1), final);
  }
});

test('under auto a call to another tool on the closing turn is invalid output and takes the one retry', async () => {
  const auto = { ...args, toolChoice: 'auto' as const };
  const stopped = () => stubLoop([{ content: 'The tool call failed (timeout).', stop: 'tool_error' }]);
  const loop = stopped();
  const model = stubModel(calls(search('c1')), calls(search('c2', 'again')), toolCall(valid));
  const r = await callBatch({ ...auto, tools: loop }, model);
  assert.ok(r.ok);
  assert.deepEqual(loop.runs, [['c1', true]]);
  assert.equal(model.requests.length, 3);
  assert.deepEqual(model.requests.map((q) => q.forcedTool), [null, null, null]);
  assert.deepEqual(model.requests[2]!.messages, [
    ...model.requests[1]!.messages,
    { role: 'assistant', content: 'called docs__search with {"query":"again"}' },
    { role: 'user', content: 'Your answer was rejected: not_a_tool_call. Call submit_review again.' },
  ]);
  assert.deepEqual(model.requests[2]!.tools, allTools);
  assert.deepEqual(r.audit.slice(-2), [closed('tool_error'), { stage: 'model', action: 'retry', subject: 'batch', reason: 'not_a_tool_call' }]);

  const twice = stopped();
  const failing = stubModel(calls(search('c1')), calls(search('c2')), calls(search('c3')));
  const f = await callBatch({ ...auto, tools: twice }, failing);
  assert.ok(!f.ok);
  assert.deepEqual([f.code, f.reason], ['invalid_output', 'not_a_tool_call']);
  assert.deepEqual(twice.runs, [['c1', true]]);
  assert.equal(failing.requests.length, 3);
  assert.deepEqual(f.audit.at(-1), { stage: 'model', action: 'failed', subject: 'batch', reason: 'invalid_output' });
});

test('a prose answer in an open turn takes the one retry, over the transcript as it stands', async () => {
  const model = stubModel(calls(search('c1')), prose('It looks fine to me.'), toolCall(valid));
  const r = await callBatch({ ...args, tools: stubLoop() }, model);
  assert.ok(r.ok);
  assert.equal(model.requests.length, 3);
  assert.deepEqual(model.requests.map((q) => q.forcedTool), [null, null, 'submit_review']);
  assert.deepEqual(model.requests[2]!.messages, [
    ...model.requests[1]!.messages,
    { role: 'assistant', content: 'It looks fine to me.' },
    { role: 'user', content: 'Your answer was rejected: not_a_tool_call. Call submit_review again.' },
  ]);
  for (const request of model.requests) assert.ok(request.messages.every((m) => m.content !== FINAL_LINE));
  assert.deepEqual(r.audit.at(-1), { stage: 'model', action: 'retry', subject: 'batch', reason: 'not_a_tool_call' });

  const failing = stubModel(calls(search('c1')), prose('It looks fine to me.'), prose('Still fine.'));
  const f = await callBatch({ ...args, tools: stubLoop() }, failing);
  assert.ok(!f.ok);
  assert.deepEqual([f.code, f.reason], ['invalid_output', 'not_a_tool_call']);
  assert.equal(failing.requests.length, 3);
});

test('an invalid submit_review after tool calls is retried once over the transcript with its tool results', async () => {
  const model = stubModel(calls(search('c1')), calls(submit('c2', { overview: 'x' })), toolCall(valid));
  const r = await callBatch({ ...args, tools: stubLoop() }, model);
  assert.ok(r.ok);
  assert.equal(model.requests.length, 3);
  const third = model.requests[2]!.messages;
  assert.deepEqual(third.slice(0, 4), model.requests[1]!.messages);
  assert.equal(third[2]!.role, 'assistant');
  assert.deepEqual(third[3], toolMessage('c1'));
  assert.deepEqual(third[4], { role: 'assistant', content: JSON.stringify({ overview: 'x' }) });
  assert.match(third[5]!.content, /^Your answer was rejected: findings/);
  assert.equal(third.length, 6);
  assert.equal(model.requests[2]!.forcedTool, 'submit_review');
});

test('one call makes at most six requests', async () => {
  const loop = stubLoop();
  const model = stubModel(calls(search('c1')), calls(search('c2')), calls(search('c3')), calls(search('c4')), toolCall(ungrounded), toolCall(ungrounded), toolCall(valid));
  const r = await callBatch({ ...args, tools: loop }, model);
  assert.ok(!r.ok);
  assert.equal(r.code, 'invalid_output');
  assert.equal(model.requests.length, 6);
  assert.equal(r.usage.calls, 6);
  assert.deepEqual(r.audit.slice(-3).map((e) => [e.action, e.reason]), [['tools_closed', 'turn_cap'], ['retry', UNGROUNDED], ['failed', 'invalid_output']]);
});

test('an answer whose only call has no id is not a tool call', async () => {
  const loop = stubLoop();
  const idless: ModelResponse = { toolName: 'docs__search', toolArguments: '{"query":"cart"}', text: null, model: 'm', provider: null, usage: usage() };
  const model = stubModel(idless, idless);
  const r = await callBatch({ ...args, tools: loop }, model);
  assert.ok(!r.ok);
  assert.deepEqual([r.code, r.reason], ['invalid_output', 'not_a_tool_call']);
  assert.deepEqual(loop.runs, []);
  assert.equal(model.requests.length, 2);
  assert.deepEqual(model.requests.map((q) => q.forcedTool), [null, 'submit_review']);
  assert.deepEqual(r.audit, [
    { stage: 'model', action: 'retry', subject: 'batch', reason: 'not_a_tool_call' },
    { stage: 'model', action: 'failed', subject: 'batch', reason: 'invalid_output' },
  ]);
});

test('a provider error with tools offered is returned at once, for the review to try again without them', async () => {
  const loop = stubLoop();
  const model = stubModel(new ProviderError('provider', 'bad request', 400, null), toolCall(valid));
  const r = await callBatch({ ...args, tools: loop }, model);
  assert.ok(!r.ok);
  assert.deepEqual([r.code, r.reason], ['provider', 'bad request']);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(loop.runs, []);
  assert.deepEqual(r.audit, [{ stage: 'model', action: 'failed', subject: 'batch', reason: 'provider' }]);
  const plain = stubModel(toolCall(valid));
  const again = await callBatch(args, plain);
  assert.ok(again.ok);
  assert.deepEqual(plain.requests, [{ messages, tools: [submitReviewTool], forcedTool: 'submit_review', effort: 'elevated', timeoutMs: 1234 }]);
});

test('a provider error in the middle of the loop is returned with the usage and the audit so far', async () => {
  const model = stubModel(calls(search('c1')), new ProviderError('timeout', 't', null, null));
  const r = await callBatch({ ...args, tools: stubLoop() }, model);
  assert.ok(!r.ok);
  assert.equal(r.code, 'timeout');
  assert.equal(r.usage.calls, 1);
  assert.deepEqual(r.models, ['m']);
  assert.deepEqual(r.audit, [outcomeOf('c1').audit, { stage: 'model', action: 'failed', subject: 'batch', reason: 'timeout' }]);
});

test('usage, models and providers add up across the turns', async () => {
  const turn = (response: ModelResponse, model: string, provider: string | null): ModelResponse => ({ ...response, model, provider });
  const model = stubModel(turn(calls(search('c1')), 'vendor/a', 'Up One'), turn(calls(search('c2')), 'vendor/b', null), toolCall(valid, 'vendor/c', 'Up Two'));
  const r = await callBatch({ ...args, tools: stubLoop() }, model);
  assert.ok(r.ok);
  assert.deepEqual(r.usage, { calls: 3, inputTokens: 300, outputTokens: 30, cachedTokens: 15, cost: 1.5 });
  assert.deepEqual(r.models, ['vendor/a', 'vendor/b', 'vendor/c']);
  assert.deepEqual(r.providers, ['Up One', 'Up Two']);
});

test('a first call to submit_review with no id is the answer, and the calls beside it are dropped', async () => {
  const loop = stubLoop();
  const turn: ModelResponse = { ...calls(search('c1'), callOf('c2', 'docs__get_page', '{"id":"p1"}')), toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify(valid) };
  const model = stubModel(turn);
  const r = await callBatch({ ...args, tools: loop }, model);
  assert.ok(r.ok);
  assert.equal(r.value.overview, 'Looks fine.');
  assert.equal(model.requests.length, 1);
  assert.deepEqual(loop.runs, []);
  assert.deepEqual(r.audit, [{ stage: 'model', action: 'tool_calls_dropped', subject: 'batch', reason: '2' }]);
});

test('under auto a failing answer read from the first call is not replaced by a later valid submit_review', async () => {
  const loop = stubLoop();
  const turn: ModelResponse = { ...calls(search('c1'), submit('c2', valid)), toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify(ungrounded) };
  const model = stubModel(turn, toolCall(valid));
  const r = await callBatch({ ...args, toolChoice: 'auto', tools: loop }, model);
  assert.ok(r.ok);
  assert.equal(model.requests.length, 2);
  assert.deepEqual(loop.runs, []);
  assert.deepEqual(model.requests[1]!.messages.slice(2), [
    { role: 'assistant', content: JSON.stringify(ungrounded) },
    { role: 'user', content: `Your answer was rejected: ${UNGROUNDED}. Call submit_review again.` },
  ]);
  assert.deepEqual(r.audit.map((e) => [e.action, e.reason]), [['tool_calls_dropped', '2'], ['retry', UNGROUNDED]]);
});

test('under forced a closing turn that calls another tool beside submit_review is answered by submit_review, and nothing of it is run', async () => {
  const loop = stubLoop([{ content: 'The tool call failed (timeout).', stop: 'tool_error' }]);
  const model = stubModel(calls(search('c1')), calls(search('c2', 'again'), submit('c3', valid)));
  const r = await callBatch({ ...args, tools: loop }, model);
  assert.ok(r.ok);
  assert.equal(r.value.overview, 'Looks fine.');
  assert.equal(model.requests.length, 2);
  assert.deepEqual(model.requests.map((q) => q.forcedTool), [null, 'submit_review']);
  assert.deepEqual(loop.runs, [['c1', true]]);
  assert.deepEqual(r.audit.map((e) => e.action), ['tool_call', 'tools_closed']);
});

test('a message that lands exactly on the room fills it', async () => {
  const turn = (...entries: ToolCall[]) => calls(...entries);
  const one = turn(search('c1'));
  const two = turn(search('c1'), search('c2'));
  const tokensOf = (r: ModelResponse) => estimateTokens(JSON.stringify(r.assistant));
  const exact = 'x'.repeat(298);   // JSON.stringify adds two quotes: 300 characters, 100 tokens
  assert.equal(estimateTokens(JSON.stringify(exact)), 100);
  // the assistant message alone reaches the room: its one call is not run
  const a = stubLoop([], tokensOf(one));
  const ma = stubModel(one, toolCall(valid));
  const ra = await callBatch({ ...args, tools: a }, ma);
  assert.deepEqual(a.runs, [['c1', false]]);
  assert.deepEqual(ra.audit.at(-1), closed('room'));
  // the first tool message reaches the room: the second call is not run
  const b = stubLoop([{ content: exact }], tokensOf(two) + 100);
  const mb = stubModel(two, toolCall(valid));
  const rb = await callBatch({ ...args, tools: b }, mb);
  assert.deepEqual(b.runs, [['c1', true], ['c2', false]]);
  assert.deepEqual(rb.audit.at(-1), closed('room'));
  // the last tool message of a turn reaches the room: the next turn must end the call
  const c = stubLoop([{ content: exact }], tokensOf(one) + 100);
  const mc = stubModel(one, toolCall(valid));
  const rc = await callBatch({ ...args, tools: c }, mc);
  assert.deepEqual(c.runs, [['c1', true]]);
  assert.deepEqual(mc.requests.map((q) => q.forcedTool), [null, 'submit_review']);
  assert.deepEqual(mc.requests[1]!.messages.at(-1), final);
  assert.deepEqual(rc.audit.at(-1), closed('room'));
  // one token under the room: the turn after is open
  const d = stubLoop([{ content: exact }], tokensOf(one) + 101);
  const md = stubModel(one, toolCall(valid));
  await callBatch({ ...args, tools: d }, md);
  assert.deepEqual(md.requests.map((q) => q.forcedTool), [null, null]);
});
