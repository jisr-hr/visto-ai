import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { ConfigError, parseDocument, readYaml, repoSettingsFor, serviceConfig } from '../config/load.ts';
import type { ServiceConfig } from '../config/load.ts';
import { editableOf } from '../config/editable.ts';
import type { SettingValue } from '../config/editable.ts';
import { readFileSettings, readSettingChanges, readSettings, settingsVersion } from '../db/settings.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { CLASH_NAMED, issuesOf, startSettings } from './settings.ts';
import type { AskedChange, SaveOutcome, Settings } from './settings.ts';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const ENV = {
  OPENROUTER_API_KEY: 'model-key-for-tests-only', SCORER_API_KEY: 'scorer-key-for-tests-only', AUDIT_KEY: 'audit-key-for-tests-only-0123456789abcdef',
  WEBHOOK_SECRET: 'webhook-secret-for-tests-only', DATABASE_URL: 'postgres://visto:db-password-for-tests@db.example.test/visto', APP_PRIVATE_KEY: PEM,
};

const FILE_YAML = `model:
  apiKey: { env: OPENROUTER_API_KEY }
  model: vendor/model-a
app:
  id: 12345
  privateKey: { env: APP_PRIVATE_KEY }
  webhookSecret: { env: WEBHOOK_SECRET }
database:
  url: { env: DATABASE_URL }
auditKey: { env: AUDIT_KEY }
ui:
  publicUrl: https://visto.example.test
limits:
  spendPerDay: 50
`;

// A file that writes a setting of nearly every kind, a second scorer and an override included.
const RICH_YAML = `dryRun: false
learning: true
model:
  apiKey: { env: OPENROUTER_API_KEY }
  model: vendor/model-a
  fallbacks: [vendor/model-b]
  effort:
    default: {}
    elevated: { reasoning: { effort: high } }
  extraBody: { provider: { order: [vendor] } }
  extraHeaders: { X-Title: Visto }
  prices: { inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 5 }
  timeoutSeconds: 120
  toolChoice: auto
scorer:
  apiKey: { env: SCORER_API_KEY }
  model: vendor/scorer-a
app:
  id: 12345
  privateKey: { env: APP_PRIVATE_KEY }
  webhookSecret: { env: WEBHOOK_SECRET }
database:
  url: { env: DATABASE_URL }
auditKey: { env: AUDIT_KEY }
ui:
  publicUrl: https://visto.example.test
limits:
  spendPerDay: 50
  queueConcurrency: 4
  inputTokensPerCall: 150000
  batchesPerReview: 3
repositories:
  defaults:
    primaryBranches: [main]
    score: { threshold: 65, autoApprove: true, auditShare: 10 }
    gate: { enabled: true, branches: [main], mode: shadow }
  overrides:
    acme/shop:
      newHead: full
      score: { threshold: 60 }
`;

const SCORER_YAML = `${FILE_YAML}scorer:
  apiKey: { env: SCORER_API_KEY }
  model: vendor/scorer-a
repositories:
  defaults:
    score: { threshold: 65 }
`;

const check = (d: unknown): ServiceConfig => serviceConfig(parseDocument(d, ENV));
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

let db: Db;
let now: number;
let logs: Array<Record<string, unknown>>;
beforeEach(async () => { db = await testDb(); now = 0; logs = []; });
afterEach(async () => { await db.close(); });

const deps = (file: unknown, uiOn = true) => ({
  db, file, check, clock: () => new Date(at(now)), log: (entry: Record<string, unknown>) => { logs.push(entry); }, uiOn,
});
const start = (yaml = FILE_YAML, uiOn = true): Promise<Settings> => startSettings(deps(readYaml(yaml), uiOn));

