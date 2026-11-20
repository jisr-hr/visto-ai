import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearingReply, openAgainReply } from '../engine/render/thread-reply.ts';
import type { ThreadVerdict } from '../engine/types.ts';
import type { ForgeWriter, ReviewThread, ThreadComment } from '../forge/types.ts';
import { FOLLOW_UP_PAUSE_MS, followUp, planFollowUp } from './thread-followup.ts';

const V = (over: Partial<ThreadVerdict> = {}): ThreadVerdict => ({ threadId: 'PRRT_1', commentId: '9001', verdict: 'fixed', reply: 'Line 14 now checks the total.', fileChanged: true, ...over });
const comment = (byApp: boolean, body: string, node: string): ThreadComment => ({ id: '1', node, author: byApp ? 'visto-test[bot]' : 'octo-dev', authorIsBot: byApp, byApp, reviewId: null, body, at: '2026-11-20T10:00:00Z' });
const byPerson = (body: string): ThreadComment => comment(false, body, 'PRRC_8');
const byApp = (body: string, node = 'PRRC_9'): ThreadComment => comment(true, body, node);
const thread = (...replies: ThreadComment[]): ReviewThread => ({
  id: 'PRRT_1', path: 'src/a.ts', side: 'RIGHT', line: 14, resolved: false, resolvedByApp: false,
  comments: [comment(true, 'The total is not checked.', 'PRRC_1'), ...replies],
});
const plan = (verdicts: ThreadVerdict[], threads: ReviewThread[], canResolve = true) => planFollowUp({ verdicts, threads, reviewId: '501', head: 'abc1234', canResolve });

test('a verdict that clears replies with the marker and then resolves', () => {
  assert.deepEqual(plan([V()], [thread(byPerson('Done.'))]), { actions: [{ kind: 'reply', thread: 'PRRT_1', body: clearingReply(V(), '501', 'abc1234'), resolve: true }], missing: 0, changed: 0 });
});
test("the app's own last reply is rewritten, not stacked, and the finding itself is never rewritten", () => {
  assert.deepEqual(plan([V()], [thread(byApp('**Fixed.**\n\n<!-- visto-ai: review=401 head=aaa1111 -->', 'PRRC_5'))]).actions,
    [{ kind: 'edit', thread: 'PRRT_1', comment: 'PRRC_5', body: clearingReply(V(), '501', 'abc1234'), resolve: true }]);
  assert.equal(plan([V()], [thread()]).actions[0]!.kind, 'reply');
});
test('a reply that is already there is not written again, and the thread is still resolved', () => {
  assert.deepEqual(plan([V()], [thread(byApp(clearingReply(V(), '501', 'abc1234')))]).actions, [{ kind: 'resolve', thread: 'PRRT_1' }]);
  assert.deepEqual(plan([V()], [{ ...thread(byApp(clearingReply(V(), '501', 'abc1234'))), resolved: true }]).actions, []);
});
test('without the permission, and on a thread that is resolved, nothing is resolved', () => {
  assert.deepEqual(plan([V()], [thread(byPerson('Done.'))], false).actions, [{ kind: 'reply', thread: 'PRRT_1', body: clearingReply(V(), '501', 'abc1234'), resolve: false }]);
  assert.deepEqual(plan([V()], [{ ...thread(byPerson('Done.')), resolved: true }]).actions, [{ kind: 'reply', thread: 'PRRT_1', body: clearingReply(V(), '501', 'abc1234'), resolve: false }]);
  assert.deepEqual(plan([V()], [thread(byApp(clearingReply(V(), '501', 'abc1234')))], false).actions, []);
  const answered = V({ verdict: 'answered' });
  assert.deepEqual(plan([answered], [thread(byApp('**Fixed.**\n\n<!-- visto-ai: review=401 head=aaa1111 -->', 'PRRC_5'))], false).actions,
    [{ kind: 'edit', thread: 'PRRT_1', comment: 'PRRC_5', body: clearingReply(answered, '501', 'abc1234'), resolve: false }]);
});
test('an open verdict answers whoever wrote last, once, and only with a reason', () => {
  const open = V({ verdict: 'open', reply: 'The total is still unchecked.' });
  assert.deepEqual(plan([open], [thread(byPerson('It is fine.'))]).actions, [{ kind: 'reply', thread: 'PRRT_1', body: '**Still open.** The total is still unchecked.', resolve: false }]);
  assert.deepEqual(plan([V({ verdict: 'open', reply: '' })], [thread(byPerson('It is fine.'))]).actions, []);
  assert.deepEqual(plan([open], [thread()]).actions, []);
  assert.deepEqual(plan([open], [thread(byPerson('It is fine.'), byApp('**Still open.** x'))]).actions, []);
});
test("an open verdict rewrites the app's own confirmation", () => {
  const open = V({ verdict: 'open', reply: 'The total is still unchecked.' });
  const confirmed = byApp(clearingReply(V(), '401', 'aaa1111'), 'PRRC_5');
  assert.deepEqual(plan([open], [{ ...thread(confirmed), resolved: true }]).actions,
    [{ kind: 'edit', thread: 'PRRT_1', comment: 'PRRC_5', body: openAgainReply(open, 'abc1234'), resolve: false }]);
});
test('a verdict whose thread is gone is counted and writes nothing', () => {
  assert.deepEqual(plan([V()], []), { actions: [], missing: 1, changed: 0 });
  assert.deepEqual(plan([V({ threadId: 'PRRT_7' }), V()], [thread(byPerson('Done.'))]).missing, 1);
});
test('a verdict is not written into a thread in which someone else wrote after it was judged, and it is counted', () => {
  const open = V({ verdict: 'open', reply: 'The total is still unchecked.', replies: 1 });
  const later = thread(byPerson('It is fine.'), byPerson('Wait, it is a bug.'));
  assert.deepEqual(plan([V({ replies: 1 })], [later]), { actions: [], missing: 0, changed: 1 });
  assert.deepEqual(plan([open], [later]), { actions: [], missing: 0, changed: 1 });
  const afterApp = thread(byPerson('It is fine.'), byApp('**Still open.** x'), byPerson('Wait, it is a bug.'));
  assert.deepEqual(plan([V({ replies: 1 })], [afterApp]), { actions: [], missing: 0, changed: 1 });
});
test('a verdict is planned as before when only the app wrote since, nothing was written since, or it holds no count', () => {
  const judged = V({ replies: 1 });
  const onlyApp = thread(byPerson('Done.'), byApp('**Fixed.**\n\n<!-- visto-ai: review=401 head=aaa1111 -->', 'PRRC_5'));
  assert.deepEqual(plan([judged], [onlyApp]), { actions: [{ kind: 'edit', thread: 'PRRT_1', comment: 'PRRC_5', body: clearingReply(judged, '501', 'abc1234'), resolve: true }], missing: 0, changed: 0 });
  assert.deepEqual(plan([judged], [thread(byPerson('Done.'))]), { actions: [{ kind: 'reply', thread: 'PRRT_1', body: clearingReply(judged, '501', 'abc1234'), resolve: true }], missing: 0, changed: 0 });
  const later = thread(byPerson('Done.'), byPerson('Wait, it is a bug.'));
  assert.deepEqual(plan([V()], [later]), { actions: [{ kind: 'reply', thread: 'PRRT_1', body: clearingReply(V(), '501', 'abc1234'), resolve: true }], missing: 0, changed: 0 });
});
test('a stored verdict that is none of the three plans nothing and is not counted', () => {
  for (const verdict of ['weird', undefined]) {
    const odd = { ...V(), verdict } as unknown as ThreadVerdict;
    assert.deepEqual(plan([odd], [thread(byPerson('Done.'))]), { actions: [], missing: 0, changed: 0 });
    assert.deepEqual(plan([odd], []), { actions: [], missing: 0, changed: 0 });
  }
});

