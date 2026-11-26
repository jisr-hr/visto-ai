import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GATE_OFF } from '../config/load.ts';
import type { RepoSettings } from '../config/load.ts';
import { markDismissed, markDismissFailed } from '../db/approvals.ts';
import { askWithdraw, claimJob, finishJob, getJob } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { markPublished, recordRun } from '../db/review-runs.ts';
import type { RunRecord } from '../db/review-runs.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import type { LivePullRequest, OwnReviewState } from '../forge/types.ts';
import { at, liveOf, REF, SETTINGS } from '../gate/testing.ts';
import { dismissMessage } from './text.ts';
import { runWithdrawJob, sweepWithdraw, WITHDRAW_RETRY_WAITS_MS } from './withdraw.ts';
import type { WithdrawJobDeps } from './withdraw.ts';

type ReviewAnswer = { state: OwnReviewState; commit: string | null } | null | Error;

interface Options {
  /** What readPullRequest answers, one for each call, the last repeated; an Error rejects. Open at h2 when not given. */
  live?: Array<LivePullRequest | null | Error>;
  /** What readReview answers for each review id, one for each call, the last repeated. Approved when not given. */
  reviews?: Record<string, ReviewAnswer[]>;
  /** What dismissReview does for each review id, one for each call, the last repeated: an Error rejects, null takes. It takes when not given. */
  dismissals?: Record<string, Array<Error | null>>;
  /** The gate enabled on main when not given. */
  settings?: RepoSettings;
  dryRun?: boolean;
  /** The installation stored with the pull request; '99' when not given; false stores no row. */
  stored?: string | null | false;
  /** The logger and the alert throw. */
  throwing?: boolean;
  /** Every statement of the job whose text holds this rejects. */
  failQuery?: string;
  /** The job's clock throws. */
  clockThrows?: boolean;
}

interface Harness {
  db: Db; deps: WithdrawJobDeps;
  /** Every call of a fake, as [name, ...args]. */
  calls: unknown[][];
  logs: Array<Record<string, unknown>>;
  alerts: Array<[string, Record<string, string | number | boolean | null> | undefined]>;
  /** The text of every statement the job's database was given. */
  queries: string[];
  queued(): number;
  /** Asks for a withdraw job at `seconds` and claims it there, at its `starts`-th start (1 when not given). */
  job(seconds?: number, more?: { installation?: string | null; starts?: number }): Promise<Job>;
  /** Claims the pending withdraw job at `seconds`, which the clock then reads; null when there is none or it is not due. */
  claim(seconds: number): Promise<Job | null>;
  run(job: Job): Promise<void>;
}

const dbs: Db[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
});

const APPROVED: ReviewAnswer = { state: 'approved', commit: null };
const DISMISSED: ReviewAnswer = { state: 'dismissed', commit: 'h1' };
const GATE_DISABLED: RepoSettings = { ...SETTINGS, gate: GATE_OFF };

const pick = <T>(list: T[], n: number): T => list[Math.min(n, list.length - 1)]!;

async function harness(options: Options = {}): Promise<Harness> {
  const db = await testDb();
  dbs.push(db);
  const calls: unknown[][] = [];
  const logs: Harness['logs'] = [];
  const alerts: Harness['alerts'] = [];
  const queries: string[] = [];
  const live = options.live ?? [liveOf({ head: 'h2' })];
  const reads = new Map<string, number>();
  const dismissals = new Map<string, number>();
  let liveReads = 0;
  let queued = 0;
  let now = new Date(at(0));

  const jobDb: Db = {
    query: <Row>(text: string, params?: unknown[]) => {
      queries.push(text);
      if (options.failQuery !== undefined && text.includes(options.failQuery)) return Promise.reject(new Error('db_down'));
      return db.query<Row>(text, params);
    },
    script: (sql) => db.script(sql),
    transaction: (work) => db.transaction(work),
    close: () => db.close(),
  };
  const deps: WithdrawJobDeps = {
    db: jobDb,
    forge: {
      async readPullRequest(ref, installation) {
        calls.push(['readPullRequest', ref, installation]);
        const answer = pick(live, liveReads);
        liveReads += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      async sourceFor() { throw new Error('not_used'); },
    },
    approvals: {
      async staleApprovals() { calls.push(['staleApprovals']); throw new Error('not_used'); },
      async readReview(_ref, _installation, reviewId) {
        calls.push(['readReview', reviewId]);
        const n = reads.get(reviewId) ?? 0;
        reads.set(reviewId, n + 1);
        const answer = pick(options.reviews?.[reviewId] ?? [APPROVED], n);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      async dismissReview(_ref, _installation, reviewId, message) {
        calls.push(['dismissReview', reviewId, message]);
        const n = dismissals.get(reviewId) ?? 0;
        dismissals.set(reviewId, n + 1);
        const answer = pick(options.dismissals?.[reviewId] ?? [null], n);
        if (answer !== null) throw answer;
      },
    },
    clock: () => { if (options.clockThrows === true) throw new Error('clock_down'); return now; },
    log: (entry) => { logs.push(entry); if (options.throwing === true) throw new Error('log_down'); },
    alert: (code, details) => { alerts.push([code, details]); if (options.throwing === true) throw new Error('alert_down'); },
    settingsFor: () => options.settings ?? SETTINGS,
    dryRun: options.dryRun ?? false,
    onQueued: () => { queued += 1; },
  };

  if (options.stored !== false) await storePullRequest(db, REF.number, 'open', options.stored === undefined ? '99' : options.stored);

  const claim = async (seconds: number): Promise<Job | null> => {
    now = new Date(at(seconds));
    const rows = await db.query<{ id: number }>("select id from visto_ai.jobs where kind = 'withdraw' and status = 'pending'");
    return rows[0] === undefined ? null : claimJob(db, rows[0].id, at(seconds));
  };
  return {
    db, deps, calls, logs, alerts, queries,
    queued: () => queued,
    async job(seconds = 0, more = {}) {
      const id = await askWithdraw(db, REF, at(seconds), 'installation' in more ? more.installation ?? null : '99');
      if ((more.starts ?? 1) > 1) await db.query('update visto_ai.jobs set starts = $2 where id = $1', [id, (more.starts ?? 1) - 1]);
      return (await claim(seconds))!;
    },
    claim,
    run: (job) => runWithdrawJob(job, deps),
  };
}

async function storePullRequest(db: Db, number: number, state: 'open' | 'closed' | 'merged', installation: string | null = '99'): Promise<void> {
  await savePullRequest(db, {
    ref: { ...REF, number }, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: 'h2', draft: false, state,
    mergedAt: state === 'merged' ? at(1) : null, closedAt: state === 'open' ? null : at(1), mergeCommit: null, installation, updatedAt: at(0),
  });
}

const record = (over: Partial<RunRecord>): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'merge000', baseBranch: 'main',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 10,
  body: 'A review.', comments: [], result: { findings: [] },
  usage: { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 }, startedAt: at(0), finishedAt: at(1), ...over,
});

