import test from 'node:test';
import assert from 'node:assert/strict';
import { captureOf } from './capture.ts';
import type { Activity } from '../db/human-activity.ts';
import type {
  ForgeEvent, GeneralComment, HumanInlineComment, HumanReview, PullRequestFacts,
} from '../forge/types.ts';

const ref = { service: 'github' as const, owner: 'acme', repo: 'shop', number: 7 };
const receivedAt = new Date('2026-03-01T12:30:00.000Z');
const delivery = 'd-1';

function facts(over: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    ref, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feature', headSha: 'aaa111',
    draft: false, state: 'open', mergedAt: null, closedAt: null, mergeCommit: null,
    installation: '555', updatedAt: '2026-03-01T10:00:00.000Z', ...over,
  };
}
function review(over: Partial<HumanReview> = {}): HumanReview {
  return {
    id: 'r-1', author: 'octo-dev', authorIsBot: false, association: 'member', state: 'approved',
    commit: 'bbb222', at: '2026-03-01T10:00:00.000Z', body: 'Looks good.', ...over,
  };
}
function inline(over: Partial<HumanInlineComment> = {}): HumanInlineComment {
  return {
    id: 'c-1', author: 'octo-dev', authorIsBot: false, association: 'collaborator', at: '2026-03-01T10:05:00.000Z',
    commit: 'bbb222', path: 'src/cart.ts', side: 'RIGHT', line: 12, startLine: 10, fileLevel: false,
    replyTo: 'c-0', body: 'Rename this.', ...over,
  };
}
function general(over: Partial<GeneralComment> = {}): GeneralComment {
  return {
    id: 'g-1', author: 'octo-dev', authorIsBot: false, association: 'owner', at: '2026-03-01T10:10:00.000Z',
    body: 'Thanks for this.', ...over,
  };
}
function base(over: Partial<Activity>): Activity {
  return {
    ref, kind: 'review', sourceId: '', author: 'octo-dev', association: null, state: null, body: '',
    path: null, side: null, line: null, startLine: null, fileLevel: null, commit: null, replyTo: null,
    thread: null, at: '', delivery, ...over,
  };
}
function thread(over: Partial<Extract<ForgeEvent, { kind: 'thread' }>> = {}): ForgeEvent {
  return {
    kind: 'thread', ref, action: 'resolved', thread: 't-1', rootComment: 'c-0', actor: 'octo-dev',
    actorIsBot: false, ...over,
  };
}

test('a ping is ignored', () => {
  assert.deepEqual(captureOf({ kind: 'ping' }, delivery, receivedAt), { outcome: 'ignored', reason: 'ping' });
});

test('an ignored event keeps its reason', () => {
  assert.deepEqual(captureOf({ kind: 'ignored', reason: 'unknown_action' }, delivery, receivedAt),
    { outcome: 'ignored', reason: 'unknown_action' });
});

test('a pull request event is handled with its facts and no activity', () => {
  const f = facts({ state: 'merged', mergedAt: '2026-03-01T11:00:00.000Z', mergeCommit: 'ccc333' });
  assert.deepEqual(captureOf({ kind: 'pull_request', action: 'closed', facts: f }, delivery, receivedAt),
    { outcome: 'handled', pullRequest: f, activity: null });
});

test('a pull request opened by a bot is handled and keeps authorIsBot', () => {
  const f = facts({ author: 'dep-updater[bot]', authorIsBot: true });
  const result = captureOf({ kind: 'pull_request', action: 'opened', facts: f }, delivery, receivedAt);
  assert.deepEqual(result, { outcome: 'handled', pullRequest: f, activity: null });
  assert.equal(result.outcome === 'handled' && result.pullRequest?.authorIsBot, true);
});

test('a review by a person is stored with its state, body, commit, association and time', () => {
  assert.deepEqual(captureOf({ kind: 'review', ref, review: review({ state: 'changes_requested' }) }, delivery, receivedAt), {
    outcome: 'handled', pullRequest: null,
    activity: base({
      kind: 'review', sourceId: 'r-1', association: 'member', state: 'changes_requested', body: 'Looks good.',
      commit: 'bbb222', at: '2026-03-01T10:00:00.000Z',
    }),
  });
});

