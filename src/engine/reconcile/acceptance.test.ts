import assert from 'node:assert/strict';
import test from 'node:test';
import { readAcceptance, reconcileAcceptance } from './acceptance.ts';
import type { SubmitReviewArgs } from '../model/submit-review.ts';
import type { AcceptanceRow } from '../types.ts';

const CRITERIA = ['Orders above the limit are refused.', 'A refund writes an audit row.', 'The export is paged.'];
const answer = (...acceptance: unknown[]): { value: SubmitReviewArgs } => ({ value: { overview: 'Changes src/a.ts.', findings: [], files: [], acceptance } });
const silent = (): { value: SubmitReviewArgs } => ({ value: { overview: 'Changes src/a.ts.', findings: [], files: [] } });
const dropped = (audit: Array<{ action: string; subject: string; reason: string }>) =>
  audit.filter((e) => e.action === 'acceptance_dropped').map((e) => [e.subject, e.reason]);
const row = (criterion: string, status: AcceptanceRow['status'], note: string, from: AcceptanceRow['from']): AcceptanceRow => ({ criterion, status, note, from });
const NONE = (criterion: string): AcceptanceRow => row(criterion, 'not_verified', '', 'none');

test('a row that is not well formed is dropped by itself, and a number is read as an id', () => {
  const throwing = { item: 'A9', note: 'x', get status(): string { throw new Error('trap'); } };
  const listProxy = new Proxy({}, { get: () => { throw new Error('trap'); }, has: () => { throw new Error('trap'); } });
  const got = reconcileAcceptance([answer(
    5, null, [], { item: {}, status: 'met', note: 'x' }, { item: 'A1' }, { item: 'A3', status: 'met', note: 7 }, throwing, listProxy,
    { item: 2.5, status: 'met', note: 'x' }, { item: 2, status: 'met', note: 'In src/a.ts:3.' },
  )], CRITERIA, [], false);
  assert.deepEqual(dropped(got.audit), [
    ['row', 'bad_shape'], ['row', 'bad_shape'], ['row', 'bad_shape'], ['row', 'bad_shape'], ['A1', 'bad_shape'], ['A3', 'bad_shape'], ['A9', 'bad_shape'],
    ['row', 'bad_shape'], ['row', 'bad_shape'],
  ]);
  assert.ok(got.audit.every((e) => e.stage === 'reconcile'));
  assert.deepEqual(got.rows, [NONE(CRITERIA[0]!), row(CRITERIA[1]!, 'met', 'In src/a.ts:3.', 'review'), NONE(CRITERIA[2]!)]);
  // A subject is the item as text, at most 40 characters, on one line.
  const long = reconcileAcceptance([answer({ item: `Z${'9'.repeat(60)}\nnext`, status: 'met', note: 'x' })], CRITERIA, [], false);
  const subject = long.audit[0]!.subject;
  assert.equal(subject.length <= 40, true);
  assert.equal(subject.includes('\n'), false);
});

test('stored rows are read one by one', () => {
  for (const value of [undefined, 'x', {}, null, 5]) assert.deepEqual(readAcceptance(value), []);
  const good = row('c', 'met', 'In src/a.ts:3.', 'earlier');
  assert.deepEqual(readAcceptance([
    { criterion: 5 }, { criterion: 'c', status: 'done', note: '' }, { criterion: 'c', status: 'met' }, { criterion: '', status: 'met', note: '' },
    null, 'row', { ...good, from: 'x' }, good,
  ]), [{ ...good, from: 'review' }, good]);
  // A stored row gets the checks a fresh row gets.
  const long = readAcceptance([{ criterion: 'c', status: 'met', note: Array.from({ length: 1000 }, (_, i) => `line ${i} ${'n'.repeat(90)}`).join('\n') }]);
  assert.equal(long.length, 1);
  assert.equal(long[0]!.note.includes('\n'), false);
  assert.equal(long[0]!.note.length <= 300, true);
  assert.equal(long[0]!.note.startsWith('line 0 n'), true);
  assert.deepEqual(readAcceptance([
    { criterion: 'c', status: 'met', note: '' }, { criterion: 'c', status: 'not_met', note: ' \u200b\n ' }, { criterion: 'c', status: 'not_verified', note: '' },
    { criterion: 'd', status: 'met', note: ' In\u200b src/a.ts:3. ' },
  ]), [row('c', 'not_verified', '', 'review'), row('d', 'met', 'In src/a.ts:3.', 'review')]);
  const throwing = { criterion: 'c', note: '', get status(): string { throw new Error('trap'); } };
  assert.deepEqual(readAcceptance([throwing, good]), [good]);
});

