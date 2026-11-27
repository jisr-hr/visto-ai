import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config/load.ts';
import type { DeploymentConfig } from '../config/load.ts';
import { recordFeedback } from '../db/feedback.ts';
import { recordActivity } from '../db/human-activity.ts';
import type { Activity } from '../db/human-activity.ts';
import { savePullRequest } from '../db/pull-requests.ts';
import { recordComments } from '../db/review-comments.ts';
import { markPublished, recordRun } from '../db/review-runs.ts';
import type { RunRecord } from '../db/review-runs.ts';
import { testDb } from '../db/testing.ts';
import type { Db } from '../db/types.ts';
import { THRESHOLDS, countAt, share } from '../eval/backtest/metrics.ts';
import { liveCases, storedScores } from '../eval/live/labels.ts';
import type { LiveComment, LivePull, LiveRun } from '../eval/live/labels.ts';
import type { PullRequestFacts, PullRequestRef, Side } from '../forge/types.ts';
import type { Measure, Quality, QualityAnswer, QualityRow, Repositories, SteppedBlock } from './api-types.ts';
import { windowStart } from './insight.ts';
import type { InsightDeps, StartedWith } from './insight.ts';
import {
  QUALITY_CACHE_MS, QUALITY_COMMENTS, QUALITY_DEADLINE_MS, QUALITY_FAILED_MS, QUALITY_GROUP, QUALITY_KEPT, QUALITY_PULLS, QUALITY_RESULT_BYTES,
  QUALITY_RUN_ROWS, QUALITY_RUNS, QUALITY_WAIT_MS, REASONS_SHOWN, STEPPED_SHOWN, approvalShort, computeQuality, createQualityCache, quality,
  qualityKey, qualityOf, repositories,
} from './quality.ts';

const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();
const DAY = 86400;
const P = 'src/cart/discount.ts';
const HEAD_A = '3f9c2e1a7b04' + 'a'.repeat(28);
const HEAD_B = '9a1e5c07b3d2' + 'b'.repeat(28);
const HEAD_C = '5d7e0b2c9f13' + 'c'.repeat(28);
const headOf = (i: number): string => '3f9c2e1a7b04' + i.toString(16).padStart(28, '0');
const refOf = (number: number, repo = 'shop'): PullRequestRef => ({ service: 'github', owner: 'acme', repo, number });

const BASE = 'model:\n  apiKey: { env: K }\n  model: vendor/model-a\n';
const configOf = (yaml = ''): DeploymentConfig => parseConfig(BASE + yaml, { K: 'model-key-for-tests-only', AUDIT: 'audit-key-for-tests-only-'.padEnd(40, 'x') });
const AT_65 = 'repositories:\n  overrides:\n    acme/shop: { score: { threshold: 65 } }\n';
const STARTED: StartedWith = { dryRun: false, learning: true, scorer: false, extensions: [], mcpServers: [] };

// -- the fixtures: scores in the engine's shape, with text that must never leave ----------------------------------------------
type Range = [number, number];
const block = (id: string, hunkHash: string, score: number | null, right: Range[], changed = 10): Record<string, unknown> => ({
  id, hunk: id, hunkHash, hash: `${hunkHash}-part`, around: `${hunkHash}-around`, changedLines: changed,
  span: { side: 'RIGHT', first: right[0]![0], last: right[0]![1] }, lines: { RIGHT: right, LEFT: [] },
  entry: score === null ? null : { score, category: 'calculation', reason: 'REASON-TEXT' },
});
const file = (path: string, diffHash: string, blocks: Array<Record<string, unknown>>, fileLevel: number | null = null): Record<string, unknown> => {
  const scores = blocks.map((b) => (b.entry as { score: number } | null)?.score ?? 0);
  return {
    path, previousPath: null, diffHash, changeSummary: 'SUMMARY-TEXT', changedLines: blocks.reduce((n, b) => n + (b.changedLines as number), 0), blocks,
    wholeFile: null, fileLevel: fileLevel === null ? null : { score: fileLevel, source: 'builtin_floor' },
    finalScore: Math.max(fileLevel ?? 0, ...scores), covered: true,
  };
};
const one = (diffHash: string, hunkHash: string, score: number, right: Range[] = [[38, 51]]): Array<Record<string, unknown>> =>
  [file(P, diffHash, [block('B1', hunkHash, score, right)])];

const facts = (number: number, closed: number | null, over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref: refOf(number), author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feature/cart', headSha: HEAD_A, draft: false,
  state: closed === null ? 'open' : 'merged', mergedAt: closed === null ? null : at(closed), closedAt: closed === null ? null : at(closed + 5),
  mergeCommit: null, installation: null, updatedAt: at(0), ...over,
});
const runOf = (number: number, head: string, started: number, scores: unknown, over: Partial<RunRecord> = {}): RunRecord => ({
  ref: refOf(number), job: null, trigger: 'automatic', mode: 'full', dryRun: false, headSha: head, baseSha: 'base-1', baseBranch: 'main',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 30, body: 'BODY-TEXT', comments: [],
  result: { scores, verdict: { threshold: 70 }, overview: 'OVERVIEW-TEXT' },
  usage: { calls: 1, inputTokens: 10, outputTokens: 10, cachedTokens: 0, cost: 0.01 },
  startedAt: at(started), finishedAt: at(started + 60), ...over,
});
const scored = (db: Db, number: number, head: string, started: number, scores: unknown, over: Partial<RunRecord> = {}): Promise<number> =>
  recordRun(db, runOf(number, head, started, scores, over));
