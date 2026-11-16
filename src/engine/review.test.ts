import assert from 'node:assert/strict';
import test from 'node:test';
import { fixedTokens } from './context/prompt.ts';
import { ProviderError } from './model/errors.ts';
import { SUBMIT_REVIEW } from './model/submit-review.ts';
import { chooseEffort, review } from './review.ts';
import type {
  ChangedFile, ModelClient, ModelRequest, ModelResponse, PullRequestInfo, RepoConfig, ReviewDeps, ReviewInput, Source, Usage,
} from './types.ts';

const CONTRACT = 'You review pull requests.';
const repo: RepoConfig = { primaryBranches: ['main'] };
const prTo = (baseBranch: string): PullRequestInfo => ({
  ref: { service: 'github', owner: 'acme', repo: 'shop', number: 7 },
  title: 'Add things', description: 'Adds things.', author: 'dev-one',
  baseBranch, headBranch: 'topic', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40), draft: false,
});
const input: ReviewInput = {
  pullRequest: prTo('feature'), trigger: 'automatic', repoConfig: repo,
  limits: { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 30 }, asOf: new Date(0), earlier: null,
};
const smallLimits: ReviewInput = {
  ...input, limits: { ...input.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest) + 400 },
};

const bulk = Array.from({ length: 30 }, (_, i) => `+const value${i} = ${i * 7919};`).join('\n');
const fileAt = (path: string): ChangedFile => ({
  path, previousPath: null, status: 'modified', additions: 31, deletions: 0,
  patch: `@@ -1,1 +1,31 @@\n head\n${bulk}`,
});
const fileA = fileAt('src/a.ts');
const fileB = fileAt('src/b.ts');
const binaryNoPatch: ChangedFile = { path: 'logo.bin', previousPath: null, status: 'modified', additions: 0, deletions: 0, patch: null };

const answerOnA = {
  overview: 'src/a.ts has a problem.',
  findings: [{ path: 'src/a.ts', side: 'RIGHT', line: 2, severity: 'major', body: 'Wrong value.', quote: '', beyond_diff: false }],
};
const answerOnB = { overview: 'src/b.ts is fine.', findings: [] };
const ungrounded = { overview: 'A long article about city gardens.', findings: [] };

const usage = (): Usage => ({ calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 5, cost: 0.5 });
const respond = (answer: unknown): ModelResponse =>
  ({ toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify(answer), text: null, model: 'm', usage: usage() });

type Step = unknown | ProviderError;
function deps(spec: { files: ChangedFile[]; answers?: Step[]; answerFor?: Record<string, Step>; delayMs?: number; listError?: Error }):
  ReviewDeps & { model: ModelClient & { requests: ModelRequest[]; maxInFlight: number }; logged: Array<Record<string, unknown>>; tokens: number } {
  const requests: ModelRequest[] = [];
  const logged: Array<Record<string, unknown>> = [];
  let inFlight = 0;
  const model = {
    requests,
    maxInFlight: 0,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      requests.push(request);
      inFlight += 1;
      model.maxInFlight = Math.max(model.maxInFlight, inFlight);
      try {
        if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
        let step: Step;
        if (spec.answerFor) {
          const last = request.messages[2]!.content; // the file sections; a retry appends later messages
          const key = Object.keys(spec.answerFor).find((p) => last.includes(p));
          step = key === undefined ? undefined : spec.answerFor[key];
        } else {
          step = (spec.answers ?? [])[requests.length - 1];
        }
        if (step === undefined) throw new Error('stub model exhausted');
        if (step instanceof ProviderError) throw step;
        return respond(step);
      } finally {
        inFlight -= 1;
      }
    },
  };
  const source: Source = {
    listFiles: () => (spec.listError ? Promise.reject(spec.listError) : Promise.resolve(spec.files)),
    getFileContent: () => Promise.resolve(null),
  };
  const d = {
    source, model, contract: CONTRACT, clock: () => new Date(0), logged, tokens: 0,
    token: () => { d.tokens += 1; return 'abcdef0123456789'; },
    log: (e: Record<string, unknown>) => { logged.push(e); },
  };
  return d;
}

test('an empty pull request makes no model call', async () => {
  const d = deps({ files: [] });
  const r = await review(input, d);
  assert.deepEqual([r.status, r.overview, d.model.requests.length], ['ok', 'No changes to review.', 0]);
});

