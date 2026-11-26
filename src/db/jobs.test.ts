import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import type { Db } from './types.ts';
import { askGate, askWithdraw, claimJob, deleteFinishedJobs, dropJobIfUnchanged, dueJobs, enqueueJob, finishJob, getJob, markStage, requeueJob, reviewJobsOf, unfinishedJobs } from './jobs.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const job = (over = {}) => ({ ref: REF, reason: 'opened', headSha: 'h1', runAt: at(0), now: at(0), delivery: 'd1', replace: true,
  trigger: 'automatic' as 'automatic' | 'manual', requestedBy: null as string | null, commentId: null as string | null, association: null as string | null, installation: null as string | null, ...over });
const manual = (over = {}) => job({ reason: 'command', headSha: '', trigger: 'manual', requestedBy: 'octo-lead', commentId: '31', association: 'member', installation: '99', ...over });

test('a second trigger for a pull request replaces its pending job and starts it afresh', async () => {
  const db = await testDb();
  const first = (await enqueueJob(db, job()))!;
  await db.query('update visto_ai.jobs set starts = 2 where id = $1', [first]);
  const second = (await enqueueJob(db, job({ reason: 'synchronize', headSha: 'h2', runAt: at(240), now: at(60), delivery: 'd2' })))!;
  assert.equal(second, first);
  assert.deepEqual(await unfinishedJobs(db), [{
    id: first, ref: REF, kind: 'review', reason: 'synchronize', headSha: 'h2',
    trigger: 'automatic', requestedBy: null, commentId: null, association: null, installation: null, status: 'pending', outcome: null, runAt: at(240), starts: 0, createdAt: at(60),
  }]);
  await db.close();
});
test('without replace, a trigger fills a gap and leaves a pending job as it is', async () => {
  const db = await testDb();
  const first = (await enqueueJob(db, job({ replace: false })))!;
  assert.notEqual(first, null);
  assert.equal(await enqueueJob(db, job({ reason: 'synchronize', headSha: 'h2', runAt: at(240), now: at(60), replace: false })), null);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.id, j.reason, j.headSha, j.runAt]), [[first, 'opened', 'h1', at(0)]]);
  await db.close();
});
test('the owner and the repository name are stored in lower case, so two spellings are one pull request', async () => {
  const db = await testDb();
  const first = (await enqueueJob(db, job({ ref: { ...REF, owner: 'Acme', repo: 'Shop' } })))!;
  assert.equal(await enqueueJob(db, job()), first);
  assert.deepEqual((await getJob(db, first))?.ref, REF);
  await db.close();
});
test('a running job does not stop a new pending job for the same pull request', async () => {
  const db = await testDb();
  const id = (await enqueueJob(db, job()))!;
  await claimJob(db, id, at(0));
  const next = (await enqueueJob(db, job({ headSha: 'h2', runAt: at(5), now: at(5) })))!;
  assert.notEqual(next, id);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.id, j.status]), [[id, 'running'], [next, 'pending']]);
  await db.close();
});
test('dueJobs returns pending jobs whose time has come, earliest first, up to the limit', async () => {
  const db = await testDb();
  await enqueueJob(db, job({ runAt: at(10) }));
  await enqueueJob(db, job({ ref: { ...REF, number: 8 }, runAt: at(5) }));
  await enqueueJob(db, job({ ref: { ...REF, number: 9 }, runAt: at(600) }));
  assert.deepEqual((await dueJobs(db, at(10), 5, 'review')).map((j) => j.ref.number), [8, 7]);
  assert.deepEqual((await dueJobs(db, at(10), 1, 'review')).map((j) => j.ref.number), [8]);
  await db.close();
});
test('claimJob counts a start and succeeds once', async () => {
  const db = await testDb();
  const id = (await enqueueJob(db, job()))!;
  const claimed = await claimJob(db, id, at(1));
  assert.deepEqual([claimed?.status, claimed?.starts], ['running', 1]);
  assert.equal(await claimJob(db, id, at(2)), null);
  await db.close();
});
test('a job replaced to a later time between the look and the claim is not claimed', async () => {
  const db = await testDb();
  const id = (await enqueueJob(db, job()))!;
  await enqueueJob(db, job({ reason: 'synchronize', headSha: 'h2', runAt: at(180), now: at(1) }));
  assert.equal(await claimJob(db, id, at(2)), null);
  assert.equal((await getJob(db, id))?.status, 'pending');
  await db.close();
});
test('finishJob ends a job once and keeps its outcome', async () => {
  const db = await testDb();
  const id = (await enqueueJob(db, job()))!;
  assert.equal(await finishJob(db, id, 'dropped', 'stale_head', at(3)), true);
  assert.equal(await finishJob(db, id, 'done', 'reviewed', at(4)), false);
  const j = await getJob(db, id);
  assert.deepEqual([j?.status, j?.outcome], ['dropped', 'stale_head']);
  await db.close();
});
test('dropJobIfUnchanged drops a pending job that is as it was listed', async () => {
  const db = await testDb();
  const id = (await enqueueJob(db, job()))!;
  const [listed] = await dueJobs(db, at(0), 5, 'review');
  assert.equal(await dropJobIfUnchanged(db, listed!, 'too_old', at(3)), true);
  const j = await getJob(db, id);
  assert.deepEqual([j?.status, j?.outcome], ['dropped', 'too_old']);
  await db.close();
});
test('dropJobIfUnchanged leaves a job that was replaced after it was listed', async () => {
  const db = await testDb();
  const id = (await enqueueJob(db, job()))!;
  await db.query('update visto_ai.jobs set starts = 3 where id = $1', [id]);
  const [listed] = await dueJobs(db, at(0), 5, 'review');
  await enqueueJob(db, job({ reason: 'synchronize', headSha: 'h2', runAt: at(5), now: at(1) }));
  assert.equal(await dropJobIfUnchanged(db, listed!, 'attempts_exhausted', at(3)), false);
  const j = await getJob(db, id);
  assert.deepEqual([j?.status, j?.headSha, j?.starts, j?.outcome], ['pending', 'h2', 0, null]);
  await db.close();
});
test('requeueJob puts a running job back, and gives its start back when asked', async () => {
  const db = await testDb();
  const id = (await enqueueJob(db, job()))!;
  await claimJob(db, id, at(1));
  assert.equal(await requeueJob(db, id, at(60), at(9), false), 'requeued');
  let j = await getJob(db, id);
  assert.deepEqual([j?.status, j?.starts, j?.runAt], ['pending', 1, at(60)]);
  await claimJob(db, id, at(60));
  assert.equal(await requeueJob(db, id, at(61), at(61), true), 'requeued');
  j = await getJob(db, id);
  assert.equal(j?.starts, 1);
  await db.close();
});
test('requeueJob drops the job as superseded when the pull request already has a pending one', async () => {
  const db = await testDb();
  const id = (await enqueueJob(db, job()))!;
  await claimJob(db, id, at(1));
  const next = (await enqueueJob(db, job({ headSha: 'h2', runAt: at(2), now: at(2) })))!;
  assert.equal(await requeueJob(db, id, at(60), at(9), false), 'superseded');
  const old = await getJob(db, id);
  assert.deepEqual([old?.status, old?.outcome], ['dropped', 'superseded']);
  assert.equal((await getJob(db, next))?.status, 'pending');
  await db.close();
});
test('requeueJob treats a unique violation on its first statement as superseded', async () => {
  const texts: string[] = [];
  const fake = { query: async (text: string) => {
    texts.push(text);
    if (texts.length === 1) throw Object.assign(new Error('duplicate key'), { code: '23505' });
    return [];
  } } as unknown as Db;
  assert.equal(await requeueJob(fake, 1, at(0), at(0), false), 'superseded');
  assert.equal(texts.length, 3);
  assert.match(texts[1]!, /j\.kind = 'gate'/);
  assert.match(texts[1]!, /j\.trigger = 'manual'/);
  assert.match(texts[2]!, /update visto_ai\.jobs set status = 'dropped', outcome = 'superseded'/);
  assert.match(texts[2]!, /where id = \$1 and status = 'running'/);
});
test('deleteFinishedJobs removes finished jobs older than the time given and no others', async () => {
  const db = await testDb();
  const old = (await enqueueJob(db, job()))!;
  await finishJob(db, old, 'done', 'reviewed', at(0));
  const recent = (await enqueueJob(db, job({ ref: { ...REF, number: 8 } })))!;
  await finishJob(db, recent, 'done', 'reviewed', at(100));
  const open = (await enqueueJob(db, job({ ref: { ...REF, number: 9 } })))!;
  assert.equal(await deleteFinishedJobs(db, at(50)), 1);
  assert.deepEqual([await getJob(db, old), (await getJob(db, recent))?.id, (await getJob(db, open))?.id], [null, recent, open]);
  await db.close();
});
test('a manual job replaces the pending automatic one and carries who asked', async () => {
  const db = await testDb();
  const first = (await enqueueJob(db, job({ runAt: at(180) })))!;
  assert.equal(await enqueueJob(db, manual({ runAt: at(5), now: at(5) })), first);
  const j = await getJob(db, first);
  assert.deepEqual(
    [j?.trigger, j?.reason, j?.headSha, j?.runAt, j?.requestedBy, j?.commentId, j?.association, j?.installation, j?.starts],
    ['manual', 'command', '', at(5), 'octo-lead', '31', 'member', '99', 0]);
  await db.close();
});
test('a push does not replace a pending manual job', async () => {
  const db = await testDb();
  const first = (await enqueueJob(db, manual()))!;
  assert.equal(await enqueueJob(db, job({ reason: 'synchronize', headSha: 'h2', runAt: at(240), now: at(60) })), null);
  const j = await getJob(db, first);
  assert.deepEqual([j?.trigger, j?.reason, j?.runAt], ['manual', 'command', at(0)]);
  await db.close();
});
test('an automatic job that may not replace meets a pending manual job: nothing is stored and the manual job is left whole', async () => {
  const db = await testDb();
  const first = (await enqueueJob(db, manual()))!;
  const before = await getJob(db, first);
  assert.equal(await enqueueJob(db, job({ reason: 'synchronize', headSha: 'h2', runAt: at(240), now: at(60), delivery: 'd2', replace: false })), null);
  assert.deepEqual(await unfinishedJobs(db), [before]);
  await db.close();
});
test('a manual job that may not replace is stored only when nothing is pending', async () => {
  const db = await testDb();
  const first = (await enqueueJob(db, job({ runAt: at(180) })))!;
  assert.equal(await enqueueJob(db, manual({ replace: false })), null);
  assert.deepEqual([(await getJob(db, first))?.trigger, (await unfinishedJobs(db)).length], ['automatic', 1]);
  const alone = await enqueueJob(db, manual({ ref: { ...REF, number: 8 }, replace: false }));
  assert.equal((await getJob(db, alone!))?.trigger, 'manual');
  await db.close();
});
test('a second manual job replaces the first', async () => {
  const db = await testDb();
  const first = (await enqueueJob(db, manual()))!;
  assert.equal(await enqueueJob(db, manual({ requestedBy: 'octo-dev', commentId: '32', now: at(9), runAt: at(9) })), first);
  assert.deepEqual([(await getJob(db, first))?.requestedBy, (await unfinishedJobs(db)).length], ['octo-dev', 1]);
  await db.close();
});
test('an automatic job is read back with no requester', async () => {
  const db = await testDb();
  const id = (await enqueueJob(db, job()))!;
  const j = await getJob(db, id);
  assert.deepEqual([j?.trigger, j?.requestedBy, j?.commentId, j?.association, j?.installation], ['automatic', null, null, null, null]);
  await db.close();
});

