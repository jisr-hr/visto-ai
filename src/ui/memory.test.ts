import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/load.ts';
import { noteLearning } from '../db/learning.ts';
import { recordActivity } from '../db/human-activity.ts';
import { addRecords } from '../db/memory-records.ts';
import type { NewRecord } from '../db/memory-records.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import type { MemoryRecordShown, MemoryView } from './api-types.ts';
import type { InsightDeps, StartedWith } from './insight.ts';
import { MEMORY_PAGE, TEXT_CHARS, memory, switchMemory, switchOf } from './memory.ts';
import { createQualityCache } from './quality.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const DAY = 86400;
const config = parseConfig('model:\n  apiKey: { env: K }\n  model: vendor/model-a\n', { K: 'model-key-for-tests-only' });
const REPO = { service: 'github', owner: 'acme', repo: 'shop' } as const;

function deps(db: Db, learning = true): InsightDeps & { log: (e: Record<string, unknown>) => void; lines: Array<Record<string, unknown>> } {
  const clock = (): Date => new Date(at(0));
  const lines: Array<Record<string, unknown>> = [];
  const started: StartedWith = { dryRun: false, learning, scorer: false, extensions: [], mcpServers: [] };
  return { db, clock, inForce: () => config, started, quality: createQualityCache({ clock, log: () => undefined }), log: (e) => { lines.push(e); }, lines };
}
const rec = (over: Partial<NewRecord> = {}): NewRecord => ({
  kind: 'human_signal', sourceRef: 'ref-1', number: 7, path: 'src/cart.ts', directory: 'src', category: 'money', reason: 'secret reason', missed: true,
  excerpt: 'the cart rounds', comment: 'c-1', createdAt: at(-DAY), expiresAt: at(100 * DAY), ...over,
});
const asView = (a: MemoryView | 'bad_request'): MemoryView => { assert.notEqual(a, 'bad_request'); return a as MemoryView; };
const q = (o: Record<string, string>): URLSearchParams => new URLSearchParams(o);

test('the memory answer holds learning, the counts and a page of records with their words and places', async () => {
  const db = await testDb();
  const d = deps(db);
  await noteLearning(db, 'signals', at(-180), { examined: 1, added: 1, retired: 0, failed: 0 });
  await recordActivity(db, {
    ref: { ...REPO, number: 7 }, kind: 'inline_comment', sourceId: 'c-1', author: 'octo-guest', association: null, state: null, body: 'b',
    path: null, side: null, line: null, startLine: null, fileLevel: null, commit: null, replyTo: null, thread: null, at: at(-DAY), delivery: null,
  });
  const many: NewRecord[] = [];
  for (let i = 0; i < 49; i++) many.push(rec({ sourceRef: `s${i}`, comment: null, excerpt: `text ${i}` }));
  await addRecords(db, REPO, [rec(), ...many]);
  await addRecords(db, REPO, [
    rec({ kind: 'revert', sourceRef: 'r1', number: 70, reverted: 68, excerpt: '', comment: null }),
    rec({ kind: 'lesson', sourceRef: 'l1', lesson: 'check units', excerpt: '', comment: null, path: 'src/u.ts' }),
  ]);
  const view = asView(await memory(d, q({})));
  assert.deepEqual(view.learning, { on: true, ranAt: at(-180) });
  assert.deepEqual(view.counts, { signals: 50, signalRepositories: 1, reverts: 1, lessons: 1, off: 0 });
  assert.equal(view.total, 52);
  assert.equal(view.records.length, MEMORY_PAGE);
  assert.equal(view.next, view.records[MEMORY_PAGE - 1]!.id);
  const lesson = view.records[0]!;
  assert.equal(lesson.kind, 'lesson');
  assert.equal(lesson.text, 'check units');
  const revert = view.records[1]!;
  assert.deepEqual({ text: revert.text, reverted: revert.reverted, by: revert.by, repository: revert.repository }, { text: '', reverted: 68, by: null, repository: 'acme/shop' });
  const second = asView(await memory(d, q({ before: String(view.next) })));
  assert.equal(second.records.length, 2);
  assert.equal(second.next, null);
  assert.equal(second.total, 52);
  const person = second.records.find((r) => r.by !== null);
  assert.equal(person?.by, 'octo-guest');
  assert.equal(person?.on, true);
  assert.equal(person?.reverted, null);
  const quiet = asView(await memory(deps(await testDb(), false), q({})));
  assert.deepEqual(quiet.learning, { on: false, ranAt: null });
  await db.close();
});

