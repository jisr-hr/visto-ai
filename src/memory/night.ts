// The rules of a night's run of the judge (7.2, 7.3, 12, calls 2, 6 to 17; call 2 of the evals with lessons): it takes
// the replies to judge from a store, judges one reply at a time, hands each verdict, its cost and its lesson to the store
// as one unit, stops at the cap of lessons, at a stop, while reviews are paused and after failures at the provider, and
// says how the run ended. Pure but for the store and the judge it is handed: the service runs it over its database and
// the eval over a file, so the two cannot disagree. It logs nothing.
import { stripControl } from '../engine/context/untrusted.ts';
import type { Usage } from '../engine/types.ts';
import type { Association, PullRequestRef, Side } from '../forge/types.ts';
import { lessonOf, restates } from './judge.ts';
import type { Asked, Classification, JudgeInput, Outcome } from './judge.ts';
import { LESSON_DAYS, LESSONS_READ } from './lessons.ts';
import { dayStart } from './select.ts';
import { directoryOf, ownWords } from './signals.ts';

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
  more: boolean;       // the run ended with replies it did not finish: the queue held more than it took, strangers were left over, or a reply it took got no verdict
  end: RunEnd; complete: boolean;   // complete: the end is done or lesson_cap
}

/** A reply to judge, as a store hands it over. */
export interface NightReply {
  ref: PullRequestRef; reply: string;                    // the reply's comment id
  association: Association | null; body: string; at: string;
  finding: string;                                       // the id of the finding's posted comment
  path: string; side: Side; line: number | null; severity: string;   // of that posted comment
  findingText: string | null;                            // the shell's store: findingBody over the stored findings; the eval's: the export's `finding`
  attempts: number;
}
/** A lesson as the night makes it: live from createdAt until expiresAt. */
export interface NightLesson { sourceRef: string; number: number; path: string; directory: string; quote: string; reply: string; text: string; createdAt: string; expiresAt: string }
export interface NightVerdict { ref: PullRequestRef; reply: string; finding: string; classification: Classification | null; outcome: Outcome; attempts: number; judgedAt: string }

/** What a night reads and writes. The service's store is its database; the eval's is a file. */
export interface NightStore {
  /** The replies written at or after `since` and before `before` with no classification and fewer than `maxAttempts` attempts: those of people with access first, then the oldest; at most `limit`. */
  replies(since: string, before: string, limit: number, maxAttempts: number): Promise<NightReply[]>;
  /** How many verdicts with the outcome `lesson` were judged at or after `since`. */
  lessonsMadeSince(since: string): Promise<number>;
  /** The verdict a later review kept for the thread whose first comment is `finding`; null when none kept one. */
  laterVerdict(ref: PullRequestRef, finding: string, after: string): Promise<string | null>;
  /** The texts of the repository's lessons that stand at `at`, newest first, at most `limit`. */
  standingLessons(repo: { service: 'github'; owner: string; repo: string }, at: string, limit: number): Promise<string[]>;
  /** The verdict, the call's usage (null: no call) and the lesson (null: none), as one unit. */
  noteVerdict(v: NightVerdict, call: Usage | null, lesson: NightLesson | null): Promise<void>;
  /** The usage of a call that failed at the provider. */
  noteCall(ref: PullRequestRef, reply: string, at: string, usage: Usage): Promise<void>;
}

export interface NightDeps {
  clock: () => Date;
  /** The judge of one reply. stopped: asked before its second request. */
  ask: (reply: NightReply, input: JudgeInput, stopped: () => boolean) => Promise<Asked>;
  /** Why reviews do not start now, as a short code; null when they do. Asked before every call. */
  paused: () => Promise<string | null>;
  /** Told the usage of every answered call, as the spend guard is told a run's. */
  noteUsage?: (usage: { inputTokens: number; outputTokens: number; cost: number }) => void;
  stopping?: () => boolean; replies?: number;   // replies: for tests; absent: JUDGE_REPLIES
}

const DAY_MS = 86_400_000;
const WITH_ACCESS: ReadonlySet<unknown> = new Set(['owner', 'member', 'collaborator']);

const repoOf = (r: NightReply): { service: 'github'; owner: string; repo: string } => ({ service: r.ref.service, owner: r.ref.owner, repo: r.ref.repo });