/** Records a run at h1 against main and publishes it as review `reviewId`: an approval unless `approved` is false. Its id is returned. */
async function posted(db: Db, reviewId: string, over: Partial<RunRecord> & { approved?: boolean } = {}): Promise<number> {
  const { approved = true, ...rest } = over;
  const id = await recordRun(db, record(rest));
  await markPublished(db, id, { reviewId, publishedAt: at(2), body: 'A review.', inlineDropped: false, approved, approvalCode: approved ? 'approved' : 'rule_off' });
  return id;
}

interface RunRow { id: number; dismissed_at: Date | null; dismissed_by: string | null; dismiss_failure: string | null; stood_at_merge: Date | null }
const runRows = (db: Db): Promise<RunRow[]> =>
  db.query<RunRow>('select id, dismissed_at, dismissed_by, dismiss_failure, stood_at_merge from visto_ai.review_runs order by id');
const row = (id: number, over: Partial<RunRow> = {}): RunRow =>
  ({ id, dismissed_at: null, dismissed_by: null, dismiss_failure: null, stood_at_merge: null, ...over });

async function statusOf(h: Harness, job: Job): Promise<[string, string | null, string]> {
  const j = (await getJob(h.db, job.id))!;
  return [j.status, j.outcome, j.runAt];
}
const gateJobs = (db: Db): Promise<Array<{ reason: string; status: string; installation: string | null }>> =>
  db.query("select reason, status, installation from visto_ai.jobs where kind = 'gate' order by id");
const lines = (h: Harness): Array<Record<string, unknown>> => h.logs.filter((e) => e['event'] === 'withdraw');
const named = (h: Harness, name: string): unknown[][] => h.calls.filter((c) => c[0] === name);

test('in dry run, and with no standing approval, nothing is read', async () => {
  const dry = await harness({ dryRun: true });
  await posted(dry.db, '501');
  const job = await dry.job();
  await dry.run(job);
  assert.deepEqual(dry.calls, []);
  // The job's own finish is the one statement.
  assert.deepEqual(dry.queries.filter((q) => !q.includes('update visto_ai.jobs set status')), []);
  assert.deepEqual(await statusOf(dry, job), ['dropped', 'dry_run', at(0)]);
  assert.deepEqual(lines(dry), [{
    event: 'withdraw', job: job.id, repo: 'acme/shop', number: 7, state: null, standing: 0, targets: 0, dismissed: 0, by_git_service: 0,
    failed: 0, code: null, outcome: 'dry_run', requeued: null,
  }]);
  assert.deepEqual(await gateJobs(dry.db), []);

  // A comment, and an approval dismissed: no standing approval, and neither GitHub nor the stored pull request is read.
  const none = await harness();
  await posted(none.db, '501', { approved: false });
  const gone = await posted(none.db, '502');
  await markDismissed(none.db, gone, at(3), 'app');
  const second = await none.job(5);
  await none.run(second);
  assert.deepEqual(none.calls, []);
  assert.deepEqual(none.queries.filter((q) => q.includes('pull_requests')), []);
  assert.deepEqual(await statusOf(none, second), ['done', 'none', at(5)]);
  assert.equal(lines(none)[0]!['outcome'], 'none');

  // No installation, the job's or the stored pull request's: dropped, and GitHub is not read.
  const lost = await harness({ stored: null });
  const id = await posted(lost.db, '501');
  const third = await lost.job(0, { installation: null });
  await lost.run(third);
  assert.deepEqual(lost.calls, []);
  assert.deepEqual(await statusOf(lost, third), ['dropped', 'no_installation', at(0)]);
  assert.deepEqual(await runRows(lost.db), [row(id)]);
  assert.equal(lines(lost)[0]!['standing'], 1);
});

test('an approval at another head than the live one is dismissed and recorded as dismissed by the app', async () => {
  const h = await harness();
  const id = await posted(h.db, '501');
  const job = await h.job(5);
  await h.run(job);
  assert.deepEqual(h.calls, [
    ['readPullRequest', REF, '99'],
    ['readReview', '501'],
    ['dismissReview', '501', dismissMessage('h1')],
  ]);
  assert.deepEqual(await runRows(h.db), [row(id, { dismissed_at: new Date(at(5)), dismissed_by: 'app' })]);
  assert.deepEqual(await statusOf(h, job), ['done', 'done', at(5)]);
  // The record changed on a pull request gated on main: the gate is asked, with the job's installation.
  assert.deepEqual(await gateJobs(h.db), [{ reason: 'sync', status: 'pending', installation: '99' }]);
  assert.equal(h.queued(), 1);
  assert.deepEqual(h.alerts, []);

  // A job asked with no installation reads GitHub with the stored pull request's.
  const stored = await harness({ stored: '98' });
  await posted(stored.db, '501');
  await stored.run(await stored.job(0, { installation: null }));
  assert.deepEqual(stored.calls[0], ['readPullRequest', REF, '98']);
  assert.deepEqual(await gateJobs(stored.db), [{ reason: 'sync', status: 'pending', installation: '98' }]);
});

