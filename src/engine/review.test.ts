import assert from 'node:assert/strict';
import test from 'node:test';
import { unitTokens } from './context/batches.ts';
import { buildFileContexts, hunksOf } from './context/build.ts';
import { ANCHOR_LEGEND } from './context/diff.ts';
import { ACCEPTANCE_HEADING, ACCEPTANCE_RULES, EXTENSION_LINE, extensionPart } from './context/extensions.ts';
import type { ExtensionContext } from './context/extensions.ts';
import { memoryParts } from './context/memory.ts';
import type { MemoryContext } from './context/memory.ts';
import { buildMessages, fixedTokens } from './context/prompt.ts';
import { FINAL_LINE } from './model/call.ts';
import { ProviderError } from './model/errors.ts';
import { NOT_RUN_CAP, NOT_RUN_CLOSED, TOOL_RULES, toolRoomTokens } from './model/tools.ts';
import { SUBMIT_REVIEW, submitReviewTool, submitReviewWithThreadsTool, submitToolFor } from './model/submit-review.ts';
import { NOTHING_READ } from './plan.ts';
import { chooseEffort, review } from './review.ts';
import { blocksOf, fileDiffHash } from './score/blocks.ts';
import { shownOf } from './score/shown.ts';
import type { BlockScore, ScoreEntry, ScoreHistory } from './score/types.ts';
import type {
  ChangedFile, ContextProvider, EarlierThread, McpAnswer, McpServer, McpSession, Memory, MemoryBlocks, MemoryLine, ModelClient, ModelRequest, ModelResponse, PullRequestInfo, RepoConfig,
  ReviewDeps, ReviewInput, ReviewResult, ScoreAnswer, ScoreRequest, Scorer, Severity, Source, ToolCall, ToolDefinition, Usage,
} from './types.ts';

const CONTRACT = 'You review pull requests.';
const repo: RepoConfig = { primaryBranches: ['main'], scoreThreshold: 70 };
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
  ...input, limits: { ...input.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest) + 420 },
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
  files: [],
};
const answerOnB = { overview: 'src/b.ts is fine.', findings: [], files: [] };
const ungrounded = { overview: 'A long article about city gardens.', findings: [], files: [] };

const usage = (): Usage => ({ calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 5, cost: 0.5 });
const respond = (answer: unknown): ModelResponse =>
  ({ toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify(answer), text: null, model: 'm', provider: null, usage: usage() });

// A step is the arguments of a submit_review answer, a ProviderError to throw, a response as it is (`Raw`), or a
// function of the request that gives one of those.
class Raw {
  readonly response: ModelResponse;
  constructor(response: ModelResponse) { this.response = response; }
}
type Step = unknown | ProviderError | Raw | ((request: ModelRequest) => unknown);
const resolveStep = (step: Step, request: ModelRequest): Step => (typeof step === 'function' ? resolveStep((step as (r: ModelRequest) => unknown)(request), request) : step);
function deps(spec: {
  files: ChangedFile[]; answers?: Step[]; answerFor?: Record<string, Step>; delayMs?: number; listError?: Error; scorer?: Scorer;
  contextProviders?: ContextProvider[]; toolChoice?: 'forced' | 'auto'; mcpServers?: McpServer[]; memory?: Memory;
}):
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
          // The message of the file sections, wherever it stands: a repository message of memory comes before it, a retry appends after it.
          const last = request.messages.find((m) => m.role === 'user' && m.content.includes(ANCHOR_LEGEND))!.content;
          const key = Object.keys(spec.answerFor).find((p) => last.includes(p));
          step = key === undefined ? undefined : spec.answerFor[key];
        } else {
          step = (spec.answers ?? [])[requests.length - 1];
        }
        step = resolveStep(step, request);
        if (step === undefined) throw new Error('stub model exhausted');
        if (step instanceof ProviderError) throw step;
        if (step instanceof Raw) return step.response;
        return respond(step);
      } finally {
        inFlight -= 1;
      }
    },
  };
  const source: Source = {
    listFiles: () => (spec.listError ? Promise.reject(spec.listError) : Promise.resolve(spec.files)),
    getFileContent: () => Promise.resolve(null),
    getDefaultBranchFile: () => Promise.resolve(null),
  };
  const d = {
    source, model, contract: CONTRACT, clock: () => new Date(0), logged, tokens: 0,
    token: () => { d.tokens += 1; return 'abcdef0123456789'; },
    log: (e: Record<string, unknown>) => { logged.push(e); },
    ...(spec.scorer === undefined ? {} : { scorer: spec.scorer }),
    ...(spec.contextProviders === undefined ? {} : { contextProviders: spec.contextProviders }),
    ...(spec.toolChoice === undefined ? {} : { toolChoice: spec.toolChoice }),
    ...(spec.mcpServers === undefined ? {} : { mcpServers: spec.mcpServers }),
    ...(spec.memory === undefined ? {} : { memory: spec.memory }),
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

test('a rename inside its directory is neither reviewed nor listed as not reviewed, and is audited', async () => {
  const rename: ChangedFile = { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0, patch: null };
  const d = deps({ files: [fileA, rename], answers: [answerOnA] });
  d.source.getFileContent = async (_p, path) => (path === 'src/old.ts' || path === 'src/new.ts' ? 'same\n' : null);
  const r = await review(input, d);
  assert.deepEqual(r.coverage, { reviewed: ['src/a.ts'], notReviewed: [] });
  assert.deepEqual(r.audit.filter((e) => e.subject === 'src/new.ts'), [{ stage: 'context', action: 'scored_by_rule', subject: 'src/new.ts', reason: 'rule_rename' }]);
});

test('characters stripped from the title and the description reach the audit', async () => {
  const pr = { ...input.pullRequest, title: 'Add\u200b things\u202e', description: 'Adds\u00ad things.' };
  const r = await review({ ...input, pullRequest: pr }, deps({ files: [fileA], answers: [answerOnA] }));
  assert.deepEqual(r.audit.filter((e) => e.subject === 'title' || e.subject === 'description'), [
    { stage: 'context', action: 'control_characters_stripped', subject: 'title', reason: '2' },
    { stage: 'context', action: 'control_characters_stripped', subject: 'description', reason: '1' },
  ]);
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
  const answerFor = Object.fromEntries(files.map((f) => [f.path, { overview: `${f.path} ok`, findings: [], files: [] }]));
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
  assert.deepEqual(d.logged.map((e) => [e.event, e.effort, e.code, e.files, e.model, e.provider]), [['model_call', 'default', 'ok', 1, 'm', null]]);
  assert.equal((e0(d.logged).usage as Usage).calls, 1);
});

test('the models and providers that answered reach the result and the log', async () => {
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB } });
  const complete = d.model.complete.bind(d.model);
  d.model.complete = async (request) => {
    const r = await complete(request);
    return request.messages[2]!.content.includes('src/a.ts')
      ? { ...r, model: 'vendor/a', provider: 'Up One' }
      : { ...r, model: 'vendor/b', provider: 'Up One' };
  };
  const r = await review(smallLimits, d);
  assert.deepEqual([r.models, r.providers], [['vendor/a', 'vendor/b'], ['Up One']]);
  assert.deepEqual(d.logged.map((e) => [e.model, e.provider]).sort(), [['vendor/a', 'Up One'], ['vendor/b', 'Up One']]);
});

test('a call that fails without an answer logs a null model and provider', async () => {
  const down = new ProviderError('provider', 'p', 502, null);
  const d = deps({ files: [fileA], answers: [down, down] });
  const r = await review(input, d);
  assert.deepEqual(d.logged.map((e) => [e.code, e.model, e.provider]), [['provider', null, null], ['provider', null, null]]);
  assert.deepEqual([r.models, r.providers], [[], []]);
});
const e0 = (l: Array<Record<string, unknown>>): Record<string, unknown> => l[0]!;

test('a key out of credit fails the review and marks the model', async () => {
  const d = deps({ files: [fileA], answers: [new ProviderError('no_credit', 'c', 402, null)] });
  const r = await review(input, d);
  assert.deepEqual([r.status, r.failure, r.dependencies.model], ['failed', { stage: 'model', code: 'no_credit' }, 'error']);
  assert.equal(d.model.requests.length, 1);
  assert.equal(r.verdict.needsHuman, true);
  assert.deepEqual(r.scores, []);
});

test('auth fails the review even when another batch succeeded', async () => {
  const r = await review(smallLimits, deps({
    files: [fileA, fileB],
    answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': new ProviderError('auth', 'a', 401, null) },
  }));
  assert.deepEqual([r.status, r.failure], ['failed', { stage: 'model', code: 'auth' }]);
  assert.deepEqual(r.findings, []);
  assert.equal(r.verdict.needsHuman, true);
  assert.deepEqual(r.scores, []);
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
  d.source.getFileContent = () => Promise.reject(new Error('Content read failed'));
  const r = await review(input, d);
  assert.deepEqual(r.failure, { stage: 'context', code: 'source_error' });
});

test('a source error whose message is a short code keeps that code', async () => {
  for (const code of ['github_401', 'too_many_files', 'github_network']) {
    const d = deps({ files: [], listError: new Error(code) });
    const r = await review(input, d);
    assert.deepEqual(r.failure, { stage: 'context', code });
    assert.deepEqual(d.logged, [{ event: 'internal_error', stage: 'context', name: 'Error' }]);
  }
  const d = deps({ files: [{ ...fileA, patch: null }] });
  d.source.getFileContent = () => Promise.reject(new Error('github_502'));
  assert.deepEqual((await review(input, d)).failure, { stage: 'context', code: 'github_502' });
});

test('a source error whose message is not a short code is source_error', async () => {
  for (const message of ['Github_401', 'github 401', `g${'x'.repeat(40)}`, '']) {
    const r = await review(input, deps({ files: [], listError: new Error(message) }));
    assert.deepEqual(r.failure, { stage: 'context', code: 'source_error' }, message);
  }
});

test('a failed probe for a paired test does not fail the review', async () => {
  const d = deps({ files: [fileA], answers: [answerOnA] });
  d.source.getFileContent = (_p, path) => (path === 'src/a.test.ts' ? Promise.reject(new Error('github_503')) : Promise.resolve(null));
  const r = await review(input, d);
  assert.equal(r.status, 'ok');
  assert.ok(r.audit.some((e) => e.action === 'test_probe_failed' && e.subject === 'src/a.test.ts' && e.reason === 'github_503'));
});

test('an answer is grounded only by the files of its own batch', async () => {
  const namesOther = { overview: 'The change in src/a.ts is fine.', findings: [], files: [] };
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': namesOther } });
  const r = await review(smallLimits, d);
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts']);
  assert.deepEqual(r.coverage.notReviewed, [{ path: 'src/b.ts', reason: 'batch_failed' }]);
  assert.ok(r.audit.some((e) => e.action === 'retry' && e.reason.startsWith('ungrounded')));
});

test('a finding on a file of another batch is dropped', async () => {
  const crossing = { overview: 'src/b.ts is fine.', findings: [{ ...answerOnA.findings[0]!, severity: 'blocker' }], files: [] };
  const r = await review(smallLimits, deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnB, 'src/b.ts': crossing } }));
  assert.deepEqual(r.findings, []);
  assert.ok(r.audit.some((e) => e.action === 'dropped' && e.subject === 'src/a.ts' && e.reason === 'path_not_in_batch'));
});

test('file numbers run across batches', async () => {
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB } });
  await review(smallLimits, d);
  const sections = d.model.requests.map((q) => q.messages[2]!.content);
  const first = sections.find((t) => t.includes('Batch 1 of 2'))!;
  const second = sections.find((t) => t.includes('Batch 2 of 2'))!;
  assert.ok(first.includes('## File 1/2: src/a.ts'));
  assert.ok(second.includes('## File 2/2: src/b.ts'));
  assert.ok(!first.includes('## File 2/2') && !second.includes('## File 1/2'));
});

test('an unexpected error in the model phase is internal_error', async () => {
  const d = deps({ files: [fileA], answers: [] }); // the stub throws a plain Error
  const r = await review(input, d);
  assert.deepEqual([r.status, r.failure], ['failed', { stage: 'model', code: 'internal_error' }]);
  assert.deepEqual(d.logged.filter((e) => e.event === 'internal_error'), [{ event: 'internal_error', stage: 'model', name: 'Error' }]);
  assert.equal(r.verdict.needsHuman, true);
  assert.deepEqual(r.scores, []);
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

test('a retry inside the model call shows in usage and audit', async () => {
  const d = deps({ files: [fileA], answers: [ungrounded, ungrounded] });
  const r = await review(input, d);
  assert.equal(r.usage.calls, 2);
  assert.ok(r.audit.some((e) => e.action === 'retry'));
});

const fourFiles = ['a', 'b', 'c', 'd'].map((n) => fileAt(`src/${n}.ts`));
const okFor = (f: ChangedFile): { overview: string; findings: never[]; files: never[] } => ({ overview: `${f.path} ok`, findings: [], files: [] });

test('an unexpected error stops the pool: nothing runs after review returns', async () => {
  const answerFor: Record<string, unknown> = Object.fromEntries(fourFiles.map((f) => [f.path, okFor(f)]));
  delete answerFor['src/a.ts']; // the stub throws a plain Error for this file
  const d = deps({ files: fourFiles, answerFor, delayMs: 10 });
  const r = await review(smallLimits, d);
  const requests = d.model.requests.length;
  const logs = d.logged.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual([d.model.requests.length, d.logged.length], [requests, logs]);
  assert.ok(requests <= 2);
  assert.deepEqual(r.failure, { stage: 'model', code: 'internal_error' });
  assert.equal(r.usage.calls, requests - 1); // the call that threw carries no usage; the in-flight one finished
});

test('a dead key stops new batches: at most the two in flight', async () => {
  const answerFor: Record<string, unknown> = Object.fromEntries(fourFiles.map((f) => [f.path, okFor(f)]));
  answerFor['src/a.ts'] = new ProviderError('no_credit', 'c', 402, null);
  const d = deps({ files: fourFiles, answerFor, delayMs: 10 });
  const r = await review(smallLimits, d);
  assert.ok(d.model.requests.length <= 2);
  assert.deepEqual(r.failure, { stage: 'model', code: 'no_credit' });
  assert.equal(r.usage.calls, d.model.requests.length - 1);
});

test('a logger that always throws changes nothing in the result', async () => {
  const answerFor = { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB };
  const normal = await review(smallLimits, deps({ files: [fileA, fileB], answerFor }));
  const broken = deps({ files: [fileA, fileB], answerFor });
  broken.log = () => { throw new Error('logger down'); };
  const r = await review(smallLimits, broken);
  assert.equal(r.usage.calls, 2);
  assert.deepEqual(r, normal);
});

// Scores and the verdict.
const scored = (path: string, score: number): unknown => ({
  overview: `${path} reviewed.`, findings: [],
  files: [{ path, change_summary: 'Changes the retry delay.', blocks: [{ id: 'B1', score, category: 'fix', reason: 'Changes the retry delay.' }] }],
});
const withRepoFile = (d: ReturnType<typeof deps>, text: string | Error): void => {
  d.source.getDefaultBranchFile = () => (text instanceof Error ? Promise.reject(text) : Promise.resolve(text));
};

test('a review returns scores and a verdict', async () => {
  const r = await review(input, deps({ files: [fileA], answers: [scored('src/a.ts', 45)] }));
  assert.equal(r.scores.length, 1);
  assert.deepEqual(r.verdict, { threshold: 70, needsHuman: false, highest: 45 });
});

test('the threshold comes from the repository config', async () => {
  const r = await review({ ...input, repoConfig: { ...repo, scoreThreshold: 40 } }, deps({ files: [fileA], answers: [scored('src/a.ts', 45)] }));
  assert.deepEqual(r.verdict, { threshold: 40, needsHuman: true, highest: 45 });
});

test('a model that returns no files sends the pull request to a person', async () => {
  const r = await review(input, deps({ files: [fileA], answers: [{ overview: 'src/a.ts is fine.', findings: [], files: [] }] }));
  assert.deepEqual(r.verdict, { threshold: 70, needsHuman: true, highest: 100 });
  assert.equal(r.scores[0]!.fileLevel?.source, 'not_scored');
});

test('a team floor is read from the default branch', async () => {
  const d = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(d, 'human_review:\n  - src/\n');
  const r = await review(input, d);
  assert.deepEqual(r.scores[0]!.fileLevel, { score: 100, source: 'team_floor' });
  assert.equal(r.verdict.needsHuman, true);
});

test('an unusable repository file floors every file', async () => {
  const d = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(d, '- a\n');
  const r = await review(input, d);
  assert.equal(r.scores[0]!.fileLevel?.source, 'team_file_invalid');
  assert.equal(r.verdict.needsHuman, true);
});

test('a failed read of the repository file fails the review at the context stage', async () => {
  const d = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(d, new Error('github_500'));
  const r = await review(input, d);
  assert.deepEqual([r.status, r.failure, r.scores], ['failed', { stage: 'context', code: 'github_500' }, []]);
  assert.deepEqual(r.verdict, { threshold: 70, needsHuman: true, highest: 100 });
  assert.equal(d.model.requests.length, 0);
});

test('the repository file is not read when there are no files', async () => {
  const d = deps({ files: [] });
  let reads = 0;
  d.source.getDefaultBranchFile = () => { reads += 1; return Promise.resolve(null); };
  await review(input, d);
  assert.equal(reads, 0);
});

test('a failed review needs a person', async () => {
  const down = new ProviderError('provider', 'p', 502, null);
  const r = await review({ ...input, repoConfig: { ...repo, scoreThreshold: 33 } }, deps({ files: [fileA], answers: [down, down] }));
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.scores, []);
  assert.deepEqual(r.verdict, { threshold: 33, needsHuman: true, highest: 100 });
});

test('a budget that is too small needs a person', async () => {
  const r = await review({ ...input, limits: { ...input.limits, inputTokensPerCall: 10 } }, deps({ files: [fileA] }));
  assert.deepEqual([r.scores, r.verdict], [[], { threshold: 70, needsHuman: true, highest: 100 }]);
});

test('no files: nothing to judge', async () => {
  const r = await review(input, deps({ files: [] }));
  assert.deepEqual([r.scores, r.verdict], [[], { threshold: 70, needsHuman: false, highest: 0 }]);
});

test('files but no batch: the scores come from rules, floors and not_scored', async () => {
  const r = await review(input, deps({ files: [binaryNoPatch] }));
  assert.equal(r.scores.length, 1);
  assert.equal(r.scores[0]!.path, 'logo.bin');
  assert.equal(r.scores[0]!.fileLevel?.source, 'not_scored');
  assert.equal(r.verdict.needsHuman, true);
});

test('files in a failed batch are not scored', async () => {
  const r = await review(smallLimits, deps({
    files: [fileA, fileB], answerFor: { 'src/a.ts': scored('src/a.ts', 10), 'src/b.ts': ungrounded },
  }));
  const byPath = new Map(r.scores.map((s) => [s.path, s]));
  assert.equal(byPath.get('src/b.ts')!.fileLevel?.source, 'not_scored');
  assert.equal(byPath.get('src/a.ts')!.fileLevel, null);
  assert.deepEqual(r.verdict, { threshold: 70, needsHuman: true, highest: 100 });
});

test('the score audit entries follow the findings audit entries', async () => {
  const bad = { overview: 'src/a.ts has a problem.', findings: [], files: [{ path: 'src/zzz.ts', change_summary: 'x', blocks: [] }] };
  const r = await review(input, deps({ files: [fileA], answers: [bad] }));
  assert.equal(r.audit.at(-1)!.action, 'score_path_not_in_pull_request');
});

test('a rename whose only change is a hidden character needs a person', async () => {
  const rename: ChangedFile = { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0, patch: null };
  const d = deps({ files: [rename], answers: [scored('src/new.ts', 5)] });
  const contents: Record<string, string> = { 'src/old.ts': 'const s = "ab";\n', 'src/new.ts': 'const s = "a\u200bb";\n' };
  d.source.getFileContent = (_pr, path) => Promise.resolve(contents[path] ?? null);
  const r = await review(input, d);
  assert.deepEqual(r.scores[0]!.fileLevel, { score: 100, source: 'hidden_characters' });
  assert.equal(r.scores[0]!.covered, false);
  assert.equal(r.verdict.needsHuman, true);
});

test('a service patch with a direction override on an added line needs a person', async () => {
  const f: ChangedFile = { path: 'src/a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+a\u202e' };
  const r = await review(input, deps({ files: [f], answers: [scored('src/a.ts', 5)] }));
  assert.deepEqual(r.scores[0]!.fileLevel, { score: 100, source: 'hidden_characters' });
  assert.equal(r.verdict.needsHuman, true);
});

test('a repository file that is not text floors every file', async () => {
  const d = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(d, 'human_review:\n  - docs/\n# \u0000\n');
  const r = await review(input, d);
  assert.deepEqual(r.scores[0]!.fileLevel, { score: 100, source: 'team_file_invalid' });
  assert.equal(r.verdict.needsHuman, true);
  assert.equal(r.teamFileInvalid, 'not_text');
});

test('the reason the repository file cannot be used reaches the result and the audit', async () => {
  const d = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(d, 'human_review:\n  - "./db/migrate/"\n');
  const r = await review(input, d);
  assert.equal(r.teamFileInvalid, 'bad_patterns');
  assert.ok(r.audit.some((e) => e.stage === 'context' && e.action === 'team_file_invalid' && e.subject === '.visto-ai.yml' && e.reason === 'bad_patterns'));
});

test('a usable repository file, a failed review and no files leave teamFileInvalid null', async () => {
  const ok = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(ok, 'human_review:\n  - docs/\n');
  assert.equal((await review(input, ok)).teamFileInvalid, null);
  const failed = deps({ files: [fileA], answers: [scored('src/a.ts', 10)] });
  withRepoFile(failed, '- a\n');
  assert.equal((await review({ ...input, limits: { ...input.limits, inputTokensPerCall: 10 } }, failed)).teamFileInvalid, null);
  assert.equal((await review(input, deps({ files: [] }))).teamFileInvalid, null);
});

// A second scorer.
const scorerUsage = (): Usage => ({ calls: 2, inputTokens: 40, outputTokens: 4, cachedTokens: 0, cost: 0.25 });
function scorerStub(reply: (request: ScoreRequest) => Partial<ScoreAnswer>): Scorer & { requests: ScoreRequest[] } {
  const requests: ScoreRequest[] = [];
  return {
    requests,
    score: (request) => {
      requests.push(request);
      return Promise.resolve({ blocks: {}, usage: scorerUsage(), failure: null, ...reply(request) });
    },
  };
}
const refunds = { score: 85, category: 'business_rule', reason: 'Changes who may refund.' };

test('with a scorer set, the scores are the scorer\'s and the summaries the review model\'s', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const r = await review(input, deps({ files: [fileA], answers: [scored('src/a.ts', 20)], scorer }));
  assert.equal(scorer.requests.length, 1);
  assert.deepEqual(r.scores[0]!.blocks.map((b) => b.entry), [refunds]);
  assert.deepEqual(r.verdict, { threshold: 70, needsHuman: true, highest: 85 });
  assert.equal(r.scores[0]!.changeSummary, 'Changes the retry delay.');
});

