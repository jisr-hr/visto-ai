import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChangedFile, PullRequestInfo, Source } from '../types.ts';
import { packBatches } from './batches.ts';
import { buildFileContexts, hunksOf } from './build.ts';
import { blocksOf } from '../score/blocks.ts';
import { fileSection } from './section.ts';
import { reconcileScores } from '../reconcile/scores.ts';
import { parseRepoFile } from '../score/floors.ts';

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

test('hunksOf strips the patch, counts what it removed, and marks a hidden character on a changed line', () => {
  const out = hunksOf('@@ -1 +1 @@\n-a\n+a\u200b');
  assert.equal(out.text, '@@ -1 +1 @@\n-a\n+a');
  assert.equal(out.removed, 1);
  assert.equal(out.hidden, true);
  assert.deepEqual(out.hunks.map((h) => h.lines.map((l) => l.text)), [['a', 'a']]);
});
test('hunksOf: a hidden character on a removed line counts', () => {
  assert.equal(hunksOf('@@ -1 +1 @@\n-a\u202e\n+b').hidden, true);
});
test('hunksOf: a hidden character on a context line does not count, nor does a CRLF ending', () => {
  assert.equal(hunksOf('@@ -1,2 +1,2 @@\n a\u200b\n-b\n+c').hidden, false);
  assert.equal(hunksOf('@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r').hidden, false);
});

const renamedInDir = file('src/b.ts', { patch: null, status: 'renamed', previousPath: 'src/a.ts', additions: 0, deletions: 0 });
test('a rename inside its directory that differs only by a zero-width space is sent to the model, marked hidden', async () => {
  const { contexts } = await buildFileContexts(pr, [renamedInDir], stub({ 'base:src/a.ts': 'const s = "ab";\n', 'head:src/b.ts': 'const s = "a\u200bb";\n' }));
  assert.equal(contexts[0]!.skip, null);
  assert.deepEqual(contexts[0]!.plan, { kind: 'model' });
  assert.equal(contexts[0]!.hidden, true);
  assert.equal(contexts[0]!.blocks.length, 1);
});
test('a service patch whose added line holds a direction override is marked hidden', async () => {
  const { contexts } = await buildFileContexts(pr, [file('src/a.ts', { patch: '@@ -1 +1 @@\n-a\n+a\u202e' })], stub({ 'head:src/a.ts': 'a\n' }));
  assert.deepEqual([contexts[0]!.skip, contexts[0]!.plan, contexts[0]!.hidden], [null, { kind: 'model' }, true]);
});
test('a hidden character on a context line only does not mark the file', async () => {
  const { contexts } = await buildFileContexts(pr, [file('src/a.ts', { patch: '@@ -1,2 +1,2 @@\n k\u200b\n-a\n+b' })], stub({ 'head:src/a.ts': 'k\nb\n' }));
  assert.equal(contexts[0]!.hidden, false);
});
test('CRLF line endings are not hidden characters, and hash like LF', async () => {
  const crlf = await buildFileContexts(pr, [file('src/a.ts', { patch: '@@ -1 +1 @@\n-a\r\n+b\r' })], stub({ 'head:src/a.ts': 'b\r\n' }));
  const lf = await buildFileContexts(pr, [file('src/a.ts', { patch: '@@ -1 +1 @@\n-a\n+b' })], stub({ 'head:src/a.ts': 'b\n' }));
  assert.equal(crlf.contexts[0]!.hidden, false);
  assert.equal(crlf.contexts[0]!.blocks[0]!.hash, lf.contexts[0]!.blocks[0]!.hash);
  const computed = await buildFileContexts(pr, [file('src/a.ts', { patch: null })], stub({ 'base:src/a.ts': 'a\r\n', 'head:src/a.ts': 'b\r\n' }));
  assert.equal(computed.contexts[0]!.hidden, false);
  assert.equal(computed.contexts[0]!.blocks[0]!.hash, blocksOf(hunksOf('@@ -1 +1 @@\n-a\n+b').hunks)[0]!.hash);
});
test('a rename inside its directory with identical contents that start with a byte order mark is still unchanged', async () => {
  const { contexts } = await buildFileContexts(pr, [renamedInDir], stub({ 'base:src/a.ts': '\ufeffsame\n', 'head:src/b.ts': '\ufeffsame\n' }));
  assert.equal(contexts[0]!.skip, 'unchanged');
  assert.equal(contexts[0]!.hidden, false);
  assert.deepEqual(contexts[0]!.plan, { kind: 'rule', score: 30, source: 'rule_rename' });
});
test('a move to another directory that differs only by a zero-width space is scored by blocks, marked hidden', async () => {
  const { contexts } = await buildFileContexts(pr, [moved], stub({ 'base:src/a.ts': 'ab\n', 'head:app/pages/b.ts': 'a\u200bb\n' }));
  assert.deepEqual(contexts[0]!.plan, { kind: 'model' });
  assert.equal(contexts[0]!.hidden, true);
});

