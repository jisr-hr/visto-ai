import test from 'node:test';
import assert from 'node:assert/strict';
import { eventOf, MAX_ID_CHARS } from './events.ts';

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
  action, repository: repo(), issue, installation: { id: 99 },
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
    kind: 'general_comment', ref, installation: '99',
    comment: { id: '31', author: 'octo-dev', authorIsBot: false, association: 'owner', at: TI, body: 'hello' },
  });
  const bare: Record<string, unknown> = issuePayload();
  delete bare.installation;
  assert.equal((eventOf('issue_comment', bare) as { installation: unknown }).installation, null);
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

test('a time outside the years 1970 to 9999 is malformed', () => {
  const malformed = { kind: 'ignored', reason: 'malformed' };
  for (const t of ['0000-01-01T00:00:00Z', '-000001-01-01T00:00:00Z', '+010000-01-01T00:00:00Z', '1969-12-31T23:59:59Z']) {
    assert.deepEqual(eventOf('pull_request', pr({ updated_at: t })), malformed, t);
    assert.deepEqual(eventOf('pull_request_review', reviewPayload({ submitted_at: t })), malformed, t);
  }
  assert.equal(eventOf('pull_request', pr({ updated_at: '1970-01-01T00:00:00Z' })).kind, 'pull_request');
  assert.equal(eventOf('pull_request', pr({ updated_at: '9999-12-31T23:59:59Z' })).kind, 'pull_request');
  assert.equal(eventOf('pull_request', pr()).kind, 'pull_request');
});

test('the texts the database indexes are at most MAX_ID_CHARS long', () => {
  assert.equal(MAX_ID_CHARS, 200);
  const long = 'x'.repeat(MAX_ID_CHARS + 1);
  const ok = 'x'.repeat(MAX_ID_CHARS);
  const malformed = { kind: 'ignored', reason: 'malformed' };
  const cases: Array<[string, (v: string) => [string, unknown]]> = [
    ['owner', (v) => ['pull_request', { ...pr(), repository: { name: 'shop', owner: { login: v } } }]],
    ['repository name', (v) => ['pull_request', { ...pr(), repository: { name: v, owner: { login: 'acme' } } }]],
    ['review id', (v) => ['pull_request_review', reviewPayload({ id: v })]],
    ['inline comment id', (v) => ['pull_request_review_comment', inlinePayload({ id: v })]],
    ['reply-to id', (v) => ['pull_request_review_comment', inlinePayload({ in_reply_to_id: v })]],
    ['general comment id', (v) => ['issue_comment', { ...issuePayload(), comment: { ...issuePayload().comment, id: v } }]],
    ['thread id', (v) => ['pull_request_review_thread', { ...threadPayload(), thread: { node_id: v, comments: [{ id: 21 }] } }]],
  ];
  for (const [name, make] of cases) {
    assert.deepEqual(eventOf(...make(long)), malformed, `${name}: ${String(MAX_ID_CHARS + 1)}`);
    assert.notDeepEqual(eventOf(...make(ok)), malformed, `${name}: ${String(MAX_ID_CHARS)}`);
  }
});
