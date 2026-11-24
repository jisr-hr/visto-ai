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
    kind: 'inline_comment', ref, installation: null,
    comment: {
      id: '21', author: 'octo-dev', authorIsBot: false, association: 'none', at: TI, commit: 'abc123', path: 'a.ts',
      side: 'RIGHT', line: 4, startLine: null, fileLevel: false, replyTo: null, body: 'nit',
    },
  });
  assert.deepEqual(eventOf('pull_request_review_comment', inlinePayload({}, 'edited')), { kind: 'ignored', reason: 'unknown_action' });
  assert.equal((eventOf('pull_request_review_comment', { ...inlinePayload(), installation: { id: 99 } }) as { installation: unknown }).installation, '99');
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
    kind: 'thread', ref, installation: null, action, thread: 'PRRT_x', rootComment, actor: 'octo-dev', actorIsBot: false,
  });
  assert.deepEqual(eventOf('pull_request_review_thread', threadPayload()), want('resolved', '21'));
  assert.deepEqual(eventOf('pull_request_review_thread', threadPayload('unresolved', [])), want('unresolved', null));
  assert.deepEqual(eventOf('pull_request_review_thread', threadPayload('edited')), { kind: 'ignored', reason: 'unknown_action' });
  assert.equal((eventOf('pull_request_review_thread', { ...threadPayload(), installation: { id: 99 } }) as { installation: unknown }).installation, '99');
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

const checkRun = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  action: 'rerequested', repository: repo(), installation: { id: 99 }, sender: user('octo-lead', 'User'),
  check_run: { name: 'AI Review', head_sha: 'abc123', external_id: '7', app: { id: 12345 }, pull_requests: [{ number: 9 }], ...over },
  ...top,
});
const rerun = (number: number) => ({
  kind: 'check_rerun', ref: { ...ref, number }, installation: '99', app: '12345', check: 'AI Review', headSha: 'abc123', actor: 'octo-lead',
});
test('a re-run of a check names its pull request by the number the check carries, else by the first one GitHub lists', () => {
  assert.deepEqual(eventOf('check_run', checkRun()), rerun(7));
  assert.deepEqual(eventOf('check_run', checkRun({ external_id: '' })), rerun(9));
  assert.deepEqual(eventOf('check_run', checkRun({ external_id: '0' })), rerun(9));
  assert.deepEqual(eventOf('check_run', checkRun({ external_id: '12345678901' })), rerun(9));
  assert.deepEqual(eventOf('check_run', checkRun({ external_id: undefined })), rerun(9));
  assert.deepEqual(eventOf('check_run', checkRun({ external_id: '7' }, { installation: undefined })), { ...rerun(7), installation: null });
  // A leading zero still reads as the number; a trailing newline is not a number the check carries.
  assert.deepEqual(eventOf('check_run', checkRun({ external_id: '07' })), rerun(7));
  assert.deepEqual(eventOf('check_run', checkRun({ external_id: '7\n' })), rerun(9));
  assert.deepEqual(eventOf('check_run', checkRun({ external_id: '7', pull_requests: { number: 9 } })), rerun(7));
  assert.deepEqual(eventOf('check_run', checkRun({ external_id: 'build-41', pull_requests: { number: 9 } })), { kind: 'ignored', reason: 'not_a_pull_request' });
  assert.deepEqual(eventOf('check_run', checkRun({ external_id: 'build-41', pull_requests: 'x' })), { kind: 'ignored', reason: 'not_a_pull_request' });
});
test('a re-run that names no pull request is not one, and another action of a check run is unknown', () => {
  assert.deepEqual(eventOf('check_run', checkRun({ external_id: 'build-41', pull_requests: undefined })), { kind: 'ignored', reason: 'not_a_pull_request' });
  assert.deepEqual(eventOf('check_run', checkRun({ external_id: 'build-41', pull_requests: [] })), { kind: 'ignored', reason: 'not_a_pull_request' });
  for (const action of ['created', 'completed', 'requested_action']) {
    assert.deepEqual(eventOf('check_run', checkRun({}, { action })), { kind: 'ignored', reason: 'unknown_action' }, action);
  }
});
test('a check run with no name, no app or no head is malformed', () => {
  const malformed = { kind: 'ignored', reason: 'malformed' };
  for (const over of [{ name: undefined }, { name: '' }, { app: undefined }, { app: {} }, { head_sha: undefined }, { head_sha: '' }, { app: { id: 'x'.repeat(MAX_ID_CHARS + 1) } }]) {
    assert.deepEqual(eventOf('check_run', checkRun(over)), malformed, JSON.stringify(over));
  }
  assert.deepEqual(eventOf('check_run', checkRun({}, { sender: undefined })), malformed);
  assert.deepEqual(eventOf('check_run', checkRun({}, { repository: undefined })), malformed);
  for (const field of ['name', 'head_sha']) {
    assert.deepEqual(eventOf('check_run', checkRun({ [field]: 'x'.repeat(MAX_ID_CHARS + 1) })), malformed, field);
    assert.notDeepEqual(eventOf('check_run', checkRun({ [field]: 'x'.repeat(MAX_ID_CHARS) })), malformed, field);
  }
});
test('a re-run of a check suite is not taken in', () => {
  assert.deepEqual(eventOf('check_suite', { action: 'rerequested', repository: repo(), check_suite: { head_sha: 'abc123', pull_requests: [{ number: 7 }] } }), { kind: 'ignored', reason: 'unknown_event' });
});

