import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalThreads } from '../config/load.ts';
import type { StoredComment } from '../db/review-comments.ts';
import { NOTE } from '../db/review-comments.ts';
import type { StoredRun } from '../db/review-runs.ts';
import type { EarlierThread } from '../engine/types.ts';
import type { Association, ReviewThread, ThreadComment } from '../forge/types.ts';
import { evaluateGate, storedSeverities } from '../gate/rule.ts';
import { accessReplied, closedBefore, newestVerdict, openForApproval } from './threads.ts';
import type { ThreadContext } from './threads.ts';
import { earlierOf } from '../shell/earlier.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const USAGE = { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 };

/** A published run at h1 against merge000 whose result says it read src/a.ts. `verdicts` sets its threadVerdicts. */
const run = (id: number, over: Partial<StoredRun> & { verdicts?: unknown } = {}): StoredRun => {
  const { verdicts, ...rest } = over;
  return {
    id, ref: REF, job: id, trigger: 'manual', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'merge000', baseBranch: 'main',
    outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 1, body: '', comments: [],
    result: { findings: [], coverage: { reviewed: ['src/a.ts'], notReviewed: [] }, threadVerdicts: verdicts ?? [] },
    usage: USAGE, startedAt: '2026-03-01T10:00:00.000Z', finishedAt: '2026-03-01T10:01:00.000Z',
    published: true, reviewId: String(500 + id), publishedAt: '2026-03-01T10:02:00.000Z', inlineDropped: false, publishTriedAt: null, ...rest,
  };
};
const verdict = (word: string, over: Record<string, unknown> = {}) =>
  ({ threadId: 'PRRT_1', commentId: '8001', verdict: word, reply: '', fileChanged: true, ...over });

const appComment = (id: string, over: Partial<ThreadComment> = {}): ThreadComment =>
  ({ id, node: `N${id}`, author: 'visto-test[bot]', authorIsBot: true, byApp: true, reviewId: '501', body: '**[major]** Check the total.', at: '2026-03-01T10:02:00.000Z', ...over });
const reply = (author: string, over: Partial<ThreadComment> = {}): ThreadComment =>
  ({ id: '9001', node: 'N9001', author, authorIsBot: false, byApp: false, reviewId: null, body: 'Meant to be so.', at: '2026-03-01T11:00:00.000Z', ...over });
const withAccess = (author: string, association: Association, over: Partial<ThreadComment> = {}): ThreadComment => reply(author, { association, ...over });
const appReply = (over: Partial<ThreadComment> = {}): ThreadComment => reply('visto-test[bot]', { id: '9002', authorIsBot: true, byApp: true, ...over });
const botReply = (over: Partial<ThreadComment> = {}): ThreadComment => reply('helper-bot', { id: '9003', authorIsBot: true, ...over });

/** An open thread of the app at src/a.ts line 12 whose first comment is 8001 (stored as a major). */
const thread = (over: Partial<ReviewThread> = {}): ReviewThread =>
  ({ id: 'PRRT_1', path: 'src/a.ts', side: 'RIGHT', line: 12, resolved: false, resolvedByApp: false, comments: [appComment('8001')], ...over });
const STORED: Array<StoredComment & { run: number }> = [{ commentId: '8001', path: 'src/a.ts', side: 'RIGHT', line: 12, severity: 'major', quote: 'total = a + b', run: 1 }];

const ctx = (over: Partial<ThreadContext> = {}): ThreadContext =>
  ({ rule: 'strict', author: 'octo-dev', clearByReply: true, published: [run(1)], ...over });
const strict = (t: ReviewThread, over: Partial<ThreadContext> = {}): boolean => closedBefore(t, ctx(over));
const gateRule = (t: ReviewThread, over: Partial<ThreadContext> = {}): boolean => closedBefore(t, ctx({ rule: 'gate', ...over }));
const resolvedWith = (...replies: ThreadComment[]): ReviewThread => thread({ resolved: true, comments: [appComment('8001'), ...replies] });
/** Whether a run owes the thread a verdict, as the engine decides it: major or blocker, and not settled. */
const isDue = (t: EarlierThread): boolean => (t.severity === 'major' || t.severity === 'blocker') && !t.settled;

