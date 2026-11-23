import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordSkip } from '../db/gate.ts';
import { askGate, claimJob, enqueueJob, finishJob, getJob } from '../db/jobs.ts';
import type { Db } from '../db/types.ts';
import type { CheckWrite } from '../forge/types.ts';
import { at, closeHarnesses, harness, liveOf, REF, storeRun, withGate } from './testing.ts';
import type { Harness } from './testing.ts';

afterEach(closeHarnesses);

const SKIP = '/ai-review-skip hotfix, checked by hand';

interface JobRow {
  id: number; status: string; reason: string; trigger: string; head_sha: string;
  requested_by: string | null; comment_id: string | null; association: string | null; installation: string | null; outcome: string | null;
}
const reviewJobs = (db: Db): Promise<JobRow[]> => db.query<JobRow>("select * from visto_ai.jobs where kind = 'review' order by id");
const pendingSyncs = (db: Db): Promise<JobRow[]> =>
  db.query<JobRow>("select * from visto_ai.jobs where kind = 'gate' and reason = 'sync' and status = 'pending' order by id");
interface SkipRow { head_sha: string; actor: string; reason: string; comment_id: string }
const skipRows = (db: Db): Promise<SkipRow[]> => db.query<SkipRow>('select head_sha, actor, reason, comment_id from visto_ai.gate_overrides order by id');

async function statusOf(h: Harness, id = h.job.id): Promise<[string, string | null]> {
  const job = (await getJob(h.db, id))!;
  return [job.status, job.outcome];
}
const answers = (h: Harness): unknown[][] =>
  h.calls.filter((c) => c[0] === 'react' || c[0] === 'comment').map((c) => (c[0] === 'react' ? ['react', c[3], c[4]] : ['comment', c[3]]));
const named = (h: Harness, name: string): unknown[][] => h.calls.filter((c) => c[0] === name);
const gateLog = (h: Harness): Record<string, unknown> | undefined => h.logs.find((e) => e['event'] === 'gate');
const outcomeOf = (h: Harness): [unknown, unknown] => [gateLog(h)?.['outcome'], gateLog(h)?.['code']];

/** Stores a review job of the pull request: pending, or claimed (running in the database). */
async function reviewJob(db: Db, trigger: 'automatic' | 'manual', claim = false): Promise<void> {
  const id = await enqueueJob(db, {
    ref: REF, reason: trigger === 'manual' ? 'command' : 'synchronize', headSha: trigger === 'manual' ? '' : 'h1', runAt: at(0), now: at(0),
    delivery: null, replace: true, trigger, requestedBy: trigger === 'manual' ? 'octo-dev' : null, commentId: trigger === 'manual' ? '21' : null,
    association: trigger === 'manual' ? 'member' : null, installation: '99',
  });
  if (claim) await claimJob(db, id!, at(0));
}

/** The job's database, with a transaction that does its work and then rejects, `times` times. */
function failingEnd(h: Harness, times: number): void {
  const real = h.deps.db;
  let left = times;
  h.deps.db = {
    query: (text, params) => real.query(text, params),
    script: (sql) => real.script(sql),
    close: () => real.close(),
    transaction: (work) => (left-- > 0
      ? real.transaction(async (tx) => { await work(tx); throw new Error('db_down'); })
      : real.transaction(work)),
  };
}

test('/done on a head that is not green stores a review job for the commenter, asks for the check, and gets its eyes', async () => {
  const h = await harness({ reason: 'done' });
  let jobsAtEyes = -1;
  const react = h.deps.writer.react;
  h.deps.writer = { ...h.deps.writer, react: async (...args) => { jobsAtEyes = (await reviewJobs(h.db)).length; return react(...args); } };
  await h.run();
  const jobs = await reviewJobs(h.db);
  assert.equal(jobs.length, 1);
  assert.deepEqual(
    [jobs[0]!.status, jobs[0]!.reason, jobs[0]!.trigger, jobs[0]!.head_sha, jobs[0]!.requested_by, jobs[0]!.comment_id, jobs[0]!.association, jobs[0]!.installation],
    ['pending', 'done', 'manual', '', 'octo-lead', '31', 'member', '99']);
  assert.equal((await pendingSyncs(h.db)).length, 1);
  assert.deepEqual(await statusOf(h), ['done', 'review_queued']);
  assert.deepEqual(answers(h), [['react', '31', 'eyes']]);
  assert.equal(jobsAtEyes, 1, 'the eyes come after the transaction');
  assert.equal(named(h, 'writeCheck').length + named(h, 'findCheck').length, 0);
  assert.equal(h.queued(), 1);
  assert.deepEqual(gateLog(h), { event: 'gate', job: h.job.id, repo: 'acme/shop', number: 7, reason: 'done', outcome: 'review_queued', code: null });
});

