import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { pgliteDb } from './db/pglite.ts';
import type { Db, InstanceLock } from './db/types.ts';
import { loadMigrations, MIGRATIONS_DIR, migrate } from './db/migrate.ts';
import { askGate, claimJob, enqueueJob, finishJob, getJob, unfinishedJobs } from './db/jobs.ts';
import type { Job } from './db/jobs.ts';
import { savePullRequest } from './db/pull-requests.ts';
import { NO_COUNTS, recordEvaluation } from './db/gate.ts';
import { recordRun } from './db/review-runs.ts';
import type { RunRecord } from './db/review-runs.ts';
import { beat, readHeartbeat } from './db/heartbeat.ts';
import { serviceConfig, parseConfig } from './config/load.ts';
import type { AppIdentity, FeatureOff, ForgeEvent, HookDelivery, LivePullRequest, OwnCheck, PostedComment, PullRequestAction, PullRequestFacts, ReviewThread, Source } from './forge/types.ts';
import type { ReviewDeps, ReviewInput, ReviewResult } from './engine/types.ts';
import { BEAT_MS, CLOSE_WAIT_MS, DRAIN_WAIT_MS, startService, STOP_WAIT_MS, TICK_MS, UPKEEP_MS } from './service.ts';
import type { Listening } from './service.ts';
import type { RequestLike, ResponseLike } from './shell/http.ts';
import { checkText } from './gate/check.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const job = (over = {}) => ({ ref: REF, reason: 'opened', headSha: 'h1', runAt: at(0), now: at(0), delivery: 'd1', replace: true,
  trigger: 'automatic' as const, requestedBy: null, commentId: null, association: null, installation: null, ...over });
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: true, headSha: 'h1', baseSha: 'b1', baseBranch: null,
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [{ path: 'a.ts', side: 'RIGHT', line: 3, body: 'note' }], result: { findings: [] },
  usage: { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.0375 },
  startedAt: at(0), finishedAt: at(90), ...over,
});
const facts = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref: REF, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: 'h1', draft: false,
  state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0), ...over,
});
type PullRequestEvent = Extract<ForgeEvent, { kind: 'pull_request' }>;
const pr = (action: PullRequestAction, over: Partial<PullRequestFacts> = {}): PullRequestEvent => ({ kind: 'pull_request', action, facts: facts(over) });
const PING = { kind: 'ping' } as ForgeEvent;
const LIVE: LivePullRequest = {
  info: { ref: REF, title: 'Add things', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'merge000', headSha: 'h1', draft: false },
  state: 'open',
};
const USAGE = { calls: 2, inputTokens: 1000, outputTokens: 200, cachedTokens: 50, cost: 0.5 };
const okResult = (): ReviewResult => ({
  status: 'ok', failure: null, mode: 'full', overview: 'Looks fine.',
  findings: [{ path: 'a.ts', side: 'RIGHT', line: 3, severity: 'minor', body: 'A note.', quote: 'x', requestedLine: null }],
  unplaced: [], beyondDiff: [], coverage: { reviewed: ['a.ts'], notReviewed: [] }, usage: USAGE, models: ['m'], providers: [],
  dependencies: { model: 'ok' }, audit: [], scores: [], verdict: { threshold: 70, needsHuman: false, highest: 35 }, teamFileInvalid: null,
});

const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const BASE_YAML = 'model:\n  apiKey: { env: K }\n  model: vendor/model-a\napp:\n  id: 12345\n  privateKey: { env: A }\n  webhookSecret: { env: S }\ndatabase:\n  url: { env: U }\nserver:\n  port: 9191\nlimits:\n  spendPerDay: 50\ndryRun: true\n';
const ENV = { K: 'k', A: appKey, S: 's', U: 'postgres://u:p@db.example.test/d' };
const config = serviceConfig(parseConfig(BASE_YAML, ENV));
/** The gate enabled on main for every repository. */
const GATE_YAML = 'repositories:\n  defaults: { gate: { enabled: true, branches: [main] } }\n';

const never = (): Promise<never> => new Promise(() => {});

interface Options {
  lock?: null; listenError?: Error; now?: string; holdReview?: boolean;
  listings?: Array<{ deliveries: HookDelivery[]; complete: boolean } | Error>;
  migrationError?: Error; closeNever?: boolean; closeError?: Error; listenerCloseError?: Error; logThrows?: boolean;
  /** The status the model endpoint's key route answers with; 200 when not given. */
  keyStatus?: number;
  /** What the app lacks; an Error makes the check reject. Nothing when not given. */
  lacks?: FeatureOff[] | Error;
  /** false to leave dry run; true when not given. */
  dryRun?: boolean;
  /** Repository settings added to the deployment file (the text after `dryRun: true`). */
  repositoriesYaml?: string;
  /** The key route's answer waits for this when given. */
  keyGate?: Promise<void>;
  /** The gate enabled on main (GATE_YAML); it also leaves dry run unless `dryRun` is given. */
  gate?: boolean;
  /** What the writer's listThreads answers; it rejects when not given. */
  threads?: ReviewThread[];
  /** Every statement outside a transaction whose text holds this rejects. */
  failQuery?: string;
  /** What the review answers; okResult() when not given. */
  result?: ReviewResult;
  /** findCheck waits for this when given. */
  holdCheck?: Promise<void>;
  /** A fake GitHub that keeps each posted review's inline comments, reads them back, and opens a thread for each (`h.threads`, a list from the start). */
  github?: boolean;
  /** What isTeamMember answers; it rejects when not given. */
  member?: boolean;
}
interface Timer { ms: number; work: () => Promise<void>; cancelled: boolean }

const opened: Db[] = [];
const started: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const service of started.splice(0)) await service.stop();
  for (const db of opened.splice(0)) await db.close();
});

