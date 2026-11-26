import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { pgliteDb } from './db/pglite.ts';
import type { Db, InstanceLock } from './db/types.ts';
import { loadMigrations, MIGRATIONS_DIR, migrate } from './db/migrate.ts';
import { askGate, askWithdraw, claimJob, enqueueJob, finishJob, getJob, unfinishedJobs } from './db/jobs.ts';
import type { Job } from './db/jobs.ts';
import { getPullRequest, savePullRequest } from './db/pull-requests.ts';
import { NO_COUNTS, recordEvaluation } from './db/gate.ts';
import { markPublished, recordRun } from './db/review-runs.ts';
import type { RunRecord } from './db/review-runs.ts';
import { markDismissFailed } from './db/approvals.ts';
import { dismissMessage } from './approval/text.ts';
import { beat, readHeartbeat } from './db/heartbeat.ts';
import { serviceConfig, parseConfig } from './config/load.ts';
import type { AppIdentity, FeatureOff, ForgeApprovals, ForgeChecks, ForgeEvent, ForgeWriter, HookDelivery, LivePullRequest, OwnCheck, PostedComment, PullRequestAction, PullRequestFacts, ReviewThread, Source } from './forge/types.ts';
import type { BlockScore, ModelRequest, ModelResponse, ReviewDeps, ReviewInput, ReviewResult } from './engine/types.ts';
import { approvalsFor, BEAT_MS, CLOSE_WAIT_MS, DRAIN_WAIT_MS, gateForge, startService, STOP_WAIT_MS, TICK_MS, UPKEEP_MS, WITHDRAW_CONCURRENCY } from './service.ts';
import type { Listening, ServiceDeps } from './service.ts';
import type { RequestLike, ResponseLike } from './shell/http.ts';
import { checkText } from './gate/check.ts';
import type { LoadedExtension } from './extensions/types.ts';
import { createFeedback } from './shell/feedback.ts';
import { LEARN_MS } from './shell/learning.ts';
import { recordActivity } from './db/human-activity.ts';
import type { Activity } from './db/human-activity.ts';
import { addRecords } from './db/memory-records.ts';
import { recordComments } from './db/review-comments.ts';
import type { HumanInlineComment } from './forge/types.ts';
import type { ForgeSignIn } from './forge/types.ts';
import type { Activity as UiActivity, Me } from './ui/api-types.ts';
import type { UiFiles } from './ui/files.ts';

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
const ENV = { K: 'k', A: appKey, S: 's', U: 'postgres://u:p@db.example.test/d', V: 'audit-key-for-tests-only-0123456789' };
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
  /** The modules the service is given; none when not given. */
  extensions?: LoadedExtension[];
  /** true to switch learning on; the config's own value (off) when not given. */
  learning?: boolean;
  /** The model's tool choice; the config's own (forced) when not given. */
  toolChoice?: 'auto' | 'forced';
  /** The approvals the service is given; none when not given. */
  approvals?: ForgeApprovals;
  /** `ui` and what follows, added to the deployment file with the app's client id and secret; none when not given. */
  uiYaml?: string;
  /** What the service is given for the UI; none when not given. */
  ui?: ServiceDeps['ui'];
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
  /** The dependencies each review was given, in the order of `inputs`. */
  const reviewDeps: ReviewDeps[] = [];
  const fetched: string[] = [];
  const listedSince: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const writes: unknown[][] = [];
  const listings = [...(options.listings ?? [])];
  /** Every request the model was sent, in order. */
  const modelRequests: ModelRequest[] = [];
  /** The text of every statement outside a transaction. */
  const queries: string[] = [];
  /** Every statement, inside a transaction or not, with its parameters. */
  const allQueries: Array<[string, unknown[]]> = [];
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
  /** The third argument of each call of `lacks`. */
  const approvalCalls: unknown[] = [];
  /** The fourth argument of each call of `lacks`. */
  const uiTeamCalls: unknown[] = [];
  /** Every call of the checks, as [name, ...args]. */
  const checked: unknown[][] = [];
  /** The checks GitHub holds, by commit. */
  const held = new Map<string, OwnCheck>();
  /** The inline comments of each review posted, by the review's id. */
  const postedComments = new Map<string, PostedComment[]>();
  let reviewsPosted = 0;
  let commentsPosted = 0;
  let newRuns = 0;
  const appInfo: AppIdentity = {
    read: () => Promise.reject(new Error('not_used')),
    canResolve: () => Promise.resolve(false),
    lacks: (dryRun, gate, approval, uiTeam) => (order.push('lacks'), lacksCalls.push(dryRun), gateCalls.push(gate), approvalCalls.push(approval), uiTeamCalls.push(uiTeam), options.lacks instanceof Error ? Promise.reject(options.lacks) : Promise.resolve(options.lacks ?? [])),
  };

  const db: Db = {
    query: (text, params) => (queries.push(text), allQueries.push([text, params ?? []]), options.failQuery !== undefined && text.includes(options.failQuery) ? Promise.reject(new Error('db_down')) : real.query(text, params)),
    script: (sql) => (options.migrationError === undefined ? real.script(sql) : Promise.reject(options.migrationError)),
    transaction: async (work) => {
      if (h.beforeTransaction !== undefined) await h.beforeTransaction();
      return real.transaction((tx) => work({ ...tx, query: (text, params) => (allQueries.push([text, params ?? []]), tx.query(text, params)) }));
    },
    close: () => {
      h.beforeClose?.();
      events.push('close');
      if (options.closeNever === true) return never();
      if (options.closeError !== undefined) return Promise.reject(options.closeError);
      return Promise.resolve();
    },
  };
  const lock: InstanceLock = { release: async () => { events.push('release'); } };

  const h = {
    db, queries, allQueries, reviewDeps, modelRequests, events, order, lacksCalls, gateCalls, approvalCalls, uiTeamCalls, checked, held, timers, inputs, fetched, listedSince, logged, writes,
    port: 0,
    /** What the clock reads; a test may move it. */
    now: options.now ?? at(0),
    /** The pull request as GitHub has it now; a test may move its head. */
    live: LIVE as LivePullRequest,
    /** The installations GitHub no longer knows (the app was installed again): a read or a write of the pull request through one is a 404. */
    gone: new Set<string>(),
    /** What the review answers for this input, when it answers; else `result`. */
    resultFor: undefined as ((input: ReviewInput) => ReviewResult | undefined) | undefined,
    /** The threads GitHub has; listThreads rejects while this is undefined. */
    threads: options.threads ?? (options.github === true ? [] : undefined) as ReviewThread[] | undefined,
    onListen: undefined as (() => Promise<void>) | undefined,
    beforeListing: undefined as (() => Promise<void>) | undefined,
    beforeTransaction: undefined as (() => Promise<void>) | undefined,
    /** Called when the database is being closed, before anything else. */
    beforeClose: undefined as (() => void) | undefined,
    /** What the model answers to a request; it rejects when not set. */
    answer: undefined as ((request: ModelRequest) => Promise<ModelResponse>) | undefined,
    releaseReview: () => { releaseReview(); },
    reviewed: () => reviewed,
    published: () => published,
    start: async () => {
      const yaml = options.repositoriesYaml ?? (options.gate === true ? GATE_YAML : undefined);
      // A second `app:` would be a duplicate key: the client id and secret go into the one there is.
      const base = options.uiYaml !== undefined
        ? serviceConfig(parseConfig(
          BASE_YAML.replace('  webhookSecret: { env: S }\n', '  webhookSecret: { env: S }\n  clientId: Iv1.0123456789abcdef\n  clientSecret: { env: C }\n') + (yaml ?? '') + options.uiYaml,
          { ...ENV, C: 'client-secret-for-tests-only' }))
        : yaml === undefined ? config : serviceConfig(parseConfig(BASE_YAML + yaml, ENV));
      const dry = options.dryRun ?? options.gate !== true;
      const chosen = options.toolChoice === undefined ? base : { ...base, model: { ...base.model, toolChoice: options.toolChoice } };
      const learned = options.learning === true ? { ...chosen, learning: true } : chosen;
      const service = await startService(dry ? learned : { ...learned, dryRun: false }, {
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
      forge: { readPullRequest: (_ref, installation) => (h.gone.has(installation) ? Promise.reject(new Error('github_404')) : Promise.resolve(h.live)), sourceFor: () => Promise.resolve({} as Source) },
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
        listThreads: async (_ref, installation) => {
          writes.push(['listThreads']);
          if (h.gone.has(installation)) throw new Error('github_404');
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
          if (h.gone.has(installation)) throw new Error('github_404');
          if (options.holdCheck !== undefined) await options.holdCheck;
          return held.get(commit) ?? null;
        },
        async writeCheck(_ref, installation, check) {
          checked.push(['writeCheck', installation, check]);
          if (h.gone.has(installation)) throw new Error('github_404');
          // As GitHub does, with the adapter's guard in its place: a completed run is not reopened by an update.
          const before = check.id === null ? undefined : [...held.values()].find((c) => c.id === check.id);
          if (before !== undefined && before.status === 'completed' && check.status !== 'completed') {
            held.set(check.commit, { ...before, title: check.title, summary: check.summary });
            throw new Error('check_not_rewritten');
          }
          // A new run of the name becomes the one findCheck answers.
          const id = check.id ?? String(701 + newRuns++);
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
      model: {
        complete: async (request) => {
          modelRequests.push(request);
          if (h.answer === undefined) throw new Error('not_expected');
          return h.answer(request);
        },
      },
      token: () => 'tok-test',
      review: async (input, given) => {
        inputs.push(input);
        reviewDeps.push(given);
        reviewCalled();
        if (options.holdReview === true) await reviewHeld;
        return h.resultFor?.(input) ?? options.result ?? okResult();
      },
      lineUrl: () => 'https://git.example.test/x',
      commentUrl: (_ref, commentId) => `https://git.example.test/c/${commentId}`,
      extensions: options.extensions ?? [],
      reviewUrl: (ref, reviewId) => `https://git.example.test/${ref.owner}/${ref.repo}/pull/${ref.number}#review-${reviewId}`,
      pullRequestUrl: (ref) => `https://git.example.test/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
      ...(options.ui === undefined ? {} : { ui: options.ui }),
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
    /** A request to the listener, with the headers `sent`; a body of null never ends. Resolves with the answer. */
    request: (method: string, url: string, body: Buffer | null = Buffer.from(''), sent: Record<string, string> = {}) => new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve) => {
      const req: RequestLike = {
        method, url, headers: sent,
        async *[Symbol.asyncIterator]() { if (body === null) await never(); else yield body; },
      };
      let status = 0;
      let headers: Record<string, string> = {};
      listener!(req, {
        writeHead(s: number, hs: Record<string, string>) { status = s; headers = hs; },
        end(text: string) { resolve({ status, headers, body: text }); },
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
test('in dry run the gate is given checks and a writer that refuse every call, and out of it the ones the service was given', async () => {
  const calls: string[] = [];
  const checks: ForgeChecks = {
    findCheck: async () => { calls.push('findCheck'); return null; }, writeCheck: async () => { calls.push('writeCheck'); return { id: '1' }; },
    greenChecks: async () => { calls.push('greenChecks'); return []; }, isTeamMember: async () => { calls.push('isTeamMember'); return true; },
  };
  const writer = { listThreads: async () => { calls.push('listThreads'); return []; } } as unknown as ForgeWriter;
  const dry = gateForge(true, checks, writer);
  for (const call of [
    () => dry.checks.findCheck(REF, '99', 'h1', 'AI Review'), () => dry.checks.writeCheck(REF, '99', { id: null, commit: 'h1', name: 'AI Review', status: 'queued', conclusion: null, title: 't', summary: 's' }),
    () => dry.checks.greenChecks(REF, '99', 'h1', ['build']), () => dry.checks.isTeamMember('99', 'acme/release-managers', 'octo-lead'),
    () => dry.writer.listThreads(REF, '99'), () => dry.writer.react(REF, '99', '31', 'eyes'), () => dry.writer.comment(REF, '99', 'x'),
  ]) await assert.rejects(call(), /dry_run/);
  assert.deepEqual(calls, []);
  const live = gateForge(false, checks, writer);
  assert.equal(live.checks, checks);
  assert.equal(live.writer, writer);
});
test('a gate job the runner drops as too old raises the alert', async () => {
  const h = await harness({ gate: true });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  // No stored pull request: the sweep at start, which renews a waiting sync, leaves this one to the runner.
  const old = (await askGate(h.db, REF, at(-90_000)))!;
  await (await h.start()).settled;
  await h.until(async () => (await jobOf(h.db, old)).status === 'dropped');
  await h.flush();
  assert.equal((await jobOf(h.db, old)).outcome, 'too_old');
  assert.deepEqual(h.logged.filter((e) => e.event === 'alert' && e.code === 'gate_check_failed'), [{ event: 'alert', code: 'gate_check_failed', reason: 'too_old' }]);
  assert.deepEqual(h.checked, []);
});
test('with the gate off a review job that leaves the runner reads nothing for the gate', async () => {
  const off = await harness({ dryRun: false });
  await migrate(off.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(off.db, facts());
  const id = (await enqueueJob(off.db, manual()))!;
  await (await off.start()).settled;
  await off.published();
  await off.until(async () => (await jobOf(off.db, id)).status === 'done');
  await off.flush();
  assert.deepEqual(off.queries.filter((q) => q.includes('from visto_ai.pull_requests') || q.includes("'gate'")), []);
  // With the gate on the same review is followed by a read of the stored pull request and a request for the check.
  const on = await harness({ gate: true, threads: [] });
  await migrate(on.db, loadMigrations(MIGRATIONS_DIR));
  // No stored pull request, so that the sweep at start asks for nothing; the sync asked for carries the review job's installation.
  const onId = (await enqueueJob(on.db, manual()))!;
  await (await on.start()).settled;
  on.queries.length = 0;
  await on.published();
  await on.until(async () => (await jobOf(on.db, onId)).status === 'done' && (await on.gateJobs()).length === 1);
  assert.ok(on.queries.some((q) => q.includes('from visto_ai.pull_requests')));
});
test('when a review job has left the runner the check is asked for and decided', async () => {
  // Published: one gate job ran after it and wrote the check from the review.
  const ok = await harness({ gate: true, threads: [] });
  await migrate(ok.db, loadMigrations(MIGRATIONS_DIR));
  // No stored pull request, so that the sweep at start asks for nothing; the sync asked for carries the review job's installation.
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
  // No stored pull request, so that the sweep at start asks for nothing; the sync asked for carries the review job's installation.
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
  // No stored pull request, so that the sweep at start asks for nothing; the sync asked for carries the review job's installation.
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
  // No stored pull request: the sweep at start, which renews a waiting sync, leaves this one to the runner.
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
    assert.deepEqual(gateQueries(other.allQueries), [], JSON.stringify(options));
  }
});
test('a sweep that cannot read the database fails the start', async () => {
  const h = await harness({ gate: true, failQuery: 'from visto_ai.gate_evaluations' });
  await assert.rejects(h.start(), /db_down/);
  assert.equal(h.events.includes('listen'), false);
});
test('a pull request whose check needed no write is asked for at every start, and writes and records nothing more', async () => {
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
  await h.until(async () => (await pending(h.db, 'gate')).every((j) => j.status === 'done'));
  assert.deepEqual(h.logged.filter((e) => e.event === 'gate_sweep'), [{ event: 'gate_sweep', asked: 1 }, { event: 'gate_sweep', asked: 1 }]);
  assert.deepEqual(await pending(h.db, 'gate'), [{ reason: 'sync', status: 'done' }, { reason: 'sync', status: 'done' }]);
  assert.deepEqual([h.written(), (await h.db.query('select id from visto_ai.gate_evaluations')).length], [[], 2]);
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
  // No stored pull request, so that the sweep at start asks for nothing; the sync asked for carries the review job's installation.
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
  // No stored pull request: the sweep at start, whose ask would fail too, asks for nothing.
  await recordRun(quiet.db, run({ startedAt: at(0), usage: { ...run().usage, cost: 50 } }));
  await enqueueJob(quiet.db, manual());
  await (await quiet.start()).settled;
  await quiet.runTimer(TICK_MS);
  const failed = quiet.logged.filter((e) => e.event === 'gate_ask_failed');
  assert.ok(failed.length >= 2);
  assert.deepEqual(failed[0], { event: 'gate_ask_failed', reason: 'db_down' });
  assert.deepEqual([quiet.inputs.length, await quiet.gateJobs()], [0, []]);
});
/** The statements that belong to the gate: a sweep's read of the open pull requests, the gate's tables, a gate job stored. */
const gateQueries = (all: Array<[string, unknown[]]>): string[] => all
  .filter(([text, params]) => (text.includes('from visto_ai.pull_requests') && text.includes("where state = 'open'"))
    || text.includes('gate_evaluations') || text.includes('gate_overrides')
    || (text.includes('insert into visto_ai.jobs') && (text.includes("'gate'") || params.includes('gate'))))
  .map(([text]) => text);

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
  // Every statement since before the start, inside a transaction or not: nothing of the gate, and the pull request is only stored.
  assert.deepEqual(gateQueries(h.allQueries), []);
  assert.deepEqual(h.allQueries.filter(([text]) => text.includes('visto_ai.pull_requests')).map(([text]) => text.trim().split(/\s+/).slice(0, 3).join(' ')), ['insert into visto_ai.pull_requests']);
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

// The sweep at start, a sync's installation, a failed review of an old head, and what counts as under way.

type Harnessed = Awaited<ReturnType<typeof harness>>;
const replyOf = (h: Harnessed, id: string, seconds: number, installation = '99'): ForgeEvent => {
  const thread = h.threads![0]!;
  thread.comments.push({ id, node: `n${id}`, author: 'octo-dev', authorIsBot: false, byApp: false, reviewId: null, body: 'Fixed by hand.', at: at(seconds) });
  return { kind: 'inline_comment', ref: REF, installation, comment: {
    id, author: 'octo-dev', authorIsBot: false, association: 'none', at: at(seconds), commit: 'h1', path: thread.path, side: thread.side,
    line: thread.line, startLine: null, fileLevel: false, replyTo: thread.comments[0]!.id, body: 'Fixed by hand.' } };
};
const resolvedOf = (h: Harnessed, installation = '99'): ForgeEvent => {
  const thread = h.threads![0]!;
  thread.resolved = true;
  return { kind: 'thread', ref: REF, installation, action: 'resolved', thread: thread.id, rootComment: thread.comments[0]!.id, actor: 'octo-dev', actorIsBot: false };
};
/** A reply and a resolve in the review's one thread, then the wait for the check: green. */
async function answerAndResolve(h: Harnessed, from: number): Promise<void> {
  h.now = at(from);
  await h.webhook(replyOf(h, '8101', from), `r${from}`);
  await h.webhook(resolvedOf(h), `t${from}`);
  h.now = at(from + 3);
  await h.runTimer(TICK_MS);
  await h.until(() => titleOn(h, 'h1') === '1 finding, none blocking');
}
/** Opened, /done, a review with one major, then a reply and a resolve: the check is green. */
async function greenRound(h: Harnessed): Promise<void> {
  await h.webhook(pr('opened'), 'g1');
  await h.until(() => titleOn(h, 'h1') === 'Waiting for /done');
  await h.webhook(general('31', '/done'), 'g2');
  await h.until(() => titleOn(h, 'h1') === '1 blocking finding is open');
  await answerAndResolve(h, 10);
}

test('a thread unresolved while the service was down is seen at the next start', async () => {
  const h = await harness({ gate: true, github: true, result: majorResult() });
  const first = await h.start();
  await first.settled;
  await greenRound(h);
  await first.stop();
  h.threads![0]!.resolved = false;
  await (await h.start()).settled;
  await h.until(() => titleOn(h, 'h1') === '1 blocking finding is open');
  assert.deepEqual(h.logged.filter((e) => e.event === 'gate_sweep').at(-1), { event: 'gate_sweep', asked: 1 });
});
test('clearing by reply switched off at a restart is applied at the start', async () => {
  const options = { gate: true, github: true, result: majorResult(), repositoriesYaml: GATE_YAML };
  const h = await harness(options);
  const first = await h.start();
  await first.settled;
  await greenRound(h);
  await first.stop();
  options.repositoriesYaml = 'repositories:\n  defaults: { gate: { enabled: true, branches: [main], clearByReply: false } }\n';
  await (await h.start()).settled;
  await h.until(() => titleOn(h, 'h1') === '1 blocking finding is open');
});
test('a push received in dry run gets its check at the next start out of it', async () => {
  const options: { gate: boolean; github: boolean; result: ReviewResult; dryRun?: boolean } = { gate: true, github: true, result: majorResult() };
  const h = await harness(options);
  const first = await h.start();
  await first.settled;
  await greenRound(h);
  await first.stop();
  options.dryRun = true;
  const dry = await h.start();
  await dry.settled;
  h.live = { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } };
  await h.webhook(pr('synchronize', { headSha: 'h2', updatedAt: at(20) }), 'd-push');
  await dry.stop();
  assert.equal(titleOn(h, 'h2'), undefined);
  options.dryRun = false;
  await (await h.start()).settled;
  await h.until(() => titleOn(h, 'h2') === 'Waiting for /done');
});
test('a sync left waiting from a stop of more than a day is renewed by the sweep and runs', async () => {
  const h = await harness({ gate: true });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts());
  const old = (await askGate(h.db, REF, at(-90_000)))!;
  await h.db.query('update visto_ai.jobs set starts = 2 where id = $1', [old]);
  await (await h.start()).settled;
  await h.until(async () => (await jobOf(h.db, old)).status === 'done');
  assert.equal((await jobOf(h.db, old)).outcome, 'synced');
  assert.deepEqual([said(h), h.logged.filter((e) => e.event === 'alert' && e.code === 'gate_check_failed')], [[['h1', 'Waiting for /done']], []]);
});
test('a pull request the service stores no row for gets its check from a /done, and a reply and a resolve turn it green', async () => {
  const h = await harness({ gate: true, github: true, result: majorResult() });
  await (await h.start()).settled;
  await h.webhook(general('31', '/done'), 'c1');
  await h.until(() => titleOn(h, 'h1') === '1 blocking finding is open');
  assert.deepEqual([h.writes.filter((w) => w[0] === 'publishReview'), await getPullRequest(h.db, REF)], [[['publishReview', 'h1']], null]);
  await answerAndResolve(h, 10);
  assert.equal(h.held.get('h1')!.conclusion, 'success');
});
test('a /done that joined the review of an older head that then fails is answered by a review of the new head', async () => {
  const h = await harness({ gate: true, github: true, holdReview: true });
  h.resultFor = (input) => (input.pullRequest.headSha === 'h1' ? { ...okResult(), status: 'failed', failure: { stage: 'model', code: 'timeout' }, findings: [] } : undefined);
  await (await h.start()).settled;
  await h.webhook(pr('opened'), 'd1');
  await h.webhook(general('31', '/done'), 'd2');
  await h.reviewed();
  // A push, then a second /done that joins the running review of h1.
  h.live = { ...LIVE, info: { ...LIVE.info, headSha: 'h2' } };
  await h.webhook(pr('synchronize', { headSha: 'h2', updatedAt: at(5) }), 'd3');
  await h.webhook(general('33', '/done'), 'd4');
  await h.until(() => h.writes.some((w) => w[0] === 'react' && w[1] === '33'));
  h.releaseReview();
  await h.until(() => titleOn(h, 'h2') === '1 finding, none blocking');
  const reviews = await h.db.query<{ reason: string; outcome: string }>("select reason, outcome from visto_ai.jobs where kind = 'review' order by id");
  assert.deepEqual(reviews, [{ reason: 'done', outcome: 'failed' }, { reason: 'done_retry', outcome: 'published' }]);
  assert.deepEqual(h.inputs.map((i) => i.pullRequest.headSha), ['h1', 'h2']);
  // The failed review started over and said nothing: the retry's review is the answer.
  assert.deepEqual(h.writes.filter((w) => w[0] === 'comment'), []);
});
test('a pull request whose last sync found it closed, reopened while the service was in dry run, is asked for at the next start', async () => {
  const options: { gate: boolean; github: boolean; result: ReviewResult; dryRun?: boolean } = { gate: true, github: true, result: majorResult() };
  const h = await harness(options);
  const first = await h.start();
  await first.settled;
  await greenRound(h);
  // GitHub has it closed and the close's own event is late: a reply's sync records closed.
  h.live = { ...LIVE, state: 'closed' };
  h.now = at(30);
  await h.webhook(replyOf(h, '8102', 30), 'r30');
  h.now = at(33);
  await h.runTimer(TICK_MS);
  await h.until(async () => (await h.db.query<{ state: string }>('select state from visto_ai.gate_evaluations order by id desc limit 1'))[0]?.state === 'closed');
  await first.stop();
  // In dry run: closed, reopened, and the thread unresolved.
  options.dryRun = true;
  const dry = await h.start();
  await dry.settled;
  await h.webhook(pr('closed', { state: 'closed', closedAt: at(40), updatedAt: at(40) }), 'p40');
  h.live = LIVE;
  await h.webhook(pr('reopened', { updatedAt: at(41) }), 'p41');
  h.threads![0]!.resolved = false;
  await dry.stop();
  assert.equal(titleOn(h, 'h1'), '1 finding, none blocking');
  options.dryRun = false;
  await (await h.start()).settled;
  await h.until(() => titleOn(h, 'h1') === '1 blocking finding is open');
  assert.deepEqual(h.logged.filter((e) => e.event === 'gate_sweep').at(-1), { event: 'gate_sweep', asked: 1 });
});
test('a pull request the service stores no row for, whose check the gate wrote in bypass, is asked for at the next start', async () => {
  const options = { gate: true, github: true, repositoriesYaml: 'repositories:\n  defaults: { gate: { enabled: true, branches: [main], mode: bypass } }\n' };
  const h = await harness(options);
  const first = await h.start();
  await first.settled;
  h.threads!.push({ id: 't1', path: 'src/a.ts', side: 'RIGHT', line: 1, resolved: false, resolvedByApp: false, comments: [
    { id: '8001', node: 'n8001', author: 'octo-lead', authorIsBot: false, byApp: false, reviewId: null, body: 'A question.', at: at(0) },
  ] });
  h.now = at(10);
  await h.webhook(replyOf(h, '8101', 10), 'r10');
  h.now = at(13);
  await h.runTimer(TICK_MS);
  await h.until(() => titleOn(h, 'h1') === 'Gate bypassed');
  await first.stop();
  assert.equal(await getPullRequest(h.db, REF), null);
  options.repositoriesYaml = GATE_YAML;
  await (await h.start()).settled;
  await h.until(() => titleOn(h, 'h1') === 'Waiting for /done');
  assert.deepEqual(h.logged.filter((e) => e.event === 'gate_sweep').at(-1), { event: 'gate_sweep', asked: 1 });
});
test('after the app is installed again, a reply and a resolve that arrive through the new installation turn a blocked check green', async () => {
  const h = await harness({ gate: true, github: true, result: majorResult() });
  const first = await h.start();
  await first.settled;
  await h.webhook(pr('opened'), 'g1');
  await h.webhook(general('31', '/done'), 'g2');
  await h.until(() => titleOn(h, 'h1') === '1 blocking finding is open');
  await first.stop();
  // Installed again: the stored row still names 99, which GitHub no longer knows; events come through 100.
  h.gone.add('99');
  h.now = at(10);
  await (await h.start()).settled;
  // The sweep's sync tried the stored installation and was put back; the reply and the resolve arrive within its wait.
  await h.until(async () => (await h.db.query<{ starts: number }>("select starts from visto_ai.jobs where kind = 'gate' and status = 'pending'"))[0]?.starts === 1);
  await h.webhook(replyOf(h, '8101', 10, '100'), 'r10');
  await h.webhook(resolvedOf(h, '100'), 't10');
  h.now = at(13);
  // The tick of the service started second (the first one's timer was cancelled at its stop).
  await h.timers.filter((t) => t.ms === TICK_MS && !t.cancelled).at(-1)!.work();
  await h.until(() => titleOn(h, 'h1') === '1 finding, none blocking');
  assert.equal(h.held.get('h1')!.conclusion, 'success');
});

// Extension modules (plan 2026-11-22, Task 10).

const alertsOf = (h: { logged: Array<Record<string, unknown>> }, ...codes: string[]) => h.logged.filter((e) => e.event === 'alert' && codes.includes(e.code as string));
const LACKS: FeatureOff[] = [{ feature: 'commands', missing: 'issues:write' }];
/** A module named chat with a notifier and a sink, each of which records its calls. */
function chatModule(): { module: LoadedExtension; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    module: { name: 'chat', parts: {
      notify: async (notice) => { calls.push(['notify', notice]); },
      alert: async (notice) => { calls.push(['alert', notice]); },
    } },
  };
}

test('a module is asked for its route in dry run too, and an unknown one is not found', async () => {
  let throwing = false;
  const seen: string[] = [];
  const h = await harness({ extensions: [{ name: 'chat', parts: { route: async (request) => {
    seen.push(`${request.method} ${request.path}`);
    if (throwing) throw new Error('chat down');
    return { status: 200, body: 'pong' };
  } } }] });
  await (await h.start()).settled;
  const sent = async (url: string) => { const a = await h.request('GET', url); return [a.status, a.body]; };
  assert.deepEqual(await sent('/extensions/chat/ping'), [200, 'pong']);
  assert.deepEqual(await sent('/extensions/other/ping'), [404, 'not_found']);
  assert.deepEqual(seen, ['GET /ping']);
  throwing = true;
  assert.deepEqual(await sent('/extensions/chat/ping'), [500, 'internal_error']);
  assert.deepEqual(await sent('/extensions/chat/ping'), [500, 'internal_error']);
  assert.deepEqual(alertsOf(h, 'extension_error', 'extension_ok'), [{ event: 'alert', code: 'extension_error', extension: 'chat', part: 'route', reason: 'threw' }]);
  throwing = false;
  assert.deepEqual(await sent('/extensions/chat/ping'), [200, 'pong']);
  assert.deepEqual(alertsOf(h, 'extension_error', 'extension_ok').slice(1), [{ event: 'alert', code: 'extension_ok', extension: 'chat', part: 'route' }]);
});
test('out of dry run a published review reaches the notifier, and an alert reaches the sink', async () => {
  const { module, calls } = chatModule();
  const h = await harness({ dryRun: false, extensions: [module], lacks: LACKS });
  await (await h.start()).settled;
  await h.until(() => calls.some((c) => c[0] === 'alert'));
  assert.deepEqual(calls, [['alert', { code: 'feature_off', at: at(0), details: { feature: 'commands', missing: 'issues:write' } }]]);
  await h.webhook(pr('opened'), 'd1');
  await h.until(() => calls.some((c) => c[0] === 'notify'));
  await h.flush();
  const runs = await h.db.query<{ id: number }>('select id from visto_ai.review_runs');
  const notices = calls.filter((c) => c[0] === 'notify').map((c) => c[1] as Record<string, unknown>);
  assert.equal(notices.length, 1);
  assert.deepEqual([notices[0]!.run, notices[0]!.repository, notices[0]!.number, notices[0]!.reviewUrl, notices[0]!.pullRequestUrl], [
    runs[0]!.id, 'acme/shop', 7, 'https://git.example.test/acme/shop/pull/7#review-501', 'https://git.example.test/acme/shop/pull/7',
  ]);
  assert.equal(h.logged.some((e) => e.event === 'extensions_quiet'), false);
});
test('in dry run no notifier and no sink is called, and the start says so once', async () => {
  const { module, calls } = chatModule();
  const h = await harness({ extensions: [module], lacks: LACKS });
  await (await h.start()).settled;
  await h.webhook(pr('opened'), 'd1');
  await h.until(async () => (await h.db.query<{ n: number }>("select count(*)::int as n from visto_ai.jobs where kind = 'review' and status = 'done'"))[0]!.n === 1);
  await h.flush();
  assert.equal((await h.db.query('select id from visto_ai.review_runs')).length, 1);
  assert.equal(alertsOf(h, 'feature_off').length, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(h.logged.filter((e) => e.event === 'extensions_quiet'), [{ event: 'extensions_quiet', reason: 'dry_run', notifiers: 1, sinks: 1 }]);
});
test('a provider that starts failing raises one alert, and one more when it works again', async () => {
  const h = await harness({ extensions: [{ name: 'tickets', parts: { context: async () => ({ status: 'empty' }) } }] });
  const statuses = [['error', 'timeout'], ['error', 'timeout'], ['ok', 'ok']];
  h.resultFor = (input) => {
    const [status, code] = statuses[h.inputs.indexOf(input)]!;
    return { ...okResult(), dependencies: { model: 'ok', extensions: { tickets: { status: status as 'ok', code: code! } } } };
  };
  await (await h.start()).settled;
  for (const [i, head] of ['h1', 'h2', 'h3'].entries()) {
    h.live = { ...LIVE, info: { ...LIVE.info, headSha: head } };
    h.now = at(i * 3600);
    await h.webhook(pr(i === 0 ? 'opened' : 'synchronize', { headSha: head, updatedAt: at(i * 3600) }), `d${i + 1}`);
    // A push is delayed a little: the clock moves past it and the runner ticks.
    h.now = at(i * 3600 + 600);
    await h.runTimer(TICK_MS);
    await h.until(() => h.logged.filter((e) => e.event === 'review').length === i + 1);
  }
  assert.deepEqual(alertsOf(h, 'extension_error', 'extension_ok'), [
    { event: 'alert', code: 'extension_error', extension: 'tickets', part: 'context', reason: 'timeout' },
    { event: 'alert', code: 'extension_ok', extension: 'tickets', part: 'context' },
  ]);
});
test('an answer a module reports for a published review is stored, and one for a dry run is refused', async () => {
  const out = await harness({ dryRun: false });
  await (await out.start()).settled;
  await out.webhook(pr('opened'), 'd1');
  await out.until(async () => (await out.db.query("select id from visto_ai.review_runs where published")).length === 1);
  const [published] = await out.db.query<{ id: number }>('select id from visto_ai.review_runs');
  const report = createFeedback({ db: out.db, clock: () => new Date(out.now), log: () => {} });
  assert.deepEqual(await report('chat', { run: published!.id, login: 'octo-lead', vote: 'up' }), { ok: true });
  assert.equal((await out.db.query('select id from visto_ai.review_feedback')).length, 1);
  const dry = await harness();
  await (await dry.start()).settled;
  await dry.webhook(pr('opened'), 'd1');
  await dry.until(async () => (await dry.db.query('select id from visto_ai.review_runs')).length === 1);
  const [recorded] = await dry.db.query<{ id: number }>('select id from visto_ai.review_runs');
  const refused = createFeedback({ db: dry.db, clock: () => new Date(dry.now), log: () => {} });
  assert.deepEqual(await refused('chat', { run: recorded!.id, login: 'octo-lead', vote: 'up' }), { ok: false, code: 'unknown_run' });
  assert.equal((await dry.db.query('select id from visto_ai.review_feedback')).length, 0);
});
test('with no module the service starts, reviews and logs as before, and an address under /extensions/ is not found without being read', async () => {
  const h = await harness({ dryRun: false, extensions: [] });
  await (await h.start()).settled;
  const atStart = h.logged.map((e) => e.event);
  assert.deepEqual(atStart, ['recovery', 'model_check', 'app_check']);
  const answer = await h.request('POST', '/extensions/x/y', null);
  assert.deepEqual([answer.status, answer.body], [404, 'not_found']);
  assert.deepEqual(await h.webhook(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
  await h.until(() => h.logged.some((e) => e.event === 'review'));
  await h.flush();
  assert.equal(h.writes.some((w) => w[0] === 'publishReview'), true);
  assert.equal(h.logged.some((e) => typeof e.event === 'string' && (e.event.startsWith('extension') || e.event.startsWith('notice'))), false);
  assert.equal(h.logged.find((e) => e.event === 'review')!.extensions, null);
});
const DOCS_YAML = 'mcpServers:\n  - name: docs\n    url: https://docs.example.test/mcp\n    tools: [search]\n';
/** Three reviews, one for each head, each answered with the MCP map given for it. */
async function threeReviews(h: Awaited<ReturnType<typeof harness>>, maps: Array<Record<string, { status: 'ok' | 'skipped' | 'error'; code: string; calls: number }>>): Promise<void> {
  h.resultFor = (input) => ({ ...okResult(), dependencies: { model: 'ok', mcp: maps[h.inputs.indexOf(input)]! } });
  await (await h.start()).settled;
  for (const [i, head] of ['h1', 'h2', 'h3'].entries()) {
    h.live = { ...LIVE, info: { ...LIVE.info, headSha: head } };
    h.now = at(i * 3600);
    await h.webhook(pr(i === 0 ? 'opened' : 'synchronize', { headSha: head, updatedAt: at(i * 3600) }), `d${i + 1}`);
    h.now = at(i * 3600 + 600);
    await h.runTimer(TICK_MS);
    await h.until(() => h.logged.filter((e) => e.event === 'review').length === i + 1);
  }
}
test('a server that starts failing raises one alert, and one more when it works again', async () => {
  const h = await harness({ repositoriesYaml: DOCS_YAML });
  const failing = { docs: { status: 'error' as const, code: 'tool_not_listed', calls: 0 } };
  await threeReviews(h, [failing, failing, { docs: { status: 'ok', code: 'ok', calls: 1 } }]);
  assert.deepEqual(alertsOf(h, 'mcp_error', 'mcp_ok'), [
    { event: 'alert', code: 'mcp_error', server: 'docs', reason: 'tool_not_listed' },
    { event: 'alert', code: 'mcp_ok', server: 'docs' },
  ]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'review').map((e) => (e.mcp as { docs: { code: string } }).docs.code), ['tool_not_listed', 'tool_not_listed', 'ok']);
});
test('with no server named the service makes no server health', async () => {
  const h = await harness();
  const failing = { docs: { status: 'error' as const, code: 'tool_not_listed', calls: 0 } };
  await threeReviews(h, [failing, failing, { docs: { status: 'ok', code: 'ok', calls: 1 } }]);
  assert.deepEqual(alertsOf(h, 'mcp_error', 'mcp_ok'), []);
  assert.deepEqual(h.logged.filter((e) => e.event === 'review').map((e) => e.mcp), [failing, failing, { docs: { status: 'ok', code: 'ok', calls: 1 } }]);
});

// Learning (Task 9).
const TAX = 'src/billing/tax.ts';
const inlineBy = (over: Partial<HumanInlineComment> = {}): ForgeEvent => ({
  kind: 'inline_comment', ref: REF, installation: '99', comment: {
    id: 'ic-1', author: 'octo-lead', authorIsBot: false, association: 'member', at: at(60), commit: 'h1', path: TAX, side: 'RIGHT',
    line: 12, startLine: null, fileLevel: false, replyTo: null, body: 'check the rounding here', ...over,
  },
});
const stored = (over: Partial<Activity> = {}): Activity => ({
  ref: REF, kind: 'inline_comment', sourceId: 'ic-1', author: 'octo-lead', association: 'member', state: null,
  body: 'check the rounding here', path: TAX, side: 'RIGHT', line: 12, startLine: null, fileLevel: false,
  commit: 'h1', replyTo: null, thread: null, at: at(-7200), delivery: 'd-0', ...over,
});
/** A stored result whose one block, lines 10 to 14 of the file, was scored `score` under a threshold of 70. */
const scoredBlock = (score: number) => ({
  scores: [{ path: TAX, previousPath: null, diffHash: 'd', changeSummary: '', changedLines: 3, wholeFile: null, fileLevel: null, finalScore: score, covered: true,
    blocks: [{ id: 'B1', hunk: 'B1', hunkHash: 'h-low', hash: 'h-low', changedLines: 3, span: { side: 'RIGHT', first: 10, last: 14 },
      lines: { LEFT: [], RIGHT: [[10, 14]] }, entry: { score, category: 'refactor', reason: 'moves a helper' } }] }],
  verdict: { threshold: 70 },
});
const closedFacts = (seconds: number) => ({ state: 'closed' as const, closedAt: at(seconds), updatedAt: at(seconds) });
const memoryRows = async (h: { db: Db }) =>
  h.db.query<{ number: number; source_ref: string; missed: boolean }>('select number, source_ref, missed from visto_ai.memory_records order by id');
const ranAt = async (h: { db: Db }): Promise<Date | null> =>
  (await h.db.query<{ ran_at: Date | null }>("select ran_at from visto_ai.learning where work = 'signals'"))[0]?.ran_at ?? null;
/** The learning timer. It has the upkeep's interval, and is registered after it, by the start. */
const learnTimer = (h: { timers: Timer[] }): Timer => {
  const both = h.timers.filter((t) => t.ms === LEARN_MS);
  assert.equal(both.length, 2);
  return both[1]!;
};
const ofLearning = (logged: Array<Record<string, unknown>>) =>
  logged.filter((e) => typeof e.event === 'string' && (e.event.startsWith('learning') || e.event.startsWith('memory')));

test('with learning off nothing of learning runs: no timer, no log line, no row, no alert', async () => {
  const h = await harness();
  await (await h.start()).settled;
  assert.deepEqual(await h.webhook(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
  await h.reviewed();
  await h.until(() => h.logged.some((e) => e.event === 'review'));
  assert.deepEqual(await h.webhook(inlineBy(), 'd2'), { status: 202, body: 'accepted' });
  assert.deepEqual(await h.webhook(pr('closed', closedFacts(120)), 'd3'), { status: 202, body: 'accepted' });
  h.now = at(40 * 3600);
  for (const timer of [...h.timers]) await timer.work();
  await h.flush();
  // The service's own statements, before this test reads anything.
  assert.deepEqual(h.allQueries.filter(([text]) => /visto_ai\.learning|memory_records|learned_at|learn_attempts/.test(text)), []);
  assert.deepEqual(h.timers.map((t) => t.ms), [TICK_MS, UPKEEP_MS, BEAT_MS]);
  assert.deepEqual(ofLearning(h.logged), []);
  assert.equal(h.logged.some((e) => e.event === 'alert' && /^(learning|memory)/.test(String(e.code))), false);
  assert.equal(h.logged.some((e) => e.event === 'start_step_failed'), false);
  assert.deepEqual(await h.db.query('select 1 from visto_ai.learning'), []);
  assert.deepEqual(await memoryRows(h), []);
  assert.equal(h.reviewDeps.length, 1);
  assert.equal('memory' in h.reviewDeps[0]!, false);
  assert.equal(h.logged.find((e) => e.event === 'review')!.memory, undefined);
});

test('with learning off a merged pull request that names a revert stores the number and nothing else', async () => {
  const h = await harness();
  await (await h.start()).settled;
  assert.deepEqual(await h.webhook(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
  await h.reviewed();
  await h.until(() => h.logged.some((e) => e.event === 'review'));
  const merge = { state: 'merged' as const, mergedAt: at(120), closedAt: at(120), updatedAt: at(120), reverts: 6 };
  assert.deepEqual(await h.webhook(pr('closed', merge), 'd3'), { status: 202, body: 'accepted' });
  h.now = at(40 * 3600);
  for (const timer of [...h.timers]) await timer.work();
  await h.flush();
  // The service's own statements, before this test reads anything.
  assert.deepEqual(h.allQueries.filter(([text]) => /visto_ai\.learning|memory_records|learned_at|learn_attempts/.test(text)), []);
  assert.deepEqual(await h.db.query('select reverts from visto_ai.pull_requests'), [{ reverts: 6 }]);
  assert.deepEqual(h.timers.map((t) => t.ms), [TICK_MS, UPKEEP_MS, BEAT_MS]);
  assert.equal(h.logged.some((e) => e.event === 'revert' || (typeof e.event === 'string' && /^(learning|memory)/.test(e.event))), false);
  assert.equal(h.logged.some((e) => e.event === 'alert'), false);
  assert.deepEqual(await h.db.query('select 1 from visto_ai.learning'), []);
  assert.deepEqual(await memoryRows(h), []);
  assert.equal(h.reviewDeps.length, 1);
  assert.equal('memory' in h.reviewDeps[0]!, false);
});

test('with learning on, the start logs what the work has done so far and a first pass runs', async () => {
  const h = await harness({ learning: true });
  await (await h.start()).settled;
  await h.until(async () => (await ranAt(h)) !== null);
  const events = h.logged.map((e) => e.event);
  assert.deepEqual(h.logged.filter((e) => e.event === 'learning_state'), [
    { event: 'learning_state', since: at(0), last_ran: null, examined: 0, added: 0, retired: 0, failed: 0 },
  ]);
  assert.ok(events.indexOf('learning_state') > events.indexOf('app_check'));
  assert.equal(LEARN_MS, UPKEEP_MS);
  assert.deepEqual(h.timers.map((t) => t.ms).sort(), [TICK_MS, UPKEEP_MS, LEARN_MS, BEAT_MS].sort());
  learnTimer(h);
  assert.equal((await ranAt(h))!.toISOString(), at(0));
});

test('at start the first pass learns what closed while the service was down', async () => {
  const h = await harness({ learning: true, now: at(2 * 86_400) });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts(closedFacts(-3600)));
  await recordActivity(h.db, stored());
  await (await h.start()).settled;
  await h.until(async () => (await memoryRows(h)).length > 0);
  assert.deepEqual(await memoryRows(h), [{ number: 7, source_ref: `7:file:${TAX}`, missed: false }]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'webhook'), []);
});

test('a comment inside a block scored below the threshold is recorded when its delivery arrives, without waiting for the timer', async () => {
  const h = await harness({ learning: true, now: at(600) });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts());
  await recordRun(h.db, run({ headSha: 'h1', result: scoredBlock(35) }));
  await (await h.start()).settled;
  await h.until(async () => (await ranAt(h)) !== null);
  assert.deepEqual(await memoryRows(h), []);
  assert.deepEqual(await h.webhook(inlineBy(), 'd2'), { status: 202, body: 'accepted' });
  await h.until(async () => (await memoryRows(h)).length > 0);
  assert.deepEqual(await memoryRows(h), [{ number: 7, source_ref: `7:h-low:${TAX}`, missed: true }]);
});

test('a pass that fails is logged with a code, and after 36 hours learning_stale is raised once', async () => {
  const h = await harness({ learning: true, failQuery: 'learn_attempts < $1' });
  await (await h.start()).settled;
  await h.until(() => h.logged.some((e) => e.event === 'learning_failed'));
  const failed = h.logged.filter((e) => e.event === 'learning_failed');
  assert.deepEqual(failed.map((e) => Object.keys(e)), [['event', 'reason']]);
  assert.match(String(failed[0]!.reason), /^[a-z][a-z0-9_]{0,39}$/);
  h.now = at(37 * 3600);
  await learnTimer(h).work();
  await learnTimer(h).work();
  assert.deepEqual(alertsOf(h, 'learning_stale'), [{ event: 'alert', code: 'learning_stale', hours: 37 }]);
  assert.equal(h.logged.filter((e) => e.event === 'learning_failed').length, 3);
  assert.equal(await ranAt(h), null);
});

test('a start step that fails still leaves the timer, and the stale alert, in place', async () => {
  const h = await harness({ learning: true, failQuery: 'insert into visto_ai.learning' });
  await (await h.start()).settled;
  assert.deepEqual(h.logged.filter((e) => e.event === 'start_step_failed'), [
    { event: 'start_step_failed', step: 'learning', error: 'Error', code: null, reason: 'db_down' },
  ]);
  assert.equal(h.logged.some((e) => e.event === 'learning_state'), false);
  learnTimer(h);
  assert.equal(h.timers.some((t) => t.ms === BEAT_MS), true);
  h.now = at(37 * 3600);
  await learnTimer(h).work();
  assert.deepEqual(alertsOf(h, 'learning_stale'), [{ event: 'alert', code: 'learning_stale', hours: 37 }]);
});

test('with learning on, the delivery of a merged revert records the reverted files without waiting for the timer', async () => {
  const h = await harness({ learning: true });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  const six = { ...REF, number: 6 };
  await savePullRequest(h.db, facts({ ref: six, state: 'merged', mergedAt: at(-3600), closedAt: at(-3600), updatedAt: at(-3600) }));
  await recordRun(h.db, run({ ref: six, result: scoredBlock(35) }));
  await (await h.start()).settled;
  await h.until(async () => (await ranAt(h)) !== null);
  const merge = { state: 'merged' as const, mergedAt: at(600), closedAt: at(600), updatedAt: at(600), reverts: 6 };
  assert.deepEqual(await h.webhook(pr('closed', merge), 'd3'), { status: 202, body: 'accepted' });
  const reverts = async () =>
    h.db.query<{ number: number; reverted: number; source_ref: string }>("select number, reverted, source_ref from visto_ai.memory_records where kind = 'revert' order by id");
  await h.until(async () => (await reverts()).length > 0);
  assert.deepEqual(await reverts(), [{ number: 7, reverted: 6, source_ref: `7:reverts:6:${TAX}` }]);
  await h.until(() => h.logged.some((e) => e.event === 'revert'));
  assert.deepEqual(h.logged.filter((e) => e.event === 'revert'), [
    { event: 'revert', repo: 'acme/shop', number: 7, reverted: 6, code: 'recorded', files: 1, added: 1, cut: 0 },
  ]);
});

test('stop waits for a pass under way and starts none after it', async () => {
  const h = await harness({ learning: true, now: at(2 * 86_400) });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts(closedFacts(-3600)));
  await recordActivity(h.db, stored());
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  let entered = false;
  // After the recovery: the pass's own transaction waits.
  h.onListen = async () => { h.beforeTransaction = async () => { entered = true; await gate; }; };
  let learnedAtClose: boolean | null = null;
  h.beforeClose = () => { learnedAtClose ??= h.logged.some((e) => e.event === 'learning'); };
  const service = await h.start();
  await service.settled;
  await h.until(() => entered);
  const batches = () => h.allQueries.filter(([text]) => text.includes('learn_attempts < $1')).length;
  const stopped = service.stop();
  await h.flush();
  assert.equal(h.events.includes('close'), false);
  release();
  await stopped;
  assert.equal(learnedAtClose, true);
  assert.deepEqual(await memoryRows(h), [{ number: 7, source_ref: `7:file:${TAX}`, missed: false }]);
  const read = batches();
  await learnTimer(h).work();
  await h.flush();
  assert.equal(batches(), read);
});

test('stop waits for a pass that never settles at most CLOSE_WAIT_MS', async (t) => {
  const h = await harness({ learning: true, now: at(2 * 86_400) });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts(closedFacts(-3600)));
  await recordActivity(h.db, stored());
  let entered = false;
  // The pass waits until the test lets it go, which it does only once it has looked at the stop.
  let letGo!: () => void;
  const held = new Promise<void>((done) => { letGo = done; });
  h.onListen = async () => { h.beforeTransaction = async () => { entered = true; await held; }; };
  const service = await h.start();
  await service.settled;
  await h.until(() => entered);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ended = false;
  void service.stop().then(() => { ended = true; });
  try {
    for (let i = 0; i < 20 && !h.events.includes('close'); i += 1) await h.flush();
    assert.equal(h.events.includes('close'), false);
    for (let i = 0; i < 20 && !ended; i += 1) {
      t.mock.timers.tick(CLOSE_WAIT_MS);
      await h.flush();
    }
    // Read through a flag, not awaited: a stop that waits for the pass without a limit fails here rather than hangs.
    assert.equal(ended, true, 'the stop did not end once the mocked time had passed');
    assert.equal(h.events.includes('close'), true);
  } finally {
    // A failure above must not leave the stop waiting: the clean-up after the test waits for the same stop.
    letGo();
    for (let i = 0; i < 20 && !ended; i += 1) {
      t.mock.timers.tick(CLOSE_WAIT_MS);
      await h.flush();
    }
  }
});

test('a review of a repository with a record is given it', async () => {
  const errored = { ...okResult(), dependencies: { model: 'ok' as const, memory: { status: 'error' as const, code: 'timeout', lines: 0 } } };
  const h = await harness({ learning: true, result: errored });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await addRecords(h.db, { service: 'github', owner: 'acme', repo: 'shop' }, [{
    kind: 'human_signal', sourceRef: `8:file:${TAX}`, number: 8, path: TAX, directory: 'src/billing', category: null, reason: null,
    missed: false, excerpt: '', comment: 'ic-9', createdAt: at(-86_400), expiresAt: at(180 * 86_400),
  }]);
  await (await h.start()).settled;
  for (const [i, head] of ['h1', 'h2'].entries()) {
    h.live = { ...LIVE, info: { ...LIVE.info, headSha: head } };
    h.now = at(i * 3600);
    await h.webhook(pr(i === 0 ? 'opened' : 'synchronize', { headSha: head, updatedAt: at(i * 3600) }), `d${i + 1}`);
    h.now = at(i * 3600 + 600);
    await h.runTimer(TICK_MS);
    await h.until(() => h.logged.filter((e) => e.event === 'review').length === i + 1);
  }
  const memory = h.reviewDeps[0]!.memory!;
  assert.notEqual(memory, undefined);
  const blocks = await memory.blocks([{ path: TAX, previousPath: null }], new Date(at(600)), new AbortController().signal);
  assert.deepEqual(blocks.pullRequest.map((l) => l.ref), [`8:file:${TAX}`]);
  assert.deepEqual(alertsOf(h, 'memory_error', 'memory_ok'), [{ event: 'alert', code: 'memory_error', reason: 'timeout' }]);
});

// The judge (Task 9).
const FINDING = { path: TAX, side: 'RIGHT', line: 12, severity: 'major', quote: 'total = round(sum)', body: 'Rounds before the discount is taken off.' };
const REPLY_BODY = 'We round half up here on purpose, as the invoices require it.';
const QUOTE = 'round half up here on purpose';
const LESSON = 'A rounding finding on invoice totals is wrong: invoices round half up on purpose.';
const pushback = (cost = 0.25): ModelResponse => ({
  toolName: 'submit_verdict', toolArguments: JSON.stringify({ classification: 'valid_pushback', lesson: LESSON, quote: QUOTE }), text: null,
  model: 'm', provider: null, usage: { calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, cost },
});
/** Pull request 7 with a run of yesterday whose one finding was posted as c-1, and `replies` members' replies to it, written yesterday. */
async function queueReplies(h: { db: Db }, replies: number): Promise<void> {
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts());
  const id = await recordRun(h.db, run({ result: { findings: [FINDING] }, usage: { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 } }));
  await recordComments(h.db, id, REF, [{ commentId: 'c-1', path: TAX, side: 'RIGHT', line: 12, severity: 'major', quote: 'total = round(sum)' }]);
  for (let i = 1; i <= replies; i += 1) {
    await recordActivity(h.db, stored({ sourceId: `r-${i}`, replyTo: 'c-1', body: REPLY_BODY, at: at(3600 + i), delivery: `d-r${i}` }));
  }
}
const ofJudge = (logged: Array<Record<string, unknown>>) => logged.filter((e) => typeof e.event === 'string' && e.event.startsWith('lessons'));
const judgeRows = async (h: { db: Db }) => ({
  verdicts: await h.db.query<{ reply: string; outcome: string }>('select reply, outcome from visto_ai.reply_verdicts order by reply'),
  calls: await h.db.query<{ reply: string }>('select reply from visto_ai.judge_calls order by id'),
  lessons: await h.db.query<{ source_ref: string }>("select source_ref from visto_ai.memory_records where kind = 'lesson' order by id"),
});
const lessonsLine = (h: { logged: Array<Record<string, unknown>> }) => h.logged.filter((e) => e.event === 'lessons');

test('with learning off nothing of the judge runs: no row, no log line, no model call, no alert', async () => {
  const h = await harness({ now: at(86_400) });
  await queueReplies(h, 1);
  h.answer = async () => pushback();
  await (await h.start()).settled;
  for (const timer of [...h.timers]) await timer.work();
  await h.flush();
  assert.deepEqual(h.timers.map((t) => t.ms), [TICK_MS, UPKEEP_MS, BEAT_MS]);
  assert.deepEqual(ofJudge(h.logged), []);
  assert.equal(h.logged.some((e) => e.event === 'alert' && String(e.code).startsWith('lessons')), false);
  assert.deepEqual(await h.db.query('select 1 from visto_ai.learning'), []);
  assert.deepEqual(await judgeRows(h), { verdicts: [], calls: [], lessons: [] });
  assert.deepEqual(h.modelRequests, []);
});

test('with learning on the start logs the judge\'s row after the learning\'s, and no run starts before the timer', async () => {
  const h = await harness({ learning: true, now: at(86_400) });
  await queueReplies(h, 1);
  h.answer = async () => pushback();
  await (await h.start()).settled;
  await h.flush();
  const events = h.logged.map((e) => e.event);
  assert.deepEqual(h.logged.filter((e) => e.event === 'lessons_state'), [
    { event: 'lessons_state', since: at(86_400), last_ran: null, judged: 0, lessons: 0, given_up: 0, failed: 0 },
  ]);
  assert.ok(events.indexOf('lessons_state') > events.indexOf('learning_state'));
  assert.ok(events.indexOf('learning_state') >= 0);
  assert.deepEqual(h.timers.map((t) => t.ms).sort(), [TICK_MS, UPKEEP_MS, LEARN_MS, BEAT_MS].sort());
  learnTimer(h);
  assert.deepEqual(h.modelRequests, []);
  assert.deepEqual(await h.db.query("select ran_at from visto_ai.learning where work = 'lessons'"), [{ ran_at: null }]);
});

test('the learning timer starts the day\'s run, and a member\'s reply to a finding becomes a lesson', async () => {
  const h = await harness({ learning: true, now: at(86_400), dryRun: false });
  await queueReplies(h, 1);
  h.answer = async () => pushback();
  await (await h.start()).settled;
  await learnTimer(h).work();
  await h.until(() => lessonsLine(h).length === 1);
  assert.equal(h.modelRequests.length, 1);
  assert.deepEqual(await judgeRows(h), { verdicts: [{ reply: 'r-1', outcome: 'lesson' }], calls: [{ reply: 'r-1' }], lessons: [{ source_ref: '7:r-1' }] });
  assert.deepEqual(lessonsLine(h), [{ event: 'lessons', judged: 1, lessons: 1, given_up: 0, failed: 0, calls: 1, cost: 0.25, more: false, end: 'done' }]);
  // The judge's request has the review's tool choice and time limit, and the service's token.
  assert.equal(h.modelRequests[0]!.forcedTool, 'submit_verdict');
  assert.equal(h.modelRequests[0]!.timeoutMs, config.model.timeoutSeconds * 1000);
  assert.ok(JSON.stringify(h.modelRequests[0]!.messages).includes('tok-test'));
  await learnTimer(h).work();
  await h.flush();
  assert.equal(h.modelRequests.length, 1);
  assert.equal(lessonsLine(h).length, 1);
});

test('at the daily limit the judge makes no call, and what the judge spends pauses the reviews', async () => {
  const h = await harness({ learning: true, now: at(86_400) });
  await queueReplies(h, 1);
  await recordRun(h.db, run({ startedAt: at(86_000), finishedAt: at(86_100), usage: { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 50 } }));
  h.answer = async () => pushback();
  await (await h.start()).settled;
  await learnTimer(h).work();
  await h.until(() => lessonsLine(h).length === 1);
  assert.deepEqual(h.modelRequests, []);
  assert.equal(lessonsLine(h)[0]!.end, 'spend_limit');

  const k = await harness({ learning: true, now: at(86_400) });
  await queueReplies(k, 2);
  k.answer = async () => pushback(50);
  await (await k.start()).settled;
  await learnTimer(k).work();
  await k.until(() => lessonsLine(k).length === 1);
  assert.equal(k.modelRequests.length, 1);
  assert.deepEqual(lessonsLine(k)[0], { event: 'lessons', judged: 1, lessons: 1, given_up: 0, failed: 0, calls: 1, cost: 50, more: true, end: 'spend_limit' });
  assert.deepEqual((await judgeRows(k)).verdicts, [{ reply: 'r-1', outcome: 'lesson' }]);
  assert.deepEqual(await k.webhook(pr('opened', { updatedAt: at(86_400) }), 'd-open'), { status: 202, body: 'accepted' });
  await k.runTimer(TICK_MS);
  await k.flush();
  assert.deepEqual(k.inputs, []);
});

test('stop tells the run under way, waits for it at most CLOSE_WAIT_MS, and nothing is written after', async (t) => {
  const h = await harness({ learning: true, now: at(86_400) });
  await queueReplies(h, 2);
  let answer!: () => void;
  const answered = new Promise<void>((done) => { answer = done; });
  h.answer = async () => { await answered; return pushback(); };
  let statementsAtClose: number | null = null;
  h.beforeClose = () => { statementsAtClose ??= h.allQueries.length; };
  const service = await h.start();
  await service.settled;
  // The timer's work starts the run and does not wait for it: it settles while the model's answer is still held.
  let worked = false;
  void learnTimer(h).work().then(() => { worked = true; });
  await h.until(() => h.modelRequests.length === 1);
  try {
    await h.until(() => worked);
  } catch {
    answer();
    assert.fail('the timer\'s work waited for the run');
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ended = false;
  void service.stop().then(() => { ended = true; });
  try {
    for (let i = 0; i < 20 && !h.events.includes('close'); i += 1) await h.flush();
    assert.equal(h.events.includes('close'), false);
    for (let i = 0; i < 20 && !ended; i += 1) {
      t.mock.timers.tick(CLOSE_WAIT_MS);
      await h.flush();
    }
    // Read through a flag, not awaited: a stop that waits for the run without a limit fails here rather than hangs.
    assert.equal(ended, true, 'the stop did not end once the mocked time had passed');
    assert.equal(h.events.includes('close'), true);
  } finally {
    // A failure above must not leave the stop waiting: the clean-up after the test waits for the same stop.
    answer();
    for (let i = 0; i < 20 && !ended; i += 1) {
      t.mock.timers.tick(CLOSE_WAIT_MS);
      await h.flush();
    }
  }
  t.mock.timers.reset();
  await h.until(() => lessonsLine(h).length === 1);
  assert.equal(lessonsLine(h)[0]!.end, 'stopped');
  assert.equal(h.modelRequests.length, 1);
  assert.equal(h.allQueries.length, statementsAtClose);
});

test('in dry run the judge runs as it does out of it', async () => {
  const h = await harness({ learning: true, now: at(86_400), dryRun: true });
  await queueReplies(h, 1);
  h.answer = async () => pushback();
  await (await h.start()).settled;
  await learnTimer(h).work();
  await h.until(() => lessonsLine(h).length === 1);
  assert.equal(h.modelRequests.length, 1);
  assert.deepEqual(await judgeRows(h), { verdicts: [{ reply: 'r-1', outcome: 'lesson' }], calls: [{ reply: 'r-1' }], lessons: [{ source_ref: '7:r-1' }] });
  assert.equal(lessonsLine(h)[0]!.end, 'done');
});

test('the stop tells the judge first: a call that returns after it ends the run, and the stop does not wait out its limit', async (t) => {
  const h = await harness({ learning: true, now: at(86_400) });
  await queueReplies(h, 2);
  let answer!: () => void;
  const answered = new Promise<void>((done) => { answer = done; });
  // The first answer is held; any later one comes at once.
  h.answer = async () => { if (h.modelRequests.length === 1) await answered; return pushback(); };
  const service = await h.start();
  await service.settled;
  // Not awaited: the first answer is held until the stop has begun.
  void learnTimer(h).work();
  await h.until(() => h.modelRequests.length === 1);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ended = false;
  void service.stop().then(() => { ended = true; });
  try {
    for (let i = 0; i < 20; i += 1) await h.flush();
    assert.equal(ended, false);
    // The mocked time does not move: the stop can end only because the run ended.
    answer();
    for (let i = 0; i < 50 && !ended; i += 1) await h.flush();
    assert.equal(ended, true, 'the stop did not end when the run under way ended');
  } finally {
    answer();
    for (let i = 0; i < 20 && !ended; i += 1) {
      t.mock.timers.tick(CLOSE_WAIT_MS);
      await h.flush();
    }
  }
  t.mock.timers.reset();
  assert.equal(h.modelRequests.length, 1);
  // A stopped run logs its line, with what it did before the stop and no statement after it.
  assert.deepEqual(lessonsLine(h), [{ event: 'lessons', judged: 0, lessons: 0, given_up: 0, failed: 0, calls: 1, cost: 0.25, more: true, end: 'stopped' }]);
  assert.deepEqual(await judgeRows(h), { verdicts: [], calls: [], lessons: [] });
});

test('the judge\'s usage reaches the spend guard: tokens with no cost raise cost_unknown', async () => {
  const h = await harness({ learning: true, now: at(86_400) });
  await queueReplies(h, 1);
  h.answer = async () => pushback(0);
  await (await h.start()).settled;
  await learnTimer(h).work();
  await h.until(() => lessonsLine(h).length === 1);
  assert.equal(h.modelRequests.length, 1);
  assert.deepEqual(alertsOf(h, 'cost_unknown'), [{ event: 'alert', code: 'cost_unknown' }]);
});

test('the judge has the configured tool choice: under auto it names no tool to call, under forced submit_verdict', async () => {
  for (const [choice, forced] of [['auto', null], ['forced', 'submit_verdict']] as const) {
    const h = await harness({ learning: true, now: at(86_400), toolChoice: choice });
    await queueReplies(h, 1);
    h.answer = async () => pushback();
    await (await h.start()).settled;
    await learnTimer(h).work();
    await h.until(() => lessonsLine(h).length === 1);
    assert.equal(h.modelRequests.length, 1, choice);
    assert.equal(h.modelRequests[0]!.forcedTool, forced, choice);
    assert.deepEqual(h.modelRequests[0]!.tools.map((tool) => tool.function.name), ['submit_verdict'], choice);
  }
});

// Withdrawals: a lane of their own.

/** Approvals as GitHub answers them: the branch's rule dismisses, a review stands approved until it is dismissed. `hold` makes readReview wait. Each call is kept as [name, ...args]. */
function approvalsFake(hold?: Promise<void>): { approvals: ForgeApprovals; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const dismissed = new Set<string>();
  return {
    calls,
    approvals: {
      staleApprovals: async (_ref, installation, branch) => { calls.push(['staleApprovals', installation, branch]); return 'dismissed'; },
      readReview: async (_ref, installation, reviewId) => {
        calls.push(['readReview', installation, reviewId]);
        if (hold !== undefined) await hold;
        return { state: dismissed.has(reviewId) ? 'dismissed' : 'approved', commit: null };
      },
      dismissReview: async (_ref, installation, reviewId, message) => { calls.push(['dismissReview', installation, reviewId, message]); dismissed.add(reviewId); },
    },
  };
}
/** Automatic approval on for every repository. */
const APPROVAL_YAML = 'repositories:\n  defaults: { score: { autoApprove: true, auditShare: 0 } }\n';
/** The pull request, from the repository itself, at `head`. */
const liveAt = (head: string): LivePullRequest => ({ ...LIVE, info: { ...LIVE.info, headSha: head, fromFork: false } });
/** A result every stored condition of approval holds for: its one file covered at 35, one minor finding, threshold 70. */
const approvable = (): ReviewResult => ({
  ...okResult(),
  scores: [{
    path: 'a.ts', previousPath: null, diffHash: 'd', changeSummary: '', changedLines: 1, wholeFile: null, fileLevel: null, finalScore: 35, covered: true,
    blocks: [{
      id: 'B1', hunk: 'B1', hunkHash: 'h', hash: 'h', changedLines: 1, span: { side: 'RIGHT', first: 3, last: 3 },
      lines: { old: [], new: [] } as unknown as BlockScore['lines'], entry: { score: 35, category: 'calculation', reason: '' },
    }],
  }],
});
/** A run at `head` against main published as review `reviewId`, an approval that stands. Its id is returned. */
async function approvalOf(db: Db, reviewId: string, head = 'h1', number = 7): Promise<number> {
  const id = await recordRun(db, run({ ref: { ...REF, number }, dryRun: false, headSha: head, baseSha: 'merge000', baseBranch: 'main', startedAt: at(-60), finishedAt: at(-50) }));
  await markPublished(db, id, { reviewId, publishedAt: at(-50), body: 'Approved.', inlineDropped: false, approved: true, approvalCode: 'approved' });
  return id;
}
const approvalRows = (db: Db) => db.query<{ id: number; approved: boolean; approval_code: string | null; dismissed_by: string | null; dismiss_failure: string | null }>(
  'select id, approved, approval_code, dismissed_by, dismiss_failure from visto_ai.review_runs where approved order by id');
const withdrawRows = (db: Db) => db.query<{ number: number; status: string; outcome: string | null; installation: string | null }>(
  "select number, status, outcome, installation from visto_ai.jobs where kind = 'withdraw' order by id");

test('a push on an approved pull request withdraws its approval in its own lane', async () => {
  const seen = approvalsFake();
  const h = await harness({ dryRun: false, repositoriesYaml: APPROVAL_YAML, threads: [], result: approvable(), approvals: seen.approvals });
  h.live = liveAt('h1');
  await (await h.start()).settled;
  // The review of h1 is posted as an approval; the withdraw job stored with it runs at once, reads it, and finds nothing to withdraw.
  await h.webhook(pr('opened'), 'd1');
  await h.until(async () => (await withdrawRows(h.db)).some((j) => j.status === 'done'));
  assert.deepEqual((await approvalRows(h.db)).map((r) => [r.approved, r.approval_code, r.dismissed_by]), [[true, 'approved', null]]);
  assert.deepEqual(await withdrawRows(h.db), [{ number: 7, status: 'done', outcome: 'kept', installation: '99' }]);
  // Reviews are paused for the day; then a push: its review waits, and the withdrawal does not.
  await recordRun(h.db, run({ startedAt: at(0), usage: { ...run().usage, cost: 50 } }));
  h.live = liveAt('h2');
  h.now = at(5);
  assert.deepEqual(await h.webhook(pr('synchronize', { headSha: 'h2', updatedAt: at(5) }), 'd2'), { status: 202, body: 'accepted' });
  // A job's line is the last thing it writes.
  await h.until(() => h.logged.filter((e) => e.event === 'withdraw').length === 2);
  // The first job read the approval and kept it; the push's job read it again and dismissed it.
  assert.deepEqual(seen.calls, [
    ['staleApprovals', '99', 'main'], ['readReview', '99', '501'], ['readReview', '99', '501'], ['dismissReview', '99', '501', dismissMessage('h1')],
  ]);
  assert.deepEqual((await approvalRows(h.db)).map((r) => [r.approved, r.dismissed_by]), [[true, 'app']]);
  assert.deepEqual((await withdrawRows(h.db)).map((j) => [j.status, j.outcome]), [['done', 'kept'], ['done', 'done']]);
  assert.deepEqual(h.logged.filter((e) => e.event === 'withdraw').map((e) => [e.outcome, e.dismissed]), [['kept', 0], ['done', 1]]);
  // No timer ran it; the push's review is still waiting, after its quiet period too.
  h.now = at(200);
  await h.runTimer(TICK_MS);
  await h.flush();
  assert.deepEqual([h.inputs.length, (await pending(h.db, 'review')).map((j) => [j.reason, j.status])], [1, [['opened', 'done'], ['synchronize', 'pending']]]);
});

test('the service hands the review job the audit key the config names', async () => {
  // Under the key V holds, acme/shop 7 is drawn above 18.8899: at 18.88 it is approved, at 18.9 it is drawn. Without the key both would be drawn.
  // approvalRows reads only approved rows, so an audited one is read here by a query of its own.
  const decided = (db: Db) => db.query<{ approved: boolean; approval_code: string | null }>(
    'select approved, approval_code from visto_ai.review_runs where number = 7 and published order by id');
  for (const [share, approved, code] of [['18.88', true, 'approved'], ['18.9', false, 'audit_sample']] as const) {
    const seen = approvalsFake();
    const yaml = `auditKey: { env: V }\nrepositories:\n  defaults: { score: { autoApprove: true, auditShare: ${share} } }\n`;
    const h = await harness({ dryRun: false, repositoriesYaml: yaml, threads: [], result: approvable(), approvals: seen.approvals });
    h.live = liveAt('h1');
    await (await h.start()).settled;
    await h.webhook(pr('opened'), 'd1');
    // A job's line is the last thing it writes; an approval's withdraw job, stored with it, then runs at once.
    await h.until(() => h.logged.some((e) => e.event === 'review'));
    if (approved) await h.until(async () => (await withdrawRows(h.db)).some((j) => j.status === 'done'));
    await h.flush();
    assert.deepEqual((await decided(h.db)).map((r) => [r.approved, r.approval_code]), [[approved, code]], share);
    const line = h.logged.find((e) => e.event === 'review')!;
    assert.deepEqual([line.approved, line.approval], [approved, code], share);
    // Posted once. The approval is read back by its withdraw job; the audited review is no approval: nothing stands, and no withdraw job is asked.
    assert.deepEqual(h.writes.filter((w) => w[0] === 'publishReview'), [['publishReview', 'h1']], share);
    assert.deepEqual(seen.calls, approved ? [['staleApprovals', '99', 'main'], ['readReview', '99', '501']] : [['staleApprovals', '99', 'main']], share);
    assert.deepEqual((await withdrawRows(h.db)).map((j) => [j.status, j.outcome]), approved ? [['done', 'kept']] : [], share);
    assert.equal(JSON.stringify(h.logged).includes(ENV.V), false, share);
  }
});

test('at start a standing approval whose withdrawal failed is asked for again on an open pull request, and nothing is logged when none is', async () => {
  const seen = approvalsFake();
  const h = await harness({ gate: true, threads: [], approvals: seen.approvals });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts({ headSha: 'h2' }));
  await markDismissFailed(h.db, await approvalOf(h.db, '501'), 'github_403');
  // A merged pull request keeps its failure as it is.
  await savePullRequest(h.db, facts({ ref: { ...REF, number: 8 }, headSha: 'h2', state: 'merged', mergedAt: at(-5), closedAt: at(-5) }));
  await markDismissFailed(h.db, await approvalOf(h.db, '502', 'h1', 8), 'github_403');
  h.live = liveAt('h2');
  let atListen: unknown[] = [];
  h.onListen = async () => { atListen = h.logged.map((e) => e.event); };
  await (await h.start()).settled;
  assert.deepEqual(atListen, ['recovery', 'gate_sweep', 'withdraw_sweep']);
  assert.deepEqual(h.logged.filter((e) => e.event === 'withdraw_sweep'), [{ event: 'withdraw_sweep', asked: 1 }]);
  await h.until(async () => (await approvalRows(h.db))[0]!.dismissed_by !== null);
  assert.deepEqual((await approvalRows(h.db)).map((r) => [r.dismissed_by, r.dismiss_failure]), [['app', null], [null, 'github_403']]);
  assert.deepEqual(seen.calls.filter((c) => c[0] !== 'staleApprovals'), [['readReview', '99', '501'], ['dismissReview', '99', '501', dismissMessage('h1')]]);
  // None failed: nothing is logged, nothing is asked, and no row of the pull requests is read at start; in dry run nothing is asked either.
  for (const [options, failed] of [[{ dryRun: false }, false], [{ dryRun: true }, true]] as const) {
    const other = await harness({ ...options, approvals: approvalsFake().approvals });
    await migrate(other.db, loadMigrations(MIGRATIONS_DIR));
    await savePullRequest(other.db, facts({ headSha: 'h2' }));
    const standing = await approvalOf(other.db, '501');
    if (failed) await markDismissFailed(other.db, standing, 'github_403');
    other.allQueries.length = 0;
    let statements: string[] = [];
    other.onListen = async () => { statements = other.allQueries.map(([text]) => text); };
    await (await other.start()).settled;
    await other.flush();
    const label = JSON.stringify(options);
    assert.deepEqual([other.logged.filter((e) => e.event === 'withdraw_sweep'), await withdrawRows(other.db)], [[], []], label);
    assert.deepEqual(statements.filter((text) => text.includes('visto_ai.pull_requests')), [], label);
  }
});

test('the app is asked what it lacks for approval when a repository has it on', async () => {
  for (const [yaml, approval] of [
    [APPROVAL_YAML, true], ['repositories:\n  overrides:\n    acme/shop: { score: { autoApprove: true, auditShare: 0 } }\n', true],
    ['repositories:\n  defaults: { score: { approvalThreads: gate, auditShare: 0 } }\n', false], [undefined, false],
  ] as const) {
    const h = await harness({ dryRun: false, ...(yaml === undefined ? {} : { repositoriesYaml: yaml }) });
    await (await h.start()).settled;
    assert.deepEqual([h.lacksCalls, h.approvalCalls], [[false], [approval]], String(yaml));
  }
});

test('stop drains the withdraw runner too', async (t) => {
  assert.equal(WITHDRAW_CONCURRENCY, 2);
  let release!: () => void;
  const hold = new Promise<void>((done) => { release = done; });
  const seen = approvalsFake(hold);
  const h = await harness({ dryRun: false, approvals: seen.approvals });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts({ headSha: 'h2' }));
  await approvalOf(h.db, '501');
  h.live = liveAt('h2');
  const service = await h.start();
  await service.settled;
  // Stored while the service runs, with no delivery to wake the runner: the timer starts it.
  await askWithdraw(h.db, REF, at(0), '99');
  await h.runTimer(TICK_MS);
  await h.until(() => seen.calls.length === 1);
  const stopping = service.stop();
  await h.flush();
  assert.equal(h.events.includes('listener-close'), false);
  release();
  await stopping;
  assert.deepEqual(h.events.slice(-3), ['listener-close', 'close', 'release']);
  assert.deepEqual([await withdrawRows(h.db), (await approvalRows(h.db)).map((r) => r.dismissed_by)], [[{ number: 7, status: 'done', outcome: 'done', installation: '99' }], ['app']]);
  // A withdrawal that never ends is cut once DRAIN_WAIT_MS has passed, and counted.
  const stuck = await harness({ dryRun: false, approvals: approvalsFake(never()).approvals });
  await migrate(stuck.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(stuck.db, facts({ headSha: 'h2' }));
  await approvalOf(stuck.db, '501');
  stuck.live = liveAt('h2');
  await askWithdraw(stuck.db, REF, at(0), '99');
  const cut = await stuck.start();
  await cut.settled;
  await stuck.until(async () => (await withdrawRows(stuck.db))[0]!.status === 'running');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ending = cut.stop();
  await stuck.flush();
  t.mock.timers.tick(DRAIN_WAIT_MS);
  await ending;
  assert.deepEqual(stuck.logged.find((e) => e.event === 'drain_timeout'), { event: 'drain_timeout', running: 1 });
});

test('a withdraw job the runner drops, as too old or out of starts, records why on each standing approval, alerts once with its pull request, and asks the gate when it is on', async () => {
  for (const [how, gate] of [['too_old', true], ['too_old', false], ['attempts_exhausted', true], ['attempts_exhausted', false]] as const) {
    const label = `${how} ${gate ? 'gate' : 'no gate'}`;
    const h = await harness(gate ? { gate: true, threads: [] } : { dryRun: false });
    await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
    // No stored pull request: the sweeps at start ask for nothing.
    await approvalOf(h.db, '501', 'h0');
    await approvalOf(h.db, '502', 'h1');
    const id = (await askWithdraw(h.db, REF, how === 'too_old' ? at(-90_000) : at(0), '99'))!;
    if (how === 'attempts_exhausted') await h.db.query('update visto_ai.jobs set starts = 3 where id = $1', [id]);
    await (await h.start()).settled;
    await h.until(() => alertsOf(h, 'dismissal_failed').length > 0);
    assert.deepEqual([(await jobOf(h.db, id)).status, (await jobOf(h.db, id)).outcome], ['dropped', how], label);
    assert.deepEqual((await approvalRows(h.db)).map((r) => [r.dismissed_by, r.dismiss_failure]), [[null, how], [null, how]], label);
    assert.deepEqual(alertsOf(h, 'dismissal_failed'), [{ event: 'alert', code: 'dismissal_failed', reason: how, repo: 'acme/shop', number: 7 }], label);
    if (gate) {
      // The check of the live head fails while the approvals stand.
      await h.until(() => h.written().length > 0);
      assert.deepEqual(h.written().map((c) => [c.commit, c.conclusion, c.title]), [['h1', 'failure', `Earlier approval not withdrawn (${how})`]], label);
      assert.deepEqual((await pending(h.db, 'gate')).map((j) => j.reason), ['sync'], label);
    } else {
      await h.flush();
      assert.deepEqual([await h.gateJobs(), h.checked], [[], []], label);
    }
    assert.equal(h.logged.some((e) => e.event === 'runner_failed'), false, label);
  }
  // A step that fails changes nothing else: the approvals cannot be read, and the alert is raised and the gate asked all the same.
  const h = await harness({ gate: true, threads: [], failQuery: 'review_id is not null' });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await approvalOf(h.db, '501', 'h0');
  await askWithdraw(h.db, REF, at(-90_000), '99');
  await (await h.start()).settled;
  await h.until(async () => (await h.gateJobs()).length === 1 && alertsOf(h, 'dismissal_failed').length === 1);
  assert.deepEqual([(await approvalRows(h.db)).map((r) => r.dismiss_failure), h.logged.some((e) => e.event === 'runner_failed')], [[null], false]);
});

test('a withdraw job the runner drops raises no alert when no approval stands, nor when each one already carried a recorded failure', async () => {
  for (const how of ['too_old', 'attempts_exhausted'] as const) {
    for (const failed of [false, true]) {
      const label = `${how} ${failed ? 'failed before' : 'none standing'}`;
      const h = await harness({ dryRun: false });
      await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
      if (failed) await markDismissFailed(h.db, await approvalOf(h.db, '501', 'h0'), 'github_403');
      const id = (await askWithdraw(h.db, REF, how === 'too_old' ? at(-90_000) : at(0), '99'))!;
      if (how === 'attempts_exhausted') await h.db.query('update visto_ai.jobs set starts = 3 where id = $1', [id]);
      await (await h.start()).settled;
      await h.until(async () => (await jobOf(h.db, id)).status === 'dropped');
      await h.flush();
      assert.deepEqual(alertsOf(h, 'dismissal_failed'), [], label);
      // The reason is recorded all the same on an approval that carried a failure.
      assert.deepEqual((await approvalRows(h.db)).map((r) => r.dismiss_failure), failed ? [how] : [], label);
    }
  }
  // A mark the database refuses counts as new: raised, though the approval carried a failure.
  const refused = await harness({ dryRun: false, failQuery: 'set dismiss_failure = $2' });
  await migrate(refused.db, loadMigrations(MIGRATIONS_DIR));
  const standing = await approvalOf(refused.db, '501', 'h0');
  await refused.db.query("update visto_ai.review_runs set dismiss_failure = 'github_403' where id = $1", [standing]);
  const id = (await askWithdraw(refused.db, REF, at(0), '99'))!;
  await refused.db.query('update visto_ai.jobs set starts = 3 where id = $1', [id]);
  await (await refused.start()).settled;
  await refused.until(() => alertsOf(refused, 'dismissal_failed').length > 0);
  assert.deepEqual(alertsOf(refused, 'dismissal_failed'), [{ event: 'alert', code: 'dismissal_failed', reason: 'attempts_exhausted', repo: 'acme/shop', number: 7 }]);
  assert.deepEqual((await approvalRows(refused.db)).map((r) => r.dismiss_failure), ['github_403']);
});

test('a withdraw job dropped as too old is asked for again at once, and its re-check withdraws what no longer holds and clears what holds; one out of starts, or in dry run, is not', async () => {
  const seen = approvalsFake();
  const h = await harness({ dryRun: false, approvals: seen.approvals });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  const old = await approvalOf(h.db, '501', 'h0');
  const held = await approvalOf(h.db, '502', 'h1');
  h.live = liveAt('h1');
  await askWithdraw(h.db, REF, at(-90_000), '99');
  await (await h.start()).settled;
  await h.until(async () => (await withdrawRows(h.db)).some((j) => j.status === 'done'));
  // The dropped job, then the one stored in its place with its installation, run at once by the lane.
  assert.deepEqual(await withdrawRows(h.db), [
    { number: 7, status: 'dropped', outcome: 'too_old', installation: '99' },
    { number: 7, status: 'done', outcome: 'done', installation: '99' },
  ]);
  // The approval of another head is dismissed; the one at the live head, the newest review, holds and its failure is cleared.
  assert.deepEqual((await approvalRows(h.db)).map((r) => [r.id, r.dismissed_by, r.dismiss_failure]), [[old, 'app', null], [held, null, null]]);
  assert.deepEqual(seen.calls, [['readReview', '99', '501'], ['dismissReview', '99', '501', dismissMessage('h0')], ['readReview', '99', '502']]);
  assert.deepEqual(alertsOf(h, 'dismissal_failed'), [{ event: 'alert', code: 'dismissal_failed', reason: 'too_old', repo: 'acme/shop', number: 7 }]);

  // Out of starts, or in dry run: no job is stored in its place.
  for (const [how, dryRun] of [['attempts_exhausted', false], ['too_old', true]] as const) {
    const label = `${how}${dryRun ? ' in dry run' : ''}`;
    const other = await harness({ dryRun, approvals: approvalsFake().approvals });
    await migrate(other.db, loadMigrations(MIGRATIONS_DIR));
    await approvalOf(other.db, '501', 'h0');
    const dropped = (await askWithdraw(other.db, REF, how === 'too_old' ? at(-90_000) : at(0), '99'))!;
    if (how === 'attempts_exhausted') await other.db.query('update visto_ai.jobs set starts = 3 where id = $1', [dropped]);
    await (await other.start()).settled;
    await other.until(() => alertsOf(other, 'dismissal_failed').length > 0);
    await other.flush();
    assert.deepEqual(await withdrawRows(other.db), [{ number: 7, status: 'dropped', outcome: how, installation: '99' }], label);
  }
});

test('a withdraw sweep that cannot read the database fails the start', async () => {
  const h = await harness({ dryRun: false, failQuery: 'dismiss_failure is not null' });
  await assert.rejects(h.start(), /db_down/);
  assert.equal(h.events.includes('listen'), false);
});

test('in dry run the approvals the service was given are never reached: the withdraw job and the review are given ones that refuse every call', async () => {
  const seen = approvalsFake();
  const h = await harness({ dryRun: true, repositoriesYaml: APPROVAL_YAML, threads: [], result: approvable(), approvals: seen.approvals });
  await migrate(h.db, loadMigrations(MIGRATIONS_DIR));
  await savePullRequest(h.db, facts({ headSha: 'h2' }));
  await approvalOf(h.db, '501');
  h.live = liveAt('h2');
  const id = (await askWithdraw(h.db, REF, at(0), '99'))!;
  await enqueueJob(h.db, manual());
  await (await h.start()).settled;
  await h.until(async () => (await jobOf(h.db, id)).status === 'dropped' && h.logged.some((e) => e.event === 'review'));
  assert.deepEqual([(await jobOf(h.db, id)).outcome, seen.calls, h.writes], ['dry_run', [], []]);
  // What each is given: in dry run, and with none given, approvals whose every call rejects; else the ones given.
  for (const [dryRun, given] of [[true, seen.approvals], [true, undefined], [false, undefined]] as const) {
    const refusing = approvalsFor(dryRun, given);
    for (const call of [
      () => refusing.staleApprovals(REF, '99', 'main'), () => refusing.readReview(REF, '99', '501'), () => refusing.dismissReview(REF, '99', '501', 'x'),
    ]) await assert.rejects(call(), /dry_run/, `${dryRun} ${given === undefined ? 'none' : 'given'}`);
  }
  assert.equal(approvalsFor(false, seen.approvals), seen.approvals);
  assert.deepEqual(seen.calls, []);
});

const UI_YAML = 'ui:\n  accounts: [octo-lead]\n  publicUrl: https://visto.example.test\n';
const INDEX_PAGE = '<!doctype html><title>Visto AI</title>';
/** What the service is given for the UI: a sign-in GitHub is never asked through here, and a built page; `reads` holds each read of either. */
function uiDeps(): { ui: NonNullable<ServiceDeps['ui']>; reads: unknown[] } {
  const reads: unknown[] = [];
  const signIn: ForgeSignIn = {
    authorizeUrl: (_state, _challenge, redirectUri) => { reads.push(['authorizeUrl', redirectUri]); return 'https://github.example.test/login/oauth/authorize'; },
    signedIn: () => Promise.reject(new Error('not_expected')),
    orgInstallation: () => Promise.reject(new Error('not_expected')),
  };
  const files: UiFiles = new Map([['/ui/index.html', { body: Buffer.from(INDEX_PAGE), type: 'text/html; charset=utf-8' }]]);
  return {
    reads,
    ui: {
      get signIn() { reads.push('signIn'); return signIn; },
      get files() { reads.push('files'); return files; },
    },
  };
}

test('with the UI off, /, /ui/ and /api/me are not found as before, and nothing is read for them', async () => {
  const given = uiDeps();
  for (const [label, options] of [['as it is', {}], ['ui in the file only', { uiYaml: UI_YAML }], ['ui given only', { ui: given.ui }]] as const) {
    const h = await harness(options);
    await (await h.start()).settled;
    for (const path of ['/', '/ui/', '/ui', '/ui/assets/index-a1.js', '/api/me', '/api/auth/start', '/api']) {
      assert.deepEqual(await h.request('GET', path), { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: 'not_found' }, `${label} ${path}`);
    }
    assert.deepEqual(h.allQueries.filter(([text]) => text.includes('ui_sessions') || text.includes('ui_states')), [], label);
    assert.deepEqual(h.logged.filter((e) => e.event === 'ui'), [], label);
  }
  assert.deepEqual(given.reads, []);
});

test('with the UI on, / goes to /ui/, the built page is served, and /api/me asks for a sign-in', async () => {
  const given = uiDeps();
  const h = await harness({ uiYaml: UI_YAML, ui: given.ui });
  let saidAtListen: boolean | null = null;
  h.onListen = async () => { saidAtListen = h.logged.some((e) => e.event === 'ui'); };
  await (await h.start()).settled;
  const home = await h.request('GET', '/');
  assert.deepEqual([home.status, home.headers.location, home.headers['x-frame-options']], [302, '/ui/', 'DENY']);
  const page = await h.request('GET', '/ui/');
  assert.deepEqual([page.status, page.headers['content-type'], page.headers['cache-control'], String(page.body)], [200, 'text/html; charset=utf-8', 'no-store', INDEX_PAGE]);
  for (const path of ['/api/me', '/api/activity', '/api/reviews']) {
    const read = await h.request('GET', path);
    assert.deepEqual([read.status, read.headers['content-type'], read.body], [401, 'application/json; charset=utf-8', '{"error":"signed_out"}'], path);
  }
  // The sign-in starts at GitHub, sent back to the address the file names.
  const start = await h.request('GET', '/api/auth/start');
  assert.deepEqual([start.status, start.headers.location], [302, 'https://github.example.test/login/oauth/authorize']);
  assert.deepEqual(given.reads.filter((r) => Array.isArray(r)), [['authorizeUrl', 'https://visto.example.test/api/auth/callback']]);
  // Said once, after listening.
  assert.deepEqual([saidAtListen, h.logged.filter((e) => e.event === 'ui')], [false, [{ event: 'ui', files: 1 }]]);
  assert.equal(JSON.stringify(h.logged).includes('client-secret-for-tests-only'), false);
});

test("the review jobs write their stage, and the app check asks for the team's permission", async () => {
  const h = await harness();
  await (await h.start()).settled;
  await h.webhook(pr('opened'), 'd1');
  await h.reviewed();
  // In dry run, and with the fake review telling no progress: the first stage only.
  assert.deepEqual(h.allQueries.filter(([text]) => text.includes('set stage = $2')).map(([, params]) => params[1]), ['preparing']);
  assert.equal(typeof h.reviewDeps[0]!.progress, 'function');
  assert.deepEqual(h.uiTeamCalls, [false]);
  for (const [yaml, team] of [['ui:\n  team: acme/reviewers\n  publicUrl: https://visto.example.test\n', true], [UI_YAML, false]] as const) {
    const other = await harness({ uiYaml: yaml, ui: uiDeps().ui });
    await (await other.start()).settled;
    assert.deepEqual(other.uiTeamCalls, [team], yaml);
  }
});

const TEAM_YAML = 'ui:\n  team: acme/reviewers\n  publicUrl: https://visto.example.test\n';
/** A cookie as a browser sends it back: the first `name=value` of the first value set. */
const cookieOf = (set: unknown): string => String(Array.isArray(set) ? set[0] : set).split(';')[0] ?? '';

test('a member of the team signs in through the service, and reads its mode, its places, its pause and its running review', async () => {
  const signIn: ForgeSignIn = {
    authorizeUrl: (state) => `https://github.example.test/login/oauth/authorize?state=${state}`,
    signedIn: async (code) => {
      if (code !== 'code-1') throw new Error('not_expected');
      return { login: 'octo-dev', isBot: false };
    },
    orgInstallation: async (org) => (org === 'acme' ? '99' : null),
  };
  const files: UiFiles = new Map([['/ui/index.html', { body: Buffer.from(INDEX_PAGE), type: 'text/html; charset=utf-8' }]]);
  const h = await harness({ uiYaml: TEAM_YAML, ui: { signIn, files }, member: true, holdReview: true });
  await (await h.start()).settled;
  // A review the runner holds; then the day's spend reaches the limit, which pauses the reviews to come.
  await h.webhook(pr('opened'), 'd1');
  await h.reviewed();
  try {
    await recordRun(h.db, run({ startedAt: at(0), usage: { ...run().usage, cost: 50 } }));
    const start = await h.request('GET', '/api/auth/start');
    const state = new URL(String(start.headers.location)).searchParams.get('state') ?? '';
    const back = await h.request('GET', `/api/auth/callback?code=code-1&state=${state}`, Buffer.from(''), { cookie: cookieOf(start.headers['set-cookie']) });
    assert.deepEqual([back.status, back.headers.location], [302, '/ui/']);
    // Let in through the team, which only the checks the service was given could tell.
    assert.deepEqual(h.checked, [['isTeamMember']]);
    const cookie = cookieOf(back.headers['set-cookie']);

    const me = await h.request('GET', '/api/me', Buffer.from(''), { cookie });
    const who = JSON.parse(me.body) as Me;
    assert.deepEqual([me.status, who.login, who.mode], [200, 'octo-dev', 'dry_run']);

    const now = await h.request('GET', '/api/activity', Buffer.from(''), { cookie });
    const seen = JSON.parse(now.body) as UiActivity;
    assert.deepEqual([now.status, seen.places, seen.paused], [200, { reviews: config.limits.queueConcurrency, withdrawals: 2 }, 'spend_limit']);
    assert.deepEqual(seen.jobs.map((j) => [j.repository, j.number, j.stage, j.startedAt, j.url]), [
      ['acme/shop', 7, 'preparing', at(0), 'https://git.example.test/acme/shop/pull/7'],
    ]);
  } finally {
    h.releaseReview();
  }
});

test('with the UI off the app check asks for no members permission, though the file names a team', async () => {
  for (const [given, team] of [[undefined, false], [uiDeps().ui, true]] as const) {
    const h = await harness({ uiYaml: TEAM_YAML, ...(given === undefined ? {} : { ui: given }) });
    await (await h.start()).settled;
    assert.deepEqual(h.uiTeamCalls, [team], given === undefined ? 'no ui given' : 'ui given');
  }
});