function fakeWriter(calls: unknown[][], opts: { failReplyIn?: string; failResolveIn?: string } = {}): ForgeWriter {
  return {
    replyToThread: async (inst: string, id: string, body: string) => {
      calls.push(['replyToThread', inst, id, body]);
      if (id === opts.failReplyIn) throw new Error('github_502');
    },
    editThreadComment: async (inst: string, node: string, body: string) => { calls.push(['editThreadComment', inst, node, body]); },
    resolveThread: async (inst: string, id: string) => {
      calls.push(['resolveThread', inst, id]);
      if (id === opts.failResolveIn) throw new Error('github_502');
    },
  } as unknown as ForgeWriter;
}

test('each write is made once, a resolve follows only a reply that landed, and a failure is counted', async () => {
  const calls: unknown[][] = [];
  const writer = fakeWriter(calls, { failReplyIn: 'PRRT_2' });
  const out = await followUp({ writer, sleep: async (ms) => { calls.push(['sleep', ms]); }, log: (e) => { calls.push(['log', e.event, e.action, e.thread, e.reason]); } }, { installation: '99', actions: [
    { kind: 'reply', thread: 'PRRT_1', body: 'a', resolve: true }, { kind: 'reply', thread: 'PRRT_2', body: 'b', resolve: true },
    { kind: 'edit', thread: 'PRRT_3', comment: 'PRRC_5', body: 'c', resolve: false }, { kind: 'resolve', thread: 'PRRT_4' },
  ] });
  assert.deepEqual(calls, [
    ['replyToThread', '99', 'PRRT_1', 'a'], ['sleep', 1000], ['resolveThread', '99', 'PRRT_1'],
    ['sleep', 1000], ['replyToThread', '99', 'PRRT_2', 'b'], ['log', 'thread_write_failed', 'reply', 'PRRT_2', 'github_502'],
    ['sleep', 1000], ['editThreadComment', '99', 'PRRC_5', 'c'], ['sleep', 1000], ['resolveThread', '99', 'PRRT_4'],
  ]);
  assert.deepEqual(out, { replied: 1, edited: 1, resolved: 2, failed: 1 });
  assert.equal(FOLLOW_UP_PAUSE_MS, 1000);
});
test('a logger that throws, a sleep that rejects and a resolve that fails change nothing else', async () => {
  const calls: unknown[][] = [];
  const writer = fakeWriter(calls, { failResolveIn: 'PRRT_1' });
  const out = await followUp({ writer, sleep: async () => { throw new Error('boom'); }, log: () => { throw new Error('log_down'); } }, { installation: '99', actions: [
    { kind: 'edit', thread: 'PRRT_1', comment: 'PRRC_5', body: 'a', resolve: true },
    { kind: 'reply', thread: 'PRRT_2', body: 'b', resolve: false },
    { kind: 'resolve', thread: 'PRRT_3' },
  ] });
  assert.deepEqual(calls.map((c) => c[0]), ['editThreadComment', 'resolveThread', 'replyToThread', 'resolveThread']);
  assert.deepEqual(out, { replied: 1, edited: 1, resolved: 1, failed: 1 });
});
