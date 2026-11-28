import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { recordActivity } from '../../db/human-activity.ts';
import type { Activity } from '../../db/human-activity.ts';
import { savePullRequest } from '../../db/pull-requests.ts';
import { recordComments } from '../../db/review-comments.ts';
import type { StoredComment } from '../../db/review-comments.ts';
import { markPublished, recordRun } from '../../db/review-runs.ts';
import type { RunRecord } from '../../db/review-runs.ts';
import { pgliteDb } from '../../db/pglite.ts';
import { testDb } from '../../db/testing.ts';
import type { Db } from '../../db/types.ts';
import type { ModelClient, ModelResponse } from '../../engine/types.ts';
import type { PullRequestRef } from '../../forge/types.ts';
import { askJudge } from '../../memory/judge.ts';
import { judgeOnce } from '../../shell/judge.ts';
import type { Judged } from '../../shell/judge.ts';
import { exportCommand, exportFindings } from './export.ts';
import { parseFindings } from './findings.ts';
import { simulateNights } from './nights.ts';

const REF: PullRequestRef = { service: 'github', owner: 'acme', repo: 'shop', number: 7 };
const NOW = new Date('2026-03-20T08:00:00.000Z');
const T1 = '2026-03-09T10:00:00.000Z';
const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
const MAJOR = { path: 'src/a.ts', side: 'RIGHT', line: 10, severity: 'major', quote: 'total = round(sum)', body: 'Rounds before the discount is taken off.' };
const NOTE = { path: 'src/b.ts', side: 'RIGHT', line: 3, severity: 'note', quote: 'x', body: 'A note.' };

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ref: REF, job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'b1', baseBranch: 'main',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35,
  body: 'text', comments: [], result: { findings: [MAJOR, NOTE] },
  usage: { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 },
  startedAt: T1, finishedAt: plus(T1, 60_000), ...over,
});
const posted = (over: Partial<StoredComment> = {}): StoredComment => ({
  commentId: 'c-1', path: 'src/a.ts', side: 'RIGHT', line: 10, severity: 'major', quote: 'total = round(sum)', ...over,
});
const reply = (sourceId: string, author: string, association: Activity['association'], at: string, over: Partial<Activity> = {}): Activity => ({
  ref: REF, kind: 'inline_comment', sourceId, author, association, state: null, body: `${author} says no`, path: 'src/a.ts', side: 'RIGHT', line: 10,
  startLine: null, fileLevel: false, commit: 'h1', replyTo: 'c-1', thread: null, at, delivery: null, ...over,
});

async function publish(db: Db, over: Partial<RunRecord>, id: string): Promise<number> {
  const runId = await recordRun(db, run(over));
  await markPublished(db, runId, { reviewId: id, publishedAt: plus(over.startedAt ?? T1, 90_000), body: 'text', inlineDropped: false });
  return runId;
}

async function fixture(): Promise<Db> {
  const db = await testDb();
  await savePullRequest(db, {
    ref: REF, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feature', headSha: 'h1', draft: false, state: 'open',
    mergedAt: null, closedAt: null, mergeCommit: null, installation: '55', updatedAt: T1,
  });
  const one = await publish(db, {}, 'rv-1');
  await recordComments(db, one, REF, [posted(), posted({ commentId: 'c-note', path: 'src/b.ts', line: 3, severity: 'note', quote: 'x' })]);
  await recordActivity(db, reply('r-ana', 'ana', 'member', '2026-03-10T10:00:00.000Z'));
  await recordActivity(db, reply('r-bo', 'bo', 'none', '2026-03-10T09:00:00.000Z', { body: 'bo says maybe' }));
  await recordActivity(db, reply('r-other', 'cy', 'member', '2026-03-10T11:00:00.000Z', { replyTo: 'c-elsewhere' }));
  await recordActivity(db, reply('r-note', 'cy', 'member', '2026-03-10T11:00:00.000Z', { replyTo: 'c-note' }));
  await recordActivity(db, { ...reply('r-general', 'cy', 'member', '2026-03-10T11:00:00.000Z'), kind: 'general_comment' });
  await publish(db, { headSha: 'h2', startedAt: '2026-03-11T10:00:00.000Z', result: { findings: [], threadVerdicts: [{ commentId: 'c-1', verdict: 'open' }, { commentId: 'c-note', verdict: 'fixed' }] } }, 'rv-2');
  const three = await recordRun(db, run({ headSha: 'h3', startedAt: '2026-03-12T10:00:00.000Z', result: { findings: [], threadVerdicts: [{ commentId: 'c-1', verdict: 'fixed' }] } }));
  assert.ok(three > 0);   // never published
  return db;
}

