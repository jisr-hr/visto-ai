import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import type { Association, FileStatus, HumanReview, Side } from '../../forge/types.ts';

export interface HistoryActivity {
  kind: 'review' | 'inline' | 'comment';
  id: string; author: string; bot: boolean; association: Association; at: string; body: string;
  state?: HumanReview['state']; commit?: string | null;                                         // review, inline
  path?: string; side?: Side; line?: number | null; start_line?: number | null; file_level?: boolean; reply_to?: string | null; // inline
}
export interface HistoryCase {
  version: 1;
  repo: string; pr_number: number; title: string; body: string; author: string; branch: string; base_branch: string; merged_at: string;
  review_head: string; review_base: string; review_at: string; reviewed_by_person: boolean;
  final_head: string; final_base: string;
  final_files: { path: string; previous_path: string | null; status: FileStatus; patch: string | null }[];
  activity: HistoryActivity[];
}

const activitySchema = z.object({
  kind: z.enum(['review', 'inline', 'comment']),
  id: z.string(), author: z.string(), bot: z.boolean(),
  association: z.enum(['owner', 'member', 'collaborator', 'none']),
  at: z.string(), body: z.string(),
  state: z.enum(['approved', 'changes_requested', 'commented', 'dismissed']).optional(),
  commit: z.string().nullable().optional(),
  path: z.string().optional(),
  side: z.enum(['LEFT', 'RIGHT']).optional(),
  line: z.number().int().nullable().optional(),
  start_line: z.number().int().nullable().optional(),
  file_level: z.boolean().optional(),
  reply_to: z.string().nullable().optional(),
});

const caseSchema = z.object({
  version: z.literal(1),
  repo: z.string(), pr_number: z.number().int(), title: z.string(), body: z.string(), author: z.string(),
  branch: z.string(), base_branch: z.string(), merged_at: z.string(),
  review_head: z.string(), review_base: z.string(), review_at: z.string(), reviewed_by_person: z.boolean(),
  final_head: z.string(), final_base: z.string(),
  final_files: z.array(z.object({
    path: z.string(), previous_path: z.string().nullable(),
    status: z.enum(['added', 'modified', 'removed', 'renamed']),
    patch: z.string().nullable(),
  })),
  activity: z.array(activitySchema),
});

export function historyKey(c: HistoryCase): string {
  return `${c.repo}#${c.pr_number}@${c.review_head.slice(0, 12)}`;
}

// History files hold private code and names: a failure reports a line number and nothing else.
export function parseHistory(jsonl: string): HistoryCase[] {
  const cases: HistoryCase[] = [];
  jsonl.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      cases.push(caseSchema.parse(JSON.parse(line)) as HistoryCase);
    } catch {
      throw new Error(`bad_history_line_${index + 1}`);
    }
  });
  return cases;
}

export function loadHistory(path: string): { cases: HistoryCase[]; sha256: string } {
  const bytes = readFileSync(path);
  return { cases: parseHistory(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
}

function activityOf(a: HistoryActivity): HistoryActivity {
  return {
    kind: a.kind, id: a.id, author: a.author, bot: a.bot, association: a.association, at: a.at, body: a.body,
    ...(a.state === undefined ? {} : { state: a.state }),
    ...(a.commit === undefined ? {} : { commit: a.commit }),
    ...(a.path === undefined ? {} : { path: a.path }),
    ...(a.side === undefined ? {} : { side: a.side }),
    ...(a.line === undefined ? {} : { line: a.line }),
    ...(a.start_line === undefined ? {} : { start_line: a.start_line }),
    ...(a.file_level === undefined ? {} : { file_level: a.file_level }),
    ...(a.reply_to === undefined ? {} : { reply_to: a.reply_to }),
  };
}

// Keys are written in the order the interface lists them, so the same input always gives the same bytes.
export function serializeCase(c: HistoryCase): string {
  const ordered: HistoryCase = {
    version: 1,
    repo: c.repo, pr_number: c.pr_number, title: c.title, body: c.body, author: c.author, branch: c.branch,
    base_branch: c.base_branch, merged_at: c.merged_at,
    review_head: c.review_head, review_base: c.review_base, review_at: c.review_at, reviewed_by_person: c.reviewed_by_person,
    final_head: c.final_head, final_base: c.final_base,
    final_files: c.final_files.map((f) => ({ path: f.path, previous_path: f.previous_path, status: f.status, patch: f.patch })),
    activity: c.activity.map(activityOf),
  };
  return JSON.stringify(ordered);
}
