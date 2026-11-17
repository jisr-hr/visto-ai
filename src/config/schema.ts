import { z } from 'zod';

/** A secret is never written in the file; it names the environment variable that holds it. */
const secretRef = z.object({ env: z.string().min(1) }).strict();

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:';
}

const fragment = z.record(z.string(), z.unknown()).prefault({});

const prices = z
  .object({
    inputPerMillion: z.number().nonnegative(),
    cachedInputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
  })
  .strict();

const model = z
  .object({
    baseUrl: z.string().refine(isHttpUrl, { message: 'must be an http or https URL' }).default('https://openrouter.ai/api/v1'),
    apiKey: secretRef,
    model: z.string().min(1),
    fallbacks: z.array(z.string().min(1)).default([]),
    effort: z
      .object({ default: fragment, elevated: fragment })
      .strict()
      .prefault({}),
    extraBody: z.record(z.string(), z.unknown()).default({}),
    extraHeaders: z.record(z.string(), z.string()).default({}),
    prices: prices.nullable().default(null),
    timeoutSeconds: z.number().positive().max(300).default(240),
  })
  .strict();

const limits = z
  .object({
    inputTokensPerCall: z.number().int().min(10000).default(200000),
    batchesPerReview: z.number().int().positive().default(6),
  })
  .strict();

const threshold = z.number().int().min(1).max(100);

const repoConfig = z
  .object({
    primaryBranches: z.array(z.string().min(1)).default(['main', 'master']),
    score: z.object({ threshold: threshold.default(70) }).strict().prefault({}),
  })
  .strict();

const repoOverride = z
  .object({
    primaryBranches: z.array(z.string().min(1)).optional(),
    score: z.object({ threshold: threshold.optional() }).strict().optional(),
  })
  .strict();

const repositories = z
  .object({
    defaults: repoConfig.prefault({}),
    overrides: z.record(z.string(), repoOverride).default({}),
  })
  .strict();

export const configSchema = z
  .object({
    model,
    limits: limits.prefault({}),
    repositories: repositories.prefault({}),
  })
  .strict();

export type RawConfig = z.output<typeof configSchema>;
