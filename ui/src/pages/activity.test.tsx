import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { RequestFailed } from '../api.ts';
import type { Api, ReviewQuery } from '../api.ts';
import type { Activity, ActivityJob, Me, RecentReview, Reviews, Withdrawal } from '../api-types.ts';
import { App } from '../app.tsx';

const NOW = '2026-03-01T10:00:00.000Z';
/** The time `seconds` after 10:00:00 on the first of March 2026, before it when negative. */
const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

const ME: Me = { login: 'octo-lead', csrf: 'csrf-token-for-tests', mode: 'live', repositories: ['acme/billing', 'acme/infra', 'acme/shop', 'acme/web'] };
const ACTIVITY: Activity = { now: NOW, places: { reviews: 2, withdrawals: 2 }, paused: null, jobs: [], withdrawals: [] };
const REVIEWS: Reviews = { now: NOW, windowDays: 30, total: 0, reviews: [], next: null };

/** An API that answers canned values, or what `over` answers, and records every call. */
function fakeApi(over: Partial<Api> = {}) {
  const calls: unknown[][] = [];
  const api: Api = {
    me: () => {
      calls.push(['me']);
      return over.me ? over.me() : Promise.resolve(ME);
    },
    activity: () => {
      calls.push(['activity']);
      return over.activity ? over.activity() : Promise.resolve(ACTIVITY);
    },
    reviews: (query) => {
      calls.push(['reviews', query]);
      return over.reviews ? over.reviews(query) : Promise.resolve(REVIEWS);
    },
    signOut: (csrf) => {
      calls.push(['signOut', csrf]);
      return over.signOut ? over.signOut(csrf) : Promise.resolve();
    },
  };
  const queries = (): unknown[] => calls.filter(([name]) => name === 'reviews').map(([, query]) => query);
  return { api, calls, queries };
}

function job(over: Partial<ActivityJob> & Pick<ActivityJob, 'job' | 'stage'>): ActivityJob {
  return {
    repository: 'acme/shop', number: 131, title: 'Cache the tax table per region', url: 'https://github.example.test/acme/shop/pull/131',
    head: 'a41c09e2b7d3', batch: null, batches: null, threadsDue: null, startedAt: null, runAt: NOW,
    askedBy: { reason: 'synchronize', login: null }, ...over,
  };
}

function review(over: Partial<RecentReview> & Pick<RecentReview, 'run'>): RecentReview {
  return {
    repository: 'acme/shop', number: 128, title: 'Round prices before tax', outcome: 'reviewed', failureCode: null, highest: 52, threshold: 70,
    findings: { blocker: 0, major: 0, minor: 0 }, mode: 'full', dryRun: false, cost: 0.084, tookMs: 41000, at: at(-720), ...over,
  };
}

/** The Activity page opened in the app, with `api` behind it. */
function open(api: Api) {
  window.history.replaceState(null, '', '/ui/activity');
  return render(<App api={api} />);
}
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

function classes(element: Element | null | undefined): string[] {
  return [...(element?.classList ?? [])].sort();
}
function words(...parts: string[]): string[] {
  return parts.join(' ').split(' ').filter(Boolean).sort();
}
/** The row of the table that holds the link named `name`. */
function rowOf(name: string): HTMLElement {
  const row = screen.getByRole('link', { name }).closest('tr');
  if (row === null) throw new Error(`No row holds the link ${name}.`);
  return row;
}
function cellsOf(name: string): HTMLElement[] {
  return within(rowOf(name)).getAllByRole('cell');
}
const region = (name: string): HTMLElement => screen.getByRole('region', { name });

// The classes of rule 1 and of Task 9's pieces.
const card = 'rounded-[12px] border border-border bg-card shadow-card overflow-hidden';
const cardHeader = 'flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-[18px]';
const h2 = 'm-0 text-base font-semibold';
const titleBox = 'flex min-w-[220px] flex-col gap-0.5';
const titleLink = 'font-medium text-text no-underline hover:text-accent-text hover:underline';
const subLine = 'text-[13px] text-muted';
const mono = 'font-mono text-[12.5px]';
const bar = 'h-1.5 overflow-hidden rounded-full bg-subtle';
const fill = 'block h-full rounded-full bg-accent';
const score = 'inline-flex min-w-11 items-center justify-center rounded-md px-2 py-0.5 text-[13px] font-semibold';
const foot = 'flex flex-wrap items-center justify-between gap-2.5 border-t border-border px-5 py-3';
const withdrawalLine = 'flex flex-wrap items-center gap-2.5 border-t border-border px-5 py-3 text-[13px]';
const badge = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs leading-5 font-medium';
const dot = 'inline-block size-1.5 rounded-full bg-current';
const cell = 'border-b border-border px-4 py-3 align-middle';
const headCell = 'whitespace-nowrap border-b border-border px-4 py-2.5 text-left text-xs font-medium text-muted';
const field = 'min-h-9 rounded-lg border border-border bg-card px-3 text-sm text-text';
const tones = {
  ok: 'bg-ok-bg text-ok', warn: 'bg-warn-bg text-warn', bad: 'bg-bad-bg text-bad', info: 'bg-info-bg text-info', muted: 'bg-subtle text-muted',
  accent: 'bg-accent-soft text-accent-text',
} as const;

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