test('one GitHub already dismissed is recorded as dismissed by the git service, and no dismissal is sent', async () => {
  const h = await harness({ reviews: { '501': [DISMISSED], '502': [{ state: 'commented', commit: 'h1' }] } });
  const first = await posted(h.db, '501');
  const second = await posted(h.db, '502');
  const job = await h.job(5);
  await h.run(job);
  assert.deepEqual(h.calls, [['readPullRequest', REF, '99'], ['readReview', '501'], ['readReview', '502']]);
  assert.deepEqual(await runRows(h.db), [
    row(first, { dismissed_at: new Date(at(5)), dismissed_by: 'git_service' }),
    row(second, { dismissed_at: new Date(at(5)), dismissed_by: 'git_service' }),
  ]);
  assert.deepEqual(await statusOf(h, job), ['done', 'done', at(5)]);
  assert.deepEqual([lines(h)[0]!['dismissed'], lines(h)[0]!['by_git_service'], lines(h)[0]!['failed']], [0, 2, 0]);
  assert.equal(h.queued(), 1);
});

test('a dismissal refused while GitHub dismissed it meanwhile is no failure', async () => {
  const h = await harness({ reviews: { '501': [APPROVED, DISMISSED] }, dismissals: { '501': [new Error('github_403')] } });
  const id = await posted(h.db, '501');
  const job = await h.job(5);
  await h.run(job);
  assert.deepEqual(h.calls, [
    ['readPullRequest', REF, '99'], ['readReview', '501'], ['dismissReview', '501', dismissMessage('h1')], ['readReview', '501'],
  ]);
  assert.deepEqual(await runRows(h.db), [row(id, { dismissed_at: new Date(at(5)), dismissed_by: 'git_service' })]);
  assert.deepEqual(await statusOf(h, job), ['done', 'done', at(5)]);
  assert.deepEqual([lines(h)[0]!['code'], lines(h)[0]!['requeued']], [null, null]);

  // Read again still approved, or not read at all: the dismissal's own code is the failure.
  for (const again of [APPROVED, new Error('github_502')]) {
    const failed = await harness({ reviews: { '501': [APPROVED, again] }, dismissals: { '501': [new Error('github_403')] } });
    const standing = await posted(failed.db, '501');
    const retried = await failed.job(5);
    await failed.run(retried);
    assert.deepEqual(await runRows(failed.db), [row(standing)]);
    assert.deepEqual(await statusOf(failed, retried), ['pending', null, at(15)]);
    assert.deepEqual([lines(failed)[0]!['code'], lines(failed)[0]!['failed']], ['github_403', 1]);
  }
});

test('an approval at the live head and base stays; one at another base branch is dismissed', async () => {
  const h = await harness({ live: [liveOf()] });
  const other = await posted(h.db, '501', { baseBranch: 'release/1.0' });
  const kept = await posted(h.db, '502');
  const job = await h.job(5);
  await h.run(job);
  // The one that stays is read too, and GitHub still holds it approved.
  assert.deepEqual(h.calls, [
    ['readPullRequest', REF, '99'], ['readReview', '502'], ['readReview', '501'], ['dismissReview', '501', dismissMessage('h1')],
  ]);
  assert.deepEqual(await runRows(h.db), [row(other, { dismissed_at: new Date(at(5)), dismissed_by: 'app' }), row(kept)]);
  assert.deepEqual([lines(h)[0]!['standing'], lines(h)[0]!['targets'], lines(h)[0]!['dismissed']], [2, 1, 1]);

  // Asked again: the one left is at the live head and base and is the newest review: it is read, and nothing is recorded.
  const again = await h.job(20);
  await h.run(again);
  assert.deepEqual(named(h, 'readReview'), [['readReview', '502'], ['readReview', '501'], ['readReview', '502']]);
  assert.equal(named(h, 'dismissReview').length, 1);
  assert.deepEqual(await statusOf(h, again), ['done', 'kept', at(20)]);
  assert.deepEqual(await runRows(h.db), [row(other, { dismissed_at: new Date(at(5)), dismissed_by: 'app' }), row(kept)]);
  assert.equal(h.queued(), 1);
});

test('a hand dismissal of the newest approval at the live head is recorded by the job its delivery asks for, and the gate is asked', async () => {
  for (const [settings, answer] of [[SETTINGS, DISMISSED], [GATE_DISABLED, DISMISSED], [SETTINGS, { state: 'commented', commit: 'h1' }]] as const) {
    const h = await harness({ settings, live: [liveOf()], reviews: { '501': [answer] } });
    const id = await posted(h.db, '501');
    // The `dismissed` delivery names the approval and asks for a job, with the event's installation.
    const job = await h.job(5);
    await h.run(job);
    assert.deepEqual(h.calls, [['readPullRequest', REF, '99'], ['readReview', '501']]);
    assert.deepEqual(await runRows(h.db), [row(id, { dismissed_at: new Date(at(5)), dismissed_by: 'git_service' })]);
    assert.deepEqual(await statusOf(h, job), ['done', 'done', at(5)]);
    assert.deepEqual(lines(h)[0], {
      event: 'withdraw', job: job.id, repo: 'acme/shop', number: 7, state: 'open', standing: 1, targets: 0, dismissed: 0, by_git_service: 1,
      failed: 0, code: null, outcome: 'done', requeued: null,
    });
    const gated = settings === SETTINGS;
    assert.deepEqual(await gateJobs(h.db), gated ? [{ reason: 'sync', status: 'pending', installation: '99' }] : []);
    assert.deepEqual([h.queued(), h.alerts], [gated ? 1 : 0, []]);
  }
});

test('the newest approval at the live head that GitHub still holds approved is read and left as it is', async () => {
  const h = await harness({ live: [liveOf()] });
  const id = await posted(h.db, '501');
  const job = await h.job(5);
  await h.run(job);
  assert.deepEqual(h.calls, [['readPullRequest', REF, '99'], ['readReview', '501']]);
  assert.deepEqual(await runRows(h.db), [row(id)]);
  assert.deepEqual(await statusOf(h, job), ['done', 'kept', at(5)]);
  assert.deepEqual([lines(h)[0]!['targets'], lines(h)[0]!['by_git_service'], lines(h)[0]!['failed'], lines(h)[0]!['outcome']], [0, 0, 0, 'kept']);
  assert.deepEqual([await gateJobs(h.db), h.queued(), h.alerts], [[], 0, []]);
});

