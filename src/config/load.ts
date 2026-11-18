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
}

export interface ScorerConfig { baseUrl: string; apiKey: string; model: string; timeoutSeconds: number }
export interface DeploymentConfig {
  model: ModelConfig;
  scorer: ScorerConfig | null;
  app: { webhookSecret: string } | null;
  database: { url: string } | null;
  server: { port: number };
  limits: { inputTokensPerCall: number; batchesPerReview: number };
  repositories: { defaults: RepoConfig; overrides: Record<string, Partial<RepoConfig>> };
}

export type ServiceConfig = DeploymentConfig & { app: { webhookSecret: string }; database: { url: string } };

export class ConfigError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
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
        const where = i.path.map(String).join('.');
        const unknown = i.code === 'unrecognized_keys' ? ` (${i.keys.join(', ')})` : '';
        return `${where === '' ? '(root)' : where}: ${i.message}${unknown}`;
      }),
    );
  }
  const raw = result.data;
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
  let app: { webhookSecret: string } | null = null;
  if (raw.app !== undefined) {
    const hookVar = raw.app.webhookSecret.env;
    const webhookSecret = env[hookVar];
    if (webhookSecret === undefined || webhookSecret === '') {
      throw new ConfigError([`app.webhookSecret: environment variable ${hookVar} is not set`]);
    }
    app = { webhookSecret };
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
  const { defaults, overrides } = raw.repositories;
  // Repository names are case-insensitive on the git service, so two such keys name one repository.
  const seen = new Map<string, string>();
  for (const name of Object.keys(overrides)) {
    const other = seen.get(name.toLowerCase());
    if (other !== undefined) throw new ConfigError([`repositories.overrides: ${other} and ${name} name the same repository`]);
    seen.set(name.toLowerCase(), name);
  }
  return {
    model: { ...raw.model, apiKey },
    scorer,
    app,
    database,
    server: raw.server,
    limits: raw.limits,
    repositories: {
      defaults: { primaryBranches: defaults.primaryBranches, scoreThreshold: defaults.score.threshold },
      overrides: Object.fromEntries(
        Object.entries(overrides).map(([name, o]) => [
          name,
          {
            ...(o.primaryBranches === undefined ? {} : { primaryBranches: o.primaryBranches }),
            ...(o.score?.threshold === undefined ? {} : { scoreThreshold: o.score.threshold }),
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
  if (missing.length > 0) throw new ConfigError(missing.map((n) => `${n}: required to run the service`));
  return config as ServiceConfig;
}

/** The file in `contract/` the review model gets. With a second scorer it is the one that asks for no block scores. */
export function contractFile(config: DeploymentConfig): string {
  return config.scorer === null ? 'review-contract.md' : 'review-contract-scorer.md';
}

/** `fullName` is "owner/name", matched without regard to case. An override replaces only the keys it sets. */
export function repoConfigFor(config: DeploymentConfig, fullName: string): RepoConfig {
  const wanted = fullName.toLowerCase();
  const key = Object.keys(config.repositories.overrides).find((name) => name.toLowerCase() === wanted);
  const override = key === undefined ? {} : config.repositories.overrides[key]!;
  return { ...config.repositories.defaults, ...override };
}
