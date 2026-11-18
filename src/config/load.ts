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
  limits: { inputTokensPerCall: number; batchesPerReview: number };
  repositories: { defaults: RepoConfig; overrides: Record<string, Partial<RepoConfig>> };
}

export class ConfigError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
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

/** `fullName` is "owner/name", matched without regard to case. An override replaces only the keys it sets. */
export function repoConfigFor(config: DeploymentConfig, fullName: string): RepoConfig {
  const wanted = fullName.toLowerCase();
  const key = Object.keys(config.repositories.overrides).find((name) => name.toLowerCase() === wanted);
  const override = key === undefined ? {} : config.repositories.overrides[key]!;
  return { ...config.repositories.defaults, ...override };
}
