import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import { beat, readHeartbeat } from './heartbeat.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

test('the heartbeat is empty until the first beat, then holds the last one', async () => {
  const db = await testDb();
  assert.equal(await readHeartbeat(db), null);
  await beat(db, at(0));
  await beat(db, at(60));
  assert.equal(await readHeartbeat(db), at(60));
  await db.close();
});
