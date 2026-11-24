import { drawnForAudit } from '../approval/audit.ts';
import { approvalOf } from '../config/load.ts';
import type { RepoSettings } from '../config/load.ts';
import { hasStandingApproval, markDismissed, newestWasApproval } from '../db/approvals.ts';
import { askWithdraw, enqueueJob, finishJob, requeueJob } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import { recordBlockScores, reusableScores } from '../db/block-scores.ts';
import { getPullRequest } from '../db/pull-requests.ts';
import { listComments, NOTE, recordComments } from '../db/review-comments.ts';
import type { StoredComment } from '../db/review-comments.ts';
import { adoptableRun, claimNotice, hasOkRun, hasRun, listRuns, markPublished, markPublishTried, recordRun, unpublishedRun } from '../db/review-runs.ts';
import type { RunRecord, StoredRun } from '../db/review-runs.ts';
import type { Db } from '../db/types.ts';
import { FROM_FORK, ORIGIN_UNKNOWN } from '../engine/context/extensions.ts';
import { renderReview } from '../engine/render/body.ts';
import type { InlineComment } from '../engine/render/body.ts';
import { renderNotes } from '../engine/render/notes.ts';
import type { Category, ScoredBy, Span } from '../engine/score/types.ts';
import type { EarlierState, LessonsStatus, Limits, Memory, MemoryState, ReviewDeps, ReviewInput, ReviewResult, ThreadVerdict, Usage } from '../engine/types.ts';
import type {
  ForgeAccess, ForgeApprovals, ForgeWriter, LivePullRequest, OwnReviewState, PullRequestInfo, PullRequestRef, ReviewThread, Source,
} from '../forge/types.ts';
import type { ReviewNotice } from '../extensions/types.ts';
import { PAUSE_MS } from './model-health.ts';
import type { ModelHealth } from './model-health.ts';
import { codeOf, isShortCode } from './codes.ts';
import type { ExtensionHealth } from './extension-health.ts';
import type { McpHealth } from './mcp-health.ts';
import type { MemoryHealth } from './memory-health.ts';
import { sendNotice } from './notify.ts';
import type { Notifier } from './notify.ts';
import { failureText, mayCommand, refusalText } from './commands.ts';
import { earlierOf, missedComments } from './earlier.ts';
import { matchPosted, notedOf } from './posted.ts';
import { publishRun } from './publish.ts';
import type { ApprovalContext, PublishOutcome } from './publish.ts';
import { acceptanceOf, CATEGORY_NAMES, historyOf, lastReviewOf, scoresToStore } from './history.ts';
import { followUp, planFollowUp } from './thread-followup.ts';
import { QUIET_SECONDS, skipReason } from './triggers.ts';
import { gatingOf, reviewedOnRequest } from '../gate/gating.ts';

export const RECORD_WAITS_MS = [1_000, 5_000];
/** The wait before a job the git service failed is tried again: after its first start, then after its second or third. */
export const RETRY_WAITS_MS = [60_000, 900_000];
/** The wait after a publication that failed, and how old a recorded review must be before a later start posts it. */
export const PUBLISH_WAIT_MS = 900_000;
/** How old a stored, unpublished review may be and still be published by a later start of its job. */
export const STORED_REVIEW_MS = 24 * 3_600_000;
/** How many days back a score another pull request stored may be reused. */
export const REUSE_DAYS = 30;

type Log = (entry: Record<string, unknown>) => void;

export interface ReviewJobDeps {
  db: Db; forge: ForgeAccess; clock: () => Date; log: (entry: Record<string, unknown>) => void;
  sleep: (ms: number) => Promise<void>;
  settingsFor: (fullName: string) => RepoSettings;
  limits: Limits;
  dryRun: boolean;
  /** The only way the job writes to the git service; never called in dry run. */
  writer: ForgeWriter;
  /** The engine's dependencies for one review, around the source it is given. */
  engineDeps: (source: Source) => ReviewDeps;
  /** The engine's entry point. */
  review: (input: ReviewInput, deps: ReviewDeps) => Promise<ReviewResult>;
  lineUrl: (pr: PullRequestInfo, file: { path: string; previousPath: string | null }, span: Span) => string;
  /** A link to one review comment of the pull request. */
  commentUrl: (ref: PullRequestRef, commentId: string) => string;
  /** Whether the app may resolve a review thread. */
  canResolve: () => Promise<boolean>;
  health: Pick<ModelHealth, 'reviewed'>;
  spend: { noteRun(usage: Usage): void };
  /** Where a published review is told to; absent in dry run and when no module has a notifier. */
  notice?: {
    notifiers: Notifier[];
    reviewUrl: (ref: PullRequestRef, reviewId: string) => string;
    pullRequestUrl: (ref: PullRequestRef) => string;
    /** For tests; passed on to sendNotice, whose own default is 10 seconds. */
    timeoutMs?: number;
    /** For tests; absent: sendNotice. */
    send?: typeof sendNotice;
  };
  /** Told how each module did; absent when the deployment has none. */
  extensionHealth?: Pick<ExtensionHealth, 'noted'>;
  /** Told how each MCP server did; absent when the deployment names none. */
  mcpHealth?: Pick<McpHealth, 'noted'>;
  /** The memory of a pull request's repository, for a review of it; absent when learning is off. */
  memoryFor?: (ref: PullRequestRef) => Memory;
  /** Told how memory did in each review; absent when learning is off. */
  memoryHealth?: Pick<MemoryHealth, 'noted'>;
  /** The base branch's rule on stale approvals, for the decision at publish; absent: it cannot be read, and nothing is approved. */
  approvals?: ForgeApprovals;
  /** Called after a withdraw job was stored, so that its runner starts it at once. */
  onWithdraw?: () => void;
  /** The deployment's audit key; absent: a share above 0 draws every pull request. Never logged, stored or posted. */
  auditKey?: string;
}

/** The newest published run of these, or null. */
function newestPublished(runs: StoredRun[]): StoredRun | null {
  let newest: StoredRun | null = null;
  for (const r of runs) if (r.published && (newest === null || r.id > newest.id)) newest = r;
  return newest;
}

/** The review ids of the published runs. */
function knownOf(runs: StoredRun[]): Set<string> {
  return new Set(runs.filter((r) => r.published && r.reviewId !== null).map((r) => r.reviewId!));
}

const NO_USAGE: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };

/** The number of findings of an engine result, or of a stored one; 0 when it has none that can be counted. */
function findingsOf(result: unknown): number {
  const findings = (result as { findings?: unknown } | null | undefined)?.findings;
  return Array.isArray(findings) ? findings.length : 0;
}

