import test from 'node:test';
import assert from 'node:assert/strict';
import type { StoredRun } from '../db/review-runs.ts';
import { isDue } from '../engine/context/threads.ts';
import type { ReviewThread, ThreadComment } from '../forge/types.ts';
import { earlierOf, missedComments } from './earlier.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const USAGE = { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 };
const BODY = 'Check the total.';
const run = (over: Partial<StoredRun> & { verdicts?: unknown; result?: unknown } = {}): StoredRun => {
  const { verdicts, result, ...rest } = over;
  const base = result ?? {
    findings: [{ path: 'src/a.ts', side: 'RIGHT', line: 12, severity: 'major', body: 'x', quote: 'total = a + b', requestedLine: null }],
    scores: [{ path: 'src/a.ts', diffHash: 'd1' }],
  };
  return {
    id: 1, ref: REF, job: 1, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'b1', baseBranch: null,
    outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 1,
    body: '', comments: [{ path: 'src/a.ts', side: 'RIGHT', line: 12, body: BODY }],
    result: verdicts === undefined ? base : { ...(base as object), threadVerdicts: verdicts },
    usage: USAGE, startedAt: '2026-03-01T10:00:00.000Z', finishedAt: '2026-03-01T10:01:00.000Z',
    published: true, reviewId: '401', publishedAt: '2026-03-01T10:02:00.000Z', inlineDropped: false, publishTriedAt: null, ...rest,
  };
};
const STORED = { commentId: '8001', path: 'src/a.ts', side: 'RIGHT' as const, line: 12, severity: 'major', quote: 'total = a + b', run: 1 };
const ROOT: ThreadComment = { id: '8001', node: 'N1', author: 'visto-test', authorIsBot: true, byApp: true, reviewId: '401', body: BODY, at: '2026-03-01T10:02:00.000Z' };
const reply = (author: string, over: Partial<ThreadComment> = {}): ThreadComment =>
  ({ id: '9000', node: 'N2', author, authorIsBot: false, byApp: false, reviewId: null, body: 'Meant to be so.', at: '2026-03-01T11:00:00.000Z', ...over });
const thread = (over: Partial<ReviewThread> = {}): ReviewThread =>
  ({ id: 'PRRT_1', path: 'src/a.ts', side: 'RIGHT', line: 12, resolved: false, resolvedByApp: false, comments: [ROOT], ...over });
const args = (threads: ReviewThread[], over: Partial<{ runs: StoredRun[]; stored: Array<typeof STORED> }> = {}) =>
  ({ last: run(), runs: over.runs ?? [run()], stored: over.stored ?? [STORED], threads });

