import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isApplied, loadMigrations, MIGRATIONS_DIR, migrate } from './migrate.ts';
import { pgliteDb } from './pglite.ts';
import { recordRun, spentSince } from './review-runs.ts';
import { testDb } from './testing.ts';
import type { Db } from './types.ts';

const one = { name: '0001_a', sql: 'create table visto_ai.a (n integer);' };
const two = { name: '0002_b', sql: 'create table visto_ai.b (n integer); insert into visto_ai.b values (1);' };

test('migrations apply in name order, once each', async () => {
  const db = await pgliteDb();
  assert.deepEqual(await migrate(db, [two, one]), ['0001_a', '0002_b']);
  assert.deepEqual(await migrate(db, [two, one]), []);
  assert.deepEqual(await db.query('select name from visto_ai.schema_migrations order by name'), [{ name: '0001_a' }, { name: '0002_b' }]);
  await db.close();
});
test('a migration that fails leaves nothing behind', async () => {
  const db = await pgliteDb();
  await migrate(db, []);
  const bad = { name: '0003_c', sql: 'create table visto_ai.c (n integer); select nope();' };
  await assert.rejects(migrate(db, [bad]));
  assert.deepEqual(await db.query("select to_regclass('visto_ai.c')::text as c"), [{ c: null }]);
  assert.deepEqual(await db.query("select name from visto_ai.schema_migrations where name = '0003_c'"), []);
  await db.close();
});
test('a database ahead of the code is refused', async () => {
  const db = await pgliteDb();
  await migrate(db, [one]);
  await assert.rejects(migrate(db, [two]), /unknown_migration_applied/);
  await db.close();
});
test('migrating nothing creates the schema and its ledger', async () => {
  const db = await pgliteDb();
  await migrate(db, []);
  assert.deepEqual(await db.query('select count(*)::int as n from visto_ai.schema_migrations'), [{ n: 0 }]);
  assert.deepEqual(
    await db.query("select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'visto_ai' and table_name = 'schema_migrations' order by column_name"),
    [
      { column_name: 'applied_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'name', data_type: 'text', is_nullable: 'NO' },
    ]);
  assert.deepEqual(await db.query("select count(*)::int as n from pg_constraint where conrelid = 'visto_ai.schema_migrations'::regclass and contype = 'p'"), [{ n: 1 }]);
  await db.close();
});
test('loadMigrations reads the .sql files in name order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'visto-migrations-'));
  try {
    writeFileSync(join(dir, '0002_b.sql'), 'select 2;');
    writeFileSync(join(dir, '0001_a.sql'), 'select 1;');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, '.gitkeep'), '');
    assert.deepEqual(loadMigrations(dir), [{ name: '0001_a', sql: 'select 1;' }, { name: '0002_b', sql: 'select 2;' }]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test('testDb resolves with the ledger in place', async () => {
  const db = await testDb();
  const names = (await db.query<{ name: string }>('select name from visto_ai.schema_migrations')).map((r) => r.name);
  assert.ok(names.includes('0001_receiving'));
  assert.ok(names.includes('0002_jobs'));
  assert.ok(names.includes('0003_publishing'));
  assert.ok(names.includes('0004_scores'));
  assert.ok(names.includes('0005_notes'));
  assert.equal(names.indexOf('0005_notes'), names.indexOf('0004_scores') + 1);
  assert.equal(names.indexOf('0006_publish_tried'), names.indexOf('0005_notes') + 1);
  assert.equal(names.indexOf('0007_score_surroundings'), names.indexOf('0006_publish_tried') + 1);
  assert.equal(names.indexOf('0008_gate'), names.indexOf('0007_score_surroundings') + 1);
  assert.equal(names.indexOf('0009_feedback'), names.indexOf('0008_gate') + 1);
  assert.equal(names.indexOf('0010_memory'), names.indexOf('0009_feedback') + 1);
  await db.close();
});
test('a migration switches the statement timeout off for itself', async () => {
  const db = await pgliteDb();
  const seen: string[] = [];
  const spy: Db = { ...db, transaction: (work) => db.transaction((tx) => work({
    ...tx,
    query: (text, params) => { seen.push(text); return tx.query(text, params); },
    script: (sql) => { seen.push(sql); return tx.script(sql); },
  })) };
  await migrate(spy, [{ name: '0001_x', sql: 'create table visto_ai.x (n integer);' }]);
  assert.equal(seen[0], 'set local statement_timeout = 0');
});
test('a migration that is applied says so, and a database with no ledger says no', async () => {
  const db = await pgliteDb();
  assert.equal(await isApplied(db, '0001_a'), false);
  await migrate(db, [one]);
  assert.equal(await isApplied(db, '0001_a'), true);
  assert.equal(await isApplied(db, '0002_b'), false);
  await db.close();
  const full = await testDb();
  assert.equal(await isApplied(full, '0010_memory'), true);
  await full.close();
});
test('the memory migration applies over rows of the release before it, and leaves them unlearned', async () => {
  const db = await pgliteDb();
  const all = loadMigrations(MIGRATIONS_DIR);
  await migrate(db, all.filter((m) => m.name < '0010_memory'));
  await db.query(
    `insert into visto_ai.pull_requests (service, owner, repo, number, author, author_is_bot, base_branch, head_branch, head_sha, draft, state, updated_at)
     values ('github', 'acme', 'shop', 7, 'octo-dev', false, 'main', 'feature', 'aaa111', false, 'closed', '2026-03-01T10:00:00Z')`);
  await db.query(
    `insert into visto_ai.human_activity (service, owner, repo, number, kind, source_id, author, body, at)
     values ('github', 'acme', 'shop', 7, 'inline_comment', 'c-1', 'octo-lead', 'check this', '2026-03-01T10:00:00Z')`);
  assert.deepEqual(await migrate(db, all.filter((m) => m.name <= '0010_memory')), ['0010_memory']);
  assert.deepEqual(await db.query('select learned_at, learn_attempts from visto_ai.pull_requests'), [{ learned_at: null, learn_attempts: 0 }]);
  assert.deepEqual(await db.query('select learned_at, body from visto_ai.human_activity'), [{ learned_at: null, body: 'check this' }]);
  assert.deepEqual(await db.query('select count(*)::int as n from visto_ai.memory_records'), [{ n: 0 }]);
  assert.deepEqual(await db.query('select count(*)::int as n from visto_ai.learning'), [{ n: 0 }]);
  await db.close();
});
test('0011_lessons comes right after 0010_memory, and applies over the rows of the release before it', async () => {
  const ledger = await testDb();
  const names = (await ledger.query<{ name: string }>('select name from visto_ai.schema_migrations order by name')).map((r) => r.name);
  assert.equal(names.indexOf('0011_lessons'), names.indexOf('0010_memory') + 1);
  await ledger.close();
  const db = await pgliteDb();
  const all = loadMigrations(MIGRATIONS_DIR);
  await migrate(db, all.filter((m) => m.name < '0011_lessons'));
  await db.query(
    `insert into visto_ai.memory_records (service, owner, repo, kind, source_ref, created_at, expires_at, number, path, directory, excerpt)
     values ('github', 'acme', 'shop', 'human_signal', '7:h1:src/billing/tax.ts', '2026-03-01T10:00:00Z', '2026-08-28T10:00:00Z', 7,
             'src/billing/tax.ts', 'src/billing', 'check this')`);
  await recordRun(db, {
    ref: { service: 'github', owner: 'acme', repo: 'shop', number: 7 }, job: null, trigger: 'automatic', mode: 'full', dryRun: true,
    headSha: 'h1', baseSha: 'b1', baseBranch: 'main', outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
    body: 'text', comments: [], result: { findings: [] },
    usage: { calls: 1, inputTokens: 1000, outputTokens: 200, cachedTokens: 0, cost: 0.5 },
    startedAt: '2026-03-01T10:00:00.000Z', finishedAt: '2026-03-01T10:01:00.000Z',
  });
  assert.deepEqual(await migrate(db, all.filter((m) => m.name <= '0011_lessons')), ['0011_lessons']);
  assert.deepEqual(await db.query('select source_ref, lesson from visto_ai.memory_records'), [{ source_ref: '7:h1:src/billing/tax.ts', lesson: null }]);
  assert.equal(await spentSince(db, '2026-03-01T00:00:00.000Z'), 0.5);
  assert.deepEqual(await db.query('select count(*)::int as n from visto_ai.reply_verdicts'), [{ n: 0 }]);
  assert.deepEqual(await db.query('select count(*)::int as n from visto_ai.judge_calls'), [{ n: 0 }]);
  await db.close();
});
test('a verdict\'s classification is one of five, in lower case, a reply has one row, and its attempts start at 0', async () => {
  const db = await testDb();
  const insert = (reply: string, classification: string | null, owner = 'acme'): Promise<unknown> => db.query(
    `insert into visto_ai.reply_verdicts (service, owner, repo, number, reply, finding, classification, outcome, judged_at)
     values ('github', $1, 'shop', 7, $2, 'c-1', $3, 'none', '2026-03-02T10:00:00Z')`, [owner, reply, classification]);
  await assert.rejects(insert('r-1', 'praise'));
  await assert.rejects(insert('r-1', 'Noise'));
  for (const c of ['confirmed_fix', 'valid_pushback', 'invalid_pushback', 'question', 'noise']) await insert(`r-${c}`, c);
  await insert('r-null', null);
  await assert.rejects(insert('r-null', 'noise', 'octo'));
  assert.deepEqual(await db.query("select attempts from visto_ai.reply_verdicts where reply = 'r-null'"), [{ attempts: 0 }]);
  assert.deepEqual(await db.query('select count(*)::int as n from visto_ai.reply_verdicts'), [{ n: 6 }]);
  await db.close();
});
test('0012_reverts comes right after 0011_lessons, and applies over the rows of the release before it', async () => {
  const ledger = await testDb();
  const names = (await ledger.query<{ name: string }>('select name from visto_ai.schema_migrations order by name')).map((r) => r.name);
  assert.equal(names.indexOf('0012_reverts'), names.indexOf('0011_lessons') + 1);
  await ledger.close();
  const db = await pgliteDb();
  const all = loadMigrations(MIGRATIONS_DIR);
  await migrate(db, all.filter((m) => m.name <= '0011_lessons'));
  await db.query(
    `insert into visto_ai.pull_requests (service, owner, repo, number, author, author_is_bot, base_branch, head_branch, head_sha, draft, state,
                                         merged_at, closed_at, merge_commit, updated_at)
     values ('github', 'acme', 'shop', 7, 'octo-dev', false, 'main', 'feature', 'aaa111', false, 'merged',
             '2026-03-05T09:00:00Z', '2026-03-05T09:00:00Z', 'fff999', '2026-03-05T09:00:00Z')`);
  await db.query(
    `insert into visto_ai.memory_records (service, owner, repo, kind, source_ref, created_at, expires_at, number, path, directory, excerpt)
     values ('github', 'acme', 'shop', 'human_signal', '7:h1:src/billing/tax.ts', '2026-03-01T10:00:00Z', '2026-08-28T10:00:00Z', 7,
             'src/billing/tax.ts', 'src/billing', 'check this')`);
  const prs = 'select number, state, merged_at, merge_commit from visto_ai.pull_requests';
  const records = 'select source_ref, kind, number, path, directory, excerpt, lesson from visto_ai.memory_records';
  const before = [await db.query(prs), await db.query(records)];
  assert.deepEqual(await migrate(db, all.filter((m) => m.name <= '0012_reverts')), ['0012_reverts']);
  assert.deepEqual([await db.query(prs), await db.query(records)], before);
  assert.deepEqual(await db.query('select reverts from visto_ai.pull_requests'), [{ reverts: null }]);
  assert.deepEqual(await db.query('select reverted from visto_ai.memory_records'), [{ reverted: null }]);
  assert.deepEqual(
    await db.query("select data_type, is_nullable from information_schema.columns where table_schema = 'visto_ai' and table_name = 'pull_requests' and column_name = 'reverts'"),
    [{ data_type: 'integer', is_nullable: 'YES' }]);
  await db.close();
});
test('0013_approval comes right after 0012_reverts, and applies over the rows of the release before it', async () => {
  const ledger = await testDb();
  const names = (await ledger.query<{ name: string }>('select name from visto_ai.schema_migrations order by name')).map((r) => r.name);
  assert.equal(names.indexOf('0013_approval'), names.indexOf('0012_reverts') + 1);
  await ledger.close();
  const db = await pgliteDb();
  const all = loadMigrations(MIGRATIONS_DIR);
  await migrate(db, all.filter((m) => m.name <= '0012_reverts'));
  const id = await recordRun(db, {
    ref: { service: 'github', owner: 'acme', repo: 'shop', number: 7 }, job: null, trigger: 'automatic', mode: 'full', dryRun: false,
    headSha: 'h1', baseSha: 'merge000', baseBranch: 'main', outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
    body: 'text', comments: [], result: { findings: [] },
    usage: { calls: 1, inputTokens: 1000, outputTokens: 200, cachedTokens: 0, cost: 0.5 },
    startedAt: '2026-03-01T10:00:00.000Z', finishedAt: '2026-03-01T10:01:00.000Z',
  });
  await db.query(
    `update visto_ai.review_runs set published = true, review_id = '501', published_at = '2026-03-01T10:01:30Z', inline_dropped = false
     where id = $1`, [id]);
  const before = await db.query('select * from visto_ai.review_runs');
  assert.deepEqual(await migrate(db, all.filter((m) => m.name <= '0013_approval')), ['0013_approval']);
  const added = ['approved', 'approval_code', 'dismissed_at', 'dismissed_by', 'dismiss_failure', 'stood_at_merge'];
  const after = await db.query('select * from visto_ai.review_runs');
  assert.deepEqual(after.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !added.includes(k)))), before);
  assert.deepEqual(
    await db.query(`select ${added.join(', ')} from visto_ai.review_runs`),
    [{ approved: false, approval_code: null, dismissed_at: null, dismissed_by: null, dismiss_failure: null, stood_at_merge: null }]);
  assert.deepEqual(
    await db.query(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'visto_ai' and table_name = 'review_runs' and column_name = any($1::text[]) order by column_name`, [added]),
    [
      { column_name: 'approval_code', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'approved', data_type: 'boolean', is_nullable: 'NO' },
      { column_name: 'dismiss_failure', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'dismissed_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'dismissed_by', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'stood_at_merge', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ]);
  assert.deepEqual(
    await db.query("select indexname from pg_indexes where schemaname = 'visto_ai' and indexname = 'review_runs_standing'"),
    [{ indexname: 'review_runs_standing' }]);
  await db.close();
});
