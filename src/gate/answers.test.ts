import test from 'node:test';
import assert from 'node:assert/strict';
import { doneFailed, doneRefused, nothingLeft, skipFailed, skipRefused } from './answers.ts';
import type { SkipRefusal } from './answers.ts';

test('each answer is one sentence that opens with the login and ends with its code, and none names the team', () => {
  const l = 'octo-lead';
  const all: string[] = [];
  const same = (actual: string, expected: string): void => { all.push(actual); assert.equal(actual, expected); };
  same(doneRefused(l, 'not_allowed'), '@octo-lead `/done` was not accepted (`not_allowed`).');
  same(doneRefused(l, 'closed'), '@octo-lead `/done` was not accepted (`closed`).');
  same(doneFailed(l, 'review_failed'), '@octo-lead `/done` could not be handled (`review_failed`).');
  same(doneFailed(l, 'It broke: /srv/app'), '@octo-lead `/done` could not be handled (`internal_error`).');
  same(skipRefused(l, 'not_allowed'), '@octo-lead `/ai-review-skip` was not accepted (`not_allowed`).');
  same(skipRefused(l, 'closed'), '@octo-lead `/ai-review-skip` was not accepted (`closed`).');
  same(skipRefused(l, 'not_gated'), '@octo-lead `/ai-review-skip` was not accepted: this pull request is not gated (`not_gated`).');
  same(skipRefused(l, 'stale_head'), '@octo-lead `/ai-review-skip` was not accepted: a commit was pushed since you commented. Look at it and comment again (`stale_head`).');
  same(skipRefused(l, 'missing_reason'), '@octo-lead `/ai-review-skip` needs a reason on its line, as in `/ai-review-skip urgent fix, checked by hand` (`missing_reason`).');
  same(skipRefused(l, 'no_skip_team'), '@octo-lead `/ai-review-skip` is not available here: no team is named for it (`no_skip_team`).');
  same(skipRefused(l, 'not_team_member'), '@octo-lead Only a member of the team that may skip can skip the review (`not_team_member`).');
  same(skipRefused(l, 'membership_unverified'), '@octo-lead Membership of the team that may skip could not be verified just now, so nothing was skipped. Try again in a minute (`membership_unverified`).');
  same(skipFailed(l, 'github_502'), '@octo-lead `/ai-review-skip` could not be handled (`github_502`).');
  same(nothingLeft(l, 'abcdef0123456789abcdef'), '@octo-lead Nothing is left to run on `abcdef012345`: the required checks and the review\'s check are green.');
  // a null login, and a login that cannot be one
  assert.equal(doneRefused(null, 'closed'), '`/done` was not accepted (`closed`).');
  assert.equal(skipRefused('not a login', 'not_team_member'), 'Only a member of the team that may skip can skip the review (`not_team_member`).');
  assert.equal(nothingLeft(null, 'abc'), 'Nothing is left to run on `abc`: the required checks and the review\'s check are green.');
  assert.equal(nothingLeft('x y', 'ab-c/d'), 'Nothing is left to run on `abcd`: the required checks and the review\'s check are green.');
  const codes: SkipRefusal[] = ['not_allowed', 'closed', 'not_gated', 'stale_head', 'missing_reason', 'no_skip_team', 'not_team_member', 'membership_unverified'];
  assert.equal(codes.length, 8);
  for (const text of all) assert.ok(!/release-managers/.test(text));
});
