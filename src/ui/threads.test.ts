import test from 'node:test';
import assert from 'node:assert/strict';
import { commentsOf, signalsOf, threadOf, type ThreadSignal } from './threads.ts';
import type { CommentRow, ThreadEventRow, VerdictRow } from '../db/review-page.ts';

const at = (n: number): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
const finding = (path: string, side: 'LEFT' | 'RIGHT', line: number, severity: 'blocker' | 'major' | 'minor', quote: string) => ({ path, side, line, severity, quote });
const row = (comment_id: string, path: string, side: string, line: number | null, severity: string, quote: string): CommentRow => ({ comment_id, path, side, line, severity, quote });
const sig = (n: number, kind: ThreadSignal['kind'], by: string | null, event: boolean): ThreadSignal => ({ at: at(n).toISOString(), kind, by, event });

test('each placed finding takes the first unused comment of its place, severity and quote', () => {
  const findings = [finding('a.ts', 'RIGHT', 9, 'major', 'q'), finding('a.ts', 'RIGHT', 12, 'major', 'q'), finding('b.ts', 'RIGHT', 3, 'minor', 'r')];
  const rows = [row('c-1', 'a.ts', 'RIGHT', 12, 'major', 'q'), row('c-2', 'a.ts', 'RIGHT', 9, 'major', 'q'), row('c-3', 'b.ts', 'RIGHT', null, 'minor', 'r')];
  assert.deepEqual(commentsOf(findings, rows), ['c-2', 'c-1', 'c-3']);
  const other = [row('c-1', 'a.ts', 'RIGHT', 12, 'minor', 'q'), row('c-2', 'a.ts', 'LEFT', 9, 'major', 'q')];
  assert.deepEqual(commentsOf(findings.slice(0, 2), other), [null, null]);
  const three = [finding('a.ts', 'RIGHT', 9, 'major', 'q'), finding('a.ts', 'RIGHT', 9, 'major', 'q'), finding('a.ts', 'RIGHT', 9, 'major', 'q')];
  assert.deepEqual(commentsOf(three, [row('c-2', 'a.ts', 'RIGHT', 9, 'major', 'q')]), ['c-2', null, null]);
  const two = findings.slice(0, 2);
  const nullFirst = [row('c-4', 'a.ts', 'RIGHT', null, 'major', 'q'), row('c-5', 'a.ts', 'RIGHT', 9, 'major', 'q')];
  assert.deepEqual(commentsOf(two, nullFirst), ['c-5', 'c-4']);
  assert.deepEqual(commentsOf(two, [...nullFirst].reverse()), ['c-5', 'c-4']);
});

test("the newest signal decides, a person's event wins a tie, and none reads as open", () => {
  assert.deepEqual(threadOf([sig(10, 'resolved', 'octo-lead', true), sig(20, 'fixed', null, false)]), { state: 'fixed', by: null });
  assert.deepEqual(threadOf([sig(10, 'fixed', null, false), sig(20, 'unresolved', null, true)]), { state: 'open', by: null });
  assert.deepEqual(threadOf([sig(20, 'resolved', 'octo-lead', true), sig(20, 'open', null, false)]), { state: 'resolved', by: 'octo-lead' });
  assert.deepEqual(threadOf([sig(20, 'open', null, false), sig(20, 'resolved', 'octo-lead', true)]), { state: 'resolved', by: 'octo-lead' });
  assert.deepEqual(threadOf([sig(5, 'answered', null, false)]), { state: 'answered', by: null });
  assert.deepEqual(threadOf([]), { state: 'open', by: null });
  assert.deepEqual(threadOf([sig(7, 'resolved', 'octo-lead', true), sig(7, 'resolved', 'octo-dev', true)]), { state: 'resolved', by: 'octo-dev' });
});

test("signals are built from a comment's own events and verdicts, and an unknown verdict is none", () => {
  const events: ThreadEventRow[] = [
    { reply_to: 'c-1', kind: 'thread_resolved', author: 'octo-lead', at: at(10) },
    { reply_to: 'c-2', kind: 'thread_unresolved', author: 'octo-dev', at: at(11) },
  ];
  const verdicts: VerdictRow[] = [
    { run: 2, started_at: at(30), comment_id: 'c-1', verdict: 'fixed' },
    { run: 2, started_at: at(30), comment_id: 'c-1', verdict: 'maybe' },
    { run: 2, started_at: at(30), comment_id: 'c-1', verdict: null },
  ];
  const map = signalsOf(events, verdicts);
  assert.deepEqual(map.get('c-1'), [
    { at: at(10).toISOString(), kind: 'resolved', by: 'octo-lead', event: true },
    { at: at(30).toISOString(), kind: 'fixed', by: null, event: false },
  ]);
  assert.deepEqual(map.get('c-2'), [{ at: at(11).toISOString(), kind: 'unresolved', by: null, event: true }]);
});