test('under the strict rule a thread the author replied to and resolved is not closed, and one a member who is not the author replied to is', () => {
  const byAuthor = resolvedWith(withAccess('octo-dev', 'member'));
  assert.equal(accessReplied(byAuthor, 'octo-dev'), false);
  assert.equal(strict(byAuthor), false);
  const byMember = resolvedWith(withAccess('octo-lead', 'member'));
  assert.equal(accessReplied(byMember, 'octo-dev'), true);
  assert.equal(strict(byMember), true);
  // The owner and a collaborator have access too; the author's own reply beside the member's takes nothing away.
  assert.equal(strict(resolvedWith(withAccess('octo-lead', 'owner'))), true);
  assert.equal(strict(resolvedWith(withAccess('octo-lead', 'collaborator'))), true);
  assert.equal(strict(resolvedWith(withAccess('octo-dev', 'member'), withAccess('octo-lead', 'member', { id: '9005' }))), true);
  // Whoever resolved it: the reply is what closes it.
  assert.equal(strict(thread({ resolved: true, resolvedByApp: true, comments: [appComment('8001'), withAccess('octo-lead', 'member')] })), true);
});

test('a reply by someone without access, or whose access GitHub did not report, closes nothing under the strict rule', () => {
  const replies: Array<[string, ThreadComment]> = [
    ['octo-guest with none', withAccess('octo-guest', 'none')],
    ['octo-lead with no association', reply('octo-lead')],
    ['a bot with member', botReply({ association: 'member' })],
    ["the app's own reply with member", appReply({ association: 'member' })],
    ['the author as Octo-Dev with owner', withAccess('Octo-Dev', 'owner')],
    ['a word that is no association', reply('octo-lead', { association: 'contributor' as unknown as Association })],
  ];
  for (const [name, r] of replies) {
    const t = resolvedWith(r);
    assert.equal(accessReplied(t, 'octo-dev'), false, name);
    assert.equal(strict(t), false, name);
  }
  // The author named with other letter case is still the author.
  assert.equal(strict(resolvedWith(withAccess('octo-dev', 'owner')), { author: 'OCTO-DEV' }), false);
  // An author that cannot be read lets no reply count.
  assert.equal(accessReplied(resolvedWith(withAccess('octo-lead', 'member')), undefined as unknown as string), false);
  // The first comment is never a reply, even one written by a member.
  assert.equal(accessReplied(thread({ resolved: true, comments: [withAccess('octo-lead', 'member', { id: '8001' })] }), 'octo-dev'), false);
  // A reply with a damaged author flag is no person's.
  for (const over of [{ byApp: undefined }, { authorIsBot: undefined }] as unknown as Array<Partial<ThreadComment>>) {
    assert.equal(strict(resolvedWith(withAccess('octo-lead', 'member', over))), false, JSON.stringify(over));
  }
});

