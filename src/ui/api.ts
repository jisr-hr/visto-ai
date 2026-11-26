// The JSON reads of the UI's frame and Activity screen (UI design 3.1, 3.2 and 5; calls 13, 14, 19, 20 and 30). Each answer is
// built field by field from an allowlist: no config, secret, body, comment, result, id of another system, author or text a
// person wrote leaves here (call 13).
import { activityJobs, countReviews, knownRepositories, recentReviews, waitingWithdrawals } from '../db/activity.ts';
import type { JobRow, ReviewFilters, ReviewRow } from '../db/activity.ts';
import type { Db } from '../db/types.ts';
import type { PullRequestRef } from '../forge/types.ts';
import { QUIET_SECONDS } from '../shell/triggers.ts';
import type { Activity, ActivityJob, JobStage, Me, RecentReview, ReviewOutcome, Reviews } from './api-types.ts';
import type { Session } from './auth.ts';

export interface ApiDeps {
  db: Db; clock: () => Date; dryRun: boolean; reviewPlaces: number; withdrawPlaces: number;
  holds: (ref: PullRequestRef) => boolean;
  paused: () => Promise<string | null>;   // the service's pauseCode as it is; any code but spend_limit and model_error answers null
  pullRequestUrl: (ref: PullRequestRef) => string;
}

export const WINDOW_DAYS = 30;
const PAGE = 25;
const JOBS_SHOWN = 200;
const WITHDRAWALS_SHOWN = 50;
const REPOSITORIES_SHOWN = 200;
const HEAD_SHOWN = 12;
const MAX_QUERY = 100;
const MAX_RUN_ID = 2147483647;
const REPOSITORY = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/;
const NUMBER_QUERY = /^#?(\d{1,9})$/;
const BEFORE = /^\d{1,10}$/;
/** The outcome filters (call 20): `needs_person` takes the audit sample too. */
const OUTCOMES: ReadonlyMap<string, string[]> = new Map([
  ['approved', ['approved']], ['needs_person', ['needs_person', 'audit']], ['failed', ['failed']],
]);
/** The stages a running review job writes on its row (call 14). */
const RUNNING_STAGES: ReadonlySet<string> = new Set(['preparing', 'reviewing', 'judging_threads', 'publishing']);

export async function me(deps: ApiDeps, session: Session): Promise<Me> {
  return {
    login: session.login, csrf: session.csrf, mode: deps.dryRun ? 'dry_run' : 'live',
    repositories: await knownRepositories(deps.db, REPOSITORIES_SHOWN),
  };
}

type Place = Pick<ActivityJob, 'stage' | 'batch' | 'batches' | 'threadsDue'>;
const at = (stage: JobStage): Place => ({ stage, batch: null, batches: null, threadsDue: null });

/**
 * A running row the runner does not hold is stopped; one it holds reads its stage, `preparing` when it has none it knows. A
 * pending row's stage is never read: a push's job, stored to wait the quiet time after it was made, waits; any other not yet
 * due waits to try again; the rest are queued.
 */
function placeOf(row: JobRow, held: boolean | null, now: number): Place {
  if (row.status === 'running') {
    if (held !== true) return at('stopped');
    const stage = row.stage !== null && RUNNING_STAGES.has(row.stage) ? row.stage as JobStage : 'preparing';
    const counted = stage === 'reviewing' || stage === 'judging_threads';
    return { stage, batch: counted ? row.batch : null, batches: counted ? row.batches : null, threadsDue: stage === 'judging_threads' ? row.threads_due : null };
  }
  const runAt = row.run_at.getTime();
  if (runAt <= now) return at('queued');
  return at(row.reason === 'synchronize' && runAt - row.created_at.getTime() === QUIET_SECONDS * 1000 ? 'waiting' : 'retrying');
}

/** The job's own head, else the stored head when the job names none (a manual job), in its first 12 characters; null when neither. */
function headOf(row: JobRow): string | null {
  const head = row.head_sha !== '' ? row.head_sha : row.stored_head ?? '';
  return head === '' ? null : head.slice(0, HEAD_SHOWN);
}

