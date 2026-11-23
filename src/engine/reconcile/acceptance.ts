// Acceptance rows: what the model said of each criterion it was shown, checked and merged by rule (5.5, 5.7).
// No model call merges anything, and the service never writes a not_met that no answer gave.
import { stripControl } from '../context/untrusted.ts';
import type { SubmitReviewArgs } from '../model/submit-review.ts';
import type { AcceptanceRow, AcceptanceStatus, AuditEntry } from '../types.ts';

const STATUSES: ReadonlySet<string> = new Set(['met', 'not_met', 'not_verified']);
const FROM: ReadonlySet<string> = new Set(['review', 'earlier', 'none']);
const NOTE_CHARS = 300;
const SUBJECT_CHARS = 40;
const ITEM = /^a?([1-9][0-9]*)$/i;

// Cuts at `limit` characters without splitting a surrogate pair.
function cutAt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

const oneLine = (text: string, limit: number): string => cutAt(stripControl(text).text.replace(/\s+/g, ' ').trim(), limit).trim();

interface Kept { index: number; status: AcceptanceStatus; note: string }

const dropped = (subject: string, reason: string): AuditEntry => ({ stage: 'reconcile', action: 'acceptance_dropped', subject, reason });

// The rows of one answer that hold, each for the criterion of its index; every other is named in the audit.
function rowsOf(entries: unknown, count: number, audit: AuditEntry[]): Kept[] {
  const kept: Kept[] = [];
  if (!Array.isArray(entries)) return kept;
  const named = new Set<number>();
  for (const entry of entries as unknown[]) {
    // Every read of an entry happens here: one that throws as it is read is an entry of the wrong shape.
    let item: string | number;
    let status: string;
    let note: string;
    try {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('bad_shape');
      const { item: i, status: s, note: n } = entry as Record<string, unknown>;
      if (typeof i === 'string') item = i;
      else if (typeof i === 'number' && Number.isInteger(i)) item = i;
      else throw new Error('bad_shape');
      if (typeof s !== 'string' || (n !== undefined && n !== null && typeof n !== 'string')) {
        audit.push(dropped(subjectOf(item), 'bad_shape'));
        continue;
      }
      status = s;
      note = typeof n === 'string' ? n : '';
    } catch {
      audit.push(dropped('row', 'bad_shape'));
      continue;
    }
    const subject = subjectOf(item);
    const id = typeof item === 'number' ? `A${item}` : item.trim();
    const match = ITEM.exec(id);
    const n = match === null ? 0 : Number(match[1]);
    if (n < 1 || n > count) {
      audit.push(dropped(subject, 'unknown_item'));
      continue;
    }
    if (!STATUSES.has(status)) {
      audit.push(dropped(subject, 'bad_status'));
      continue;
    }
    if (named.has(n)) {
      audit.push(dropped(subject, 'repeated'));
      continue;
    }
    named.add(n);
    const line = oneLine(note, NOTE_CHARS);
    if (line === '' && status !== 'not_verified') {
      audit.push(dropped(subject, 'no_note'));
      continue;
    }
    kept.push({ index: n - 1, status: status as AcceptanceStatus, note: line });
  }
  return kept;
}

// The item as text, on one line and at most 40 characters; `row` when nothing of it can be written.
function subjectOf(item: string | number): string {
  const text = typeof item === 'number' ? `A${item}` : oneLine(item, SUBJECT_CHARS);
  return text === '' ? 'row' : text;
}

/** One row for each criterion, in order. `carry`: a criterion no answer judged keeps the earlier row of the same text. */
export function reconcileAcceptance(answers: Array<{ value: SubmitReviewArgs }>, criteria: string[], earlier: AcceptanceRow[], carry: boolean):
  { rows: AcceptanceRow[]; audit: AuditEntry[] } {
  const audit: AuditEntry[] = [];
  const said: Kept[][] = criteria.map(() => []);
  for (const answer of answers) {
    for (const one of rowsOf(answer.value.acceptance, criteria.length, audit)) said[one.index]!.push(one);
  }
  const rows = criteria.map((criterion, i): AcceptanceRow => {
    const given = said[i]!;
    const notMet = given.find((r) => r.status === 'not_met');
    const met = given.find((r) => r.status === 'met');
    if (notMet !== undefined) {
      if (met !== undefined) audit.push({ stage: 'reconcile', action: 'acceptance_disagreement', subject: `A${i + 1}`, reason: 'not_met' });
      return { criterion, status: 'not_met', note: notMet.note, from: 'review' };
    }
    if (met !== undefined) return { criterion, status: 'met', note: met.note, from: 'review' };
    const unsure = given[0];
    if (unsure !== undefined) return { criterion, status: 'not_verified', note: unsure.note, from: 'review' };
    const before = carry ? earlier.find((r) => r.criterion === criterion && r.from !== 'none') : undefined;
    if (before !== undefined) return { criterion, status: before.status, note: before.note, from: 'earlier' };
    return { criterion, status: 'not_verified', note: '', from: 'none' };
  });
  return { rows, audit };
}

/** The rows of a stored result's `acceptance`, each checked: the one reader of stored rows. [] for a value that is no list. */
export function readAcceptance(value: unknown): AcceptanceRow[] {
  if (!Array.isArray(value)) return [];
  const rows: AcceptanceRow[] = [];
  for (const one of value as unknown[]) {
    try {
      if (typeof one !== 'object' || one === null) continue;
      const { criterion, status, note, from } = one as Record<string, unknown>;
      if (typeof criterion !== 'string' || criterion === '' || typeof status !== 'string' || !STATUSES.has(status) || typeof note !== 'string') continue;
      rows.push({ criterion, status: status as AcceptanceStatus, note, from: typeof from === 'string' && FROM.has(from) ? (from as AcceptanceRow['from']) : 'review' });
    } catch {
      // a row that throws when it is read is skipped
    }
  }
  return rows;
}
