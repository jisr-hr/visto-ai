import { z } from 'zod';
import type { RawFinding, ToolDefinition } from '../types.ts';

export const SUBMIT_REVIEW = 'submit_review';
export interface RawPart { first: string; last: string; score: number; category: string; reason?: string }
export interface RawBlock { id: string; score?: number; category?: string; reason?: string; parts?: RawPart[] }
export interface RawFile { path: string; change_summary: string; score?: number; category?: string; reason?: string; blocks: RawBlock[] }
export interface RawVerdict { thread_id: string; verdict: string; reply?: string }
export interface SubmitReviewArgs { overview: string; findings: RawFinding[]; files: RawFile[]; thread_verdicts?: RawVerdict[] }

const findingSchema = z.object({
  path: z.string().trim().min(1),
  side: z.enum(['LEFT', 'RIGHT']),
  line: z.number().int().positive(),
  severity: z.enum(['blocker', 'major', 'minor']),
  body: z.string().trim().min(1),
  quote: z.string(),
  beyond_diff: z.boolean(),
}).strict();

// Only the shape is checked here. A bad score, category or block id is judged
// later, where it costs one block and not the whole answer, so unknown keys in
// files are ignored rather than rejected.
// Models often send null for a field they leave out: in files, that reads as the field being absent.
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === null ? undefined : v), schema.optional());

const partSchema = z.object({
  first: z.string(),
  last: z.string(),
  score: z.number(),
  category: z.string(),
  reason: optional(z.string()),
});

const blockSchema = z.object({
  id: z.string().min(1),
  score: optional(z.number()),
  category: optional(z.string()),
  reason: optional(z.string()),
  parts: optional(z.array(partSchema)),
});

const fileSchema = z.object({
  path: z.string().trim().min(1),
  change_summary: z.string(),
  score: optional(z.number()),
  category: optional(z.string()),
  reason: optional(z.string()),
  blocks: z.array(blockSchema).default([]),
});

const argsSchema = z.object({
  overview: z.string().trim().min(1),
  findings: z.array(findingSchema),
  files: z.array(fileSchema),
}).strict();

// Only the shape of a verdict is checked here; a bad id or verdict is judged later.
const verdictSchema = z.object({
  thread_id: z.string(),
  verdict: z.string(),
  reply: optional(z.string()),
});

// A second schema beside the first, for a later review: the first tool's JSON stays what it was.
const argsWithThreadsSchema = z.object({
  ...argsSchema.shape,
  thread_verdicts: optional(z.array(verdictSchema)),
}).strict();

const SUBMIT_DESCRIPTION = 'Submit your review of the pull request. Call this tool exactly once, with your overview, all of your findings, and one entry for each file.';

function toolOf(schema: z.ZodType): ToolDefinition {
  const parameters = z.toJSONSchema(schema) as Record<string, unknown>;
  delete parameters.$schema;
  return { type: 'function', function: { name: SUBMIT_REVIEW, description: SUBMIT_DESCRIPTION, parameters } };
}

export const submitReviewTool: ToolDefinition = toolOf(argsSchema);
export const submitReviewWithThreadsTool: ToolDefinition = toolOf(argsWithThreadsSchema);

const LEADING_TAG = /^\s*(?:\*\*)?\[(blocker|major|minor|nit)\](?:\*\*)?\s*/i;

function formatPath(path: PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out === '' ? String(part) : `.${String(part)}`;
  }
  return out;
}

const MAX_REASON_CHARS = 200;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// A rejection reason is one line of at most MAX_REASON_CHARS characters.
export function parseSubmitReview(json: string, withThreads = false): { ok: true; value: SubmitReviewArgs } | { ok: false; reason: string } {
  const parsed = parseArgs(json, withThreads);
  return parsed.ok ? parsed : { ok: false, reason: oneLine(parsed.reason).slice(0, MAX_REASON_CHARS) };
}

function parseArgs(json: string, withThreads: boolean): { ok: true; value: SubmitReviewArgs } | { ok: false; reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const parsed = withThreads ? argsWithThreadsSchema.safeParse(data) : argsSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue === undefined) return { ok: false, reason: 'invalid' };
    const path = formatPath(issue.path);
    let what: string;
    if (issue.code === 'invalid_value' && issue.values.length > 0) what = `expected one of ${issue.values.map(String).join('|')}`;
    else if (issue.code === 'unrecognized_keys') what = `unexpected key ${issue.keys.join(', ')}`;
    else what = issue.message;
    return { ok: false, reason: oneLine(`${path}: ${what}`) };
  }
  const findings: RawFinding[] = [];
  for (const [index, finding] of parsed.data.findings.entries()) {
    const body = finding.body.replace(LEADING_TAG, '');
    if (body === '') return { ok: false, reason: `findings[${index}].body: empty after removing the severity tag` };
    findings.push({ ...finding, body });
  }
  const value: SubmitReviewArgs = { overview: parsed.data.overview, findings, files: parsed.data.files };
  if (withThreads) {
    const given = (parsed.data as { thread_verdicts?: RawVerdict[] }).thread_verdicts ?? [];
    value.thread_verdicts = given.map((v) => (v.reply === undefined ? { thread_id: v.thread_id, verdict: v.verdict } : { thread_id: v.thread_id, verdict: v.verdict, reply: v.reply }));
  }
  return { ok: true, value };
}