test('the export holds each finding of a published run with its text, its replies in order and the later verdicts of its thread', async () => {
  const db = await fixture();
  const file = await exportFindings(db, NOW);
  assert.equal(file.exported_at, NOW.toISOString());
  assert.equal(file.findings.length, 1);
  const f = file.findings[0]!;
  assert.deepEqual([f.repo, f.pr_number, f.comment_id, f.path, f.side, f.line, f.severity], ['acme/shop', 7, 'c-1', 'src/a.ts', 'RIGHT', 10, 'major']);
  assert.deepEqual(f.run, { id: f.run.id, head_sha: 'h1', base_sha: 'b1', started_at: T1 });
  assert.equal(f.finding, MAJOR.body);
  // ana's reply was stored first, so it comes first, whatever the times say.
  assert.deepEqual(f.replies.map((r) => [r.id, r.association, r.body, r.at]), [
    ['r-ana', 'member', 'ana says no', '2026-03-10T10:00:00.000Z'],
    ['r-bo', 'none', 'bo says maybe', '2026-03-10T09:00:00.000Z'],
  ]);
  assert.ok(f.replies[0]!.order < f.replies[1]!.order);
  assert.equal(f.later.length, 1);
  assert.deepEqual([f.later[0]!.started_at, f.later[0]!.published_at, f.later[0]!.verdict], ['2026-03-11T10:00:00.000Z', '2026-03-11T10:01:30.000Z', 'open']);
  assert.ok(f.later[0]!.run > f.run.id);
  await db.close();
});

test('findings are ordered by repository, number, run and comment, and a reply of another pull request is not theirs', async () => {
  const db = await fixture();
  const other: PullRequestRef = { ...REF, repo: 'web', number: 9 };
  const id = await recordRun(db, run({ ref: other }));
  await markPublished(db, id, { reviewId: 'rv-w', publishedAt: plus(T1, 90_000), body: 't', inlineDropped: false });
  await recordComments(db, id, other, [posted({ commentId: 'c-w', severity: 'minor' })]);
  await recordActivity(db, { ...reply('r-w', 'ana', 'member', '2026-03-10T10:00:00.000Z', { replyTo: 'c-1' }), ref: other });
  const file = await exportFindings(db, NOW);
  assert.deepEqual(file.findings.map((f) => [f.repo, f.pr_number, f.comment_id, f.replies.length]), [['acme/shop', 7, 'c-1', 2], ['acme/web', 9, 'c-w', 0]]);
  await db.close();
});

test('a finding whose text cannot be told is exported with finding null', async () => {
  const db = await testDb();
  const id = await publish(db, { result: {} }, 'rv-1');
  await recordComments(db, id, REF, [posted()]);
  const file = await exportFindings(db, NOW);
  assert.equal(file.findings.length, 1);
  assert.equal(file.findings[0]!.finding, null);
  await db.close();
});

async function counts(db: Db): Promise<Record<string, number>> {
  const tables = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'visto_ai' order by 1");
  const out: Record<string, number> = {};
  for (const t of tables) out[t.table_name] = (await db.query<{ n: number }>(`select count(*)::int as n from visto_ai.${t.table_name}`))[0]!.n;
  return out;
}