const rows = async () => (await readSettings(db)).map((r) => ({
  key: `${r.scope}:${r.path}`, value: r.value, by: r.set_by, name: r.set_by_name, at: r.set_at.toISOString(),
}));
const rowOf = async (key: string) => (await rows()).find((r) => r.key === key);
/** Oldest first. */
const record = async () => (await readSettingChanges(db, null, 1000)).reverse().map((c) => ({
  at: c.at.toISOString(), by: c.by, name: c.by_name, key: `${c.scope}:${c.path}`, before: c.before, after: c.after,
}));
const fileRows = async () => (await readFileSettings(db)).map((r) => ({ key: `${r.scope}:${r.path}`, value: r.value }));
const state = async () => ({ rows: await rows(), record: await record(), file: await fileRows(), version: await settingsVersion(db) });
const set = (scope: string, path: string, value: SettingValue): AskedChange => ({ scope, path, value });
const unset = (scope: string, path: string): AskedChange => ({ scope, path });
const saveNow = async (s: Settings, changes: AskedChange[]): Promise<SaveOutcome> => s.save(await settingsVersion(db), changes, 'octo-admin');

test('the first start copies every setting the file writes, recorded as made by config.yml, and none it does not write', async () => {
  const file = readYaml(FILE_YAML);
  const s = await startSettings(deps(file));
  assert.deepEqual(await rows(), [
    { key: 'global:limits.spendPerDay', value: 50, by: 'config.yml', name: null, at: at(0) },
    { key: 'global:model.model', value: 'vendor/model-a', by: 'config.yml', name: null, at: at(0) },
  ]);
  assert.deepEqual(new Map((await rows()).map((r) => [r.key, r.value])), editableOf(file));
  assert.deepEqual(await record(), [
    { at: at(0), by: 'config.yml', name: null, key: 'global:limits.spendPerDay', before: null, after: '50' },
    { at: at(0), by: 'config.yml', name: null, key: 'global:model.model', before: null, after: '"vendor/model-a"' },
  ]);
  assert.deepEqual(await fileRows(), [{ key: 'global:limits.spendPerDay', value: 50 }, { key: 'global:model.model', value: 'vendor/model-a' }]);
  assert.deepEqual(logs, [{ event: 'settings', from_file: 2, from_ui: 0 }]);
  assert.equal(s.file, file);
  assert.deepEqual(s.atStart, check(file));
  assert.deepEqual(s.inForce(), check(file));
  assert.deepEqual(s.saved(), { editable: editableOf(file), config: check(file) });
  assert.deepEqual(s.startEditable, editableOf(file));

  // A file that writes nearly every setting starts exactly as it did before this release.
  await db.close();
  db = await testDb();
  logs = [];
  const rich = readYaml(RICH_YAML);
  const r = await startSettings(deps(rich));
  const written = editableOf(rich);
  assert.deepEqual(new Map((await rows()).map((x) => [x.key, x.value])), written);
  assert.ok((await rows()).every((x) => x.by === 'config.yml' && x.name === null));
  assert.equal((await record()).length, written.size);
  assert.ok((await record()).every((c) => c.before === null && c.by === 'config.yml'));
  assert.deepEqual(new Map((await fileRows()).map((x) => [x.key, x.value])), written);
  assert.deepEqual(logs, [{ event: 'settings', from_file: written.size, from_ui: 0 }]);
  assert.deepEqual(r.atStart, check(rich));
});

test("the sync never writes the model's or the scorer's endpoint, and the service starts on the file's", async () => {
  const yaml = `${SCORER_YAML.replace('model: vendor/model-a', 'baseUrl: https://model.example.test/v1\n  model: vendor/model-a')}`
    .replace('  model: vendor/scorer-a', '  baseUrl: https://scorer.example.test/v1\n  model: vendor/scorer-a');
  const s = await start(yaml);
  assert.ok(!(await rows()).some((r) => r.key.includes('baseUrl')));
  assert.ok(!(await record()).some((r) => r.key.includes('baseUrl')));
  assert.ok(!(await fileRows()).some((r) => r.key.includes('baseUrl')));
  assert.equal(s.atStart.model.baseUrl, 'https://model.example.test/v1');
  assert.equal(s.atStart.scorer?.baseUrl, 'https://scorer.example.test/v1');
  assert.equal(s.inForce().model.baseUrl, 'https://model.example.test/v1');
  const saved = await saveNow(s, [set('global', 'model.model', 'vendor/model-b')]);
  assert.equal(saved.kind, 'saved');
  assert.equal(s.saved().config.model.baseUrl, 'https://model.example.test/v1');
  assert.equal(s.saved().config.scorer?.baseUrl, 'https://scorer.example.test/v1');
  assert.ok(!(await rows()).some((r) => r.key.includes('baseUrl')));
});

