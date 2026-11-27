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
  startedAt: at(-641), finishedAt: at(-720), publishedAt: at(-719),
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
  expect(screen.queryByText(/ by /)).toBeNull();
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
    await screen.findByText(title);
    const element = banner();
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
