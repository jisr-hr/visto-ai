import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './testing.ts';
import { addRecords, liveLessons, liveLessonsWithin, liveRecords, liveRecordsWithin, retireExpired, standingLessons } from './memory-records.ts';
import type { NewRecord, RepoKey } from './memory-records.ts';

const REPO: RepoKey = { service: 'github', owner: 'acme', repo: 'shop' };
const T = '2026-03-10T12:00:00.000Z';
const ms = (iso: string, delta: number): string => new Date(Date.parse(iso) + delta).toISOString();
const DAY = 24 * 60 * 60 * 1000;

const record = (over: Partial<NewRecord> = {}): NewRecord => ({
  kind: 'human_signal', sourceRef: '7:h1:src/billing/tax.ts', number: 7,
  path: 'src/billing/tax.ts', directory: 'src/billing',
  category: 'money', reason: 'rounds totals', missed: true,
  excerpt: 'this rounds before the discount', comment: 'c-1',
  createdAt: T, expiresAt: ms(T, 180 * DAY), ...over,
});

test('a record is stored with every field, and a lookup reads back only what it needs', async () => {
  const db = await testDb();
  assert.equal(await addRecords(db, REPO, [record()]), 1);
  const rows = await db.query(
    `select service, owner, repo, kind, source_ref, status, created_at, expires_at, number, path, directory,
            category, reason, missed, excerpt, comment
     from visto_ai.memory_records`);
  assert.deepEqual(rows, [{
    service: 'github', owner: 'acme', repo: 'shop', kind: 'human_signal', source_ref: '7:h1:src/billing/tax.ts',
    status: 'active', created_at: new Date(T), expires_at: new Date(ms(T, 180 * DAY)), number: 7,
    path: 'src/billing/tax.ts', directory: 'src/billing', category: 'money', reason: 'rounds totals', missed: true,
    excerpt: 'this rounds before the discount', comment: 'c-1',
  }]);
  const live = await liveRecords(db, REPO, 'human_signal', ms(T, DAY), 10);
  assert.equal(live.length, 1);
  assert.deepEqual(Object.keys(live[0]!).sort(), ['category', 'createdAt', 'directory', 'id', 'missed', 'number', 'path', 'sourceRef']);
  assert.deepEqual({ ...live[0]!, id: 0 }, {
    id: 0, sourceRef: '7:h1:src/billing/tax.ts', number: 7, path: 'src/billing/tax.ts', directory: 'src/billing',
    category: 'money', missed: true, createdAt: T,
  });
  await db.close();
});

test('a record with no path, category or comment is stored with nulls and an empty excerpt', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [record({ path: null, directory: null, category: null, reason: null, missed: false, excerpt: '', comment: null })]);
  const [row] = await liveRecords(db, REPO, 'human_signal', T, 10);
  assert.deepEqual({ ...row!, id: 0 }, { id: 0, sourceRef: '7:h1:src/billing/tax.ts', number: 7, path: null, directory: null, category: null, missed: false, createdAt: T });
  assert.deepEqual(await db.query('select excerpt, reason, comment from visto_ai.memory_records'), [{ excerpt: '', reason: null, comment: null }]);
  await db.close();
});

test('the same record added twice is stored once, and the first is left as it was', async () => {
  const db = await testDb();
  assert.equal(await addRecords(db, REPO, [record()]), 1);
  assert.equal(await addRecords(db, REPO, [record({ excerpt: 'another text', missed: false })]), 0);
  assert.deepEqual(await db.query('select excerpt, missed from visto_ai.memory_records'), [{ excerpt: 'this rounds before the discount', missed: true }]);
  await db.query("update visto_ai.memory_records set status = 'disabled'");
  assert.equal(await addRecords(db, REPO, [record({ excerpt: 'a third text' })]), 0);
  assert.deepEqual(await db.query('select excerpt, status from visto_ai.memory_records'), [{ excerpt: 'this rounds before the discount', status: 'disabled' }]);
  await db.close();
});