test('a second start with the file unchanged changes and records nothing', async () => {
  for (const yaml of [FILE_YAML, RICH_YAML]) {
    await db.close();
    db = await testDb();
    now = 0;
    await start(yaml);
    const before = await state();
    now = 60;
    logs = [];
    const s = await start(yaml);
    assert.deepEqual(await state(), before);
    assert.deepEqual(logs, [{ event: 'settings', from_file: 0, from_ui: 0 }]);
    assert.deepEqual(s.atStart, check(readYaml(yaml)));
  }
});

test('a setting changed in the file replaces what the UI saved, and one the file did not change keeps it', async () => {
  const first = await start();
  now = 10;
  assert.deepEqual(await saveNow(first, [set('global', 'limits.spendPerDay', 40), set('defaults', 'score.threshold', 55)]),
    { kind: 'saved', changed: 2, restart: false });
  now = 20;
  logs = [];
  const second = await start(FILE_YAML.replace('spendPerDay: 50', 'spendPerDay: 30'));
  assert.deepEqual(await rowOf('global:limits.spendPerDay'), { key: 'global:limits.spendPerDay', value: 30, by: 'config.yml', name: null, at: at(20) });
  assert.deepEqual(await rowOf('defaults:score.threshold'), { key: 'defaults:score.threshold', value: 55, by: 'ui', name: 'octo-admin', at: at(10) });
  const changes = await record();
  assert.equal(changes.length, 5);
  assert.deepEqual(changes.at(-1), { at: at(20), by: 'config.yml', name: null, key: 'global:limits.spendPerDay', before: '40', after: '30' });
  assert.deepEqual(logs, [{ event: 'settings', from_file: 1, from_ui: 1 }]);
  assert.equal(second.atStart.limits.spendPerDay, 30);
  assert.equal(second.atStart.repositories.defaults.scoreThreshold, 55);
  assert.deepEqual(await fileRows(), [{ key: 'global:limits.spendPerDay', value: 30 }, { key: 'global:model.model', value: 'vendor/model-a' }]);
});

test('a setting removed from the file goes back to its default, and one the file writes as the UI saved it records nothing', async () => {
  await start(`${FILE_YAML}learning: true\n`);
  assert.deepEqual(await rowOf('global:learning'), { key: 'global:learning', value: true, by: 'config.yml', name: null, at: at(0) });
  now = 10;
  const s = await start();
  assert.equal(await rowOf('global:learning'), undefined);
  assert.deepEqual((await record()).at(-1), { at: at(10), by: 'config.yml', name: null, key: 'global:learning', before: 'true', after: null });
  assert.equal(s.atStart.learning, false);

  now = 20;
  assert.equal((await saveNow(s, [set('global', 'dryRun', false)])).kind, 'saved');
  assert.deepEqual(await rowOf('global:dryRun'), { key: 'global:dryRun', value: false, by: 'ui', name: 'octo-admin', at: at(20) });
  const before = await record();
  now = 30;
  logs = [];
  const again = await start(`${FILE_YAML}dryRun: false\n`);
  assert.deepEqual(await record(), before);
  assert.deepEqual(await rowOf('global:dryRun'), { key: 'global:dryRun', value: false, by: 'config.yml', name: null, at: at(30) });
  assert.deepEqual(logs, [{ event: 'settings', from_file: 0, from_ui: 0 }]);
  assert.equal(again.atStart.dryRun, false);
});

