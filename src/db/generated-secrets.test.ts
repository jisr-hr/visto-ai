import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import { storedAuditKey } from './generated-secrets.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const FIRST = 'generated-key-for-tests-only-0123456789abcdef';
const SECOND = 'generated-key-for-tests-only-fedcba9876543210';

const rows = async (db: Awaited<ReturnType<typeof testDb>>) =>
  (await db.query<{ name: string; value: string; created_at: Date }>('select name, value, created_at from visto_ai.generated_secrets'))
    .map((r) => ({ name: r.name, value: r.value, at: r.created_at.toISOString() }));

test('the first call stores the fresh value with its time, and returns it', async () => {
  const db = await testDb();
  assert.equal(await storedAuditKey(db, () => FIRST, at(0)), FIRST);
  assert.deepEqual(await rows(db), [{ name: 'audit_key', value: FIRST, at: at(0) }]);
  await db.close();
});

test('a later call with another fresh value returns the first, and changes nothing', async () => {
  const db = await testDb();
  await storedAuditKey(db, () => FIRST, at(0));
  assert.equal(await storedAuditKey(db, () => SECOND, at(60)), FIRST);
  assert.deepEqual(await rows(db), [{ name: 'audit_key', value: FIRST, at: at(0) }]);
  await db.close();
});