test('the export reads in a read-only transaction and leaves every row as it was', async () => {
  const inner = await fixture();
  const sent: string[] = [];
  const spy = (db: Db): Db => ({
    query: (text, params) => { sent.push(text); return db.query(text, params); },
    script: (sql) => db.script(sql),
    transaction: (work) => db.transaction((tx) => work(spy(tx))),
    close: () => db.close(),
  });
  const before = await counts(inner);
  sent.length = 0;
  const file = await exportFindings(spy(inner), NOW);
  assert.equal(file.findings.length, 1);
  assert.equal(sent[0], 'set transaction isolation level repeatable read, read only');
  assert.equal(sent.length, 4);
  assert.deepEqual(await counts(inner), before);
  // The database itself refuses a write inside it.
  await assert.rejects(inner.transaction(async (tx) => {
    await tx.query('set transaction isolation level repeatable read, read only');
    await tx.query("delete from visto_ai.review_comments");
  }));
  assert.deepEqual(await counts(inner), before);
  await inner.close();
});

test('the export command writes its file mode 600, refuses an existing file without force and an unmigrated database', async () => {
  const db = await fixture();
  const dir = mkdtempSync(join(tmpdir(), 'export-'));
  const out = join(dir, 'findings.jsonl');
  await exportCommand(db, out, false, NOW);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.equal(parseFindings(readFileSync(out, 'utf8')).findings.length, 1);
  await assert.rejects(exportCommand(db, out, false, NOW), { message: 'out_exists' });
  await exportCommand(db, out, true, new Date('2026-03-21T08:00:00.000Z'));
  assert.equal(parseFindings(readFileSync(out, 'utf8')).exported_at, '2026-03-21T08:00:00.000Z');
  assert.equal(statSync(out).mode & 0o777, 0o600);
  await db.close();

  // A file that was there with a wider mode is narrowed.
  const wide = await testDb();
  const again = join(dir, 'again.jsonl');
  await exportCommand(wide, again, false, NOW);
  const { chmodSync } = await import('node:fs');
  chmodSync(again, 0o644);
  await exportCommand(wide, again, true, NOW);
  assert.equal(statSync(again).mode & 0o777, 0o600);

  // Removing the ledger row stands in for a database that was never migrated to 0003_publishing.
  await wide.query("delete from visto_ai.schema_migrations where name = '0003_publishing'");
  const fresh = join(dir, 'fresh.jsonl');
  await assert.rejects(exportCommand(wide, fresh, false, NOW), { message: 'database_not_migrated' });
  assert.throws(() => statSync(fresh));
  await wide.close();
  const bare = await pgliteDb();
  await assert.rejects(exportCommand(bare, fresh, false, NOW), { message: 'database_not_migrated' });
  await bare.close();
});

test('the export command prints counts and no reply, finding, path or login', async () => {
  const db = await fixture();
  const dir = mkdtempSync(join(tmpdir(), 'export-'));
  const line = await exportCommand(db, join(dir, 'f.jsonl'), false, NOW);
  assert.match(line, /^findings \d+, with replies \d+, replies \d+, pull requests \d+$/);
  assert.equal(line, 'findings 1, with replies 1, replies 2, pull requests 1');
  for (const secret of ['ana', 'bo', 'src/a.ts', 'Rounds', 'says']) assert.ok(!line.includes(secret), secret);
  await db.close();
});

// The parity of the two stores (call 6; Review Focus 2): the service's night over the database, and the eval's nights over
// its export, asked with the same answers, keep the same verdicts and make the same lessons.
const TAX = { path: 'src/billing/tax.ts', side: 'RIGHT', line: 12, severity: 'major', quote: 'total = round(sum)', body: 'Rounds before the discount is taken off.' };
const CART = { path: 'src/cart/cache.ts', side: 'RIGHT', line: 4, severity: 'minor', quote: 'return cache.get(id)', body: 'This read can return a stale cart after a write.' };
const TAX_BODY = 'We round half up here on purpose, as the invoices require it.';
const CART_BODY = 'The cache is cleared by the caller on every write, so a stale read cannot happen here.';
const CART_AGAIN = 'Callers clear the cache on every write, so stale reads of the cart cannot occur.';
const TAX_LESSON = 'A rounding finding on invoice totals is wrong: invoices round half up on purpose.';
const CART_LESSON = 'A stale read finding on the cart cache is wrong: its callers clear it on every write.';
const CART_RESTATED = 'Stale read findings on the cart cache are wrong, because callers clear the cache on every write.';