test('/done on a green head starts nothing', async () => {
  const reviewed = await harness({ reason: 'done' });
  await storeRun(reviewed.db, { findings: [] });
  await reviewed.run();
  assert.deepEqual(await statusOf(reviewed), ['done', 'already_green']);
  assert.deepEqual(answers(reviewed), [['react', '31', 'eyes']]);
  assert.equal((await reviewJobs(reviewed.db)).length, 0);
  assert.equal((await pendingSyncs(reviewed.db)).length, 1);
  assert.equal(named(reviewed, 'greenChecks').length, 0, 'no required check named: greenChecks is not asked');

  const skipped = await harness({ reason: 'done' });
  await recordSkip(skipped.db, { ref: REF, headSha: 'h1', actor: 'octo-lead', reason: 'urgent', commentId: '41', at: at(0) });
  await skipped.run();
  assert.deepEqual([await statusOf(skipped), answers(skipped), (await reviewJobs(skipped.db)).length], [['done', 'already_green'], [['react', '31', 'eyes']], 0]);

  const bypassed = await harness({ reason: 'done', settings: withGate({ mode: 'bypass' }) });
  await bypassed.run();
  assert.deepEqual([await statusOf(bypassed), answers(bypassed), (await reviewJobs(bypassed.db)).length], [['done', 'already_green'], [['react', '31', 'eyes']], 0]);
});

test('/done with everything green says so once', async () => {
  const sentence = "@octo-lead Nothing is left to run on `h1`: the required checks and the review's check are green.";
  const all = await harness({ reason: 'done', settings: withGate({ requiredChecks: ['build', 'test'] }) });
  await storeRun(all.db, { findings: [] });
  await all.run();
  assert.deepEqual(answers(all), [['react', '31', 'eyes'], ['comment', sentence]]);
  assert.deepEqual(named(all, 'greenChecks')[0]!.slice(2), ['99', 'h1', ['build', 'test']]);

  const one = await harness({ reason: 'done', settings: withGate({ requiredChecks: ['build', 'test'] }), green: ['build'] });
  await storeRun(one.db, { findings: [] });
  await one.run();
  assert.deepEqual(answers(one), [['react', '31', 'eyes']]);

  const unread = await harness({ reason: 'done', settings: withGate({ requiredChecks: ['build'] }), green: new Error('github_502') });
  await storeRun(unread.db, { findings: [] });
  await unread.run();
  assert.deepEqual(answers(unread), [['react', '31', 'eyes']]);
  assert.deepEqual(unread.logs.filter((e) => e['event'] === 'gate_checks_unread'), [{ event: 'gate_checks_unread', job: unread.job.id, reason: 'github_502' }]);
  assert.deepEqual(await statusOf(unread), ['done', 'already_green']);
});

test('/done joins a review that is running or was asked for, and takes the place of a push\'s waiting job', async () => {
  const running = await harness({ reason: 'done' });
  await reviewJob(running.db, 'manual', true);
  await running.run();
  assert.deepEqual([await statusOf(running), (await reviewJobs(running.db)).length, answers(running)], [['done', 'coalesced'], 1, [['react', '31', 'eyes']]]);

  const pending = await harness({ reason: 'done' });
  await reviewJob(pending.db, 'manual');
  await pending.run();
  assert.deepEqual([await statusOf(pending), (await reviewJobs(pending.db)).map((j) => j.requested_by)], [['done', 'coalesced'], ['octo-dev']]);

  const push = await harness({ reason: 'done' });
  await reviewJob(push.db, 'automatic');
  await push.run();
  const replaced = await reviewJobs(push.db);
  assert.deepEqual([await statusOf(push), replaced.map((j) => [j.status, j.trigger, j.reason, j.requested_by])],
    [['done', 'review_queued'], [['pending', 'manual', 'done', 'octo-lead']]]);

  const gated = await harness({ reason: 'done' });
  await reviewJob(gated.db, 'automatic', true);
  await gated.run();
  assert.deepEqual([await statusOf(gated), (await reviewJobs(gated.db)).map((j) => [j.status, j.trigger])],
    [['done', 'review_queued'], [['running', 'automatic'], ['pending', 'manual']]]);

  const loose = await harness({ reason: 'done', reviewing: false });
  await reviewJob(loose.db, 'manual', true);
  await loose.run();
  assert.deepEqual([await statusOf(loose), (await reviewJobs(loose.db)).map((j) => [j.status, j.reason])],
    [['done', 'review_queued'], [['running', 'command'], ['pending', 'done']]]);
});