// Patches below are in the shape the git service sends: lines joined by a line feed, a file's
// carriage return kept at the end of each content line, none on the header, no line feed at the end.
const noNewline = '\\ No newline at end of file';
test('hunksOf: a CRLF file changed on its last line is not hidden', () => {
  assert.equal(hunksOf('@@ -1 +1 @@\n-a\r\n+b\r').hidden, false);
});
test('an added CRLF file whose patch ends on its last added line is not hidden and keeps its block score', async () => {
  const added = file('src/n.ts', { patch: '@@ -0,0 +1,3 @@\n+a\r\n+b\r\n+c\r', status: 'added', additions: 3, deletions: 0 });
  assert.equal(hunksOf(added.patch!).hidden, false);
  const { contexts } = await buildFileContexts(pr, [added], stub({}));
  const value = { overview: 'o', findings: [], files: [{ path: 'src/n.ts', change_summary: 's', blocks: [{ id: 'B1', score: 5, category: 'fix' }] }] };
  const [s] = reconcileScores([{ value, files: ['src/n.ts'] }], contexts, new Set(), parseRepoFile(null)).scores;
  assert.deepEqual([s!.finalScore, s!.covered], [5, true]);
});
test('hunksOf: a carriage return added on a last line with no line ending is hidden', () => {
  assert.equal(hunksOf(['@@ -1 +1 @@', '-exec app', noNewline, '+exec app\r', noNewline].join('\n')).hidden, true);
});
test('hunksOf: a zero-length line between a line ending in a carriage return and the marker keeps it hidden', () => {
  assert.equal(hunksOf(['@@ -1 +1 @@', '-exec app', '+exec app\r', '', noNewline].join('\n')).hidden, true);
});
test('hunksOf: an added line ending in two carriage returns is hidden', () => {
  assert.equal(hunksOf('@@ -1,2 +1,2 @@\n-a\r\n+a\r\r\n k\r').hidden, true);
});
test('hunksOf: a line that changes from LF to CRLF alone is not hidden', () => {
  assert.equal(hunksOf('@@ -1,2 +1,2 @@\n-a\n+a\r\n k').hidden, false);
});
test('hunksOf on a computed patch: any carriage return left on a changed line is hidden', () => {
  assert.equal(hunksOf('@@ -1 +1 @@\n-a\n+b\r', true).hidden, true);
  assert.equal(hunksOf('@@ -1 +1 @@\n-a\n+b', true).hidden, false);
});
for (const computed of [false, true]) {
  test(`hunksOf: U+200B and U+202E on an added line are hidden (computed ${computed})`, () => {
    assert.equal(hunksOf('@@ -1 +1 @@\n-a\n+a\u200b', computed).hidden, true);
    assert.equal(hunksOf('@@ -1 +1 @@\n-a\n+a\u202e', computed).hidden, true);
  });
}
test('a computed diff where a line gains a carriage return in its text is hidden', async () => {
  const { contexts } = await buildFileContexts(pr, [file('src/a.ts', { patch: null })], stub({ 'base:src/a.ts': 'ab\n', 'head:src/a.ts': 'a\rb\n' }));
  assert.equal(contexts[0]!.hidden, true);
});
test('a computed diff where a line ending goes from LF to CR CR LF is hidden', async () => {
  const { contexts } = await buildFileContexts(pr, [file('src/a.ts', { patch: null })], stub({ 'base:src/a.ts': 'a\nb\n', 'head:src/a.ts': 'a\r\r\nb\n' }));
  assert.equal(contexts[0]!.hidden, true);
});
test('a computed diff of two contents equal apart from LF against CRLF is unchanged', async () => {
  const { contexts } = await buildFileContexts(pr, [file('src/a.ts', { patch: null })], stub({ 'base:src/a.ts': 'a\nb\n', 'head:src/a.ts': 'a\r\nb\r\n' }));
  assert.equal(contexts[0]!.skip, 'unchanged');
  assert.equal(contexts[0]!.hidden, false);
});
