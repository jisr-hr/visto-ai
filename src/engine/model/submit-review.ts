import { z } from 'zod';
import type { RawFinding, ToolDefinition } from '../types.ts';

export const SUBMIT_REVIEW = 'submit_review';
export interface SubmitReviewArgs { overview: string; findings: RawFinding[] }

const findingSchema = z.object({
  path: z.string().trim().min(1),
  side: z.enum(['LEFT', 'RIGHT']),
  line: z.number().int().positive(),
  severity: z.enum(['blocker', 'major', 'minor']),
  body: z.string().trim().min(1),
  quote: z.string(),
  beyond_diff: z.boolean(),
}).strict();

const argsSchema = z.object({
  overview: z.string().trim().min(1),
  findings: z.array(findingSchema),
}).strict();

const parameters = z.toJSONSchema(argsSchema) as Record<string, unknown>;
delete parameters.$schema;

export const submitReviewTool: ToolDefinition = {
  type: 'function',
  function: {
    name: SUBMIT_REVIEW,
    description: 'Submit your review of the pull request. Call this tool exactly once, with your overview and all of your findings.',
    parameters,
  },
};

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
export function parseSubmitReview(json: string): { ok: true; value: SubmitReviewArgs } | { ok: false; reason: string } {
  const parsed = parseArgs(json);
  return parsed.ok ? parsed : { ok: false, reason: oneLine(parsed.reason).slice(0, MAX_REASON_CHARS) };
}

function parseArgs(json: string): { ok: true; value: SubmitReviewArgs } | { ok: false; reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const parsed = argsSchema.safeParse(data);
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
  return { ok: true, value: { overview: parsed.data.overview, findings } };
}
