import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import { listActivity, recordActivity } from './human-activity.ts';
import type { Activity } from './human-activity.ts';

const ref = { service: 'github' as const, owner: 'acme', repo: 'shop', number: 7 };
function activity(over: Partial<Activity> = {}): Activity {
  return {
    ref, kind: 'review', sourceId: 'r-1', author: 'octo-dev', association: 'member',
    state: 'approved', body: '', path: null, side: null, line: null, startLine: null, fileLevel: null,
    commit: 'aaa111', replyTo: null, thread: null, at: '2026-03-01T10:00:00.000Z', delivery: 'd-1', ...over,
  };
}

test('an approval with an empty body is stored and listed unchanged', async () => {
  const db = await testDb();
  const a = activity();
  assert.equal(await recordActivity(db, a), true);
  assert.deepEqual(await listActivity(db, ref), [a]);
  await db.close();
});
test('an inline comment keeps every field', async () => {
  const db = await testDb();
  const a = activity({
    kind: 'inline_comment', sourceId: 'c-1', state: null, body: 'rename this',
    path: 'src/a.ts', side: 'RIGHT', line: 12, startLine: 10, fileLevel: false, replyTo: 'c-0', thread: 't-1',
  });
  await recordActivity(db, a);
  assert.deepEqual(await listActivity(db, ref), [a]);
  await db.close();
});
test('the same kind and source id is stored once; another kind is stored too', async () => {
  const db = await testDb();
  assert.equal(await recordActivity(db, activity()), true);
  assert.equal(await recordActivity(db, activity({ body: 'changed' })), false);
  assert.equal(await recordActivity(db, activity({ kind: 'general_comment', state: null })), true);
  assert.deepEqual(await db.query('select count(*)::int as n from visto_ai.human_activity'), [{ n: 2 }]);
  assert.equal((await listActivity(db, ref)).find((x) => x.kind === 'review')?.body, '');
  await db.close();
});
test('a row with no delivery is stored and listed', async () => {
  const db = await testDb();
  await recordActivity(db, activity({ delivery: null }));
  assert.equal((await listActivity(db, ref))[0]?.delivery, null);
  await db.close();
});
test('listActivity is oldest first by time, then by insertion', async () => {
  const db = await testDb();
  await recordActivity(db, activity({ sourceId: 'late', at: '2026-03-01T12:00:00.000Z' }));
  await recordActivity(db, activity({ sourceId: 'tie-1', at: '2026-03-01T11:00:00.000Z' }));
  await recordActivity(db, activity({ sourceId: 'early', at: '2026-03-01T09:00:00.000Z' }));
  await recordActivity(db, activity({ sourceId: 'tie-2', at: '2026-03-01T11:00:00.000Z' }));
  assert.deepEqual((await listActivity(db, ref)).map((x) => x.sourceId), ['early', 'tie-1', 'tie-2', 'late']);
  await db.close();
});
test('Review Focus 5: NUL, a lone surrogate and a long body are stored as data', async () => {
  const db = await testDb();
  const body = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(0xd800) + 'c'.repeat(64_996);
  assert.equal(body.length, 65_000);
  assert.equal(await recordActivity(db, activity({ body })), true);
  const got = (await listActivity(db, ref))[0]?.body ?? '';
  assert.equal(got.includes(String.fromCharCode(0)), false);
  assert.equal(got.length, 64_999);
  assert.equal(got.slice(0, 3), 'ab' + String.fromCharCode(0xfffd));
  await db.close();
});
test('another pull request of the same repository has no activity listed', async () => {
  const db = await testDb();
  await recordActivity(db, activity());
  assert.deepEqual(await listActivity(db, { ...ref, number: 8 }), []);
  await db.close();
});
