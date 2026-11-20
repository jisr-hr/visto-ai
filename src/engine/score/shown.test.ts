import test from 'node:test';
import assert from 'node:assert/strict';
import { shownOf } from './shown.ts';

const blk = (hash: string, score: number | null) => ({ hash, hunkHash: hash, entry: score === null ? null : { score, category: 'feature', reason: `r ${hash}` } });
const fileOf = (path: string, finalScore: number, blocks: unknown[]) => ({ path, finalScore, blocks });
const result = (over: { threshold?: number; scores?: unknown[]; notReviewed?: unknown[] } = {}) => ({
  verdict: { threshold: over.threshold ?? 70, needsHuman: true, highest: 90 },
  coverage: { reviewed: [], notReviewed: over.notReviewed ?? [{ path: 'src/z.ts', reason: 'too_large' }, { path: 'src/y.ts', reason: 'no_diff' }] },
  scores: over.scores ?? [fileOf('src/a.ts', 90, [blk('h1', 90), blk('h2', 20)]), fileOf('src/b.ts', 75, [blk('h3', 75), blk('h4', null)])],
});

test('what a review shows is the same text for the same scores in any order', () => {
  const reordered = result({
    scores: [fileOf('src/b.ts', 75, [blk('h4', null), blk('h3', 75)]), fileOf('src/a.ts', 90, [blk('h2', 20), blk('h1', 90)])],
    notReviewed: [{ path: 'src/y.ts', reason: 'no_diff' }, { path: 'src/z.ts', reason: 'too_large' }],
  });
  assert.notEqual(shownOf(result()), null);
  assert.equal(shownOf(reordered), shownOf(result()));
});
test('another threshold shows another text', () => {
  assert.notEqual(shownOf(result({ threshold: 80 })), shownOf(result()));
});
test('a file more shows another text', () => {
  const scores = [fileOf('src/a.ts', 90, [blk('h1', 90), blk('h2', 20)]), fileOf('src/b.ts', 75, [blk('h3', 75), blk('h4', null)]), fileOf('src/c.ts', 5, [])];
  assert.notEqual(shownOf(result({ scores })), shownOf(result()));
});
test('another final score for a file shows another text', () => {
  const scores = [fileOf('src/a.ts', 95, [blk('h1', 90), blk('h2', 20)]), fileOf('src/b.ts', 75, [blk('h3', 75), blk('h4', null)])];
  assert.notEqual(shownOf(result({ scores })), shownOf(result()));
});
test('a block at or above the threshold more shows another text', () => {
  const scores = [fileOf('src/a.ts', 90, [blk('h1', 90), blk('h2', 20), blk('h5', 70)]), fileOf('src/b.ts', 75, [blk('h3', 75), blk('h4', null)])];
  assert.notEqual(shownOf(result({ scores })), shownOf(result()));
});
test('a block at or above the threshold with another hash shows another text', () => {
  const scores = [fileOf('src/a.ts', 90, [blk('h9', 90), blk('h2', 20)]), fileOf('src/b.ts', 75, [blk('h3', 75), blk('h4', null)])];
  assert.notEqual(shownOf(result({ scores })), shownOf(result()));
});
test('another path not reviewed shows another text', () => {
  assert.notEqual(shownOf(result({ notReviewed: [{ path: 'src/z.ts', reason: 'too_large' }] })), shownOf(result()));
});
test('a block below the threshold that differs shows the same text', () => {
  const scores = [fileOf('src/a.ts', 90, [blk('h1', 90), blk('h7', 40), blk('h8', null)]), fileOf('src/b.ts', 75, [blk('h3', 75), blk('h4', null)])];
  assert.equal(shownOf(result({ scores })), shownOf(result()));
});
test('a result that cannot be read shows nothing', () => {
  const noThreshold = { ...result(), verdict: { needsHuman: true } };
  const noScores = { verdict: { threshold: 70 }, coverage: { notReviewed: [] } };
  const noCoverage = { verdict: { threshold: 70 }, scores: [] };
  assert.deepEqual([{}, null, 'x', noThreshold, noScores, noCoverage].map(shownOf), [null, null, null, null, null, null]);
});
