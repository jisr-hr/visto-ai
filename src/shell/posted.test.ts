import test from 'node:test';
import assert from 'node:assert/strict';
import type { PostedComment } from '../forge/types.ts';
import { noteKey } from '../engine/render/notes.ts';
import { matchPosted, notedOf } from './posted.ts';

const rendered = (path: string, body: string, side: 'LEFT' | 'RIGHT' = 'RIGHT') => ({ path, side, line: 3, body });
const finding = (severity: string, quote: string) => ({ path: 'a.ts', side: 'RIGHT', line: 3, severity, body: 'x', quote, requestedLine: null });
const post = (id: string, path: string, body: string, line: number | null = 3): PostedComment => ({ id, path, side: 'RIGHT', line, body });

test('the same text twice is matched once each, in order', () => {
  const run = { result: { findings: [finding('major', 'q1'), finding('minor', 'q2')] }, comments: [rendered('a.ts', 'Same.'), rendered('a.ts', 'Same.')] };
  assert.deepEqual(matchPosted(run, [post('1', 'a.ts', 'Same.'), post('2', 'a.ts', 'Same.', 4), post('3', 'a.ts', 'Same.')]), [
    { commentId: '1', path: 'a.ts', side: 'RIGHT', line: 3, severity: 'major', quote: 'q1' },
    { commentId: '2', path: 'a.ts', side: 'RIGHT', line: 4, severity: 'minor', quote: 'q2' },
  ]);
});
test('a comment on another path is not matched', () => {
  const run = { result: { findings: [finding('major', 'q1')] }, comments: [rendered('a.ts', 'Text.')] };
  assert.deepEqual(matchPosted(run, [post('1', 'b.ts', 'Text.')]), []);
});
test('a rendered comment with no finding is skipped', () => {
  const run = { result: { findings: [finding('major', 'q1')] }, comments: [rendered('a.ts', 'One.'), rendered('a.ts', 'Two.')] };
  assert.deepEqual(matchPosted(run, [post('2', 'a.ts', 'Two.')]), []);
});
test('a stored result or comments that are not arrays match nothing', () => {
  assert.deepEqual(matchPosted({ result: null, comments: [rendered('a.ts', 'T.')] }, [post('1', 'a.ts', 'T.')]), []);
  assert.deepEqual(matchPosted({ result: { findings: [finding('major', 'q')] }, comments: 'x' }, [post('1', 'a.ts', 'T.')]), []);
});

const NOTE_BODY = '**Human review:** lines 12-40, 85% `calculation`';
const FINDING_COMMENT = { path: 'src/a.ts', side: 'RIGHT', line: 9, body: '**[major]** Wrong.' };
const NOTE_COMMENT = { path: 'src/a.ts', side: 'RIGHT', line: 12, body: NOTE_BODY, note: 'h1' };
const RUN = { result: { findings: [{ severity: 'major', quote: 'x()' }] }, comments: [FINDING_COMMENT, NOTE_COMMENT] };
const postedFinding = { id: '601', path: 'src/a.ts', side: 'RIGHT', line: 9, body: '**[major]** Wrong.' } as const;
const postedNote = { id: '602', path: 'src/a.ts', side: 'RIGHT', line: 12, body: NOTE_BODY } as const;

