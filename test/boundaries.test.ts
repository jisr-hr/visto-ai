import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
test('no part of the MCP client but the header names may be imported outside the mcp part and the service entry', async () => {
  for (const target of ['client.ts', 'rpc.ts', 'sse.ts', 'x/y.ts']) {
    for (const [file, prefix] of [['src/service.ts', './mcp/'], ['src/shell/x.ts', '../mcp/'], ['src/config/x.ts', '../mcp/'], ['src/extensions/x.ts', '../mcp/'],
      ['src/forge/github/x.ts', '../../mcp/'], ['src/db/x.ts', '../mcp/'], ['src/gate/x.ts', '../mcp/']] as const) {
      assert.ok((await lint(`import '${prefix}${target}';\n`, file)).includes('no-restricted-imports'), `${file} ${target}`);
    }
  }
  assert.deepEqual(await lint("import { SET_BY_SERVICE } from '../mcp/headers.ts';\nexport const s = SET_BY_SERVICE;\n", 'src/config/x.ts'), []);
  for (const target of ['./mcp/client.ts', './mcp/rpc.ts']) assert.deepEqual(await lint(`import '${target}';\n`, 'src/main.ts'), [], target);
});
test('the mcp part imports nothing of the project but types of the engine and the config, and its own files', async () => {
  const file = 'src/mcp/x.ts';
  const refused = [
    "import '../shell/alerts.ts';\n", "import '../db/types.ts';\n", "import '../extensions/load.ts';\n", "import '../service.ts';\n",
    "import '../main.ts';\n", "import '../engine/review.ts';\n", "import '../engine/context/untrusted.ts';\n", "import '../forge/github/read-source.ts';\n",
    "import { GATE_OFF } from '../config/load.ts';\nexport const g = GATE_OFF;\n", "import { NOT_A_TYPE } from '../engine/types.ts';\nexport const n = NOT_A_TYPE;\n",
    "import 'pg';\n",
  ];
  for (const code of refused) {
    const ids = await lint(code, file);
    assert.ok(ids.some((id) => id !== null && id.endsWith('no-restricted-imports')), code);
  }
  const allowed = [
    "import type { McpServer } from '../engine/types.ts';\nexport type S = McpServer;\n",
    "import type { McpServerConfig } from '../config/load.ts';\nexport type C = McpServerConfig;\n",
    "import { eventData } from './sse.ts';\nexport const e = eventData;\n",
    "import { setFlagsFromString } from 'node:v8';\nexport const f = setFlagsFromString;\n",
  ];
  for (const code of allowed) assert.deepEqual(await lint(code, file), [], code);
  // a test file of the part may also run a review end to end: the engine's review and its submit tool, and nothing more
  for (const target of ['../engine/review.ts', '../engine/model/submit-review.ts']) {
    assert.deepEqual(await lint(`import '${target}';\n`, 'src/mcp/x.test.ts'), [], target);
    const ids = await lint(`import '${target}';\n`, file);
    assert.ok(ids.some((id) => id !== null && id.endsWith('no-restricted-imports')), target);
  }
  for (const code of ["import '../main.ts';\n", "import '../db/types.ts';\n", "import '../engine/model/call.ts';\n"]) {
    const ids = await lint(code, 'src/mcp/x.test.ts');
    assert.ok(ids.some((id) => id !== null && id.endsWith('no-restricted-imports')), code);
  }
});
test('the header names are a leaf: headers.ts imports nothing', () => {
  const text = readFileSync(join(import.meta.dirname, '..', 'src', 'mcp', 'headers.ts'), 'utf8');
  assert.equal(/^\s*import\b|\bimport\s*\(|\brequire\s*\(/m.test(text), false);
});
test('the engine may not import the memory part, and may import its own memory file', async () => {
  assert.ok((await lint("import '../memory/select.ts';\n", 'src/engine/x.ts')).includes('no-restricted-imports'));
  assert.ok((await lint("import '../../memory/select.ts';\n", 'src/engine/context/x.ts')).includes('no-restricted-imports'));
  assert.deepEqual(await lint("import './memory.ts';\n", 'src/engine/context/x.ts'), []);
  assert.deepEqual(await lint("import '../context/memory.ts';\n", 'src/engine/score/x.ts'), []);
});
test('the memory part imports nothing of the database, the shell, the eval, the adapters or the network', async () => {
  const file = 'src/memory/x.ts';
  const refused = [
    '../db/types.ts', '../shell/receive.ts', '../eval/score.ts', '../forge/github/read-source.ts', '../gate/x.ts', '../extensions/load.ts',
    '../mcp/client.ts', '../mcp/headers.ts', '../main.ts', '../service.ts', 'node:fs', 'fs', 'node:net', 'node:http', 'pg', '@electric-sql/pglite',
  ];
  for (const target of refused) {
    assert.ok((await lint(`import '${target}';\n`, file)).includes('no-restricted-imports'), target);
    assert.ok((await lint(`import '${target}';\n`, 'src/memory/x.test.ts')).includes('no-restricted-imports'), `test ${target}`);
  }
  assert.ok((await lint("export const m = import('node:fs');\n", file)).includes('no-restricted-syntax'));
  const allowed = [
    "import type { Memory } from '../engine/types.ts';\nexport type M = Memory;\n",
    "import { MEMORY_NAME } from '../engine/context/memory.ts';\nexport const n = MEMORY_NAME;\n",
    "import type { Side } from '../forge/types.ts';\nexport type S = Side;\n",
    "import { other } from './other.ts';\nexport const o = other;\n",
  ];
  for (const code of allowed) assert.deepEqual(await lint(code, file), [], code);
});
test('the eval imports nothing of the database, except its command line, the seed and the seed\'s test', async () => {
  for (const [file, target] of [['src/eval/backtest/x.ts', '../../db/types.ts'], ['src/eval/cli.test.ts', '../db/testing.ts'], ['src/eval/x.ts', '../db/memory-records.ts']] as const) {
    assert.ok((await lint(`import '${target}';\n`, file)).includes('no-restricted-imports'), file);
  }
  for (const [file, target] of [['src/eval/cli.ts', '../db/postgres.ts'], ['src/eval/history/seed.ts', '../../db/types.ts'], ['src/eval/history/seed.test.ts', '../../db/testing.ts']] as const) {
    assert.deepEqual(await lint(`import '${target}';\n`, file), [], file);
  }
  // the seed and its test keep the eval's other restrictions
  for (const file of ['src/eval/history/seed.ts', 'src/eval/history/seed.test.ts']) {
    for (const target of ['../../forge/github/read-source.ts', '../../mcp/client.ts', '../../main.ts', 'pg']) {
      assert.ok((await lint(`import '${target}';\n`, file)).includes('no-restricted-imports'), `${file} ${target}`);
    }
  }
});