// The record of a lesson (rule 9): live from the 00:00 UTC that follows the reply, for LESSON_DAYS days.
function lessonRecord(r: NightReply, text: string, quote: string): NightLesson {
  const created = dayStart(new Date(r.at)).getTime() + DAY_MS;
  return {
    sourceRef: `${r.ref.number}:${r.reply}`, number: r.ref.number,
    path: r.path, directory: directoryOf(r.path),
    quote, reply: r.reply, text,
    createdAt: new Date(created).toISOString(), expiresAt: new Date(created + LESSON_DAYS * DAY_MS).toISOString(),
  };
}

const runUsage = (u: Usage): Usage => ({ calls: u.calls, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedTokens: u.cachedTokens, cost: u.cost });
const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);

/** One night, from its day to its end. Rejects when the store does; what the store kept before stays. */
export async function runNight(store: NightStore, deps: NightDeps): Promise<Judged> {
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
  const queue = await store.replies(since, day.toISOString(), size + 1, JUDGE_ATTEMPTS);
  out.more = queue.length > size;
  const taken: NightReply[] = [];
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
  let made = await store.lessonsMadeSince(day.toISOString());
  let inRow = 0;
  let worked = 0;   // taken replies whose verdict was written
  let end: RunEnd | null = made >= LESSONS_PER_RUN ? 'lesson_cap' : null;

  for (const r of end === null ? taken : []) {
    // Rule 3.
    if (stopping()) { end = 'stopped'; break; }
    const why = await deps.paused();
    if (why !== null) { end = why === 'spend_limit' ? 'spend_limit' : 'model_error'; break; }

    // Rule 4: a reply with no call.
    if (stripControl(ownWords(r.body)).text.trim() === '') {
      await store.noteVerdict({ ref: r.ref, reply: r.reply, finding: r.finding, classification: 'noise', outcome: 'no_own_words', attempts: r.attempts, judgedAt: now() }, null, null);
      out.judged += 1;
      worked += 1;
      continue;
    }
    const finding = r.findingText;
    if (finding === null) {
      await store.noteVerdict({ ref: r.ref, reply: r.reply, finding: r.finding, classification: null, outcome: 'finding_unknown', attempts: JUDGE_ATTEMPTS, judgedAt: now() }, null, null);
      out.givenUp += 1;
      worked += 1;
      continue;
    }

    // Rule 5: the call.
    const asked = await deps.ask(r, { path: r.path, severity: r.severity, finding, reply: r.body }, stopping);
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
      if (answered) await store.noteCall(r.ref, r.reply, now(), runUsage(asked.usage));
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
      await store.noteVerdict({ ref: r.ref, reply: r.reply, finding: r.finding, classification: null, outcome: 'unjudged', attempts, judgedAt: at }, runUsage(asked.usage), null);
      out.failed += 1;
      worked += 1;
      if (attempts >= JUDGE_ATTEMPTS) out.givenUp += 1;
      continue;
    }

    // Rule 8: a verdict.
    const result = lessonOf(asked.value, { body: r.body, association: r.association }, r.path);
    let outcome: Outcome = result.outcome;
    if (result.outcome === 'lesson') {
      const later = await store.laterVerdict(r.ref, r.finding, r.at);
      if (later === 'open' || later === 'fixed') outcome = 'review_disagreed';
      else if (restates(result.text, await store.standingLessons(repoOf(r), at, LESSONS_READ))) outcome = 'restates';
    }
    await store.noteVerdict(
      { ref: r.ref, reply: r.reply, finding: r.finding, classification: asked.value.classification, outcome, attempts: r.attempts, judgedAt: at },
      runUsage(asked.usage),
      outcome === 'lesson' && result.outcome === 'lesson' ? lessonRecord(r, result.text, result.quote) : null);
    out.judged += 1;
    worked += 1;
    if (outcome === 'lesson') {
      out.lessons += 1;
      made += 1;
      if (made >= LESSONS_PER_RUN) { end = 'lesson_cap'; break; }
    }
  }

  // Rule 11: the end. A stop found here too sends nothing more.
  if (worked < taken.length) out.more = true;
  out.end = end !== 'stopped' && stopping() ? 'stopped' : end ?? 'done';
  out.complete = out.end === 'done' || out.end === 'lesson_cap';
  return out;
}