async function harness(options: Options = {}) {
  const real = await pgliteDb();
  opened.push(real);
  const events: string[] = [];
  const timers: Timer[] = [];
  const inputs: ReviewInput[] = [];
  const fetched: string[] = [];
  const listedSince: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const writes: unknown[][] = [];
  const listings = [...(options.listings ?? [])];
  /** The text of every statement outside a transaction. */
  const queries: string[] = [];
  let listener: ((req: RequestLike, res: ResponseLike) => void) | null = null;
  let current: ForgeEvent = PING;
  let delivered = 'd-1';
  let releaseReview!: () => void;
  const reviewHeld = new Promise<void>((done) => { releaseReview = done; });
  let reviewCalled!: () => void;
  const reviewed = new Promise<void>((done) => { reviewCalled = done; });
  let publishCalled!: () => void;
  const published = new Promise<void>((done) => { publishCalled = done; });
  const order: string[] = [];
  const lacksCalls: boolean[] = [];
  const gateCalls: unknown[] = [];
  /** Every call of the checks, as [name, ...args]. */
  const checked: unknown[][] = [];
  /** The checks GitHub holds, by commit. */
  const held = new Map<string, OwnCheck>();
  /** The inline comments of each review posted, by the review's id. */
  const postedComments = new Map<string, PostedComment[]>();
  let reviewsPosted = 0;
  let commentsPosted = 0;
  const appInfo: AppIdentity = {
    read: () => Promise.reject(new Error('not_used')),
    canResolve: () => Promise.resolve(false),
    lacks: (dryRun, gate) => (order.push('lacks'), lacksCalls.push(dryRun), gateCalls.push(gate), options.lacks instanceof Error ? Promise.reject(options.lacks) : Promise.resolve(options.lacks ?? [])),
  };

  const db: Db = {
    query: (text, params) => (queries.push(text), options.failQuery !== undefined && text.includes(options.failQuery) ? Promise.reject(new Error('db_down')) : real.query(text, params)),
    script: (sql) => (options.migrationError === undefined ? real.script(sql) : Promise.reject(options.migrationError)),
    transaction: async (work) => {
      if (h.beforeTransaction !== undefined) await h.beforeTransaction();
      return real.transaction(work);
    },
    close: () => {
      events.push('close');
      if (options.closeNever === true) return never();
      if (options.closeError !== undefined) return Promise.reject(options.closeError);
      return Promise.resolve();
    },
  };
  const lock: InstanceLock = { release: async () => { events.push('release'); } };

  const h = {
    db, queries, events, order, lacksCalls, gateCalls, checked, held, timers, inputs, fetched, listedSince, logged, writes,
    port: 0,
    /** What the clock reads; a test may move it. */
    now: options.now ?? at(0),
    /** The pull request as GitHub has it now; a test may move its head. */
    live: LIVE as LivePullRequest,
    /** The threads GitHub has; listThreads rejects while this is undefined. */
    threads: options.threads ?? (options.github === true ? [] : undefined) as ReviewThread[] | undefined,
    onListen: undefined as (() => Promise<void>) | undefined,
    beforeListing: undefined as (() => Promise<void>) | undefined,
    beforeTransaction: undefined as (() => Promise<void>) | undefined,
    releaseReview: () => { releaseReview(); },
    reviewed: () => reviewed,
    published: () => published,
    start: async () => {
      const yaml = options.repositoriesYaml ?? (options.gate === true ? GATE_YAML : undefined);
      const base = yaml === undefined ? config : serviceConfig(parseConfig(BASE_YAML + yaml, ENV));
      const dry = options.dryRun ?? options.gate !== true;
      const service = await startService(dry ? base : { ...base, dryRun: false }, {
      db, appInfo,
      reader: { read: () => ({ ok: true as const, delivery: delivered, name: current.kind, action: current.kind === 'pull_request' ? current.action : null, event: current }) },
      clock: () => new Date(h.now),
      log: (e) => { logged.push(e); if (options.logThrows === true) throw new Error('logger down'); },
      listen: async (l, p) => {
        events.push('listen');
        listener = l;
        h.port = p;
        if (h.onListen !== undefined) await h.onListen();
        if (options.listenError !== undefined) throw options.listenError;
        const listening: Listening = {
          close: () => {
            events.push('listener-close');
            return options.listenerCloseError === undefined ? Promise.resolve() : Promise.reject(options.listenerCloseError);
          },
        };
        return listening;
      },
      takeLock: async () => {
        events.push('lock');
        return options.lock === null ? null : lock;
      },
      forge: { readPullRequest: () => Promise.resolve(h.live), sourceFor: () => Promise.resolve({} as Source) },
      hooks: {
        listSince: async (since) => {
          listedSince.push(since);
          order.push('listing');
          if (h.beforeListing !== undefined) await h.beforeListing();
          const next = listings.shift() ?? { deliveries: [], complete: true };
          if (next instanceof Error) throw next;
          return next;
        },
        redeliver: () => Promise.resolve(),
      },
      writer: {
        publishReview: async (_ref, _installation, draft) => {
          writes.push(['publishReview', draft.commit]);
          const id = String(501 + reviewsPosted);
          reviewsPosted += 1;
          if (options.github === true) {
            const posted = draft.comments.map((c) => {
              const commentId = String(8001 + commentsPosted);
              commentsPosted += 1;
              h.threads!.push({ id: `t${commentId}`, path: c.path, side: c.side, line: c.line, resolved: false, resolvedByApp: false, comments: [
                { id: commentId, node: `n${commentId}`, author: 'visto-test[bot]', authorIsBot: true, byApp: true, reviewId: id, body: c.body, at: h.now },
              ] });
              return { id: commentId, path: c.path, side: c.side, line: c.line, body: c.body };
            });
            postedComments.set(id, posted);
          }
          publishCalled();
          return { id };
        },
        listOwnReviews: async () => { writes.push(['listOwnReviews']); return []; },
        listReviewComments: async (_ref, _installation, reviewId) => { writes.push(['listReviewComments']); return postedComments.get(reviewId) ?? []; },
        react: async (_ref, _installation, commentId, reaction) => { writes.push(['react', commentId, reaction]); },
        comment: async (_ref, _installation, body) => { writes.push(['comment', body]); },
        listThreads: async () => {
          writes.push(['listThreads']);
          if (h.threads === undefined) throw new Error('not_expected');
          return h.threads;
        },
        replyToThread: () => Promise.reject(new Error('not_expected')),
        editThreadComment: () => Promise.reject(new Error('not_expected')),
        resolveThread: () => Promise.reject(new Error('not_expected')),
      },
      checks: {
        async findCheck(_ref, installation, commit, name) {
          checked.push(['findCheck', installation, commit, name]);
          if (options.holdCheck !== undefined) await options.holdCheck;
          return held.get(commit) ?? null;
        },
        async writeCheck(_ref, installation, check) {
          checked.push(['writeCheck', installation, check]);
          const id = check.id ?? '701';
          held.set(check.commit, { id, status: check.status, conclusion: check.conclusion, title: check.title, summary: check.summary });
          return { id };
        },
        greenChecks: async () => { checked.push(['greenChecks']); throw new Error('not_expected'); },
        isTeamMember: async () => {
          checked.push(['isTeamMember']);
          if (options.member === undefined) throw new Error('not_expected');
          return options.member;
        },
      },
      fetch: (async (url: string | URL | Request) => {
        fetched.push(String(url));
        if (String(url).endsWith('/key')) {
          order.push('key');
          if (options.keyGate !== undefined) await options.keyGate;
        }
        return new Response('{}', { status: String(url).endsWith('/key') ? options.keyStatus ?? 200 : 200 });
      }) as typeof fetch,
      sleep: () => Promise.resolve(),
      every: (ms, work) => {
        const timer: Timer = { ms, work, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },
      engineDeps: (source) => ({ source }) as ReviewDeps,
      review: async (input) => {
        inputs.push(input);
        reviewCalled();
        if (options.holdReview === true) await reviewHeld;
        return options.result ?? okResult();
      },
      lineUrl: () => 'https://git.example.test/x',
      commentUrl: (_ref, commentId) => `https://git.example.test/c/${commentId}`,
      });
      started.push(service);
      return service;
    },
    runTimer: (ms: number) => timers.find((t) => t.ms === ms)!.work(),
    webhook: (event: ForgeEvent, delivery: string) => new Promise<{ status: number | null; body: string | null }>((resolve) => {
      current = event;
      delivered = delivery;
      const answer = { status: null as number | null, body: null as string | null };
      const req: RequestLike = { method: 'POST', url: '/webhooks/github', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } };
      listener!(req, {
        writeHead(status: number) { answer.status = status; },
        end(body: string) { answer.body = body; resolve(answer); },
      });
    }),
    flush: async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((done) => setImmediate(done));
    },
    /** Waits until `ready` answers true, for at most five seconds. */
    until: async (ready: () => boolean | Promise<boolean>) => {
      const end = Date.now() + 5_000;
      while (!(await ready())) {
        if (Date.now() > end) throw new Error('not reached within 5 seconds');
        await new Promise((done) => { setTimeout(done, 5).unref(); });
      }
    },
    /** The gate jobs, oldest first. */
    gateJobs: async () => (await h.db.query<{ id: number }>("select id from visto_ai.jobs where kind = 'gate' order by id"))
      .map((r) => r.id),
    /** The checks written, in order. */
    written: () => checked.filter((c) => c[0] === 'writeCheck').map((c) => c[2] as { title: string; status: string; conclusion: string | null; commit: string }),
  };
  return h;
}

