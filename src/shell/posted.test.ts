import test from 'node:test';
import assert from 'node:assert/strict';
import type { PostedComment } from '../forge/types.ts';
import { matchPosted } from './posted.ts';

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
