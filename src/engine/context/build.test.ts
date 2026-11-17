import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChangedFile, PullRequestInfo, Source } from '../types.ts';
import { packBatches } from './batches.ts';
import { buildFileContexts } from './build.ts';
import { fileSection } from './section.ts';

const pr: PullRequestInfo = {
  ref: { service: 'github', owner: 'acme', repo: 'shop', number: 1 },
  title: 't', description: '', author: 'dev-one',
  baseBranch: 'main', headBranch: 'feature', baseSha: 'base', headSha: 'head', draft: false,
};

function file(path: string, over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path, previousPath: null, status: 'modified', additions: 1, deletions: 1,
    patch: '@@ -1 +1 @@\n-a\n+b', ...over,
  };
}

function stub(record: Record<string, string | null>): Source & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listFiles: async () => [],
    getDefaultBranchFile: async () => null,
    getFileContent: async (_pr, path, sha) => {
      const key = `${sha}:${path}`;
      calls.push(key);
      return record[key] ?? null;
    },
  };
}

const allPresent = new Proxy({} as Record<string, string | null>, { get: () => 'x\n' });

test('a missing patch is computed from the two contents', async () => {
  const { contexts } = await buildFileContexts(pr, [file('src/a.ts', { patch: null })], stub({ 'base:src/a.ts': 'x\n', 'head:src/a.ts': 'y\n' }));
  assert.deepEqual(contexts[0]!.ranges, { RIGHT: [[1, 1]], LEFT: [[1, 1]] });
});
test('a missing patch with binary or absent content leaves the file uncommentable', async () => {
  const { contexts } = await buildFileContexts(pr, [file('logo.bin', { patch: null })], stub({}));
  assert.equal(contexts[0]!.ranges, null);
  assert.equal(contexts[0]!.diffText, null);
});
test('an added file with no patch fetches only the head', async () => {
  const source = stub({ 'head:src/n.ts': 'y\n' });
  const { contexts } = await buildFileContexts(pr, [file('src/n.ts', { patch: null, status: 'added' })], source);
  assert.deepEqual(contexts[0]!.ranges, { RIGHT: [[1, 1]], LEFT: [] });
  assert.ok(!source.calls.includes('base:src/n.ts'));
});
test('a removed file with no patch has no diff', async () => {
  const { contexts } = await buildFileContexts(pr, [file('src/gone.ts', { patch: null, status: 'removed' })], stub(allPresent));
  assert.equal(contexts[0]!.ranges, null);
  assert.equal(contexts[0]!.full, null);
  assert.equal(contexts[0]!.test, null);
});
test('a removed or low-priority file gets no full-file context', async () => {
  const { contexts } = await buildFileContexts(pr, [file('src/gone.ts', { status: 'removed' }), file('docs/x.md')], stub(allPresent));
  assert.deepEqual(contexts.map((c) => c.full), [null, null]);
});
test('the head content becomes the full file', async () => {
  const { contexts } = await buildFileContexts(pr, [file('src/a.ts')], stub({ 'head:src/a.ts': 'b\n' }));
  assert.equal(contexts[0]!.full!.kind, 'full');
});
test('the paired test is attached, and skipped when it is itself changed', async () => {
  const s = { 'head:src/a.ts': 'x\n', 'head:src/a.test.ts': 't\n' };
  const one = await buildFileContexts(pr, [file('src/a.ts')], stub(s));
  assert.equal(one.contexts[0]!.test!.path, 'src/a.test.ts');
  assert.match(one.contexts[0]!.test!.text, /^ +1\| t/);
  const both = await buildFileContexts(pr, [file('src/a.ts'), file('src/a.test.ts')], stub(s));
  assert.equal(both.contexts.find((c) => c.file.path === 'src/a.ts')!.test, null);
});
test('contents are never fetched twice and test probes stop at 20', async () => {
  const source = stub({});
  await buildFileContexts(pr, Array.from({ length: 30 }, (_, i) => file(`src/f${i}.ts`)), source);
  assert.equal(source.calls.filter((k) => /\.(test|spec)\.ts$/.test(k)).length, 20);
  assert.equal(new Set(source.calls).size, source.calls.length);
});
test('a content fetched for the diff is reused for the full file', async () => {
  const source = stub({ 'base:src/a.ts': 'x\n', 'head:src/a.ts': 'y\n' });
  await buildFileContexts(pr, [file('src/a.ts', { patch: null })], source);
  assert.equal(source.calls.filter((k) => k === 'head:src/a.ts').length, 1);
});
test('stripped control characters are audited', async () => {
  const { audit } = await buildFileContexts(pr, [file('src/a.ts', { patch: '@@ -1 +1 @@\n-a\n+b\u202e' })], stub({ 'head:src/a.ts': 'b\n' }));
  assert.deepEqual(audit, [{ stage: 'context', action: 'control_characters_stripped', subject: 'src/a.ts', reason: '1' }]);
});
test('control characters in head content and in a paired test are audited separately', async () => {
  const { audit } = await buildFileContexts(pr, [file('src/a.ts')], stub({ 'head:src/a.ts': 'b\u200b\n', 'head:src/a.test.ts': 't\u202e\u202e\n' }));
  assert.deepEqual(audit, [
    { stage: 'context', action: 'control_characters_stripped', subject: 'src/a.test.ts', reason: '2' },
    { stage: 'context', action: 'control_characters_stripped', subject: 'src/a.ts', reason: '1' },
  ]);
});
test('control characters in the head of a low-priority file with no patch are audited once', async () => {
  const { audit, contexts } = await buildFileContexts(pr, [file('docs/x.md', { patch: null })], stub({ 'base:docs/x.md': 'x\n', 'head:docs/x.md': 'y\u200b\n' }));
  assert.notEqual(contexts[0]!.ranges, null);
  assert.deepEqual(audit, [{ stage: 'context', action: 'control_characters_stripped', subject: 'docs/x.md', reason: '1' }]);
});
test('a renamed file with identical contents has no diff', async () => {
  const source = stub({ 'base:src/old.ts': 'same\n', 'head:src/new.ts': 'same\n', 'head:src/new.test.ts': 't\n' });
  const { contexts } = await buildFileContexts(pr, [file('src/new.ts', { patch: null, status: 'renamed', previousPath: 'src/old.ts' })], source);
  assert.ok(source.calls.includes('base:src/old.ts'));
  assert.deepEqual([contexts[0]!.ranges, contexts[0]!.diffText, contexts[0]!.full, contexts[0]!.test], [null, null, null, null]);
  assert.equal(contexts[0]!.skip, 'unchanged');
});
test('an empty given patch has no diff', async () => {
  const { contexts } = await buildFileContexts(pr, [file('src/a.ts', { patch: '' })], stub(allPresent));
  assert.deepEqual([contexts[0]!.ranges, contexts[0]!.diffText, contexts[0]!.full, contexts[0]!.test], [null, null, null, null]);
  assert.equal(contexts[0]!.skip, 'unchanged');
});
test('skip is null for a file with a diff, no_diff for one with no patch and no content', async () => {
  const { contexts } = await buildFileContexts(
    pr,
    [file('src/a.ts'), file('logo.bin', { patch: null }), file('src/gone.ts', { patch: null, status: 'removed' })],
    stub({ 'head:src/a.ts': 'b\n' }),
  );
  assert.deepEqual(contexts.map((c) => [c.file.path, c.skip]), [['src/a.ts', null], ['src/gone.ts', 'no_diff'], ['logo.bin', 'no_diff']]);
});
const manyLines = (count: number, prefix: string): string => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join('\n') + '\n';
test('a patch that cannot be computed within the bound is too_large', async () => {
  const source = stub({ 'base:src/big.ts': manyLines(6000, 'old'), 'head:src/big.ts': manyLines(6000, 'new') });
  const { contexts } = await buildFileContexts(pr, [file('src/big.ts', { patch: null })], source);
  assert.deepEqual([contexts[0]!.skip, contexts[0]!.ranges, contexts[0]!.full], ['too_large', null, null]);
});
test('control characters stripped from the base content count toward the file', async () => {
  const { audit } = await buildFileContexts(pr, [file('src/a.ts', { patch: null })], stub({ 'base:src/a.ts': 'x\u200b\u00ad\n', 'head:src/a.ts': 'y\u200b\n' }));
  assert.deepEqual(audit, [{ stage: 'context', action: 'control_characters_stripped', subject: 'src/a.ts', reason: '3' }]);
});
test('a failed probe for a paired test is audited and the file has no test', async () => {
  const source = stub({ 'head:src/a.ts': 'x\n' });
  const inner = source.getFileContent;
  source.getFileContent = async (p, path, sha) => {
    if (path === 'src/a.test.ts') throw new Error('github_502');
    if (path === 'src/a.spec.ts') throw new Error('Something long went wrong');
    return inner(p, path, sha);
  };
  const { contexts, audit } = await buildFileContexts(pr, [file('src/a.ts')], source);
  assert.equal(contexts[0]!.test, null);
  assert.notEqual(contexts[0]!.ranges, null);
  assert.deepEqual(audit, [
    { stage: 'context', action: 'test_probe_failed', subject: 'src/a.test.ts', reason: 'github_502' },
    { stage: 'context', action: 'test_probe_failed', subject: 'src/a.spec.ts', reason: 'source_error' },
  ]);
});
test('a failure fetching the file own content still fails', async () => {
  const source = stub({});
  source.getFileContent = async () => { throw new Error('github_502'); };
  await assert.rejects(buildFileContexts(pr, [file('src/a.ts', { patch: null })], source), { message: 'github_502' });
  await assert.rejects(buildFileContexts(pr, [file('src/a.ts')], source), { message: 'github_502' });
});
test('blocks and plan are set, and a block is the same object in the context', async () => {
  const { contexts } = await buildFileContexts(pr, [file('src/a.ts')], stub({ 'head:src/a.ts': 'b\n' }));
  assert.deepEqual(contexts[0]!.blocks.map((b) => b.id), ['B1']);
  assert.deepEqual(contexts[0]!.plan, { kind: 'model' });
  assert.deepEqual(packBatches(contexts, 100000, 6).batches[0]!.files[0]!.blocks, contexts[0]!.blocks);
  assert.equal(packBatches(contexts, 100000, 6).batches[0]!.files[0]!.blocks[0], contexts[0]!.blocks[0]);
});
test('a file with a diff says a whole-file score is allowed', async () => {
  const { contexts } = await buildFileContexts(pr, [file('src/a.ts')], stub({ 'head:src/a.ts': 'b\n' }));
  const section = fileSection(contexts[0]!, 1, 1, 'tok');
  assert.match(section, /deletions: 1\nwhole-file score: allowed\n/);
});
const moved = file('app/pages/b.ts', { patch: null, status: 'renamed', previousPath: 'src/a.ts', additions: 0, deletions: 0 });
test('a file moved to another directory with the same content is sent with no diff and a required whole-file score', async () => {
  const { contexts } = await buildFileContexts(pr, [moved], stub({ 'base:src/a.ts': 'same\n', 'head:app/pages/b.ts': 'same\n' }));
  assert.deepEqual(contexts[0]!.plan, { kind: 'model_whole' });
  assert.equal(contexts[0]!.skip, 'unchanged');
  const section = fileSection(contexts[0]!, 1, 1, 'tok');
  assert.match(section, /deletions: 0\nprevious path: src\/a\.ts\nwhole-file score: required\. The file moved to another directory and its content did not change\. Score the move itself\./);
  assert.doesNotMatch(section, /<<<data/);
  assert.doesNotMatch(section, /Full file|Paired test/);
  const packed = packBatches(contexts, 100000, 6);
  assert.equal(packed.batches[0]!.files.length, 1);
  assert.deepEqual([packed.notReviewed, packed.audit], [[], []]);
});
test('a rename inside its directory is scored by rule: not packed, not listed, one audit entry', async () => {
  const renamed = file('src/b.ts', { patch: null, status: 'renamed', previousPath: 'src/a.ts', additions: 0, deletions: 0 });
  const { contexts } = await buildFileContexts(pr, [renamed], stub({ 'base:src/a.ts': 'same\n', 'head:src/b.ts': 'same\n' }));
  const { batches, notReviewed, audit } = packBatches(contexts, 100000, 6);
  assert.deepEqual([batches, notReviewed], [[], []]);
  assert.deepEqual(audit, [{ stage: 'context', action: 'scored_by_rule', subject: 'src/b.ts', reason: 'rule_rename' }]);
});
test('an image with no text diff is scored by rule and not listed as not reviewed', async () => {
  const { contexts } = await buildFileContexts(pr, [file('img/logo.png', { patch: null, status: 'added' })], stub({}));
  const { batches, notReviewed, audit } = packBatches(contexts, 100000, 6);
  assert.deepEqual([batches, notReviewed], [[], []]);
  assert.deepEqual(audit, [{ stage: 'context', action: 'scored_by_rule', subject: 'img/logo.png', reason: 'rule_asset' }]);
});
