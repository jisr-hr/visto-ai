import assert from 'node:assert/strict';
import test from 'node:test';
import { GATE_OFF, type DeploymentConfig } from '../config/load.ts';
import { ProviderError } from '../engine/model/errors.ts';
import type { ChangedFile, ModelClient, ModelRequest, ModelResponse, ReviewDeps, Source } from '../engine/types.ts';
import type { EvalCase } from './cases.ts';
import { PLAIN_PROMPT, SUBMIT_FINDINGS, plainCase } from './plain.ts';

const config: DeploymentConfig = {
  model: {
    baseUrl: 'https://models.example.test/v1', apiKey: 'k', model: 'm', fallbacks: [],
    effort: { default: {}, elevated: {} }, extraBody: {}, extraHeaders: {}, prices: null, timeoutSeconds: 45, toolChoice: 'forced',
  },
  scorer: null,
  app: null, database: null, server: { port: 8080 }, dryRun: false, learning: false, alerts: null, extensions: [], mcpServers: [],
  limits: { inputTokensPerCall: 200_000, batchesPerReview: 6, spendPerDay: 50, queueConcurrency: 2 },
  repositories: { defaults: { primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: [], baseBranches: [], newHead: null, inlineNotes: false, gate: GATE_OFF }, overrides: {} },
};

const theCase: EvalCase = {
  repo: 'acme/shop', pr_number: 7, head_sha: 'abcdef0123456789', compare_base: 'base000', title: 'Add a cart total',
  body: 'Adds the total of a cart.', branch: 'topic', base_branch: 'dev', author: 'dev-one',
  labels: [{ comment_id: '1', path: 'src/cart.ts', line: 2, side: 'RIGHT', severity: 'major', label: 'valid' }],
};

const cart: ChangedFile = { path: 'src/cart.ts', previousPath: null, status: 'modified', additions: 2, deletions: 0, patch: '@@ -1,1 +1,3 @@\n head\n+const total = items.length;\n+export { total };' };
const logo: ChangedFile = { path: 'logo.bin', previousPath: null, status: 'modified', additions: 0, deletions: 0, patch: null };
const answer = (findings: unknown[]): string => JSON.stringify({ findings });
const oneFinding = { path: 'src/cart.ts', line: 3, severity: 'major', body: 'The total counts items, not their prices.' };

function response(args: string | null, extra: Partial<ModelResponse> = {}): ModelResponse {
  return {
    toolName: args === null ? null : SUBMIT_FINDINGS, toolArguments: args, text: null, model: 'm', provider: null,
    usage: { calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, cost: 0.01 }, ...extra,
  };
}

function setup(replies: Array<string | null | Error>, files: ChangedFile[] | Error = [cart, logo], overrides: Partial<ReviewDeps> = {}) {
  const requests: ModelRequest[] = [];
  const model: ModelClient = {
    complete: (r) => {
      requests.push(r);
      const next = replies[Math.min(requests.length - 1, replies.length - 1)]!;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(response(next));
    },
  };
  const source: Source = {
    listFiles: () => (files instanceof Error ? Promise.reject(files) : Promise.resolve(files)),
    getFileContent: () => Promise.resolve(null), getDefaultBranchFile: () => Promise.resolve(null),
  };
  const deps: ReviewDeps = { source, model, contract: 'unused', clock: () => new Date(0), token: () => 'abcdef0123456789', log: () => {}, ...overrides };
  return { deps, requests };
}

test('plainCase sends one call with the patch between markers and returns its findings', async () => {
  const { deps, requests } = setup([answer([oneFinding])]);
  const r = await plainCase(theCase, config, deps);
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.forcedTool, SUBMIT_FINDINGS);
  assert.equal(request.timeoutMs, 45_000);
  assert.equal(request.messages[0]!.content, PLAIN_PROMPT);
  const user = request.messages[1]!.content;
  assert.match(user, /<<<data abcdef0123456789 patch>>>\nFile: src\/cart\.ts\n/);
  assert.match(user, /<<<data abcdef0123456789 title>>>\nAdd a cart total\n<<<end abcdef0123456789>>>/);
  assert.match(user, /<<<data abcdef0123456789 description>>>/);
  assert.equal(user.includes('logo.bin'), false);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.findings, [{ ...oneFinding, side: 'RIGHT' }]);
  assert.equal(r.files_reviewed, 1);
  assert.deepEqual(r.not_reviewed, { no_diff: 1 });
  assert.deepEqual([r.highest_score, r.needs_human, r.calls, r.total_cost, r.total_tokens, r.models], [null, null, 1, 0.01, 110, ['m']]);
});