test('one call with the same source reference twice stores it once, and an empty list adds nothing', async () => {
  const db = await testDb();
  assert.equal(await addRecords(db, REPO, [record(), record({ excerpt: 'second' }), record({ sourceRef: '7:file:src/cart/cart.ts' })]), 2);
  assert.equal(await addRecords(db, REPO, []), 0);
  assert.deepEqual(await db.query('select count(*)::int as n from visto_ai.memory_records'), [{ n: 2 }]);
  await db.close();
});

test('the same source reference of another kind or another repository is another record', async () => {
  const db = await testDb();
  assert.equal(await addRecords(db, REPO, [record()]), 1);
  assert.equal(await addRecords(db, REPO, [record({ kind: 'revert' })]), 1);
  assert.equal(await addRecords(db, { ...REPO, repo: 'web' }, [record()]), 1);
  await db.close();
});

test('text Postgres would refuse is stored cleaned', async () => {
  const db = await testDb();
  const NUL = String.fromCharCode(0);
  const HALF = String.fromCharCode(0xd83d);
  await addRecords(db, REPO, [record({ excerpt: `a${NUL}b${HALF}`, reason: `r${NUL}`, path: `src/x${NUL}.ts` })]);
  const [row] = await db.query<{ excerpt: string; reason: string; path: string }>('select excerpt, reason, path from visto_ai.memory_records');
  assert.equal(row!.excerpt, 'ab\ufffd');
  assert.equal(row!.reason, 'r');
  assert.equal(row!.path, 'src/x.ts');
  await db.close();
});

test('a record is live from the time it was made until it expires, whatever a pass has done', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [record()]);
  const at = async (iso: string): Promise<number> => (await liveRecords(db, REPO, 'human_signal', iso, 10)).length;
  assert.equal(await at(ms(T, -1)), 0);
  assert.equal(await at(T), 1);
  assert.equal(await at(ms(T, 180 * DAY - 1)), 1);
  assert.equal(await at(ms(T, 180 * DAY)), 0);
  assert.deepEqual(await db.query('select status from visto_ai.memory_records'), [{ status: 'active' }]);
  await db.close();
});

test('a disabled record and a record of another repository or another kind are not read', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [record({ sourceRef: 'a' }), record({ sourceRef: 'b' }), record({ sourceRef: 'c', kind: 'lesson' })]);
  await addRecords(db, { ...REPO, repo: 'web' }, [record({ sourceRef: 'd' })]);
  await addRecords(db, { ...REPO, owner: 'other' }, [record({ sourceRef: 'e' })]);
  await db.query("update visto_ai.memory_records set status = 'disabled' where source_ref = 'b'");
  assert.deepEqual((await liveRecords(db, REPO, 'human_signal', T, 10)).map((r) => r.sourceRef), ['a']);
  assert.deepEqual((await liveRecords(db, REPO, 'lesson', T, 10)).map((r) => r.sourceRef), ['c']);
  await db.query("update visto_ai.memory_records set status = 'expired' where source_ref = 'a'");
  assert.deepEqual(await liveRecords(db, REPO, 'human_signal', T, 10), []);
  await db.close();
});

test('records are read newest first, and no more than the limit', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [
    record({ sourceRef: 'old', createdAt: ms(T, -2 * DAY) }),
    record({ sourceRef: 'new', createdAt: T }),
    record({ sourceRef: 'mid', createdAt: ms(T, -DAY) }),
  ]);
  const later = ms(T, DAY);
  assert.deepEqual((await liveRecords(db, REPO, 'human_signal', later, 2)).map((r) => r.sourceRef), ['new', 'mid']);
  await addRecords(db, REPO, [record({ sourceRef: 'same-1', createdAt: T })]);
  await addRecords(db, REPO, [record({ sourceRef: 'same-2', createdAt: T })]);
  assert.deepEqual((await liveRecords(db, REPO, 'human_signal', later, 3)).map((r) => r.sourceRef), ['same-2', 'same-1', 'new']);
  await db.close();
});

