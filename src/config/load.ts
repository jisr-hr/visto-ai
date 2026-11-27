import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse, YAMLParseError } from 'yaml';
import type { RepoConfig } from '../engine/types.ts';
import { configSchema } from './schema.ts';

export interface ModelConfig {
  baseUrl: string; apiKey: string; model: string; fallbacks: string[];
  effort: { default: Record<string, unknown>; elevated: Record<string, unknown> };
  extraBody: Record<string, unknown>; extraHeaders: Record<string, string>;
  prices: { inputPerMillion: number; cachedInputPerMillion: number; outputPerMillion: number } | null;
  timeoutSeconds: number;
  /** How the model is made to answer through submit_review: every request names the tool, or the model is asked to call it. */
  toolChoice: 'forced' | 'auto';
}

/** One module the deployment names (section 11.3). Nothing is loaded here: `module` is kept as written. */
export interface ExtensionConfig {
  /** A short code, unique in the list. */
  name: string;
  /** As written: a path, or the name of a package. */
  module: string;
  /** As written, with every { env: NAME } replaced by that variable's value. */
  options: Record<string, unknown>;
}

/** One MCP server the deployment names (section 5.4). Nothing is opened here. */
export interface McpServerConfig {
  /** A short code of at most 20 characters, unique in the list. */
  name: string;
  /** http or https, as written. */
  url: string;
  /** As written, with every { env: NAME } replaced by that variable's value. */
  headers: Record<string, string>;
  /** The names the model may be offered, in the order written; never empty. */
  tools: string[];
}

export interface ScorerConfig { baseUrl: string; apiKey: string; model: string; timeoutSeconds: number }

/** Who may open the UI, and what sign-in needs (section 3.2). Read from the file only. */
export interface UiConfig {
  /** As written. */
  accounts: string[];
  /** "org/team-slug"; null when not written. */
  team: string | null;
  /** The origin, with no trailing slash. */
  publicUrl: string;
  /** `app.clientId` as written. Null exactly when GitHub sign-in is off: ui names neither an account nor a team. */
  clientId: string | null;
  /** The value of the variable `app.clientSecret` names. Never logged, stored or posted. Null when GitHub sign-in is off. */
  clientSecret: string | null;
}

/** Whether ui names an account or a team, which turns GitHub sign-in on (its client id and secret are then written). */
export function githubSignInOn(ui: UiConfig): ui is UiConfig & { clientId: string; clientSecret: string } {
  return ui.accounts.length > 0 || ui.team !== null;
}

export interface DeploymentConfig {
  model: ModelConfig;
  scorer: ScorerConfig | null;
  app: { id: string; privateKey: string; webhookSecret: string } | null;
  database: { url: string } | null;
  /** The value of the variable `auditKey` names; present only when `auditKey` is written. Never logged, stored or posted. */
  auditKey?: string;
  server: { port: number };
  /** Present only when `ui` writes an address, names an account or writes a team. */
  ui?: UiConfig;
  dryRun: boolean;
  learning: boolean;
  alerts: { webhook: string } | null;
  extensions: ExtensionConfig[];
  mcpServers: McpServerConfig[];
  limits: { inputTokensPerCall: number; batchesPerReview: number; spendPerDay: number; queueConcurrency: number };
  repositories: { defaults: RepoSettings; overrides: Record<string, RepoOverride> };
}

/** The merge gate of one repository (section 9). */
export interface GateSettings {
  enabled: boolean;
  /** The base branches whose pull requests are gated. */
  branches: string[];
  checkName: string;
  mode: 'enforce' | 'shadow' | 'bypass';
  /** O18: whether a person's reply and a resolve clear a blocking thread. */
  clearByReply: boolean;
  /** "org/team-slug". */
  skipTeam: string | null;
  /** The names `/done` reads. */
  requiredChecks: string[];
}

export const GATE_OFF: GateSettings = {
  enabled: false, branches: [], checkName: 'AI Review', mode: 'enforce', clearByReply: true, skipTeam: null, requiredChecks: [],
};

/** D18: which threads count as closed for an approval. */
export type ApprovalThreads = 'strict' | 'gate';

