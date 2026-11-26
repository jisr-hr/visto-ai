import test from 'node:test';
import assert from 'node:assert/strict';
import type { StoredRun } from '../db/review-runs.ts';
import type { PullRequestInfo } from '../forge/types.ts';
import { liveRefusal, storedRefusal, withoutThread } from './rule.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const USAGE = { calls: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0 };

/** A file covered at `finalScore`. */
const file = (path: string, finalScore: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  path, previousPath: null, diffHash: 'd1', changeSummary: '', changedLines: 3, blocks: [], wholeFile: null, fileLevel: null, finalScore, covered: true, ...over,
});
const finding = (severity: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ path: 'src/a.ts', side: 'RIGHT', line: 10, severity, body: 'Check the total.', quote: 'total = a + b', requestedLine: null, ...over });
const unplacedOf = (severity: string): Record<string, unknown> =>
  ({ path: 'src/b.ts', side: 'RIGHT', line: 4, severity, body: 'Check the total.', quote: 'q', reason: 'line_not_in_diff' });
const discussed = (over: Record<string, unknown>): Record<string, unknown> =>
  ({ path: 'src/a.ts', side: 'RIGHT', line: 12, severity: 'major', body: 'Check the total.', commentId: '8001', resolved: true, ...over });

/** A result whose two files are covered at 35 and 20, no finding but a minor, scored with threshold 70. */
const approvable = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'ok', failure: null, mode: 'full', overview: 'Changes a.ts.', findings: [finding('minor')], unplaced: [], beyondDiff: [],
  coverage: { reviewed: ['src/a.ts', 'src/b.ts'], notReviewed: [] }, usage: USAGE, models: [], providers: [], dependencies: { model: 'ok' }, audit: [],
  scores: [file('src/a.ts', 35), file('src/b.ts', 20)], verdict: { threshold: 70, needsHuman: false, highest: 35 }, teamFileInvalid: null, ...over,
});

/** A run at h1 against merge000, published unless `over` says otherwise. */
const run = (id: number, result: unknown = approvable(), over: Partial<StoredRun> = {}): StoredRun => ({
  id, ref: REF, job: id, trigger: 'automatic', mode: 'full', dryRun: false, headSha: 'h1', baseSha: 'merge000', baseBranch: 'main',
  outcome: 'ok', failureStage: null, failureCode: null, needsHuman: false, highestScore: 35, body: '', comments: [], result,
  usage: USAGE, startedAt: '2026-03-01T10:00:00.000Z', finishedAt: '2026-03-01T10:01:00.000Z',
  published: true, reviewId: String(500 + id), publishedAt: '2026-03-01T10:02:00.000Z', inlineDropped: false, publishTriedAt: null, ...over,
});
/** The run about to be published: recorded, not yet posted. */
const current = (result: unknown = approvable(), over: Partial<StoredRun> = {}): StoredRun =>
  run(9, result, { published: false, reviewId: null, publishedAt: null, ...over });
/** The decision for `r` with every run of the pull request: the earlier ones, then `r` as stored. */
const decide = (r: StoredRun, earlier: StoredRun[] = [], threshold = 70) => storedRefusal(r, [...earlier, r], threshold);

test('a covered result under the threshold with no blocking finding is refused by nothing stored', () => {
  assert.equal(decide(current()), null);
  assert.equal(storedRefusal(current(), [], 70), null);
  // An earlier published run that left nothing without a thread, and the same head reviewed again: still nothing.
  assert.equal(decide(current(), [run(1), run(2, approvable({ findings: [finding('major')] }))]), null);
  assert.equal(withoutThread([run(1), current()]), 0);
});

test('a file not covered, a file not reviewed, or no file at all is not_covered', () => {
  assert.equal(decide(current(approvable({ scores: [file('src/a.ts', 35), file('src/b.ts', 20, { covered: false })] }))), 'not_covered');
  assert.equal(decide(current(approvable({ coverage: { reviewed: ['src/a.ts'], notReviewed: [{ path: 'src/b.ts', reason: 'too_large' }] } }))), 'not_covered');
  assert.equal(decide(current(approvable({ scores: [] }))), 'not_covered');
  // An entry that is no object, or whose covered is not true, cannot be told covered.
  assert.equal(decide(current(approvable({ scores: [file('src/a.ts', 35), 7] }))), 'not_covered');
  assert.equal(decide(current(approvable({ scores: [file('src/a.ts', 35), null] }))), 'not_covered');
  assert.equal(decide(current(approvable({ scores: [file('src/a.ts', 35, { covered: 'yes' })] }))), 'not_covered');
  assert.equal(decide(current(approvable({ scores: [file('src/a.ts', 35, { covered: undefined })] }))), 'not_covered');
});

