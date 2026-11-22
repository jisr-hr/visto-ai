import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedLock } from './lock.ts';

/** A work that records its start, waits until it is let go, records its end and answers its name. */
function gated(name: string, seen: string[]) {
  let release!: () => void;
  const let_go = new Promise<void>((resolve) => { release = resolve; });
  const work = async (): Promise<string> => {
    seen.push(`start ${name}`);
    await let_go;
    seen.push(`end ${name}`);
    return name;
  };
  return { work, release };
}

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

test('the work of one key runs one at a time, in order, and other keys do not wait', async () => {
  const lock = createKeyedLock();
  const seen: string[] = [];
  const a1 = gated('a1', seen);
  const a2 = gated('a2', seen);
  const a3 = gated('a3', seen);
  const b1 = gated('b1', seen);
  const p1 = lock.run('acme/shop@h1', a1.work);
  const p2 = lock.run('acme/shop@h1', a2.work);
  const p3 = lock.run('acme/shop@h1', a3.work);
  const q1 = lock.run('acme/shop@h2', b1.work);
  await turn();
  assert.deepEqual(seen, ['start a1', 'start b1']);
  a2.release();
  a3.release();
  await turn();
  assert.deepEqual(seen, ['start a1', 'start b1'], 'a released work that was asked later still waits for the one before it');
  a1.release();
  assert.equal(await p1, 'a1');
  assert.equal(await p2, 'a2');
  assert.equal(await p3, 'a3');
  assert.deepEqual(seen, ['start a1', 'start b1', 'end a1', 'start a2', 'end a2', 'start a3', 'end a3']);
  b1.release();
  assert.equal(await q1, 'b1');
  // The key was forgotten: a new work of it starts at once.
  const a4 = gated('a4', seen);
  const p4 = lock.run('acme/shop@h1', a4.work);
  await turn();
  assert.equal(seen.at(-1), 'start a4');
  a4.release();
  await p4;
});

test('a work that rejects does not hold the next, and its rejection reaches its caller', async () => {
  const lock = createKeyedLock();
  const seen: string[] = [];
  const first = lock.run('acme/shop@h1', async () => { seen.push('first'); await turn(); throw new Error('github_502'); });
  const thrown = lock.run('acme/shop@h1', () => { seen.push('thrown'); throw new Error('internal_error'); });
  const next = lock.run('acme/shop@h1', async () => { seen.push('next'); return 7; });
  await assert.rejects(first, { message: 'github_502' });
  await assert.rejects(thrown, { message: 'internal_error' });
  assert.equal(await next, 7);
  assert.deepEqual(seen, ['first', 'thrown', 'next']);
});
