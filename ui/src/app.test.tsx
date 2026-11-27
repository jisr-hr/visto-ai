import { act, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { createApi, RequestFailed, usePoll } from './api.ts';
import type { Api } from './api.ts';
import type { Account, Accounts, Activity, Me, OneTime, Reviews, SettingsSave, SignInStep } from './api-types.ts';
import { App } from './app.tsx';

const shown = vi.hoisted(() => ({ api: null as Api | null }));

// The Overview, as it is, keeps the API the app gave the pages: no page calls every method yet, so a test calls each of them on it.
vi.mock('./pages/overview.tsx', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pages/overview.tsx')>();
  const { useApp } = await import('./context.tsx');
  function OverviewPage() {
    shown.api = useApp().api;
    return real.OverviewPage();
  }
  return { ...real, OverviewPage };
});

const NOW = '2026-03-01T10:00:00.000Z';
const MEMORY_SUB = 'What the service learned from people, reverts and replies, told to later reviews as context';
const REPOSITORIES_SUB = 'How well the score tells what needs a person, measured from what people did';
const SAVE: SettingsSave = { version: 14, changes: [{ scope: 'global', path: 'learning', value: true }] };
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
    review: (run) => {
      calls.push(['review', run]);
      return over.review ? over.review(run) : Promise.reject(new RequestFailed(404, 'not_found'));
    },
    pullReviews: (repository, number) => {
      calls.push(['pullReviews', repository, number]);
      return over.pullReviews ? over.pullReviews(repository, number) : Promise.resolve({ now: NOW, total: 0, reviews: [] });
    },
    settings: () => {
      calls.push(['settings']);
      return over.settings ? over.settings() : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    saveSettings: (csrf, save) => {
      calls.push(['saveSettings', csrf, save]);
      return over.saveSettings ? over.saveSettings(csrf, save) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    settingChanges: (before) => {
      calls.push(['settingChanges', before]);
      return over.settingChanges ? over.settingChanges(before) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    settingsExport: () => {
      calls.push(['settingsExport']);
      return over.settingsExport ? over.settingsExport() : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    overview: (days) => {
      calls.push(['overview', days]);
      return over.overview ? over.overview(days) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    health: () => {
      calls.push(['health']);
      return over.health ? over.health() : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    repositories: () => {
      calls.push(['repositories']);
      return over.repositories ? over.repositories() : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    quality: (repository, window) => {
      calls.push(['quality', repository, window]);
      return over.quality ? over.quality(repository, window) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    memory: (query) => {
      calls.push(['memory', query]);
      return over.memory ? over.memory(query) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    switchMemory: (csrf, id, on) => {
      calls.push(['switchMemory', csrf, id, on]);
      return over.switchMemory ? over.switchMemory(csrf, id, on) : Promise.reject(new RequestFailed(500, 'not_expected'));
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

test('each sidebar entry leads to its page, and an unknown path is not found', async () => {
  const { api } = fakeApi();
  const user = userEvent.setup();
  at('/ui/repositories');
  const { unmount } = render(<App api={api} />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Repositories' })).toBeInTheDocument();
  expect(screen.getByText(REPOSITORIES_SUB)).toBeInTheDocument();
  const nav = screen.getByRole('navigation', { name: 'Main' });
  const current = (): string[] => within(nav).queryAllByRole('link', { current: 'page' }).map((link) => link.textContent ?? '');
  expect(current()).toEqual(['Repositories']);

  const pages = [
    ['Overview', '/ui/', 'Overview', 'Last 30 days'],
    ['Memory', '/ui/memory', 'Memory', MEMORY_SUB],
    ['Repositories', '/ui/repositories', 'Repositories', REPOSITORIES_SUB],
  ] as const;
  for (const [entry, path, heading, subLine] of pages) {
    await user.click(within(nav).getByRole('link', { name: entry }));
    expect(window.location.pathname).toBe(path);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getByText(subLine)).toBeInTheDocument();
    expect(current()).toEqual([entry]);
  }
  await user.click(within(nav).getByRole('link', { name: 'Activity' }));
  expect(window.location.pathname).toBe('/ui/activity');
  expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeInTheDocument();
  expect(current()).toEqual(['Activity']);
  unmount();

  at('/ui/reviews/9001');
  const review = render(<App api={api} />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Review not found' })).toBeInTheDocument();
  expect(screen.getByText('No review is stored under this number.')).toBeInTheDocument();
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
  await act(async () => {});
  expect(reads).toBe(2);
  expect(screen.getByRole('link', { name: 'Sign in with GitHub' })).toHaveAttribute('href', '/api/auth/start');
  expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();

  // Signed out, nothing is read again.
  await act(() => vi.advanceTimersByTimeAsync(20000));
  expect(reads).toBe(2);
});

test('a 401 from any method of the API the pages are given shows the sign-in page', async () => {
  // Each method of the client, called as a page would, and the call the API under it records.
  const each: [keyof Api, (api: Api) => Promise<unknown>, unknown[]][] = [
    ['me', (api) => api.me(), ['me']],
    ['activity', (api) => api.activity(), ['activity']],
    ['reviews', (api) => api.reviews({ repo: 'acme/shop' }), ['reviews', { repo: 'acme/shop' }]],
    ['signOut', (api) => api.signOut(ME.csrf), ['signOut', ME.csrf]],
    ['ways', (api) => api.ways(), ['ways']],
    ['passwordSignIn', (api) => api.passwordSignIn('octo-admin', 'a long password of mine'), ['passwordSignIn', 'octo-admin', 'a long password of mine']],
    [
      'firstPassword', (api) => api.firstPassword('octo-new', 'k7m2q9xh4wz8r3bt6pn5', 'a long password of mine'),
      ['firstPassword', 'octo-new', 'k7m2q9xh4wz8r3bt6pn5', 'a long password of mine'],
    ],
    [
      'changePassword', (api) => api.changePassword(ME.csrf, 'a long password of mine', 'another long password'),
      ['changePassword', ME.csrf, 'a long password of mine', 'another long password'],
    ],
    ['accounts', (api) => api.accounts(), ['accounts']],
    ['makeAccount', (api) => api.makeAccount(ME.csrf, 'octo-viewer', 'viewer'), ['makeAccount', ME.csrf, 'octo-viewer', 'viewer']],
    ['setRole', (api) => api.setRole(ME.csrf, 3, 'admin'), ['setRole', ME.csrf, 3, 'admin']],
    ['resetPassword', (api) => api.resetPassword(ME.csrf, 3), ['resetPassword', ME.csrf, 3]],
    ['removeAccount', (api) => api.removeAccount(ME.csrf, 3), ['removeAccount', ME.csrf, 3]],
    ['review', (api) => api.review(9001), ['review', 9001]],
    ['pullReviews', (api) => api.pullReviews('acme/shop', 128), ['pullReviews', 'acme/shop', 128]],
    ['settings', (api) => api.settings(), ['settings']],
    ['saveSettings', (api) => api.saveSettings(ME.csrf, SAVE), ['saveSettings', ME.csrf, SAVE]],
    ['settingChanges', (api) => api.settingChanges(8977), ['settingChanges', 8977]],
    ['settingsExport', (api) => api.settingsExport(), ['settingsExport']],
    ['overview', (api) => api.overview(30), ['overview', 30]],
    ['health', (api) => api.health(), ['health']],
    ['repositories', (api) => api.repositories(), ['repositories']],
    ['quality', (api) => api.quality('acme/shop', 30), ['quality', 'acme/shop', 30]],
    ['memory', (api) => api.memory({}), ['memory', {}]],
    ['switchMemory', (api) => api.switchMemory('t', 7, false), ['switchMemory', 't', 7, false]],
  ];
  // Every method there is.
  expect(each.map(([name]) => name).sort()).toEqual(Object.keys(createApi()).sort());

  for (const [name, call, recorded] of each) {
    at('/ui/');
    shown.api = null;
    // The method called answers as the fake does until the page shows, then 401; every other one as the fake does.
    let refusing = false;
    const canned = fakeApi().api[name] as (...args: unknown[]) => Promise<unknown>;
    const { api, calls } = fakeApi({
      [name]: (...args: unknown[]) => (refusing ? Promise.reject(new RequestFailed(401, 'signed_out')) : canned(...args)),
    } as Partial<Api>);
    const { unmount } = render(<App api={api} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    const pages = shown.api as Api | null;
    expect(pages).not.toBeNull();
    expect(pages).not.toBe(api);

    refusing = true;
    const before = calls.length;
    let failure: unknown = null;
    await act(async () => {
      failure = await call(pages!).then(() => null, (error: unknown) => error);
    });
    // The call went through with its arguments, its refusal is passed on, and the person is signed out here.
    expect(calls[before]).toEqual(recorded);
    expect(failure).toBeInstanceOf(RequestFailed);
    expect(failure).toMatchObject({ status: 401, code: 'signed_out' });
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    await act(async () => {});
    unmount();
  }
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

test('the new requests send JSON with their method, path and body, and a change behind a session its token', async () => {
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
  // A 204 whose body is never read: reading it at all is recorded.
  const bodiesRead: string[] = [];
  const empty = () => {
    const response = new Response(null, { status: 204 });
    for (const way of ['json', 'text', 'arrayBuffer', 'blob'] as const) {
      vi.spyOn(response, way).mockImplementation(() => {
        bodiesRead.push(way);
        return Promise.reject(new Error('The body of a 204 was read.'));
      });
    }
    return response;
  };
  const get = { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } };
  const post = (body: unknown) => ({
    method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const change = (body: unknown) => ({
    method: 'POST', credentials: 'same-origin',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-visto-csrf': ME.csrf }, body: JSON.stringify(body),
  });

  const account: Account = {
    id: 3, kind: 'password', name: 'octo-viewer', role: 'viewer', password: 'one_time', waitsUntil: null, madeAt: NOW,
    madeBy: { kind: 'password', name: 'octo-admin' }, lastSignInAt: null, you: false,
  };
  const accounts: Accounts = { now: NOW, accounts: [account] };
  const oneTime: OneTime = { account, oneTimePassword: 'k7m2q9xh4wz8r3bt6pn5', expiresAt: '2026-03-04T10:00:00.000Z' };

  answers.push(
    jsonOf(200, { github: false }), jsonOf(200, { next: 'choose_password' }), jsonOf(200, { next: 'signed_in' }), empty, jsonOf(200, accounts),
    jsonOf(201, oneTime), jsonOf(200, { account: { ...account, role: 'admin' } }), jsonOf(200, oneTime), empty,
  );
  expect(await api.ways()).toEqual({ github: false });
  expect(await api.passwordSignIn('octo-admin', 'a long password of mine')).toEqual({ next: 'choose_password' });
  expect(await api.firstPassword('octo-new', 'k7m2q9xh4wz8r3bt6pn5', 'a long password of mine')).toEqual({ next: 'signed_in' });
  await expect(api.changePassword(ME.csrf, 'a long password of mine', 'another long password')).resolves.toBeUndefined();
  expect(await api.accounts()).toEqual(accounts);
  expect(await api.makeAccount(ME.csrf, 'octo-viewer', 'viewer')).toEqual(oneTime);
  expect(await api.setRole(ME.csrf, 3, 'admin')).toEqual({ account: { ...account, role: 'admin' } });
  expect(await api.resetPassword(ME.csrf, 3)).toEqual(oneTime);
  await expect(api.removeAccount(ME.csrf, 3)).resolves.toBeUndefined();
  expect(bodiesRead).toEqual([]);
  expect(seen).toStrictEqual([
    ['/api/auth/ways', get],
    ['/api/auth/password', post({ name: 'octo-admin', password: 'a long password of mine' })],
    ['/api/auth/first-password', post({ name: 'octo-new', oneTimePassword: 'k7m2q9xh4wz8r3bt6pn5', password: 'a long password of mine' })],
    ['/api/me/password', change({ current: 'a long password of mine', password: 'another long password' })],
    ['/api/accounts', get],
    ['/api/accounts/new', change({ name: 'octo-viewer', role: 'viewer' })],
    ['/api/accounts/role', change({ id: 3, role: 'admin' })],
    ['/api/accounts/reset', change({ id: 3 })],
    ['/api/accounts/remove', change({ id: 3 })],
  ]);
  // The exact text sent, key by key in its order.
  expect(seen[2]?.[1]?.body).toBe('{"name":"octo-new","oneTimePassword":"k7m2q9xh4wz8r3bt6pn5","password":"a long password of mine"}');

  // A refusal carries its status and code; an ok answer that is not JSON is unreadable; no answer is the network.
  const refused = async (sending: () => Promise<unknown>, status: number, code: string) => {
    const error: unknown = await sending().then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(RequestFailed);
    expect(error).toMatchObject({ status, code });
  };
  answers.push(jsonOf(409, { error: 'last_admin' }));
  await refused(() => api.removeAccount(ME.csrf, 1), 409, 'last_admin');
  answers.push(jsonOf(409, { error: 'last_admin' }));
  await refused(() => api.setRole(ME.csrf, 1, 'viewer'), 409, 'last_admin');
  answers.push(jsonOf(401, { error: 'refused' }));
  await refused(() => api.passwordSignIn('octo-admin', 'another long password'), 401, 'refused');
  answers.push(jsonOf(400, { error: 'wrong_password' }));
  await refused(() => api.changePassword(ME.csrf, 'another long password', 'a long password of mine'), 400, 'wrong_password');
  answers.push(() => new Response('busy', { status: 503 }));
  await refused(() => api.firstPassword('octo-new', 'k7m2q9xh4wz8r3bt6pn5', 'a long password of mine'), 503, 'unknown');
  answers.push(() => new Response('<html>', { status: 201 }));
  await refused(() => api.makeAccount(ME.csrf, 'octo-viewer', 'viewer'), 201, 'unreadable');
  await refused(() => api.ways(), 0, 'network');
});

test('a password sign-in reads who is signed in again and opens the page, and a refusal is said on the page', async () => {
  at('/ui/signin');
  const people: (() => Promise<Me>)[] = [() => Promise.reject(new RequestFailed(401, 'signed_out')), () => Promise.resolve(ME)];
  const steps: (() => Promise<SignInStep>)[] = [() => Promise.reject(new RequestFailed(401, 'refused')), () => Promise.resolve({ next: 'signed_in' })];
  const { api, calls } = fakeApi({ me: () => people.shift()!(), passwordSignIn: () => steps.shift()!() });
  render(<App api={api} />);
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Name'), 'octo-admin');
  await user.type(screen.getByLabelText('Password'), 'another long password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The name or the password is wrong.');
  expect(calls.filter(([name]) => name === 'me')).toHaveLength(1);

  await user.type(screen.getByLabelText('Password'), 'a long password of mine');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/ui/');
  expect(calls.filter(([name]) => name === 'me')).toHaveLength(2);
  expect(calls.filter(([name]) => name === 'passwordSignIn')).toEqual([
    ['passwordSignIn', 'octo-admin', 'another long password'], ['passwordSignIn', 'octo-admin', 'a long password of mine'],
  ]);
});

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

test('a read again answered after its session signed out and another person signed in leaves that person as they are', async () => {
  const viewer: Me = { ...ME, name: 'octo-viewer', kind: 'password', role: 'viewer', csrf: 'csrf-token-of-the-viewer' };
  const four = ['Overview', 'Activity', 'Repositories', 'Memory'];
  // The admin's late answer: who the admin is, then, in the second case, a 401.
  const answers: ((late: ReturnType<typeof later<Me>>) => void)[] = [
    (late) => late.resolve(ME),
    (late) => late.reject(new RequestFailed(401, 'signed_out')),
  ];
  for (const answer of answers) {
    at('/ui/activity');
    const again = later<Me>();
    const people: (() => Promise<Me>)[] = [() => Promise.resolve(ME), () => again.promise, () => Promise.resolve(viewer)];
    let refused = false;
    const { api, calls } = fakeApi({
      me: () => people.shift()!(),
      activity: () => {
        if (refused) return Promise.resolve(ACTIVITY);
        refused = true;
        return Promise.reject(new RequestFailed(403, 'forbidden'));
      },
      passwordSignIn: () => Promise.resolve({ next: 'signed_in' }),
    });
    const entries = (): string[] =>
      within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link').map((link) => link.textContent ?? '');
    const user = userEvent.setup();
    const { unmount } = render(<App api={api} />);

    // The admin's Activity answers 403 forbidden: who is signed in is read again, and the answer waits.
    expect(await screen.findByText('octo-lead')).toBeInTheDocument();
    await act(async () => {});
    expect(calls.filter(([name]) => name === 'me')).toHaveLength(2);
    expect(entries()).toEqual([...four, 'Settings']);

    // The admin signs out, and a viewer signs in with a password.
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'octo-viewer');
    await user.type(screen.getByLabelText('Password'), 'a long password of mine');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('octo-viewer')).toBeInTheDocument();
    expect(entries()).toEqual(four);

    // The admin's answer comes: the viewer stays signed in, as themselves, with their own token.
    await act(async () => answer(again));
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Sign in' })).toBeNull();
    expect(screen.getByText('octo-viewer')).toBeInTheDocument();
    expect(screen.queryByText('octo-lead')).toBeNull();
    expect(screen.getByText('Signed in with a password')).toBeInTheDocument();
    expect(entries()).toEqual(four);
    expect(calls.filter(([name]) => name === 'me')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(calls.filter(([name]) => name === 'signOut')).toEqual([['signOut', ME.csrf], ['signOut', viewer.csrf]]);
    unmount();
  }
});

const VIEWER: Me = { ...ME, name: 'octo-viewer', kind: 'password', role: 'viewer', csrf: 'csrf-token-of-the-viewer' };
const FOUR = ['Overview', 'Activity', 'Repositories', 'Memory'];
/** The sidebar's entries, in their order. */
const entries = (): string[] => within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link').map((link) => link.textContent ?? '');

/** Signs the person shown out, then octo-viewer in with a password, and waits for the viewer's page. */
async function signOutThenViewerIn(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  await user.type(screen.getByLabelText('Name'), 'octo-viewer');
  await user.type(screen.getByLabelText('Password'), 'a long password of mine');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('octo-viewer')).toBeInTheDocument();
  expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
}

test('a page read answered 401 after its session signed out and another person signed in leaves that person as they are', async () => {
  at('/ui/');
  const late = later<Activity>();
  const people: (() => Promise<Me>)[] = [() => Promise.resolve(ME), () => Promise.resolve(VIEWER)];
  let reads = 0;
  let refusing = false;
  const { api, calls } = fakeApi({
    me: () => people.shift()!(),
    // The admin's first read of the activity waits; a later one answers, or, once refusing, is answered 401.
    activity: () => {
      reads += 1;
      if (reads === 1) return late.promise;
      return refusing ? Promise.reject(new RequestFailed(401, 'signed_out')) : Promise.resolve(ACTIVITY);
    },
    passwordSignIn: () => Promise.resolve({ next: 'signed_in' }),
  });
  const user = userEvent.setup();
  render(<App api={api} />);
  expect(await screen.findByText('octo-lead')).toBeInTheDocument();
  expect(reads).toBe(1);

  // The admin signs out while the read waits, and a viewer signs in with a password.
  await signOutThenViewerIn(user);
  expect(entries()).toEqual(FOUR);

  // The admin's read is answered 401: the viewer stays signed in, as themselves.
  await act(async () => late.reject(new RequestFailed(401, 'signed_out')));
  await act(async () => {});
  expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 1, name: 'Sign in' })).toBeNull();
  expect(screen.getByText('octo-viewer')).toBeInTheDocument();
  expect(screen.queryByText('octo-lead')).toBeNull();
  expect(entries()).toEqual(FOUR);
  expect(calls.filter(([name]) => name === 'me')).toHaveLength(2);

  // The viewer's own read answered 401 signs the viewer out.
  refusing = true;
  await act(async () => {
    await shown.api!.activity().catch(() => {});
  });
  expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
});

test('a 403 of the person signed in after another reads who they are again, and their answer applies', async () => {
  at('/ui/');
  const promoted: Me = { ...VIEWER, role: 'admin' };
  const people: (() => Promise<Me>)[] = [() => Promise.resolve(ME), () => Promise.resolve(VIEWER), () => Promise.resolve(promoted)];
  let refusing = false;
  const { api, calls } = fakeApi({
    me: () => people.shift()!(),
    activity: () => (refusing ? Promise.reject(new RequestFailed(403, 'forbidden')) : Promise.resolve(ACTIVITY)),
    passwordSignIn: () => Promise.resolve({ next: 'signed_in' }),
  });
  const user = userEvent.setup();
  render(<App api={api} />);
  expect(await screen.findByText('octo-lead')).toBeInTheDocument();
  expect(entries()).toEqual([...FOUR, 'Settings']);
  await signOutThenViewerIn(user);
  expect(entries()).toEqual(FOUR);

  // The viewer's own read answered 403 forbidden: who is signed in is read again for the viewer, and the new role shows.
  refusing = true;
  await act(async () => {
    await shown.api!.activity().catch(() => {});
  });
  await act(async () => {});
  expect(calls.filter(([name]) => name === 'me')).toHaveLength(3);
  expect(screen.getByText('octo-viewer')).toBeInTheDocument();
  expect(entries()).toEqual([...FOUR, 'Settings']);
});

test('an answer to a read asked while nobody was signed in is dropped', async () => {
  // A page read asked between a sign-out and the next sign-in, answered 401 once a viewer signed in.
  at('/ui/');
  const late = later<Activity>();
  const people: (() => Promise<Me>)[] = [() => Promise.resolve(ME), () => Promise.resolve(VIEWER)];
  // The answer of the next read of the activity, when one is set.
  let next: (() => Promise<Activity>) | null = null;
  const first = fakeApi({
    me: () => people.shift()!(),
    activity: () => (next === null ? Promise.resolve(ACTIVITY) : next()),
    passwordSignIn: () => Promise.resolve({ next: 'signed_in' }),
  });
  const user = userEvent.setup();
  const { unmount } = render(<App api={first.api} />);
  expect(await screen.findByText('octo-lead')).toBeInTheDocument();
  const pages = shown.api!;
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  next = () => late.promise;
  const read = pages.activity().catch(() => {});
  next = null;
  await user.type(screen.getByLabelText('Name'), 'octo-viewer');
  await user.type(screen.getByLabelText('Password'), 'a long password of mine');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('octo-viewer')).toBeInTheDocument();
  await act(async () => {
    late.reject(new RequestFailed(401, 'signed_out'));
    await read;
  });
  expect(screen.getByText('octo-viewer')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 1, name: 'Sign in' })).toBeNull();
  unmount();

  // A 403 answered while nobody is signed in: the read again it asks is answered once a viewer signed in, and is dropped.
  at('/ui/');
  const forbidden = later<Activity>();
  const again = later<Me>();
  const second: (() => Promise<Me>)[] = [() => Promise.resolve(ME), () => again.promise, () => Promise.resolve(VIEWER)];
  let reads = 0;
  const { api, calls } = fakeApi({
    me: () => second.shift()!(),
    activity: () => (++reads === 1 ? forbidden.promise : Promise.resolve(ACTIVITY)),
    passwordSignIn: () => Promise.resolve({ next: 'signed_in' }),
  });
  render(<App api={api} />);
  expect(await screen.findByText('octo-lead')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  await act(async () => forbidden.reject(new RequestFailed(403, 'forbidden')));
  expect(calls.filter(([name]) => name === 'me')).toHaveLength(2);
  await user.type(screen.getByLabelText('Name'), 'octo-viewer');
  await user.type(screen.getByLabelText('Password'), 'a long password of mine');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('octo-viewer')).toBeInTheDocument();
  await act(async () => again.resolve(ME));
  expect(screen.getByText('octo-viewer')).toBeInTheDocument();
  expect(screen.queryByText('octo-lead')).toBeNull();
  expect(entries()).toEqual(FOUR);
  expect(calls.filter(([name]) => name === 'me')).toHaveLength(3);
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

test('the reads of one review ask their own paths, and a refusal carries its code', async () => {
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
  const list = { now: NOW, total: 0, reviews: [] };

  answers.push(jsonOf(200, list), jsonOf(404, { error: 'not_found' }));
  expect(await api.pullReviews('acme/shop', 128)).toEqual(list);
  await expect(api.review(9001)).rejects.toEqual(new RequestFailed(404, 'not_found'));
  expect(seen).toEqual([
    ['/api/pulls/acme/shop/128/reviews', get],
    ['/api/reviews/9001', get],
  ]);
});