test('an expired active record is retired, and a disabled one is left as it is', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [
    record({ sourceRef: 'gone', expiresAt: ms(T, DAY) }),
    record({ sourceRef: 'off', expiresAt: ms(T, DAY) }),
    record({ sourceRef: 'kept', expiresAt: ms(T, 3 * DAY) }),
  ]);
  await db.query("update visto_ai.memory_records set status = 'disabled' where source_ref = 'off'");
  assert.equal(await retireExpired(db, ms(T, DAY)), 1);
  assert.deepEqual(await db.query('select source_ref, status from visto_ai.memory_records order by source_ref'), [
    { source_ref: 'gone', status: 'expired' }, { source_ref: 'kept', status: 'active' }, { source_ref: 'off', status: 'disabled' },
  ]);
  assert.equal(await retireExpired(db, ms(T, DAY)), 0);
  await db.close();
});

test('the owner and the name of a repository are compared in lower case', async () => {
  const db = await testDb();
  await addRecords(db, { ...REPO, owner: 'Acme', repo: 'Shop' }, [record()]);
  assert.deepEqual(await db.query('select owner, repo from visto_ai.memory_records'), [{ owner: 'acme', repo: 'shop' }]);
  assert.equal((await liveRecords(db, REPO, 'human_signal', T, 10)).length, 1);
  assert.equal((await liveRecords(db, { ...REPO, owner: 'ACME', repo: 'SHOP' }, 'human_signal', T, 10)).length, 1);
  assert.equal(await addRecords(db, REPO, [record()]), 0);
  await db.close();
});

test('a row whose time cannot be read is passed over, and a record kept for good is read', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [
    record({ sourceRef: 'good-1' }), record({ sourceRef: 'never', createdAt: ms(T, -DAY) }),
    record({ sourceRef: 'minus', createdAt: ms(T, -2 * DAY) }), record({ sourceRef: 'bc', createdAt: ms(T, -3 * DAY) }),
    record({ sourceRef: 'good-2', createdAt: ms(T, -4 * DAY) }),
  ]);
  await db.query("update visto_ai.memory_records set created_at = '-infinity' where source_ref = 'minus'");
  await db.query("update visto_ai.memory_records set created_at = '0044-03-15 BC' where source_ref = 'bc'");
  // what an operator writes to keep a record for good
  await db.query("update visto_ai.memory_records set expires_at = 'infinity' where source_ref = 'never'");
  const rows = await liveRecords(db, REPO, 'human_signal', ms(T, DAY), 10);
  assert.deepEqual(rows.map((r) => r.sourceRef), ['good-1', 'never', 'good-2']);
  assert.equal(rows[1]!.createdAt, ms(T, -DAY));
  // and far in the future still
  assert.deepEqual((await liveRecords(db, REPO, 'human_signal', '2030-01-01T00:00:00.000Z', 10)).map((r) => r.sourceRef), ['never']);
  await db.close();
});

test('the records of the pull request left out take no place in the read', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [
    record({ sourceRef: 'own-1', number: 7, createdAt: T }), record({ sourceRef: 'own-2', number: 7, createdAt: T }),
    record({ sourceRef: 'other-1', number: 8, createdAt: ms(T, -DAY) }), record({ sourceRef: 'other-2', number: 9, createdAt: ms(T, -2 * DAY) }),
  ]);
  const later = ms(T, DAY);
  assert.deepEqual((await liveRecords(db, REPO, 'human_signal', later, 2, 7)).map((r) => r.sourceRef), ['other-1', 'other-2']);
  assert.deepEqual((await liveRecords(db, REPO, 'human_signal', later, 2, 8)).map((r) => r.sourceRef).sort(), ['own-1', 'own-2']);
  // with no number, none is left out
  assert.equal((await liveRecords(db, REPO, 'human_signal', later, 10)).length, 4);
  await db.close();
});