/** The log entries of a stop, without those every start writes. */
const ofStop = (logged: Array<Record<string, unknown>>) => logged.filter((e) => e.event !== 'recovery' && e.event !== 'model_check' && e.event !== 'app_check');

test('start takes the lock, then migrates and recovers, then listens', async () => {
  const h = await harness();
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  const cut = (await enqueueJob(h.db, job()))!;
  await claimJob(h.db, cut, at(0));
  let seenAtListen: string | undefined;
  h.onListen = async () => { seenAtListen = (await getJob(h.db, cut))?.status; };
  await h.start();
  assert.deepEqual([h.events.slice(0, 2), seenAtListen], [['lock', 'listen'], 'pending']);
});
test('a second instance is refused before it migrates or listens', async () => {
  const h = await harness({ lock: null });
  await assert.rejects(h.start(), /^Error: another_instance_running$/);
  assert.deepEqual(h.events, ['lock', 'close']);
  await assert.rejects(h.db.query('select 1 from visto_ai.jobs'));
});
test('when a later step of the start fails the lock is released and the database closed', async () => {
  const h = await harness({ listenError: new Error('EADDRINUSE') });
  await assert.rejects(h.start(), /EADDRINUSE/);
  assert.deepEqual(h.events.slice(-2).sort(), ['close', 'release']);
});
test('a delivery that queues a review is run without waiting for the timer', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  assert.deepEqual(await h.webhook(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
  await h.reviewed();
  assert.equal(h.inputs[0]!.pullRequest.headSha, 'h1');
});
test('after listening it checks the key, asks for failed deliveries since the last heartbeat less two minutes, then starts beating', async () => {
  const h = await harness({ now: at(600) });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await beat(h.db, at(0));
  const service = await h.start();
  await service.settled;
  assert.deepEqual([h.fetched.some((u) => u.endsWith('/key')), h.listedSince, await readHeartbeat(h.db)], [true, [at(-120)], at(600)]);
  assert.deepEqual(h.timers.map((t) => t.ms), [TICK_MS, UPKEEP_MS, BEAT_MS]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'model_check'), [{ event: 'model_check', result: 'ok' }]);
});
test('on a first start nothing is asked for again, and the beat starts', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  assert.deepEqual([h.listedSince, await readHeartbeat(h.db), h.timers.some((t) => t.ms === BEAT_MS)], [[], at(0), true]);
});
test('a redelivery that does not get through is alerted once and tried again by the upkeep with the same look-back; the beat starts only when one does', async () => {
  const h = await harness({ now: at(600), listings: [new Error('github_502'), new Error('github_502'), { deliveries: [], complete: true }] });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await beat(h.db, at(0));
  const service = await h.start();
  await service.settled;
  assert.deepEqual([h.listedSince, await readHeartbeat(h.db), h.timers.some((t) => t.ms === BEAT_MS)], [[at(-120)], at(0), false]);
  await h.runTimer(UPKEEP_MS);
  await h.runTimer(UPKEEP_MS);
  assert.deepEqual([h.listedSince, await readHeartbeat(h.db), h.timers.some((t) => t.ms === BEAT_MS)], [[at(-120), at(-120), at(-120)], at(600), true]);
  const raised = h.logged.filter((e) => e.event === 'alert' && e.code === 'redelivery_failed');
  assert.deepEqual(raised, [{ event: 'alert', code: 'redelivery_failed', reason: 'github_502', failed: 0, complete: false }]);
  await h.runTimer(UPKEEP_MS);
  assert.equal(h.listedSince.length, 3);
});
test('the upkeep checks the key and deletes jobs finished more than fourteen days ago', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  const old = (await enqueueJob(h.db, job()))!;
  await finishJob(h.db, old, 'done', 'reviewed', at(-15 * 86_400));
  h.fetched.length = 0;
  await h.runTimer(UPKEEP_MS);
  assert.deepEqual([h.fetched.some((u) => u.endsWith('/key')), await getJob(h.db, old)], [true, null]);
});
test('nothing starts once the daily limit is reached, and the operator is told once', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  await recordRun(h.db, run({ startedAt: at(0), usage: { ...run().usage, cost: 50 } }));
  await h.webhook(pr('opened'), 'd1');
  await h.runTimer(TICK_MS);
  await h.runTimer(TICK_MS);
  assert.deepEqual([h.inputs.length, (await unfinishedJobs(h.db))[0]!.status], [0, 'pending']);
  assert.equal(h.logged.filter((e) => e.event === 'alert' && e.code === 'spend_limit').length, 1);
});
test('stop drains first: a running review finishes while webhooks are still accepted, then the listener, the database and the lock', async () => {
  const h = await harness({ holdReview: true });
  const service = await h.start();
  await service.settled;
  await h.webhook(pr('opened'), 'd1');
  await h.reviewed();
  const stopping = service.stop();
  assert.deepEqual(await h.webhook(pr('opened', { headSha: 'h2', updatedAt: at(5) }), 'd2'), { status: 202, body: 'accepted' });
  assert.equal(h.events.includes('listener-close'), false);
  h.releaseReview();
  await stopping;
  assert.deepEqual(h.events.slice(-3), ['listener-close', 'close', 'release']);
  const pending = await h.db.query<{ n: number }>("select count(*)::int as n from visto_ai.jobs where status = 'pending'");
  assert.deepEqual([h.timers.every((t) => t.cancelled), pending[0]!.n], [true, 1]);
});
test('stop goes on once DRAIN_WAIT_MS has passed, and says how many reviews were cut', async (t) => {
  const h = await harness({ holdReview: true });
  const service = await h.start();
  await service.settled;
  await h.webhook(pr('opened'), 'd1');
  await h.reviewed();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopping = service.stop();
  await h.flush();
  t.mock.timers.tick(DRAIN_WAIT_MS);
  await stopping;
  assert.deepEqual(h.logged.find((e) => e.event === 'drain_timeout'), { event: 'drain_timeout', running: 1 });
  assert.equal((await h.db.query<{ status: string }>('select status from visto_ai.jobs'))[0]!.status, 'running');
});
test('a redelivery attempt that is still under way when the upkeep runs is not started twice, and one beat is registered', async () => {
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const h = await harness({ now: at(600) });
  h.beforeListing = () => held;
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await beat(h.db, at(0));
  const service = await h.start();
  await h.flush();
  const upkept = h.runTimer(UPKEEP_MS);
  await h.flush();
  assert.equal(h.listedSince.length, 1);
  release();
  await service.settled;
  await upkept;
  assert.deepEqual([h.listedSince.length, h.timers.filter((t) => t.ms === BEAT_MS).length], [1, 1]);
  await service.stop();
});
test('a refused key stops the service from reviewing until the pause is over', async () => {
  const h = await harness({ keyStatus: 401 });
  const service = await h.start();
  await service.settled;
  await h.webhook(pr('opened'), 'd1');
  await h.runTimer(TICK_MS);
  await h.runTimer(TICK_MS);
  assert.deepEqual([h.inputs.length, (await unfinishedJobs(h.db))[0]!.status], [0, 'pending']);
  h.now = at(300);
  await h.runTimer(TICK_MS);
  await h.reviewed();
  assert.equal(h.inputs.length, 1);
  await service.stop();
});
test('a stop that comes while failed deliveries are being asked for starts no beat', async () => {
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const h = await harness({ now: at(600) });
  h.beforeListing = () => held;               // listSince waits for this before it answers
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await beat(h.db, at(0));
  const service = await h.start();
  await h.flush();
  const stopping = service.stop();
  release();
  await stopping;
  await service.settled;
  assert.deepEqual([await readHeartbeat(h.db), h.timers.some((t) => t.ms === BEAT_MS)], [at(0), false]);
});

