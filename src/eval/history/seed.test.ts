import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { recordActivity } from '../../db/human-activity.ts';
import { pullRequestsToLearn } from '../../db/learning.ts';
import { addRecords } from '../../db/memory-records.ts';
import { loadMigrations, MIGRATIONS_DIR, migrate } from '../../db/migrate.ts';
import { pgliteDb } from '../../db/pglite.ts';
import { savePullRequest } from '../../db/pull-requests.ts';
import { testDb } from '../../db/testing.ts';
import type { Db } from '../../db/types.ts';
import type { PullRequestFacts, PullRequestRef } from '../../forge/types.ts';
import { learnOnce } from '../../shell/learning.ts';
import { historyMemory } from '../backtest/memory.ts';
import type { HistoryActivity, HistoryCase } from './file.ts';
import { seedCommand, seedMemory } from './seed.ts';

const TAX = 'src/billing/tax.ts';
const CART = 'src/cart/cart.ts';
const NOW = new Date('2026-03-20T08:00:00.000Z');
const LATER = new Date('2026-03-21T08:00:00.000Z');
const M7 = '2026-03-05T12:00:00.000Z';
const M8 = '2026-03-12T12:00:00.000Z';
const DAY_MS = 24 * 3_600_000;
const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
const refOf = (number: number): PullRequestRef => ({ service: 'github', owner: 'acme', repo: 'shop', number });

const inline = (id: string, path: string, at: string, over: Partial<HistoryActivity> = {}): HistoryActivity => ({
  kind: 'inline', id, author: 'octo-lead', bot: false, association: 'member', at, body: 'Check the rounding here.',
  commit: 'c0ffee000000', path, side: 'RIGHT', line: 12, start_line: 10, file_level: false, reply_to: null, ...over,
});
const review = (id: string, at: string, over: Partial<HistoryActivity> = {}): HistoryActivity => ({
  kind: 'review', id, author: 'octo-lead', bot: false, association: 'member', at, body: 'Looks fine.', state: 'approved', commit: 'c0ffee000000', ...over,
});
const general = (id: string, at: string, over: Partial<HistoryActivity> = {}): HistoryActivity => ({
  kind: 'comment', id, author: 'octo-guest', bot: false, association: 'none', at, body: 'When does this ship?', ...over,
});

function mkCase(pr: number, files: string[], mergedAt: string, activity: HistoryActivity[], over: Partial<HistoryCase> = {}): HistoryCase {
  return {
    version: 1, repo: 'acme/shop', pr_number: pr, title: 'Change things', body: 'Changes things.', author: 'octo-dev', branch: 'topic',
    base_branch: 'main', merged_at: mergedAt, review_head: `head${pr}`.padEnd(12, '0'), review_base: 'base0000',
    review_at: mergedAt, reviewed_by_person: true, final_head: 'final000', final_base: 'base0000',
    final_files: files.map((path) => ({ path, previous_path: null, status: 'modified' as const, patch: '@@ -1,1 +1,2 @@\n a\n+b' })),
    activity, ...over,
  };
}

const case7 = (): HistoryCase => mkCase(7, [TAX], M7, [
  review('r7', '2026-03-04T09:00:00.000Z'),
  inline('i7', TAX, '2026-03-04T10:00:00.000Z'),
  general('g7', '2026-03-04T11:00:00.000Z'),
]);
const case8 = (): HistoryCase => mkCase(8, [CART], M8, [
  inline('i8', CART, '2026-03-11T10:00:00.000Z', { side: 'LEFT', line: 4, start_line: null, file_level: true, commit: null }),
  inline('i8b', CART, '2026-03-11T10:05:00.000Z', { reply_to: 'i8', body: 'Agreed.' }),
]);

const facts = (number: number, over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref: refOf(number), author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feature', headSha: 'c1',
  draft: false, state: 'closed', mergedAt: null, closedAt: '2026-03-06T12:00:00.000Z', mergeCommit: null, installation: '55',
  updatedAt: '2026-03-06T12:00:00.000Z', ...over,
});

