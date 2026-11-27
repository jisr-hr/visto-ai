import { expect, test } from 'vitest';
import type { Setting, SettingsView } from './api-types.ts';
import {
  changesOf, DEFAULTS, effortChoice, effortValue, GLOBAL, keyOf, numberOrText, overridesOf, REPOSITORY_NAME, repositoryNames, shown, UNSET,
  valueText, withChange,
} from './settings-draft.ts';
import type { Draft } from './settings-draft.ts';

const set = (value: Setting['value'], written = false): Setting => ({
  written, value, source: written ? { by: 'ui', name: 'octo-lead', at: '2026-03-01T10:00:00.000Z' } : null, restart: false, waits: false,
});
const VIEW: SettingsView = {
  now: '2026-03-01T10:00:00.000Z', version: 14,
  global: { learning: set(false), 'extra.map': set({ b: 1, a: 2 }, true) },
  defaults: { 'score.threshold': set(60), 'score.mode': set('full', true) },
  repositories: [{ name: 'acme/shop', settings: { 'score.threshold': set(60), 'score.mode': set('light', true) } }],
  scorer: { on: false, waits: false }, endpoints: { model: 'https://llm.example.test/v1', scorer: null }, secrets: [], access: { publicUrl: 'https://visto.example.test', github: true, accounts: [], team: null },
};
const EMPTY: Draft = new Map();

test('a setting shows the draft over the view, and a repository not overriding shows the defaults as drafted', () => {
  expect(keyOf('acme/web', 'score.threshold')).not.toBe(keyOf('acme/shop', 'score.threshold'));
  const draft = withChange(EMPTY, DEFAULTS, 'score.threshold', 65);
  expect(shown(VIEW, draft, 'acme/web', 'score.threshold')).toMatchObject({ written: false, value: 65, edited: false });
  expect(shown(VIEW, draft, DEFAULTS, 'score.threshold')).toMatchObject({ written: true, value: 65, edited: true });
  // A repository the view lists, not writing the key, shows the defaults as drafted; one that writes it shows its own.
  expect(shown(VIEW, draft, 'acme/shop', 'score.threshold')).toMatchObject({ written: false, value: 65 });
  expect(shown(VIEW, draft, 'acme/shop', 'score.mode')).toMatchObject({ written: true, value: 'light', edited: false });
  const unset = withChange(draft, 'acme/shop', 'score.mode', UNSET);
  expect(shown(VIEW, unset, 'acme/shop', 'score.mode')).toMatchObject({ written: false, value: 'full', edited: true });
  const shop = withChange(draft, 'acme/shop', 'score.threshold', UNSET);
  expect(shown(VIEW, shop, 'acme/shop', 'score.threshold')).toMatchObject({ written: false, value: 65, edited: true });
  expect(shown(VIEW, EMPTY, GLOBAL, 'learning')).toMatchObject({ written: false, value: false, edited: false, source: null });
});

test('only what differs from the view is a change, sorted, and unsetting sends no value', () => {
  let draft = withChange(EMPTY, GLOBAL, 'extra.map', { a: 2, b: 1 });
  draft = withChange(draft, GLOBAL, 'learning', false);
  // learning false equals the view's value but is not written there: writing it is a change; the map in another key order is none.
  expect(changesOf(VIEW, draft)).toEqual([{ scope: GLOBAL, path: 'learning', value: false }]);
  draft = withChange(EMPTY, GLOBAL, 'extra.map', { a: 2, b: 1 });
  expect(changesOf(VIEW, draft)).toEqual([]);
  draft = withChange(draft, 'acme/shop', 'score.mode', UNSET);
  draft = withChange(draft, DEFAULTS, 'score.threshold', 70);
  draft = withChange(draft, GLOBAL, 'extra.map', UNSET);
  const changes = changesOf(VIEW, draft);
  expect(changes).toEqual([
    { scope: 'acme/shop', path: 'score.mode' },
    { scope: DEFAULTS, path: 'score.threshold', value: 70 },
    { scope: GLOBAL, path: 'extra.map' },
  ]);
  expect('value' in changes[0]!).toBe(false);
  // Unsetting what was never written is nothing.
  expect(changesOf(VIEW, withChange(EMPTY, GLOBAL, 'learning', UNSET))).toEqual([]);
});

test('numbers, effort and values read as pinned', () => {
  expect(numberOrText('45')).toBe(45);
  expect(numberOrText(' 1.5 ')).toBe(1.5);
  expect(numberOrText('')).toBe('');
  expect(numberOrText('abc')).toBe('abc');
  expect(numberOrText('Infinity')).toBe('Infinity');
  expect(effortChoice({})).toBe('none');
  expect(effortChoice({ reasoning: { effort: 'high' } })).toBe('high');
  expect(effortChoice({ reasoning: { effort: 'low' } })).toBe('low');
  expect(effortChoice({ reasoning: { effort: 'max' } })).toBe('custom');
  expect(effortChoice({ reasoning: { effort: 'high' }, x: 1 })).toBe('custom');
  expect(effortChoice('high')).toBe('custom');
  expect(effortValue('none')).toEqual({});
  expect(effortValue('medium')).toEqual({ reasoning: { effort: 'medium' } });
  expect(valueText('baseBranches', [])).toBe('*');
  expect(valueText('primaryBranches', ['main', 'master'])).toBe('main, master');
  expect(valueText('ignoredAuthors', [])).toBe('none');
  expect(valueText('learning', true)).toBe('On');
  expect(valueText('learning', false)).toBe('Off');
  expect(valueText('x', null)).toBe('none');
  expect(valueText('x', 65)).toBe('65');
  expect(valueText('x', { a: 1 })).toBe('{"a":1}');
  expect(REPOSITORY_NAME.test('acme/web')).toBe(true);
  expect(REPOSITORY_NAME.test('Acme/web')).toBe(false);
});

test('the repositories are the view\'s, those added and those the draft names, sorted, once each', () => {
  const draft = withChange(withChange(EMPTY, 'acme/web', 'score.threshold', 70), 'acme/shop', 'score.mode', UNSET);
  expect(repositoryNames(VIEW, draft, ['acme/tools', 'acme/shop'])).toEqual(['acme/shop', 'acme/tools', 'acme/web']);
  expect(repositoryNames(VIEW, EMPTY, [])).toEqual(['acme/shop']);
  expect(overridesOf(VIEW, EMPTY, 'acme/shop')).toBe(1);
  expect(overridesOf(VIEW, withChange(EMPTY, 'acme/shop', 'score.mode', UNSET), 'acme/shop')).toBe(0);
  expect(overridesOf(VIEW, withChange(EMPTY, 'acme/shop', 'score.threshold', 70), 'acme/shop')).toBe(2);
  expect(overridesOf(VIEW, withChange(EMPTY, 'acme/web', 'score.threshold', 70), 'acme/web')).toBe(1);
});