test('settings saved in the UI that clash with the file refuse the start with each issue and the sentence, and nothing is copied', async () => {
  const sentence = (named: string): string => `Saved in the UI: ${named}; with them config.yml does not pass. Changing them in config.yml `
    + '(another value, or removed) settles it: a setting changed in the file wins at the next start.';
  const withoutKey = FILE_YAML.replace('auditKey: { env: AUDIT_KEY }\n', '');
  const s = await start();
  now = 10;
  assert.equal((await saveNow(s, [set('defaults', 'score.autoApprove', true)])).kind, 'saved');
  const before = await state();
  now = 20;
  logs = [];
  const changed = withoutKey.replace('spendPerDay: 50', 'spendPerDay: 30');
  assert.doesNotThrow(() => check(readYaml(changed)));
  await assert.rejects(start(changed), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.deepEqual(error.issues, [
      'auditKey: must be written while autoApprove is true with an auditShare above 0',
      sentence('repositories.defaults.score.autoApprove'),
    ]);
    assert.equal(error.details.length, error.issues.length);
    return true;
  });
  assert.deepEqual(await state(), before);
  assert.deepEqual(await rowOf('global:limits.spendPerDay'), { key: 'global:limits.spendPerDay', value: 50, by: 'config.yml', name: null, at: at(0) });
  assert.deepEqual(logs, []);

  // Twelve settings saved in the UI: the sentence names the first ten, sorted, then how many more.
  await db.close();
  db = await testDb();
  now = 0;
  const twelve = await start();
  const asked = [
    set('defaults', 'score.autoApprove', true), set('defaults', 'score.threshold', 55), set('defaults', 'score.inlineNotes', false),
    set('defaults', 'score.approvalThreads', 'gate'), set('defaults', 'score.auditShare', 10), set('defaults', 'primaryBranches', ['main']),
    set('defaults', 'ignoredAuthors', ['bot']), set('defaults', 'baseBranches', ['main']), set('defaults', 'newHead', 'full'),
    set('defaults', 'gate.checkName', 'Visto'), set('defaults', 'gate.mode', 'shadow'), set('defaults', 'gate.clearByReply', false),
  ];
  assert.equal(asked.length, CLASH_NAMED + 2);
  assert.deepEqual(await saveNow(twelve, asked), { kind: 'saved', changed: 12, restart: false });
  const named = [
    'baseBranches', 'gate.checkName', 'gate.clearByReply', 'gate.mode', 'ignoredAuthors', 'newHead', 'primaryBranches', 'score.approvalThreads',
    'score.auditShare', 'score.autoApprove',
  ].map((p) => `repositories.defaults.${p}`).join(', ');
  await assert.rejects(start(withoutKey), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.deepEqual(error.issues, ['auditKey: must be written while autoApprove is true with an auditShare above 0', sentence(`${named}, and 2 more`)]);
    return true;
  });

  // A merged part that fails with no setting from the UI: the issues alone, and nothing copied.
  await db.close();
  db = await testDb();
  await assert.rejects(start(FILE_YAML.replace('spendPerDay: 50', 'spendPerDay: 50\n  queueConcurrency: 0')), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.issues.length, 1);
    assert.match(error.issues[0]!, /^limits\.queueConcurrency: /);
    return true;
  });
  assert.deepEqual(await state(), { rows: [], record: [], file: [], version: 0 });

  // Any other failure of the check rolls back and rejects as it is.
  const boom = new Error('boom');
  await assert.rejects(startSettings({ ...deps(readYaml(FILE_YAML)), check: () => { throw boom; } }), (error: unknown) => error === boom);
  assert.deepEqual(await state(), { rows: [], record: [], file: [], version: 0 });
});