test("the app's resolve closes a thread under the strict rule only after a fixed verdict on a changed file, the newest verdict deciding", () => {
  const byApp = thread({ resolved: true, resolvedByApp: true });
  const closed = (published: StoredRun[]): boolean => strict(byApp, { published });
  assert.equal(closed([run(1, { verdicts: [verdict('fixed')] })]), true);
  assert.equal(closed([run(1, { verdicts: [verdict('fixed', { fileChanged: false })] })]), false);
  assert.equal(closed([run(1, { verdicts: [verdict('fixed', { fileChanged: 'yes' })] })]), false);
  assert.equal(closed([run(1, { verdicts: [verdict('fixed', { fileChanged: undefined })] })]), false);
  assert.equal(closed([run(1, { verdicts: [verdict('answered')] })]), false);
  assert.equal(closed([run(1, { verdicts: [verdict('open')] })]), false);
  assert.equal(closed([run(1)]), false);
  assert.equal(closed([]), false);
  // An older fixed on a changed file under a newer open, in either order of the list.
  const older = run(1, { headSha: 'h0', verdicts: [verdict('fixed')] });
  const reopened = run(2, { verdicts: [verdict('open')] });
  assert.equal(closed([older, reopened]), false);
  assert.equal(closed([reopened, older]), false);
  // A newer run with no entry on the thread lets the older one decide.
  assert.equal(closed([older, run(2), run(3, { verdicts: [verdict('fixed', { threadId: 'PRRT_OTHER' })] })]), true);
  // A damaged newest entry: no verdict, and no older run stands in.
  const damaged = run(2, { verdicts: [verdict('fixed', { replies: -1 })] });
  assert.equal(closed([older, damaged]), false);
  // The verdict alone, without the app's resolve, closes nothing.
  assert.equal(strict(thread({ resolved: true }), { published: [older] }), false);

  assert.deepEqual(newestVerdict([older], 'PRRT_1'), { verdict: 'fixed', fileChanged: true, replies: null });
  assert.deepEqual(newestVerdict([run(1, { verdicts: [verdict('answered', { fileChanged: 1, replies: 2 })] })], 'PRRT_1'), { verdict: 'answered', fileChanged: false, replies: 2 });
  assert.deepEqual(newestVerdict([older, reopened], 'PRRT_1'), { verdict: 'open', fileChanged: true, replies: null });
  assert.equal(newestVerdict([older, damaged], 'PRRT_1'), 'damaged');
  for (const replies of [-1, 1.5, '1', null, Number.NaN]) assert.equal(newestVerdict([run(1, { verdicts: [verdict('fixed', { replies })] })], 'PRRT_1'), 'damaged', String(replies));
  assert.equal(newestVerdict([run(1)], 'PRRT_1'), null);
  assert.equal(newestVerdict([], 'PRRT_1'), null);
  // The first object with the thread's id and a known word is the entry; what comes before it that is not one is passed over.
  assert.deepEqual(newestVerdict([run(1, { verdicts: [5, null, 'x', [verdict('open')], verdict('maybe'), { ...verdict('open'), threadId: 7 }, verdict('fixed'), verdict('open')] })], 'PRRT_1'),
    { verdict: 'fixed', fileChanged: true, replies: null });
  // A result that cannot be read has no entry, and an older run decides.
  for (const result of ['x', null, 5, [], { threadVerdicts: 5 }]) {
    assert.deepEqual(newestVerdict([older, run(2, { result })], 'PRRT_1'), { verdict: 'fixed', fileChanged: true, replies: null }, JSON.stringify(result));
  }
});

test('an unresolved thread is never closed before the run, under either rule', () => {
  const fixed = [run(1, { verdicts: [verdict('fixed')] })];
  const cases: Array<Partial<ReviewThread>> = [
    { resolvedByApp: true },
    { resolvedByApp: true, comments: [appComment('8001'), appReply()] },
    { comments: [appComment('8001'), withAccess('octo-lead', 'member')] },
    { comments: [appComment('8001'), withAccess('octo-lead', 'owner'), reply('octo-dev', { id: '9005' })] },
    { resolvedByApp: true, comments: [appComment('8001'), withAccess('octo-lead', 'member'), appReply()] },
  ];
  for (const rule of ['strict', 'gate'] as ApprovalThreads[]) {
    for (const clearByReply of [true, false]) {
      for (const c of cases) {
        assert.equal(closedBefore(thread({ ...c, resolved: false }), ctx({ rule, clearByReply, published: fixed })), false, `${rule} ${clearByReply} ${JSON.stringify(c)}`);
      }
    }
  }
  // A resolved flag that is not true is not resolved.
  const damaged = thread({ resolved: 'yes' as unknown as boolean, resolvedByApp: true, comments: [appComment('8001'), withAccess('octo-lead', 'member')] });
  assert.equal(strict(damaged, { published: fixed }), false);
  assert.equal(gateRule(damaged, { published: fixed }), false);
});