const inline = (number: number, sourceId: string, commit: string | null, seconds: number, over: Partial<Activity> = {}): Activity => ({
  ref: refOf(number), kind: 'inline_comment', sourceId, author: 'octo-guest', association: null, state: null, body: 'COMMENT-TEXT',
  path: P, side: 'RIGHT', line: 40, startLine: null, fileLevel: false, commit, replyTo: null, thread: null, at: at(seconds), delivery: null, ...over,
});
const comment = (db: Db, number: number, sourceId: string, commit: string | null, seconds: number, over: Partial<Activity> = {}): Promise<boolean> =>
  recordActivity(db, inline(number, sourceId, commit, seconds, over));

// -- the harness: a spy on the statements, a clock the test moves, the settings in force the test changes --------------------
type Hook = (text: string, params: unknown[]) => Promise<void> | void;
interface Harness {
  deps: InsightDeps; sent: Array<{ text: string; params: unknown[] }>; logs: Array<Record<string, unknown>>;
  move(seconds: number): void; use(config: DeploymentConfig): void; hook: { before: Hook | null };
}
function harness(inner: Db, config = configOf()): Harness {
  let now = Date.parse(at(0));
  let inForce = config;
  const sent: Harness['sent'] = [];
  const logs: Harness['logs'] = [];
  const hook: Harness['hook'] = { before: null };
  const db: Db = {
    query: async <Row,>(text: string, params?: unknown[]): Promise<Row[]> => {
      sent.push({ text, params: params ?? [] });
      if (hook.before !== null) await hook.before(text, params ?? []);
      return inner.query<Row>(text, params);
    },
    script: (sql) => inner.script(sql), close: () => inner.close(), transaction: (work) => inner.transaction(work),
  };
  const clock = (): Date => new Date(now);
  return {
    deps: { db, clock, inForce: () => inForce, started: STARTED, quality: createQualityCache({ clock, log: (entry) => { logs.push(entry); } }) },
    sent, logs, move: (seconds) => { now += seconds * 1000; }, use: (c) => { inForce = c; }, hook,
  };
}
const KINDS: Array<[string, string]> = [
  ['closedPulls', "state in ('merged', 'closed')"], ['okRuns', 'select id, number, head_sha, started_at'], ['runScores', 'pg_column_size'],
  ['inlineCommentsOf', "kind = 'inline_comment'"], ['findingThreads', 'from visto_ai.review_comments'], ['mergedReverts', 'p.reverts is not null'],
  ['auditedPulls', "approval_code = 'audit_sample'"], ['feedbackCounts', "filter (where vote = 'up')"], ['feedbackReasons', 'array_agg'],
];
const kindOf = (text: string): string => KINDS.find(([, part]) => text.includes(part))?.[0] ?? 'other';
const kinds = (h: Harness, from = 0): string[] => h.sent.slice(from).map((s) => kindOf(s.text));
const groupsRead = (h: Harness): number[][] => h.sent.filter((s) => kindOf(s.text) === 'runScores').map((s) => JSON.parse(s.params[0] as string) as number[]);
const days = (value?: string): URLSearchParams => new URLSearchParams(value === undefined ? '' : `days=${value}`);
const m = (part: number, of: number): Measure => ({ share: share(part, of), part, of });
const ready = async (answer: Promise<QualityAnswer | 'bad_request'>): Promise<Quality> => {
  const got = await answer;
  assert.notEqual(got, 'bad_request');
  assert.equal((got as QualityAnswer).state, 'ready');
  return (got as QualityAnswer).quality!;
};
const rowAt = (q: Quality, threshold: number): QualityRow => {
  const row = q.rows.find((r) => r.threshold === threshold);
  assert.ok(row !== undefined, `no row at ${threshold}`);
  return row;
};
const NOTHING = { reverts: { merged: 0, approved: 0 }, audits: { drawn: 0, needed: 0 }, feedback: { helpful: 0, notHelpful: 0, reasons: [] } };
const settle = async (h: Harness, key: string): Promise<void> => {
  for (let i = 0; i < 10_000 && h.deps.quality.kept(key) === null; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("a repository's quality is measured on the pull requests closed in the window, from their stored runs and people's comments", async () => {
  const db = await testDb();
  await savePullRequest(db, facts(119, -DAY));
  await scored(db, 119, HEAD_A, -3 * DAY, one('dA', 'h1', 55));
  await scored(db, 119, HEAD_B, -2 * DAY, one('dB', 'h9', 80, [[38, 53]]));
  // A run after the merge is not its last run: were it, B1 would not have changed.
  await scored(db, 119, HEAD_B, -DAY + 60, one('dA', 'h1', 20));
  await comment(db, 119, '7001', HEAD_A, -3 * DAY + 100);
  await savePullRequest(db, facts(120, -2 * DAY));
  await scored(db, 120, HEAD_A, -2 * DAY - 600, [file('src/cart/total.ts', 'dT', [block('B1', 'h3', 30, [[1, 10]])])]);
  // Merged before the window, and open: not measured.
  await savePullRequest(db, facts(118, -40 * DAY));
  await scored(db, 118, HEAD_A, -41 * DAY, one('dA', 'h1', 10));
  await comment(db, 118, '7002', HEAD_A, -41 * DAY + 100, { author: 'octo-lead' });
  await savePullRequest(db, facts(121, null));
  await scored(db, 121, HEAD_A, -DAY, one('dA', 'h1', 10));

  const h = harness(db);
  const want: Quality = {
    repository: 'acme/shop', window: 30, threshold: 70, pullRequests: 2, unreadable: 0, cut: { pulls: false, comments: false, runs: false },
    rows: [
      { threshold: 20, current: false, safetyBlocks: m(0, 1), safetyFiles: m(0, 1), benefit: m(0, 2), focus: m(20, 20) },
      { threshold: 40, current: false, safetyBlocks: m(0, 1), safetyFiles: m(0, 1), benefit: m(1, 2), focus: m(10, 10) },
      { threshold: 70, current: true, safetyBlocks: m(1, 1), safetyFiles: m(1, 1), benefit: m(1, 2), focus: m(10, 10) },
      { threshold: 90, current: false, safetyBlocks: m(1, 1), safetyFiles: m(1, 1), benefit: m(2, 2), focus: m(0, 0) },
    ],
    stepped: [{ path: P, number: 119, score: 55 }],
    ...NOTHING,
  };
  assert.deepEqual(await computeQuality(h.deps, 'acme/shop', 30, 70), want);
  assert.deepEqual(rowAt(want, 70).safetyBlocks, { share: 1, part: 1, of: 1 });
  assert.deepEqual(rowAt(want, 70).benefit, { share: 0.5, part: 1, of: 2 });
  assert.deepEqual(await quality(h.deps, 'acme/shop', days()), { now: at(0), state: 'ready', quality: want });
  await db.close();
});

test('a comment on a head whose only run found nothing new is placed on that run, and the last run is the newest that did not fail', async () => {
  const db = await testDb();
  // #121: the run at head B found nothing new and holds the scores of its head; a run after it failed. It is the last run.
  await savePullRequest(db, facts(121, -DAY));
  const r1 = await scored(db, 121, HEAD_A, -3 * DAY, one('dA', 'h1', 80));
  const r2 = await scored(db, 121, HEAD_B, -2 * DAY, one('dB', 'h9', 30), { result: { nothingToDo: true, scores: one('dB', 'h9', 30) } });
  await scored(db, 121, HEAD_C, -DAY - 600, null, { outcome: 'failed', failureStage: 'model', failureCode: 'model_timeout', result: {} });
  await comment(db, 121, '7001', HEAD_B, -2 * DAY + 100);
  // #122: the run at head B found nothing new, and a later run changed B1: the comment at head B is a strict label on that run.
  await savePullRequest(db, facts(122, -DAY));
  const r4 = await scored(db, 122, HEAD_A, -3 * DAY, one('dA', 'h1', 55));
  const r5 = await scored(db, 122, HEAD_B, -2.5 * DAY, one('dB', 'h5', 45), { result: { nothingToDo: true, scores: one('dB', 'h5', 45) } });
  const r6 = await scored(db, 122, HEAD_C, -2 * DAY, one('dC', 'h6', 30));
  await comment(db, 122, '7002', HEAD_B, -2.5 * DAY + 100);

  const h = harness(db);
  const q = await computeQuality(h.deps, 'acme/shop', 30, 70);
  assert.deepEqual(groupsRead(h), [[r6, r5, r2]]);
  assert.ok(!groupsRead(h).flat().includes(r1) && !groupsRead(h).flat().includes(r4));
  assert.equal(q.pullRequests, 2);
  assert.deepEqual(rowAt(q, 70).benefit, m(2, 2));
  assert.deepEqual(rowAt(q, 70).safetyBlocks, m(1, 1));
  assert.deepEqual(q.stepped, [{ path: P, number: 122, score: 45 }]);
  await db.close();
});

test("the repository's threshold in force is a row of its own, marked, and one of the four is marked when it is that", async () => {
  const db = await testDb();
  await savePullRequest(db, facts(119, -DAY));
  await scored(db, 119, HEAD_A, -2 * DAY, one('dA', 'h1', 67));
  const h = harness(db, configOf(AT_65));
  const at65 = await ready(quality(h.deps, 'acme/shop', days('30')));
  assert.equal(at65.threshold, 65);
  assert.deepEqual(at65.rows.map((r) => [r.threshold, r.current]), [[20, false], [40, false], [65, true], [70, false], [90, false]]);
  assert.deepEqual(rowAt(at65, 65).benefit, m(0, 1));
  assert.deepEqual(rowAt(at65, 70).benefit, m(1, 1));
  h.use(configOf());
  const at70 = await ready(quality(h.deps, 'acme/shop', days('30')));
  assert.equal(at70.threshold, 70);
  assert.deepEqual(at70.rows.map((r) => [r.threshold, r.current]), [[20, false], [40, false], [70, true], [90, false]]);
  assert.deepEqual(THRESHOLDS, [20, 40, 70, 90]);
  await db.close();
});

test('scores are read ten runs to a statement, pull request by pull request, and the counts add up across groups', async () => {
  const db = await testDb();
  const expected: LivePull[] = [];
  for (let i = 0; i < 25; i++) {
    const number = 201 + i;
    const scores = [file(P, `d${i}`, [block('B1', `h${i}`, (i * 7) % 100, [[38, 51]], 5 + i), block('B2', `g${i}`, (i * 13) % 100, [[60, 70]], 3)])];
    await savePullRequest(db, facts(number, -DAY + i * 60));
    const id = await scored(db, number, headOf(i), -2 * DAY, scores);
    await comment(db, number, `70${i}`, headOf(i), -2 * DAY + 100, { line: 65 });
    const last: LiveRun = { id, head: headOf(i), scores: storedScores(scores)! };
    const c: LiveComment = {
      id: `70${i}`, author: 'octo-guest', path: P, side: 'RIGHT', line: 65, startLine: null, fileLevel: false, commit: headOf(i), replyTo: null,
    };
    expected.push({ number, author: 'octo-dev', threshold: 70, last, atHead: new Map([[headOf(i), last]]), comments: [c], findingThreads: new Set() });
  }
  const h = harness(db);
  const q = await computeQuality(h.deps, 'acme/shop', 30, 70);
  assert.deepEqual(groupsRead(h).map((ids) => ids.length), [10, 10, 5]);
  const all = liveCases(expected);
  const rows: QualityRow[] = THRESHOLDS.map((x) => {
    const pulls = countAt(all.pulls, x);
    const labelled = countAt(all.labelled, x);
    return {
      threshold: x, current: x === 70,
      safetyBlocks: m(labelled.blocksLeft, labelled.blocks), safetyFiles: m(labelled.filesLeft, labelled.files),
      benefit: m(pulls.prsClear, pulls.prs), focus: m(pulls.flaggedLines, pulls.totalLines),
    };
  });
  assert.deepEqual(q.rows, rows);
  assert.equal(q.pullRequests, 25);
  assert.ok(rows.some((r) => r.benefit.part > 0 && r.benefit.part < 25) && rows.some((r) => r.focus.part > 0 && r.focus.part < r.focus.of));
  await db.close();
});

test("a pull request's runs are read with it in one statement, its last run and at most nine commented heads, never split across two", async () => {
  const db = await testDb();
  await savePullRequest(db, facts(302, -DAY));
  const first = await scored(db, 302, HEAD_A, -2 * DAY, one('dA', 'h1', 10));
  await savePullRequest(db, facts(301, -DAY - 60));
  const ids: number[] = [];
  for (let k = 1; k <= 12; k++) ids.push(await scored(db, 301, headOf(k), -10 * DAY + k * 3600, one(`d${k}`, `h${k}`, 50)));
  for (let k = 1; k <= 11; k++) await comment(db, 301, `71${k}`, headOf(k), -10 * DAY + k * 3600 + 100);
  await savePullRequest(db, facts(300, -DAY - 120));
  const last = await scored(db, 300, HEAD_A, -2 * DAY, one('dA', 'h1', 10));

  const h = harness(db);
  const q = await computeQuality(h.deps, 'acme/shop', 30, 70);
  const newest = ids.slice(2).reverse();
  assert.deepEqual(groupsRead(h), [[first], newest, [last]]);
  assert.equal(newest.length, QUALITY_GROUP);
  // Each of the nine heads read labels its block strictly; the two older heads fall back to the last run, never strictly.
  assert.deepEqual(rowAt(q, 70).safetyBlocks, m(9, 9));
  assert.deepEqual(rowAt(q, 70).safetyFiles, m(9, 9));
  assert.deepEqual(q.stepped, Array.from({ length: 9 }, () => ({ path: P, number: 301, score: 50 })));
  assert.equal(q.pullRequests, 3);
  await db.close();
});

test("a comment is read field by field: a side of no known name as none, a file level not written as false, a reply in the app's finding thread not counted", async () => {
  const db = await testDb();
  await savePullRequest(db, facts(150, -DAY));
  const blocks = (suffix: string): Array<Record<string, unknown>> => [file(P, `d${suffix}`, [
    block('B1', `h1${suffix}`, 50, [[38, 51]]), block('B2', `h2${suffix}`, 50, [[60, 70]]),
    block('B3', `h3${suffix}`, 50, [[80, 90]]), block('B4', `h4${suffix}`, 50, [[100, 110]]),
  ])];
  await scored(db, 150, HEAD_A, -3 * DAY, blocks('a'));
  const lastRun = await scored(db, 150, HEAD_B, -2 * DAY, blocks('b'));
  await recordComments(db, lastRun, refOf(150), [
    { commentId: '9001', path: P, side: 'RIGHT', line: 85, severity: 'major', quote: 'QUOTE-TEXT' },
    { commentId: '9002', path: P, side: 'RIGHT', line: 105, severity: 'note', quote: '', blockHash: 'h4b' },
  ]);
  await comment(db, 150, '7001', HEAD_A, -3 * DAY + 100, { side: 'MIDDLE' as Side, line: 40 });
  await comment(db, 150, '7002', HEAD_A, -3 * DAY + 110, { fileLevel: null, line: 65 });
  await comment(db, 150, '7003', HEAD_A, -3 * DAY + 120, { replyTo: '9001', line: 85 });
  await comment(db, 150, '7004', HEAD_A, -3 * DAY + 130, { replyTo: '9002', line: 105 });

  const h = harness(db);
  const q = await computeQuality(h.deps, 'acme/shop', 30, 70);
  // B1 (the side read as none, so the new side), B2 (a block, not the file only) and B4 (under a note); not B3.
  assert.deepEqual(rowAt(q, 70).safetyBlocks, m(3, 3));
  assert.deepEqual(q.stepped.length, 3);
  await db.close();
});

test('one computation runs at a time in the service, the same key is not queued twice, and a result is kept five minutes', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(119, -DAY));
  await scored(db, 119, HEAD_A, -2 * DAY, one('dA', 'h1', 50));
  await savePullRequest(db, { ...facts(120, -DAY), ref: refOf(120, 'web') });
  await recordRun(db, { ...runOf(120, HEAD_A, -2 * DAY, one('dA', 'h1', 50)), ref: refOf(120, 'web') });
  const h = harness(db);

  const [shop, web] = await Promise.all([quality(h.deps, 'acme/shop', days()), quality(h.deps, 'acme/web', days())]);
  assert.equal((shop as QualityAnswer).state, 'ready');
  assert.equal((web as QualityAnswer).quality!.repository, 'acme/web');
  const ofRepo = (repo: string): number[] => h.sent.flatMap((s, i) => (s.params[2] === repo ? [i] : []));
  const lastShop = Math.max(...ofRepo('shop'));
  const firstWeb = Math.min(...ofRepo('web'));
  assert.equal(kindOf(h.sent[lastShop]!.text), 'feedbackReasons');
  assert.equal(kindOf(h.sent[firstWeb]!.text), 'closedPulls');
  assert.ok(firstWeb > lastShop, 'the second began before the first ended');

  let from = h.sent.length;
  const twice = await Promise.all([quality(h.deps, 'acme/shop', days('7')), quality(h.deps, 'Acme/Shop', days('7'))]);
  assert.deepEqual(twice[0], twice[1]);
  assert.deepEqual(kinds(h, from).filter((k) => k === 'closedPulls'), ['closedPulls']);
  h.move(QUALITY_CACHE_MS / 1000 - 1);
  from = h.sent.length;
  assert.deepEqual(await quality(h.deps, 'acme/shop', days('7')), { ...(twice[0] as QualityAnswer), now: at(299) });
  assert.equal(h.sent.length, from);
  h.move(1);
  await ready(quality(h.deps, 'acme/shop', days('7')));
  assert.deepEqual(kinds(h, from).filter((k) => k === 'closedPulls'), ['closedPulls']);

  from = h.sent.length;
  h.use(configOf(AT_65));
  const changed = await ready(quality(h.deps, 'acme/shop', days('7')));
  assert.equal(changed.threshold, 65);
  assert.deepEqual(kinds(h, from).filter((k) => k === 'closedPulls'), ['closedPulls']);
  assert.equal(h.deps.quality.kept(qualityKey('Acme/Shop', 7, 65))?.state, 'ready');
  assert.equal(qualityKey('Acme/Shop', 'all', 65), 'acme/shop\nall\n65');
  await db.close();
});