test('a row counts only for a criterion that was shown, with a status of the three, once for each answer, and with a note when it claims', () => {
  const unknown = reconcileAcceptance([answer(
    { item: 'A4', status: 'met', note: 'x' }, { item: 'A0', status: 'met', note: 'x' }, { item: 'x', status: 'met', note: 'x' }, { item: '', status: 'met', note: 'x' },
    { item: 0, status: 'met', note: 'x' }, { item: 'A01', status: 'met', note: 'x' },
  )], CRITERIA, [], false);
  assert.deepEqual(dropped(unknown.audit), [['A4', 'unknown_item'], ['A0', 'unknown_item'], ['x', 'unknown_item'], ['row', 'unknown_item'], ['A0', 'unknown_item'], ['A01', 'unknown_item']]);
  assert.deepEqual(unknown.rows, CRITERIA.map(NONE));

  const status = reconcileAcceptance([answer({ item: 'A1', status: 'done', note: 'x' }, { item: 'A1', status: 'MET', note: 'x' })], CRITERIA, [], false);
  assert.deepEqual(dropped(status.audit), [['A1', 'bad_status'], ['A1', 'repeated']]);

  const twice = reconcileAcceptance([answer({ item: 'A1', status: 'met', note: 'First.' }, { item: 'a1', status: 'not_met', note: 'Second.' })], CRITERIA, [], false);
  assert.deepEqual(dropped(twice.audit), [['a1', 'repeated']]);
  assert.deepEqual(twice.rows[0], row(CRITERIA[0]!, 'met', 'First.', 'review'));

  const noNote = reconcileAcceptance([answer(
    { item: 'A1', status: 'met', note: '' }, { item: 'A2', status: 'not_met', note: ' \u200b ' }, { item: 'A3', status: 'met' }, { item: 'A3', status: 'not_met', note: null },
  )], CRITERIA, [], false);
  assert.deepEqual(dropped(noNote.audit), [['A1', 'no_note'], ['A2', 'no_note'], ['A3', 'no_note'], ['A3', 'repeated']]);
  assert.deepEqual(noNote.rows, CRITERIA.map(NONE));

  for (const item of ['a2', ' A2 ', '2', 2]) {
    const kept = reconcileAcceptance([answer({ item, status: 'met', note: 'In src/a.ts:3.' })], CRITERIA, [], false);
    assert.deepEqual([kept.rows[1], kept.audit], [row(CRITERIA[1]!, 'met', 'In src/a.ts:3.', 'review'), []], String(item));
  }
  const unsure = reconcileAcceptance([answer({ item: 'A3', status: 'not_verified' })], CRITERIA, [], false);
  assert.deepEqual([unsure.rows[2], unsure.audit], [row(CRITERIA[2]!, 'not_verified', '', 'review'), []]);

  const long = reconcileAcceptance([answer({ item: 'A1', status: 'met', note: `${'w'.repeat(200)}\n\t${'v'.repeat(200)}` })], CRITERIA, [], false);
  assert.equal(long.rows[0]!.note, `${'w'.repeat(200)} ${'v'.repeat(99)}`);
  const pair = reconcileAcceptance([answer({ item: 'A1', status: 'met', note: `${'p'.repeat(299)}\ud83d\ude00` })], CRITERIA, [], false);
  assert.equal(pair.rows[0]!.note, 'p'.repeat(299));
  const hidden = reconcileAcceptance([answer({ item: 'A1', status: 'met', note: 'In\u200b src/a.ts:3.' })], CRITERIA, [], false);
  assert.equal(hidden.rows[0]!.note, 'In src/a.ts:3.');
});

test('the first row for an item decides, damaged or not', () => {
  const firsts: unknown[][] = [
    [{ item: 'A1', status: 'done' }, { item: 'A1', status: 'met', note: 'In src/a.ts:3.' }],
    [{ item: 'A1', status: 'met' }, { item: 'A1', status: 'met', note: 'In src/a.ts:3.' }],
    [{ item: 'A1', status: 'met', note: 7 }, { item: 'A1', status: 'met', note: 'In src/a.ts:3.' }],
    [{ item: 1 }, { item: 'A1', status: 'met', note: 'In src/a.ts:3.' }],
  ];
  for (const rows of firsts) {
    const got = reconcileAcceptance([answer(...rows)], CRITERIA, [], false);
    assert.deepEqual(got.rows, CRITERIA.map(NONE), JSON.stringify(rows));
    assert.deepEqual(dropped(got.audit).at(-1), ['A1', 'repeated'], JSON.stringify(rows));
  }
  // A row whose id is not known claims nothing.
  const unknown = reconcileAcceptance([answer({ item: 'A9', status: 'met', note: 'x' }, { item: 'A1', status: 'met', note: 'In src/a.ts:3.' })], CRITERIA, [], false);
  assert.deepEqual(unknown.rows[0], row(CRITERIA[0]!, 'met', 'In src/a.ts:3.', 'review'));
});

test('a list of rows that is no list costs the rows and nothing else', () => {
  for (const junk of ['x', 5, { item: 'A1', status: 'met', note: 'x' }, true]) {
    const got = reconcileAcceptance([{ value: { overview: 'Changes src/a.ts.', findings: [], files: [], acceptance: junk } }], CRITERIA, [], false);
    assert.deepEqual(got.rows, CRITERIA.map(NONE));
    assert.deepEqual(got.audit, [{ stage: 'reconcile', action: 'acceptance_dropped', subject: 'acceptance', reason: 'bad_shape' }]);
  }
  assert.deepEqual(reconcileAcceptance([silent()], CRITERIA, [], false).audit, []);
});

