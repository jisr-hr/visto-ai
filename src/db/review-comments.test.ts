import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import { NOTE, listComments, recordComments } from './review-comments.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;

test('posted comments are stored once, with the finding they came from', async () => {
  const db = await testDb();
  const c = { commentId: '9001', path: 'a.ts', side: 'RIGHT' as const, line: 3, severity: 'major', quote: 'x = 1' };
  await recordComments(db, 4, REF, [c, { ...c, commentId: '9002', line: null }]);
  await recordComments(db, 5, REF, [{ ...c, severity: 'minor' }]);
  assert.deepEqual(await listComments(db, REF), [{ ...c, blockHash: null, run: 4 }, { ...c, commentId: '9002', line: null, blockHash: null, run: 4 }]);
  assert.deepEqual(await listComments(db, { ...REF, number: 8 }), []);
  await db.close();
});
test('a note is stored with the hash of its block, and a finding with none', async () => {
  const db = await testDb();
  await recordComments(db, 1, REF, [
    { commentId: '501', path: 'src/a.ts', side: 'RIGHT', line: 3, severity: NOTE, quote: '', blockHash: 'h1' },
    { commentId: '502', path: 'src/a.ts', side: 'RIGHT', line: 9, severity: 'major', quote: 'x()' },
  ]);
  assert.deepEqual((await listComments(db, REF)).map((c) => [c.commentId, c.severity, c.blockHash]), [['501', 'note', 'h1'], ['502', 'major', null]]);
  await db.close();
});
test('a row stored before notes existed reads with no block hash', async () => {
  const db = await testDb();
  await db.query(
    `insert into visto_ai.review_comments (run, service, owner, repo, number, comment_id, path, side, line, severity, quote)
     values (1, 'github', 'acme', 'shop', 7, '77', 'a.ts', 'RIGHT', 2, 'minor', 'y')`);
  assert.deepEqual((await listComments(db, REF)).map((c) => [c.commentId, c.blockHash]), [['77', null]]);
  await db.close();
});
