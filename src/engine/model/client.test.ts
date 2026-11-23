import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelConfig } from '../../config/load.ts';
import type { ModelRequest } from '../types.ts';
import { ProviderError, classify, createModelClient } from './client.ts';

interface Call { url: string; method: string | undefined; headers: Record<string, string>; raw: Headers; body: Record<string, unknown>; signal: AbortSignal | null | undefined }
type Step = Response | Error;

const baseConfig: ModelConfig = {
  baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'vendor/model-a', fallbacks: ['vendor/model-b'],
  effort: { default: {}, elevated: { reasoning: { effort: 'high' } } },
  extraBody: { provider: { require_parameters: true } }, extraHeaders: { 'X-Title': 'synthetic' },
  prices: null, timeoutSeconds: 60, toolChoice: 'forced',
};
const req: ModelRequest = {
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', function: { name: 'submit_review', description: 'd', parameters: {} } }],
  forcedTool: 'submit_review', effort: 'default', timeoutMs: 1000,
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });
const success = (model: string, usage: Record<string, unknown> = {}): unknown => ({
  model,
  choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ function: { name: 'submit_review', arguments: '{"a": 1}' } }] } }],
  usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 }, cost: 0.0123, ...usage },
});

function setup(config: ModelConfig = baseConfig) {
  const calls: Call[] = [];
  const slept: number[] = [];
  let steps: Step[] = [];
  const fetchStub = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url: String(url), method: init?.method, headers, raw: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown>, signal: init?.signal });
    const next = steps.shift();
    if (next === undefined) throw new Error('stub fetch: queue empty');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const client = createModelClient(config, { fetch: fetchStub as typeof fetch, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } });
  return { client, calls, slept, queue: (...s: Step[]) => { steps = s; } };
}
const named = (name: string): Error => Object.assign(new Error('x'), { name });