test('a read within a limit sets the limit inside its transaction, and refuses a limit that is no whole number above 0', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [record({ sourceRef: 'own', number: 7 }), record({ sourceRef: 'other', number: 8 })]);
  const setting = async (): Promise<string> => (await db.query<{ setting: string }>("select setting from pg_settings where name = 'statement_timeout'"))[0]!.setting;
  const outside = await setting();
  const seen: string[] = [];
  const watched = {
    ...db,
    query: db.query.bind(db), script: db.script.bind(db), close: db.close.bind(db),
    transaction: <R>(work: (tx: typeof db) => Promise<R>) => db.transaction((tx) => work({
      query: async <Row>(text: string, params?: unknown[]) => {
        const rows = await tx.query<Row>(text, params);
        seen.push((await tx.query<{ setting: string }>("select setting from pg_settings where name = 'statement_timeout'"))[0]!.setting);
        return rows;
      },
      script: (sql: string) => tx.script(sql), close: () => tx.close(), transaction: (w) => tx.transaction(w),
    })),
  };
  const rows = await liveRecordsWithin(watched, REPO, 'human_signal', ms(T, DAY), 10, 1234, 7);
  assert.deepEqual(rows.map((r) => r.sourceRef), ['other']);
  assert.deepEqual(seen, ['1234', '1234']);
  assert.equal(await setting(), outside);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5' as unknown as number, null as unknown as number]) {
    seen.length = 0;
    await assert.rejects(liveRecordsWithin(watched, REPO, 'human_signal', ms(T, DAY), 10, bad, 7), /bad_statement_limit/, String(bad));
    assert.deepEqual(seen, [], String(bad));
  }
  await db.close();
});

const TAX_RULE = 'A rounding helper in billing is meant to round half up, by design.';
const lesson = (over: Partial<NewRecord> = {}): NewRecord => record({
  kind: 'lesson', sourceRef: '7:r-1', category: null, reason: null, missed: false,
  excerpt: 'we round half up on purpose here', comment: 'r-1', lesson: TAX_RULE, expiresAt: ms(T, 90 * DAY), ...over,
});

test('a lesson is stored with its text, and a record added with no lesson key has none', async () => {
  const db = await testDb();
  assert.equal(await addRecords(db, REPO, [lesson(), record()]), 2);
  assert.deepEqual(await db.query('select kind, lesson, excerpt, comment from visto_ai.memory_records order by kind'), [
    { kind: 'human_signal', lesson: null, excerpt: 'this rounds before the discount', comment: 'c-1' },
    { kind: 'lesson', lesson: TAX_RULE, excerpt: 'we round half up on purpose here', comment: 'r-1' },
  ]);
  await db.close();
});

test('the live lessons are read with their text, newest first, and a signal is never read as one', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [
    lesson({ sourceRef: '7:r-1', lesson: 'first rule of the billing module, kept as it is' }),
    lesson({ sourceRef: '7:r-2', createdAt: ms(T, 1000), lesson: 'second rule of the billing module, kept as it is' }),
    lesson({ sourceRef: '7:r-3', createdAt: ms(T, 2000), path: 'src/cart/cart.ts', directory: 'src/cart', lesson: 'third rule of the cart module, kept as it is' }),
    record({ sourceRef: '7:h9', createdAt: ms(T, 3000), lesson: 'a signal that carries a text is still no lesson at all' }),
  ]);
  const rows = await liveLessons(db, REPO, ms(T, DAY), 2);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['createdAt', 'id', 'lesson', 'number', 'path', 'sourceRef']);
  assert.deepEqual(rows.map((r) => ({ ...r, id: 0 })), [
    { id: 0, sourceRef: '7:r-3', number: 7, path: 'src/cart/cart.ts', lesson: 'third rule of the cart module, kept as it is', createdAt: ms(T, 2000) },
    { id: 0, sourceRef: '7:r-2', number: 7, path: 'src/billing/tax.ts', lesson: 'second rule of the billing module, kept as it is', createdAt: ms(T, 1000) },
  ]);
  assert.deepEqual((await liveLessons(db, REPO, ms(T, DAY), 10)).map((r) => r.sourceRef), ['7:r-3', '7:r-2', '7:r-1']);
  await db.close();
});

test('a lesson is live from the time it was made until it expires, and a disabled one, one with no text and one with no path are not read', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [
    lesson(),
    lesson({ sourceRef: '7:r-2' }),
    lesson({ sourceRef: '7:r-3', lesson: null }),
    lesson({ sourceRef: '7:r-4', path: null, directory: null }),
  ]);
  await db.query("update visto_ai.memory_records set status = 'disabled' where source_ref = '7:r-2'");
  assert.deepEqual(await liveLessons(db, REPO, ms(T, -1), 10), []);
  assert.deepEqual((await liveLessons(db, REPO, T, 10)).map((r) => r.sourceRef), ['7:r-1']);
  assert.deepEqual((await liveLessons(db, REPO, ms(T, 90 * DAY - 1), 10)).map((r) => r.sourceRef), ['7:r-1']);
  assert.deepEqual(await liveLessons(db, REPO, ms(T, 90 * DAY), 10), []);
  assert.deepEqual(await db.query("select status from visto_ai.memory_records where source_ref = '7:r-1'"), [{ status: 'active' }]);
  await db.close();
});