test('a standing approval that is no target and whose read fails, or answers nothing or another state, is no failure', async () => {
  for (const answer of [new Error('github_502'), null, { state: 'other', commit: 'h1' }] as ReviewAnswer[]) {
    const h = await harness({ live: [liveOf()], reviews: { '501': [answer] } });
    const id = await posted(h.db, '501');
    const job = await h.job(5);
    await h.run(job);
    assert.deepEqual(h.calls, [['readPullRequest', REF, '99'], ['readReview', '501']]);
    assert.deepEqual(await runRows(h.db), [row(id)]);
    // Not put back, nothing recorded on it, nothing alerted or asked.
    assert.deepEqual(await statusOf(h, job), ['done', 'kept', at(5)]);
    assert.deepEqual([lines(h)[0]!['failed'], lines(h)[0]!['code'], lines(h)[0]!['requeued'], lines(h)[0]!['outcome']], [0, null, null, 'kept']);
    assert.deepEqual([await gateJobs(h.db), h.queued(), h.alerts], [[], 0, []]);
  }
});

test('a later review that does not approve withdraws the approval of the same head', async () => {
  const h = await harness({ live: [liveOf()] });
  const id = await posted(h.db, '501');
  await posted(h.db, '502', { approved: false });
  const job = await h.job(5);
  await h.run(job);
  assert.deepEqual(h.calls, [['readPullRequest', REF, '99'], ['readReview', '501'], ['dismissReview', '501', dismissMessage('h1')]]);
  assert.deepEqual((await runRows(h.db))[0], row(id, { dismissed_at: new Date(at(5)), dismissed_by: 'app' }));
  assert.deepEqual(await statusOf(h, job), ['done', 'done', at(5)]);

  // The newest review an approval that was dismissed: no reason to keep an older one of the same head.
  const g = await harness({ live: [liveOf()] });
  const older = await posted(g.db, '501');
  const newer = await posted(g.db, '502');
  await markDismissed(g.db, newer, at(3), 'git_service');
  await g.run(await g.job(5));
  assert.deepEqual((await runRows(g.db))[0], row(older, { dismissed_at: new Date(at(5)), dismissed_by: 'app' }));
});

test('a closed pull request, and one GitHub does not find, are left as they are', async () => {
  for (const [live, outcome, state] of [[liveOf({ head: 'h2', state: 'closed' }), 'closed', 'closed'], [null, 'not_found', null]] as const) {
    const h = await harness({ live: [live] });
    const id = await posted(h.db, '501');
    const job = await h.job(5);
    await h.run(job);
    assert.deepEqual(h.calls, [['readPullRequest', REF, '99']]);
    assert.deepEqual(await runRows(h.db), [row(id)]);
    assert.deepEqual(await statusOf(h, job), ['done', outcome, at(5)]);
    assert.deepEqual([lines(h)[0]!['state'], lines(h)[0]!['targets']], [state, 0]);
    assert.deepEqual([await gateJobs(h.db), h.queued(), h.alerts], [[], 0, []]);
  }
});

test('a review GitHub does not find is a failure, not a dismissal', async () => {
  const h = await harness({ reviews: { '501': [null] } });
  const id = await posted(h.db, '501');
  const job = await h.job(5);
  await h.run(job);
  assert.deepEqual(h.calls, [['readPullRequest', REF, '99'], ['readReview', '501']]);
  assert.deepEqual(await runRows(h.db), [row(id)]);
  assert.deepEqual(await statusOf(h, job), ['pending', null, at(15)]);
  assert.deepEqual([lines(h)[0]!['code'], lines(h)[0]!['outcome'], lines(h)[0]!['requeued']], ['review_not_found', 'put_back', true]);

  // At the third start it is recorded with its code.
  await h.db.query('update visto_ai.jobs set starts = 2 where id = $1', [job.id]);
  const last = await h.claim(15);
  assert.equal(last!.starts, 3);
  await h.run(last!);
  assert.deepEqual(await runRows(h.db), [row(id, { dismiss_failure: 'review_not_found' })]);
  assert.deepEqual(h.alerts, [['dismissal_failed', { reason: 'review_not_found', repo: 'acme/shop', number: 7 }]]);
  assert.equal(named(h, 'dismissReview').length, 0);
});

test('a review in a state that is neither approved, commented nor dismissed is a failure', async () => {
  const other: ReviewAnswer = { state: 'other', commit: 'h1' };
  // Open: never dismissed, recorded at the give-up.
  const open = await harness({ reviews: { '501': [other] } });
  const id = await posted(open.db, '501');
  const job = await open.job(5, { starts: 3 });
  await open.run(job);
  assert.equal(named(open, 'dismissReview').length, 0);
  assert.deepEqual(await runRows(open.db), [row(id, { dismiss_failure: 'review_state_other' })]);
  assert.deepEqual(await statusOf(open, job), ['done', 'failed', at(5)]);
  assert.deepEqual(open.alerts, [['dismissal_failed', { reason: 'review_state_other', repo: 'acme/shop', number: 7 }]]);

  // Merged: tried again, and at the give-up nothing is recorded or alerted.
  const merged = await harness({ live: [liveOf({ head: 'h2', state: 'merged' })], reviews: { '501': [other] } });
  const stale = await posted(merged.db, '501');
  const first = await merged.job(5);
  await merged.run(first);
  assert.deepEqual(await statusOf(merged, first), ['pending', null, at(15)]);
  assert.deepEqual([lines(merged)[0]!['state'], lines(merged)[0]!['code']], ['merged', 'review_state_other']);
  const last = await merged.job(20, { starts: 3 });
  await merged.run(last);
  assert.deepEqual(await statusOf(merged, last), ['done', 'failed', at(20)]);
  assert.deepEqual(await runRows(merged.db), [row(stale)]);
  assert.deepEqual([merged.alerts, await gateJobs(merged.db)], [[], []]);
});