const gate = (over = {}) => manual({ kind: 'gate' as const, reason: 'done', ...over });
const sync = async (db: Db, now = at(0)): Promise<number> => (await askGate(db, REF, now))!;

test('a job has a kind, and one stored without it is a review job', async () => {
  const db = await testDb();
  const review = (await enqueueJob(db, job()))!;
  const command = (await enqueueJob(db, gate()))!;
  await db.query(
    `insert into visto_ai.jobs (service, owner, repo, number, reason, head_sha, status, run_at, starts, created_at, trigger)
     values ('github', 'acme', 'shop', 8, 'opened', 'h1', 'pending', $1::timestamptz, 0, $1::timestamptz, 'automatic')`, [at(0)]);
  const bySql = (await unfinishedJobs(db)).find((j) => j.ref.number === 8)!;
  assert.deepEqual([(await getJob(db, review))?.kind, (await getJob(db, command))?.kind, bySql.kind], ['review', 'gate', 'review']);
  await db.close();
});
test('a pull request can have a pending review job and a pending gate job, and one of each at most', async () => {
  const db = await testDb();
  const review = (await enqueueJob(db, job()))!;
  const command = (await enqueueJob(db, gate()))!;
  assert.notEqual(review, command);
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.id, j.kind, j.status]), [[review, 'review', 'pending'], [command, 'gate', 'pending']]);
  assert.equal(await enqueueJob(db, gate({ reason: 'skip', replace: false })), null);
  const reviewBefore = await getJob(db, review);
  assert.equal(await enqueueJob(db, gate({ reason: 'skip', commentId: '32', runAt: at(5), now: at(5) })), command);
  const replaced = await getJob(db, command);
  assert.deepEqual([replaced?.reason, replaced?.commentId, replaced?.runAt], ['skip', '32', at(5)]);
  assert.deepEqual(await getJob(db, review), reviewBefore);
  assert.equal((await unfinishedJobs(db)).length, 2);
  await db.close();
});
test('the due jobs are listed for one kind', async () => {
  const db = await testDb();
  await enqueueJob(db, job());
  const command = (await enqueueJob(db, gate()))!;
  assert.deepEqual((await dueJobs(db, at(10), 5, 'gate')).map((j) => [j.id, j.kind]), [[command, 'gate']]);
  assert.deepEqual((await dueJobs(db, at(10), 5, 'review')).map((j) => j.kind), ['review']);
  await db.close();
});
test('a review job put back is superseded by a waiting review job as before, and never by a gate job', async () => {
  const db = await testDb();
  const cut = (await enqueueJob(db, manual()))!;
  await claimJob(db, cut, at(1));
  const waiting = (await enqueueJob(db, job({ reason: 'synchronize', headSha: 'h2', runAt: at(2), now: at(2) })))!;
  assert.equal(await requeueJob(db, cut, at(60), at(9), false), 'superseded');
  assert.deepEqual([(await getJob(db, cut))?.outcome, (await getJob(db, waiting))?.status], ['superseded', 'pending']);

  const other = { ...REF, number: 8 };
  const alone = (await enqueueJob(db, manual({ ref: other })))!;
  await claimJob(db, alone, at(1));
  const command = (await enqueueJob(db, gate({ ref: other })))!;
  assert.equal(await requeueJob(db, alone, at(60), at(9), false), 'requeued');
  assert.deepEqual([(await getJob(db, alone))?.status, (await getJob(db, command))?.status], ['pending', 'pending']);
  await db.close();
});
test('a gate command put back takes the slot of a waiting sync, and loses it only to a later command', async () => {
  const db = await testDb();
  const command = (await enqueueJob(db, gate()))!;
  await claimJob(db, command, at(1));
  const waiting = await sync(db, at(2));
  assert.equal(await requeueJob(db, command, at(60), at(9), false), 'requeued');
  const dropped = await getJob(db, waiting);
  assert.deepEqual([dropped?.status, dropped?.outcome], ['dropped', 'superseded']);
  assert.deepEqual([(await getJob(db, command))?.status, (await getJob(db, command))?.runAt], ['pending', at(60)]);

  await claimJob(db, command, at(60));
  const later = (await enqueueJob(db, gate({ reason: 'skip', commentId: '33', runAt: at(61), now: at(61) })))!;
  const laterBefore = await getJob(db, later);
  assert.equal(await requeueJob(db, command, at(90), at(62), false), 'superseded');
  assert.deepEqual([(await getJob(db, command))?.status, (await getJob(db, command))?.outcome], ['dropped', 'superseded']);
  assert.deepEqual(await getJob(db, later), laterBefore);
  await db.close();
});
test('a gate command put back while a sync is stored between the two statements takes the slot all the same', async () => {
  const db = await testDb();
  const command = (await enqueueJob(db, gate()))!;
  await claimJob(db, command, at(1));
  await sync(db, at(2));
  let raced = false;
  const racing: Db = { ...db, query: async (text, params) => {
    const rows = await db.query(text, params);
    if (!raced && text.includes("p.trigger = 'automatic'")) {
      raced = true;
      await askGate(db, REF, at(3));
    }
    return rows as never;
  } };
  assert.equal(await requeueJob(racing, command, at(60), at(9), false), 'requeued');
  const left = await unfinishedJobs(db);
  assert.deepEqual([raced, left.map((j) => [j.id, j.status])], [true, [[command, 'pending']]]);
  await db.close();
});
test('a sync put back beside a waiting sync hands it its starts', async () => {
  const db = await testDb();
  const running = await sync(db);
  await claimJob(db, running, at(1));
  await db.query('update visto_ai.jobs set starts = 2 where id = $1', [running]);
  const waiting = await sync(db, at(2));
  assert.equal(await requeueJob(db, running, at(60), at(9), false), 'superseded');
  assert.deepEqual([(await getJob(db, running))?.outcome, (await getJob(db, waiting))?.starts], ['superseded', 2]);

  const other = { ...REF, number: 8 };
  const second = (await askGate(db, other, at(0)))!;
  await claimJob(db, second, at(1));
  await db.query('update visto_ai.jobs set starts = 2 where id = $1', [second]);
  const busier = (await askGate(db, other, at(2)))!;
  await db.query('update visto_ai.jobs set starts = 3 where id = $1', [busier]);
  assert.equal(await requeueJob(db, second, at(60), at(9), false), 'superseded');
  assert.equal((await getJob(db, busier))?.starts, 3);
  await db.close();
});
test('asking for the check stores one sync, moves a waiting sync to the new time without touching its starts, and leaves a waiting command in place', async () => {
  const db = await testDb();
  const first = await sync(db, at(0));
  assert.equal(await askGate(db, REF, at(1), at(4)), first);
  assert.deepEqual(await unfinishedJobs(db), [{
    id: first, ref: REF, kind: 'gate', reason: 'sync', headSha: '', trigger: 'automatic',
    requestedBy: null, commentId: null, association: null, installation: null, status: 'pending', outcome: null,
    runAt: at(4), starts: 0, createdAt: at(0),
  }]);
  for (const t of [4, 5]) {
    await claimJob(db, first, at(t));
    assert.equal(await requeueJob(db, first, at(t + 1), at(t), false), 'requeued');
  }
  assert.equal(await askGate(db, REF, at(6), at(9)), first);
  assert.deepEqual([(await getJob(db, first))?.starts, (await getJob(db, first))?.runAt], [2, at(9)]);

  const other = { ...REF, number: 8 };
  const command = (await enqueueJob(db, gate({ ref: other, reason: 'skip' })))!;
  const before = await getJob(db, command);
  assert.equal(await askGate(db, other, at(7)), null);
  assert.deepEqual((await unfinishedJobs(db)).filter((j) => j.ref.number === 8), [before]);
  await db.close();
});
test('a sync carries the installation it was asked with, the newest onto a waiting one, and only the sweep renews a waiting one', async () => {
  const db = await testDb();
  const first = (await askGate(db, REF, at(0)))!;
  assert.equal((await getJob(db, first))?.installation, null);
  assert.equal(await askGate(db, REF, at(1), undefined, { installation: '99' }), first);
  assert.equal((await getJob(db, first))?.installation, '99');
  // The newest installation wins (the app installed again has a new id); an ask that brings none leaves it.
  assert.equal(await askGate(db, REF, at(2), undefined, { installation: '77' }), first);
  assert.equal((await getJob(db, first))?.installation, '77');
  assert.equal(await askGate(db, REF, at(3)), first);
  assert.equal((await getJob(db, first))?.installation, '77');
  const other = { ...REF, number: 8 };
  const stored = (await askGate(db, other, at(0), undefined, { installation: '42' }))!;
  assert.equal((await getJob(db, stored))?.installation, '42');

  // A sync two starts old, from a long stop: an ask keeps its starts and its age; the sweep's ask renews both.
  await claimJob(db, first, at(3));
  assert.equal(await requeueJob(db, first, at(4), at(3), false), 'requeued');
  assert.equal(await askGate(db, REF, at(5)), first);
  assert.deepEqual([(await getJob(db, first))?.starts, (await getJob(db, first))?.createdAt], [1, at(0)]);
  assert.equal(await askGate(db, REF, at(90_000), undefined, { renew: true }), first);
  assert.deepEqual([(await getJob(db, first))?.starts, (await getJob(db, first))?.createdAt, (await getJob(db, first))?.runAt], [0, at(90_000), at(90_000)]);
  // A waiting command is never renewed.
  const third = { ...REF, number: 9 };
  const command = (await enqueueJob(db, gate({ ref: third, reason: 'skip' })))!;
  const before = await getJob(db, command);
  assert.equal(await askGate(db, third, at(9), undefined, { renew: true, installation: '1' }), null);
  assert.deepEqual(await getJob(db, command), before);
  await db.close();
});

