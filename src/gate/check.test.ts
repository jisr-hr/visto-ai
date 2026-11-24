import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_COUNTS } from '../db/gate.ts';
import type { StoredRun } from '../db/review-runs.ts';
import type { OwnCheck } from '../forge/types.ts';
import { checkText, countsOf, planAfter, planBefore, sameCheck } from './check.ts';
import type { CheckFacts, CheckMeta, CheckPlan } from './check.ts';
import type { Blocking, GateVerdict } from './rule.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const USAGE = { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 };

const run = (id: number, over: Partial<StoredRun> = {}): StoredRun => ({
  id, ref: REF, job: id, trigger: 'manual', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'b1', baseBranch: 'main',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 1, body: 'A review.', comments: [],
  result: { findings: [], coverage: { reviewed: ['src/a.ts'], notReviewed: [] }, threadVerdicts: [] },
  usage: USAGE, startedAt: '2026-03-01T10:00:00.000Z', finishedAt: '2026-03-01T10:01:00.000Z',
  published: true, reviewId: String(400 + id), publishedAt: '2026-03-01T10:02:00.000Z', inlineDropped: false, publishTriedAt: null, ...over,
});
const facts = (over: Partial<CheckFacts> = {}): CheckFacts =>
  ({ gating: 'enforce', head: 'h1', base: 'b1', skip: null, job: null, paused: null, runs: [], ...over });

const meta = (over: Partial<CheckMeta> = {}): CheckMeta => ({
  head: 'abcdef0123456789abcdef', canSkip: false, clearByReply: true, retrying: false,
  threadUrl: (id) => `https://git.example.test/c/${id}`, ...over,
});
const blocking = (over: Partial<Blocking> = {}): Blocking =>
  ({ thread: 'PRRT_1', commentId: '8001', path: 'src/a.ts', line: 12, severity: 'major', why: 'open', unread: false, ...over });
const verdict = (list: Blocking[], over: Partial<GateVerdict> = {}): GateVerdict =>
  ({ blocking: list, clearedByReview: 0, clearedByReply: 0, silentResolves: 0, unknownThreads: 0, findings: list.length, ...over });
const plan = (state: 'passed' | 'blocked', v: GateVerdict, over: { notReviewed?: number; withoutThread?: number; refused?: number } = {}): CheckPlan =>
  ({ state, verdict: v, notReviewed: 0, withoutThread: 0, refused: 0, ...over });

const SKIP = 'The team that may skip can comment `/ai-review-skip <reason>` to let this commit through.';
const WAY_ON = 'To clear a finding, push a fix, or reply in its thread saying why the code is right, and comment `/done`: the review then says which findings still stand. You can also reply in the thread and resolve it yourself. Resolving a thread without a reply does not clear it.';
const WAY_OFF = 'To clear a finding, push a fix, or reply in its thread saying why the code is right, and comment `/done`: the review then says which findings still stand. On this repository, resolving a thread yourself does not clear it.';
const LINE_8001 = '- **\\[major]** [`src/a.ts:12`](https://git.example.test/c/8001)';