test('under the gate rule a thread closes before the run as the gate clears it, with clearing by reply on or off', () => {
  const byApp = thread({ resolved: true, resolvedByApp: true });
  for (const clearByReply of [true, false]) {
    const closed = (t: ReviewThread, published: StoredRun[]): boolean => gateRule(t, { clearByReply, published });
    assert.equal(closed(byApp, [run(1, { verdicts: [verdict('fixed')] })]), true, `fixed ${clearByReply}`);
    assert.equal(closed(byApp, [run(1, { verdicts: [verdict('fixed', { fileChanged: false })] })]), true, `fixed unchanged ${clearByReply}`);
    assert.equal(closed(byApp, [run(1, { verdicts: [verdict('answered')] })]), true, `answered ${clearByReply}`);
    assert.equal(closed(byApp, [run(1, { verdicts: [verdict('open')] })]), false, `open ${clearByReply}`);
    assert.equal(closed(byApp, [run(1)]), false, `none ${clearByReply}`);
    assert.equal(closed(byApp, [run(1, { headSha: 'h0', verdicts: [verdict('fixed')] }), run(2, { verdicts: [verdict('fixed', { replies: -1 })] })]), false, `damaged ${clearByReply}`);
    assert.equal(closed(thread({ resolved: true }), [run(1, { verdicts: [verdict('fixed')] })]), false, `not the app's resolve ${clearByReply}`);
    // Any person's reply, the author's included and access or not, once it is resolved; never a bot's or the app's.
    for (const r of [reply('octo-dev'), withAccess('octo-guest', 'none'), withAccess('octo-lead', 'member')]) {
      assert.equal(closed(resolvedWith(r), [run(1)]), clearByReply, `${r.author} ${clearByReply}`);
    }
    for (const r of [botReply(), appReply()]) assert.equal(closed(resolvedWith(r), [run(1)]), false, `${r.author} ${clearByReply}`);
    assert.equal(closed(thread({ resolved: true }), [run(1)]), false, `silent ${clearByReply}`);
  }

  // As the gate clears it, with a head's review that kept no verdict on the thread.
  const head = run(3);
  const runsOf: Record<string, StoredRun[]> = {
    none: [head],
    fixed: [run(1, { headSha: 'h0', verdicts: [verdict('fixed')] }), head],
    answered: [run(1, { headSha: 'h0', verdicts: [verdict('answered')] }), head],
    reopened: [run(1, { headSha: 'h0', verdicts: [verdict('fixed')] }), run(2, { headSha: 'h0', verdicts: [verdict('open')] }), head],
    damaged: [run(1, { headSha: 'h0', verdicts: [verdict('fixed')] }), run(2, { headSha: 'h0', verdicts: [verdict('fixed', { replies: 'x' })] }), head],
  };
  const threads: ReviewThread[] = [
    thread(),
    thread({ resolved: true }),
    thread({ resolved: true, resolvedByApp: true }),
    resolvedWith(reply('octo-dev')),
    resolvedWith(botReply()),
    thread({ comments: [appComment('8001'), reply('octo-dev')] }),
    thread({ resolved: true, resolvedByApp: true, comments: [appComment('8001'), reply('octo-dev')] }),
  ];
  for (const [name, runs] of Object.entries(runsOf)) {
    for (const clearByReply of [true, false]) {
      for (const t of threads) {
        const gateClears = evaluateGate({ threads: [t], stored: STORED, runs, reviewed: head, clearByReply }).blocking.length === 0;
        assert.equal(gateRule(t, { clearByReply, published: runs }), gateClears, `${name} ${clearByReply} ${JSON.stringify(t)}`);
      }
    }
  }
});

type Stored = StoredComment & { run: number };
type OpenArgs = Parameters<typeof openForApproval>[0];
const stored = (commentId: string, severity: string, over: Partial<Stored> = {}): Stored =>
  ({ commentId, path: 'src/a.ts', side: 'RIGHT', line: 12, severity, quote: 'total = a + b', run: 1, ...over });
/** This run: 2, recorded at h1 and not yet published, with the verdicts it kept. */
const thisRun = (verdicts: unknown = []): StoredRun => run(2, { published: false, reviewId: null, publishedAt: null, verdicts });
/** Open for approval under `rule`: by default the thread of 8001 listed, 8001 stored as a major of the published run 1, and this run with no verdict. */
const open = (rule: ApprovalThreads, over: Partial<OpenArgs> = {}): number => {
  const current = over.run ?? thisRun();
  return openForApproval({ threads: [thread()], stored: STORED, runs: [run(1), current], run: current, rule, author: 'octo-dev', clearByReply: true, ...over });
};
/** [strict, gate] */
const both = (over: Partial<OpenArgs> = {}): [number, number] => [open('strict', over), open('gate', over)];

