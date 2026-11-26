import assert from 'node:assert/strict';
import test from 'node:test';
import { hunksOf } from '../context/build.ts';
import type { FileContext } from '../context/build.ts';
import type { ShownThread } from '../context/threads.ts';
import type { RawVerdict, SubmitReviewArgs } from '../model/submit-review.ts';
import { fileDiffHash } from '../score/blocks.ts';
import type { ChangedFile, EarlierThread, ThreadVerdict } from '../types.ts';
import { dropDuplicates, reconcileVerdicts } from './threads.ts';

const PATCH_A = '@@ -10,3 +10,4 @@\n const a = 1;\n const b = 2;\n+const total = a + b;\n return total;';
const PATCH_B = '@@ -10,3 +10,5 @@\n const a = 1;\n const b = 2;\n+const total = a + b;\n+if (total < 0) throw new Error();\n return total;';
const fileOf = (patch: string): ChangedFile => ({ path: 'src/a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 0, patch });
const ctxOf = (patch: string): FileContext => ({
  file: fileOf(patch), hunks: hunksOf(patch).hunks, ranges: null, diffText: null, full: null, test: null, skip: null,
  blocks: [], plan: { kind: 'model' }, hidden: false, findings: true,
}) as FileContext;
const ctxA = ctxOf(PATCH_A);
const ctxB = ctxOf(PATCH_B);
const HASH_A = fileDiffHash(ctxA.hunks);
const thread = (over: Partial<EarlierThread> = {}): EarlierThread => ({
  id: 'PRRT_1', commentId: '9001', path: 'src/a.ts', side: 'RIGHT', line: 12, severity: 'major', quote: 'const total = a + b;', body: 'Check the total.',
  openedAt: { head: 'h1', diffHash: HASH_A }, resolved: false, settled: false, lastVerdict: null,
  replies: [{ author: 'octo-dev', kind: 'person', body: 'It is checked by the caller.' }], ...over,
});
const shown = (threadOver: Partial<EarlierThread> = {}, due = true): ShownThread => ({ key: 'T1', file: 'src/a.ts', thread: thread(threadOver), due });
const answer = (verdicts: RawVerdict[], threads: string[] = ['T1']): { value: SubmitReviewArgs; files: string[]; threads?: string[] } =>
  ({ value: { overview: 'o', findings: [], files: [], thread_verdicts: verdicts }, files: ['src/a.ts'], threads });
const REASON = 'Line 14 now checks the total.';
const FILES: ChangedFile[] = [fileOf(PATCH_A)];

test('a verdict for a thread that is due, from the call that held its file, is kept', () => {
  const out = reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'answered', reply: ' The guard is\n in the caller. ' }])], [shown()], [ctxA], 'h2');
  assert.deepEqual(out, { verdicts: [{ threadId: 'PRRT_1', commentId: '9001', verdict: 'answered', reply: 'The guard is in the caller.', fileChanged: false, replies: 1 }], audit: [] });
});
test('a kept verdict records how many replies its thread had when it was judged', () => {
  const two = [{ author: 'octo-dev', kind: 'person' as const, body: 'a' }, { author: 'visto-test', kind: 'app' as const, body: 'b' }];
  const out = (over: Partial<EarlierThread>, verdict: string) => reconcileVerdicts([answer([{ thread_id: 'T1', verdict, reply: REASON }])], [shown(over)], [ctxB], 'h2').verdicts.map((v) => v.replies);
  assert.deepEqual(out({ replies: two }, 'answered'), [2]);
  assert.deepEqual(out({ replies: [] }, 'fixed'), [0]);
  assert.deepEqual(out({ replies: two }, 'open'), [2]);
});
test('a verdict the model had no right to give is dropped, and says why', () => {
  const cases: Array<[string, () => ReturnType<typeof reconcileVerdicts>]> = [
    ['unknown_thread', () => reconcileVerdicts([answer([{ thread_id: 'T9', verdict: 'open' }])], [shown()], [ctxA], 'h2')],
    ['not_shown', () => reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'open' }], [])], [shown()], [ctxA], 'h2')],
    ['not_due', () => reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'fixed', reply: REASON }])], [shown({}, false)], [ctxB], 'h2')],
    ['bad_verdict', () => reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'resolved', reply: REASON }])], [shown()], [ctxA], 'h2')],
    ['no_reason', () => reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'fixed', reply: ' \n ' }])], [shown()], [ctxB], 'h2')],
    ['no_reply', () => reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'answered', reply: REASON }])], [shown({ replies: [{ author: 'visto-test', kind: 'app', body: 'x' }] })], [ctxA], 'h2')],
    ['same_head', () => reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'fixed', reply: REASON }])], [shown()], [ctxB], 'h1')],
  ];
  for (const [reason, run] of cases) assert.deepEqual([run().verdicts, run().audit.map((a) => [a.action, a.reason])], [[], [['verdict_dropped', reason]]], reason);
});
test('a dropped verdict names the id as given, cut to 40 characters', () => {
  const id = ` T9${'x'.repeat(60)}`;
  const out = reconcileVerdicts([answer([{ thread_id: id, verdict: 'open' }])], [shown()], [ctxA], 'h2');
  assert.deepEqual(out.audit, [{ stage: 'reconcile', action: 'verdict_dropped', subject: id.slice(0, 40), reason: 'unknown_thread' }]);
  const padded = reconcileVerdicts([answer([{ thread_id: ' T1 ', verdict: 'open' }])], [shown()], [ctxA], 'h2');
  assert.equal(padded.verdicts.length, 1);
});
test('the first verdict for a thread stands and a second is dropped as repeated', () => {
  const out = reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'open' }, { thread_id: 'T1', verdict: 'fixed', reply: REASON }])], [shown()], [ctxB], 'h2');
  assert.deepEqual(out.verdicts.map((v) => v.verdict), ['open']);
  assert.deepEqual(out.audit, [{ stage: 'reconcile', action: 'verdict_dropped', subject: 'T1', reason: 'repeated' }]);
  const across = reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'open' }]), answer([{ thread_id: 'T1', verdict: 'open' }])], [shown()], [ctxA], 'h2');
  assert.deepEqual([across.verdicts.length, across.audit.map((a) => a.reason)], [1, ['repeated']]);
});
test("a fix is tied to the thread only when the thread's file has another diff than before", () => {
  const fixed = (ctx: FileContext, over: Partial<EarlierThread> = {}, verdict = 'fixed'): ThreadVerdict[] =>
    reconcileVerdicts([answer([{ thread_id: 'T1', verdict, reply: REASON }])], [shown(over)], [ctx], 'h2').verdicts;
  assert.deepEqual(fixed(ctxB).map((v) => v.fileChanged), [true]);
  assert.deepEqual(fixed(ctxA).map((v) => v.fileChanged), [false]);
  assert.deepEqual(fixed(ctxB, { openedAt: { head: 'h1', diffHash: null } }).map((v) => v.fileChanged), [false]);
  assert.deepEqual(fixed(ctxB, {}, 'answered').map((v) => [v.verdict, v.fileChanged]), [['answered', false]]);
  assert.deepEqual(fixed(ctxB, {}, 'open').map((v) => [v.verdict, v.fileChanged]), [['open', false]]);
});
test('an answer without the list of threads it was shown keeps no verdict', () => {
  const { value, files } = answer([{ thread_id: 'T1', verdict: 'open' }]);
  const out = reconcileVerdicts([{ value, files }], [shown()], [ctxA], 'h2');
  assert.deepEqual([out.verdicts, out.audit.map((a) => a.reason)], [[], ['not_shown']]);
});
test("another bot's reply can be accepted, an open verdict needs no reason, and a reason is made one line of at most 600 characters", () => {
  const bot = reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'answered', reply: REASON }])], [shown({ replies: [{ author: 'lint-bot', kind: 'bot', body: 'ok' }] })], [ctxA], 'h2');
  assert.deepEqual(bot.verdicts.map((v) => [v.verdict, v.reply]), [['answered', REASON]]);
  const open = reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'open', reply: '' }])], [shown()], [ctxA], 'h2');
  assert.deepEqual(open.verdicts.map((v) => [v.verdict, v.reply]), [['open', '']]);
  const none = reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'open' }])], [shown()], [ctxA], 'h2');
  assert.deepEqual(none.verdicts.map((v) => v.reply), ['']);
  const long = `${'word\n'.repeat(119)}abcd\ud83d\ude00tail`; // 599 characters, then a pair that would be split at 600
  const cut = reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'open', reply: long }])], [shown()], [ctxA], 'h2').verdicts[0]!.reply;
  assert.ok(cut.length <= 600);
  assert.equal(cut.length, 599);
  assert.ok(!cut.includes('\n'));
  const last = cut.charCodeAt(cut.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff));
  const plain = reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'open', reply: 'y\n'.repeat(400) }])], [shown()], [ctxA], 'h2').verdicts[0]!.reply;
  assert.equal(plain.length, 600);
  assert.ok(!plain.includes('\n'));
});
test('a reason that holds only characters nobody can see is no reason', () => {
  for (const hidden of ['\u200b', '\u2060', '\u202e', '\u0000']) {
    for (const verdict of ['fixed', 'answered']) {
      const out = reconcileVerdicts([answer([{ thread_id: 'T1', verdict, reply: ` ${hidden} ${hidden}` }])], [shown()], [ctxB], 'h2');
      assert.deepEqual([out.verdicts, out.audit.map((a) => a.reason)], [[], ['no_reason']], `${verdict} ${hidden.charCodeAt(0).toString(16)}`);
    }
  }
  const kept = reconcileVerdicts([answer([{ thread_id: 'T1', verdict: 'fixed', reply: `Line\u200b 14 now\u202e checks it.` }])], [shown()], [ctxB], 'h2');
  assert.deepEqual(kept.verdicts.map((v) => v.reply), ['Line 14 now checks it.']);
});

