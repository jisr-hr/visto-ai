import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { GLOBAL_PATHS, REPOSITORY_PATHS } from '../config/editable.ts';
import type { SettingValue } from '../config/editable.ts';
import { parseDocument, readYaml, serviceConfig } from '../config/load.ts';
import type { ServiceConfig } from '../config/load.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { settingsVersion, writeSetting } from '../db/settings.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { startSettings } from '../shell/settings.ts';
import type { Settings } from '../shell/settings.ts';
import { saveOf, saveSettings, settingChanges, settingsExport, settingsView } from './settings.ts';
import type { SettingsApiDeps } from './settings.ts';

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
repositories:
  defaults:
    score: { threshold: 70 }
  overrides:
    acme/shop:
      score: { threshold: 60 }
`;
const SCORER_YAML = `${FILE_YAML}scorer:
  apiKey: { env: SCORER_API_KEY }
  model: vendor/scorer-a
`;
const ACCESS = { publicUrl: 'https://visto.example.test', github: true, accounts: ['octo-lead'], team: null };
const check = (d: unknown): ServiceConfig => serviceConfig(parseDocument(d, ENV));
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

let db: Db;
beforeEach(async () => { db = await testDb(); });
afterEach(async () => { await db.close(); });

async function deps(yaml = FILE_YAML): Promise<SettingsApiDeps> {
  const settings: Settings = await startSettings({
    db, file: readYaml(yaml), check, clock: () => new Date(at(0)), log: () => {}, uiOn: true,
  });
  return { db, clock: () => new Date(at(30)), settings, log: () => {}, access: ACCESS };
}
const saveNow = async (d: SettingsApiDeps, changes: Array<{ scope: string; path: string; value?: SettingValue }>) =>
  d.settings.save(await settingsVersion(db), changes, 'octo-admin');

test('the view holds every setting with its value, whether it is written and where it came from', async () => {
  await savePullRequest(db, {
    ref: { service: 'github', owner: 'acme', repo: 'web', number: 3 }, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feature-branch',
    headSha: 'a41c09e2b7d3f00dbabe0123456789abcdef0123', draft: false, state: 'open', mergedAt: null, closedAt: null, mergeCommit: null,
    installation: '99', updatedAt: at(0), title: 'A title',
  });
  const d = await deps();
  const view = await settingsView(d);
  assert.deepEqual(Object.keys(view.global), [...GLOBAL_PATHS]);
  assert.deepEqual(Object.keys(view.defaults), [...REPOSITORY_PATHS]);
  assert.deepEqual(view.repositories.map((r) => r.name), ['acme/shop', 'acme/web']);
  for (const r of view.repositories) assert.deepEqual(Object.keys(r.settings), [...REPOSITORY_PATHS]);
  const web = view.repositories[1]!.settings['score.threshold']!;
  assert.deepEqual([web.written, web.value, web.source], [false, 70, null]);
  const shop = view.repositories[0]!.settings['score.threshold']!;
  assert.deepEqual([shop.written, shop.value, shop.source?.by, shop.source?.name], [true, 60, 'config.yml', null]);
  assert.equal(shop.source?.at, at(0));
  assert.deepEqual(view.global['limits.spendPerDay'], { written: true, value: 50, source: { by: 'config.yml', name: null, at: at(0) }, restart: false, waits: false });
  assert.deepEqual(view.global['limits.queueConcurrency']!.restart, true);
  assert.equal(view.now, at(30));
  assert.equal(view.version, 4);
  assert.deepEqual(view.access, ACCESS);
  assert.deepEqual(view.endpoints, { model: 'https://openrouter.ai/api/v1', scorer: null });
  assert.ok(!('model.baseUrl' in view.global) && !('scorer.baseUrl' in view.global));
  // The version is the record's length after more saves.
  await saveNow(d, [{ scope: 'global', path: 'limits.spendPerDay', value: 40 }]);
  const after = await settingsView(d);
  assert.equal(after.version, 5);
  assert.deepEqual(after.global['limits.spendPerDay']!.source, { by: 'ui', name: 'octo-admin', at: at(0) });
});

test("the view reads the version before the rows, and shows a row's own value", async () => {
  const d = await deps();
  const seen: string[] = [];
  const spy: Db = {
    query: (text, params) => { seen.push(text); return db.query(text, params); },
    script: (sql) => db.script(sql),
    transaction: (work) => db.transaction(work),
    close: () => Promise.resolve(),
  };
  // A save between the two reads would give an older version with newer rows: the version is the first statement.
  await settingsView({ ...d, db: spy });
  const versionAt = seen.findIndex((t) => t.includes('max(id)'));
  const rowsAt = seen.findIndex((t) => t.includes('from visto_ai.settings order by'));
  assert.ok(versionAt !== -1 && rowsAt !== -1 && versionAt < rowsAt, seen.join(' | '));
  // A row written straight into the table differs from the saved configuration held in memory: the view shows the row.
  assert.equal(d.settings.saved().config.limits.spendPerDay, 50);
  await writeSetting(db, { scope: 'global', path: 'limits.spendPerDay', value: 99, by: 'ui', name: 'octo-admin', at: at(5) });
  const view = await settingsView(d);
  assert.equal(view.global['limits.spendPerDay']!.value, 99);
  assert.deepEqual(view.global['limits.spendPerDay']!.source, { by: 'ui', name: 'octo-admin', at: at(5) });
});

test("the endpoints are the file's, shown as they are written and never as settings", async () => {
  const d = await deps(SCORER_YAML.replace('  model: vendor/model-a', '  baseUrl: https://model.example.test/v1\n  model: vendor/model-a'));
  assert.deepEqual((await settingsView(d)).endpoints, { model: 'https://model.example.test/v1', scorer: 'https://openrouter.ai/api/alpha' });
});

test("the scorer's endpoint is read from the file, whether or not the scorer is on", async () => {
  // Written in the file while the scorer block is there: shown, and with the default when it writes none.
  const own = await deps(SCORER_YAML.replace('  model: vendor/scorer-a', '  baseUrl: https://scorer.example.test/v1\n  model: vendor/scorer-a'));
  assert.equal((await settingsView(own)).endpoints.scorer, 'https://scorer.example.test/v1');
  // Switched off in the settings, the file still writes it: the view shows it.
  assert.equal((await saveNow(own, [{ scope: 'global', path: 'scorer.model' }])).kind, 'saved');
  const off = await settingsView(own);
  assert.equal(off.scorer.on, false);
  assert.equal(off.endpoints.scorer, 'https://scorer.example.test/v1');
  // A file with no scorer block has none, and one with a block and no address has the default.
  assert.equal((await settingsView(await deps())).endpoints.scorer, null);
  assert.equal((await settingsView(await deps(SCORER_YAML))).endpoints.scorer, 'https://openrouter.ai/api/alpha');
});

test("a start-time setting saved waits for the restart, and the scorer's being on too", async () => {
  const d = await deps();
  assert.equal((await saveNow(d, [{ scope: 'global', path: 'dryRun', value: false }])).kind, 'saved');
  const view = await settingsView(d);
  assert.deepEqual([view.global.dryRun!.restart, view.global.dryRun!.waits], [true, true]);
  assert.deepEqual([view.global['limits.spendPerDay']!.restart, view.global['limits.spendPerDay']!.waits], [false, false]);
  assert.deepEqual(view.scorer, { on: false, waits: false });

  const scored = await deps(SCORER_YAML);
  assert.deepEqual((await settingsView(scored)).scorer, { on: true, waits: false });
  assert.equal((await saveNow(scored, [{ scope: 'global', path: 'scorer.model' }])).kind, 'saved');
  assert.deepEqual((await settingsView(scored)).scorer, { on: false, waits: true });
});

test('the record is paged newest first, its values cut at 200 characters, and a malformed page is bad_request', async () => {
  const d = await deps();
  for (let i = 0; i < 57; i += 1) await saveNow(d, [{ scope: 'global', path: 'limits.spendPerDay', value: 100 + i }]);
  const first = await settingChanges(d, new URLSearchParams(''));
  assert.notEqual(first, 'bad_request');
  if (first === 'bad_request') return;
  assert.equal(first.changes.length, 50);
  assert.deepEqual([first.changes[0]!.id, first.next], [61, first.changes[49]!.id]);
  assert.deepEqual(first.changes[0], { id: 61, at: at(0), by: 'ui', name: 'octo-admin', scope: 'global', path: 'limits.spendPerDay', before: '155', after: '156' });
  const second = await settingChanges(d, new URLSearchParams({ before: String(first.next) }));
  assert.notEqual(second, 'bad_request');
  if (second === 'bad_request') return;
  assert.deepEqual([second.changes.length, second.next], [11, null]);
  assert.deepEqual(await settingChanges(d, new URLSearchParams({ before: '' })), first);
  for (const bad of ['x', '-1', '1.5', '2147483648', '12345678901', ' 3']) assert.equal(await settingChanges(d, new URLSearchParams({ before: bad })), 'bad_request', bad);

  await saveNow(d, [{ scope: 'global', path: 'model.extraBody', value: { b: 'x'.repeat(300), aa: 1 } }]);
  const long = await settingChanges(d, new URLSearchParams(''));
  if (long === 'bad_request') throw new Error('bad_request');
  const row = long.changes[0]!;
  assert.equal(row.before, null);
  assert.equal(row.after!.length, 203);
  assert.ok(row.after!.endsWith('...'));
  // Postgres keeps the keys of an object shorter first, then bytewise ('b' before 'aa'); the record shows them sorted, parsed and written again.
  assert.ok(row.after!.startsWith('{"aa":1,"b":"xxx'));
});

test("no answer holds a secret's value or a field the screen does not show", async () => {
  const d = await deps(SCORER_YAML);
  await saveNow(d, [{ scope: 'defaults', path: 'score.threshold', value: 65 }]);
  const view = await settingsView(d);
  assert.deepEqual(Object.keys(view), ['now', 'version', 'global', 'defaults', 'repositories', 'scorer', 'endpoints', 'secrets', 'access']);
  for (const setting of [...Object.values(view.global), ...Object.values(view.defaults), ...Object.values(view.repositories[0]!.settings)]) {
    assert.deepEqual(Object.keys(setting), ['written', 'value', 'source', 'restart', 'waits']);
    if (setting.source !== null) assert.deepEqual(Object.keys(setting.source), ['by', 'name', 'at']);
  }
  assert.deepEqual(Object.keys(view.repositories[0]!), ['name', 'settings']);
  assert.deepEqual(Object.keys(view.endpoints), ['model', 'scorer']);
  assert.deepEqual(Object.keys(view.access), ['publicUrl', 'github', 'accounts', 'team']);
  assert.deepEqual(view.secrets.map((s) => [s.kind, s.variable]), [
    ['model_key', 'OPENROUTER_API_KEY'], ['scorer_key', 'SCORER_API_KEY'], ['app_private_key', 'APP_PRIVATE_KEY'], ['webhook_secret', 'WEBHOOK_SECRET'],
    ['app_client_secret', null], ['database', 'DATABASE_URL'], ['audit_key', 'AUDIT_KEY'], ['alert_webhook', null],
  ]);
  for (const s of view.secrets) assert.deepEqual(Object.keys(s), ['kind', 'of', 'variable']);
  const changes = await settingChanges(d, new URLSearchParams(''));
  if (changes === 'bad_request') throw new Error('bad_request');
  for (const c of changes.changes) assert.deepEqual(Object.keys(c), ['id', 'at', 'by', 'name', 'scope', 'path', 'before', 'after']);
  assert.deepEqual(Object.keys(changes), ['changes', 'next']);
  const exported = settingsExport(d);
  assert.deepEqual(Object.keys(exported), ['text']);
  assert.match(exported.text, /^# The settings saved in the UI on 2026-03-01T10:00:30\.000Z, as config\.yml writes them\.\n/);
  const everything = JSON.stringify([view, changes, exported]);
  for (const value of Object.values(ENV)) assert.equal(everything.includes(value), false, value.slice(0, 12));
  assert.equal(everything.includes('BEGIN PRIVATE KEY'), false);
});

test('a save is answered saved, changed or invalid, and invalid stores nothing', async () => {
  const d = await deps();
  const saved = await saveSettings(d, 'octo-admin', { version: 4, changes: [{ scope: 'defaults', path: 'score.threshold', value: 65 }] });
  assert.equal(saved.status, 200);
  assert.equal((JSON.parse(String(saved.body)) as { version: number }).version, 5);
  const stale = await saveSettings(d, 'octo-admin', { version: 4, changes: [{ scope: 'defaults', path: 'score.threshold', value: 66 }] });
  assert.deepEqual([stale.status, JSON.parse(String(stale.body))], [409, { error: 'changed' }]);
  const invalid = await saveSettings(d, 'octo-admin', { version: 5, changes: [{ scope: 'defaults', path: 'gate.enabled', value: true }] });
  assert.equal(invalid.status, 422);
  const body = JSON.parse(String(invalid.body)) as { error: string; issues: Array<Record<string, unknown>> };
  assert.equal(body.error, 'invalid');
  assert.ok(body.issues.length >= 1);
  for (const issue of body.issues) assert.deepEqual(Object.keys(issue), ['scope', 'path', 'message']);
  assert.equal(await settingsVersion(db), 5);
});

test('a save whose body is not of its shape is null, and one of its shape is read as it is', () => {
  const one = (change: Record<string, unknown>) => ({ version: 1, changes: [change] });
  const bad: Array<Record<string, unknown>> = [
    one({ scope: 'defaults', path: 'nope' }),
    one({ scope: 'global', path: 'score.threshold' }),
    one({ scope: 'global', path: 'model.baseUrl', value: 'https://elsewhere.example.test/v1' }),
    one({ scope: 'global', path: 'scorer.baseUrl', value: 'https://elsewhere.example.test/v1' }),
    one({ scope: 'Acme/Shop', path: 'newHead' }),
    one({ scope: 'acme', path: 'newHead' }),
    one({ scope: 'defaults', path: 'newHead', extra: 1 }),
    one({ scope: 'defaults', path: 5 }),
    { version: 1, changes: [{ scope: 'defaults', path: 'newHead' }, { scope: 'defaults', path: 'newHead', value: 'full' }] },
    one({ scope: 'defaults', path: 'ignoredAuthors', value: ['a\u0000b'] }),
    one({ scope: 'defaults', path: 'ignoredAuthors', value: [{ ['k' + String.fromCharCode(0)]: 'x' }] }),
    one({ scope: 'defaults', path: 'ignoredAuthors', value: ['lone' + String.fromCharCode(0xd800)] }),
    { version: 1, changes: Array.from({ length: 501 }, (_, i) => ({ scope: `acme/r${i}`, path: 'newHead' })) },
    { version: -1, changes: [{ scope: 'defaults', path: 'newHead' }] },
    { version: 1.5, changes: [{ scope: 'defaults', path: 'newHead' }] },
    { version: '1', changes: [{ scope: 'defaults', path: 'newHead' }] },
    { version: 2147483648, changes: [{ scope: 'defaults', path: 'newHead' }] },
    { version: 1, changes: [{ scope: 'defaults', path: 'newHead' }], extra: true },
    { version: 1 },
    { changes: [{ scope: 'defaults', path: 'newHead' }] },
    { version: 1, changes: [] },
    { version: 1, changes: 'x' },
    { version: 1, changes: [[]] },
  ];
  for (const body of bad) assert.equal(saveOf(body), null, JSON.stringify(body).slice(0, 80));
  const fine = { version: 0, changes: [{ scope: 'defaults', path: 'newHead' }] };
  assert.deepEqual(saveOf(fine), fine);
  const withValue = { version: 2147483647, changes: [{ scope: 'defaults', path: 'score.threshold', value: 65 }, { scope: 'acme/shop', path: 'baseBranches', value: null }] };
  assert.deepEqual(saveOf(withValue), withValue);
  assert.equal(saveOf({ version: 1, changes: Array.from({ length: 500 }, (_, i) => ({ scope: `acme/r${i}`, path: 'newHead' })) })?.changes.length, 500);
});
