// A night's run of the judge (7.2, 7.3, 12, calls 2, 6 to 17): it finds the replies to judge by what is stored, judges
// one reply at a time, writes each verdict, its cost and its lesson in one transaction, stops at the cap of lessons,
// at a stop, while reviews are paused and after failures at the provider, and records what it did. Logs hold counts,
// a cost and short codes: never a reply's words, a finding, a lesson's text, a quote, a path or a login.
import { addToLearning, noteLearning } from '../db/learning.ts';
import { addRecords, standingLessons } from '../db/memory-records.ts';
import type { NewRecord, RepoKey } from '../db/memory-records.ts';
import { lessonsMadeSince, laterVerdict, noteVerdict, repliesToJudge } from '../db/reply-verdicts.ts';
import type { QueuedReply } from '../db/reply-verdicts.ts';
import { recordJudgeCall } from '../db/review-runs.ts';
import type { Db } from '../db/types.ts';
import { stripControl } from '../engine/context/untrusted.ts';
import type { ModelClient, Usage } from '../engine/types.ts';
import { askJudge, findingBody, lessonOf, restates } from '../memory/judge.ts';
import type { Outcome } from '../memory/judge.ts';
import { LESSON_DAYS, LESSONS_READ } from '../memory/lessons.ts';
import { dayStart } from '../memory/select.ts';
import { directoryOf, ownWords } from '../memory/signals.ts';
import { codeOf } from './codes.ts';

export const WORK_LESSONS = 'lessons';     // the row of the learning table this work writes
export const JUDGE_REPLIES = 100;          // replies one run takes
export const JUDGE_STRANGERS = 20;         // of those, the replies of strangers at most
export const JUDGE_ATTEMPTS = 3;           // answers with no verdict after which a reply is retired
export const LESSONS_PER_RUN = 10;
export const JUDGE_FAILURES = 3;           // calls that fail at the provider in a row before a run ends for now

export type RunEnd = 'done' | 'lesson_cap' | 'stopped' | 'spend_limit' | 'model_error' | 'auth' | 'no_credit' | 'rate_limited' | 'timeout' | 'provider';
export interface Judged {
  judged: number;      // replies that got a classification
  lessons: number;     // lessons made
  givenUp: number;     // replies retired
  failed: number;      // calls that failed at the provider, or gave no verdict
  calls: number; cost: number;   // requests answered, and what they cost
  more: boolean;       // the queue held replies the run did not take
  end: RunEnd; complete: boolean;   // complete: the end is done or lesson_cap
}

const DAY_MS = 86_400_000;
const WITH_ACCESS: ReadonlySet<unknown> = new Set(['owner', 'member', 'collaborator']);

type Log = (entry: Record<string, unknown>) => void;

const safe = (log: Log | undefined): Log => (entry) => {
  if (log === undefined) return;
  try {
    log(entry);
  } catch {
    // a logger that throws changes nothing
  }
};

type Deps = {
  db: Db; clock: () => Date; model: ModelClient; token: () => string; auto: boolean;
  /** The time limit of each request, in milliseconds: the one a review's request has. */
  timeoutMs: number;
  /** Why reviews do not start now, as a short code; null when they do. Asked before every call. */
  paused: () => Promise<string | null>;
  /** Told the usage of every answered call, as the spend guard is told a run's. */
  noteUsage?: (usage: { inputTokens: number; outputTokens: number; cost: number }) => void;
  log?: (entry: Record<string, unknown>) => void; stopping?: () => boolean; replies?: number;
};

/** One run. Rejects when the database does; what it committed before stays. replies: for tests; absent: JUDGE_REPLIES. */
export async function judgeOnce(deps: Deps): Promise<Judged> {
  const log = safe(deps.log);
  try {
    return await runOnce(deps, log);
  } catch (err) {
    log({ event: 'lessons_failed', reason: codeOf(err) });
    throw err;
  }
}

const repoOf = (r: QueuedReply): RepoKey => ({ service: r.ref.service, owner: r.ref.owner, repo: r.ref.repo });

// The record of a lesson (rule 9): live from the 00:00 UTC that follows the reply, for LESSON_DAYS days.
function lessonRecord(r: QueuedReply, text: string, quote: string): NewRecord {
  const created = dayStart(new Date(r.at)).getTime() + DAY_MS;
  return {
    kind: 'lesson', sourceRef: `${r.ref.number}:${r.reply}`, number: r.ref.number,
    path: r.path, directory: directoryOf(r.path), category: null, reason: null, missed: false,
    excerpt: quote, comment: r.reply, lesson: text,
    createdAt: new Date(created).toISOString(), expiresAt: new Date(created + LESSON_DAYS * DAY_MS).toISOString(),
  };
}

const runUsage = (u: Usage): Usage => ({ calls: u.calls, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedTokens: u.cachedTokens, cost: u.cost });
const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);