test("a stored finding's thread is handed on with where it was opened and what was said", () => {
  const t = thread({ comments: [ROOT, reply('octo-dev'), reply('visto-test', { byApp: true, authorIsBot: true }), reply('helper-bot', { authorIsBot: true })] });
  assert.deepEqual(earlierOf({ last: run(), runs: [run()], stored: [STORED], threads: [t] }), {
    head: 'h1',
    threads: [{
      id: 'PRRT_1', commentId: '8001', path: 'src/a.ts', side: 'RIGHT', line: 12, severity: 'major', quote: 'total = a + b', body: ROOT.body,
      openedAt: { head: 'h1', diffHash: 'd1' }, resolved: false, settled: false, lastVerdict: null,
      replies: [{ author: 'octo-dev', kind: 'person', body: 'Meant to be so.' }, { author: 'visto-test', kind: 'app', body: 'Meant to be so.' }, { author: 'helper-bot', kind: 'bot', body: 'Meant to be so.' }],
    }],
  });
});
test("a thread the database does not hold is not the reviewer's", () => {
  assert.deepEqual(earlierOf(args([thread({ comments: [{ ...ROOT, id: '7777' }] })])).threads, []);
});
test('a thread is settled only when it is resolved and the app resolved it or a person replied', () => {
  const settled = (over: Partial<ReviewThread>) => earlierOf(args([thread(over)])).threads[0]!.settled;
  assert.deepEqual([
    settled({ resolved: true }),
    settled({ resolved: true, resolvedByApp: true }),
    settled({ resolved: true, comments: [ROOT, reply('octo-dev')] }),
    settled({ resolved: false, comments: [ROOT, reply('octo-dev')] }),
    settled({ resolved: true, comments: [ROOT, reply('helper-bot', { authorIsBot: true })] }),
  ], [false, false, true, false, false]);
});
test("the app resolved it only when the thread also holds the app's own reply with a marker", () => {
  const settled = (over: Partial<ReviewThread>) => earlierOf(args([thread(over)])).threads[0]!.settled;
  const MARKED = 'Answered.\n\n<!-- visto-ai: review=402 head=h2 -->';
  assert.deepEqual([
    settled({ resolved: true, resolvedByApp: true }),
    settled({ resolved: true, resolvedByApp: true, comments: [ROOT, reply('visto-test', { byApp: true, authorIsBot: true, body: MARKED })] }),
    // not the app's: another bot under the same login (a person's reply settles the thread on its own, so a bot shows the rule alone)
    settled({ resolved: true, resolvedByApp: true, comments: [ROOT, reply('visto-test', { authorIsBot: true, body: MARKED })] }),
    settled({ resolved: true, resolvedByApp: true, comments: [ROOT, reply('visto-test', { byApp: true, authorIsBot: true, body: 'Answered.' })] }),
    settled({ resolved: true, resolvedByApp: false, comments: [ROOT, reply('visto-test', { byApp: true, authorIsBot: true, body: MARKED })] }),
  ], [false, true, false, false, false]);
});
test('with replies not settling, only a thread the app resolved with its hidden line is settled', () => {
  const MARKED = 'Answered.\n\n<!-- visto-ai: review=402 head=h2 -->';
  const byApp = reply('visto-test', { byApp: true, authorIsBot: true, body: MARKED });
  const cases: Array<Partial<ReviewThread>> = [
    { resolved: true, comments: [ROOT, reply('octo-dev')] },
    { resolved: true, resolvedByApp: true, comments: [ROOT, byApp] },
    { resolved: true, resolvedByApp: true, comments: [ROOT, reply('octo-dev'), byApp] },
    { resolved: true, resolvedByApp: true, comments: [ROOT, reply('octo-dev')] },
    { resolved: false, resolvedByApp: false, comments: [ROOT, byApp, reply('octo-dev')] },
  ];
  const settled = (over: Partial<ReviewThread>, replySettles?: boolean) =>
    earlierOf({ ...args([thread(over)]), ...(replySettles === undefined ? {} : { replySettles }) }).threads[0]!.settled;
  assert.deepEqual(cases.map((c) => settled(c, false)), [false, true, true, false, false]);
  // replySettles absent, or true: today's answer
  assert.deepEqual(cases.map((c) => settled(c)), [true, true, true, true, false]);
  assert.deepEqual(cases.map((c) => settled(c, true)), [true, true, true, true, false]);
});
test('a thread listed twice is handed on once, as first listed', () => {
  const out = earlierOf(args([thread(), thread({ line: 99 })]));
  assert.deepEqual(out.threads.map((t) => [t.id, t.line]), [['PRRT_1', 12]]);
});
test('the newest published verdict on a thread is its last verdict', () => {
  const runs = [
    run({ id: 1 }),
    run({ id: 2, verdicts: [{ threadId: 'PRRT_1', verdict: 'fixed' }] }),
    run({ id: 3, verdicts: [{ threadId: 'PRRT_1', verdict: 'open' }] }),
    run({ id: 4, published: false, verdicts: [{ threadId: 'PRRT_1', verdict: 'answered' }] }),
    run({ id: 5, verdicts: [{ threadId: 'PRRT_OTHER', verdict: 'fixed' }] }),
  ];
  assert.equal(earlierOf({ ...args([thread()]), runs }).threads[0]!.lastVerdict, 'open');
  const skipped = [run({ id: 2, verdicts: [{ threadId: 'PRRT_1', verdict: 'fixed' }] }), run({ id: 3 })];
  assert.equal(earlierOf({ ...args([thread()]), runs: skipped }).threads[0]!.lastVerdict, 'fixed');
});
test('a run that is gone, or has no score for the file, leaves the place of opening unknown', () => {
  assert.deepEqual(earlierOf(args([thread()], { stored: [{ ...STORED, run: 99 }] })).threads[0]!.openedAt, { head: '', diffHash: null });
  assert.deepEqual(earlierOf(args([thread()], { runs: [run({ result: { findings: [], scores: [] } })] })).threads[0]!.openedAt, { head: 'h1', diffHash: null });
  assert.deepEqual(earlierOf(args([thread()], { runs: [run({ result: 'not an object' })] })).threads[0]!.openedAt, { head: 'h1', diffHash: null });
});
test('threads come in the order their findings were posted', () => {
  const stored = [{ ...STORED, commentId: '10' }, { ...STORED, commentId: '9' }];
  const out = earlierOf(args([
    thread({ id: 'T10', comments: [{ ...ROOT, id: '10' }] }),
    thread({ id: 'T9', comments: [{ ...ROOT, id: '9' }] }),
  ], { stored }));
  assert.deepEqual(out.threads.map((t) => t.id), ['T9', 'T10']);
});
test('a posted comment the read-back missed is tied to its finding from the thread itself', () => {
  assert.deepEqual(missedComments({ runs: [run()], stored: [], threads: [thread()] }), [{ ...STORED, line: 12 }]);
  assert.deepEqual(missedComments({ runs: [run()], stored: [STORED], threads: [thread()] }), []);
  assert.deepEqual(missedComments({ runs: [run()], stored: [], threads: [thread({ comments: [{ ...ROOT, reviewId: '999' }] })] }), []);
  assert.deepEqual(missedComments({ runs: [run()], stored: [], threads: [thread({ comments: [{ ...ROOT, body: 'edited by hand' }] })] }), []);
});