test('a command joins a push\'s review where pull requests are reviewed on a push: in shadow, and on a branch outside the gate\'s list', async () => {
  const shadow = await harness({ reason: 'done', settings: withGate({ mode: 'shadow' }) });
  await reviewJob(shadow.db, 'automatic', true);
  await shadow.run();
  assert.deepEqual([await statusOf(shadow), (await reviewJobs(shadow.db)).map((j) => [j.status, j.trigger]), answers(shadow)],
    [['done', 'coalesced'], [['running', 'automatic']], [['react', '31', 'eyes']]]);

  const waiting = await harness({ reason: 'done', settings: withGate({ mode: 'shadow' }) });
  await reviewJob(waiting.db, 'automatic');
  await waiting.run();
  assert.deepEqual([await statusOf(waiting), (await reviewJobs(waiting.db)).map((j) => [j.status, j.trigger])], [['done', 'coalesced'], [['pending', 'automatic']]]);

  const outside = await harness({ reason: 'done', live: liveOf({ baseBranch: 'feature/x' }) });
  await reviewJob(outside.db, 'automatic', true);
  await outside.run();
  assert.deepEqual([await statusOf(outside), (await reviewJobs(outside.db)).length], [['done', 'coalesced'], 1]);

  const rerun = await harness({ reason: 'rerun', settings: withGate({ mode: 'shadow' }), requestedBy: null, commentId: null, association: null });
  await reviewJob(rerun.db, 'automatic', true);
  await rerun.run();
  assert.deepEqual([await statusOf(rerun), (await reviewJobs(rerun.db)).length], [['done', 'coalesced'], 1]);

  // Enforced: a push's waiting job is about to be dropped as gated, so it is not joined.
  const enforced = await harness({ reason: 'done' });
  await reviewJob(enforced.db, 'automatic');
  await enforced.run();
  assert.deepEqual([await statusOf(enforced), (await reviewJobs(enforced.db)).map((j) => [j.status, j.trigger])], [['done', 'review_queued'], [['pending', 'manual']]]);
});

/** Stores a manual review job of the pull request with this association and reason: pending, or claimed. */
async function manualJob(db: Db, association: string | null, reason: string, claim = false): Promise<void> {
  const id = await enqueueJob(db, {
    ref: REF, reason, headSha: '', runAt: at(0), now: at(0), delivery: null, replace: true, trigger: 'manual',
    requestedBy: 'octo-dev', commentId: reason.startsWith('rerun') ? null : '21', association, installation: '99',
  });
  if (claim) await claimJob(db, id!, at(0));
}

test('/done joins only a review that will run', async () => {
  const stranger = await harness({ reason: 'done' });
  await manualJob(stranger.db, 'none', 'command');
  await stranger.run();
  assert.deepEqual([await statusOf(stranger), answers(stranger)], [['done', 'review_queued'], [['react', '31', 'eyes']]]);
  assert.deepEqual((await reviewJobs(stranger.db)).map((j) => [j.status, j.reason, j.requested_by, j.comment_id, j.association]),
    [['pending', 'done', 'octo-lead', '31', 'member']], "the member's job takes the stranger's place");

  const member = await harness({ reason: 'done' });
  await manualJob(member.db, 'member', 'command');
  await member.run();
  assert.deepEqual([await statusOf(member), (await reviewJobs(member.db)).map((j) => j.requested_by)], [['done', 'coalesced'], ['octo-dev']]);

  for (const reason of ['rerun', 'rerun_retry']) {
    const rerun = await harness({ reason: 'done' });
    await manualJob(rerun.db, null, reason);
    await rerun.run();
    assert.deepEqual([await statusOf(rerun), (await reviewJobs(rerun.db)).map((j) => j.reason)], [['done', 'coalesced'], [reason]], reason);
  }

  const running = await harness({ reason: 'done' });
  await manualJob(running.db, 'none', 'command', true);
  await running.run();
  assert.deepEqual([await statusOf(running), (await reviewJobs(running.db)).map((j) => [j.status, j.association])],
    [['done', 'review_queued'], [['running', 'none'], ['pending', 'member']]]);
});

