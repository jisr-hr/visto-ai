import test from 'node:test';
import assert from 'node:assert/strict';
import { eventOf } from './events.ts';

const ref = { service: 'github', owner: 'acme', repo: 'shop', number: 7 };
const repo = () => ({ name: 'shop', owner: { login: 'acme' } });
const user = (login: string, type: string) => ({ login, type });
const T = '2026-03-01T10:00:00Z';
const TI = '2026-03-01T10:00:00.000Z';

const pr = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  action: 'opened', number: 7, repository: repo(), installation: { id: 99 },
  pull_request: {
    user: user('octo-dev', 'User'), base: { ref: 'main' }, head: { ref: 'feat', sha: 'abc123' }, draft: false,
    state: 'open', merged: false, merged_at: null, closed_at: null, merge_commit_sha: null, updated_at: T, ...over,
  },
  ...top,
});
const facts = (over: Record<string, unknown> = {}) => ({
  ref, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: 'abc123', draft: false,
  state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: TI, ...over,
});
const reviewPayload = (over: Record<string, unknown> = {}, action = 'submitted') => ({
  action, repository: repo(), pull_request: { number: 7 },
  review: { id: 11, user: user('octo-dev', 'User'), author_association: 'MEMBER', state: 'approved', commit_id: 'abc123', submitted_at: T, body: 'ok', ...over },
});
const inlinePayload = (over: Record<string, unknown> = {}, action = 'created') => ({
  action, repository: repo(), pull_request: { number: 7 },
  comment: {
    id: 21, user: user('octo-dev', 'User'), author_association: 'NONE', created_at: T, original_commit_id: 'abc123',
    path: 'a.ts', side: 'RIGHT', original_line: 4, body: 'nit', ...over,
  },
});
const issuePayload = (issue: Record<string, unknown> = { number: 7, pull_request: {} }, action = 'created') => ({
  action, repository: repo(), issue,
  comment: { id: 31, user: user('octo-dev', 'User'), author_association: 'OWNER', created_at: T, body: 'hello' },
});
const threadPayload = (action = 'resolved', comments: unknown[] = [{ id: 21 }, { id: 22 }]) => ({
  action, repository: repo(), pull_request: { number: 7 }, sender: user('octo-dev', 'User'),
  thread: { node_id: 'PRRT_x', comments },
});

test('ping', () => assert.deepEqual(eventOf('ping', { zen: 'x' }), { kind: 'ping' }));

for (const action of ['opened', 'reopened', 'ready_for_review', 'synchronize', 'closed']) {
  test(`pull_request ${action}`, () => {
    assert.deepEqual(eventOf('pull_request', pr({}, { action })), { kind: 'pull_request', action, facts: facts() });
  });
}

test('pull_request closed merged and not merged', () => {
  const merged = eventOf('pull_request', pr({ merged: true, state: 'closed', merged_at: T, closed_at: T, merge_commit_sha: 'def456' }, { action: 'closed' }));
  assert.deepEqual(merged, {
    kind: 'pull_request', action: 'closed',
    facts: facts({ state: 'merged', mergedAt: TI, closedAt: TI, mergeCommit: 'def456' }),
  });
  const closed = eventOf('pull_request', pr({ state: 'closed', closed_at: T, merge_commit_sha: 'zzz' }, { action: 'closed' }));
  assert.deepEqual(closed, { kind: 'pull_request', action: 'closed', facts: facts({ state: 'closed', closedAt: TI, mergeCommit: null }) });
});

test('pull_request other and edited actions', () => {
  assert.deepEqual(eventOf('pull_request', pr({}, { action: 'labeled' })), { kind: 'pull_request', action: 'other', facts: facts() });
  assert.deepEqual(eventOf('pull_request', pr({}, { action: 'edited' })), { kind: 'pull_request', action: 'other', facts: facts() });
  assert.deepEqual(eventOf('pull_request', pr({}, { action: 'edited', changes: { base: { ref: { from: 'dev' } } } })), { kind: 'pull_request', action: 'retargeted', facts: facts() });
});

test('pull_request without installation, and a bot author', () => {
  const p = pr({ user: user('tool[bot]', 'Bot') });
  delete (p as Record<string, unknown>).installation;
  assert.deepEqual(eventOf('pull_request', p), { kind: 'pull_request', action: 'opened', facts: facts({ author: 'tool[bot]', authorIsBot: true, installation: null }) });
});