test("this review's fixed verdict on a changed file closes a thread under the strict rule, unless someone wrote after it was judged", () => {
  const judged = (verdicts: unknown, replies: ThreadComment[]): number => {
    const current = thisRun(verdicts);
    return open('strict', { threads: [thread({ comments: [appComment('8001'), ...replies] })], run: current, runs: [run(1), current] });
  };
  const answer = reply('octo-dev');
  const later = reply('octo-dev', { id: '9005', at: '2026-03-01T12:00:00.000Z' });
  // Judged with its one reply: closed; a comment of the author after that: open; only the app's own after it: closed.
  assert.equal(judged([verdict('fixed', { replies: 1 })], [answer]), 0);
  assert.equal(judged([verdict('fixed', { replies: 1 })], [answer, later]), 1);
  assert.equal(judged([verdict('fixed', { replies: 1 })], [answer, appReply()]), 0);
  assert.equal(judged([verdict('fixed', { replies: 0 })], [answer]), 1);
  // replies absent: none is checked.
  assert.equal(judged([verdict('fixed')], [answer, later]), 0);
  // Not on a changed file, or not fixed: open, the thread being unresolved.
  assert.equal(judged([verdict('fixed', { fileChanged: false })], [answer]), 1);
  assert.equal(judged([verdict('fixed', { fileChanged: undefined })], []), 1);
  assert.equal(judged([verdict('answered')], [answer]), 1);
  assert.equal(judged([], [answer]), 1);
  // An older review's fixed verdict on a changed file is not this review's: open.
  assert.equal(open('strict', { runs: [run(1, { verdicts: [verdict('fixed')] }), thisRun()] }), 1);
  // Resolved by the app after an older answered: this review's fixed, stale by the author's later comment, is not the newest
  // verdict an earlier run kept, so it closes nothing; judged after that comment, it closes the thread.
  const resolvedByApp = (verdicts: unknown): number => {
    const current = thisRun(verdicts);
    const answeredBefore = run(1, { headSha: 'h0', verdicts: [verdict('answered')] });
    return open('strict', { threads: [thread({ resolved: true, resolvedByApp: true, comments: [appComment('8001'), answer] })], run: current, runs: [answeredBefore, current] });
  };
  assert.equal(resolvedByApp([verdict('fixed', { replies: 0 })]), 1);
  assert.equal(resolvedByApp([verdict('fixed', { replies: 1 })]), 0);
});

test('a thread this review kept open is open for approval under both rules, though a member replied and it is resolved', () => {
  const t = resolvedWith(withAccess('octo-lead', 'member'));
  const kept = thisRun([verdict('open')]);
  // Without a verdict of this review the member's reply closes it under both rules; this review's open holds it.
  assert.deepEqual(both({ threads: [t] }), [0, 0]);
  assert.deepEqual(both({ threads: [t], run: kept, runs: [run(1), kept] }), [1, 1]);
  assert.equal(open('gate', { threads: [t], run: kept, runs: [run(1), kept], clearByReply: false }), 1);
  // Resolved by the app after an older review's fixed verdict on a changed file: this review's open still holds it.
  const byApp = thread({ resolved: true, resolvedByApp: true, comments: [appComment('8001'), withAccess('octo-lead', 'member')] });
  const fixedBefore = run(1, { headSha: 'h0', verdicts: [verdict('fixed')] });
  assert.deepEqual(both({ threads: [byApp], runs: [fixedBefore, thisRun()] }), [0, 0]);
  assert.deepEqual(both({ threads: [byApp], run: kept, runs: [fixedBefore, kept] }), [1, 1]);
});

test("the app's own thread with no stored finding is open until a person with access who is not the author replied and it is resolved", () => {
  const unstored = (over: Partial<ReviewThread> = {}): ReviewThread => thread({ id: 'PRRT_9', comments: [appComment('8009')], ...over });
  const strictOf = (t: ReviewThread, over: Partial<OpenArgs> = {}): number => open('strict', { threads: [t], stored: [], ...over });
  assert.equal(strictOf(unstored()), 1);
  assert.equal(strictOf(unstored({ resolved: true })), 1);
  assert.equal(strictOf(unstored({ resolved: true, resolvedByApp: true })), 1);
  assert.equal(strictOf(unstored({ resolved: true, comments: [appComment('8009'), withAccess('octo-dev', 'member')] })), 1);
  assert.equal(strictOf(unstored({ resolved: true, comments: [appComment('8009'), withAccess('octo-guest', 'none')] })), 1);
  assert.equal(strictOf(unstored({ comments: [appComment('8009'), withAccess('octo-lead', 'member')] })), 1);
  assert.equal(strictOf(unstored({ resolved: true, comments: [appComment('8009'), withAccess('octo-lead', 'member')] })), 0);
  // No verdict closes it: neither this review's fixed on a changed file nor the app's resolve after an older one (call 27).
  const fixed = [verdict('fixed', { threadId: 'PRRT_9', commentId: '8009' })];
  const current = thisRun(fixed);
  assert.equal(strictOf(unstored(), { run: current, runs: [run(1), current] }), 1);
  assert.equal(strictOf(unstored({ resolved: true, resolvedByApp: true }), { runs: [run(1, { verdicts: fixed }), thisRun()] }), 1);
  // Under the gate's rule it is the gate's unknown: any person's reply once resolved, while clearing by reply is on.
  const answered = unstored({ resolved: true, comments: [appComment('8009'), reply('octo-dev')] });
  assert.equal(open('gate', { threads: [unstored()], stored: [] }), 1);
  assert.equal(open('gate', { threads: [answered], stored: [] }), 0);
  assert.equal(open('gate', { threads: [answered], stored: [], clearByReply: false }), 1);
});

