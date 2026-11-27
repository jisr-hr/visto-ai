import { stringify } from 'yaml';
import { approvalOf, repoSettingsFor } from './load.ts';
import type { DeploymentConfig, RepoSettings } from './load.ts';

export type SettingValue = null | boolean | number | string | SettingValue[] | { [key: string]: SettingValue };

export const GLOBAL = 'global';
export const DEFAULTS = 'defaults';

export const GLOBAL_PATHS: readonly string[] = [
  'dryRun', 'learning', 'limits.spendPerDay', 'limits.queueConcurrency', 'limits.inputTokensPerCall', 'limits.batchesPerReview',
  'model.model', 'model.fallbacks', 'model.effort.default', 'model.effort.elevated', 'model.toolChoice', 'model.timeoutSeconds',
  'model.prices', 'model.extraBody', 'model.extraHeaders', 'scorer.model', 'scorer.timeoutSeconds',
];

export const REPOSITORY_PATHS: readonly string[] = [
  'primaryBranches', 'ignoredAuthors', 'baseBranches', 'newHead', 'score.threshold', 'score.inlineNotes', 'score.autoApprove', 'score.approvalThreads',
  'score.auditShare', 'gate.enabled', 'gate.branches', 'gate.checkName', 'gate.mode', 'gate.clearByReply', 'gate.skipTeam', 'gate.requiredChecks',
];

/** Global paths read once when the service starts (call 19); whether the scorer is on is start-time too. */
export const AT_START: ReadonlySet<string> = new Set([
  'dryRun', 'learning', 'limits.queueConcurrency', 'model.timeoutSeconds', 'model.toolChoice',
]);

/** A repository's scope once lower-cased. */
export const REPOSITORY_SCOPE = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/;

export function settingKey(scope: string, path: string): string {
  return `${scope}:${path}`;
}

/** Split at the first ':' (a scope holds none). */
export function keyParts(key: string): { scope: string; path: string } {
  const at = key.indexOf(':');
  return at === -1 ? { scope: key, path: '' } : { scope: key.slice(0, at), path: key.slice(at + 1) };
}

export function isSetting(scope: string, path: string): boolean {
  if (scope === GLOBAL) return GLOBAL_PATHS.includes(path);
  return (scope === DEFAULTS || REPOSITORY_SCOPE.test(scope)) && REPOSITORY_PATHS.includes(path);
}

/** Every setting written, keyed by settingKey. */
export type Editable = ReadonlyMap<string, SettingValue>;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const has = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** The value an object holds at a path of keys: own properties only, `undefined` counts as not written. */
function valueAt(root: unknown, segments: readonly string[]): { value: unknown } | null {
  let node = root;
  for (const key of segments) {
    if (!isMapping(node) || !has(node, key)) return null;
    node = node[key];
  }
  return node === undefined ? null : { value: node };
}

/** Sets a value at a path of keys, creating the objects on the way. */
function setAt(root: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let node = root;
  for (const key of segments.slice(0, -1)) {
    const next = has(node, key) ? node[key] : undefined;
    if (isMapping(next)) {
      node = next;
    } else {
      const made: Record<string, unknown> = {};
      node[key] = made;
      node = made;
    }
  }
  node[segments[segments.length - 1]!] = value;
}

const segmentsOf = (path: string): string[] => path.split('.');

export function editableOf(document: unknown): Editable {
  const out = new Map<string, SettingValue>();
  const take = (scope: string, root: unknown, paths: readonly string[]): void => {
    for (const path of paths) {
      const found = valueAt(root, segmentsOf(path));
      if (found !== null) out.set(settingKey(scope, path), found.value as SettingValue);
    }
  };
  take(GLOBAL, document, GLOBAL_PATHS);
  const repositories = isMapping(document) && has(document, 'repositories') ? document.repositories : undefined;
  const defaults = valueAt(repositories, ['defaults']);
  if (defaults !== null) take(DEFAULTS, defaults.value, REPOSITORY_PATHS);
  const overrides = valueAt(repositories, ['overrides']);
  if (overrides !== null && isMapping(overrides.value)) {
    for (const name of Object.keys(overrides.value).sort()) {
      const scope = name.toLowerCase();
      if (REPOSITORY_SCOPE.test(scope)) take(scope, overrides.value[name], REPOSITORY_PATHS);
    }
  }
  return out;
}