test('with a scorer set, a review answer that scores no block loses nothing', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const unscored = { ...answerOnA, files: [{ path: 'src/a.ts', change_summary: 'Changes the retry delay.', blocks: [] }] };
  const r = await review(input, deps({ files: [fileA], answers: [unscored], scorer }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.scores[0]!.blocks.map((b) => b.entry), [refunds]);
  assert.equal(r.scores[0]!.fileLevel, null);
  assert.equal(r.scores[0]!.covered, true);
  assert.equal(r.scores[0]!.changeSummary, 'Changes the retry delay.');
  assert.deepEqual(r.findings.map((f) => f.path), ['src/a.ts']);
  assert.deepEqual(r.audit, []);
});

test('a file the scorer fails on is not scored, and the review and its findings stand', async () => {
  const both = {
    ...answerOnA,
    files: ['src/a.ts', 'src/b.ts'].map((path) => ({ path, change_summary: 'x', blocks: [{ id: 'B1', score: 10, category: 'fix', reason: '' }] })),
  };
  const scorer = scorerStub((req) => (req.text.includes('src/b.ts') ? { failure: 'provider' } : { blocks: { B1: { ...refunds, score: 10 } } }));
  const r = await review(input, deps({ files: [fileA, fileB], answers: [both], scorer }));
  const byPath = new Map(r.scores.map((s) => [s.path, s]));
  assert.deepEqual(byPath.get('src/b.ts')!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(byPath.get('src/a.ts')!.fileLevel, null);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.findings.map((f) => f.path), ['src/a.ts']);
  assert.ok(r.audit.some((e) => e.stage === 'scorer' && e.action === 'file_failed' && e.subject === 'src/b.ts' && e.reason === 'provider'));
});

test('only files the review model read are sent to the scorer', async () => {
  const fileC = fileAt('src/c.ts');
  const asset: ChangedFile = { path: 'logo.png', previousPath: null, status: 'modified', additions: 0, deletions: 0, patch: null };
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const r = await review({ ...smallLimits, limits: { ...smallLimits.limits, batchesPerReview: 2 } }, deps({
    files: [fileA, fileB, fileC, asset], answerFor: { 'src/a.ts': scored('src/a.ts', 10), 'src/b.ts': ungrounded }, scorer,
  }));
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts']);
  assert.deepEqual(r.coverage.notReviewed.map((n) => n.reason).sort(), ['batch_failed', 'over_batch_limit']);
  assert.equal(scorer.requests.length, 1);
  assert.ok(scorer.requests[0]!.text.includes('## File 1/1: src/a.ts'));
  for (const path of ['src/b.ts', 'src/c.ts', 'logo.png']) assert.ok(!scorer.requests[0]!.text.includes(path));
});

test('the scorer\'s usage is added to the review\'s', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const r = await review(input, deps({ files: [fileA], answers: [scored('src/a.ts', 20)], scorer }));
  assert.equal(r.usage.calls, 1 + 2);
  assert.equal(r.usage.cost, 0.5 + 0.25);
});

test('nothing reviewable, or every batch failed: the scorer is never asked', async () => {
  const none = scorerStub(() => ({}));
  await review(input, deps({ files: [binaryNoPatch], scorer: none }));
  const down = new ProviderError('provider', 'p', 502, null);
  const failed = scorerStub(() => ({}));
  const r = await review(input, deps({ files: [fileA], answers: [down, down], scorer: failed }));
  assert.equal(r.status, 'failed');
  assert.deepEqual([none.requests.length, failed.requests.length], [0, 0]);
});

const movedAway: ChangedFile = { path: 'lib/x.ts', previousPath: 'src/x.ts', status: 'renamed', additions: 0, deletions: 0, patch: null };
const movedAndA = {
  overview: 'Moves lib/x.ts and changes src/a.ts.', findings: [],
  files: [
    { path: 'lib/x.ts', change_summary: 'Moves the file.', blocks: [], score: 35, category: 'rename', reason: 'Moves the file.' },
    { path: 'src/a.ts', change_summary: 'Changes the retry delay.', score: 95, category: 'fix', reason: 'Changes the retry delay.', blocks: [{ id: 'B1', score: 20, category: 'fix', reason: 'Changes the retry delay.' }] },
  ],
};

test('with a scorer set, a file moved to another directory keeps the review model\'s whole-file score', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const d = deps({ files: [fileA, movedAway], answers: [movedAndA], scorer });
  d.source.getFileContent = async (_p, path) => (path === 'src/x.ts' || path === 'lib/x.ts' ? 'same\n' : null);
  const r = await review(input, d);
  assert.equal(scorer.requests.length, 1);
  assert.ok(!scorer.requests[0]!.text.includes('lib/x.ts'));
  const byPath = new Map(r.scores.map((s) => [s.path, s]));
  assert.deepEqual(byPath.get('lib/x.ts')!.fileLevel, { score: 35, source: 'whole_file' });
  assert.deepEqual(byPath.get('src/a.ts')!.blocks.map((b) => b.entry), [refunds]);
  assert.ok(!r.audit.some((e) => e.action === 'score_path_not_in_batch'));
});

test('with a scorer set, a review-model whole-file score for a file with a diff is not used', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: { ...refunds, score: 15 } } }));
  const d = deps({ files: [fileA, movedAway], answers: [movedAndA], scorer });
  d.source.getFileContent = async (_p, path) => (path === 'src/x.ts' || path === 'lib/x.ts' ? 'same\n' : null);
  const r = await review(input, d);
  const a = r.scores.find((s) => s.path === 'src/a.ts')!;
  assert.equal(a.fileLevel, null);
  assert.equal(a.finalScore, 15);
});

test('the scorer is sent the file as the review model received it, with the full file cut', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const d = deps({ files: [fileA], answers: [scored('src/a.ts', 20)], scorer });
  const content = Array.from({ length: 60 }, (_, i) => `const line${i} = ${i * 104729};`).join('\n');
  d.source.getFileContent = async (_p, path) => (path === 'src/a.ts' ? content : null);
  const r = await review(smallLimits, d);
  assert.ok(r.audit.some((e) => e.action === 'full_file_cut' && e.subject === 'src/a.ts'));
  assert.equal(scorer.requests.length, 1);
  assert.ok(!scorer.requests[0]!.text.includes('### Full file'));
  assert.ok(!d.model.requests[0]!.messages[2]!.content.includes('### Full file'));
});

test('a later review shows the thread in the call that holds its file, and a first review is sent nothing new', async () => {
  const dueThread = {
    id: 'PRRT_1', commentId: 'C1', path: 'src/a.ts', side: 'RIGHT' as const, line: 2, severity: 'major' as const, quote: '', body: 'Wrong value.',
    openedAt: { head: 'abcdef0', diffHash: null }, resolved: false, settled: false, lastVerdict: null, replies: [],
  };
  const later = deps({ files: [fileA], answers: [answerOnA] });
  await review({ ...input, earlier: { head: 'abcdef0', threads: [dueThread] } }, later);
  const sent = later.model.requests[0]!;
  assert.ok(sent.messages[2]!.content.includes('### Thread T1'));
  assert.deepEqual(sent.tools, [submitReviewWithThreadsTool]);
  const first = deps({ files: [fileA], answers: [answerOnA] });
  await review(input, first);
  const away = deps({ files: [fileA], answers: [answerOnA] });
  const r = await review({ ...input, earlier: { head: 'abcdef0', threads: [{ ...dueThread, path: 'src/gone.ts' }] } }, away);
  assert.deepEqual(away.model.requests, first.model.requests);
  assert.deepEqual(first.model.requests[0]!.tools, [submitReviewTool]);
  assert.ok(r.audit.some((e) => e.action === 'thread_not_shown' && e.subject === 'T1' && e.reason === 'file_not_in_diff'));
});
test('a thread on a file that was not reviewed is named even when no call is made', async () => {
  const dueThread = {
    id: 'PRRT_1', commentId: 'C1', path: 'src/a.ts', side: 'RIGHT' as const, line: 2, severity: 'major' as const, quote: '', body: 'Wrong value.',
    openedAt: { head: 'abcdef0', diffHash: null }, resolved: false, settled: false, lastVerdict: null, replies: [],
  };
  const tiny: ReviewInput = {
    ...input, earlier: { head: 'abcdef0', threads: [dueThread] },
    limits: { ...input.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest, true) + 50 },
  };
  const d = deps({ files: [fileA] });
  const r = await review(tiny, d);
  assert.equal(d.model.requests.length, 0);
  assert.deepEqual(r.coverage.notReviewed, [{ path: 'src/a.ts', reason: 'too_large' }]);
  assert.ok(r.audit.some((e) => e.action === 'thread_not_shown' && e.subject === 'T1' && e.reason === 'file_not_reviewed'));
});

const earlierThread = (over: Partial<EarlierThread> = {}): EarlierThread => ({
  id: 'PRRT_1', commentId: 'C1', path: 'src/a.ts', side: 'RIGHT', line: 2, severity: 'major', quote: 'const a = 1;', body: 'Wrong value.',
  openedAt: { head: 'abcdef0', diffHash: null }, resolved: true, settled: false, lastVerdict: null, replies: [], ...over,
});
test('a later review keeps a verdict, drops a finding its thread already raised, and counts the threads that were due', async () => {
  const answer = {
    ...answerOnA,
    findings: [{ ...answerOnA.findings[0]!, quote: 'const a = 1;' }],
    thread_verdicts: [{ thread_id: 'T1', verdict: 'open' }],
  };
  const threads = [earlierThread(), earlierThread({ id: 'PRRT_2', commentId: 'C2', path: 'src/gone.ts' })];
  const r = await review({ ...input, earlier: { head: 'abcdef0', threads } }, deps({ files: [fileA], answers: [answer] }));
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.alreadyDiscussed, [
    { path: 'src/a.ts', side: 'RIGHT', line: 2, severity: 'major', body: 'Wrong value.', commentId: 'C1', resolved: true, settled: false },
  ]);
  assert.deepEqual(r.threadVerdicts, [{ threadId: 'PRRT_1', commentId: 'C1', verdict: 'open', reply: '', fileChanged: false, replies: 0 }]);
  assert.equal(r.threadsDue, 2);
  assert.ok(r.audit.some((e) => e.action === 'thread_not_shown' && e.subject === 'T2' && e.reason === 'file_not_in_diff'));
  assert.ok(r.audit.some((e) => e.stage === 'reconcile' && e.action === 'duplicate' && e.subject === 'src/a.ts:2' && e.reason === 'near_thread'));
});
test('a review that fails, and one with nothing to read, still say how many threads were due', async () => {
  const earlier = { head: 'abcdef0', threads: [earlierThread(), earlierThread({ id: 'PRRT_2', severity: 'minor' })] };
  const failed = await review({ ...input, earlier }, deps({ files: [fileA], answers: [new ProviderError('auth', 'a', null, null)] }));
  const empty = await review({ ...input, earlier }, deps({ files: [] }));
  const unreadable = await review({ ...input, earlier }, deps({ files: [binaryNoPatch] }));
  const tooSmall = await review({ ...input, earlier, limits: { ...input.limits, inputTokensPerCall: 1 } }, deps({ files: [fileA] }));
  const first = await review(input, deps({ files: [fileA], answers: [answerOnA] }));
  for (const [name, r, status] of [['failed', failed, 'failed'], ['empty', empty, 'ok'], ['unreadable', unreadable, 'ok'], ['too small', tooSmall, 'failed']] as const) {
    assert.deepEqual([r.status, r.threadsDue, r.threadVerdicts, r.alreadyDiscussed], [status, 1, [], []], name);
  }
  assert.deepEqual([first.threadsDue, first.threadVerdicts, first.alreadyDiscussed, first.findings.length], [0, [], [], 1]);
});
test('with two calls, each thread keeps the verdict of the call that showed it, and the other call\'s is dropped as not shown', async () => {
  const replied = [{ author: 'octo-dev', kind: 'person' as const, body: 'ok' }];
  const threads = [
    earlierThread({ resolved: false, quote: 'zzz', replies: replied }),
    earlierThread({ id: 'PRRT_2', commentId: 'C2', path: 'src/b.ts', resolved: false, quote: 'zzz', replies: replied }),
  ];
  const both = (from: string) => ({
    overview: `${from} reviewed.`, findings: [], files: [],
    thread_verdicts: [{ thread_id: 'T1', verdict: 'fixed', reply: `From the call of ${from}.` }, { thread_id: 'T2', verdict: 'answered', reply: `From the call of ${from}.` }],
  });
  const two: ReviewInput = {
    ...input, earlier: { head: 'abcdef0', threads },
    limits: { ...input.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest, true) + 900 },
  };
  const d = deps({ files: [fileA, fileB], answerFor: { ': src/a.ts\n': both('src/a.ts'), ': src/b.ts\n': both('src/b.ts') } });
  const r = await review(two, d);
  assert.deepEqual([r.status, d.model.requests.length], ['ok', 2]);
  assert.deepEqual(d.model.requests.map((q) => q.messages[2]!.content.match(/### Thread T\d/g)), [['### Thread T1'], ['### Thread T2']]);
  assert.deepEqual(r.threadVerdicts?.map((v) => [v.threadId, v.verdict, v.reply]), [['PRRT_1', 'fixed', 'From the call of src/a.ts.'], ['PRRT_2', 'answered', 'From the call of src/b.ts.']]);
  assert.deepEqual(r.audit.filter((e) => e.action === 'verdict_dropped').map((e) => [e.subject, e.reason]), [['T2', 'not_shown'], ['T1', 'not_shown']]);
});

// Scores that hold across reviews.
const twoHunkPatch = [
  '@@ -10,3 +10,3 @@', ' keep', '-const delay = 1;', '+const delay = 2;', ' keep',
  '@@ -50,3 +50,3 @@', ' keep', '-const tries = 1;', '+const tries = 3;', ' keep',
].join('\n');
const fileTwo: ChangedFile = { path: 'src/t.ts', previousPath: null, status: 'modified', additions: 2, deletions: 2, patch: twoHunkPatch };
const [hashB1, hashB2] = blocksOf(hunksOf(twoHunkPatch).hunks).map((b) => b.hash);
const [aroundB1, aroundB2] = blocksOf(hunksOf(twoHunkPatch).hunks).map((b) => b.around);
// A score stored for a block of fileTwo is stored among that block's lines.
const aroundOfHash = (hash: string): string | null => (hash === hashB1 ? aroundB1! : hash === hashB2 ? aroundB2! : null);
// `covered`: a published review read the file with the diff of fileTwo.
const historyOf = (blocks: Array<[string, number]>, covered = false): ScoreHistory => ({
  by: 'model', lastReview: null, shown: null,
  files: [{
    path: 'src/t.ts', blocks: blocks.map(([hash, score]) => ({ hash, arounds: aroundOfHash(hash) === null ? [] : [aroundOfHash(hash)!], entry: { score, category: 'fix', reason: '' }, raisedFrom: null })),
    splits: [], stoodFor: [], wholeFile: null, coveredAt: covered ? [fileDiffHash(hunksOf(twoHunkPatch).hunks)!] : [], readAt: null,
  }],
});
const answerOnT = { overview: 'src/t.ts reviewed.', findings: [], files: [] };
const headersOf = (d: ReturnType<typeof deps>): string[] => d.model.requests[0]!.messages[2]!.content.match(/### Block B\d \([^)]*\)/g) ?? [];

test('a later review asks the model only for the blocks that have no score', async () => {
  const d = deps({ files: [fileTwo], answers: [answerOnT] });
  const r = await review({ ...input, history: historyOf([[hashB1!, 40]]) }, d);
  assert.equal(r.status, 'ok');
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)', '### Block B2 (2 changed lines, not scored)']);
  assert.ok(d.model.requests[0]!.messages[2]!.content.includes('whole-file score: allowed'));
  // Every block scored and the file read as it is: the file is told it takes no whole-file score.
  const all = deps({ files: [fileTwo], answers: [answerOnT] });
  await review({ ...input, history: historyOf([[hashB1!, 40], [hashB2!, 10]], true) }, all);
  assert.deepEqual(headersOf(all), ['### Block B1 (2 changed lines, scored)', '### Block B2 (2 changed lines, scored)']);
  assert.ok(all.model.requests[0]!.messages[2]!.content.includes('whole-file score: not allowed. Every block of this file already has its score.'));
});

test('a later review asks the second scorer only for the blocks that have no score', async () => {
  const scorer = scorerStub(() => ({ blocks: { B2: refunds } }));
  const d = deps({ files: [fileTwo, fileA], answers: [answerOnT], scorer });
  await review({ ...input, history: { ...historyOf([[hashB1!, 40]]), by: 'scorer' } }, d);
  const byFile = scorer.requests.map((q) => [q.text.includes('src/t.ts') ? 'src/t.ts' : 'src/a.ts', q.blocks]);
  assert.deepEqual(byFile.sort(), [['src/a.ts', ['B1']], ['src/t.ts', ['B2']]]);
});

test('a failed lookup across pull requests is named in the audit and the review goes on', async () => {
  const d = deps({ files: [fileTwo], answers: [answerOnT] });
  const asked: Array<Array<{ path: string; hash: string; around: string }>> = [];
  d.reusableScores = (blocks) => { asked.push(blocks); return Promise.reject(new Error('db_down')); };
  const r = await review(input, d);
  assert.equal(r.status, 'ok');
  assert.deepEqual(asked, [[{ path: 'src/t.ts', hash: hashB1, around: aroundB1 }, { path: 'src/t.ts', hash: hashB2, around: aroundB2 }]]);
  assert.deepEqual(r.audit.filter((e) => e.action === 'reuse_failed'), [{ stage: 'context', action: 'reuse_failed', subject: 'scores', reason: 'db_down' }]);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, not scored)', '### Block B2 (2 changed lines, not scored)']);
  // An error without a short code is named internal_error.
  const odd = deps({ files: [fileTwo], answers: [answerOnT] });
  odd.reusableScores = () => Promise.reject(new Error('Connection refused at 10.0.0.1'));
  const again = await review(input, odd);
  assert.equal(again.status, 'ok');
  assert.deepEqual(again.audit.filter((e) => e.action === 'reuse_failed').map((e) => e.reason), ['internal_error']);
  // Nothing to look up: no call.
  const settled = deps({ files: [fileTwo], answers: [answerOnT] });
  let calls = 0;
  settled.reusableScores = () => { calls += 1; return Promise.resolve([]); };
  await review({ ...input, history: historyOf([[hashB1!, 40], [hashB2!, 10]]) }, settled);
  assert.equal(calls, 0);
});

test('an answer of the lookup for a block that was not asked, or with a score that is none, is not used', async () => {
  const fix = (score: number) => ({ score, category: 'fix' as const, reason: '' });
  const d = deps({ files: [fileTwo], answers: [answerOnT] });
  d.reusableScores = () => Promise.resolve([
    { path: 'src/t.ts', hash: hashB1!, around: aroundB1!, entry: fix(50.5) },
    { path: 'src/t.ts', hash: hashB1!, around: aroundB1!, entry: fix(101) },
    { path: 'src/t.ts', hash: hashB1!, around: aroundB1!, entry: fix(-1) },
    { path: 'src/other.ts', hash: hashB1!, around: aroundB1!, entry: fix(50) },
    { path: 'src/t.ts', hash: 'f'.repeat(64), around: aroundB1!, entry: fix(50) },
    { path: 'src/t.ts', hash: hashB2!, around: aroundB2!, entry: fix(20) },
  ]);
  const r = await review(input, d);
  assert.equal(r.status, 'ok');
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, not scored)', '### Block B2 (2 changed lines, scored)']);
});

test('with no history and no lookup the request is the one a first review sends today', async () => {
  const d = deps({ files: [fileTwo], answers: [answerOnT] });
  await review(input, d);
  const none = deps({ files: [fileTwo], answers: [answerOnT] });
  await review({ ...input, history: null }, none);
  assert.deepEqual(none.model.requests, d.model.requests);
  const built = await buildFileContexts(input.pullRequest, [fileTwo], d.source);
  assert.deepEqual(d.model.requests[0]!.messages, buildMessages({
    contract: CONTRACT, pr: input.pullRequest, fileCount: 1, firstFileNumber: 1,
    batch: { files: built.contexts, tokens: 0 }, batchIndex: 0, batchCount: 1, token: 'abcdef0123456789',
  }));
  assert.equal(built.contexts[0]!.kept, undefined);
  assert.deepEqual(d.model.requests[0]!.tools, [submitReviewTool]);
});

// The history earlier reviews' stored results leave, read as the shell reads them (oldest first): for each hash the highest
// entry, with every surroundings a block of it had an entry among; a hunk not below its own parts; each hunk the newest run cut
// wholly into scored parts, by the hunk's hash and surroundings, with their places.
// `covered`: the last of them was published, so each file it read is covered at the diff it had.
// `readAt`: the head of the published run that read each file the last of them read, with the hashes it had then.
// A block with no score of its own in a file a review left covered with a whole-file score is a stood-for pair, also when its hash has an entry.
function historyFrom(results: ReviewResult | ReviewResult[], extra: {
  covered?: boolean; lastReview?: ScoreHistory['lastReview']; shown?: string | null; readAt?: string;
} = {}): ScoreHistory {
  const runs = (Array.isArray(results) ? results : [results]).map((r) => JSON.parse(JSON.stringify(r)) as ReviewResult);
  const last = runs.at(-1)!;
  const read = new Set(extra.covered === true ? last.coverage.reviewed : []);
  const aroundOf = (one: BlockScore): string | null => (typeof one.around === 'string' && one.around !== '' ? one.around : null);
  const keyOf = (hash: string, around: string | null): string => `${hash}\n${around ?? ''}`;
  type Acc = {
    entries: Map<string, { entry: ScoreEntry; raisedFrom: number | null; run: number }>; arounds: Map<string, Set<string>>; partsOf: Map<string, Set<string>>;
    splits: Map<string, ScoreHistory['files'][number]['splits'][number]>; stood: Map<string, { hash: string; around: string | null }>;
    wholeFile: ScoreEntry | null; coveredAt: string[]; readAt: ScoreHistory['files'][number]['readAt'];
  };
  const accs = new Map<string, Acc>();
  for (const [n, run] of runs.entries()) {
    for (const f of run.scores) {
      let acc = accs.get(f.path);
      if (acc === undefined) {
        acc = { entries: new Map(), arounds: new Map(), partsOf: new Map(), splits: new Map(), stood: new Map(), wholeFile: null, coveredAt: [], readAt: null };
        accs.set(f.path, acc);
      }
      const hunks = new Map<string, BlockScore[]>();
      for (const one of f.blocks) {
        const key = keyOf(one.hunkHash, aroundOf(one));
        hunks.set(key, [...(hunks.get(key) ?? []), one]);
        if (one.entry === null) continue;
        const around = aroundOf(one);
        if (around !== null) acc.arounds.set(one.hash, (acc.arounds.get(one.hash) ?? new Set()).add(around));
        const known = acc.entries.get(one.hash);
        // On a tie an entry that was not raised wins over one that was; then the newer run.
        const raised = one.raisedFrom ?? null;
        const tie = known !== undefined && one.entry.score === known.entry.score
          && ((known.raisedFrom !== null && raised === null) || ((known.raisedFrom === null) === (raised === null) && n > known.run));
        if (known === undefined || one.entry.score > known.entry.score || tie) acc.entries.set(one.hash, { entry: one.entry, raisedFrom: raised, run: n });
        if (one.hunkHash !== one.hash) acc.partsOf.set(one.hunkHash, (acc.partsOf.get(one.hunkHash) ?? new Set()).add(one.hash));
      }
      for (const [key, parts] of hunks) {
        if (parts.every((p) => p.range !== undefined && p.entry !== null)) {
          acc.splits.set(key, { hunkHash: parts[0]!.hunkHash, around: aroundOf(parts[0]!), parts: parts.map((p) => ({ hash: p.hash, range: p.range! })) });
        }
      }
      if (f.covered && f.wholeFile !== null) for (const one of f.blocks) if (one.entry === null) acc.stood.set(keyOf(one.hash, aroundOf(one)), { hash: one.hash, around: aroundOf(one) });
      if (f.wholeFile !== null && (acc.wholeFile === null || f.wholeFile.score >= acc.wholeFile.score)) acc.wholeFile = f.wholeFile;
      if (run === last) {
        acc.coveredAt = read.has(f.path) && f.diffHash !== null ? [f.diffHash] : [];
        acc.readAt = extra.readAt !== undefined && last.coverage.reviewed.includes(f.path)
          ? { head: extra.readAt, hashes: [...new Set(f.blocks.flatMap((one) => [one.hash, one.hunkHash]))] }
          : null;
      }
    }
  }
  return {
    by: 'model', lastReview: extra.lastReview ?? null, shown: extra.shown ?? null,
    files: [...accs].map(([path, acc]) => {
      // A hunk does not stand below its own parts, by its hash; repeated until nothing is raised.
      for (let raised = true; raised;) {
        raised = false;
        for (const [hunkHash, parts] of acc.partsOf) {
          const whole = acc.entries.get(hunkHash);
          const highest = Math.max(...[...parts].map((p) => acc.entries.get(p)!.entry.score));
          if (whole !== undefined && whole.entry.score < highest) {
            const top = [...parts].map((p) => acc.entries.get(p)!).find((e) => e.entry.score === highest)!;
            acc.entries.set(hunkHash, { entry: top.entry, raisedFrom: null, run: top.run });
            raised = true;
          }
        }
      }
      return {
        path,
        blocks: [...acc.entries].map(([hash, k]) => ({ hash, arounds: [...(acc.arounds.get(hash) ?? [])], entry: k.entry, raisedFrom: k.raisedFrom })),
        splits: [...acc.splits.values()],
        stoodFor: [...acc.stood.values()],
        wholeFile: acc.wholeFile, coveredAt: acc.coveredAt, readAt: acc.readAt,
      };
    }),
  };
}
const withoutOrigin = (blocks: BlockScore[]) => blocks.map((one) => { const rest = { ...one }; delete rest.origin; return rest; });