test('a request waits ten seconds at most, then is answered computing, and the computation is kept when it ends', async (t) => {
  const db = await testDb();
  await savePullRequest(db, facts(119, -DAY));
  await scored(db, 119, HEAD_A, -2 * DAY, one('dA', 'h1', 50));
  const h = harness(db);
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  h.hook.before = async (text) => { if (kindOf(text) === 'closedPulls') await held; };

  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answered = false;
  const asked = quality(h.deps, 'acme/shop', days()).then((answer) => { answered = true; return answer; });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(QUALITY_WAIT_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answered, false);
  h.move(QUALITY_WAIT_MS / 1000);
  t.mock.timers.tick(1);
  assert.deepEqual(await asked, { now: at(10), state: 'computing', quality: null });
  t.mock.timers.reset();

  const key = qualityKey('acme/shop', 30, 70);
  assert.equal(h.deps.quality.kept(key), null);
  release();
  await settle(h, key);
  assert.equal(h.deps.quality.kept(key)?.state, 'ready');
  const from = h.sent.length;
  const next = await ready(quality(h.deps, 'acme/shop', days()));
  assert.equal(next.pullRequests, 1);
  assert.equal(h.sent.length, from);
  await db.close();
});

test('a failure is kept for a minute, answered failed, and logged with its code', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(119, -DAY));
  const h = harness(db);
  let failing = true;
  h.hook.before = (text) => { if (failing && kindOf(text) === 'closedPulls') throw new Error('db_down'); };
  assert.deepEqual(await quality(h.deps, 'acme/shop', days()), { now: at(0), state: 'failed', quality: null });
  assert.deepEqual(h.logs, [{ event: 'quality_failed', reason: 'db_down' }]);
  h.move(QUALITY_FAILED_MS / 1000 - 1);
  const from = h.sent.length;
  assert.deepEqual(await quality(h.deps, 'acme/shop', days()), { now: at(59), state: 'failed', quality: null });
  assert.equal(h.sent.length, from);
  h.move(1);
  failing = false;
  await ready(quality(h.deps, 'acme/shop', days()));
  assert.deepEqual(kinds(h, from)[0], 'closedPulls');
  assert.equal(h.logs.length, 1);
  await db.close();
});