export function scorerOn(editable: Editable): boolean {
  return [...editable.keys()].some((key) => {
    const { scope, path } = keyParts(key);
    return scope === GLOBAL && path.startsWith('scorer.');
  });
}

/** A new document: `document`'s keys config.yml alone holds, with `editable` in place of its editable part (rule 3). */
export function withEditable(document: unknown, editable: Editable): unknown {
  const copy: Record<string, unknown> = isMapping(document) ? structuredClone(document) : {};
  const modelKey = valueAt(copy, ['model', 'apiKey']);
  const scorerKey = valueAt(copy, ['scorer', 'apiKey']);
  // The endpoints are file-only: where the keys are sent is for whoever edits config.yml.
  const modelUrl = valueAt(copy, ['model', 'baseUrl']);
  const scorerUrl = valueAt(copy, ['scorer', 'baseUrl']);
  for (const key of ['dryRun', 'learning', 'limits', 'repositories', 'model', 'scorer']) delete copy[key];

  const byScope = new Map<string, Map<string, SettingValue>>();
  for (const [key, value] of editable) {
    const { scope, path } = keyParts(key);
    if (!isSetting(scope, path)) continue;
    const paths = byScope.get(scope) ?? new Map<string, SettingValue>();
    paths.set(path, value);
    byScope.set(scope, paths);
  }
  const place = (target: Record<string, unknown>, scope: string, order: readonly string[], prefix: readonly string[]): void => {
    const paths = byScope.get(scope);
    if (paths === undefined) return;
    for (const path of order) {
      if (paths.has(path)) setAt(target, [...prefix, ...segmentsOf(path)], structuredClone(paths.get(path)));
    }
  };

  const block: Record<string, unknown> = {};
  if (modelUrl !== null) setAt(block, ['model', 'baseUrl'], modelUrl.value);
  if (modelKey !== null) setAt(block, ['model', 'apiKey'], modelKey.value);
  place(block, GLOBAL, GLOBAL_PATHS, []);
  if (scorerOn(editable) && scorerUrl !== null) setAt(block, ['scorer', 'baseUrl'], scorerUrl.value);
  if (scorerOn(editable) && scorerKey !== null) setAt(block, ['scorer', 'apiKey'], scorerKey.value);
  // The lists' order for the top-level keys, whatever the order the settings were put in.
  for (const top of ['dryRun', 'learning', 'limits', 'model', 'scorer']) if (has(block, top)) copy[top] = block[top];

  const repositories: Record<string, unknown> = {};
  place(repositories, DEFAULTS, REPOSITORY_PATHS, ['defaults']);
  for (const scope of [...byScope.keys()].filter((s) => s !== GLOBAL && s !== DEFAULTS).sort()) {
    place(repositories, scope, REPOSITORY_PATHS, ['overrides', scope]);
  }
  if (Object.keys(repositories).length > 0) copy.repositories = repositories;
  return copy;
}

/** The part in force: `saved`'s, but each start-time setting and the scorer's being on as `atStart` has them (rule 4). */
export function inForceEditable(atStart: Editable, saved: Editable): Editable {
  const out = new Map(saved);
  for (const path of AT_START) {
    const key = settingKey(GLOBAL, path);
    const value = atStart.get(key);
    if (value === undefined) out.delete(key);
    else out.set(key, value);
  }
  if (!scorerOn(atStart)) {
    for (const key of [...out.keys()]) if (keyParts(key).scope === GLOBAL && keyParts(key).path.startsWith('scorer.')) out.delete(key);
  } else if (!scorerOn(saved)) {
    for (const path of ['scorer.model', 'scorer.timeoutSeconds']) {
      const value = atStart.get(settingKey(GLOBAL, path));
      if (value !== undefined) out.set(settingKey(GLOBAL, path), value);
    }
  }
  return out;
}