const finding = (over = {}) => ({ path: 'src/a.ts', side: 'RIGHT' as const, line: 14, severity: 'major' as const, quote: 'total = a +  b', body: 'x', ...over });
test('a finding that sits within 3 lines of an earlier thread of its class, or quotes the code of one whose line is gone, is a duplicate', () => {
  const t = thread({ line: 12, quote: ' total = a + b ' });
  assert.deepEqual(dropDuplicates([finding({ line: 40 })], [t], [], FILES).kept.length, 1);                          // the same quote far from a thread that has a line
  assert.deepEqual(dropDuplicates([finding({ line: 40 })], [{ ...t, line: null }], [], FILES).audit.map((a) => a.reason), ['same_quote']);
  assert.deepEqual(dropDuplicates([finding()], [t], [], FILES).audit.map((a) => a.reason), ['near_thread']);
  assert.deepEqual(dropDuplicates([finding({ quote: 'other' })], [t], [], FILES).audit.map((a) => a.reason), ['near_thread']);
  assert.deepEqual(dropDuplicates([finding({ quote: 'other', line: 16 })], [t], [], FILES).kept.length, 1);          // 4 lines away
  assert.deepEqual(dropDuplicates([finding({ quote: 'other', side: 'LEFT' })], [t], [], FILES).kept.length, 1);      // the other side
  assert.deepEqual(dropDuplicates([finding({ quote: '' })], [thread({ line: null, quote: '' })], [], FILES).kept.length, 1);
});
test('a duplicate is audited by its place and goes to dropped with its thread', () => {
  const t = thread({ line: null, quote: 'total = a + b' });
  const f = finding({ line: 40 });
  const out = dropDuplicates([f, finding({ quote: 'other', line: 80 })], [t], [], FILES);
  assert.deepEqual(out.dropped, [{ finding: f, thread: t }]);
  assert.deepEqual(out.kept.map((k) => k.line), [80]);
  assert.deepEqual(out.audit, [{ stage: 'reconcile', action: 'duplicate', subject: 'src/a.ts:40', reason: 'same_quote' }]);
});
test('a blocking finding is never a duplicate of a minor thread, and a minor one is of a minor thread', () => {
  const minorThread = thread({ severity: 'minor', quote: 'total = a + b' });
  assert.equal(dropDuplicates([finding()], [minorThread], [], FILES).kept.length, 1);
  assert.equal(dropDuplicates([finding({ severity: 'blocker' })], [minorThread], [], FILES).kept.length, 1);
  assert.deepEqual(dropDuplicates([finding({ severity: 'minor', quote: 'other' })], [minorThread], [], FILES).audit.map((a) => a.reason), ['near_thread']);
  const majorThread = thread({ quote: 'total = a + b' });
  assert.equal(dropDuplicates([finding({ severity: 'minor', quote: 'other' })], [majorThread], [], FILES).kept.length, 1);
  assert.deepEqual(dropDuplicates([finding({ severity: 'minor' })], [majorThread], [], FILES).kept.length, 1);
  assert.deepEqual(dropDuplicates([finding({ severity: 'minor' })], [{ ...majorThread, line: null }], [], FILES).audit.map((a) => a.reason), ['same_quote']);
});
test('a thread marked fixed, in this run or an earlier one, hides nothing', () => {
  const t = thread({ quote: 'total = a + b' });
  const kept = (over: Partial<EarlierThread>, verdicts: ThreadVerdict[]): number => dropDuplicates([finding()], [{ ...t, ...over }], verdicts, FILES).kept.length;
  const verdict = (v: ThreadVerdict['verdict']): ThreadVerdict => ({ threadId: t.id, commentId: t.commentId, verdict: v, reply: REASON, fileChanged: false });
  assert.equal(kept({ lastVerdict: 'fixed' }, []), 1);
  assert.equal(kept({ lastVerdict: 'open' }, [verdict('fixed')]), 1);
  assert.equal(kept({ lastVerdict: 'fixed' }, [verdict('open')]), 0);
  assert.equal(kept({ lastVerdict: 'fixed' }, [{ ...verdict('open'), threadId: 'PRRT_other' }]), 1);
});
test('a thread on the file under its earlier name counts, and a thread on another file does not', () => {
  const moved: ChangedFile[] = [{ ...fileOf(PATCH_A), status: 'renamed', previousPath: 'lib/a.ts' }];
  assert.deepEqual(dropDuplicates([finding()], [thread({ path: 'lib/a.ts', line: null, quote: 'total = a + b' })], [], moved).audit.map((a) => a.reason), ['same_quote']);
  assert.equal(dropDuplicates([finding()], [thread({ path: 'src/z.ts', quote: 'total = a + b' })], [], moved).kept.length, 1);
});
test('the first thread that matches, in the order given, decides', () => {
  const first = thread({ id: 'PRRT_1', quote: 'other' });
  const second = thread({ id: 'PRRT_2', line: 80, quote: 'total = a + b' });
  const out = dropDuplicates([finding()], [first, second], [], FILES);
  assert.deepEqual([out.dropped.map((d) => d.thread.id), out.audit.map((a) => a.reason)], [['PRRT_1'], ['near_thread']]);
});
