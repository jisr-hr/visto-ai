import { expect, test } from 'vitest';
import { createApi, RequestFailed } from './api.ts';
import type { SettingChanges, SettingsExport, SettingsSave, SettingsView } from './api-types.ts';

const VIEW: SettingsView = {
  now: '2026-03-01T10:00:00.000Z', started: '2026-03-01T09:00:00.000Z', version: 14, global: {}, defaults: {}, repositories: [],
  scorer: { on: false, waits: false }, endpoints: { model: 'https://llm.example.test/v1', scorer: null }, secrets: [], access: { publicUrl: 'https://visto.example.test', github: true, accounts: [], teams: [] },
};
const SAVE: SettingsSave = { version: 14, changes: [{ scope: 'global', path: 'learning', value: true }] };

test('the settings calls send what the service reads and read what it answers', async () => {
  const seen: [string, RequestInit | undefined][] = [];
  const answers: (() => Response)[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push([String(input), init]);
    const next = answers.shift();
    return next ? Promise.resolve(next()) : Promise.reject(new TypeError('Failed to fetch'));
  }) as typeof fetch;
  const api = createApi(fetchFn);
  const jsonOf = (status: number, value: unknown) => () =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const get = { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } };
  const issues = [{ scope: 'global', path: 'learning', message: 'must be on or off' }];
  const changes: SettingChanges = { changes: [], next: null };
  const exported: SettingsExport = { text: 'learning: true\n' };

  answers.push(
    jsonOf(200, VIEW), jsonOf(200, VIEW), jsonOf(200, { ...VIEW, restarting: true }), jsonOf(422, { error: 'invalid', issues }), jsonOf(409, { error: 'changed' }), jsonOf(422, { error: 'too_long' }),
    jsonOf(200, changes), jsonOf(200, changes), jsonOf(200, exported),
  );
  expect(await api.settings()).toEqual(VIEW);
  expect(await api.saveSettings('tok', SAVE)).toEqual({ kind: 'saved', view: VIEW, restarting: false });
  // The view keeps none of the answer's own field.
  expect(await api.saveSettings('tok', SAVE)).toEqual({ kind: 'saved', view: VIEW, restarting: true });
  expect(await api.saveSettings('tok', SAVE)).toEqual({ kind: 'invalid', issues });
  await expect(api.saveSettings('tok', SAVE)).rejects.toEqual(new RequestFailed(409, 'changed'));
  await expect(api.saveSettings('tok', SAVE)).rejects.toEqual(new RequestFailed(422, 'too_long'));
  expect(await api.settingChanges(8977)).toEqual(changes);
  expect(await api.settingChanges()).toEqual(changes);
  expect(await api.settingsExport()).toEqual(exported);

  const put = {
    method: 'PUT', credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-visto-csrf': 'tok' }, body: JSON.stringify(SAVE),
  };
  expect(seen).toEqual([
    ['/api/settings', get],
    ['/api/settings', put], ['/api/settings', put], ['/api/settings', put], ['/api/settings', put], ['/api/settings', put],
    ['/api/settings/changes?before=8977', get],
    ['/api/settings/changes', get],
    ['/api/settings/export', get],
  ]);
});

test('the reads of the overview, repositories and memory ask their own paths, and a switch sends the token and the body', async () => {
  const seen: [string, RequestInit | undefined][] = [];
  const answers: (() => Response)[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push([String(input), init]);
    const next = answers.shift();
    return next ? Promise.resolve(next()) : Promise.reject(new TypeError('Failed to fetch'));
  }) as typeof fetch;
  const api = createApi(fetchFn);
  const jsonOf = (status: number, value: unknown) => () =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const get = { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } };
  const ok = { now: '2026-03-01T10:00:00.000Z' };

  answers.push(
    jsonOf(200, ok), jsonOf(200, ok), jsonOf(200, ok), jsonOf(200, ok), jsonOf(200, ok), jsonOf(200, ok), jsonOf(200, ok),
    jsonOf(200, { record: { id: 7 } }), jsonOf(403, { error: 'forbidden' }),
  );
  await api.overview(7);
  await api.health();
  await api.repositories();
  await api.quality('acme/shop', 'all');
  await api.quality('acme/we b', 30);
  await api.memory({});
  await api.memory({ kind: 'lesson', q: 'a b' });
  expect(seen.slice(0, 7)).toEqual([
    ['/api/overview?days=7', get], ['/api/health', get], ['/api/repositories', get],
    ['/api/repositories/acme/shop/quality?days=all', get], ['/api/repositories/acme/we%20b/quality?days=30', get],
    ['/api/memory', get], [expect.stringMatching(/^\/api\/memory\?kind=lesson&q=a(%20|\+)b$/), get],
  ]);

  expect(await api.switchMemory('t', 7, false)).toEqual({ record: { id: 7 } });
  expect(seen[7]).toEqual([
    '/api/memory/7',
    {
      method: 'PUT', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-visto-csrf': 't' },
      body: '{"on":false}',
    },
  ]);
  await expect(api.switchMemory('t', 7, true)).rejects.toEqual(new RequestFailed(403, 'forbidden'));
});