test('sends a forced tool call with the bearer key', async () => {
  const { client, calls, queue } = setup();
  queue(json(200, success('vendor/model-a')));
  await client.complete(req);
  assert.equal(calls[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.headers.authorization, 'Bearer k');
  assert.equal(calls[0]!.headers['content-type'], 'application/json');
  assert.equal(calls[0]!.headers['x-title'], 'synthetic');
  assert.deepEqual(calls[0]!.body.tool_choice, { type: 'function', function: { name: 'submit_review' } });
  assert.deepEqual(calls[0]!.body.messages, req.messages);
  assert.deepEqual(calls[0]!.body.tools, req.tools);
  assert.equal(calls[0]!.body.model, 'vendor/model-a');
  assert.equal(calls[0]!.body.stream, false);
  assert.ok(calls[0]!.signal instanceof AbortSignal);
});
test('merges the effort fragment and the extras', async () => {
  const { client, calls, queue } = setup();
  queue(json(200, success('vendor/model-a')));
  await client.complete({ ...req, effort: 'elevated' });
  assert.deepEqual(calls[0]!.body.reasoning, { effort: 'high' });
  assert.deepEqual(calls[0]!.body.provider, { require_parameters: true });
});
test('extraBody overrides the effort fragment', async () => {
  const { client, calls, queue } = setup({ ...baseConfig, effort: { default: { n: 1, temperature: 0 }, elevated: {} }, extraBody: { n: 2 } });
  queue(json(200, success('vendor/model-a')));
  await client.complete(req);
  assert.equal(calls[0]!.body.n, 2);
  assert.equal(calls[0]!.body.temperature, 0);
});
test('configuration cannot override the engine fields', async () => {
  const hostile = { model: 'x', messages: [], tools: [], tool_choice: 'none' };
  const { client, calls, queue } = setup({ ...baseConfig, effort: { default: hostile, elevated: {} }, extraBody: { model: 'x', tool_choice: 'none' } });
  queue(json(200, { error: { message: 'down' } }), json(200, success('vendor/model-b')));
  await client.complete(req);
  assert.equal(calls[0]!.body.model, 'vendor/model-a');
  assert.equal(calls[1]!.body.model, 'vendor/model-b');
  assert.deepEqual(calls[0]!.body.tool_choice, { type: 'function', function: { name: 'submit_review' } });
  assert.deepEqual(calls[0]!.body.messages, req.messages);
  assert.deepEqual(calls[0]!.body.tools, req.tools);
});
test('a body read that times out is a timeout, not a fallback', async () => {
  for (const [name, kind, calls] of [['TimeoutError', 'timeout', 1], ['AbortError', 'timeout', 1], ['Other', 'provider', 2]] as const) {
    const s = setup();
    const broken = { status: 200, headers: new Headers(), text: () => Promise.reject(named(name)) } as unknown as Response;
    s.queue(broken, broken);
    await assert.rejects(s.client.complete(req), (e: ProviderError) => e.kind === kind);
    assert.equal(s.calls.length, calls);
  }
});
const unreadable = (status: number, name: string, headers: Record<string, string> = {}): Response =>
  ({ status, headers: new Headers(headers), text: () => Promise.reject(named(name)) }) as unknown as Response;
test('a failed body read on a non-2xx status is still classified by status', async () => {
  const a = setup();
  a.queue(unreadable(401, 'Other'), json(200, success('vendor/model-b')));
  await assert.rejects(a.client.complete(req), (e: ProviderError) => e.kind === 'auth');
  assert.equal(a.calls.length, 1);
  const b = setup();
  b.queue(unreadable(429, 'Other', { 'retry-after': '3' }), json(200, success('vendor/model-a')));
  await b.client.complete(req);
  assert.deepEqual(b.slept, [3000]);
  assert.deepEqual(b.calls.map((c) => c.body.model), ['vendor/model-a', 'vendor/model-a']);
  const c = setup();
  c.queue(unreadable(200, 'TimeoutError'), json(200, success('vendor/model-b')));
  await assert.rejects(c.client.complete(req), (e: ProviderError) => e.kind === 'timeout');
  assert.equal(c.calls.length, 1);
});
test('the key is in neither message nor stack, even across the 200-character cut', async () => {
  const key = 'sk-test-0123456789abcdef';
  const cases = [`bad key ${key} given`, `${'x'.repeat(190)}${key}`];
  for (const message of cases) {
    const { client, queue } = setup({ ...baseConfig, apiKey: key });
    queue(json(401, { error: { message } }));
    await assert.rejects(client.complete(req), (e: ProviderError) => {
      const seen = `${e.message}\n${e.stack ?? ''}`;
      return !seen.includes(key.slice(0, 8)) && e.message.includes('[redacted]');
    });
  }
});
test('the key is redacted from an error message the provider echoes it in', async () => {
  const { client, queue } = setup({ ...baseConfig, apiKey: 'sekret-key-value' });
  queue(json(401, { error: { message: 'bad key sekret-key-value given' } }));
  await assert.rejects(client.complete(req), (e: ProviderError) => !e.message.includes('sekret') && e.message.includes('[redacted]'));
});
test('reads the tool call, the model and the usage', async () => {
  const { client, queue } = setup();
  queue(json(200, success('vendor/model-a')));
  const r = await client.complete(req);
  assert.deepEqual([r.toolName, r.toolArguments, r.text, r.model, r.provider], ['submit_review', '{"a": 1}', null, 'vendor/model-a', null]);
  assert.deepEqual(r.usage, { calls: 1, inputTokens: 1000, outputTokens: 50, cachedTokens: 800, cost: 0.0123 });
});
test('a reply with no tool call is returned with its text', async () => {
  const { client, queue } = setup();
  queue(json(200, { model: 'vendor/model-a', choices: [{ finish_reason: 'stop', message: { content: 'plain' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
  const r = await client.complete(req);
  assert.deepEqual([r.toolName, r.toolArguments, r.text], [null, null, 'plain']);
  assert.deepEqual(r.usage, { calls: 1, inputTokens: 1, outputTokens: 2, cachedTokens: 0, cost: 0 });
});
test('cost comes from prices when the endpoint reports none', async () => {
  const { client, queue } = setup({ ...baseConfig, prices: { inputPerMillion: 1, cachedInputPerMillion: 0.5, outputPerMillion: 2 } });
  queue(json(200, success('vendor/model-a', { cost: undefined })));
  assert.equal((await client.complete(req)).usage.cost, 0.0007);
});
test('an error inside a 200 moves to the fallback model', async () => {
  const { client, calls, queue } = setup();
  queue(json(200, { error: { code: 502, message: 'upstream down' } }), json(200, success('vendor/model-b')));
  assert.equal((await client.complete(req)).model, 'vendor/model-b');
  assert.equal(calls[1]!.body.model, 'vendor/model-b');
});
test('a network failure moves to the fallback model; every model failing throws the last error', async () => {
  const { client, calls, queue } = setup();
  queue(new TypeError('fetch failed'), json(500, { error: { message: 'boom\nline two' } }));
  await assert.rejects(client.complete(req), (e: ProviderError) => e.kind === 'provider' && e.status === 500 && e.message === 'provider: boom line two');
  assert.equal(calls.length, 2);
});
test('a 2xx body that is not JSON is a provider error', async () => {
  const { client, queue } = setup({ ...baseConfig, fallbacks: [] });
  queue(new Response('<html>', { status: 200 }));
  await assert.rejects(client.complete(req), (e: ProviderError) => e.kind === 'provider');
});
test('classify handles each status and body shape', () => {
  assert.equal(classify(200, success('m'), null), null);
  assert.equal(classify(200, { choices: [] }, null)!.kind, 'provider');
  assert.equal(classify(200, { model: 'm' }, null)!.kind, 'provider');
  assert.equal(classify(200, { choices: [{ finish_reason: 'error', message: {} }] }, null)!.kind, 'provider');
  assert.equal(classify(200, { error: { message: 'e' }, choices: [{}] }, null)!.kind, 'provider');
  assert.equal(classify(401, {}, null)!.kind, 'auth');
  assert.equal(classify(402, {}, null)!.kind, 'no_credit');
  assert.equal(classify(408, {}, null)!.kind, 'timeout');
  assert.equal(classify(504, {}, null)!.kind, 'timeout');
  assert.equal(classify(503, {}, null)!.kind, 'provider');
  assert.equal(classify(404, undefined, null)!.message, 'provider: status 404');
  assert.equal(classify(429, {}, '2')!.retryAfterMs, 2000);
  assert.equal(classify(429, {}, null)!.retryAfterMs, 5000);
  assert.equal(classify(429, {}, 'soon')!.retryAfterMs, 5000);
  assert.equal(classify(429, {}, '600')!.retryAfterMs, 60000);
  assert.equal(classify(500, { error: { message: 'a'.repeat(300) } }, null)!.message, `provider: ${'a'.repeat(200)}`);
});
test('a rejected key and an empty balance stop at once', async () => {
  const { client, calls, queue } = setup();
  queue(json(401, { error: { code: 401, message: 'no' } }));
  await assert.rejects(client.complete(req), (e: ProviderError) => e.kind === 'auth');
  assert.equal(calls.length, 1);
  queue(json(402, { error: { code: 402, message: 'credits' } }));
  await assert.rejects(client.complete(req), (e: ProviderError) => e.kind === 'no_credit');
  assert.equal(calls.length, 2);
});
test('the key appears in the Authorization header only', async () => {
  const { client, calls, queue } = setup({ ...baseConfig, apiKey: 'sekret-key-value' });
  queue(json(401, { error: { message: 'bad' } }));
  await assert.rejects(client.complete(req), (e: ProviderError) => !JSON.stringify(e).includes('sekret') && !e.message.includes('sekret'));
  assert.equal(JSON.stringify(calls[0]!.body).includes('sekret'), false);
});
test('a rate limit waits the named delay, once', async () => {
  const { client, slept, queue } = setup();
  queue(json(429, {}, { 'retry-after': '2' }), json(200, success('vendor/model-a')));
  await client.complete(req);
  assert.deepEqual(slept, [2000]);
});
test('a second rate limit throws', async () => {
  const { client, slept, calls, queue } = setup();
  queue(json(429, {}), json(429, {}));
  await assert.rejects(client.complete(req), (e: ProviderError) => e.kind === 'rate_limited');
  assert.deepEqual(slept, [5000]);
  assert.equal(calls.length, 2);
});
test('an abort is a timeout and is not retried', async () => {
  for (const name of ['AbortError', 'TimeoutError']) {
    const { client, calls, queue } = setup();
    queue(named(name));
    await assert.rejects(client.complete(req), (e: ProviderError) => e.kind === 'timeout');
    assert.equal(calls.length, 1);
  }
  const { client, queue } = setup();
  queue(json(504, {}));
  await assert.rejects(client.complete(req), (e: ProviderError) => e.kind === 'timeout');
});
test('usage adds up the attempts that returned it', async () => {
  const { client, queue } = setup({ ...baseConfig, fallbacks: ['vendor/model-b', 'vendor/model-c'] });
  queue(
    json(200, { error: { message: 'x' }, usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.5 } }),
    new TypeError('fetch failed'),
    json(200, success('vendor/model-c')),
  );
  const r = await client.complete(req);
  assert.deepEqual(r.usage, { calls: 2, inputTokens: 1010, outputTokens: 51, cachedTokens: 800, cost: 0.5123 });
});
test('the upstream provider is read when it is a string', async () => {
  const a = setup();
  a.queue(json(200, { ...(success('vendor/model-a') as object), provider: 'Upstream One' }));
  assert.equal((await a.client.complete(req)).provider, 'Upstream One');
  const b = setup();
  b.queue(json(200, { ...(success('vendor/model-a') as object), provider: { name: 'x' } }));
  assert.equal((await b.client.complete(req)).provider, null);
});
test('a response with no model field reports the model that was requested', async () => {
  const { client, queue } = setup();
  const body = success('ignored') as Record<string, unknown>;
  delete body.model;
  queue(json(200, { error: { message: 'down' } }), json(200, body));
  assert.equal((await client.complete(req)).model, 'vendor/model-b');
});
test('a fetch that gives up waiting for headers or body is a timeout, not a fallback', async () => {
  for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
    const { client, calls, queue } = setup();
    queue(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('timeout'), { code }) }), json(200, success('vendor/model-b')));
    await assert.rejects(client.complete(req), (e: ProviderError) => e.kind === 'timeout');
    assert.equal(calls.length, 1);
  }
  const other = setup();
  other.queue(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }), json(200, success('vendor/model-b')));
  assert.equal((await other.client.complete(req)).model, 'vendor/model-b');
});
test('a body read that gives up on the undici body timeout is a timeout', async () => {
  const s = setup();
  const failing = { status: 200, headers: new Headers(), text: () => Promise.reject(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_BODY_TIMEOUT' } })) } as unknown as Response;
  s.queue(failing, json(200, success('vendor/model-b')));
  await assert.rejects(s.client.complete(req), (e: ProviderError) => e.kind === 'timeout');
  assert.equal(s.calls.length, 1);
});
test('configuration cannot override the request headers or streaming', async () => {
  const { client, calls, queue } = setup({
    ...baseConfig,
    extraHeaders: { authorization: 'Bearer other', 'content-type': 'text/plain', 'X-Title': 'synthetic' },
    extraBody: { stream: true },
    effort: { default: { stream: true }, elevated: {} },
  });
  queue(json(200, success('vendor/model-a')));
  await client.complete(req);
  assert.equal(calls[0]!.raw.get('authorization'), 'Bearer k');
  assert.equal(calls[0]!.raw.get('content-type'), 'application/json');
  assert.equal(calls[0]!.raw.get('x-title'), 'synthetic');
  assert.equal(calls[0]!.body.stream, false);
});
