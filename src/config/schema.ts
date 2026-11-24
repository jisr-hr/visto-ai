import { isBuiltin } from 'node:module';
import { z } from 'zod';
import { SET_BY_SERVICE } from '../mcp/headers.ts';

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
    toolChoice: z.enum(['forced', 'auto']).default('forced'),
  })
  .strict();

const scorer = z
  .object({
    baseUrl: z.string().refine(isHttpUrl, { message: 'must be an http or https URL' }).default('https://openrouter.ai/api/alpha'),
    apiKey: secretRef,
    model: z.string().min(1),
    timeoutSeconds: z.number().positive().max(300).default(60),
  })
  .strict();

const app = z.object({ id: z.number().int().min(1), privateKey: secretRef, webhookSecret: secretRef }).strict();

const alerts = z.object({ webhook: secretRef }).strict();

const database = z.object({ url: secretRef }).strict();

const server = z.object({ port: z.number().int().min(1).max(65535).default(8080) }).strict();

const limits = z
  .object({
    inputTokensPerCall: z.number().int().min(10000).default(200000),
    batchesPerReview: z.number().int().positive().default(6),
    spendPerDay: z.number().positive().default(50),
    queueConcurrency: z.number().int().min(1).max(20).default(2),
  })
  .strict();

const MODULE_MESSAGE = 'must be a path that starts with ./, ../ or /, or the name of a package';

/** A path starts with ./, ../ or /; anything else must be the name of a package, so a path written without its ./ is refused. */
function isModuleSpecifier(value: string): boolean {
  if (value.length < 1 || value.length > 1000) return false;
  if (/[\x00-\x20\x7f]/.test(value)) return false;
  if (value.startsWith('./') || value.startsWith('../') || value.startsWith('/')) return true;
  if (value.startsWith('.') || value.includes(':') || value.includes('\\')) return false;
  if (/\.(ts|mts|js|mjs|cjs)$/.test(value)) return false;
  return !isBuiltin(value);
}

const extension = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, {
      message: 'must be a short code (a lower-case letter, then lower-case letters, digits or underscores, at most 40)',
    }),
    module: z.string().refine(isModuleSpecifier, { message: MODULE_MESSAGE }),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const extensions = z
  .array(extension)
  .max(20)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((entry, i) => {
      if (seen.has(entry.name)) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: 'is already used by another extension' });
      seen.add(entry.name);
    });
  });

/** A server's address: http or https, with no user name and no password (a secret goes in a header). */
function isServerUrl(value: string): boolean {
  if (!/^[\x21-\x7E]+$/.test(value) || !isHttpUrl(value)) return false;
  const { username, password } = new URL(value);
  return username === '' && password === '';
}

/** Each value is plain text or a reference; a value's characters are checked after a reference is resolved. */
const mcpHeaders = z
  .record(z.string(), z.union([z.string(), secretRef], { error: 'must be text or a reference { env: NAME }' }))
  .superRefine((headers, ctx) => {
    const seen = new Set<string>();
    const names = Object.keys(headers);
    if (names.length > 20) ctx.addIssue({ code: 'custom', path: [], message: 'must have at most 20 headers' });
    for (const name of names) {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(name)) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'must be a header name of letters, digits and hyphens, at most 100' });
        continue;
      }
      const lower = name.toLowerCase();
      if (SET_BY_SERVICE.has(lower)) ctx.addIssue({ code: 'custom', path: [name], message: 'is set by the service' });
      else if (seen.has(lower)) ctx.addIssue({ code: 'custom', path: [name], message: 'is written twice' });
      seen.add(lower);
    }
  });

const mcpTools = z
  .array(
    z.string().refine((t) => /^[^\x00-\x1f\x7f]{1,128}$/.test(t), { message: 'must be 1 to 128 characters with no control character' }),
    { error: 'must name 1 to 20 tools' },
  )
  .min(1, 'must name 1 to 20 tools')
  .max(20, 'must name 1 to 20 tools')
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((tool, j) => {
      if (seen.has(tool)) ctx.addIssue({ code: 'custom', path: [j], message: 'is named twice' });
      seen.add(tool);
    });
  });

