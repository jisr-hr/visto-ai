import test from 'node:test';
import assert from 'node:assert/strict';
import type { StoredComment } from '../db/review-comments.ts';
import type { StoredRun } from '../db/review-runs.ts';
import type { ReviewThread, ThreadComment } from '../forge/types.ts';
import { evaluateGate, refusedInline, reviewedRun } from './rule.ts';

type Stored = StoredComment & { run: number };

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const USAGE = { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 };
const MARKER = '<!-- visto-ai: review=501 head=h1 -->';

/** A published run at h1 against b1 whose result says it read src/a.ts. `verdicts` sets its threadVerdicts. */
const run = (id: number, over: Partial<StoredRun> & { verdicts?: unknown } = {}): StoredRun => {
  const { verdicts, ...rest } = over;
  return {
    id, ref: REF, job: id, trigger: 'manual', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'b1', baseBranch: 'main',
    outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 1, body: '', comments: [],
    result: { findings: [], coverage: { reviewed: ['src/a.ts'], notReviewed: [] }, threadVerdicts: verdicts ?? [] },
    usage: USAGE, startedAt: '2026-03-01T10:00:00.000Z', finishedAt: '2026-03-01T10:01:00.000Z',
    published: true, reviewId: String(400 + id), publishedAt: '2026-03-01T10:02:00.000Z', inlineDropped: false, publishTriedAt: null, ...rest,
  };
};
const verdict = (verdict: string, over: Record<string, unknown> = {}) =>
  ({ threadId: 'PRRT_1', commentId: '8001', verdict, reply: '', fileChanged: true, ...over });

const appComment = (id: string, over: Partial<ThreadComment> = {}): ThreadComment =>
  ({ id, node: `N${id}`, author: 'visto-test[bot]', authorIsBot: true, byApp: true, reviewId: '401', body: '**[major]** Check the total.', at: '2026-03-01T10:02:00.000Z', ...over });
const reply = (author: string, over: Partial<ThreadComment> = {}): ThreadComment =>
  ({ id: '9001', node: 'N9001', author, authorIsBot: false, byApp: false, reviewId: null, body: 'Meant to be so.', at: '2026-03-01T11:00:00.000Z', ...over });
const appReply = (over: Partial<ThreadComment> = {}): ThreadComment => reply('visto-test[bot]', { id: '9002', authorIsBot: true, byApp: true, ...over });
const botReply = (): ThreadComment => reply('helper-bot', { id: '9003', authorIsBot: true });
const deletedReply = (): ThreadComment => reply('ghost', { id: '9004', authorIsBot: true });

/** An open thread of the app at src/a.ts line 12 whose first comment is 8001. */
const thread = (over: Partial<ReviewThread> = {}): ReviewThread =>
  ({ id: 'PRRT_1', path: 'src/a.ts', side: 'RIGHT', line: 12, resolved: false, resolvedByApp: false, comments: [appComment('8001')], ...over });
const stored = (commentId: string, severity: string, over: Partial<Stored> = {}): Stored =>
  ({ commentId, path: 'src/a.ts', side: 'RIGHT', line: 12, severity, quote: 'total = a + b', run: 1, ...over });
const STORED: Stored[] = [stored('8001', 'major')];

const gate = (over: { threads?: ReviewThread[]; stored?: Stored[]; runs?: StoredRun[]; reviewed?: StoredRun; clearByReply?: boolean } = {}) => {
  const reviewed = over.reviewed ?? run(1);
  return evaluateGate({
    threads: over.threads ?? [thread()], stored: over.stored ?? STORED, runs: over.runs ?? [reviewed],
    reviewed, clearByReply: over.clearByReply ?? true,
  });
};

test('a thread a person opened never blocks, whatever its text says', () => {
  const t = thread({ comments: [reply('octo-dev', { id: '8001', body: '**[major]** x' })] });
  const v = gate({ threads: [t] });
  assert.deepEqual(v.blocking, []);
  assert.equal(v.findings, 0);
});

