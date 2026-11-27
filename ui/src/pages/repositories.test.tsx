import { act, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { RequestFailed } from '../api.ts';
import type { Api } from '../api.ts';
import type { Activity, Me, Quality, QualityAnswer, Reviews } from '../api-types.ts';
import { App } from '../app.tsx';
import { QUALITY_RETRY_MS } from './repositories.tsx';

const NOW = '2026-03-01T10:00:00.000Z';
const ME: Me = { name: 'octo-lead', kind: 'github', role: 'admin', csrf: 'csrf-token-for-tests', mode: 'live', repositories: ['acme/shop', 'acme/web'] };
const ACTIVITY: Activity = { now: NOW, places: { reviews: 2, withdrawals: 2 }, paused: null, jobs: [], withdrawals: [] };
const REVIEWS: Reviews = { now: NOW, windowDays: 30, total: 0, reviews: [], next: null };

/** An API that answers what `over` says for a method, canned values for the layout's reads, and rejects any other; records each call. */
function fakeApi(over: Partial<Record<keyof Api, (...args: never[]) => Promise<unknown>>> = {}) {
  const calls: unknown[][] = [];
  const api = new Proxy({}, {
    get: (_target, name: string) => (...args: unknown[]) => {
      calls.push([name, ...args]);
      const given = over[name as keyof Api] as ((...a: unknown[]) => Promise<unknown>) | undefined;
      if (given) return given(...args);
      if (name === 'me') return Promise.resolve(ME);
      if (name === 'activity') return Promise.resolve(ACTIVITY);
      if (name === 'reviews') return Promise.resolve(REVIEWS);
      return Promise.reject(new RequestFailed(500, 'not_expected'));
    },
  }) as Api;
  return { api, calls };
}

const measure = (part: number, of: number) => ({ share: of === 0 ? null : Math.round((part / of) * 1000) / 1000, part, of });
const row = (threshold: number, current: boolean, blocks: [number, number], files: [number, number], benefit: [number, number], focus: [number, number]) => ({
  threshold, current, safetyBlocks: measure(...blocks), safetyFiles: measure(...files), benefit: measure(...benefit), focus: measure(...focus),
});

function quality(over: Partial<Quality> = {}): Quality {
  return {
    repository: 'acme/shop', window: 30, threshold: 70, pullRequests: 127, unreadable: 0, cut: { pulls: false, comments: false, runs: false },
    rows: [
      row(20, false, [0, 74], [0, 71], [8, 127], [5753, 9412]),
      row(70, true, [3, 74], [5, 71], [52, 127], [1694, 9412]),
      row(90, false, [16, 74], [18, 71], [99, 127], [376, 9412]),
    ],
    stepped: [], reverts: { merged: 2, approved: 0 }, audits: { drawn: 6, needed: 1 },
    feedback: { helpful: 31, notHelpful: 5, reasons: [{ reason: 'repeats a settled thread', count: 3 }, { reason: 'too long', count: 1 }] },
    ...over,
  };
}
const ready = (over: Partial<Quality> = {}): QualityAnswer => ({ now: NOW, state: 'ready', quality: quality(over) });
const LIST = { now: NOW, repositories: ['acme/shop', 'acme/web'] };

function open(api: Api, search = '') {
  window.history.replaceState(null, '', `/ui/repositories${search}`);
  return render(<App api={api} />);
}
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const classes = (element: Element | null | undefined): string[] => [...(element?.classList ?? [])].sort();
const cardOf = (heading: string): HTMLElement => screen.getByRole('heading', { level: 2, name: heading }).closest('[data-slot="card"]') as HTMLElement;

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

test('the headline cards and the table say each number with its count at the threshold, the current row marked', async () => {
  const { api } = fakeApi({ repositories: () => Promise.resolve(LIST), quality: () => Promise.resolve(ready()) });
  open(api);

  expect(await screen.findByRole('heading', { level: 1, name: 'Repositories' })).toBeInTheDocument();
  expect(screen.getByText('How well the score tells what needs a person, measured from what people did')).toBeInTheDocument();
  const headline = await screen.findByRole('region', { name: 'Headline numbers at the threshold' });
  expect(classes(headline)).toEqual(['gap-4', 'grid', 'grid-cols-[repeat(auto-fit,minmax(210px,1fr))]']);
  expect(within(headline).getByText('Safety, by block')).toBeInTheDocument();
  expect(within(headline).getByText('4%')).toBeInTheDocument();
  expect(within(headline).getByText('3 of 74 blocks that needed a person were under 70%. Lower is better.')).toBeInTheDocument();
  expect(within(headline).getByText('41%')).toBeInTheDocument();
  expect(within(headline).getByText('In 52 of 127 pull requests nothing reached 70%.')).toBeInTheDocument();
  expect(within(headline).getByText('18%')).toBeInTheDocument();
  expect(within(headline).getByText('of 9,412 changed lines in pull requests that needed a person were flagged for them.')).toBeInTheDocument();
  expect(within(headline).getByText('2')).toBeInTheDocument();
  expect(within(headline).getByText('reverts')).toBeInTheDocument();
  expect(classes(within(headline).getByText('reverts'))).toEqual(['font-medium', 'text-base', 'text-muted']);
  expect(within(headline).getByText('0 of them approved by the bot. Audit: 6 drawn, 1 needed a person.')).toBeInTheDocument();

  const table = cardOf('At each threshold');
  expect(within(table).getByText("The highlighted row is the repository's own threshold")).toBeInTheDocument();
  expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Threshold', 'Safety, by block', 'Safety, by file', 'Benefit', 'Focus']);
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows).toHaveLength(3);
  expect(within(rows[0]!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['20%', '0% 0 of 74', '0% 0 of 71', '6% 8 of 127', '61%']);
  const current = within(rows[1]!).getAllByRole('cell');
  expect(current.map((cell) => cell.textContent)).toEqual(['70%current', '4% 3 of 74', '7% 5 of 71', '41% 52 of 127', '18%']);
  expect(within(current[0]!).getByText('current')).toHaveAttribute('data-slot', 'badge');
  for (const cell of current) expect(cell).toHaveClass('bg-accent-soft');
  for (const cell of within(rows[0]!).getAllByRole('cell')) expect(cell).not.toHaveClass('bg-accent-soft');
  expect(
    within(table).getByText(
      'A block needed a person when someone other than the author commented on its lines and the lines changed in a later commit, as the pull request\'s last review saw them: the diff at the merge is not stored. Labels per block are fewer than per file, so the block numbers need more history before they mean much.',
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Window' })).toHaveValue('30');
});

test('a tab and the window choose what is read, and ?repo= opens that repository', async () => {
  const user = userEvent.setup();
  const { api, calls } = fakeApi({ repositories: () => Promise.resolve(LIST), quality: (repository: never) => Promise.resolve(ready({ repository })) });
  open(api, '?repo=ACME/Web');

  const tabs = await screen.findByRole('tablist', { name: 'Repository' });
  expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['acme/shop', 'acme/web']);
  expect(within(tabs).getByRole('tab', { name: 'acme/web' })).toHaveAttribute('aria-selected', 'true');
  expect(within(tabs).getByRole('tab', { name: 'acme/shop' })).toHaveAttribute('aria-selected', 'false');
  expect(classes(within(tabs).getByRole('tab', { name: 'acme/web' }))).toContain('border-accent');
  expect(calls.filter(([name]) => name === 'repositories')).toHaveLength(1);
  expect(calls.filter(([name]) => name === 'quality')).toEqual([['quality', 'acme/web', 30]]);

  await user.click(within(tabs).getByRole('tab', { name: 'acme/shop' }));
  expect(window.location.search).toBe('?repo=acme/shop');
  expect(within(tabs).getByRole('tab', { name: 'acme/shop' })).toHaveAttribute('aria-selected', 'true');
  expect(calls.filter(([name]) => name === 'quality')).toEqual([['quality', 'acme/web', 30], ['quality', 'acme/shop', 30]]);

  const select = screen.getByRole('combobox', { name: 'Window' });
  expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['Last 30 days', 'Last 90 days', 'Since install']);
  await user.selectOptions(select, 'Since install');
  expect(calls.filter(([name]) => name === 'quality').at(-1)).toEqual(['quality', 'acme/shop', 'all']);
  await user.selectOptions(select, 'Last 90 days');
  expect(calls.filter(([name]) => name === 'quality').at(-1)).toEqual(['quality', 'acme/shop', 90]);
});

test('a repository the list does not hold opens the first one', async () => {
  const { api, calls } = fakeApi({ repositories: () => Promise.resolve(LIST), quality: () => Promise.resolve(ready()) });
  open(api, '?repo=acme/none');
  expect(await screen.findByRole('tab', { name: 'acme/shop', selected: true })).toBeInTheDocument();
  expect(calls.filter(([name]) => name === 'quality')).toEqual([['quality', 'acme/shop', 30]]);
});

test('the blocks stepped in on and the feedback are listed, and their absence said', async () => {
  const stepped = [{ path: 'src/cart/discount.ts', number: 119, score: 55 }, { path: 'src/checkout/address.ts', number: 112, score: 48 }];
  let answer = ready({ stepped });
  const { api } = fakeApi({ repositories: () => Promise.resolve(LIST), quality: () => Promise.resolve(answer) });
  const user = userEvent.setup();
  open(api);

  const blocks = (await screen.findByRole('heading', { level: 2, name: 'Blocks a person stepped in on, under the threshold' })).closest('[data-slot="card"]') as HTMLElement;
  expect(classes(blocks)).toContain('basis-[360px]');
  expect(within(blocks).getByText('src/cart/discount.ts')).toHaveClass('font-mono');
  expect(within(blocks).getByText('#119')).toBeInTheDocument();
  expect(within(blocks).getByText('scored 55%')).toBeInTheDocument();
  expect(within(blocks).getByText('scored 48%')).toBeInTheDocument();
  const feedback = cardOf('Reviewer feedback');
  expect(within(feedback).getByText('86%')).toBeInTheDocument();
  expect(within(feedback).getByText('helpful, 31 of 36 answers')).toBeInTheDocument();
  expect(within(feedback).getByText('Reasons given when not helpful')).toBeInTheDocument();
  expect(within(feedback).getByText('Repeats a settled thread (3), too long (1)')).toBeInTheDocument();

  answer = ready({ feedback: { helpful: 1, notHelpful: 0, reasons: [] } });
  await user.selectOptions(screen.getByRole('combobox', { name: 'Window' }), 'Last 90 days');
  expect(await screen.findByText('None in this window.')).toBeInTheDocument();
  expect(screen.getByText('helpful, 1 of 1 answer')).toBeInTheDocument();
  expect(screen.getByText('None given.')).toBeInTheDocument();

  answer = ready({ feedback: { helpful: 0, notHelpful: 0, reasons: [] } });
  await user.selectOptions(screen.getByRole('combobox', { name: 'Window' }), 'Since install');
  expect(await screen.findByText('No answer in this window.')).toBeInTheDocument();
  expect(within(cardOf('Reviewer feedback')).getByText('None')).toBeInTheDocument();
});

test('the settings link is an admin\'s only', async () => {
  const user = userEvent.setup();
  const { api } = fakeApi({ repositories: () => Promise.resolve(LIST), quality: () => Promise.resolve(ready()) });
  const { unmount } = open(api);
  const link = await screen.findByRole('link', { name: 'Settings of acme/shop' });
  expect(link).toHaveAttribute('href', '/ui/settings');
  await user.click(link);
  expect(window.location.pathname).toBe('/ui/settings');
  unmount();

  const viewer = fakeApi({
    me: () => Promise.resolve({ ...ME, role: 'viewer' }), repositories: () => Promise.resolve(LIST), quality: () => Promise.resolve(ready()),
  });
  open(viewer.api);
  expect(await screen.findByRole('tab', { name: 'acme/shop' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /^Settings of/ })).toBeNull();
});

test('a repository being measured is read again every five seconds until it is ready, and a failure says so', async () => {
  vi.useFakeTimers();
  const answers: QualityAnswer[] = [{ now: NOW, state: 'computing', quality: null }, { now: NOW, state: 'computing', quality: null }, ready()];
  const { api, calls } = fakeApi({ repositories: () => Promise.resolve(LIST), quality: () => Promise.resolve(answers.shift()!) });
  const reads = (): number => calls.filter(([name]) => name === 'quality').length;
  open(api);
  await settle();

  expect(QUALITY_RETRY_MS).toBe(5000);
  expect(screen.getByText("Measuring this repository's pull requests.")).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: 'Repositories' })).toBeInTheDocument();
  expect(reads()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(4999));
  expect(reads()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(reads()).toBe(2);
  expect(screen.getByText("Measuring this repository's pull requests.")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(reads()).toBe(3);
  expect(screen.getByText('3 of 74 blocks that needed a person were under 70%. Lower is better.')).toBeInTheDocument();
  expect(screen.queryByText("Measuring this repository's pull requests.")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(reads()).toBe(3);
});

test('a failed measure and a failed read say so, with no alert, and Try again reads once more', async () => {
  const user = userEvent.setup();
  let answer: () => Promise<QualityAnswer> = () => Promise.resolve({ now: NOW, state: 'failed', quality: null });
  const { api, calls } = fakeApi({ repositories: () => Promise.resolve(LIST), quality: () => answer() });
  open(api);

  expect(await screen.findByText('The numbers could not be measured. They are measured again a minute after the failure.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  answer = () => Promise.reject(new RequestFailed(500, 'internal_error'));
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('The numbers could not be read.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  answer = () => Promise.resolve(ready());
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('3 of 74 blocks that needed a person were under 70%. Lower is better.')).toBeInTheDocument();
  expect(calls.filter(([name]) => name === 'quality')).toHaveLength(3);
});

test('a failed list of repositories says so and reads again', async () => {
  const user = userEvent.setup();
  let list: () => Promise<typeof LIST> = () => Promise.reject(new RequestFailed(500, 'internal_error'));
  const { api } = fakeApi({ repositories: () => list(), quality: () => Promise.resolve(ready()) });
  open(api);
  expect(await screen.findByText('The numbers could not be read.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: 'Repositories' })).toBeInTheDocument();
  list = () => Promise.resolve(LIST);
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('3 of 74 blocks that needed a person were under 70%. Lower is better.')).toBeInTheDocument();
});

test('too few labels, a cut, unreadable runs and no repository are said', async () => {
  let answer = ready({ rows: [row(70, true, [1, 4], [1, 4], [52, 127], [1, 10])], cut: { pulls: true, comments: false, runs: true }, unreadable: 1 });
  const { api } = fakeApi({ repositories: () => Promise.resolve(LIST), quality: () => Promise.resolve(answer) });
  const user = userEvent.setup();
  open(api);

  expect(await screen.findByText('1 of 4 blocks that needed a person were under 70%. Lower is better. Not enough labels yet to mean much.')).toBeInTheDocument();
  expect(screen.getByText('Measured on the newest 300 pull requests closed in this window.')).toBeInTheDocument();
  expect(screen.getByText('Some comments or runs were past what one measure reads, and were left out.')).toBeInTheDocument();
  expect(screen.getByText('1 pull request left out: their stored scores could not be read.')).toBeInTheDocument();

  answer = ready({ pullRequests: 0, unreadable: 3, rows: [row(70, true, [0, 0], [0, 0], [0, 0], [0, 0])] });
  await user.selectOptions(screen.getByRole('combobox', { name: 'Window' }), 'Last 90 days');
  expect(await screen.findByText('No pull request closed in this window.')).toBeInTheDocument();
  expect(screen.getByText('3 pull requests left out: their stored scores could not be read.')).toBeInTheDocument();
  expect(screen.queryByText(/newest 300/)).toBeNull();
});

test('with no repository reviewed, it says so and reads no quality', async () => {
  const { api, calls } = fakeApi({ repositories: () => Promise.resolve({ now: NOW, repositories: [] }) });
  open(api);
  expect(await screen.findByText('No repository has been reviewed yet.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: 'Repositories' })).toBeInTheDocument();
  expect(calls.filter(([name]) => name === 'quality')).toHaveLength(0);
});
