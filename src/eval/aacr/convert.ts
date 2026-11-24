import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

import { stripControl } from '../../engine/context/untrusted.ts';
import type { HistorySource, MergedPullRequest, Side } from '../../forge/types.ts';
import type { EvalCase, Label } from '../cases.ts';
import { serializeCase } from '../history/file.ts';
import type { HistoryActivity, HistoryCase } from '../history/file.ts';

export interface AacrComment { path: string; side: Side; fromLine: number; toLine: number; text: string }
export interface AacrRecord {
  url: string; owner: string; repo: string; number: number; base: string; head: string;
  createdAt: string; mergedAt: string; comments: AacrComment[];
}
export type AacrSkip = 'pr_unreadable' | 'head_unreadable' | 'too_many_files';

const TEXT_LIMIT = 2000;
// As import-history keeps a description.
const DESCRIPTION_LIMIT = 4000;
const URL_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/;
const COMMIT = /^[0-9a-f]{40}$/i;

function cut(text: string, limit: number): string {
  return stripControl(text).text.slice(0, limit);
}

// The file is untrusted: a value may be a number or an integer string, and anything else is refused.
const lineSchema = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) { ctx.addIssue({ code: 'custom', message: 'bad_line' }); return z.NEVER; }
  return n;
});

const commentSchema = z.object({
  path: z.string().min(1),
  side: z.string().transform((v, ctx) => {
    const side = v.toUpperCase();
    if (side !== 'LEFT' && side !== 'RIGHT') { ctx.addIssue({ code: 'custom', message: 'bad_side' }); return z.NEVER; }
    return side as Side;
  }),
  from_line: lineSchema,
  to_line: lineSchema,
  note: z.string().refine((v) => v.trim() !== ''),
});

const date = z.string().refine((v) => !Number.isNaN(Date.parse(v)));
const recordSchema = z.object({
  githubPrUrl: z.string().regex(URL_PATTERN),
  source_commit: z.string().regex(COMMIT),
  target_commit: z.string().regex(COMMIT),
  created_at: date,
  merged_at: date,
  comments: z.array(z.unknown()),
});

function sortKey(r: AacrRecord): string {
  return createHash('sha256').update(`${r.url}@${r.head}`).digest('hex');
}

// The file is read, validated and never executed. A failure counts and names no data.
export function parseAacr(json: string): { records: AacrRecord[]; skipped: { bad_record: number; bad_comment: number; duplicate: number } } {
  let data: unknown;
  try { data = JSON.parse(json); } catch { throw new Error('bad_aacr_file'); }
  if (!Array.isArray(data)) throw new Error('bad_aacr_file');
  const skipped = { bad_record: 0, bad_comment: 0, duplicate: 0 };
  const seen = new Set<string>();
  const records: AacrRecord[] = [];
  for (const item of data as unknown[]) {
    const parsed = recordSchema.safeParse(item);
    if (!parsed.success) { skipped.bad_record += 1; continue; }
    const raw = parsed.data;
    const comments: AacrComment[] = [];
    for (const entry of raw.comments) {
      const c = commentSchema.safeParse(entry);
      if (!c.success) { skipped.bad_comment += 1; continue; }
      const { from_line: a, to_line: b } = c.data;
      comments.push({ path: c.data.path, side: c.data.side, fromLine: Math.min(a, b), toLine: Math.max(a, b), text: c.data.note });
    }
    if (comments.length === 0) { skipped.bad_record += 1; continue; }
    const match = URL_PATTERN.exec(raw.githubPrUrl)!;
    const record: AacrRecord = {
      url: raw.githubPrUrl, owner: match[1]!, repo: match[2]!, number: Number(match[3]),
      base: raw.source_commit.toLowerCase(), head: raw.target_commit.toLowerCase(),
      createdAt: raw.created_at, mergedAt: raw.merged_at, comments,
    };
    const identity = `${record.url}@${record.head}`;
    if (seen.has(identity)) { skipped.duplicate += 1; continue; }
    seen.add(identity);
    records.push(record);
  }
  // A fixed order, whatever the file's own: --max-cases then takes a spread.
  const keyed = records.map((r) => ({ r, key: sortKey(r) }));
  keyed.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return { records: keyed.map((k) => k.r), skipped };
}

