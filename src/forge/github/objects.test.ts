import test from 'node:test';
import assert from 'node:assert/strict';
import { authorOf, generalCommentOf, inlineCommentOf, reviewOf } from './objects.ts';

const review = (over: Record<string, unknown>) => ({
  id: 11, user: { login: 'octo-dev', type: 'User' }, author_association: 'MEMBER',
  state: 'APPROVED', commit_id: 'abc123', submitted_at: '2026-03-01T10:00:00Z', body: 'ok', ...over,
});

test('a review state maps the same in capitals and in lower case', () => {
  assert.equal(reviewOf(review({ state: 'APPROVED' }))?.state, 'approved');
  assert.equal(reviewOf(review({ state: 'approved' }))?.state, 'approved');
  assert.equal(reviewOf(review({ state: 'changes_requested' }))?.state, 'changes_requested');
});

test('a null body becomes empty text and a pending review is null', () => {
  assert.equal(reviewOf(review({ body: null }))?.body, '');
  assert.equal(reviewOf(review({ state: 'PENDING' })), null);
  assert.equal(reviewOf(review({ state: 'pending' })), null);
});

test('authorOf tells people from bots', () => {
  assert.deepEqual(authorOf({ login: 'octo-dev', type: 'User' }), { author: 'octo-dev', authorIsBot: false });
  assert.equal(authorOf({ login: 'tool', type: 'Bot' }).authorIsBot, true);
  assert.equal(authorOf({ login: 'tool[bot]', type: 'User' }).authorIsBot, true);
  assert.deepEqual(authorOf(null), { author: 'ghost', authorIsBot: false });
});

test('comment mappers read their objects and refuse other shapes', () => {
  const c = inlineCommentOf({
    id: 5, user: { login: 'octo-dev', type: 'User' }, author_association: 'NONE', created_at: '2026-03-01T10:00:00Z',
    original_commit_id: 'abc123', path: 'a.ts', side: 'LEFT', original_line: 3,
  });
  assert.equal(c.side, 'LEFT');
  assert.equal(c.line, 3);
  assert.equal(generalCommentOf({ id: 6, user: { login: 'octo-dev', type: 'User' }, created_at: '2026-03-01T10:00:00Z', body: 'hi' }).body, 'hi');
  assert.throws(() => generalCommentOf(null), { message: 'github_bad_response' });
  assert.throws(() => reviewOf(review({ submitted_at: undefined })), { message: 'github_bad_response' });
});