test('an open major or blocker of the app blocks; a minor and a note never do', () => {
  const threads = [
    thread({ id: 'T4', comments: [appComment('8004')] }),
    thread({ id: 'T3', comments: [appComment('8003')] }),
    thread({ id: 'T2', comments: [appComment('8002')], line: 20 }),
    thread({ id: 'T1', comments: [appComment('8001')] }),
  ];
  const v = gate({ threads, stored: [stored('8001', 'minor'), stored('8002', 'blocker'), stored('8003', 'note'), stored('8004', 'major')] });
  assert.deepEqual(v.blocking, [
    { thread: 'T2', commentId: '8002', path: 'src/a.ts', line: 20, severity: 'blocker', why: 'open', unread: false },
    { thread: 'T4', commentId: '8004', path: 'src/a.ts', line: 12, severity: 'major', why: 'open', unread: false },
  ]);
  assert.equal(v.findings, 3);
  assert.equal(v.clearedByReview, 0);
  assert.equal(v.clearedByReply, 0);
});

test("a fixed or answered verdict of the head's review clears the thread, resolved or not", () => {
  for (const word of ['fixed', 'answered']) {
    for (const resolved of [false, true]) {
      const v = gate({ reviewed: run(1, { verdicts: [verdict(word)] }), threads: [thread({ resolved })] });
      assert.deepEqual(v.blocking, [], `${word} ${resolved}`);
      assert.equal(v.clearedByReview, 1);
      assert.equal(v.findings, 1);
    }
  }
});

test('the verdict of a review of another head, of another base, of an unpublished run or of a dry run clears nothing', () => {
  const fixed = { verdicts: [verdict('fixed')] };
  assert.equal(reviewedRun([run(5, { ...fixed, headSha: 'h0' })], 'h1', 'b1'), null);
  assert.equal(reviewedRun([run(5, { ...fixed, baseSha: 'b0' })], 'h1', 'b1'), null);
  assert.equal(reviewedRun([run(5, { ...fixed, baseSha: null })], 'h1', 'b1'), null);
  assert.equal(reviewedRun([run(5, { ...fixed, published: false })], 'h1', 'b1'), null);
  assert.equal(reviewedRun([run(5, { ...fixed, dryRun: true })], 'h1', 'b1'), null);
  const head = run(2);
  const older = run(1, { ...fixed, headSha: 'h0' });
  assert.equal(reviewedRun([older, head], 'h1', 'b1'), head);
  const v = gate({ runs: [older, head], reviewed: head });
  assert.equal(v.blocking.length, 1);
  assert.equal(v.clearedByReview, 0);
});

test("of two published reviews of the head the newer is the head's review, also when it kept no verdict", () => {
  const older = run(1, { verdicts: [verdict('fixed')] });
  const newer = run(2, { mode: 'recheck' });
  assert.equal(reviewedRun([newer, older], 'h1', 'b1'), newer);
  assert.equal(reviewedRun([older, newer], 'h1', 'b1'), newer);
  const v = gate({ runs: [older, newer], reviewed: newer });
  assert.equal(v.blocking.length, 1);
  assert.equal(v.blocking[0]!.why, 'open');
});

test('a verdict clears nothing once someone other than the app wrote in the thread after it was judged', () => {
  const judged = run(1, { verdicts: [verdict('answered', { replies: 1 })] });
  const later = gate({ reviewed: judged, threads: [thread({ comments: [appComment('8001'), reply('octo-dev'), reply('octo-dev', { id: '9005' })] })] });
  assert.equal(later.blocking.length, 1);
  assert.equal(later.clearedByReview, 0);
  const byApp = gate({ reviewed: judged, threads: [thread({ comments: [appComment('8001'), reply('octo-dev'), appReply()] })] });
  assert.equal(byApp.blocking.length, 0);
  assert.equal(byApp.clearedByReview, 1);
  const byBot = gate({ reviewed: judged, threads: [thread({ comments: [appComment('8001'), reply('octo-dev'), botReply()] })] });
  assert.equal(byBot.blocking.length, 1);
  const noField = gate({
    reviewed: run(1, { verdicts: [verdict('answered')] }),
    threads: [thread({ comments: [appComment('8001'), reply('octo-dev'), reply('octo-dev', { id: '9005' })] })],
  });
  assert.equal(noField.blocking.length, 0);
  assert.equal(noField.clearedByReview, 1);
});

