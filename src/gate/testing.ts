import { GATE_OFF } from '../config/load.ts';
import type { GateSettings, RepoSettings } from '../config/load.ts';
import { askGate, claimJob, enqueueJob } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { recordComments } from '../db/review-comments.ts';
import type { StoredComment } from '../db/review-comments.ts';
import { markPublished, recordRun } from '../db/review-runs.ts';
import type { RunRecord } from '../db/review-runs.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import type { CheckWrite, LivePullRequest, OwnCheck, PullRequestRef, ReviewThread, ThreadComment } from '../forge/types.ts';
import { runGateJob } from './job.ts';
import type { GateJobDeps } from './job.ts';
import { createKeyedLock } from './lock.ts';
import type { KeyedLock } from './lock.ts';

export const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
export const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
export const commentUrl = (_ref: PullRequestRef, id: string): string => `https://git.example.test/c/${id}`;

/** The gate enabled on main, in enforce. */
export const GATE_ON: GateSettings = { ...GATE_OFF, enabled: true, branches: ['main'] };
export const SETTINGS: RepoSettings = {
  primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: [], baseBranches: [], newHead: null, inlineNotes: false, gate: GATE_ON,
};
export const withGate = (over: Partial<GateSettings>): RepoSettings => ({ ...SETTINGS, gate: { ...GATE_ON, ...over } });

/** The pull request as GitHub has it: open, against main, head h1, merge base merge000. */
export function liveOf(over: { number?: number; head?: string; base?: string; baseBranch?: string; state?: LivePullRequest['state'] } = {}): LivePullRequest {
  return {
    info: {
      ref: { ...REF, number: over.number ?? REF.number }, title: 'Add things', description: '', author: 'octo-dev',
      baseBranch: over.baseBranch ?? 'main', headBranch: 'feat', baseSha: over.base ?? 'merge000', headSha: over.head ?? 'h1', draft: false,
    },
    state: over.state ?? 'open',
  };
}

const USAGE = { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 };
export const FINDING_BODY = '**[major]** Check the total.';

/** A finding as a run's result holds it, at src/a.ts line 12. */
export const finding = (severity: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ path: 'src/a.ts', side: 'RIGHT', line: 12, severity, body: 'Check the total.', quote: 'total = a + b', requestedLine: null, ...over });

/**
 * Stores a run at h1 against merge000 that read src/a.ts and holds one major finding, and publishes it as review 501
 * unless `publish` is false. Its id is returned.
 */
export async function storeRun(db: Db, over: Partial<RunRecord> & {
  findings?: unknown[]; verdicts?: unknown[]; publish?: { reviewId?: string; inlineDropped?: boolean } | false;
} = {}): Promise<number> {
  const { findings, verdicts, publish, ...rest } = over;
  const list = findings ?? [finding('major')];
  const id = await recordRun(db, {
    ref: REF, job: null, trigger: 'manual', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'merge000', baseBranch: 'main',
    outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 10, body: 'A review.',
    comments: list.map(() => ({ path: 'src/a.ts', side: 'RIGHT', line: 12, body: FINDING_BODY })),
    result: { findings: list, coverage: { reviewed: ['src/a.ts'], notReviewed: [] }, threadVerdicts: verdicts ?? [] },
    usage: USAGE, startedAt: at(0), finishedAt: at(1), ...rest,
  });
  if (publish !== false) {
    await markPublished(db, id, { reviewId: publish?.reviewId ?? '501', publishedAt: at(2), body: 'A review.', inlineDropped: publish?.inlineDropped ?? false });
  }
  return id;
}

/** Stores the first comment of a run's thread: 8001 at src/a.ts line 12. */
export async function storeComment(db: Db, run: number, severity: string, over: Partial<StoredComment> = {}): Promise<void> {
  await recordComments(db, run, REF, [{ commentId: '8001', path: 'src/a.ts', side: 'RIGHT', line: 12, severity, quote: 'total = a + b', ...over }]);
}