test('/done by someone who may not command, and on a closed pull request, is refused with its code', async () => {
  const none = await harness({ reason: 'done', association: 'none' });
  await none.run();
  assert.deepEqual(answers(none), [['react', '31', 'confused'], ['comment', '@octo-lead `/done` was not accepted (`not_allowed`).']]);
  assert.deepEqual([await statusOf(none), outcomeOf(none)], [['done', 'refused'], ['refused', 'not_allowed']]);
  assert.equal((await reviewJobs(none.db)).length, 0);
  assert.equal((await pendingSyncs(none.db)).length, 1);
  assert.equal(named(none, 'readPullRequest').length, 0);

  const closed = await harness({ reason: 'done', live: liveOf({ state: 'closed' }) });
  await closed.run();
  assert.deepEqual(answers(closed), [['react', '31', 'confused'], ['comment', '@octo-lead `/done` was not accepted (`closed`).']]);
  assert.deepEqual([await statusOf(closed), outcomeOf(closed)], [['done', 'refused'], ['refused', 'closed']]);
  assert.equal((await pendingSyncs(closed.db)).length, 0);
  assert.equal((await reviewJobs(closed.db)).length, 0);

  const gone = await harness({ reason: 'done', live: null });
  await gone.run();
  assert.deepEqual([await statusOf(gone), answers(gone), (await pendingSyncs(gone.db)).length], [['dropped', 'not_found'], [], 0]);
});

test('/done on a pull request that is not gated is a /review', async () => {
  const h = await harness({ reason: 'done', live: liveOf({ baseBranch: 'feature/x' }), threads: [[]] });
  await storeRun(h.db, { findings: [] });
  await h.run();
  assert.deepEqual((await reviewJobs(h.db)).map((j) => [j.reason, j.trigger, j.requested_by]), [['done', 'manual', 'octo-lead']]);
  assert.equal(named(h, 'listThreads').length + named(h, 'paused').length, 0, 'planNow is not asked');
  assert.equal((await pendingSyncs(h.db)).length, 0);
  assert.deepEqual([await statusOf(h), answers(h)], [['done', 'review_queued'], [['react', '31', 'eyes']]]);
});

test('/done on a head whose review GitHub refused inline is not green', async () => {
  const h = await harness({ reason: 'done' });
  await storeRun(h.db, { publish: { inlineDropped: true } });
  await h.run();
  assert.deepEqual(await statusOf(h), ['done', 'review_queued']);
  assert.equal((await reviewJobs(h.db)).length, 1);
});

test('/done whose threads cannot be read asks for a review', async () => {
  const h = await harness({ reason: 'done', threads: [new Error('github_502')] });
  await storeRun(h.db, { findings: [] });
  await h.run();
  assert.equal(named(h, 'listThreads').length, 1);
  assert.deepEqual(await statusOf(h), ['done', 'review_queued']);
  assert.equal((await reviewJobs(h.db)).length, 1);
});

test('/done put back after a failed read keeps its place against a sync stored meanwhile', async () => {
  const h = await harness({ reason: 'done' });
  const forge = h.deps.forge;
  let sync: number | null = null;
  h.deps.forge = {
    ...forge,
    readPullRequest: async () => {
      sync = await askGate(h.db, REF, at(1));
      throw new Error('github_502');
    },
  };
  await h.run();
  assert.ok(sync !== null);
  assert.deepEqual(await statusOf(h), ['pending', null]);
  assert.deepEqual(await statusOf(h, sync), ['dropped', 'superseded']);
  assert.deepEqual([outcomeOf(h), answers(h)], [['put_back', null], []]);
  assert.equal(gateLog(h)?.['requeued'], true);
  assert.equal(await askGate(h.db, REF, at(2)), null, 'while it waits the command holds the slot');

  h.deps.forge = forge;
  const again = await h.claimNext(at(10));
  assert.equal(again?.id, h.job.id);
  await h.run(again!);
  assert.deepEqual(await statusOf(h), ['done', 'review_queued']);
  assert.equal((await reviewJobs(h.db)).length, 1);
  assert.equal((await pendingSyncs(h.db)).length, 1);
});

