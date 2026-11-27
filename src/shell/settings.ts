// The settings the service runs on: config.yml synced with the database at each start, and a save from the UI, each in one
// transaction whose first statement is the settings' lock (the UI design 3.4 and 4.2 to 4.5; calls 13 to 17, 22 and 27).
// Nothing but `check` decides whether settings are good. No log line or error holds a value or a name.
import { ConfigError } from '../config/load.ts';
import type { ServiceConfig } from '../config/load.ts';
import {
  AT_START, GLOBAL, editableOf, filePathOf, inForceEditable, isSetting, keyParts, sameValue, scorerOn, settingKey, settingOfIssue,
  withEditable,
} from '../config/editable.ts';
import type { Editable, SettingValue } from '../config/editable.ts';
import {
  deleteSetting, lockSettings, readFileSettings, readSettings, recordSettingChange, replaceFileSettings, settingsVersion, writeSetting,
} from '../db/settings.ts';
import type { SettingRow } from '../db/settings.ts';
import { storableValue } from '../db/text.ts';
import type { Db } from '../db/types.ts';

/** No value: not written ("use the default"). */
export interface AskedChange { scope: string; path: string; value?: SettingValue }
/** An issue at a setting, or (scope and path null) at none, with its whole line. */
export interface SettingIssue { scope: string | null; path: string | null; message: string }
export type SaveOutcome =
  | { kind: 'saved'; changed: number; restart: boolean }
  | { kind: 'changed' }
  | { kind: 'invalid'; issues: SettingIssue[] };

export interface Settings {
  /** When this start read the settings (ISO): a restart gives a newer one. */
  readonly started: string;
  /** The file's document as read at this start. */
  readonly file: unknown;
  /** The editable part this start left in the database. */
  readonly startEditable: Editable;
  /** The file's own part with startEditable: what the service started on. */
  readonly atStart: ServiceConfig;
  /** What the service runs on now (call 19). */
  inForce(): ServiceConfig;
  /** As last saved: what the next start runs on, the file unchanged. */
  saved(): { editable: Editable; config: ServiceConfig };
  save(version: number, changes: readonly AskedChange[], by: string): Promise<SaveOutcome>;
}

/** How many settings saved in the UI a refused start names. */
export const CLASH_NAMED = 10;

export function issuesOf(error: ConfigError): SettingIssue[] {
  return error.details.map((detail, i) => {
    const setting = settingOfIssue(detail.path);
    return setting === null
      ? { scope: null, path: null, message: error.issues[i] ?? detail.message }
      : { scope: setting.scope, path: setting.path, message: detail.message };
  });
}

function partOf(rows: ReadonlyArray<{ scope: string; path: string; value: unknown }>): Map<string, SettingValue> {
  return new Map(rows.map((r) => [settingKey(r.scope, r.path), r.value as SettingValue]));
}

/** The start's refusal (call 14): the issues, then, when some setting came from the UI, the sentence naming them. */
function clash(error: ConfigError, part: readonly SettingRow[]): ConfigError {
  const fromUi = part.filter((r) => r.set_by === 'ui').map((r) => filePathOf(r.scope, r.path)).sort();
  if (fromUi.length === 0) return error;
  const more = fromUi.length > CLASH_NAMED ? `, and ${fromUi.length - CLASH_NAMED} more` : '';
  const sentence = `Saved in the UI: ${fromUi.slice(0, CLASH_NAMED).join(', ')}${more}; with them config.yml does not pass. `
    + 'Changing them in config.yml (another value, or removed) settles it: a setting changed in the file wins at the next start.';
  return new ConfigError([...error.issues, sentence], [...error.details, { path: [], message: sentence }]);
}

interface Started { part: Editable; config: ServiceConfig; fromFile: number; fromUi: number; version: number }

interface StartDeps {
  db: Db; file: unknown; check: (document: unknown) => ServiceConfig; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  /** Whether the file turns the UI on (it writes `ui.publicUrl`); false: the start copies the file whole (call 13). */
  uiOn: boolean;
}

