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
test('the engine may not import bare fs', async () => {
  assert.ok((await lint("import 'fs';\n", 'src/engine/x.ts')).includes('no-restricted-imports'));
});
test('the engine may not import node:tls', async () => {
  assert.ok((await lint("import 'node:tls';\n", 'src/engine/x.ts')).includes('no-restricted-imports'));
});
test('the engine may not import the GitHub adapter dynamically', async () => {
  assert.ok((await lint("export const m = import('../forge/github/read-source.ts');\n", 'src/engine/x.ts')).includes('no-restricted-syntax'));
});
test('the engine may not import from eval', async () => {
  assert.ok((await lint("import '../eval/score.ts';\n", 'src/engine/x.ts')).includes('no-restricted-imports'));
});
test('the engine may import forge types', async () => {
  assert.deepEqual(await lint("import type { Side } from '../forge/types.ts';\nexport type S = Side;\n", 'src/engine/x.ts'), []);
});
test('only the eval command line may import the GitHub adapter outside forge', async () => {
  assert.ok((await lint("import '../forge/github/read-source.ts';\n", 'src/eval/score.ts')).includes('no-restricted-imports'));
  assert.deepEqual(await lint("import '../forge/github/read-source.ts';\n", 'src/eval/cli.ts'), []);
});
test('only the db part may import a Postgres client', async () => {
  for (const name of ['pg', '@electric-sql/pglite']) {
    assert.ok((await lint(`import '${name}';\n`, 'src/shell/x.ts')).includes('no-restricted-imports'), name);
    assert.ok((await lint(`import '${name}';\n`, 'src/forge/github/x.ts')).includes('no-restricted-imports'), name);
    assert.deepEqual(await lint(`import '${name}';\n`, 'src/db/x.ts'), [], name);
  }
});
test('the engine may not import the db or the shell', async () => {
  assert.ok((await lint("import '../db/types.ts';\n", 'src/engine/x.ts')).includes('no-restricted-imports'));
  assert.ok((await lint("import '../shell/receive.ts';\n", 'src/engine/x.ts')).includes('no-restricted-imports'));
});
test('the shell may not import the GitHub adapter, and the service entry may', async () => {
  assert.ok((await lint("import '../forge/github/webhook.ts';\n", 'src/shell/x.ts')).includes('no-restricted-imports'));
  assert.deepEqual(await lint("import './forge/github/webhook.ts';\n", 'src/main.ts'), []);
});
test('the --import flag reaches test processes: fetch is blocked without importing setup', async () => {
  await assert.rejects(fetch('https://example.com'), (error: Error) => error.name === 'NetworkBlockedError');
});
test('the db part may not import from the engine', async () => {
  assert.ok((await lint("import '../engine/x.ts';\n", 'src/db/x.ts')).includes('no-restricted-imports'));
  assert.deepEqual(await lint("import '../forge/types.ts';\n", 'src/db/x.ts'), []);
});
test('the gate may not import the GitHub adapter or a Postgres client', async () => {
  assert.ok((await lint("import '../forge/github/read-source.ts';\n", 'src/gate/x.ts')).includes('no-restricted-imports'));
  for (const name of ['pg', '@electric-sql/pglite']) {
    assert.ok((await lint(`import '${name}';\n`, 'src/gate/x.ts')).includes('no-restricted-imports'), name);
  }
});
test('the extensions part may not import the GitHub adapter or a Postgres client', async () => {
  assert.ok((await lint("import '../forge/github/read-source.ts';\n", 'src/extensions/x.ts')).includes('no-restricted-imports'));
  for (const name of ['pg', '@electric-sql/pglite']) {
    assert.ok((await lint(`import '${name}';\n`, 'src/extensions/x.ts')).includes('no-restricted-imports'), name);
  }
});
test('the engine may not import the extensions part', async () => {
  assert.ok((await lint("import '../extensions/load.ts';\n", 'src/engine/x.ts')).includes('no-restricted-imports'));
});
test('the engine may not import the mcp part', async () => {
  assert.ok((await lint("import '../mcp/client.ts';\n", 'src/engine/x.ts')).includes('no-restricted-imports'));
});
test('the mcp part may not import the GitHub adapter or a Postgres client', async () => {
  assert.ok((await lint("import '../forge/github/read-source.ts';\n", 'src/mcp/x.ts')).includes('no-restricted-imports'));
  for (const name of ['pg', '@electric-sql/pglite']) {
    assert.ok((await lint(`import '${name}';\n`, 'src/mcp/x.ts')).includes('no-restricted-imports'), name);
  }
});
test('the eval may not import the mcp part or the service entry, its command line included', async () => {
  for (const file of ['src/eval/x.ts', 'src/eval/cli.ts', 'src/eval/backtest/x.ts']) {
    const up = file.split('/').length - 2;
    const prefix = '../'.repeat(up);
    for (const target of ['mcp/client.ts', 'mcp/headers.ts', 'main.ts']) {
      assert.ok((await lint(`import '${prefix}${target}';\n`, file)).includes('no-restricted-imports'), `${file} ${target}`);
    }
  }
});
test('the MCP client may be imported only by the service entry and by the mcp part', async () => {
  const refused: Array<[string, string]> = [
    ['src/service.ts', './mcp/client.ts'], ['src/shell/x.ts', '../mcp/client.ts'], ['src/config/x.ts', '../mcp/client.ts'],
    ['src/extensions/x.ts', '../mcp/client.ts'], ['src/forge/github/x.ts', '../../mcp/client.ts'], ['src/db/x.ts', '../mcp/client.ts'],
    ['src/engine/x.ts', '../mcp/client.ts'],
  ];
  for (const [file, target] of refused) {
    assert.ok((await lint(`import '${target}';\n`, file)).includes('no-restricted-imports'), file);
  }
  assert.deepEqual(await lint("import './mcp/client.ts';\n", 'src/main.ts'), []);
  assert.deepEqual(await lint("import './client.ts';\n", 'src/mcp/x.ts'), []);
  assert.deepEqual(await lint("import '../mcp/headers.ts';\n", 'src/config/x.ts'), []);
});
test('the mcp part may not import the service entry', async () => {
  assert.ok((await lint("import '../main.ts';\n", 'src/mcp/x.ts')).includes('no-restricted-imports'));
  assert.ok((await lint("import '../main.ts';\n", 'src/mcp/x.test.ts')).includes('no-restricted-imports'));
});
