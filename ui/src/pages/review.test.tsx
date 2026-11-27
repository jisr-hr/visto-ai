import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RequestFailed } from '../api.ts';
import type { Api } from '../api.ts';
import type { Me, OneReview, PullReviews } from '../api-types.ts';
import { App } from '../app.tsx';
import { runOfPath } from './review.tsx';

const NOW = '2026-03-01T10:00:00.000Z';
const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

const ME: Me = { name: 'octo-lead', kind: 'github', role: 'admin', csrf: 'csrf-token-for-tests', mode: 'live', repositories: ['acme/shop'] };
const REVIEW: OneReview = {
  now: NOW, run: 9001, ordinal: 3, runs: 3,
  pullRequest: {
    repository: 'acme/shop', number: 128, title: 'Round prices before tax', author: 'octo-dev', headBranch: 'fix/round-prices', baseBranch: 'main',
    url: 'https://github.example.test/acme/shop/pull/128',
  },
  head: '3f9c2e1a7b04', askedBy: { reason: 'synchronize', login: null }, mode: 'incremental', posting: 'published', failure: null,
  startedAt: at(-761), finishedAt: at(-720), publishedAt: at(-719),
  approval: { decision: 'not_approved', code: 'needs_human', text: 'a part of this change is at or above 70%, so a person should review it.' },
  gate: { mode: 'enforce', state: 'blocked', code: null, blocking: 1 }, threshold: 70,
  files: [], filesCut: 0, read: { files: 4, reviewed: 2 }, findings: [], findingsCut: 0, counts: { blocker: 0, major: 1, minor: 0 },
  earlier: { cleared: 2, open: 1, unjudged: 0, discussed: 1 },
  usage: { models: ['vendor/model-a'], calls: 3, inputTokens: 38412, cachedTokens: 21900, outputTokens: 2118, cost: 0.084 },
  approvals: [], dependencies: [], feedback: { helpful: 0, notHelpful: 0, reasons: [] },
};
const PULL: PullReviews = {
  now: NOW, total: 3,
  reviews: [
    { run: 9001, ordinal: 3, at: at(-720) },
    { run: 8990, ordinal: 2, at: at(-86400) },
    { run: 8977, ordinal: 1, at: at(-2 * 86400 - 60) },
  ],
};

interface Over { review?: (run: number) => Promise<OneReview>; pullReviews?: (repository: string, number: number) => Promise<PullReviews> }
function fakeApi(over: Over = {}) {
  const calls: unknown[][] = [];
  const nope = (): Promise<never> => Promise.reject(new RequestFailed(500, 'not_expected'));
  const api: Api = {
    me: () => Promise.resolve(ME),
    activity: () => Promise.resolve({ now: NOW, places: { reviews: 2, withdrawals: 2 }, paused: null, jobs: [], withdrawals: [] }),
    reviews: () => Promise.resolve({ now: NOW, windowDays: 30, total: 0, reviews: [], next: null }),
    signOut: nope, ways: nope, passwordSignIn: nope, firstPassword: nope, changePassword: nope, accounts: nope, makeAccount: nope, setRole: nope,
    resetPassword: nope, removeAccount: nope,
    review: (run) => {
      calls.push(['review', run]);
      return over.review ? over.review(run) : Promise.resolve({ ...REVIEW, run });
    },
    pullReviews: (repository, number) => {
      calls.push(['pullReviews', repository, number]);
      return over.pullReviews ? over.pullReviews(repository, number) : Promise.resolve(PULL);
    },
  };
  const named = (name: string): unknown[][] => calls.filter(([n]) => n === name);
  return { api, named };
}

function open(api: Api, path = '/ui/reviews/9001') {
  window.history.replaceState(null, '', path);
  return render(<App api={api} />);
}
/** The banner, with the review's decision and gate set as given. */
function withApproval(approval: OneReview['approval'], gate: OneReview['gate'] = null, failure: OneReview['failure'] = null): Over {
  return { review: (run) => Promise.resolve({ ...REVIEW, run, approval, gate, failure }) };
}
const banner = (): HTMLElement => screen.getByRole('region', { name: 'Approval' });

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