test('before the threads: bypass, then a skip, then a review under way, then the review of the head, then a failed try, else waiting', () => {
  const skip = { actor: 'octo-lead', reason: 'hotfix' };
  assert.deepEqual(planBefore(facts({ gating: 'bypass', skip })), { state: 'bypassed' });
  assert.deepEqual(planBefore(facts({ skip, job: 'running' })), { state: 'skipped', actor: 'octo-lead', reason: 'hotfix' });
  assert.deepEqual(planBefore(facts({ skip, runs: [run(1)] })), { state: 'skipped', actor: 'octo-lead', reason: 'hotfix' });
  assert.deepEqual(planBefore(facts({ job: 'running', paused: 'spend_limit', runs: [run(1)] })), { state: 'reviewing' });
  assert.deepEqual(planBefore(facts({ job: 'pending', paused: 'spend_limit' })), { state: 'paused', code: 'spend_limit' });
  assert.deepEqual(planBefore(facts({ job: 'pending', paused: null, runs: [run(1)] })), { state: 'reviewing' });
  assert.equal(planBefore(facts({ runs: [run(1)] })), null);
  assert.deepEqual(planBefore(facts({ runs: [run(1, { baseSha: 'b0' })] })), { state: 'waiting' });
  assert.deepEqual(planBefore(facts()), { state: 'waiting' });
  const failed = (over: Partial<StoredRun>): StoredRun => run(2, { published: false, outcome: 'failed', body: '', ...over });
  assert.deepEqual(planBefore(facts({ runs: [failed({ failureCode: 'github_502' })] })), { state: 'failed', code: 'github_502', evaluated: false });
  assert.deepEqual(planBefore(facts({ runs: [failed({ failureCode: 'It broke' })] })), { state: 'failed', code: 'review_failed', evaluated: false });
  assert.deepEqual(planBefore(facts({ runs: [failed({ failureCode: null })] })), { state: 'failed', code: 'review_failed', evaluated: false });
  const unpublished = (over: Partial<StoredRun>): StoredRun => run(2, { published: false, ...over });
  assert.deepEqual(planBefore(facts({ runs: [unpublished({ body: '', result: { nothingToDo: true } })] })), { state: 'waiting' });
  assert.deepEqual(planBefore(facts({ runs: [unpublished({ body: '', result: {} })] })), { state: 'failed', code: 'render_failed', evaluated: false });
  assert.deepEqual(planBefore(facts({ runs: [unpublished({ body: '', result: 'x' })] })), { state: 'failed', code: 'render_failed', evaluated: false });
  assert.deepEqual(planBefore(facts({ runs: [unpublished({ body: 'Text' })] })), { state: 'failed', code: 'not_published', evaluated: false });
  assert.deepEqual(planBefore(facts({ runs: [failed({ failureCode: 'github_502', dryRun: true })] })), { state: 'waiting' });
  assert.deepEqual(planBefore(facts({ runs: [failed({ failureCode: 'github_502', headSha: 'h0' })] })), { state: 'waiting' });
  assert.equal(planBefore(facts({ runs: [failed({ id: 1, failureCode: 'github_502' }), run(3)] })), null);
  // the newest run of the head decides among unpublished ones
  assert.deepEqual(planBefore(facts({ runs: [failed({ id: 5, failureCode: 'github_502' }), failed({ id: 4, failureCode: 'github_503' })] })), { state: 'failed', code: 'github_502', evaluated: false });
});

test('after the threads the check is passed or blocked, and counts what the review left out', () => {
  const reviewed = run(1, {
    result: {
      coverage: { reviewed: [], notReviewed: ['a', 'b'] },
      unplaced: [{ severity: 'major' }, { severity: 'minor' }, 'x', { severity: 'blocker' }],
      unchanged: [{ severity: 'minor' }],
    },
  });
  const p = planAfter(verdict([]), reviewed, 0);
  assert.deepEqual(p, { state: 'passed', verdict: verdict([]), notReviewed: 2, withoutThread: 3, refused: 0 });
  const q = planAfter(verdict([]), reviewed, 1);
  assert.equal(q.state, 'blocked');
  assert.equal(planAfter(verdict([blocking()]), reviewed, 0).state, 'blocked');
  assert.deepEqual(planAfter(verdict([]), run(1, { result: 'nope' }), 0), { state: 'passed', verdict: verdict([]), notReviewed: 0, withoutThread: 0, refused: 0 });
  const bad = run(1, { result: { coverage: { notReviewed: 'x' }, unplaced: 'x', unchanged: 4 } });
  assert.deepEqual(planAfter(verdict([]), bad, 0), { state: 'passed', verdict: verdict([]), notReviewed: 0, withoutThread: 0, refused: 0 });
});

test('a count of refused findings that is not a whole number at or above 0 reads as blocked', () => {
  for (const refused of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, -0.1]) {
    const p = planAfter(verdict([]), run(1), refused);
    assert.equal(p.state, 'blocked', String(refused));
    assert.equal(p.state === 'blocked' && p.refused, 1, String(refused));
  }
  assert.equal(planAfter(verdict([]), run(1), 0).state, 'passed');
});

