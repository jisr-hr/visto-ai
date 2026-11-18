import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScorerConfig } from '../../config/load.ts';
import { combine } from './jev-combine.ts';
import type { Answers } from './jev-combine.ts';
import { SIGNAL_NAMES } from './jev-questions.ts';
import { createJevScorer } from './jev.ts';

interface Call { url: string; method: string | undefined; headers: Record<string, string>; body: { model: string; state: string; questions: Record<string, unknown> }; signal: AbortSignal | null | undefined }
type Step = Response | Error;

const KEY = 'sk-synthetic-key-123';
const config: ScorerConfig = { baseUrl: 'https://decisions.example.test/v1', apiKey: KEY, model: 'synthetic-model', timeoutSeconds: 30 };

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });
const named = (name: string): Error => Object.assign(new Error('x'), { name });

function answersFor(prefix: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of SIGNAL_NAMES) out[`${prefix}_${name}`] = { type: 'noul', noul: 0 };
  for (const [name, noul] of Object.entries(over)) out[`${prefix}_${name}`] = { type: 'noul', noul };
  return out;
}
const merge = (...parts: Record<string, unknown>[]): Record<string, unknown> => Object.assign({}, ...parts);
const ok = (answers: Record<string, unknown>, usage?: Record<string, unknown>): Response =>
  json(200, usage === undefined ? { answers } : { answers, usage });

function setup(baseUrl = config.baseUrl) {
  const calls: Call[] = [];
  const slept: number[] = [];
  let steps: Step[] = [];
  const fetchStub = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url: String(url), method: init?.method, headers, body: JSON.parse(String(init?.body)) as Call['body'], signal: init?.signal });
    const next = steps.shift();
    if (next === undefined) throw new Error('stub fetch: queue empty');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const scorer = createJevScorer({ ...config, baseUrl }, { fetch: fetchStub as typeof fetch, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } });
  return { scorer, calls, slept, queue: (...s: Step[]) => { steps = s; } };
}

const ids = (...n: string[]): string[] => n;

test('six blocks go out as two requests of four and two', async () => {
  const { scorer, calls, queue } = setup('https://decisions.example.test/v1///');
  queue(
    ok(merge(...['b1', 'b2', 'b3', 'b4'].map((i) => answersFor(i)))),
    ok(merge(...['b5', 'b6'].map((i) => answersFor(i)))),
  );
  const answer = await scorer.score({ text: 'the diff', blocks: ids('b1', 'b2', 'b3', 'b4', 'b5', 'b6') });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, 'https://decisions.example.test/v1/decisions');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[0]!.headers['content-type'], 'application/json');
  assert.equal(calls[0]!.body.state, 'the diff');
  assert.equal(calls[0]!.body.model, 'synthetic-model');
  assert.equal(Object.keys(calls[0]!.body.questions).length, 52);
  assert.equal(Object.keys(calls[1]!.body.questions).length, 26);
  assert.ok(calls[0]!.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(answer.blocks), ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
  assert.equal(answer.whole, null);
  assert.equal(answer.failure, null);
});

test('no blocks asks one whole-file request', async () => {
  const { scorer, calls, queue } = setup();
  queue(ok(answersFor('file')));
  const answer = await scorer.score({ text: 'moved file', blocks: [] });
  assert.equal(calls.length, 1);
  const keys = Object.keys(calls[0]!.body.questions);
  assert.equal(keys.length, 13);
  assert.ok(keys.every((k) => k.startsWith('file_')));
  assert.notEqual(answer.whole, null);
  assert.deepEqual(answer.blocks, {});
  assert.equal(answer.failure, null);
});

test('usage adds up over responses and a response without usage adds nothing', async () => {
  const { scorer, queue } = setup();
  const four = ['b1', 'b2', 'b3', 'b4'];
  queue(
    ok(merge(...four.map((i) => answersFor(i))), { input_tokens: 100, output_tokens: 10, cost: 0.5 }),
    ok(answersFor('b5'), { input_tokens: 30, output_tokens: 5, cost: 0.25 }),
  );
  const answer = await scorer.score({ text: 't', blocks: [...four, 'b5'] });
  assert.deepEqual(answer.usage, { calls: 2, inputTokens: 130, outputTokens: 15, cachedTokens: 0, cost: 0.75 });

  queue(ok(answersFor('b1')));
  const none = await scorer.score({ text: 't', blocks: ['b1'] });
  assert.deepEqual(none.usage, { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 });
});

test('a block with a missing, out-of-range or wrong-typed answer is left out', async () => {
  const { scorer, queue } = setup();
  const missing = answersFor('b1');
  delete missing.b1_security;
  queue(ok(merge(missing, answersFor('b2', { security: 1.2 }), { ...answersFor('b3'), b3_security: { type: 'choice', noul: 0 } }, answersFor('b4'))));
  const answer = await scorer.score({ text: 't', blocks: ids('b1', 'b2', 'b3', 'b4') });
  assert.deepEqual(Object.keys(answer.blocks), ['b4']);
  assert.equal(answer.failure, 'bad_answer');
});