test('out of dry run, a review is posted through the writer the service was given; in dry run that writer is never reached', async () => {
  const out = await harness({ dryRun: false });
  const service = await out.start();
  await service.settled;
  await out.webhook(pr('opened'), 'd1');
  const gave = await Promise.race([out.published().then(() => 'posted'), new Promise<string>((done) => { setTimeout(() => { done('no post within 5 seconds'); }, 5_000).unref(); })]);
  assert.equal(gave, 'posted');
  assert.equal(out.writes.some((w) => w[0] === 'publishReview'), true);
  const dry = await harness();
  await (await dry.start()).settled;
  await dry.webhook(pr('opened'), 'd1');
  await dry.reviewed();
  await dry.flush();
  assert.deepEqual(dry.writes, []);
});
test('at start the service says what the app lacks, once for each thing, and keeps running', async () => {
  const h = await harness({ dryRun: false, lacks: [{ feature: 'publishing', missing: 'pull_requests:write' }, { feature: 'commands', missing: 'issues:write' }] });
  const service = await h.start();
  await service.settled;
  assert.deepEqual(h.logged.filter((e) => e.event === 'feature_off'), [
    { event: 'feature_off', feature: 'publishing', missing: 'pull_requests:write' },
    { event: 'feature_off', feature: 'commands', missing: 'issues:write' },
  ]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'alert' && e.code === 'feature_off'), [
    { event: 'alert', code: 'feature_off', feature: 'publishing', missing: 'pull_requests:write' },
    { event: 'alert', code: 'feature_off', feature: 'commands', missing: 'issues:write' },
  ]);
  assert.deepEqual(h.lacksCalls, [false]);
  assert.deepEqual(await h.webhook(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
});
test('the app check comes after the key check and before the redelivery', async () => {
  const h = await harness({ now: at(600) });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await beat(h.db, at(0));
  await (await h.start()).settled;
  assert.deepEqual(h.order, ['key', 'lacks', 'listing']);
});
test('in dry run the service asks what the app lacks for dry run', async () => {
  const h = await harness();
  await (await h.start()).settled;
  assert.deepEqual(h.lacksCalls, [true]);
});
test('a stop that comes while the key check is pending ends the start: the app is not asked and nothing is raised', async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const h = await harness({ keyGate: gate, lacks: [{ feature: 'publishing', missing: 'pull_requests:write' }] });
  const service = await h.start();
  await h.flush();
  const stopping = service.stop();
  release();
  await stopping;
  await service.settled;
  assert.deepEqual([h.lacksCalls, h.logged.filter((e) => e.event === 'app_check' || e.event === 'feature_off')], [[], []]);
});
test('an app that lacks nothing is logged as such, and a check that cannot be made does not stop the start', async () => {
  const ok = await harness();
  await (await ok.start()).settled;
  assert.deepEqual(ok.logged.filter((e) => e.event === 'app_check'), [{ event: 'app_check', missing: 0 }]);
  const down = await harness({ lacks: new Error('github_network') });
  await (await down.start()).settled;
  assert.equal(down.logged.some((e) => e.event === 'start_step_failed' && e.step === 'app_check' && e.reason === 'github_network'), true);
});

// Plan 3's tests of the start and the stop, on the new harness.

