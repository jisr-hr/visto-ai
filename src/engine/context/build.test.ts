import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChangedFile, PullRequestInfo, Source } from '../types.ts';
import { buildFileContexts } from './build.ts';

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
});
test('an empty given patch has no diff', async () => {
  const { contexts } = await buildFileContexts(pr, [file('src/a.ts', { patch: '' })], stub(allPresent));
  assert.deepEqual([contexts[0]!.ranges, contexts[0]!.diffText, contexts[0]!.full, contexts[0]!.test], [null, null, null, null]);
});
