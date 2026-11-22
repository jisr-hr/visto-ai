import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GATE_SETTLE_MS, receive } from './receive.ts';
import type { HttpAnswer } from './receive.ts';
import { testDb } from '../db/testing.ts';
import { askGate, unfinishedJobs } from '../db/jobs.ts';
import { getPullRequest } from '../db/pull-requests.ts';
import type { Db } from '../db/types.ts';
import { GATE_OFF, type RepoSettings } from '../config/load.ts';
import { commentBody, listActivity } from '../db/human-activity.ts';
import type { ForgeEvent, PullRequestAction, PullRequestFacts } from '../forge/types.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const SETTINGS: RepoSettings = { primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: ['dependabot[bot]'], baseBranches: [], newHead: null, inlineNotes: false, gate: GATE_OFF };
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

const said = (body: string, over = {}): ForgeEvent => ({
  kind: 'general_comment', ref: REF, installation: '99',
  comment: { id: '31', author: 'octo-lead', authorIsBot: false, association: 'member', at: at(0), body, ...over },
});

const GATED: RepoSettings = { ...SETTINGS, gate: { ...GATE_OFF, enabled: true, branches: ['main'] } };
const NAMES: Record<ForgeEvent['kind'], string> = {
  pull_request: 'pull_request', general_comment: 'issue_comment', inline_comment: 'pull_request_review_comment',
  thread: 'pull_request_review_thread', check_rerun: 'check_run', review: 'pull_request_review', ping: 'ping', ignored: 'other',
};

function deliver(
  event: ForgeEvent, delivery: string,
  { database = db, settings = SETTINGS, dryRun = false }: { database?: Db; settings?: RepoSettings; dryRun?: boolean } = {},
): Promise<HttpAnswer> {
  const name = NAMES[event.kind];
  const action = event.kind === 'pull_request' || event.kind === 'thread' ? event.action : event.kind === 'check_rerun' ? 'rerequested' : 'created';
  const reader = { read: () => ({ ok: true as const, delivery, name, action, event }) };
  return receive({
    db: database, reader, clock: () => new Date(now), log: (entry) => { logged.push(entry); },
    settingsFor: () => settings, onQueued: () => onQueued(), dryRun, appId: '12345',
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
  assert.deepEqual(await deliver(pr('opened'), 'd1', { database: failing }), { status: 503, body: 'storage_unavailable' });
  assert.equal(await getPullRequest(db, REF), null);
  assert.deepEqual(await db.query('select id from visto_ai.deliveries'), []);
  assert.equal(queued, 0);
});
test('an onQueued that throws changes nothing about the answer', async () => {
  onQueued = () => { throw new Error('boom'); };
  assert.deepEqual(await deliver(pr('opened'), 'd1'), { status: 202, body: 'accepted' });
});

test('a /review comment stores a manual job due now, and the comment itself', async () => {
  assert.deepEqual(await deliver(said('/review'), 'c1'), { status: 202, body: 'accepted' });
  const [job] = await unfinishedJobs(db);
  assert.deepEqual(
    [job!.trigger, job!.reason, job!.headSha, job!.requestedBy, job!.commentId, job!.association, job!.installation, job!.runAt],
    ['manual', 'command', '', 'octo-lead', '31', 'member', '99', at(0)]);
  assert.equal((await listActivity(db, REF)).length, 1);
  assert.deepEqual([logged.at(-1)!.job, logged.at(-1)!.command, queued], ['queued', 'review', 1]);
});
test('a /review replaces the pending job of a push, and a later push does not replace it', async () => {
  await deliver(pr('synchronize'), 'd1');
  await deliver(said('/review'), 'c1');
  await deliver(pr('synchronize', { headSha: 'h2', updatedAt: at(9) }), 'd2');
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.trigger, j.reason, j.runAt]), [['manual', 'command', at(0)]]);
});
test('a comment that is not a command, and a command from a bot, queue nothing', async () => {
  await deliver(said('looks good'), 'c1');
  await deliver(said('/review', { author: 'helper[bot]', authorIsBot: true }), 'c2');
  assert.deepEqual([await unfinishedJobs(db), queued], [[], 0]);
});
test("a stranger's command is stored when nothing is pending, for the job to refuse", async () => {
  await deliver(said('/review', { association: 'none' }), 'c1');
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.trigger, j.association]), [['manual', 'none']]);
});
test("a stranger's command never pushes a pending job out", async () => {
  await deliver(pr('synchronize'), 'd1');
  assert.deepEqual(await deliver(said('/review', { association: 'none' }), 'c1'), { status: 202, body: 'accepted' });
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.trigger, j.reason, j.runAt]), [['automatic', 'synchronize', at(180)]]);
  assert.deepEqual([logged.at(-1)!.command, logged.at(-1)!.job, queued], ['review', null, 1]);
});
for (const [association, replaces] of [['owner', true], ['collaborator', true], ['none', false], ['contributor', false]] as const) {
  test(`a /review from ${association} ${replaces ? 'replaces' : 'does not replace'} a pending automatic job`, async () => {
    await deliver(pr('synchronize'), 'd1');
    await deliver(said('/review', { association }), 'c1');
    const want = replaces ? [['manual', 'command']] : [['automatic', 'synchronize']];
    assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.trigger, j.reason]), want);
  });
}

