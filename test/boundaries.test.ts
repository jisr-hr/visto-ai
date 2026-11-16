import test from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

const lint = async (code: string, filePath: string) =>
  (await new ESLint().lintText(code, { filePath }))[0]!.messages.map((m) => m.ruleId);

test('the engine may not import the GitHub adapter', async () => {
  assert.ok((await lint("import '../forge/github/read-source.ts';\n", 'src/engine/x.ts')).includes('no-restricted-imports'));
});
test('the engine may not import node:fs', async () => {
  assert.ok((await lint("import 'node:fs';\n", 'src/engine/x.ts')).includes('no-restricted-imports'));
});
test('the engine may import forge types', async () => {
  assert.deepEqual(await lint("import type { Side } from '../forge/types.ts';\nexport type S = Side;\n", 'src/engine/x.ts'), []);
});
test('only the eval command line may import the GitHub adapter outside forge', async () => {
  assert.ok((await lint("import '../forge/github/read-source.ts';\n", 'src/eval/score.ts')).includes('no-restricted-imports'));
  assert.deepEqual(await lint("import '../forge/github/read-source.ts';\n", 'src/eval/cli.ts'), []);
});
