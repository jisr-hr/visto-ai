import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalThreads } from '../config/load.ts';
import type { StoredComment } from '../db/review-comments.ts';
import type { StoredRun } from '../db/review-runs.ts';
import type { Association, ReviewThread, ThreadComment } from '../forge/types.ts';
import { evaluateGate } from '../gate/rule.ts';
import { accessReplied, closedBefore, newestVerdict } from './threads.ts';
import type { ThreadContext } from './threads.ts';

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
