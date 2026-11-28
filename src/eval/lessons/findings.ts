// The export of the reviewer's findings (plan "evals with lessons", calls 4, 5, 16): one header line, then one line per
// finding with the replies under it and the later verdicts of its thread. The file holds private text, so a line that
// cannot be read is named by its number and nothing else.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import type { Association, Side } from '../../forge/types.ts';

export interface ExportedReply { id: string; order: number; association: Association | null; body: string; at: string }   // order: human_activity.id
export interface ExportedLater { run: number; started_at: string; published_at: string | null; verdict: string }
export interface ExportedFinding {
  repo: string; pr_number: number;                         // repo: owner/name as stored (lower case)
  run: { id: number; head_sha: string; base_sha: string | null; started_at: string };
  comment_id: string; path: string; side: Side; line: number | null; severity: string;
  finding: string | null;                                  // findingBody of the comment over its run's stored findings
  replies: ExportedReply[];                                // by order
  later: ExportedLater[];                                  // published runs of the pull request that kept a verdict for this thread, by run id
}
export interface FindingsFile { exported_at: string; findings: ExportedFinding[] }

const headerSchema = z.strictObject({ version: z.literal(1), kind: z.literal('findings_export'), exported_at: z.string() });

const findingSchema = z.strictObject({
  version: z.literal(1),
  repo: z.string(), pr_number: z.number().int(),
  run: z.strictObject({ id: z.number().int(), head_sha: z.string(), base_sha: z.string().nullable(), started_at: z.string() }),
  comment_id: z.string(), path: z.string(), side: z.enum(['LEFT', 'RIGHT']), line: z.number().int().nullable(), severity: z.string(),
  finding: z.string().nullable(),
  replies: z.array(z.strictObject({
    id: z.string(), order: z.number().int(), association: z.enum(['owner', 'member', 'collaborator', 'none']).nullable(),
    body: z.string(), at: z.string(),
  })),
  later: z.array(z.strictObject({
    run: z.number().int(), started_at: z.string(), published_at: z.string().nullable(), verdict: z.string(),
  })),
});

/** The JSONL: a header line, then one line per finding, keys in the order the interfaces list them. */
export function findingsText(file: FindingsFile): string {
  const lines = [JSON.stringify({ version: 1, kind: 'findings_export', exported_at: file.exported_at })];
  for (const f of file.findings) {
    lines.push(JSON.stringify({
      version: 1,
      repo: f.repo, pr_number: f.pr_number,
      run: { id: f.run.id, head_sha: f.run.head_sha, base_sha: f.run.base_sha, started_at: f.run.started_at },
      comment_id: f.comment_id, path: f.path, side: f.side, line: f.line, severity: f.severity,
      finding: f.finding,
      replies: f.replies.map((r) => ({ id: r.id, order: r.order, association: r.association, body: r.body, at: r.at })),
      later: f.later.map((l) => ({ run: l.run, started_at: l.started_at, published_at: l.published_at, verdict: l.verdict })),
    }));
  }
  return lines.join('\n') + '\n';
}

// Findings files hold private text: a failure reports a line number and nothing else.
export function parseFindings(jsonl: string): FindingsFile {
  let exportedAt: string | null = null;
  const findings: ExportedFinding[] = [];
  jsonl.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      const value: unknown = JSON.parse(line);
      if (exportedAt === null) {
        exportedAt = headerSchema.parse(value).exported_at;
        return;
      }
      const { version, ...finding } = findingSchema.parse(value);
      if (version !== 1) throw new Error('version');
      findings.push(finding as ExportedFinding);
    } catch {
      throw new Error(`bad_findings_line_${index + 1}`);
    }
  });
  if (exportedAt === null) throw new Error('bad_findings_line_1');
  return { exported_at: exportedAt, findings };
}

export function loadFindings(path: string): { file: FindingsFile; sha256: string } {
  const bytes = readFileSync(path);
  return { file: parseFindings(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
}