test('a score at or above the threshold in force is needs_human, whatever threshold the run was scored with', () => {
  // Scored with 80, so the stored verdict did not ask for a person; in force now, 70.
  const at80 = approvable({ scores: [file('src/a.ts', 75), file('src/b.ts', 20)], verdict: { threshold: 80, needsHuman: false, highest: 75 } });
  assert.equal(decide(current(at80)), 'needs_human');
  assert.equal(decide(current(at80), [], 80), null);
  // A stored verdict that asked for a person holds, even under a threshold in force that the scores are below.
  assert.equal(decide(current(approvable({ verdict: { threshold: 30, needsHuman: true, highest: 35 } }))), 'needs_human');
  // At the threshold is not below it: the highest, or a file's final score.
  assert.equal(decide(current(approvable({ verdict: { threshold: 70, needsHuman: false, highest: 70 } }))), 'needs_human');
  assert.equal(decide(current(approvable({ scores: [file('src/a.ts', 70), file('src/b.ts', 20)] }))), 'needs_human');
  // What cannot be read as "not needed" or as a number below the threshold is needed.
  assert.equal(decide(current(approvable({ verdict: { threshold: 70, highest: 35 } }))), 'needs_human');
  assert.equal(decide(current(approvable({ verdict: { threshold: 70, needsHuman: 'no', highest: 35 } }))), 'needs_human');
  assert.equal(decide(current(approvable({ verdict: { threshold: 70, needsHuman: false, highest: '35' } }))), 'needs_human');
  assert.equal(decide(current(approvable({ verdict: { threshold: 70, needsHuman: false } }))), 'needs_human');
  assert.equal(decide(current(approvable({ scores: [file('src/a.ts', 35), file('src/b.ts', 20, { finalScore: null })] }))), 'needs_human');
  assert.equal(decide(current(approvable({ scores: [file('src/a.ts', 35), file('src/b.ts', 20, { finalScore: '20' })] }))), 'needs_human');
  assert.equal(decide(current(), [], Number.NaN), 'needs_human');
});

test('a major or a blocker of this review, placed, unplaced or on unchanged code, is blocking_finding; a minor and a finding beyond the diff are not', () => {
  assert.equal(decide(current(approvable({ findings: [finding('minor'), finding('major')] }))), 'blocking_finding');
  assert.equal(decide(current(approvable({ findings: [finding('blocker')] }))), 'blocking_finding');
  assert.equal(decide(current(approvable({ unplaced: [unplacedOf('major')] }))), 'blocking_finding');
  assert.equal(decide(current(approvable({ unplaced: [unplacedOf('blocker')] }))), 'blocking_finding');
  assert.equal(decide(current(approvable({ unchanged: [finding('major')] }))), 'blocking_finding');
  assert.equal(decide(current(approvable({ unchanged: [finding('blocker')] }))), 'blocking_finding');
  assert.equal(decide(current(approvable({ unplaced: [unplacedOf('minor')], unchanged: [finding('minor')] }))), null);
  // Beyond the diff is never read (5.6, step 5), whatever it holds.
  assert.equal(decide(current(approvable({ beyondDiff: [{ ...finding('blocker'), beyond_diff: true }] }))), null);
  assert.equal(decide(current(approvable({ beyondDiff: 'x' }))), null);
  assert.equal(decide(current(approvable({ beyondDiff: undefined }))), null);
});