export const appComment = (id: string, over: Partial<ThreadComment> = {}): ThreadComment =>
  ({ id, node: `N${id}`, author: 'visto-test[bot]', authorIsBot: true, byApp: true, reviewId: '501', body: FINDING_BODY, at: at(2), ...over });
export const reply = (author: string, over: Partial<ThreadComment> = {}): ThreadComment =>
  ({ id: '9001', node: 'N9001', author, authorIsBot: false, byApp: false, reviewId: null, body: 'Meant to be so.', at: at(100), ...over });
/** An open thread of the app at src/a.ts line 12 whose first comment is 8001. */
export const thread = (over: Partial<ReviewThread> = {}): ReviewThread =>
  ({ id: 'PRRT_1', path: 'src/a.ts', side: 'RIGHT', line: 12, resolved: false, resolvedByApp: false, comments: [appComment('8001')], ...over });

export interface HarnessOptions {
  /** What readPullRequest answers; an Error rejects. liveOf() when not given. */
  live?: LivePullRequest | Error | null;
  /** The gate enabled on main when not given. */
  settings?: RepoSettings;
  /** The check GitHub holds on the live head under the check's name, or an Error that findCheck rejects with. None when not given. */
  check?: OwnCheck | Error | null;
  /** What listThreads answers, one answer for each call, the last one repeated; an Error rejects. [] when not given. */
  threads?: Array<ReviewThread[] | Error>;
  /** The first writes reject with these, one each. */
  writeFailures?: Error[];
  /** What paused() answers; null when not given. */
  paused?: string | null;
  /** What reviewing() answers; true when not given. */
  reviewing?: boolean;
  /** The job's reason; sync when not given. */
  reason?: string;
  dryRun?: boolean;
  /** The job's starts once claimed; 1 when not given. */
  starts?: number;
  /** Each fake waits one turn of the event loop before it answers. */
  slow?: boolean;
  /** The installation stored with the pull request; '99' when not given. */
  installation?: string | null;
  /** Every statement whose text holds this rejects. */
  failQuery?: string;
  /** The lock the job is given; a new one when not given. */
  lock?: KeyedLock;
}

export interface Harness {
  /** The database as the test sees it; the job is given one that may reject (failQuery). */
  db: Db;
  deps: GateJobDeps;
  /** Every call of a fake, as [name, ...args]. */
  calls: unknown[][];
  logs: Array<Record<string, unknown>>;
  alerts: Array<[string, Record<string, string | number | boolean | null> | undefined]>;
  /** The claimed job. */
  job: Job;
  /** The checks GitHub holds, by commit. */
  held: Map<string, OwnCheck>;
  /** How many times onQueued was called. */
  queued(): number;
  setNow(iso: string): void;
  /** Runs the claimed job, or the one given. */
  run(job?: Job): Promise<void>;
  /** Claims the pending gate job of the pull request at this time (which the clock then reads); null when there is none or it is not due. */
  claimNext(iso: string, number?: number): Promise<Job | null>;
  /** Stores the pull request `number` with the same facts, and stores and claims one sync for it. */
  another(number: number): Promise<Job>;
  close(): Promise<void>;
}

const open = new Set<Db>();