test('while the UI is off, a start copies the file whole, and what the UI saved goes, recorded as made by config.yml', async () => {
  const s = await start();
  now = 10;
  assert.equal((await saveNow(s, [
    set('defaults', 'score.threshold', 55), set('global', 'limits.spendPerDay', 40), set('global', 'model.model', 'vendor/model-b'),
  ])).kind, 'saved');
  const count = (await record()).length;
  now = 20;
  logs = [];
  const off = await start(FILE_YAML.replace('model: vendor/model-a', 'model: vendor/model-b'), false);
  assert.equal(await rowOf('defaults:score.threshold'), undefined);
  assert.deepEqual(await rowOf('global:limits.spendPerDay'), { key: 'global:limits.spendPerDay', value: 50, by: 'config.yml', name: null, at: at(20) });
  // Written as the UI saved it: its source becomes the file's, and nothing is recorded.
  assert.deepEqual(await rowOf('global:model.model'), { key: 'global:model.model', value: 'vendor/model-b', by: 'config.yml', name: null, at: at(20) });
  assert.ok((await rows()).every((r) => r.by === 'config.yml' && r.name === null));
  assert.deepEqual((await record()).slice(count), [
    { at: at(20), by: 'config.yml', name: null, key: 'defaults:score.threshold', before: '55', after: null },
    { at: at(20), by: 'config.yml', name: null, key: 'global:limits.spendPerDay', before: '40', after: '50' },
  ]);
  assert.equal(off.atStart.repositories.defaults.scoreThreshold, 70);
  assert.equal(off.atStart.limits.spendPerDay, 50);
  assert.deepEqual(logs, [{ event: 'settings', from_file: 2, from_ui: 0 }]);
  assert.deepEqual(await fileRows(), [{ key: 'global:limits.spendPerDay', value: 50 }, { key: 'global:model.model', value: 'vendor/model-b' }]);
});

test('a file value holding a NUL is stored as the database keeps it and is not seen as changed at the next start', async () => {
  const yaml = FILE_YAML.replace('model: vendor/model-a', 'model: "vendor/a\\0"');
  assert.equal(editableOf(readYaml(yaml)).get('global:model.model'), `vendor/a${String.fromCharCode(0)}`);
  const s = await start(yaml);
  assert.equal((await rowOf('global:model.model'))?.value, 'vendor/a');
  assert.deepEqual((await fileRows()).find((r) => r.key === 'global:model.model'), { key: 'global:model.model', value: 'vendor/a' });
  assert.equal(s.atStart.model.model, 'vendor/a');
  const before = await state();
  now = 10;
  logs = [];
  await start(yaml);
  assert.deepEqual(await state(), before);
  assert.deepEqual(logs, [{ event: 'settings', from_file: 0, from_ui: 0 }]);
});

test('a save is checked whole, refused with each issue at its setting, and stores nothing then', async () => {
  const s = await start();
  const before = await state();
  logs = [];
  assert.deepEqual(await saveNow(s, [set('defaults', 'gate.enabled', true)]), {
    kind: 'invalid', issues: [{ scope: 'defaults', path: 'gate.branches', message: 'must name at least one branch when the gate is enabled' }],
  });
  assert.deepEqual(await state(), before);
  const concurrency = await saveNow(s, [set('global', 'limits.queueConcurrency', 0)]);
  assert.equal(concurrency.kind, 'invalid');
  assert.deepEqual(concurrency.kind === 'invalid' ? concurrency.issues.map((i) => [i.scope, i.path]) : null, [['global', 'limits.queueConcurrency']]);
  assert.deepEqual(await state(), before);
  const scorer = await saveNow(s, [set('global', 'scorer.model', 'vendor/scorer-a')]);
  assert.equal(scorer.kind, 'invalid');
  const issues = scorer.kind === 'invalid' ? scorer.issues : [];
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.scope, null);
  assert.equal(issues[0]!.path, null);
  assert.match(issues[0]!.message, /^scorer\.apiKey: /);
  assert.deepEqual(await state(), before);
  assert.deepEqual(logs, [1, 2, 3].map(() => ({ event: 'settings_save', outcome: 'invalid', changes: 1 })));
  assert.deepEqual(s.saved().config, s.atStart);

  // The part in force is checked too: the scorer stays on until the restart, and it needs the threshold written.
  now = 10;
  const scored = await start(SCORER_YAML);
  const scoredBefore = await state();
  assert.deepEqual(await saveNow(scored, [unset('global', 'scorer.model'), unset('defaults', 'score.threshold')]), {
    kind: 'invalid', issues: [{ scope: 'defaults', path: 'score.threshold', message: 'must be written when scorer is set' }],
  });
  assert.deepEqual(await state(), scoredBefore);

  // A change the route would never send rejects, and writes nothing.
  await assert.rejects(saveNow(s, [set('global', 'model.apiKey', 'x')]), /bad_change/);
  // The endpoints are config.yml's alone: a save naming one is refused like any path that is no setting.
  await assert.rejects(saveNow(s, [set('global', 'model.baseUrl', 'https://elsewhere.example.test/v1')]), /bad_change/);
  await assert.rejects(saveNow(s, [set('global', 'scorer.baseUrl', 'https://elsewhere.example.test/v1')]), /bad_change/);
  await assert.rejects(saveNow(s, [set('Acme/Shop', 'newHead', 'full')]), /bad_change/);
  assert.deepEqual(await state(), scoredBefore);
});