interface ActivityRow {
  number: number; kind: string; source_id: string; author: string; association: string | null; state: string | null; body: string;
  path: string | null; side: string | null; line: number | null; start_line: number | null; file_level: boolean | null;
  commit: string | null; reply_to: string | null; thread: string | null; delivery: string | null; at: Date; learned_at: Date | null;
}
const activityRows = async (db: Db): Promise<ActivityRow[]> => db.query<ActivityRow>(
  `select number, kind, source_id, author, association, state, body, path, side, line, start_line, file_level,
          commit, reply_to, thread, delivery, at, learned_at
   from visto_ai.human_activity order by number, at, source_id`);
interface RecordRow {
  owner: string; repo: string; kind: string; source_ref: string; status: string; number: number; path: string | null; directory: string | null;
  category: string | null; reason: string | null; missed: boolean; excerpt: string; comment: string | null; created_at: Date; expires_at: Date;
}
const recordRows = async (db: Db): Promise<RecordRow[]> => db.query<RecordRow>(
  `select owner, repo, kind, source_ref, status, number, path, directory, category, reason, missed, excerpt, comment, created_at, expires_at
   from visto_ai.memory_records order by number, source_ref`);
const count = async (db: Db, table: string): Promise<number> =>
  (await db.query<{ n: number }>(`select count(*)::int as n from visto_ai.${table}`))[0]!.n;

/** Every row of every table of the schema, as text, in a fixed order. */
async function snapshot(db: Db): Promise<Record<string, string[]>> {
  const tables = await db.query<{ t: string }>(
    "select table_name as t from information_schema.tables where table_schema = 'visto_ai' and table_type = 'BASE TABLE' order by 1");
  const out: Record<string, string[]> = {};
  for (const { t } of tables) {
    out[t] = (await db.query<{ j: string }>(`select to_jsonb(x)::text as j from visto_ai.${t} x order by 1`)).map((r) => r.j);
  }
  return out;
}

/** A Db that passes everything to `db`, with some of it replaced. */
function wrap(db: Db, over: Partial<Db>): Db {
  return {
    query: <R,>(text: string, params?: unknown[]) => db.query<R>(text, params),
    script: (sql) => db.script(sql),
    transaction: <T,>(work: (tx: Db) => Promise<T>) => db.transaction(work),
    close: () => db.close(),
    ...over,
  };
}

test('a history file seeds the activity and the signals of its pull requests, dated by their merge', async () => {
  const db = await testDb();
  const seeded = await seedMemory(db, [case7(), case8()], NOW);
  assert.deepEqual(seeded, { cases: 2, known: 0, activity: 5, signals: 2 });

  const rows = await activityRows(db);
  assert.deepEqual(rows.map((r) => [r.number, r.kind, r.source_id, r.author, r.association]), [
    [7, 'review', 'r7', 'octo-lead', 'member'],
    [7, 'inline_comment', 'i7', 'octo-lead', 'member'],
    [7, 'general_comment', 'g7', 'octo-guest', 'none'],
    [8, 'inline_comment', 'i8', 'octo-lead', 'member'],
    [8, 'inline_comment', 'i8b', 'octo-lead', 'member'],
  ]);
  const byId = new Map(rows.map((r) => [r.source_id, r]));
  assert.deepEqual(byId.get('r7'), {
    number: 7, kind: 'review', source_id: 'r7', author: 'octo-lead', association: 'member', state: 'approved', body: 'Looks fine.',
    path: null, side: null, line: null, start_line: null, file_level: null, commit: 'c0ffee000000', reply_to: null, thread: null,
    delivery: null, at: new Date('2026-03-04T09:00:00.000Z'), learned_at: null,
  });
  assert.deepEqual(byId.get('i7'), {
    number: 7, kind: 'inline_comment', source_id: 'i7', author: 'octo-lead', association: 'member', state: null, body: 'Check the rounding here.',
    path: TAX, side: 'RIGHT', line: 12, start_line: 10, file_level: false, commit: 'c0ffee000000', reply_to: null, thread: null,
    delivery: null, at: new Date('2026-03-04T10:00:00.000Z'), learned_at: NOW,
  });
  assert.deepEqual(byId.get('g7'), {
    number: 7, kind: 'general_comment', source_id: 'g7', author: 'octo-guest', association: 'none', state: null, body: 'When does this ship?',
    path: null, side: null, line: null, start_line: null, file_level: null, commit: null, reply_to: null, thread: null,
    delivery: null, at: new Date('2026-03-04T11:00:00.000Z'), learned_at: null,
  });
  assert.deepEqual([byId.get('i8')!.side, byId.get('i8')!.line, byId.get('i8')!.start_line, byId.get('i8')!.file_level, byId.get('i8')!.commit], ['LEFT', 4, null, true, null]);
  assert.equal(byId.get('i8b')!.reply_to, 'i8');

  assert.deepEqual(await recordRows(db), [
    {
      owner: 'acme', repo: 'shop', kind: 'human_signal', source_ref: `7:file:${TAX}`, status: 'active', number: 7, path: TAX, directory: 'src/billing',
      category: null, reason: null, missed: false, excerpt: 'Check the rounding here.', comment: 'i7',
      created_at: new Date(M7), expires_at: new Date(plus(M7, 180 * DAY_MS)),
    },
    {
      owner: 'acme', repo: 'shop', kind: 'human_signal', source_ref: `8:file:${CART}`, status: 'active', number: 8, path: CART, directory: 'src/cart',
      category: null, reason: null, missed: false, excerpt: 'Check the rounding here.', comment: 'i8',
      created_at: new Date(M8), expires_at: new Date(plus(M8, 180 * DAY_MS)),
    },
  ]);
  assert.equal(await count(db, 'pull_requests'), 0);
  await db.close();
});

