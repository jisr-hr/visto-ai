// The four settings routes' work (UI design 3.2, 4 and 5; calls 12, 15 to 18, 22 to 24 and 27): the view, the save, the record of
// changes and the export. Every answer is built field by field from an allowlist, out of the rows and the saved configuration; no
// secret's value, no loaded configuration and no raw row leaves. A secret is its variable's name and whether it is set.
import {
  AT_START, DEFAULTS, GLOBAL, GLOBAL_PATHS, REPOSITORY_PATHS, canonical, exportText, isSetting, sameValue, scorerOn, secretsOf, settingKey,
  shownValues,
} from '../config/editable.ts';
import type { Editable, SettingValue } from '../config/editable.ts';
import { knownRepositories } from '../db/activity.ts';
import { readSettingChanges, readSettings, settingsVersion } from '../db/settings.ts';
import type { Db } from '../db/types.ts';
import type { UiAnswer } from '../shell/http.ts';
import type { Settings } from '../shell/settings.ts';
import { json } from './headers.ts';
import type {
  Setting, SettingChangeRow, SettingChanges, SettingIssue, SettingsExport, SettingsInvalid, SettingsSave, SettingsView,
} from './api-types.ts';

export interface SettingsApiDeps {
  db: Db; clock: () => Date; settings: Settings; log: (entry: Record<string, unknown>) => void;
  access: SettingsView['access'];
}

export const CHANGES_SHOWN = 50;
/** A value of the record is cut at this many characters. */
export const VALUE_SHOWN = 200;
export const MAX_CHANGES = 500;
const MAX_INT = 2147483647;
/** Repositories read from the activity besides those with a row. */
const KNOWN_SHOWN = 200;

const isMapping = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value's JSON text from Postgres (keys reordered), parsed and written again with sorted keys, cut at VALUE_SHOWN. */
function shownText(text: string | null): string | null {
  if (text === null) return null;
  const whole = canonical(JSON.parse(text) as SettingValue);
  if (whole.length <= VALUE_SHOWN) return whole;
  // Never cut a surrogate pair in two.
  const cut = /[\uD800-\uDBFF]/.test(whole.charAt(VALUE_SHOWN - 1)) ? VALUE_SHOWN - 1 : VALUE_SHOWN;
  return `${whole.slice(0, cut)}...`;
}

/** The scorer's address as the file writes it (the schema's default when its block has none); null with no scorer block. */
const SCORER_DEFAULT_URL = 'https://openrouter.ai/api/alpha';
function scorerEndpoint(file: unknown): string | null {
  const block = isMapping(file) ? file.scorer : undefined;
  if (!isMapping(block)) return null;
  return typeof block.baseUrl === 'string' ? block.baseUrl : SCORER_DEFAULT_URL;
}

export async function settingsView(deps: SettingsApiDeps): Promise<SettingsView> {
  const { db, settings } = deps;
  // The version first: a save between the two reads gives an older version with newer rows, which the next save meets as a 409.
  const version = await settingsVersion(db);
  const rows = await readSettings(db);
  const byKey = new Map(rows.map((row) => [settingKey(row.scope, row.path), row]));
  const saved: Editable = new Map(rows.map((row) => [settingKey(row.scope, row.path), row.value as SettingValue]));
  const names = [...new Set([
    ...rows.map((row) => row.scope).filter((scope) => scope !== GLOBAL && scope !== DEFAULTS),
    ...(await knownRepositories(db, KNOWN_SHOWN)).map((name) => name.toLowerCase()),
  ])].sort();
  const shown = shownValues(settings.saved().config, names);

  const settingOf = (scope: string, path: string): Setting => {
    const key = settingKey(scope, path);
    const row = byKey.get(key);
    const start = scope === GLOBAL && AT_START.has(path);
    return {
      written: row !== undefined,
      value: row === undefined ? (shown.get(key) ?? null) : structuredClone(row.value as SettingValue),
      source: row === undefined ? null : { by: row.set_by, name: row.set_by_name, at: row.set_at.toISOString() },
      restart: start,
      waits: start && !sameValue(settings.startEditable.get(key), saved.get(key)),
    };
  };
  const section = (scope: string, paths: readonly string[]): Record<string, Setting> =>
    Object.fromEntries(paths.map((path) => [path, settingOf(scope, path)]));

  return {
    now: deps.clock().toISOString(),
    version,
    global: section(GLOBAL, GLOBAL_PATHS),
    defaults: section(DEFAULTS, REPOSITORY_PATHS),
    repositories: names.map((name) => ({ name, settings: section(name, REPOSITORY_PATHS) })),
    scorer: { on: scorerOn(saved), waits: scorerOn(saved) !== scorerOn(settings.startEditable) },
    endpoints: { model: settings.atStart.model.baseUrl, scorer: scorerEndpoint(settings.file) },
    secrets: secretsOf(settings.file).map((secret) => ({ kind: secret.kind, of: secret.of, variable: secret.variable })),
    access: {
      publicUrl: deps.access.publicUrl, github: deps.access.github, accounts: [...deps.access.accounts], team: deps.access.team,
    },
  };
}