test('plainCase lets the model choose the tool when toolChoice is auto', async () => {
  const { deps, requests } = setup([answer([])], [cart], { toolChoice: 'auto' });
  const r = await plainCase(theCase, config, deps);
  assert.equal(requests[0]!.forcedTool, null);
  assert.deepEqual([r.status, r.findings], ['ok', []]);
});

test('plainCase retries once on an invalid answer, then fails with invalid_output', async () => {
  const bad = answer([{ ...oneFinding, severity: 'huge' }]);
  const { deps, requests } = setup([bad]);
  const r = await plainCase(theCase, config, deps);
  assert.equal(requests.length, 2);
  const again = requests[1]!.messages;
  assert.equal(again[again.length - 2]!.content, bad);
  assert.match(again[again.length - 1]!.content, /rejected: bad_severity/);
  assert.deepEqual([r.status, r.failure_stage, r.failure_reason, r.calls], ['failed', 'plain', 'invalid_output', 2]);
});

test('plainCase accepts the second answer when the first is invalid', async () => {
  const { deps, requests } = setup(['not json', answer([oneFinding])]);
  const r = await plainCase(theCase, config, deps);
  assert.equal(requests.length, 2);
  assert.deepEqual([r.status, r.findings.length], ['ok', 1]);
});

test('plainCase rejects an answer as a whole when one item is bad, or findings is missing', async () => {
  for (const bad of [answer([oneFinding, { ...oneFinding, line: 1.5 }]), answer([{ ...oneFinding, body: '' }]), JSON.stringify({ other: [] }), null]) {
    const { deps, requests } = setup([bad]);
    const r = await plainCase(theCase, config, deps);
    assert.equal(requests.length, 2);
    assert.equal(r.failure_reason, 'invalid_output');
  }
});

test('plainCase fails with too_large above the input limit, with no model call', async () => {
  const { deps, requests } = setup([answer([])]);
  const r = await plainCase(theCase, { ...config, limits: { ...config.limits, inputTokensPerCall: 50 } }, deps);
  assert.equal(requests.length, 0);
  assert.deepEqual([r.status, r.failure_stage, r.failure_reason, r.calls], ['failed', 'plain', 'too_large', 0]);
});

test('plainCase keeps a finding on a path that is not in the diff', async () => {
  const stray = { path: 'src/elsewhere.ts', line: 9, severity: 'minor', body: 'A stray comment.' };
  const { deps } = setup([answer([stray])]);
  const r = await plainCase(theCase, config, deps);
  assert.deepEqual(r.findings, [{ ...stray, side: 'RIGHT' }]);
});

test("plainCase uses the engine's effort", async () => {
  const many = Array.from({ length: 21 }, (_, i): ChangedFile => ({ ...cart, path: `src/f${i}.ts` }));
  const big = setup([answer([])], many);
  await plainCase(theCase, config, big.deps);
  assert.equal(big.requests[0]!.effort, 'elevated');
  const small = setup([answer([])]);
  await plainCase(theCase, config, small.deps);
  assert.equal(small.requests[0]!.effort, 'default');
});

test("plainCase fails with the source's code when listing the files rejects", async () => {
  const coded = await plainCase(theCase, config, setup([answer([])], new Error('github_403')).deps);
  assert.deepEqual([coded.status, coded.failure_stage, coded.failure_reason], ['failed', 'source', 'github_403']);
  const loud = await plainCase(theCase, config, setup([answer([])], new Error('Not Found: acme/shop')).deps);
  assert.deepEqual([loud.failure_stage, loud.failure_reason], ['source', 'unexpected_error']);
});

test('plainCase reports a provider error by its kind', async () => {
  const { deps } = setup([new ProviderError('rate_limited', 'rate_limited: slow down', 429, 1000)]);
  const r = await plainCase(theCase, config, deps);
  assert.deepEqual([r.status, r.failure_stage, r.failure_reason], ['failed', 'plain', 'rate_limited']);
});
