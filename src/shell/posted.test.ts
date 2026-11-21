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
  ];
  assert.deepEqual([...notedOf(stored)], [noteKey('src/a.ts', 'h1')]);
});
