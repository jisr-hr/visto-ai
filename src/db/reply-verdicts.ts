import type { Association, PullRequestRef, Side } from '../forge/types.ts';
import { storable, storableOrNull } from './text.ts';
import type { Db } from './types.ts';

export interface QueuedReply {
  ref: PullRequestRef; reply: string;                    // the reply's comment id
  association: Association | null; body: string; at: string;
  finding: string;                                       // the id of the finding's posted comment
  path: string; side: Side; line: number | null; severity: string; quote: string;   // of that posted comment
  findings: unknown;                                     // `result.findings` of the run that posted it, as stored
  attempts: number;
}

interface QueuedRow {
  service: 'github'; owner: string; repo: string; number: number; reply: string; association: Association | null; body: string; at: Date;
  finding: string; path: string; side: Side; line: number | null; severity: string; quote: string; findings: unknown; attempts: number;
}

/** The replies in finding threads written at or after `since` and before `before` that have no classification and fewer than `maxAttempts` attempts: those of people with access first, then the oldest; at most `limit`. */
export async function repliesToJudge(db: Db, since: string, before: string, limit: number, maxAttempts: number): Promise<QueuedReply[]> {
  const rows = await db.query<QueuedRow>(
    `select h.service, h.owner, h.repo, h.number, h.source_id as reply, h.association, h.body, h.at,
            c.comment_id as finding, c.path, c.side, c.line, c.severity, c.quote,
            r.result -> 'findings' as findings,
            coalesce(v.attempts, 0) as attempts
     from visto_ai.human_activity h
     join visto_ai.review_comments c
       on c.service = h.service and c.owner = h.owner and c.repo = h.repo and c.number = h.number
      and c.comment_id = h.reply_to and c.severity <> 'note'
     join visto_ai.review_runs r on r.id = c.run
     left join visto_ai.reply_verdicts v on v.service = h.service and v.reply = h.source_id
     where h.kind = 'inline_comment'
       and h.at >= $1::timestamptz and h.at < $2::timestamptz
       and (v.reply is null or (v.classification is null and v.attempts < $3))
     order by coalesce(h.association in ('owner', 'member', 'collaborator'), false) desc, h.at, h.id
     limit $4`,
    [since, before, maxAttempts, limit]);
  return rows.map((x) => ({
    ref: { service: x.service, owner: x.owner, repo: x.repo, number: x.number }, reply: x.reply,
    association: x.association, body: x.body, at: x.at.toISOString(),
    finding: x.finding, path: x.path, side: x.side, line: x.line, severity: x.severity, quote: x.quote,
    findings: x.findings, attempts: x.attempts,
  }));
}

export interface Verdict { ref: PullRequestRef; reply: string; finding: string; classification: string | null; outcome: string; attempts: number; judgedAt: string }

/** Writes the reply's row. A row that has a classification is left as it is; one that has none is replaced. */
export async function noteVerdict(db: Db, v: Verdict): Promise<void> {
  await db.query(
    `insert into visto_ai.reply_verdicts (service, owner, repo, number, reply, finding, classification, outcome, attempts, judged_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
     on conflict (service, reply) do update set
       classification = excluded.classification, outcome = excluded.outcome, attempts = excluded.attempts, judged_at = excluded.judged_at
     where visto_ai.reply_verdicts.classification is null`,
    [
      v.ref.service, storable(v.ref.owner).toLowerCase(), storable(v.ref.repo).toLowerCase(), v.ref.number,
      storable(v.reply), storable(v.finding), storableOrNull(v.classification), storable(v.outcome), v.attempts, v.judgedAt,
    ]);
}

/** How many verdicts with the outcome `lesson` were judged at or after `since`. */
export async function lessonsMadeSince(db: Db, since: string): Promise<number> {
  const rows = await db.query<{ n: number }>(
    "select count(*)::int as n from visto_ai.reply_verdicts where outcome = 'lesson' and judged_at >= $1::timestamptz",
    [since]);
  return rows[0]!.n;
}

/** The verdict (`fixed`, `answered`, `open`, or whatever is stored) that the newest published run of the pull request started after `after` kept for the thread whose first comment is `finding`; null when no such run kept one. */
export async function laterVerdict(db: Db, ref: PullRequestRef, finding: string, after: string): Promise<string | null> {
  const rows = await db.query<{ verdict: string | null }>(
    `select v ->> 'verdict' as verdict
     from visto_ai.review_runs r
     cross join lateral jsonb_array_elements(
       case when jsonb_typeof(r.result -> 'threadVerdicts') = 'array' then r.result -> 'threadVerdicts' else '[]'::jsonb end) as v
     where r.service = $1 and r.owner = $2 and r.repo = $3 and r.number = $4
       and r.published and r.started_at > $5::timestamptz
       and v ->> 'commentId' = $6
     order by r.id desc
     limit 1`,
    [ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number, after, storable(finding)]);
  return rows[0]?.verdict ?? null;
}