/** Automatic approval of one repository (section 6.4). */
export interface ApprovalSettings {
  /** 6.4, condition 1. */
  enabled: boolean;
  /** D18. */
  threads: ApprovalThreads;
  /** 6.5: of the pull requests approval would approve, the percentage (0 to 100) sent to a person anyway; 0 switches the sample off. */
  auditShare: number;
}

export const APPROVAL_OFF: ApprovalSettings = { enabled: false, threads: 'strict', auditShare: 5 };

export interface RepoSettings extends RepoConfig {
  ignoredAuthors: string[]; baseBranches: string[];
  /** How a head after a review is reviewed; null when the file does not say, which reads as incremental. */
  newHead: 'full' | 'incremental' | null;
  /** Whether a short note is posted in the diff for each block a person should read. */
  inlineNotes: boolean;
  gate: GateSettings;
  /** Present only when the config writes one of its keys; absent reads as APPROVAL_OFF. */
  approval?: ApprovalSettings;
}

/** What a repository's entry under `overrides` sets: each key it writes replaces the default's, and the gate and approval key by key. */
export type RepoOverride = Partial<Omit<RepoSettings, 'gate' | 'approval'>> & { gate?: Partial<GateSettings>; approval?: Partial<ApprovalSettings> };

export type ServiceConfig = DeploymentConfig & {
  app: { id: string; privateKey: string; webhookSecret: string }; database: { url: string };
};

/** One issue, with its place as keys ([] for one of the whole file) and its text after the place. */
export interface ConfigIssue { path: Array<string | number>; message: string }