test('a second review of an unchanged file gives it the same scores without asking for them', async () => {
  const scoredT = { ...answerOnT, files: [{ path: 'src/t.ts', change_summary: 'Changes the delay and the tries.', blocks: [
    { id: 'B1', score: 45, category: 'calculation', reason: 'Doubles the delay.' }, { id: 'B2', score: 10, category: 'fix', reason: '' },
  ] }] };
  const first = await review(input, deps({ files: [fileTwo], answers: [scoredT] }));
  const none = { ...answerOnT, files: [{ path: 'src/t.ts', change_summary: 'Changes the delay and the tries.', blocks: [] }] };
  const d = deps({ files: [fileTwo], answers: [none] });
  const second = await review({ ...input, history: historyFrom(first) }, d);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)', '### Block B2 (2 changed lines, scored)']);
  assert.deepEqual(second.scores[0]!.blocks.map((one) => one.origin), ['earlier_run', 'earlier_run']);
  assert.deepEqual(withoutOrigin(second.scores[0]!.blocks), first.scores[0]!.blocks);
  assert.deepEqual([second.scores[0]!.finalScore, second.scores[0]!.covered], [45, true]);
});

const delayPatch = (value: number) => ['@@ -10,3 +10,3 @@', ' keep', '-const delay = 1;', `+const delay = ${value};`, ' keep'].join('\n');
const delayFile = (value: number): ChangedFile => ({ path: 'src/t.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: delayPatch(value) });
const onT = (file: Record<string, unknown>) => ({ ...answerOnT, files: [{ path: 'src/t.ts', change_summary: 'Changes the delay.', blocks: [], ...file }] });

test('an edited block cannot buy a lower score, by a block score or by a whole-file score', async (t) => {
  const first = await review(input, deps({ files: [delayFile(2)], answers: [onT({ blocks: [{ id: 'B1', score: 80, category: 'calculation', reason: 'Changes the delay.' }] })] }));
  assert.equal(first.scores[0]!.finalScore, 80);
  await t.test('by a block score', async () => {
    const second = await review({ ...input, history: historyFrom(first) }, deps({
      files: [delayFile(5)], answers: [onT({ blocks: [{ id: 'B1', score: 20, category: 'fix', reason: 'Small change.' }] })],
    }));
    const [block] = second.scores[0]!.blocks;
    assert.deepEqual([block!.entry, block!.raisedFrom], [{ score: 80, category: 'fix', reason: 'Small change.' }, 20]);
    assert.equal(second.scores[0]!.finalScore, 80);
  });
  await t.test('by a whole-file score', async () => {
    const second = await review({ ...input, history: historyFrom(first) }, deps({
      files: [delayFile(5)], answers: [onT({ score: 20, category: 'fix', reason: 'Small change.' })],
    }));
    const [block] = second.scores[0]!.blocks;
    assert.deepEqual([block!.entry, block!.raisedFrom], [{ score: 80, category: 'fix', reason: 'Small change.' }, 20]);
    assert.equal(second.scores[0]!.finalScore, 80);
  });
});

test('a hunk split in a first review keeps its parts and their scores in the second', async () => {
  const fortyLines = ['@@ -0,0 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => `+const row${i} = ${i * 31};`)].join('\n');
  const added: ChangedFile = { path: 'src/t.ts', previousPath: null, status: 'added', additions: 40, deletions: 0, patch: fortyLines };
  const split = onT({ blocks: [{ id: 'B1', parts: [
    { first: 'R1', last: 'R20', score: 30, category: 'test' }, { first: 'R21', last: 'R40', score: 80, category: 'data_model', reason: 'Adds a table.' },
  ] }] });
  const first = await review(input, deps({ files: [added], answers: [split] }));
  assert.deepEqual(first.scores[0]!.blocks.map((one) => [one.id, one.range]), [['B1.1', [0, 19]], ['B1.2', [20, 39]]]);
  const d = deps({ files: [added], answers: [onT({})] });
  const second = await review({ ...input, history: historyFrom(first) }, d);
  assert.deepEqual(headersOf(d), ['### Block B1 (40 changed lines, scored)']);
  assert.deepEqual(second.scores[0]!.blocks.map((one) => [one.id, one.entry?.score, one.range, one.origin]), [
    ['B1.1', 30, [0, 19], 'earlier_run'], ['B1.2', 80, [20, 39], 'earlier_run'],
  ]);
  assert.deepEqual([second.scores[0]!.finalScore, second.scores[0]!.covered], [80, true]);
});

test('a file with an earlier thread and a history still shows its scored blocks', async () => {
  const d = deps({ files: [fileTwo], answers: [answerOnT] });
  const earlier = { head: 'abcdef0', threads: [earlierThread({ path: 'src/t.ts', line: 11, quote: 'const delay = 2;' })] };
  await review({ ...input, earlier, history: historyOf([[hashB1!, 40]]) }, d);
  assert.ok(d.model.requests[0]!.messages[2]!.content.includes('### Thread T1'));
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)', '### Block B2 (2 changed lines, not scored)']);
});

test('with a scorer set, each score the scorer gave says so', async () => {
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const r = await review(input, deps({ files: [fileA], answers: [scored('src/a.ts', 20)], scorer }));
  assert.deepEqual(r.scores[0]!.blocks.map((one) => one.by), ['scorer']);
  const plain = await review(input, deps({ files: [fileA], answers: [scored('src/a.ts', 20)] }));
  assert.equal('by' in plain.scores[0]!.blocks[0]!, false);
});

// Reading less.
const HEAD0 = 'c'.repeat(40);
const LAST = { head: HEAD0, overview: 'Changes the retry delay and the tries.' };
const LAST_LINE = 'The last review of this pull request summarized it as below. It describes an earlier state of the code and proves nothing about the code you are given.';
const valueFile = (path: string, value: number): ChangedFile => ({ path, previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: delayPatch(value) });
const fileT = valueFile('src/t.ts', 2);
const fileU = valueFile('src/u.ts', 2);
const blockAnswer = (scores: Record<string, number>) => ({
  overview: `${Object.keys(scores).join(' and ')} reviewed.`, findings: [],
  files: Object.entries(scores).map(([path, score]) => ({ path, change_summary: 'Changes the delay.', blocks: [{ id: 'B1', score, category: 'fix', reason: 'Changes the delay.' }] })),
});
const firstOf = (files: ChangedFile[], answer: unknown): Promise<ReviewResult> => review(input, deps({ files, answers: [answer] }));
const named = (d: ReturnType<typeof deps>, path: string): number => d.model.requests.filter((q) => q.messages[2]!.content.includes(path)).length;
const finals = (r: ReviewResult): Record<string, number> => Object.fromEntries(r.scores.map((one) => [one.path, one.finalScore]));
const notSent = (r: ReviewResult): string[][] => r.audit.filter((e) => e.action === 'not_sent').map((e) => [e.subject, e.reason]);
const asset: ChangedFile = { path: 'logo.png', previousPath: null, status: 'modified', additions: 0, deletions: 0, patch: null };

test('an incremental review sends only the file whose diff changed, and scores the other from what it keeps', async () => {
  const first = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  const d = deps({ files: [fileT, valueFile('src/u.ts', 5)], answers: [blockAnswer({ 'src/u.ts': 30 })] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.equal(r.status, 'ok');
  assert.equal(d.model.requests.length, 1);
  assert.deepEqual([named(d, 'src/u.ts'), named(d, 'src/t.ts')], [1, 0]);
  assert.deepEqual(finals(r), { 'src/t.ts': 40, 'src/u.ts': 30 });
  assert.deepEqual(r.scores.find((one) => one.path === 'src/t.ts')!.blocks.map((one) => [one.entry?.score, one.origin]), [[40, 'earlier_run']]);
  assert.deepEqual(notSent(r), [['src/t.ts', 'covered']]);
  assert.deepEqual(r.coverage, { reviewed: ['src/u.ts'], notReviewed: [] });
  assert.deepEqual([r.mode, r.since], ['incremental', HEAD0]);
  assert.ok(d.model.requests[0]!.messages[1]!.content.endsWith(
    `\n${LAST_LINE}\n<<<data abcdef0123456789 last review overview>>>\n${LAST.overview}\n<<<end abcdef0123456789>>>`,
  ));
});

test('a moved file an earlier review scored is not sent again and keeps its score, in an incremental review and in a full one', async (t) => {
  const movedAnswer = {
    overview: 'Moves lib/x.ts and changes src/a.ts.', findings: [],
    files: [
      { path: 'lib/x.ts', change_summary: 'Moves the file.', blocks: [], score: 35, category: 'rename', reason: 'Moves the file.' },
      { path: 'src/a.ts', change_summary: 'Changes the values.', blocks: [{ id: 'B1', score: 20, category: 'fix', reason: '' }] },
    ],
  };
  const withMoved = (d: ReturnType<typeof deps>): ReturnType<typeof deps> => {
    d.source.getFileContent = async (_p, path) => (path === 'src/x.ts' || path === 'lib/x.ts' ? 'same\n' : null);
    return d;
  };
  const first = await review(input, withMoved(deps({ files: [fileA, movedAway], answers: [movedAnswer] })));
  assert.deepEqual(first.scores.find((one) => one.path === 'lib/x.ts')!.fileLevel, { score: 35, source: 'whole_file' });
  const history = historyFrom(first, { covered: true, lastReview: LAST });
  await t.test('incremental', async () => {
    const d = withMoved(deps({ files: [fileA, movedAway] }));
    const r = await review({ ...input, mode: 'incremental', history }, d);
    assert.equal(d.model.requests.length, 0);
    assert.deepEqual(r.scores.find((one) => one.path === 'lib/x.ts')!.fileLevel, { score: 35, source: 'whole_file' });
    assert.deepEqual(notSent(r), [['src/a.ts', 'covered'], ['lib/x.ts', 'covered']]);
    assert.deepEqual(r.coverage, { reviewed: [], notReviewed: [] });
  });
  await t.test('full', async () => {
    const d = withMoved(deps({ files: [fileA, movedAway], answers: [answerOnA] }));
    const r = await review({ ...input, mode: 'full', history }, d);
    assert.equal(d.model.requests.length, 1);
    assert.deepEqual([named(d, 'src/a.ts'), named(d, 'lib/x.ts')], [1, 0]);
    assert.deepEqual(r.scores.find((one) => one.path === 'lib/x.ts')!.fileLevel, { score: 35, source: 'whole_file' });
    assert.deepEqual(notSent(r), [['lib/x.ts', 'covered']]);
    assert.deepEqual(r.coverage, { reviewed: ['src/a.ts'], notReviewed: [] });
  });
});

test('the sentence of a last review that read nothing is not passed on as its overview', async () => {
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  await review(input, plain);
  const d = deps({ files: [fileA], answers: [answerOnA] });
  await review({ ...input, mode: 'incremental', history: { by: 'model', lastReview: { head: HEAD0, overview: NOTHING_READ }, shown: null, files: [] } }, d);
  assert.equal(d.model.requests[0]!.messages[1]!.content, plain.model.requests[0]!.messages[1]!.content);
});

test('a last review whose overview is empty passes on no overview', async () => {
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  await review(input, plain);
  const d = deps({ files: [fileA], answers: [answerOnA] });
  await review({ ...input, mode: 'recheck', history: { by: 'model', lastReview: { head: HEAD0, overview: ' \n ' }, shown: null, files: [] } }, d);
  assert.equal(d.model.requests[0]!.messages[1]!.content, plain.model.requests[0]!.messages[1]!.content);
});

test('an overview made only of characters nobody can see is not shown', async () => {
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  await review(input, plain);
  const d = deps({ files: [fileA], answers: [answerOnA] });
  await review({ ...input, mode: 'incremental', history: { by: 'model', lastReview: { head: HEAD0, overview: '\u200b\u202e \u2066' }, shown: null, files: [] } }, d);
  assert.equal(d.model.requests[0]!.messages[1]!.content, plain.model.requests[0]!.messages[1]!.content);
});

test('the room the last review overview takes is counted, with threads and without', async (t) => {
  const overview = `Changes the retry delay. ${'Each try waits longer. '.repeat(40)}`;
  const history: ScoreHistory = { by: 'model', lastReview: { head: HEAD0, overview }, shown: null, files: [] };
  await t.test('without threads', async () => {
    const limits = { ...input.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest, false, overview) };
    const r = await review({ ...input, limits, mode: 'incremental', history }, deps({ files: [fileA], answers: [answerOnA] }));
    assert.deepEqual([r.status, r.failure], ['failed', { stage: 'context', code: 'budget_too_small' }]);
  });
  await t.test('with threads', async () => {
    const limits = { ...input.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest, true, overview) };
    const earlier = { head: HEAD0, threads: [earlierThread({ resolved: false })] };
    const r = await review({ ...input, limits, mode: 'incremental', history, earlier }, deps({ files: [fileA], answers: [answerOnA] }));
    assert.deepEqual([r.status, r.failure], ['failed', { stage: 'context', code: 'budget_too_small' }]);
  });
});

test('a full review shows no last review overview', async () => {
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  await review(input, plain);
  const d = deps({ files: [fileA], answers: [answerOnA] });
  await review({ ...input, mode: 'full', history: { by: 'model', lastReview: LAST, shown: null, files: [] } }, d);
  assert.deepEqual(d.model.requests, plain.model.requests);
});

const fortyAdded: ChangedFile = {
  path: 'src/t.ts', previousPath: null, status: 'added', additions: 40, deletions: 0,
  patch: ['@@ -0,0 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => `+const row${i} = ${i * 31};`)].join('\n'),
};
const splitInTwo = onT({ blocks: [{ id: 'B1', parts: [
  { first: 'R1', last: 'R20', score: 30, category: 'test' }, { first: 'R21', last: 'R40', score: 80, category: 'data_model', reason: 'Adds a table.' },
] }] });

test('a hunk split in the first review does not send its file again', async () => {
  const first = await firstOf([fortyAdded], splitInTwo);
  assert.deepEqual(first.scores[0]!.blocks.map((one) => [one.id, one.range]), [['B1.1', [0, 19]], ['B1.2', [20, 39]]]);
  const d = deps({ files: [fortyAdded, fileA], answers: [answerOnA] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.equal(d.model.requests.length, 1);
  assert.equal(named(d, 'src/t.ts'), 0);
  assert.deepEqual(r.scores.find((one) => one.path === 'src/t.ts')!.blocks.map((one) => [one.id, one.entry?.score]), [['B1.1', 30], ['B1.2', 80]]);
  assert.deepEqual(notSent(r), [['src/t.ts', 'covered']]);
});

test('a thread that is not due on a file left out is named in the audit and not shown', async () => {
  const first = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  const minor = earlierThread({ path: 'src/t.ts', line: 11, severity: 'minor', resolved: false });
  const d = deps({ files: [fileT, valueFile('src/u.ts', 5)], answers: [blockAnswer({ 'src/u.ts': 30 })] });
  const r = await review({
    ...input, mode: 'incremental', earlier: { head: HEAD0, threads: [minor] }, history: historyFrom(first, { covered: true, lastReview: LAST }),
  }, d);
  assert.equal(d.model.requests.length, 1);
  assert.deepEqual(d.model.requests[0]!.tools, [submitReviewTool]);
  assert.ok(!d.model.requests[0]!.messages[2]!.content.includes('### Thread'));
  assert.deepEqual(r.audit.filter((e) => e.action === 'thread_not_shown'), [{ stage: 'context', action: 'thread_not_shown', subject: 'T1', reason: 'file_covered' }]);
  assert.deepEqual([r.threadsDue, r.threadVerdicts], [0, []]);
});

test('a thread that is due keeps its covered file in an incremental review', async () => {
  const first = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  const due = earlierThread({ path: 'src/t.ts', line: 11, resolved: false });
  const d = deps({ files: [fileT, fileU], answers: [{ ...blockAnswer({ 'src/t.ts': 40 }), thread_verdicts: [{ thread_id: 'T1', verdict: 'open' }] }] });
  const r = await review({ ...input, mode: 'incremental', earlier: { head: HEAD0, threads: [due] }, history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.deepEqual([d.model.requests.length, named(d, 'src/t.ts'), named(d, 'src/u.ts')], [1, 1, 0]);
  assert.deepEqual(d.model.requests[0]!.tools, [submitReviewWithThreadsTool]);
  assert.deepEqual(notSent(r), [['src/u.ts', 'covered']]);
  assert.deepEqual(r.threadVerdicts?.map((v) => v.verdict), ['open']);
});

test('with nothing new the model is not called and the result says so', async () => {
  const first = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  const history = historyFrom(first, { covered: true, lastReview: LAST, shown: shownOf(first) });
  for (const mode of ['incremental', 'recheck'] as const) {
    const d = deps({ files: [fileT, fileU] });
    const r = await review({ ...input, mode, history }, d);
    assert.deepEqual([d.model.requests.length, r.nothingToDo, r.status, r.overview, r.mode, r.since], [0, true, 'ok', NOTHING_READ, mode, HEAD0], mode);
    assert.deepEqual(finals(r), { 'src/t.ts': 40, 'src/u.ts': 20 }, mode);
    assert.deepEqual(r.scores.map((one) => one.blocks.map((b) => b.origin)), [['earlier_run'], ['earlier_run']], mode);
    assert.deepEqual([r.findings, r.usage.calls, r.coverage], [[], 0, { reviewed: [], notReviewed: [] }], mode);
    assert.deepEqual(r.verdict, first.verdict, mode);
    assert.deepEqual(notSent(r), [['src/t.ts', 'covered'], ['src/u.ts', 'covered']], mode);
  }
});

test('a review that would say something the newest one does not is not nothing new', async (t) => {
  const first = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  const history = historyFrom(first, { covered: true, lastReview: LAST, shown: shownOf(first) });
  const quiet = (r: ReviewResult, d: ReturnType<typeof deps>): void => {
    assert.deepEqual([d.model.requests.length, r.status, r.overview, 'nothingToDo' in r], [0, 'ok', NOTHING_READ, false]);
  };
  await t.test('a new file with no diff', async () => {
    const d = deps({ files: [fileT, fileU, binaryNoPatch] });
    const r = await review({ ...input, mode: 'incremental', history }, d);
    quiet(r, d);
    assert.deepEqual(r.coverage.notReviewed, [{ path: 'logo.bin', reason: 'no_diff' }]);
    assert.equal(finals(r)['logo.bin'], 100);
  });
  await t.test('a due thread whose file left the diff', async () => {
    const d = deps({ files: [fileT, fileU] });
    const r = await review({ ...input, mode: 'incremental', earlier: { head: HEAD0, threads: [earlierThread({ path: 'src/gone.ts', resolved: false })] }, history }, d);
    quiet(r, d);
    assert.equal(r.threadsDue, 1);
  });
  await t.test('a flagged block put back into a covered file', async () => {
    const flagged = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 80, 'src/u.ts': 20 }));
    // The newest review was of a head where src/t.ts had left the diff: it did not list the block.
    const newest = await review({ ...input, mode: 'incremental', history: historyFrom(flagged, { covered: true, lastReview: LAST }) }, deps({ files: [fileU] }));
    assert.deepEqual(finals(newest), { 'src/u.ts': 20 });
    const d = deps({ files: [fileT, fileU] });
    const r = await review({ ...input, mode: 'incremental', history: historyFrom(flagged, { covered: true, lastReview: LAST, shown: shownOf(newest) }) }, d);
    quiet(r, d);
    assert.deepEqual(finals(r), { 'src/t.ts': 80, 'src/u.ts': 20 });
    assert.equal(r.verdict.needsHuman, true);
  });
  await t.test('a new file scored by a fixed rule', async () => {
    const d = deps({ files: [fileT, fileU, asset] });
    const r = await review({ ...input, mode: 'incremental', history }, d);
    quiet(r, d);
    assert.equal(finals(r)['logo.png'], 10);
  });
  await t.test('a history that does not say what the newest review showed', async () => {
    const d = deps({ files: [fileT, fileU] });
    const r = await review({ ...input, mode: 'incremental', history: { ...history, shown: null } }, d);
    quiet(r, d);
  });
});

test('a pull request with a file nobody can read still ends as nothing new when nothing else changed', async () => {
  const first = await firstOf([fileT, fileU, binaryNoPatch], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  assert.deepEqual(first.coverage.notReviewed, [{ path: 'logo.bin', reason: 'no_diff' }]);
  const d = deps({ files: [fileT, fileU, binaryNoPatch] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST, shown: shownOf(first) }) }, d);
  assert.deepEqual([d.model.requests.length, r.nothingToDo, r.coverage.notReviewed], [0, true, [{ path: 'logo.bin', reason: 'no_diff' }]]);
});

test('a file with a stripped character on a changed line is read once, then left out, and still counts as 100', async () => {
  const hiddenFile: ChangedFile = { path: 'src/h.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+a\u202e' };
  const first = await firstOf([hiddenFile], blockAnswer({ 'src/h.ts': 5 }));
  assert.deepEqual([first.coverage.reviewed, first.scores[0]!.covered, first.scores[0]!.finalScore], [['src/h.ts'], false, 100]);
  const d = deps({ files: [hiddenFile, fileA], answers: [answerOnA] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.equal(d.model.requests.length, 1);
  assert.equal(named(d, 'src/h.ts'), 0);
  assert.deepEqual(notSent(r), [['src/h.ts', 'covered']]);
  assert.deepEqual(r.scores.find((one) => one.path === 'src/h.ts')!.fileLevel, { score: 100, source: 'hidden_characters' });
  assert.equal(finals(r)['src/h.ts'], 100);
});

test('a covered file that finds no room is scored from what it keeps and not listed as not reviewed', async (t) => {
  const [fa, fb, fc, fd, fe] = ['a', 'b', 'c', 'd', 'e'].map((n) => fileAt(`src/${n}.ts`)) as [ChangedFile, ChangedFile, ChangedFile, ChangedFile, ChangedFile];
  const first = await firstOf([fc, fd], blockAnswer({ 'src/c.ts': 30, 'src/d.ts': 40 }));
  const history = historyFrom(first, { covered: true, lastReview: LAST });
  const built = await buildFileContexts(input.pullRequest, [fa], deps({ files: [] }).source);
  const unit = unitTokens(built.contexts[0]!);
  const roomForTwo: ReviewInput = {
    ...input, mode: 'full', history,
    limits: { ...input.limits, batchesPerReview: 1, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest) + 2 * unit + Math.floor(unit / 2) },
  };
  await t.test('the covered files keep their scores and are not listed', async () => {
    const d = deps({ files: [fc, fd, fa, fb], answers: [blockAnswer({ 'src/a.ts': 10, 'src/b.ts': 15 })] });
    const r = await review(roomForTwo, d);
    assert.equal(d.model.requests.length, 1);
    assert.deepEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'].map((p) => named(d, p)), [1, 1, 0, 0]);
    assert.deepEqual(r.coverage, { reviewed: ['src/a.ts', 'src/b.ts'], notReviewed: [] });
    assert.deepEqual(notSent(r), [['src/c.ts', 'covered'], ['src/d.ts', 'covered']]);
    assert.deepEqual(finals(r), { 'src/a.ts': 10, 'src/b.ts': 15, 'src/c.ts': 30, 'src/d.ts': 40 });
  });
  await t.test('an uncovered file that finds no room is still listed and counts as 100', async () => {
    const d = deps({ files: [fc, fd, fa, fb, fe], answers: [blockAnswer({ 'src/a.ts': 10, 'src/b.ts': 15 })] });
    const r = await review(roomForTwo, d);
    assert.deepEqual(r.coverage.notReviewed, [{ path: 'src/e.ts', reason: 'over_batch_limit' }]);
    assert.equal(finals(r)['src/e.ts'], 100);
    assert.deepEqual(notSent(r), [['src/c.ts', 'covered'], ['src/d.ts', 'covered']]);
  });
  await t.test('a thread on a covered file that finds no room is named as on a covered file and gets no verdict', async () => {
    const minor = earlierThread({ path: 'src/c.ts', severity: 'minor', resolved: false });
    const withThread: ReviewInput = {
      ...roomForTwo, earlier: { head: HEAD0, threads: [minor] },
      limits: { ...roomForTwo.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest, true) + 2 * unit + Math.floor(unit / 2) },
    };
    const d = deps({ files: [fc, fd, fa, fb], answers: [{ ...blockAnswer({ 'src/a.ts': 10, 'src/b.ts': 15 }), thread_verdicts: [{ thread_id: 'T1', verdict: 'open' }] }] });
    const r = await review(withThread, d);
    assert.deepEqual([d.model.requests.length, named(d, 'src/c.ts'), r.coverage.notReviewed], [1, 0, []]);
    assert.deepEqual(r.audit.filter((e) => e.action === 'thread_not_shown'), [{ stage: 'context', action: 'thread_not_shown', subject: 'T1', reason: 'file_covered' }]);
    assert.deepEqual(r.threadVerdicts, []);
    // The thread left the list of those shown: a verdict for it is for a thread the run does not know.
    assert.deepEqual(r.audit.filter((e) => e.action === 'verdict_dropped').map((e) => [e.subject, e.reason]), [['T1', 'unknown_thread']]);
  });
});

test('a failed review says the mode it was given', async () => {
  const history: ScoreHistory = { by: 'model', lastReview: LAST, shown: null, files: [] };
  const r = await review({ ...input, mode: 'incremental', history }, deps({ files: [], listError: new Error('github_502') }));
  assert.deepEqual([r.status, r.failure, r.mode, r.since], ['failed', { stage: 'context', code: 'github_502' }, 'incremental', HEAD0]);
});

test('every result a review ends with early says the mode and the head it was given', async () => {
  const at: ReviewInput = { ...input, mode: 'recheck', history: { by: 'model', lastReview: LAST, shown: null, files: [] } };
  const down = new ProviderError('provider', 'p', 502, null);
  const empty = await review(at, deps({ files: [] }));
  const tooSmall = await review({ ...at, limits: { ...at.limits, inputTokensPerCall: 10 } }, deps({ files: [fileA] }));
  const failed = await review(at, deps({ files: [fileA], answers: [down, down] }));
  const thrown = await review(at, deps({ files: [fileA], answers: [] }));
  for (const [name, r, overview] of [['empty', empty, 'No changes to review.'], ['too small', tooSmall, ''], ['failed', failed, ''], ['thrown', thrown, '']] as const) {
    assert.deepEqual([r.overview, r.mode, r.since], [overview, 'recheck', HEAD0], name);
  }
  // With no last review there is nothing it is measured from.
  const noLast = await review({ ...at, history: null }, deps({ files: [] }));
  assert.deepEqual([noLast.mode, 'since' in noLast], ['recheck', false]);
});

test('a full review of a later head reads every file, the uncovered ones first', async () => {
  const first = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  // The new file is as large as the others and its path sorts last: only the rule puts it first.
  const d = deps({ files: [fileT, fileU, valueFile('src/z.ts', 2)], answers: [blockAnswer({ 'src/z.ts': 10 })] });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.equal(d.model.requests.length, 1);
  const sent = d.model.requests[0]!.messages[2]!.content;
  const order = ['## File 1/3: src/z.ts', '## File 2/3: src/t.ts', '## File 3/3: src/u.ts'].map((h) => sent.indexOf(h));
  assert.ok(order.every((n) => n >= 0));
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  assert.deepEqual(r.coverage.reviewed, ['src/z.ts', 'src/t.ts', 'src/u.ts']);
  assert.deepEqual([r.mode, 'since' in r, 'nothingToDo' in r], ['full', false, false]);
  assert.ok(!d.model.requests[0]!.messages[1]!.content.includes(LAST_LINE));
});

test('a review with no mode is a full review', async () => {
  const r = await review({ ...input, history: { by: 'model', lastReview: LAST, shown: null, files: [] } }, deps({ files: [fileA], answers: [answerOnA] }));
  assert.deepEqual([r.mode, 'since' in r, 'nothingToDo' in r], ['full', false, false]);
});

// Lines changed since a file was last read.
const NOW = input.pullRequest.headSha;
const CHANGED_LINE = 'lines changed since this file was last reviewed: ';
const sixLines = (delay: number, top = ''): string => `${top}l1\nconst a = 1;\nl3\nconst delay = ${delay};\nl5\nl6\n`;
const sixPatch = (delay: number, start = 1): string =>
  [`@@ -${start},6 +${start},6 @@`, ' l1', '-const a = 0;', '+const a = 1;', ' l3', ` const delay = ${delay};`, ' l5', ' l6'].join('\n');
const sixFile = (delay: number, extra: Partial<ChangedFile> = {}): ChangedFile =>
  ({ path: 'src/t.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: sixPatch(delay), ...extra });
const onLines = (...found: Array<[Severity, number]>) => ({
  overview: 'src/t.ts reviewed.', files: [],
  findings: found.map(([severity, line]) => ({ path: 'src/t.ts', side: 'RIGHT', line, severity, body: `Look at line ${line}.`, quote: '', beyond_diff: false })),
});
// The file's content at each `<sha>:<path>`; every read is recorded, and a value that is an Error is a rejection.
function contents(d: ReturnType<typeof deps>, at: Record<string, string | Error>): string[] {
  const asked: string[] = [];
  d.source.getFileContent = async (_p, path, sha) => {
    asked.push(`${sha}:${path}`);
    const value = at[`${sha}:${path}`];
    if (value instanceof Error) throw value;
    return value ?? null;
  };
  return asked;
}
const sentText = (d: ReturnType<typeof deps>): string => d.model.requests[0]!.messages[2]!.content;
const linesOf = (findings: Array<{ severity: Severity; line: number }> | undefined) => (findings ?? []).map((f) => [f.severity, f.line]);

test('an incremental review tells the model which lines changed, lists a major on an unchanged line and keeps one on a changed line', async (t) => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['major', 4], ['major', 2])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2), [`${NOW}:src/t.ts`]: sixLines(5) });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  await t.test('the header names the changed line', () => {
    assert.ok(sentText(d).includes(`\nwhole-file score: allowed\n${CHANGED_LINE}R4\n`));
  });
  await t.test('the major on the changed line is a finding', () => {
    assert.deepEqual(linesOf(r.findings), [['major', 4]]);
  });
  await t.test('the major on the unchanged line is listed', () => {
    assert.deepEqual(linesOf(r.unchanged), [['major', 2]]);
  });
});