test('the seed makes the signals the backtest\'s memory makes from the same file', async () => {
  const db = await testDb();
  const late = mkCase(9, [TAX, CART], '2026-03-30T12:00:00.000Z', []);
  const cases = [case7(), case8(), late];
  await seedMemory(db, cases, NOW);
  const lines = (await historyMemory(cases).of(late).blocks(
    [{ path: TAX, previousPath: null }, { path: CART, previousPath: null }], new Date(late.review_at), new AbortController().signal)).pullRequest;
  const seeded = await recordRows(db);
  assert.deepEqual(
    lines.map((l) => [l.ref, l.day, l.path, l.category, l.missed]).sort(),
    seeded.map((r) => [r.source_ref, r.created_at.toISOString().slice(0, 10), r.path, r.category, r.missed]).sort());
  assert.equal(lines.length, 2);
  await db.close();
});

test('seeding twice adds nothing the second time', async () => {
  const db = await testDb();
  const cases = [case7(), case8()];
  const first = await seedMemory(db, cases, NOW);
  assert.ok(first.activity > 0 && first.signals > 0);
  const before = await snapshot(db);
  const second = await seedMemory(db, cases, LATER);
  assert.deepEqual(second, { cases: 2, known: 0, activity: 0, signals: 0 });
  assert.deepEqual(await snapshot(db), before);
  await db.close();
});

test('what the live service captured is never overwritten', async () => {
  const db = await testDb();
  // A comment the service captured under the same id, with another text; a record already stored under the same source reference, then disabled.
  assert.equal(await recordActivity(db, {
    ref: refOf(7), kind: 'inline_comment', sourceId: 'i7', author: 'octo-lead', association: 'member', state: null, body: 'captured text',
    path: TAX, side: 'RIGHT', line: 3, startLine: null, fileLevel: false, commit: 'c1', replyTo: null, thread: null,
    at: '2026-03-04T10:00:00.000Z', delivery: 'd-1',
  }), true);
  assert.equal(await addRecords(db, { service: 'github', owner: 'acme', repo: 'shop' }, [{
    kind: 'human_signal', sourceRef: `7:file:${TAX}`, number: 7, path: TAX, directory: 'src/billing', category: 'money', reason: 'kept reason',
    missed: true, excerpt: 'kept excerpt', comment: 'i7', createdAt: '2026-03-06T00:00:00.000Z', expiresAt: '2026-09-02T00:00:00.000Z',
  }]), 1);
  await db.query("update visto_ai.memory_records set status = 'disabled'");
  // A pull request the service stores, and another it stores that the file does not hold.
  assert.equal(await savePullRequest(db, facts(8)), true);
  assert.equal(await savePullRequest(db, facts(11)), true);
  await db.query('update visto_ai.pull_requests set learn_attempts = 2, learned_at = $1 where number = 11', ['2026-03-06T12:00:00.000Z']);
  const pullRequests = (await snapshot(db)).pull_requests;
  const records = await recordRows(db);

  const seeded = await seedMemory(db, [case7(), case8()], NOW);
  assert.deepEqual(seeded, { cases: 2, known: 1, activity: 4, signals: 0 });
  const captured = (await activityRows(db)).find((r) => r.source_id === 'i7')!;
  assert.deepEqual([captured.body, captured.line, captured.commit, captured.delivery], ['captured text', 3, 'c1', 'd-1']);
  assert.deepEqual(await recordRows(db), records);
  assert.equal(records[0]!.status, 'disabled');
  assert.equal(records[0]!.excerpt, 'kept excerpt');
  assert.deepEqual((await snapshot(db)).pull_requests, pullRequests);
  await db.close();
});