test('a major or blocker left without a thread by any published run holds approval', () => {
  const earlier = (result: Record<string, unknown>, over: Partial<StoredRun> = {}): StoredRun => run(1, approvable(result), over);
  const holding: Array<[string, StoredRun]> = [
    ['an unplaced major', earlier({ unplaced: [unplacedOf('major')] })],
    ['inline dropped with a placed blocker', earlier({ findings: [finding('blocker')] }, { inlineDropped: true })],
    ['an unchanged major', earlier({ unchanged: [finding('major')] })],
    ['a discussed entry closed for approval', earlier({ alreadyDiscussed: [discussed({ settled: false, closedForApproval: true })] })],
    ['a discussed entry stored before the flag, settled', earlier({ alreadyDiscussed: [discussed({ settled: true })] })],
  ];
  for (const [what, r] of holding) {
    assert.equal(decide(current(), [r]), 'finding_without_thread', what);
    assert.equal(withoutThread([r]), 1, what);
    // Not in a dry run, nor in a run that was never published.
    assert.equal(decide(current(), [{ ...r, dryRun: true }]), null, `${what}, in a dry run`);
    assert.equal(decide(current(), [{ ...r, published: false, reviewId: null, publishedAt: null }]), null, `${what}, unpublished`);
  }
  assert.equal(withoutThread(holding.map(([, r]) => r)), 5);
  const notHolding: Array<[string, StoredRun]> = [
    ['a discussed entry closed for approval false, settled true', earlier({ alreadyDiscussed: [discussed({ settled: true, closedForApproval: false })] })],
    ['a discussed entry stored before the flag, not settled', earlier({ alreadyDiscussed: [discussed({ settled: false })] })],
    ['an unplaced minor', earlier({ unplaced: [unplacedOf('minor')] })],
    ['an unchanged minor', earlier({ unchanged: [finding('minor')] })],
    ['inline dropped with a placed minor', earlier({ findings: [finding('minor')] }, { inlineDropped: true })],
    ['a placed blocker posted inline', earlier({ findings: [finding('blocker')] })],
  ];
  for (const [what, r] of notHolding) {
    assert.equal(decide(current(), [r]), null, what);
    assert.equal(withoutThread([r]), 0, what);
  }
  // This run's own discussed entry counts, whether or not the runs given hold it.
  const own = current(approvable({ alreadyDiscussed: [discussed({ settled: false, closedForApproval: true })] }));
  assert.equal(storedRefusal(own, [], 70), 'finding_without_thread');
  assert.equal(decide(own), 'finding_without_thread');
  // A stored copy of this run is not read in its place: the run handed in decides.
  assert.equal(storedRefusal(current(), [run(9, approvable({ alreadyDiscussed: [discussed({ settled: true })] }))], 70), null);
});

test('an earlier run not known to be unpublished is read, and one not known to be posted with its inline comments counts its placed blocker', () => {
  const unpublished = { ...run(1, approvable({ unplaced: [unplacedOf('major')] })), published: undefined } as unknown as StoredRun;
  assert.equal(decide(current(), [unpublished]), 'finding_without_thread');
  const dropped = { ...run(1, approvable({ findings: [finding('blocker')] })), inlineDropped: undefined } as unknown as StoredRun;
  assert.equal(withoutThread([dropped]), 1);
  assert.equal(decide(current(), [dropped]), 'finding_without_thread');
});