test('a dismissal that fails is tried again after 10 and 60 seconds, then recorded, alerted once and asked of the gate', async () => {
  assert.deepEqual(WITHDRAW_RETRY_WAITS_MS, [10_000, 60_000]);
  for (const settings of [SETTINGS, GATE_DISABLED]) {
    const h = await harness({ settings, dismissals: { '501': [new Error('github_403')] } });
    const id = await posted(h.db, '501');
    const first = await h.job(0);
    await h.run(first);
    assert.deepEqual(await statusOf(h, first), ['pending', null, at(10)]);
    assert.equal(await h.claim(9), null);
    const second = await h.claim(10);
    assert.equal(second!.starts, 2);
    await h.run(second!);
    assert.deepEqual(await statusOf(h, second!), ['pending', null, at(70)]);
    assert.deepEqual([await runRows(h.db), await gateJobs(h.db), h.alerts], [[row(id)], [], []]);
    const third = await h.claim(70);
    assert.equal(third!.starts, 3);
    await h.run(third!);
    assert.deepEqual(await statusOf(h, third!), ['done', 'failed', at(70)]);
    // Each start read the review, sent the dismissal and read the review again.
    assert.equal(named(h, 'dismissReview').length, 3);
    assert.deepEqual(await runRows(h.db), [row(id, { dismiss_failure: 'github_403' })]);
    assert.deepEqual(h.alerts, [['dismissal_failed', { reason: 'github_403', repo: 'acme/shop', number: 7 }]]);
    assert.deepEqual(lines(h).map((l) => [l['outcome'], l['requeued'], l['code']]), [
      ['put_back', true, 'github_403'], ['put_back', true, 'github_403'], ['failed', false, 'github_403'],
    ]);
    const gated = settings === SETTINGS;
    assert.deepEqual(await gateJobs(h.db), gated ? [{ reason: 'sync', status: 'pending', installation: '99' }] : []);
    assert.equal(h.queued(), gated ? 1 : 0);

    // A second give-up: the failure was recorded before, so no second alert, and the gate is not asked again.
    const again = await h.job(200, { starts: 3 });
    await h.run(again);
    assert.deepEqual(await statusOf(h, again), ['done', 'failed', at(200)]);
    assert.equal(h.alerts.length, 1);
    assert.equal(h.queued(), gated ? 1 : 0);
  }
});

test("a pull request whose live read fails three times records the read's code on each standing approval and alerts once", async () => {
  const h = await harness({ live: [new Error('github_502')] });
  const first = await posted(h.db, '501');
  const second = await posted(h.db, '502', { headSha: 'h2', baseBranch: 'release/1.0' });
  await h.run(await h.job(0));
  await h.run((await h.claim(10))!);
  assert.deepEqual(await runRows(h.db), [row(first), row(second)]);
  const last = await h.claim(70);
  await h.run(last!);
  assert.deepEqual(h.calls, [['readPullRequest', REF, '99'], ['readPullRequest', REF, '99'], ['readPullRequest', REF, '99']]);
  assert.deepEqual(await runRows(h.db), [row(first, { dismiss_failure: 'github_502' }), row(second, { dismiss_failure: 'github_502' })]);
  assert.deepEqual(h.alerts, [['dismissal_failed', { reason: 'github_502', repo: 'acme/shop', number: 7 }]]);
  assert.deepEqual(lines(h)[2], {
    event: 'withdraw', job: last!.id, repo: 'acme/shop', number: 7, state: null, standing: 2, targets: 0, dismissed: 0, by_git_service: 0,
    failed: 0, code: 'github_502', outcome: 'failed', requeued: false,
  });
  // Gated by the stored base branch, since the live one was never read.
  assert.deepEqual(await gateJobs(h.db), [{ reason: 'sync', status: 'pending', installation: '99' }]);
  assert.equal(h.queued(), 1);
});

test('a dismissal that succeeds after a recorded failure clears it and asks the gate again', async () => {
  const h = await harness();
  const id = await posted(h.db, '501');
  assert.equal(await markDismissFailed(h.db, id, 'github_403'), true);
  const job = await h.job(5);
  await h.run(job);
  assert.deepEqual(await runRows(h.db), [row(id, { dismissed_at: new Date(at(5)), dismissed_by: 'app' })]);
  assert.deepEqual(await statusOf(h, job), ['done', 'done', at(5)]);
  assert.deepEqual(await gateJobs(h.db), [{ reason: 'sync', status: 'pending', installation: '99' }]);
  assert.deepEqual([h.queued(), h.alerts], [1, []]);
});

test('the same job run twice dismisses once', async () => {
  const h = await harness();
  const id = await posted(h.db, '501');
  const job = await h.job(5);
  await h.run(job);
  await h.run(job);
  assert.equal(named(h, 'dismissReview').length, 1);
  assert.deepEqual(await statusOf(h, job), ['done', 'done', at(5)]);
  // The second run found nothing standing and did not finish the job again.
  assert.deepEqual([lines(h)[1]!['standing'], lines(h)[1]!['outcome']], [0, null]);

  // A redelivered push asks again: nothing stands, nothing is read.
  const again = await h.job(30);
  await h.run(again);
  assert.deepEqual([named(h, 'dismissReview').length, named(h, 'readPullRequest').length], [1, 1]);
  assert.deepEqual(await statusOf(h, again), ['done', 'none', at(30)]);
  assert.deepEqual(await runRows(h.db), [row(id, { dismissed_at: new Date(at(5)), dismissed_by: 'app' })]);
});