const gateJobs = async (database: Db = db) => (await unfinishedJobs(database)).filter((j) => j.kind === 'gate');
const reviewJobs = async (database: Db = db) => (await unfinishedJobs(database)).filter((j) => j.kind === 'review');
const thread = (actor = 'octo-dev', actorIsBot = false, action: 'resolved' | 'unresolved' = 'resolved'): ForgeEvent => ({
  kind: 'thread', ref: REF, action, thread: 't-1', rootComment: '40', actor, actorIsBot,
});
const inline = (over = {}): ForgeEvent => ({
  kind: 'inline_comment', ref: REF,
  comment: {
    id: '41', author: 'octo-dev', authorIsBot: false, association: 'member', at: at(0), commit: 'h1', path: 'src/a.ts',
    side: 'RIGHT', line: 3, startLine: null, fileLevel: false, replyTo: '40', body: 'will fix', ...over,
  },
});
const rerun = (over = {}): ForgeEvent => ({
  kind: 'check_rerun', ref: REF, installation: '99', app: '12345', check: 'AI Review', headSha: 'h1', actor: 'octo-lead', ...over,
});

test('a push to a gated pull request stores no review job and asks for its check', async () => {
  assert.deepEqual(await deliver(pr('synchronize'), 'd1', { settings: GATED }), { status: 202, body: 'accepted' });
  assert.deepEqual(await reviewJobs(), []);
  assert.deepEqual((await gateJobs()).map((j) => [j.reason, j.trigger, j.runAt, j.status]), [['sync', 'automatic', at(0), 'pending']]);
  assert.deepEqual([logged.at(-1)!.skip, logged.at(-1)!.job, logged.at(-1)!.gate, queued], ['gated', null, true, 1]);
});
test('with the gate off, and in dry run, a pull request event stores what it stored before', async () => {
  await deliver(pr('opened'), 'd1');
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.kind, j.reason]), [['review', 'opened']]);
  assert.deepEqual(logged.at(-1), {
    event: 'webhook', delivery: 'd1', name: 'pull_request', action: 'opened', outcome: 'accepted', reason: null, job: 'queued', skip: null,
  });
  const other = await testDb();
  try {
    await deliver(pr('opened'), 'd2', { database: other, settings: GATED, dryRun: true });
    assert.deepEqual(await unfinishedJobs(other), []);
    assert.deepEqual([logged.at(-1)!.skip, 'gate' in logged.at(-1)!], ['gated', false]);
  } finally { await other.close(); }
});
test('a push to a pull request of a gated repository against another branch is reviewed and asks for nothing', async () => {
  await deliver(pr('synchronize', { baseBranch: 'feature/x' }), 'd1', { settings: GATED });
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.kind, j.reason]), [['review', 'synchronize']]);
  assert.equal('gate' in logged.at(-1)!, false);
});
test('a resolve, an unresolve and a reply ask for the check three seconds later, whoever made them', async () => {
  assert.equal(GATE_SETTLE_MS, 3_000);
  await deliver(pr('opened'), 'd0', { settings: GATED });
  await deliver(thread(), 't1', { settings: GATED });
  assert.deepEqual((await gateJobs()).map((j) => [j.reason, j.runAt]), [['sync', at(3)]]);
  const [first] = await gateJobs();
  now = at(2);
  await deliver(thread('octo-dev', false, 'unresolved'), 't2', { settings: GATED });
  assert.deepEqual((await gateJobs()).map((j) => [j.id, j.runAt]), [[first!.id, at(5)]]);
  assert.equal(logged.at(-1)!.gate, true);
  now = at(4);
  queued = 0;
  assert.deepEqual(await deliver(inline({ author: 'helper[bot]', authorIsBot: true }), 'r1', { settings: GATED }), { status: 202, body: 'ignored' });
  assert.deepEqual((await gateJobs()).map((j) => [j.id, j.runAt]), [[first!.id, at(7)]]);
  assert.deepEqual([logged.at(-1)!.outcome, logged.at(-1)!.gate, queued], ['ignored', true, 1]);
  now = at(5);
  assert.deepEqual(await deliver(thread('visto-test[bot]', true), 't3', { settings: GATED }), { status: 202, body: 'ignored' });
  assert.deepEqual((await gateJobs()).map((j) => j.runAt), [at(8)]);
  now = at(30);
  await deliver(inline({ replyTo: null, id: '42' }), 'r2', { settings: GATED });
  assert.deepEqual((await gateJobs()).map((j) => j.runAt), [at(8)]);
  assert.equal('gate' in logged.at(-1)!, false);
});
test('a thread event for a pull request the service does not know asks for the check, and one for an ungated pull request does not', async () => {
  await deliver(pr('opened', { baseBranch: 'feature/x' }), 'd0', { settings: GATED });
  await deliver(thread(), 't1', { settings: GATED });
  assert.deepEqual(await gateJobs(), []);
  const other = await testDb();
  try {
    await deliver(thread(), 't2', { database: other, settings: GATED });
    assert.deepEqual((await gateJobs(other)).map((j) => [j.reason, j.runAt]), [['sync', at(3)]]);
  } finally { await other.close(); }
});
test('a thread event and a reply in dry run, or with the gate off, ask for nothing', async () => {
  await deliver(thread(), 't1', { settings: GATED, dryRun: true });
  await deliver(inline(), 'r1');
  await deliver(thread(), 't2');
  assert.deepEqual(await unfinishedJobs(db), []);
  assert.equal(logged.some((e) => 'gate' in e), false);
});
test('/review by a member on a gated pull request also asks for the check; by anyone else it does not', async () => {
  await deliver(pr('opened'), 'd0', { settings: GATED });
  await deliver(said('/review'), 'c1', { settings: GATED });
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.kind, j.trigger, j.reason]), [['gate', 'automatic', 'sync'], ['review', 'manual', 'command']]);
  assert.deepEqual([logged.at(-1)!.command, logged.at(-1)!.job, logged.at(-1)!.gate], ['review', 'queued', true]);
  const other = await testDb();
  try {
    await deliver(said('/review', { association: 'none' }), 'c2', { database: other, settings: GATED });
    assert.deepEqual((await unfinishedJobs(other)).map((j) => [j.kind, j.trigger, j.reason]), [['review', 'manual', 'command']]);
    assert.equal('gate' in logged.at(-1)!, false);
  } finally { await other.close(); }
});
test('/done in a gated repository stores a gate job with the commenter, and with the gate off it is an ordinary comment', async () => {
  assert.deepEqual(await deliver(said('/done'), 'c1', { settings: GATED }), { status: 202, body: 'accepted' });
  const [job] = await unfinishedJobs(db);
  assert.deepEqual(
    [job!.kind, job!.reason, job!.headSha, job!.trigger, job!.requestedBy, job!.commentId, job!.association, job!.installation, job!.runAt],
    ['gate', 'done', '', 'manual', 'octo-lead', '31', 'member', '99', at(0)]);
  assert.deepEqual([logged.at(-1)!.command, logged.at(-1)!.gate, queued], ['done', true, 1]);
  const other = await testDb();
  try {
    await deliver(said('/done'), 'c2', { database: other });
    assert.deepEqual(await unfinishedJobs(other), []);
    assert.equal((await listActivity(other, REF)).length, 1);
    assert.deepEqual(logged.at(-1), {
      event: 'webhook', delivery: 'c2', name: 'issue_comment', action: 'created', outcome: 'accepted', reason: null,
    });
  } finally { await other.close(); }
});
test('/done by someone who may not command does not take a waiting job\'s place', async () => {
  await askGate(db, REF, at(0));
  queued = 0;
  await deliver(said('/done', { association: 'none' }), 'c1', { settings: GATED });
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.kind, j.reason, j.trigger]), [['gate', 'sync', 'automatic']]);
  assert.deepEqual([logged.at(-1)!.command, 'gate' in logged.at(-1)!, queued], ['done', false, 0]);
});
test('in dry run /done is a /review and the skip is nothing', async () => {
  await deliver(said('/done'), 'c1', { settings: GATED, dryRun: true });
  assert.deepEqual(
    (await unfinishedJobs(db)).map((j) => [j.kind, j.reason, j.trigger, j.requestedBy, j.commentId, j.association, j.installation]),
    [['review', 'done', 'manual', 'octo-lead', '31', 'member', '99']]);
  assert.deepEqual([logged.at(-1)!.command, logged.at(-1)!.job, 'gate' in logged.at(-1)!], ['done', 'queued', false]);
  await deliver(said('/ai-review-skip hotfix', { id: '32' }), 'c2', { settings: GATED, dryRun: true });
  assert.equal((await gateJobs()).length, 0);
  assert.equal('command' in logged.at(-1)!, false);
});
test('/ai-review-skip stores a gate job with the head the service has stored, and its reason stays in the stored comment', async () => {
  const body = '/ai-review-skip the release is on fire\nmore words';
  await deliver(pr('opened'), 'd0', { settings: GATED });
  await deliver(said(body), 'c1', { settings: GATED });
  const [job] = await unfinishedJobs(db);
  assert.deepEqual(
    [job!.kind, job!.reason, job!.headSha, job!.trigger, job!.requestedBy, job!.commentId, job!.association, job!.installation],
    ['gate', 'skip', 'h1', 'manual', 'octo-lead', '31', 'member', '99']);
  assert.equal(await commentBody(db, REF, '31'), body);
  assert.deepEqual([logged.at(-1)!.command, logged.at(-1)!.gate], ['skip', true]);
  const other = await testDb();
  try {
    await deliver(said(body), 'c2', { database: other, settings: GATED });
    assert.deepEqual((await gateJobs(other)).map((j) => [j.reason, j.headSha]), [['skip', '']]);
    await deliver(said(body, { id: '33' }), 'c3', { database: other });
    assert.equal('command' in logged.at(-1)!, false);
  } finally { await other.close(); }
});
test('a re-run of the app\'s own check stores a gate job for the commit, and another app\'s or another name\'s check stores nothing', async () => {
  assert.deepEqual(await deliver(rerun(), 'k1', { settings: GATED }), { status: 202, body: 'accepted' });
  const [job] = await unfinishedJobs(db);
  assert.deepEqual(
    [job!.kind, job!.reason, job!.headSha, job!.trigger, job!.requestedBy, job!.commentId, job!.association, job!.installation, job!.runAt],
    ['gate', 'rerun', 'h1', 'manual', 'octo-lead', null, null, '99', at(0)]);
  assert.deepEqual([logged.at(-1)!.command, logged.at(-1)!.gate, queued], ['rerun', true, 1]);
  for (const [i, [event, settings, dryRun]] of ([
    [rerun({ app: '777' }), GATED, false], [rerun({ check: 'CI' }), GATED, false], [rerun(), SETTINGS, false], [rerun(), GATED, true],
  ] as const).entries()) {
    const other = await testDb();
    try {
      assert.deepEqual(await deliver(event, `k${i + 2}`, { database: other, settings, dryRun }), { status: 202, body: 'accepted' });
      assert.deepEqual(await unfinishedJobs(other), []);
      assert.deepEqual(logged.at(-1), {
        event: 'webhook', delivery: `k${i + 2}`, name: 'check_run', action: 'rerequested', outcome: 'accepted', reason: null,
      });
    } finally { await other.close(); }
  }
});
test('a delivery seen twice asks once', async () => {
  await deliver(thread(), 't1', { settings: GATED });
  now = at(2);
  assert.deepEqual(await deliver(thread(), 't1', { settings: GATED }), { status: 202, body: 'duplicate' });
  assert.deepEqual((await gateJobs()).map((j) => j.runAt), [at(3)]);
  await deliver(rerun(), 'k1', { settings: GATED });
  assert.deepEqual(await deliver(rerun(), 'k1', { settings: GATED }), { status: 202, body: 'duplicate' });
  assert.equal((await gateJobs()).length, 1);
});
