import test from 'node:test';
import assert from 'node:assert/strict';
import type { Usage } from '../engine/types.ts';
import type { PullRequestRef } from '../forge/types.ts';
import type { Asked, JudgeInput } from './judge.ts';
import { JUDGE_ATTEMPTS, JUDGE_FAILURES, JUDGE_REPLIES, JUDGE_STRANGERS, LESSONS_PER_RUN, runNight } from './night.ts';
import type { Judged, NightDeps, NightLesson, NightReply, NightStore, NightVerdict } from './night.ts';

const REF: PullRequestRef = { service: 'github', owner: 'acme', repo: 'shop', number: 7 };
const REPO = { service: 'github', owner: 'acme', repo: 'shop' };
const PATH = 'src/cart/cache.ts';
const NOW = '2026-03-10T00:05:00.000Z';
const REPLY_AT = '2026-03-09T14:00:00.000Z';
const BODY = 'The cache is cleared by the caller on every write, so a stale read cannot happen here.';
const QUOTE = 'cleared by the caller on every write';
const LESSON = 'A stale read finding on the cart cache is wrong: its callers clear it on every write.';
const FINDING_TEXT = 'This read can return a stale cart after a write.';
const USAGE: Usage = { calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, cost: 0.25 };

/** A reply by ana (a member) under the finding c-1 of acme/shop 7. */
const reply = (over: Partial<NightReply> = {}): NightReply => ({
  ref: REF, reply: 'r-1', association: 'member', body: BODY, at: REPLY_AT,
  finding: 'c-1', path: PATH, side: 'RIGHT', line: 12, severity: 'major', findingText: FINDING_TEXT, attempts: 0, ...over,
});
const pushback = (): Asked => ({ ok: true, value: { classification: 'valid_pushback', lesson: LESSON, quote: QUOTE }, usage: { ...USAGE } });
const failed = (code: 'timeout'): Asked => ({ ok: false, code, usage: { ...USAGE } });

type Seen = Array<[string, ...unknown[]]>;

/** A store in memory that hands out `replies` (at most the limit asked) and records every call, in order. */
function storeOf(replies: NightReply[], over: { made?: number; later?: (finding: string) => string | null; standing?: string[] } = {}): { store: NightStore; seen: Seen } {
  const seen: Seen = [];
  const store: NightStore = {
    replies: async (since, before, limit, maxAttempts) => {
      seen.push(['replies', since, before, limit, maxAttempts]);
      return replies.slice(0, limit);
    },
    lessonsMadeSince: async (since) => {
      seen.push(['lessonsMadeSince', since]);
      return over.made ?? 0;
    },
    laterVerdict: async (ref, finding, after) => {
      seen.push(['laterVerdict', ref, finding, after]);
      return over.later?.(finding) ?? null;
    },
    standingLessons: async (repo, at, limit) => {
      seen.push(['standingLessons', repo, at, limit]);
      return over.standing ?? [];
    },
    noteVerdict: async (v: NightVerdict, call: Usage | null, lesson: NightLesson | null) => {
      seen.push(['noteVerdict', v, call, lesson]);
    },
    noteCall: async (ref, replyId, at, usage) => {
      seen.push(['noteCall', ref, replyId, at, usage]);
    },
  };
  return { store, seen };
}

/** Deps whose judge answers from `answers` in turn, and records each reply and input it is asked with. */
function depsOf(answers: Asked[], over: Partial<NightDeps> = {}): { deps: NightDeps; asked: Array<{ reply: string; input: JudgeInput }>; usage: unknown[] } {
  const asked: Array<{ reply: string; input: JudgeInput }> = [];
  const usage: unknown[] = [];
  const deps: NightDeps = {
    clock: () => new Date(NOW),
    ask: async (r, input) => {
      asked.push({ reply: r.reply, input });
      const a = answers[asked.length - 1];
      if (a === undefined) throw new Error('asked once too often');
      return a;
    },
    paused: async () => null,
    noteUsage: (u) => usage.push(u),
    ...over,
  };
  return { deps, asked, usage };
}

const judged = (over: Partial<Judged> = {}): Judged =>
  ({ judged: 0, lessons: 0, givenUp: 0, failed: 0, calls: 0, cost: 0, more: false, end: 'done', complete: true, ...over });
const names = (seen: Seen): string[] => seen.map(([name]) => name);

test('the constants of a night are those of the service', () => {
  assert.deepEqual([JUDGE_REPLIES, JUDGE_STRANGERS, JUDGE_ATTEMPTS, LESSONS_PER_RUN, JUDGE_FAILURES], [100, 20, 3, 10, 3]);
});