function sortedJson(value: SettingValue): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(value[k]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** JSON with sorted keys; undefined (not written) is its own text. */
export function canonical(value: SettingValue | undefined): string {
  return value === undefined ? 'undefined' : sortedJson(value);
}

export function sameValue(a: SettingValue | undefined, b: SettingValue | undefined): boolean {
  return canonical(a) === canonical(b);
}

/** The setting an issue's path names; null when it names none. */
export function settingOfIssue(path: ReadonlyArray<string | number>): { scope: string; path: string } | null {
  const keys = path.map(String);
  const head = keys[0];
  if (head === 'dryRun' || head === 'learning') return { scope: GLOBAL, path: head };
  if (head === 'limits' || head === 'model' || head === 'scorer') {
    const two = `${head}.${keys[1] ?? ''}`;
    if (GLOBAL_PATHS.includes(two)) return { scope: GLOBAL, path: two };
    if (head === 'model' && keys[1] === 'effort' && (keys[2] === 'default' || keys[2] === 'elevated')) return { scope: GLOBAL, path: `model.effort.${keys[2]}` };
    return null;
  }
  if (head !== 'repositories') return null;
  let scope: string;
  let rest: string[];
  if (keys[1] === 'defaults') {
    scope = DEFAULTS;
    rest = keys.slice(2);
  } else if (keys[1] === 'overrides' && keys[2] !== undefined) {
    scope = keys[2].toLowerCase();
    if (!REPOSITORY_SCOPE.test(scope)) return null;
    rest = keys.slice(3);
  } else {
    return null;
  }
  if (rest[0] === undefined) return null;
  const two = `${rest[0]}.${rest[1] ?? ''}`;
  if (REPOSITORY_PATHS.includes(two)) return { scope, path: two };
  return REPOSITORY_PATHS.includes(rest[0]) ? { scope, path: rest[0] } : null;
}

/** The path config.yml writes: `learning`, `repositories.defaults.score.threshold`, `repositories.overrides.acme/shop.gate.mode`. */
export function filePathOf(scope: string, path: string): string {
  if (scope === GLOBAL) return path;
  if (scope === DEFAULTS) return `repositories.defaults.${path}`;
  return `repositories.overrides.${scope}.${path}`;
}

function repositoryValues(scope: string, s: RepoSettings, out: Map<string, SettingValue>): void {
  const approval = approvalOf(s);
  const values: Array<[string, SettingValue]> = [
    ['primaryBranches', s.primaryBranches], ['ignoredAuthors', s.ignoredAuthors], ['baseBranches', s.baseBranches], ['newHead', s.newHead],
    ['score.threshold', s.scoreThreshold], ['score.inlineNotes', s.inlineNotes], ['score.autoApprove', approval.enabled],
    ['score.approvalThreads', approval.threads], ['score.auditShare', approval.auditShare], ['gate.enabled', s.gate.enabled],
    ['gate.branches', s.gate.branches], ['gate.checkName', s.gate.checkName], ['gate.mode', s.gate.mode], ['gate.clearByReply', s.gate.clearByReply],
    ['gate.skipTeam', s.gate.skipTeam], ['gate.requiredChecks', s.gate.requiredChecks],
  ];
  for (const [path, value] of values) out.set(settingKey(scope, path), structuredClone(value));
}

/** Every global and defaults setting, and each repository's of `repositories`, as `config` holds it, in the file's shape (rule 6). */
export function shownValues(config: DeploymentConfig, repositories: readonly string[]): Map<string, SettingValue> {
  const out = new Map<string, SettingValue>();
  const { model, scorer, limits } = config;
  const global: Array<[string, SettingValue]> = [
    ['dryRun', config.dryRun], ['learning', config.learning],
    ['limits.spendPerDay', limits.spendPerDay], ['limits.queueConcurrency', limits.queueConcurrency],
    ['limits.inputTokensPerCall', limits.inputTokensPerCall], ['limits.batchesPerReview', limits.batchesPerReview],
    ['model.model', model.model], ['model.fallbacks', model.fallbacks],
    ['model.effort.default', model.effort.default as SettingValue], ['model.effort.elevated', model.effort.elevated as SettingValue],
    ['model.toolChoice', model.toolChoice], ['model.timeoutSeconds', model.timeoutSeconds], ['model.prices', model.prices],
    ['model.extraBody', model.extraBody as SettingValue], ['model.extraHeaders', model.extraHeaders],
    ['scorer.model', scorer?.model ?? null], ['scorer.timeoutSeconds', scorer?.timeoutSeconds ?? null],
  ];
  for (const [path, value] of global) out.set(settingKey(GLOBAL, path), structuredClone(value));
  repositoryValues(DEFAULTS, config.repositories.defaults, out);
  for (const name of repositories) repositoryValues(name.toLowerCase(), repoSettingsFor(config, name), out);
  return out;
}

/** The export (call 24). */
export function exportText(document: unknown, editable: Editable, at: string): string {
  const full = withEditable(document, editable) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of ['dryRun', 'learning', 'limits', 'model', 'scorer', 'repositories']) if (has(full, key)) picked[key] = full[key];
  return `# The settings saved in the UI on ${at}, as config.yml writes them.\n`
    + '# Replace these keys of config.yml with them: a setting changed in the file wins at the next start.\n'
    + stringify(picked);
}