test('In review now shows each stage with its words, who asked, when it started and its progress', async () => {
  const jobs = [
    job({ job: 1, stage: 'reviewing', batch: 2, batches: 3, startedAt: at(-48) }),
    job({
      job: 2, stage: 'judging_threads', repository: 'acme/billing', number: 77, title: 'Retry failed webhooks with backoff',
      url: 'https://github.example.test/acme/billing/pull/77', head: '9be2041a6c18', batch: 1, batches: 2, threadsDue: 3, startedAt: at(-21),
      askedBy: { reason: 'command', login: 'octo-dev' },
    }),
    job({ job: 3, stage: 'waiting', repository: 'acme/web', number: 204, title: null, url: 'https://github.example.test/acme/web/pull/204', head: '17f0c3a9e5b2', runAt: at(102) }),
    job({ job: 4, stage: 'retrying', number: 132, title: 'Split the refund job', runAt: at(30), askedBy: { reason: 'command_retry', login: null } }),
    job({ job: 5, stage: 'queued', repository: 'acme/infra', number: 19, title: 'Rotate the build cache key', runAt: at(-5), askedBy: { reason: 'opened', login: null } }),
    job({ job: 6, stage: 'preparing', number: 133, title: 'Bump the logging library', startedAt: at(-2), askedBy: { reason: 'done', login: 'octo-dev' } }),
    job({ job: 7, stage: 'publishing', number: 134, title: 'Round prices before tax', head: null, startedAt: at(-75), askedBy: { reason: 'rerun', login: null } }),
    job({ job: 8, stage: 'stopped', number: 135, title: 'Add a label for the cart total', startedAt: at(-3600), askedBy: { reason: 'reopened', login: null } }),
    job({ job: 9, stage: 'reviewing', number: 136, title: 'Read invoices in pages of 100', batch: 3, batches: 3, startedAt: at(-30) }),
  ];
  const first = open(fakeApi({ activity: () => Promise.resolve({ ...ACTIVITY, jobs }) }).api);
  await screen.findByRole('link', { name: 'Cache the tax table per region' });
  const now = region('In review now');

  // One table, in the order the service sent.
  expect(within(now).getAllByRole('table')).toHaveLength(1);
  expect(within(now).getAllByRole('columnheader').map((head) => head.textContent)).toEqual(['Pull request', 'Stage', 'Asked by', 'Started', 'Progress']);
  expect(classes(within(now).getByRole('columnheader', { name: 'Progress' }))).toEqual(words(headCell, 'w-[200px]'));
  expect(within(now).getByRole('columnheader', { name: 'Stage' })).toHaveAttribute('scope', 'col');
  expect(within(within(now).getByRole('table')).getAllByRole('link').map((link) => link.textContent)).toEqual([
    'Cache the tax table per region', 'Retry failed webhooks with backoff', 'acme/web #204', 'Split the refund job', 'Rotate the build cache key',
    'Bump the logging library', 'Round prices before tax', 'Add a label for the cart total', 'Read invoices in pages of 100',
  ]);

  const shown = (name: string) => {
    const [, stage, asked, started, progress] = cellsOf(name);
    const img = within(progress!).getByRole('img');
    return [stage?.textContent, asked?.textContent, started?.textContent, img.getAttribute('aria-label'), (img.firstElementChild as HTMLElement).style.width];
  };
  expect(shown('Cache the tax table per region')).toEqual(['Reviewing batch 2 of 3', 'A push', '48 s ago', 'About 37 percent', '37%']);
  expect(shown('Retry failed webhooks with backoff')).toEqual(['Judging threads 3 due', '/review by octo-dev', '21 s ago', 'About 10 percent', '10%']);
  expect(shown('acme/web #204')).toEqual(['Waiting for pushes to settle 1:42 left', 'A push', 'Not yet', 'Waiting', '0%']);
  expect(shown('Split the refund job')).toEqual(['Waiting to try again 0:30 left', '/review', 'Not yet', 'Waiting', '0%']);
  expect(shown('Rotate the build cache key')).toEqual(['Queued starts when a place is free', 'Opened', 'Not yet', 'Queued', '0%']);
  expect(shown('Bump the logging library')).toEqual(['Preparing', '/done by octo-dev', '2 s ago', 'About 5 percent', '5%']);
  expect(shown('Round prices before tax')).toEqual(['Publishing', 'A re-run of the check', '1 min ago', 'About 95 percent', '95%']);
  expect(shown('Add a label for the cart total')).toEqual(['Stopped runs again at the next start', 'Reopened', '1 h ago', 'Stopped', '0%']);
  expect(shown('Read invoices in pages of 100')).toEqual(['Reviewing batch 3 of 3', 'A push', '30 s ago', 'About 63 percent', '63%']);

  // The title cell: the title linked to the pull request, over its repository, number and head.
  const link = screen.getByRole('link', { name: 'Cache the tax table per region' });
  expect(link).toHaveAttribute('href', 'https://github.example.test/acme/shop/pull/131');
  expect(link).toHaveAttribute('rel', 'noreferrer');
  expect(classes(link)).toEqual(words(titleLink));
  expect(classes(link.parentElement)).toEqual(words(titleBox));
  const sub = link.nextElementSibling;
  expect(sub?.textContent).toBe('acme/shop #131 a41c09e2b7d3');
  expect(classes(sub)).toEqual(words(subLine));
  expect(classes(within(sub as HTMLElement).getByText('a41c09e2b7d3'))).toEqual(words(mono));
  const untitled = screen.getByRole('link', { name: 'acme/web #204' });
  expect(untitled).toHaveAttribute('href', 'https://github.example.test/acme/web/pull/204');
  expect(untitled.nextElementSibling?.textContent).toBe('acme/web #204 17f0c3a9e5b2');
  // With no head, the sub-line is the repository and the number.
  expect(screen.getByRole('link', { name: 'Round prices before tax' }).nextElementSibling?.textContent).toBe('acme/shop #134');
  expect(screen.getByRole('link', { name: 'Round prices before tax' }).nextElementSibling?.querySelector('span')).toBeNull();

  // The stage's badge, its dot and its detail; the asked-by in mono; the start muted; the bar.
  const [, stage, asked, started, progress] = cellsOf('Cache the tax table per region');
  const reviewing = within(stage!).getByText('Reviewing');
  expect(classes(reviewing)).toEqual(words(badge, tones.info));
  expect(classes(reviewing.firstElementChild)).toEqual(words(dot));
  expect(classes(within(stage!).getByText('batch 2 of 3'))).toEqual(words('text-[13px] text-muted'));
  expect(classes(started)).toEqual(words(cell, 'text-muted'));
  expect(classes(asked)).toEqual(words(cell));
  const img = within(progress!).getByRole('img');
  expect(classes(img)).toEqual(words(bar));
  expect(classes(img.firstElementChild)).toEqual(words(fill));
  expect(classes(within(cellsOf('Retry failed webhooks with backoff')[2]!).getByText('/review'))).toEqual(words(mono));
  expect(classes(within(cellsOf('Bump the logging library')[2]!).getByText('/done'))).toEqual(words(mono));
  const tone = (name: string, label: string) => classes(within(cellsOf(name)[1]!).getByText(label));
  expect(tone('acme/web #204', 'Waiting for pushes to settle')).toEqual(words(badge, tones.muted));
  expect(tone('Split the refund job', 'Waiting to try again')).toEqual(words(badge, tones.muted));
  expect(tone('Rotate the build cache key', 'Queued')).toEqual(words(badge, tones.muted));
  expect(tone('Bump the logging library', 'Preparing')).toEqual(words(badge, tones.info));
  expect(tone('Retry failed webhooks with backoff', 'Judging threads')).toEqual(words(badge, tones.info));
  expect(tone('Round prices before tax', 'Publishing')).toEqual(words(badge, tones.info));
  expect(tone('Add a label for the cart total', 'Stopped')).toEqual(words(badge, tones.warn));
  const dotted = [['acme/web #204', 'Waiting for pushes to settle'], ['Add a label for the cart total', 'Stopped'], ['Bump the logging library', 'Preparing']] as const;
  for (const [name, label] of dotted) expect(classes(within(cellsOf(name)[1]!).getByText(label).firstElementChild)).toEqual(words(dot));

  // The card, its header and its table's box, as drawn.
  expect(classes(now)).toEqual(words(card));
  expect(now.tagName).toBe('SECTION');
  const heading = within(now).getByRole('heading', { level: 2, name: 'In review now' });
  expect(classes(heading)).toEqual(words(h2));
  expect(classes(heading.parentElement?.parentElement)).toEqual(words(cardHeader));
  expect(classes(heading.parentElement)).toEqual(words('flex items-center gap-2.5'));
  expect(classes(within(now).getByRole('table').parentElement)).toEqual(words('overflow-x-auto'));
  first.unmount();

  // Who asked, for each reason a job is made for.
  const reasons = [
    ['ready_for_review', null, 'Marked ready for review'],
    ['retargeted', null, 'Retargeted'],
    ['command', null, '/review'],
    ['done_retry', 'octo-dev', '/done by octo-dev'],
    ['rerun_retry', null, 'A re-run of the check'],
    ['edited', null, 'edited'],
  ] as const;
  const asking = reasons.map(([reason, login], i) =>
    job({ job: 20 + i, stage: 'queued', number: 20 + i, title: `Pull request ${20 + i}`, askedBy: { reason, login } }));
  open(fakeApi({ activity: () => Promise.resolve({ ...ACTIVITY, jobs: asking }) }).api);
  await screen.findByRole('link', { name: 'Pull request 20' });
  reasons.forEach(([, , text], i) => {
    expect(cellsOf(`Pull request ${20 + i}`)[2]?.textContent).toBe(text);
  });
  expect(classes(within(cellsOf('Pull request 25')[2]!).getByText('edited'))).toEqual(words(mono));
});

