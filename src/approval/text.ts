import type { ApprovalThreads } from '../config/load.ts';
import { head12 } from '../gate/answers.ts';
import { isShortCode } from '../shell/codes.ts';
import type { ApprovalCode } from './rule.ts';

type Meta = { head: string; threshold: number; rule: ApprovalThreads; code?: string };

const commit = (head: string): string => (typeof head === 'string' ? head12(head) : '');
const shown = (code: string | undefined): string => (typeof code === 'string' && isShortCode(code) ? code : 'internal_error');
// The threshold as a whole number: for whole-number scores, the first score that is at or above it.
const percent = (threshold: number): string => `${Math.ceil(threshold)}%`;

const OPEN_GATE = 'a major or blocker thread of this reviewer is still open, or its comment is gone.';
const OPEN_STRICT = `${OPEN_GATE} Here a thread counts as closed when a review verified a fix in changed code, or when it is resolved and someone other than the author, with access to the repository, replied in it.`;

const REASONS: Record<Exclude<ApprovalCode, 'approved'>, (meta: Meta) => string> = {
  record_unreadable: () => 'a stored review of this pull request could not be read.',
  not_covered: () => 'not every file of this pull request is reviewed and scored at this commit.',
  needs_human: (m) => `a part of this change is at or above ${percent(m.threshold)}, so a person should review it.`,
  blocking_finding: () => 'this review has a major or blocker finding.',
  finding_without_thread: () => 'a review of this pull request raised a major or blocker finding that no later review can clear: one not placed on the diff, one whose inline comment GitHub refused, one on code unchanged since an earlier review, or one that repeats a thread already closed. It holds approval for as long as the pull request is open.',
  draft: () => 'this pull request is a draft.',
  from_fork: () => 'its branch is in a fork, and a pull request from a fork is never approved automatically.',
  origin_unknown: () => 'the reviewer could not tell whether its branch is in this repository.',
  threads_unreadable: (m) => `the review threads of this pull request could not be read (\`${shown(m.code)}\`).`,
  // The strict rule says how a thread closes; any other rule gives only what holds under every rule.
  open_thread: (m) => (m.rule === 'strict' ? OPEN_STRICT : OPEN_GATE),
  rule_unreadable: (m) => `the reviewer could not read whether the base branch dismisses an approval when new commits are pushed (\`${shown(m.code)}\`).`,
  rule_off: () => 'the base branch does not dismiss an approval when new commits are pushed. The reviewer approves only where a ruleset or the branch protection of the base branch dismisses stale approvals.',
  refused: (m) => `GitHub refused this review as an approval (\`${shown(m.code)}\`), so it was posted as a comment.`,
  audit_sample: () => 'this pull request was drawn for the audit sample. Every other condition for an automatic approval holds, and a share of the pull requests this reviewer would approve is sent to a person anyway, so that people keep checking what it approves. A person should review it.',
};

/** The paragraph a review ends with when approval is on: it was approved, or the one reason it was not. One line of ASCII. */
export function approvalParagraph(decided: ApprovalCode, meta: { head: string; threshold: number; rule: ApprovalThreads; code?: string }): string {
  if (decided === 'approved') {
    return `**Approved automatically** for commit \`${commit(meta.head)}\`: every file is reviewed, nothing is at or above ${percent(meta.threshold)}, and no major or blocker finding is open. A new commit withdraws this approval.`;
  }
  // A code this release does not know never reads as an approval.
  const reason = REASONS[decided] ?? REASONS.record_unreadable;
  return `**Not approved automatically:** ${reason(meta)}`;
}

/** The message an approval of commit `head` is dismissed with. */
export function dismissMessage(head: string): string {
  return `This approval was for commit ${commit(head)}. A new commit, a change of the base branch, or a later review of this reviewer that does not approve means it no longer holds.`;
}