test('a pull request the service stores gets its missing comments and no signal from the file, and the pass then makes it', async () => {
  const db = await testDb();
  assert.equal(await savePullRequest(db, facts(7)), true);
  const seeded = await seedMemory(db, [case7()], NOW);
  assert.deepEqual(seeded, { cases: 1, known: 1, activity: 3, signals: 0 });
  assert.deepEqual((await activityRows(db)).map((r) => [r.source_id, r.learned_at]), [['r7', null], ['i7', null], ['g7', null]]);
  assert.equal(await count(db, 'memory_records'), 0);
  assert.deepEqual((await pullRequestsToLearn(db, 10, null, 3)).map((p) => p.ref.number), [7]);

  const learned = await learnOnce({ db, clock: () => LATER });
  assert.equal(learned.added, 1);
  assert.deepEqual((await recordRows(db)).map((r) => [r.source_ref, r.comment, r.created_at.toISOString()]), [
    [`7:file:${TAX}`, 'i7', '2026-03-06T12:00:00.000Z'],
  ]);
  await db.close();
});

test('a seeded pull request\'s comments are marked, so the pass makes nothing of them again', async () => {
  const db = await testDb();
  await seedMemory(db, [case7(), case8()], NOW);
  assert.deepEqual((await activityRows(db)).filter((r) => r.kind === 'inline_comment').map((r) => [r.source_id, r.learned_at]),
    [['i7', NOW], ['i8', NOW], ['i8b', NOW]]);
  // The service stores the pull requests later, open: only an inline comment not looked at would make them work.
  assert.equal(await savePullRequest(db, facts(7, { state: 'open', closedAt: null })), true);
  assert.equal(await savePullRequest(db, facts(8, { state: 'open', closedAt: null })), true);
  assert.deepEqual(await pullRequestsToLearn(db, 10, null, 3), []);
  const before = await recordRows(db);
  const learned = await learnOnce({ db, clock: () => LATER });
  assert.equal(learned.added, 0);
  assert.equal(learned.examined, 0);
  assert.deepEqual(await recordRows(db), before);
  await db.close();
});

test('the activity of bots is not stored, and it still keeps a reply in a bot\'s thread from counting', async () => {
  const db = await testDb();
  const bot = { author: 'ci-bot', bot: true, association: 'none' as const };
  const withBots = (pr: number): HistoryCase => mkCase(pr, [TAX], M7, [
    review(`r${pr}`, '2026-03-04T08:00:00.000Z', bot),
    inline(`b${pr}`, TAX, '2026-03-04T09:00:00.000Z', bot),
    inline(`x${pr}`, TAX, '2026-03-04T10:00:00.000Z', { reply_to: `b${pr}` }),
    general(`g${pr}`, '2026-03-04T11:00:00.000Z', bot),
  ]);
  // 7: not stored by the service, so its signals come from the file; 8: stored, so the pass makes them.
  assert.equal(await savePullRequest(db, facts(8)), true);
  const seeded = await seedMemory(db, [withBots(7), withBots(8)], NOW);
  assert.deepEqual(seeded, { cases: 2, known: 1, activity: 2, signals: 0 });
  assert.deepEqual((await activityRows(db)).map((r) => [r.number, r.source_id, r.author]), [[7, 'x7', 'octo-lead'], [8, 'x8', 'octo-lead']]);
  const learned = await learnOnce({ db, clock: () => LATER });
  assert.equal(learned.added, 0);
  assert.equal(await count(db, 'memory_records'), 0);
  await db.close();
});