test('a save records each value it changes, by the name given, and one that changes nothing records nothing', async () => {
  const s = await start();
  const count = (await record()).length;
  now = 10;
  logs = [];
  assert.deepEqual(await saveNow(s, [set('defaults', 'score.threshold', 55), set('global', 'limits.spendPerDay', 50)]),
    { kind: 'saved', changed: 1, restart: false });
  assert.deepEqual((await record()).slice(count), [
    { at: at(10), by: 'ui', name: 'octo-admin', key: 'defaults:score.threshold', before: null, after: '55' },
  ]);
  assert.deepEqual(await rowOf('defaults:score.threshold'), { key: 'defaults:score.threshold', value: 55, by: 'ui', name: 'octo-admin', at: at(10) });
  assert.deepEqual(await rowOf('global:limits.spendPerDay'), { key: 'global:limits.spendPerDay', value: 50, by: 'config.yml', name: null, at: at(0) });
  assert.equal(s.saved().config.repositories.defaults.scoreThreshold, 55);
  assert.equal(s.inForce().repositories.defaults.scoreThreshold, 55);
  assert.equal(s.saved().editable.get('defaults:score.threshold'), 55);

  const version = await settingsVersion(db);
  const stateAfter = await state();
  now = 20;
  assert.deepEqual(await saveNow(s, [set('defaults', 'score.threshold', 55), set('global', 'limits.spendPerDay', 50)]),
    { kind: 'saved', changed: 0, restart: false });
  assert.deepEqual(await state(), stateAfter);
  assert.equal(await settingsVersion(db), version);

  now = 30;
  assert.deepEqual(await saveNow(s, [set('acme/shop', 'newHead', 'full')]), { kind: 'saved', changed: 1, restart: false });
  assert.equal(repoSettingsFor(s.saved().config, 'acme/shop').newHead, 'full');
  now = 40;
  assert.deepEqual(await saveNow(s, [unset('acme/shop', 'newHead')]), { kind: 'saved', changed: 1, restart: false });
  assert.equal(await rowOf('acme/shop:newHead'), undefined);
  assert.deepEqual((await record()).at(-1), { at: at(40), by: 'ui', name: 'octo-admin', key: 'acme/shop:newHead', before: '"full"', after: null });
  assert.equal(repoSettingsFor(s.saved().config, 'acme/shop').newHead, null);
  assert.equal(s.saved().editable.has('acme/shop:newHead'), false);
  assert.deepEqual(logs, [1, 0, 1, 1].map((changes) => ({ event: 'settings_save', outcome: 'saved', changes })));
});