test('review', () => {
  assert.deepEqual(eventOf('pull_request_review', reviewPayload()), {
    kind: 'review', ref,
    review: { id: '11', author: 'octo-dev', authorIsBot: false, association: 'member', state: 'approved', commit: 'abc123', at: TI, body: 'ok' },
  });
  assert.deepEqual(eventOf('pull_request_review', reviewPayload({}, 'dismissed')), { kind: 'ignored', reason: 'unknown_action' });
  assert.deepEqual(eventOf('pull_request_review', reviewPayload({ state: 'pending' })), { kind: 'ignored', reason: 'unknown_action' });
});

test('inline comment', () => {
  assert.deepEqual(eventOf('pull_request_review_comment', inlinePayload()), {
    kind: 'inline_comment', ref,
    comment: {
      id: '21', author: 'octo-dev', authorIsBot: false, association: 'none', at: TI, commit: 'abc123', path: 'a.ts',
      side: 'RIGHT', line: 4, startLine: null, fileLevel: false, replyTo: null, body: 'nit',
    },
  });
  assert.deepEqual(eventOf('pull_request_review_comment', inlinePayload({}, 'edited')), { kind: 'ignored', reason: 'unknown_action' });
});

test('general comment', () => {
  assert.deepEqual(eventOf('issue_comment', issuePayload()), {
    kind: 'general_comment', ref,
    comment: { id: '31', author: 'octo-dev', authorIsBot: false, association: 'owner', at: TI, body: 'hello' },
  });
  assert.deepEqual(eventOf('issue_comment', issuePayload({ number: 7 })), { kind: 'ignored', reason: 'not_a_pull_request' });
  assert.deepEqual(eventOf('issue_comment', issuePayload(undefined, 'edited')), { kind: 'ignored', reason: 'unknown_action' });
  assert.deepEqual(eventOf('issue_comment', issuePayload(undefined, 'deleted')), { kind: 'ignored', reason: 'unknown_action' });
});

test('thread', () => {
  const want = (action: string, rootComment: string | null) => ({
    kind: 'thread', ref, action, thread: 'PRRT_x', rootComment, actor: 'octo-dev', actorIsBot: false,
  });
  assert.deepEqual(eventOf('pull_request_review_thread', threadPayload()), want('resolved', '21'));
  assert.deepEqual(eventOf('pull_request_review_thread', threadPayload('unresolved', [])), want('unresolved', null));
  assert.deepEqual(eventOf('pull_request_review_thread', threadPayload('edited')), { kind: 'ignored', reason: 'unknown_action' });
});

test('an unknown event', () => assert.deepEqual(eventOf('deployment', {}), { kind: 'ignored', reason: 'unknown_event' }));

test('malformed payloads are ignored without throwing', () => {
  const malformed = { kind: 'ignored', reason: 'malformed' };
  const noPr = pr();
  delete (noPr as Record<string, unknown>).pull_request;
  const cases: Array<[string, unknown]> = [
    ['pull_request', null], ['pull_request', 'text'], ['pull_request', []], ['pull_request', {}],
    ['pull_request', pr({}, { number: '7' })],
    ['pull_request', pr({}, { number: 2147483648 })],
    ['pull_request', pr({}, { number: 0 })],
    ['pull_request', noPr],
    ['pull_request', pr({ updated_at: 'yesterday' })],
    ['pull_request', pr({ merged_at: 'soon' })],
    ['pull_request', pr({ draft: 'no' })],
    ['pull_request_review', { ...reviewPayload(), review: null }],
    ['pull_request_review', reviewPayload({ submitted_at: 'later' })],
    ['pull_request_review_comment', inlinePayload({ original_line: -1 })],
    ['pull_request_review_comment', inlinePayload({ original_start_line: 0 })],
    ['pull_request_review_comment', inlinePayload({ created_at: 'x' })],
    ['issue_comment', { ...issuePayload(), comment: null }],
    ['pull_request_review_thread', { ...threadPayload(), thread: {} }],
  ];
  for (const [name, payload] of cases) assert.deepEqual(eventOf(name, payload), malformed, `${name} ${JSON.stringify(payload)}`);
});
