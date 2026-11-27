// The draft of the settings the person has not saved yet (UI design 4 and 5; calls 2, 25 and 26): what they changed, over the
// view the service last gave. A draft key is a setting of one scope; its value is the new one, or UNSET (not written).
import type { Setting, SettingSource, SettingsSave, SettingsView, SettingValue } from './api-types.ts';

export const GLOBAL = 'global';
export const DEFAULTS = 'defaults';
export interface Unset { readonly unset: true }
export const UNSET: Unset = { unset: true };
export type Draft = ReadonlyMap<string, SettingValue | Unset>;

/** A repository's name as the service reads one. */
export const REPOSITORY_NAME = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/;

// A scope is `global`, `defaults` or a repository's name, none holding a colon, so the first colon ends the scope.
export function keyOf(scope: string, path: string): string {
  return `${scope}:${path}`;
}
function splitKey(key: string): { scope: string; path: string } {
  const colon = key.indexOf(':');
  return { scope: key.slice(0, colon), path: key.slice(colon + 1) };
}
const isUnset = (value: SettingValue | Unset): value is Unset => typeof value === 'object' && value !== null && 'unset' in value && value.unset === true;

/** A value's JSON with the keys of every map sorted, so two values are the same when their text is. */
function canonical(value: SettingValue): string {
  const sorted = (inner: SettingValue): SettingValue => {
    if (Array.isArray(inner)) return inner.map(sorted);
    if (typeof inner === 'object' && inner !== null) {
      const out: { [key: string]: SettingValue } = {};
      for (const key of Object.keys(inner).sort()) out[key] = sorted(inner[key]!);
      return out;
    }
    return inner;
  };
  return JSON.stringify(sorted(value));
}

export interface Shown { written: boolean; value: SettingValue; edited: boolean; source: SettingSource | null; restart: boolean; waits: boolean }

const inView = (view: SettingsView, scope: string, path: string): Setting | undefined => {
  if (scope === GLOBAL) return view.global[path];
  if (scope === DEFAULTS) return view.defaults[path];
  return view.repositories.find((repository) => repository.name === scope)?.settings[path];
};

/**
 * A setting as the screen shows it: the draft's value when it holds the key (UNSET: not written), else the view's. A repository's
 * setting not written shows the defaults', as drafted; a repository the view does not list reads as every key not written.
 */
export function shown(view: SettingsView, draft: Draft, scope: string, path: string): Shown {
  const key = keyOf(scope, path);
  const mine = draft.get(key);
  const was = inView(view, scope, path);
  const flags = { restart: was?.restart ?? false, waits: was?.waits ?? false };
  const edited = draft.has(key);
  if (mine !== undefined && !isUnset(mine)) return { written: true, value: mine, edited, source: null, ...flags };
  if (mine === undefined && was?.written === true) return { written: true, value: was.value, edited, source: was.source, ...flags };
  // Not written: a repository shows the defaults as drafted; global and the defaults show what the view says.
  if (scope !== GLOBAL && scope !== DEFAULTS) {
    const under = shown(view, draft, DEFAULTS, path);
    return { written: false, value: under.value, edited, source: null, restart: flags.restart || under.restart, waits: flags.waits || under.waits };
  }
  return { written: false, value: was?.value ?? null, edited, source: null, ...flags };
}

export function withChange(draft: Draft, scope: string, path: string, value: SettingValue | Unset): Draft {
  return new Map(draft).set(keyOf(scope, path), value);
}

/** One change for each draft key whose written-ness or value differs from the view's, by scope then path; UNSET has no value. */
export function changesOf(view: SettingsView, draft: Draft): SettingsSave['changes'] {
  const changes: SettingsSave['changes'] = [];
  for (const [key, mine] of draft) {
    const { scope, path } = splitKey(key);
    const was = inView(view, scope, path);
    if (isUnset(mine)) {
      if (was?.written === true) changes.push({ scope, path });
    } else if (was?.written !== true || canonical(was.value) !== canonical(mine)) {
      changes.push({ scope, path, value: mine });
    }
  }
  return changes.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** How many settings a repository writes of its own, with the draft applied. */
export function overridesOf(view: SettingsView, draft: Draft, name: string): number {
  const written = new Set<string>();
  for (const [path, setting] of Object.entries(view.repositories.find((repository) => repository.name === name)?.settings ?? {})) {
    if (setting.written) written.add(path);
  }
  for (const [key, value] of draft) {
    const { scope, path } = splitKey(key);
    if (scope !== name) continue;
    if (isUnset(value)) written.delete(path);
    else written.add(path);
  }
  return written.size;
}

/** The view's repositories, those added and those the draft names, sorted, once each. */
export function repositoryNames(view: SettingsView, draft: Draft, added: readonly string[]): string[] {
  const names = new Set<string>([...view.repositories.map((repository) => repository.name), ...added]);
  for (const key of draft.keys()) {
    const { scope } = splitKey(key);
    if (scope !== GLOBAL && scope !== DEFAULTS) names.add(scope);
  }
  return [...names].sort();
}

/** A number when the text, trimmed, is not empty and is a finite number; else the text as it is (the service refuses it at its field). */
export function numberOrText(text: string): SettingValue {
  const trimmed = text.trim();
  if (trimmed === '') return text;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : text;
}

export type EffortChoice = 'none' | 'low' | 'medium' | 'high' | 'custom';
const EFFORTS = ['low', 'medium', 'high'] as const;

/** `{}` is none; `{ reasoning: { effort } }` and nothing else is that effort; any other value is custom. */
export function effortChoice(value: SettingValue): EffortChoice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'custom';
  const keys = Object.keys(value);
  if (keys.length === 0) return 'none';
  const reasoning = value.reasoning;
  if (keys.length !== 1 || keys[0] !== 'reasoning' || typeof reasoning !== 'object' || reasoning === null || Array.isArray(reasoning)) return 'custom';
  const inner = Object.keys(reasoning);
  const effort = reasoning.effort;
  return inner.length === 1 && EFFORTS.some((name) => name === effort) ? (effort as EffortChoice) : 'custom';
}

export function effortValue(choice: Exclude<EffortChoice, 'custom'>): SettingValue {
  return choice === 'none' ? {} : { reasoning: { effort: choice } };
}

/** A value as a row says it: lists joined with ', ' (an empty baseBranches '*', another empty list 'none'), true 'On', false 'Off', null 'none', a map as JSON. */
export function valueText(path: string, value: SettingValue): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return path === 'baseBranches' ? '*' : 'none';
    return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ');
  }
  if (value === true) return 'On';
  if (value === false) return 'Off';
  if (value === null) return 'none';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