test('a skip by a member of the team is stored for the head with its reason, and gets its eyes', async () => {
  const h = await harness({ reason: 'skip', comment: SKIP });
  await h.run();
  assert.deepEqual(await skipRows(h.db), [{ head_sha: 'h1', actor: 'octo-lead', reason: 'hotfix, checked by hand', comment_id: '31' }]);
  assert.deepEqual(named(h, 'isTeamMember').map((c) => c.slice(1)), [['99', 'acme/release-managers', 'octo-lead']]);
  assert.equal((await pendingSyncs(h.db)).length, 1);
  assert.deepEqual([await statusOf(h), answers(h)], [['done', 'skipped'], [['react', '31', 'eyes']]]);
  for (const entry of h.logs) {
    const text = JSON.stringify(entry);
    assert.ok(!text.includes('release-managers') && !text.includes('hotfix'), text);
  }

  const sync = await h.claimNext(at(0));
  assert.ok(sync !== null);
  await h.run(sync);
  const written = named(h, 'writeCheck').map((c) => c[3] as CheckWrite);
  assert.deepEqual(written.map((w) => [w.commit, w.title]), [['h1', 'Skipped by @octo-lead']]);
});

test('a skip lands only on the commit the service knew when the comment came', async () => {
  const stale = await harness({ reason: 'skip', comment: SKIP, head: 'h1', live: liveOf({ head: 'h2' }) });
  await stale.run();
  assert.deepEqual(answers(stale), [['react', '31', 'confused'], ['comment',
    '@octo-lead `/ai-review-skip` was not accepted: a commit was pushed since you commented. Look at it and comment again (`stale_head`).']]);
  assert.deepEqual([await skipRows(stale.db), outcomeOf(stale), (await pendingSyncs(stale.db)).length], [[], ['refused', 'stale_head'], 1]);

  const unknown = await harness({ reason: 'skip', comment: SKIP, head: '', live: liveOf({ head: 'h2' }) });
  await unknown.run();
  assert.deepEqual((await skipRows(unknown.db)).map((r) => r.head_sha), ['h2']);
  assert.deepEqual(await statusOf(unknown), ['done', 'skipped']);
});

test('a skip with no reason is refused before anyone is looked up', async () => {
  const sentence = '@octo-lead `/ai-review-skip` needs a reason on its line, as in `/ai-review-skip urgent fix, checked by hand` (`missing_reason`).';
  const bare = await harness({ reason: 'skip', comment: '/ai-review-skip' });
  await bare.run();
  assert.deepEqual([answers(bare), named(bare, 'isTeamMember').length, outcomeOf(bare)],
    [[['react', '31', 'confused'], ['comment', sentence]], 0, ['refused', 'missing_reason']]);

  const nothing = await harness({ reason: 'skip' });
  await nothing.run();
  assert.deepEqual([answers(nothing), named(nothing, 'isTeamMember').length, await skipRows(nothing.db)],
    [[['react', '31', 'confused'], ['comment', sentence]], 0, []]);
});

test('a skip by someone outside the team is refused, and the answer does not name the team', async () => {
  const outside = await harness({ reason: 'skip', comment: SKIP, member: false });
  await outside.run();
  const sentence = '@octo-lead Only a member of the team that may skip can skip the review (`not_team_member`).';
  assert.deepEqual(answers(outside), [['react', '31', 'confused'], ['comment', sentence]]);
  assert.deepEqual([await skipRows(outside.db), outcomeOf(outside)], [[], ['refused', 'not_team_member']]);
  assert.ok(!sentence.includes('release-managers'));

  const nobody = await harness({ reason: 'skip', comment: SKIP, requestedBy: null });
  await nobody.run();
  assert.deepEqual(answers(nobody), [['react', '31', 'confused'], ['comment', 'Only a member of the team that may skip can skip the review (`not_team_member`).']]);
  assert.deepEqual([named(nobody, 'isTeamMember').length, await skipRows(nobody.db)], [0, []]);
});