export class ConfigError extends Error {
  issues: string[];
  /** One per issue, in the same order; without it, each issue with path [] and its whole text. */
  details: ConfigIssue[];
  constructor(issues: string[], details?: ConfigIssue[]) {
    super(`invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
    this.details = details ?? issues.map((message) => ({ path: [], message }));
  }
}

/** An issue written by hand: its text is its place as dotted keys, then the message. */
function at(path: Array<string | number>, message: string): ConfigIssue {
  return { path, message };
}

function failWith(items: ConfigIssue[]): ConfigError {
  return new ConfigError(items.map((i) => `${i.path.join('.')}: ${i.message}`), items);
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:';
}

function isRsaPrivateKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

function writesDefaultThreshold(doc: unknown): boolean {
  let node = doc;
  for (const key of ['repositories', 'defaults', 'score', 'threshold']) {
    if (typeof node !== 'object' || node === null || !(key in node)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return true;
}

const GATE_NEEDS_BRANCH = 'must name at least one branch when the gate is enabled';

/** An enabled gate with no branch gates nothing, which is never what was meant. No issue quotes a value. */
function gateBranchIssues(repositories: { defaults: { gate: GateSettings }; overrides: Record<string, { gate?: Partial<GateSettings> | undefined }> }): ConfigIssue[] {
  const { gate: defaults } = repositories.defaults;
  const issues: ConfigIssue[] = [];
  const defaultsBad = defaults.enabled && defaults.branches.length === 0;
  if (defaultsBad) issues.push(at(['repositories', 'defaults', 'gate', 'branches'], GATE_NEEDS_BRANCH));
  for (const [name, o] of Object.entries(repositories.overrides)) {
    const merged = { ...defaults, ...definedOnly(o.gate ?? {}) };
    if (!(merged.enabled && merged.branches.length === 0)) continue;
    // Defaults already named as bad cover an override that sets neither key.
    if (defaultsBad && o.gate?.enabled === undefined && o.gate?.branches === undefined) continue;
    issues.push(at(['repositories', 'overrides', name, 'gate', 'branches'], GATE_NEEDS_BRANCH));
  }
  return issues;
}

/** The approval keys of a `score` block, as the schema gives them. */
interface ApprovalKeys { autoApprove?: boolean | undefined; approvalThreads?: ApprovalThreads | undefined; auditShare?: number | undefined }

/** `{ approval }` with the keys a `score` block writes, under the settings' names; nothing when it writes none. */
function approvalWritten(score: ApprovalKeys | undefined): { approval?: Partial<ApprovalSettings> } {
  const approval = definedOnly({ enabled: score?.autoApprove, threads: score?.approvalThreads, auditShare: score?.auditShare });
  return Object.keys(approval).length === 0 ? {} : { approval };
}

const AUDIT_KEY_NEEDED = 'must be written while autoApprove is true with an auditShare above 0';

/**
 * Whether the defaults, or some override merged with them as `repoSettingsFor` merges it, have approval on with a share
 * above 0 (-0 is 0): the audit sample is then drawn, and it needs the key.
 */
function auditKeyNeeded(repositories: { defaults: { score: ApprovalKeys }; overrides: Record<string, { score?: ApprovalKeys | undefined }> }): boolean {
  const draws = (a: ApprovalSettings): boolean => a.enabled && a.auditShare > 0;
  const defaults = approvalWritten(repositories.defaults.score).approval;
  if (draws({ ...APPROVAL_OFF, ...defaults })) return true;
  return Object.values(repositories.overrides).some((o) => draws({ ...APPROVAL_OFF, ...defaults, ...approvalWritten(o.score).approval }));
}

const UI_NEEDS = 'must be written when ui names accounts or a team';

/** The UI is on when `ui` writes an address, names at least one account or writes a team. */
function uiOn<T extends { accounts: string[]; team?: string | undefined; publicUrl?: string | undefined }>(ui: T | undefined): ui is T {
  return ui !== undefined && (ui.publicUrl !== undefined || githubOn(ui));
}

/** GitHub sign-in is on when `ui` names at least one account or writes a team. */
function githubOn(ui: { accounts: string[]; team?: string | undefined }): boolean {
  return ui.accounts.length > 0 || ui.team !== undefined;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replaces every mapping whose only key is `env` by that variable's value, at any depth. An issue names a key, never a value. */
function resolveReferences(value: unknown, path: Array<string | number>, env: Record<string, string | undefined>, issues: ConfigIssue[]): unknown {
  if (Array.isArray(value)) return value.map((item, i) => resolveReferences(item, [...path, i], env, issues));
  if (!isMapping(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'env') {
    const name = value.env;
    if (typeof name !== 'string' || name === '') {
      issues.push(at(path, 'env must name an environment variable'));
      return null;
    }
    const found = env[name];
    if (found === undefined || found === '') {
      issues.push(at(path, `environment variable ${name} is not set`));
      return null;
    }
    return found;
  }
  return Object.fromEntries(keys.map((k) => [k, resolveReferences(value[k], [...path, k], env, issues)]));
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The YAML of a config file, read; throws a ConfigError for YAML it cannot read. */
export function readYaml(text: string): unknown {
  try {
    return parse(text);
  } catch (e) {
    // The library's message quotes source lines, which may hold a secret: report position only.
    const pos = e instanceof YAMLParseError ? e.linePos?.[0] : undefined;
    const code = e instanceof YAMLParseError ? ` (${e.code})` : '';
    throw new ConfigError([
      pos === undefined ? `not valid YAML${code}` : `not valid YAML at line ${pos.line}, column ${pos.col}${code}`,
    ]);
  }
}

export function parseConfig(yamlText: string, env: Record<string, string | undefined>): DeploymentConfig {
  return parseDocument(readYaml(yamlText), env);
}

/** Every check of parseConfig on a document already read; never changes it. */
export function parseDocument(doc: unknown, env: Record<string, string | undefined>): DeploymentConfig {
  // Issue messages never echo the offending value, so a secret written inline is not printed.
  const result = configSchema.safeParse(doc ?? {});
  if (!result.success) {
    const details: ConfigIssue[] = [];
    const texts = result.error.issues.map((i) => {
      // A key outside printable ASCII is shown escaped, so an issue stays one line.
      const where = i.path.map((k) => (/^[\x20-\x7E]*$/.test(String(k)) ? String(k) : JSON.stringify(String(k)))).join('.');
      const unknown = i.code === 'unrecognized_keys' ? ` (${i.keys.join(', ')})` : '';
      const message = `${i.message}${unknown}`;
      details.push({ path: i.path.map((k) => (typeof k === 'number' ? k : String(k))), message });
      return `${where === '' ? '(root)' : where}: ${message}`;
    });
    throw new ConfigError(texts, details);
  }
  const raw = result.data;
  // Needed with no key written fails closed, dry run or not: one issue, however many repositories need it.
  const keyIssues = raw.auditKey === undefined && auditKeyNeeded(raw.repositories) ? [at(['auditKey'], AUDIT_KEY_NEEDED)] : [];
  // What sign-in needs fails closed the same way: each key missing is named, dry run or not, and no value is quoted.
  const uiIssues = raw.ui !== undefined && githubOn(raw.ui)
    ? [
      raw.ui.publicUrl === undefined ? at(['ui', 'publicUrl'], UI_NEEDS) : null,
      raw.app?.clientId === undefined ? at(['app', 'clientId'], UI_NEEDS) : null,
      raw.app?.clientSecret === undefined ? at(['app', 'clientSecret'], UI_NEEDS) : null,
    ].filter((i) => i !== null)
    : [];
  const writtenIssues = [...gateBranchIssues(raw.repositories), ...keyIssues, ...uiIssues];
  if (writtenIssues.length > 0) throw failWith(writtenIssues);
  const varName = raw.model.apiKey.env;
  const apiKey = env[varName];
  if (apiKey === undefined || apiKey === '') {
    throw failWith([at(['model', 'apiKey'], `environment variable ${varName} is not set`)]);
  }
  let scorer: ScorerConfig | null = null;
  if (raw.scorer !== undefined) {
    const scorerVar = raw.scorer.apiKey.env;
    const scorerKey = env[scorerVar];
    if (scorerKey === undefined || scorerKey === '') {
      throw failWith([at(['scorer', 'apiKey'], `environment variable ${scorerVar} is not set`)]);
    }
    // The schema gives the threshold a default, so only the parsed document tells whether it was written.
    if (!writesDefaultThreshold(doc)) {
      throw failWith([at(['repositories', 'defaults', 'score', 'threshold'], 'must be written when scorer is set')]);
    }
    scorer = { ...raw.scorer, apiKey: scorerKey };
  }
  let app: { id: string; privateKey: string; webhookSecret: string } | null = null;
  let clientSecret: string | undefined;
  if (raw.app !== undefined) {
    const hookVar = raw.app.webhookSecret.env;
    const webhookSecret = env[hookVar];
    if (webhookSecret === undefined || webhookSecret === '') {
      throw failWith([at(['app', 'webhookSecret'], `environment variable ${hookVar} is not set`)]);
    }
    // Resolved whenever it is written, whatever ui says; it stays out of `app`.
    if (raw.app.clientSecret !== undefined) {
      const secretVar = raw.app.clientSecret.env;
      clientSecret = env[secretVar];
      if (clientSecret === undefined || clientSecret === '') {
        throw failWith([at(['app', 'clientSecret'], `environment variable ${secretVar} is not set`)]);
      }
    }
    const keyVar = raw.app.privateKey.env;
    const keyText = env[keyVar];
    if (keyText === undefined || keyText === '') {
      throw failWith([at(['app', 'privateKey'], `environment variable ${keyVar} is not set`)]);
    }
    const privateKey = keyText.replaceAll('\\n', '\n');
    if (!isRsaPrivateKey(privateKey)) throw failWith([at(['app', 'privateKey'], 'must be an RSA private key in PEM form')]);
    app = { id: String(raw.app.id), privateKey, webhookSecret };
  }
  let alerts: { webhook: string } | null = null;
  if (raw.alerts !== undefined) {
    const urlVar = raw.alerts.webhook.env;
    const webhook = env[urlVar];
    if (webhook === undefined || webhook === '') {
      throw failWith([at(['alerts', 'webhook'], `environment variable ${urlVar} is not set`)]);
    }
    // The URL is a credential of the alert channel, so the message never quotes it.
    if (!isHttpUrl(webhook)) throw failWith([at(['alerts', 'webhook'], 'must be an http or https URL')]);
    alerts = { webhook };
  }
  let database: { url: string } | null = null;
  if (raw.database !== undefined) {
    const urlVar = raw.database.url.env;
    const url = env[urlVar];
    if (url === undefined || url === '') {
      throw failWith([at(['database', 'url'], `environment variable ${urlVar} is not set`)]);
    }
    // The URL holds a password, so the message never quotes it.
    if (!/^postgres(ql)?:\/\//.test(url) || !URL.canParse(url)) throw failWith([at(['database', 'url'], 'must be a postgres URL')]);
    database = { url };
  }
  // Resolved whenever it is written, needed or not.
  let auditKey: string | undefined;
  if (raw.auditKey !== undefined) {
    const auditVar = raw.auditKey.env;
    const value = env[auditVar];
    if (value === undefined || value === '') {
      throw failWith([at(['auditKey'], `environment variable ${auditVar} is not set`)]);
    }
    // A short key could be found from the draws an author has seen. Kept as it is, spaces included; the message never quotes it.
    if (value.length < 32) throw failWith([at(['auditKey'], `environment variable ${auditVar} must hold at least 32 characters`)]);
    auditKey = value;
  }
  const extensionIssues: ConfigIssue[] = [];
  const extensions: ExtensionConfig[] = raw.extensions.map((e, i) => ({
    name: e.name,
    module: e.module,
    // A reference is a value inside options, never options itself, which stays a mapping.
    options: Object.fromEntries(
      Object.entries(e.options).map(([k, v]) => [k, resolveReferences(v, ['extensions', i, 'options', k], env, extensionIssues)]),
    ),
  }));
  if (extensionIssues.length > 0) throw failWith(extensionIssues);
  const mcpIssues: ConfigIssue[] = [];
  const mcpServers: McpServerConfig[] = raw.mcpServers.map((s, i) => ({
    name: s.name,
    url: s.url,
    headers: Object.fromEntries(
      Object.entries(s.headers).map(([header, v]): [string, string] => {
        const path = ['mcpServers', i, 'headers', header];
        let value: string;
        if (typeof v === 'string') value = v;
        else {
          const found = env[v.env];
          if (found === undefined || found === '') {
            mcpIssues.push(at(path, `environment variable ${v.env} is not set`));
            return [header, ''];
          }
          value = found;
        }
        // A value read from a variable is held to the same rule as one written here; no issue quotes it.
        if (!/^[\x20-\x7E]{1,4000}$/.test(value)) mcpIssues.push(at(path, 'must be 1 to 4,000 printable ASCII characters'));
        return [header, value];
      }),
    ),
    tools: s.tools,
  }));
  if (mcpIssues.length > 0) throw failWith(mcpIssues);
  const { defaults, overrides } = raw.repositories;
  // Repository names are case-insensitive on the git service, so two such keys name one repository.
  const seen = new Map<string, string>();
  for (const name of Object.keys(overrides)) {
    const other = seen.get(name.toLowerCase());
    if (other !== undefined) throw failWith([at(['repositories', 'overrides'], `${other} and ${name} name the same repository`)]);
    seen.set(name.toLowerCase(), name);
  }
  const { approval: defaultsApproval } = approvalWritten(defaults.score);
  // The UI is on with its address written (with accounts or a team and no address, the issues above have refused the file).
  // The client id and secret are carried only with GitHub sign-in on, which the issues above have made write both; with the
  // address alone either may be absent, and neither is carried.
  const publicUrl = raw.ui?.publicUrl;
  const clientId = raw.app?.clientId;
  let ui: UiConfig | undefined;
  if (uiOn(raw.ui) && publicUrl !== undefined) {
    const github = githubOn(raw.ui);
    ui = {
      accounts: raw.ui.accounts, team: raw.ui.team ?? null, publicUrl: new URL(publicUrl).origin,
      clientId: github ? clientId ?? null : null, clientSecret: github ? clientSecret ?? null : null,
    };
  }
  return {
    model: { ...raw.model, apiKey },
    scorer,
    app,
    database,
    ...(auditKey === undefined ? {} : { auditKey }),
    server: raw.server,
    ...(ui === undefined ? {} : { ui }),
    dryRun: raw.dryRun,
    learning: raw.learning,
    alerts,
    extensions,
    mcpServers,
    limits: raw.limits,
    repositories: {
      defaults: {
        primaryBranches: defaults.primaryBranches, scoreThreshold: defaults.score.threshold,
        ignoredAuthors: defaults.ignoredAuthors, baseBranches: defaults.baseBranches, newHead: defaults.newHead ?? null,
        inlineNotes: defaults.score.inlineNotes, gate: defaults.gate,
        ...(defaultsApproval === undefined ? {} : { approval: { ...APPROVAL_OFF, ...defaultsApproval } }),
      },
      overrides: Object.fromEntries(
        Object.entries(overrides).map(([name, o]) => [
          name,
          {
            ...(o.primaryBranches === undefined ? {} : { primaryBranches: o.primaryBranches }),
            ...(o.score?.threshold === undefined ? {} : { scoreThreshold: o.score.threshold }),
            ...(o.score?.inlineNotes === undefined ? {} : { inlineNotes: o.score.inlineNotes }),
            ...(o.ignoredAuthors === undefined ? {} : { ignoredAuthors: o.ignoredAuthors }),
            ...(o.baseBranches === undefined ? {} : { baseBranches: o.baseBranches }),
            ...(o.newHead === undefined ? {} : { newHead: o.newHead }),
            ...(o.gate === undefined ? {} : { gate: definedOnly(o.gate) }),
            ...approvalWritten(o.score),
          },
        ]),
      ),
    },
  };
}

export function loadConfig(path: string, env: Record<string, string | undefined>): DeploymentConfig {
  return parseConfig(readFileSync(path, 'utf8'), env);
}

/** The config a running service needs. Throws a ConfigError naming each missing block. */
export function serviceConfig(config: DeploymentConfig): ServiceConfig {
  const missing = [config.app === null ? 'app' : null, config.database === null ? 'database' : null].filter((n) => n !== null);
  const issues = missing.map((n) => `${n}: required to run the service`);
  if (issues.length > 0) throw new ConfigError(issues);
  return config as ServiceConfig;
}

/** The file in `contract/` the review model gets. With a second scorer it is the one that asks for no block scores. */
export function contractFile(config: DeploymentConfig): string {
  return config.scorer === null ? 'review-contract.md' : 'review-contract-scorer.md';
}

/**
 * `fullName` is "owner/name", matched without regard to case. An override replaces only the keys it sets.
 * The settings carry `approval` only when the defaults or the override has one.
 */
export function repoSettingsFor(config: DeploymentConfig, fullName: string): RepoSettings {
  const wanted = fullName.toLowerCase();
  const key = Object.keys(config.repositories.overrides).find((name) => name.toLowerCase() === wanted);
  const { approval, ...override }: RepoOverride = key === undefined ? {} : config.repositories.overrides[key]!;
  const defaults = config.repositories.defaults;
  const settings: RepoSettings = { ...defaults, ...override, gate: { ...defaults.gate, ...override.gate } };
  if (defaults.approval === undefined && approval === undefined) return settings;
  return { ...settings, approval: { ...APPROVAL_OFF, ...defaults.approval, ...approval } };
}

/** What of the gate some repository switches on. */
export interface GateUse { check: boolean; statuses: boolean; members: boolean; bypass: boolean }

/** Looks at the defaults and at each override once merged. A key of a gate that is not enabled switches nothing on. */
export function gateUseOf(config: DeploymentConfig): GateUse {
  const { defaults, overrides } = config.repositories;
  const merged = [defaults, ...Object.keys(overrides).map((name) => repoSettingsFor(config, name))];
  const gates = merged.map((s) => s.gate).filter((g) => g.enabled);
  return {
    check: gates.length > 0,
    statuses: gates.some((g) => g.requiredChecks.length > 0),
    members: gates.some((g) => g.skipTeam !== null),
    bypass: gates.some((g) => g.mode === 'bypass'),
  };
}

/** A repository's automatic approval: off unless its settings carry one. */
export function approvalOf(settings: RepoSettings): ApprovalSettings {
  return settings.approval ?? APPROVAL_OFF;
}

/** Whether the defaults or some override, once merged, has automatic approval on. */
export function approvalUseOf(config: DeploymentConfig): boolean {
  const { defaults, overrides } = config.repositories;
  const merged = [defaults, ...Object.keys(overrides).map((name) => repoSettingsFor(config, name))];
  return merged.some((s) => approvalOf(s).enabled);
}

/** The two keys the engine reads. */
export function repoConfigFor(config: DeploymentConfig, fullName: string): RepoConfig {
  const { primaryBranches, scoreThreshold } = repoSettingsFor(config, fullName);
  return { primaryBranches, scoreThreshold };
}