test('each state has its status, its conclusion and its words', () => {
  const WAITING = 'Comment `/done` on this pull request when it is ready to be reviewed. The review then decides this check: a finding marked major or blocker has to be fixed or answered before the merge.';
  assert.deepEqual(checkText({ state: 'waiting' }, meta({ canSkip: true })), { status: 'queued', conclusion: null, title: 'Waiting for /done', summary: WAITING });
  assert.deepEqual(checkText({ state: 'reviewing' }, meta({ canSkip: true })), {
    status: 'in_progress', conclusion: null, title: 'Reviewing',
    summary: 'A review of this pull request is under way or waiting for its turn. Its findings arrive as inline comments with one review, and this check is decided when the review is posted.',
  });
  assert.deepEqual(checkText({ state: 'paused', code: 'spend_limit' }, meta({ canSkip: true })), {
    status: 'queued', conclusion: null, title: 'Review waiting: reviews are paused (spend_limit)',
    summary: `A review of this pull request was asked for and has not started: this deployment has reached its daily spending limit. Reviews start again with the next UTC day, and this one then starts by itself.\n\n${SKIP}`,
  });
  assert.deepEqual(checkText({ state: 'paused', code: 'model_error' }, meta()), {
    status: 'queued', conclusion: null, title: 'Review waiting: reviews are paused (model_error)',
    summary: "A review of this pull request was asked for and has not started: reviews are paused on the reviewer's side. This one starts by itself when they resume.",
  });
  const other = checkText({ state: 'paused', code: 'other_thing' }, meta());
  assert.equal(other.title, 'Review waiting: reviews are paused (other_thing)');
  assert.ok(other.summary.startsWith("A review of this pull request was asked for and has not started: reviews are paused on the reviewer's side."));
  assert.equal(checkText({ state: 'paused', code: 'Bad: /srv/x' }, meta()).title, 'Review waiting: reviews are paused (internal_error)');

  assert.deepEqual(checkText(plan('passed', verdict([], { findings: 0 })), meta({ canSkip: true })), {
    status: 'completed', conclusion: 'success', title: 'No blocking findings', summary: 'Nothing blocks this merge.',
  });
  assert.equal(checkText(plan('passed', verdict([], { findings: 1 })), meta()).title, '1 finding, none blocking');
  assert.equal(checkText(plan('passed', verdict([], { findings: 3 })), meta()).title, '3 findings, none blocking');
  assert.deepEqual(checkText(plan('passed', verdict([], { findings: 3, clearedByReview: 2, clearedByReply: 1 })), meta()), {
    status: 'completed', conclusion: 'success', title: '3 findings, none blocking',
    summary: 'Nothing blocks this merge.\n\nMajor and blocker findings cleared: 2 by a review, 1 by a reply in a resolved thread.',
  });

  assert.deepEqual(checkText({ state: 'failed', code: 'github_502', evaluated: false }, meta({ canSkip: true })), {
    status: 'completed', conclusion: 'failure', title: 'Review failed (github_502): comment /done to retry',
    summary: `The review of this commit did not finish or was not posted (\`github_502\`). Comment \`/done\` to run it again.\n\n${SKIP}`,
  });
  assert.equal(checkText({ state: 'failed', code: 'It broke', evaluated: false }, meta()).title, 'Review failed (internal_error): comment /done to retry');
  assert.deepEqual(checkText({ state: 'failed', code: 'github_502', evaluated: true }, meta({ retrying: true, canSkip: true })), {
    status: 'completed', conclusion: 'failure', title: 'Could not evaluate (github_502): comment /done to retry',
    summary: `The review was posted, but its threads could not be read to decide this check (\`github_502\`). The service tries again by itself. You can also comment \`/done\`.\n\n${SKIP}`,
  });
  assert.equal(checkText({ state: 'failed', code: 'github_502', evaluated: true }, meta({ retrying: false })).summary,
    'The review was posted, but its threads could not be read to decide this check (`github_502`). Comment `/done` to try again.');

  assert.deepEqual(checkText({ state: 'skipped', actor: 'octo-lead', reason: 'hotfix,   checked\tby hand ' }, meta({ canSkip: true })), {
    status: 'completed', conclusion: 'success', title: 'Skipped by @octo-lead',
    summary: 'The review was skipped for commit `abcdef012345` by `octo-lead`.\n\nReason: `hotfix, checked by hand`\n\nA new commit ends the skip: its check waits for `/done` again.',
  });
  assert.deepEqual(checkText({ state: 'bypassed' }, meta({ canSkip: true })), {
    status: 'completed', conclusion: 'success', title: 'Gate bypassed',
    summary: "The merge gate is in bypass mode for this repository, so this check passes without a review. When bypass is switched off, the check goes back to what the gate's rule says.",
  });
});

