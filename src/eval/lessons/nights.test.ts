import assert from 'node:assert/strict';
import test from 'node:test';

import type { Usage } from '../../engine/types.ts';
import type { Asked } from '../../memory/judge.ts';
import { JUDGE_ATTEMPTS, JUDGE_STRANGERS, LESSONS_PER_RUN } from '../../memory/night.ts';
import type { NightReply } from '../../memory/night.ts';
import type { ExportedFinding, ExportedLater, ExportedReply, FindingsFile } from './findings.ts';
import { simulateNights } from './nights.ts';
import type { SimAsk, Simulated } from './nights.ts';

const PATH = 'src/billing/tax.ts';
const BODY = 'We round half up here on purpose, as the invoices require it.';
const QUOTE = 'round half up here on purpose';
const LESSON = 'A rounding finding on invoice totals is wrong: invoices round half up on purpose.';
const USAGE: Usage = { calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, cost: 0.25 };
const DAY_MS = 86_400_000;
const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
const pad = (i: number): string => String(i).padStart(2, '0');

let order = 0;
/** A reply by a member, under the finding it is put in; `order` grows with each reply made. */
const reply = (id: string, at: string, over: Partial<ExportedReply> = {}): ExportedReply =>
  ({ id, order: (order += 1), association: 'member', body: BODY, at, ...over });
/** The finding c-1 of acme/shop 7 on src/billing/tax.ts, with `replies`. */
const finding = (replies: ExportedReply[], over: Partial<ExportedFinding> = {}): ExportedFinding => ({
  repo: 'acme/shop', pr_number: 7, run: { id: 1, head_sha: 'h1', base_sha: 'b1', started_at: '2026-02-27T10:00:00.000Z' },
  comment_id: 'c-1', path: PATH, side: 'RIGHT', line: 12, severity: 'major', finding: 'Rounds before the discount is taken off.',
  replies, later: [], ...over,
});
const fileOf = (exportedAt: string, findings: ExportedFinding[]): FindingsFile => ({ exported_at: exportedAt, findings });
const later = (run: number, startedAt: string, publishedAt: string | null, verdict = 'open'): ExportedLater =>
  ({ run, started_at: startedAt, published_at: publishedAt, verdict });

const pushback = (lesson = LESSON, quote = QUOTE): Asked => ({ ok: true, value: { classification: 'valid_pushback', lesson, quote }, usage: { ...USAGE } });
const noise = (): Asked => ({ ok: true, value: { classification: 'noise', lesson: null, quote: null }, usage: { ...USAGE } });
const unjudged = (): Asked => ({ ok: false, code: 'invalid_output', usage: { ...USAGE, calls: 2, cost: 0.5 } });
const failed = (code: 'rate_limited'): Asked => ({ ok: false, code, usage: { ...USAGE, calls: 0, cost: 0 } });

/** A judge that answers by `answer` (its argument: the number of the call, 0 first) and records the reply of each call. */
function askOf(answer: (i: number, r: NightReply) => Asked): { ask: SimAsk; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (r) => {
      asked.push(r.reply);
      return answer(asked.length - 1, r);
    },
  };
}
const never = (): string | null => null;
const outcomes = (sim: Simulated): Array<[string, string | null, string, number, string]> =>
  sim.verdicts.map((v) => [v.reply, v.classification, v.outcome, v.attempts, v.night]);

test('the nights run from the day after the first reply to the day of the export', async () => {
  const file = fileOf('2026-03-06T09:00:00.000Z', [
    finding([reply('r-1', '2026-03-04T10:00:00.000Z')]),
    finding([reply('r-2', '2026-03-01T10:00:00.000Z')], { comment_id: 'c-2' }),
  ]);
  const { ask, asked } = askOf(() => noise());
  const sim = await simulateNights(file, ask, never);
  assert.equal(sim.nights, 5);
  assert.equal(sim.first_night, '2026-03-02T00:00:00.000Z');
  assert.equal(sim.last_night, '2026-03-06T00:00:00.000Z');
  assert.equal(sim.complete, true);
  assert.equal(sim.end, null);
  assert.deepEqual(asked, ['r-2', 'r-1']);
  assert.deepEqual(outcomes(sim), [
    ['r-2', 'noise', 'none', 0, '2026-03-02T00:00:00.000Z'],
    ['r-1', 'noise', 'none', 0, '2026-03-05T00:00:00.000Z'],
  ]);
  assert.deepEqual(sim.verdicts.map((v) => [v.repo, v.number, v.finding]), [['acme/shop', 7, 'c-2'], ['acme/shop', 7, 'c-1']]);
  assert.deepEqual([sim.judged, sim.given_up, sim.failed, sim.calls, sim.cost, sim.waiting], [2, 0, 0, 2, 0.5, 0]);

  // No reply: no night, and nothing left undone.
  const none = await simulateNights(fileOf('2026-03-06T09:00:00.000Z', [finding([])]), ask, never);
  assert.deepEqual(none, {
    complete: true, end: null, nights: 0, first_night: null, last_night: null, waiting: 0,
    verdicts: [], lessons: [], judged: 0, given_up: 0, failed: 0, calls: 0, cost: 0,
  });
  assert.equal((await simulateNights(fileOf('2026-03-06T09:00:00.000Z', []), ask, never)).nights, 0);
});