test('a seeded excerpt leaves out a quoted line', async () => {
  const db = await testDb();
  const c = mkCase(7, [TAX], M7, [inline('i7', TAX, '2026-03-04T10:00:00.000Z', { body: '> a stranger\'s words\n\nyes' })]);
  assert.equal((await seedMemory(db, [c], NOW)).signals, 1);
  assert.deepEqual((await recordRows(db)).map((r) => r.excerpt), ['yes']);
  await db.close();
});

test('a case with a repository that is not owner/name stops the seed with a short code', async () => {
  for (const repo of ['shop', 'acme/shop/extra', '/shop', 'acme/', 'acme shop/x']) {
    const db = await testDb();
    const bad = { ...case8(), repo };
    await assert.rejects(seedMemory(db, [case7(), bad, mkCase(9, [TAX], M8, [inline('i9', TAX, '2026-03-11T10:00:00.000Z')])], NOW), { message: 'bad_case_repo' }, repo);
    // The case before it stays; nothing of it or after it is written.
    assert.deepEqual([...new Set((await activityRows(db)).map((r) => r.number))], [7], repo);
    assert.deepEqual((await recordRows(db)).map((r) => r.number), [7], repo);
    await db.close();
  }
});

test('one case is one transaction: a case that fails leaves nothing of itself, and the cases before it stay', async () => {
  const db = await testDb();
  // Case 8's transaction rejects at its last statement, after its activity was written.
  const failing = wrap(db, {
    transaction: <T,>(work: (tx: Db) => Promise<T>) => db.transaction((tx) => work(wrap(tx, {
      query: async <R,>(text: string, params?: unknown[]) => {
        if (text.includes('memory_records') && JSON.stringify(params ?? []).includes('"number\\":8')) throw new Error('injected');
        return tx.query<R>(text, params);
      },
    }))),
  });
  await assert.rejects(seedMemory(failing, [case7(), case8()], NOW), { message: 'injected' });
  assert.deepEqual([...new Set((await activityRows(db)).map((r) => r.number))], [7]);
  assert.deepEqual((await recordRows(db)).map((r) => r.number), [7]);
  // Run again without the failure: case 8 is written whole, and case 7 adds nothing.
  assert.deepEqual(await seedMemory(db, [case7(), case8()], NOW), { cases: 2, known: 0, activity: 2, signals: 1 });
  await db.close();
});

test('the seed reads a case\'s comments with the backtest\'s own mapping, and holds no copy of it', () => {
  const text = readFileSync(new URL('./seed.ts', import.meta.url), 'utf8');
  assert.match(text, /import \{[^}]*\bpersonComments\b[^}]*\} from '\.\.\/backtest\/memory\.ts';/);
  assert.equal(/function personComment\b/.test(text), false);
  assert.equal(/start_line \?\? null/.test(text.slice(text.indexOf('function seedCase'))), false);
});

test('a database the seed\'s migration is not applied to is refused before any write', async () => {
  const db = await testDb();
  // Removing the one ledger row stands in for a database that was never migrated to 0011_lessons.
  await db.query("delete from visto_ai.schema_migrations where name = '0011_lessons'");
  const before = await snapshot(db);
  await assert.rejects(seedCommand(db, [case7(), case8()], NOW), { message: 'database_not_migrated' });
  assert.deepEqual(await snapshot(db), before);
  await db.close();
});

test('the command prints the four counts in their order', async () => {
  const db = await testDb();
  assert.equal(await savePullRequest(db, facts(8)), true);
  const case9 = mkCase(9, [TAX], M8, [inline('i9', TAX, '2026-03-11T10:00:00.000Z')]);
  assert.equal(await seedCommand(db, [case7(), case8(), case9], NOW), 'cases 3, known 1, activity 6, signals 2');
  await db.close();
});