test('the page reads its review once, and says while it reads, when it is not stored, and when it cannot be read', async () => {
  vi.useFakeTimers();
  let fail: RequestFailed | null = new RequestFailed(404, 'not_found');
  const { api, named } = fakeApi({ review: () => (fail === null ? Promise.resolve(REVIEW) : Promise.reject(fail)) });
  const view = open(api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  // Read: the answer is a 404, so the not-found header shows, under the breadcrumb.
  expect(named('review')).toEqual([['review', 9001]]);
  expect(screen.getByRole('heading', { level: 1, name: 'Review not found' })).toBeInTheDocument();
  expect(screen.getByText('No review is stored under this number.')).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(60000));
  expect(named('review')).toHaveLength(1);
  expect(named('pullReviews')).toHaveLength(0);
  const crumb = (): HTMLElement => screen.getByRole('navigation', { name: 'Breadcrumb' });
  expect(within(crumb()).getByRole('link', { name: 'Activity' })).toHaveAttribute('href', '/ui/activity');
  expect(crumb()).toHaveTextContent('Activity/Review 9001');
  view.unmount();

  // While it reads: busy, under the breadcrumb; the list is not asked before a review is read.
  let answer: (review: OneReview) => void = () => {};
  const slow = fakeApi({ review: () => new Promise<OneReview>((resolve) => { answer = resolve; }) });
  const second = open(slow.api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(slow.named('review')).toEqual([['review', 9001]]);
  expect(slow.named('pullReviews')).toHaveLength(0);
  expect(crumb()).toHaveTextContent('Activity/Review 9001');
  await act(async () => answer(REVIEW));
  expect(screen.getByRole('heading', { level: 1, name: 'Round prices before tax' })).toBeInTheDocument();
  second.unmount();

  // Any other failure says so and Try again reads again.
  fail = new RequestFailed(500, 'unknown');
  const broken = fakeApi({ review: () => (fail === null ? Promise.resolve(REVIEW) : Promise.reject(fail)) });
  open(broken.api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByText('The review could not be read.')).toBeInTheDocument();
  expect(within(crumb()).getByRole('link', { name: 'Activity' })).toHaveAttribute('href', '/ui/activity');
  fail = null;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(broken.named('review')).toEqual([['review', 9001], ['review', 9001]]);
  expect(screen.getByRole('heading', { level: 1, name: 'Round prices before tax' })).toBeInTheDocument();
});

test('an address whose run is not a run says Review not found and reads nothing', async () => {
  expect(runOfPath('/ui/reviews/9001')).toBe(9001);
  expect(runOfPath('/ui/reviews/2147483647')).toBe(2147483647);
  expect(runOfPath('/ui/reviews/2147483648')).toBeNull();
  for (const path of ['/ui/reviews/007', '/ui/reviews/0', '/ui/reviews/2147483648', `/ui/reviews/${'9'.repeat(400)}`]) {
    const { api, named } = fakeApi();
    const view = open(api, path);
    expect(await screen.findByRole('heading', { level: 1, name: 'Review not found' })).toBeInTheDocument();
    expect(named('review')).toHaveLength(0);
    expect(named('pullReviews')).toHaveLength(0);
    view.unmount();
  }
});

test('the header shows the title, the pull request, its author, branches and head, and links to GitHub', async () => {
  const { api } = fakeApi();
  const view = open(api);
  expect(await screen.findByRole('heading', { level: 1, name: 'Round prices before tax' })).toBeInTheDocument();
  expect(screen.getByText('acme/shop #128 by octo-dev')).toBeInTheDocument();
  for (const text of ['fix/round-prices', 'main', '3f9c2e1a7b04']) {
    const element = screen.getByText(text);
    expect(element).toHaveClass('font-mono', 'text-[12.5px]');
  }
  expect(screen.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute('href', 'https://github.example.test/acme/shop/pull/128');
  expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Activity/acme/shop #128');
  view.unmount();

  const bare = fakeApi({
    review: (run) =>
      Promise.resolve({ ...REVIEW, run, pullRequest: { ...REVIEW.pullRequest, title: null, author: null, url: 'http://github.example.test/acme/shop/pull/128' } }),
  });
  open(bare.api);
  expect(await screen.findByRole('heading', { level: 1, name: 'acme/shop #128' })).toBeInTheDocument();
  expect(screen.getAllByText('acme/shop #128')).toHaveLength(3);
  expect(screen.queryByText(/^acme\/shop #128 by /)).toBeNull();
  expect(screen.queryByRole('link', { name: 'Open on GitHub' })).toBeNull();
});

test('the selector lists the reviews of the pull request and moves between them', async () => {
  const { api, named } = fakeApi({
    review: (run) => Promise.resolve({ ...REVIEW, run, pullRequest: { ...REVIEW.pullRequest, number: run === 7000 ? 77 : 128 } }),
  });
  open(api);
  const select = await screen.findByRole('combobox', { name: 'Review' });
  expect(named('pullReviews')).toEqual([['pullReviews', 'acme/shop', 128]]);
  const options = within(select).getAllByRole('option');
  expect(options.map((option) => option.textContent)).toEqual(['Review 3 of 3, 12 min ago', 'Review 2 of 3, yesterday', 'Review 1 of 3, 2 days ago']);
  expect(select).toHaveValue('9001');

  fireEvent.change(select, { target: { value: '8990' } });
  expect(window.location.pathname).toBe('/ui/reviews/8990');
  expect(await screen.findByRole('combobox', { name: 'Review' })).toHaveValue('8990');
  expect(named('review')).toEqual([['review', 9001], ['review', 8990]]);
  expect(named('pullReviews')).toHaveLength(1);

  // A review of another pull request reads the list of that one.
  act(() => {
    window.history.pushState(null, '', '/ui/reviews/7000');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await screen.findByText('acme/shop #77', { selector: 'span' });
  await vi.waitFor(() => expect(named('pullReviews')).toEqual([['pullReviews', 'acme/shop', 128], ['pullReviews', 'acme/shop', 77]]));
});

test('the selector always holds this run, even when the list does not, and is left out when the list cannot be read', async () => {
  const unlisted = fakeApi({ pullReviews: () => Promise.resolve({ ...PULL, reviews: PULL.reviews.slice(1) }) });
  const view = open(unlisted.api);
  const select = await screen.findByRole('combobox', { name: 'Review' });
  expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
    'Review 2 of 3, yesterday', 'Review 1 of 3, 2 days ago', 'Review 3 of 3, 12 min ago',
  ]);
  expect(select).toHaveValue('9001');
  view.unmount();

  const failing = fakeApi({ pullReviews: () => Promise.reject(new RequestFailed(500, 'unknown')) });
  open(failing.api);
  expect(await screen.findByRole('heading', { level: 1, name: 'Round prices before tax' })).toBeInTheDocument();
  await vi.waitFor(() => expect(failing.named('pullReviews')).toHaveLength(1));
  await act(async () => {});
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByRole('link', { name: 'Open on GitHub' })).toBeInTheDocument();
});

test("why it approved or not is said with the paragraph's words and the merge gate's state", async () => {
  const gate = (over: Partial<NonNullable<OneReview['gate']>>): NonNullable<OneReview['gate']> => ({ mode: 'enforce', state: 'passed', code: null, blocking: 0, ...over });
  const none = { code: null, text: null };

  // not_approved, with its paragraph and the gate.
  const first = open(fakeApi().api);
  await screen.findByText('Not approved automatically');
  expect(banner()).toHaveClass('border-warn', 'bg-warn-bg');
  expect(banner()).toHaveTextContent(
    "Not approved automatically" + 'A part of this change is at or above 70%, so a person should review it. ' + "The merge gate's check says 1 blocking finding is open.",
  );
  first.unmount();

  async function shows(over: Over, title: string): Promise<HTMLElement> {
    const view = open(fakeApi(over).api);
    const element = await screen.findByRole('region', { name: 'Approval' });
    within(element).getByText(title);
    // Hand the view back through a cleanup the next call makes.
    cleanup = view.unmount;
    return element;
  }
  let cleanup = (): void => {};
  const again = async (over: Over, title: string): Promise<HTMLElement> => {
    cleanup();
    return shows(over, title);
  };

  let element = await again(withApproval({ decision: 'approved', code: null, text: 'for commit `3f9c2e1a7b04`: every file is below the threshold.' }), 'Approved automatically');
  expect(element).toHaveClass('border-ok', 'bg-ok-bg');
  expect(element).toHaveTextContent('For commit 3f9c2e1a7b04: every file is below the threshold.');
  expect(within(element).getByText('3f9c2e1a7b04')).toHaveClass('font-mono');

  element = await again(withApproval({ decision: 'approved', ...none }), 'Approved automatically');
  expect(element).toHaveTextContent('Posted as an approval.');

  element = await again(withApproval({ decision: 'not_approved', code: 'needs_human', text: null }), 'Not approved automatically');
  expect(element).toHaveTextContent('Decided as needs_human.');
  expect(within(element).getByText('needs_human')).toHaveClass('font-mono');

  element = await again(withApproval({ decision: 'dry_run', ...none }), 'Not decided in dry run');
  expect(element).toHaveClass('border-border', 'bg-card');
  expect(element).toHaveTextContent('In dry run the service decides no approval: it reads neither threads nor branch rules.');

  element = await again(withApproval({ decision: 'not_decided', ...none }), 'No approval decided');
  expect(element).toHaveTextContent('Automatic approval was off for this repository when this review was posted, or the review was already on GitHub.');
  element = await again(withApproval({ decision: 'not_posted', ...none }), 'Not posted');
  expect(element).toHaveTextContent('This review was recorded and not posted, so no approval was decided.');
  element = await again(withApproval({ decision: 'nothing_new', ...none }), 'Nothing new');
  expect(element).toHaveTextContent('This review found nothing new to tell, so it was not posted and decided no approval.');

  element = await again(withApproval({ decision: 'failed', ...none }, null, { stage: 'model', code: 'model_timeout' }), 'Review failed');
  expect(element).toHaveClass('border-bad', 'bg-bad-bg');
  expect(element).toHaveTextContent('The review did not finish (model: model_timeout), so no approval was decided.');
  expect(within(element).getByText('model')).toHaveClass('font-mono');
  element = await again(withApproval({ decision: 'failed', ...none }, null, { stage: 'unknown', code: null }), 'Review failed');
  expect(element).toHaveTextContent('The review did not finish (unknown), so no approval was decided.');

  const lines: Array<[Partial<NonNullable<OneReview['gate']>>, string]> = [
    [{ state: 'blocked', blocking: 2 }, "The merge gate's check says 2 blocking findings are open."],
    [{ state: 'passed', mode: 'shadow' }, "The merge gate's check, in shadow mode, says nothing blocks the merge."],
    [{ state: 'paused', code: 'spend_limit' }, "The merge gate's check waits: reviews are paused (spend_limit)."],
    [{ state: 'paused' }, "The merge gate's check waits: reviews are paused."],
    [{ state: 'waiting' }, "The merge gate's check waits for /done."],
    [{ state: 'reviewing' }, "The merge gate's check waits for the review under way."],
    [{ state: 'failed', code: 'github_500' }, "The merge gate's check failed (github_500)."],
    [{ state: 'skipped' }, "The merge gate's check was skipped by a team member."],
    [{ state: 'bypassed' }, "The merge gate's check passes: the gate is in bypass mode."],
    [{ state: 'unwithdrawn', code: 'github_403' }, "The merge gate's check fails: an earlier approval is not withdrawn (github_403)."],
    [{ state: 'closed' }, "The merge gate's check was not written: the pull request is closed."],
    [{ state: 'not_found' }, "The merge gate's check was not written: the pull request was not found."],
    [{ state: 'later_state' }, "The merge gate's check says later_state."],
  ];
  for (const [state, line] of lines) {
    element = await again(withApproval({ decision: 'not_decided', ...none }, gate(state)), 'No approval decided');
    expect(element).toHaveTextContent(line);
  }
  element = await again(withApproval({ decision: 'not_decided', ...none }, null), 'No approval decided');
  expect(element).not.toHaveTextContent("merge gate's check");
  cleanup();
});

const FILE: OneReview['files'][number] = {
  path: 'src/cart/price.ts', score: 74, notReviewed: null, source: null, reason: 'Changes the amount every order total is built from.',
  category: null, blocks: 2, highest: { side: 'RIGHT', first: 38, last: 51 }, kept: null, raisedFrom: null,
};
const FINDING: OneReview['findings'][number] = {
  kind: 'placed', severity: 'major', path: 'src/cart/price.ts', side: 'RIGHT', line: 42, body: 'Rounding each line before tax can move a total.',
  thread: { state: 'open', by: null },
};
function withParts(parts: Partial<OneReview>): Over {
  return { review: (run) => Promise.resolve({ ...REVIEW, run, ...parts }) };
}
const scores = (): HTMLElement => screen.getByRole('region', { name: 'Scores by file' });
const findingsCard = (): HTMLElement => screen.getByRole('region', { name: 'Findings' });
const rowOf = (path: string): HTMLElement => screen.getByText(path).closest('tr')!;

test('scores by file show each score with its colour, its blocks and why', async () => {
  vi.useFakeTimers();
  const files: OneReview['files'] = [
    FILE,
    { ...FILE, path: 'src/cart/tax.ts', score: 58, blocks: 1, kept: 'earlier_run', reason: 'Reads the rounded amount.' },
    { ...FILE, path: 'src/cart/price.test.ts', score: 12, source: 'whole_file', blocks: 1, highest: null, reason: 'Tests only.' },
    { ...FILE, path: 'src/cart/whole.ts', score: 20, source: 'whole_file', blocks: 1, highest: null, reason: '' },
    { ...FILE, path: '.github/workflows/ci.yml', score: 100, source: 'builtin_floor', blocks: 3, highest: null, reason: '' },
    { ...FILE, path: 'src/cart/other.ts', score: 30, blocks: 1, kept: 'other_pull_request', category: 'calculation', reason: '' },
    { ...FILE, path: 'src/cart/nocat.ts', score: 30, blocks: 1, kept: 'other_pull_request', category: null, reason: '' },
    { ...FILE, path: 'src/cart/old.ts', score: 10, blocks: 1, highest: { side: 'LEFT', first: 40, last: 40 }, reason: 'Removed code.' },
    { ...FILE, path: 'src/cart/blank.ts', score: 10, blocks: 1, reason: '' },
    { ...FILE, path: 'src/cart/raised.ts', score: 80, blocks: 1, raisedFrom: 55, reason: 'Money.' },
    { ...FILE, path: 'src/cart/none.ts', score: 5, blocks: 0, highest: null, reason: 'Nothing.' },
    { ...FILE, path: 'src/cart/many.ts', score: 5, blocks: 3, highest: { side: 'LEFT', first: 3, last: 3 }, kept: 'earlier_run', reason: 'x.' },
    { ...FILE, path: 'src/cart/single.ts', score: 5, blocks: 1, highest: { side: 'RIGHT', first: 8, last: 8 }, reason: 'x.' },
  ];
  const { api } = fakeApi(withParts({ files }));
  open(api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const card = scores();
  expect(within(card).getByRole('heading', { level: 2, name: 'Scores by file' })).toBeInTheDocument();
  expect(within(card).getByText('Threshold 70%')).toBeInTheDocument();
  expect(within(card).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['File', 'Score', 'Why']);
  const price = rowOf('src/cart/price.ts');
  expect(within(price).getByText('src/cart/price.ts')).toHaveClass('font-mono');
  expect(within(price).getByText('2 blocks, the highest at lines 38 to 51')).toBeInTheDocument();
  expect(within(price).getByText('74%')).toHaveClass('bg-bad-bg', 'text-bad');
  expect(within(price).getByText('Changes the amount every order total is built from.')).toBeInTheDocument();
  expect(within(rowOf('src/cart/tax.ts')).getByText('58%')).toHaveClass('bg-info-bg');
  expect(within(rowOf('src/cart/tax.ts')).getByText('1 block, kept from an earlier review')).toBeInTheDocument();
  const tests = rowOf('src/cart/price.test.ts');
  expect(within(tests).getByText('12%')).toHaveClass('bg-ok-bg');
  expect(within(tests).getByText('Whole file')).toBeInTheDocument();
  expect(within(tests).getByText('Tests only.')).toBeInTheDocument();
  expect(within(rowOf('src/cart/whole.ts')).getByText('Scored as a whole file.')).toBeInTheDocument();
  expect(within(rowOf('.github/workflows/ci.yml')).getByText("It changes the reviewer's own file, code owners or CI.")).toBeInTheDocument();
  const other = rowOf('src/cart/other.ts');
  expect(within(other).getByText('1 block, scored on another pull request')).toBeInTheDocument();
  expect(within(other).getByText('calculation')).toHaveClass('font-mono');
  expect(other).toHaveTextContent('Scored on another pull request as calculation.');
  expect(rowOf('src/cart/nocat.ts')).toHaveTextContent('Scored on another pull request.');
  expect(within(rowOf('src/cart/old.ts')).getByText('1 block, at old line 40')).toBeInTheDocument();
  expect(within(rowOf('src/cart/blank.ts')).getByText('No reason given.')).toHaveClass('text-muted');
  expect(rowOf('src/cart/raised.ts')).toHaveTextContent('Money. 55% was given; a block this file lost had scored 80%.');
  expect(rowOf('src/cart/none.ts').querySelector('.mt-1')).toBeNull();
  expect(within(rowOf('src/cart/many.ts')).getByText('3 blocks, the highest at old line 3, kept from an earlier review')).toBeInTheDocument();
  expect(within(rowOf('src/cart/single.ts')).getByText('1 block, at line 8')).toBeInTheDocument();
});

test('files not reviewed say why and what they counted as', async () => {
  vi.useFakeTimers();
  const base = { ...FILE, blocks: 0, highest: null, reason: '' };
  const files: OneReview['files'] = [
    { ...base, path: 'package-lock.json', score: 100, notReviewed: 'too_large' },
    { ...base, path: 'secret.env', score: null, notReviewed: 'secret_file' },
    { ...base, path: 'odd.txt', score: 100, notReviewed: 'later_reason' },
    { ...base, path: 'a.bin', score: null, notReviewed: 'no_diff' },
    { ...base, path: 'b.ts', score: null, notReviewed: 'over_batch_limit' },
    { ...base, path: 'c.ts', score: null, notReviewed: 'batch_failed' },
    { ...base, path: 'd.ts', score: 40, source: 'weird_source' },
  ];
  const { api } = fakeApi(withParts({ files }));
  open(api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const lock = rowOf('package-lock.json');
  expect(within(lock).getByText('Not reviewed')).toHaveClass('bg-subtle', 'text-muted');
  expect(within(lock).queryByText('100%')).toBeNull();
  expect(lock).toHaveTextContent('Its diff is too large to send to the model. Counted as 100%.');
  expect(lock.querySelectorAll('td')[2]).toHaveClass('text-muted');
  expect(rowOf('secret.env')).toHaveTextContent('It may hold secrets, so it is never sent to the model.');
  expect(rowOf('secret.env')).not.toHaveTextContent('Counted');
  expect(within(rowOf('odd.txt')).getByText('later_reason')).toHaveClass('font-mono');
  expect(rowOf('odd.txt')).toHaveTextContent('later_reason Counted as 100%.');
  expect(rowOf('a.bin')).toHaveTextContent('GitHub shows no diff for it, so it was not read.');
  expect(rowOf('b.ts')).toHaveTextContent('It did not fit in the batches one review may send.');
  expect(rowOf('c.ts')).toHaveTextContent('The model call that held it failed.');
  expect(within(rowOf('d.ts')).getByText('weird_source')).toHaveClass('font-mono');
  const sources: Array<[string, string]> = [
    ['team_floor', 'A path the team marked as always needing a person.'],
    ['team_file_invalid', "The repository's .visto-ai.yml cannot be used, so every file needs a person."],
    ['hidden_characters', 'A changed line holds invisible or direction-changing characters.'],
    ['not_scored', 'Not read, or left without a score.'],
    ['rule_rename', 'Renamed within its folder, so it is scored by rule.'],
    ['rule_asset', 'An image or a font, so it is scored by rule.'],
  ];
  expect(sources).toHaveLength(6);
  const more = fakeApi(withParts({ files: sources.map(([source], i) => ({ ...base, path: `s${i}.ts`, score: 1, source })) }));
  const second = open(more.api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  sources.forEach(([, text], i) => expect(rowOf(`s${i}.ts`)).toHaveTextContent(text));
  second.unmount();
});

test('findings show their severity, place, thread state and text', async () => {
  vi.useFakeTimers();
  const findings: OneReview['findings'] = [
    FINDING,
    { ...FINDING, severity: 'minor', path: 'src/cart/tax.ts', line: 18, body: 'The name `amount` no longer says which amount it is.', thread: { state: 'resolved', by: 'octo-dev' } },
    { ...FINDING, severity: 'blocker', path: 'a.ts', side: 'LEFT', line: 3, body: 'Old.', thread: { state: 'resolved', by: null } },
    { ...FINDING, path: 'b.ts', body: 'b', thread: { state: 'fixed', by: null } },
    { ...FINDING, path: 'c.ts', body: 'c', thread: { state: 'answered', by: null } },
    { ...FINDING, path: 'd.ts', body: 'd', thread: { state: 'no_thread', by: null } },
    { ...FINDING, path: 'e.ts', body: 'e', thread: { state: 'not_posted', by: null } },
    { ...FINDING, path: 'f.ts', body: 'f', kind: 'unplaced', thread: { state: 'none', by: null } },
    { ...FINDING, path: 'g.ts', body: 'g', kind: 'unchanged', thread: { state: 'none', by: null } },
    { ...FINDING, path: 'h.ts', body: 'h', kind: 'beyond_diff', thread: { state: 'none', by: null } },
  ];
  const { api } = fakeApi(withParts({ findings, counts: { blocker: 0, major: 1, minor: 1 } }));
  open(api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const card = findingsCard();
  expect(within(card).getByRole('heading', { level: 2, name: 'Findings' })).toBeInTheDocument();
  expect(within(card).getByText('1 major, 1 minor')).toBeInTheDocument();
  const first = within(card).getByText('Rounding each line before tax can move a total.').closest('div')!;
  expect(within(first).getByText('Major')).toHaveClass('bg-bad-bg', 'text-bad');
  expect(within(first).getByText('src/cart/price.ts:42')).toHaveClass('font-mono');
  expect(within(first).getByText('Thread open')).toHaveClass('bg-warn-bg', 'ml-auto');
  const minor = within(card).getByText('Minor').closest('div')!;
  expect(within(minor).getByText('Minor')).toHaveClass('bg-subtle');
  expect(within(minor).getByText('Resolved by octo-dev')).toHaveClass('bg-ok-bg');
  expect(within(card).getByText('amount')).toHaveClass('font-mono');
  const blocker = within(card).getByText('Blocker').closest('div')!;
  expect(within(blocker).getByText('Blocker')).toHaveClass('bg-bad-bg');
  expect(blocker).toHaveTextContent('a.ts:3 (old file)');
  expect(within(blocker).getByText('Resolved')).toHaveClass('bg-ok-bg');
  expect(within(card).getByText('Fixed in a later review')).toHaveClass('bg-ok-bg');
  expect(within(card).getByText('Answered in its thread')).toHaveClass('bg-info-bg');
  expect(within(card).getByText('No thread recorded')).toHaveClass('bg-subtle');
  expect(within(card).getByText('Not posted')).toHaveClass('bg-subtle');
  expect(within(card).getByText('Not on the diff')).toHaveClass('bg-subtle');
  expect(within(card).getByText('On unchanged code')).toHaveClass('bg-subtle');
  expect(within(card).getByText('Beyond the diff')).toHaveClass('bg-subtle');
  expect(within(card).getByText('Rounding each line before tax can move a total.')).toHaveClass('whitespace-pre-line');
});

test('earlier threads and dropped duplicates are counted under the findings', async () => {
  vi.useFakeTimers();
  const foot = (): HTMLElement | null => findingsCard().querySelector('.border-t');
  const first = fakeApi(withParts({ earlier: { cleared: 2, open: 1, unjudged: 0, discussed: 1 } }));
  const one = open(first.api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(foot()).toHaveTextContent('Earlier threads: 2 cleared, 1 still open');
  expect(foot()).not.toHaveTextContent('could not be judged');
  expect(within(foot()!).getByText('2 cleared').tagName).toBe('STRONG');
  expect(within(foot()!).getByText('1 finding dropped as already discussed')).toBeInTheDocument();
  one.unmount();
  const second = fakeApi(withParts({ earlier: { cleared: 0, open: 0, unjudged: 2, discussed: 3 } }));
  const two = open(second.api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(foot()).toHaveTextContent('Earlier threads: 0 cleared, 0 still open, 2 could not be judged');
  expect(within(foot()!).getByText('3 findings dropped as already discussed')).toBeInTheDocument();
  two.unmount();
  const third = fakeApi(withParts({ earlier: { cleared: 0, open: 0, unjudged: 0, discussed: 0 } }));
  open(third.api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(foot()).toBeNull();
});

test('empty and cut lists say so', async () => {
  vi.useFakeTimers();
  const empty = fakeApi(withParts({ counts: { blocker: 0, major: 0, minor: 0 } }));
  const one = open(empty.api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(within(scores()).getByText('No file was scored.')).toBeInTheDocument();
  expect(within(findingsCard()).getByText('No findings.')).toHaveClass('text-sm', 'text-muted');
  expect(within(findingsCard()).getByText('None')).toBeInTheDocument();
  one.unmount();
  const failed = fakeApi(withParts({ failure: { stage: 'model', code: null }, approval: { decision: 'failed', code: null, text: null }, posting: 'failed', threshold: null }));
  const two = open(failed.api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(within(scores()).getByText('The review did not finish, so no file was scored.')).toBeInTheDocument();
  expect(within(findingsCard()).getByText('The review did not finish.')).toBeInTheDocument();
  expect(within(scores()).queryByText(/Threshold/)).toBeNull();
  two.unmount();
  const cut = fakeApi(withParts({ files: [FILE], filesCut: 3, findings: [FINDING], findingsCut: 1 }));
  const three = open(cut.api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(within(scores()).getByText('3 more files are not shown.')).toHaveClass('px-5', 'py-3', 'text-[13px]', 'text-muted');
  expect(within(findingsCard()).getByText('1 more finding is not shown.')).toHaveClass('text-[13px]', 'text-muted');
  three.unmount();
  const one1 = fakeApi(withParts({ files: [FILE], filesCut: 1 }));
  open(one1.api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(within(scores()).getByText('1 more file is not shown.')).toBeInTheDocument();
});

const card = (name: string): HTMLElement => screen.getByRole('region', { name });
/** The `dd` that follows the `dt` of the given words, inside a card. */
const fact = (name: string, term: string): HTMLElement => {
  const dt = within(card(name)).getByText(term, { selector: 'dt' });
  return dt.nextElementSibling as HTMLElement;
};
async function shown(parts: Partial<OneReview>) {
  vi.useFakeTimers();
  const view = open(fakeApi(withParts(parts)).api);
  await act(() => vi.advanceTimersByTimeAsync(0));
  return view;
}

test('this review says who asked, the mode and files read, how it ended, how long it took and when it was posted', async () => {
  const one = await shown({ startedAt: at(-761), finishedAt: at(-720), publishedAt: at(-720) });
  const here = (term: string): HTMLElement => fact('This review', term);
  expect(here('Asked by')).toHaveTextContent('A push');
  expect(here('Mode')).toHaveTextContent('Incremental, 2 of 4 files read');
  expect(within(here('Outcome')).getByText('Published')).toHaveClass('bg-ok-bg', 'text-ok');
  expect(here('Took')).toHaveTextContent('41 s');
  expect(here('Posted')).toHaveTextContent('12 min ago');
  expect(card('This review').querySelector('dl')).toHaveClass('grid', 'text-sm');
  one.unmount();
  const asked = await shown({ askedBy: { reason: 'command', login: 'octo-dev' } });
  expect(within(fact('This review', 'Asked by')).getByText('/review')).toHaveClass('font-mono');
  expect(fact('This review', 'Asked by')).toHaveTextContent('/review by octo-dev');
  asked.unmount();
  const auto = await shown({ askedBy: { reason: 'automatic', login: null } });
  expect(fact('This review', 'Asked by')).toHaveTextContent('Automatic');
  auto.unmount();
  const hand = await shown({ askedBy: { reason: 'manual', login: null } });
  expect(fact('This review', 'Asked by')).toHaveTextContent('By hand');
  hand.unmount();
  const dry = await shown({ posting: 'dry_run', publishedAt: null });
  expect(within(fact('This review', 'Outcome')).getByText('Dry run')).toHaveClass('bg-warn-bg', 'text-warn');
  expect(fact('This review', 'Posted')).toHaveTextContent('Not posted');
  dry.unmount();
  const failed = await shown({ posting: 'failed', publishedAt: null, failure: { stage: 'model', code: 'model_timeout' } });
  const outcome = fact('This review', 'Outcome');
  expect(within(outcome).getByText('Failed')).toHaveClass('bg-bad-bg', 'text-bad');
  expect(within(outcome).getByText('model_timeout')).toHaveClass('font-mono', 'text-muted');
  failed.unmount();
  const notPosted = await shown({ posting: 'not_posted', publishedAt: null });
  expect(within(fact('This review', 'Outcome')).getByText('Not posted')).toHaveClass('bg-subtle', 'text-muted');
  notPosted.unmount();
  const nothing = await shown({ posting: 'nothing_new', publishedAt: null });
  expect(within(fact('This review', 'Outcome')).getByText('Nothing new')).toHaveClass('bg-subtle');
  nothing.unmount();
  const none = await shown({ mode: 'full', read: { files: 0, reviewed: 0 } });
  expect(fact('This review', 'Mode').textContent).toBe('Full');
  none.unmount();
  await shown({ mode: 'full', read: { files: 1, reviewed: 1 } });
  expect(fact('This review', 'Mode')).toHaveTextContent('Full, 1 of 1 file read');
});

test('usage shows the models, the calls, the tokens with their thousands and the cost', async () => {
  const one = await shown({});
  expect(within(fact('Usage', 'Model')).getByText('vendor/model-a')).toHaveClass('font-mono');
  expect(fact('Usage', 'Calls')).toHaveTextContent('3');
  expect(fact('Usage', 'Input tokens')).toHaveTextContent('38,412');
  expect(fact('Usage', 'Cached')).toHaveTextContent('21,900');
  expect(fact('Usage', 'Output tokens')).toHaveTextContent('2,118');
  expect(fact('Usage', 'Cost')).toHaveTextContent('$0.084');
  one.unmount();
  await shown({ usage: { models: [], calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 } });
  expect(fact('Usage', 'Model')).toHaveTextContent('None');
});

const HEAD2 = '9a1e5c07b3d2';
test("the approval record shows this review's code and each approval up to it with its withdrawal", async () => {
  const failedEntry = { run: 8990, ordinal: 2, head: HEAD2, state: 'withdrawal_failed' as const, code: 'github_403', retryAt: at(52), stoodAtMerge: false };
  const one = await shown({ approvals: [failedEntry] });
  const record = card('Approval record');
  expect(within(record).getByText('needs_human')).toHaveClass('bg-warn-bg', 'text-warn');
  expect(record).toHaveTextContent('Approval of review 2, head 9a1e5c07b3d2');
  expect(within(record).getByText(HEAD2)).toHaveClass('font-mono');
  expect(within(record).getByText('Withdrawal failed')).toHaveClass('bg-bad-bg', 'text-bad');
  expect(record).toHaveTextContent('Dismissing it failed (github_403). Tried again in 52 s.');
  expect(within(record).getByText('github_403')).toHaveClass('font-mono');
  one.unmount();
  const noCode = await shown({ approvals: [{ ...failedEntry, code: null, retryAt: null }] });
  expect(card('Approval record')).toHaveTextContent('Dismissing it failed.');
  expect(card('Approval record').textContent).not.toContain('()');
  expect(card('Approval record')).not.toHaveTextContent('again');
  noCode.unmount();
  const noRetry = await shown({ approvals: [{ ...failedEntry, retryAt: null }] });
  expect(card('Approval record')).toHaveTextContent('Dismissing it failed (github_403).');
  expect(card('Approval record')).not.toHaveTextContent('again');
  noRetry.unmount();
  for (const retryAt of [NOW, at(-5), new Date(Date.parse(NOW) + 400).toISOString()]) {
    const past = await shown({ approvals: [{ ...failedEntry, retryAt }] });
    expect(card('Approval record')).toHaveTextContent('Dismissing it failed (github_403). Trying again now.');
    expect(card('Approval record')).not.toHaveTextContent('Tried again');
    past.unmount();
  }
  const audit = await shown({ approval: { decision: 'not_approved', code: 'audit_sample', text: null } });
  expect(within(card('Approval record')).getByText('audit_sample')).toHaveClass('bg-accent-soft', 'text-accent-text');
  audit.unmount();
  const approved = await shown({ approval: { decision: 'approved', code: null, text: null } });
  expect(within(card('Approval record')).getByText('approved')).toHaveClass('bg-ok-bg', 'text-ok');
  approved.unmount();
  const dry = await shown({ approval: { decision: 'dry_run', code: null, text: null } });
  expect(within(card('Approval record')).getByText('Not decided in dry run')).toHaveClass('bg-subtle', 'text-muted');
  dry.unmount();
  for (const decision of ['not_decided', 'failed'] as const) {
    const quiet = await shown({ approval: { decision, code: null, text: null } });
    expect(within(card('Approval record')).getByText('None')).toHaveClass('bg-subtle');
    quiet.unmount();
  }
  const notPosted = await shown({ approval: { decision: 'not_posted', code: null, text: null } });
  expect(within(card('Approval record')).getByText('Not posted')).toHaveClass('bg-subtle');
  notPosted.unmount();
  const nothing = await shown({ approval: { decision: 'nothing_new', code: null, text: null } });
  expect(within(card('Approval record')).getByText('Nothing new')).toHaveClass('bg-subtle');
  nothing.unmount();
  const mine = await shown({
    approvals: [
      { run: 9001, ordinal: 3, head: '3f9c2e1a7b04', state: 'stands', code: null, retryAt: null, stoodAtMerge: true },
      { run: 8990, ordinal: 2, head: HEAD2, state: 'withdrawn', code: null, retryAt: null, stoodAtMerge: false },
      { run: 8977, ordinal: 1, head: 'aaaaaaaaaaaa', state: 'dismissed_on_github', code: null, retryAt: null, stoodAtMerge: false },
    ],
  });
  const rec = card('Approval record');
  const order = [...rec.querySelectorAll('[data-slot="badge"]')].map((b) => b.textContent);
  expect(order).toEqual(['needs_human', 'Stands', 'Withdrawn', 'Dismissed on GitHub']);
  expect(rec).toHaveTextContent('Approval of this review, head 3f9c2e1a7b04');
  expect(within(rec).getByText('Stands')).toHaveClass('bg-ok-bg', 'text-ok');
  expect(within(rec).getByText('Withdrawn')).toHaveClass('bg-subtle', 'text-muted');
  expect(within(rec).getByText('Dismissed on GitHub')).toHaveClass('bg-subtle', 'text-muted');
  expect(within(rec).getByText('It stood when the pull request was merged.')).toHaveClass('text-[13px]', 'text-muted');
  expect(within(rec).queryAllByText(/stood when/)).toHaveLength(1);
  mine.unmount();
});

test('each dependency of the review is shown with its status and code', async () => {
  const one = await shown({
    dependencies: [
      { kind: 'model', name: null, status: 'ok', code: null, count: null },
      { kind: 'memory', name: null, status: 'ok', code: null, count: 2 },
      { kind: 'mcp', name: 'docs', status: 'error', code: 'mcp_timeout', count: null },
      { kind: 'extension', name: 'example', status: 'ok', code: null, count: null },
      { kind: 'lessons', name: null, status: 'empty', code: 'no_lessons', count: 0 },
      { kind: 'extension', name: 'other', status: 'skipped', code: null, count: null },
    ],
  });
  const deps = card('Dependencies on this review');
  expect(deps).toHaveTextContent('Review model');
  expect(deps).toHaveTextContent('Memory, 2 records shown');
  expect(deps).toHaveTextContent('MCP server docs (mcp_timeout)');
  expect(within(deps).getByText('mcp_timeout')).toHaveClass('font-mono');
  expect(deps).toHaveTextContent('Extension example');
  expect(deps).toHaveTextContent('Lessons, 0 shown (no_lessons)');
  expect(deps.querySelectorAll('[data-slot="badge"] > .rounded-full')).toHaveLength(6);
  expect(within(deps).getAllByText('Working')[0]).toHaveClass('bg-ok-bg', 'text-ok');
  expect(within(deps).getByText('Failed')).toHaveClass('bg-bad-bg', 'text-bad');
  expect(within(deps).getByText('Nothing to add')).toHaveClass('bg-subtle', 'text-muted');
  expect(within(deps).getByText('Skipped')).toHaveClass('bg-subtle', 'text-muted');
  one.unmount();
  const single = await shown({ dependencies: [{ kind: 'memory', name: null, status: 'ok', code: null, count: 1 }] });
  expect(card('Dependencies on this review')).toHaveTextContent('Memory, 1 record shown');
  single.unmount();
  const unknown = await shown({ dependencies: [{ kind: 'memory', name: null, status: 'skipped', code: null, count: null }] });
  expect(card('Dependencies on this review').textContent).toContain('MemorySkipped');
  unknown.unmount();
  const lessons = await shown({ dependencies: [{ kind: 'lessons', name: null, status: 'ok', code: null, count: null }] });
  expect(card('Dependencies on this review').textContent).toContain('LessonsWorking');
  lessons.unmount();
  await shown({ dependencies: [] });
  expect(within(card('Dependencies on this review')).getByText('None recorded.')).toHaveClass('text-muted');
});

test('the feedback shows its counts and the reasons people gave, and says when there is none', async () => {
  const one = await shown({
    feedback: {
      helpful: 2, notHelpful: 1,
      reasons: [
        { reason: 'Repeats the earlier thread.', login: 'octo-guest' },
        { reason: 'Too noisy.', login: null },
      ],
    },
  });
  const box = card('Feedback');
  expect(within(box).getByText('2 helpful')).toHaveClass('bg-ok-bg', 'text-ok');
  expect(within(box).getByText('1 not helpful')).toHaveClass('bg-bad-bg', 'text-bad');
  const first = within(box).getByText('Repeats the earlier thread.');
  expect(first.tagName).toBe('BDI');
  const quote = first.closest('blockquote')!;
  expect(quote).toHaveTextContent('Repeats the earlier thread. octo-guest');
  expect(within(quote).getByText('octo-guest')).toHaveClass('text-muted');
  const second = within(box).getByText('Too noisy.').closest('blockquote')!;
  expect(second.querySelector('.text-muted')).toBeNull();
  expect(second.textContent).toBe('Too noisy.');
  expect(within(box).queryByText('No feedback on this review.')).toBeNull();
  one.unmount();
  await shown({});
  expect(within(card('Feedback')).getByText('No feedback on this review.')).toHaveClass('text-muted');
  expect(within(card('Feedback')).queryByText(/helpful/)).toBeNull();
});