test('a stored result that cannot be read is record_unreadable, never approvable', () => {
  for (const result of [null, 'x', [], 7]) assert.equal(decide(current(result)), 'record_unreadable', String(result));
  assert.equal(decide(current(approvable(), { result: undefined })), 'record_unreadable');
  const unreadable: Array<[string, Record<string, unknown>]> = [
    ['scores not a list', { scores: {} }],
    ['findings not a list', { findings: null }],
    ['unplaced not a list', { unplaced: 'x' }],
    ['coverage not an object', { coverage: [] }],
    ['notReviewed not a list', { coverage: { reviewed: [], notReviewed: 'x' } }],
    ['verdict not an object', { verdict: [] }],
    ['verdict absent', { verdict: undefined }],
    ['unchanged not a list', { unchanged: 'x' }],
    ['unchanged null', { unchanged: null }],
    ['a finding that is no object', { findings: [7] }],
    ['a finding with no severity', { findings: [finding('minor', { severity: undefined })] }],
    ['a finding whose severity is no word of the engine', { findings: [finding('critical')] }],
    ['an unplaced entry that is no object', { unplaced: [null] }],
    ['an unchanged entry with a severity that is no string', { unchanged: [finding('minor', { severity: 3 })] }],
  ];
  for (const [what, over] of unreadable) assert.equal(decide(current(approvable(over))), 'record_unreadable', what);

  const earlier = (result: unknown, over: Partial<StoredRun> = {}): StoredRun => run(1, result, over);
  const unreadableEarlier: Array<[string, StoredRun]> = [
    ["an earlier run's alreadyDiscussed [7]", earlier(approvable({ alreadyDiscussed: [7] }))],
    ['a discussed entry with neither flag', earlier(approvable({ alreadyDiscussed: [discussed({})] }))],
    ['a discussed entry whose flag is no boolean', earlier(approvable({ alreadyDiscussed: [discussed({ settled: true, closedForApproval: 'yes' })] }))],
    ['inlineDropped with findings null', earlier(approvable({ findings: null }), { inlineDropped: true })],
    ['inlineDropped with no findings', earlier(approvable({ findings: undefined }), { inlineDropped: true })],
    ['an earlier result null', earlier(null)],
    ['an earlier unplaced not a list', earlier(approvable({ unplaced: {} }))],
    ['an earlier unchanged entry that is no object', earlier(approvable({ unchanged: ['x'] }))],
    ['an earlier alreadyDiscussed not a list', earlier(approvable({ alreadyDiscussed: 'x' }))],
    ['an earlier unplaced entry with no severity', earlier(approvable({ unplaced: [{ path: 'src/b.ts' }] }))],
  ];
  for (const [what, r] of unreadableEarlier) {
    assert.equal(decide(current(), [r]), 'record_unreadable', what);
    assert.equal(withoutThread([r]), null, what);
  }
  // The runs themselves: no list, or an entry that is no run.
  assert.equal(storedRefusal(current(), 'x' as unknown as StoredRun[], 70), 'record_unreadable');
  assert.equal(storedRefusal(current(), [null as unknown as StoredRun], 70), 'record_unreadable');
  assert.equal(storedRefusal(null as unknown as StoredRun, [], 70), 'record_unreadable');
  assert.equal(withoutThread('x' as unknown as StoredRun[]), null);
  assert.equal(withoutThread([7 as unknown as StoredRun]), null);
  // A field this rule does not read is not checked: findings of a run posted inline, beyond the diff.
  assert.equal(decide(current(), [earlier(approvable({ findings: null, beyondDiff: 'x' }))]), null);
});

test('the first condition that fails is the one given', () => {
  const blocker = [finding('blocker')];
  const over = [file('src/a.ts', 90), file('src/b.ts', 20, { covered: false })];
  assert.equal(decide(current(approvable({ scores: over, findings: blocker, verdict: { threshold: 70, needsHuman: true, highest: 90 } }))), 'not_covered');
  assert.equal(decide(current(approvable({ scores: [file('src/a.ts', 90)], findings: blocker, verdict: { threshold: 70, needsHuman: true, highest: 90 } }))), 'needs_human');
  const heldEarlier = run(1, approvable({ unplaced: [unplacedOf('major')] }));
  assert.equal(decide(current(approvable({ findings: blocker })), [heldEarlier]), 'blocking_finding');
  // What cannot be read comes before all of these; a damaged earlier run only once this one holds.
  assert.equal(decide(current(approvable({ unplaced: 'x', scores: [] }))), 'record_unreadable');
  assert.equal(decide(current(approvable({ findings: blocker })), [run(1, null)]), 'blocking_finding');
  assert.equal(decide(current(approvable({ scores: [] })), [run(1, null)]), 'not_covered');
});

test('a draft, a fork and an origin not known are refused in that order', () => {
  const info = (over: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
    ref: REF, title: 'Fix the total', description: '', author: 'octo-dev', baseBranch: 'main', headBranch: 'fix-total',
    baseSha: 'merge000', headSha: 'h1', draft: false, fromFork: false, ...over,
  });
  assert.equal(liveRefusal(info()), null);
  assert.equal(liveRefusal(info({ draft: true, fromFork: true })), 'draft');
  assert.equal(liveRefusal(info({ draft: true, fromFork: undefined })), 'draft');
  assert.equal(liveRefusal(info({ fromFork: true })), 'from_fork');
  assert.equal(liveRefusal(info({ fromFork: undefined })), 'origin_unknown');
  const absent = info();
  delete absent.fromFork;
  assert.equal('fromFork' in absent, false);
  assert.equal(liveRefusal(absent), 'origin_unknown');
  // A field that is no boolean is not known: never "not a draft" or "not a fork".
  assert.equal(liveRefusal(info({ fromFork: 'no' as unknown as boolean })), 'origin_unknown');
  assert.equal(liveRefusal(info({ draft: undefined as unknown as boolean })), 'draft');
  assert.equal(liveRefusal(null as unknown as PullRequestInfo), 'draft');
});