test('the lessons of the pull request left out take no place in the read', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [
    lesson({ sourceRef: '8:r-1', number: 8 }),
    lesson({ sourceRef: '7:r-2', createdAt: ms(T, 1000) }),
    lesson({ sourceRef: '7:r-3', createdAt: ms(T, 2000) }),
  ]);
  assert.deepEqual((await liveLessons(db, REPO, ms(T, DAY), 1, 7)).map((r) => r.sourceRef), ['8:r-1']);
  assert.deepEqual((await liveLessons(db, REPO, ms(T, DAY), 1)).map((r) => r.sourceRef), ['7:r-3']);
  await db.close();
});

test('the standing lessons are the active and the disabled ones that have not expired', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [
    lesson({ sourceRef: '7:r-1', lesson: 'the active rule, which still stands for now' }),
    lesson({ sourceRef: '7:r-2', createdAt: ms(T, 1000), lesson: 'the disabled rule, which still stands for now' }),
    lesson({ sourceRef: '7:r-3', createdAt: ms(T, 2000), lesson: 'the rule expired by its status alone' }),
    lesson({ sourceRef: '7:r-4', createdAt: ms(T, 3000), expiresAt: ms(T, DAY), lesson: 'the rule whose expiry is behind' }),
    record({ sourceRef: '7:h1', createdAt: ms(T, 4000), lesson: 'a signal that carries a text is still no lesson at all' }),
  ]);
  await db.query("update visto_ai.memory_records set status = 'disabled' where source_ref = '7:r-2'");
  await db.query("update visto_ai.memory_records set status = 'expired' where source_ref = '7:r-3'");
  assert.deepEqual(await standingLessons(db, REPO, ms(T, 2 * DAY), 10),
    ['the disabled rule, which still stands for now', 'the active rule, which still stands for now']);
  assert.deepEqual(await standingLessons(db, REPO, ms(T, 2 * DAY), 1), ['the disabled rule, which still stands for now']);
  await db.close();
});

test('a read of lessons within a limit sets it inside its transaction, and refuses a limit that is no whole number above 0', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [lesson({ sourceRef: '7:r-1', number: 7 }), lesson({ sourceRef: '8:r-1', number: 8 })]);
  const setting = async (): Promise<string> => (await db.query<{ setting: string }>("select setting from pg_settings where name = 'statement_timeout'"))[0]!.setting;
  const outside = await setting();
  const seen: string[] = [];
  const watched = {
    ...db,
    query: db.query.bind(db), script: db.script.bind(db), close: db.close.bind(db),
    transaction: <R>(work: (tx: typeof db) => Promise<R>) => db.transaction((tx) => work({
      query: async <Row>(text: string, params?: unknown[]) => {
        const rows = await tx.query<Row>(text, params);
        seen.push((await tx.query<{ setting: string }>("select setting from pg_settings where name = 'statement_timeout'"))[0]!.setting);
        return rows;
      },
      script: (sql: string) => tx.script(sql), close: () => tx.close(), transaction: (w) => tx.transaction(w),
    })),
  };
  const rows = await liveLessonsWithin(watched, REPO, ms(T, DAY), 10, 1234, 7);
  assert.deepEqual(rows.map((r) => r.sourceRef), ['8:r-1']);
  assert.deepEqual(seen, ['1234', '1234']);
  assert.equal(await setting(), outside);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5' as unknown as number, null as unknown as number]) {
    seen.length = 0;
    await assert.rejects(liveLessonsWithin(watched, REPO, ms(T, DAY), 10, bad, 7), /bad_statement_limit/, String(bad));
    assert.deepEqual(seen, [], String(bad));
  }
  await db.close();
});