test('a re-check treats every line of a file read at this head as unchanged', async (t) => {
  const first = await firstOf([sixFile(5)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['major', 4], ['blocker', 2])] });
  const r = await review({ ...input, mode: 'recheck', history: historyFrom(first, { lastReview: LAST, readAt: NOW }) }, d);
  await t.test('the header says none', () => {
    assert.ok(sentText(d).includes(`\n${CHANGED_LINE}none\n`));
  });
  await t.test('a major goes to unchanged', () => {
    assert.deepEqual(linesOf(r.unchanged), [['major', 4]]);
  });
  await t.test('a blocker stays', () => {
    assert.deepEqual(linesOf(r.findings), [['blocker', 2]]);
  });
});

test('a re-check of a file the last review listed as not reviewed measures from the review that did read it', async (t) => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['major', 4])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2), [`${NOW}:src/t.ts`]: sixLines(5) });
  const history = historyFrom(first, { lastReview: { head: NOW, overview: LAST.overview }, readAt: HEAD0 });
  const r = await review({ ...input, mode: 'recheck', history }, d);
  await t.test('the file is sent', () => {
    assert.equal(named(d, 'src/t.ts'), 1);
  });
  await t.test('the header says R4', () => {
    assert.ok(sentText(d).includes(`\n${CHANGED_LINE}R4\n`));
  });
  await t.test('the major on line 4 is a finding, not listed as unchanged', () => {
    assert.deepEqual([linesOf(r.findings), linesOf(r.unchanged)], [[['major', 4]], []]);
  });
});

test('a file no published review has read is changed throughout', async (t) => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['minor', 2])] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST }) }, d);
  await t.test('the header says all', () => {
    assert.ok(sentText(d).includes(`\n${CHANGED_LINE}all\n`));
  });
  await t.test('a minor on it is kept', () => {
    assert.deepEqual(linesOf(r.findings), [['minor', 2]]);
  });
});

test('the same block at other line numbers is not changed', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const top = Array.from({ length: 10 }, (_, i) => `top ${i}\n`).join('');
  const d = deps({ files: [sixFile(2, { patch: sixPatch(2, 11) })], answers: [onLines()] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2), [`${NOW}:src/t.ts`]: sixLines(2, top) });
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.ok(sentText(d).includes(`\n${CHANGED_LINE}R1-R10\n`));
});

test('a file that cannot be read at the earlier head counts as changed throughout', async (t) => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5, { status: 'renamed', previousPath: 'src/old.ts' })], answers: [onLines()] });
  const asked = contents(d, { [`${NOW}:src/t.ts`]: sixLines(5) });
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  await t.test('it is looked for at its path and at its previous path', () => {
    assert.deepEqual(asked.filter((key) => key.startsWith(HEAD0)), [`${HEAD0}:src/t.ts`, `${HEAD0}:src/old.ts`]);
  });
  await t.test('the header says all', () => {
    assert.ok(sentText(d).includes(`\n${CHANGED_LINE}all\n`));
  });
});

test('a removed file read before has no changed line but the removed lines of a new hunk', async (t) => {
  const gone = (patch: string[]): ChangedFile => ({ path: 'src/gone.ts', previousPath: null, status: 'removed', additions: 0, deletions: 4, patch: patch.join('\n') });
  const hunkOne = ['@@ -1,2 +0,0 @@', '-const a = 1;', '-const b = 2;'];
  const answer = { overview: 'src/gone.ts is removed.', findings: [], files: [] };
  const first = await firstOf([gone(hunkOne)], answer);
  const d = deps({ files: [gone([...hunkOne, '@@ -10,2 +0,0 @@', '-const c = 3;', '-const d = 4;'])], answers: [answer] });
  const asked = contents(d, {});
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  await t.test('no content is read for it', () => {
    assert.deepEqual(asked.filter((key) => key.endsWith(':src/gone.ts')), []);
  });
  await t.test('the header names the removed lines of the new hunk', () => {
    assert.ok(sentText(d).includes(`\n${CHANGED_LINE}removed lines of B2\n`));
  });
});

test('a failed read of the earlier content fails an incremental review before any model call', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines()] });
  contents(d, { [`${HEAD0}:src/t.ts`]: new Error('github_502'), [`${NOW}:src/t.ts`]: sixLines(5) });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.deepEqual([r.status, r.failure, r.usage.calls, d.model.requests.length], ['failed', { stage: 'context', code: 'github_502' }, 0, 0]);
});

test('a full review of a later head counts its blocking findings on unchanged lines and changes nothing else', async (t) => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['blocker', 2], ['major', 4], ['minor', 3])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2), [`${NOW}:src/t.ts`]: sixLines(5) });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  await t.test('the count is the blocker on an unchanged line', () => {
    assert.equal(r.blockingOnUnchanged, 1);
  });
  await t.test('the findings are as returned', () => {
    assert.deepEqual([linesOf(r.findings), 'unchanged' in r], [[['blocker', 2], ['major', 4], ['minor', 3]], false]);
  });
  await t.test('no header line', () => {
    assert.ok(!sentText(d).includes(CHANGED_LINE));
  });
});

test('a failed read while counting leaves the count out and the review whole', async (t) => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['blocker', 2])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: new Error('github_502'), [`${NOW}:src/t.ts`]: sixLines(5) });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  await t.test('the review is ok and keeps its findings', () => {
    assert.deepEqual([r.status, linesOf(r.findings)], ['ok', [['blocker', 2]]]);
  });
  await t.test('the count is absent', () => {
    assert.equal('blockingOnUnchanged' in r, false);
  });
  await t.test('the audit names the failed count', () => {
    assert.deepEqual(r.audit.filter((e) => e.action === 'unchanged_count_failed'),
      [{ stage: 'reconcile', action: 'unchanged_count_failed', subject: 'src/t.ts', reason: 'github_502' }]);
  });
});

test('a first review has no such count', async () => {
  const r = await review(input, deps({ files: [sixFile(5)], answers: [onLines(['blocker', 2])] }));
  assert.deepEqual([r.status, 'blockingOnUnchanged' in r], ['ok', false]);
});

test('a new hunk that only adds lines is not named for its removed lines, and a new hunk with a removed line is', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const patch = ['@@ -1,2 +1,3 @@', ' a1', '+new2', ' a3', '@@ -8,3 +9,3 @@', ' b9', '-old', '+b10', ' b11'].join('\n');
  const d = deps({ files: [sixFile(2, { patch, additions: 2 })], answers: [onLines()] });
  contents(d, {
    [`${HEAD0}:src/t.ts`]: 'a1\na3\nl4\nl5\nl6\nl7\nl8\nb9\nold\nb11\n',
    [`${NOW}:src/t.ts`]: 'a1\nnew2\na3\nl4\nl5\nl6\nl7\nl8\nb9\nb10\nb11\n',
  });
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.ok(sentText(d).includes(`\n${CHANGED_LINE}R2, R10; removed lines of B2\n`));
});

test('a major the model raised on a changed line outside the diff is not hidden when it is placed on a neighbouring line', async (t) => {
  const first = await firstOf([sixFile(5)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['major', 9])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: `${sixLines(5)}l7\nl8\nprChanged9\n`, [`${NOW}:src/t.ts`]: `${sixLines(5)}l7\nl8\nbase9\n` });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  await t.test('the header says R9', () => {
    assert.ok(sentText(d).includes(`\n${CHANGED_LINE}R9\n`));
  });
  await t.test('the major is a finding, placed on 6', () => {
    assert.deepEqual([r.findings.map((f) => [f.severity, f.line, f.requestedLine]), linesOf(r.unchanged)], [[['major', 6, 9]], []]);
  });
});

test('in a full review a major placed on an unchanged line is not counted when the line the model named changed', async () => {
  const first = await firstOf([sixFile(5)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['major', 9])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: `${sixLines(5)}l7\nl8\nprChanged9\n`, [`${NOW}:src/t.ts`]: `${sixLines(5)}l7\nl8\nbase9\n` });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.deepEqual(r.findings.map((f) => [f.severity, f.line, f.requestedLine]), [['major', 6, 9]]);
  assert.equal(r.blockingOnUnchanged, 0);
});

test('a file whose present content cannot be read counts as changed throughout', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines()] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2) });
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.ok(sentText(d).includes(`\n${CHANGED_LINE}all\n`));
});

test('two contents too different to compare count as changed throughout', async () => {
  const many = (count: number, prefix: string): string => Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n') + '\n';
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines()] });
  contents(d, { [`${HEAD0}:src/t.ts`]: many(6000, 'old'), [`${NOW}:src/t.ts`]: many(6000, 'new') });
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.ok(sentText(d).includes(`\n${CHANGED_LINE}all\n`));
});

test('line endings are made alike before the two contents are compared', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines()] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2).replaceAll('\n', '\r\n'), [`${NOW}:src/t.ts`]: sixLines(5) });
  await review({ ...input, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.ok(sentText(d).includes(`\n${CHANGED_LINE}R4\n`));
});

test('the packer counts the line of what changed', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const at = { [`${HEAD0}:src/t.ts`]: sixLines(2), [`${NOW}:src/t.ts`]: sixLines(5) };
  const probe = deps({ files: [sixFile(5)] });
  contents(probe, at);
  const [without] = (await buildFileContexts(input.pullRequest, [sixFile(5)], probe.source)).contexts;
  // Room for the file as it is without the line, and not with it: the packer must cut the full file to make room.
  const limits = { ...input.limits, inputTokensPerCall: fixedTokens(CONTRACT, input.pullRequest, false, LAST.overview) + unitTokens(without!) };
  const d = deps({ files: [sixFile(5)], answers: [onLines()] });
  contents(d, at);
  const r = await review({ ...input, limits, mode: 'incremental', history: historyFrom(first, { lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.ok(without!.full !== null);
  assert.deepEqual(r.audit.filter((e) => e.action === 'full_file_cut').map((e) => e.subject), ['src/t.ts']);
});

test('a full review with a history and no last review has no count', async () => {
  const first = await firstOf([sixFile(2)], onLines());
  const d = deps({ files: [sixFile(5)], answers: [onLines(['blocker', 2])] });
  contents(d, { [`${HEAD0}:src/t.ts`]: sixLines(2), [`${NOW}:src/t.ts`]: sixLines(5) });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { readAt: HEAD0 }) }, d);
  assert.deepEqual([r.status, linesOf(r.findings), 'blockingOnUnchanged' in r], ['ok', [['blocker', 2]], false]);
});

// A file is settled only where a published review of this pull request read it as it is.
const WHOLE = 'whole-file score: allowed';
const NOT_ALLOWED = 'whole-file score: not allowed';
const twoAndWhole = (blocks: Record<string, number>, whole?: number) => ({
  overview: 'src/t.ts reviewed.', findings: [],
  files: [{
    path: 'src/t.ts', change_summary: 'Changes the delay and the tries.',
    blocks: Object.entries(blocks).map(([id, score]) => ({ id, score, category: 'fix', reason: '' })),
    ...(whole === undefined ? {} : { score: whole, category: 'business_rule', reason: 'The two changes together decide how long a refund waits.' }),
  }],
});
const lookupOf = (first: ReviewResult) => (blocks: Array<{ path: string; hash: string; around: string }>) => Promise.resolve(blocks.flatMap((w) => first.scores
  .filter((f) => f.path === w.path).flatMap((f) => f.blocks.filter((one) => one.hash === w.hash && one.around === w.around && one.entry !== null))
  .map((one) => ({ path: w.path, hash: w.hash, around: w.around, entry: one.entry! }))));

test('the same change opened as another pull request may still take its whole-file score', async () => {
  const first = await firstOf([fileTwo], twoAndWhole({ B1: 20, B2: 20 }, 90));
  assert.equal(first.scores[0]!.finalScore, 90);
  const d = deps({ files: [fileTwo], answers: [twoAndWhole({}, 95)] });
  d.reusableScores = lookupOf(first);
  const r = await review(input, d);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)', '### Block B2 (2 changed lines, scored)']);
  assert.ok(sentText(d).includes(`\n${WHOLE}\n`));
  assert.ok(!sentText(d).includes(NOT_ALLOWED));
  assert.deepEqual(r.scores[0]!.blocks.map((one) => [one.entry?.score, one.origin]), [[20, 'other_pull_request'], [20, 'other_pull_request']]);
  assert.deepEqual([r.scores[0]!.fileLevel, r.scores[0]!.finalScore], [{ score: 95, source: 'whole_file' }, 95]);
});

test('a push that adds a block another pull request scored leaves the file open to a whole-file score', async () => {
  const first = await firstOf([delayFile(2)], onT({ blocks: [{ id: 'B1', score: 20, category: 'fix', reason: '' }] }));
  const elsewhere = await firstOf([fileTwo], twoAndWhole({ B1: 20, B2: 15 }));
  const d = deps({ files: [fileTwo], answers: [twoAndWhole({}, 90)] });
  d.reusableScores = lookupOf(elsewhere);
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)', '### Block B2 (2 changed lines, scored)']);
  assert.ok(sentText(d).includes(`\n${WHOLE}\n`));
  assert.deepEqual(r.scores[0]!.blocks.map((one) => [one.entry?.score, one.origin]), [[20, 'earlier_run'], [15, 'other_pull_request']]);
  assert.deepEqual([r.scores[0]!.fileLevel, r.scores[0]!.finalScore], [{ score: 90, source: 'whole_file' }, 90]);
});