test('a long text is cut at the limit', async () => {
  const db = await testDb();
  await addRecords(db, REPO, [rec({ excerpt: 'x'.repeat(TEXT_CHARS + 50) })]);
  const view = asView(await memory(deps(db), q({})));
  assert.equal(view.records[0]!.text.length, TEXT_CHARS);
  await db.close();
});

test('the search takes percent, underscore and backslash as themselves, an empty parameter is absent, and a malformed one is bad_request', async () => {
  const db = await testDb();
  const d = deps(db);
  await addRecords(db, REPO, [
    rec({ sourceRef: 'a', excerpt: '100% done', comment: null }), rec({ sourceRef: 'b', excerpt: 'a_b', comment: null }),
    rec({ sourceRef: 'c', excerpt: 'c\\d', comment: null }), rec({ sourceRef: 'd', excerpt: 'plain', comment: null }),
  ]);
  const found = async (qs: string): Promise<string[]> => asView(await memory(d, q({ q: qs }))).records.map((r) => r.text).sort();
  assert.deepEqual(await found('%'), ['100% done']);
  assert.deepEqual(await found('_'), ['a_b']);
  assert.deepEqual(await found('\\'), ['c\\d']);
  assert.deepEqual(await found('  PLAIN '), ['plain']);
  assert.equal(asView(await memory(d, q({ kind: '', repo: '', q: '', before: '' }))).records.length, 4);
  assert.equal(asView(await memory(d, q({ q: '   ' }))).records.length, 4);
  assert.equal(asView(await memory(d, q({ repo: 'ACME/Shop' }))).records.length, 4);
  const bads: Array<Record<string, string>> = [{ kind: 'person' }, { repo: 'acme' }, { repo: 'a/b/c' }, { before: 'x' }, { before: '2147483648' }, { before: '12345678901' }, { q: 'x'.repeat(101) }, { q: 'a\u0000b' }];
  for (const bad of bads) {
    assert.equal(await memory(d, q(bad)), 'bad_request', JSON.stringify(bad));
  }
  await db.close();
});

test('a switch answers the record as it is after, and logs a change only', async () => {
  const db = await testDb();
  const d = deps(db);
  await addRecords(db, REPO, [rec({ comment: null })]);
  const id = asView(await memory(d, q({}))).records[0]!.id;
  const off = await switchMemory(d, id, false, 'octo-admin');
  assert.equal(off?.on, false);
  assert.deepEqual(d.lines, [{ event: 'memory_switch', record: id, on: false }]);
  const again = await switchMemory(d, id, false, 'octo-admin');
  assert.equal(again?.on, false);
  assert.equal(d.lines.length, 1);
  assert.equal(asView(await memory(d, q({}))).counts.off, 1);
  const on = await switchMemory(d, id, true, 'octo-admin');
  assert.equal(on?.on, true);
  assert.equal(d.lines.length, 2);
  assert.equal(await switchMemory(d, id + 100, false, 'octo-admin'), null);
  await db.query("update visto_ai.memory_records set expires_at = $1::timestamptz", [at(-1)]);
  assert.equal(await switchMemory(d, id, false, 'octo-admin'), null);
  assert.equal(d.lines.length, 2);
  await db.close();
});

test('the body of a switch is exactly on, a boolean', () => {
  assert.deepEqual(switchOf({ on: true }), { on: true });
  assert.deepEqual(switchOf({ on: false }), { on: false });
  assert.equal(switchOf({}), null);
  assert.equal(switchOf({ on: 'true' }), null);
  assert.equal(switchOf({ on: true, id: 1 }), null);
  assert.equal(switchOf({ off: true }), null);
});

test('an answer holds no field the screens do not show', async () => {
  const db = await testDb();
  const d = deps(db);
  await addRecords(db, REPO, [rec({ sourceRef: 'secret-source-ref', reason: 'secret reason', category: 'secret-category' })]);
  const view = asView(await memory(d, q({})));
  assert.deepEqual(Object.keys(view).sort(), ['counts', 'learning', 'next', 'now', 'records', 'total']);
  const keys = ['by', 'createdAt', 'directory', 'expiresAt', 'id', 'kind', 'number', 'on', 'path', 'repository', 'reverted', 'text'];
  assert.deepEqual(Object.keys(view.records[0]!).sort(), keys);
  const switched: MemoryRecordShown | null = await switchMemory(d, view.records[0]!.id, false, 'octo-admin');
  assert.deepEqual(Object.keys(switched!).sort(), keys);
  const json = JSON.stringify([view, switched]);
  for (const word of ['secret-source-ref', 'secret reason', 'secret-category', 'c-1', 'missed', 'source_ref']) assert.ok(!json.includes(word), word);
  await db.close();
});