test('at a merge, an approval of another head that still stands is recorded and alerted once; one dismissed is recorded as such; one at the merged head is left', async () => {
  const h = await harness({
    live: [liveOf({ head: 'h2', state: 'merged' })],
    reviews: { '501': [APPROVED], '502': [DISMISSED], '504': [null] },
  });
  const stale = await posted(h.db, '501');
  const gone = await posted(h.db, '502');
  const merged = await posted(h.db, '503', { headSha: 'h2' });
  const missing = await posted(h.db, '504');
  const job = await h.job(5);
  await h.run(job);
  assert.deepEqual(h.calls, [['readPullRequest', REF, '99'], ['readReview', '501'], ['readReview', '502'], ['readReview', '504']]);
  const after = [
    row(stale, { stood_at_merge: new Date(at(5)) }),
    row(gone, { dismissed_at: new Date(at(5)), dismissed_by: 'git_service' }),
    row(merged),
    row(missing),
  ];
  assert.deepEqual(await runRows(h.db), after);
  assert.deepEqual(h.alerts, [['stale_approval_merged', { repo: 'acme/shop', number: 7 }]]);
  assert.deepEqual(await statusOf(h, job), ['done', 'done', at(5)]);
  assert.deepEqual([lines(h)[0]!['state'], lines(h)[0]!['targets'], lines(h)[0]!['by_git_service'], lines(h)[0]!['failed']], ['merged', 3, 1, 0]);

  // Asked again: the one that stood is read again, and neither recorded nor alerted a second time.
  const again = await h.job(30);
  await h.run(again);
  assert.equal(named(h, 'dismissReview').length, 0);
  assert.deepEqual(await runRows(h.db), after);
  assert.equal(h.alerts.length, 1);
});

test('the sweep asks for each open pull request with a failed withdrawal, and leaves a closed or merged one recorded as it is', async () => {
  const h = await harness();
  await posted(h.db, '500');
  h.queries.length = 0;
  // No failed withdrawal: nothing of the pull requests is read.
  assert.equal(await sweepWithdraw(h.deps.db, at(40)), 0);
  assert.deepEqual(h.queries.filter((q) => q.includes('pull_requests')), []);

  const failed: Record<number, number> = {};
  for (const [number, state] of [[7, 'open'], [8, 'closed'], [9, 'merged'], [11, null]] as const) {
    if (state !== null && number !== 7) await storePullRequest(h.db, number, state);
    const id = await posted(h.db, `6${number}`, { ref: { ...REF, number } });
    await markDismissFailed(h.db, id, 'github_403');
    failed[number] = id;
  }
  // Open, with a standing approval but no failure: not asked.
  await storePullRequest(h.db, 10, 'open');
  await posted(h.db, '610', { ref: { ...REF, number: 10 } });
  h.queries.length = 0;
  assert.equal(await sweepWithdraw(h.deps.db, at(50)), 1);
  assert.deepEqual(
    await h.db.query("select number, reason, status, installation, run_at from visto_ai.jobs where kind = 'withdraw' order by id"),
    [{ number: 7, reason: 'withdraw', status: 'pending', installation: null, run_at: new Date(at(50)) }]);
  // The stored pull request is read for each failed withdrawal only: 7, 8, 9 and 11.
  assert.equal(h.queries.filter((q) => q.includes('from visto_ai.pull_requests')).length, 4);
  const rows = await h.db.query<{ id: number; dismiss_failure: string | null }>('select id, dismiss_failure from visto_ai.review_runs order by id');
  for (const number of [8, 9, 11]) assert.deepEqual(rows.find((r) => r.id === failed[number]), { id: failed[number], dismiss_failure: 'github_403' });
});

test('the log line holds ids, counts and codes only', async () => {
  const h = await harness({ dismissals: { '502': [new Error('github_403')] } });
  await posted(h.db, '501');
  await posted(h.db, '502');
  const job = await h.job(5);
  await h.run(job);
  assert.deepEqual(h.logs, [{
    event: 'withdraw', job: job.id, repo: 'acme/shop', number: 7, state: 'open', standing: 2, targets: 2, dismissed: 1, by_git_service: 0,
    failed: 1, code: 'github_403', outcome: 'put_back', requeued: true,
  }]);
  const text = JSON.stringify(h.logs);
  for (const word of ['octo-', 'h1', 'h2', 'main', 'feat', 'This approval']) assert.equal(text.includes(word), false, word);

  // A logger and an alert that throw change nothing: the give-up is recorded and the job finished.
  const loud = await harness({ throwing: true, dismissals: { '501': [new Error('github_403')] } });
  const id = await posted(loud.db, '501');
  const last = await loud.job(5, { starts: 3 });
  await loud.run(last);
  assert.deepEqual(await statusOf(loud, last), ['done', 'failed', at(5)]);
  assert.deepEqual(await runRows(loud.db), [row(id, { dismiss_failure: 'github_403' })]);
  assert.deepEqual([loud.alerts.length, loud.logs.length, loud.queued()], [1, 1, 1]);
});

test('a live state of no known kind is a failure, never read as a merge', async () => {
  const odd = { ...liveOf({ head: 'h2' }), state: 'locked' } as unknown as LivePullRequest;
  const h = await harness({ live: [odd] });
  const id = await posted(h.db, '501');
  const job = await h.job(5, { starts: 3 });
  await h.run(job);
  assert.deepEqual(h.calls, [['readPullRequest', REF, '99']]);
  assert.deepEqual(await runRows(h.db), [row(id, { dismiss_failure: 'internal_error' })]);
  assert.deepEqual(h.alerts, [['dismissal_failed', { reason: 'internal_error', repo: 'acme/shop', number: 7 }]]);
  assert.deepEqual(await statusOf(h, job), ['done', 'failed', at(5)]);
  assert.equal(lines(h)[0]!['state'], null);
});

test('a give-up records its failures before the job is finished: a refused record still alerts once and asks the gate', async () => {
  const h = await harness({ failQuery: 'set dismiss_failure = $2', dismissals: { '501': [new Error('github_403')] } });
  const id = await posted(h.db, '501');
  const job = await h.job(5, { starts: 3 });
  await h.run(job);
  assert.deepEqual(await statusOf(h, job), ['done', 'failed', at(5)]);
  assert.deepEqual(await runRows(h.db), [row(id)]);
  assert.deepEqual(h.alerts, [['dismissal_failed', { reason: 'github_403', repo: 'acme/shop', number: 7 }]]);
  assert.deepEqual(await gateJobs(h.db), [{ reason: 'sync', status: 'pending', installation: '99' }]);
  assert.equal(h.queued(), 1);
  // The records came first: the finish was the job's last statement.
  const marks = h.queries.findIndex((q) => q.includes('set dismiss_failure = $2'));
  const finish = h.queries.findIndex((q) => q.includes("status in ('pending', 'running')") && q.includes('outcome = $3'));
  assert.ok(marks >= 0 && finish > marks);
});

