import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readYaml, parseDocument } from './load.ts';
import type { DeploymentConfig } from './load.ts';
import {
  AT_START, DEFAULTS, GLOBAL, GLOBAL_PATHS, REPOSITORY_PATHS, REPOSITORY_SCOPE, canonical, editableOf, exportText, filePathOf, inForceEditable,
  isSetting, keyParts, sameValue, scorerOn, secretsOf, settingKey, settingOfIssue, shownValues, withEditable,
} from './editable.ts';
import type { Editable, SettingValue } from './editable.ts';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const ENV = {
  OPENROUTER_API_KEY: 'model-key-for-tests-only', SCORER_API_KEY: 'scorer-key-for-tests-only', AUDIT_KEY: 'audit-key-for-tests-only-0123456789abcdef',
  WEBHOOK_SECRET: 'webhook-secret-for-tests-only', DATABASE_URL: 'postgres://visto:db-password-for-tests@db.example.test/visto', APP_PRIVATE_KEY: PEM,
  ALERT_WEBHOOK_URL: 'https://alerts.example.test/in/abc', EXAMPLE_FEEDBACK_SECRET: 'feedback-secret-for-tests', DOCS_MCP_AUTHORIZATION: 'Bearer docs-token-for-tests',
};

const example = (): string => readFileSync(new URL('../../config.example.yml', import.meta.url), 'utf8');

