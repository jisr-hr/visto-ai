import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { addRecords } from '../db/memory-records.ts';
import type { NewRecord, RepoKey } from '../db/memory-records.ts';
import { MEMORY_TIMEOUT_MS, REVERTED_LINE_RULES } from '../engine/context/memory.ts';
import { review } from '../engine/review.ts';
import { SUBMIT_REVIEW } from '../engine/model/submit-review.ts';
import type { Memory, ModelClient, ModelRequest, ModelResponse, ReviewInput, ReviewResult } from '../engine/types.ts';
import type { Source } from '../forge/types.ts';
import { LESSONS_READ } from '../memory/lessons.ts';
import { RECORDS_READ, REVERTS_READ } from '../memory/select.ts';
import { recordsMemory } from './memory.ts';
import { createMemoryHealth } from './memory-health.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const REPO: RepoKey = { service: 'github', owner: 'acme', repo: 'shop' };
const AS_OF = new Date('2026-03-12T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const TAX = { path: 'src/billing/tax.ts', previousPath: null };
const signal = new AbortController().signal;
const later = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/** A signal of pull request 8 on src/billing/tax.ts, made on 3 March, a miss of the kind calculation. */
const record = (over: Partial<NewRecord> = {}): NewRecord => {
  const createdAt = over.createdAt ?? '2026-03-03T09:00:00.000Z';
  return {
    kind: 'human_signal', sourceRef: '8:file:src/billing/tax.ts', number: 8,
    path: 'src/billing/tax.ts', directory: 'src/billing',
    category: 'calculation', reason: 'rounds the totals', missed: true,
    excerpt: 'please check the rounding here', comment: 'c-81',
    createdAt, expiresAt: later(createdAt, 180 * DAY), ...over,
  };
};

let db: Db;
beforeEach(async () => { db = await testDb(); });
afterEach(async () => { await db.close(); });

test('a record on a changed file reaches the blocks as a line', async () => {
  await addRecords(db, REPO, [record()]);
  const blocks = await recordsMemory(db, REF).blocks([TAX], AS_OF, signal);
  assert.deepEqual(blocks.pullRequest, [{ ref: '8:file:src/billing/tax.ts', near: false, path: 'src/billing/tax.ts', day: '2026-03-03', category: 'calculation', missed: true }]);
  assert.deepEqual(Object.keys(blocks.pullRequest[0]!).sort(), ['category', 'day', 'missed', 'near', 'path', 'ref']);
  // one pull request is under the lists' minimum
  assert.deepEqual(blocks.repository, { directories: [], categories: [] });
});

test('a pull request is never shown a record made from itself', async () => {
  await addRecords(db, REPO, [
    record({ sourceRef: '7:h7:src/billing/tax.ts', number: 7, comment: 'c-71' }),
    record({ createdAt: '2026-03-04T09:00:00.000Z' }),
    record({ sourceRef: '9:file:src/billing/rates.ts', number: 9, path: 'src/billing/rates.ts', comment: 'c-91', createdAt: '2026-03-05T09:00:00.000Z' }),
  ]);
  const of7 = await recordsMemory(db, REF).blocks([TAX], AS_OF, signal);
  assert.deepEqual(of7.pullRequest.map((l) => l.ref), ['8:file:src/billing/tax.ts']);
  // 8 and 9, not 7
  assert.deepEqual(of7.repository, { directories: [{ name: 'src/billing', pullRequests: 2 }], categories: [{ name: 'calculation', pullRequests: 2 }] });
  const of8 = await recordsMemory(db, { ...REF, number: 8 }).blocks([TAX], AS_OF, signal);
  assert.deepEqual(of8.pullRequest.map((l) => l.ref), ['7:h7:src/billing/tax.ts']);
  // 7 and 9, not 8
  assert.deepEqual(of8.repository, { directories: [{ name: 'src/billing', pullRequests: 2 }], categories: [{ name: 'calculation', pullRequests: 2 }] });
});

test('a disabled record, an expired one and one made after the as-of time are in no block', async () => {
  await addRecords(db, REPO, [
    record({ sourceRef: 'kept', number: 8 }),
    record({ sourceRef: 'off', number: 9 }),
    record({ sourceRef: 'gone', number: 10 }),
    record({ sourceRef: 'soon', number: 11 }),
  ]);
  await db.query("update visto_ai.memory_records set status = 'disabled' where source_ref = 'off'");
  // expired the day before, and not yet retired by a pass: it is still active
  await db.query("update visto_ai.memory_records set expires_at = '2026-03-11T12:00:00.000Z' where source_ref = 'gone'");
  await db.query("update visto_ai.memory_records set created_at = '2026-03-12T10:00:00.001Z' where source_ref = 'soon'");
  const blocks = await recordsMemory(db, REF).blocks([TAX], AS_OF, signal);
  assert.deepEqual(blocks.pullRequest.map((l) => l.ref), ['kept']);
  assert.deepEqual(blocks.repository, { directories: [], categories: [] });
  // the same records at a time all four were live
  await db.query("update visto_ai.memory_records set status = 'active'");
  const before = await recordsMemory(db, REF).blocks([TAX], new Date('2026-03-12T11:00:00.000Z'), signal);
  assert.deepEqual(before.pullRequest.map((l) => l.ref).sort(), ['kept', 'off', 'soon']);
});

test('another repository\'s records are never read', async () => {
  await addRecords(db, { service: 'github', owner: 'acme', repo: 'shop-admin' }, [record()]);
  await addRecords(db, { service: 'github', owner: 'acme-labs', repo: 'shop' }, [record({ number: 9, sourceRef: '9:file:src/billing/tax.ts' })]);
  const blocks = await recordsMemory(db, REF).blocks([TAX], AS_OF, signal);
  assert.deepEqual(blocks, { repository: { directories: [], categories: [] }, pullRequest: [], cut: { directories: 0, categories: 0, lines: 0, names: 0, records: false } });
  // and the repository's own are
  await addRecords(db, REPO, [record()]);
  assert.equal((await recordsMemory(db, REF).blocks([TAX], AS_OF, signal)).pullRequest.length, 1);
});

test('a row with no path or no directory is passed over, and nothing else of a row is dropped', async () => {
  await addRecords(db, REPO, [
    record({ sourceRef: 'no-path', number: 9, path: null }),
    record({ sourceRef: 'no-dir', number: 10, directory: null }),
    record({ sourceRef: 'plain', number: 11, category: null, missed: false }),
    record({ sourceRef: 'odd', number: 12, category: 'not_a_category', createdAt: '2026-03-02T09:00:00.000Z' }),
  ]);
  const blocks = await recordsMemory(db, REF).blocks([TAX], AS_OF, signal);
  assert.deepEqual(blocks.pullRequest, [
    { ref: 'plain', near: false, path: 'src/billing/tax.ts', day: '2026-03-03', category: null, missed: false },
    { ref: 'odd', near: false, path: 'src/billing/tax.ts', day: '2026-03-02', category: 'not_a_category', missed: true },
  ]);
  // the two rows read are 11 and 12: their directory is listed, an unknown category is not
  assert.deepEqual(blocks.repository, { directories: [{ name: 'src/billing', pullRequests: 2 }], categories: [] });
});

/** The database, with every statement seen: inside a transaction or not, and the statement limit in force right after it. */
function watched(inner: Db) {
  const seen: Array<{ text: string; params: unknown[] | undefined; inTransaction: boolean; limit: string | null }> = [];
  const setting = async (on: Db): Promise<string> => (await on.query<{ setting: string }>("select setting from pg_settings where name = 'statement_timeout'"))[0]!.setting;
  const wrapped: Db = {
    query: async (text, params) => { seen.push({ text, params, inTransaction: false, limit: null }); return inner.query(text, params); },
    script: (sql) => inner.script(sql),
    close: () => inner.close(),
    transaction: (work) => inner.transaction((tx) => work({
      query: async <Row>(text: string, params?: unknown[]) => {
        const rows = await tx.query<Row>(text, params);
        seen.push({ text, params, inTransaction: true, limit: await setting(tx) });
        return rows;
      },
      script: (sql) => tx.script(sql),
      close: () => tx.close(),
      transaction: (w) => tx.transaction(w),
    })),
  };
  return { wrapped, seen, setting };
}

test('each read sets its own statement limit inside its transaction, and the limit ends with it', async () => {
  await addRecords(db, REPO, [record()]);
  const { wrapped, seen, setting } = watched(db);
  const outside = await setting(db);
  assert.notEqual(outside, String(MEMORY_TIMEOUT_MS));
  const blocks = await recordsMemory(wrapped, REF).blocks([TAX], AS_OF, signal);
  assert.equal(blocks.pullRequest.length, 1);
  // three reads: the signals and the reverts as of the time, then the signals as of the start of its day; each is the limit, then the lookup, in one transaction
  assert.equal(seen.length, 6);
  assert.ok(seen.every((s) => s.inTransaction));
  for (const [i, at] of [[0, '2026-03-12T10:00:00.000Z'], [4, '2026-03-12T00:00:00.000Z']] as const) {
    assert.match(seen[i]!.text, /^set local statement_timeout = \d+$/);
    assert.equal(seen[i]!.params, undefined);
    assert.equal(seen[i]!.limit, String(MEMORY_TIMEOUT_MS));
    assert.match(seen[i + 1]!.text, /from visto_ai\.memory_records/);
    // the pull request's own records are left out by the statement
    assert.deepEqual(seen[i + 1]!.params, ['github', 'acme', 'shop', 'human_signal', at, RECORDS_READ + 1, 7]);
  }
  assert.match(seen[2]!.text, /^set local statement_timeout = \d+$/);
  assert.equal(seen[2]!.limit, String(MEMORY_TIMEOUT_MS));
  assert.match(seen[3]!.text, /kind = 'revert'/);
  assert.deepEqual(seen[3]!.params, ['github', 'acme', 'shop', '2026-03-12T10:00:00.000Z', REVERTS_READ + 1, 7]);
  // after the transaction the limit is what it was
  assert.equal(await setting(db), outside);
});

test('a read that fails rejects, and leaves no limit behind', async () => {
  const outside = await db.query('show statement_timeout');
  const failing: Db = {
    query: (text, params) => db.query(text, params),
    script: (sql) => db.script(sql),
    close: () => db.close(),
    transaction: (work) => db.transaction((tx) => work({
      query: async <Row>(text: string, params?: unknown[]) => {
        if (text.includes('memory_records')) throw new Error('db_down');
        return tx.query<Row>(text, params);
      },
      script: (sql) => tx.script(sql),
      close: () => tx.close(),
      transaction: (w) => tx.transaction(w),
    })),
  };
  await assert.rejects(recordsMemory(failing, REF).blocks([TAX], AS_OF, signal), /db_down/);
  assert.deepEqual(await db.query('show statement_timeout'), outside);
});

/** The real review of pull request 7 (or `number`) over these changed files, with a stub source and a stub model, given this memory; every request the model got. */
async function reviewWith(memory: Memory, files: string[], number: number = REF.number): Promise<{ result: ReviewResult; requests: ModelRequest[] }> {
  const source: Source = {
    listFiles: () => Promise.resolve(files.map((path) => ({ path, previousPath: null, status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1,1 +1,2 @@\n head\n+const a = 1;' }))),
    getFileContent: () => Promise.resolve(null),
    getDefaultBranchFile: () => Promise.resolve(null),
  };
  const requests: ModelRequest[] = [];
  const model: ModelClient = {
    complete: (request): Promise<ModelResponse> => {
      requests.push(structuredClone(request));
      return Promise.resolve({
        toolName: SUBMIT_REVIEW, toolArguments: JSON.stringify({ overview: 'Fine.', findings: [], files: [] }), text: null, model: 'm', provider: null,
        usage: { calls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0.1 },
      });
    },
  };
  const input: ReviewInput = {
    pullRequest: { ref: { ...REF, number }, title: 'Add things', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'feat', baseSha: 'merge000', headSha: 'h1', draft: false },
    trigger: 'automatic', repoConfig: { primaryBranches: ['main'], scoreThreshold: 70 },
    limits: { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 30 }, asOf: AS_OF, earlier: null,
  };
  const result = await review(input, { source, model, contract: 'You review pull requests.', clock: () => AS_OF, token: () => 'abcdef0123456789', log: () => {}, memory });
  return { result, requests };
}

// Sentences of their own: none of their words is in the contract, the rules of memory, the diff or a path.
const WRITTEN = [
  'Gargoyles knit turquoise hammocks.',
  'Velvet comets bake cinnamon pretzels.',
  'Platypus orchestras rehearse lullabies.',
  'Kangaroo librarians catalogue thunderstorms.',
];

test('nothing a person wrote reaches the model through memory', async () => {
  await addRecords(db, REPO, [
    record({ excerpt: WRITTEN[0]!, reason: WRITTEN[1]! }),
    record({ sourceRef: '9:file:src/billing/rates.ts', number: 9, path: 'src/billing/rates.ts', excerpt: WRITTEN[2]!, reason: WRITTEN[3]!, comment: 'c-91', createdAt: '2026-03-05T09:00:00.000Z' }),
  ]);
  const files = ['src/billing/tax.ts', 'src/billing/fees.ts'];
  const { result: r, requests } = await reviewWith(recordsMemory(db, REF), files);
  assert.deepEqual(r.dependencies.memory, { status: 'ok', code: 'ok', lines: 2, lessons: { status: 'empty', code: 'no_lessons', shown: 0 } });
  assert.ok(requests.length >= 1);
  const sent = requests.map((request) => JSON.stringify(request));
  const stored = await db.query<{ excerpt: string; reason: string | null; path: string }>('select excerpt, reason, path from visto_ai.memory_records');
  assert.equal(stored.length, 2);
  for (const row of stored) {
    for (const text of sent) {
      assert.equal(text.includes(row.excerpt), false, row.excerpt);
      assert.equal(text.includes(row.reason!), false, row.reason!);
      // the record's place is shown
      assert.equal(text.includes(row.path), true, row.path);
    }
  }
  // and no word of what was written, wherever it would stand
  const paths = [...files, ...stored.map((row) => row.path)].join(' ').toLowerCase();
  const words = WRITTEN.flatMap((sentence) => sentence.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => !paths.includes(word));
  assert.equal(words.length, 17);
  for (const text of sent.map((t) => t.toLowerCase())) {
    for (const word of words) assert.equal(text.includes(word), false, word);
  }
});

/** `count` records of other pull requests on src/cart, made one second apart going back from `newest`, in one statement. */
const others = (count: number, newest: string, first: number): Promise<unknown> => db.query(
  `insert into visto_ai.memory_records (service, owner, repo, kind, source_ref, created_at, expires_at, number, path, directory, missed, excerpt)
   select 'github', 'acme', 'shop', 'human_signal', 'cart-' || n, $1::timestamptz - n * interval '1 second', $1::timestamptz + interval '180 days',
          n, 'src/cart/c' || n || '.ts', 'src/cart', false, ''
   from generate_series($2::integer, $2::integer + $3::integer - 1) as n`,
  [newest, first, count]);

test('the pull request\'s own records take no place in the read, and records left out are said to be', async () => {
  // the newest: five of pull request 7; then 4,996 of others; then the three oldest, on the changed file
  await addRecords(db, REPO, [1, 2, 3, 4, 5].map((n) => record({ sourceRef: `7:own:${n}`, number: 7, path: 'src/cart/own.ts', directory: 'src/cart', createdAt: '2026-03-11T00:00:00.000Z' })));
  await others(4_996, '2026-03-10T00:00:00.000Z', 100);
  const tax = [8, 9, 10].map((n) => record({ sourceRef: `${n}:file:src/billing/tax.ts`, number: n, createdAt: `2026-02-0${n - 7}T00:00:00.000Z` }));
  await addRecords(db, REPO, tax);
  const blocks = await recordsMemory(db, REF).blocks([TAX], AS_OF, signal);
  assert.deepEqual(blocks.pullRequest.map((l) => l.ref), ['10:file:src/billing/tax.ts', '9:file:src/billing/tax.ts', '8:file:src/billing/tax.ts']);
  assert.equal(blocks.cut.records, false);
  // two more of others, older than all: 5,001 live records of other pull requests, and the answer says some were left out
  await others(2, '2026-01-01T00:00:00.000Z', 6_000);
  const more = await recordsMemory(db, REF).blocks([TAX], AS_OF, signal);
  assert.equal(more.pullRequest.length, 3);
  assert.equal(more.cut.records, true);
});

test('a record whose time cannot be read is passed over, and the review still has its memory', async () => {
  await addRecords(db, REPO, [
    record(), record({ sourceRef: 'minus', number: 9 }), record({ sourceRef: 'bc', number: 10 }), record({ sourceRef: 'never', number: 11, createdAt: '2026-03-02T09:00:00.000Z' }),
  ]);
  await db.query("update visto_ai.memory_records set created_at = '-infinity' where source_ref = 'minus'");
  await db.query("update visto_ai.memory_records set created_at = '0044-03-15 BC' where source_ref = 'bc'");
  await db.query("update visto_ai.memory_records set expires_at = 'infinity' where source_ref = 'never'");
  const blocks = await recordsMemory(db, REF).blocks([TAX], AS_OF, signal);
  assert.deepEqual(blocks.pullRequest.map((l) => l.ref), ['8:file:src/billing/tax.ts', 'never']);
  const alerts: unknown[][] = [];
  const health = createMemoryHealth((code, details) => { alerts.push([code, details]); });
  const r = await reviewWith(recordsMemory(db, REF), [TAX.path]);
  assert.deepEqual(r.result.dependencies.memory, { status: 'ok', code: 'ok', lines: 2, lessons: { status: 'empty', code: 'no_lessons', shown: 0 } });
  health.noted(r.result.dependencies.memory!.status !== 'error', r.result.dependencies.memory!.code);
  assert.deepEqual(alerts, []);
});

test('a live record of another kind on the changed file is in no block', async () => {
  await addRecords(db, REPO, [record(), record({ sourceRef: 'lesson-1', number: 9 }), record({ sourceRef: 'revert-1', number: 10 })]);
  await db.query("update visto_ai.memory_records set kind = 'lesson' where source_ref = 'lesson-1'");
  await db.query("update visto_ai.memory_records set kind = 'revert' where source_ref = 'revert-1'");
  const blocks = await recordsMemory(db, REF).blocks([TAX], AS_OF, signal);
  assert.deepEqual(blocks.pullRequest.map((l) => l.ref), ['8:file:src/billing/tax.ts']);
  assert.deepEqual(blocks.repository, { directories: [], categories: [] });
});

const OF_8 = { ...REF, number: 8 };
const RULE = 'Tax totals are rounded once by the ledger service, so a missing rounding call in this module is no defect.';

/** A lesson of pull request 7 on src/billing/tax.ts, made from reply r-71, live from 4 March for 90 days. */
const lessonRecord = (over: Partial<NewRecord> = {}): NewRecord => {
  const createdAt = over.createdAt ?? '2026-03-04T00:00:00.000Z';
  return {
    kind: 'lesson', sourceRef: '7:r-71', number: 7,
    path: 'src/billing/tax.ts', directory: 'src/billing',
    category: null, reason: null, missed: false,
    excerpt: 'the ledger already rounds every total before it is stored', comment: 'r-71',
    createdAt, expiresAt: later(createdAt, 90 * DAY), lesson: RULE, ...over,
  };
};

test('a lesson of another pull request on a changed file reaches a review as a lesson', async () => {
  await addRecords(db, REPO, [lessonRecord()]);
  const taught = await recordsMemory(db, OF_8).lessons!([TAX], AS_OF, signal);
  assert.deepEqual(taught, {
    lessons: [{ ref: '7:r-71', why: 'file', path: 'src/billing/tax.ts', day: '2026-03-04', text: RULE }],
    cut: { lessons: 0, names: 0, records: false },
  });
  assert.deepEqual(Object.keys(taught.lessons[0]!).sort(), ['day', 'path', 'ref', 'text', 'why']);
});

test('a pull request is never shown a lesson made from itself', async () => {
  await addRecords(db, REPO, [lessonRecord()]);
  const of7 = await recordsMemory(db, REF).lessons!([TAX], AS_OF, signal);
  assert.deepEqual(of7, { lessons: [], cut: { lessons: 0, names: 0, records: false } });
  const of8 = await recordsMemory(db, OF_8).lessons!([TAX], AS_OF, signal);
  assert.deepEqual(of8.lessons.map((l) => l.ref), ['7:r-71']);
});

test('a disabled lesson, an expired one and one dated after the as-of time are never shown', async () => {
  await addRecords(db, REPO, [
    lessonRecord({ sourceRef: 'kept', comment: 'r-1' }),
    lessonRecord({ sourceRef: 'off', comment: 'r-2' }),
    lessonRecord({ sourceRef: 'gone', comment: 'r-3' }),
    lessonRecord({ sourceRef: 'soon', comment: 'r-4' }),
  ]);
  await db.query("update visto_ai.memory_records set status = 'disabled' where source_ref = 'off'");
  // expired the day before, and not yet retired by a pass: it is still active
  await db.query("update visto_ai.memory_records set expires_at = '2026-03-11T12:00:00.000Z' where source_ref = 'gone'");
  await db.query("update visto_ai.memory_records set created_at = '2026-03-12T10:00:00.001Z' where source_ref = 'soon'");
  const taught = await recordsMemory(db, OF_8).lessons!([TAX], AS_OF, signal);
  assert.deepEqual(taught.lessons.map((l) => l.ref), ['kept']);
  // the same lessons at a time all four were live, once the switched-off one is switched on again
  await db.query("update visto_ai.memory_records set status = 'active'");
  const before = await recordsMemory(db, OF_8).lessons!([TAX], new Date('2026-03-11T11:00:00.000Z'), signal);
  assert.deepEqual(before.lessons.map((l) => l.ref).sort(), ['gone', 'kept', 'off']);
  const after = await recordsMemory(db, OF_8).lessons!([TAX], new Date('2026-03-12T11:00:00.000Z'), signal);
  assert.deepEqual(after.lessons.map((l) => l.ref).sort(), ['kept', 'off', 'soon']);
});

test('another repository\'s lessons are never read, and a signal is never shown as a lesson', async () => {
  await addRecords(db, { service: 'github', owner: 'acme', repo: 'shop-admin' }, [lessonRecord()]);
  await addRecords(db, { service: 'github', owner: 'acme-labs', repo: 'shop' }, [lessonRecord({ sourceRef: '9:r-91', number: 9, comment: 'r-91' })]);
  // a signal of pull request 9 on the changed file, whose excerpt would pass as a lesson's text
  await addRecords(db, REPO, [record({ sourceRef: '9:file:src/billing/tax.ts', number: 9, excerpt: RULE })]);
  const memory = recordsMemory(db, OF_8);
  assert.deepEqual(await memory.lessons!([TAX], AS_OF, signal), { lessons: [], cut: { lessons: 0, names: 0, records: false } });
  assert.deepEqual((await memory.blocks([TAX], AS_OF, signal)).pullRequest.map((l) => l.ref), ['9:file:src/billing/tax.ts']);
  // and the repository's own are
  await addRecords(db, REPO, [lessonRecord()]);
  assert.deepEqual((await recordsMemory(db, OF_8).lessons!([TAX], AS_OF, signal)).lessons.map((l) => l.ref), ['7:r-71']);
});

test('the read of lessons sets its own statement limit inside its transaction', async () => {
  await addRecords(db, REPO, [lessonRecord()]);
  const { wrapped, seen, setting } = watched(db);
  const outside = await setting(db);
  assert.notEqual(outside, String(MEMORY_TIMEOUT_MS));
  const taught = await recordsMemory(wrapped, OF_8).lessons!([TAX], AS_OF, signal);
  assert.equal(taught.lessons.length, 1);
  // one read: the limit, then the lookup, in one transaction
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s.inTransaction));
  assert.match(seen[0]!.text, /^set local statement_timeout = \d+$/);
  assert.equal(seen[0]!.params, undefined);
  assert.equal(seen[0]!.limit, String(MEMORY_TIMEOUT_MS));
  assert.match(seen[1]!.text, /from visto_ai\.memory_records/);
  assert.match(seen[1]!.text, /kind = 'lesson'/);
  // the pull request's own lessons are left out by the statement
  assert.deepEqual(seen[1]!.params, ['github', 'acme', 'shop', '2026-03-12T10:00:00.000Z', LESSONS_READ + 1, 8]);
  // after the transaction the limit is what it was
  assert.equal(await setting(db), outside);
});

test('a lesson reaches the model between markers, and the reply\'s words never do', async () => {
  const QUOTE = 'Narwhals juggle saffron accordions every afternoon.';
  await addRecords(db, REPO, [
    lessonRecord({ excerpt: QUOTE }),
    record({ sourceRef: '9:file:src/billing/rates.ts', number: 9, path: 'src/billing/rates.ts', excerpt: WRITTEN[0]!, reason: WRITTEN[1]!, comment: 'c-91' }),
  ]);
  const { result: r, requests } = await reviewWith(recordsMemory(db, OF_8), ['src/billing/fees.ts'], 8);
  assert.equal(r.dependencies.memory?.lessons?.status, 'ok');
  assert.deepEqual(r.dependencies.memory?.lessons, { status: 'ok', code: 'ok', shown: 1 });
  assert.ok(requests.length >= 1);
  const wrapped = `<<<data abcdef0123456789 lesson L1>>>\n${RULE}\n<<<end abcdef0123456789>>>`;
  for (const request of requests) {
    const all = request.messages.map((m) => m.content).join('\n');
    // the lesson's text once, between a start and an end marker with the review's token
    assert.equal(all.split(RULE).length, 2);
    const header = request.messages.filter((m) => m.content.includes(RULE));
    assert.equal(header.length, 1);
    assert.equal(header[0]!.content.includes(wrapped), true);
  }
  const stored = await db.query<{ excerpt: string }>('select excerpt from visto_ai.memory_records');
  assert.equal(stored.length, 2);
  for (const text of requests.map((request) => JSON.stringify(request))) {
    for (const row of stored) assert.equal(text.includes(row.excerpt), false, row.excerpt);
  }
});

/** A revert by pull request 9 of pull request 6, on src/billing/tax.ts, made on 10 March, live for 180 days. */
const revertRecord = (over: Partial<NewRecord> = {}): NewRecord => {
  const createdAt = over.createdAt ?? '2026-03-10T09:00:00.000Z';
  return {
    kind: 'revert', sourceRef: '9:reverts:6:src/billing/tax.ts', number: 9, reverted: 6,
    path: 'src/billing/tax.ts', directory: 'src/billing',
    category: null, reason: null, missed: false, excerpt: '', comment: null,
    createdAt, expiresAt: later(createdAt, 180 * DAY), ...over,
  };
};
const REVERTED = { ref: '9:reverts:6:src/billing/tax.ts', near: false, path: 'src/billing/tax.ts', day: '2026-03-10', category: null, missed: false, reverted: true };

test('a revert of another pull request on a changed file reaches the blocks as a reverted line, after the signals\' lines', async () => {
  await addRecords(db, REPO, [revertRecord()]);
  const alone = await recordsMemory(db, REF).blocks([TAX], AS_OF, signal);
  assert.deepEqual(alone.pullRequest, [REVERTED]);
  // with the file's signal of 3 March: the signal's line first though it is older, then the revert
  await addRecords(db, REPO, [record()]);
  const both = await recordsMemory(db, REF).blocks([TAX], AS_OF, signal);
  assert.deepEqual(both.pullRequest, [
    { ref: '8:file:src/billing/tax.ts', near: false, path: 'src/billing/tax.ts', day: '2026-03-03', category: 'calculation', missed: true },
    REVERTED,
  ]);
  assert.equal('reverted' in both.pullRequest[0]!, false);
});

test('a pull request is shown neither the revert it made nor its own revert', async () => {
  await addRecords(db, REPO, [revertRecord()]);
  for (const number of [9, 6]) {
    const { wrapped, seen } = watched(db);
    const blocks = await recordsMemory(wrapped, { ...REF, number }).blocks([TAX], AS_OF, signal);
    assert.deepEqual(blocks.pullRequest, [], String(number));
    const read = seen.find((s) => /kind = 'revert'/.test(s.text));
    assert.equal(read!.params!.at(-1), number);
  }
  const of8 = await recordsMemory(db, OF_8).blocks([TAX], AS_OF, signal);
  assert.deepEqual(of8.pullRequest, [REVERTED]);
});

test('a disabled revert, an expired one and one made after the as-of time are in no block', async () => {
  const cases: Array<[string, string]> = [
    ['off', "update visto_ai.memory_records set status = 'disabled'"],
    // expired the day before, and not yet retired by a pass: it is still active
    ['gone', "update visto_ai.memory_records set expires_at = '2026-03-11T12:00:00.000Z'"],
    ['soon', "update visto_ai.memory_records set created_at = '2026-03-12T10:00:00.001Z'"],
  ];
  for (const [name, change] of cases) {
    await db.query('delete from visto_ai.memory_records');
    await addRecords(db, REPO, [revertRecord()]);
    await db.query(change);
    assert.deepEqual((await recordsMemory(db, REF).blocks([TAX], AS_OF, signal)).pullRequest, [], name);
  }
  // the same record, active and live
  await db.query('delete from visto_ai.memory_records');
  await addRecords(db, REPO, [revertRecord()]);
  assert.deepEqual((await recordsMemory(db, REF).blocks([TAX], AS_OF, signal)).pullRequest, [REVERTED]);
});

test('another repository\'s reverts are never read', async () => {
  await addRecords(db, { service: 'github', owner: 'acme', repo: 'other' }, [revertRecord()]);
  const blocks = await recordsMemory(db, REF).blocks([TAX], AS_OF, signal);
  assert.deepEqual(blocks, { repository: { directories: [], categories: [] }, pullRequest: [], cut: { directories: 0, categories: 0, lines: 0, names: 0, records: false } });
  // and the repository's own are
  await addRecords(db, REPO, [revertRecord()]);
  assert.deepEqual((await recordsMemory(db, REF).blocks([TAX], AS_OF, signal)).pullRequest, [REVERTED]);
});

test('a reverted line reaches the model with its rule, and nothing of either pull request but a path and a day', async () => {
  await addRecords(db, REPO, [revertRecord()]);
  const { result: r, requests } = await reviewWith(recordsMemory(db, REF), [TAX.path]);
  assert.ok(requests.length >= 1);
  for (const request of requests) {
    const header = request.messages.filter((m) => m.content.includes(REVERTED_LINE_RULES));
    assert.equal(header.length, 1);
    assert.equal(header[0]!.content.includes('changed | `src/billing/tax.ts` | 2026-03-10 | - | reverted'), true);
    const text = JSON.stringify(request);
    assert.equal(text.includes('9:reverts'), false);
    // the author of the pull request under review is printed by the prompt itself; nothing else of a login is sent
    assert.equal(text.replace('Author: octo-dev', '').includes('octo-'), false);
  }
  assert.deepEqual(r.dependencies.memory, { status: 'ok', code: 'ok', lines: 1, lessons: { status: 'empty', code: 'no_lessons', shown: 0 } });
});

test('thirty signals\' lines and a revert: the review is shown the thirty, and the audit says a line was cut', async () => {
  const files = [TAX.path, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `src/cart/c${n}.ts`)];
  const signals = files.flatMap((path, f) => [1, 2, 3].map((k) => record({
    sourceRef: `${10 + k}:file:${path}`, number: 10 + k, path, directory: path.slice(0, path.lastIndexOf('/')),
    createdAt: `2026-03-0${k}T0${f}:00:00.000Z`,
  })));
  await addRecords(db, REPO, [...signals, revertRecord()]);
  const { result: r, requests } = await reviewWith(recordsMemory(db, REF), files);
  assert.equal(r.dependencies.memory?.lines, 30);
  assert.ok(requests.length >= 1);
  for (const request of requests) {
    const text = JSON.stringify(request);
    assert.equal(text.includes(' | reverted'), false);
    assert.equal(text.includes(REVERTED_LINE_RULES), false);
  }
  assert.ok(r.audit.some((e) => e.stage === 'context' && e.action === 'memory_cut' && e.subject === 'lines' && e.reason === '1'));
  const shown = r.audit.filter((e) => e.action === 'memory_shown');
  assert.equal(shown.length, 30);
  assert.equal(shown.some((e) => e.subject.includes(':reverts:')), false);
});

test('a read of reverts that fails costs the review its memory, not the review', async () => {
  await addRecords(db, REPO, [record(), revertRecord()]);
  const failing: Db = {
    query: (text, params) => { if (text.includes("kind = 'revert'")) throw new Error('db_down'); return db.query(text, params); },
    script: (sql) => db.script(sql),
    close: () => db.close(),
    transaction: (work) => db.transaction((tx) => work({
      query: async <Row>(text: string, params?: unknown[]) => {
        if (text.includes("kind = 'revert'")) throw new Error('db_down');
        return tx.query<Row>(text, params);
      },
      script: (sql) => tx.script(sql),
      close: () => tx.close(),
      transaction: (w) => tx.transaction(w),
    })),
  };
  await assert.rejects(recordsMemory(failing, REF).blocks([TAX], AS_OF, signal), /db_down/);
  const { result: r, requests } = await reviewWith(recordsMemory(failing, REF), [TAX.path]);
  assert.equal(r.dependencies.memory?.status, 'error');
  assert.match(r.dependencies.memory!.code, /^[a-z_]+$/);
  // the review ends as a review with no memory ends (the stub model's answer is the same for both), and its requests are that review's
  const none = await reviewWith(undefined as unknown as Memory, [TAX.path]);
  assert.equal(none.result.dependencies.memory, undefined);
  assert.equal(r.status, none.result.status);
  assert.deepEqual(r.failure, none.result.failure);
  assert.notEqual(r.failure?.stage, 'context');
  assert.deepEqual(requests, none.requests);
});