const judgeUsage = { calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, cost: 0.25 };
const answer = (args: Record<string, unknown>): ModelResponse =>
  ({ toolName: 'submit_verdict', toolArguments: JSON.stringify(args), text: null, model: 'm', provider: null, usage: judgeUsage });
/** A judge that answers by the words of the reply it is sent, and by nothing else. */
const byWords: ModelClient = {
  complete: async (request) => {
    const sent = request.messages[1]!.content;
    if (sent.includes('maybe')) return { toolName: null, toolArguments: null, text: 'It looks fine to me.', model: 'm', provider: null, usage: judgeUsage };
    if (sent.includes('round half up')) return answer({ classification: 'valid_pushback', lesson: TAX_LESSON, quote: 'round half up here on purpose' });
    if (sent.includes('cleared by the caller')) return answer({ classification: 'valid_pushback', lesson: CART_LESSON, quote: 'cleared by the caller on every write' });
    if (sent.includes('stale reads of the cart')) return answer({ classification: 'valid_pushback', lesson: CART_RESTATED, quote: 'clear the cache on every write' });
    return answer({ classification: 'noise', lesson: null, quote: null });
  },
};

test('a database and its export judged night by night with the same answers give the same verdicts and the same lessons', async () => {
  const WEB: PullRequestRef = { service: 'github', owner: 'acme', repo: 'web', number: 8 };
  const db = await testDb();
  // Every run is recorded and then published: a comment is stored only once its run is published.
  const shop = await publish(db, { startedAt: '2026-03-01T08:00:00.000Z', result: { findings: [TAX] } }, 'rv-s1');
  await recordComments(db, shop, REF, [
    posted({ commentId: 'c-tax', path: TAX.path, line: TAX.line, quote: TAX.quote }),
    posted({ commentId: 'c-lost', path: 'src/billing/fees.ts', line: 3, quote: 'fee = 0' }),   // no stored finding says it
  ]);
  const web = await publish(db, { ref: WEB, startedAt: '2026-03-01T08:30:00.000Z', result: { findings: [CART] } }, 'rv-w1');
  await recordComments(db, web, WEB, [posted({ commentId: 'c-cart', path: CART.path, line: CART.line, severity: CART.severity, quote: CART.quote })]);
  // A later review of acme/shop 7 kept c-tax open. It is published before the first night: the database holds it from the
  // start, and the service never sees a run from the future.
  await publish(db, { headSha: 'h2', startedAt: '2026-03-01T20:00:00.000Z', result: { findings: [], threadVerdicts: [{ commentId: 'c-tax', verdict: 'open' }] } }, 'rv-s2');

  const onShop = (id: string, author: string, association: Activity['association'], at: string, replyTo: string, body: string): Activity =>
    reply(id, author, association, at, { replyTo, body, path: replyTo === 'c-tax' ? TAX.path : 'src/billing/fees.ts' });
  const onWeb = (id: string, author: string, association: Activity['association'], at: string, body: string): Activity =>
    ({ ...reply(id, author, association, at, { replyTo: 'c-cart', body, path: CART.path, line: CART.line }), ref: WEB });
  await recordActivity(db, onShop('r-1', 'ana', 'member', '2026-03-01T12:00:00.000Z', 'c-tax', TAX_BODY));    // before the later review: it disagrees
  await recordActivity(db, onWeb('r-2', 'cy', 'none', '2026-03-01T13:00:00.000Z', CART_BODY));                  // a stranger
  await recordActivity(db, onShop('r-3', 'bo', 'member', '2026-03-01T14:00:00.000Z', 'c-tax', 'Hmm, maybe; I will look again tomorrow.'));   // never a verdict
  await recordActivity(db, onShop('r-4', 'ana', 'member', '2026-03-01T21:00:00.000Z', 'c-tax', TAX_BODY));    // after the later review began: a lesson
  await recordActivity(db, onShop('r-5', 'bo', 'member', '2026-03-02T09:00:00.000Z', 'c-tax', '> it is intended, see the spec'));   // no words of its own
  await recordActivity(db, onShop('r-6', 'ana', 'member', '2026-03-02T10:00:00.000Z', 'c-lost', TAX_BODY));   // its finding is unknown
  await recordActivity(db, onWeb('r-7', 'bo', 'collaborator', '2026-03-02T11:00:00.000Z', CART_BODY));          // a lesson in acme/web
  await recordActivity(db, onWeb('r-8', 'ana', 'member', '2026-03-03T09:00:00.000Z', CART_AGAIN));              // restates r-7's

  const exported = await exportFindings(db, new Date('2026-03-05T09:00:00.000Z'));

  // The service: one run a night, a few minutes after 00:00.
  const ran: Judged[] = [];
  for (const day of ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']) {
    ran.push(await judgeOnce({
      db, clock: () => new Date(`${day}T00:05:00.000Z`), model: byWords, token: () => 'tok123', auto: false, timeoutMs: 60_000, paused: async () => null,
    }));
  }
  assert.ok(ran.every((r) => r.complete));

  // The eval: the nights over the export, asked through the same judge.
  const sim = await simulateNights(exported, (_reply, input) => askJudge(byWords, input, 'tok123', false, 60_000), () => null);
  assert.equal(sim.complete, true);
  assert.equal(sim.nights, 4);
  assert.equal(sim.calls, ran.reduce((n, r) => n + r.calls, 0));

  const stored = await db.query<{ reply: string; classification: string | null; outcome: string; attempts: number }>(
    'select reply, classification, outcome, attempts from visto_ai.reply_verdicts order by reply');
  const simulated = sim.verdicts
    .map((v) => ({ reply: v.reply, classification: v.classification, outcome: v.outcome, attempts: v.attempts }))
    .sort((a, b) => (a.reply < b.reply ? -1 : a.reply > b.reply ? 1 : 0));
  assert.deepEqual(simulated, stored);
  assert.deepEqual(stored.map((v) => [v.reply, v.classification, v.outcome, v.attempts]), [
    ['r-1', 'valid_pushback', 'review_disagreed', 0],
    ['r-2', 'valid_pushback', 'no_access', 0],
    ['r-3', null, 'unjudged', 3],
    ['r-4', 'valid_pushback', 'lesson', 0],
    ['r-5', 'noise', 'no_own_words', 0],
    ['r-6', null, 'finding_unknown', 3],
    ['r-7', 'valid_pushback', 'lesson', 0],
    ['r-8', 'valid_pushback', 'restates', 0],
  ]);

  const made = (await db.query<{ repo: string; source_ref: string; path: string; lesson: string; created_at: Date }>(
    "select owner || '/' || repo as repo, source_ref, path, lesson, created_at from visto_ai.memory_records where kind = 'lesson' order by source_ref"))
    .map((x) => [x.repo, x.source_ref, x.path, x.lesson, x.created_at.toISOString()]);
  const kept = sim.lessons.map((l) => [l.repo, l.ref, l.path, l.text, l.createdAt]).sort((a, b) => (a[1]! < b[1]! ? -1 : 1));
  assert.deepEqual(kept, made);
  assert.deepEqual(made, [
    ['acme/shop', '7:r-4', TAX.path, TAX_LESSON, '2026-03-02T00:00:00.000Z'],
    ['acme/web', '8:r-7', CART.path, CART_LESSON, '2026-03-03T00:00:00.000Z'],
  ]);
  await db.close();
});