test('at the give-up a read of the standing approvals that rejects again counts as new: raised, and the gate asked', async () => {
  const h = await harness({ failQuery: 'review_id is not null' });
  await posted(h.db, '501');
  const job = await h.job(5, { starts: 3 });
  await h.run(job);
  // The job's read and the give-up's read both rejected: nothing could be recorded, and GitHub was not read.
  assert.equal(h.queries.filter((q) => q.includes('review_id is not null')).length, 2);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.alerts, [['dismissal_failed', { reason: 'db_down', repo: 'acme/shop', number: 7 }]]);
  // Gated by the stored base branch, with the job's installation.
  assert.deepEqual(await gateJobs(h.db), [{ reason: 'sync', status: 'pending', installation: '99' }]);
  assert.equal(h.queued(), 1);
  assert.deepEqual(await statusOf(h, job), ['done', 'failed', at(5)]);
});

test('a give-up whose records are written is recorded though the job was finished meanwhile', async () => {
  const h = await harness({ dismissals: { '501': [new Error('github_403')] } });
  const id = await posted(h.db, '501');
  const job = await h.job(5, { starts: 3 });
  assert.equal(await finishJob(h.db, job.id, 'dropped', 'superseded', at(5)), true);
  await h.run(job);
  assert.deepEqual(await statusOf(h, job), ['dropped', 'superseded', at(5)]);
  assert.deepEqual(await runRows(h.db), [row(id, { dismiss_failure: 'github_403' })]);
  assert.deepEqual(h.alerts, [['dismissal_failed', { reason: 'github_403', repo: 'acme/shop', number: 7 }]]);
  assert.deepEqual([lines(h)[0]!['outcome'], lines(h)[0]!['requeued'], h.queued()], [null, false, 1]);
});

test('a failure recorded on an approval at the live head ends when a later job finds it dismissed by hand', async () => {
  // The withdraw job asked after the approving publication cannot read the pull request at its third start.
  const h = await harness({ live: [new Error('github_502'), liveOf()], reviews: { '501': [DISMISSED] } });
  const id = await posted(h.db, '501');
  await h.run(await h.job(5, { starts: 3 }));
  assert.deepEqual(await runRows(h.db), [row(id, { dismiss_failure: 'github_502' })]);
  assert.deepEqual([h.alerts.length, h.queued()], [1, 1]);

  // A person dismisses it by hand; the next job reads it, though it is at the live head and the newest review.
  const next = await h.job(200);
  await h.run(next);
  assert.deepEqual(named(h, 'readReview'), [['readReview', '501']]);
  assert.equal(named(h, 'dismissReview').length, 0);
  assert.deepEqual(await runRows(h.db), [row(id, { dismissed_at: new Date(at(200)), dismissed_by: 'git_service' })]);
  assert.deepEqual(await statusOf(h, next), ['done', 'done', at(200)]);
  assert.deepEqual([lines(h)[1]!['targets'], lines(h)[1]!['by_git_service'], h.alerts.length, h.queued()], [0, 1, 1, 2]);
});

test('a failure recorded on an approval that is no longer a target is cleared when GitHub still holds it approved', async () => {
  const h = await harness({ live: [liveOf()], dismissals: { '501': [new Error('github_403')] } });
  const approval = await posted(h.db, '501');
  // A later comment of the same head makes it a target (call 11), and its dismissal fails three times.
  const comment = await posted(h.db, '502', { approved: false });
  await h.run(await h.job(5, { starts: 3 }));
  assert.equal((await runRows(h.db))[0]!.dismiss_failure, 'github_403');
  assert.deepEqual([h.alerts.length, h.queued()], [1, 1]);

  // /review approves the same head again: the first approval is no target, holds on GitHub, and its failure ends.
  const again = await posted(h.db, '503');
  const next = await h.job(200);
  await h.run(next);
  assert.deepEqual(named(h, 'readReview').slice(-1), [['readReview', '501']]);
  assert.equal(named(h, 'dismissReview').length, 1);
  assert.deepEqual(await runRows(h.db), [row(approval), row(comment), row(again)]);
  assert.deepEqual(await statusOf(h, next), ['done', 'done', at(200)]);
  assert.deepEqual([lines(h)[1]!['targets'], lines(h)[1]!['failed'], h.alerts.length, h.queued()], [0, 0, 1, 2]);
});

test('an approval no longer targeted whose failure cannot be read again stays recorded, with no new alert', async () => {
  const answers: Array<[ReviewAnswer, string]> = [
    [new Error('github_500'), 'github_500'], [null, 'review_not_found'], [{ state: 'other', commit: 'h1' }, 'review_state_other'],
  ];
  for (const [answer, code] of answers) {
    const h = await harness({ live: [liveOf()], reviews: { '501': [answer] } });
    const id = await posted(h.db, '501');
    assert.equal(await markDismissFailed(h.db, id, 'github_502'), true);
    const first = await h.job(5);
    await h.run(first);
    assert.deepEqual(await statusOf(h, first), ['pending', null, at(15)], code);
    assert.deepEqual([lines(h)[0]!['targets'], lines(h)[0]!['failed'], lines(h)[0]!['code']], [0, 1, code]);
    await h.db.query('update visto_ai.jobs set starts = 2 where id = $1', [first.id]);
    const last = await h.claim(15);
    await h.run(last!);
    assert.deepEqual(await statusOf(h, last!), ['done', 'failed', at(15)], code);
    // Still recorded, now with the code of the last failed withdrawal; the failure is not new, so nothing is alerted or asked.
    assert.deepEqual(await runRows(h.db), [row(id, { dismiss_failure: code })], code);
    assert.deepEqual([h.alerts, h.queued(), named(h, 'dismissReview').length], [[], 0, 0], code);
  }
});