test('a computation past sixty seconds stops as too slow', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(119, -DAY));
  await scored(db, 119, HEAD_A, -2 * DAY, one('dA', 'h1', 50));
  const h = harness(db);
  h.hook.before = (text) => { if (kindOf(text) === 'okRuns') h.move(QUALITY_DEADLINE_MS / 1000 + 1); };
  assert.deepEqual(await quality(h.deps, 'acme/shop', days()), { now: at(61), state: 'failed', quality: null });
  assert.deepEqual(h.logs, [{ event: 'quality_failed', reason: 'too_slow' }]);
  assert.deepEqual(kinds(h), ['closedPulls', 'inlineCommentsOf', 'okRuns']);
  const again = harness(db);
  again.hook.before = (text) => { if (kindOf(text) === 'okRuns') again.move(61); };
  await assert.rejects(computeQuality(again.deps, 'acme/shop', 30, 70), (error: Error) => error.message === 'too_slow');
  await db.close();
});

test('reverts and audits are counted, an audit needing a person when it was labelled strictly or reverted', async () => {
  const db = await testDb();
  const publish = (id: number, approved: boolean, approvalCode: string): Promise<boolean> =>
    markPublished(db, id, { reviewId: `r-${id}`, publishedAt: at(-DAY), body: 'BODY-TEXT', inlineDropped: false, approved, approvalCode });
  // #128: approved, the approval never withdrawn, later drawn for the audit; reverted by #130.
  await savePullRequest(db, facts(128, -5 * DAY));
  await publish(await scored(db, 128, HEAD_A, -6 * DAY, one('dA', 'h1', 10)), true, 'approved');
  await publish(await scored(db, 128, HEAD_B, -5.5 * DAY, one('dB', 'h1', 10)), false, 'audit_sample');
  await savePullRequest(db, facts(130, -DAY, { reverts: 128 }));
  // #129: drawn, and nothing came of it. #127: drawn, and a person stepped in on a block that changed after.
  await savePullRequest(db, facts(129, -4 * DAY));
  await publish(await scored(db, 129, HEAD_A, -4.5 * DAY, one('dA', 'h1', 10)), false, 'audit_sample');
  await savePullRequest(db, facts(127, -6 * DAY));
  await scored(db, 127, HEAD_A, -8 * DAY, one('dA', 'h1', 10));
  await publish(await scored(db, 127, HEAD_B, -7 * DAY, one('dB', 'h9', 10)), false, 'audit_sample');
  await comment(db, 127, '7001', HEAD_A, -8 * DAY + 100);
  // A revert merged before the window is not counted.
  await savePullRequest(db, facts(126, -40 * DAY, { reverts: 125 }));

  const h = harness(db);
  const q = await computeQuality(h.deps, 'acme/shop', 30, 70);
  assert.deepEqual(q.reverts, { merged: 1, approved: 1 });
  assert.deepEqual(q.audits, { drawn: 3, needed: 2 });
  const week = await computeQuality(h.deps, 'acme/shop', 7, 70);
  assert.deepEqual(week.reverts, { merged: 1, approved: 1 });
  await db.close();
});