test('a reviewed file moved to another directory with the same change is read once where it now stands', async () => {
  const before: ChangedFile = { path: 'src/util/x.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: delayPatch(2) };
  const after: ChangedFile = { path: 'app/api/x.ts', previousPath: 'src/util/x.ts', status: 'renamed', additions: 1, deletions: 1, patch: delayPatch(2) };
  const onX = (path: string, file: Record<string, unknown>) => ({ overview: `${path} reviewed.`, findings: [], files: [{ path, change_summary: 'Moves the file.', blocks: [], ...file }] });
  const first = await firstOf([before], onX('src/util/x.ts', { blocks: [{ id: 'B1', score: 20, category: 'fix', reason: '' }] }));
  const d = deps({ files: [after], answers: [onX('app/api/x.ts', { score: 95, category: 'security', reason: 'The code is now served on a public route.' })] });
  const second = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST, readAt: HEAD0 }) }, d);
  assert.equal(d.model.requests.length, 1);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)']);
  assert.ok(sentText(d).includes(`\n${WHOLE}\n`));
  assert.deepEqual([second.scores[0]!.blocks[0]!.entry?.score, second.scores[0]!.finalScore], [20, 95]);
  const third = deps({ files: [after] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(second, { covered: true, lastReview: LAST, readAt: NOW }) }, third);
  assert.equal(third.model.requests.length, 0);
  assert.deepEqual(notSent(r), [['app/api/x.ts', 'covered']]);
  assert.equal(r.scores[0]!.finalScore, 95);
});

test('a new file a later push renames keeps its scores', async () => {
  const billing = (path: string): ChangedFile => ({ path, previousPath: null, status: 'added', additions: 1, deletions: 1, patch: delayPatch(2) });
  const onBilling = (path: string, score: number) => ({ overview: `${path} reviewed.`, findings: [], files: [{ path, change_summary: 'Adds billing.', blocks: [{ id: 'B1', score, category: 'business_rule', reason: 'Charges the card.' }] }] });
  const first = await firstOf([billing('src/billing.ts')], onBilling('src/billing.ts', 92));
  const d = deps({ files: [billing('src/billing2.ts')], answers: [onBilling('src/billing2.ts', 10)] });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)']);
  assert.deepEqual(r.scores[0]!.blocks.map((one) => [one.entry?.score, one.origin]), [[92, 'earlier_run']]);
  assert.equal(r.scores[0]!.finalScore, 92);
});

test('a block the whole-file score stood for is still stood for at the next review', async () => {
  const first = await firstOf([fileTwo], twoAndWhole({}, 60));
  assert.deepEqual([first.scores[0]!.blocks.map((one) => one.entry), first.scores[0]!.finalScore, first.scores[0]!.covered], [[null, null], 60, true]);
  const d = deps({ files: [fileTwo] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.equal(d.model.requests.length, 0);
  assert.deepEqual(notSent(r), [['src/t.ts', 'covered']]);
  assert.deepEqual([r.scores[0]!.blocks.map((one) => one.entry), r.scores[0]!.fileLevel, r.scores[0]!.finalScore], [[null, null], { score: 60, source: 'whole_file' }, 60]);
});

test('a new file the model scored as a whole only keeps that score when a later push renames it', async () => {
  const billing = (path: string): ChangedFile => ({ path, previousPath: null, status: 'added', additions: 1, deletions: 1, patch: delayPatch(2) });
  const asWhole = (path: string, score: number) => ({ overview: `${path} reviewed.`, findings: [], files: [{ path, change_summary: 'Adds billing.', blocks: [], score, category: 'business_rule', reason: 'Charges the card.' }] });
  const first = await firstOf([billing('src/billing.ts')], asWhole('src/billing.ts', 92));
  const d = deps({ files: [billing('src/billing2.ts')], answers: [asWhole('src/billing2.ts', 10)] });
  const r = await review({ ...input, mode: 'full', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, scored)']);
  assert.deepEqual([r.scores[0]!.blocks.map((one) => one.entry), r.scores[0]!.fileLevel, r.scores[0]!.finalScore], [[null], { score: 92, source: 'whole_file' }, 92]);
});

test('a copy of a new file keeps its scores, and keeps them once the original is gone', async () => {
  const added = (path: string): ChangedFile => ({ path, previousPath: null, status: 'added', additions: 1, deletions: 1, patch: delayPatch(2) });
  const onFile = (path: string, blocks: unknown[] = []) => ({ overview: `${path} reviewed.`, findings: [], files: [{ path, change_summary: 'Adds billing.', blocks }] });
  const first = await firstOf([added('a.ts')], onFile('a.ts', [{ id: 'B1', score: 92, category: 'business_rule', reason: 'Charges the card.' }]));
  const d = deps({ files: [added('a.ts'), added('b.ts')], answers: [onFile('b.ts', [{ id: 'B1', score: 10, category: 'fix', reason: '' }])] });
  const second = await review({ ...input, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.deepEqual([d.model.requests.length, named(d, 'b.ts'), headersOf(d)], [1, 1, ['### Block B1 (2 changed lines, scored)']]);
  assert.deepEqual(finals(second), { 'a.ts': 92, 'b.ts': 92 });
  const third = deps({ files: [added('b.ts')] });
  const r = await review({ ...input, mode: 'incremental', history: historyFrom(second, { covered: true, lastReview: LAST }) }, third);
  assert.equal(third.model.requests.length, 0);
  assert.deepEqual(finals(r), { 'b.ts': 92 });
});

test('the reason of a score taken from another pull request is dropped where it is taken', async () => {
  const d = deps({ files: [fileTwo], answers: [answerOnT] });
  d.reusableScores = () => Promise.resolve([
    { path: 'src/t.ts', hash: hashB1!, around: aroundB1!, entry: { score: 30, category: 'fix', reason: 'See [the notes](https://example.test/x).' } },
    { path: 'src/t.ts', hash: hashB2!, around: aroundB2!, entry: { score: 20, category: 'fix', reason: 'See ![x](https://example.test/i.png).' } },
  ]);
  const taken = await review(input, d);
  assert.deepEqual(taken.scores[0]!.blocks.map((one) => [one.entry?.score, one.entry?.reason, one.origin]), [[30, '', 'other_pull_request'], [20, '', 'other_pull_request']]);
  const later = await review({ ...input, history: historyFrom(taken, { covered: true }) }, deps({ files: [fileTwo], answers: [answerOnT] }));
  assert.deepEqual(later.scores[0]!.blocks.map((one) => one.origin), ['earlier_run', 'earlier_run']);
  assert.ok(!JSON.stringify(later).includes('example.test'));
});

// The delay change of fileTwo between other unchanged lines, beside a new block.
const movedPatch = [
  '@@ -10,3 +10,3 @@', ' if (admin) {', '-const delay = 1;', '+const delay = 2;', ' }',
  '@@ -50,3 +50,3 @@', ' keep', '-const tries = 1;', '+const tries = 3;', ' keep',
].join('\n');
const movedFile: ChangedFile = { ...fileTwo, patch: movedPatch };

test('lines scored in one place and moved to another are scored again and cannot score lower', async () => {
  const first = await firstOf([delayFile(2)], onT({ blocks: [{ id: 'B1', score: 80, category: 'calculation', reason: 'Changes the delay.' }] }));
  const history = historyFrom(first, { covered: true, lastReview: LAST });
  const lower = deps({ files: [movedFile], answers: [onT({ blocks: [
    { id: 'B1', score: 5, category: 'fix', reason: 'Small.' }, { id: 'B2', score: 5, category: 'fix', reason: 'Small.' },
  ] })] });
  const r = await review({ ...input, mode: 'full', history }, lower);
  assert.deepEqual(headersOf(lower), ['### Block B1 (2 changed lines, not scored)', '### Block B2 (2 changed lines, not scored)']);
  assert.deepEqual(r.scores[0]!.blocks.map((one) => [one.id, one.entry?.score, one.raisedFrom, one.origin]), [['B1', 80, 5, undefined], ['B2', 5, undefined, undefined]]);
  assert.equal(r.scores[0]!.finalScore, 80);
  const higher = deps({ files: [movedFile], answers: [onT({ blocks: [
    { id: 'B1', score: 90, category: 'calculation', reason: 'Only admins wait.' }, { id: 'B2', score: 5, category: 'fix', reason: '' },
  ] })] });
  const h = await review({ ...input, mode: 'full', history }, higher);
  assert.deepEqual(h.scores[0]!.blocks.map((one) => [one.id, one.entry?.score, one.raisedFrom]), [['B1', 90, undefined], ['B2', 5, undefined]]);
});

test('a result stored with no surroundings: every block is asked for again and each is held to its own stored score', async () => {
  const first = await firstOf([fileTwo], twoAndWhole({ B1: 80, B2: 10 }));
  const old = JSON.parse(JSON.stringify(first)) as ReviewResult;
  for (const f of old.scores) for (const one of f.blocks) delete one.around;
  const d = deps({ files: [fileTwo], answers: [twoAndWhole({ B1: 5, B2: 5 })] });
  const r = await review({ ...input, mode: 'full', history: historyFrom(old, { covered: true, lastReview: LAST }) }, d);
  assert.equal(d.model.requests.length, 1);
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, not scored)', '### Block B2 (2 changed lines, not scored)']);
  assert.deepEqual(r.scores[0]!.blocks.map((one) => [one.id, one.entry?.score, one.raisedFrom]), [['B1', 80, 5], ['B2', 10, 5]]);
});

test('an answer of the lookup with other surroundings, or none, gives no score', async () => {
  const fix = (score: number) => ({ score, category: 'fix' as const, reason: '' });
  const d = deps({ files: [fileTwo], answers: [answerOnT] });
  d.reusableScores = () => Promise.resolve([
    { path: 'src/t.ts', hash: hashB1!, around: aroundB2!, entry: fix(50) },
    { path: 'src/t.ts', hash: hashB1!, entry: fix(50) },
    { path: 'src/t.ts', hash: hashB1!, around: 5, entry: fix(50) },
    { path: 'src/t.ts', hash: hashB1!, around: '', entry: fix(50) },
    { path: 'src/t.ts', hash: hashB2!, around: aroundB2!, entry: fix(20) },
  ] as unknown as Array<{ path: string; hash: string; around: string; entry: ScoreEntry }>);
  const r = await review(input, d);
  assert.equal(r.status, 'ok');
  assert.deepEqual(headersOf(d), ['### Block B1 (2 changed lines, not scored)', '### Block B2 (2 changed lines, scored)']);
});

test('no score falls: a block whose neighbours change and change back, and two hunks with the same changed lines of which the higher is edited', async () => {
  // A block scored 20; a line beside it changes: asked, 60; the line changes back: kept at 60, the model not asked for it.
  const r1 = await firstOf([delayFile(2)], onT({ blocks: [{ id: 'B1', score: 20, category: 'fix', reason: '' }] }));
  const beside: ChangedFile = { ...delayFile(2), patch: ['@@ -10,3 +10,3 @@', ' if (admin) {', '-const delay = 1;', '+const delay = 2;', ' }'].join('\n') };
  const asked = deps({ files: [beside], answers: [onT({ blocks: [{ id: 'B1', score: 60, category: 'calculation', reason: 'Only admins wait.' }] })] });
  const r2 = await review({ ...input, mode: 'full', history: historyFrom([r1]) }, asked);
  assert.deepEqual([headersOf(asked), r2.scores[0]!.finalScore], [['### Block B1 (2 changed lines, not scored)'], 60]);
  const back = deps({ files: [delayFile(2)], answers: [onT({ blocks: [{ id: 'B1', score: 5, category: 'fix', reason: '' }] })] });
  const r3 = await review({ ...input, mode: 'full', history: historyFrom([r1, r2]) }, back);
  assert.deepEqual(headersOf(back), ['### Block B1 (2 changed lines, scored)']);
  assert.deepEqual([r3.scores[0]!.blocks[0]!.entry?.score, r3.scores[0]!.blocks[0]!.origin, r3.scores[0]!.finalScore], [60, 'earlier_run', 60]);

  // Two hunks with the same changed lines scored 85 and 10; read again; then the first is edited and scored 15: the file stands at 85.
  const twins = (value: number): ChangedFile => ({ ...fileTwo, patch: [
    '@@ -10,3 +10,3 @@', ' keep', '-const delay = 1;', `+const delay = ${value};`, ' keep',
    '@@ -50,3 +50,3 @@', ' if (admin) {', '-const delay = 1;', '+const delay = 2;', ' }',
  ].join('\n') });
  const t1 = await firstOf([twins(2)], twoAndWhole({ B1: 85, B2: 10 }));
  assert.deepEqual(t1.scores[0]!.blocks.map((one) => one.entry?.score), [85, 10]);
  const again = deps({ files: [twins(2)], answers: [twoAndWhole({})] });
  const t2 = await review({ ...input, mode: 'full', history: historyFrom([t1]) }, again);
  assert.deepEqual(t2.scores[0]!.blocks.map((one) => [one.entry?.score, one.origin]), [[85, 'earlier_run'], [85, 'earlier_run']]);
  const edited = deps({ files: [twins(5)], answers: [twoAndWhole({ B1: 15 })] });
  const t3 = await review({ ...input, mode: 'full', history: historyFrom([t1, t2]) }, edited);
  assert.deepEqual(headersOf(edited), ['### Block B1 (2 changed lines, not scored)', '### Block B2 (2 changed lines, scored)']);
  assert.deepEqual(t3.scores[0]!.blocks.map((one) => [one.entry?.score, one.origin]), [[15, undefined], [85, 'earlier_run']]);
  assert.equal(t3.scores[0]!.finalScore, 85);

  // A block scored 20; a line beside it changes: asked, the model gives the file 50 and the block nothing. The review after asks nothing.
  const c1 = await firstOf([delayFile(2)], onT({ blocks: [{ id: 'B1', score: 20, category: 'fix', reason: '' }] }));
  const wholeOnly = deps({ files: [beside], answers: [onT({ score: 50, category: 'business_rule', reason: 'Only admins wait.' })] });
  const c2 = await review({ ...input, mode: 'full', history: historyFrom([c1]) }, wholeOnly);
  assert.deepEqual([headersOf(wholeOnly), c2.scores[0]!.blocks[0]!.entry, c2.scores[0]!.finalScore, c2.scores[0]!.covered], [['### Block B1 (2 changed lines, not scored)'], null, 50, true]);
  const after = deps({ files: [beside] });
  const c3 = await review({ ...input, mode: 'incremental', history: historyFrom([c1, c2], { covered: true, lastReview: LAST, readAt: NOW }) }, after);
  assert.equal(after.model.requests.length, 0);
  assert.deepEqual([c3.scores[0]!.blocks[0]!.entry?.score, c3.scores[0]!.blocks[0]!.origin, c3.scores[0]!.fileLevel, c3.scores[0]!.finalScore],
    [20, 'earlier_run', { score: 50, source: 'whole_file' }, 50]);

  // A hunk split by the model into parts scored 10 and 20; a line beside it changes: asked as one, 70; the line changes back: one block at 70, not asked.
  const rows = Array.from({ length: 32 }, (_, i) => `+const row${i} = ${i * 13};`);
  const tall = (head: string): ChangedFile => ({ path: 'src/t.ts', previousPath: null, status: 'modified', additions: 32, deletions: 0, patch: ['@@ -1,1 +1,33 @@', ` ${head}`, ...rows].join('\n') });
  const d1 = await firstOf([tall('head')], onT({ blocks: [{ id: 'B1', parts: [
    { first: 'R2', last: 'R17', score: 10, category: 'test', reason: '' }, { first: 'R18', last: 'R33', score: 20, category: 'fix', reason: '' },
  ] }] }));
  assert.deepEqual(d1.scores[0]!.blocks.map((one) => [one.id, one.entry?.score]), [['B1.1', 10], ['B1.2', 20]]);
  const whole = deps({ files: [tall('other head')], answers: [onT({ blocks: [{ id: 'B1', score: 70, category: 'data_model', reason: 'Adds the rows.' }] })] });
  const d2 = await review({ ...input, mode: 'full', history: historyFrom([d1]) }, whole);
  assert.deepEqual([headersOf(whole), d2.scores[0]!.finalScore], [['### Block B1 (32 changed lines, not scored)'], 70]);
  const backTall = deps({ files: [tall('head')], answers: [onT({ blocks: [] })] });
  const d3 = await review({ ...input, mode: 'full', history: historyFrom([d1, d2]) }, backTall);
  assert.deepEqual(headersOf(backTall), ['### Block B1 (32 changed lines, scored)']);
  assert.deepEqual([d3.scores[0]!.blocks.map((one) => [one.id, one.entry?.score, one.origin]), d3.scores[0]!.finalScore], [[['B1', 70, 'earlier_run']], 70]);
});

// Context providers. The pull request of these tests says it is not from a fork.
const own: ReviewInput = { ...input, pullRequest: { ...input.pullRequest, fromFork: false } };
const TICKET = 'The total is rounded to cents, and a refund keeps its sign.';
const ticketContext: ExtensionContext = { blocks: [{ name: 'tickets', label: 'ticket SHOP-12', text: TICKET }], criteria: [] };
const TOKEN = 'abcdef0123456789';
function ticketProvider(answer: unknown = { status: 'ok', label: 'ticket SHOP-12', text: TICKET }): ContextProvider & { calls: number } {
  const p = { name: 'tickets', calls: 0, provide: async () => { p.calls += 1; return answer as never; } };
  return p;
}
const longContent = Array.from({ length: 60 }, (_, i) => `const line${i} = ${i * 104729};`).join('\n');
const withContent = <T extends ReviewDeps>(d: T): T => {
  d.source.getFileContent = async (_p, path) => (path === 'src/a.ts' ? longContent : null);
  return d;
};
async function unitOf(file: ChangedFile, content: boolean): Promise<number> {
  const source = content ? withContent(deps({ files: [] })).source : deps({ files: [] }).source;
  return unitTokens((await buildFileContexts(own.pullRequest, [file], source)).contexts[0]!);
}
const limitsOf = (inputTokensPerCall: number, batchesPerReview = 6): ReviewInput => ({ ...own, limits: { ...own.limits, inputTokensPerCall, batchesPerReview } });
const partTokens = (): number => fixedTokens(CONTRACT, own.pullRequest, false, undefined, ticketContext) - fixedTokens(CONTRACT, own.pullRequest);

test('a pull request from a fork is reviewed with no extension context, and the result says why', async () => {
  const provider = ticketProvider();
  const fork: ReviewInput = { ...input, pullRequest: { ...input.pullRequest, fromFork: true } };
  const asked = deps({ files: [fileA], answers: [answerOnA], contextProviders: [provider] });
  const r = await review(fork, asked);
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  await review(fork, plain);
  assert.equal(provider.calls, 0);
  assert.deepEqual(asked.model.requests, plain.model.requests);
  assert.deepEqual(r.dependencies.extensions, { tickets: { status: 'skipped', code: 'from_fork' } });
});

test('with no provider nothing is asked and the result says nothing of extensions', async () => {
  const today = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB } });
  const expected = await review(smallLimits, today);
  for (const contextProviders of [undefined, []]) {
    const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB }, ...(contextProviders === undefined ? {} : { contextProviders }) });
    const r = await review({ ...smallLimits, pullRequest: own.pullRequest }, d);
    assert.equal('extensions' in r.dependencies, false);
    assert.deepEqual(d.model.requests, today.model.requests);
    assert.deepEqual(r, expected);
    assert.deepEqual(d.logged, today.logged);
  }
});

test('a provider is asked once for a review of two batches, its text is in both calls and its status in the result', async () => {
  const unit = await unitOf(fileA, false);
  const provider = ticketProvider();
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB }, contextProviders: [provider] });
  const r = await review(limitsOf(fixedTokens(CONTRACT, own.pullRequest, false, undefined, ticketContext) + unit + Math.floor(unit / 2)), d);
  assert.equal(provider.calls, 1);
  assert.deepEqual(r.dependencies, { model: 'ok', extensions: { tickets: { status: 'ok', code: 'ok' } } });
  assert.equal(d.model.requests.length, 2);
  const headers = d.model.requests.map((q) => q.messages[1]!.content);
  assert.equal(headers[0], headers[1]);
  assert.equal(headers[0]!.endsWith(`\n${extensionPart(ticketContext, TOKEN)}`), true);
  assert.equal(d.model.requests.some((q) => q.messages[2]!.content.includes(EXTENSION_LINE)), false);
});

test('a provider that throws or answers junk never fails the review', async () => {
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  const expected = await review(own, plain);
  const d = deps({
    files: [fileA], answers: [answerOnA],
    contextProviders: [
      { name: 'tickets', provide: async () => { throw new Error('Refused by host 10.0.0.5'); } },
      { name: 'chat', provide: async () => ({ status: 'ok', text: 5 }) as never },
    ],
  });
  const r = await review(own, d);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.findings, expected.findings);
  assert.deepEqual(r.dependencies.extensions, { tickets: { status: 'error', code: 'provider_failed' }, chat: { status: 'error', code: 'bad_shape' } });
  assert.deepEqual(d.model.requests, plain.model.requests);
  assert.doesNotMatch(JSON.stringify(r), /10\.0\.0\.5|Refused/);
});

test('the statuses are on a failed review too, and a pull request with no changed file asks nobody', async () => {
  const failed = await review(own, deps({ files: [fileA], answers: [new ProviderError('auth', 'c', 401, null)], contextProviders: [ticketProvider()] }));
  assert.deepEqual([failed.status, failed.dependencies], ['failed', { model: 'error', extensions: { tickets: { status: 'ok', code: 'ok' } } }]);
  const unread = deps({ files: [fileA], contextProviders: [ticketProvider()] });
  unread.source.getDefaultBranchFile = () => Promise.reject(new Error('github_500'));
  const source = await review(own, unread);
  assert.deepEqual([source.failure, source.dependencies.extensions], [{ stage: 'context', code: 'github_500' }, { tickets: { status: 'ok', code: 'ok' } }]);
  const provider = ticketProvider();
  const empty = await review(own, deps({ files: [], contextProviders: [provider] }));
  assert.equal(provider.calls, 0);
  assert.equal('extensions' in empty.dependencies, false);
});

test('text that would cost a file its full contents is dropped for the whole review, and the audit says so', async () => {
  const full = await unitOf(fileA, true);
  assert.ok(full - (await unitOf(fileA, false)) > partTokens());
  const d = withContent(deps({ files: [fileA], answers: [answerOnA], contextProviders: [ticketProvider()] }));
  const r = await review(limitsOf(fixedTokens(CONTRACT, own.pullRequest) + full), d);
  assert.equal(d.model.requests.length, 1);
  assert.ok(d.model.requests[0]!.messages[2]!.content.includes('### Full file'));
  assert.equal(d.model.requests[0]!.messages[1]!.content.includes(EXTENSION_LINE), false);
  assert.deepEqual(r.audit.filter((e) => e.action === 'extension_context_cut'), [{ stage: 'context', action: 'extension_context_cut', subject: 'extensions', reason: 'over_call_budget' }]);
  assert.equal(r.audit.some((e) => e.action === 'full_file_cut'), false);
  assert.deepEqual(r.dependencies.extensions, { tickets: { status: 'ok', code: 'ok' } });
});

test('a file that is cut with or without the text does not cost the text its place', async () => {
  const bare = await unitOf(fileA, false);
  const d = withContent(deps({ files: [fileA], answers: [answerOnA], contextProviders: [ticketProvider()] }));
  const r = await review(limitsOf(fixedTokens(CONTRACT, own.pullRequest, false, undefined, ticketContext) + bare), d);
  assert.ok(r.audit.some((e) => e.action === 'full_file_cut' && e.subject === 'src/a.ts'));
  assert.equal(r.audit.some((e) => e.action === 'extension_context_cut'), false);
  assert.equal(d.model.requests[0]!.messages[1]!.content.endsWith(extensionPart(ticketContext, TOKEN)), true);
  assert.deepEqual(r.coverage, { reviewed: ['src/a.ts'], notReviewed: [] });
});