test('a bad answer does not stop the remaining groups', async () => {
  const { scorer, calls, queue } = setup();
  queue(ok(merge(answersFor('b1', { security: -0.1 }), answersFor('b2'), answersFor('b3'), answersFor('b4'))), ok(answersFor('b5')));
  const answer = await scorer.score({ text: 't', blocks: ids('b1', 'b2', 'b3', 'b4', 'b5') });
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(answer.blocks), ['b2', 'b3', 'b4', 'b5']);
  assert.equal(answer.failure, 'bad_answer');
});

test('401 is auth and 402 is no_credit, with no second try', async () => {
  const a = setup();
  a.queue(json(401, { error: { message: 'no' } }));
  const auth = await a.scorer.score({ text: 't', blocks: ['b1'] });
  assert.equal(auth.failure, 'auth');
  assert.equal(a.calls.length, 1);
  assert.deepEqual(a.slept, []);

  const b = setup();
  b.queue(json(402, {}));
  const credit = await b.scorer.score({ text: 't', blocks: ['b1'] });
  assert.equal(credit.failure, 'no_credit');
  assert.equal(b.calls.length, 1);
});

test('429 waits the retry-after time and tries once more', async () => {
  const a = setup();
  a.queue(json(429, {}, { 'retry-after': '2' }), ok(answersFor('b1')));
  const done = await a.scorer.score({ text: 't', blocks: ['b1'] });
  assert.deepEqual(a.slept, [2000]);
  assert.equal(done.failure, null);
  assert.deepEqual(Object.keys(done.blocks), ['b1']);

  const b = setup();
  b.queue(json(429, {}), json(429, {}));
  const limited = await b.scorer.score({ text: 't', blocks: ['b1'] });
  assert.equal(limited.failure, 'rate_limited');
  assert.equal(b.calls.length, 2);
});

test('a provider error is tried again at once; a second one stops the file but keeps earlier groups', async () => {
  const a = setup();
  a.queue(json(500, {}), ok(answersFor('b1')));
  const done = await a.scorer.score({ text: 't', blocks: ['b1'] });
  assert.equal(a.calls.length, 2);
  assert.deepEqual(a.slept, []);
  assert.equal(done.failure, null);

  const b = setup();
  const g1 = ['b1', 'b2', 'b3', 'b4'];
  const g2 = ['b5', 'b6', 'b7', 'b8'];
  b.queue(ok(merge(...g1.map((i) => answersFor(i)))), json(500, {}), json(500, {}));
  const partial = await b.scorer.score({ text: 't', blocks: [...g1, ...g2, 'b9'] });
  assert.equal(b.calls.length, 3);
  assert.deepEqual(Object.keys(partial.blocks), g1);
  assert.equal(partial.failure, 'provider');
});

test('timeouts, network errors and non-JSON bodies are told apart', async () => {
  const t = setup();
  t.queue(named('TimeoutError'), named('TimeoutError'));
  assert.equal((await t.scorer.score({ text: 't', blocks: ['b1'] })).failure, 'timeout');
  assert.equal(t.calls.length, 2);

  const n = setup();
  n.queue(new TypeError('fetch failed'), new TypeError('fetch failed'));
  assert.equal((await n.scorer.score({ text: 't', blocks: ['b1'] })).failure, 'provider');

  const j = setup();
  j.queue(new Response('not json', { status: 200 }), new Response('not json', { status: 200 }));
  assert.equal((await j.scorer.score({ text: 't', blocks: ['b1'] })).failure, 'provider');

  const m = setup();
  m.queue(json(200, { something: 1 }), json(200, { something: 1 }));
  assert.equal((await m.scorer.score({ text: 't', blocks: ['b1'] })).failure, 'provider');
});

test('the key never reaches the returned answer', async () => {
  const { scorer, queue } = setup();
  queue(json(500, { error: { message: `bad key ${KEY}` } }), json(500, { error: { message: `bad key ${KEY}` } }));
  const answer = await scorer.score({ text: 't', blocks: ['b1'] });
  assert.equal(answer.failure, 'provider');
  assert.ok(!JSON.stringify(answer).includes(KEY));
});

test('category and reason text sent by the provider changes nothing', async () => {
  const { scorer, queue } = setup();
  const over = { security: 0.9, display_only: 0.2 };
  const answers = answersFor('b1', over);
  for (const key of Object.keys(answers)) Object.assign(answers[key] as object, { category: 'invented', reason: 'invented text' });
  queue(ok(answers));
  const answer = await scorer.score({ text: 't', blocks: ['b1'] });
  const probabilities = Object.fromEntries(SIGNAL_NAMES.map((n) => [n, 0])) as Answers;
  Object.assign(probabilities, over);
  assert.deepEqual(answer.blocks.b1, combine(probabilities));
});