test('a withdraw job has its own pending slot beside a review job and a gate job, and a second ask moves its time and keeps its starts', async () => {
  const db = await testDb();
  const review = (await enqueueJob(db, job()))!;
  const check = await sync(db);
  const withdraw = (await askWithdraw(db, { ...REF, owner: 'Acme' }, at(0)))!;
  assert.deepEqual((await unfinishedJobs(db)).map((j) => [j.id, j.kind, j.status]),
    [[review, 'review', 'pending'], [check, 'gate', 'pending'], [withdraw, 'withdraw', 'pending']]);
  await claimJob(db, withdraw, at(1));
  assert.equal(await requeueJob(db, withdraw, at(11), at(1), false), 'requeued');
  const others = [await getJob(db, review), await getJob(db, check)];
  assert.equal(await askWithdraw(db, REF, at(5), '98'), withdraw);
  assert.deepEqual(await getJob(db, withdraw), {
    id: withdraw, ref: REF, kind: 'withdraw', reason: 'withdraw', headSha: '', trigger: 'automatic',
    requestedBy: null, commentId: null, association: null, installation: '98', status: 'pending', outcome: null,
    runAt: at(5), starts: 1, createdAt: at(0),
  });
  assert.equal(await askWithdraw(db, REF, at(6)), withdraw);
  assert.deepEqual([(await getJob(db, withdraw))?.installation, (await getJob(db, withdraw))?.runAt, (await getJob(db, withdraw))?.starts], ['98', at(6), 1]);
  assert.deepEqual([await getJob(db, review), await getJob(db, check)], others);
  assert.equal((await unfinishedJobs(db)).filter((j) => j.kind === 'withdraw').length, 1);
  assert.deepEqual((await dueJobs(db, at(10), 5, 'withdraw')).map((j) => [j.id, j.kind]), [[withdraw, 'withdraw']]);
  await db.close();
});
test('a withdraw job put back while another waits hands it its starts, as a sync does', async () => {
  const db = await testDb();
  const running = (await askWithdraw(db, REF, at(0)))!;
  await claimJob(db, running, at(0));
  assert.equal(await requeueJob(db, running, at(10), at(1), false), 'requeued');
  await claimJob(db, running, at(10));
  assert.equal((await getJob(db, running))?.starts, 2);
  const waiting = (await askWithdraw(db, REF, at(11)))!;
  assert.notEqual(waiting, running);
  const check = await sync(db, at(11));
  assert.equal(await requeueJob(db, running, at(70), at(12), false), 'superseded');
  assert.deepEqual([(await getJob(db, running))?.status, (await getJob(db, running))?.outcome], ['dropped', 'superseded']);
  assert.deepEqual([(await getJob(db, waiting))?.status, (await getJob(db, waiting))?.starts], ['pending', 2]);
  assert.equal((await getJob(db, check))?.starts, 0);

  // A gate sync behaves as before: it hands its starts to a waiting sync, never to a waiting withdraw job.
  const other = { ...REF, number: 8 };
  const syncing = (await askGate(db, other, at(0)))!;
  await claimJob(db, syncing, at(1));
  await db.query('update visto_ai.jobs set starts = 2 where id = $1', [syncing]);
  const nextSync = (await askGate(db, other, at(2)))!;
  const nextWithdraw = (await askWithdraw(db, other, at(2)))!;
  assert.equal(await requeueJob(db, syncing, at(60), at(9), false), 'superseded');
  assert.deepEqual([(await getJob(db, nextSync))?.starts, (await getJob(db, nextWithdraw))?.starts], [2, 0]);
  await db.close();
});
test('the unfinished review jobs of a pull request are listed, never a gate job, a finished one or another pull request\'s', async () => {
  const db = await testDb();
  const done = (await enqueueJob(db, job()))!;
  await finishJob(db, done, 'done', 'reviewed', at(1));
  const running = (await enqueueJob(db, job({ now: at(2) })))!;
  await claimJob(db, running, at(2));
  const pending = (await enqueueJob(db, job({ headSha: 'h2', now: at(3) })))!;
  await enqueueJob(db, gate());
  await enqueueJob(db, job({ ref: { ...REF, number: 8 } }));
  assert.deepEqual((await reviewJobsOf(db, { ...REF, owner: 'Acme' })).map((j) => [j.id, j.status]), [[running, 'running'], [pending, 'pending']]);
  await db.close();
});