test('one file, one finding, end to end', async () => {
  const r = await review(input, deps({ files: [fileA], answers: [answerOnA] }));
  assert.deepEqual(r.findings.map((f) => [f.path, f.side, f.line, f.severity]), [['src/a.ts', 'RIGHT', 2, 'major']]);
  assert.deepEqual(r.coverage, { reviewed: ['src/a.ts'], notReviewed: [] });
  assert.equal(r.usage.calls, 1);
  assert.equal(r.overview, 'src/a.ts has a problem.');
  assert.deepEqual([r.status, r.failure, r.mode, r.dependencies.model], ['ok', null, 'full', 'ok']);
});

test('a file with no patch and no content is listed, and the rest is reviewed', async () => {
  const r = await review(input, deps({ files: [fileA, binaryNoPatch], answers: [answerOnA] }));
  assert.deepEqual(r.coverage.notReviewed, [{ path: 'logo.bin', reason: 'no_diff' }]);
  assert.equal(r.status, 'ok');
});

test('files but nothing reviewable: ok, no call, files listed', async () => {
  const d = deps({ files: [binaryNoPatch] });
  const r = await review(input, d);
  assert.deepEqual([r.status, r.overview, d.model.requests.length], ['ok', 'No reviewable changes.', 0]);
  assert.deepEqual(r.coverage.notReviewed, [{ path: 'logo.bin', reason: 'no_diff' }]);
});

test('a budget below the fixed part fails with no call', async () => {
  const d = deps({ files: [fileA] });
  const r = await review({ ...input, limits: { ...input.limits, inputTokensPerCall: 10 } }, d);
  assert.deepEqual([r.status, r.failure, d.model.requests.length], ['failed', { stage: 'context', code: 'budget_too_small' }, 0]);
  assert.equal(r.overview, '');
});

test('effort', () => {
  assert.equal(chooseEffort(prTo('feature'), Array(16).fill(fileA), repo), 'elevated');
  assert.equal(chooseEffort(prTo('feature'), Array(15).fill({ ...fileA, additions: 1 }), repo), 'default');
  assert.equal(chooseEffort(prTo('feature'), [{ ...fileA, additions: 501 }], repo), 'elevated');
  assert.equal(chooseEffort(prTo('feature'), [{ ...fileA, additions: 500 }], repo), 'default');
  assert.equal(chooseEffort(prTo('main'), [fileA], repo), 'elevated');
  assert.equal(chooseEffort(prTo('feature'), [fileA], repo), 'default');
});

test('never more than two batches in flight', async () => {
  const files = ['a', 'b', 'c', 'd', 'e'].map((n) => fileAt(`src/${n}.ts`));
  const answerFor = Object.fromEntries(files.map((f) => [f.path, { overview: `${f.path} ok`, findings: [] }]));
  const d = deps({ files, answerFor, delayMs: 10 });
  const r = await review(smallLimits, d);
  assert.equal(d.model.requests.length, 5);
  assert.equal(d.model.maxInFlight, 2);
  assert.equal(r.coverage.reviewed.length, 5);
});

test('a timed-out batch of two files is split and each half is called once', async () => {
  const d = deps({ files: [fileA, fileB], answers: [new ProviderError('timeout', 't', null, null), answerOnA, answerOnB] });
  const r = await review(input, d);
  assert.deepEqual([d.model.requests.length, r.coverage.reviewed.length], [3, 2]);
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts', 'src/b.ts']);
  assert.equal(r.dependencies.model, 'ok');
});

test('a split half that fails again is given up, the other half counts', async () => {
  const t = new ProviderError('timeout', 't', null, null);
  const d = deps({ files: [fileA, fileB], answers: [t, answerOnA, t] });
  const r = await review(input, d);
  assert.equal(d.model.requests.length, 3);
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts']);
  assert.deepEqual(r.coverage.notReviewed, [{ path: 'src/b.ts', reason: 'batch_failed' }]);
  assert.equal(r.dependencies.model, 'error');
  assert.equal(r.status, 'ok');
});

test('a timeout on a single file is retried as the same batch', async () => {
  const d = deps({ files: [fileA], answers: [new ProviderError('timeout', 't', null, null), answerOnA] });
  const r = await review(input, d);
  assert.deepEqual([d.model.requests.length, r.status, r.coverage.reviewed], [2, 'ok', ['src/a.ts']]);
  assert.deepEqual(d.model.requests[0]!.messages, d.model.requests[1]!.messages);
});

test('a provider failure is tried once more, then the batch is given up', async () => {
  const down = new ProviderError('provider', 'p', 502, null);
  const d = deps({ files: [fileA], answers: [down, down] });
  const r = await review(input, d);
  assert.deepEqual([d.model.requests.length, r.status, r.failure], [2, 'failed', { stage: 'model', code: 'provider' }]);
  assert.equal(r.dependencies.model, 'error');
  assert.equal(r.usage.calls, 0); // a thrown provider error carries no usage
});