test('text that would leave a file unreviewed is dropped, and text that only moves a file to a second batch is kept', async () => {
  const unit = await unitOf(fileA, false);
  const room = fixedTokens(CONTRACT, own.pullRequest) + 2 * unit;
  const one = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB }, contextProviders: [ticketProvider()] });
  const r1 = await review(limitsOf(room, 1), one);
  assert.equal(one.model.requests.length, 1);
  assert.deepEqual(r1.coverage, { reviewed: ['src/a.ts', 'src/b.ts'], notReviewed: [] });
  assert.equal(one.model.requests[0]!.messages[1]!.content.includes(EXTENSION_LINE), false);
  assert.deepEqual(r1.audit.filter((e) => e.action === 'extension_context_cut').map((e) => e.subject), ['extensions']);
  const two = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB }, contextProviders: [ticketProvider()] });
  const r2 = await review(limitsOf(room, 2), two);
  assert.equal(two.model.requests.length, 2);
  assert.ok(two.model.requests.every((q) => q.messages[1]!.content.endsWith(extensionPart(ticketContext, TOKEN))));
  assert.deepEqual(r2.coverage.notReviewed, []);
  assert.equal(r2.audit.some((e) => e.action === 'extension_context_cut'), false);
});

// Acceptance criteria.
const CRITERIA = ['Orders above the limit are refused.', 'A refund writes an audit row.', 'The export is paged.'];
const criteriaProvider = (criteria: string[] = CRITERIA, text?: string): ContextProvider & { calls: number } =>
  ticketProvider({ status: 'ok', label: 'ticket SHOP-12', criteria, ...(text === undefined ? {} : { text }) });
const withRows = (answer: object, acceptance: unknown[]): object => ({ ...answer, acceptance });
const rowOf = (criterion: string, status: string, note: string, from: string) => ({ criterion, status, note, from });
const notJudged = (criterion: string) => rowOf(criterion, 'not_verified', '', 'none');

test('criteria come back as rows, one for each, in the order shown', async () => {
  const d = deps({
    files: [fileA], contextProviders: [criteriaProvider()],
    answers: [withRows(answerOnA, [{ item: 'A1', status: 'met', note: 'In src/a.ts:2.' }, { item: 'A3', status: 'not_met', note: 'Nothing pages the export.' }])],
  });
  const r = await review(own, d);
  assert.deepEqual(r.acceptance, [
    rowOf(CRITERIA[0]!, 'met', 'In src/a.ts:2.', 'review'), notJudged(CRITERIA[1]!), rowOf(CRITERIA[2]!, 'not_met', 'Nothing pages the export.', 'review'),
  ]);
  assert.deepEqual(d.model.requests[0]!.tools, [submitToolFor(false, true)]);
  assert.ok(d.model.requests[0]!.messages[1]!.content.endsWith(extensionPart({ blocks: [], criteria: CRITERIA }, TOKEN)));
  assert.ok(d.model.requests[0]!.messages[1]!.content.includes(`A1. ${CRITERIA[0]}\nA2. ${CRITERIA[1]}\nA3. ${CRITERIA[2]}`));
  // Rows change nothing else.
  const plain = await review(own, deps({ files: [fileA], answers: [answerOnA] }));
  assert.deepEqual([r.findings, r.scores, r.verdict, r.coverage], [plain.findings, plain.scores, plain.verdict, plain.coverage]);
});

test('two batches that disagree leave the criterion not met', async () => {
  const unit = await unitOf(fileA, false);
  const shown: ExtensionContext = { blocks: [], criteria: CRITERIA };
  const d = deps({
    files: [fileA, fileB], contextProviders: [criteriaProvider()],
    answerFor: {
      'src/a.ts': withRows(answerOnA, [{ item: 'A1', status: 'met', note: 'In src/a.ts:2.' }]),
      'src/b.ts': withRows(answerOnB, [{ item: 'A1', status: 'not_met', note: 'src/b.ts lets them through.' }]),
    },
  });
  const r = await review(limitsOf(fixedTokens(CONTRACT, own.pullRequest, false, undefined, shown) + unit + Math.floor(unit / 2)), d);
  assert.equal(d.model.requests.length, 2);
  assert.deepEqual(r.acceptance![0], rowOf(CRITERIA[0]!, 'not_met', 'src/b.ts lets them through.', 'review'));
  assert.deepEqual(r.audit.filter((e) => e.action === 'acceptance_disagreement'), [{ stage: 'reconcile', action: 'acceptance_disagreement', subject: 'A1', reason: 'not_met' }]);
});

test('a badly shaped row costs that row, and the findings of its answer are kept', async () => {
  const d = deps({
    files: [fileA], contextProviders: [criteriaProvider()],
    answers: [withRows(answerOnA, [{ item: 1, status: 'met', note: 'In src/a.ts:2.' }, 'junk', { item: 'A2' }])],
  });
  const r = await review(own, d);
  assert.equal(d.model.requests.length, 1);
  assert.equal(r.audit.some((e) => e.action === 'retry'), false);
  assert.deepEqual(r.findings.map((f) => [f.path, f.line]), [['src/a.ts', 2]]);
  assert.deepEqual(r.acceptance, [rowOf(CRITERIA[0]!, 'met', 'In src/a.ts:2.', 'review'), notJudged(CRITERIA[1]!), notJudged(CRITERIA[2]!)]);
  assert.deepEqual(r.audit.filter((e) => e.action === 'acceptance_dropped').map((e) => [e.subject, e.reason]), [['row', 'bad_shape'], ['A2', 'bad_shape']]);
});

test('rows that are no list cost no answer and no retry', async () => {
  const d = deps({ files: [fileA], contextProviders: [criteriaProvider()], answers: [withRows(answerOnA, 'x' as never)] });
  const r = await review(own, d);
  assert.equal(d.model.requests.length, 1);
  assert.deepEqual(r.findings.map((f) => [f.path, f.line]), [['src/a.ts', 2]]);
  assert.deepEqual(r.acceptance, CRITERIA.map(notJudged));
  assert.deepEqual(r.audit.filter((e) => e.action === 'acceptance_dropped'), [{ stage: 'reconcile', action: 'acceptance_dropped', subject: 'acceptance', reason: 'bad_shape' }]);
});

test('criteria are shown alone when the texts with them would cost a file something', async () => {
  const full = await unitOf(fileA, true);
  const alone: ExtensionContext = { blocks: [], criteria: CRITERIA.slice(0, 2) };
  const d = withContent(deps({ files: [fileA], answers: [answerOnA], contextProviders: [criteriaProvider(CRITERIA.slice(0, 2), TICKET.repeat(20))] }));
  const r = await review(limitsOf(fixedTokens(CONTRACT, own.pullRequest, false, undefined, alone) + full), d);
  assert.equal(d.model.requests.length, 1);
  const request = d.model.requests[0]!;
  assert.ok(request.messages[2]!.content.includes('### Full file'));
  assert.ok(request.messages[1]!.content.endsWith(extensionPart(alone, TOKEN)));
  assert.ok(request.messages[1]!.content.includes(ACCEPTANCE_RULES));
  assert.equal(request.messages[1]!.content.includes('extension tickets:'), false);
  assert.deepEqual(request.tools, [submitToolFor(false, true)]);
  assert.deepEqual(r.audit.filter((e) => e.action === 'extension_context_cut'), [{ stage: 'context', action: 'extension_context_cut', subject: 'texts', reason: 'over_call_budget' }]);
  assert.equal(r.audit.some((e) => e.action === 'full_file_cut'), false);
});

test('with no criterion the result has no acceptance and the tool is the tool of today', async () => {
  const text = deps({ files: [fileA], answers: [answerOnA], contextProviders: [ticketProvider()] });
  const withText = await review(own, text);
  assert.equal('acceptance' in withText, false);
  assert.deepEqual(text.model.requests[0]!.tools, [submitReviewTool]);
  assert.equal(text.model.requests[0]!.messages[1]!.content.includes(ACCEPTANCE_HEADING), false);
  const silent = deps({ files: [fileA], answers: [answerOnA], contextProviders: [ticketProvider({ status: 'skipped', code: 'no_ticket' })] });
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  const r = await review(own, silent);
  const expected = await review(own, plain);
  assert.deepEqual(silent.model.requests, plain.model.requests);
  assert.deepEqual({ ...r, dependencies: { model: r.dependencies.model } }, expected);
});

test('a review that calls no model still lists the criteria, not judged', async () => {
  const d = deps({ files: [binaryNoPatch], contextProviders: [criteriaProvider()] });
  const r = await review(own, d);
  assert.equal(d.model.requests.length, 0);
  assert.deepEqual(r.acceptance, CRITERIA.map(notJudged));
});

test('criteria that were not shown for want of room stay in the result, and the tool is the tool of today', async () => {
  const full = await unitOf(fileA, true);
  const d = withContent(deps({ files: [fileA], answers: [answerOnA], contextProviders: [criteriaProvider(CRITERIA, TICKET)] }));
  const r = await review(limitsOf(fixedTokens(CONTRACT, own.pullRequest) + full), d);
  assert.equal(d.model.requests.length, 1);
  assert.deepEqual(d.model.requests[0]!.tools, [submitReviewTool]);
  assert.equal(d.model.requests[0]!.messages[1]!.content.includes(EXTENSION_LINE), false);
  assert.deepEqual(r.audit.filter((e) => e.action === 'extension_context_cut').map((e) => e.subject), ['extensions']);
  assert.deepEqual(r.acceptance, CRITERIA.map(notJudged));
});

test('an incremental review keeps what the last review found for a criterion it does not judge and tells the model of it, and a full review does neither', async () => {
  const [a, b] = CRITERIA as [string, string];
  const earlierAcceptance = [rowOf(a, 'met', 'In src/a.ts:2.', 'review'), rowOf(b, 'not_met', 'No audit row.', 'review')] as ReviewInput['earlierAcceptance'];
  const answer = withRows(answerOnA, [{ item: 'A2', status: 'met', note: 'src/a.ts:2 writes it.' }]);
  const LINE = 'The last review left these as: A1 met; A2 not_met.';
  for (const mode of ['incremental', 'recheck'] as const) {
    const d = deps({ files: [fileA], answers: [answer], contextProviders: [criteriaProvider([a, b])] });
    const r = await review({ ...own, mode, earlierAcceptance }, d);
    assert.deepEqual(r.acceptance, [rowOf(a, 'met', 'In src/a.ts:2.', 'earlier'), rowOf(b, 'met', 'src/a.ts:2 writes it.', 'review')], mode);
    assert.ok(d.model.requests[0]!.messages[1]!.content.includes(`\n\n${LINE}\n\n<<<data ${TOKEN} acceptance criteria>>>`), mode);
  }
  const d = deps({ files: [fileA], answers: [answer], contextProviders: [criteriaProvider([a, b])] });
  const r = await review({ ...own, mode: 'full', earlierAcceptance }, d);
  assert.deepEqual(r.acceptance, [notJudged(a), rowOf(b, 'met', 'src/a.ts:2 writes it.', 'review')]);
  assert.equal(d.model.requests[0]!.messages[1]!.content.includes('The last review left these as'), false);
  // A stored row that is damaged is passed over.
  const damaged = deps({ files: [fileA], answers: [answerOnA], contextProviders: [criteriaProvider([a])] });
  const kept = await review({ ...own, mode: 'incremental', earlierAcceptance: [{ criterion: a, status: 'done', note: 'x', from: 'review' }] as never }, damaged);
  assert.deepEqual(kept.acceptance, [notJudged(a)]);
  assert.equal(damaged.model.requests[0]!.messages[1]!.content.includes('The last review left these as'), false);
});

test('a criterion cut at a space keeps its row at the next review, as one cut inside a word does', async () => {
  for (const long of ['word '.repeat(80), 'wordss '.repeat(80)]) {
    const first = deps({ files: [fileA], answers: [withRows(answerOnA, [{ item: 'A1', status: 'not_met', note: 'The handler has no test.' }])], contextProviders: [criteriaProvider([long])] });
    const r1 = await review(own, first);
    // Stored and read back, as the shell does.
    const earlierAcceptance = JSON.parse(JSON.stringify(r1.acceptance)) as ReviewInput['earlierAcceptance'];
    const second = deps({ files: [fileA], answers: [answerOnA], contextProviders: [criteriaProvider([long])] });
    const r2 = await review({ ...own, mode: 'incremental', earlierAcceptance }, second);
    assert.deepEqual(r2.acceptance!.map((row) => [row.status, row.from, row.note]), [['not_met', 'earlier', 'The handler has no test.']], long.slice(0, 6));
    assert.ok(second.model.requests[0]!.messages[1]!.content.includes('The last review left these as: A1 not_met.'), long.slice(0, 6));
  }
});

test('a failed review has no acceptance rows', async () => {
  const r = await review(own, deps({ files: [fileA], answers: [new ProviderError('auth', 'c', 401, null)], contextProviders: [criteriaProvider()] }));
  assert.equal(r.status, 'failed');
  assert.equal('acceptance' in r, false);
});

test('a provider whose list of criteria is hostile fails no review', async () => {
  const list = ['a'];
  const trap: Record<string | symbol, unknown> = { every: () => true, some: () => false, [Symbol.iterator]: () => { throw new Error('Trap set'); } };
  trap.map = () => trap;
  Object.defineProperty(list, 'slice', { value: () => trap });
  const lying = ['b'];
  Object.defineProperty(lying, 'slice', { value: () => [{ obj: 1 }, 42] });
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  const expected = await review(own, plain);
  for (const criteria of [[, 'a'], new Array(3)]) {
    const d = deps({ files: [fileA], answers: [answerOnA], contextProviders: [ticketProvider({ status: 'ok', criteria })] });
    const r = await review(own, d);
    assert.deepEqual(r.dependencies.extensions, { tickets: { status: 'error', code: 'bad_shape' } });
    assert.deepEqual(d.model.requests, plain.model.requests);
  }
  const d = deps({ files: [fileA], answers: [answerOnA], contextProviders: [ticketProvider({ status: 'ok', criteria: list }), { ...ticketProvider({ status: 'ok', criteria: lying }), name: 'chat' }] });
  const r = await review(own, d);
  assert.deepEqual([r.status, r.failure, r.findings], [expected.status, expected.failure, expected.findings]);
  assert.deepEqual(r.dependencies.extensions, { tickets: { status: 'ok', code: 'ok' }, chat: { status: 'ok', code: 'ok' } });
});

test('the tool choice of the dependencies reaches every call of a review, a retry and the halves of a split batch included', async () => {
  const split = (toolChoice?: 'forced' | 'auto') =>
    deps({ files: [fileA, fileB], answers: [new ProviderError('timeout', 't', null, null), answerOnA, answerOnB], ...(toolChoice === undefined ? {} : { toolChoice }) });
  const auto = split('auto');
  const r = await review(input, auto);
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(auto.model.requests.map((q) => q.forcedTool), [null, null, null]);
  const forced = split();
  await review(input, forced);
  assert.deepEqual(forced.model.requests.map((q) => q.forcedTool), [SUBMIT_REVIEW, SUBMIT_REVIEW, SUBMIT_REVIEW]);
  assert.deepEqual(auto.model.requests.map((q) => [q.messages, q.tools]), forced.model.requests.map((q) => [q.messages, q.tools]));
  // a second try after a time-out, then the retry of an invalid answer
  const retried = deps({ files: [fileA], answers: [new ProviderError('timeout', 't', null, null), ungrounded, answerOnA], toolChoice: 'auto' });
  const again = await review(input, retried);
  assert.deepEqual([again.status, again.coverage.reviewed], ['ok', ['src/a.ts']]);
  assert.deepEqual(retried.model.requests.map((q) => q.forcedTool), [null, null, null]);
});

// MCP servers (stage 6, Task 9). A fake server is a literal whose open gives a literal session; each pushes
// [name, ...args] for its calls into one log, which the model's requests join when a test asks for the order.
const SYSTEM_WITH_TOOLS = `${CONTRACT}\n\n${TOOL_RULES}`;
const searchSchema = { type: 'object', properties: { query: { type: 'string' } } };
const listedTool = (name: string) => ({ name, description: `Does ${name}.`, inputSchema: searchSchema });
const docsSearch: ToolDefinition = { type: 'function', function: { name: 'docs__search', description: 'Does search.', parameters: searchSchema } };
const textResult = (text: string): McpAnswer => ({ ok: true, result: { content: [{ type: 'text', text }] } });
interface FakeServer { server: McpServer; log: unknown[][] }
function fakeServer(opts: {
  name?: string; tools?: string[]; listed?: string[];
  answer?: (tool: string, args: Record<string, unknown>) => Promise<McpAnswer>;
  open?: (session: McpSession) => Promise<McpSession>;
} = {}): FakeServer {
  const log: unknown[][] = [];
  const tools = opts.tools ?? ['search'];
  const session: McpSession = {
    tools: (opts.listed ?? tools).map(listedTool),
    call(tool, args) { log.push(['call', tool, args]); return opts.answer ? opts.answer(tool, args) : Promise.resolve(textResult(`${tool} result`)); },
    close() { log.push(['close']); return Promise.resolve(); },
  };
  const server: McpServer = {
    name: opts.name ?? 'docs', tools,
    open() { log.push(['open']); return opts.open ? opts.open(session) : Promise.resolve(session); },
  };
  return { server, log };
}
const kinds = (f: FakeServer, kind: string): unknown[][] => f.log.filter((e) => e[0] === kind);
// The model's requests join the server's log, so that the order of the two can be read.
const logRequests = (d: ReturnType<typeof deps>, f: FakeServer): void => {
  const complete = d.model.complete.bind(d.model);
  d.model.complete = (request) => { f.log.push(['request']); return complete(request); };
};
const toolCallOf = (id: string, name: string, args: string | null): ToolCall => ({ id, name, arguments: args });
const searchCall = (id: string, query = 'cart'): ToolCall => toolCallOf(id, 'docs__search', JSON.stringify({ query }));
const callsTools = (...calls: ToolCall[]): Raw => new Raw({
  toolName: calls[0]!.name, toolArguments: calls[0]!.arguments, text: null, model: 'm', provider: null, usage: usage(),
  toolCalls: calls,
  assistant: { role: 'assistant', content: null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) },
});
// The steps of one batch, one for each request it makes, in order.
const inTurn = (...steps: Step[]): ((request: ModelRequest) => Step) => {
  let i = 0;
  return () => { i += 1; return steps[i - 1]; };
};
// Limits under which, with the tools of docs/search offered, each batch holds `files` units of the file given.
const roomFor = async (units: number): Promise<ReviewInput> =>
  limitsOf(fixedTokens(SYSTEM_WITH_TOOLS, own.pullRequest) + toolRoomTokens([docsSearch]) + Math.floor(units * (await unitOf(fileA, false))));
const toolMessages = (q: ModelRequest) => q.messages.filter((m) => m.role === 'tool');

test('with no server, with an empty list, and with the tool choice not given, the requests, the result and the log are those of before', async () => {
  const lim: ReviewInput = { ...smallLimits, pullRequest: own.pullRequest };
  const spec = () => ({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB } });
  const today = deps(spec());
  const expected = await review(lim, today);
  // Each request is the literal of before: the contract, the header and the files, and submit_review forced.
  const built = await buildFileContexts(own.pullRequest, [fileA, fileB], today.source);
  assert.equal(today.model.requests.length, 2);
  today.model.requests.forEach((q, i) => {
    assert.deepEqual(q, {
      messages: buildMessages({
        contract: CONTRACT, pr: own.pullRequest, fileCount: 2, firstFileNumber: i + 1,
        batch: { files: [built.contexts[i]!], tokens: 0 }, batchIndex: i, batchCount: 2, token: TOKEN,
      }),
      tools: [submitReviewTool], forcedTool: 'submit_review', effort: 'default', timeoutMs: 30_000,
    });
    assert.deepEqual([q.messages.length, q.messages[0]], [3, { role: 'system', content: CONTRACT }]);
    assert.deepEqual(Object.keys(q).sort(), ['effort', 'forcedTool', 'messages', 'timeoutMs', 'tools']);
  });
  assert.deepEqual(today.logged, [0, 1].map(() => ({
    event: 'model_call', files: 1, effort: 'default', code: 'ok', usage: usage(), model: 'm', provider: null,
  })));
  assert.deepEqual([expected.status, expected.dependencies, expected.coverage.reviewed], ['ok', { model: 'ok' }, ['src/a.ts', 'src/b.ts']]);
  const variants: Array<{ mcpServers?: McpServer[]; toolChoice?: 'forced' }> = [{}, { mcpServers: [] }, { toolChoice: 'forced' }, { mcpServers: [], toolChoice: 'forced' }];
  for (const variant of variants) {
    const d = deps({ ...spec(), ...variant });
    const r = await review(lim, d);
    assert.equal('mcp' in r.dependencies, false);
    assert.deepEqual(d.model.requests, today.model.requests);
    assert.deepEqual(r, expected);
    assert.deepEqual(d.logged, today.logged);
  }
});

test('the system message with no tool offered is the contract, character for character', async () => {
  const docs = fakeServer({ tools: ['get_page'], listed: ['search'] });
  const d = deps({ files: [fileA], answers: [answerOnA], mcpServers: [docs.server] });
  const r = await review(own, d);
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  await review(own, plain);
  assert.equal(d.model.requests[0]!.messages[0]!.content, CONTRACT);
  assert.deepEqual([d.model.requests[0]!.tools, d.model.requests[0]!.forcedTool], [[submitReviewTool], 'submit_review']);
  assert.deepEqual(d.model.requests, plain.model.requests);
  assert.deepEqual(r.dependencies.mcp, { docs: { status: 'error', code: 'tool_not_listed', calls: 0 } });
  assert.deepEqual(kinds(docs, 'close').length, 1);
});

test('servers are opened once for a review of two batches and closed once, and both batches are sent the same rules and tools', async () => {
  const docs = fakeServer();
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB }, mcpServers: [docs.server] });
  logRequests(d, docs);
  const r = await review(await roomFor(1.5), d);
  assert.equal(d.model.requests.length, 2);
  assert.deepEqual(docs.log, [['open'], ['request'], ['request'], ['close']]);
  for (const q of d.model.requests) {
    assert.equal(q.messages[0]!.content, SYSTEM_WITH_TOOLS);
    assert.deepEqual([q.tools, q.forcedTool], [[submitReviewTool, docsSearch], null]);
  }
  assert.deepEqual(r.dependencies, { model: 'ok', mcp: { docs: { status: 'ok', code: 'ok', calls: 0 } } });
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts', 'src/b.ts']);
});

test('a tool call of the model reaches the server, and its result reaches the model wrapped with the review\'s token', async () => {
  const docs = fakeServer();
  const d = deps({ files: [fileA], answers: [callsTools(searchCall('c1')), answerOnA], mcpServers: [docs.server] });
  const r = await review(own, d);
  assert.deepEqual(kinds(docs, 'call'), [['call', 'search', { query: 'cart' }]]);
  assert.equal(d.model.requests.length, 2);
  assert.deepEqual(d.model.requests[1]!.messages.at(-1), {
    role: 'tool', toolCallId: 'c1', content: `<<<data ${TOKEN} tool result docs__search>>>\nsearch result\n<<<end ${TOKEN}>>>`,
  });
  assert.equal(r.dependencies.mcp!.docs!.calls, 1);
  assert.ok(r.audit.some((e) => e.stage === 'tools' && e.action === 'tool_call' && e.subject === 'docs__search' && e.reason === 'ok:13'));
  assert.deepEqual([r.status, r.usage.calls, r.findings.length], ['ok', 2, 1]);
});

