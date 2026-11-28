// A night's run of the judge (7.2, 7.3, 12, calls 2, 6 to 17): the night's rules (`runNight`, src/memory/night.ts) run over
// a store that is the database: it finds the replies to judge by what is stored, and writes each verdict, its cost and
// its lesson in one transaction. This file keeps what is the service's own: the stop before a run begins, the log line,
// the learning row and the nightly timer. Logs hold counts, a cost and short codes: never a reply's words, a finding, a
// lesson's text, a quote, a path or a login.
import { addToLearning, noteLearning, readLearning, startLearning } from '../db/learning.ts';
import type { LearningState } from '../db/learning.ts';
import { addRecords, standingLessons } from '../db/memory-records.ts';
import type { NewRecord, RepoKey } from '../db/memory-records.ts';
import { lessonsMadeSince, laterVerdict, noteVerdict, repliesToJudge } from '../db/reply-verdicts.ts';
import { recordJudgeCall } from '../db/review-runs.ts';
import type { Db } from '../db/types.ts';
import type { ModelClient } from '../engine/types.ts';
import { askJudge, findingBody } from '../memory/judge.ts';
import { runNight } from '../memory/night.ts';
import type { Judged, NightDeps, NightLesson, NightStore } from '../memory/night.ts';
import { dayStart } from '../memory/select.ts';
import type { Alert } from './alerts.ts';
import { codeOf } from './codes.ts';
import { STALE_AFTER_MS } from './learning.ts';

export { JUDGE_ATTEMPTS, JUDGE_FAILURES, JUDGE_REPLIES, JUDGE_STRANGERS, LESSONS_PER_RUN } from '../memory/night.ts';
export type { Judged, RunEnd } from '../memory/night.ts';

export const WORK_LESSONS = 'lessons';     // the row of the learning table this work writes
export const NIGHT_RETRY_MS = 3_600_000;   // how long after a run that did not complete the next is tried
export const ROW_WAIT_MS = 5_000;          // how long a tick waits for its read of the row

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

// The record of a lesson the night made (rule 9), as the memory table keeps it.
const lessonRow = (l: NightLesson): NewRecord => ({
  kind: 'lesson', sourceRef: l.sourceRef, number: l.number,
  path: l.path, directory: l.directory, category: null, reason: null, missed: false,
  excerpt: l.quote, comment: l.reply, lesson: l.text,
  createdAt: l.createdAt, expiresAt: l.expiresAt,
});

// The night's store over the database. A verdict with no call is one statement; one with a call is one transaction of
// the call, the verdict and its lesson, in that order.
function databaseStore(db: Db): NightStore {
  return {
    replies: async (since, before, limit, maxAttempts) => (await repliesToJudge(db, since, before, limit, maxAttempts)).map((r) => ({
      ref: r.ref, reply: r.reply, association: r.association, body: r.body, at: r.at,
      finding: r.finding, path: r.path, side: r.side, line: r.line, severity: r.severity,
      findingText: findingBody({ path: r.path, side: r.side, line: r.line, severity: r.severity, quote: r.quote }, r.findings),
      attempts: r.attempts,
    })),
    lessonsMadeSince: (since) => lessonsMadeSince(db, since),
    laterVerdict: (ref, finding, after) => laterVerdict(db, ref, finding, after),
    standingLessons: (repo, at, limit) => standingLessons(db, repo, at, limit),
    noteVerdict: async (v, call, lesson) => {
      if (call === null && lesson === null) {
        await noteVerdict(db, v);
        return;
      }
      const repo: RepoKey = { service: v.ref.service, owner: v.ref.owner, repo: v.ref.repo };
      await db.transaction(async (tx) => {
        if (call !== null) await recordJudgeCall(tx, v.ref, v.reply, v.judgedAt, call);
        await noteVerdict(tx, v);
        if (lesson !== null) await addRecords(tx, repo, [lessonRow(lesson)]);
      });
    },
    noteCall: (ref, reply, at, usage) => recordJudgeCall(db, ref, reply, at, usage),
  };
}

async function runOnce(deps: Deps, log: Log): Promise<Judged> {
  const { db } = deps;
  const stopping = (): boolean => {
    try {
      return deps.stopping?.() === true;
    } catch {
      return true;   // a stop that cannot be read is a stop
    }
  };
  const now = (): string => deps.clock().toISOString();
  const finish = (out: Judged): Judged => {
    log({ event: 'lessons', judged: out.judged, lessons: out.lessons, given_up: out.givenUp, failed: out.failed, calls: out.calls, cost: out.cost, more: out.more, end: out.end });
    return out;
  };
  // A run stopped before it began reads nothing.
  if (stopping()) {
    return finish({ judged: 0, lessons: 0, givenUp: 0, failed: 0, calls: 0, cost: 0, more: false, end: 'stopped', complete: false });
  }

  // Rules 1 to 11: the night.
  const night: NightDeps = {
    clock: deps.clock,
    ask: (_reply, input, stopped) => askJudge(deps.model, input, deps.token(), deps.auto, deps.timeoutMs, stopped),
    paused: deps.paused,
    ...(deps.noteUsage === undefined ? {} : { noteUsage: deps.noteUsage }),
    ...(deps.stopping === undefined ? {} : { stopping: deps.stopping }),
    ...(deps.replies === undefined ? {} : { replies: deps.replies }),
  };
  const out = await runNight(databaseStore(db), night);

  // Rule 11: the learning row.
  const counts = { examined: out.judged, added: out.lessons, retired: out.givenUp, failed: out.failed };
  if (out.complete) await noteLearning(db, WORK_LESSONS, now(), counts);
  else if (out.end !== 'stopped') await addToLearning(db, WORK_LESSONS, now(), counts);
  return finish(out);
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
    const today = dayStart(new Date(at)).getTime();
    // A run of this process that completed today is one, whatever an older read of the row says.
    if (lastCompleted !== null && lastCompleted >= today) return false;
    const ranAt = read.row?.ranAt ?? null;
    if (ranAt === null) return true;
    return Date.parse(ranAt) < today;
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
        if (stopped) return;   // a tick that began before the stop does nothing after it
        checkStale(read, at);
        if (!read.ok) {
          log({ event: 'lessons_failed', reason: read.reason });
          return;
        }
        if (!due(read, at)) return;
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