test('notes and minor threads are not counted, and a thread listed twice counts once', () => {
  // The gate's rank: blocker 4, major 3, unknown 2, minor 1, note 0, whatever the order of the rows.
  const rows = [
    stored('8001', 'major'), stored('8002', NOTE), stored('8003', 'minor'),
    stored('8004', 'minor'), stored('8004', 'major', { run: 2 }), stored('8005', 'blocker'), stored('8005', 'major'),
    stored('8006', 'nit'), stored('8007', 'nit'), stored('8007', 'minor'), stored('8008', NOTE), stored('8008', 'minor'),
  ];
  assert.deepEqual(storedSeverities(rows), new Map([
    ['8001', 'major'], ['8002', 'note'], ['8003', 'minor'], ['8004', 'major'], ['8005', 'blocker'], ['8006', 'unknown'], ['8007', 'unknown'], ['8008', 'minor'],
  ]));
  assert.deepEqual(storedSeverities([]), new Map());

  const note = thread({ id: 'PRRT_2', comments: [appComment('8002')] });
  const minor = thread({ id: 'PRRT_3', comments: [appComment('8003')] });
  const smaller = [stored('8002', NOTE), stored('8003', 'minor')];
  assert.deepEqual(both({ threads: [note, minor], stored: smaller }), [0, 0]);
  assert.deepEqual(both({ threads: [thread(), thread()] }), [1, 1]);
  assert.deepEqual(both({ threads: [thread(), note, thread(), minor, note], stored: [...STORED, ...smaller] }), [1, 1]);
  // The first listing of an id decides; a second one with other contents is not judged again.
  assert.deepEqual(both({ threads: [resolvedWith(withAccess('octo-lead', 'member')), thread()] }), [0, 0]);
  // A comment stored as a minor and as a major counts as a major.
  assert.deepEqual(both({ threads: [thread({ comments: [appComment('8004')] })], stored: [stored('8004', 'minor'), stored('8004', 'major')] }), [1, 1]);
});

test("the gate rule counts what the gate would block with this review as the head's review", () => {
  const rows = ['8001', '8002', '8003', '8004'].map((id) => stored(id, 'major'));
  const threads = [
    thread(),
    thread({ id: 'PRRT_2', resolved: true, resolvedByApp: true, comments: [appComment('8002')] }),
    thread({ id: 'PRRT_3', resolved: true, comments: [appComment('8003'), reply('octo-dev')] }),
    thread({ id: 'PRRT_4', resolved: true, comments: [appComment('8004')] }),
  ];
  const older = run(1, { headSha: 'h0', verdicts: [verdict('fixed', { threadId: 'PRRT_2', commentId: '8002' })] });
  const current = thisRun();
  const asHead = { ...current, published: true };
  const blocked: Record<string, number> = {};
  for (const clearByReply of [true, false]) {
    const byHand = evaluateGate({ threads, stored: rows, runs: [older, asHead], reviewed: asHead, clearByReply }).blocking.length;
    blocked[String(clearByReply)] = byHand;
    assert.equal(open('gate', { threads, stored: rows, runs: [older, current], run: current, clearByReply }), byHand, String(clearByReply));
    // Whether or not the runs list this run.
    assert.equal(open('gate', { threads, stored: rows, runs: [older], run: current, clearByReply }), byHand, String(clearByReply));
  }
  assert.deepEqual(blocked, { true: 2, false: 3 });
  // The strict rule on the same threads: the author's reply closes nothing.
  assert.equal(open('strict', { threads, stored: rows, runs: [older, current], run: current }), 3);
  // This review is the head's review: its own fixed on a changed file closes an unresolved thread under both rules,
  // and an older head's fixed, with no verdict of this review, closes it under neither.
  const fixedNow = thisRun([verdict('fixed')]);
  assert.deepEqual(both({ run: fixedNow, runs: [run(1), fixedNow] }), [0, 0]);
  assert.deepEqual(both({ runs: [run(1, { headSha: 'h0', verdicts: [verdict('fixed')] }), thisRun()] }), [1, 1]);
});