test('a membership that cannot be read is "could not verify", never "not a member"', async () => {
  const h = await harness({ reason: 'skip', comment: SKIP, member: new Error('github_403') });
  await h.run();
  assert.deepEqual(answers(h), [['react', '31', 'confused'], ['comment',
    '@octo-lead Membership of the team that may skip could not be verified just now, so nothing was skipped. Try again in a minute (`membership_unverified`).']]);
  assert.deepEqual([await skipRows(h.db), await statusOf(h), outcomeOf(h)], [[], ['done', 'refused'], ['refused', 'membership_unverified']]);
});

test('a skip is refused without a team, for a team of another organisation, by someone who may not command, on a closed and on an ungated pull request', async () => {
  const cases: Array<[Parameters<typeof harness>[0], string, number]> = [
    [{ settings: withGate({ skipTeam: null }) }, '@octo-lead `/ai-review-skip` is not available here: no team is named for it (`no_skip_team`).', 1],
    [{ settings: withGate({ skipTeam: 'other/release-managers' }) }, '@octo-lead `/ai-review-skip` is not available here: no team is named for it (`no_skip_team`).', 1],
    [{ association: 'none' }, '@octo-lead `/ai-review-skip` was not accepted (`not_allowed`).', 1],
    [{ live: liveOf({ state: 'closed' }) }, '@octo-lead `/ai-review-skip` was not accepted (`closed`).', 0],
    [{ live: liveOf({ baseBranch: 'feature/x' }) }, '@octo-lead `/ai-review-skip` was not accepted: this pull request is not gated (`not_gated`).', 0],
  ];
  for (const [options, sentence, syncs] of cases) {
    const h = await harness({ reason: 'skip', comment: SKIP, ...options });
    await h.run();
    assert.deepEqual(answers(h), [['react', '31', 'confused'], ['comment', sentence]]);
    assert.deepEqual([await skipRows(h.db), await statusOf(h), (await pendingSyncs(h.db)).length], [[], ['done', 'refused'], syncs], sentence);
    if (options?.settings !== undefined || options?.association !== undefined) assert.equal(named(h, 'isTeamMember').length, 0);
  }
});

test('a skip works while reviews are paused', async () => {
  const h = await harness({ reason: 'skip', comment: SKIP, paused: 'spend_limit' });
  await reviewJob(h.db, 'manual');
  await h.run();
  assert.deepEqual([await statusOf(h), (await skipRows(h.db)).length], [['done', 'skipped'], 1]);
});

test('a re-run of the head\'s check stores a review job and says nothing', async () => {
  const h = await harness({ reason: 'rerun', requestedBy: 'octo-dev', commentId: null, association: null });
  await h.run();
  const jobs = await reviewJobs(h.db);
  assert.deepEqual(jobs.map((j) => [j.reason, j.trigger, j.requested_by, j.comment_id, j.association, j.installation]),
    [['rerun', 'manual', 'octo-dev', null, null, '99']]);
  assert.deepEqual([await statusOf(h), answers(h)], [['done', 'review_queued'], []]);
  assert.equal(h.logs.filter((e) => e['event'] === 'answer_failed').length, 0);
  assert.equal((await pendingSyncs(h.db)).length, 1);
});

test('a re-run of an old commit, of a closed pull request and in bypass starts no review, and one on a pull request that is no longer gated does nothing at all', async () => {
  const rerun = { reason: 'rerun', requestedBy: 'octo-dev', commentId: null, association: null } as const;
  const cases: Array<[Parameters<typeof harness>[0], string, number]> = [
    [{ head: 'h1', live: liveOf({ head: 'h2' }) }, 'stale_head', 1],
    [{ live: liveOf({ state: 'closed' }) }, 'closed', 0],
    [{ settings: withGate({ mode: 'bypass' }) }, 'bypassed', 1],
    [{ live: liveOf({ baseBranch: 'feature/x' }) }, 'not_gated', 0],
  ];
  for (const [options, outcome, syncs] of cases) {
    const h = await harness({ ...rerun, ...options });
    await h.run();
    assert.deepEqual([await statusOf(h), (await reviewJobs(h.db)).length, (await pendingSyncs(h.db)).length], [['done', outcome], 0, syncs], outcome);
    assert.deepEqual(h.calls.map((c) => c[0]), ['readPullRequest'], outcome);
  }
});