test('invalid output gets no further attempt beyond its own retry', async () => {
  const d = deps({ files: [fileA], answers: [ungrounded, ungrounded, answerOnA] });
  const r = await review(input, d);
  assert.equal(d.model.requests.length, 2);
  assert.deepEqual(r.failure, { stage: 'model', code: 'invalid_output' });
  assert.equal(r.dependencies.model, 'ok');
  assert.equal(r.usage.calls, 2);
});

test('a failed batch does not waste the others', async () => {
  const r = await review(smallLimits, deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': ungrounded } }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts']);
  assert.deepEqual(r.coverage.notReviewed, [{ path: 'src/b.ts', reason: 'batch_failed' }]);
  assert.ok(r.audit.some((e) => e.action === 'batch_failed' && e.subject === 'src/b.ts' && e.reason === 'invalid_output'));
  assert.equal(r.dependencies.model, 'ok');
});

test('every model call is logged with its effort and outcome', async () => {
  const d = deps({ files: [fileA], answers: [answerOnA] });
  await review(input, d);
  assert.deepEqual(d.logged.map((e) => [e.event, e.effort, e.code, e.files]), [['model_call', 'default', 'ok', 1]]);
  assert.equal((e0(d.logged).usage as Usage).calls, 1);
});
const e0 = (l: Array<Record<string, unknown>>): Record<string, unknown> => l[0]!;

test('a key out of credit fails the review and marks the model', async () => {
  const d = deps({ files: [fileA], answers: [new ProviderError('no_credit', 'c', 402, null)] });
  const r = await review(input, d);
  assert.deepEqual([r.status, r.failure, r.dependencies.model], ['failed', { stage: 'model', code: 'no_credit' }, 'error']);
  assert.equal(d.model.requests.length, 1);
});

test('auth fails the review even when another batch succeeded', async () => {
  const r = await review(smallLimits, deps({
    files: [fileA, fileB],
    answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': new ProviderError('auth', 'a', 401, null) },
  }));
  assert.deepEqual([r.status, r.failure], ['failed', { stage: 'model', code: 'auth' }]);
  assert.deepEqual(r.findings, []);
});

test('a source error is a failed result, not an exception', async () => {
  const secret = new Error('boom secret-detail');
  const d = deps({ files: [], listError: secret });
  const r = await review(input, d);
  assert.deepEqual([r.status, r.failure], ['failed', { stage: 'context', code: 'source_error' }]);
  assert.ok(!JSON.stringify(r).includes('secret-detail'));
  assert.deepEqual(d.logged, [{ event: 'internal_error', stage: 'context', name: 'Error' }]);
});

test('an error reading file content is a source error too', async () => {
  const d = deps({ files: [{ ...fileA, patch: null }] });
  d.source.getFileContent = () => Promise.reject(new Error('nope'));
  const r = await review(input, d);
  assert.deepEqual(r.failure, { stage: 'context', code: 'source_error' });
});

test('an unexpected error in the model phase is internal_error', async () => {
  const d = deps({ files: [fileA], answers: [] }); // the stub throws a plain Error
  const r = await review(input, d);
  assert.deepEqual([r.status, r.failure], ['failed', { stage: 'model', code: 'internal_error' }]);
  assert.deepEqual(d.logged.filter((e) => e.event === 'internal_error'), [{ event: 'internal_error', stage: 'model', name: 'Error' }]);
});

test('one marker token is used for the whole review', async () => {
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB } });
  await review(smallLimits, d);
  assert.equal(d.tokens, 1);
  const seen = d.model.requests.map((q) => q.messages[1]!.content);
  assert.equal(new Set(seen).size, 1);
  assert.ok(seen[0]!.includes('abcdef0123456789'));
});

test('requests carry the timeout and numbering of the whole review', async () => {
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB } });
  await review(smallLimits, d);
  assert.ok(d.model.requests.every((q) => q.timeoutMs === 30_000));
  const lasts = d.model.requests.map((q) => q.messages[2]!.content).sort();
  assert.ok(lasts.some((t) => t.includes('Batch 1 of 2') && t.includes('1 of 2')));
  assert.ok(lasts.some((t) => t.includes('Batch 2 of 2')));
});

test('usage sums every call, failed ones included', async () => {
  const r = await review(smallLimits, deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': ungrounded } }));
  assert.equal(r.usage.calls, 3);
  assert.equal(r.usage.inputTokens, 300);
});

test('the model's own retry shows in usage and audit', async () => {
  const d = deps({ files: [fileA], answers: [ungrounded, ungrounded] });
  const r = await review(input, d);
  assert.equal(r.usage.calls, 2);
  assert.ok(r.audit.some((e) => e.action === 'retry'));
});