const MERGED = { merged: true, state: 'closed', merged_at: T, closed_at: T, merge_commit_sha: 'def456' };
const mergedFacts = (over: Record<string, unknown> = {}) => facts({ state: 'merged', mergedAt: TI, closedAt: TI, mergeCommit: 'def456', ...over });
const factsIn = (event: unknown): Record<string, unknown> => (event as { facts: Record<string, unknown> }).facts;

test('a pull request whose description names no revert is read as before', () => {
  const bodies: Array<Record<string, unknown>> = [{}, { body: null }, { body: '' }, { body: 'Fixes the rounding of totals.' }];
  for (const over of bodies) {
    const opened = eventOf('pull_request', pr(over));
    assert.deepEqual(opened, { kind: 'pull_request', action: 'opened', facts: facts() }, JSON.stringify(over));
    assert.equal('reverts' in factsIn(opened), false);
    const merged = eventOf('pull_request', pr({ ...MERGED, ...over }, { action: 'closed' }));
    assert.deepEqual(merged, { kind: 'pull_request', action: 'closed', facts: mergedFacts() }, JSON.stringify(over));
    assert.equal('reverts' in factsIn(merged), false);
  }
});

test('a description whose first line names a revert of its own repository gives the number, before the merge and in the delivery of the merge', () => {
  const body = 'Reverts acme/shop#6';
  for (const action of ['opened', 'synchronize']) {
    assert.deepEqual(eventOf('pull_request', pr({ body }, { action })), { kind: 'pull_request', action, facts: facts({ reverts: 6 }) });
  }
  assert.deepEqual(eventOf('pull_request', pr({ ...MERGED, body }, { action: 'closed' })), { kind: 'pull_request', action: 'closed', facts: mergedFacts({ reverts: 6 }) });
  const upper = eventOf('pull_request', pr({ body }, { repository: { name: 'Shop', owner: { login: 'Acme' } } }));
  assert.equal(factsIn(upper).reverts, 6);
  const below = eventOf('pull_request', pr({ body: 'Fixes it.\nReverts acme/shop#6' }));
  assert.deepEqual(below, { kind: 'pull_request', action: 'opened', facts: facts() });
  assert.equal('reverts' in factsIn(below), false);
});