test('a reply waits for the night after its day, and a reply of the export day is left waiting', async () => {
  const file = fileOf('2026-03-06T09:00:00.000Z', [finding([
    reply('r-1', '2026-03-05T23:59:59.999Z'),
    reply('r-2', '2026-03-06T08:00:00.000Z'),
  ])]);
  const { ask, asked } = askOf(() => noise());
  const sim = await simulateNights(file, ask, never);
  assert.equal(sim.nights, 1);
  assert.deepEqual(asked, ['r-1']);
  assert.deepEqual(outcomes(sim), [['r-1', 'noise', 'none', 0, '2026-03-06T00:00:00.000Z']]);
  assert.equal(sim.waiting, 1);
  assert.equal(sim.complete, true);

  // A reply written at the night's 00:00 is of that day: the night before it does not take it.
  const edge = await simulateNights(fileOf('2026-03-06T09:00:00.000Z', [finding([
    reply('r-1', '2026-03-05T10:00:00.000Z'),
    reply('r-2', '2026-03-06T00:00:00.000Z'),
  ])]), askOf(() => noise()).ask, never);
  assert.deepEqual(edge.verdicts.map((v) => v.reply), ['r-1']);
  assert.equal(edge.waiting, 1);
});

test('a later review counts at a night only when its run started after the reply and was published before the night', async () => {
  const at = '2026-03-02T12:00:00.000Z';
  const run = async (exportedAt: string, kept: ExportedLater[], answer: (i: number) => Asked): Promise<Simulated> =>
    simulateNights(fileOf(exportedAt, [finding([reply('r-1', at)], { later: kept })]), askOf(answer).ask, never);

  // Published after the night of 03-03 began: that night makes a lesson.
  const early = await run('2026-03-03T09:00:00.000Z', [later(2, '2026-03-03T10:00:00.000Z', '2026-03-03T10:00:00.000Z')], () => pushback());
  assert.deepEqual(outcomes(early), [['r-1', 'valid_pushback', 'lesson', 0, '2026-03-03T00:00:00.000Z']]);
  assert.deepEqual(early.lessons.map((l) => [l.ref, l.madeAt]), [['7:r-1', '2026-03-03T00:00:00.000Z']]);

  // An answer with no verdict at 03-03, a verdict at 03-04: by then the later review is published, and it disagrees.
  const next = await run('2026-03-04T09:00:00.000Z', [later(2, '2026-03-03T10:00:00.000Z', '2026-03-03T10:00:00.000Z')], (i) => (i === 0 ? unjudged() : pushback()));
  assert.deepEqual(outcomes(next), [['r-1', 'valid_pushback', 'review_disagreed', 1, '2026-03-04T00:00:00.000Z']]);
  assert.deepEqual(next.lessons, []);

  // Started before the night of 03-04 and published after it began: not read at that night.
  const late = await run('2026-03-04T09:00:00.000Z', [later(2, '2026-03-03T23:50:00.000Z', '2026-03-04T00:10:00.000Z')], (i) => (i === 0 ? unjudged() : pushback()));
  assert.deepEqual(outcomes(late), [['r-1', 'valid_pushback', 'lesson', 1, '2026-03-04T00:00:00.000Z']]);
  assert.deepEqual(late.lessons.map((l) => [l.ref, l.createdAt, l.madeAt]), [['7:r-1', '2026-03-03T00:00:00.000Z', '2026-03-04T00:00:00.000Z']]);

  // Started at the reply's time, or never published: not read.
  const neither = await run('2026-03-03T09:00:00.000Z', [
    later(2, at, '2026-03-02T12:30:00.000Z', 'fixed'),
    later(3, '2026-03-02T13:00:00.000Z', null, 'open'),
  ], () => pushback());
  assert.deepEqual(outcomes(neither).map((o) => o[2]), ['lesson']);

  // Of the runs that count, the one with the highest id says: answered over an older fixed is no disagreement, and the reverse is.
  const newest = await run('2026-03-03T09:00:00.000Z', [
    later(2, '2026-03-02T14:00:00.000Z', '2026-03-02T14:30:00.000Z', 'fixed'),
    later(3, '2026-03-02T13:00:00.000Z', '2026-03-02T15:00:00.000Z', 'answered'),
  ], () => pushback());
  assert.deepEqual(outcomes(newest).map((o) => o[2]), ['lesson']);
  const reverse = await run('2026-03-03T09:00:00.000Z', [
    later(3, '2026-03-02T13:00:00.000Z', '2026-03-02T15:00:00.000Z', 'fixed'),
    later(2, '2026-03-02T14:00:00.000Z', '2026-03-02T14:30:00.000Z', 'answered'),
  ], () => pushback());
  assert.deepEqual(outcomes(reverse).map((o) => o[2]), ['review_disagreed']);
});