test('a save from an older version is refused as changed, and of two saves at once one is saved', async () => {
  const s = await start();
  const v = await settingsVersion(db);
  now = 10;
  logs = [];
  assert.equal((await s.save(v, [set('defaults', 'score.threshold', 55)], 'octo-admin')).kind, 'saved');
  const before = await state();
  assert.deepEqual(await s.save(v, [set('defaults', 'score.threshold', 60), set('global', 'learning', true)], 'octo-admin'), { kind: 'changed' });
  assert.deepEqual(await state(), before);
  assert.deepEqual(logs, [{ event: 'settings_save', outcome: 'saved', changes: 1 }, { event: 'settings_save', outcome: 'changed', changes: 2 }]);
  assert.equal(s.saved().config.repositories.defaults.scoreThreshold, 55);

  const w = await settingsVersion(db);
  const both = await Promise.all([
    s.save(w, [set('defaults', 'score.threshold', 60)], 'octo-admin'),
    s.save(w, [set('defaults', 'score.threshold', 65)], 'octo-admin'),
  ]);
  assert.deepEqual(both.map((o) => o.kind).sort(), ['changed', 'saved']);
  const won = both[0]!.kind === 'saved' ? 60 : 65;
  assert.equal((await rowOf('defaults:score.threshold'))?.value, won);
  assert.equal(s.saved().config.repositories.defaults.scoreThreshold, won);
  assert.equal(s.inForce().repositories.defaults.scoreThreshold, won);
  assert.equal(s.saved().editable.get('defaults:score.threshold'), won);

  // Two saves the lock puts in a row whose answers come back out of order: the newer one stays in memory.
  let hold: Promise<void> | null = null;
  let release = (): void => {};
  const slow: Db = {
    query: (text, params) => db.query(text, params),
    script: (sql) => db.script(sql),
    close: () => db.close(),
    transaction: async (work) => {
      const result = await db.transaction(work);
      const waiting = hold;
      hold = null;
      if (waiting !== null) await waiting;
      return result;
    },
  };
  const t = await startSettings({ ...deps(readYaml(FILE_YAML)), db: slow });
  const x = await settingsVersion(db);
  hold = new Promise((resolve) => { release = resolve; });
  const older = t.save(x, [set('defaults', 'score.threshold', 70)], 'octo-admin');
  assert.deepEqual(await t.save(x + 1, [set('defaults', 'score.threshold', 75)], 'octo-admin'), { kind: 'saved', changed: 1, restart: false });
  release();
  assert.deepEqual(await older, { kind: 'saved', changed: 1, restart: false });
  assert.equal((await rowOf('defaults:score.threshold'))?.value, 75);
  assert.equal(t.saved().config.repositories.defaults.scoreThreshold, 75);
  assert.equal(t.inForce().repositories.defaults.scoreThreshold, 75);
});

test('the settings in force keep what is read at start until the next start; the rest follow the save', async () => {
  const s = await start();
  now = 10;
  assert.deepEqual(await saveNow(s, [
    set('global', 'dryRun', false), set('global', 'limits.queueConcurrency', 5), set('global', 'model.toolChoice', 'auto'),
    set('defaults', 'score.threshold', 55), set('global', 'limits.inputTokensPerCall', 50000),
  ]), { kind: 'saved', changed: 5, restart: true });
  const inForce = s.inForce();
  assert.equal(inForce.dryRun, true);
  assert.equal(inForce.limits.queueConcurrency, 2);
  assert.equal(inForce.model.toolChoice, 'forced');
  assert.equal(inForce.repositories.defaults.scoreThreshold, 55);
  assert.equal(inForce.limits.inputTokensPerCall, 50000);
  const saved = s.saved().config;
  assert.equal(saved.dryRun, false);
  assert.equal(saved.limits.queueConcurrency, 5);
  assert.equal(saved.model.toolChoice, 'auto');
  assert.equal(s.atStart.dryRun, true);
  assert.equal(s.atStart.repositories.defaults.scoreThreshold, 70);
  assert.equal(s.startEditable.has('global:dryRun'), false);

  // The scorer switched on in the UI waits for the restart too.
  now = 20;
  const scored = await start(SCORER_YAML);
  now = 30;
  assert.deepEqual(await saveNow(scored, [unset('global', 'scorer.model')]), { kind: 'saved', changed: 1, restart: true });
  assert.equal(scored.saved().config.scorer, null);
  assert.equal(scored.inForce().scorer?.model, 'vendor/scorer-a');
});