test('a criterion that is not a string has no row, and nothing is thrown', () => {
  const criteria = [CRITERIA[0], undefined, 5, {}, CRITERIA[1]] as unknown as string[];
  const got = reconcileAcceptance([answer({ item: 'A5', status: 'met', note: 'In src/a.ts:3.' }, { item: 'A2', status: 'met', note: 'x' })], criteria, [null, 5] as never, true);
  assert.deepEqual(got.rows, [NONE(CRITERIA[0]!), row(CRITERIA[1]!, 'met', 'In src/a.ts:3.', 'review')]);
  assert.deepEqual(reconcileAcceptance([silent()], 'x' as never, [], true).rows, []);
});

test('rows of several batches are merged by rule', () => {
  const one = [CRITERIA[0]!];
  const merged = (...answers: Array<{ value: SubmitReviewArgs }>) => reconcileAcceptance(answers, one, [], false);
  const said = (status: string, note: string) => answer({ item: 'A1', status, note });
  assert.deepEqual(merged(said('met', 'M1.')).rows, [row(one[0]!, 'met', 'M1.', 'review')]);
  assert.deepEqual(merged(said('met', 'M1.'), said('met', 'M2.')).rows, [row(one[0]!, 'met', 'M1.', 'review')]);
  for (const order of [[said('met', 'M1.'), said('not_met', 'N1.')], [said('not_met', 'N1.'), said('met', 'M1.')]]) {
    const got = merged(...order);
    assert.deepEqual(got.rows, [row(one[0]!, 'not_met', 'N1.', 'review')]);
    assert.deepEqual(got.audit, [{ stage: 'reconcile', action: 'acceptance_disagreement', subject: 'A1', reason: 'not_met' }]);
  }
  const notMet = merged(said('not_met', 'N1.'), said('not_verified', 'V1.'));
  assert.deepEqual([notMet.rows, notMet.audit], [[row(one[0]!, 'not_met', 'N1.', 'review')], []]);
  assert.deepEqual(merged(said('not_verified', 'V1.'), said('met', 'M1.')).rows, [row(one[0]!, 'met', 'M1.', 'review')]);
  assert.deepEqual(merged(said('not_verified', 'V1.'), silent()).rows, [row(one[0]!, 'not_verified', 'V1.', 'review')]);
  assert.deepEqual(merged(silent(), said('not_met', 'N1.'), said('not_met', 'N2.')).rows, [row(one[0]!, 'not_met', 'N1.', 'review')]);
});

test('a criterion nobody judged keeps its earlier row when rows are carried, and is not judged otherwise', () => {
  const [a, b, c] = CRITERIA as [string, string, string];
  const earlier = [row(a, 'met', 'In src/a.ts:3.', 'review'), row(b, 'not_met', 'No row.', 'earlier'), row(c, 'not_met', '', 'none')];
  const carried = reconcileAcceptance([silent()], CRITERIA, earlier, true);
  assert.deepEqual(carried.rows, [row(a, 'met', 'In src/a.ts:3.', 'earlier'), row(b, 'not_met', 'No row.', 'earlier'), NONE(c)]);
  assert.deepEqual(carried.audit, []);
  const full = reconcileAcceptance([silent()], CRITERIA, earlier, false);
  assert.deepEqual(full.rows, CRITERIA.map(NONE));
  const nothing = reconcileAcceptance([], CRITERIA, [], true);
  assert.deepEqual(nothing.rows, CRITERIA.map(NONE));
  // A row of this review wins over the earlier one.
  const judged = reconcileAcceptance([answer({ item: 'A2', status: 'met', note: 'Writes it.' })], CRITERIA, earlier, true);
  assert.deepEqual(judged.rows[1], row(b, 'met', 'Writes it.', 'review'));
  for (const got of [carried, full, nothing, judged]) {
    assert.ok(got.rows.every((r) => r.status !== 'not_met' || r.from !== 'none'));
  }
});

test('the earlier row is found by the criterion text, wherever it stands', () => {
  const [a, b, c] = CRITERIA as [string, string, string];
  const earlier = [row(a, 'met', 'Note A.', 'review'), row(b, 'not_met', 'Note B.', 'review')];
  const reordered = reconcileAcceptance([silent()], [b, c, a], earlier, true);
  assert.deepEqual(reordered.rows, [row(b, 'not_met', 'Note B.', 'earlier'), NONE(c), row(a, 'met', 'Note A.', 'earlier')]);
  const reworded = reconcileAcceptance([silent()], [`${a.slice(0, -1)}!`], earlier, true);
  assert.deepEqual(reworded.rows, [NONE(`${a.slice(0, -1)}!`)]);
  // Gone for one review, kept from the review before it.
  const without = reconcileAcceptance([silent()], [b], earlier, true);
  const back = reconcileAcceptance([silent()], [a, b], [...earlier, ...without.rows], true);
  assert.deepEqual(back.rows, [row(a, 'met', 'Note A.', 'earlier'), row(b, 'not_met', 'Note B.', 'earlier')]);
});