test('startService migrates before it listens, on the configured port, and serves webhooks', async () => {
  const h = await harness();
  let tableAtListen: unknown[] = [];
  h.onListen = async () => {
    tableAtListen = await h.db.query("select 1 as x from information_schema.tables where table_schema = 'visto_ai' and table_name = 'deliveries'");
  };
  const service = await h.start();
  assert.equal(h.port, 9191);
  assert.equal(tableAtListen.length, 1);
  await h.webhook(PING, 'd-1');
  assert.deepEqual(await h.db.query('select id from visto_ai.deliveries'), [{ id: 'd-1' }]);
  await service.stop();
});
test('stop closes the listener, then waits for a request in flight, then closes the database', async () => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  h.beforeTransaction = () => gate;
  const answered = h.webhook(PING, 'd-1').then(() => { h.events.push('answered'); });
  await h.flush();
  const stopped = service.stop().then(() => { h.events.push('stopped'); });
  await h.flush();
  assert.deepEqual(h.events.slice(-1), ['listener-close']);
  release();
  await answered;
  await stopped;
  assert.deepEqual(h.events.slice(-5), ['listener-close', 'answered', 'close', 'release', 'stopped']);
});
test('when a migration rejects startService rejects, nothing listens, and the database is closed', async () => {
  const h = await harness({ migrationError: new Error('bad sql') });
  await assert.rejects(h.start(), { message: 'bad sql' });
  assert.equal(h.events.includes('listen'), false);
  assert.deepEqual(h.events.slice(-2).sort(), ['close', 'release']);
});
test('stop goes on to close the database once STOP_WAIT_MS has passed when a request never finishes', async (t) => {
  const h = await harness();
  const service = await h.start();
  await service.settled;
  h.beforeTransaction = never;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  void h.webhook(PING, 'd-1');
  await h.flush();
  const stopped = service.stop();
  await h.flush();
  assert.deepEqual([h.events.includes('listener-close'), h.events.includes('close')], [true, false]);
  t.mock.timers.tick(STOP_WAIT_MS);
  await stopped;
  assert.equal(h.events.includes('close'), true);
});
test('stop resolves once CLOSE_WAIT_MS has passed when the database never closes', async (t) => {
  const h = await harness({ closeNever: true });
  const service = await h.start();
  await service.settled;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopped = service.stop();
  while (!h.events.includes('close')) await h.flush();
  t.mock.timers.tick(CLOSE_WAIT_MS);
  await stopped;
  assert.deepEqual(ofStop(h.logged), [{ event: 'database_close_timeout' }]);
});
test('stop called twice returns the same promise and closes the database once', async () => {
  const h = await harness();
  const service = await h.start();
  const first = service.stop();
  assert.equal(service.stop(), first);
  await first;
  assert.deepEqual(h.events.filter((e) => e === 'close'), ['close']);
});
test('a database whose close rejects does not make stop reject, and its message is not logged', async () => {
  const h = await harness({ closeError: Object.assign(new Error('do-not-log-this'), { code: 'X1' }) });
  const service = await h.start();
  await service.settled;
  await service.stop();
  assert.deepEqual(ofStop(h.logged), [{ event: 'database_close_failed', error: 'Error', code: 'X1' }]);
  assert.ok(!JSON.stringify(h.logged).includes('do-not-log-this'));
});
test('a listener whose close rejects does not make stop reject; stop goes on and closes the database', async () => {
  const h = await harness({ listenerCloseError: Object.assign(new Error('do-not-log-this'), { code: 'L1' }) });
  const service = await h.start();
  await service.settled;
  await service.stop();
  assert.deepEqual(h.events.slice(-2), ['close', 'release']);
  assert.deepEqual(ofStop(h.logged), [{ event: 'listener_close_failed', error: 'Error', code: 'L1' }]);
  assert.ok(!JSON.stringify(h.logged).includes('do-not-log-this'));
});
test('a logger that throws changes nothing about stop', async () => {
  const h = await harness({ logThrows: true, closeError: new Error('close failed'), listenerCloseError: new Error('listener failed') });
  const service = await h.start();
  await service.settled;
  await service.stop();
  assert.deepEqual(h.events.slice(-2), ['close', 'release']);
});
test('the app is asked for what the configured gate needs', async () => {
  const on = await harness({
    repositoriesYaml: 'repositories:\n  defaults: { gate: { enabled: true, branches: [main], skipTeam: acme/release-managers } }\n',
  });
  await (await on.start()).settled;
  assert.deepEqual(on.gateCalls, [{ check: true, statuses: false, members: true, bypass: false }]);
  const off = await harness();
  await (await off.start()).settled;
  assert.deepEqual(off.gateCalls, [{ check: false, statuses: false, members: false, bypass: false }]);
});

// The gate's runner beside the reviews.

const manual = (over = {}) => job({ reason: 'command', headSha: '', trigger: 'manual' as const, requestedBy: 'octo-lead', commentId: '31', association: 'member', installation: '99', ...over });
const jobOf = async (db: Db, id: number): Promise<Job> => (await getJob(db, id))!;
const gateEntries = (logged: Array<Record<string, unknown>>) => logged.filter((e) => e.event === 'gate');
/** A record of the check waiting at h1 under enforce, so that the sweep at start leaves the pull request alone. */
const recordedWaiting = (db: Db) => recordEvaluation(db, { ref: REF, headSha: 'h1', at: at(0), mode: 'enforce', state: 'waiting', code: null, run: null, counts: NO_COUNTS });