/** A job's stage as stored: [stage, stage_at, batch, batches, threads_due]. */
const stageOf = async (db: Db, id: number): Promise<Array<string | number | null>> => {
  const [r] = await db.query<{ stage: string | null; stage_at: Date | null; batch: number | null; batches: number | null; threads_due: number | null }>(
    'select stage, stage_at, batch, batches, threads_due from visto_ai.jobs where id = $1', [id]);
  return [r!.stage, r!.stage_at === null ? null : r!.stage_at.toISOString(), r!.batch, r!.batches, r!.threads_due];
};
const NO_STAGE = [null, null, null, null, null];

test("a running job's stage is written with its time, and a job that is not running takes none", async () => {
  const db = await testDb();
  const id = (await enqueueJob(db, job()))!;
  await claimJob(db, id, at(1));
  assert.deepEqual(await stageOf(db, id), NO_STAGE);
  assert.equal(await markStage(db, id, { stage: 'reviewing', batch: 2, batches: 3 }, at(5)), true);
  assert.deepEqual(await stageOf(db, id), ['reviewing', at(5), 2, 3, null]);
  assert.equal(await markStage(db, id, { stage: 'judging_threads', batch: 1, batches: 2, threadsDue: 3 }, at(6)), true);
  assert.deepEqual(await stageOf(db, id), ['judging_threads', at(6), 1, 2, 3]);
  assert.equal(await markStage(db, id, { stage: 'preparing' }, at(7)), true);
  assert.deepEqual(await stageOf(db, id), ['preparing', at(7), null, null, null]);

  const pending = (await enqueueJob(db, job({ ref: { ...REF, number: 8 } })))!;
  assert.equal(await markStage(db, pending, { stage: 'reviewing', batch: 1, batches: 1 }, at(8)), false);
  assert.deepEqual(await stageOf(db, pending), NO_STAGE);
  assert.equal(await finishJob(db, id, 'done', 'reviewed', at(9)), true);
  assert.equal(await markStage(db, id, { stage: 'publishing' }, at(10)), false);
  assert.deepEqual(await stageOf(db, id), ['preparing', at(7), null, null, null]);
  assert.equal(await markStage(db, 999_999, { stage: 'publishing' }, at(10)), false);
  await db.close();
});
test('a claim clears the stage a start before left', async () => {
  const db = await testDb();
  const id = (await enqueueJob(db, job()))!;
  await claimJob(db, id, at(1));
  assert.equal(await markStage(db, id, { stage: 'publishing' }, at(2)), true);
  assert.equal(await requeueJob(db, id, at(3), at(2), false), 'requeued');
  assert.deepEqual(await stageOf(db, id), ['publishing', at(2), null, null, null]);
  assert.notEqual(await claimJob(db, id, at(3)), null);
  assert.deepEqual(await stageOf(db, id), NO_STAGE);
  // The counts too: a start that left a batch and threads due.
  assert.equal(await markStage(db, id, { stage: 'judging_threads', batch: 1, batches: 2, threadsDue: 3 }, at(4)), true);
  assert.equal(await requeueJob(db, id, at(5), at(4), false), 'requeued');
  assert.notEqual(await claimJob(db, id, at(5)), null);
  assert.deepEqual(await stageOf(db, id), NO_STAGE);
  await db.close();
});
test('a job put back keeps the code it is given, and one put back without a code has none', async () => {
  const db = await testDb();
  const retryCode = async (id: number): Promise<string | null | undefined> =>
    (await db.query<{ retry_code: string | null }>('select retry_code from visto_ai.jobs where id = $1', [id]))[0]?.retry_code;
  const id = (await enqueueJob(db, job()))!;
  assert.equal(await retryCode(id), null);
  await claimJob(db, id, at(1));
  assert.equal(await requeueJob(db, id, at(10), at(1), false, 'github_403'), 'requeued');
  assert.equal(await retryCode(id), 'github_403');
  await claimJob(db, id, at(10));
  assert.equal(await requeueJob(db, id, at(20), at(10), false), 'requeued');
  assert.equal(await retryCode(id), null);
  await db.close();
});