test('a thread the app resolved after clearing it stays cleared at a later head', () => {
  const earlier = run(1, { headSha: 'h0', verdicts: [verdict('fixed')] });
  const head = run(2);
  const v = gate({ runs: [earlier, head], reviewed: head, threads: [thread({ resolved: true, resolvedByApp: true })] });
  assert.deepEqual(v.blocking, []);
  assert.equal(v.clearedByReview, 1);
});

test('a thread named as resolved by the app blocks when its newest verdict is open or it has none', () => {
  const t = thread({ resolved: true, resolvedByApp: true });
  const earlier = run(1, { headSha: 'h0', verdicts: [verdict('fixed')] });
  const reopened = run(2, { headSha: 'h0b', verdicts: [verdict('open')] });
  const head = run(3);
  const open = gate({ runs: [earlier, reopened, head], reviewed: head, threads: [t] });
  assert.deepEqual(open.blocking.map((b) => b.why), ['resolved_no_reply']);
  const none = gate({ runs: [head], reviewed: head, threads: [t] });
  assert.deepEqual(none.blocking.map((b) => b.why), ['resolved_no_reply']);
  const unpublished = gate({ runs: [run(4, { headSha: 'h0', published: false, verdicts: [verdict('fixed')] }), head], reviewed: head, threads: [t] });
  assert.deepEqual(unpublished.blocking.map((b) => b.why), ['resolved_no_reply']);
});

test('a resolved thread with a reply by a person clears, whoever resolved it and whenever the reply was written', () => {
  const v = gate({ threads: [thread({ resolved: true, comments: [appComment('8001'), reply('octo-dev', { at: '2026-02-01T10:00:00.000Z' })] })] });
  assert.deepEqual(v.blocking, []);
  assert.equal(v.clearedByReply, 1);
  assert.equal(v.clearedByReview, 0);
});

test('a resolve with no reply, a reply with no resolve, and a reply by a bot or a deleted account clear nothing', () => {
  const silent = gate({ threads: [thread({ resolved: true })] });
  assert.deepEqual(silent.blocking.map((b) => b.why), ['resolved_no_reply']);
  assert.equal(silent.silentResolves, 1);
  const unresolved = gate({ threads: [thread({ comments: [appComment('8001'), reply('octo-dev')] })] });
  assert.deepEqual(unresolved.blocking.map((b) => b.why), ['open']);
  assert.equal(unresolved.silentResolves, 0);
  for (const r of [botReply(), deletedReply(), appReply()]) {
    const v = gate({ threads: [thread({ resolved: true, comments: [appComment('8001'), r] })] });
    assert.deepEqual(v.blocking.map((b) => b.why), ['resolved_no_reply']);
    assert.equal(v.clearedByReply, 0);
  }
});

test('with clearing by reply off only a review clears', () => {
  const answered = thread({ resolved: true, comments: [appComment('8001'), reply('octo-dev')] });
  const off = gate({ threads: [answered], clearByReply: false });
  assert.deepEqual(off.blocking.map((b) => b.why), ['resolved_reply_off']);
  assert.equal(off.clearedByReply, 0);
  assert.equal(off.silentResolves, 1);
  const verified = gate({ threads: [answered], clearByReply: false, reviewed: run(1, { verdicts: [verdict('answered', { replies: 1 })] }) });
  assert.deepEqual(verified.blocking, []);
  assert.equal(verified.clearedByReview, 1);
});

test("the app's own thread with no stored finding blocks as unknown, and clears like any other", () => {
  const v = gate({ stored: [] });
  assert.deepEqual(v.blocking, [{ thread: 'PRRT_1', commentId: '8001', path: 'src/a.ts', line: 12, severity: 'unknown', why: 'open', unread: false }]);
  assert.equal(v.unknownThreads, 1);
  assert.equal(v.findings, 1);
  const other = gate({ stored: [], reviewed: run(1, { result: { findings: [], coverage: { reviewed: ['src/b.ts'] } } }) });
  assert.equal(other.blocking[0]!.unread, false);
  const cleared = gate({ stored: [], threads: [thread({ resolved: true, comments: [appComment('8001'), reply('octo-dev')] })] });
  assert.deepEqual(cleared.blocking, []);
  assert.equal(cleared.clearedByReply, 1);
  assert.equal(cleared.unknownThreads, 0);
  assert.equal(cleared.findings, 1);
});

