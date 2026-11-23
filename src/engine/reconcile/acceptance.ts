// Acceptance rows: what the model said of each criterion it was shown, checked and merged by rule (5.5, 5.7).
// No model call merges anything, and the service never writes a not_met that no answer gave.
import { CRITERIA_MAX, CRITERION_CHARS } from '../context/extensions.ts';
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

// Stripped, made well formed, one line, trimmed and cut: what a fresh criterion and a fresh note are made.
const oneLine = (text: string, limit: number): string => cutAt(stripControl(text).text.toWellFormed().replace(/\s+/g, ' ').trim(), limit).trim();

interface Kept { index: number; status: AcceptanceStatus; note: string }

const dropped = (subject: string, reason: string): AuditEntry => ({ stage: 'reconcile', action: 'acceptance_dropped', subject, reason });

// The rows of one answer that hold, each for the criterion of its index; every other is named in the audit.
function rowsOf(entries: unknown, count: number, audit: AuditEntry[]): Kept[] {
  const kept: Kept[] = [];
  if (entries === undefined) return kept;
  if (!Array.isArray(entries)) {
    // A value that is no list costs the rows, never the answer.
    audit.push(dropped('acceptance', 'bad_shape'));
    return kept;
  }
  const named = new Set<number>();
  for (const entry of entries as unknown[]) {
    // Every read of an entry happens inside a guard: a read that throws is a row of the wrong shape.
    let item: string | number;
    try {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('bad_shape');
      const i = (entry as Record<string, unknown>).item;
      if (typeof i === 'string') item = i;
      else if (typeof i === 'number' && Number.isInteger(i)) item = i;
      else throw new Error('bad_shape');
    } catch {
      audit.push(dropped('row', 'bad_shape'));
      continue;
    }
    let status: string | null = null;
    let note = '';
    try {
      const { status: s, note: n } = entry as Record<string, unknown>;
      if (typeof s === 'string' && (n === undefined || n === null || typeof n === 'string')) {
        status = s;
        note = typeof n === 'string' ? n : '';
      }
    } catch {
      status = null;
    }
    const subject = subjectOf(item);
    const id = typeof item === 'number' ? `A${item}` : item.trim();
    const match = ITEM.exec(id);
    const n = match === null ? 0 : Number(match[1]);
    const known = n >= 1 && n <= count;
    // A row whose id is well formed and known claims it, whatever else is wrong with it: the first row for an item decides.
    if (known && named.has(n)) {
      audit.push(dropped(subject, 'repeated'));
      continue;
    }
    if (known) named.add(n);
    if (status === null) {
      audit.push(dropped(subject, 'bad_shape'));
      continue;
    }
    if (!known) {
      audit.push(dropped(subject, 'unknown_item'));
      continue;
    }
    if (!STATUSES.has(status)) {
      audit.push(dropped(subject, 'bad_status'));
      continue;
    }
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
  const list: unknown[] = Array.isArray(criteria) ? criteria : [];
  const before: AcceptanceRow[] = Array.isArray(earlier) ? earlier.filter((r) => typeof r === 'object' && r !== null) : [];
  const said: Kept[][] = list.map(() => []);
  for (const answer of answers) {
    for (const one of rowsOf(answer.value.acceptance, list.length, audit)) said[one.index]!.push(one);
  }
  // Ids are places in the list as it was shown; a criterion that is not a string has no row.
  const rows = list.flatMap((criterion, i): AcceptanceRow[] => (typeof criterion === 'string' ? [rowFor(criterion, i, said[i]!, before, carry, audit)] : []));
  return { rows, audit };
}

function rowFor(criterion: string, i: number, given: Kept[], earlier: AcceptanceRow[], carry: boolean, audit: AuditEntry[]): AcceptanceRow {
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
}

/** The rows of a stored result's `acceptance`, each checked: the one reader of stored rows. [] for a value that is no list. */
export function readAcceptance(value: unknown): AcceptanceRow[] {
  if (!Array.isArray(value)) return [];
  const rows: AcceptanceRow[] = [];
  for (const one of value as unknown[]) {
    // No more rows than there can be criteria: a damaged result cannot fill a body.
    if (rows.length >= CRITERIA_MAX) break;
    try {
      if (typeof one !== 'object' || one === null) continue;
      const { criterion, status, note, from } = one as Record<string, unknown>;
      if (typeof criterion !== 'string' || typeof status !== 'string' || !STATUSES.has(status) || typeof note !== 'string') continue;
      // The checks of a fresh row: the criterion and the note cleaned and cut alike, and a claim with no note is no row.
      const text = oneLine(criterion, CRITERION_CHARS);
      const line = oneLine(note, NOTE_CHARS);
      if (text === '' || (line === '' && status !== 'not_verified')) continue;
      rows.push({ criterion: text, status: status as AcceptanceStatus, note: line, from: typeof from === 'string' && FROM.has(from) ? (from as AcceptanceRow['from']) : 'review' });
    } catch {
      // a row that throws when it is read is skipped
    }
  }
  return rows;
}