export function toEvalCase(r: AacrRecord, pr: MergedPullRequest, mergeBase: string): EvalCase {
  const labels: Label[] = r.comments.map((c, i) => ({
    comment_id: `aacr-${i + 1}`, path: c.path, line: c.toLine, side: c.side, severity: '', label: 'valid',
    tolerance: c.toLine - c.fromLine + 3, text: cut(c.text, TEXT_LIMIT), start_line: c.fromLine,
  }));
  return {
    repo: `${r.owner}/${r.repo}`, pr_number: r.number, head_sha: r.head, compare_base: mergeBase,
    title: pr.title, body: pr.description.slice(0, DESCRIPTION_LIMIT), branch: pr.headBranch, base_branch: pr.baseBranch,
    author: pr.author, labels,
  };
}

export function toHistoryCase(r: AacrRecord, pr: MergedPullRequest, mergeBase: string): HistoryCase {
  const activity: HistoryActivity[] = r.comments.map((c, i) => ({
    kind: 'inline', id: `aacr-${i + 1}`, author: 'aacr-reference', bot: false, association: 'member', at: r.createdAt,
    body: cut(c.text, TEXT_LIMIT), commit: r.head, path: c.path, side: c.side, line: c.toLine, start_line: c.fromLine,
    file_level: false, reply_to: null,
  }));
  return {
    version: 1,
    repo: `${r.owner}/${r.repo}`, pr_number: r.number, title: pr.title, body: pr.description.slice(0, DESCRIPTION_LIMIT),
    author: pr.author, branch: pr.headBranch, base_branch: pr.baseBranch, merged_at: r.mergedAt,
    review_head: r.head, review_base: mergeBase, review_at: r.createdAt, reviewed_by_person: true,
    final_head: r.head, final_base: mergeBase, final_files: [], activity,
  };
}

function freshFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // A link at the path would send the writes to its target: remove it, never follow it.
  rmSync(path, { force: true });
  writeFileSync(path, '');
}

export async function runAacrImport(
  args: { records: AacrRecord[]; source: HistorySource; casesOut: string; historyOut: string },
): Promise<{ written: number; skipped: Record<AacrSkip, number> }> {
  freshFile(args.casesOut);
  freshFile(args.historyOut);
  const skipped: Record<AacrSkip, number> = { pr_unreadable: 0, head_unreadable: 0, too_many_files: 0 };
  let written = 0;
  // One at a time: the source is rate limited. Each line is appended at once, so a failure keeps what was read.
  for (const r of args.records) {
    const repo = { owner: r.owner, repo: r.repo };
    let pr: MergedPullRequest | null;
    try {
      pr = await args.source.pullRequest(repo, r.number);
    } catch (error) {
      if (error instanceof Error && /^github_\d{3}$/.test(error.message)) { skipped.pr_unreadable += 1; continue; }
      throw error;
    }
    if (pr === null) { skipped.pr_unreadable += 1; continue; }
    let comparison;
    try {
      comparison = await args.source.compare(repo, r.base, r.head);
    } catch (error) {
      if (error instanceof Error && error.message === 'too_many_files') { skipped.too_many_files += 1; continue; }
      // One record whose commit GitHub refuses (a 422, say) must not end the import.
      if (error instanceof Error && /^github_\d{3}$/.test(error.message)) { skipped.head_unreadable += 1; continue; }
      throw error;
    }
    if (comparison === null) { skipped.head_unreadable += 1; continue; }
    appendFileSync(args.casesOut, JSON.stringify(toEvalCase(r, pr, comparison.mergeBase)) + '\n');
    appendFileSync(args.historyOut, serializeCase(toHistoryCase(r, pr, comparison.mergeBase)) + '\n');
    written += 1;
  }
  return { written, skipped };
}
