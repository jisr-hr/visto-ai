// A night's run of the judge (7.2, 7.3, 12, calls 2, 6 to 17): it finds the replies to judge by what is stored, judges
// one reply at a time, writes each verdict, its cost and its lesson in one transaction, stops at the cap of lessons,
// at a stop, while reviews are paused and after failures at the provider, and records what it did. Logs hold counts,
// a cost and short codes: never a reply's words, a finding, a lesson's text, a quote, a path or a login.
import { addToLearning, noteLearning, readLearning, startLearning } from '../db/learning.ts';
import type { LearningState } from '../db/learning.ts';
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
import type { Alert } from './alerts.ts';
import { codeOf } from './codes.ts';
import { STALE_AFTER_MS } from './learning.ts';

export const WORK_LESSONS = 'lessons';     // the row of the learning table this work writes
export const JUDGE_REPLIES = 100;          // replies one run takes
export const JUDGE_STRANGERS = 20;         // of those, the replies of strangers at most
export const JUDGE_ATTEMPTS = 3;           // answers with no verdict after which a reply is retired
export const LESSONS_PER_RUN = 10;
export const JUDGE_FAILURES = 3;           // calls that fail at the provider in a row before a run ends for now
export const NIGHT_RETRY_MS = 3_600_000;   // how long after a run that did not complete the next is tried
export const ROW_WAIT_MS = 5_000;          // how long a tick waits for its read of the row

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

export interface Nightly {
  /** Makes sure the work's row is there, and logs what it holds. Rejects when the database does. */
  start(): Promise<void>;
  /** The check for staleness, then a run when one is due, which is not waited for. Never rejects. */
  tick(): Promise<void>;
  /** Resolves when no run is under way. */
  idle(): Promise<void>;
  /** No run starts from now on, and the run under way is told. */
  stop(): void;
}

const HOUR_MS = 3_600_000;

// The clock's time in milliseconds; null when it cannot be read.
function msOf(clock: () => Date): number | null {
  try {
    const ms = clock().getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

type RowRead = { ok: true; row: LearningState | null } | { ok: false; reason: string };

// The row, read once and waited for at most `ms`: a read that rejects or has not settled by then is a failed read.
async function readRow(db: Db, ms: number): Promise<RowRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<RowRead>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), ms);
    timer.unref?.();
  });
  let read: Promise<RowRead>;
  try {
    read = readLearning(db, WORK_LESSONS).then((row): RowRead => ({ ok: true, row }), (err: unknown): RowRead => ({ ok: false, reason: codeOf(err) }));
  } catch (err) {
    read = Promise.resolve({ ok: false, reason: codeOf(err) });
  }
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The nightly work (7.3, 14, D13, calls 15, 16): a run once in a UTC day, asked at every tick of the learning timer;
 *  a run that did not complete is tried again NIGHT_RETRY_MS later; lessons_stale after STALE_AFTER_MS with none. */
export function createNightly(deps: {
  db: Db; clock: () => Date; log: (entry: Record<string, unknown>) => void; alert: Alert;
  model: ModelClient; token: () => string; auto: boolean; timeoutMs: number; paused: () => Promise<string | null>;   // each handed to judgeOnce as it is
  noteUsage?: (usage: { inputTokens: number; outputTokens: number; cost: number }) => void;
  rowWaitMs?: number;   // for tests; absent: ROW_WAIT_MS
}): Nightly {
  const log = safe(deps.log);
  const rowWait = deps.rowWaitMs ?? ROW_WAIT_MS;
  let made: number | null = null;            // the first time the clock could be read: the 36 hours count from it when nothing else tells
  let lastCompleted: number | null = null;   // when a run last completed in this process
  let raised = false;                        // lessons_stale was raised since a run last completed
  let stopped = false;
  let notBefore: number | null = null;       // after a run that did not complete: no run is due before this time
  let current: Promise<void> | null = null;  // the run under way

  const now = (): number | null => {
    const ms = msOf(deps.clock);
    if (made === null && ms !== null) made = ms;
    return ms;
  };
  now();

  // Rule 4: what a run's end sets. `began`: the tick's time, used when the clock cannot be read at the end.
  function startRun(began: number): Promise<void> {
    return (async () => {
      let complete = false;
      try {
        const judged = await judgeOnce({
          db: deps.db, clock: deps.clock, model: deps.model, token: deps.token, auto: deps.auto, timeoutMs: deps.timeoutMs,
          paused: deps.paused, log, stopping: () => stopped,
          ...(deps.noteUsage === undefined ? {} : { noteUsage: deps.noteUsage }),
        });
        complete = judged.complete;
      } catch {
        // logged by the run
      }
      const ended = now() ?? began;
      if (complete) {
        lastCompleted = ended;
        notBefore = null;
        raised = false;
      } else {
        notBefore = ended + NIGHT_RETRY_MS;
      }
    })().finally(() => {
      current = null;
    });
  }

  // Rule 5: the time the 36 hours count from.
  function lastOf(read: RowRead): number | null {
    const fallback = lastCompleted ?? made;
    if (!read.ok || read.row === null) return fallback;
    const ms = Date.parse(read.row.ranAt ?? read.row.since);
    return Number.isFinite(ms) ? ms : fallback;
  }

  function checkStale(read: RowRead, at: number): void {
    const last = lastOf(read);
    if (raised || last === null || at - last <= STALE_AFTER_MS) return;
    raised = true;
    try {
      // An alert that throws, or returns a promise that rejects, changes nothing.
      const returned: unknown = deps.alert('lessons_stale', { hours: Math.floor((at - last) / HOUR_MS) });
      void Promise.resolve(returned).catch(() => {});
    } catch {
      // an alert that throws changes nothing
    }
  }

  // Rule 3: a run is due when none is under way, the wait after a run cut short is over, and none completed today.
  function due(read: RowRead & { ok: true }, at: number): boolean {
    if (current !== null) return false;
    if (notBefore !== null && at < notBefore) return false;
    const ranAt = read.row?.ranAt ?? null;
    if (ranAt === null) return true;
    return Date.parse(ranAt) < dayStart(new Date(at)).getTime();
  }

  return {
    async start(): Promise<void> {
      const at = deps.clock().toISOString();
      const row = await startLearning(deps.db, WORK_LESSONS, at);
      log({ event: 'lessons_state', since: row.since, last_ran: row.ranAt, judged: row.examined, lessons: row.added, given_up: row.retired, failed: row.failed });
    },
    async tick(): Promise<void> {
      try {
        if (stopped) return;
        const at = now();
        if (at === null) return;   // a tick whose clock cannot be read does nothing
        const read = await readRow(deps.db, rowWait);
        checkStale(read, at);
        if (!read.ok) {
          log({ event: 'lessons_failed', reason: read.reason });
          return;
        }
        if (stopped || !due(read, at)) return;
        current = startRun(at);
      } catch {
        // a tick never rejects
      }
    },
    async idle(): Promise<void> {
      while (current !== null) await current;
    },
    stop(): void {
      stopped = true;
    },
  };
}
