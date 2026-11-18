import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import { recordDelivery } from './deliveries.ts';

test('a delivery id is recorded once; the first call is what is kept', async () => {
  const db = await testDb();
  assert.equal(await recordDelivery(db, { id: 'd-1', name: 'pull_request', action: 'opened', outcome: 'handled', reason: null }), true);
  assert.equal(await recordDelivery(db, { id: 'd-1', name: 'issues', action: null, outcome: 'ignored', reason: 'unknown_event' }), false);
  assert.deepEqual(
    await db.query('select id, name, action, outcome, reason from visto_ai.deliveries'),
    [{ id: 'd-1', name: 'pull_request', action: 'opened', outcome: 'handled', reason: null }]);
  await db.close();
});