test('a gate job runs while reviews are paused', async () => {
  const h = await harness({ gate: true });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts());
  await recordRun(h.db, run({ startedAt: at(0), usage: { ...run().usage, cost: 50 } }));
  const review = (await enqueueJob(h.db, manual()))!;
  const sync = (await askGate(h.db, REF, at(0)))!;
  const service = await h.start();
  await service.settled;
  await h.until(async () => (await jobOf(h.db, sync)).status === 'done');
  await h.runTimer(TICK_MS);
  await h.flush();
  assert.deepEqual([h.inputs.length, (await jobOf(h.db, review)).status, (await jobOf(h.db, sync)).outcome], [0, 'pending', 'synced']);
  assert.deepEqual(h.written().map((c) => [c.commit, c.status, c.title]), [['h1', 'queued', 'Review waiting: reviews are paused (spend_limit)']]);
});
test('stop waits for a gate job as it waits for a review', async () => {
  let release!: () => void;
  const holdCheck = new Promise<void>((done) => { release = done; });
  const h = await harness({ gate: true, holdCheck });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts());
  const sync = (await askGate(h.db, REF, at(0)))!;
  const service = await h.start();
  await service.settled;
  await h.until(() => h.checked.length > 0);
  const stopping = service.stop();
  await h.flush();
  assert.equal(h.events.includes('listener-close'), false);
  release();
  await stopping;
  assert.deepEqual(h.events.slice(-3), ['listener-close', 'close', 'release']);
  assert.deepEqual([(await jobOf(h.db, sync)).outcome, h.written().map((c) => c.title)], ['synced', ['Waiting for /done']]);
});
test('in dry run a stored gate job is dropped, and neither the checks nor the writer it was given can be reached', async () => {
  const h = await harness({ gate: true, dryRun: true });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts());
  const sync = (await askGate(h.db, REF, at(0)))!;
  const service = await h.start();
  await service.settled;
  await h.until(async () => (await jobOf(h.db, sync)).status === 'dropped');
  assert.equal((await jobOf(h.db, sync)).outcome, 'dry_run');
  assert.deepEqual([h.checked, h.writes], [[], []]);
});
test('when a review job has left the runner the check is asked for and decided', async () => {
  // Published: one gate job ran after it and wrote the check from the review.
  const ok = await harness({ gate: true, threads: [] });
  await migrate(ok.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(ok.db, facts());
  await recordedWaiting(ok.db);
  await enqueueJob(ok.db, manual());
  await (await ok.start()).settled;
  await ok.published();
  await ok.until(() => ok.written().length > 0);
  await ok.until(async () => (await ok.gateJobs()).length === 1 && (await jobOf(ok.db, (await ok.gateJobs())[0]!)).status === 'done');
  assert.deepEqual(ok.written().map((c) => [c.commit, c.status, c.conclusion, c.title]), [['h1', 'completed', 'success', 'No blocking findings']]);
  assert.equal((await jobOf(ok.db, (await ok.gateJobs())[0]!)).outcome, 'synced');

  // Failed: the check says so with its code.
  const failed = await harness({ gate: true, result: { ...okResult(), status: 'failed', failure: { stage: 'model', code: 'timeout' }, findings: [] } });
  await migrate(failed.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(failed.db, facts());
  await recordedWaiting(failed.db);
  await enqueueJob(failed.db, manual());
  await (await failed.start()).settled;
  await failed.until(() => failed.written().length > 0);
  assert.deepEqual(failed.written().map((c) => [c.status, c.conclusion, c.title]), [['completed', 'failure', 'Review failed (timeout): comment /done to retry']]);

  // With the gate off, and against a branch the gate does not list: no gate job, no gate entry, no call of the checks.
  // With a gate configured for another branch the sweep at start says it asked for nothing (Task 12, rule 1).
  for (const [options, swept] of [[{ dryRun: false }, []], [{ dryRun: false, repositoriesYaml: 'repositories:\n  defaults: { gate: { enabled: true, branches: [release] } }\n' }, ['gate_sweep']]] as const) {
    const off = await harness(options);
    await migrate(off.db, loadMigrations(MIGRATIONS_DIR));
    await savePullRequest(off.db, facts());
    const id = (await enqueueJob(off.db, manual()))!;
    await (await off.start()).settled;
    await off.published();
    await off.until(async () => (await jobOf(off.db, id)).status === 'done');
    await off.flush();
    assert.deepEqual([await off.gateJobs(), gateEntries(off.logged), off.checked], [[], [], []]);
    assert.deepEqual(off.logged.map((e) => e.event), ['recovery', ...swept, 'model_check', 'app_check', 'readback', 'review']);
    assert.deepEqual(off.logged.filter((e) => e.event === 'gate_sweep'), swept.map(() => ({ event: 'gate_sweep', asked: 0 })));
  }
});
test('a review job that is dropped as too old leaves the check to be decided', async () => {
  const h = await harness({ gate: true });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts());
  await recordedWaiting(h.db);
  const old = (await enqueueJob(h.db, manual({ runAt: at(-90_000), now: at(-90_000) })))!;
  await (await h.start()).settled;
  await h.until(() => h.written().length > 0);
  assert.deepEqual([(await jobOf(h.db, old)).outcome, (await h.gateJobs()).length], ['too_old', 1]);
  assert.deepEqual(h.written().map((c) => [c.status, c.title]), [['queued', 'Waiting for /done']]);
});
test('a review whose record failed leaves no Reviewing behind', async () => {
  const h = await harness({ gate: true, failQuery: 'insert into visto_ai.review_runs' });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts());
  const id = (await enqueueJob(h.db, manual()))!;
  await (await h.start()).settled;
  await h.reviewed();
  await h.until(() => h.written().length > 0);
  assert.equal((await jobOf(h.db, id)).status, 'running');
  assert.deepEqual(h.written().map((c) => [c.status, c.title]), [['queued', 'Waiting for /done']]);
});
test('a gate job the runner gives up raises the alert once and asks for nothing', async () => {
  const h = await harness({ gate: true });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts());
  const first = (await askGate(h.db, REF, at(0)))!;
  await h.db.query('update visto_ai.jobs set starts = 3 where id = $1', [first]);
  await (await h.start()).settled;
  await h.until(async () => (await jobOf(h.db, first)).status === 'dropped');
  await h.flush();
  assert.deepEqual([(await jobOf(h.db, first)).outcome, await h.gateJobs()], ['attempts_exhausted', [first]]);
  const second = (await askGate(h.db, REF, at(0)))!;
  await h.db.query('update visto_ai.jobs set starts = 3 where id = $1', [second]);
  await h.runTimer(TICK_MS);
  await h.until(async () => (await jobOf(h.db, second)).status === 'dropped');
  await h.flush();
  assert.deepEqual(await h.gateJobs(), [first, second]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'alert' && e.code === 'gate_check_failed'), [{ event: 'alert', code: 'gate_check_failed', reason: 'attempts_exhausted' }]);
  assert.deepEqual(h.checked, []);
});

// The service keeps the checks true.

const said = (h: { written: () => Array<{ commit: string; title: string }> }) => h.written().map((c) => [c.commit, c.title]);
const titleOn = (h: { held: Map<string, OwnCheck> }, commit: string): string | undefined => h.held.get(commit)?.title;
const general = (id: string, body: string, author = 'octo-lead'): ForgeEvent =>
  ({ kind: 'general_comment', ref: REF, installation: '99', comment: { id, author, authorIsBot: false, association: 'member', at: at(0), body } });
const majorResult = (): ReviewResult => ({ ...okResult(), findings: [{ ...okResult().findings[0]!, severity: 'major', body: 'Check the total.' }] });
const pending = async (db: Db, kind: string): Promise<Array<{ reason: string; status: string }>> =>
  db.query<{ reason: string; status: string }>('select reason, status from visto_ai.jobs where kind = $1 order by id', [kind]);

