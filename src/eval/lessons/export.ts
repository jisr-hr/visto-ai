// The operator's export (plan "evals with lessons", calls 4, 5, 16): the findings of published runs, the replies under
// them and the later verdicts of their threads, read in one read-only transaction and written to one file, mode 600,
// outside the project. It writes nothing to the database. Nothing it prints holds a reply, a finding, a path or a login.
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';

import { isApplied } from '../../db/migrate.ts';
import type { Db } from '../../db/types.ts';
import type { Association, Side } from '../../forge/types.ts';
import { findingBody } from '../../memory/judge.ts';
import { findingsText } from './findings.ts';
import type { ExportedFinding, ExportedLater, ExportedReply, FindingsFile } from './findings.ts';

interface FindingRow {
  service: string; owner: string; repo: string; number: number;
  run: number; head_sha: string; base_sha: string | null; started_at: Date; findings: unknown;
  comment_id: string; path: string; side: Side; line: number | null; severity: string; quote: string;
}
interface ReplyRow {
  service: string; comment_id: string; id: number; source_id: string; association: Association | null; body: string; at: Date;
}
interface LaterRow { service: string; comment_id: string; run: number; started_at: Date; published_at: Date | null; verdict: unknown }

const keyOf = (service: string, commentId: string): string => `${service}\u0000${commentId}`;
const FINDINGS_OF = `c.severity <> 'note' and r.published`;

/** Every finding of a published run with its replies and the later verdicts of its thread, from one snapshot of the database. */
export async function exportFindings(db: Db, now: Date): Promise<FindingsFile> {
  return db.transaction(async (tx) => {
    await tx.query('set transaction isolation level repeatable read, read only');
    const rows = await tx.query<FindingRow>(
      `select c.service, c.owner, c.repo, c.number, r.id as run, r.head_sha, r.base_sha, r.started_at,
              case when row_number() over (partition by r.id order by c.id) = 1 then r.result -> 'findings' end as findings,
              c.comment_id, c.path, c.side, c.line, c.severity, c.quote
       from visto_ai.review_comments c
       join visto_ai.review_runs r on r.id = c.run
       where ${FINDINGS_OF}
       order by c.owner, c.repo, c.number, r.id, c.id`);
    const replyRows = await tx.query<ReplyRow>(
      `select c.service, c.comment_id, h.id, h.source_id, h.association, h.body, h.at
       from visto_ai.review_comments c
       join visto_ai.review_runs r on r.id = c.run
       join visto_ai.human_activity h
         on h.service = c.service and h.owner = c.owner and h.repo = c.repo and h.number = c.number
        and h.kind = 'inline_comment' and h.reply_to = c.comment_id
       where ${FINDINGS_OF}
       order by h.id`);
    const laterRows = await tx.query<LaterRow>(
      `select c.service, c.comment_id, l.id as run, l.started_at, l.published_at, v ->> 'verdict' as verdict
       from visto_ai.review_comments c
       join visto_ai.review_runs r on r.id = c.run
       join visto_ai.review_runs l
         on l.service = c.service and l.owner = c.owner and l.repo = c.repo and l.number = c.number and l.published
       cross join lateral jsonb_array_elements(
         case when jsonb_typeof(l.result -> 'threadVerdicts') = 'array' then l.result -> 'threadVerdicts' else '[]'::jsonb end) as v
       where ${FINDINGS_OF} and v ->> 'commentId' = c.comment_id
       order by l.id`);

    const replies = new Map<string, ExportedReply[]>();
    for (const x of replyRows) {
      const list = replies.get(keyOf(x.service, x.comment_id)) ?? [];
      list.push({ id: x.source_id, order: x.id, association: x.association, body: x.body, at: x.at.toISOString() });
      replies.set(keyOf(x.service, x.comment_id), list);
    }
    const later = new Map<string, ExportedLater[]>();
    for (const x of laterRows) {
      if (typeof x.verdict !== 'string') continue;
      const list = later.get(keyOf(x.service, x.comment_id)) ?? [];
      list.push({ run: x.run, started_at: x.started_at.toISOString(), published_at: x.published_at === null ? null : x.published_at.toISOString(), verdict: x.verdict });
      later.set(keyOf(x.service, x.comment_id), list);
    }
    // The run's findings come once, on its first comment's row (the rows are in run order).
    const findingsOfRun = new Map<number, unknown>();
    for (const x of rows) if (!findingsOfRun.has(x.run)) findingsOfRun.set(x.run, x.findings);
    const findings: ExportedFinding[] = rows.map((x) => ({
      repo: `${x.owner}/${x.repo}`, pr_number: x.number,
      run: { id: x.run, head_sha: x.head_sha, base_sha: x.base_sha, started_at: x.started_at.toISOString() },
      comment_id: x.comment_id, path: x.path, side: x.side, line: x.line, severity: x.severity,
      finding: findingBody({ path: x.path, side: x.side, line: x.line, severity: x.severity, quote: x.quote }, findingsOfRun.get(x.run)),
      replies: replies.get(keyOf(x.service, x.comment_id)) ?? [],
      later: later.get(keyOf(x.service, x.comment_id)) ?? [],
    }));
    return { exported_at: now.toISOString(), findings };
  });
}

/** The command's steps once connected: refuses a database 0003_publishing is not applied to, and an existing `out` without `force`, before any read; exports; writes `out` mode 600; returns the one line to print. */
export async function exportCommand(db: Db, out: string, force: boolean, now: Date): Promise<string> {
  if (!(await isApplied(db, '0003_publishing'))) throw new Error('database_not_migrated');
  if (!force && existsSync(out)) throw new Error('out_exists');
  const file = await exportFindings(db, now);
  if (force) rmSync(out, { force: true });          // a new file, so it is never written wide
  try {
    writeFileSync(out, findingsText(file), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('out_exists');
    throw error;
  }
  chmodSync(out, 0o600);          // a file that was there keeps its old mode through the write
  const withReplies = file.findings.filter((f) => f.replies.length > 0).length;
  const replies = file.findings.reduce((n, f) => n + f.replies.length, 0);
  const pullRequests = new Set(file.findings.map((f) => `${f.repo}#${f.pr_number}`)).size;
  return `findings ${file.findings.length}, with replies ${withReplies}, replies ${replies}, pull requests ${pullRequests}`;
}