test('the title of what runs links only to an https address', async () => {
  const jobs = [
    job({ job: 1, stage: 'queued' }),
    job({ job: 2, stage: 'queued', number: 128, title: 'Round the prices', url: 'javascript:alert(1)' }),
    job({ job: 3, stage: 'queued', repository: 'acme/web', number: 204, title: 'Move the tax picker', url: 'http://github.example.test/acme/web/pull/204' }),
  ];
  open(fakeApi({ activity: () => Promise.resolve({ ...ACTIVITY, jobs }) }).api);
  const link = await screen.findByRole('link', { name: 'Cache the tax table per region' });
  expect(link).toHaveAttribute('href', 'https://github.example.test/acme/shop/pull/131');
  expect(link).toHaveAttribute('rel', 'noreferrer');
  const table = within(region('In review now')).getByRole('table');
  expect(within(table).getAllByRole('link').map((one) => one.textContent)).toEqual(['Cache the tax table per region']);
  expect(document.querySelector('[href^="javascript:"]')).toBeNull();

  // Any other address: the same text in its place, with no link.
  const unlinked = [['Round the prices', 'acme/shop #128 a41c09e2b7d3'], ['Move the tax picker', 'acme/web #204 a41c09e2b7d3']] as const;
  for (const [title, sub] of unlinked) {
    const text = within(table).getByText(title);
    expect(text.tagName).toBe('SPAN');
    expect(text.closest('tr')?.querySelector('a')).toBeNull();
    expect(classes(text)).toEqual(words('font-medium text-text'));
    expect(classes(text.parentElement)).toEqual(words(titleBox));
    expect(text.nextElementSibling?.textContent).toBe(sub);
  }
});

