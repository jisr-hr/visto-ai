import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SUBMIT_REVIEW } from '../engine/model/submit-review.ts';
import { review } from '../engine/review.ts';
import type { ChangedFile, ModelRequest, ModelResponse, ReviewDeps, ReviewInput } from '../engine/types.ts';
import { contextProvidersOf, loadExtensions } from './load.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const bulk = Array.from({ length: 30 }, (_, i) => `+const value${i} = ${i * 7919};`).join('\n');
const FILE: ChangedFile = { path: 'src/a.ts', previousPath: null, status: 'modified', additions: 31, deletions: 0, patch: `@@ -1,1 +1,31 @@\n head\n${bulk}` };
const INPUT: ReviewInput = {
  pullRequest: {
    ref: { service: 'github', owner: 'acme', repo: 'shop', number: 7 },
    title: 'Add the cart', description: 'For SHOP-12.', author: 'octo-dev',
    baseBranch: 'main', headBranch: 'shop-12-cart', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), draft: false, fromFork: false,
  },
  trigger: 'automatic', repoConfig: { primaryBranches: ['main'], scoreThreshold: 70 },
  limits: { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 30 }, asOf: new Date(0), earlier: null,
};

test('a review with the example module shows its text and its criteria to the model and comes back with a row for each', async () => {
  const loaded = await loadExtensions([{ name: 'example', module: './examples/extension-example.ts', options: {} }], {
    configDir: ROOT, log: () => {}, reportFeedback: async () => ({ ok: true }),
  });
  const requests: ModelRequest[] = [];
  const answer = {
    overview: 'src/a.ts adds values.', findings: [], files: [],
    acceptance: [{ item: 'A1', status: 'met', note: 'src/a.ts is covered by a test.' }],
  };
  const deps: ReviewDeps = {
    source: { listFiles: () => Promise.resolve([FILE]), getFileContent: () => Promise.resolve(null), getDefaultBranchFile: () => Promise.resolve(null) },
    model: {
      complete: async (request): Promise<ModelResponse> => {
        requests.push(request);
        return { toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify(answer), text: null, model: 'm', provider: null, usage: { calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, cost: 0.01 } };
      },
    },
    contract: 'You review pull requests.', clock: () => new Date(0), token: () => 'abcdef0123456789', log: () => {},
    contextProviders: contextProvidersOf(loaded),
  };
  const r = await review(INPUT, deps);
  assert.equal(requests.length, 1);
  const header = requests[0]!.messages[1]!.content;
  assert.ok(header.includes('This text comes from the example extension.'));
  assert.ok(header.includes('A1. The change has a test.'));
  assert.deepEqual(r.acceptance?.map((row) => row.status), ['met', 'not_verified']);
  assert.deepEqual(r.dependencies.extensions, { example: { status: 'ok', code: 'ok' } });
});
