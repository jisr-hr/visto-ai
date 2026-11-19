import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { enqueueJob, getJob } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import { createRunner } from './runner.ts';
import type { RunnerDeps } from './runner.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const job = (over = {}) => ({ ref: REF, reason: 'opened', headSha: 'h1', runAt: at(0), now: at(0), delivery: 'd1', replace: true, ...over });

let db: Db;
beforeEach(async () => { db = await testDb(); });
afterEach(async () => { await db.close(); });

function harness(over: Partial<RunnerDeps> = {}) {
  const started: Job[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const ends = new Map<string, () => void>();          // by "<number> <head>"
  const state = { now: at(600) };
  const runner = createRunner({
    db, concurrency: 2, clock: () => new Date(state.now), log: (e) => { logged.push(e); }, mayStart: async () => true,
    run: (j) => new Promise<void>((end) => { started.push(j); ends.set(`${j.ref.number} ${j.headSha}`, end); }),
    ...over,
  });
  /** Lets the runner notice a job's end, then runs one more pass. */
  const next = async (): Promise<void> => { await new Promise((r) => setImmediate(r)); await runner.tick(); };
  return { runner, started, logged, state, end: (key: string): void => { ends.get(key)!(); }, next };
}
const numbers = (jobs: Job[]): number[] => jobs.map((j) => j.ref.number);

test('due jobs start up to the concurrency, and the next starts when one ends', async () => {
  for (const n of [7, 8, 9]) await enqueueJob(db, job({ ref: { ...REF, number: n }, runAt: at(n) }));
  const h = harness();
  await h.runner.tick();
  assert.deepEqual([numbers(h.started), h.runner.running()], [[7, 8], 2]);
  h.end('7 h1');
  await h.next();
  assert.deepEqual(numbers(h.started), [7, 8, 9]);
});
test('a pull request never has two jobs running, and a later pull request is not held up', async () => {
  const h = harness();
  await enqueueJob(db, job());
  await h.runner.tick();
  await enqueueJob(db, job({ headSha: 'h2', runAt: at(1), now: at(1) }));
  await enqueueJob(db, job({ ref: { ...REF, number: 8 }, runAt: at(2), now: at(2) }));
  await h.runner.tick();
  assert.deepEqual(h.started.map((j) => `${j.ref.number} ${j.headSha}`), ['7 h1', '8 h1']);
  h.end('7 h1');
  await h.next();
  assert.deepEqual(h.started.map((j) => `${j.ref.number} ${j.headSha}`), ['7 h1', '8 h1', '7 h2']);
});
test('a job is not started before its time', async () => {
  const h = harness();
  h.state.now = at(0);
  await enqueueJob(db, job({ runAt: at(180) }));
  await h.runner.tick();
  assert.deepEqual(h.started, []);
  h.state.now = at(180);
  await h.runner.tick();
  assert.deepEqual(numbers(h.started), [7]);
});
test('nothing starts while mayStart says no, and no start is counted', async () => {
  const id = (await enqueueJob(db, job()))!;
  const h = harness({ mayStart: async () => false });
  await h.runner.tick();
  const j = await getJob(db, id);
  assert.deepEqual([h.started.length, j?.status, j?.starts], [0, 'pending', 0]);
});
test('a mayStart that rejects is treated as no and logged', async () => {
  await enqueueJob(db, job());
  const h = harness({ mayStart: () => Promise.reject(new Error('db down')) });
  await h.runner.tick();
  assert.deepEqual([h.started.length, h.logged[0]!.event], [0, 'gate_failed']);
});
test('a job that is out of starts is dropped and not run, and the next one runs', async () => {
  const id = (await enqueueJob(db, job()))!;
  await db.query('update visto_ai.jobs set starts = 3 where id = $1', [id]);
  await enqueueJob(db, job({ ref: { ...REF, number: 8 }, runAt: at(1) }));
  const h = harness({ concurrency: 1 });
  await h.runner.tick();
  const j = await getJob(db, id);
  assert.deepEqual([numbers(h.started), j?.status, j?.outcome], [[8], 'dropped', 'attempts_exhausted']);
});
test('a job more than a day old is dropped and not run', async () => {
  const id = (await enqueueJob(db, job({ now: at(-90_000), runAt: at(-90_000) })))!;
  const h = harness();
  await h.runner.tick();
  const j = await getJob(db, id);
  assert.deepEqual([h.started.length, j?.status, j?.outcome], [0, 'dropped', 'too_old']);
  assert.deepEqual(h.logged, [{ event: 'job', job: id, repo: 'acme/shop', number: 7, outcome: 'dropped', reason: 'too_old' }]);
});
test('a run that rejects ends the job as failed and the runner goes on', async () => {
  const id = (await enqueueJob(db, job()))!;
  await enqueueJob(db, job({ ref: { ...REF, number: 8 }, runAt: at(1) }));
  const ran: number[] = [];
  const h = harness({ concurrency: 1, run: async (j) => { ran.push(j.ref.number); if (j.ref.number === 7) throw new TypeError('private detail'); } });
  await h.runner.tick();
  await h.next();
  const j = await getJob(db, id);
  assert.deepEqual([ran, j?.status, j?.outcome], [[7, 8], 'done', 'failed']);
  assert.equal(JSON.stringify(h.logged).includes('private detail'), false);
});
test('ticks that overlap never start more than the concurrency', async () => {
  for (const n of [7, 8, 9, 10, 11]) await enqueueJob(db, job({ ref: { ...REF, number: n } }));
  const h = harness();
  await Promise.all([h.runner.tick(), h.runner.tick(), h.runner.tick()]);
  assert.equal(h.started.length, 2);
});
test('after drain nothing starts, and drain resolves when the running jobs have ended', async () => {
  for (const n of [7, 8, 9]) await enqueueJob(db, job({ ref: { ...REF, number: n }, runAt: at(n) }));
  const h = harness();
  await h.runner.tick();
  let drained = false;
  const draining = h.runner.drain().then(() => { drained = true; });
  h.end('7 h1');
  await h.next();
  assert.deepEqual([numbers(h.started), drained], [[7, 8], false]);
  h.end('8 h1');
  await draining;
  assert.equal(h.runner.running(), 0);
});
test('a database failure in a pass is logged and the next pass works', async () => {
  await enqueueJob(db, job());
  let fail = true;
  const flaky: Db = { ...db, query: (text, params) => (fail ? Promise.reject(Object.assign(new Error('gone'), { code: '57P01' })) : db.query(text, params)) };
  const h = harness({ db: flaky });
  await h.runner.tick();
  assert.deepEqual([h.started.length, h.logged[0]!.event, h.logged[0]!.code], [0, 'runner_failed', '57P01']);
  fail = false;
  await h.runner.tick();
  assert.deepEqual(numbers(h.started), [7]);
});