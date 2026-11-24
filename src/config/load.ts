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
export interface DeploymentConfig {
  model: ModelConfig;
  scorer: ScorerConfig | null;
  app: { id: string; privateKey: string; webhookSecret: string } | null;
  database: { url: string } | null;
  server: { port: number };
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
  /** 6.5, a percentage from 0 to 100; this release accepts only 0 while enabled. */
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

export class ConfigError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
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
function gateBranchIssues(repositories: { defaults: { gate: GateSettings }; overrides: Record<string, { gate?: Partial<GateSettings> | undefined }> }): string[] {
  const { gate: defaults } = repositories.defaults;
  const issues: string[] = [];
  const defaultsBad = defaults.enabled && defaults.branches.length === 0;
  if (defaultsBad) issues.push(`repositories.defaults.gate.branches: ${GATE_NEEDS_BRANCH}`);
  for (const [name, o] of Object.entries(repositories.overrides)) {
    const merged = { ...defaults, ...definedOnly(o.gate ?? {}) };
    if (!(merged.enabled && merged.branches.length === 0)) continue;
    // Defaults already named as bad cover an override that sets neither key.
    if (defaultsBad && o.gate?.enabled === undefined && o.gate?.branches === undefined) continue;
    issues.push(`repositories.overrides.${name}.gate.branches: ${GATE_NEEDS_BRANCH}`);
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

const AUDIT_NOT_DRAWN = 'must be written as 0 while autoApprove is true: this release does not draw the audit sample yet';

/** Until the audit sample is drawn, approval is on only with an audit share written as 0, dry run or not. No issue quotes a value. */
function auditShareIssues(repositories: { defaults: { score: ApprovalKeys }; overrides: Record<string, { score?: ApprovalKeys | undefined }> }): string[] {
  const refused = (a: ApprovalSettings): boolean => a.enabled && a.auditShare !== 0;
  const defaults = approvalWritten(repositories.defaults.score).approval;
  const issues: string[] = [];
  const defaultsBad = refused({ ...APPROVAL_OFF, ...defaults });
  if (defaultsBad) issues.push(`repositories.defaults.score.auditShare: ${AUDIT_NOT_DRAWN}`);
  for (const [name, o] of Object.entries(repositories.overrides)) {
    if (!refused({ ...APPROVAL_OFF, ...defaults, ...approvalWritten(o.score).approval })) continue;
    // Defaults already named as bad cover an override that writes neither key.
    if (defaultsBad && o.score?.autoApprove === undefined && o.score?.auditShare === undefined) continue;
    issues.push(`repositories.overrides.${name}.score.auditShare: ${AUDIT_NOT_DRAWN}`);
  }
  return issues;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replaces every mapping whose only key is `env` by that variable's value, at any depth. An issue names a key, never a value. */
function resolveReferences(value: unknown, path: string, env: Record<string, string | undefined>, issues: string[]): unknown {
  if (Array.isArray(value)) return value.map((item, i) => resolveReferences(item, `${path}.${i}`, env, issues));
  if (!isMapping(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'env') {
    const name = value.env;
    if (typeof name !== 'string' || name === '') {
      issues.push(`${path}: env must name an environment variable`);
      return null;
    }
    const found = env[name];
    if (found === undefined || found === '') {
      issues.push(`${path}: environment variable ${name} is not set`);
      return null;
    }
    return found;
  }
  return Object.fromEntries(keys.map((k) => [k, resolveReferences(value[k], `${path}.${k}`, env, issues)]));
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function parseConfig(yamlText: string, env: Record<string, string | undefined>): DeploymentConfig {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (e) {
    // The library's message quotes source lines, which may hold a secret: report position only.
    const pos = e instanceof YAMLParseError ? e.linePos?.[0] : undefined;
    const code = e instanceof YAMLParseError ? ` (${e.code})` : '';
    throw new ConfigError([
      pos === undefined ? `not valid YAML${code}` : `not valid YAML at line ${pos.line}, column ${pos.col}${code}`,
    ]);
  }
  // Issue messages never echo the offending value, so a secret written inline is not printed.
  const result = configSchema.safeParse(doc ?? {});
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => {
        // A key outside printable ASCII is shown escaped, so an issue stays one line.
        const where = i.path.map((k) => (/^[\x20-\x7E]*$/.test(String(k)) ? String(k) : JSON.stringify(String(k)))).join('.');
        const unknown = i.code === 'unrecognized_keys' ? ` (${i.keys.join(', ')})` : '';
        return `${where === '' ? '(root)' : where}: ${i.message}${unknown}`;
      }),
    );
  }
  const raw = result.data;
  const repositoryIssues = [...gateBranchIssues(raw.repositories), ...auditShareIssues(raw.repositories)];
  if (repositoryIssues.length > 0) throw new ConfigError(repositoryIssues);
  const varName = raw.model.apiKey.env;
  const apiKey = env[varName];
  if (apiKey === undefined || apiKey === '') {
    throw new ConfigError([`model.apiKey: environment variable ${varName} is not set`]);
  }
  let scorer: ScorerConfig | null = null;
  if (raw.scorer !== undefined) {
    const scorerVar = raw.scorer.apiKey.env;
    const scorerKey = env[scorerVar];
    if (scorerKey === undefined || scorerKey === '') {
      throw new ConfigError([`scorer.apiKey: environment variable ${scorerVar} is not set`]);
    }
    // The schema gives the threshold a default, so only the parsed document tells whether it was written.
    if (!writesDefaultThreshold(doc)) {
      throw new ConfigError(['repositories.defaults.score.threshold: must be written when scorer is set']);
    }
    scorer = { ...raw.scorer, apiKey: scorerKey };
  }
  let app: { id: string; privateKey: string; webhookSecret: string } | null = null;
  if (raw.app !== undefined) {
    const hookVar = raw.app.webhookSecret.env;
    const webhookSecret = env[hookVar];
    if (webhookSecret === undefined || webhookSecret === '') {
      throw new ConfigError([`app.webhookSecret: environment variable ${hookVar} is not set`]);
    }
    const keyVar = raw.app.privateKey.env;
    const keyText = env[keyVar];
    if (keyText === undefined || keyText === '') {
      throw new ConfigError([`app.privateKey: environment variable ${keyVar} is not set`]);
    }
    const privateKey = keyText.replaceAll('\\n', '\n');
    if (!isRsaPrivateKey(privateKey)) throw new ConfigError(['app.privateKey: must be an RSA private key in PEM form']);
    app = { id: String(raw.app.id), privateKey, webhookSecret };
  }
  let alerts: { webhook: string } | null = null;
  if (raw.alerts !== undefined) {
    const urlVar = raw.alerts.webhook.env;
    const webhook = env[urlVar];
    if (webhook === undefined || webhook === '') {
      throw new ConfigError([`alerts.webhook: environment variable ${urlVar} is not set`]);
    }
    // The URL is a credential of the alert channel, so the message never quotes it.
    if (!isHttpUrl(webhook)) throw new ConfigError(['alerts.webhook: must be an http or https URL']);
    alerts = { webhook };
  }
  let database: { url: string } | null = null;
  if (raw.database !== undefined) {
    const urlVar = raw.database.url.env;
    const url = env[urlVar];
    if (url === undefined || url === '') {
      throw new ConfigError([`database.url: environment variable ${urlVar} is not set`]);
    }
    // The URL holds a password, so the message never quotes it.
    if (!/^postgres(ql)?:\/\//.test(url) || !URL.canParse(url)) throw new ConfigError(['database.url: must be a postgres URL']);
    database = { url };
  }
  const extensionIssues: string[] = [];
  const extensions: ExtensionConfig[] = raw.extensions.map((e, i) => ({
    name: e.name,
    module: e.module,
    // A reference is a value inside options, never options itself, which stays a mapping.
    options: Object.fromEntries(
      Object.entries(e.options).map(([k, v]) => [k, resolveReferences(v, `extensions.${i}.options.${k}`, env, extensionIssues)]),
    ),
  }));
  if (extensionIssues.length > 0) throw new ConfigError(extensionIssues);
  const mcpIssues: string[] = [];
  const mcpServers: McpServerConfig[] = raw.mcpServers.map((s, i) => ({
    name: s.name,
    url: s.url,
    headers: Object.fromEntries(
      Object.entries(s.headers).map(([header, v]): [string, string] => {
        const path = `mcpServers.${i}.headers.${header}`;
        let value: string;
        if (typeof v === 'string') value = v;
        else {
          const found = env[v.env];
          if (found === undefined || found === '') {
            mcpIssues.push(`${path}: environment variable ${v.env} is not set`);
            return [header, ''];
          }
          value = found;
        }
        // A value read from a variable is held to the same rule as one written here; no issue quotes it.
        if (!/^[\x20-\x7E]{1,4000}$/.test(value)) mcpIssues.push(`${path}: must be 1 to 4,000 printable ASCII characters`);
        return [header, value];
      }),
    ),
    tools: s.tools,
  }));
  if (mcpIssues.length > 0) throw new ConfigError(mcpIssues);
  const { defaults, overrides } = raw.repositories;
  // Repository names are case-insensitive on the git service, so two such keys name one repository.
  const seen = new Map<string, string>();
  for (const name of Object.keys(overrides)) {
    const other = seen.get(name.toLowerCase());
    if (other !== undefined) throw new ConfigError([`repositories.overrides: ${other} and ${name} name the same repository`]);
    seen.set(name.toLowerCase(), name);
  }
  const { approval: defaultsApproval } = approvalWritten(defaults.score);
  return {
    model: { ...raw.model, apiKey },
    scorer,
    app,
    database,
    server: raw.server,
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