async function runOnce(deps: Deps, log: Log): Promise<Judged> {
  const { db } = deps;
  const size = deps.replies ?? JUDGE_REPLIES;
  const stopping = (): boolean => {
    try {
      return deps.stopping?.() === true;
    } catch {
      return true;   // a stop that cannot be read is a stop
    }
  };
  const now = (): string => deps.clock().toISOString();
  const out: Judged = { judged: 0, lessons: 0, givenUp: 0, failed: 0, calls: 0, cost: 0, more: false, end: 'done', complete: false };

  // Rule 1: the run's day, fixed for the whole run.
  const day = dayStart(deps.clock());
  const since = new Date(day.getTime() - LESSON_DAYS * DAY_MS).toISOString();
  const queue = await repliesToJudge(db, since, day.toISOString(), size + 1, JUDGE_ATTEMPTS);
  out.more = queue.length > size;
  const taken: QueuedReply[] = [];
  let strangers = 0;
  for (const r of queue.slice(0, size)) {
    if (!WITH_ACCESS.has(r.association)) {
      if (strangers >= JUDGE_STRANGERS) {
        out.more = true;
        continue;
      }
      strangers += 1;
    }
    taken.push(r);
  }

  // Rule 2: the cap, counted from the stored verdicts since the run's day began.
  let made = await lessonsMadeSince(db, day.toISOString());
  let inRow = 0;
  let end: RunEnd | null = made >= LESSONS_PER_RUN ? 'lesson_cap' : null;

  for (const r of end === null ? taken : []) {
    // Rule 3.
    if (stopping()) { end = 'stopped'; break; }
    const why = await deps.paused();
    if (why !== null) { end = why === 'spend_limit' ? 'spend_limit' : 'model_error'; break; }

    // Rule 4: a reply with no call.
    if (stripControl(ownWords(r.body)).text.trim() === '') {
      await noteVerdict(db, { ref: r.ref, reply: r.reply, finding: r.finding, classification: 'noise', outcome: 'no_own_words', attempts: r.attempts, judgedAt: now() });
      out.judged += 1;
      continue;
    }
    const finding = findingBody({ path: r.path, side: r.side, line: r.line, severity: r.severity, quote: r.quote }, r.findings);
    if (finding === null) {
      await noteVerdict(db, { ref: r.ref, reply: r.reply, finding: r.finding, classification: null, outcome: 'finding_unknown', attempts: JUDGE_ATTEMPTS, judgedAt: now() });
      out.givenUp += 1;
      continue;
    }

    // Rule 5: the call.
    const asked = await askJudge(deps.model, { path: r.path, severity: r.severity, finding, reply: r.body }, deps.token(), deps.auto, deps.timeoutMs);
    const answered = asked.usage.calls > 0;
    if (answered) {
      out.calls += finite(asked.usage.calls);
      out.cost += finite(asked.usage.cost);
      try {
        deps.noteUsage?.({ inputTokens: asked.usage.inputTokens, outputTokens: asked.usage.outputTokens, cost: asked.usage.cost });
      } catch {
        // a guard that throws changes nothing
      }
    }
    if (stopping()) { end = 'stopped'; break; }

    if (!asked.ok && asked.code !== 'invalid_output') {
      // Rule 6: a call that failed at the provider.
      if (answered) await recordJudgeCall(db, r.ref, r.reply, now(), runUsage(asked.usage));
      if (asked.code === 'auth' || asked.code === 'no_credit') { end = asked.code; break; }
      out.failed += 1;
      inRow += 1;
      if (inRow >= JUDGE_FAILURES) { end = asked.code; break; }
      continue;
    }
    inRow = 0;
    const at = now();

    if (!asked.ok) {
      // Rule 7: an answer with no verdict.
      const attempts = r.attempts + 1;
      await db.transaction(async (tx) => {
        await recordJudgeCall(tx, r.ref, r.reply, at, runUsage(asked.usage));
        await noteVerdict(tx, { ref: r.ref, reply: r.reply, finding: r.finding, classification: null, outcome: 'unjudged', attempts, judgedAt: at });
      });
      out.failed += 1;
      if (attempts >= JUDGE_ATTEMPTS) out.givenUp += 1;
      continue;
    }

    // Rule 8: a verdict.
    const result = lessonOf(asked.value, { body: r.body, association: r.association }, r.path);
    let outcome: Outcome = result.outcome;
    if (result.outcome === 'lesson') {
      const later = await laterVerdict(db, r.ref, r.finding, r.at);
      if (later === 'open' || later === 'fixed') outcome = 'review_disagreed';
      else if (restates(result.text, await standingLessons(db, repoOf(r), at, LESSONS_READ))) outcome = 'restates';
    }
    await db.transaction(async (tx) => {
      await recordJudgeCall(tx, r.ref, r.reply, at, runUsage(asked.usage));
      await noteVerdict(tx, { ref: r.ref, reply: r.reply, finding: r.finding, classification: asked.value.classification, outcome, attempts: r.attempts, judgedAt: at });
      if (outcome === 'lesson' && result.outcome === 'lesson') await addRecords(tx, repoOf(r), [lessonRecord(r, result.text, result.quote)]);
    });
    out.judged += 1;
    if (outcome === 'lesson') {
      out.lessons += 1;
      made += 1;
      if (made >= LESSONS_PER_RUN) { end = 'lesson_cap'; break; }
    }
  }

  // Rule 11: the end.
  out.end = end ?? 'done';
  out.complete = out.end === 'done' || out.end === 'lesson_cap';
  const counts = { examined: out.judged, added: out.lessons, retired: out.givenUp, failed: out.failed };
  if (out.complete) await noteLearning(db, WORK_LESSONS, now(), counts);
  else if (out.end !== 'stopped') await addToLearning(db, WORK_LESSONS, now(), counts);
  log({ event: 'lessons', judged: out.judged, lessons: out.lessons, given_up: out.givenUp, failed: out.failed, calls: out.calls, cost: out.cost, more: out.more, end: out.end });
  return out;
}
