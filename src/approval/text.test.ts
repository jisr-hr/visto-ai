import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalThreads } from '../config/load.ts';
import type { ApprovalCode } from './rule.ts';
import { approvalParagraph, dismissMessage } from './text.ts';

const META = { head: 'abcdef1234567890', threshold: 70, rule: 'strict', code: 'github_403' } as const;
const CODES: ApprovalCode[] = [
  'approved', 'record_unreadable', 'not_covered', 'needs_human', 'blocking_finding', 'finding_without_thread',
  'draft', 'from_fork', 'origin_unknown', 'threads_unreadable', 'open_thread', 'rule_unreadable', 'rule_off', 'refused',
];
const NOT = '**Not approved automatically:** ';

test('each code has its sentence, pinned whole', () => {
  const said = (code: ApprovalCode, rule: ApprovalThreads = 'strict'): string => approvalParagraph(code, { ...META, rule });
  assert.equal(said('approved'), '**Approved automatically** for commit `abcdef123456`: every file is reviewed, nothing is at or above 70%, and no major or blocker finding is open. A new commit withdraws this approval.');
  assert.equal(said('record_unreadable'), `${NOT}a stored review of this pull request could not be read.`);
  assert.equal(said('not_covered'), `${NOT}not every file of this pull request is reviewed and scored at this commit.`);
  assert.equal(said('needs_human'), `${NOT}a part of this change is at or above 70%, so a person should review it.`);
  assert.equal(said('blocking_finding'), `${NOT}this review has a major or blocker finding.`);
  assert.equal(said('finding_without_thread'), `${NOT}a review of this pull request raised a major or blocker finding that no later review can clear: one not placed on the diff, one whose inline comment GitHub refused, one on code unchanged since an earlier review, or one that repeats a thread already closed. It holds approval for as long as the pull request is open.`);
  assert.equal(said('draft'), `${NOT}this pull request is a draft.`);
  assert.equal(said('from_fork'), `${NOT}its branch is in a fork, and a pull request from a fork is never approved automatically.`);
  assert.equal(said('origin_unknown'), `${NOT}the reviewer could not tell whether its branch is in this repository.`);
  assert.equal(said('threads_unreadable'), `${NOT}the review threads of this pull request could not be read (\`github_403\`).`);
  assert.equal(said('open_thread', 'strict'), `${NOT}a major or blocker thread of this reviewer is still open, or its comment is gone. Here a thread counts as closed when a review verified a fix in changed code, or when it is resolved and someone other than the author, with access to the repository, replied in it.`);
  assert.equal(said('open_thread', 'gate'), `${NOT}a major or blocker thread of this reviewer is still open, or its comment is gone.`);
  assert.equal(said('rule_unreadable'), `${NOT}the reviewer could not read whether the base branch dismisses an approval when new commits are pushed (\`github_403\`).`);
  assert.equal(said('rule_off'), `${NOT}the base branch does not dismiss an approval when new commits are pushed. The reviewer approves only where a ruleset or the branch protection of the base branch dismisses stale approvals.`);
  assert.equal(said('refused'), `${NOT}GitHub refused this review as an approval (\`github_403\`), so it was posted as a comment.`);
  assert.equal(dismissMessage(META.head), 'This approval was for commit abcdef123456. A new commit, a change of the base branch, or a later review of this reviewer that does not approve means it no longer holds.');
  // The thread rule changes only the open thread's sentence.
  for (const code of CODES.filter((c) => c !== 'open_thread')) assert.equal(said(code, 'gate'), said(code, 'strict'), code);
});

test('a code shown is a short code, else internal_error, and the commit is cut to 12 characters', () => {
  const shown = (code: string | undefined): string => approvalParagraph('threads_unreadable', { ...META, code });
  assert.ok(shown('github_403').endsWith('(`github_403`).'));
  assert.ok(shown(`a${'b'.repeat(39)}`).endsWith(`(\`a${'b'.repeat(39)}\`).`));
  for (const code of [undefined, '', 'Not a code', `a${'b'.repeat(40)}`, '`x`', '403', 'github-403', '@octo-lead']) {
    assert.ok(shown(code).endsWith('(`internal_error`).'), String(code));
    assert.ok(approvalParagraph('rule_unreadable', { ...META, code }).endsWith('(`internal_error`).'), String(code));
    assert.ok(approvalParagraph('refused', { ...META, code }).includes('(`internal_error`), so it'), String(code));
  }
  assert.ok(approvalParagraph('refused', { head: META.head, threshold: 70, rule: 'strict' }).includes('(`internal_error`), so it'));
  // Only three sentences show a code.
  for (const code of CODES.filter((c) => !['threads_unreadable', 'rule_unreadable', 'refused'].includes(c))) {
    assert.equal(approvalParagraph(code, META).includes('github_403'), false, code);
  }
  // The commit: its first 12 characters, with everything but letters and digits taken out; a shorter one whole.
  assert.ok(approvalParagraph('approved', META).includes('for commit `abcdef123456`:'));
  assert.ok(dismissMessage('abcdef1234567890').startsWith('This approval was for commit abcdef123456. '));
  assert.ok(approvalParagraph('approved', { ...META, head: 'h1' }).includes('for commit `h1`:'));
  assert.ok(dismissMessage('h1').startsWith('This approval was for commit h1. '));
  assert.ok(approvalParagraph('approved', { ...META, head: 'ab`c@d <e>#f0123' }).includes('for commit `abcdef`:'));
  assert.ok(dismissMessage('ab`c@d <e>#f0123').startsWith('This approval was for commit abcdef. '));
  // The threshold, as a whole number.
  assert.ok(approvalParagraph('needs_human', { ...META, threshold: 40 }).includes('at or above 40%, so'));
  assert.ok(approvalParagraph('approved', { ...META, threshold: 40 }).includes('nothing is at or above 40%, and'));
});

test('the texts are ASCII and hold no mention, link, tag or heading', () => {
  const hostile = { head: '@octo-lead <b>#12 https://example.test/x', threshold: 70, code: '@octo-lead <b>' };
  const texts: string[] = [dismissMessage(META.head), dismissMessage(hostile.head)];
  for (const rule of ['strict', 'gate'] as const) {
    for (const code of CODES) texts.push(approvalParagraph(code, { ...META, rule }), approvalParagraph(code, { ...hostile, rule }));
  }
  for (const text of texts) {
    // One line of printable ASCII.
    assert.match(text, /^[\x20-\x7e]+$/, text);
    assert.equal(text.includes('@'), false, text);
    assert.equal(/<|>|&/.test(text), false, text);
    assert.equal(/\[|\]|\(http|https?:|www\./i.test(text), false, text);
    assert.equal(text.includes('#'), false, text);
    assert.equal(/^\s*(?:[-=]{3,}|>)/.test(text), false, text);
  }
});
