// A finding's thread state, derived from what is stored. Pure.
import type { CommentRow, ThreadEventRow, VerdictRow } from '../db/review-page.ts';
import type { ThreadState } from './api-types.ts';
import type { ReadFinding } from './review-result.ts';

/** For each placed finding, in order, the id of its first comment; null when none is left for it. */
export function commentsOf(
  findings: ReadonlyArray<Pick<ReadFinding, 'path' | 'side' | 'line' | 'severity' | 'quote'>>, rows: readonly CommentRow[],
): Array<string | null> {
  const taken = new Set<number>();
  const found: Array<string | null> = findings.map(() => null);
  const pass = (exact: boolean): void => {
    findings.forEach((finding, index) => {
      if (found[index] !== null) return;
      const at = rows.findIndex((row, i) => !taken.has(i) && row.path === finding.path && row.side === finding.side
        && row.severity === finding.severity && row.quote === finding.quote && row.line === (exact ? finding.line : null));
      if (at < 0) return;
      taken.add(at);
      found[index] = rows[at]!.comment_id;
    });
  };
  pass(true);
  pass(false);
  return found;
}

export interface ThreadSignal { at: string; kind: 'resolved' | 'unresolved' | 'fixed' | 'answered' | 'open'; by: string | null; event: boolean }

/** Each comment id's signals: its people's events and its later verdicts. */
export function signalsOf(events: readonly ThreadEventRow[], verdicts: readonly VerdictRow[]): Map<string, ThreadSignal[]> {
  const map = new Map<string, ThreadSignal[]>();
  const add = (id: string, signal: ThreadSignal): void => {
    const list = map.get(id);
    if (list) list.push(signal); else map.set(id, [signal]);
  };
  for (const event of events) {
    add(event.reply_to, event.kind === 'thread_resolved'
      ? { at: event.at.toISOString(), kind: 'resolved', by: event.author, event: true }
      : { at: event.at.toISOString(), kind: 'unresolved', by: null, event: true });
  }
  for (const verdict of verdicts) {
    if (verdict.verdict !== 'fixed' && verdict.verdict !== 'answered' && verdict.verdict !== 'open') continue;
    add(verdict.comment_id, { at: verdict.started_at.toISOString(), kind: verdict.verdict, by: null, event: false });
  }
  return map;
}

/** The state the signals say: the latest decides, a person's event wins a tie, then the later in the list. */
export function threadOf(signals: readonly ThreadSignal[]): { state: ThreadState; by: string | null } {
  let best: ThreadSignal | null = null;
  let bestTime = 0;
  for (const signal of signals) {
    const time = Date.parse(signal.at);
    if (best === null || time > bestTime || (time === bestTime && (signal.event || !best.event))) {
      best = signal;
      bestTime = time;
    }
  }
  if (best === null) return { state: 'open', by: null };
  if (best.kind === 'resolved') return { state: 'resolved', by: best.by };
  if (best.kind === 'fixed' || best.kind === 'answered') return { state: best.kind, by: null };
  return { state: 'open', by: null };
}