test('a blocked check lists its threads and says how to clear them', () => {
  const one = checkText(plan('blocked', verdict([blocking()])), meta());
  assert.deepEqual(one, {
    status: 'completed', conclusion: 'action_required', title: '1 blocking finding is open',
    summary: `These threads block the merge:\n\n${LINE_8001}\n\n${WAY_ON}`,
  });
  const four = verdict([
    blocking({ commentId: '8001', severity: 'blocker', why: 'resolved_no_reply', path: 'README', line: null }),
    blocking({ commentId: '8002', unread: true }),
    blocking({ commentId: '8003', severity: 'unknown' }),
    blocking({ commentId: '8004', why: 'resolved_reply_off', unread: true, severity: 'unknown' }),
  ]);
  const on = checkText(plan('blocked', four), meta({ canSkip: true }));
  assert.equal(on.title, '4 blocking findings are open');
  assert.equal(on.summary, [
    'These threads block the merge:',
    [
      '- **\\[blocker]** [`README`](https://git.example.test/c/8001) (resolved with no reply from a person, so it still blocks)',
      "- **\\[major]** [`src/a.ts:12`](https://git.example.test/c/8002) (the review of this commit did not read this thread's file, so it could not judge it: reply in the thread and resolve it)",
      '- **\\[unknown]** [`src/a.ts:12`](https://git.example.test/c/8003) (this app has no record of this finding, so no review can clear it: reply in the thread and resolve it)',
      "- **\\[unknown]** [`src/a.ts:12`](https://git.example.test/c/8004) (resolved; on this repository only a review clears it) (the review of this commit did not read this thread's file, so it could not judge it: reply in the thread and resolve it) (this app has no record of this finding, so no review can clear it: reply in the thread and resolve it)",
    ].join('\n'),
    WAY_ON, SKIP,
  ].join('\n\n'));
  const off = checkText(plan('blocked', four), meta({ clearByReply: false }));
  assert.equal(off.summary, [
    'These threads block the merge:',
    [
      '- **\\[blocker]** [`README`](https://git.example.test/c/8001) (resolved with no reply from a person, so it still blocks)',
      "- **\\[major]** [`src/a.ts:12`](https://git.example.test/c/8002) (the review of this commit did not read this thread's file, so it could not judge it: while that stays so, only a skip lets it through)",
      '- **\\[unknown]** [`src/a.ts:12`](https://git.example.test/c/8003) (this app has no record of this finding, so no review can clear it: only a skip lets it through)',
      "- **\\[unknown]** [`src/a.ts:12`](https://git.example.test/c/8004) (resolved; on this repository only a review clears it) (the review of this commit did not read this thread's file, so it could not judge it: while that stays so, only a skip lets it through) (this app has no record of this finding, so no review can clear it: only a skip lets it through)",
    ].join('\n'),
    WAY_OFF,
  ].join('\n\n'));
});

test('a review GitHub refused inline blocks by itself and beside threads, with its own words', () => {
  const REFUSED = 'GitHub refused the inline comments of the review of this commit, so its findings could not be opened as threads. Major and blocker findings among them: 2. They are listed in the review, and they block this merge.';
  const FIX = 'To clear them, push a fix and comment `/done`: the review of the new commit decides.';
  assert.deepEqual(checkText(plan('blocked', verdict([]), { refused: 2 }), meta({ canSkip: true })), {
    status: 'completed', conclusion: 'action_required', title: 'Blocking findings open: 2 (2 listed in the review only)',
    summary: `${REFUSED}\n\n${FIX}\n\n${SKIP}`,
  });
  const beside = checkText(plan('blocked', verdict([blocking(), blocking({ commentId: '8002', line: 3 })]), { refused: 1 }), meta());
  assert.equal(beside.conclusion, 'action_required');
  assert.equal(beside.title, 'Blocking findings open: 3 (1 listed in the review only)');
  assert.equal(beside.summary, [
    'These threads block the merge:',
    `${LINE_8001}\n- **\\[major]** [\`src/a.ts:3\`](https://git.example.test/c/8002)`,
    WAY_ON,
    REFUSED.replace('among them: 2', 'among them: 1'),
    FIX,
  ].join('\n\n'));
});