/** The sync (call 13), in `tx`; `now` is the file's part as the database keeps it. */
async function sync(tx: Db, deps: StartDeps, now: ReadonlyMap<string, SettingValue>, at: string): Promise<Started> {
  await lockSettings(tx);
  const last = partOf(await readFileSettings(tx));
  const stored = new Map((await readSettings(tx)).map((r) => [settingKey(r.scope, r.path), r]));
  const walked = new Set([...(deps.uiOn ? last.keys() : stored.keys()), ...now.keys()]);
  let fromFile = 0;
  for (const key of [...walked].sort()) {
    const value = now.get(key);
    const row = stored.get(key);
    const before = row === undefined ? undefined : row.value as SettingValue;
    const fromTheFile = deps.uiOn ? !sameValue(last.get(key), value) : !sameValue(before, value) || row?.set_by === 'ui';
    if (!fromTheFile) continue;
    const { scope, path } = keyParts(key);
    if (value === undefined) await deleteSetting(tx, scope, path);
    else await writeSetting(tx, { scope, path, value, by: 'config.yml', name: null, at });
    if (!sameValue(before, value)) {
      await recordSettingChange(tx, { at, by: 'config.yml', name: null, scope, path, before, after: value });
      fromFile += 1;
    }
  }
  await replaceFileSettings(tx, [...now.keys()].sort().map((key) => ({ ...keyParts(key), value: now.get(key) })));
  const rows = await readSettings(tx);
  const part = partOf(rows);
  let config: ServiceConfig;
  try {
    config = deps.check(withEditable(deps.file, part));
  } catch (error) {
    throw error instanceof ConfigError ? clash(error, rows) : error;
  }
  return { part, config, fromFile, fromUi: rows.filter((r) => r.set_by === 'ui').length, version: await settingsVersion(tx) };
}

type Saving =
  | { kind: 'changed' }
  | { kind: 'invalid'; issues: SettingIssue[] }
  | { kind: 'saved'; changed: number; restart: boolean; version: number; editable: Editable; saved: ServiceConfig; inForce: ServiceConfig };

export async function startSettings(deps: StartDeps): Promise<Settings> {
  const { db, file, check, clock, log } = deps;
  // Compared and stored as the database keeps them, so a value it would change is not seen as changed at every start.
  const now = new Map([...editableOf(file)].map(([key, value]) => [key, storableValue(value) as SettingValue]));
  const startedAt = clock().toISOString();
  const started = await db.transaction((tx) => sync(tx, deps, now, startedAt));
  log({ event: 'settings', from_file: started.fromFile, from_ui: started.fromUi });
  const startEditable = started.part;
  let held = { version: started.version, editable: startEditable, saved: started.config, inForce: started.config };

  async function save(version: number, changes: readonly AskedChange[], by: string): Promise<SaveOutcome> {
    const result = await db.transaction(async (tx): Promise<Saving> => {
      await lockSettings(tx);
      if (await settingsVersion(tx) !== version) return { kind: 'changed' };
      const stored = partOf(await readSettings(tx));
      const next = new Map(stored);
      for (const c of changes) {
        if (!isSetting(c.scope, c.path)) throw new Error('bad_change');
        const key = settingKey(c.scope, c.path);
        // As the database keeps it, and a copy: nothing held follows the caller's value.
        if (c.value === undefined) next.delete(key);
        else next.set(key, storableValue(c.value) as SettingValue);
      }
      let saved: ServiceConfig;
      let inForce: ServiceConfig;
      try {
        saved = check(withEditable(file, next));
        inForce = check(withEditable(file, inForceEditable(startEditable, next)));
      } catch (error) {
        if (error instanceof ConfigError) return { kind: 'invalid', issues: issuesOf(error) };
        throw error;
      }
      const at = clock().toISOString();
      const current = new Map(stored);
      let changed = 0;
      let last = version;
      for (const c of changes) {
        const key = settingKey(c.scope, c.path);
        const before = current.get(key);
        const after = c.value === undefined ? undefined : storableValue(c.value) as SettingValue;
        if (sameValue(before, after)) continue;
        if (after === undefined) {
          await deleteSetting(tx, c.scope, c.path);
          current.delete(key);
        } else {
          await writeSetting(tx, { scope: c.scope, path: c.path, value: after, by: 'ui', name: by, at });
          current.set(key, after);
        }
        last = await recordSettingChange(tx, { at, by: 'ui', name: by, scope: c.scope, path: c.path, before, after });
        changed += 1;
      }
      // A restart is asked while something saved waits for one, as the view says it (`waits`): a setting read at start that
      // differs from the start's, or the second scorer on or off unlike at the start.
      const restart = scorerOn(next) !== scorerOn(startEditable)
        || [...AT_START].some((path) => !sameValue(startEditable.get(settingKey(GLOBAL, path)), next.get(settingKey(GLOBAL, path))));
      return { kind: 'saved', changed, restart, version: last, editable: next, saved, inForce };
    });
    if (result.kind !== 'saved') {
      log({ event: 'settings_save', outcome: result.kind, changes: changes.length });
      return result;
    }
    // Two saves the lock puts in a row may end in either order here: the newer one stays.
    if (result.version > held.version) held = { version: result.version, editable: result.editable, saved: result.saved, inForce: result.inForce };
    log({ event: 'settings_save', outcome: 'saved', changes: result.changed });
    return { kind: 'saved', changed: result.changed, restart: result.restart };
  }

  return {
    started: startedAt,
    file,
    startEditable,
    atStart: started.config,
    inForce: () => held.inForce,
    saved: () => ({ editable: held.editable, config: held.saved }),
    save,
  };
}
