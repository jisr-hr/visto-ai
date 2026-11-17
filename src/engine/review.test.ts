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
    getDefaultBranchFile: () => Promise.resolve(null),
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
  assert.equal(r.verdict.needsHuman, r.scores[0]!.finalScore >= 70);
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
});
