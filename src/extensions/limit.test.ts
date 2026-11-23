import test from 'node:test';
import assert from 'node:assert/strict';
import { withLimit } from './limit.ts';

test('work that settles in time is its own result, and one that throws at once is a rejection', async () => {
  assert.equal(await withLimit(1000, () => 5), 5);
  assert.equal(await withLimit(1000, async () => 'later'), 'later');
  await assert.rejects(withLimit(1000, () => { throw new Error('at_once'); }), { message: 'at_once' });
  await assert.rejects(withLimit(1000, () => Promise.reject(new Error('rejected'))), { message: 'rejected' });
});

test('work that does not settle rejects with timeout, and its signal is aborted', async () => {
  let seen: AbortSignal | null = null;
  await assert.rejects(withLimit(5, (signal) => { seen = signal; return new Promise(() => {}); }), { message: 'timeout' });
  assert.equal((seen as AbortSignal | null)?.aborted, true);
});