/** The thread verdicts an engine result, or a stored one, kept; none when it has none. */
function verdictsOf(result: unknown): ThreadVerdict[] {
  const verdicts = (result as { threadVerdicts?: unknown } | null | undefined)?.threadVerdicts;
  return Array.isArray(verdicts) ? verdicts as ThreadVerdict[] : [];
}

/** How many threads an engine result, or a stored one, owed a verdict; 0 when it does not say. */
function threadsDueOf(result: unknown): number {
  const due = (result as { threadsDue?: unknown } | null | undefined)?.threadsDue;
  return typeof due === 'number' && Number.isFinite(due) ? due : 0;
}

/** How many blocker and major findings an engine result, or a stored one, has on unchanged lines; null when it does not say. */
function blockingOnUnchangedOf(result: unknown): number | null {
  const count = (result as { blockingOnUnchanged?: unknown } | null | undefined)?.blockingOnUnchanged;
  return typeof count === 'number' && Number.isFinite(count) ? count : null;
}

/** Whether an engine result, or a stored one, says it had nothing new. */
function nothingNewOf(result: unknown): boolean {
  return (result as { nothingToDo?: unknown } | null | undefined)?.nothingToDo === true;
}

/** How many findings an engine result, or a stored one, dropped as already discussed; 0 when it does not say. */
function duplicatesOf(result: unknown): number {
  const discussed = (result as { alreadyDiscussed?: unknown } | null | undefined)?.alreadyDiscussed;
  return Array.isArray(discussed) ? discussed.length : 0;
}

/** How many of a run's recorded comments, as stored, are notes: the entries with a string `note`; 0 when they cannot be read. */
function notesOf(comments: unknown): number {
  if (!Array.isArray(comments)) return 0;
  return (comments as unknown[]).filter((c) => typeof c === 'object' && c !== null && typeof (c as { note?: unknown }).note === 'string').length;
}

/**
 * The providers' statuses of an engine result, or of a stored one: each entry whose name, status and code are short codes, as { status, code }.
 * null when the result has no such map or it is not one.
 */
function extensionsOf(result: unknown): Record<string, { status: string; code: string }> | null {
  const dependencies = (result as { dependencies?: unknown } | null | undefined)?.dependencies;
  const map = typeof dependencies === 'object' && dependencies !== null ? (dependencies as { extensions?: unknown }).extensions : undefined;
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return null;
  const out: Record<string, { status: string; code: string }> = {};
  for (const [name, entry] of Object.entries(map)) {
    if (!isShortCode(name) || typeof entry !== 'object' || entry === null) continue;
    const { status, code } = entry as { status?: unknown; code?: unknown };
    if (typeof status === 'string' && typeof code === 'string' && isShortCode(status) && isShortCode(code)) out[name] = { status, code };
  }
  return out;
}

/**
 * The MCP servers' statuses of an engine result, or of a stored one: each entry whose name and code are short codes, whose status is
 * ok, skipped or error, and whose count of calls is a whole number from 0 up, as { status, code, calls }. null when the result has no such
 * map or it is not one.
 */
function mcpOf(result: unknown): Record<string, { status: 'ok' | 'skipped' | 'error'; code: string; calls: number }> | null {
  const dependencies = (result as { dependencies?: unknown } | null | undefined)?.dependencies;
  const map = typeof dependencies === 'object' && dependencies !== null ? (dependencies as { mcp?: unknown }).mcp : undefined;
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return null;
  const out: Record<string, { status: 'ok' | 'skipped' | 'error'; code: string; calls: number }> = {};
  for (const [name, entry] of Object.entries(map)) {
    if (!isShortCode(name) || typeof entry !== 'object' || entry === null) continue;
    const { status, code, calls } = entry as { status?: unknown; code?: unknown; calls?: unknown };
    if (status !== 'ok' && status !== 'skipped' && status !== 'error') continue;
    if (typeof code !== 'string' || !isShortCode(code)) continue;
    if (typeof calls !== 'number' || !Number.isInteger(calls) || calls < 0) continue;
    out[name] = { status, code, calls };
  }
  return out;
}

const isMemoryState = (value: unknown): value is MemoryState => value === 'ok' || value === 'empty' || value === 'skipped' || value === 'error';

/** The lessons part of a stored memory status when it reads: a status, a short code and a count shown from 0 up; else undefined. */
function lessonsOf(entry: unknown): LessonsStatus | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
  const { status, code, shown } = entry as { status?: unknown; code?: unknown; shown?: unknown };
  if (!isMemoryState(status)) return undefined;
  if (typeof code !== 'string' || !isShortCode(code)) return undefined;
  if (typeof shown !== 'number' || !Number.isInteger(shown) || shown < 0) return undefined;
  return { status, code, shown };
}

/**
 * How memory did in an engine result, or in a stored one: its status when that is ok, empty, skipped or error, its code a short code
 * and its count of lines a whole number from 0 up, as { status, code, lines }, with `lessons` when that part reads too.
 * null when the result has no signals part, or one that cannot be read.
 */
function memoryOf(result: unknown): { status: MemoryState; code: string; lines: number; lessons?: LessonsStatus } | null {
  const dependencies = (result as { dependencies?: unknown } | null | undefined)?.dependencies;
  const entry = typeof dependencies === 'object' && dependencies !== null ? (dependencies as { memory?: unknown }).memory : undefined;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const { status, code, lines } = entry as { status?: unknown; code?: unknown; lines?: unknown };
  if (!isMemoryState(status)) return null;
  if (typeof code !== 'string' || !isShortCode(code)) return null;
  if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 0) return null;
  const lessons = lessonsOf((entry as { lessons?: unknown }).lessons);
  return lessons === undefined ? { status, code, lines } : { status, code, lines, lessons };
}

/** The findings of an engine result, or of a stored one, counted by severity; 0 each when they cannot be read. */
function severitiesOf(result: unknown): ReviewNotice['findings'] {
  const counts = { blocker: 0, major: 0, minor: 0 };
  const findings = (result as { findings?: unknown } | null | undefined)?.findings;
  if (!Array.isArray(findings)) return counts;
  for (const f of findings as unknown[]) {
    const severity = typeof f === 'object' && f !== null ? (f as { severity?: unknown }).severity : undefined;
    if (severity === 'blocker' || severity === 'major' || severity === 'minor') counts[severity] += 1;
  }
  return counts;
}