test('an approval with an empty body by a person is handled, not dropped', () => {
  assert.deepEqual(captureOf({ kind: 'review', ref, review: review({ body: '' }) }, delivery, receivedAt), {
    outcome: 'handled', pullRequest: null,
    activity: base({
      kind: 'review', sourceId: 'r-1', association: 'member', state: 'approved', body: '',
      commit: 'bbb222', at: '2026-03-01T10:00:00.000Z',
    }),
  });
});

test('a review by a bot is ignored', () => {
  assert.deepEqual(captureOf({ kind: 'review', ref, review: review({ authorIsBot: true }) }, delivery, receivedAt),
    { outcome: 'ignored', reason: 'bot_author' });
});

test('an inline comment by a person is stored with its place in the diff', () => {
  assert.deepEqual(captureOf({ kind: 'inline_comment', ref, comment: inline() }, delivery, receivedAt), {
    outcome: 'handled', pullRequest: null,
    activity: base({
      kind: 'inline_comment', sourceId: 'c-1', association: 'collaborator', body: 'Rename this.',
      path: 'src/cart.ts', side: 'RIGHT', line: 12, startLine: 10, fileLevel: false,
      commit: 'bbb222', replyTo: 'c-0', at: '2026-03-01T10:05:00.000Z',
    }),
  });
});

test('an inline comment by a bot is ignored', () => {
  assert.deepEqual(captureOf({ kind: 'inline_comment', ref, comment: inline({ authorIsBot: true }) }, delivery, receivedAt),
    { outcome: 'ignored', reason: 'bot_author' });
});

test('a general comment by a person is stored with its body, association and time', () => {
  assert.deepEqual(captureOf({ kind: 'general_comment', ref, installation: null, comment: general() }, delivery, receivedAt), {
    outcome: 'handled', pullRequest: null,
    activity: base({
      kind: 'general_comment', sourceId: 'g-1', association: 'owner', body: 'Thanks for this.',
      at: '2026-03-01T10:10:00.000Z',
    }),
  });
});

test('a general comment by a bot is ignored', () => {
  assert.deepEqual(captureOf({ kind: 'general_comment', ref, installation: null, comment: general({ authorIsBot: true }) }, delivery, receivedAt),
    { outcome: 'ignored', reason: 'bot_author' });
});

test('a thread resolved by a person is stored keyed by the delivery and the arrival time', () => {
  assert.deepEqual(captureOf(thread(), delivery, receivedAt), {
    outcome: 'handled', pullRequest: null,
    activity: base({
      kind: 'thread_resolved', sourceId: 'd-1', author: 'octo-dev', association: null,
      thread: 't-1', replyTo: 'c-0', at: '2026-03-01T12:30:00.000Z',
    }),
  });
});

test('a thread unresolved by a person is stored, with no root comment as null', () => {
  assert.deepEqual(captureOf(thread({ action: 'unresolved', rootComment: null }), delivery, receivedAt), {
    outcome: 'handled', pullRequest: null,
    activity: base({
      kind: 'thread_unresolved', sourceId: 'd-1', author: 'octo-dev', association: null,
      thread: 't-1', replyTo: null, at: '2026-03-01T12:30:00.000Z',
    }),
  });
});

test('a thread changed by a bot is ignored', () => {
  assert.deepEqual(captureOf(thread({ actorIsBot: true }), delivery, receivedAt),
    { outcome: 'ignored', reason: 'bot_author' });
});

test('the same arguments give equal results', () => {
  const event: ForgeEvent = { kind: 'inline_comment', ref, comment: inline() };
  assert.deepEqual(captureOf(event, delivery, receivedAt), captureOf(event, delivery, receivedAt));
});

test('a re-run is handled and stores nothing', () => {
  const event: ForgeEvent = { kind: 'check_rerun', ref, installation: '555', app: '12345', check: 'AI Review', headSha: 'aaa111', actor: 'octo-lead' };
  assert.deepEqual(captureOf(event, delivery, receivedAt), { outcome: 'handled', pullRequest: null, activity: null });
});