function jobOf(deps: ApiDeps, row: JobRow, now: number): ActivityJob {
  const ref: PullRequestRef = { service: 'github', owner: row.owner, repo: row.repo, number: row.number };
  const running = row.status === 'running';
  const place = placeOf(row, running ? deps.holds(ref) : null, now);
  return {
    job: row.id, repository: `${row.owner}/${row.repo}`, number: row.number, title: row.title, url: deps.pullRequestUrl(ref),
    head: headOf(row), stage: place.stage, batch: place.batch, batches: place.batches, threadsDue: place.threadsDue,
    startedAt: running && row.started_at !== null ? row.started_at.toISOString() : null, runAt: row.run_at.toISOString(),
    askedBy: { reason: row.reason, login: row.trigger === 'manual' ? row.requested_by : null },
  };
}

export async function activity(deps: ApiDeps): Promise<Activity> {
  const clock = deps.clock();
  const now = clock.toISOString();
  const rows = await activityJobs(deps.db, JOBS_SHOWN);
  const waiting = await waitingWithdrawals(deps.db, WITHDRAWALS_SHOWN);
  const code = await deps.paused();
  return {
    now,
    places: { reviews: deps.reviewPlaces, withdrawals: deps.withdrawPlaces },
    paused: code === 'spend_limit' || code === 'model_error' ? code : null,
    jobs: rows.map((row) => jobOf(deps, row, clock.getTime())),
    withdrawals: waiting.map((w) => ({ repository: `${w.owner}/${w.repo}`, number: w.number, code: w.retry_code, runAt: w.run_at.toISOString() })),
  };
}

/** A parameter's one value, null when absent or written empty; undefined when it is given more than once. */
function single(query: URLSearchParams, name: string): string | null | undefined {
  const values = query.getAll(name);
  if (values.length > 1) return undefined;
  const value = values[0];
  return value === undefined || value === '' ? null : value;
}

/** The filters the query asks for; null when one parameter is malformed. */
function filtersOf(query: URLSearchParams, since: string): ReviewFilters | null {
  const repo = single(query, 'repo');
  const outcome = single(query, 'outcome');
  const q = single(query, 'q');
  const before = single(query, 'before');
  if (repo === undefined || outcome === undefined || q === undefined || before === undefined) return null;

  const repository = repo === null ? null : repo.toLowerCase();
  if (repository !== null && !REPOSITORY.test(repository)) return null;
  const kinds = outcome === null ? null : OUTCOMES.get(outcome);
  if (kinds === undefined) return null;
  const trimmed = q === null ? null : q.trim();
  if (trimmed !== null && trimmed.length > MAX_QUERY) return null;
  const title = trimmed === null || trimmed === '' ? null : trimmed;
  const digits = title === null ? null : NUMBER_QUERY.exec(title)?.[1] ?? null;
  if (before !== null && !(BEFORE.test(before) && Number(before) <= MAX_RUN_ID)) return null;
  return {
    since, repository, kinds: kinds === null ? null : [...kinds], title, number: digits === null ? null : Number(digits),
    before: before === null ? null : Number(before),
  };
}

function reviewOf(row: ReviewRow): RecentReview {
  const outcome = row.kind as ReviewOutcome;
  return {
    run: row.id, repository: `${row.owner}/${row.repo}`, number: row.number, title: row.title, outcome, failureCode: row.failure_code,
    highest: outcome === 'failed' || outcome === 'nothing_new' ? null : row.highest_score, threshold: row.threshold,
    findings: { blocker: row.blockers, major: row.majors, minor: row.minors },
    mode: row.mode, dryRun: row.dry_run, cost: row.cost, tookMs: row.finished_at.getTime() - row.started_at.getTime(), at: row.finished_at.toISOString(),
  };
}

export async function reviews(deps: ApiDeps, query: URLSearchParams): Promise<Reviews | 'bad_request'> {
  const clock = deps.clock();
  const now = clock.toISOString();
  const filters = filtersOf(query, new Date(clock.getTime() - WINDOW_DAYS * 86_400_000).toISOString());
  if (filters === null) return 'bad_request';
  const rows = await recentReviews(deps.db, filters, PAGE + 1);
  const total = await countReviews(deps.db, filters);
  return {
    now, windowDays: WINDOW_DAYS, total, reviews: rows.slice(0, PAGE).map(reviewOf),
    next: rows.length > PAGE ? rows[PAGE - 1]!.id : null,
  };
}
