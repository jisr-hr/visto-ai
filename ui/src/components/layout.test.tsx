import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { RequestFailed } from '../api.ts';
import type { Api } from '../api.ts';
import type { Activity, ActivityJob, JobStage, Me, Reviews } from '../api-types.ts';
import { App } from '../app.tsx';

const NOW = '2026-03-01T10:00:00.000Z';
const ME: Me = { name: 'octo-lead', kind: 'github', role: 'admin', csrf: 'csrf-token-for-tests', mode: 'live', repositories: ['acme/billing', 'acme/infra', 'acme/shop', 'acme/web'] };
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
    ways: () => {
      calls.push(['ways']);
      return over.ways ? over.ways() : Promise.resolve({ github: true });
    },
    accounts: () => {
      calls.push(['accounts']);
      return over.accounts ? over.accounts() : Promise.resolve({ now: NOW, accounts: [] });
    },
    passwordSignIn: (name, password) => {
      calls.push(['passwordSignIn', name, password]);
      return over.passwordSignIn ? over.passwordSignIn(name, password) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    firstPassword: (name, oneTimePassword, password) => {
      calls.push(['firstPassword', name, oneTimePassword, password]);
      return over.firstPassword ? over.firstPassword(name, oneTimePassword, password) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    changePassword: (csrf, current, password) => {
      calls.push(['changePassword', csrf, current, password]);
      return over.changePassword ? over.changePassword(csrf, current, password) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    makeAccount: (csrf, name, role) => {
      calls.push(['makeAccount', csrf, name, role]);
      return over.makeAccount ? over.makeAccount(csrf, name, role) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    setRole: (csrf, id, role) => {
      calls.push(['setRole', csrf, id, role]);
      return over.setRole ? over.setRole(csrf, id, role) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    resetPassword: (csrf, id) => {
      calls.push(['resetPassword', csrf, id]);
      return over.resetPassword ? over.resetPassword(csrf, id) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    removeAccount: (csrf, id) => {
      calls.push(['removeAccount', csrf, id]);
      return over.removeAccount ? over.removeAccount(csrf, id) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
  };
  return { api, calls };
}

function job(id: number, stage: JobStage): ActivityJob {
  return {
    job: id, repository: 'acme/shop', number: 7, title: 'Cache the tax table per region', url: 'https://github.example.test/acme/shop/pull/7',
    head: 'a41c09e2b7d3', stage, batch: null, batches: null, threadsDue: null, startedAt: null, runAt: NOW,
    askedBy: { reason: 'synchronize', login: null },
  };
}

function at(address: string): void {
  window.history.replaceState(null, '', address);
}
function classes(element: Element | null | undefined): string[] {
  return [...(element?.classList ?? [])].sort();
}
function words(...parts: string[]): string[] {
  return parts.join(' ').split(' ').filter(Boolean).sort();
}

// The classes of rules 5 and 6.
const root = 'flex min-h-screen flex-wrap bg-bg font-sans text-text';
const aside = 'flex max-w-full shrink grow basis-[232px] flex-col gap-6 border-r border-border bg-card px-3.5 py-5';
const brand = 'flex items-center gap-2.5 px-1.5';
const mark = 'shrink-0 rounded-[7px] ring-1 ring-border';
const nav = 'flex flex-col gap-0.5';
const entry = 'flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted no-underline hover:bg-subtle hover:text-text';
const entryOn = 'flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium no-underline bg-accent-soft text-accent-text hover:bg-accent-soft hover:text-accent-text';
const foot = 'mt-auto flex flex-col gap-3';
const modeCard = 'rounded-[12px] border border-border bg-card flex flex-col gap-1.5 p-3 shadow-none';
const badge = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs leading-5 font-medium';
const userRow = 'flex items-center gap-2.5 px-1.5';
const avatar = 'flex size-[30px] items-center justify-center rounded-full bg-subtle text-xs font-semibold';
const iconButton =
  'inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-text no-underline hover:bg-subtle hover:text-text disabled:cursor-default disabled:opacity-55';
const main = 'flex min-w-0 shrink grow-[999] basis-[560px] flex-col gap-6 px-8 pb-12 pt-7';
const header = 'flex flex-wrap items-end justify-between gap-4';
const heading = 'm-0 text-2xl font-semibold tracking-[-0.01em]';
const subLine = 'mt-1 mb-0 text-sm text-muted';

afterEach(() => {
  vi.useRealTimers();
  at('/');
});

test('the sidebar shows who is signed in, the mode and the running count', async () => {
  at('/ui/activity');
  const busy = { ...ACTIVITY, jobs: [job(1, 'reviewing'), job(2, 'stopped'), job(3, 'waiting'), job(4, 'queued'), job(5, 'retrying')] };
  const first = render(<App api={fakeApi({ activity: () => Promise.resolve(busy) }).api} />);

  const sidebar = await screen.findByRole('navigation', { name: 'Main' });
  expect(screen.getByText('OL')).toHaveAttribute('aria-hidden', 'true');
  expect(classes(screen.getByText('OL'))).toEqual(words(avatar));
  expect(screen.getByText('octo-lead')).toBeInTheDocument();
  expect(screen.getByText('Signed in with GitHub')).toBeInTheDocument();
  const live = screen.getByText('Live');
  expect(classes(live)).toEqual(words(badge, 'bg-ok-bg text-ok self-start'));
  expect(classes(live.firstElementChild)).toEqual(words('inline-block size-1.5 rounded-full bg-current'));
  expect(screen.getByText('Posting reviews on 4 repositories. Dry run is off.')).toBeInTheDocument();
  expect(classes(screen.getByText('Posting reviews on 4 repositories. Dry run is off.'))).toEqual(words('text-xs text-muted'));
  // Its own classes: the card's shadow is not merged away by cn, so the mode card never carries it.
  expect(classes(live.parentElement)).toEqual(words(modeCard));

  const activity = await within(sidebar).findByRole('link', { name: /^Activity\s*3$/ });
  const count = within(activity).getByText('3');
  expect(classes(count)).toEqual(words(badge, 'bg-accent-soft text-accent-text ml-auto'));
  expect(activity).toHaveAttribute('href', '/ui/activity');
  expect(activity).toHaveAttribute('aria-current', 'page');
  expect(classes(activity)).toEqual(words(entryOn));
  const overview = within(sidebar).getByRole('link', { name: 'Overview' });
  expect(overview).toHaveAttribute('href', '/ui/');
  expect(overview).not.toHaveAttribute('aria-current');
  expect(classes(overview)).toEqual(words(entry));
  expect(within(sidebar).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Overview', '/ui/'], ['Activity3', '/ui/activity'], ['Repositories', '/ui/repositories'], ['Memory', '/ui/memory'], ['Settings', '/ui/settings'],
  ]);
  for (const link of within(sidebar).getAllByRole('link')) expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

  // The frame, as drawn.
  const side = sidebar.closest('aside');
  expect(classes(side)).toEqual(words(aside));
  expect(classes(side?.parentElement)).toEqual(words(root));
  expect(classes(sidebar)).toEqual(words(nav));
  // The name over its line, beside the project icon.
  const named = screen.getByText('Visto AI').parentElement?.parentElement;
  expect(classes(named)).toEqual(words(brand));
  const icon = named?.firstElementChild;
  expect(icon?.tagName).toBe('svg');
  expect(classes(icon)).toEqual(words(mark));
  expect(icon).toHaveAttribute('aria-hidden', 'true');
  expect(icon).toHaveAttribute('viewBox', '0 0 512 512');
  expect([...(icon?.querySelectorAll('[fill]') ?? [])].map((shape) => shape.getAttribute('fill'))).toEqual(['#0e211d', '#f3f6f4', '#34d399', '#f3f6f4', '#f3f6f4']);
  expect(classes(screen.getByText('Visto AI'))).toEqual(words('text-[15px]'));
  expect(screen.getByText('Visto AI').tagName).toBe('STRONG');
  expect(classes(screen.getByText('Review service'))).toEqual(words('text-xs text-muted'));
  expect(classes(screen.getByText('octo-lead'))).toEqual(words('text-[13px] font-medium'));
  expect(classes(screen.getByText('Signed in with GitHub'))).toEqual(words('text-xs text-muted'));
  const row = screen.getByText('OL').parentElement;
  expect(classes(row)).toEqual(words(userRow));
  expect(classes(row?.parentElement)).toEqual(words(foot));
  expect(classes(screen.getByRole('button', { name: 'Switch to dark theme' }))).toEqual(words(iconButton, 'ml-auto'));
  expect(classes(screen.getByRole('button', { name: 'Sign out' }))).toEqual(words(iconButton));
  const page = screen.getByRole('main');
  expect(classes(page)).toEqual(words(main));
  const title = within(page).getByRole('heading', { level: 1, name: 'Activity' });
  expect(classes(title)).toEqual(words(heading));
  expect(classes(title.closest('header'))).toEqual(words(header));
  first.unmount();

  // The coming pages' line is the header's sub-line.
  at('/ui/memory');
  const memory = render(<App api={fakeApi().api} />);
  expect(classes(await screen.findByText('Coming in a later plan.'))).toEqual(words(subLine));
  expect(screen.getByText('Coming in a later plan.').tagName).toBe('P');
  // With no job running, the entry carries no count.
  expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Activity' }).textContent).toBe('Activity');
  memory.unmount();

  const dry: Me = { ...ME, mode: 'dry_run' };
  const second = render(<App api={fakeApi({ me: () => Promise.resolve(dry), activity: () => Promise.resolve({ ...ACTIVITY, jobs: [job(1, 'queued')] }) }).api} />);
  const dryRun = await screen.findByText('Dry run');
  expect(classes(dryRun)).toEqual(words(badge, 'bg-warn-bg text-warn self-start'));
  expect(classes(dryRun.firstElementChild)).toEqual(words('inline-block size-1.5 rounded-full bg-current'));
  expect(screen.getByText('Reviews are recorded, nothing is posted.')).toBeInTheDocument();
  expect(screen.queryByText('Live')).toBeNull();
  expect(screen.queryByText(/Posting reviews/)).toBeNull();
  // Read, but nothing runs: no count.
  await act(async () => {});
  expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Activity' }).textContent).toBe('Activity');
  second.unmount();

  render(<App api={fakeApi({ me: () => Promise.resolve({ ...ME, repositories: ['acme/shop'] }) }).api} />);
  expect(await screen.findByText('Posting reviews on 1 repository. Dry run is off.')).toBeInTheDocument();
});

test('the theme switch stores the choice and switches the class on the page', async () => {
  at('/ui/');
  render(<App api={fakeApi().api} />);
  const button = await screen.findByRole('button', { name: 'Switch to dark theme' });
  expect([...button.querySelectorAll('path')].map((path) => path.getAttribute('d'))).toEqual(['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z']);
  const user = userEvent.setup();

  await user.click(button);
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(document.documentElement.classList.contains('light')).toBe(false);
  expect(localStorage.getItem('visto-theme')).toBe('dark');
  expect(button).toHaveAccessibleName('Switch to light theme');

  await user.click(button);
  expect(document.documentElement.className).toBe('light');
  expect(localStorage.getItem('visto-theme')).toBe('light');
  expect(button).toHaveAccessibleName('Switch to dark theme');
});

test('sign out sends the token for changes and shows the sign-in page', async () => {
  at('/ui/settings');
  let tries = 0;
  const { api, calls } = fakeApi({
    signOut: () => (++tries === 1 ? Promise.reject(new RequestFailed(500, 'internal_error')) : Promise.resolve()),
  });
  render(<App api={api} />);
  const button = await screen.findByRole('button', { name: 'Sign out' });
  expect([...button.querySelectorAll('path')].map((path) => path.getAttribute('d'))).toEqual([
    'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3', 'M10 17l-5-5 5-5', 'M5 12h11',
  ]);
  expect(button.querySelector('svg')).toHaveAttribute('stroke', 'currentColor');
  expect(button.querySelector('svg')).toHaveAttribute('fill', 'none');
  const user = userEvent.setup();

  // A failure leaves the person signed in, where they were.
  await user.click(button);
  await act(async () => {});
  expect(calls.filter(([name]) => name === 'signOut')).toEqual([['signOut', 'csrf-token-for-tests']]);
  expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/ui/settings');

  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('link', { name: 'Sign in with GitHub' })).toHaveAttribute('href', '/api/auth/start');
  expect(calls.filter(([name]) => name === 'signOut')).toEqual([['signOut', 'csrf-token-for-tests'], ['signOut', 'csrf-token-for-tests']]);
  expect(window.location.pathname).toBe('/ui/signin');
  expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('the activity is read every five seconds, and not while the page is hidden', async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const turn = (next: DocumentVisibilityState): void => {
    visibility = next;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };
  at('/ui/');
  const { api, calls } = fakeApi();
  render(<App api={api} />);
  const reads = (): number => calls.filter(([name]) => name === 'activity').length;

  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(reads()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(4999));
  expect(reads()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(reads()).toBe(2);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(reads()).toBe(3);

  turn('hidden');
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(reads()).toBe(3);

  turn('visible');
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(reads()).toBe(4);
  await act(() => vi.advanceTimersByTimeAsync(4999));
  expect(reads()).toBe(4);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(reads()).toBe(5);
  expect(calls.filter(([name]) => name === 'me')).toHaveLength(1);
});

// Who is signed in, by kind and role (the password design 4.7).
const GITHUB_VIEWER: Me = { ...ME, name: 'octo-dev', role: 'viewer' };
const PASSWORD_ADMIN: Me = { ...ME, name: 'octo-admin', kind: 'password' };
const PASSWORD_VIEWER: Me = { ...ME, name: 'octo-viewer', kind: 'password', role: 'viewer' };
const FOUR = [['Overview', '/ui/'], ['Activity', '/ui/activity'], ['Repositories', '/ui/repositories'], ['Memory', '/ui/memory']];
const FIVE = [...FOUR, ['Settings', '/ui/settings']];

/** The sidebar's entries, each its text and address. */
const entries = (): (string | null)[][] =>
  within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')]);

/** A promise and the ways to settle it. */
function later<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('a viewer has no Settings entry, and an admin has it', async () => {
  // An admin's role only: a viewer, and a role this frontend does not know, have none.
  const people: [Me, string[][]][] = [
    [GITHUB_VIEWER, FOUR], [PASSWORD_VIEWER, FOUR], [{ ...ME, role: 'Admin' as unknown as Me['role'] }, FOUR], [ME, FIVE], [PASSWORD_ADMIN, FIVE],
  ];
  for (const [me, shown] of people) {
    at('/ui/activity');
    const { unmount } = render(<App api={fakeApi({ me: () => Promise.resolve(me) }).api} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Activity' })).toBeInTheDocument();
    expect(entries()).toEqual(shown);
    for (const link of within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link')) {
      expect(classes(link)).toEqual(words(link.getAttribute('href') === '/ui/activity' ? entryOn : entry));
    }
    unmount();
  }
});

test('a password account is said so and links Change password; a GitHub account does not', async () => {
  at('/ui/activity');
  const user = userEvent.setup();
  const first = render(<App api={fakeApi({ me: () => Promise.resolve(PASSWORD_VIEWER) }).api} />);
  const line = await screen.findByText('Signed in with a password');
  expect(line.tagName).toBe('SPAN');
  expect(classes(line)).toEqual(words('text-xs text-muted'));
  expect(screen.queryByText('Signed in with GitHub')).toBeNull();
  expect(classes(screen.getByText('octo-viewer'))).toEqual(words('text-[13px] font-medium'));
  // Under the line, in the name's column, outside the entries.
  const link = screen.getByRole('link', { name: 'Change password' });
  expect(link.tagName).toBe('A');
  expect(link).toHaveAttribute('href', '/ui/password');
  expect(classes(link)).toEqual(words('text-xs'));
  expect(link.parentElement).toBe(line.parentElement);
  expect([...(line.parentElement?.children ?? [])]).toEqual([screen.getByText('octo-viewer'), line, link]);
  expect(classes(line.parentElement)).toEqual(words('flex min-w-0 flex-col'));
  expect(screen.getByRole('navigation', { name: 'Main' }).contains(link)).toBe(false);

  // It leads to the page in the page, and no entry is the current one there.
  await user.click(link);
  expect(window.location.pathname).toBe('/ui/password');
  expect(screen.getByRole('heading', { level: 1, name: 'Change password' })).toBeInTheDocument();
  expect(within(screen.getByRole('navigation', { name: 'Main' })).queryAllByRole('link', { current: 'page' })).toEqual([]);
  first.unmount();

  for (const me of [ME, GITHUB_VIEWER]) {
    at('/ui/activity');
    const { unmount } = render(<App api={fakeApi({ me: () => Promise.resolve(me) }).api} />);
    const github = await screen.findByText('Signed in with GitHub');
    expect(classes(github)).toEqual(words('text-xs text-muted'));
    expect([...(github.parentElement?.children ?? [])]).toEqual([screen.getByText(me.name), github]);
    expect(screen.queryByText('Signed in with a password')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Change password' })).toBeNull();
    unmount();
  }
});

test('a viewer at /ui/settings and a GitHub account at /ui/password see Not found', async () => {
  const pages: [string, Me, string][] = [
    ['/ui/settings', GITHUB_VIEWER, 'Not found'],
    ['/ui/settings', PASSWORD_VIEWER, 'Not found'],
    ['/ui/password', ME, 'Not found'],
    ['/ui/password', GITHUB_VIEWER, 'Not found'],
    // And who may see them, does.
    ['/ui/settings', ME, 'Settings'],
    ['/ui/settings', PASSWORD_ADMIN, 'Settings'],
    ['/ui/password', PASSWORD_ADMIN, 'Change password'],
    ['/ui/password', PASSWORD_VIEWER, 'Change password'],
  ];
  for (const [path, me, heading] of pages) {
    at(path);
    const { unmount } = render(<App api={fakeApi({ me: () => Promise.resolve(me) }).api} />);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    if (heading === 'Not found') {
      expect(screen.getByText('No page at this address.')).toBeInTheDocument();
      expect(screen.queryByRole('form')).toBeNull();
    }
    if (heading === 'Settings') expect(screen.getByRole('region', { name: 'Accounts' })).toBeInTheDocument();
    expect(window.location.pathname).toBe(path);
    unmount();
  }

  // A role or a kind this frontend does not know reads as the least: neither page, no Settings entry, no Change password link.
  const unknown: [string, Me, string[][]][] = [
    ['/ui/settings', { ...ME, role: 'owner' as unknown as Me['role'] }, FOUR],
    ['/ui/password', { ...PASSWORD_ADMIN, kind: 'saml' as unknown as Me['kind'] }, FIVE],
  ];
  for (const [path, me, shown] of unknown) {
    at(path);
    const { unmount } = render(<App api={fakeApi({ me: () => Promise.resolve(me) }).api} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('No page at this address.')).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
    expect(entries()).toEqual(shown);
    expect(screen.queryByRole('link', { name: 'Change password' })).toBeNull();
    expect(screen.queryByText('Signed in with a password')).toBeNull();
    expect(window.location.pathname).toBe(path);
    unmount();
  }
});

test('a 403 forbidden makes the app read who is signed in again, and Settings goes', async () => {
  vi.useFakeTimers();
  at('/ui/activity');
  const again = later<Me>();
  const people: (() => Promise<Me>)[] = [() => Promise.resolve(ME), () => again.promise];
  // A refusal of another kind reads nothing again; a 403 forbidden does, once.
  const reads: (() => Promise<Activity>)[] = [
    () => Promise.reject(new RequestFailed(403, 'csrf')),
    () => Promise.reject(new RequestFailed(500, 'internal_error')),
    () => Promise.reject(new RequestFailed(404, 'forbidden')),
    () => Promise.reject(new RequestFailed(403, 'forbidden')),
  ];
  const { api, calls } = fakeApi({ me: () => people.shift()!(), activity: () => (reads.shift() ?? (() => Promise.resolve(ACTIVITY)))() });
  const mes = (): number => calls.filter(([name]) => name === 'me').length;
  render(<App api={api} />);

  await act(() => vi.advanceTimersByTimeAsync(0));
  const title = screen.getByRole('heading', { level: 1, name: 'Activity' });
  expect(entries()).toEqual(FIVE);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(mes()).toBe(1);
  expect(entries()).toEqual(FIVE);

  // The 403 forbidden: read again, the page kept on screen while it is read.
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(mes()).toBe(2);
  expect(title.isConnected).toBe(true);
  expect(entries()).toEqual(FIVE);
  expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();

  await act(async () => again.resolve(GITHUB_VIEWER));
  expect(entries()).toEqual(FOUR);
  expect(screen.getByText('octo-dev')).toBeInTheDocument();
  expect(screen.queryByText('octo-lead')).toBeNull();
  // The same page, never left: the very heading it showed.
  expect(title.isConnected).toBe(true);
  expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBe(title);
  expect(window.location.pathname).toBe('/ui/activity');

  // The next reads answer: nothing is read again.
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(mes()).toBe(2);
});

test('a read again after a 403 forbidden that is answered 401 signs out, one that fails keeps who is signed in, and one answered after a sign-out signs nobody in', async () => {
  vi.useFakeTimers();
  at('/ui/activity');
  const answers: (() => Promise<Me>)[] = [
    () => Promise.resolve(ME),
    () => Promise.reject(new RequestFailed(500, 'internal_error')),
    () => Promise.reject(new RequestFailed(403, 'forbidden')),
    () => Promise.reject(new RequestFailed(401, 'signed_out')),
  ];
  const { api, calls } = fakeApi({
    me: () => answers.shift()!(),
    activity: () => Promise.reject(new RequestFailed(403, 'forbidden')),
  });
  const mes = (): number => calls.filter(([name]) => name === 'me').length;
  render(<App api={api} />);

  // A read again that fails: the page and who is signed in stay.
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(async () => {});
  expect(mes()).toBe(2);
  expect(entries()).toEqual(FIVE);
  expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeInTheDocument();

  // One answered 403 forbidden is not read again in turn: it keeps who is signed in too.
  await act(() => vi.advanceTimersByTimeAsync(5000));
  await act(async () => {});
  expect(mes()).toBe(3);
  expect(entries()).toEqual(FIVE);

  // One answered 401: the sign-in page.
  await act(() => vi.advanceTimersByTimeAsync(5000));
  await act(async () => {});
  expect(mes()).toBe(4);
  expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  cleanup();

  // Signed out while it is read: its answer, when it comes, signs nobody in.
  at('/ui/activity');
  const again = later<Me>();
  const people: (() => Promise<Me>)[] = [() => Promise.resolve(ME), () => again.promise];
  let refusedOnce = false;
  const second = fakeApi({
    me: () => people.shift()!(),
    activity: () => {
      if (refusedOnce) return Promise.resolve(ACTIVITY);
      refusedOnce = true;
      return Promise.reject(new RequestFailed(403, 'forbidden'));
    },
  });
  render(<App api={second.api} />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(second.calls.filter(([name]) => name === 'me')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await act(async () => {});
  expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  await act(async () => again.resolve(ME));
  expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/ui/signin');
});