const NOTE_ROOT: ThreadComment = { ...ROOT, id: '8002', node: 'N3', body: '**Human review:** lines 12-40, 85% `calculation`' };
test('a note is not an earlier thread', () => {
  const note = { commentId: '8002', path: 'src/a.ts', side: 'RIGHT' as const, line: 12, severity: 'note', quote: '', blockHash: 'h1', run: 1 };
  const out = earlierOf({ last: run(), runs: [run()], stored: [STORED, note], threads: [thread(), thread({ id: 'PRRT_2', comments: [NOTE_ROOT] })] });
  assert.deepEqual(out.threads.map((t) => t.id), ['PRRT_1']);
});
test('a note the database missed is repaired as a note', () => {
  const withNote = run({ comments: [{ path: 'src/a.ts', side: 'RIGHT', line: 12, body: BODY }, { path: 'src/a.ts', side: 'RIGHT', line: 12, body: NOTE_ROOT.body, note: 'h1' }] });
  assert.deepEqual(missedComments({ runs: [withNote], stored: [STORED], threads: [thread(), thread({ id: 'PRRT_2', comments: [NOTE_ROOT] })] }),
    [{ commentId: '8002', path: 'src/a.ts', side: 'RIGHT', line: 12, severity: 'note', quote: '', blockHash: 'h1', run: 1 }]);
});

const MARKED = 'Answered.\n\n<!-- visto-ai: review=402 head=h2 -->';
const appMarked = (): ThreadComment => reply('visto-test', { id: '9002', byApp: true, authorIsBot: true, body: MARKED });
const STRICT = { rule: 'strict' as const, author: 'octo-dev', clearByReply: true };
const GATE_RULE = { rule: 'gate' as const, author: 'octo-dev', clearByReply: true };
/** Threads T1, T2, ... whose first comments 8001, 8002, ... are stored majors of run 1. */
const numbered = (overs: Array<Partial<ReviewThread>>) => {
  const threads = overs.map((over, i) => thread({ id: `T${i + 1}`, ...over, comments: [{ ...ROOT, id: String(8001 + i) }, ...(over.comments ?? [])] }));
  const stored = overs.map((_, i) => ({ ...STORED, commentId: String(8001 + i) }));
  return { threads, stored };
};