/**
 * Takes one claimed job to its end: drops it, puts it back, or reviews and records; not in dry run, then publishes.
 * A manual job is first checked, refused or accepted, and answered on the pull request once it is finished. Never rejects.
 */
export async function runReviewJob(job: Job, deps: ReviewJobDeps): Promise<void> {
  const { db } = deps;
  const repo = `${job.ref.owner}/${job.ref.repo}`;
  const manual = job.trigger === 'manual';
  const requestedBy = manual ? job.requestedBy : null;
  /** A re-run of the check: GitHub decided who may ask, and it has no comment. */
  const rerun = manual && (job.reason === 'rerun' || job.reason === 'rerun_retry');
  /** A /done: the gate job gave its comment the eyes. */
  const done = manual && (job.reason === 'done' || job.reason === 'done_retry');
  /** The reason of the job that starts this one over when the head moves; null for a job that started over already, and for a push's. */
  const retryReason = manual && (job.reason === 'command' || job.reason === 'done' || job.reason === 'rerun') ? `${job.reason}_retry` : null;
  const log: Log = (entry) => {
    try {
      deps.log(entry);
    } catch {
      // a logger that fails changes nothing
    }
  };
  /** Told after a withdraw job was stored; one that throws changes nothing, and the runner's timer starts the job. */
  const wake = (): void => {
    try {
      deps.onWithdraw?.();
    } catch {
      // a wake that fails changes nothing
    }
  };
  const now = deps.clock();
  const nowIso = now.toISOString();
  const at = (ms: number): string => new Date(now.getTime() + ms).toISOString();
  /** `ms` after the clock as it reads now; after the job's start when the clock fails. */
  const later = (ms: number): string => {
    let t = now;
    try {
      t = deps.clock();
    } catch {
      // a clock that fails leaves the start's time
    }
    return new Date(t.getTime() + ms).toISOString();
  };
  const retryWait = RETRY_WAITS_MS[job.starts <= 1 ? 0 : 1]!;

  /** Runs one write, up to three times, with the waits between. false when the third try failed too. */
  const tried = async (write: () => Promise<void>): Promise<boolean> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await write();
        return true;
      } catch {
        const wait = RECORD_WAITS_MS[attempt];
        if (wait === undefined) return false;
        try {
          await deps.sleep(wait);
        } catch {
          // a sleep that fails only shortens the wait
        }
      }
    }
  };

  const dropped = async (reason: string, write: () => Promise<void>): Promise<void> => {
    const done = await tried(write);
    log({ event: 'job', job: job.id, repo, number: job.ref.number, outcome: done ? 'dropped' : 'drop_failed', reason });
  };
  const drop = (reason: string): Promise<void> =>
    dropped(reason, async () => { await finishJob(db, job.id, 'dropped', reason, nowIso); });

  /** One write on the pull request, made once: never in dry run; one that cannot be made is logged and changes nothing. */
  const say = async (write: (commentId: string) => Promise<void>): Promise<void> => {
    if (deps.dryRun) return;
    // A job with no comment (a re-run) is given no reaction and no sentence.
    if (job.commentId === null) return;
    try {
      await write(job.commentId);
    } catch (error) {
      log({ event: 'answer_failed', job: job.id, reason: codeOf(error) });
    }
  };
  /** The answer to a command: a confused reaction on its comment, then one sentence. Only once the job is finished. */
  const answer = async (installation: string, text: string): Promise<void> => {
    await say((commentId) => deps.writer.react(job.ref, installation, commentId, 'confused'));
    await say(() => deps.writer.comment(job.ref, installation, text));
  };
  /** Finishes the job as refused, with `also` in the same transaction, then says so; nothing is said when it could not be finished. true when it was. */
  const refuse = async (installation: string, reason: string, also?: (tx: Db) => Promise<void>): Promise<boolean> => {
    let finished = false;
    const stored = await tried(() => db.transaction(async (tx) => {
      finished = await finishJob(tx, job.id, 'done', 'refused', nowIso);
      if (finished && also !== undefined) await also(tx);
    }));
    log({ event: 'job', job: job.id, repo, number: job.ref.number, outcome: stored ? 'refused' : 'refuse_failed', reason });
    if (stored && finished) await answer(installation, refusalText(job.requestedBy, reason));
    return stored;
  };
  /**
   * A manual job that ends without a published review while the pull request moved on starts over once, as a new job
   * for the live head, in the transaction of its end: a command that joined it is answered by a review of the new head.
   * Moved on: the stored row was updated after this job started and its head is not the one reviewed; a stored head
   * that is merely behind starts nothing. Not for a retry, and not when no row is stored. true when it started over:
   * the job then says nothing, and the retry's own end answers, as at a publication whose head moved.
   */
  const startOverIfMoved = async (tx: Db, reviewed: string): Promise<boolean> => {
    if (retryReason === null || reviewed === '') return false;
    const stored = await getPullRequest(tx, job.ref);
    if (stored === null || stored.headSha === reviewed || !(Date.parse(stored.updatedAt) > now.getTime())) return false;
    await enqueueJob(tx, { ref: job.ref, reason: retryReason, headSha: '', runAt: later(0), now: nowIso, delivery: null, replace: true,
      trigger: 'manual', requestedBy: job.requestedBy, commentId: job.commentId, association: job.association, installation: job.installation });
    return true;
  };
  /** Says that the command failed; the job has already been given its outcome. */
  const fail = (installation: string, code: string): Promise<void> =>
    manual ? answer(installation, failureText(job.requestedBy, code)) : Promise.resolve();

  /**
   * Stores the posted inline comments of a published run, each with the finding or the block it came from. Never rejects; changes nothing else.
   * `notesDropped`: the publication did not post the run's notes, or nothing is known of them; no note is then counted as missing.
   */
  const readBack = async (target: StoredRun, installation: string, reviewId: string, notesDropped: boolean): Promise<void> => {
    try {
      const posted = await deps.writer.listReviewComments(job.ref, installation, reviewId);
      if (posted === null) {
        log({ event: 'readback_failed', job: job.id, run: target.id, reason: 'cut_short' });
        return;
      }
      const matched = matchPosted(target, posted);
      await recordComments(db, target.id, job.ref, matched);
      const notes = matched.filter((m) => m.severity === NOTE).length;
      const missing = notesDropped ? 0 : Math.max(0, notesOf(target.comments) - notes);
      log({ event: 'readback', job: job.id, run: target.id, posted: posted.length, stored: matched.length, notes, notes_missing: missing });
    } catch (error) {
      log({ event: 'readback_failed', job: job.id, run: target.id, reason: codeOf(error) });
    }
  };

  /**
   * Writes the verdicts a published run kept into their threads. Only after the publication was recorded and the job finished;
   * never rejects, and nothing in it changes the job's outcome.
   */
  const threadFollowUp = async (target: StoredRun, installation: string, reviewId: string): Promise<void> => {
    try {
      const verdicts = verdictsOf(target.result);
      if (verdicts.length === 0) return;
      const threads = await deps.writer.listThreads(job.ref, installation);
      let canResolve = false;
      try {
        canResolve = await deps.canResolve();
      } catch {
        // a permission that cannot be read is read as not granted
      }
      const plan = planFollowUp({ verdicts, threads, reviewId, head: target.headSha, canResolve });
      const done = await followUp({ writer: deps.writer, sleep: deps.sleep, log }, { installation, actions: plan.actions });
      log({ event: 'thread_followup', job: job.id, run: target.id, review: reviewId, ...done, missing: plan.missing, changed: plan.changed });
    } catch (error) {
      log({ event: 'thread_followup_failed', job: job.id, reason: codeOf(error) });
    }
  };

  /**
   * Tells the notifiers of a run this job just marked as published: the notice is built, then the stamp is written, then they are called.
   * Never in dry run, never without notifiers. Never rejects, and nothing in it changes the job.
   */
  const tell = async (target: StoredRun, info: PullRequestInfo, reviewId: string, body: string): Promise<void> => {
    try {
      const notice = deps.notice;
      if (deps.dryRun || notice === undefined || notice.notifiers.length === 0) return;
      let built: ReviewNotice;
      try {
        built = {
          run: target.id, repository: repo, number: job.ref.number, title: info.title, author: info.author,
          headSha: target.headSha, mode: target.mode, trigger: target.trigger,
          reviewUrl: notice.reviewUrl(job.ref, reviewId), pullRequestUrl: notice.pullRequestUrl(job.ref),
          needsHuman: target.needsHuman, highestScore: target.highestScore, findings: severitiesOf(target.result), body,
        };
      } catch (error) {
        log({ event: 'notice_failed', job: job.id, run: target.id, reason: codeOf(error) });
        return;
      }
      // The stamp first, in its own statement: a stop after it loses the notice, and never doubles it.
      let claimed: boolean;
      try {
        claimed = await claimNotice(db, target.id, later(0));
      } catch (error) {
        log({ event: 'notice_failed', job: job.id, run: target.id, reason: codeOf(error) });
        return;
      }
      if (!claimed) {
        log({ event: 'notice', job: job.id, run: target.id, sent: false });
        return;
      }
      let outcomes: Awaited<ReturnType<typeof sendNotice>>;
      try {
        outcomes = await (notice.send ?? sendNotice)(notice.notifiers, built, notice.timeoutMs);
      } catch (error) {
        // sendNotice never rejects; the job does not depend on it
        log({ event: 'notice_failed', job: job.id, run: target.id, reason: codeOf(error) });
        return;
      }
      const results: Record<string, string> = {};
      for (const o of outcomes) results[o.name] = o.code;
      log({ event: 'notice', job: job.id, run: target.id, review: reviewId, sent: true, results });
      for (const o of outcomes) {
        try {
          deps.extensionHealth?.noted(o.name, 'notify', o.ok, o.code);
        } catch {
          // a health that fails changes nothing
        }
      }
    } catch {
      // nothing in a notice changes the job
    }
  };

  let result: ReviewResult | null = null;
  /** The mode of this review, decided once the live pull request and its last review are known; full until then, and in dry run. */
  let mode: RunRecord['mode'] = 'full';
  /** Who gives the block scores of this review. */
  let by: ScoredBy = 'model';
  /**
   * The mode, the first rule that applies: no last review; a command on the last review's head and base; another base branch; the repository's
   * setting; when it says nothing, full for a pull request that is reviewed only when asked (D4), else incremental.
   */
  const modeOf = (pr: LivePullRequest, lastReview: StoredRun | null): RunRecord['mode'] => {
    if (lastReview === null) return 'full';
    if (manual && lastReview.headSha === pr.info.headSha && lastReview.baseSha === pr.info.baseSha) return 'recheck';
    if (lastReview.baseBranch === null || lastReview.baseBranch !== pr.info.baseBranch) return 'full';
    const settings = deps.settingsFor(repo);
    return settings.newHead ?? (reviewedOnRequest(gatingOf(settings, pr.info.baseBranch)) ? 'full' : 'incremental');
  };
  /** Stores the scores a recorded run gave, for other pull requests; made once. One that cannot be stored is logged and changes nothing. */
  const keepScores = async (runId: number, finishedAt: string): Promise<void> => {
    try {
      await recordBlockScores(db, runId, job.ref, by, scoresToStore(result), finishedAt);
    } catch (error) {
      log({ event: 'scores_store_failed', job: job.id, run: runId, reason: codeOf(error) });
    }
  };
  try {
    // 1. The installation: the job's own, else the stored pull request's.
    const installation = job.installation ?? (await getPullRequest(db, job.ref))?.installation ?? null;
    if (installation === null) return await drop('no_installation');

    // 1b. Who asked; not for a re-run, where GitHub decided. A refused command may have stood in the way of a push's job: the stored head gets one, unless it has a run in this mode.
    if (manual && !rerun && !mayCommand(job.association)) {
      await refuse(installation, 'not_allowed', async (tx) => {
        const stored = await getPullRequest(tx, job.ref);
        if (stored === null || stored.state !== 'open') return;
        if (await hasRun(tx, job.ref, stored.headSha, deps.dryRun)) return;
        await enqueueJob(tx, { ref: job.ref, reason: 'opened', headSha: stored.headSha, runAt: nowIso, now: nowIso, delivery: null, replace: false,
          trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null });
      });
      return;
    }

    let resumed: StoredRun | null = null;
    /** The pull request's runs, as read out of dry run; empty in dry run. */
    let runs: StoredRun[] = [];
    /** The last review: the newest published run that is not a re-check; null in dry run. */
    let last: StoredRun | null = null;
    let earlier: EarlierState | null = null;
    /** The blocks of the pull request that have their note (noteKey); empty when the stored comments were not read. */
    let noted = new Set<string>();

    // 2. The live read.
    let live: LivePullRequest | null = null;
    let prepareError: unknown = null;
    try {
      live = await deps.forge.readPullRequest(job.ref, installation);
    } catch (error) {
      prepareError = error;
    }
    if (prepareError === null) {
      if (live === null) return await drop('not_found');

      // 3. The checks. A manual job reviews the live head of an open pull request, whatever the filters say.
      if (manual) {
        if (live.state !== 'open') {
          await refuse(installation, 'closed');
          return;
        }
      } else {
        const reason = skipReason({ state: live.state, draft: live.info.draft, author: live.info.author, baseBranch: live.info.baseBranch }, deps.settingsFor(repo));
        if (reason !== null) return await drop(reason);
      }
      if (!manual && live.info.headSha !== job.headSha) {
        const head = live.info.headSha;
        return await dropped('stale_head', () => db.transaction(async (tx) => {
          await enqueueJob(tx, { ref: job.ref, reason: job.reason, headSha: head, runAt: at(QUIET_SECONDS * 1000), now: nowIso, delivery: null, replace: false,
            trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null });
          await finishJob(tx, job.id, 'dropped', 'stale_head', nowIso);
        }));
      }
      if (deps.dryRun) {
        if (await hasOkRun(db, job.ref, live.info.headSha, live.info.baseSha, true)) return await drop('already_reviewed');
      } else {
        // The record. Already reviewed? Only a published review of this head and this base counts, whatever its mode; a command re-checks it.
        runs = await listRuns(db, job.ref);
        const newest = newestPublished(runs);
        const reviewed = newest !== null && newest.headSha === live.info.headSha && newest.baseSha === live.info.baseSha ? newest : null;
        if (reviewed !== null && !manual) return await drop('already_reviewed');
        last = lastReviewOf(runs);
        mode = modeOf(live, last);
        // A stored review? This start then publishes it: no engine, no render, no guard.
        resumed = await unpublishedRun(db, job.ref, live.info.headSha, live.info.baseSha, new Date(now.getTime() - STORED_REVIEW_MS).toISOString());
        // An older row of a head that has its review is a leftover of the review already posted, not one that waits.
        if (reviewed !== null && resumed !== null && resumed.id <= reviewed.id) resumed = null;
        // What the database may not know: a review of the app's own on the pull request that no published run has. Asked before anything is paid.
        if (resumed === null) {
          let own: Array<{ id: string; commit: string; state?: OwnReviewState }> | null = null;
          try {
            own = await deps.writer.listOwnReviews(job.ref, installation);
          } catch (error) {
            prepareError = error;
          }
          if (own !== null) {
            const known = knownOf(runs);
            const unknown = own.filter((r) => !known.has(r.id));
            const head = live.info.headSha;
            if (unknown.some((r) => r.commit === head)) {
              if (manual) {
                await refuse(installation, 'already_reviewed');
                return;
              }
              return await drop('already_reviewed');
            }
            let adopted = false;
            // The list is newest first: each other one is looked at oldest first.
            for (const review of [...unknown].reverse()) {
              const found = await adoptableRun(db, job.ref, review.commit);
              if (found === null) {
                log({ event: 'unknown_review', job: job.id, review: review.id });
                continue;
              }
              // Recorded as posted with its inline comments: the read-back stores what it finds. GitHub holds it as an approval, or one
              // dismissed since (only an approval can be dismissed here): an approval, with no decision of this job's.
              const approved = review.state === 'approved' || review.state === 'dismissed';
              await markPublished(db, found.id, { reviewId: review.id, publishedAt: nowIso, body: found.body, inlineDropped: false, approved });
              // Dismissed: by the git service. Still held: it is at another commit than the live head, and its withdrawal is asked for.
              if (review.state === 'dismissed') await markDismissed(db, found.id, nowIso, 'git_service');
              else if (approved && (await askWithdraw(db, job.ref, nowIso, installation)) !== null) wake();
              adopted = true;
              log({ event: 'adopted_late', job: job.id, run: found.id, review: review.id });
              // Nothing is known of the notes it was posted with: none is counted as missing.
              await readBack(found, installation, review.id, true);
              // Told now, before the live head is reviewed: a failure later in the job cannot lose it.
              await tell(found, live.info, review.id, found.body);
            }
            if (adopted) {
              runs = await listRuns(db, job.ref);
              last = lastReviewOf(runs);
              mode = modeOf(live, last);
            }
          }
          // The earlier state: the last review and its threads, read before anything is paid.
          if (prepareError === null && last !== null) {
            let threads: ReviewThread[] | null = null;
            try {
              threads = await deps.writer.listThreads(job.ref, installation);
            } catch (error) {
              prepareError = error;
            }
            if (threads !== null) {
              let stored = await listComments(db, job.ref);
              const read = stored;
              /** What the threads show that the database did not hold, whether or not recording it succeeded. */
              let missed: Array<StoredComment & { run: number }> = [];
              try {
                missed = missedComments({ runs, stored, threads });
                const byRun = new Map<number, StoredComment[]>();
                for (const m of missed) byRun.set(m.run, [...(byRun.get(m.run) ?? []), m]);
                for (const [runId, comments] of byRun) await recordComments(db, runId, job.ref, comments);
                stored = [...stored, ...missed];
              } catch (error) {
                log({ event: 'repair_failed', job: job.id, reason: codeOf(error) });
              }
              noted = notedOf([...read, ...missed]);
              // Under the gate with clearing by reply off, a person's reply settles nothing (5.2): the thread is judged again.
              const settings = deps.settingsFor(repo);
              const replySettles = !(reviewedOnRequest(gatingOf(settings, live.info.baseBranch)) && !settings.gate.clearByReply);
              // With approval on, a thread is settled only when the thread rule in force closes it too (call 7).
              const approval = approvalOf(settings);
              earlier = approval.enabled
                ? earlierOf({ last, runs, stored, threads, replySettles, approval: { rule: approval.threads, author: live.info.author, clearByReply: settings.gate.clearByReply } })
                : earlierOf({ last, runs, stored, threads, replySettles });
            }
          }
        }
      }
    }

    // A command that will be honoured: only now its comment gets its eyes; a /done's were given by the gate job.
    if (manual && !done && prepareError === null) await say((commentId) => deps.writer.react(job.ref, installation, commentId, 'eyes'));

    // 4. The review.
    let failure: { stage: string; code: string } | null = null;
    if (prepareError !== null) {
      failure = { stage: 'prepare', code: codeOf(prepareError) };
    } else if (resumed === null) {
      const pr = live!;
      let source: Source | null = null;
      try {
        source = await deps.forge.sourceFor(installation);
      } catch (error) {
        failure = { stage: 'prepare', code: codeOf(error) };
      }
      if (source !== null) {
        const settings = deps.settingsFor(repo);
        try {
          const input: ReviewInput = {
            pullRequest: pr.info, trigger: job.trigger,
            repoConfig: { primaryBranches: settings.primaryBranches, scoreThreshold: settings.scoreThreshold },
            limits: deps.limits, asOf: now, earlier,
          };
          // With learning on, the review is given its repository's memory, in dry run too; with it off the object is what it was.
          const engine = deps.memoryFor === undefined ? deps.engineDeps(source) : { ...deps.engineDeps(source), memory: deps.memoryFor(job.ref) };
          if (deps.dryRun) {
            result = await deps.review(input, engine);
          } else {
            by = engine.scorer !== undefined ? 'scorer' : 'model';
            const scoredBy = by;
            const since = new Date(now.getTime() - REUSE_DAYS * 86_400_000).toISOString();
            result = await deps.review({ ...input, mode, history: historyOf({ runs, last, by: scoredBy }), earlierAcceptance: acceptanceOf(runs) }, {
              ...engine,
              reusableScores: async (blocks) => (await reusableScores(db, job.ref, scoredBy, blocks, since)).map((row) => ({
                path: row.path, hash: row.hash, around: row.around,
                entry: { score: row.score, category: (CATEGORY_NAMES.includes(row.category) ? row.category : 'other') as Category, reason: row.reason },
              })),
            });
          }
        } catch {
          failure = { stage: 'engine', code: 'internal_error' };
        }
      }
    }

    // 5 and 6. What would be posted, and telling the guards.
    let body = '';
    let comments: InlineComment[] = [];
    let refused: 'auth' | 'no_credit' | null = null;
    if (result !== null) {
      const info = live!.info;
      try {
        ({ body, comments } = renderReview(result, {
          trigger: job.trigger, requestedBy, lineUrl: (file, span) => deps.lineUrl(info, file, span), inline: true,
          commentUrl: (id) => deps.commentUrl(job.ref, id),
        }));
      } catch {
        log({ event: 'render_failed', job: job.id, repo, number: job.ref.number });
      }
      // The notes: after the findings' comments, which the read-back takes the first entries for.
      if (body !== '' && result.status === 'ok' && deps.settingsFor(repo).inlineNotes) {
        try {
          comments = [...comments, ...renderNotes(result, noted)];
        } catch {
          // Notes that cannot be rendered are none: the review goes without them.
          log({ event: 'notes_failed', job: job.id });
        }
      }
      try {
        deps.spend.noteRun(result.usage);
      } catch {
        // a guard that fails changes nothing
      }
      const code = result.failure?.code;
      if (code === 'auth' || code === 'no_credit') refused = code;
      try {
        if (refused !== null) deps.health.reviewed(refused, deps.clock());
        else if (result.usage.calls >= 1 && result.dependencies.model === 'ok') deps.health.reviewed(null, deps.clock());
      } catch {
        // a guard that fails changes nothing
      }
      // How each provider did; in dry run too. A provider the engine did not ask, for the pull request's origin, did nothing.
      for (const [name, status] of Object.entries(extensionsOf(result) ?? {})) {
        if (status.status === 'skipped' && (status.code === FROM_FORK || status.code === ORIGIN_UNKNOWN)) continue;
        try {
          deps.extensionHealth?.noted(name, 'context', status.status !== 'error', status.code);
        } catch {
          // a health that fails changes nothing
        }
      }
      // How each MCP server did; in dry run too. A server the engine skipped, for whatever reason, did nothing.
      for (const [name, status] of Object.entries(mcpOf(result) ?? {})) {
        if (status.status === 'skipped') continue;
        try {
          deps.mcpHealth?.noted(name, status.status === 'ok', status.code);
        } catch {
          // a health that fails changes nothing
        }
      }
      // How memory did, once for the review and in dry run too: the signals part first, then the lessons part. An error of
      // either is a failure; else a part that was asked is a success; a part the engine skipped did nothing.
      const memory = memoryOf(result);
      const parts = memory === null ? [] : memory.lessons === undefined ? [memory] : [memory, memory.lessons];
      const failed = parts.find((part) => part.status === 'error');
      const asked = parts.find((part) => part.status === 'ok' || part.status === 'empty');
      const told = failed ?? asked;
      if (told !== undefined) {
        try {
          const out: unknown = deps.memoryHealth?.noted(failed === undefined, told.code);
          // A health that returns a rejected promise changes nothing either.
          if (typeof out === 'object' && out !== null) Promise.resolve(out).catch(() => {});
        } catch {
          // a health that fails changes nothing
        }
      }
    }

    // 7. The record.
    const usage = result === null ? NO_USAGE : result.usage;
    const run: RunRecord = resumed ?? (result === null
      ? {
        ref: job.ref, job: job.id, trigger: job.trigger, mode, dryRun: deps.dryRun, headSha: live?.info.headSha ?? job.headSha, baseSha: null,
        baseBranch: live?.info.baseBranch ?? null,
        outcome: 'failed', failureStage: failure!.stage, failureCode: failure!.code, needsHuman: true, highestScore: 100,
        body: '', comments: [], result: {}, usage: NO_USAGE, startedAt: nowIso, finishedAt: deps.clock().toISOString(),
      }
      : {
        ref: job.ref, job: job.id, trigger: job.trigger, mode: result.mode, dryRun: deps.dryRun,
        headSha: live!.info.headSha, baseSha: live!.info.baseSha, baseBranch: live!.info.baseBranch,
        outcome: result.status, failureStage: result.failure?.stage ?? null, failureCode: result.failure?.code ?? null,
        needsHuman: result.verdict.needsHuman, highestScore: result.verdict.highest,
        body, comments, result, usage: result.usage, startedAt: nowIso, finishedAt: deps.clock().toISOString(),
      });

    const gitFailed = failure?.stage === 'prepare'
      || (result?.failure?.stage === 'context' && result.failure.code.startsWith('github_') && result.usage.calls === 0);
    const putBack = refused !== null
      ? { runAt: later(PAUSE_MS), giveBackStart: usage.calls === 0 }
      : gitFailed ? { runAt: later(retryWait), giveBackStart: false } : null;

    let written: boolean;
    let requeued = false;
    /** The job was ended as nothing new by this start. */
    let endedNothingNew = false;
    /** The read of the newest published review failed: the review is posted, and decided as a record that could not be read. */
    let newestUnread = false;
    /**
     * With approval on, whether a push that tells nothing new is posted all the same: the newest published review was an approval,
     * dismissed since or not, and the new head needs its own (call 12). A read that fails posts it too, never as an approval.
     */
    const afterApproval = async (): Promise<boolean> => {
      if (!approvalOf(deps.settingsFor(repo)).enabled) return false;
      try {
        return await newestWasApproval(db, job.ref);
      } catch {
        newestUnread = true;
        return true;
      }
    };
    /** The recorded run to publish; only ever set when not in dry run. */
    let toPublish: StoredRun | null = resumed;
    if (resumed !== null) {
      written = true;
    } else if (putBack !== null) {
      written = await tried(async () => { await recordRun(db, run); });
      if (written) {
        written = await tried(async () => { requeued = (await requeueJob(db, job.id, putBack.runAt, nowIso, putBack.giveBackStart)) === 'requeued'; });
        // Another job was waiting: this one was dropped as superseded.
        if (written && !requeued) await fail(installation, 'superseded');
      }
    } else if (deps.dryRun || run.outcome !== 'ok') {
      const ended = run.outcome === 'ok' ? 'reviewed' : 'failed';
      let startedOver = false;
      written = await tried(() => db.transaction(async (tx) => {
        // Each try starts afresh: a retry stored by a try that was rolled back is no job.
        startedOver = false;
        if (await finishJob(tx, job.id, 'done', ended, nowIso)) {
          await recordRun(tx, run);
          if (ended === 'failed') startedOver = await startOverIfMoved(tx, run.headSha);
        }
      }));
      if (written && ended === 'failed' && !startedOver) await fail(installation, 'review_failed');
    } else if (!manual && nothingNewOf(result) && !(await afterApproval())) {
      // Nothing new: no review is posted. The run is kept with no body, so that no later start takes it for a review waiting to be published.
      let runId: number | null = null;
      written = await tried(() => db.transaction(async (tx) => {
        // Each try starts afresh: an id from a try that was rolled back is no row's.
        runId = null;
        if (await finishJob(tx, job.id, 'done', 'nothing_new', nowIso)) runId = await recordRun(tx, { ...run, body: '', comments: [] });
      }));
      endedNothingNew = written && runId !== null;
      if (written && runId !== null) await keepScores(runId, run.finishedAt);
    } else if (run.body === '') {
      // A review whose text could not be rendered is never posted.
      let runId: number | null = null;
      let startedOver = false;
      written = await tried(() => db.transaction(async (tx) => {
        runId = null;
        startedOver = false;
        if (await finishJob(tx, job.id, 'done', 'render_failed', nowIso)) {
          runId = await recordRun(tx, run);
          startedOver = await startOverIfMoved(tx, run.headSha);
        }
      }));
      if (written) {
        if (runId !== null) await keepScores(runId, run.finishedAt);
        if (!startedOver) await fail(installation, 'render_failed');
      }
    } else {
      // Recorded alone: the job stays running until the publication is settled.
      let runId: number | null = null;
      written = await tried(async () => {
        const id = await recordRun(db, run);
        runId = id;
        toPublish = { ...run, id, published: false, reviewId: null, publishedAt: null, inlineDropped: false, publishTriedAt: null };
      });
      if (written && runId !== null) await keepScores(runId, run.finishedAt);
    }

    // 8. The publication. Once the review is recorded, only a publication that failed puts the job back.
    let publish: PublishOutcome | null = null;
    /** The notice of the run this job published, sent once the job's line is logged. */
    let toTell: { target: StoredRun; reviewId: string; body: string } | null = null;
    const target = toPublish;
    if (!deps.dryRun && written && target !== null) {
      // A review recorded by an earlier start is held for the wait after a failed publication, counted from the last start that set out
      // to post it: the git service may hold the review that start posted and not list it yet. The first start posts right after it records.
      const age = resumed === null ? Number.NaN : now.getTime() - Date.parse(resumed.publishTriedAt ?? resumed.finishedAt);
      const hold = age < PUBLISH_WAIT_MS;
      // A later start that may post writes the time first, so that the start after it is held from then on. Without that, nothing is posted.
      const timed = resumed === null || hold || await tried(async () => { await markPublishTried(db, target.id, nowIso); });
      /** A read just before the post; null when it rejects. */
      const orNull = async <T>(read: () => Promise<T>): Promise<T | null> => {
        try {
          return await read();
        } catch {
          return null;
        }
      };
      /** With approval on (the settings as they read now), what the decision is made from besides the live reads; with it off, nothing. */
      const approvalContext = async (): Promise<ApprovalContext | undefined> => {
        const settings = deps.settingsFor(repo);
        const approval = approvalOf(settings);
        if (!approval.enabled) return undefined;
        return {
          rule: approval.threads, clearByReply: settings.gate.clearByReply, threshold: settings.scoreThreshold,
          // The newest review that could not be read stands for a record that cannot be: never approved.
          runs: newestUnread ? null : await orNull(() => listRuns(db, job.ref)),
          stored: await orNull(() => listComments(db, job.ref)),
          // The audit sample (6.5), with the share as the settings read now and the deployment's key: asked by the decision last.
          drawn: () => drawnForAudit(deps.auditKey, job.ref, approval.auditShare),
        };
      };
      let out: PublishOutcome;
      if (!timed) {
        out = { kind: 'failed', code: 'record_failed' };
      } else {
        const approval = await approvalContext();
        // A run another job recorded keeps that job's trigger and requester; one recorded with no job, by an older release, is this job's.
        const ownRun = resumed === null || resumed.job === null || resumed.job === job.id;
        out = await publishRun({ forge: deps.forge, writer: deps.writer, lineUrl: deps.lineUrl, commentUrl: deps.commentUrl, approvals: deps.approvals }, {
          ref: job.ref, installation, run: target, trigger: job.trigger, requestedBy, known: knownOf(runs), resumed: resumed !== null, hold, ownRun,
          ...(approval === undefined ? {} : { approval }),
        });
      }
      publish = out;
      const finish = (outcome: string): Promise<boolean> => tried(async () => { await finishJob(db, job.id, 'done', outcome, nowIso); });
      if (out.kind === 'published') {
        /** A withdraw job was stored by the try that committed. */
        let asked = false;
        written = await tried(() => db.transaction(async (tx) => {
          // Each try starts afresh: a job stored by a try that was rolled back is no job.
          asked = false;
          await markPublished(tx, target.id, {
            reviewId: out.reviewId, publishedAt: later(0), body: out.body, inlineDropped: out.inlineDropped,
            approved: out.approval?.approved === true, approvalCode: out.approval?.code ?? null,
          });
          // An adopted review GitHub holds as a dismissed approval.
          if (out.approval?.dismissed === true) await markDismissed(tx, target.id, later(0), 'git_service');
          await finishJob(tx, job.id, 'done', 'published', nowIso);
          // Any approval of the app's that stands, this one included, is looked at again: a push may have landed since it was decided,
          // and a later review that does not approve withdraws it (calls 10, 11).
          if (await hasStandingApproval(tx, job.ref)) asked = (await askWithdraw(tx, job.ref, later(0), installation)) !== null;
        }));
        if (written && asked) wake();
        if (written) {
          await readBack(target, installation, out.reviewId, out.notesDropped);
          await threadFollowUp(target, installation, out.reviewId);
          toTell = { target, reviewId: out.reviewId, body: out.body };
        }
      } else if (out.kind === 'moved' && retryReason !== null) {
        // A command, a /done or a re-run starts over once, as a new job for the live head.
        written = await tried(() => db.transaction(async (tx) => {
          await enqueueJob(tx, { ref: job.ref, reason: retryReason, headSha: '', runAt: later(0), now: nowIso, delivery: null, replace: true,
            trigger: 'manual', requestedBy: job.requestedBy, commentId: job.commentId, association: job.association, installation: job.installation });
          await finishJob(tx, job.id, 'done', 'head_moved', nowIso);
        }));
      } else if (out.kind === 'moved' && manual) {
        // A command that started over does not start over again: the live head gets an automatic job.
        written = await tried(() => db.transaction(async (tx) => {
          await enqueueJob(tx, { ref: job.ref, reason: 'synchronize', headSha: out.head, runAt: later(QUIET_SECONDS * 1000), now: nowIso, delivery: null, replace: false,
            trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null });
          await finishJob(tx, job.id, 'done', 'head_moved', nowIso);
        }));
        if (written) await fail(installation, 'head_moved');
      } else if (out.kind === 'moved') {
        written = await tried(() => db.transaction(async (tx) => {
          await enqueueJob(tx, { ref: job.ref, reason: job.reason, headSha: out.head, runAt: later(QUIET_SECONDS * 1000), now: nowIso, delivery: null, replace: false,
            trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null });
          await finishJob(tx, job.id, 'done', 'head_moved', nowIso);
        }));
      } else if (out.kind === 'closed') {
        written = await finish('closed');
      } else if (out.kind === 'rejected') {
        let startedOver = false;
        written = await tried(() => db.transaction(async (tx) => {
          startedOver = false;
          if (await finishJob(tx, job.id, 'done', 'publish_rejected', nowIso)) startedOver = await startOverIfMoved(tx, target.headSha);
        }));
        if (written && !startedOver) await fail(installation, 'publish_rejected');
      } else if (out.kind === 'unlisted') {
        // Held: the job waits until the review is old enough, and the start is given back. A review dated after the clock waits no longer than one dated now.
        const runAt = at(Math.min(PUBLISH_WAIT_MS, PUBLISH_WAIT_MS - age));
        written = await tried(async () => { requeued = (await requeueJob(db, job.id, runAt, nowIso, true)) === 'requeued'; });
        if (written && !requeued) await fail(installation, 'superseded');
      } else {
        // After a failure the git service may hold the review all the same: the later start, which adopts it or posts it, comes when the review is no longer held.
        written = await tried(async () => { requeued = (await requeueJob(db, job.id, later(PUBLISH_WAIT_MS), nowIso, false)) === 'requeued'; });
        if (written && !requeued) await fail(installation, 'superseded');
      }
    }

    // 9. The log. The MCP servers' map and memory's status only when the result has them: with neither the line is what it was.
    const mcp = mcpOf(result ?? resumed?.result);
    const memory = memoryOf(result ?? resumed?.result);
    log({
      event: 'review', job: job.id, repo, number: job.ref.number, head: run.headSha, trigger: job.trigger, mode: run.mode, dry_run: deps.dryRun,
      outcome: written ? run.outcome : 'record_failed', failure_stage: run.failureStage, failure_code: run.failureCode,
      needs_human: run.needsHuman, highest: run.highestScore, findings: findingsOf(result ?? resumed?.result),
      calls: usage.calls, cost: usage.cost, duration_ms: deps.clock().getTime() - now.getTime(), requeued,
      published: publish?.kind === 'published', review: publish?.kind === 'published' ? publish.reviewId : null,
      publish: publish?.kind ?? null, publish_code: publish?.kind === 'failed' ? publish.code : null,
      resumed: resumed !== null, adopted: publish?.kind === 'published' && publish.adopted,
      // Only when the publication carried a decision (its code) or an adopted approval (null): with approval off the line is what it was.
      ...(publish?.kind === 'published' && publish.approval !== undefined ? { approved: publish.approval.approved, approval: publish.approval.code } : {}),
      threads_due: threadsDueOf(result ?? resumed?.result), verdicts: verdictsOf(result ?? resumed?.result).length, duplicates: duplicatesOf(result ?? resumed?.result),
      blocking_on_unchanged: blockingOnUnchangedOf(result ?? resumed?.result), nothing_new: endedNothingNew,
      notes: endedNothingNew ? 0 : notesOf(run.comments), notes_dropped: publish?.kind === 'published' ? publish.notesDropped : null,
      extensions: extensionsOf(result ?? resumed?.result),
      ...(mcp === null ? {} : { mcp }),
      ...(memory === null ? {} : { memory }),
    });
    // 10. The notice: the last thing the job does, so the line's duration does not count it.
    if (toTell !== null) await tell(toTell.target, live!.info, toTell.reviewId, toTell.body);
  } catch (error) {
    if (result !== null) {
      // The review was paid for: putting the job back would pay for it again. It is left running, as after three failed tries to record.
      let cost = 0;
      try {
        if (typeof result.usage.cost === 'number') cost = result.usage.cost;
      } catch {
        // a cost that cannot be read is logged as 0
      }
      log({ event: 'review', job: job.id, repo, number: job.ref.number, head: job.headSha, trigger: job.trigger, mode, dry_run: deps.dryRun, outcome: 'record_failed', cost, requeued: false });
      return;
    }
    // Nothing has been spent on this path: put the job back, its start counted, as for a git service failure.
    let requeued = false;
    await tried(async () => { requeued = (await requeueJob(db, job.id, later(retryWait), nowIso, false)) === 'requeued'; });
    log({ event: 'job', job: job.id, repo, number: job.ref.number, outcome: 'error', reason: codeOf(error), requeued });
  }
}