test('files not reviewed are counted in the title and the summary, and never fail the check', () => {
  const one = checkText(plan('passed', verdict([], { findings: 0 }), { notReviewed: 1 }), meta());
  assert.equal(one.title, 'No blocking findings; 1 file not reviewed');
  assert.equal(one.conclusion, 'success');
  assert.equal(one.summary, 'Nothing blocks this merge.\n\nFiles not reviewed: 1. The review lists them under Coverage, and this check is decided on the files that were reviewed.');
  const four = checkText(plan('passed', verdict([], { findings: 2, clearedByReview: 1 }), { notReviewed: 4, withoutThread: 2 }), meta());
  assert.equal(four.title, '2 findings, none blocking; 4 files not reviewed');
  assert.equal(four.summary, [
    'Nothing blocks this merge.',
    'Major and blocker findings cleared: 1 by a review, 0 by a reply in a resolved thread.',
    'Files not reviewed: 4. The review lists them under Coverage, and this check is decided on the files that were reviewed.',
    'Major and blocker findings the review could not place on the diff, or raised on code unchanged since the last review: 2. The review lists them, and they do not block.',
  ].join('\n\n'));
  const blocked = checkText(plan('blocked', verdict([blocking()]), { notReviewed: 2 }), meta({ canSkip: true }));
  assert.equal(blocked.title, '1 blocking finding is open; 2 files not reviewed');
  assert.equal(blocked.conclusion, 'action_required');
  assert.equal(blocked.summary, [
    'These threads block the merge:', LINE_8001, WAY_ON,
    'Files not reviewed: 2. The review lists them under Coverage, and this check is decided on the files that were reviewed.',
    SKIP,
  ].join('\n\n'));
});

test('more than fifty blocking threads are cut to fifty lines and a count', () => {
  const many = Array.from({ length: 53 }, (_, i) => blocking({ commentId: String(9000 + i) }));
  const text = checkText(plan('blocked', verdict(many)), meta());
  assert.equal(text.title, '53 blocking findings are open');
  const list = text.summary.split('\n\n')[1]!.split('\n');
  assert.equal(list.length, 51);
  assert.ok(list[0]!.includes('/c/9000'));
  assert.ok(list[49]!.includes('/c/9049'));
  assert.equal(list[50], '- and 3 more');
  const exactly = checkText(plan('blocked', verdict(many.slice(0, 50))), meta());
  assert.equal(exactly.summary.split('\n\n')[1]!.split('\n').length, 50);
});