test('the parser reads the line as it is written', () => {
  for (const body of ['Reverts acme/shop#6\r3', 'Reverts acme/shop#6\u20283']) {
    assert.deepEqual(eventOf('pull_request', pr({ body })), { kind: 'pull_request', action: 'opened', facts: facts({ reverts: 6 }) }, JSON.stringify(body));
  }
  for (const body of ['Rev\u200berts acme/shop#6', 'Reverts acme/shop#6\u202e3', 'Reverts acme/shop#6.', 'Reverts acme/shop#6 because it broke']) {
    const event = eventOf('pull_request', pr({ body }));
    assert.deepEqual(event, { kind: 'pull_request', action: 'opened', facts: facts() }, JSON.stringify(body));
    assert.equal('reverts' in factsIn(event), false, JSON.stringify(body));
  }
});

test('an event of a merged pull request other than its closed one says that what is stored is kept, whatever its description names', () => {
  for (const action of ['edited', 'labeled', 'synchronize']) {
    for (const over of [{ body: 'Reverts acme/shop#6' }, { body: 'Fixes the rounding of totals.' }, {}]) {
      const event = eventOf('pull_request', pr({ ...MERGED, ...over }, { action }));
      assert.equal(event.kind, 'pull_request', `${action} ${JSON.stringify(over)}`);
      assert.equal(factsIn(event).reverts, 'kept', `${action} ${JSON.stringify(over)}`);
    }
  }
  const closed = eventOf('pull_request', pr({ state: 'closed', closed_at: T, body: 'Reverts acme/shop#6' }, { action: 'closed' }));
  assert.deepEqual(closed, { kind: 'pull_request', action: 'closed', facts: facts({ state: 'closed', closedAt: TI, reverts: 6 }) });
});

test('an edited event stays another action, and carries what the description names now while the pull request is not merged', () => {
  const body = 'Reverts acme/shop#6';
  assert.deepEqual(eventOf('pull_request', pr({ body }, { action: 'edited', changes: { body: { from: 'x' } } })), { kind: 'pull_request', action: 'other', facts: facts({ reverts: 6 }) });
  assert.deepEqual(eventOf('pull_request', pr({ body }, { action: 'edited', changes: { base: { ref: { from: 'dev' } } } })), { kind: 'pull_request', action: 'retargeted', facts: facts({ reverts: 6 }) });
});

test('a body that is no string, or that names another repository, gives no number and no malformed event', () => {
  const bodies: unknown[] = [5, {}, ['Reverts acme/shop#6'], 'Reverts other/shop#6', `${'x'.repeat(60_000)}Reverts acme/shop#6`];
  for (const body of bodies) {
    const event = eventOf('pull_request', pr({ body }));
    assert.deepEqual(event, { kind: 'pull_request', action: 'opened', facts: facts() }, typeof body);
    assert.equal('reverts' in factsIn(event), false);
  }
});

test('the repository a revert must name is the one of the payload', () => {
  const cart = { repository: { name: 'cart', owner: { login: 'octo' } } };
  const own = eventOf('pull_request', pr({ body: 'Reverts octo/cart#6' }, cart));
  assert.deepEqual(own, { kind: 'pull_request', action: 'opened', facts: facts({ ref: { ...ref, owner: 'octo', repo: 'cart' }, reverts: 6 }) });
  const other = eventOf('pull_request', pr({ body: 'Reverts acme/shop#6' }, cart));
  assert.deepEqual(other, { kind: 'pull_request', action: 'opened', facts: facts({ ref: { ...ref, owner: 'octo', repo: 'cart' } }) });
  assert.equal('reverts' in factsIn(other), false);
});

test('no word of the description is in the event', () => {
  const body = 'Reverts acme/shop#6\n\nThe totals of March were doubled.';
  for (const over of [{}, MERGED]) {
    const event = eventOf('pull_request', pr({ ...over, body, title: 'Revert "Double the totals"' }, { action: 'closed' }));
    const text = JSON.stringify(event);
    assert.equal(factsIn(event).reverts, 6);
    assert.equal(text.includes('doubled'), false);
    assert.equal(text.includes('Double'), false);
  }
});