/** Whether a string anywhere in `value`, a key included, holds U+0000 or a lone surrogate (call 18); walked without recursion. */
function brokenText(value: unknown): boolean {
  const open: unknown[] = [value];
  while (open.length > 0) {
    const item = open.pop();
    if (typeof item === 'string') {
      if (item.includes(String.fromCharCode(0)) || !item.isWellFormed()) return true;
    } else if (Array.isArray(item)) {
      open.push(...item);
    } else if (isMapping(item)) {
      for (const key of Object.keys(item)) {
        if (key.includes(String.fromCharCode(0)) || !key.isWellFormed()) return true;
        open.push(item[key]);
      }
    }
  }
  return false;
}

/** The body of a save; null when it is not of its shape. */
export function saveOf(body: Record<string, unknown>): SettingsSave | null {
  const keys = Object.keys(body);
  if (keys.length !== 2 || !Object.hasOwn(body, 'version') || !Object.hasOwn(body, 'changes')) return null;
  const { version, changes } = body;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > MAX_INT) return null;
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > MAX_CHANGES) return null;
  const seen = new Set<string>();
  const out: SettingsSave['changes'] = [];
  for (const change of changes as unknown[]) {
    if (!isMapping(change)) return null;
    const names = Object.keys(change);
    if (!names.every((name) => name === 'scope' || name === 'path' || name === 'value')) return null;
    const { scope, path } = change;
    if (typeof scope !== 'string' || typeof path !== 'string' || !isSetting(scope, path)) return null;
    const key = settingKey(scope, path);
    if (seen.has(key)) return null;
    seen.add(key);
    if (Object.hasOwn(change, 'value')) {
      if (brokenText(change.value)) return null;
      out.push({ scope, path, value: change.value as SettingValue });
    } else {
      out.push({ scope, path });
    }
  }
  return { version, changes: out };
}

export async function saveSettings(deps: SettingsApiDeps, by: string, save: SettingsSave): Promise<UiAnswer> {
  const outcome = await deps.settings.save(save.version, save.changes, by);
  if (outcome.kind === 'saved') return json(200, await settingsView(deps));
  if (outcome.kind === 'changed') return json(409, { error: 'changed' });
  const issues: SettingIssue[] = outcome.issues.map((issue) => ({ scope: issue.scope, path: issue.path, message: issue.message }));
  return json(422, { error: 'invalid', issues } satisfies SettingsInvalid);
}

export async function settingChanges(deps: SettingsApiDeps, query: URLSearchParams): Promise<SettingChanges | 'bad_request'> {
  const asked = query.get('before') ?? '';
  let before: number | null = null;
  if (asked !== '') {
    if (!/^\d{1,10}$/.test(asked) || Number(asked) > MAX_INT) return 'bad_request';
    before = Number(asked);
  }
  const rows = await readSettingChanges(deps.db, before, CHANGES_SHOWN + 1);
  const shown = rows.slice(0, CHANGES_SHOWN);
  const changes: SettingChangeRow[] = shown.map((row) => ({
    id: row.id, at: row.at.toISOString(), by: row.by, name: row.by_name, scope: row.scope, path: row.path,
    before: shownText(row.before), after: shownText(row.after),
  }));
  return { changes, next: rows.length > CHANGES_SHOWN ? shown[shown.length - 1]!.id : null };
}

export function settingsExport(deps: SettingsApiDeps): SettingsExport {
  return { text: exportText(deps.settings.file, deps.settings.saved().editable, deps.clock().toISOString()) };
}