test('nothing a person or a file name wrote can leave its place in the summary, and no text names the team', () => {
  const odd = checkText(plan('blocked', verdict([blocking({ path: 'src/a`b\nc\u00e9.ts' })])), meta());
  assert.ok(odd.summary.includes('[`src/a?b?c?.ts:12`](https://git.example.test/c/8001)'));
  assert.equal(odd.summary.split('\n\n')[1]!.split('\n').length, 1);
  const long = checkText(plan('blocked', verdict([blocking({ path: 'p'.repeat(300), line: 4 })])), meta());
  assert.ok(long.summary.includes(`[\`${'p'.repeat(200)}:4\`]`));
  const skipped = checkText({ state: 'skipped', actor: 'octo-lead', reason: '@octo-dev <b>x</b>\n# T' }, meta());
  assert.equal(skipped.summary.split('\n\n')[1], 'Reason: `@octo-dev <b>x</b> # T`');
  const reason = skipped.summary.split('\n\n')[1]!;
  assert.ok(!reason.includes('\n'));
  const cut = checkText({ state: 'skipped', actor: 'octo-lead', reason: 'x'.repeat(400) }, meta());
  assert.equal(cut.summary.split('\n\n')[1], `Reason: \`${'x'.repeat(300)}\``);
  // Everything a person typed stays inside one code span: no link, bold, mention, tag, backtick, line break or change of direction is live.
  const live = '[click](https://evil.example.test) **bold** @octo-dev <img src=x> `code` line\nnext \u202Eevil\u2066x\u2069 \u0000\u0007\u007F\u0085\u200E\u200F\u202A\u202B\u202C\u202D';
  const shown = checkText({ state: 'skipped', actor: 'octo-lead', reason: live }, meta()).summary.split('\n\n')[1]!;
  assert.equal(shown, "Reason: `[click](https://evil.example.test) **bold** @octo-dev <img src=x> 'code' line next evilx`");
  assert.ok(!/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(shown));
  assert.equal(shown.split('`').length, 3);
  const spaced = checkText({ state: 'skipped', actor: 'octo-lead', reason: 'a\u0001 \u0002b\tc' }, meta()).summary.split('\n\n')[1];
  assert.equal(spaced, 'Reason: `a b c`');
  const wide = checkText({ state: 'skipped', actor: 'octo-lead', reason: '\u{1F600}'.repeat(301) }, meta()).summary.split('\n\n')[1];
  assert.equal(wide, `Reason: \`${'\u{1F600}'.repeat(300)}\``);
  const empty = checkText({ state: 'skipped', actor: 'octo-lead', reason: '\u202E\u0001 ' }, meta()).summary.split('\n\n')[1];
  assert.equal(empty, 'Reason: `?`');
  // A path that is empty after its treatment is shown as `?`.
  const bare = checkText(plan('blocked', verdict([blocking({ path: '', line: null })])), meta());
  assert.ok(bare.summary.includes('[`?`](https://git.example.test/c/8001)'));
  const bareLine = checkText(plan('blocked', verdict([blocking({ path: '', line: 3 })])), meta());
  assert.ok(bareLine.summary.includes('[`?:3`](https://git.example.test/c/8001)'));
  const stranger = checkText({ state: 'skipped', actor: 'x y', reason: 'ok' }, meta());
  assert.equal(stranger.title, 'Skipped by a team member');
  assert.equal(stranger.summary.split('\n\n')[0], 'The review was skipped for commit `abcdef012345` by a team member.');
  assert.ok(!stranger.title.includes('@'));
  assert.equal(checkText({ state: 'skipped', actor: 'a'.repeat(40), reason: 'ok' }, meta()).title, 'Skipped by a team member');
  assert.equal(checkText({ state: 'skipped', actor: 'a'.repeat(39), reason: 'ok' }, meta()).title, `Skipped by @${'a'.repeat(39)}`);
  assert.equal(checkText({ state: 'failed', code: 'It broke: /srv/app', evaluated: false }, meta()).summary.includes('/srv/app'), false);
  assert.equal(checkText({ state: 'skipped', actor: 'octo-lead', reason: 'ok' }, meta({ head: 'ab/c-d' })).summary.split('\n\n')[0], 'The review was skipped for commit `abcd` by `octo-lead`.');
  const everything: CheckPlan[] = [
    { state: 'waiting' }, { state: 'reviewing' }, { state: 'paused', code: 'spend_limit' }, { state: 'bypassed' },
    { state: 'failed', code: 'x', evaluated: true }, { state: 'skipped', actor: 'octo-lead', reason: 'r' },
    plan('blocked', verdict([blocking()]), { refused: 1 }), plan('passed', verdict([])),
  ];
  for (const p of everything) {
    const t = checkText(p, meta({ canSkip: true }));
    assert.ok(!/release-managers/.test(t.title + t.summary));
  }
});

test('a check that says the same is not written again', () => {
  const wanted = checkText({ state: 'waiting' }, meta());
  const current: OwnCheck = { id: '1', status: 'queued', conclusion: null, title: wanted.title, summary: wanted.summary };
  assert.equal(sameCheck(current, wanted), true);
  assert.equal(sameCheck({ ...current, title: 'Other' }, wanted), false);
  assert.equal(sameCheck({ ...current, summary: 'Other' }, wanted), false);
  assert.equal(sameCheck({ ...current, status: 'in_progress' }, wanted), false);
  const done = checkText({ state: 'bypassed' }, meta());
  assert.equal(sameCheck({ id: '1', status: 'completed', conclusion: null, title: done.title, summary: done.summary }, done), false);
  assert.equal(sameCheck({ id: '1', status: 'completed', conclusion: 'success', title: done.title, summary: done.summary }, done), true);
  assert.equal(sameCheck(null, wanted), false);
});