test('a stored major whose comment was deleted holds approval back, under both rules', () => {
  const gone = (over: Partial<OpenArgs> = {}): [number, number] => both({ threads: [], ...over });
  assert.deepEqual(gone(), [1, 1]);
  assert.deepEqual(gone({ stored: [stored('8001', 'blocker')] }), [1, 1]);
  // Counted once by comment id.
  assert.deepEqual(gone({ stored: [stored('8001', 'major'), stored('8001', 'blocker')] }), [1, 1]);
  assert.deepEqual(gone({ stored: [stored('8001', 'major'), stored('8002', 'major')] }), [2, 2]);
  // The same row of a dry run, or of a run not published: 0; a stored minor or note: 0.
  assert.deepEqual(gone({ runs: [run(1, { dryRun: true }), thisRun()] }), [0, 0]);
  assert.deepEqual(gone({ runs: [run(1, { published: false, reviewId: null, publishedAt: null }), thisRun()] }), [0, 0]);
  assert.deepEqual(gone({ stored: [stored('8001', 'minor'), stored('8002', NOTE)] }), [0, 0]);
  // Listed as the first comment of the app's own thread: judged as a thread, and closed here.
  assert.deepEqual(both({ threads: [resolvedWith(withAccess('octo-lead', 'member'))] }), [0, 0]);
  // A reply in a listed thread is not its first comment: lost.
  const moved = thread({ id: 'PRRT_2', comments: [appComment('8002'), appComment('8001')] });
  assert.deepEqual(both({ threads: [moved], stored: [stored('8001', 'major'), stored('8002', 'minor')] }), [1, 1]);
});

test("a thread whose first comment is no longer the app's holds approval back", () => {
  const closed = (byApp: boolean): ReviewThread => thread({ resolved: true, comments: [appComment('8001', { byApp }), withAccess('octo-lead', 'member')] });
  assert.deepEqual(both({ threads: [closed(false)] }), [1, 1]);
  assert.deepEqual(both({ threads: [closed(true)] }), [0, 0]);
  // Unresolved, it counts once, not as a thread and as a lost one.
  assert.deepEqual(both({ threads: [thread({ comments: [appComment('8001', { byApp: false })] })] }), [1, 1]);
});

test('what cannot be read is open for approval, under both rules, and nothing throws', () => {
  const closed = resolvedWith(withAccess('octo-lead', 'member'));
  assert.deepEqual(both({ threads: [closed] }), [0, 0]);
  const damagedVerdict = thisRun([verdict('fixed', { replies: -1 })]);
  const unreadable = (result: unknown): StoredRun => ({ ...thisRun(), result });
  const cases: Array<[string, Partial<OpenArgs>]> = [
    ['a verdict of this review that cannot be read', { threads: [closed], run: damagedVerdict, runs: [run(1), damagedVerdict] }],
    ["this review's verdicts that are no list", { threads: [closed], run: unreadable({ findings: [], threadVerdicts: 5 }) }],
    ["this review's result that is no object", { threads: [closed], run: unreadable('x') }],
    ['threads that are no list', { threads: 5 as unknown as ReviewThread[] }],
    ['a thread that is no object', { threads: [closed, null as unknown as ReviewThread] }],
    ['a thread whose comments are no list', { threads: [closed, thread({ id: 'PRRT_2', comments: 'x' as unknown as ThreadComment[] })] }],
    ['a thread with no comment', { threads: [closed, thread({ id: 'PRRT_2', comments: [] })] }],
    ['a thread whose first comment is no object', { threads: [closed, thread({ id: 'PRRT_2', comments: [7 as unknown as ThreadComment] })] }],
    ['a first comment whose author flag is not a boolean', { threads: [closed, thread({ id: 'PRRT_2', comments: [appComment('8009', { byApp: undefined as unknown as boolean })] })] }],
    ['a reply that is no object', { threads: [resolvedWith(withAccess('octo-lead', 'member'), null as unknown as ThreadComment)] }],
    ['stored rows that are no list', { threads: [closed], stored: null as unknown as Stored[] }],
    ['a stored row that is no object', { threads: [closed], stored: [...STORED, 7 as unknown as Stored] }],
    ['a stored row of a severity that is no known word, whose comment is gone', { threads: [closed], stored: [...STORED, stored('8002', 'nit')] }],
    ['a stored major of a run that is not listed, whose comment is gone', { threads: [closed], stored: [...STORED, stored('8002', 'major', { run: 9 })] }],
    ['runs that are no list', { threads: [closed], runs: {} as unknown as StoredRun[] }],
    ['a run that is no object', { threads: [closed], runs: [run(1), null as unknown as StoredRun, thisRun()] }],
    ['this run that is no object', { threads: [closed], run: null as unknown as StoredRun, runs: [run(1)] }],
  ];
  for (const [name, over] of cases) assert.deepEqual(both(over), [1, 1], name);
  // A thread rule this code does not know closes nothing; a clearing flag that is not true clears nothing under the gate's rule.
  assert.equal(open('loose' as unknown as ApprovalThreads, { threads: [closed] }), 1);
  const answered = resolvedWith(reply('octo-dev'));
  assert.equal(open('gate', { threads: [answered] }), 0);
  assert.equal(open('gate', { threads: [answered], clearByReply: 'yes' as unknown as boolean }), 1);
});