test('with approval on under the strict rule, a thread the author replied to and resolved is not settled, and is due', () => {
  const t = thread({ resolved: true, comments: [ROOT, reply('octo-dev', { association: 'member' })] });
  const off = earlierOf(args([t])).threads[0]!;
  assert.equal(off.settled, true);
  assert.equal(isDue(off), false);
  const on = earlierOf({ ...args([t]), approval: STRICT }).threads[0]!;
  assert.deepEqual([on.resolved, on.settled, on.closedForApproval], [true, false, false]);
  assert.equal(isDue(on), true);
  // A member who is not the author, in the same thread: settled again, and not due.
  const member = earlierOf({ ...args([thread({ resolved: true, comments: [ROOT, reply('octo-dev'), reply('octo-lead', { id: '9001', association: 'member' })] })]), approval: STRICT }).threads[0]!;
  assert.deepEqual([member.settled, member.closedForApproval, isDue(member)], [true, true, false]);
});
test('under the gate rule for approval with clearing by reply off, a thread a person replied to and resolved is not settled, and is due', () => {
  const t = thread({ resolved: true, comments: [ROOT, reply('octo-dev')] });
  for (const replySettles of [undefined, true]) {
    const gated = replySettles === undefined ? {} : { replySettles };
    assert.equal(earlierOf({ ...args([t]), ...gated }).threads[0]!.settled, true);
    const on = earlierOf({ ...args([t]), ...gated, approval: { ...GATE_RULE, clearByReply: false } }).threads[0]!;
    assert.deepEqual([on.settled, on.closedForApproval], [false, false], String(replySettles));
    assert.equal(isDue(on), true);
  }
  // With clearing by reply on it is closed, and settled as today.
  const replyOn = earlierOf({ ...args([t]), approval: GATE_RULE }).threads[0]!;
  assert.deepEqual([replyOn.settled, replyOn.closedForApproval, isDue(replyOn)], [true, true, false]);
});
test('with approval off the earlier state is what it was', () => {
  const runs = [run({ id: 1 }), run({ id: 2, verdicts: [{ threadId: 'T2', verdict: 'fixed', fileChanged: true }, { threadId: 'T3', verdict: 'answered' }] })];
  const { threads, stored } = numbered([
    {},
    { resolved: true, resolvedByApp: true, comments: [appMarked()] },
    { resolved: true, resolvedByApp: true, comments: [appMarked(), reply('octo-dev')] },
    { resolved: true, comments: [reply('octo-dev'), reply('octo-lead', { id: '9001', association: 'member' })] },
    { resolved: true },
    { resolved: false, comments: [reply('octo-guest', { association: 'none' })] },
  ]);
  for (const replySettles of [undefined, true, false]) {
    const base = { last: run(), runs, stored, threads, ...(replySettles === undefined ? {} : { replySettles }) };
    const before = earlierOf(base);
    assert.deepEqual(earlierOf({ ...base, approval: undefined }), before);
    assert.equal(before.threads.length, 6);
    for (const t of before.threads) assert.equal('closedForApproval' in t, false, t.id);
  }
});
test('under the gate rule for approval each thread carries whether it was closed for approval', () => {
  const runs = [run({ id: 1 }), run({ id: 2, verdicts: [{ threadId: 'T2', verdict: 'fixed', fileChanged: false }, { threadId: 'T5', verdict: 'open' }, { threadId: 'T6', verdict: 'answered' }] })];
  const { threads, stored } = numbered([
    { resolved: true, comments: [reply('octo-dev')] },                                   // a person replied: closed
    { resolved: true, resolvedByApp: true, comments: [appMarked()] },                   // the app resolved it after a fixed: closed
    { resolved: false, comments: [reply('octo-dev')] },                                 // not resolved
    { resolved: true },                                                                 // resolved, no reply
    { resolved: true, resolvedByApp: true, comments: [appMarked()] },                   // the app resolved it, the newest verdict open
    { resolved: true, resolvedByApp: true, comments: [appMarked()] },                   // the app resolved it after an answered: closed
    { resolved: true, comments: [reply('helper-bot', { authorIsBot: true })] },         // a bot replied
  ]);
  const out = earlierOf({ last: run(), runs, stored, threads, approval: GATE_RULE });
  assert.deepEqual(out.threads.map((t) => [t.id, t.settled, t.closedForApproval]), [
    ['T1', true, true], ['T2', true, true], ['T3', false, false], ['T4', false, false], ['T5', false, false], ['T6', true, true], ['T7', false, false],
  ]);
  // The same threads under the strict rule: only the app's resolve after a fixed on a changed file, or a reply with access, would close one.
  const strict = earlierOf({ last: run(), runs, stored, threads, approval: STRICT });
  assert.deepEqual(strict.threads.map((t) => t.closedForApproval), [false, false, false, false, false, false, false]);
});
test("with the gate's clearing by reply off and the strict rule, a thread is settled only when both accept it", () => {
  const runs = [run({ id: 1 }), run({ id: 2, verdicts: [
    { threadId: 'T1', verdict: 'fixed', fileChanged: true },
    { threadId: 'T2', verdict: 'fixed', fileChanged: true },
    { threadId: 'T3', verdict: 'answered', fileChanged: false },
  ] })];
  const member = reply('octo-lead', { id: '9001', association: 'member' });
  const { threads, stored } = numbered([
    { resolved: true, resolvedByApp: true, comments: [appMarked()] },                    // both accept it
    { resolved: true, resolvedByApp: true },                                             // strict accepts it; no marked reply of the app's, so today's rule does not
    { resolved: true, resolvedByApp: true, comments: [appMarked()] },                    // today's rule accepts it; an answered verdict, so the strict rule does not
    { resolved: true, comments: [member] },                                              // strict accepts it; replies do not settle, so today's rule does not
    { resolved: true, resolvedByApp: true, comments: [appMarked(), member] },            // both accept it
    { resolved: true, comments: [reply('octo-dev')] },                                   // neither
  ]);
  const out = earlierOf({ last: run(), runs, stored, threads, replySettles: false, approval: { ...STRICT, clearByReply: false } });
  assert.deepEqual(out.threads.map((t) => [t.id, t.settled, t.closedForApproval]), [
    ['T1', true, true], ['T2', false, true], ['T3', false, false], ['T4', false, true], ['T5', true, true], ['T6', false, false],
  ]);
  assert.deepEqual(out.threads.filter(isDue).map((t) => t.id), ['T2', 'T3', 'T4', 'T6']);
  // Without approval only today's rule decides.
  assert.deepEqual(earlierOf({ last: run(), runs, stored, threads, replySettles: false }).threads.map((t) => t.settled), [true, false, true, false, true, false]);
});
