import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import type { Db } from './types.ts';
import { claimJob, deleteFinishedJobs, dropJobIfUnchanged, dueJobs, enqueueJob, finishJob, getJob, requeueJob, unfinishedJobs } from './jobs.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const job = (over = {}) => ({ ref: REF, reason: 'opened', headSha: 'h1', runAt: at(0), now: at(0), delivery: 'd1', replace: true, ...over });

test('a second trigger for a pull request replaces its pending job and starts it afresh', async () => {
  const db = await testDb();
  const first = (await enqueueJob(db, job()))!;
  await db.query('update visto_ai.jobs set starts = 2 where id = $1', [first]);
  const second = (await enqueueJob(db, job({ reason: 'synchronize', headSha: 'h2', runAt: at(240), now: at(60), delivery: 'd2' })))!;
  assert.equal(second, first);
  assert.deepEqual(await unfinishedJobs(db), [{
    id: first, ref: REF, reason: 'synchronize', headSha: 'h2', status: 'pending', outcome: null, runAt: at(240), starts: 0, createdAt: at(60),
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
  assert.deepEqual((await dueJobs(db, at(10), 5)).map((j) => j.ref.number), [8, 7]);
  assert.deepEqual((await dueJobs(db, at(10), 1)).map((j) => j.ref.number), [8]);
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
  const [listed] = await dueJobs(db, at(0), 5);
  assert.equal(await dropJobIfUnchanged(db, listed!, 'too_old', at(3)), true);
  const j = await getJob(db, id);
  assert.deepEqual([j?.status, j?.outcome], ['dropped', 'too_old']);
  await db.close();
});
test('dropJobIfUnchanged leaves a job that was replaced after it was listed', async () => {
  const db = await testDb();
  const id = (await enqueueJob(db, job()))!;
  await db.query('update visto_ai.jobs set starts = 3 where id = $1', [id]);
  const [listed] = await dueJobs(db, at(0), 5);
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
  assert.match(texts[1]!, /'dropped'/);
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