test('a night judges the replies its store hands it, writes each verdict with its call, and makes a lesson from a valid pushback', async () => {
  const { store, seen } = storeOf([reply()]);
  const { deps, asked, usage } = depsOf([pushback()]);
  assert.deepEqual(await runNight(store, deps), judged({ judged: 1, lessons: 1, calls: 1, cost: 0.25 }));
  assert.deepEqual(asked, [{ reply: 'r-1', input: { path: PATH, severity: 'major', finding: FINDING_TEXT, reply: BODY } }]);
  assert.deepEqual(usage, [{ inputTokens: 100, outputTokens: 10, cost: 0.25 }]);
  assert.deepEqual(names(seen), ['replies', 'lessonsMadeSince', 'laterVerdict', 'standingLessons', 'noteVerdict']);
  assert.deepEqual(seen[2], ['laterVerdict', REF, 'c-1', REPLY_AT]);
  assert.deepEqual(seen[3], ['standingLessons', REPO, NOW, 1_000]);
  const verdict: NightVerdict = { ref: REF, reply: 'r-1', finding: 'c-1', classification: 'valid_pushback', outcome: 'lesson', attempts: 0, judgedAt: NOW };
  // Live from the 00:00 UTC that follows the reply, for 90 days.
  const lesson: NightLesson = {
    sourceRef: '7:r-1', number: 7, path: PATH, directory: 'src/cart', quote: QUOTE, reply: 'r-1', text: LESSON,
    createdAt: '2026-03-10T00:00:00.000Z', expiresAt: '2026-06-08T00:00:00.000Z',
  };
  assert.deepEqual(seen[4], ['noteVerdict', verdict, USAGE, lesson]);
});

test('the night asks the store with its day, the 90 days before it, the queue size and the attempts', async () => {
  const { store, seen } = storeOf([]);
  const { deps, asked } = depsOf([]);
  assert.deepEqual(await runNight(store, deps), judged());
  assert.deepEqual(asked, []);
  assert.deepEqual(seen, [
    ['replies', '2025-12-10T00:00:00.000Z', '2026-03-10T00:00:00.000Z', 101, 3],
    ['lessonsMadeSince', '2026-03-10T00:00:00.000Z'],
  ]);
  const small = storeOf([]);
  await runNight(small.store, depsOf([], { replies: 4 }).deps);
  assert.deepEqual(small.seen[0], ['replies', '2025-12-10T00:00:00.000Z', '2026-03-10T00:00:00.000Z', 5, 3]);
});

test('the night stops at ten lessons, counting those made since its day began', async () => {
  const { store, seen } = storeOf([reply(), reply({ reply: 'r-2', finding: 'c-2' })], { made: 9 });
  const { deps, asked } = depsOf([pushback(), pushback()]);
  assert.deepEqual(await runNight(store, deps), judged({ judged: 1, lessons: 1, calls: 1, cost: 0.25, more: true, end: 'lesson_cap' }));
  assert.deepEqual(asked.map((a) => a.reply), ['r-1']);
  assert.deepEqual(names(seen), ['replies', 'lessonsMadeSince', 'laterVerdict', 'standingLessons', 'noteVerdict']);
  // Ten already made today: no reply is asked about.
  const full = storeOf([reply()], { made: 10 });
  const none = depsOf([]);
  assert.deepEqual(await runNight(full.store, none.deps), judged({ more: true, end: 'lesson_cap' }));
  assert.deepEqual(none.asked, []);
  assert.deepEqual(names(full.seen), ['replies', 'lessonsMadeSince']);
});

test('a later review that kept the finding open, and a lesson that restates a standing one, make no lesson', async () => {
  const replies = [reply(), reply({ reply: 'r-2', finding: 'c-2' })];
  const { store, seen } = storeOf(replies, { later: (finding) => (finding === 'c-1' ? 'open' : null), standing: [LESSON] });
  const { deps } = depsOf([pushback(), pushback()]);
  assert.deepEqual(await runNight(store, deps), judged({ judged: 2, calls: 2, cost: 0.5 }));
  assert.deepEqual(names(seen), ['replies', 'lessonsMadeSince', 'laterVerdict', 'noteVerdict', 'laterVerdict', 'standingLessons', 'noteVerdict']);
  const written = seen.filter(([name]) => name === 'noteVerdict').map(([, v, call, lesson]) => [(v as NightVerdict).reply, (v as NightVerdict).outcome, call, lesson]);
  assert.deepEqual(written, [['r-1', 'review_disagreed', USAGE, null], ['r-2', 'restates', USAGE, null]]);
});

test('three failures at the provider in a row end the night with that code, and their usage is noted', async () => {
  const replies = ['r-1', 'r-2', 'r-3', 'r-4'].map((id, i) => reply({ reply: id, finding: `c-${i + 1}` }));
  const { store, seen } = storeOf(replies);
  const { deps, asked, usage } = depsOf([failed('timeout'), failed('timeout'), failed('timeout')]);
  assert.deepEqual(await runNight(store, deps), judged({ failed: 3, calls: 3, cost: 0.75, more: true, end: 'timeout', complete: false }));
  assert.deepEqual(asked.map((a) => a.reply), ['r-1', 'r-2', 'r-3']);
  assert.equal(usage.length, 3);
  assert.deepEqual(seen.slice(2), ['r-1', 'r-2', 'r-3'].map((id) => ['noteCall', REF, id, NOW, USAGE]));
});