test('a command run again after a stop does nothing twice', async () => {
  const h = await harness({ reason: 'skip', comment: SKIP });
  failingEnd(h, 1);
  await h.run();
  assert.deepEqual([await skipRows(h.db), await statusOf(h), answers(h)], [[], ['pending', null], []]);
  const again = await h.claimNext(at(10));
  assert.ok(again !== null);
  await h.run(again);
  assert.equal((await skipRows(h.db)).length, 1);
  await h.run(again);
  assert.equal((await skipRows(h.db)).length, 1);
  assert.deepEqual(answers(h), [['react', '31', 'eyes']]);

  const done = await harness({ reason: 'done' });
  failingEnd(done, 1);
  await done.run();
  assert.equal((await reviewJobs(done.db)).length, 0);
  await done.run((await done.claimNext(at(10)))!);
  assert.equal((await reviewJobs(done.db)).length, 1);
});

test('a command GitHub fails three times is answered as failed', async () => {
  const h = await harness({ reason: 'done', starts: 3, live: new Error('github_502') });
  await h.run();
  assert.deepEqual([await statusOf(h), outcomeOf(h)], [['done', 'failed'], ['failed', 'github_502']]);
  assert.deepEqual(answers(h), [['react', '31', 'confused'], ['comment', '@octo-lead `/done` could not be handled (`github_502`).']]);
  assert.equal((await pendingSyncs(h.db)).length, 1);

  const skip = await harness({ reason: 'skip', comment: SKIP, starts: 3, live: new Error('github_502') });
  await skip.run();
  assert.deepEqual(answers(skip), [['react', '31', 'confused'], ['comment', '@octo-lead `/ai-review-skip` could not be handled (`github_502`).']]);

  const rerun = await harness({ reason: 'rerun', requestedBy: 'octo-dev', commentId: null, association: null, starts: 3, live: new Error('github_502') });
  await rerun.run();
  assert.deepEqual([await statusOf(rerun), answers(rerun)], [['done', 'failed'], []]);
});

test('a command found already finished at its last end is gone, stores nothing and says nothing', async () => {
  const h = await harness({ reason: 'done', starts: 3, live: new Error('github_502') });
  await finishJob(h.db, h.job.id, 'done', 'review_queued', at(0));
  await h.run();
  assert.deepEqual([outcomeOf(h), answers(h), (await pendingSyncs(h.db)).length, await statusOf(h)], [['gone', null], [], 0, ['done', 'review_queued']]);
});

test('an answer that cannot be written is logged and changes nothing', async () => {
  const h = await harness({ reason: 'done', answerFails: true });
  await h.run();
  assert.deepEqual(h.logs.filter((e) => e['event'] === 'answer_failed'), [{ event: 'answer_failed', job: h.job.id, reason: 'github_500' }]);
  assert.equal((await reviewJobs(h.db)).length, 1);
  assert.deepEqual(await statusOf(h), ['done', 'review_queued']);

  const refused = await harness({ reason: 'done', association: 'none', answerFails: true });
  await refused.run();
  assert.equal(refused.logs.filter((e) => e['event'] === 'answer_failed').length, 2, 'the sentence is still tried after the reaction failed');
});

test('a command uses its own installation before the stored one: the app installed again has a new id', async () => {
  const h = await harness({ reason: 'done', installation: '1' });
  const forge = h.deps.forge;
  h.deps.forge = { ...forge, readPullRequest: (ref, installation) => (installation === '99' ? forge.readPullRequest(ref, installation) : Promise.reject(new Error('github_404'))) };
  await h.run();
  assert.deepEqual(await statusOf(h), ['done', 'review_queued']);
  assert.deepEqual(h.calls.filter((c) => c[0] === 'react').map((c) => c[2]), ['99']);
});

test('a /done while a review that started over runs is stored as its own job, and one while it waits joins it', async () => {
  for (const [claim, outcome, jobs] of [[true, 'review_queued', [['running', 'done_retry'], ['pending', 'done']]], [false, 'coalesced', [['pending', 'done_retry']]]] as const) {
    const h = await harness({ reason: 'done' });
    const id = await enqueueJob(h.db, {
      ref: REF, reason: 'done_retry', headSha: '', runAt: at(0), now: at(0), delivery: null, replace: true, trigger: 'manual',
      requestedBy: 'octo-dev', commentId: '21', association: 'member', installation: '99',
    });
    if (claim) await claimJob(h.db, id!, at(0));
    await h.run();
    assert.deepEqual(await statusOf(h), ['done', outcome], String(claim));
    assert.deepEqual((await reviewJobs(h.db)).map((j) => [j.status, j.reason]), jobs, String(claim));
  }
});