test('the sweep comes after the recovery and before the listener, and not in dry run or with no gate', async () => {
  const h = await harness({ gate: true });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts());
  let atListen: unknown[] = [];
  h.onListen = async () => { atListen = h.logged.map((e) => e.event); };
  await (await h.start()).settled;
  assert.deepEqual(atListen, ['recovery', 'gate_sweep']);
  assert.deepEqual(h.logged.filter((e) => e.event === 'gate_sweep'), [{ event: 'gate_sweep', asked: 1 }]);
  await h.until(() => h.written().length > 0);
  assert.deepEqual(said(h), [['h1', 'Waiting for /done']]);

  for (const options of [{ gate: true, dryRun: true }, { dryRun: false }]) {
    const other = await harness(options);
    await migrate(other.db, loadMigrations(MIGRATIONS_DIR));
    await savePullRequest(other.db, facts());
    await (await other.start()).settled;
    await other.runTimer(TICK_MS);
    await other.flush();
    assert.deepEqual([other.logged.filter((e) => e.event === 'gate_sweep'), await other.gateJobs(), other.checked], [[], [], []]);
  }
});
test('a sweep that cannot read the database fails the start', async () => {
  const h = await harness({ gate: true, failQuery: 'from visto_ai.gate_evaluations' });
  await assert.rejects(h.start(), /db_down/);
  assert.equal(h.events.includes('listen'), false);
});
test('a pull request whose check needed no write after a change of mode is not asked for at every start', async () => {
  const h = await harness({ gate: true });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts());
  await recordEvaluation(h.db, { ref: REF, headSha: 'h1', at: at(0), mode: 'shadow', state: 'waiting', code: null, run: null, counts: NO_COUNTS });
  const wanted = checkText({ state: 'waiting' }, { head: 'h1', canSkip: false, clearByReply: true, retrying: true, threadUrl: () => '' });
  h.held.set('h1', { id: '71', ...wanted });
  const first = await h.start();
  await first.settled;
  await h.until(async () => (await pending(h.db, 'gate')).some((j) => j.status === 'done'));
  await first.stop();
  const rows = await h.db.query<{ mode: string; state: string }>('select mode, state from visto_ai.gate_evaluations order by id');
  assert.deepEqual([h.logged.filter((e) => e.event === 'gate_sweep'), h.written(), rows], [
    [{ event: 'gate_sweep', asked: 1 }], [], [{ mode: 'shadow', state: 'waiting' }, { mode: 'enforce', state: 'waiting' }],
  ]);
  const second = await h.start();
  await second.settled;
  assert.deepEqual(h.logged.filter((e) => e.event === 'gate_sweep'), [{ event: 'gate_sweep', asked: 1 }, { event: 'gate_sweep', asked: 0 }]);
  assert.deepEqual(await pending(h.db, 'gate'), [{ reason: 'sync', status: 'done' }]);
});
test('a start in bypass says so and raises its alert once', async () => {
  const yaml = 'repositories:\n  defaults: { gate: { enabled: true, branches: [main], mode: bypass } }\n';
  const h = await harness({ dryRun: false, repositoriesYaml: yaml });
  const service = await h.start();
  await service.settled;
  await h.runTimer(TICK_MS);
  await h.runTimer(UPKEEP_MS);
  assert.deepEqual(h.logged.filter((e) => e.event === 'gate_bypass' || (e.event === 'alert' && e.code === 'gate_bypass')), [
    { event: 'gate_bypass' }, { event: 'alert', code: 'gate_bypass' },
  ]);
  // Not in dry run, and not with the gate in another mode.
  for (const options of [{ dryRun: true, repositoriesYaml: yaml }, { gate: true }]) {
    const other = await harness(options);
    await (await other.start()).settled;
    assert.deepEqual(other.logged.filter((e) => e.event === 'gate_bypass' || e.code === 'gate_bypass'), []);
  }
});
test('when reviews are paused a waiting review\'s check says why, and says Reviewing again when they resume', async () => {
  const h = await harness({ gate: true, github: true, holdReview: true });
  const service = await h.start();
  await service.settled;
  await h.webhook(pr('opened'), 'd1');
  await h.until(() => titleOn(h, 'h1') === 'Waiting for /done');
  // The daily limit is reached; then a /done asks for a review, which waits.
  await recordRun(h.db, run({ startedAt: at(0), usage: { ...run().usage, cost: 50 } }));
  await h.webhook(general('31', '/done'), 'd2');
  await h.until(() => titleOn(h, 'h1') === 'Review waiting: reviews are paused (spend_limit)');
  await h.runTimer(TICK_MS);
  assert.deepEqual([h.inputs.length, (await pending(h.db, 'review')).map((j) => j.status)], [0, ['pending']]);
  // The next UTC day: the pause ends, the check says Reviewing, and the review runs.
  h.now = at(86_400);
  await h.runTimer(TICK_MS);
  await h.until(() => titleOn(h, 'h1') === 'Reviewing');
  await h.reviewed();
  h.releaseReview();
  await h.until(() => titleOn(h, 'h1') === '1 finding, none blocking');
  assert.deepEqual(said(h), [
    ['h1', 'Waiting for /done'], ['h1', 'Review waiting: reviews are paused (spend_limit)'], ['h1', 'Reviewing'], ['h1', '1 finding, none blocking'],
  ]);
  assert.equal(h.logged.some((e) => e.event === 'gate_ask_failed'), false);
});
test('a pause that begins asks for the checks of the waiting reviews, and one whose asking fails is logged and tried again', async () => {
  const h = await harness({ gate: true });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts());
  await recordedWaiting(h.db);
  await (await h.start()).settled;
  await h.flush();
  // A review job that is stored while reviews run, and then the daily limit is reached before it starts.
  await recordRun(h.db, run({ startedAt: at(0), usage: { ...run().usage, cost: 50 } }));
  await enqueueJob(h.db, manual());
  await h.runTimer(TICK_MS);
  await h.until(() => titleOn(h, 'h1') === 'Review waiting: reviews are paused (spend_limit)');
  // A start while paused, when the gate's jobs cannot be stored: logged, and each pass asks again.
  const quiet = await harness({ gate: true, failQuery: "'gate', 'sync'" });
  await migrate(quiet.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(quiet.db, facts());
  await recordedWaiting(quiet.db);
  await recordRun(quiet.db, run({ startedAt: at(0), usage: { ...run().usage, cost: 50 } }));
  await enqueueJob(quiet.db, manual());
  await (await quiet.start()).settled;
  await quiet.runTimer(TICK_MS);
  const failed = quiet.logged.filter((e) => e.event === 'gate_ask_failed');
  assert.ok(failed.length >= 2);
  assert.deepEqual(failed[0], { event: 'gate_ask_failed', reason: 'db_down' });
  assert.deepEqual([quiet.inputs.length, await quiet.gateJobs()], [0, []]);
});
test('with no gate a pause and its end ask for nothing', async () => {
  const h = await harness({ dryRun: false });
  await (await h.start()).settled;
  await h.webhook(pr('opened', { draft: true }), 'd1');
  await recordRun(h.db, run({ startedAt: at(0), usage: { ...run().usage, cost: 50 } }));
  h.queries.length = 0;
  await h.runTimer(TICK_MS);
  h.now = at(86_400);
  await h.runTimer(TICK_MS);
  await h.flush();
  assert.deepEqual([h.queries.filter((q) => q.includes("status in ('pending', 'running')") || q.includes('gate')), h.checked], [[], []]);
  assert.deepEqual(h.logged.filter((e) => typeof e.event === 'string' && e.event.startsWith('gate')), []);
});
test('a /done that joined the review of an older head is answered by a review of the new one', async () => {
  const h = await harness({ gate: true, github: true, holdReview: true });
  const service = await h.start();
  await service.settled;
  await h.webhook(pr('opened'), 'd1');
  await h.webhook(general('31', '/done'), 'd2');
  await h.reviewed();
  await h.until(() => titleOn(h, 'h1') === 'Reviewing');
  // A push: the head is h2, and a review of the pull request is still under way.
  h.live = { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } };
  await h.webhook(pr('synchronize', { headSha: 'h2', updatedAt: at(5) }), 'd3');
  await h.until(() => titleOn(h, 'h2') === 'Reviewing');
  const onH1 = h.written().filter((c) => c.commit === 'h1').length;
  // A second /done joins the running review: its eyes, and no new job.
  await h.webhook(general('33', '/done'), 'd4');
  await h.until(() => h.writes.some((w) => w[0] === 'react' && w[1] === '33'));
  assert.deepEqual((await pending(h.db, 'review')).map((j) => [j.reason, j.status]), [['done', 'running']]);
  h.releaseReview();
  await h.until(() => h.held.get('h2')?.status === 'completed');
  const reviews = await h.db.query<{ reason: string; outcome: string }>("select reason, outcome from visto_ai.jobs where kind = 'review' order by id");
  assert.deepEqual(reviews, [{ reason: 'done', outcome: 'head_moved' }, { reason: 'done_retry', outcome: 'published' }]);
  assert.deepEqual([h.inputs.map((i) => i.pullRequest.headSha), titleOn(h, 'h2')], [['h1', 'h2'], '1 finding, none blocking']);
  assert.equal(h.written().filter((c) => c.commit === 'h1').length, onH1);
  assert.deepEqual(h.writes.filter((w) => w[0] === 'react'), [['react', '31', 'eyes'], ['react', '33', 'eyes']]);
});
test('a whole round on a gated pull request', async () => {
  const h = await harness({
    dryRun: false, github: true, member: true, holdReview: true, result: majorResult(),
    repositoriesYaml: 'repositories:\n  defaults: { gate: { enabled: true, branches: [main], skipTeam: acme/release-managers } }\n',
  });
  const service = await h.start();
  await service.settled;
  // Opened: no review, the check waits for /done.
  await h.webhook(pr('opened'), 'd1');
  await h.until(() => titleOn(h, 'h1') === 'Waiting for /done');
  assert.equal(h.inputs.length, 0);
  // /done: eyes, Reviewing, one review posted with a major, then the check blocks.
  await h.webhook(general('31', '/done'), 'd2');
  await h.until(() => titleOn(h, 'h1') === 'Reviewing');
  h.releaseReview();
  await h.until(() => titleOn(h, 'h1') === '1 blocking finding is open');
  assert.deepEqual([h.inputs.length, h.writes.filter((w) => w[0] === 'publishReview'), h.held.get('h1')!.conclusion], [1, [['publishReview', 'h1']], 'action_required']);
  assert.deepEqual(h.writes.find((w) => w[0] === 'react'), ['react', '31', 'eyes']);
  // A reply by the author and a resolve: green three seconds later, with no review.
  const thread = h.threads![0]!;
  thread.comments.push({ id: '8101', node: 'n8101', author: 'octo-dev', authorIsBot: false, byApp: false, reviewId: null, body: 'Fixed by hand.', at: at(10) });
  thread.resolved = true;
  h.now = at(10);
  await h.webhook({ kind: 'inline_comment', ref: REF, comment: {
    id: '8101', author: 'octo-dev', authorIsBot: false, association: 'none', at: at(10), commit: 'h1', path: thread.path, side: thread.side,
    line: thread.line, startLine: null, fileLevel: false, replyTo: '8001', body: 'Fixed by hand.' } }, 'd3');
  await h.webhook({ kind: 'thread', ref: REF, action: 'resolved', thread: thread.id, rootComment: '8001', actor: 'octo-dev', actorIsBot: false }, 'd4');
  await h.runTimer(TICK_MS);
  await h.flush();
  assert.equal(titleOn(h, 'h1'), '1 blocking finding is open');
  h.now = at(13);
  await h.runTimer(TICK_MS);
  await h.until(() => titleOn(h, 'h1') === '1 finding, none blocking');
  assert.deepEqual([h.inputs.length, h.held.get('h1')!.conclusion], [1, 'success']);
  // A push: the new commit's check waits for /done, and the old commit's is not rewritten.
  const onH1 = h.written().filter((c) => c.commit === 'h1').length;
  h.live = { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } };
  await h.webhook(pr('synchronize', { headSha: 'h2', updatedAt: at(20) }), 'd5');
  await h.until(() => titleOn(h, 'h2') === 'Waiting for /done');
  // A skip by a member of the team.
  await h.webhook(general('32', '/ai-review-skip hotfix, checked by hand'), 'd6');
  await h.until(() => titleOn(h, 'h2') === 'Skipped by @octo-lead');
  // A re-run of that check: one more review, and the check still says skipped.
  await h.webhook({ kind: 'check_rerun', ref: REF, installation: '99', app: '12345', check: 'AI Review', headSha: 'h2', actor: 'octo-dev' }, 'd7');
  await h.until(async () => (await pending(h.db, 'review')).some((j) => j.reason === 'rerun' && j.status === 'done'));
  await h.until(async () => (await pending(h.db, 'gate')).every((j) => j.status === 'done'));
  assert.deepEqual([h.inputs.map((i) => i.pullRequest.headSha), h.writes.filter((w) => w[0] === 'publishReview')], [['h1', 'h2'], [['publishReview', 'h1'], ['publishReview', 'h2']]]);
  assert.deepEqual([titleOn(h, 'h2'), h.held.get('h2')!.conclusion], ['Skipped by @octo-lead', 'success']);
  assert.equal(h.written().filter((c) => c.commit === 'h1').length, onH1);
  assert.deepEqual(said(h), [
    ['h1', 'Waiting for /done'], ['h1', 'Reviewing'], ['h1', '1 blocking finding is open'], ['h1', '1 finding, none blocking'],
    ['h2', 'Waiting for /done'], ['h2', 'Skipped by @octo-lead'],
  ]);
});