test('the counts say running and queued as the overview counts them, and the places', async () => {
  const jobs = [
    job({ job: 1, stage: 'reviewing', number: 1, title: 'One', batch: 1, batches: 2, startedAt: at(-10) }),
    job({ job: 2, stage: 'preparing', number: 2, title: 'Two', startedAt: at(-3) }),
    job({ job: 3, stage: 'stopped', number: 3, title: 'Three', startedAt: at(-600) }),
    job({ job: 4, stage: 'waiting', number: 4, title: 'Four', runAt: at(60) }),
    job({ job: 5, stage: 'queued', number: 5, title: 'Five', runAt: at(-1) }),
    job({ job: 6, stage: 'retrying', number: 6, title: 'Six', runAt: at(20) }),
  ];
  const first = open(fakeApi({ activity: () => Promise.resolve({ ...ACTIVITY, jobs }) }).api);
  const counts = await within(await screen.findByRole('region', { name: 'In review now' })).findByText('4 running, 2 queued');
  expect(classes(counts)).toEqual(words(badge, tones.accent));
  expect(counts.previousElementSibling).toHaveTextContent('In review now');
  expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: /^Activity\s*4$/ })).toBeInTheDocument();
  const places = screen.getByText('2 places for reviews, 2 for withdrawals');
  expect(classes(places)).toEqual(words('text-[13px] text-muted'));
  expect(places.parentElement).toBe(counts.parentElement?.parentElement);
  first.unmount();

  const one = open(fakeApi({ activity: () => Promise.resolve({ ...ACTIVITY, places: { reviews: 1, withdrawals: 2 }, jobs }) }).api);
  expect(await screen.findByText('1 place for reviews, 2 for withdrawals')).toBeInTheDocument();
  expect(cellsOf('Five')[1]?.textContent).toBe('Queued starts when a place is free');
  one.unmount();

  for (const paused of ['spend_limit', 'model_error'] as const) {
    const held = open(fakeApi({ activity: () => Promise.resolve({ ...ACTIVITY, paused, jobs }) }).api);
    await screen.findByRole('link', { name: 'Five' });
    expect(cellsOf('Five')[1]?.textContent).toBe('Queued waits while reviews are paused');
    expect(cellsOf('Six')[1]?.textContent).toBe('Waiting to try again 0:20 left');
    expect(screen.getByText('4 running, 2 queued')).toBeInTheDocument();
    held.unmount();
  }
});