/** Closes every database a harness made. */
export async function closeHarnesses(): Promise<void> {
  const all = [...open];
  open.clear();
  for (const db of all) await db.close();
}

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const db = await testDb();
  open.add(db);
  const calls: unknown[][] = [];
  const logs: Array<Record<string, unknown>> = [];
  const alerts: Harness['alerts'] = [];
  const held = new Map<string, OwnCheck>();
  const settings = options.settings ?? SETTINGS;
  const live = 'live' in options ? options.live ?? null : liveOf();
  const liveHead = live instanceof Error || live === null ? 'h1' : live.info.headSha;
  if (options.check !== undefined && options.check !== null && !(options.check instanceof Error)) held.set(liveHead, options.check);
  const threads = options.threads ?? [[]];
  const writeFailures = [...(options.writeFailures ?? [])];
  let threadCalls = 0;
  let nextId = 701;
  let queued = 0;
  let now = new Date(at(0));
  const wait = async (): Promise<void> => { if (options.slow === true) await turn(); };

  const jobDb: Db = options.failQuery === undefined ? db : {
    query: <Row>(text: string, params?: unknown[]) => (text.includes(options.failQuery!) ? Promise.reject(new Error('db_down')) : db.query<Row>(text, params)),
    script: (sql) => db.script(sql),
    transaction: (work) => db.transaction(work),
    close: () => db.close(),
  };

  const deps: GateJobDeps = {
    db: jobDb,
    forge: {
      async readPullRequest(ref, installation) {
        calls.push(['readPullRequest', ref, installation]);
        await wait();
        if (live instanceof Error) throw live;
        if (live === null) return null;
        return { ...live, info: { ...live.info, ref: { ...live.info.ref, number: ref.number } } };
      },
      async sourceFor() { throw new Error('not_used'); },
    },
    checks: {
      async findCheck(ref, installation, commit, name) {
        calls.push(['findCheck', ref, installation, commit, name]);
        await wait();
        if (options.check instanceof Error) throw options.check;
        return name === settings.gate.checkName ? held.get(commit) ?? null : null;
      },
      async writeCheck(ref, installation, check: CheckWrite) {
        calls.push(['writeCheck', ref, installation, check]);
        await wait();
        const failure = writeFailures.shift();
        if (failure !== undefined) throw failure;
        const id = check.id ?? String(nextId++);
        held.set(check.commit, { id, status: check.status, conclusion: check.conclusion, title: check.title, summary: check.summary });
        return { id };
      },
      async greenChecks() { throw new Error('not_used'); },
      async isTeamMember() { throw new Error('not_used'); },
    },
    writer: {
      async listThreads(ref, installation) {
        calls.push(['listThreads', ref, installation]);
        await wait();
        const answer = threads[Math.min(threadCalls, threads.length - 1)]!;
        threadCalls += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      async react() { throw new Error('not_used'); },
      async comment() { throw new Error('not_used'); },
    },
    clock: () => now,
    log: (entry) => { logs.push(entry); },
    settingsFor: () => settings,
    dryRun: options.dryRun ?? false,
    paused: async () => {
      calls.push(['paused']);
      return options.paused ?? null;
    },
    reviewing: () => options.reviewing ?? true,
    commentUrl,
    alert: (code, details) => { alerts.push([code, details]); },
    lock: options.lock ?? createKeyedLock(),
    onQueued: () => { queued += 1; },
  };

  const store = async (number: number): Promise<Job> => {
    const ref = { ...REF, number };
    await savePullRequest(db, {
      ref, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: liveHead, draft: false, state: 'open',
      mergedAt: null, closedAt: null, mergeCommit: null, installation: 'installation' in options ? options.installation ?? null : '99', updatedAt: at(0),
    });
    const reason = options.reason ?? 'sync';
    const id = reason === 'sync'
      ? await askGate(db, ref, at(0))
      : await enqueueJob(db, {
        ref, kind: 'gate', reason, headSha: liveHead, runAt: at(0), now: at(0), delivery: 'd1', replace: true,
        trigger: 'manual', requestedBy: 'octo-lead', commentId: '31', association: 'member', installation: null,
      });
    const starts = options.starts ?? 1;
    if (starts > 1) await db.query('update visto_ai.jobs set starts = $2 where id = $1', [id, starts - 1]);
    return (await claimJob(db, id!, at(0)))!;
  };

  const job = await store(REF.number);
  return {
    db, deps, calls, logs, alerts, job, held,
    queued: () => queued,
    setNow: (iso) => { now = new Date(iso); },
    run: (j) => runGateJob(j ?? job, deps),
    async claimNext(iso, number = REF.number) {
      now = new Date(iso);
      const rows = await db.query<{ id: number }>(
        "select id from visto_ai.jobs where kind = 'gate' and status = 'pending' and number = $1", [number]);
      return rows[0] === undefined ? null : claimJob(db, rows[0].id, iso);
    },
    another: (number) => store(number),
    close: async () => { open.delete(db); await db.close(); },
  };
}