test('the queue takes people with access first, then by time, and at most twenty strangers a night', async () => {
  // 25 strangers early in the day, the odd ones under a second finding; two members late in the day, at one time,
  // listed against the order they were stored in.
  const strangers = Array.from({ length: 25 }, (_, i) => reply(`s-${pad(i)}`, plus('2026-03-01T01:00:00.000Z', i * 60_000), { association: i < 3 ? null : 'none' }));
  const m0 = reply('m-0', '2026-03-01T23:00:00.000Z', { association: 'owner' });
  const m1 = reply('m-1', '2026-03-01T23:00:00.000Z', { association: 'collaborator' });
  const file = fileOf('2026-03-03T09:00:00.000Z', [
    finding([...strangers.filter((_, i) => i % 2 === 0), m1, m0]),
    finding(strangers.filter((_, i) => i % 2 === 1), { comment_id: 'c-2' }),
  ]);
  const { ask, asked } = askOf(() => noise());
  const sim = await simulateNights(file, ask, never);
  assert.equal(JUDGE_STRANGERS, 20);
  assert.deepEqual(asked, ['m-0', 'm-1', ...Array.from({ length: 25 }, (_, i) => `s-${pad(i)}`)]);
  const night = new Map(sim.verdicts.map((v) => [v.reply, v.night]));
  assert.deepEqual([...night.values()].filter((n) => n === '2026-03-02T00:00:00.000Z').length, 22);
  for (const id of ['s-20', 's-21', 's-22', 's-23', 's-24']) assert.equal(night.get(id), '2026-03-03T00:00:00.000Z', id);
  assert.equal(sim.judged, 27);
  assert.equal(sim.complete, true);
});

test('ten lessons end a night and the rest wait for the next', async () => {
  const file = fileOf('2026-03-03T09:00:00.000Z', [finding(Array.from({ length: 12 }, (_, i) => reply(`r-${pad(i)}`, plus('2026-03-01T10:00:00.000Z', i * 60_000))))]);
  const { ask, asked } = askOf((i) => pushback(`Note ${i}: a tax line here may round on purpose.`));
  const sim = await simulateNights(file, ask, never);
  assert.equal(LESSONS_PER_RUN, 10);
  assert.equal(asked.length, 12);
  assert.equal(sim.lessons.length, 12);
  assert.equal(sim.lessons.filter((l) => l.madeAt === '2026-03-02T00:00:00.000Z').length, 10);
  assert.deepEqual(sim.lessons.slice(10).map((l) => [l.ref, l.madeAt]), [['7:r-10', '2026-03-03T00:00:00.000Z'], ['7:r-11', '2026-03-03T00:00:00.000Z']]);
  const first = sim.lessons[0]!;
  assert.deepEqual(first, {
    ref: '7:r-00', repo: 'acme/shop', number: 7, reply: 'r-00', path: PATH, text: 'Note 0: a tax line here may round on purpose.',
    createdAt: '2026-03-02T00:00:00.000Z', madeAt: '2026-03-02T00:00:00.000Z', expiresAt: plus('2026-03-02T00:00:00.000Z', 90 * DAY_MS),
  });
  assert.equal(sim.complete, true);
  assert.equal(sim.end, null);
  assert.equal(sim.waiting, 0);
});

test('an answer with no verdict is asked again the next night, and the third retires the reply', async () => {
  const file = fileOf('2026-03-05T09:00:00.000Z', [finding([reply('r-1', '2026-03-01T10:00:00.000Z')])]);
  const { ask, asked } = askOf(() => unjudged());
  const sim = await simulateNights(file, ask, never);
  assert.equal(sim.nights, 4);
  assert.equal(asked.length, JUDGE_ATTEMPTS);
  assert.deepEqual(outcomes(sim), [['r-1', null, 'unjudged', 3, '2026-03-04T00:00:00.000Z']]);
  assert.deepEqual([sim.given_up, sim.failed, sim.calls, sim.cost, sim.waiting], [1, 3, 6, 1.5, 0]);
  assert.equal(sim.complete, true);
});