test('a run whose scores cannot be read, or whose stored result is too large, leaves its pull request out, counted', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(140, -DAY));
  await scored(db, 140, HEAD_A, -2 * DAY, 'x');
  await savePullRequest(db, facts(142, -DAY));
  await scored(db, 142, HEAD_A, -2 * DAY, [file(P, 'dA', [{ ...block('B1', 'h1', 50, [[38, 51]]), lines: undefined }])]);
  await savePullRequest(db, facts(143, -DAY));
  await scored(db, 143, HEAD_A, -2 * DAY, null, { result: { findings: [] } });
  // #141: the newest run at the commented head cannot be read; the comment then labels the last run's file, never an older run at that head.
  await savePullRequest(db, facts(141, -DAY));
  await scored(db, 141, HEAD_B, -4 * DAY, one('dB', 'h1', 50));
  await scored(db, 141, HEAD_B, -3 * DAY, null, { result: { findings: [] } });
  await scored(db, 141, HEAD_C, -2 * DAY, one('dC', 'h9', 30));
  await comment(db, 141, '7001', HEAD_B, -3 * DAY + 100);

  const h = harness(db);
  const q = await computeQuality(h.deps, 'acme/shop', 30, 70);
  assert.equal(q.unreadable, 3);
  assert.equal(q.pullRequests, 1);
  assert.deepEqual(rowAt(q, 70).safetyBlocks, m(0, 0));
  assert.deepEqual(rowAt(q, 70).safetyFiles, m(0, 0));
  assert.deepEqual(rowAt(q, 70).benefit, m(1, 1));
  const small = await computeQuality(h.deps, 'acme/shop', 30, 70, { resultBytes: 10 });
  assert.equal(small.unreadable, 4);
  assert.equal(small.pullRequests, 0);
  assert.ok(QUALITY_RESULT_BYTES === 2 * 1024 * 1024);
  await db.close();
});

