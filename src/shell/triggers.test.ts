import test from 'node:test';
import assert from 'node:assert/strict';
import { triggerOf } from './triggers.ts';
import { GATE_OFF, type RepoSettings } from '../config/load.ts';
import type { PullRequestFacts } from '../forge/types.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const at = (seconds: number): string => new Date(Date.parse('2026-03-01T10:00:00.000Z') + seconds * 1000).toISOString();

const SETTINGS: RepoSettings = { primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: ['dependabot[bot]'], baseBranches: [], newHead: null, inlineNotes: false, gate: GATE_OFF };
const facts = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  ref: REF, author: 'octo-dev', authorIsBot: false, baseBranch: 'main', headBranch: 'feat', headSha: 'h1', draft: false,
  state: 'open', mergedAt: null, closedAt: null, mergeCommit: null, installation: '99', updatedAt: at(0), ...over,
});

test('opening, reopening, marking ready and retargeting queue a review at once; a push after the quiet period', () => {
  for (const action of ['opened', 'reopened', 'ready_for_review', 'retargeted'] as const) {
    assert.deepEqual(triggerOf(action, facts(), SETTINGS), { kind: 'queue', reason: action, headSha: 'h1', delaySeconds: 0 });
  }
  assert.deepEqual(triggerOf('synchronize', facts(), SETTINGS), { kind: 'queue', reason: 'synchronize', headSha: 'h1', delaySeconds: 180 });
});
test('a close and any other action ask for nothing', () => {
  assert.deepEqual(triggerOf('closed', facts({ state: 'closed' }), SETTINGS), { kind: 'none' });
  assert.deepEqual(triggerOf('other', facts(), SETTINGS), { kind: 'none' });
});
test('the filters, in their order: closed, draft, ignored author, base branch', () => {
  assert.deepEqual(triggerOf('reopened', facts({ state: 'merged', draft: true }), SETTINGS), { kind: 'skip', reason: 'closed' });
  assert.deepEqual(triggerOf('opened', facts({ draft: true, author: 'dependabot[bot]' }), SETTINGS), { kind: 'skip', reason: 'draft' });
  assert.deepEqual(triggerOf('opened', facts({ author: 'Dependabot[bot]' }), SETTINGS), { kind: 'skip', reason: 'ignored_author' });
  assert.deepEqual(triggerOf('opened', facts(), { ...SETTINGS, baseBranches: ['release'] }), { kind: 'skip', reason: 'base_filtered' });
  assert.equal(triggerOf('opened', facts(), { ...SETTINGS, baseBranches: ['main'] }).kind, 'queue');
});
test('a gated pull request is not reviewed on a push, an opening or a retarget; in shadow and against another branch it is', () => {
  const GATED: RepoSettings = { ...SETTINGS, gate: { ...GATE_OFF, enabled: true, branches: ['main'] } };
  for (const action of ['opened', 'reopened', 'ready_for_review', 'synchronize', 'retargeted'] as const) {
    assert.deepEqual(triggerOf(action, facts(), GATED), { kind: 'skip', reason: 'gated' });
    assert.equal(triggerOf(action, facts(), { ...GATED, gate: { ...GATED.gate, mode: 'shadow' } }).kind, 'queue');
    assert.equal(triggerOf(action, facts({ baseBranch: 'feature/x' }), GATED).kind, 'queue');
    assert.deepEqual(triggerOf(action, facts(), { ...GATED, gate: { ...GATED.gate, mode: 'bypass' } }), { kind: 'skip', reason: 'gated' });
    assert.deepEqual(triggerOf(action, facts({ draft: true }), GATED), { kind: 'skip', reason: 'draft' });
  }
});
