import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { claimJob, enqueueJob, getJob } from '../db/jobs.ts';
import { recoverJobs } from './recovery.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const job = (over = {}) => ({ ref: REF, reason: 'opened', headSha: 'h1', runAt: at(0), now: at(0), delivery: 'd1', replace: true, ...over });

let db: Db;
beforeEach(async () => { db = await testDb(); });
afterEach(async () => { await db.close(); });

test('start-up puts interrupted jobs back and leaves pending ones alone', async () => {
  const cut = (await enqueueJob(db, job()))!;
  await claimJob(db, cut, at(0));
  const waiting = (await enqueueJob(db, job({ ref: { ...REF, number: 8 }, runAt: at(120) })))!;
  const logged: Array<Record<string, unknown>> = [];
  assert.deepEqual(await recoverJobs(db, new Date(at(10)), (e) => { logged.push(e); }), { requeued: 1, dropped: 0 });
  const back = await getJob(db, cut);
  assert.deepEqual([back?.status, back?.starts, back?.runAt], ['pending', 1, at(10)]);
  assert.deepEqual([(await getJob(db, waiting))?.status, (await getJob(db, waiting))?.runAt], ['pending', at(120)]);
  assert.deepEqual(logged, [{ event: 'recovery', requeued: 1, dropped: 0 }]);
});
test('an interrupted job whose pull request has a newer pending job is dropped as superseded', async () => {
  const cut = (await enqueueJob(db, job()))!;
  await claimJob(db, cut, at(0));
  await enqueueJob(db, job({ headSha: 'h2', runAt: at(1), now: at(1) }));
  assert.deepEqual(await recoverJobs(db, new Date(at(10)), () => {}), { requeued: 0, dropped: 1 });
  assert.equal((await getJob(db, cut))?.outcome, 'superseded');
});