test("a thread whose file the head's review did not read is told apart", () => {
  const readB = run(1, { result: { findings: [], coverage: { reviewed: ['src/b.ts'], notReviewed: [] }, threadVerdicts: [] } });
  assert.equal(gate({ reviewed: readB }).blocking[0]!.unread, true);
  assert.equal(gate({ reviewed: run(1) }).blocking[0]!.unread, false);
  const openVerdict = run(1, { result: { findings: [], coverage: { reviewed: ['src/b.ts'] }, threadVerdicts: [verdict('open')] } });
  assert.equal(gate({ reviewed: openVerdict }).blocking[0]!.unread, false);
  assert.equal(gate({ reviewed: run(1, { result: { findings: [], coverage: 'x', threadVerdicts: [] } }) }).blocking[0]!.unread, false);
  assert.equal(gate({ reviewed: run(1, { result: { findings: [], coverage: { reviewed: 5 } } }) }).blocking[0]!.unread, false);
  assert.equal(gate({ reviewed: run(1, { result: 'x' }) }).blocking[0]!.unread, false);
  const cleared = gate({ reviewed: readB, threads: [thread({ resolved: true, comments: [appComment('8001'), reply('octo-dev')] })] });
  assert.deepEqual(cleared.blocking, []);
  assert.equal(cleared.clearedByReply, 1);
  const off = gate({ reviewed: readB, clearByReply: false, threads: [thread({ resolved: true, comments: [appComment('8001'), reply('octo-dev')] })] });
  assert.deepEqual(off.blocking.map((b) => [b.why, b.unread]), [['resolved_reply_off', true]]);
});

test('the hidden line clears nothing by itself', () => {
  const inReply = thread({ id: 'T1', comments: [appComment('8001'), reply('octo-dev', { body: `Done.\n\n${MARKER}` })] });
  const inFirst = thread({ id: 'T2', comments: [appComment('8002', { body: `**[major]** Check the total.\n\n${MARKER}` })] });
  const v = gate({ threads: [inReply, inFirst], stored: [stored('8001', 'major'), stored('8002', 'major')] });
  assert.deepEqual(v.blocking.map((b) => b.thread), ['T1', 'T2']);
});

test('a review posted without its inline comments counts its major and blocker findings, and a later re-check of the head does not undo it', () => {
  const f = (severity: string) => ({ path: 'src/a.ts', side: 'RIGHT', line: 12, severity, body: 'x', quote: 'y', requestedLine: null });
  const refused = (id: number, over: Partial<StoredRun> = {}, findings: unknown = [f('major'), f('blocker'), f('minor')]) =>
    run(id, { inlineDropped: true, result: { findings, coverage: { reviewed: ['src/a.ts'] } }, ...over });
  assert.equal(refusedInline([refused(1)], 'h1', 'b1'), 2);
  assert.equal(refusedInline([refused(1), run(2, { mode: 'recheck' })], 'h1', 'b1'), 2);
  assert.equal(refusedInline([refused(1, {}, [f('minor')])], 'h1', 'b1'), 0);
  assert.equal(refusedInline([refused(1, { inlineDropped: false })], 'h1', 'b1'), 0);
  assert.equal(refusedInline([refused(1, { headSha: 'h0' })], 'h1', 'b1'), 0);
  assert.equal(refusedInline([refused(1, { baseSha: 'b0' })], 'h1', 'b1'), 0);
  assert.equal(refusedInline([refused(1, { published: false })], 'h1', 'b1'), 0);
  assert.equal(refusedInline([refused(1, { dryRun: true })], 'h1', 'b1'), 0);
  assert.equal(refusedInline([refused(1, {}, 'x')], 'h1', 'b1'), 0);
  assert.equal(refusedInline([refused(1, { result: 'x' })], 'h1', 'b1'), 0);
  assert.equal(refusedInline([], 'h1', 'b1'), 0);
  assert.equal(refusedInline([refused(1), refused(3, {}, [f('blocker')]), refused(2, {}, [f('minor')])], 'h1', 'b1'), 1);
  assert.equal(refusedInline([refused(1), refused(2, {}, [f('minor')])], 'h1', 'b1'), 2);
  assert.equal(refusedInline([refused(1, {}, [f('major'), 5, null, { severity: 'critical' }])], 'h1', 'b1'), 1);
});