/** A case that cannot be stored stops the seed with its code: the case before it stays, nothing of it or after it is written. */
async function refused(bad: HistoryCase, code: string, name: string): Promise<void> {
  const db = await testDb();
  const after = mkCase(9, [TAX], M8, [inline('i9', TAX, '2026-03-11T10:00:00.000Z')]);
  await assert.rejects(seedMemory(db, [case7(), bad, after], NOW), { message: code }, name);
  const dump = await snapshot(db);
  const mentions = (n: number) => [...dump.human_activity!, ...dump.memory_records!].filter((j) => (JSON.parse(j) as { number: number }).number === n).length;
  assert.equal(mentions(7) > 0, true, name);
  assert.equal(mentions(bad.pr_number), 0, name);
  assert.equal(mentions(9), 0, name);
  assert.deepEqual(dump.pull_requests, [], name);
  await db.close();
}

test('a case with a number that cannot be stored stops the seed with a short code', async () => {
  for (const n of [0, -8, 1.5, 2_147_483_648, Number.NaN]) await refused({ ...case8(), pr_number: n }, 'bad_case_number', String(n));
  // The largest number that can be stored is seeded.
  const db = await testDb();
  assert.equal((await seedMemory(db, [{ ...case8(), pr_number: 2_147_483_647 }], NOW)).signals, 1);
  await db.close();
});

test('a case with a merge or an activity time that cannot be read stops the seed with a short code', async () => {
  const at = (value: string, index: number): HistoryCase => {
    const c = case8();
    return { ...c, activity: c.activity.map((a, i) => (i === index ? { ...a, at: value } : a)) };
  };
  const bad: [string, HistoryCase][] = [
    ['merged_at not a time', { ...case8(), merged_at: 'yesterday' }],
    ['merged_at with no zone', { ...case8(), merged_at: '2026-03-12T12:00:00' }],
    ['merged_at in the year 0', { ...case8(), merged_at: '0000-03-12T12:00:00Z' }],
    ['first activity not a time', at('soon', 0)],
    ['second activity on a day that does not exist', at('2026-02-30T10:00:00Z', 1)],
    ['an activity in the year 0', at('0000-03-11T10:00:00Z', 1)],
    ['a bot\'s activity not a time', { ...case8(), activity: [...case8().activity, inline('b8', CART, 'later', { author: 'ci-bot', bot: true, association: 'none' })] }],
  ];
  for (const [name, c] of bad) await refused(c, 'bad_case_time', name);
});

test('a case with an inline line or start line that cannot be stored stops the seed with a short code', async () => {
  const lineOf = (over: Partial<HistoryActivity>): HistoryCase => {
    const c = case8();
    return { ...c, activity: c.activity.map((a, i) => (i === 1 ? { ...a, ...over } : a)) };
  };
  await refused(lineOf({ line: 2_147_483_648 }), 'bad_case_number', 'line');
  await refused(lineOf({ start_line: 2_147_483_648 }), 'bad_case_number', 'start_line');
  await refused(lineOf({ line: -2_147_483_649 }), 'bad_case_number', 'line below');
  // The largest line that can be stored is stored.
  const db = await testDb();
  await seedMemory(db, [lineOf({ line: 2_147_483_647, start_line: 2_147_483_647 })], NOW);
  const stored = (await activityRows(db)).find((r) => r.source_id === 'i8b')!;
  assert.equal(stored.line, 2_147_483_647);
  assert.equal(stored.start_line, 2_147_483_647);
  await db.close();
  // And the smallest.
  const low = await testDb();
  await seedMemory(low, [lineOf({ line: -2_147_483_648 })], NOW);
  assert.equal((await activityRows(low)).find((r) => r.source_id === 'i8b')!.line, -2_147_483_648);
  await low.close();
});

test('a database migrated to 0010_memory and no further is refused by the seed before any write', async () => {
  const db = await pgliteDb();
  await migrate(db, loadMigrations(MIGRATIONS_DIR).filter((m) => m.name <= '0010_memory'));
  const before = await snapshot(db);
  await assert.rejects(seedCommand(db, [case7(), case8()], NOW), { message: 'database_not_migrated' });
  assert.deepEqual(await snapshot(db), before);
  assert.deepEqual(Object.entries(before).filter(([t, rows]) => t !== 'schema_migrations' && rows.length > 0), []);
  await db.close();
});