test('the gate is not asked for a pull request whose base branch is not gated', async () => {
  const h = await harness({ live: [liveOf({ head: 'h2', baseBranch: 'release/1.0' })] });
  const id = await posted(h.db, '501', { baseBranch: 'release/1.0' });
  await h.run(await h.job(5));
  assert.deepEqual(await runRows(h.db), [row(id, { dismissed_at: new Date(at(5)), dismissed_by: 'app' })]);
  assert.deepEqual([await gateJobs(h.db), h.queued()], [[], 0]);
});

test('at a merge, an approval at the merged head for another base branch is recorded and alerted once', async () => {
  const h = await harness({ live: [liveOf({ head: 'h2', state: 'merged' })] });
  const id = await posted(h.db, '501', { headSha: 'h2', baseBranch: 'release/1.0' });
  const job = await h.job(5);
  await h.run(job);
  assert.deepEqual(h.calls, [['readPullRequest', REF, '99'], ['readReview', '501']]);
  assert.deepEqual([await runRows(h.db), h.alerts], [[row(id, { stood_at_merge: new Date(at(5)) })], [['stale_approval_merged', { repo: 'acme/shop', number: 7 }]]]);
  assert.deepEqual(await statusOf(h, job), ['done', 'done', at(5)]);
  assert.deepEqual([lines(h)[0]!['state'], lines(h)[0]!['targets']], ['merged', 1]);
});

test('at a merge, an approval a later review of the same head did not approve is recorded and alerted once, and never dismissed', async () => {
  const h = await harness({ live: [liveOf({ head: 'h1', state: 'merged' })] });
  const stale = await posted(h.db, '501');
  const comment = await posted(h.db, '502', { approved: false });
  const job = await h.job(5);
  await h.run(job);
  assert.deepEqual(h.calls, [['readPullRequest', REF, '99'], ['readReview', '501']]);
  assert.deepEqual(await runRows(h.db), [row(stale, { stood_at_merge: new Date(at(5)) }), row(comment)]);
  assert.deepEqual(h.alerts, [['stale_approval_merged', { repo: 'acme/shop', number: 7 }]]);
  assert.deepEqual(await statusOf(h, job), ['done', 'done', at(5)]);
  assert.deepEqual([lines(h)[0]!['state'], lines(h)[0]!['targets']], ['merged', 1]);

  // Asked again: read again, and neither recorded nor alerted a second time.
  await h.run(await h.job(30));
  assert.deepEqual([named(h, 'readReview').length, named(h, 'dismissReview').length, h.alerts.length], [2, 0, 1]);
});

test('at a merge, an approval of the merged head and base is left while the newest review is an approval that stands', async () => {
  const h = await harness({ live: [liveOf({ head: 'h2', state: 'merged' })] });
  const id = await posted(h.db, '501', { headSha: 'h2' });
  const job = await h.job(5);
  await h.run(job);
  assert.deepEqual(h.calls, [['readPullRequest', REF, '99']]);
  assert.deepEqual([await runRows(h.db), h.alerts], [[row(id)], []]);
  assert.deepEqual(await statusOf(h, job), ['done', 'kept', at(5)]);
});

test('at the give-up each failed target records its own code', async () => {
  const h = await harness({ reviews: { '501': [null] }, dismissals: { '502': [new Error('github_403')] } });
  const first = await posted(h.db, '501');
  const second = await posted(h.db, '502');
  await h.run(await h.job(5, { starts: 3 }));
  assert.deepEqual(await runRows(h.db), [row(first, { dismiss_failure: 'review_not_found' }), row(second, { dismiss_failure: 'github_403' })]);
  assert.deepEqual(h.alerts, [['dismissal_failed', { reason: 'review_not_found', repo: 'acme/shop', number: 7 }]]);
});

test('a record that changes nothing is not counted', async () => {
  const h = await harness({ reviews: { '501': [DISMISSED] } });
  const gone = await posted(h.db, '501');
  const taken = await posted(h.db, '502');
  // Another job records each one first, as GitHub answers this one.
  const { readReview, dismissReview } = h.deps.approvals;
  h.deps.approvals.readReview = async (ref, installation, reviewId) => {
    if (reviewId === '501') await markDismissed(h.db, gone, at(4), 'git_service');
    return readReview(ref, installation, reviewId);
  };
  h.deps.approvals.dismissReview = async (ref, installation, reviewId, message) => {
    await markDismissed(h.db, taken, at(4), 'app');
    return dismissReview(ref, installation, reviewId, message);
  };
  const job = await h.job(5);
  await h.run(job);
  assert.deepEqual(await runRows(h.db), [
    row(gone, { dismissed_at: new Date(at(4)), dismissed_by: 'git_service' }), row(taken, { dismissed_at: new Date(at(4)), dismissed_by: 'app' }),
  ]);
  assert.deepEqual(await statusOf(h, job), ['done', 'done', at(5)]);
  assert.deepEqual([lines(h)[0]!['targets'], lines(h)[0]!['dismissed'], lines(h)[0]!['by_git_service'], lines(h)[0]!['failed']], [2, 0, 0, 0]);
});

test('a clock that throws when the job is put back changes nothing', async () => {
  const h = await harness({ clockThrows: true, dismissals: { '501': [new Error('github_403')] } });
  await posted(h.db, '501');
  const job = await h.job(5);
  await h.run(job);
  assert.equal((await getJob(h.db, job.id))!.status, 'pending');
  assert.deepEqual([lines(h)[0]!['outcome'], lines(h)[0]!['requeued'], lines(h)[0]!['code']], ['put_back', true, 'github_403']);
});
test("a withdrawal put back after a failed try keeps that try's code on its row", async () => {
  const h = await harness({ dismissals: { '501': [new Error('github_403')] } });
  await posted(h.db, '501');
  const first = await h.job(0);
  await h.run(first);
  assert.deepEqual(await statusOf(h, first), ['pending', null, at(10)]);
  assert.deepEqual(
    await h.db.query('select retry_code from visto_ai.jobs where id = $1', [first.id]),
    [{ retry_code: 'github_403' }]);
  assert.deepEqual([lines(h)[0]!['outcome'], lines(h)[0]!['code']], ['put_back', 'github_403']);
});