test('a thread a review kept open after a member\'s reply, then resolved by the author, is not closed for approval, and is due', () => {
  // octo-lead replies on the open thread; review 2 judges it with that one reply and keeps it open; the author resolves it.
  const opened = run(1, { headSha: 'h0' });
  const keptOpen = (over: Record<string, unknown> = { replies: 1 }): StoredRun => run(2, { verdicts: [verdict('open', { fileChanged: false, ...over })] });
  const ask = withAccess('octo-lead', 'member', { body: 'Please fix the total.' });
  const later = withAccess('octo-lead', 'member', { id: '9005', at: '2026-03-01T12:00:00.000Z' });
  const t = resolvedWith(ask);
  const published = [opened, keptOpen()];
  assert.equal(strict(t, { published }), false);
  assert.equal(strict(resolvedWith(ask, appReply()), { published }), false);
  assert.equal(strict(resolvedWith(ask, withAccess('octo-dev', 'member', { id: '9005' })), { published }), false);
  // A member's reply after the first 1 + replies comments closes it.
  assert.equal(strict(resolvedWith(ask, later), { published }), true);
  assert.equal(strict(resolvedWith(ask, appReply(), later), { published }), true);
  // replies absent on the open entry: what it judged cannot be told, and no reply counts.
  assert.equal(strict(resolvedWith(ask, later), { published: [opened, keptOpen({})] }), false);
  // A damaged newest entry: no reply counts.
  assert.equal(strict(resolvedWith(ask, later), { published: [opened, run(2, { verdicts: [verdict('fixed', { replies: -1 })] })] }), false);
  // A newest verdict that is not open, or none, lets the reply count as before.
  assert.equal(strict(t, { published: [opened, run(2, { verdicts: [verdict('answered', { replies: 1 })] })] }), true);
  assert.equal(strict(t, { published: [opened] }), true);
  // Through the earlier state: not settled, and due.
  const approval = { rule: 'strict' as const, author: 'octo-dev', clearByReply: true };
  const earlier = earlierOf({ last: keptOpen(), runs: published, stored: STORED, threads: [t], approval }).threads[0]!;
  assert.deepEqual([earlier.settled, earlier.closedForApproval, isDue(earlier)], [false, false, true]);
  assert.equal(earlierOf({ last: keptOpen(), runs: published, stored: STORED, threads: [t] }).threads[0]!.settled, true);
  // And once the next review is posted with no verdict on it, the thread is open.
  const current = run(3, { published: false, reviewId: null, publishedAt: null });
  assert.equal(openForApproval({ threads: [t], stored: STORED, runs: [...published, current], run: current, rule: 'strict', author: 'octo-dev', clearByReply: true }), 1);
  // Under the gate rule the same sequence is what it is today.
  assert.equal(gateRule(t, { published }), true);
  assert.equal(gateRule(t, { published, clearByReply: false }), false);
});