test('the counts of a state', () => {
  const v = verdict([blocking(), blocking({ commentId: '8002' })], { clearedByReview: 3, clearedByReply: 2, silentResolves: 1, unknownThreads: 1, findings: 9 });
  assert.deepEqual(countsOf(plan('blocked', v, { notReviewed: 4, withoutThread: 5, refused: 1 })), {
    blocking: 2, clearedByReview: 3, clearedByReply: 2, silentResolves: 1, unknownThreads: 1, findings: 9, notReviewed: 4, withoutThread: 5, refusedInline: 1,
  });
  assert.equal(countsOf(plan('passed', verdict([], { findings: 2 }))).findings, 2);
  assert.deepEqual(countsOf({ state: 'waiting' }), NO_COUNTS);
  assert.deepEqual(countsOf({ state: 'failed', code: 'x', evaluated: true }), NO_COUNTS);
});

test('a recorded failure to withdraw fails the check, outranks a skip and a review, and gives way to bypass', () => {
  const skip = { actor: 'octo-lead', reason: 'hotfix' };
  const unwithdrawn: CheckPlan = { state: 'unwithdrawn', code: 'github_403' };
  const failed = run(2, { published: false, outcome: 'failed', body: '', failureCode: 'github_502' });
  for (const over of [
    {}, { skip }, { job: 'running' as const }, { job: 'pending' as const, paused: 'spend_limit' }, { job: 'pending' as const, paused: null },
    { runs: [run(1)] }, { runs: [failed] }, { skip, job: 'running' as const, runs: [run(1)] }, { gating: 'shadow' as const, skip },
  ]) {
    assert.deepEqual(planBefore(facts({ ...over, unwithdrawn: 'github_403' })), unwithdrawn, JSON.stringify(over));
  }
  assert.deepEqual(planBefore(facts({ gating: 'bypass', skip, unwithdrawn: 'github_403' })), { state: 'bypassed' });
  assert.deepEqual(planBefore(facts({ gating: 'bypass', unwithdrawn: 'github_403', runs: [run(1)] })), { state: 'bypassed' });
  // None recorded, absent or null: what it was.
  for (const none of [{}, { unwithdrawn: null }]) {
    assert.deepEqual(planBefore(facts({ ...none, skip })), { state: 'skipped', actor: 'octo-lead', reason: 'hotfix' });
    assert.deepEqual(planBefore(facts({ ...none, job: 'running' })), { state: 'reviewing' });
    assert.equal(planBefore(facts({ ...none, runs: [run(1)] })), null);
    assert.deepEqual(planBefore(facts(none)), { state: 'waiting' });
  }
  // A recorded code that is not a short code, the empty one included, is still a recorded failure.
  for (const code of ['It broke: /srv/app', '', 'GITHUB_403']) {
    assert.deepEqual(planBefore(facts({ unwithdrawn: code, skip })), { state: 'unwithdrawn', code: 'internal_error' }, code);
  }
  assert.deepEqual(countsOf(unwithdrawn), NO_COUNTS);
});

test('the text of a failed withdrawal is pinned and has no skip line', () => {
  const summary = (code: string): string => [
    `This reviewer approved an earlier commit of this pull request, or gave an approval it no longer stands behind, and could not dismiss it (\`${code}\`). While it stands it may count toward the approvals this branch requires, so this check fails.`,
    "Dismiss that approval on the pull request's page. The service also tries again at the next commit, the next review of this pull request and its next start, and this check is decided again once the approval is gone.",
  ].join('\n\n');
  for (const m of [meta(), meta({ canSkip: true }), meta({ canSkip: true, retrying: true, clearByReply: false })]) {
    const text = checkText({ state: 'unwithdrawn', code: 'github_403' }, m);
    assert.deepEqual(text, { status: 'completed', conclusion: 'failure', title: 'Earlier approval not withdrawn (github_403)', summary: summary('github_403') });
    assert.ok(!text.summary.includes(SKIP));
  }
  // A code that is not a short code is shown as internal_error, in the title and in the summary.
  const odd = checkText({ state: 'unwithdrawn', code: 'It broke: /srv/app' }, meta({ canSkip: true }));
  assert.deepEqual(odd, { status: 'completed', conclusion: 'failure', title: 'Earlier approval not withdrawn (internal_error)', summary: summary('internal_error') });
  assert.ok(!(odd.title + odd.summary).includes('/srv/app'));
});
