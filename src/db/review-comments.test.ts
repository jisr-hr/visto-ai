import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import { listComments, recordComments } from './review-comments.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;

test('posted comments are stored once, with the finding they came from', async () => {
  const db = await testDb();
  const c = { commentId: '9001', path: 'a.ts', side: 'RIGHT' as const, line: 3, severity: 'major', quote: 'x = 1' };
  await recordComments(db, 4, REF, [c, { ...c, commentId: '9002', line: null }]);
  await recordComments(db, 5, REF, [{ ...c, severity: 'minor' }]);
  assert.deepEqual(await listComments(db, REF), [{ ...c, run: 4 }, { ...c, commentId: '9002', line: null, run: 4 }]);
  assert.deepEqual(await listComments(db, { ...REF, number: 8 }), []);
  await db.close();
});