test('the sessions are closed when the review fails, when a model call throws, and when every batch fails', async () => {
  // Each case makes a tool call first, so that the log holds requests, a call and the close, in the order they happened.
  const cases: Step[][] = [
    [callsTools(searchCall('c1')), new ProviderError('auth', 'c', 401, null)],
    [callsTools(searchCall('c1')), () => { throw new Error('boom'); }],
    [callsTools(searchCall('c1')), ungrounded, ungrounded],
  ];
  for (const answers of cases) {
    const docs = fakeServer();
    const d = deps({ files: [fileA], answers, mcpServers: [docs.server] });
    logRequests(d, docs);
    const r = await review(own, d);
    assert.equal(r.status, 'failed');
    assert.equal(kinds(docs, 'close').length, 1);
    assert.equal(kinds(docs, 'call').length, 1);
    assert.equal(kinds(docs, 'request').length, answers.length);
    assert.deepEqual(docs.log.at(-1), ['close']);
    assert.ok(r.dependencies.mcp !== undefined);
  }
  // reviewOnce turns every error into a failed result, an error whose name throws when it is read included: it ends
  // as the same failed result as any other unexpected error, and the session is closed all the same, last.
  const hostile = new Error('boom');
  Object.defineProperty(hostile, 'name', { get() { throw new Error('trap'); } });
  const docs = fakeServer();
  const d = deps({ files: [fileA], answers: [callsTools(searchCall('c1')), () => { throw hostile; }], mcpServers: [docs.server] });
  logRequests(d, docs);
  const r = await review(own, d);
  const plainDocs = fakeServer();
  const plain = await review(own, deps({ files: [fileA], answers: [callsTools(searchCall('c1')), () => { throw new Error('boom'); }], mcpServers: [plainDocs.server] }));
  assert.deepEqual([r.status, r.failure, r.usage, r.dependencies], [plain.status, plain.failure, plain.usage, plain.dependencies]);
  assert.equal(r.status, 'failed');
  assert.ok(d.logged.some((e) => e.event === 'internal_error' && e.name === 'unknown'));
  assert.deepEqual(docs.log, [['open'], ['request'], ['call', 'search', { query: 'cart' }], ['request'], ['close']]);
});

test('a review that calls no model opens nothing and says nothing of servers', async () => {
  for (const [files, inp] of [[[], own], [[binaryNoPatch], own], [[fileA], limitsOf(10)]] as Array<[ChangedFile[], ReviewInput]>) {
    const docs = fakeServer();
    const d = deps({ files, mcpServers: [docs.server] });
    const r = await review(inp, d);
    assert.deepEqual(docs.log, []);
    assert.equal('mcp' in r.dependencies, false);
    assert.equal(d.model.requests.length, 0);
  }
});

test('a pull request from a fork is reviewed with no tool, and the result says why', async () => {
  for (const [fromFork, code] of [[true, 'from_fork'], [undefined, 'origin_unknown']] as Array<[boolean | undefined, string]>) {
    const pr: PullRequestInfo = { ...input.pullRequest };
    if (fromFork !== undefined) pr.fromFork = fromFork;
    const docs = fakeServer();
    const d = deps({ files: [fileA], answers: [answerOnA], mcpServers: [docs.server] });
    const r = await review({ ...input, pullRequest: pr }, d);
    const plain = deps({ files: [fileA], answers: [answerOnA] });
    await review({ ...input, pullRequest: pr }, plain);
    assert.deepEqual(docs.log, []);
    assert.deepEqual(d.model.requests, plain.model.requests);
    assert.deepEqual(r.dependencies.mcp, { docs: { status: 'skipped', code, calls: 0 } });
  }
});

test('tools that would cost a file its contents are not offered for the whole review, and the audit says so', async () => {
  const full = await unitOf(fileA, true);
  const bare = await unitOf(fileA, false);
  // With the room the file loses its contents; without it, it keeps them. Then a budget that leaves no room at all.
  const limits = [fixedTokens(SYSTEM_WITH_TOOLS, own.pullRequest) + toolRoomTokens([docsSearch]) + bare, fixedTokens(CONTRACT, own.pullRequest) + full];
  for (const inputTokensPerCall of limits) {
    assert.ok(inputTokensPerCall - fixedTokens(CONTRACT, own.pullRequest) >= full);
    const docs = fakeServer();
    const d = withContent(deps({ files: [fileA], answers: [answerOnA], mcpServers: [docs.server] }));
    const r = await review(limitsOf(inputTokensPerCall), d);
    const plain = withContent(deps({ files: [fileA], answers: [answerOnA] }));
    await review(limitsOf(inputTokensPerCall), plain);
    assert.deepEqual(d.model.requests, plain.model.requests);
    assert.ok(d.model.requests[0]!.messages[2]!.content.includes('### Full file'));
    assert.deepEqual(r.audit.filter((e) => e.action === 'tools_cut'), [{ stage: 'context', action: 'tools_cut', subject: 'tools', reason: 'over_call_budget' }]);
    assert.equal(r.audit.some((e) => e.action === 'full_file_cut'), false);
    assert.deepEqual(r.dependencies.mcp, { docs: { status: 'skipped', code: 'no_room', calls: 0 } });
    assert.deepEqual([kinds(docs, 'open').length, kinds(docs, 'close').length], [1, 1]);
  }
});

test('a file that is cut with or without the tools does not cost the tools their place', async () => {
  // Larger than the room the tools take: its full contents are cut with them and without them.
  const huge = Array.from({ length: 1_000 }, (_, i) => `const line${i} = '${'x'.repeat(110)}';`).join('\n');
  const docs = fakeServer();
  const d = deps({ files: [fileA], answers: [answerOnA], mcpServers: [docs.server] });
  d.source.getFileContent = async (_p, path) => (path === 'src/a.ts' ? huge : null);
  const r = await review(await roomFor(1), d);
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  plain.source.getFileContent = d.source.getFileContent;
  const without = await review(await roomFor(1), plain);
  assert.ok(without.audit.some((e) => e.action === 'full_file_cut' && e.subject === 'src/a.ts'));
  assert.ok(r.audit.some((e) => e.action === 'full_file_cut' && e.subject === 'src/a.ts'));
  assert.equal(r.audit.some((e) => e.action === 'tools_cut'), false);
  assert.deepEqual(d.model.requests[0]!.tools, [submitReviewTool, docsSearch]);
  assert.deepEqual(r.coverage, { reviewed: ['src/a.ts'], notReviewed: [] });
  assert.deepEqual(r.dependencies.mcp, { docs: { status: 'ok', code: 'ok', calls: 0 } });
});

test('tools never cost the extension context its place', async () => {
  // Room for everything: the text is shown and the tools are offered.
  const roomy = deps({ files: [fileA], answers: [answerOnA], contextProviders: [ticketProvider()], mcpServers: [fakeServer().server] });
  await review(own, roomy);
  assert.equal(roomy.model.requests[0]!.messages[1]!.content.endsWith(extensionPart(ticketContext, TOKEN)), true);
  assert.deepEqual(roomy.model.requests[0]!.tools, [submitReviewTool, docsSearch]);
  // Room for the text and the file's contents, not for the tools: the text is shown and the tools are not offered.
  const full = await unitOf(fileA, true);
  const tight = limitsOf(fixedTokens(CONTRACT, own.pullRequest, false, undefined, ticketContext) + full);
  const d = withContent(deps({ files: [fileA], answers: [answerOnA], contextProviders: [ticketProvider()], mcpServers: [fakeServer().server] }));
  const r = await review(tight, d);
  const plain = withContent(deps({ files: [fileA], answers: [answerOnA], contextProviders: [ticketProvider()] }));
  await review(tight, plain);
  assert.equal(d.model.requests[0]!.messages[1]!.content.endsWith(extensionPart(ticketContext, TOKEN)), true);
  assert.deepEqual(d.model.requests, plain.model.requests);
  assert.equal(r.audit.some((e) => e.action === 'extension_context_cut'), false);
  assert.deepEqual(r.dependencies.mcp, { docs: { status: 'skipped', code: 'no_room', calls: 0 } });
});

test('the batches of a review share the eight calls', async () => {
  // Each call asks for its own id, so that the server's log says which batch sent it.
  const five = (prefix: string): Raw => callsTools(...[1, 2, 3, 4, 5].map((n) => searchCall(`${prefix}${n}`, `${prefix}${n}`)));
  const docs = fakeServer();
  const d = deps({
    files: [fileA, fileB], mcpServers: [docs.server],
    answerFor: { 'src/a.ts': inTurn(five('a'), answerOnA), 'src/b.ts': inTurn(five('b'), answerOnB) },
  });
  const r = await review(await roomFor(1.5), d);
  assert.equal(kinds(docs, 'call').length, 8);
  // Whichever order the two batches' calls take, eight are sent and two are not run: the first call refused for
  // the cap is NOT_RUN_CAP, and a call after it in the same turn is NOT_RUN_CLOSED.
  const notRun = (c: string): boolean => c === NOT_RUN_CAP || c === NOT_RUN_CLOSED;
  const lasts = d.model.requests.filter((q) => toolMessages(q).length > 0);
  assert.equal(lasts.length, 2);
  const answered = lasts.flatMap(toolMessages);
  assert.equal(answered.length, 10);
  assert.equal(answered.filter((m) => !notRun(m.content)).length, 8);
  assert.equal(answered.filter((m) => notRun(m.content)).length, 2);
  assert.ok(answered.some((m) => m.content === NOT_RUN_CAP));
  for (const prefix of ['a', 'b']) {
    const own = answered.filter((m) => m.toolCallId!.startsWith(prefix));
    assert.deepEqual(own.map((m) => m.toolCallId), [1, 2, 3, 4, 5].map((n) => `${prefix}${n}`));
    const sent = kinds(docs, 'call').filter((e) => (e[2] as { query: string }).query.startsWith(prefix)).length;
    assert.equal(sent, own.filter((m) => !notRun(m.content)).length);
    assert.equal(sent + own.filter((m) => notRun(m.content)).length, 5);
  }
  assert.equal(r.dependencies.mcp!.docs!.calls, 8);
  assert.deepEqual([r.status, r.coverage.reviewed.length], ['ok', 2]);
});

test('two batches racing for the last call: one call reaches the server', async () => {
  const docs = fakeServer({ answer: (tool) => new Promise((resolve) => setTimeout(() => resolve(textResult(`${tool} result`)), 5)) });
  const d = deps({
    files: [fileA, fileB], mcpServers: [docs.server], delayMs: 2,
    answerFor: {
      'src/a.ts': inTurn(callsTools(searchCall('a1'), searchCall('a2'), searchCall('a3'), searchCall('a4')), callsTools(searchCall('a5')), answerOnA),
      'src/b.ts': inTurn(callsTools(searchCall('b1'), searchCall('b2'), searchCall('b3')), callsTools(searchCall('b4')), answerOnB),
    },
  });
  const r = await review(await roomFor(1.5), d);
  assert.equal(kinds(docs, 'call').length, 8);
  const last = d.model.requests.flatMap((q) => toolMessages(q).filter((m) => m.toolCallId === 'a5' || m.toolCallId === 'b4'));
  const byId = new Map(last.map((m) => [m.toolCallId, m.content]));
  assert.deepEqual([...byId.values()].filter((c) => c === NOT_RUN_CAP).length, 1);
  assert.equal(byId.size, 2);
  assert.deepEqual([r.status, r.coverage.reviewed], ['ok', ['src/a.ts', 'src/b.ts']]);
  assert.equal(r.audit.filter((e) => e.action === 'batch_failed').length, 0);
});

test('a second try is sent no tools', async () => {
  const docs = fakeServer();
  const timeout = new ProviderError('timeout', 't', null, null);
  const d = deps({ files: [fileA, fileB], answers: [callsTools(searchCall('c1')), timeout, answerOnA, answerOnB], mcpServers: [docs.server] });
  const r = await review(own, d);
  const plain = deps({ files: [fileA, fileB], answers: [timeout, answerOnA, answerOnB] });
  await review(own, plain);
  assert.equal(d.model.requests.length, 4);
  const halves = d.model.requests.slice(2);
  for (const q of halves) {
    assert.equal(q.messages[0]!.content, CONTRACT);
    assert.deepEqual([q.tools, q.forcedTool, toolMessages(q)], [[submitReviewTool], 'submit_review', []]);
  }
  assert.deepEqual(halves, plain.model.requests.slice(1));
  assert.equal(d.logged.filter((e) => e.event === 'model_call').length, 3);
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(r.dependencies, { model: 'ok', mcp: { docs: { status: 'ok', code: 'ok', calls: 1 } } });
  // a first call that ends rate_limited: its retry is sent no tools either, and nothing is withheld
  const limited = deps({ files: [fileA], answers: [new ProviderError('rate_limited', 'r', 429, null), answerOnA], mcpServers: [fakeServer().server] });
  const again = await review(own, limited);
  assert.deepEqual(limited.model.requests.map((q) => [q.messages[0]!.content, q.tools.length]), [[SYSTEM_WITH_TOOLS, 2], [CONTRACT, 1]]);
  assert.deepEqual(again.dependencies, { model: 'ok', mcp: { docs: { status: 'ok', code: 'ok', calls: 0 } } });
  assert.equal(again.audit.some((e) => e.action === 'tools_refused'), false);
});

test('an endpoint that refuses a request with tools costs the tools, not the review', async () => {
  const fileC = fileAt('src/c.ts');
  const refuse = (answer: unknown) => (q: ModelRequest): Step => (q.tools.length > 1 ? new ProviderError('provider', 'p', 400, null) : answer);
  const docs = fakeServer();
  const d = deps({
    files: [fileA, fileB, fileC], mcpServers: [docs.server],
    answerFor: { 'src/a.ts': refuse(answerOnA), 'src/b.ts': refuse(answerOnB), 'src/c.ts': refuse(okFor(fileC)) },
  });
  const r = await review(await roomFor(1.5), d);
  assert.equal(d.model.requests.length, 5);
  assert.deepEqual(d.model.requests.map((q) => q.tools.length), [2, 2, 1, 1, 1]);
  for (const q of d.model.requests.slice(2)) assert.deepEqual([q.messages[0]!.content, q.forcedTool], [CONTRACT, 'submit_review']);
  assert.equal(r.status, 'ok');
  assert.deepEqual([...r.coverage.reviewed].sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepEqual(r.dependencies, { model: 'ok', mcp: { docs: { status: 'error', code: 'model_refused_tools', calls: 0 } } });
  assert.deepEqual(r.audit.filter((e) => e.action === 'tools_refused'), [{ stage: 'model', action: 'tools_refused', subject: 'batch', reason: 'provider' }]);
  assert.equal(kinds(docs, 'close').length, 1);
});

test('a second try that fails too is the model\'s failure, as today', async () => {
  const down = new ProviderError('provider', 'p', 502, null);
  const r = await review(own, deps({ files: [fileA], answers: [down, down], mcpServers: [fakeServer().server] }));
  assert.deepEqual([r.status, r.failure, r.dependencies.model], ['failed', { stage: 'model', code: 'provider' }, 'error']);
  assert.deepEqual(r.dependencies.mcp, { docs: { status: 'ok', code: 'ok', calls: 0 } });
  assert.equal(r.audit.some((e) => e.action === 'tools_refused'), false);
});

test('a model that only makes up tools costs each batch one more request, and no call reaches a server', async () => {
  const docs = fakeServer();
  const nope = () => callsTools(toolCallOf('c1', 'docs__nope', '{}'));
  const d = deps({
    files: [fileA, fileB], mcpServers: [docs.server],
    answerFor: { 'src/a.ts': inTurn(nope(), answerOnA), 'src/b.ts': inTurn(nope(), answerOnB) },
  });
  const r = await review(await roomFor(1.5), d);
  assert.equal(d.model.requests.length, 4);
  assert.equal(kinds(docs, 'call').length, 0);
  assert.deepEqual(r.audit.filter((e) => e.action === 'tool_call_refused').map((e) => [e.subject, e.reason]), [['unknown', 'unknown_tool'], ['unknown', 'unknown_tool']]);
  assert.deepEqual(r.audit.filter((e) => e.action === 'tools_closed').map((e) => e.reason), ['nothing_sent', 'nothing_sent']);
  assert.equal(r.status, 'ok');
  assert.doesNotMatch(JSON.stringify(r), /docs__nope/);
});

test('a server that cannot be opened never fails the review, and with no tool offered the requests are those of a review with no server', async () => {
  const docs = fakeServer({ open: () => Promise.reject(new Error('http_401')) });
  const d = deps({ files: [fileA], answers: [answerOnA], mcpServers: [docs.server] });
  const r = await review(own, d);
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  const expected = await review(own, plain);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.findings, expected.findings);
  assert.deepEqual(d.model.requests, plain.model.requests);
  assert.deepEqual(r.dependencies.mcp, { docs: { status: 'error', code: 'open_http_401', calls: 0 } });
  assert.deepEqual(kinds(docs, 'close'), []);
});

test('a server that fails in the middle of a review does not fail it', async () => {
  const docs = fakeServer({ answer: () => Promise.resolve({ ok: false, code: 'timeout' }) });
  const d = deps({ files: [fileA], answers: [callsTools(searchCall('c1')), answerOnA], mcpServers: [docs.server] });
  const r = await review(own, d);
  assert.equal(d.model.requests.length, 2);
  const closing = d.model.requests[1]!;
  assert.deepEqual([closing.forcedTool, closing.messages.at(-1)], ['submit_review', { role: 'user', content: FINAL_LINE }]);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.dependencies.mcp, { docs: { status: 'error', code: 'call_timeout', calls: 1 } });
});

test('the model_call line counts the tool calls only for a call that was given tools', async () => {
  const d = deps({ files: [fileA], answers: [callsTools(searchCall('c1')), answerOnA], mcpServers: [fakeServer().server] });
  await review(own, d);
  assert.deepEqual(d.logged, [{
    event: 'model_call', files: 1, effort: 'default', code: 'ok', usage: { ...usage(), calls: 2, inputTokens: 200, outputTokens: 20, cachedTokens: 10, cost: 1 },
    model: 'm', provider: null, tool_calls: 1,
  }]);
  const retried = deps({ files: [fileA], answers: [new ProviderError('rate_limited', 'r', 429, null), answerOnA], mcpServers: [fakeServer().server] });
  await review(own, retried);
  assert.deepEqual(retried.logged.map((e) => ['tool_calls' in e, e.tool_calls]), [[true, 0], [false, undefined]]);
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  await review(own, plain);
  assert.equal('tool_calls' in plain.logged[0]!, false);
});

test('with a scorer the scorer is sent no tool and no result', async () => {
  const withTools = scorerStub(() => ({ blocks: { B1: refunds } }));
  await review(own, deps({ files: [fileA], answers: [callsTools(searchCall('c1')), scored('src/a.ts', 20)], scorer: withTools, mcpServers: [fakeServer().server] }));
  const without = scorerStub(() => ({ blocks: { B1: refunds } }));
  await review(own, deps({ files: [fileA], answers: [scored('src/a.ts', 20)], scorer: without }));
  assert.equal(withTools.requests.length, 1);
  assert.deepEqual(withTools.requests, without.requests);
  assert.doesNotMatch(JSON.stringify(withTools.requests), /search result|docs__search/);
});

test('the sessions are closed at once when no tool can be called: no room, and no named tool offered', async () => {
  const bare = await unitOf(fileA, false);
  const noRoom = limitsOf(fixedTokens(SYSTEM_WITH_TOOLS, own.pullRequest) + toolRoomTokens([docsSearch]) + bare);
  const cases: Array<[FakeServer, ReviewInput, string]> = [
    [fakeServer(), noRoom, 'no_room'],
    [fakeServer({ tools: ['get_page'], listed: ['search'] }), own, 'tool_not_listed'],
  ];
  for (const [docs, inp, code] of cases) {
    const d = withContent(deps({ files: [fileA], answers: [answerOnA], mcpServers: [docs.server] }));
    logRequests(d, docs);
    const r = await review(inp, d);
    assert.deepEqual(docs.log, [['open'], ['close'], ['request']], code);
    assert.equal(r.dependencies.mcp!.docs!.code, code);
  }
});

// Memory: where people stepped in before (7.4).
type MemoryFiles = Array<{ path: string; previousPath: string | null }>;
const memoryLine = (over: Partial<MemoryLine> = {}): MemoryLine =>
  ({ ref: '8:file:src/a.ts', near: false, path: 'src/a.ts', day: '2026-03-10', category: 'business_rule', missed: true, ...over });
const twoLines = [memoryLine(), memoryLine({ ref: '9:file:src/cart/add.ts', near: true, path: 'src/cart/add.ts', day: '2026-03-02', category: null, missed: false })];
const noCut = { directories: 0, categories: 0, lines: 0, names: 0, records: false };
const memoryAnswer = (lines: MemoryLine[], withLists = true, cut = noCut): MemoryBlocks => ({
  repository: withLists
    ? { directories: [{ name: 'src/billing', pullRequests: 3 }, { name: 'src/cart', pullRequests: 2 }], categories: [{ name: 'business_rule', pullRequests: 2 }] }
    : { directories: [], categories: [] },
  pullRequest: lines, cut,
});
// The context the engine makes of an answer that is valid throughout.
const contextOf = (answer: MemoryBlocks): MemoryContext => ({ directories: answer.repository.directories, categories: answer.repository.categories, lines: answer.pullRequest });
function memoryOf(answer: MemoryBlocks | (() => Promise<MemoryBlocks>)): Memory & { calls: Array<[MemoryFiles, Date]> } {
  const calls: Array<[MemoryFiles, Date]> = [];
  return {
    calls,
    blocks: async (files, asOf) => { calls.push([files, asOf]); return typeof answer === 'function' ? answer() : answer; },
  };
}
const withoutMemory = (r: ReviewResult): ReviewResult => {
  const dependencies = { ...r.dependencies };
  delete dependencies.memory;
  return { ...r, dependencies };
};

test('with no memory given the requests, the result and the log are those of before', async () => {
  const lim: ReviewInput = { ...smallLimits, pullRequest: own.pullRequest };
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB } });
  const r = await review(lim, d);
  assert.equal('memory' in r.dependencies, false);
  assert.deepEqual(r.dependencies, { model: 'ok' });
  const built = await buildFileContexts(own.pullRequest, [fileA, fileB], d.source);
  assert.equal(d.model.requests.length, 2);
  d.model.requests.forEach((q, i) => {
    assert.deepEqual(q, {
      messages: buildMessages({
        contract: CONTRACT, pr: own.pullRequest, fileCount: 2, firstFileNumber: i + 1,
        batch: { files: [built.contexts[i]!], tokens: 0 }, batchIndex: i, batchCount: 2, token: TOKEN,
      }),
      tools: [submitReviewTool], forcedTool: 'submit_review', effort: 'default', timeoutMs: 30_000,
    });
    assert.deepEqual([q.messages.length, q.messages[0]], [3, { role: 'system', content: CONTRACT }]);
    assert.deepEqual(Object.keys(q).sort(), ['effort', 'forcedTool', 'messages', 'timeoutMs', 'tools']);
  });
  assert.deepEqual(d.logged, [0, 1].map(() => ({
    event: 'model_call', files: 1, effort: 'default', code: 'ok', usage: usage(), model: 'm', provider: null,
  })));
  assert.deepEqual([r.status, r.coverage.reviewed], ['ok', ['src/a.ts', 'src/b.ts']]);
  assert.equal(r.audit.some((e) => e.action.startsWith('memory_')), false);
});

