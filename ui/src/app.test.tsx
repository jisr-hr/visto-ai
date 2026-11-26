import { act, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { createApi, RequestFailed, usePoll } from './api.ts';
import type { Api } from './api.ts';
import type { Activity, Me, Reviews } from './api-types.ts';
import { App } from './app.tsx';

const NOW = '2026-03-01T10:00:00.000Z';
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
  return { api, calls };
}

/** The page at `address`, as a person opened it. */
function at(address: string): void {
  window.history.replaceState(null, '', address);
}

afterEach(() => {
  vi.useRealTimers();
  at('/');
});

test('while signed out the sign-in page shows, with the reason GitHub sent back', async () => {
  at('/ui/signin?error=not_allowed');
  const { api } = fakeApi({ me: () => Promise.reject(new RequestFailed(401, 'signed_out')) });
  const { unmount } = render(<App api={api} />);

  const link = await screen.findByRole('link', { name: 'Sign in with GitHub' });
  expect(link).toHaveAttribute('href', '/api/auth/start');
  expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  expect(screen.getByRole('alert').textContent).toBe('This GitHub account may not open this page.');
  expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  unmount();

  // A reason is read on the sign-in page's own address only.
  at('/ui/activity?error=denied');
  render(<App api={api} />);
  expect(await screen.findByRole('link', { name: 'Sign in with GitHub' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(window.location.pathname).toBe('/ui/activity');
});

test('a service that cannot be reached says so, and Try again reads again', async () => {
  at('/ui/');
  const answers: (() => Promise<Me>)[] = [
    () => Promise.reject(new RequestFailed(500, 'internal_error')),
    () => Promise.reject(new TypeError('Failed to fetch')),
    () => Promise.resolve(ME),
  ];
  const { api, calls } = fakeApi({ me: () => answers.shift()!() });
  const { container } = render(<App api={api} />);
  expect(container.innerHTML).toBe('<div aria-busy="true"></div>');

  expect(await screen.findByText('Could not reach the service.')).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Could not reach the service.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  expect(screen.queryByText('Could not reach the service.')).toBeNull();
  expect(calls.filter(([name]) => name === 'me')).toHaveLength(3);
});

test('each sidebar entry leads to its page, the coming ones say so, and an unknown path is not found', async () => {
  const { api } = fakeApi();
  const user = userEvent.setup();
  at('/ui/repositories');
  const { unmount } = render(<App api={api} />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Repositories' })).toBeInTheDocument();
  expect(screen.getByText('Coming in a later plan.')).toBeInTheDocument();
  const nav = screen.getByRole('navigation', { name: 'Main' });
  const current = (): string[] => within(nav).queryAllByRole('link', { current: 'page' }).map((link) => link.textContent ?? '');
  expect(current()).toEqual(['Repositories']);

  const pages = [
    ['Overview', '/ui/', 'Overview'],
    ['Memory', '/ui/memory', 'Memory'],
    ['Settings', '/ui/settings', 'Settings'],
    ['Repositories', '/ui/repositories', 'Repositories'],
  ] as const;
  for (const [entry, path, heading] of pages) {
    await user.click(within(nav).getByRole('link', { name: entry }));
    expect(window.location.pathname).toBe(path);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getByText('Coming in a later plan.')).toBeInTheDocument();
    expect(current()).toEqual([entry]);
  }
  await user.click(within(nav).getByRole('link', { name: 'Activity' }));
  expect(window.location.pathname).toBe('/ui/activity');
  expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeInTheDocument();
  expect(current()).toEqual(['Activity']);
  unmount();

  at('/ui/reviews/9001');
  const review = render(<App api={api} />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Review' })).toBeInTheDocument();
  expect(screen.getByText('Coming in a later plan.')).toBeInTheDocument();
  expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { current: 'page' })).toHaveTextContent('Activity');
  review.unmount();

  for (const path of ['/ui/nope', '/ui/reviews/x9', '/ui/activity/']) {
    at(path);
    const lost = render(<App api={api} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
    expect(screen.getByText('No page at this address.')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Main' })).queryAllByRole('link', { current: 'page' })).toEqual([]);
    lost.unmount();
  }

  // Signed in, the sign-in page's address leads to the overview, in place of itself in the history.
  at('/ui/signin?error=state');
  const length = window.history.length;
  render(<App api={api} />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  expect(window.location.pathname + window.location.search).toBe('/ui/');
  expect(window.history.length).toBe(length);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('any read answered 401 shows the sign-in page', async () => {
  vi.useFakeTimers();
  at('/ui/activity');
  let reads = 0;
  const { api } = fakeApi({
    activity: () => (++reads === 2 ? Promise.reject(new RequestFailed(401, 'signed_out')) : Promise.resolve(ACTIVITY)),
  });
  render(<App api={api} />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  expect(reads).toBe(1);

  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(reads).toBe(2);
  expect(screen.getByRole('link', { name: 'Sign in with GitHub' })).toHaveAttribute('href', '/api/auth/start');
  expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();

  // Signed out, nothing is read again.
  await act(() => vi.advanceTimersByTimeAsync(20000));
  expect(reads).toBe(2);
});

test('the client asks its own origin for JSON, sends the token for changes, and a refusal carries its code', async () => {
  const seen: [string, RequestInit | undefined][] = [];
  const answers: (() => Response)[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push([String(input), init]);
    const next = answers.shift();
    return next ? Promise.resolve(next()) : Promise.reject(new TypeError('Failed to fetch'));
  }) as typeof fetch;
  const api = createApi(fetchFn);
  const jsonOf = (status: number, value: unknown) => () =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const get = { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } };

  answers.push(jsonOf(200, ME), jsonOf(200, ACTIVITY), jsonOf(200, REVIEWS), jsonOf(200, REVIEWS));
  expect(await api.me()).toEqual(ME);
  expect(await api.activity()).toEqual(ACTIVITY);
  expect(await api.reviews({ repo: 'acme/shop', outcome: 'needs_person', q: '#7 tax', before: 8977 })).toEqual(REVIEWS);
  expect(await api.reviews({ repo: '', q: '' })).toEqual(REVIEWS);
  expect(seen).toEqual([
    ['/api/me', get],
    ['/api/activity', get],
    ['/api/reviews?repo=acme%2Fshop&outcome=needs_person&q=%237+tax&before=8977', get],
    ['/api/reviews', get],
  ]);

  seen.length = 0;
  answers.push(() => new Response(null, { status: 204 }));
  await expect(api.signOut(ME.csrf)).resolves.toBeUndefined();
  expect(seen).toEqual([
    ['/api/auth/signout', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'x-visto-csrf': ME.csrf } }],
  ]);

  const refused = async (answer: (() => Response) | null, status: number, code: string) => {
    if (answer) answers.push(answer);
    const error: unknown = await api.me().then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(RequestFailed);
    expect(error).toMatchObject({ status, code });
  };
  await refused(jsonOf(401, { error: 'signed_out' }), 401, 'signed_out');
  await refused(jsonOf(403, { error: 'csrf' }), 403, 'csrf');
  await refused(() => new Response('busy', { status: 503 }), 503, 'unknown');
  await refused(jsonOf(500, { error: 'Not A Code' }), 500, 'unknown');
  await refused(jsonOf(500, { code: 'internal_error' }), 500, 'unknown');
  await refused(() => new Response('<html>', { status: 200 }), 200, 'unreadable');
  await refused(null, 0, 'network');

  // With no fetch given, the page's own: blocked in the tests, so a network failure.
  const own = vi.spyOn(globalThis, 'fetch');
  await expect(createApi().me()).rejects.toMatchObject({ status: 0, code: 'network' });
  expect(own).toHaveBeenCalledTimes(1);
  expect(own.mock.calls[0]?.[0]).toBe('/api/me');
});

test('a poll keeps its last answer when a read fails and says so until one works, and a new key starts from none', async () => {
  vi.useFakeTimers();
  const results: (() => Promise<string>)[] = [];
  const reads: string[] = [];
  function Probe({ name, ms }: { name: string; ms: number }) {
    const { data, failed, error } = usePoll(() => {
      reads.push(name);
      const next = results.shift();
      return next ? next() : Promise.resolve(`${name} again`);
    }, ms, name);
    return <p>{`${data ?? 'none'} ${failed ? 'failed' : 'working'} ${error ? `${error.status} ${error.code}` : 'no error'}`}</p>;
  }
  const said = (): string => screen.getByRole('paragraph').textContent ?? '';

  results.push(() => Promise.resolve('first'));
  const { rerender } = render(<Probe name="one" ms={5000} />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(said()).toBe('first working no error');

  results.push(() => Promise.reject(new RequestFailed(500, 'internal_error')));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(said()).toBe('first failed 500 internal_error');
  results.push(() => Promise.reject(new TypeError('Failed to fetch')));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(said()).toBe('first failed no error');
  results.push(() => Promise.resolve('second'));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(said()).toBe('second working no error');

  // A new key: none until its own first answer, read at once; an answer for the old key that comes late is dropped.
  let late: (value: string) => void = () => {};
  results.push(() => new Promise<string>((resolve) => { late = resolve; }));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  results.push(() => new Promise<string>(() => {}));
  rerender(<Probe name="two" ms={0} />);
  expect(said()).toBe('none working no error');
  await act(async () => late('old'));
  expect(said()).toBe('none working no error');
  expect(reads).toEqual(['one', 'one', 'one', 'one', 'one', 'two']);

  // An ms of 0 reads once.
  rerender(<Probe name="three" ms={0} />);
  await act(() => vi.advanceTimersByTimeAsync(60000));
  expect(said()).toBe('three again working no error');
  expect(reads.filter((name) => name === 'three')).toHaveLength(1);
});

test('a read in flight is not asked again when the page is hidden and shown again', async () => {
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const turn = (next: DocumentVisibilityState): void => {
    visibility = next;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };
  let reads = 0;
  let answer: (value: string) => void = () => {};
  function Probe() {
    const { data } = usePoll(() => {
      reads += 1;
      return new Promise<string>((resolve) => { answer = resolve; });
    }, 5000, 'one');
    return <p>{data ?? 'none'}</p>;
  }

  render(<Probe />);
  expect(reads).toBe(1);
  turn('hidden');
  turn('visible');
  turn('hidden');
  turn('visible');
  expect(reads).toBe(1);
  await act(async () => answer('first'));
  expect(screen.getByRole('paragraph').textContent).toBe('first');
  expect(reads).toBe(1);
});