test('a posted note is stored as a note with its block, beside the finding', () => {
  const out = matchPosted(RUN, [postedFinding, postedNote]);
  assert.deepEqual(out.map((c) => [c.commentId, c.severity, c.quote, c.blockHash ?? null]), [['601', 'major', 'x()', null], ['602', 'note', '', 'h1']]);
});
test('only the notes GitHub holds are stored', () => {
  const out = matchPosted(RUN, [postedFinding]);
  assert.deepEqual(out.map((c) => [c.commentId, c.severity]), [['601', 'major']]);
});
test('a note keeps the line GitHub gave its posted comment', () => {
  const out = matchPosted(RUN, [{ ...postedNote, line: 14 }]);
  assert.deepEqual(out.map((c) => [c.commentId, c.line]), [['602', 14]]);
});
test('a note is never matched as a finding', () => {
  const run = { result: { findings: [{ severity: 'major', quote: 'x()' }] }, comments: [NOTE_COMMENT] };
  assert.deepEqual(matchPosted(run, [postedNote]), []);
});
test('an entry after the findings whose note is not a string is stored as nothing', () => {
  const run = { result: { findings: [{ severity: 'major', quote: 'x()' }] }, comments: [FINDING_COMMENT, { ...NOTE_COMMENT, note: 5 }] };
  assert.deepEqual(matchPosted(run, [postedNote]), []);
});
test('a finding is never stored as a note, nor a note as a finding', () => {
  const run = { result: { findings: [{ severity: 'major', quote: 'x()' }] }, comments: [{ ...NOTE_COMMENT }] };
  assert.deepEqual(matchPosted(run, [postedNote]), []);
  const plain = { result: { findings: [{ severity: 'major', quote: 'x()' }] }, comments: [FINDING_COMMENT, { path: 'src/a.ts', side: 'RIGHT', line: 12, body: NOTE_BODY }] };
  assert.deepEqual(matchPosted(plain, [postedNote]), []);
});
test('two notes with the same text are each used once', () => {
  const run = { result: { findings: [] }, comments: [NOTE_COMMENT, { ...NOTE_COMMENT, note: 'h2' }] };
  const out = matchPosted(run, [postedNote, { ...postedNote, id: '603' }, { ...postedNote, id: '604' }]);
  assert.deepEqual(out.map((c) => [c.commentId, c.blockHash]), [['602', 'h1'], ['603', 'h2']]);
});
test('a run recorded before notes existed is read as before', () => {
  const run = { result: { findings: [finding('major', 'q1')] }, comments: [rendered('a.ts', 'One.')] };
  assert.deepEqual(matchPosted(run, [post('1', 'a.ts', 'One.')]).map((c) => [c.commentId, c.severity]), [['1', 'major']]);
});
test('a comment list that is not a list holds no note', () => {
  assert.deepEqual(matchPosted({ result: { findings: [] }, comments: 'x' }, [postedNote]), []);
});
test('a result with no findings still has its notes read', () => {
  assert.deepEqual(matchPosted({ result: null, comments: [NOTE_COMMENT] }, [postedNote]).map((c) => c.severity), ['note']);
});
test('entries that are not objects, or have odd fields, match nothing and nothing throws', () => {
  const run = { result: { findings: [] }, comments: [null, 7, 'x', { note: 'h', path: 1, side: 'RIGHT', body: NOTE_BODY }, { note: 'h', path: 'src/a.ts', side: 2, body: NOTE_BODY }, { note: 'h', path: 'src/a.ts', side: 'RIGHT', body: 4 }] };
  assert.deepEqual(matchPosted(run, [postedNote]), []);
});
test('the blocks that have a note are known by path and hash', () => {
  const stored = [
    { commentId: '1', path: 'src/a.ts', side: 'RIGHT' as const, line: 1, severity: 'note', quote: '', blockHash: 'h1' },
    { commentId: '2', path: 'src/a.ts', side: 'RIGHT' as const, line: 2, severity: 'note', quote: '', blockHash: null },
    { commentId: '3', path: 'src/a.ts', side: 'RIGHT' as const, line: 3, severity: 'major', quote: 'q', blockHash: 'h9' },
    { commentId: '4', path: 'src/a.ts', side: 'RIGHT' as const, line: 4, severity: 'note', quote: '', blockHash: '' },
  ];
  assert.deepEqual([...notedOf(stored)], [noteKey('src/a.ts', 'h1')]);
});
test('a note on another path or side is not matched', () => {
  assert.deepEqual(matchPosted(RUN, [{ ...postedNote, side: 'LEFT' }]), []);
  assert.deepEqual(matchPosted(RUN, [{ ...postedNote, path: 'src/b.ts' }]), []);
});
test('a finding the stored result holds damaged is no finding, and nothing throws', () => {
  for (const bad of [null, 7, 'x', {}, { severity: 'major' }, { severity: 3, quote: 'q' }]) {
    const run = { result: { findings: [bad] }, comments: [FINDING_COMMENT, NOTE_COMMENT] };
    assert.deepEqual(matchPosted(run, [postedFinding, postedNote]).map((c) => [c.commentId, c.severity]), [['602', 'note']], JSON.stringify(bad));
  }
});

// A note as renderNotes writes it: the service's words, then the model's reason.
const REASON_NOTE = '**Human review:** lines 12-40, 85% `calculation` \u2014 Totals are rounded twice.';
const REASON_RUN = { result: { findings: [{ severity: 'major', quote: 'x()' }] }, comments: [FINDING_COMMENT, { ...NOTE_COMMENT, body: REASON_NOTE }] };
test('a note whose reason GitHub gave back changed is still that note', () => {
  const changed = [
    REASON_NOTE.replace('twice', 'twicE'), REASON_NOTE.replace('twice', 'twce'), REASON_NOTE.slice(0, -10),
    REASON_NOTE.replace('\u2014', '-'), REASON_NOTE.replace(' \u2014 Totals are rounded twice.', ''),
  ];
  for (const body of changed) {
    const out = matchPosted(REASON_RUN, [postedFinding, { ...postedNote, body }]);
    assert.deepEqual(out.map((c) => [c.commentId, c.severity, c.blockHash ?? null]), [['601', 'major', null], ['602', 'note', 'h1']], body);
  }
});
test('a finding is still matched by its whole text', () => {
  assert.deepEqual(matchPosted(REASON_RUN, [{ ...postedFinding, body: '**[major]** Wrong!' }]), []);
});
test('two notes of one review are told apart by their heads', () => {
  const other = '**Human review:** line 50, 90% `calculation` \u2014 Totals.';
  const run = { result: { findings: [] }, comments: [{ ...NOTE_COMMENT, body: REASON_NOTE }, { ...NOTE_COMMENT, line: 50, body: other, note: 'h2' }] };
  const out = matchPosted(run, [{ ...postedNote, id: '702', line: 50, body: other.replace('Totals', 'Sums') }, { ...postedNote, id: '701', body: REASON_NOTE.replace('twice', 'thrice') }]);
  assert.deepEqual(out.map((c) => [c.commentId, c.blockHash]), [['702', 'h2'], ['701', 'h1']]);
});
test('a comment that only begins as a note does, with another label, is no note of the run', () => {
  for (const body of ['**Human review:** line 12, 85% `calculation` \u2014 Totals are rounded twice.', '**Human review:** lines 12-40, 86% `calculation`', '**Human review:** lines 12-40, 85% `billing`', '**Human review:**']) {
    assert.deepEqual(matchPosted(REASON_RUN, [{ ...postedNote, body }]), [], body);
  }
});
test('a recorded note that has no head is matched by its whole text', () => {
  const run = { result: { findings: [] }, comments: [{ ...NOTE_COMMENT, body: '**Human review:** something else' }] };
  assert.deepEqual(matchPosted(run, [{ ...postedNote, body: '**Human review:** something else' }]).map((c) => c.severity), ['note']);
  assert.deepEqual(matchPosted(run, [{ ...postedNote, body: '**Human review:** something else!' }]), []);
});
