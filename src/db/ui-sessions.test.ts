import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import type { Db } from './types.ts';
import { createSession, deleteExpired, deleteSession, liveStates, readSession, saveState, takeState } from './ui-sessions.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const lastUsed = async (db: Db, idHash: string): Promise<string | undefined> =>
  (await db.query<{ last_used_at: Date }>('select last_used_at from visto_ai.ui_sessions where id_hash = $1', [idHash]))[0]?.last_used_at.toISOString();
const count = async (db: Db, table: 'ui_sessions' | 'ui_states'): Promise<number> =>
  (await db.query<{ n: number }>(`select count(*)::int as n from visto_ai.${table}`))[0]!.n;

test('a session is read with its way in while it has not expired, and its use is written when the stored one is 60 seconds old or more', async () => {
  const db = await testDb();
  await createSession(db, { idHash: 'h-a', login: 'octo-lead', via: 'account', at: at(0), expiresAt: at(43200) });
  assert.deepEqual(
    (await db.query<{ created_at: Date; last_used_at: Date; expires_at: Date }>('select created_at, last_used_at, expires_at from visto_ai.ui_sessions'))
      .map((r) => [r.created_at.toISOString(), r.last_used_at.toISOString(), r.expires_at.toISOString()]),
    [[at(0), at(0), at(43200)]]);
  assert.deepEqual(await readSession(db, 'h-a', at(30)), { login: 'octo-lead', via: 'account' });
  assert.equal(await lastUsed(db, 'h-a'), at(0));
  assert.deepEqual(await readSession(db, 'h-a', at(59)), { login: 'octo-lead', via: 'account' });
  assert.equal(await lastUsed(db, 'h-a'), at(0));
  assert.deepEqual(await readSession(db, 'h-a', at(60)), { login: 'octo-lead', via: 'account' });
  assert.equal(await lastUsed(db, 'h-a'), at(60));
  assert.deepEqual(await readSession(db, 'h-a', at(119)), { login: 'octo-lead', via: 'account' });
  assert.equal(await lastUsed(db, 'h-a'), at(60));

  await createSession(db, { idHash: 'h-b', login: 'octo-dev', via: 'acme/reviewers', at: at(0), expiresAt: at(43200) });
  assert.deepEqual(await readSession(db, 'h-b', at(30)), { login: 'octo-dev', via: 'acme/reviewers' });
  assert.equal(await readSession(db, 'h-c', at(30)), null);
  await db.close();
});
test('a session read at a clock gone back writes no last use', async () => {
  const db = await testDb();
  await createSession(db, { idHash: 'h-a', login: 'octo-lead', via: 'account', at: at(120), expiresAt: at(43320) });
  assert.deepEqual(await readSession(db, 'h-a', at(30)), { login: 'octo-lead', via: 'account' });
  assert.equal(await lastUsed(db, 'h-a'), at(120));
  assert.deepEqual(await readSession(db, 'h-a', at(-3600)), { login: 'octo-lead', via: 'account' });
  assert.equal(await lastUsed(db, 'h-a'), at(120));
  await db.close();
});
test('a deleted or expired session is not read', async () => {
  const db = await testDb();
  await createSession(db, { idHash: 'h-a', login: 'octo-lead', via: 'account', at: at(0), expiresAt: at(43200) });
  assert.deepEqual(await readSession(db, 'h-a', at(43199)), { login: 'octo-lead', via: 'account' });
  assert.equal(await readSession(db, 'h-a', at(43200)), null);
  assert.equal(await lastUsed(db, 'h-a'), at(43199));

  await createSession(db, { idHash: 'h-b', login: 'octo-lead', via: 'account', at: at(0), expiresAt: at(43200) });
  assert.equal(await deleteSession(db, 'h-b'), true);
  assert.equal(await deleteSession(db, 'h-b'), false);
  assert.equal(await readSession(db, 'h-b', at(10)), null);
  await db.close();
});
test('a state is taken once with its verifier hash, and an expired one is taken but answers null', async () => {
  const db = await testDb();
  await saveState(db, { stateHash: 'h-s', verifierHash: 'h-v', expiresAt: at(600) });
  assert.deepEqual(await takeState(db, 'h-s', at(10)), { verifierHash: 'h-v' });
  assert.equal(await takeState(db, 'h-s', at(10)), null);
  await saveState(db, { stateHash: 'h-s2', verifierHash: 'h-v2', expiresAt: at(600) });
  assert.equal(await takeState(db, 'h-s2', at(600)), null);
  assert.equal(await count(db, 'ui_states'), 0);
  assert.equal(await takeState(db, 'h-none', at(10)), null);
  await db.close();
});
test('a state asked for at a time that cannot be read rejects, and is not taken', async () => {
  const db = await testDb();
  await saveState(db, { stateHash: 'h-s', verifierHash: 'h-v', expiresAt: at(600) });
  for (const now of ['not a time', '']) await assert.rejects(takeState(db, 'h-s', now), /^Error: bad_time$/, now);
  assert.equal(await count(db, 'ui_states'), 1);
  assert.deepEqual(await takeState(db, 'h-s', at(10)), { verifierHash: 'h-v' });
  await db.close();
});
test('live states are counted, and expired sessions and states are deleted while the rest stays', async () => {
  const db = await testDb();
  await saveState(db, { stateHash: 'h-s1', verifierHash: 'h-v1', expiresAt: at(10) });
  await saveState(db, { stateHash: 'h-s2', verifierHash: 'h-v2', expiresAt: at(600) });
  await saveState(db, { stateHash: 'h-s3', verifierHash: 'h-v3', expiresAt: at(600) });
  assert.equal(await liveStates(db, at(9)), 3);
  assert.equal(await liveStates(db, at(10)), 2);
  await createSession(db, { idHash: 'h-a', login: 'octo-lead', via: 'account', at: at(0), expiresAt: at(5) });
  await createSession(db, { idHash: 'h-b', login: 'octo-lead', via: 'account', at: at(0), expiresAt: at(10) });
  await createSession(db, { idHash: 'h-c', login: 'octo-lead', via: 'account', at: at(0), expiresAt: at(43200) });
  await createSession(db, { idHash: 'h-d', login: 'octo-dev', via: 'acme/reviewers', at: at(0), expiresAt: at(43200) });
  assert.equal(await deleteExpired(db, at(10)), 3);
  assert.deepEqual(await readSession(db, 'h-c', at(10)), { login: 'octo-lead', via: 'account' });
  assert.deepEqual(await readSession(db, 'h-d', at(10)), { login: 'octo-dev', via: 'acme/reviewers' });
  assert.equal(await liveStates(db, at(10)), 2);
  assert.deepEqual([await count(db, 'ui_sessions'), await count(db, 'ui_states')], [2, 2]);
  assert.equal(await deleteExpired(db, at(10)), 0);
  await db.close();
});