test("no row, log line or error holds a secret's value", async () => {
  const seen: string[] = [];
  const s = await start(SCORER_YAML);
  now = 10;
  for (const changes of [
    [set('defaults', 'score.autoApprove', true), set('global', 'model.extraHeaders', { 'X-Title': 'Visto' })],
    [set('defaults', 'gate.enabled', true)],
    [set('global', 'limits.queueConcurrency', 0)],
  ]) {
    seen.push(JSON.stringify(await saveNow(s, changes)));
  }
  now = 20;
  await assert.rejects(start(SCORER_YAML.replace('auditKey: { env: AUDIT_KEY }\n', '')), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    seen.push(error.message, JSON.stringify(error.issues), JSON.stringify(error.details), JSON.stringify(issuesOf(error)));
    return true;
  });
  const missing = new ConfigError(['model.apiKey: environment variable OPENROUTER_API_KEY is not set'],
    [{ path: ['model', 'apiKey'], message: 'environment variable OPENROUTER_API_KEY is not set' }]);
  seen.push(JSON.stringify(issuesOf(missing)));
  const tables = await Promise.all(['settings', 'settings_file', 'setting_changes'].map((t) => db.query(`select * from visto_ai.${t}`)));
  const haystack = [JSON.stringify(tables), JSON.stringify(logs), ...seen].join('\n');
  const pemBody = PEM.split('\n').filter((line) => line !== '' && !line.startsWith('-----'));
  assert.ok(pemBody.length > 5);
  for (const secret of [ENV.OPENROUTER_API_KEY, ENV.SCORER_API_KEY, ENV.AUDIT_KEY, ENV.WEBHOOK_SECRET, 'db-password-for-tests', ...pemBody]) {
    assert.equal(haystack.includes(secret), false, secret);
  }
  assert.ok(JSON.stringify(tables).includes('octo-admin'));
  assert.equal([JSON.stringify(logs), ...seen].join('\n').includes('octo-admin'), false);
  assert.ok(logs.length >= 4);
});

test('the file and the changes given are left as they were, and the settings held do not follow them', async () => {
  const given: Array<{ document: unknown; copy: unknown }> = [];
  const spy = (document: unknown): ServiceConfig => {
    given.push({ document, copy: structuredClone(document) });
    return check(document);
  };
  const file = readYaml(RICH_YAML) as { model: { extraBody: Record<string, unknown> }; limits: { spendPerDay: number } };
  const fileCopy = structuredClone(file);
  const s = await startSettings({ ...deps(file), check: spy });
  assert.deepEqual(file, fileCopy);
  const value = { provider: { order: ['vendor'] }, extra: [1] };
  const asked = [set('global', 'model.extraBody', value)];
  const askedCopy = structuredClone(asked);
  now = 10;
  assert.equal((await saveNow(s, asked)).kind, 'saved');
  assert.deepEqual(asked, askedCopy);
  assert.deepEqual(file, fileCopy);
  assert.equal(given.length, 3);
  for (const { document, copy } of given) assert.deepEqual(document, copy);

  value.provider.order.push('other');
  value.extra.push(2);
  file.model.extraBody.provider = 'changed';
  file.limits.spendPerDay = 1;
  const expected = { provider: { order: ['vendor'] }, extra: [1] };
  assert.deepEqual(s.saved().config.model.extraBody, expected);
  assert.deepEqual(s.inForce().model.extraBody, expected);
  assert.deepEqual(s.saved().editable.get('global:model.extraBody'), expected);
  assert.deepEqual(s.atStart.model.extraBody, { provider: { order: ['vendor'] } });
  assert.equal(s.atStart.limits.spendPerDay, 50);
  assert.equal(s.saved().config.limits.spendPerDay, 50);
});

test('an issue at a setting is given with its scope and path, and one at no setting with its whole line', () => {
  const error = new ConfigError(
    ['repositories.overrides.Acme/Shop.score.threshold: too big', 'auditKey: must be written', 'app: required to run the service'],
    [
      { path: ['repositories', 'overrides', 'Acme/Shop', 'score', 'threshold'], message: 'too big' },
      { path: ['auditKey'], message: 'must be written' },
      { path: [], message: 'app: required to run the service' },
    ],
  );
  assert.deepEqual(issuesOf(error), [
    { scope: 'acme/shop', path: 'score.threshold', message: 'too big' },
    { scope: null, path: null, message: 'auditKey: must be written' },
    { scope: null, path: null, message: 'app: required to run the service' },
  ]);
  assert.deepEqual(issuesOf(new ConfigError(['app: required to run the service'])), [{ scope: null, path: null, message: 'app: required to run the service' }]);
});