test('pull requests, comments and runs past their bounds are cut, and said so', async () => {
  const db = await testDb();
  for (let n = 1; n <= QUALITY_PULLS + 1; n++) await savePullRequest(db, facts(n, -2 * DAY + n * 60));
  await scored(db, QUALITY_PULLS + 1, HEAD_A, -3 * DAY, one('dA', 'h1', 10));
  await scored(db, 1, HEAD_A, -3 * DAY, one('dA', 'h1', 10));
  const h = harness(db);
  const q = await computeQuality(h.deps, 'acme/shop', 30, 70);
  assert.deepEqual(q.cut, { pulls: true, comments: false, runs: false });
  assert.equal(q.pullRequests, 1);
  const closed = h.sent.find((s) => kindOf(s.text) === 'closedPulls')!;
  assert.equal(closed.params[4], QUALITY_PULLS + 1);
  assert.equal((JSON.parse(h.sent.find((s) => kindOf(s.text) === 'okRuns')!.params[3] as string) as number[]).length, QUALITY_PULLS);
  await db.close();

  const few = await testDb();
  for (const n of [10, 11]) {
    await savePullRequest(few, facts(n, -DAY));
    await scored(few, n, HEAD_A, -2 * DAY, one('dA', 'h1', 10));
  }
  await comment(few, 10, '7001', HEAD_A, -2 * DAY + 100);
  await comment(few, 11, '7002', HEAD_A, -2 * DAY + 100);
  await comment(few, 11, '7003', HEAD_A, -2 * DAY + 200);
  const f = harness(few);
  const whole = await computeQuality(f.deps, 'acme/shop', 30, 70);
  assert.deepEqual([whole.cut, whole.pullRequests], [{ pulls: false, comments: false, runs: false }, 2]);
  assert.deepEqual((await computeQuality(f.deps, 'acme/shop', 30, 70, { comments: 2 })).cut, { pulls: false, comments: true, runs: false });
  const runs = await computeQuality(f.deps, 'acme/shop', 30, 70, { runs: 1 });
  assert.deepEqual([runs.cut, runs.pullRequests], [{ pulls: false, comments: false, runs: true }, 1]);
  const rows = await computeQuality(f.deps, 'acme/shop', 30, 70, { runRows: 1 });
  assert.deepEqual([rows.cut, rows.pullRequests], [{ pulls: false, comments: false, runs: true }, 1]);
  assert.ok(QUALITY_COMMENTS === 20_000 && QUALITY_RUN_ROWS === 10_000 && QUALITY_RUNS === 1000 && QUALITY_GROUP === 10);
  await few.close();
});

