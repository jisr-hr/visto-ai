import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { receive } from './receive.ts';
import type { HttpAnswer } from './receive.ts';
import { testDb } from '../db/testing.ts';
import { unfinishedJobs } from '../db/jobs.ts';
import { getPullRequest } from '../db/pull-requests.ts';
import type { Db } from '../db/types.ts';
import type { RepoSettings } from '../config/load.ts';
import type { ForgeEvent, PullRequestAction, PullRequestFacts } from '../forge/types.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const SETTINGS: RepoSettings = { primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: ['dependabot[bot]'], baseBranches: [] };
const facts = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref: REF, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: 'h1', draft: false,
  state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0), ...over,
});
type PullRequestEvent = Extract<ForgeEvent, { kind: 'pull_request' }>;
const pr = (action: PullRequestAction, over: Partial<PullRequestFacts> = {}): PullRequestEvent => ({ kind: 'pull_request', action, facts: facts(over) });

let db: Db;
let now: string;
let logged: Array<Record<string, unknown>>;
let queued: number;
let onQueued: () => void;

beforeEach(async () => {
  db = await testDb();
  now = at(0);
  logged = [];
  queued = 0;
  onQueued = () => { queued += 1; };
});

afterEach(async () => { await db.close(); });

function deliver(event: PullRequestEvent, delivery: string, database: Db = db): Promise<HttpAnswer> {
  const reader = { read: () => ({ ok: true as const, delivery, name: 'pull_request', action: event.action, event }) };
  return receive({
    db: database, reader, clock: () => new Date(now), log: (entry) => { logged.push(entry); },
    settingsFor: () => SETTINGS, onQueued: () => onQueued(),
  }, {}, Buffer.alloc(0));
}

test('an opened pull request stores a job due now and wakes the runner', async () => {
  assert.deepEqual(await deliver(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
  const [job] = await unfinishedJobs(db);
  assert.deepEqual([job!.ref, job!.reason, job!.headSha, job!.runAt, job!.status], [REF, 'opened', 'h1', at(0), 'pending']);
  assert.deepEqual([logged.at(-1)!.job, logged.at(-1)!.skip, queued], ['queued', null, 1]);
});
test('a push stores a job due after the quiet period', async () => {
  await deliver(pr('synchronize'), 'd1');
  assert.equal((await unfinishedJobs(db))[0]!.runAt, at(180));
  assert.equal(logged.at(-1)!.job, 'delayed');
});
test('two pushes leave one job, of the second head, timed from the second push', async () => {
  await deliver(pr('synchronize'), 'd1');
  now = at(60);
  await deliver(pr('synchronize', { headSha: 'h2', updatedAt: at(60) }), 'd2');
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.headSha, j.runAt]), [['h2', at(240)]]);
});
test('a draft stores the pull request and no job', async () => {
  await deliver(pr('opened', { draft: true }), 'd1');
  assert.notEqual(await getPullRequest(db, REF), null);
  assert.deepEqual([await unfinishedJobs(db), logged.at(-1)!.job, logged.at(-1)!.skip, queued], [[], null, 'draft', 0]);
});
test('an event that arrives after a later one still queues, from the stored facts', async () => {
  await deliver(pr('other', { updatedAt: at(2) }), 'd1');            // a label, stored first
  await deliver(pr('synchronize', { updatedAt: at(0) }), 'd2');      // the push it followed
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.reason, j.headSha, j.runAt]), [['synchronize', 'h1', at(180)]]);
  assert.deepEqual([logged.at(-1)!.job, queued], ['delayed', 1]);
});
test('an older event never replaces the job of a newer one', async () => {
  await deliver(pr('synchronize', { headSha: 'h2', updatedAt: at(5) }), 'd1');
  await deliver(pr('opened', { updatedAt: at(0) }), 'd2');
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.reason, j.headSha, j.runAt]), [['synchronize', 'h2', at(180)]]);
  assert.deepEqual([logged.at(-1)!.job, logged.at(-1)!.skip, queued], [null, null, 1]);
});
test('an older event is filtered by the stored state, not by its own', async () => {
  await deliver(pr('opened', { draft: true, updatedAt: at(100) }), 'd1');
  await deliver(pr('ready_for_review', { updatedAt: at(50) }), 'd2');
  assert.deepEqual([await unfinishedJobs(db), logged.at(-1)!.skip], [[], 'draft']);
});
test('the same delivery twice queues once', async () => {
  await deliver(pr('opened'), 'd1');
  assert.deepEqual(await deliver(pr('opened'), 'd1'), { status: 202, body: 'duplicate' });
  assert.deepEqual([(await unfinishedJobs(db)).length, queued], [1, 1]);
});
test('when the job cannot be stored nothing of the delivery is stored', async () => {
  const failing: Db = { ...db, transaction: (work) => db.transaction((tx) => work({
    ...tx, query: (text, params) => (text.includes('visto_ai.jobs') ? Promise.reject(new Error('refused')) : tx.query(text, params)),
  })) };
  assert.deepEqual(await deliver(pr('opened'), 'd1', failing), { status: 503, body: 'storage_unavailable' });
  assert.equal(await getPullRequest(db, REF), null);
  assert.deepEqual(await db.query('select id from visto_ai.deliveries'), []);
  assert.equal(queued, 0);
});
test('an onQueued that throws changes nothing about the answer', async () => {
  onQueued = () => { throw new Error('boom'); };
  assert.deepEqual(await deliver(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
});