export type SecretKind = 'model_key' | 'scorer_key' | 'app_private_key' | 'webhook_secret' | 'app_client_secret' | 'database' | 'audit_key' | 'alert_webhook' | 'extension' | 'mcp_header';
export interface SecretRef { kind: SecretKind; of: string | null; variable: string | null }

/** The variable a `{ env: NAME }` reference names, or null when the value is not one. */
function referenceOf(value: unknown): string | null {
  if (!isMapping(value)) return null;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'env' && typeof value.env === 'string' ? value.env : null;
}

function referencesIn(value: unknown, path: string[], found: Array<{ path: string[]; variable: string }>): void {
  const variable = referenceOf(value);
  if (variable !== null) {
    found.push({ path, variable });
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => referencesIn(item, [...path, String(i)], found));
  } else if (isMapping(value)) {
    for (const key of Object.keys(value)) referencesIn(value[key], [...path, key], found);
  }
}

export function secretsOf(document: unknown): SecretRef[] {
  const fixed: Array<[SecretKind, string[]]> = [
    ['model_key', ['model', 'apiKey']], ['scorer_key', ['scorer', 'apiKey']], ['app_private_key', ['app', 'privateKey']],
    ['webhook_secret', ['app', 'webhookSecret']], ['app_client_secret', ['app', 'clientSecret']], ['database', ['database', 'url']],
    ['audit_key', ['auditKey']], ['alert_webhook', ['alerts', 'webhook']],
  ];
  const out: SecretRef[] = fixed.map(([kind, path]) => {
    const found = valueAt(document, path);
    return { kind, of: null, variable: found === null ? null : referenceOf(found.value) };
  });
  const root = isMapping(document) ? document : {};
  if (Array.isArray(root.extensions)) {
    for (const extension of root.extensions) {
      if (!isMapping(extension)) continue;
      const found: Array<{ path: string[]; variable: string }> = [];
      referencesIn(extension.options, [], found);
      for (const { path, variable } of found) out.push({ kind: 'extension', of: `${String(extension.name)}, option ${path.join('.')}`, variable });
    }
  }
  if (Array.isArray(root.mcpServers)) {
    for (const server of root.mcpServers) {
      if (!isMapping(server) || !isMapping(server.headers)) continue;
      for (const header of Object.keys(server.headers)) {
        const variable = referenceOf(server.headers[header]);
        if (variable !== null) out.push({ kind: 'mcp_header', of: `${String(server.name)}, header ${header}`, variable });
      }
    }
  }
  return out;
}