// Removes the "# " after the indent of `first` from that line and from the commented lines that follow it at that indent.
function uncomment(text: string, first: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(first);
  assert.notEqual(start, -1, first);
  const indent = first.slice(0, first.indexOf('#'));
  for (let i = start; i < lines.length && lines[i]!.startsWith(`${indent}#`); i += 1) {
    lines[i] = indent + lines[i]!.slice(indent.length).replace(/^# ?/, '');
  }
  return lines.join('\n');
}

const keysOf = (e: Editable): string[] => [...e.keys()].sort();
const sameEditable = (a: Editable, b: Editable): boolean => {
  const ka = keysOf(a);
  return JSON.stringify(ka) === JSON.stringify(keysOf(b)) && ka.every((k) => sameValue(a.get(k), b.get(k)));
};
const withKeys = (e: Editable, ...entries: Array<[string, SettingValue]>): Editable => new Map([...e, ...entries]);

test('the editable part of a file is every setting it writes, by scope and path, and none it does not', () => {
  const doc = readYaml(example());
  const e = editableOf(doc);
  const global = keysOf(e).filter((k) => k.startsWith('global:'));
  assert.deepEqual(global, [
    'dryRun', 'learning', 'limits.batchesPerReview', 'limits.inputTokensPerCall', 'limits.queueConcurrency', 'limits.spendPerDay',
    'model.effort.default', 'model.effort.elevated', 'model.extraBody', 'model.extraHeaders', 'model.fallbacks', 'model.model', 'model.prices',
    'model.timeoutSeconds', 'model.toolChoice',
  ].map((p) => `global:${p}`).sort());
  assert.deepEqual(keysOf(e).filter((k) => k.startsWith('defaults:')), ['defaults:baseBranches', 'defaults:ignoredAuthors', 'defaults:primaryBranches']);
  assert.deepEqual(e.get('acme/shop:primaryBranches'), ['trunk']);
  assert.deepEqual(e.get('acme/shop:baseBranches'), ['trunk']);
  assert.equal(e.get('acme/shop:score.threshold'), 60);
  assert.equal(e.get('global:model.prices'), null);
  assert.equal(e.get('global:limits.spendPerDay'), 50);
  assert.deepEqual(e.get('global:model.effort.elevated'), { reasoning: { effort: 'high' } });
  for (const k of e.keys()) assert.ok(isSetting(keyParts(k).scope, keyParts(k).path), k);
  for (const word of ['apiKey', 'app', 'database', 'ui']) assert.ok(![...e.keys()].some((k) => k.includes(word)), word);
});

test('an override key is lower-cased, and one that names no repository is dropped', () => {
  const full = 'full';
  const e = editableOf({ repositories: { overrides: { 'Acme/Web': { newHead: full }, acme: { newHead: full }, ' acme/x': { newHead: full } } } });
  assert.deepEqual([...e.keys()], ['acme/web:newHead']);
  assert.equal(e.get('acme/web:newHead'), full);
});

test('the lists, the start-time paths and the keys of a scope are as the design has them', () => {
  assert.equal(GLOBAL_PATHS.length, 17);
  assert.equal(REPOSITORY_PATHS.length, 16);
  assert.ok([...AT_START].every((p) => GLOBAL_PATHS.includes(p)));
  assert.equal(AT_START.size, 5);
  assert.equal(settingKey('acme/shop.js', 'gate.mode'), 'acme/shop.js:gate.mode');
  assert.deepEqual(keyParts('acme/shop.js:gate.mode'), { scope: 'acme/shop.js', path: 'gate.mode' });
  assert.ok(isSetting(GLOBAL, 'dryRun') && !isSetting(GLOBAL, 'newHead') && !isSetting(GLOBAL, 'model.apiKey'));
  for (const path of ['model.baseUrl', 'scorer.baseUrl']) assert.ok(!isSetting(GLOBAL, path) && !GLOBAL_PATHS.includes(path) && !AT_START.has(path), path);
  assert.ok(isSetting(DEFAULTS, 'newHead') && !isSetting(DEFAULTS, 'dryRun') && isSetting('acme/web', 'gate.mode') && !isSetting('Acme/Web', 'gate.mode'));
  assert.ok(REPOSITORY_SCOPE.test('acme/shop.js') && !REPOSITORY_SCOPE.test('acme'));
  assert.equal(filePathOf(GLOBAL, 'learning'), 'learning');
  assert.equal(filePathOf(DEFAULTS, 'score.threshold'), 'repositories.defaults.score.threshold');
  assert.equal(filePathOf('acme/shop', 'gate.mode'), 'repositories.overrides.acme/shop.gate.mode');
});

test('a document with its editable part put back checks as the file does, and keeps every key config.yml alone holds', () => {
  const text = uncomment(uncomment(example(), '# app:'), '# extensions:');
  const doc = { ...(readYaml(text) as object), ui: { publicUrl: 'https://visto.example.test' } };
  const before = structuredClone(doc);
  const back = withEditable(doc, editableOf(doc));
  assert.deepEqual(parseDocument(back, ENV), parseDocument(doc, ENV));
  assert.deepEqual(doc, before);
  const changed = parseDocument(withEditable(doc, withKeys(editableOf(doc), ['defaults:score.threshold', 55])), ENV);
  assert.equal(changed.repositories.defaults.scoreThreshold, 55);
  const loaded = parseDocument(doc, ENV);
  for (const key of ['app', 'database', 'ui', 'extensions', 'server', 'alerts'] as const) assert.deepEqual(changed[key], loaded[key]);

  const withScorer = { ...(doc as object), scorer: { apiKey: { env: 'SCORER_API_KEY' }, model: 'vendor/decision-model' }, repositories: { defaults: { score: { threshold: 65 } } } };
  const plain = withEditable(withScorer, new Map<string, SettingValue>([['global:model.model', 'm'], ['defaults:score.threshold', 65]])) as Record<string, unknown>;
  assert.ok(!('scorer' in plain));
  assert.equal(parseDocument(plain, ENV).scorer, null);
  const asked = withEditable(withScorer, new Map<string, SettingValue>([['global:model.model', 'm'], ['global:scorer.model', 'vendor/other'], ['defaults:score.threshold', 65]])) as Record<string, unknown>;
  assert.deepEqual(asked.scorer, { model: 'vendor/other', apiKey: { env: 'SCORER_API_KEY' } });
  const kept = withEditable({ model: { apiKey: { env: 'OPENROUTER_API_KEY' }, model: 'x' } }, new Map([['global:model.model', 'y']])) as { model: Record<string, unknown> };
  assert.deepEqual(kept.model, { apiKey: { env: 'OPENROUTER_API_KEY' }, model: 'y' });
  // The endpoints are the file's alone: kept from it, and never taken from the editable part.
  const withUrls = { model: { baseUrl: 'https://model.example.test/v1', apiKey: { env: 'OPENROUTER_API_KEY' }, model: 'x' }, scorer: { baseUrl: 'https://scorer.example.test/v1', apiKey: { env: 'SCORER_API_KEY' }, model: 's' } };
  const asked2 = withEditable(withUrls, new Map<string, SettingValue>([
    ['global:model.model', 'y'], ['global:model.baseUrl', 'https://elsewhere.example.test/v1'], ['global:scorer.model', 's2'], ['global:scorer.baseUrl', 'https://elsewhere.example.test/v1'],
  ])) as { model: Record<string, unknown>; scorer: Record<string, unknown> };
  assert.equal(asked2.model.baseUrl, 'https://model.example.test/v1');
  assert.equal(asked2.scorer.baseUrl, 'https://scorer.example.test/v1');
  const noScorer = withEditable(withUrls, new Map<string, SettingValue>([['global:model.model', 'y']])) as { model: Record<string, unknown>; scorer?: unknown };
  assert.equal(noScorer.model.baseUrl, 'https://model.example.test/v1');
  assert.ok(!('scorer' in noScorer));
  const apiKeyAttempt = withEditable({ model: { apiKey: { env: 'OPENROUTER_API_KEY' } } }, new Map([['global:model.apiKey', 'sk-inline']])) as { model: Record<string, unknown> };
  assert.deepEqual(apiKeyAttempt.model, { apiKey: { env: 'OPENROUTER_API_KEY' } });
});

test('the settings in force keep the ones read at start until the next start, and follow the save in every other', () => {
  const atStart: Editable = new Map<string, SettingValue>([
    ['global:dryRun', true], ['global:limits.queueConcurrency', 2], ['global:model.model', 'start-model'], ['defaults:score.threshold', 70],
  ]);
  const saved: Editable = new Map<string, SettingValue>([
    ['global:dryRun', false], ['global:learning', true], ['global:limits.queueConcurrency', 5],
    ['global:model.model', 'saved-model'], ['global:model.toolChoice', 'auto'], ['global:model.timeoutSeconds', 99], ['defaults:score.threshold', 80],
    ['acme/shop:gate.mode', 'shadow'],
  ]);
  const force = inForceEditable(atStart, saved);
  assert.equal(force.get('global:dryRun'), true);
  assert.equal(force.get('global:limits.queueConcurrency'), 2);
  for (const p of ['learning', 'model.toolChoice', 'model.timeoutSeconds']) assert.ok(AT_START.has(p) && !force.has(`global:${p}`), p);
  assert.equal(force.get('global:model.model'), 'saved-model');
  assert.equal(force.get('defaults:score.threshold'), 80);
  assert.equal(force.get('acme/shop:gate.mode'), 'shadow');
  // Each start-time path takes atStart's value.
  for (const p of AT_START) {
    const f = inForceEditable(new Map<string, SettingValue>([[`global:${p}`, 'start']]), new Map<string, SettingValue>([[`global:${p}`, 'saved']]));
    assert.equal(f.get(`global:${p}`), 'start', p);
  }

  assert.equal(scorerOn(new Map([['global:scorer.model', 'a']])), true);
  assert.equal(scorerOn(new Map([['global:model.model', 'a']])), false);
  assert.deepEqual(keysOf(inForceEditable(new Map(), new Map<string, SettingValue>([['global:scorer.model', 'b']]))), []);
  const on = new Map<string, SettingValue>([['global:scorer.model', 'a'], ['global:scorer.timeoutSeconds', 60]]);
  const fromOn = inForceEditable(on, new Map<string, SettingValue>([['defaults:primaryBranches', ['main']]]));
  assert.equal(fromOn.get('global:scorer.model'), 'a');
  assert.equal(fromOn.get('global:scorer.timeoutSeconds'), 60);
  assert.equal(inForceEditable(on, new Map<string, SettingValue>([['global:scorer.model', 'b']])).get('global:scorer.model'), 'b');
});

test('values are the same when they hold the same JSON, keys in any order, and a value not written is only itself', () => {
  assert.equal(sameValue({ a: 1, b: [2] }, { b: [2], a: 1 }), true);
  assert.equal(sameValue(undefined, null), false);
  assert.equal(sameValue(undefined, undefined), true);
  assert.equal(sameValue(1, '1'), false);
  assert.notEqual(canonical(undefined), canonical('undefined'));
  assert.equal(canonical({ b: 1, a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1},"b":1}');
});

test("an issue's path names its setting, and an issue of config.yml alone names none", () => {
  assert.deepEqual(settingOfIssue(['model', 'fallbacks', 0]), { scope: 'global', path: 'model.fallbacks' });
  assert.deepEqual(settingOfIssue(['model', 'effort', 'elevated', 'x']), { scope: 'global', path: 'model.effort.elevated' });
  assert.deepEqual(settingOfIssue(['dryRun']), { scope: 'global', path: 'dryRun' });
  assert.deepEqual(settingOfIssue(['scorer', 'model']), { scope: 'global', path: 'scorer.model' });
  assert.deepEqual(settingOfIssue(['repositories', 'overrides', 'Acme/Shop', 'gate', 'branches']), { scope: 'acme/shop', path: 'gate.branches' });
  assert.deepEqual(settingOfIssue(['repositories', 'overrides', 'Acme/Shop', 'gate', 'branches', 0]), { scope: 'acme/shop', path: 'gate.branches' });
  assert.deepEqual(settingOfIssue(['repositories', 'defaults', 'score', 'threshold']), { scope: 'defaults', path: 'score.threshold' });
  assert.deepEqual(settingOfIssue(['repositories', 'defaults', 'newHead']), { scope: 'defaults', path: 'newHead' });
  assert.deepEqual(settingOfIssue(['repositories', 'defaults', 'primaryBranches', 1]), { scope: 'defaults', path: 'primaryBranches' });
  for (const none of [['scorer', 'apiKey'], ['auditKey'], ['limits'], ['model', 'effort'], ['repositories'], ['repositories', 'defaults'], []]) {
    assert.equal(settingOfIssue(none), null, JSON.stringify(none));
  }
});

test('the values shown are the settings loaded, in the shape the file writes them', () => {
  const config: DeploymentConfig = parseDocument(readYaml(example()), ENV);
  const shown = shownValues(config, ['acme/shop', 'Acme/Web']);
  assert.equal(shown.get('global:limits.spendPerDay'), 50);
  assert.equal(shown.get('global:model.prices'), null);
  assert.equal(shown.get('global:scorer.model'), null);
  assert.equal(shown.get('global:dryRun'), true);
  assert.equal(shown.get('global:model.model'), 'vendor/model-a');
  assert.equal(shown.get('defaults:score.threshold'), 70);
  assert.equal(shown.get('defaults:score.autoApprove'), false);
  assert.equal(shown.get('defaults:score.approvalThreads'), 'strict');
  assert.equal(shown.get('defaults:score.auditShare'), 5);
  assert.equal(shown.get('defaults:newHead'), null);
  assert.equal(shown.get('defaults:gate.enabled'), false);
  assert.equal(shown.get('defaults:gate.checkName'), 'AI Review');
  assert.equal(shown.get('acme/shop:score.threshold'), 60);
  assert.deepEqual(shown.get('acme/shop:primaryBranches'), ['trunk']);
  assert.deepEqual(shown.get('acme/shop:ignoredAuthors'), ['dependabot[bot]']);
  assert.equal(shown.get('acme/web:score.threshold'), 70);
  for (const k of shown.keys()) assert.ok(isSetting(keyParts(k).scope, keyParts(k).path), k);
  const base = readYaml(uncomment(example(), '# scorer:')) as { repositories: { defaults: object } };
  const scored = parseDocument({ ...base, repositories: { ...base.repositories, defaults: { ...base.repositories.defaults, score: { threshold: 70 } } } }, ENV);
  assert.equal(shownValues(scored, []).get('global:scorer.model'), 'vendor/decision-model');
});

test('the export holds the references the file writes and no secret, and reads back as the same settings', () => {
  // Every block of the file switched on, so that what the export leaves out is there to be left out.
  let text0 = example();
  for (const first of ['# scorer:', '# app:', '# ui:', '# auditKey: { env: AUDIT_KEY }', '# extensions:', '# mcpServers:']) text0 = uncomment(text0, first);
  const base = readYaml(text0) as { repositories: { overrides: Record<string, unknown> } };
  for (const block of ['scorer', 'app', 'database', 'server', 'alerts', 'ui', 'auditKey', 'extensions', 'mcpServers']) assert.ok(block in base, block);
  const doc = { ...base, repositories: { ...base.repositories, overrides: { ...base.repositories.overrides, 'acme/shop.js': { newHead: 'full', gate: { mode: 'shadow' } } } } };
  const editable = withKeys(editableOf(doc), ['global:scorer.model', 'vendor/decision-model']);
  const text = exportText(doc, editable, '2026-03-01 10:00 UTC');
  assert.ok(text.startsWith(
    '# The settings saved in the UI on 2026-03-01 10:00 UTC, as config.yml writes them.\n'
    + '# Replace these keys of config.yml with them: a setting changed in the file wins at the next start.\n',
  ));
  assert.ok(sameEditable(editableOf(readYaml(text)), editable));
  assert.equal(editable.get('acme/shop.js:newHead'), 'full');
  assert.equal(editableOf(readYaml(text)).get('acme/shop.js:gate.mode'), 'shadow');
  assert.ok(text.includes('OPENROUTER_API_KEY'));
  // The variables of every other block are in the file, and not in the export.
  const others = secretsOf(doc).filter((r) => !['model_key', 'scorer_key'].includes(r.kind)).map((r) => r.variable).filter((v): v is string => v !== null);
  assert.ok(others.length >= 5, others.join(','));
  for (const variable of others) assert.ok(!text.includes(variable), variable);
  for (const never of ['model-key-for-tests-only', 'app:', 'database:', 'ui:', 'server:', 'alerts:', 'extensions:', 'mcpServers:', 'auditKey', 'AUDIT_KEY']) assert.ok(!text.includes(never), never);
  assert.deepEqual(Object.keys(readYaml(text) as object), ['dryRun', 'learning', 'limits', 'model', 'scorer', 'repositories']);
  assert.ok(!text.includes('# scorer:'));
  // The second scorer off in the saved settings while the file writes its block: the export says to remove the block.
  const off = exportText(doc, new Map([...editable].filter(([k]) => !k.startsWith('global:scorer.'))), '2026-03-01 10:00 UTC');
  assert.ok(!('scorer' in (readYaml(off) as object)));
  assert.equal(off.split('\n').filter((l) => l.startsWith('#')).length, 3);
  assert.match(off, /^# scorer: not in the saved settings \(the second scorer is off\); remove the scorer block from config\.yml\.$/m);
  const none = exportText({ model: { apiKey: { env: 'OPENROUTER_API_KEY' }, model: 'x' } }, new Map<string, SettingValue>([['global:model.model', 'x']]), '2026-03-01 10:00 UTC');
  assert.equal(none.split('\n').filter((l) => l.startsWith('#')).length, 2);
});

test('the secrets are the references config.yml writes, by variable name, and the ones it does not write have none', () => {
  const text = uncomment(uncomment(uncomment(example(), '# app:'), '# extensions:'), '# mcpServers:');
  const refs = secretsOf(readYaml(text));
  assert.deepEqual(refs.map((r) => r.kind), [
    'model_key', 'scorer_key', 'app_private_key', 'webhook_secret', 'app_client_secret', 'database', 'audit_key', 'alert_webhook', 'extension', 'mcp_header',
  ]);
  assert.deepEqual(refs[0], { kind: 'model_key', of: null, variable: 'OPENROUTER_API_KEY' });
  assert.deepEqual(refs[1], { kind: 'scorer_key', of: null, variable: null });
  assert.deepEqual(refs.map((r) => r.variable), ['OPENROUTER_API_KEY', null, 'APP_PRIVATE_KEY', 'WEBHOOK_SECRET', null, 'DATABASE_URL', null, 'ALERT_WEBHOOK_URL', 'EXAMPLE_FEEDBACK_SECRET', 'DOCS_MCP_AUTHORIZATION']);
  assert.deepEqual(refs[8], { kind: 'extension', of: 'example, option secret', variable: 'EXAMPLE_FEEDBACK_SECRET' });
  assert.deepEqual(refs[9], { kind: 'mcp_header', of: 'docs, header Authorization', variable: 'DOCS_MCP_AUTHORIZATION' });
  const literal = secretsOf({ mcpServers: [{ name: 'docs', url: 'https://docs.example.test/mcp', headers: { 'X-Plain': 'visible', 'X-Ref': { env: 'X_REF' } }, tools: ['search'] }] });
  assert.deepEqual(literal.filter((r) => r.kind === 'mcp_header'), [{ kind: 'mcp_header', of: 'docs, header X-Ref', variable: 'X_REF' }]);
  const nested = secretsOf({ extensions: [{ name: 'e', module: './m.ts', options: { a: { b: [{ env: 'DEEP' }] } } }] });
  assert.deepEqual(nested.filter((r) => r.kind === 'extension'), [{ kind: 'extension', of: 'e, option a.b.0', variable: 'DEEP' }]);
  // As load.ts reads them, a reference is a value inside options, never options itself.
  const whole = secretsOf({ extensions: [{ name: 'e', module: './m.ts', options: { env: 'WHOLE' } }] });
  assert.deepEqual(whole.filter((r) => r.kind === 'extension'), []);
  const top = secretsOf({ extensions: [{ name: 'e', module: './m.ts', options: { token: { env: 'TOKEN' }, plain: 'x', env: { env: 'ENV_NAMED' } } }] });
  assert.deepEqual(top.filter((r) => r.kind === 'extension'), [
    { kind: 'extension', of: 'e, option token', variable: 'TOKEN' }, { kind: 'extension', of: 'e, option env', variable: 'ENV_NAMED' },
  ]);
  assert.equal(secretsOf({}).length, 8);
});