test('the counts of a mixed pull request', () => {
  const head = run(2);
  const earlier = run(1, { headSha: 'h0', verdicts: [verdict('fixed', { threadId: 'T3' })] });
  const threads = [
    thread({ id: 'T1', comments: [appComment('8001')] }),
    thread({ id: 'T2', comments: [appComment('8002')], resolved: true }),
    thread({ id: 'T3', comments: [appComment('8003')], resolved: true, resolvedByApp: true }),
    thread({ id: 'T4', comments: [appComment('8004'), reply('octo-dev')], resolved: true }),
    thread({ id: 'T5', comments: [appComment('8005')] }),
    thread({ id: 'T6', comments: [reply('octo-lead', { id: '8006' })] }),
  ];
  const v = gate({
    runs: [earlier, head], reviewed: head, threads,
    stored: [stored('8001', 'major'), stored('8002', 'blocker'), stored('8003', 'major'), stored('8004', 'major'), stored('8005', 'minor'), stored('8006', 'major')],
  });
  assert.deepEqual(v, {
    blocking: [
      { thread: 'T1', commentId: '8001', path: 'src/a.ts', line: 12, severity: 'major', why: 'open', unread: false },
      { thread: 'T2', commentId: '8002', path: 'src/a.ts', line: 12, severity: 'blocker', why: 'resolved_no_reply', unread: false },
    ],
    clearedByReview: 1, clearedByReply: 1, silentResolves: 1, unknownThreads: 0, findings: 5,
  });
});

test('a damaged result, a damaged verdict and a thread listed twice change nothing', () => {
  const blocked = { thread: 'PRRT_1', commentId: '8001', path: 'src/a.ts', line: 12, severity: 'major', why: 'open', unread: false };
  for (const result of ['x', null, 5, [], { threadVerdicts: 5 }, { threadVerdicts: [5, null, 'x', verdict('maybe'), { ...verdict('fixed'), threadId: 7 }] }]) {
    const reviewed = run(1, { result });
    const v = gate({ reviewed, runs: [reviewed] });
    assert.deepEqual(v.blocking, [blocked], JSON.stringify(result));
    assert.equal(v.clearedByReview, 0);
  }
  for (const replies of [-1, 1.5, '1', null, Number.NaN]) {
    const v = gate({ reviewed: run(1, { verdicts: [verdict('fixed', { replies })] }) });
    assert.equal(v.blocking.length, 1, String(replies));
  }
  const after = gate({ reviewed: run(1, { verdicts: [verdict('maybe'), verdict('fixed')] }) });
  assert.equal(after.clearedByReview, 1);
  const twice = gate({ threads: [thread(), thread({ resolved: true })] });
  assert.deepEqual(twice.blocking, [blocked]);
  assert.equal(twice.findings, 1);
  assert.doesNotThrow(() => gate({ threads: [thread({ comments: [] })], runs: [run(1, { result: 'x' })] }));
  assert.deepEqual(gate({ threads: [thread({ comments: [] })] }).blocking, []);
  assert.doesNotThrow(() => reviewedRun([run(1, { result: 'x' })], 'h1', 'b1'));
});

test('a stored severity that is no severity gates as unknown', () => {
  const v = gate({ stored: [stored('8001', 'critical')] });
  assert.deepEqual(v.blocking.map((b) => b.severity), ['unknown']);
  assert.equal(v.unknownThreads, 1);
  assert.equal(v.blocking[0]!.unread, false);
  const twice = gate({ stored: [stored('8001', 'minor', { run: 1 }), stored('8001', 'blocker', { run: 2 })] });
  assert.deepEqual(twice.blocking.map((b) => b.severity), ['blocker']);
});