const memoryTokens = (answer: MemoryBlocks): number => fixedTokens(CONTRACT, own.pullRequest, false, undefined, undefined, contextOf(answer)) - fixedTokens(CONTRACT, own.pullRequest);
// Limits under which, with the memory of `answer` shown, a call holds `units` units of fileA.
const memoryRoom = async (answer: MemoryBlocks, units: number): Promise<ReviewInput> =>
  limitsOf(fixedTokens(CONTRACT, own.pullRequest, false, undefined, undefined, contextOf(answer)) + Math.floor(units * (await unitOf(fileA, false))));
const shownOfMemory = (r: ReviewResult) => r.audit.filter((e) => e.action === 'memory_shown');

test('a memory with nothing for the changed files changes no request, and the result says it was empty', async () => {
  const plain = deps({ files: [fileA, fileB], answers: [answerOnA, answerOnB] });
  const expected = await review(own, plain);
  const memory = memoryOf(memoryAnswer([]));
  const d = deps({ files: [fileA, fileB], answers: [answerOnA, answerOnB], memory });
  const r = await review(own, d);
  assert.equal(memory.calls.length, 1);
  assert.deepEqual(d.model.requests, plain.model.requests);
  assert.deepEqual(d.logged, plain.logged);
  assert.deepEqual(r.dependencies.memory, { status: 'empty', code: 'no_records', lines: 0 });
  assert.deepEqual(withoutMemory(r), expected);
});

test('memory is asked once for a review of two batches, with the files the run sends and the time it was given', async () => {
  const answer = memoryAnswer(twoLines);
  const memory = memoryOf(answer);
  const asOf = new Date('2026-03-12T10:00:00.000Z');
  const d = deps({ files: [fileA, fileB], answers: [answerOnA, answerOnB], memory });
  await review({ ...(await memoryRoom(answer, 1.5)), asOf }, d);
  assert.equal(d.model.requests.length, 2);
  assert.equal(memory.calls.length, 1);
  assert.deepEqual(memory.calls[0]![0], [{ path: 'src/a.ts', previousPath: null }, { path: 'src/b.ts', previousPath: null }]);
  // A copy of the time it was given: equal to it, not the same object.
  assert.deepEqual(memory.calls[0]![1], asOf);
  assert.notEqual(memory.calls[0]![1], asOf);
  // A memory that sets the time it was handed leaves the review's own as it was.
  const given = new Date('2026-03-12T10:00:00.000Z');
  const setting: Memory = { blocks: async (_files, at) => { at.setTime(0); return answer; } };
  const r = await review({ ...(await memoryRoom(answer, 1.5)), asOf: given }, deps({ files: [fileA, fileB], answers: [answerOnA, answerOnB], memory: setting }));
  assert.deepEqual(r.dependencies.memory, { status: 'ok', code: 'ok', lines: 2 });
  assert.equal(given.getTime(), asOf.getTime());
});

test('both batches are sent the repository message and the same header, and the result counts the lines', async () => {
  const answer = memoryAnswer(twoLines);
  const parts = memoryParts(contextOf(answer));
  const d = deps({ files: [fileA, fileB], answers: [answerOnA, answerOnB], memory: memoryOf(answer) });
  const r = await review(await memoryRoom(answer, 1.5), d);
  assert.equal(d.model.requests.length, 2);
  for (const q of d.model.requests) {
    assert.equal(q.messages.length, 4);
    assert.deepEqual(q.messages[1], { role: 'user', content: parts.repository });
    assert.equal(q.messages[2]!.content.endsWith(`\n${parts.pullRequest}`), true);
  }
  assert.equal(d.model.requests[0]!.messages[2]!.content, d.model.requests[1]!.messages[2]!.content);
  assert.deepEqual(r.dependencies.memory, { status: 'ok', code: 'ok', lines: 2 });
  assert.deepEqual(shownOfMemory(r), [
    { stage: 'context', action: 'memory_shown', subject: '8:file:src/a.ts', reason: 'changed' },
    { stage: 'context', action: 'memory_shown', subject: '9:file:src/cart/add.ts', reason: 'near' },
  ]);
  assert.deepEqual(r.coverage, { reviewed: ['src/a.ts', 'src/b.ts'], notReviewed: [] });
});

test('two reviews on one day are sent the same repository message, byte for byte', async () => {
  const answer = memoryAnswer(twoLines);
  const parts = memoryParts(contextOf(answer));
  const one = deps({ files: [fileA], answers: [answerOnA], memory: memoryOf(answer) });
  const two = deps({ files: [fileA], answers: [answerOnA], memory: memoryOf(answer) });
  two.token = () => 'fedcba9876543210';
  await review(own, one);
  await review(own, two);
  const [q1, q2] = [one.model.requests[0]!, two.model.requests[0]!];
  assert.equal(q1.messages[1]!.content, q2.messages[1]!.content);
  assert.equal(q1.messages[1]!.content, parts.repository);
  assert.ok(q1.messages[2]!.content.includes(`\n${parts.pullRequest}`) && q2.messages[2]!.content.includes(`\n${parts.pullRequest}`));
  assert.notEqual(q1.messages[2]!.content, q2.messages[2]!.content);   // the header holds each review's own token
  for (const text of [parts.repository, parts.pullRequest]) {
    assert.equal(text.includes(TOKEN) || text.includes('fedcba9876543210'), false);
  }
});

test('memory that would cost a file its contents is not shown, and the audit says so', async () => {
  const answer = memoryAnswer(twoLines, false);
  const full = await unitOf(fileA, true);
  assert.ok(full - (await unitOf(fileA, false)) > memoryTokens(answer));
  const lim = limitsOf(fixedTokens(CONTRACT, own.pullRequest) + full);
  const d = withContent(deps({ files: [fileA], answers: [answerOnA], memory: memoryOf(answer) }));
  const r = await review(lim, d);
  const plain = withContent(deps({ files: [fileA], answers: [answerOnA] }));
  const expected = await review(lim, plain);
  assert.deepEqual(d.model.requests, plain.model.requests);
  assert.ok(d.model.requests[0]!.messages[2]!.content.includes('### Full file'));
  assert.deepEqual(r.audit.filter((e) => e.action.startsWith('memory_')), [{ stage: 'context', action: 'memory_cut', subject: 'memory', reason: 'over_call_budget' }]);
  assert.equal(r.audit.some((e) => e.action === 'full_file_cut'), false);
  assert.deepEqual(r.dependencies.memory, { status: 'skipped', code: 'no_room', lines: 0 });
  assert.deepEqual(r.coverage, expected.coverage);
});

test('a file that is cut with or without memory does not cost memory its place', async () => {
  const answer = memoryAnswer(twoLines, false);
  const parts = memoryParts(contextOf(answer));
  const bare = await unitOf(fileA, false);
  assert.ok((await unitOf(fileA, true)) - bare > memoryTokens(answer));
  const d = withContent(deps({ files: [fileA], answers: [answerOnA], memory: memoryOf(answer) }));
  const r = await review(await memoryRoom(answer, 1), d);
  assert.ok(r.audit.some((e) => e.action === 'full_file_cut' && e.subject === 'src/a.ts'));
  assert.equal(r.audit.some((e) => e.action === 'memory_cut'), false);
  assert.equal(d.model.requests[0]!.messages.length, 3);   // no list: no repository message
  assert.equal(d.model.requests[0]!.messages[1]!.content.endsWith(`\n${parts.pullRequest}`), true);
  assert.deepEqual(r.dependencies.memory, { status: 'ok', code: 'ok', lines: 2 });
  assert.deepEqual(r.coverage, { reviewed: ['src/a.ts'], notReviewed: [] });
});

test('when both cannot be shown, memory keeps its place and the extension context is cut', async () => {
  const answer = memoryAnswer(twoLines);
  const parts = memoryParts(contextOf(answer));
  const full = await unitOf(fileA, true);
  const lim = limitsOf(fixedTokens(CONTRACT, own.pullRequest, false, undefined, undefined, contextOf(answer)) + full);
  const d = withContent(deps({ files: [fileA], answers: [answerOnA], memory: memoryOf(answer), contextProviders: [ticketProvider()] }));
  const r = await review(lim, d);
  const header = d.model.requests[0]!.messages[2]!.content;
  assert.equal(header.endsWith(`\n${parts.pullRequest}`), true);
  assert.equal(header.includes(EXTENSION_LINE), false);
  assert.ok(d.model.requests[0]!.messages[3]!.content.includes('### Full file'));
  assert.deepEqual(r.audit.filter((e) => e.action === 'extension_context_cut'), [{ stage: 'context', action: 'extension_context_cut', subject: 'extensions', reason: 'over_call_budget' }]);
  assert.equal(r.audit.some((e) => e.action === 'memory_cut'), false);
  assert.deepEqual(r.dependencies.memory, { status: 'ok', code: 'ok', lines: 2 });
  // With room for both, both are shown: memory first, the providers' text after it.
  const roomy = deps({ files: [fileA], answers: [answerOnA], memory: memoryOf(answer), contextProviders: [ticketProvider()] });
  await review(own, roomy);
  assert.equal(roomy.model.requests[0]!.messages[2]!.content.endsWith(`\n${parts.pullRequest}\n${extensionPart(ticketContext, TOKEN)}`), true);
});

test('the entries of memory stand in the audit after those of the packing and before those of the room for extension context', async () => {
  // No lists: the full file must cost more than memory, and with the lists it no longer does.
  const answer = memoryAnswer(twoLines, false, { directories: 0, categories: 0, lines: 4, names: 0, records: true });
  const bare = await unitOf(fileA, false);
  assert.ok((await unitOf(fileA, true)) - bare > memoryTokens(answer));
  const d = withContent(deps({ files: [fileA], answers: [answerOnA], memory: memoryOf(answer), contextProviders: [ticketProvider()] }));
  const r = await review(await memoryRoom(answer, 1), d);
  const at = r.audit.findIndex((e) => e.action === 'full_file_cut');
  assert.ok(at >= 0);
  assert.deepEqual(r.audit.slice(at, at + 6), [
    r.audit[at],
    { stage: 'context', action: 'memory_cut', subject: 'lines', reason: '4' },
    { stage: 'context', action: 'memory_cut', subject: 'records', reason: 'over_read_limit' },
    { stage: 'context', action: 'memory_shown', subject: '8:file:src/a.ts', reason: 'changed' },
    { stage: 'context', action: 'memory_shown', subject: '9:file:src/cart/add.ts', reason: 'near' },
    { stage: 'context', action: 'extension_context_cut', subject: 'extensions', reason: 'over_call_budget' },
  ]);
  assert.equal(r.audit[at]!.subject, 'src/a.ts');
});

test('tools are offered only when they cost memory nothing', async () => {
  const answer = memoryAnswer(twoLines);
  const parts = memoryParts(contextOf(answer));
  const full = await unitOf(fileA, true);
  // One token short of the room the tools need with memory counted: without memory there is room for them.
  const lim = limitsOf(fixedTokens(SYSTEM_WITH_TOOLS, own.pullRequest, false, undefined, undefined, contextOf(answer)) + toolRoomTokens([docsSearch]) + full - 1);
  assert.ok(memoryTokens(answer) >= 1);
  const bare = withContent(deps({ files: [fileA], answers: [answerOnA], mcpServers: [fakeServer().server] }));
  const without = await review(lim, bare);
  assert.deepEqual(bare.model.requests[0]!.tools, [submitReviewTool, docsSearch]);
  assert.ok(bare.model.requests[0]!.messages[2]!.content.includes('### Full file'));
  assert.equal(without.audit.some((e) => e.action === 'tools_cut'), false);
  assert.deepEqual(without.dependencies.mcp, { docs: { status: 'ok', code: 'ok', calls: 0 } });
  const docs = fakeServer();
  const d = withContent(deps({ files: [fileA], answers: [answerOnA], memory: memoryOf(answer), mcpServers: [docs.server] }));
  const r = await review(lim, d);
  const plain = withContent(deps({ files: [fileA], answers: [answerOnA], memory: memoryOf(answer) }));
  await review(lim, plain);
  assert.deepEqual(d.model.requests, plain.model.requests);
  assert.ok(d.model.requests[0]!.messages[3]!.content.includes('### Full file'));
  assert.equal(d.model.requests[0]!.messages[2]!.content.endsWith(`\n${parts.pullRequest}`), true);
  assert.deepEqual(d.model.requests[0]!.tools, [submitReviewTool]);
  assert.deepEqual(r.audit.filter((e) => e.action === 'tools_cut'), [{ stage: 'context', action: 'tools_cut', subject: 'tools', reason: 'over_call_budget' }]);
  assert.deepEqual(r.dependencies.mcp, { docs: { status: 'skipped', code: 'no_room', calls: 0 } });
  assert.deepEqual(r.dependencies.memory, { status: 'ok', code: 'ok', lines: 2 });
  // With room for both, the tools are offered and memory is shown in the same call.
  const roomy = deps({ files: [fileA], answers: [answerOnA], memory: memoryOf(answer), mcpServers: [fakeServer().server] });
  await review(own, roomy);
  assert.deepEqual(roomy.model.requests[0]!.tools, [submitReviewTool, docsSearch]);
  assert.deepEqual(roomy.model.requests[0]!.messages.slice(0, 2), [{ role: 'system', content: SYSTEM_WITH_TOOLS }, { role: 'user', content: parts.repository }]);
});

test('a memory that fails costs the review its memory, not the review', async () => {
  const plain = deps({ files: [fileA], answers: [answerOnA] });
  const expected = await review(own, plain);
  const rejecting: Memory = { blocks: () => Promise.reject(new Error('storage_unavailable')) };
  const throwing: Memory = { blocks: () => { throw new Error('It broke at 10.0.0.5!'); } };
  for (const [memory, code] of [[rejecting, 'storage_unavailable'], [throwing, 'lookup_failed']] as const) {
    const d = deps({ files: [fileA], answers: [answerOnA], memory });
    const r = await review(own, d);
    assert.equal(r.status, 'ok');
    assert.deepEqual(d.model.requests, plain.model.requests);
    assert.deepEqual(r.dependencies.memory, { status: 'error', code, lines: 0 });
    assert.deepEqual(r.audit.filter((e) => e.action.startsWith('memory_')), [{ stage: 'context', action: 'memory_failed', subject: 'memory', reason: code }]);
    assert.deepEqual(r.findings, expected.findings);
    assert.doesNotMatch(JSON.stringify(r), /10\.0\.0\.5|broke/);
  }
});

test('with a second scorer memory is not asked, and the scorer\'s requests are those of before', async () => {
  const memory = memoryOf(memoryAnswer(twoLines));
  const scorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const d = deps({ files: [fileA], answers: [answerOnA], scorer, memory });
  const r = await review(own, d);
  const plainScorer = scorerStub(() => ({ blocks: { B1: refunds } }));
  const plain = deps({ files: [fileA], answers: [answerOnA], scorer: plainScorer });
  const expected = await review(own, plain);
  assert.equal(memory.calls.length, 0);
  assert.deepEqual(r.dependencies.memory, { status: 'skipped', code: 'second_scorer', lines: 0 });
  assert.deepEqual(d.model.requests, plain.model.requests);
  assert.deepEqual(scorer.requests, plainScorer.requests);
  assert.deepEqual(withoutMemory(r), expected);
});

test('a review that calls no model asks no memory and says so', async () => {
  const memory = memoryOf(memoryAnswer(twoLines));
  const d = deps({ files: [binaryNoPatch], memory });
  const r = await review(own, d);
  assert.deepEqual([d.model.requests.length, memory.calls.length], [0, 0]);
  assert.deepEqual(r.dependencies.memory, { status: 'skipped', code: 'no_model_call', lines: 0 });
  const empty = await review(own, deps({ files: [], memory }));
  assert.equal(memory.calls.length, 0);
  assert.equal('memory' in empty.dependencies, false);
});

test('a review that ends before its files are packed says nothing of memory', async () => {
  const memory = memoryOf(memoryAnswer(twoLines));
  const listed = await review(own, deps({ files: [fileA], listError: new Error('github_500'), memory }));
  assert.equal(listed.status, 'failed');
  assert.equal('memory' in listed.dependencies, false);
  const small = await review({ ...own, limits: { ...own.limits, inputTokensPerCall: 10 } }, deps({ files: [fileA], memory }));
  assert.deepEqual(small.failure, { stage: 'context', code: 'budget_too_small' });
  assert.equal('memory' in small.dependencies, false);
  assert.equal(memory.calls.length, 0);
});

test('a second try and the halves of a split batch are sent the same memory', async () => {
  const answer = memoryAnswer(twoLines);
  const parts = memoryParts(contextOf(answer));
  const d = deps({ files: [fileA, fileB], answers: [new ProviderError('timeout', 't', null, null), answerOnA, answerOnB], memory: memoryOf(answer) });
  const r = await review(own, d);
  assert.equal(d.model.requests.length, 3);
  for (const q of d.model.requests) {
    assert.deepEqual(q.messages[1], { role: 'user', content: parts.repository });
    assert.equal(q.messages[2]!.content.endsWith(`\n${parts.pullRequest}`), true);
  }
  assert.deepEqual(r.coverage.reviewed, ['src/a.ts', 'src/b.ts']);
  // A first call offered tools and refused, then a second try without them: both are sent the memory.
  const tools = deps({ files: [fileA], answers: [new ProviderError('provider', 'p', 400, null), answerOnA], memory: memoryOf(answer), mcpServers: [fakeServer().server] });
  await review(own, tools);
  assert.equal(tools.model.requests.length, 2);
  assert.deepEqual(tools.model.requests.map((q) => q.tools.length), [2, 1]);
  for (const q of tools.model.requests) {
    assert.deepEqual(q.messages[1], { role: 'user', content: parts.repository });
    assert.equal(q.messages[2]!.content.endsWith(`\n${parts.pullRequest}`), true);
  }
});

test('memory changes no score by itself: with the same answers the scores are those of a review with no memory', async () => {
  const answer = memoryAnswer([memoryLine({ path: 'src/t.ts', ref: '8:file:src/t.ts', missed: true }), ...twoLines]);
  const scored = blockAnswer({ 'src/t.ts': 20 });
  const plain = await review(own, deps({ files: [fileT], answers: [scored] }));
  const d = deps({ files: [fileT], answers: [scored], memory: memoryOf(answer) });
  const r = await review(own, d);
  assert.ok(d.model.requests[0]!.messages[2]!.content.includes('changed | `src/t.ts` | 2026-03-10 | business_rule | missed'));
  assert.deepEqual(r.dependencies.memory, { status: 'ok', code: 'ok', lines: 3 });
  assert.deepEqual([r.scores, r.verdict], [plain.scores, plain.verdict]);
  assert.equal(r.verdict.needsHuman, false);
});

test('a failed review still says how memory did', async () => {
  const r = await review(own, deps({ files: [fileA], answers: [new ProviderError('auth', 'c', 401, null)], memory: memoryOf(memoryAnswer(twoLines)) }));
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.dependencies, { model: 'error', memory: { status: 'ok', code: 'ok', lines: 2 } });
});

test('in an incremental review memory is asked for the files that are sent, not for those an earlier review covers', async () => {
  const first = await firstOf([fileT, fileU], blockAnswer({ 'src/t.ts': 40, 'src/u.ts': 20 }));
  const memory = memoryOf(memoryAnswer(twoLines));
  const d = deps({ files: [fileT, valueFile('src/u.ts', 5)], answers: [blockAnswer({ 'src/u.ts': 30 })], memory });
  const r = await review({ ...own, mode: 'incremental', history: historyFrom(first, { covered: true, lastReview: LAST }) }, d);
  assert.equal(r.status, 'ok');
  assert.deepEqual(memory.calls.map(([files]) => files), [[{ path: 'src/u.ts', previousPath: null }]]);
  assert.deepEqual(r.dependencies.memory, { status: 'ok', code: 'ok', lines: 2 });
});

test('memory is fitted with the threads counted', async () => {
  const answer = memoryAnswer(twoLines, false);
  const thread = earlierThread({ resolved: false });
  const later = (inputTokensPerCall: number): ReviewInput => ({ ...limitsOf(inputTokensPerCall), earlier: { head: 'abcdef0', threads: [thread] } });
  const run = async (inputTokensPerCall: number, memory?: Memory) => {
    const d = withContent(deps({ files: [fileA], answers: [answerOnA], ...(memory === undefined ? {} : { memory }) }));
    return { r: await review(later(inputTokensPerCall), d), d };
  };
  // The smallest limit under which, with the thread shown and no memory, the file keeps its full contents.
  const keeps = async (n: number) => !(await run(n)).r.audit.some((e) => e.action === 'full_file_cut');
  let low = fixedTokens(CONTRACT, own.pullRequest, true);
  let high = low + 10_000;
  assert.ok(await keeps(high));
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await keeps(mid)) high = mid; else low = mid;
  }
  // One token short of the room memory needs with the threads counted; with them left out of the count it would fit.
  const edge = high + memoryTokens(answer) - 1;
  assert.ok(fixedTokens(CONTRACT, own.pullRequest, true) - fixedTokens(CONTRACT, own.pullRequest, false) >= 1);
  const plain = await run(edge);
  const { r, d } = await run(edge, memoryOf(answer));
  assert.ok(d.model.requests[0]!.messages[2]!.content.includes('### Thread T1'));
  assert.deepEqual(d.model.requests, plain.d.model.requests);
  assert.ok(d.model.requests[0]!.messages[2]!.content.includes('### Full file'));
  assert.deepEqual(r.dependencies.memory, { status: 'skipped', code: 'no_room', lines: 0 });
  assert.ok(r.audit.some((e) => e.action === 'memory_cut' && e.subject === 'memory'));
  // One token more and memory is shown, and the file keeps its contents.
  const shown = await run(edge + 1, memoryOf(answer));
  assert.deepEqual(shown.r.dependencies.memory, { status: 'ok', code: 'ok', lines: 2 });
  assert.ok(shown.d.model.requests[0]!.messages[1]!.content.includes(memoryParts(contextOf(answer)).pullRequest));
  assert.ok(shown.d.model.requests[0]!.messages[2]!.content.includes('### Full file'));
});

test('the stub answers each batch from its own files, whatever paths the memory names in the header', async () => {
  // The only line names src/b.ts: the header of both batches holds that path, and only the files' message tells them apart.
  const answer = memoryAnswer([memoryLine({ ref: '8:file:src/b.ts', path: 'src/b.ts' })]);
  const d = deps({ files: [fileA, fileB], answerFor: { 'src/a.ts': answerOnA, 'src/b.ts': answerOnB }, memory: memoryOf(answer) });
  const r = await review(await memoryRoom(answer, 1.5), d);
  assert.equal(d.model.requests.length, 2);
  assert.ok(d.model.requests.every((q) => q.messages[2]!.content.includes('changed | `src/b.ts`') && !q.messages[2]!.content.includes('src/a.ts')));
  assert.deepEqual(r.findings.map((f) => f.path), ['src/a.ts']);
  assert.deepEqual([r.overview.includes('src/a.ts has a problem.'), r.overview.includes('src/b.ts is fine.')], [true, true]);
});