const mcpServer = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/, {
      message: 'must be a short code of at most 20 characters (a lower-case letter, then lower-case letters, digits or underscores)',
    }),
    url: z.string().refine(isServerUrl, { message: 'must be an http or https URL with no user name and no password' }),
    headers: mcpHeaders.default({}),
    tools: mcpTools,
  })
  .strict();

const mcpServers = z
  .array(mcpServer)
  .max(5, 'must name at most 5 servers')
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((entry, i) => {
      if (seen.has(entry.name)) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: 'is already used by another server' });
      seen.add(entry.name);
    });
  });

const threshold = z.number().int().min(1).max(100);

/** How a head after a review is reviewed. */
const newHead = z.enum(['full', 'incremental']);

const gateFields = {
  enabled: z.boolean(),
  branches: z.array(z.string().min(1).max(200)).max(50),
  checkName: z.string().regex(/^[\x20-\x7E]{1,100}$/, { message: 'must be 1 to 100 printable ASCII characters' }),
  mode: z.enum(['enforce', 'shadow', 'bypass']),
  clearByReply: z.boolean(),
  skipTeam: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, { message: 'must be <org>/<team-slug>' }).nullable(),
  requiredChecks: z.array(z.string().min(1).max(200)).max(20),
};

/** The merge gate (section 9). Every key has its default, so a block that is not written is a gate that is off. */
const gate = z
  .object({
    enabled: gateFields.enabled.default(false),
    branches: gateFields.branches.default([]),
    checkName: gateFields.checkName.default('AI Review'),
    mode: gateFields.mode.default('enforce'),
    clearByReply: gateFields.clearByReply.default(true),
    skipTeam: gateFields.skipTeam.default(null),
    requiredChecks: gateFields.requiredChecks.default([]),
  })
  .strict();

const gateOverride = z
  .object({
    enabled: gateFields.enabled.optional(),
    branches: gateFields.branches.optional(),
    checkName: gateFields.checkName.optional(),
    mode: gateFields.mode.optional(),
    clearByReply: gateFields.clearByReply.optional(),
    skipTeam: gateFields.skipTeam.optional(),
    requiredChecks: gateFields.requiredChecks.optional(),
  })
  .strict();

/** Automatic approval (section 6.4): no default, so the loaded settings carry approval only when one of these is written. */
const approvalFields = {
  autoApprove: z.boolean().optional(),
  approvalThreads: z.enum(['strict', 'gate']).optional(),
  auditShare: z.number().min(0).max(100).optional(),
};

const repoConfig = z
  .object({
    primaryBranches: z.array(z.string().min(1)).default(['main', 'master']),
    score: z.object({ threshold: threshold.default(70), inlineNotes: z.boolean().default(false), ...approvalFields }).strict().prefault({}),
    ignoredAuthors: z.array(z.string().min(1)).default(['dependabot[bot]']),
    baseBranches: z.array(z.string().min(1)).default([]),
    newHead: newHead.optional(),
    gate: gate.prefault({}),
  })
  .strict();

const repoOverride = z
  .object({
    primaryBranches: z.array(z.string().min(1)).optional(),
    score: z.object({ threshold: threshold.optional(), inlineNotes: z.boolean().optional(), ...approvalFields }).strict().optional(),
    ignoredAuthors: z.array(z.string().min(1)).optional(),
    baseBranches: z.array(z.string().min(1)).optional(),
    newHead: newHead.optional(),
    gate: gateOverride.optional(),
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
    scorer: scorer.optional(),
    app: app.optional(),
    database: database.optional(),
    auditKey: secretRef.optional(),
    server: server.prefault({}),
    dryRun: z.boolean().default(true),
    learning: z.boolean().default(false),
    alerts: alerts.optional(),
    extensions: extensions.default([]),
    mcpServers: mcpServers.default([]),
    limits: limits.prefault({}),
    repositories: repositories.prefault({}),
  })
  .strict();

export type RawConfig = z.output<typeof configSchema>;