test('a failure at the provider ends the simulation after its night, incomplete, with its code', async () => {
  const file = fileOf('2026-03-05T09:00:00.000Z', [finding([reply('r-1', '2026-03-01T10:00:00.000Z'), reply('r-2', '2026-03-01T11:00:00.000Z')])]);
  const { ask, asked } = askOf((i) => (i === 0 ? failed('rate_limited') : noise()));
  const sim = await simulateNights(file, ask, never);
  assert.deepEqual(asked, ['r-1', 'r-2']);
  assert.equal(sim.complete, false);
  assert.equal(sim.end, 'rate_limited');
  assert.equal(sim.nights, 1);
  assert.equal(sim.last_night, '2026-03-02T00:00:00.000Z');
  assert.deepEqual(outcomes(sim), [['r-2', 'noise', 'none', 0, '2026-03-02T00:00:00.000Z']]);
  assert.deepEqual([sim.failed, sim.waiting], [1, 1]);

  // A night the failures end on its own ends the simulation with the night's end.
  const auth = await simulateNights(file, askOf(() => ({ ok: false, code: 'auth', usage: { ...USAGE, calls: 0, cost: 0 } })).ask, never);
  assert.deepEqual([auth.complete, auth.end, auth.nights, auth.waiting], [false, 'auth', 1, 2]);
});

test('a spend limit stops the simulation incomplete', async () => {
  const file = fileOf('2026-03-05T09:00:00.000Z', [finding([reply('r-1', '2026-03-01T10:00:00.000Z'), reply('r-2', '2026-03-01T11:00:00.000Z')])]);
  let n = 0;
  const { ask, asked } = askOf(() => noise());
  const sim = await simulateNights(file, ask, () => (n++ === 0 ? null : 'spend_limit'));
  assert.deepEqual(asked, ['r-1']);
  assert.deepEqual([sim.complete, sim.end, sim.nights, sim.waiting], [false, 'spend_limit', 1, 1]);

  // Any other reason reviews do not start is the model's.
  const other = await simulateNights(file, askOf(() => noise()).ask, () => 'model_unset');
  assert.deepEqual([other.complete, other.end, other.nights, other.waiting], [false, 'model_error', 1, 2]);
});

test('a lesson stands only in its own repository, its name compared in lower case, until it expires', async () => {
  const file = fileOf('2026-05-31T09:00:00.000Z', [
    finding([reply('r-1', '2026-03-01T10:00:00.000Z')], { repo: 'Acme/Shop' }),
    finding([reply('r-2', '2026-03-02T10:00:00.000Z')], { repo: 'acme/web', pr_number: 8, comment_id: 'c-2' }),
    finding([
      reply('r-3', '2026-03-02T11:00:00.000Z'),
      reply('r-4', '2026-05-29T10:00:00.000Z'),   // judged 05-30, before r-1's lesson expires at 05-31
      reply('r-5', '2026-05-30T10:00:00.000Z'),   // judged 05-31, as it expires
    ], { pr_number: 9, comment_id: 'c-3' }),
  ]);
  const sim = await simulateNights(file, askOf(() => pushback()).ask, never);
  assert.equal(sim.complete, true);
  assert.deepEqual(sim.verdicts.map((v) => [v.reply, v.repo, v.outcome]), [
    ['r-1', 'acme/shop', 'lesson'],
    ['r-2', 'acme/web', 'lesson'],
    ['r-3', 'acme/shop', 'restates'],
    ['r-4', 'acme/shop', 'restates'],
    ['r-5', 'acme/shop', 'lesson'],
  ]);
  assert.deepEqual(sim.lessons.map((l) => [l.ref, l.repo, l.expiresAt]), [
    ['7:r-1', 'acme/shop', '2026-05-31T00:00:00.000Z'],
    ['8:r-2', 'acme/web', '2026-06-01T00:00:00.000Z'],
    ['9:r-5', 'acme/shop', '2026-08-29T00:00:00.000Z'],
  ]);
});

test('a note is never judged, and a reply whose time or repository cannot be read refuses the file', async () => {
  const notes = fileOf('2026-03-05T09:00:00.000Z', [finding([reply('r-1', '2026-03-01T10:00:00.000Z')], { severity: 'note' })]);
  const { ask, asked } = askOf(() => noise());
  const sim = await simulateNights(notes, ask, never);
  assert.deepEqual([sim.nights, sim.waiting, asked.length], [0, 0, 0]);
  await assert.rejects(simulateNights(fileOf('2026-03-05T09:00:00.000Z', [finding([reply('r-1', 'yesterday')])]), ask, never), { message: 'bad_findings_time' });
  await assert.rejects(simulateNights(fileOf('soon', [finding([reply('r-1', '2026-03-01T10:00:00.000Z')])]), ask, never), { message: 'bad_findings_time' });
  await assert.rejects(simulateNights(fileOf('2026-03-05T09:00:00.000Z', [finding([], { repo: 'shop' })]), ask, never), { message: 'bad_findings_repo' });
});