test('the window and the repository must be of their shape', async () => {
  const db = await testDb();
  const h = harness(db);
  for (const [value, window] of [[undefined, 30], ['', 30], ['30', 30], ['7', 7], ['90', 90], ['all', 'all']] as const) {
    const q = await ready(quality(h.deps, 'acme/shop', days(value)));
    assert.equal(q.window, window, String(value));
  }
  const from = h.sent.length;
  for (const value of ['0', '365', 'ALL', 'abc', ' 7', '7.0', '-7']) assert.equal(await quality(h.deps, 'acme/shop', days(value)), 'bad_request', value);
  for (const name of ['acme', 'acme/shop/x', '', 'acme/', '/shop', 'ac me/shop', `acme/${'s'.repeat(101)}`]) {
    assert.equal(await quality(h.deps, name, days()), 'bad_request', name);
  }
  assert.equal(h.sent.length, from);
  assert.equal((await ready(quality(h.deps, 'Acme/Shop', days()))).repository, 'acme/shop');
  const now = new Date(at(0));
  assert.equal(windowStart(now, 7), '2026-02-23T00:00:00.000Z');
  assert.equal(windowStart(now, 30), '2026-01-31T00:00:00.000Z');
  assert.equal(windowStart(now, 90), '2025-12-02T00:00:00.000Z');
  assert.equal(windowStart(now, 'all'), '1970-01-01T00:00:00.000Z');
  await db.close();
});

test('the repositories are those seen, by name', async () => {
  const db = await testDb();
  await savePullRequest(db, { ...facts(120, null), ref: refOf(120, 'web') });
  await savePullRequest(db, facts(119, null));
  await savePullRequest(db, facts(121, null));
  const h = harness(db);
  assert.deepEqual(await repositories(h.deps), { now: at(0), repositories: ['acme/shop', 'acme/web'] });
  await db.close();
});

test('the automatic approval in short is read from the settings in force', async () => {
  const db = await testDb();
  const h = harness(db);
  assert.deepEqual(approvalShort(h.deps, 'acme/shop'), { enabled: false, threads: 'strict', auditShare: 5 });
  h.use(configOf('repositories:\n  overrides:\n    acme/web: { score: { autoApprove: true, approvalThreads: gate, auditShare: 10 } }\nauditKey: { env: AUDIT }\n'));
  assert.deepEqual(approvalShort(h.deps, 'Acme/Web'), { enabled: true, threads: 'gate', auditShare: 10 });
  await db.close();
});

test('at most a hundred are kept, the oldest put dropped first', async () => {
  const cache = createQualityCache({ clock: () => new Date(at(0)), log: () => {} });
  const made = (repository: string): Quality => ({
    repository, window: 30, threshold: 70, pullRequests: 0, unreadable: 0, cut: { pulls: false, comments: false, runs: false }, rows: [], stepped: [], ...NOTHING,
  });
  let computed = 0;
  const measure = (key: string): Promise<unknown> => cache.measure(key, async () => { computed += 1; return made(key); }, 1000);
  for (let i = 0; i <= QUALITY_KEPT; i++) assert.deepEqual(await measure(`k${i}`), { state: 'ready', quality: made(`k${i}`) });
  assert.equal(computed, QUALITY_KEPT + 1);
  assert.equal(cache.kept('k0'), null);
  assert.deepEqual(cache.kept('k1'), { state: 'ready', quality: made('k1') });
  assert.equal(cache.kept(`k${QUALITY_KEPT}`)?.state, 'ready');
  await measure('k-new');
  assert.equal(cache.kept('k1'), null);
  assert.equal(cache.kept('k2')?.state, 'ready');
  assert.equal(computed, QUALITY_KEPT + 2);
});