test('a withdrawal waiting to try again is said with its code and when', async () => {
  const withdrawals: Withdrawal[] = [
    { repository: 'acme/shop', number: 128, code: 'github_403', runAt: at(52) },
    { repository: 'acme/billing', number: 75, code: null, runAt: at(52) },
    { repository: 'acme/web', number: 202, code: 'github_502', runAt: at(-5) },
    { repository: 'acme/infra', number: 18, code: 'network', runAt: at(150) },
  ];
  open(fakeApi({ activity: () => Promise.resolve({ ...ACTIVITY, jobs: [job({ job: 1, stage: 'queued' })], withdrawals }) }).api);
  await screen.findByRole('link', { name: 'Cache the tax table per region' });
  const now = region('In review now');
  const lines = within(now).getAllByText('Withdrawal').map((label) => label.parentElement!);
  expect(lines.map((line) => line.lastElementChild?.textContent)).toEqual([
    'acme/shop #128: dismissing an earlier approval failed (github_403), tried again in 52 s.',
    'acme/billing #75: dismissing an earlier approval failed, tried again in 52 s.',
    'acme/web #202: dismissing an earlier approval failed (github_502), tried again in 0 s.',
    'acme/infra #18: dismissing an earlier approval failed (network), tried again in 2 min 30 s.',
  ]);
  for (const line of lines) {
    expect(classes(line)).toEqual(words(withdrawalLine));
    expect(classes(line.firstElementChild)).toEqual(words(badge, tones.warn));
    expect(line.firstElementChild?.childElementCount).toBe(0);
  }
  expect(classes(within(lines[0]!).getByText('github_403'))).toEqual(words(mono));
  expect(lines[1]?.querySelector('.font-mono')).toBeNull();
  // The lines come after the table, in the card.
  const table = within(now).getByRole('table');
  expect(table.compareDocumentPosition(lines[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('nothing running reads as such, and the live badge says when updates fail', async () => {
  vi.useFakeTimers();
  const answers: (() => Promise<Activity>)[] = [
    () => Promise.resolve(ACTIVITY),
    () => Promise.reject(new RequestFailed(500, 'internal_error')),
    () => Promise.resolve(ACTIVITY),
  ];
  const first = open(fakeApi({ activity: () => answers.shift()!() }).api);
  await settle();

  // The header, as drawn: the heading, its line, the search, the repository and the badge.
  const main = screen.getByRole('main');
  const title = within(main).getByRole('heading', { level: 1, name: 'Activity' });
  expect(screen.getByText('What the service is doing now, and what it did lately')).toBeInTheDocument();
  const search = screen.getByLabelText('Search pull requests');
  expect(search).toHaveAttribute('type', 'search');
  expect(search).toHaveAttribute('placeholder', 'Search pull requests');
  expect(classes(search)).toEqual(words(field, 'w-[240px]'));
  expect(classes(screen.getByText('Search pull requests', { selector: 'label' }))).toEqual(words('sr-only'));
  const repository = screen.getByLabelText('Repository');
  expect(repository.tagName).toBe('SELECT');
  expect(classes(repository)).toEqual(words(field));
  expect(classes(screen.getByText('Repository', { selector: 'label' }))).toEqual(words('sr-only'));
  expect(within(repository).getAllByRole('option').map((option) => [option.textContent, option.getAttribute('value')])).toEqual([
    ['All repositories', ''], ['acme/billing', 'acme/billing'], ['acme/infra', 'acme/infra'], ['acme/shop', 'acme/shop'], ['acme/web', 'acme/web'],
  ]);
  const controls = search.parentElement;
  expect(classes(controls)).toEqual(words('flex flex-wrap items-center gap-2.5'));
  expect(controls?.parentElement).toBe(title.closest('header'));
  const live = screen.getByText('Updating live');
  expect(live.parentElement).toBe(controls);
  expect(classes(live)).toEqual(words(badge, tones.ok));
  expect(classes(live.firstElementChild)).toEqual(words(dot));

  // No job: one cell across the columns.
  const nothing = within(region('In review now')).getByText('Nothing is running or queued.');
  expect(nothing.tagName).toBe('TD');
  expect(nothing).toHaveAttribute('colspan', '5');
  expect(classes(nothing)).toEqual(words(cell, 'text-muted'));
  expect(within(region('In review now')).getAllByRole('cell')).toHaveLength(1);
  expect(screen.getByText('0 running, 0 queued')).toBeInTheDocument();

  // A read that fails says so until one works.
  await act(() => vi.advanceTimersByTimeAsync(5000));
  const stale = screen.getByText('Not updating');
  expect(classes(stale)).toEqual(words(badge, tones.warn));
  expect(classes(stale.firstElementChild)).toEqual(words(dot));
  expect(screen.queryByText('Updating live')).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(screen.getByText('Updating live')).toBeInTheDocument();
  expect(screen.queryByText('Not updating')).toBeNull();
  first.unmount();

  // A first read that fails: nothing to show, and not updating.
  const unread = open(fakeApi({ activity: () => Promise.reject(new RequestFailed(500, 'internal_error')) }).api);
  await settle();
  expect(screen.getByText('Not updating')).toBeInTheDocument();
  expect(screen.queryByText('Nothing is running or queued.')).toBeNull();
  expect(screen.queryByText(/running, .* queued/)).toBeNull();
  expect(screen.queryByText(/for withdrawals/)).toBeNull();
  unread.unmount();

  // The reviews' read failing says so too.
  open(fakeApi({ reviews: () => Promise.reject(new RequestFailed(500, 'internal_error')) }).api);
  await settle();
  expect(screen.getByText('Not updating')).toBeInTheDocument();
  expect(screen.getByText('Nothing is running or queued.')).toBeInTheDocument();
});

test('a filter that hides every job says so, and the counts stay over all jobs', async () => {
  const jobs = [job({ job: 1, stage: 'reviewing', batch: 1, batches: 2, startedAt: at(-10) })];
  open(fakeApi({ activity: () => Promise.resolve({ ...ACTIVITY, jobs }) }).api);
  await screen.findByRole('link', { name: 'Cache the tax table per region' });
  const now = region('In review now');
  const user = userEvent.setup();

  // The repository hides it.
  await user.selectOptions(screen.getByLabelText('Repository'), 'acme/web');
  const nothing = await within(now).findByText('Nothing running or queued matches.');
  expect(nothing.tagName).toBe('TD');
  expect(nothing).toHaveAttribute('colspan', '5');
  expect(classes(nothing)).toEqual(words(cell, 'text-muted'));
  expect(within(now).getAllByRole('cell')).toHaveLength(1);
  expect(within(now).queryByText('Nothing is running or queued.')).toBeNull();
  // The counts are over all jobs, as the sidebar's are.
  expect(within(now).getByText('1 running, 0 queued')).toBeInTheDocument();
  expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: /^Activity\s*1$/ })).toBeInTheDocument();

  // The search hides it too.
  await user.selectOptions(screen.getByLabelText('Repository'), '');
  expect(await within(now).findByRole('link', { name: 'Cache the tax table per region' })).toBeInTheDocument();
  await user.type(screen.getByLabelText('Search pull requests'), 'refund');
  expect(await within(now).findByText('Nothing running or queued matches.')).toBeInTheDocument();
  expect(within(now).queryByRole('link')).toBeNull();
  expect(within(now).getByText('1 running, 0 queued')).toBeInTheDocument();
});

test('the search takes at most 100 characters, as the server does', async () => {
  open(fakeApi().api);
  expect(await screen.findByLabelText('Search pull requests')).toHaveAttribute('maxlength', '100');
});

test('recent reviews show each outcome, score, findings, mode, cost, time taken and age', async () => {
  const reviews = [
    review({ run: 9001, outcome: 'needs_person', highest: 74, threshold: 70, findings: { blocker: 0, major: 1, minor: 0 }, mode: 'incremental' }),
    review({ run: 9000, number: 130, title: 'Add a label for the cart total', outcome: 'approved', highest: 18, cost: 0.031, tookMs: 22000, at: at(-1500) }),
    review({ run: 8999, repository: 'acme/billing', number: 76, title: 'Read invoices in pages of 100', highest: 52, findings: { blocker: 0, major: 0, minor: 2 }, dryRun: true }),
    review({ run: 8998, repository: 'acme/web', number: 203, title: null, outcome: 'audit', highest: 12 }),
    review({ run: 8997, number: 129, title: 'Bump the logging library', outcome: 'nothing_new', highest: null, mode: 'recheck', cost: 0, tookMs: 2000 }),
    review({ run: 8996, repository: 'acme/billing', number: 75, title: 'Split the refund job', outcome: 'needs_person', highest: 81, threshold: null, findings: { blocker: 1, major: 1, minor: 0 }, tookMs: 72000, at: at(-3 * 3600) }),
    review({ run: 8995, repository: 'acme/infra', number: 18, title: 'Rotate the build cache key', outcome: 'failed', failureCode: 'github_502', highest: null, cost: 0, tookMs: 6000 }),
    review({ run: 8994, number: 127, title: 'Move the date picker', outcome: 'not_posted', highest: 74, threshold: 80, findings: { blocker: 2, major: 3, minor: 4 } }),
    review({ run: 8993, number: 126, title: 'At the threshold', highest: 70, threshold: 70 }),
    review({ run: 8992, number: 125, title: 'At forty', highest: 40 }),
    review({ run: 8991, number: 124, title: 'Below forty', highest: 39 }),
  ];
  open(fakeApi({ reviews: () => Promise.resolve({ ...REVIEWS, total: 11, reviews }) }).api);
  await screen.findByRole('link', { name: 'Round prices before tax' });
  const recent = region('Recent reviews');
  expect(classes(recent)).toEqual(words(card));
  expect(recent.tagName).toBe('SECTION');
  expect(within(recent).getAllByRole('columnheader').map((head) => head.textContent)).toEqual([
    'Pull request', 'Outcome', 'Highest score', 'Findings', 'Mode', 'Cost', 'Took', 'When',
  ]);
  const heading = within(recent).getByRole('heading', { level: 2, name: 'Recent reviews' });
  expect(classes(heading)).toEqual(words(h2));
  expect(classes(heading.parentElement)).toEqual(words(cardHeader));
  expect(within(recent).getByRole('group', { name: 'Outcome' }).parentElement).toBe(heading.parentElement);
  expect(classes(within(recent).getByRole('table').parentElement)).toEqual(words('overflow-x-auto'));

  const shown = (name: string) => cellsOf(name).slice(1).map((one) => one.textContent);
  expect(shown('Round prices before tax')).toEqual(['Needs a person', '74%', '1 major', 'Incremental', '$0.084', '41 s', '12 min ago']);
  expect(shown('Add a label for the cart total')).toEqual(['Approved', '18%', 'None', 'Full', '$0.031', '22 s', '25 min ago']);
  expect(shown('Read invoices in pages of 100')).toEqual(['Reviewed', '52%', '2 minor', 'Full, dry run', '$0.084', '41 s', '12 min ago']);
  expect(shown('acme/web #203')).toEqual(['Drawn for the audit', '12%', 'None', 'Full', '$0.084', '41 s', '12 min ago']);
  expect(shown('Bump the logging library')).toEqual(['Nothing new', 'Kept', 'None', 'Re-check', '$0.000', '2 s', '12 min ago']);
  expect(shown('Split the refund job')).toEqual(['Needs a person', '81%', '1 blocker, 1 major', 'Full', '$0.084', '1 min 12 s', '3 h ago']);
  expect(shown('Rotate the build cache key')).toEqual(['Failed github_502', 'None', 'None', 'Full', '$0.000', '6 s', '12 min ago']);
  expect(shown('Move the date picker')).toEqual(['Not posted', '74%', '2 blocker, 3 major, 4 minor', 'Full', '$0.084', '41 s', '12 min ago']);

  // The outcome's badge, no dot.
  const outcome = (name: string, label: string) => {
    const shownBadge = within(cellsOf(name)[1]!).getByText(label);
    expect(shownBadge.childElementCount).toBe(0);
    return classes(shownBadge);
  };
  expect(outcome('Add a label for the cart total', 'Approved')).toEqual(words(badge, tones.ok));
  expect(outcome('Round prices before tax', 'Needs a person')).toEqual(words(badge, tones.warn));
  expect(outcome('acme/web #203', 'Drawn for the audit')).toEqual(words(badge, tones.accent));
  expect(outcome('Read invoices in pages of 100', 'Reviewed')).toEqual(words(badge, tones.muted));
  expect(outcome('Bump the logging library', 'Nothing new')).toEqual(words(badge, tones.muted));
  expect(outcome('Move the date picker', 'Not posted')).toEqual(words(badge, tones.muted));
  expect(outcome('Rotate the build cache key', 'Failed')).toEqual(words(badge, tones.bad));
  expect(classes(within(cellsOf('Rotate the build cache key')[1]!).getByText('github_502'))).toEqual(words(mono, 'text-muted'));

  // The score's colour: red at or above the run's own threshold (70 when it holds none), blue at 40 or above, green below.
  const colour = (name: string) => classes(within(cellsOf(name)[2]!).getByText(/%$/));
  expect(colour('Round prices before tax')).toEqual(words(score, tones.bad));
  expect(colour('Split the refund job')).toEqual(words(score, tones.bad));
  expect(colour('At the threshold')).toEqual(words(score, tones.bad));
  expect(colour('Move the date picker')).toEqual(words(score, tones.info));
  expect(colour('Read invoices in pages of 100')).toEqual(words(score, tones.info));
  expect(colour('At forty')).toEqual(words(score, tones.info));
  expect(colour('Below forty')).toEqual(words(score, tones.ok));
  expect(colour('Add a label for the cart total')).toEqual(words(score, tones.ok));
  // None, Kept and no findings are muted cells; the age is muted.
  expect(classes(cellsOf('Rotate the build cache key')[2])).toEqual(words(cell, 'text-muted'));
  expect(classes(cellsOf('Bump the logging library')[2])).toEqual(words(cell, 'text-muted'));
  expect(classes(cellsOf('Add a label for the cart total')[3])).toEqual(words(cell, 'text-muted'));
  expect(classes(cellsOf('Round prices before tax')[3])).toEqual(words(cell));
  expect(classes(cellsOf('Round prices before tax')[7])).toEqual(words(cell, 'text-muted'));

  // The title cell, and its link to the review's own page in the application.
  const link = screen.getByRole('link', { name: 'Round prices before tax' });
  expect(link).toHaveAttribute('href', '/ui/reviews/9001');
  expect(classes(link)).toEqual(words(titleLink));
  expect(classes(link.parentElement)).toEqual(words(titleBox));
  expect(link.nextElementSibling?.textContent).toBe('acme/shop #128');
  expect(classes(link.nextElementSibling)).toEqual(words(subLine));
  expect(screen.getByRole('link', { name: 'acme/web #203' })).toHaveAttribute('href', '/ui/reviews/8998');
  const user = userEvent.setup();
  await user.click(link);
  expect(window.location.pathname).toBe('/ui/reviews/9001');
  expect(screen.getByRole('heading', { level: 1, name: 'Review' })).toBeInTheDocument();
});

test('the outcome, the repository and the search are sent to the server, and paging goes forward and back', async () => {
  // Driven with fireEvent: Testing Library's async wrapper waits on a timer that a fake clock never runs.
  vi.useFakeTimers();
  const jobs = [
    job({ job: 1, stage: 'reviewing', number: 131, title: 'Cache the TAX table per region', batch: 1, batches: 2, startedAt: at(-10) }),
    job({ job: 2, stage: 'queued', number: 128, title: 'Round the prices' }),
    job({ job: 3, stage: 'queued', repository: 'acme/web', number: 204, title: 'Move the tax picker' }),
    job({ job: 4, stage: 'queued', number: 7, title: null }),
  ];
  const pageOf = (query: ReviewQuery): Reviews => ({
    ...REVIEWS, total: 60, reviews: [review({ run: query.before === undefined ? 9001 : query.before - 1 })],
    next: query.before === undefined ? 8977 : query.before === 8977 ? 8952 : null,
  });
  const { api, queries } = fakeApi({ activity: () => Promise.resolve({ ...ACTIVITY, jobs }), reviews: (query) => Promise.resolve(pageOf(query)) });
  open(api);
  await settle();
  const previous = () => screen.getByRole('button', { name: 'Previous' });
  const next = () => screen.getByRole('button', { name: 'Next' });
  const press = async (button: HTMLElement) => {
    fireEvent.click(button);
    await settle();
  };
  const repository = async (value: string) => {
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value } });
    await settle();
  };
  const key = (value: string) => fireEvent.change(screen.getByLabelText('Search pull requests'), { target: { value } });
  const shownJobs = () => within(within(region('In review now')).getByRole('table')).queryAllByRole('link').map((link) => link.textContent);
  expect(queries()).toEqual([{}]);
  expect(previous()).toBeDisabled();
  expect(next()).toBeEnabled();
  const outcome = within(region('Recent reviews')).getByRole('group', { name: 'Outcome' });
  expect(within(outcome).getAllByRole('button').map((button) => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([
    ['All', 'true'], ['Approved', 'false'], ['Needs a person', 'false'], ['Failed', 'false'],
  ]);

  await press(within(outcome).getByRole('button', { name: 'Approved' }));
  expect(within(outcome).getByRole('button', { name: 'Approved' })).toHaveAttribute('aria-pressed', 'true');
  await repository('acme/shop');
  expect(screen.getByLabelText('Repository')).toHaveValue('acme/shop');
  expect(queries()).toEqual([{}, { outcome: 'approved' }, { repo: 'acme/shop', outcome: 'approved' }]);
  // The repository filters what runs now, in the page.
  expect(shownJobs()).toEqual(['Cache the TAX table per region', 'Round the prices', 'acme/shop #7']);

  // The search is sent 300 ms after the last key, once.
  key('t');
  await act(() => vi.advanceTimersByTimeAsync(100));
  key('ta');
  await act(() => vi.advanceTimersByTimeAsync(100));
  key('tax');
  await act(() => vi.advanceTimersByTimeAsync(299));
  expect(queries()).toHaveLength(3);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(queries()).toEqual([{}, { outcome: 'approved' }, { repo: 'acme/shop', outcome: 'approved' }, { repo: 'acme/shop', outcome: 'approved', q: 'tax' }]);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(queries()).toHaveLength(4);
  // The search filters what runs now too: the title without letter case.
  expect(shownJobs()).toEqual(['Cache the TAX table per region']);

  // Next pushes the page's next, Previous pops it.
  const filters = { repo: 'acme/shop', outcome: 'approved', q: 'tax' };
  await press(next());
  expect(previous()).toBeEnabled();
  await press(next());
  expect(next()).toBeDisabled();
  await press(previous());
  await press(previous());
  expect(previous()).toBeDisabled();
  expect(queries().slice(4)).toEqual([{ ...filters, before: 8977 }, { ...filters, before: 8952 }, { ...filters, before: 8977 }, filters]);

  // Any filter change starts again from the first page.
  await press(next());
  await press(within(outcome).getByRole('button', { name: 'Failed' }));
  expect(previous()).toBeDisabled();
  await press(next());
  await repository('');
  expect(previous()).toBeDisabled();
  await press(next());
  key('#128');
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(previous()).toBeDisabled();
  expect(queries().slice(8)).toEqual([
    { ...filters, before: 8977 }, { repo: 'acme/shop', outcome: 'failed', q: 'tax' },
    { repo: 'acme/shop', outcome: 'failed', q: 'tax', before: 8977 }, { outcome: 'failed', q: 'tax' },
    { outcome: 'failed', q: 'tax', before: 8977 }, { outcome: 'failed', q: '#128' },
  ]);

  // The number, with or without #, in every repository.
  expect(shownJobs()).toEqual(['Round the prices']);
  key('128');
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(shownJobs()).toEqual(['Round the prices']);
  key('tax');
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(shownJobs()).toEqual(['Cache the TAX table per region', 'Move the tax picker']);
  key('');
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(shownJobs()).toEqual(['Cache the TAX table per region', 'Round the prices', 'Move the tax picker', 'acme/shop #7']);
  expect(queries().at(-1)).toEqual({ outcome: 'failed' });
  // Choosing the outcome that is on already reads nothing.
  const before = queries().length;
  await press(within(outcome).getByRole('button', { name: 'Failed' }));
  expect(queries()).toHaveLength(before);
});

test('a space typed after the search on a later page reads nothing and keeps the page', async () => {
  vi.useFakeTimers();
  const { api, queries } = fakeApi({
    reviews: (query) => Promise.resolve({ ...REVIEWS, total: 30, reviews: [review({ run: query.before === undefined ? 9001 : 8976 })], next: query.before === undefined ? 8977 : null }),
  });
  open(api);
  await settle();
  const search = () => screen.getByLabelText('Search pull requests');
  fireEvent.change(search(), { target: { value: 'tax' } });
  await act(() => vi.advanceTimersByTimeAsync(300));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await settle();
  expect(queries()).toEqual([{}, { q: 'tax' }, { q: 'tax', before: 8977 }]);
  expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();

  fireEvent.change(search(), { target: { value: 'tax ' } });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(search()).toHaveValue('tax ');
  expect(queries()).toHaveLength(3);
  expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});

test('the list says when nothing matches, and when it cannot be read', async () => {
  const empty = open(fakeApi().api);
  const none = await screen.findByText('No review in the last 30 days.');
  expect(none.tagName).toBe('TD');
  expect(none).toHaveAttribute('colspan', '8');
  expect(within(region('Recent reviews')).getAllByRole('cell')).toHaveLength(1);
  const count = screen.getByText('0 of 0 reviews in the last 30 days');
  expect(classes(count)).toEqual(words('text-[13px] text-muted'));
  expect(classes(count.parentElement)).toEqual(words(foot));
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Next' }).parentElement?.parentElement).toBe(count.parentElement);

  // With any filter: the search, the repository or the outcome.
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Search pull requests'), 'tax');
  expect(await screen.findByText('No review matches.')).toBeInTheDocument();
  await user.clear(screen.getByLabelText('Search pull requests'));
  expect(await screen.findByText('No review in the last 30 days.')).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Repository'), 'acme/web');
  expect(await screen.findByText('No review matches.')).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Repository'), '');
  expect(await screen.findByText('No review in the last 30 days.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Needs a person' }));
  expect(await screen.findByText('No review matches.')).toBeInTheDocument();
  empty.unmount();

  const failed = open(fakeApi({ reviews: () => Promise.reject(new RequestFailed(500, 'internal_error')) }).api);
  const unread = await screen.findByText('The reviews could not be read.');
  expect(unread.tagName).toBe('TD');
  expect(unread).toHaveAttribute('colspan', '8');
  expect(screen.queryByText(/reviews? in the last 30 days/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  failed.unmount();

  const many = Array.from({ length: 25 }, (_, i) => review({ run: 9001 - i, number: 100 + i, title: `Pull request ${100 + i}` }));
  const full = open(fakeApi({ reviews: () => Promise.resolve({ ...REVIEWS, total: 412, reviews: many, next: 8977 }) }).api);
  expect(await screen.findByText('25 of 412 reviews in the last 30 days')).toBeInTheDocument();
  expect(within(within(region('Recent reviews')).getByRole('table')).getAllByRole('link')).toHaveLength(25);
  expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  full.unmount();

  open(fakeApi({ reviews: () => Promise.resolve({ ...REVIEWS, total: 1, reviews: [review({ run: 9001 })] }) }).api);
  expect(await screen.findByText('1 of 1 review in the last 30 days')).toBeInTheDocument();
});

test('the first page of reviews is read again every 15 seconds, and a later page is not', async () => {
  vi.useFakeTimers();
  const { api, queries } = fakeApi({
    reviews: (query) => Promise.resolve({ ...REVIEWS, total: 30, reviews: [review({ run: query.before === undefined ? 9001 : 8976 })], next: query.before === undefined ? 8977 : null }),
  });
  open(api);
  await settle();
  expect(queries()).toEqual([{}]);
  await act(() => vi.advanceTimersByTimeAsync(14999));
  expect(queries()).toHaveLength(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(queries()).toEqual([{}, {}]);
  await act(() => vi.advanceTimersByTimeAsync(15000));
  expect(queries()).toEqual([{}, {}, {}]);

  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await settle();
  expect(queries().slice(3)).toEqual([{ before: 8977 }]);
  await act(() => vi.advanceTimersByTimeAsync(60000));
  expect(queries()).toHaveLength(4);

  // Back on the first page, it is read at once and every 15 seconds again.
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
  await settle();
  expect(queries().slice(4)).toEqual([{}]);
  await act(() => vi.advanceTimersByTimeAsync(15000));
  expect(queries().slice(4)).toEqual([{}, {}]);
});
