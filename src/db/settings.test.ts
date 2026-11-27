import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import type { Db } from './types.ts';
import {
  deleteSetting, lockSettings, readFileSettings, readSettingChanges, readSettings, recordSettingChange, replaceFileSettings,
  settingsVersion, writeSetting,
} from './settings.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

test('a setting is written with its source, replaced, read back with its JSON as it was, and deleted', async () => {
  const db = await testDb();
  await writeSetting(db, { scope: 'global', path: 'model.prices', value: null, by: 'config.yml', name: null, at: at(0) });
  const first = await readSettings(db);
  assert.deepEqual(first.map((r) => ({ ...r, set_at: r.set_at.toISOString() })),
    [{ scope: 'global', path: 'model.prices', value: null, set_by: 'config.yml', set_by_name: null, set_at: at(0) }]);
  await writeSetting(db, { scope: 'global', path: 'model.prices', value: { a: [1, 'x'] }, by: 'ui', name: 'octo-admin', at: at(5) });
  const second = await readSettings(db);
  assert.deepEqual(second.map((r) => ({ ...r, set_at: r.set_at.toISOString() })),
    [{ scope: 'global', path: 'model.prices', value: { a: [1, 'x'] }, set_by: 'ui', set_by_name: 'octo-admin', set_at: at(5) }]);
  assert.equal(await deleteSetting(db, 'global', 'model.prices'), true);
  assert.equal(await deleteSetting(db, 'global', 'model.prices'), false);
  assert.deepEqual(await readSettings(db), []);
  await assert.rejects(writeSetting(db, { scope: 'global', path: 'p', value: 1, by: 'ui', name: null, at: at(6) }));
  await db.close();
});

test("the file's part is replaced whole", async () => {
  const db = await testDb();
  await replaceFileSettings(db, [{ scope: 'global', path: 'a', value: 1 }, { scope: 'global', path: 'b', value: { k: 'v' } }]);
  assert.deepEqual(await readFileSettings(db), [{ scope: 'global', path: 'a', value: 1 }, { scope: 'global', path: 'b', value: { k: 'v' } }]);
  await replaceFileSettings(db, [{ scope: 'global', path: 'b', value: 2 }, { scope: 'repo:x', path: 'c', value: null }]);
  assert.deepEqual(await readFileSettings(db), [{ scope: 'global', path: 'b', value: 2 }, { scope: 'repo:x', path: 'c', value: null }]);
  await db.close();
});

test('a change is recorded with its values as JSON text, not written as null, and paged newest first', async () => {
  const db = await testDb();
  assert.equal(await settingsVersion(db), 0);
  const c = { at: at(0), by: 'config.yml' as const, name: null, scope: 'global', path: 'p' };
  await recordSettingChange(db, { ...c, before: undefined, after: 70 });
  await recordSettingChange(db, { ...c, before: null, after: undefined });
  const [newer, older] = await readSettingChanges(db, null, 10);
  assert.ok(newer !== undefined && older !== undefined);
  assert.deepEqual([older.before, older.after], [null, '70']);
  assert.deepEqual([newer.before, newer.after], ['null', null]);
  assert.deepEqual({ ...newer, at: newer.at.toISOString(), id: 0 }, { id: 0, at: at(0), by: 'config.yml', by_name: null, scope: 'global', path: 'p', before: 'null', after: null });
  await assert.rejects(recordSettingChange(db, { ...c, before: undefined, after: undefined }));
  for (let i = 0; i < 58; i++) await recordSettingChange(db, { ...c, at: at(i), before: i, after: i + 1 });
  const page = await readSettingChanges(db, null, 51);
  assert.equal(page.length, 51);
  assert.deepEqual(page.map((r) => r.id), [...page.map((r) => r.id)].sort((x, y) => y - x));
  assert.equal(await settingsVersion(db), page[0]!.id);
  const rest = await readSettingChanges(db, page[50]!.id, 51);
  assert.equal(rest.length, 9);
  assert.ok(rest.every((r) => r.id < page[50]!.id));
  await db.close();
  const empty = await testDb();
  assert.equal(await settingsVersion(empty), 0);
  await empty.close();
});

test('the lock is the first statement of the transaction that takes it', async () => {
  const db = await testDb();
  const seen: string[] = [];
  const spy = (inner: Db): Db => ({
    query: (text, params) => { seen.push(text); return inner.query(text, params); },
    script: (sql) => inner.script(sql),
    close: () => inner.close(),
    transaction: (work) => inner.transaction((tx) => work(spy(tx))),
  });
  await spy(db).transaction(async (tx) => { await lockSettings(tx); await readSettings(tx); });
  assert.equal(seen.length, 2);
  assert.match(seen[0]!, /^lock table visto_ai\.settings in share row exclusive mode/);
  assert.match(seen[1]!, /^select scope, path, value/);
  await db.close();
});