test('the quality of a repository is measured through the cache at its threshold in force', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(119, -DAY));
  await scored(db, 119, HEAD_A, -2 * DAY, one('dA', 'h1', 50));
  const h = harness(db, configOf(AT_65));
  const got = await qualityOf(h.deps, 'Acme/Shop', 90, QUALITY_WAIT_MS);
  assert.equal(got.state, 'ready');
  assert.deepEqual(h.deps.quality.kept(qualityKey('acme/shop', 90, 65)), got);
  assert.equal(got.state === 'ready' ? got.quality.threshold : null, 65);
  await db.close();
});

// The keys of each answer, held to api-types.ts by the type check.
const KEYS = (shape: object): string[] => Object.keys(shape).sort();
const keysOf = (value: object): string[] => Object.keys(value).sort();
const ANSWER: Record<keyof QualityAnswer, true> = { now: true, state: true, quality: true };
const QUALITY: Record<keyof Quality, true> = {
  repository: true, window: true, threshold: true, pullRequests: true, unreadable: true, cut: true, rows: true, stepped: true, reverts: true,
  audits: true, feedback: true,
};
const CUT: Record<keyof Quality['cut'], true> = { pulls: true, comments: true, runs: true };
const ROW: Record<keyof QualityRow, true> = { threshold: true, current: true, safetyBlocks: true, safetyFiles: true, benefit: true, focus: true };
const MEASURE: Record<keyof Measure, true> = { share: true, part: true, of: true };
const STEPPED: Record<keyof SteppedBlock, true> = { path: true, number: true, score: true };
const REVERTS: Record<keyof Quality['reverts'], true> = { merged: true, approved: true };
const AUDITS: Record<keyof Quality['audits'], true> = { drawn: true, needed: true };
const FEEDBACK: Record<keyof Quality['feedback'], true> = { helpful: true, notHelpful: true, reasons: true };
const REASON: Record<keyof Quality['feedback']['reasons'][number], true> = { reason: true, count: true };
const REPOSITORIES: Record<keyof Repositories, true> = { now: true, repositories: true };

test('an answer holds no field the screens do not show', async () => {
  const db = await testDb();
  await savePullRequest(db, facts(119, -DAY));
  await scored(db, 119, HEAD_A, -3 * DAY, one('dA', 'h1', 55));
  const lastRun = await scored(db, 119, HEAD_B, -2 * DAY, one('dB', 'h9', 80));
  await markPublished(db, lastRun, { reviewId: 'r-77', publishedAt: at(-2 * DAY), body: 'BODY-TEXT', inlineDropped: false });
  await recordComments(db, lastRun, refOf(119), [{ commentId: '9001', path: P, side: 'RIGHT', line: 40, severity: 'major', quote: 'QUOTE-TEXT' }]);
  await comment(db, 119, '7001', HEAD_A, -3 * DAY + 100);
  await recordFeedback(db, { run: lastRun, login: 'octo-guest', vote: 'down', reason: 'Repeats a settled thread', extension: 'example', at: at(-DAY) });
  const h = harness(db);
  const answer = await quality(h.deps, 'acme/shop', days()) as QualityAnswer;
  const q = answer.quality!;
  assert.deepEqual(keysOf(answer), KEYS(ANSWER));
  assert.deepEqual(keysOf(q), KEYS(QUALITY));
  assert.deepEqual(keysOf(q.cut), KEYS(CUT));
  assert.equal(q.rows.length, 4);
  for (const r of q.rows) {
    assert.deepEqual(keysOf(r), KEYS(ROW));
    for (const part of [r.safetyBlocks, r.safetyFiles, r.benefit, r.focus]) assert.deepEqual(keysOf(part), KEYS(MEASURE));
  }
  assert.equal(q.stepped.length, 1);
  for (const s of q.stepped) assert.deepEqual(keysOf(s), KEYS(STEPPED));
  assert.deepEqual(keysOf(q.reverts), KEYS(REVERTS));
  assert.deepEqual(keysOf(q.audits), KEYS(AUDITS));
  assert.deepEqual(keysOf(q.feedback), KEYS(FEEDBACK));
  assert.deepEqual(q.feedback.reasons, [{ reason: 'Repeats a settled thread', count: 1 }]);
  for (const r of q.feedback.reasons) assert.deepEqual(keysOf(r), KEYS(REASON));
  const listed = await repositories(h.deps);
  assert.deepEqual(keysOf(listed), KEYS(REPOSITORIES));
  const text = JSON.stringify([answer, listed]);
  for (const secret of [
    'COMMENT-TEXT', 'REASON-TEXT', 'QUOTE-TEXT', 'octo-guest', 'octo-dev', 'BODY-TEXT', 'OVERVIEW-TEXT', 'SUMMARY-TEXT', '7001', '9001', 'r-77', 'h9', 'dB',
    HEAD_A, HEAD_B,
  ]) assert.ok(!text.includes(secret), `the answer holds ${secret}`);
  assert.ok(REASONS_SHOWN === 5 && STEPPED_SHOWN === 20 && QUALITY_KEPT === 100);
  await db.close();
});
