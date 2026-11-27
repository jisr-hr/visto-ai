import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { RequestFailed } from '../api.ts';
import type { Api } from '../api.ts';
import type { Activity, Me, Reviews } from '../api-types.ts';
import { App } from '../app.tsx';

const NOW = '2026-03-01T10:00:00.000Z';
const ME: Me = { name: 'octo-admin', kind: 'password', role: 'admin', csrf: 'csrf-token-for-tests', mode: 'live', repositories: ['acme/shop'] };
const ACTIVITY: Activity = { now: NOW, places: { reviews: 2, withdrawals: 2 }, paused: null, jobs: [], withdrawals: [] };
const REVIEWS: Reviews = { now: NOW, windowDays: 30, total: 0, reviews: [], next: null };

const WRONG = 'The current password is wrong, or the account is waiting after five wrong tries (15 minutes).';
const LENGTH = 'A password has 12 to 128 characters.';
const NOT_THE_SAME = 'The two passwords are not the same.';
const BUSY = 'The service is busy. Try again in a moment.';
const UNREACHABLE = 'The service could not be reached. Try again in a moment.';
const FAILED = 'The password could not be changed.';
const CHANGED = 'Your password is changed. Your other sessions have ended.';
const MISSING = 'Write your current password.';

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
  };
  const sent = (name: string): unknown[][] => calls.filter(([called]) => called === name);
  return { api, calls, sent };
}

/** A promise and the ways to settle it. */
function later<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
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
function without(all: string, ...gone: string[]): string {
  return all.split(' ').filter((name) => !gone.includes(name)).join(' ');
}

const card = 'rounded-[12px] border border-border bg-card shadow-card';
const button =
  'inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-sm font-medium text-text no-underline hover:bg-subtle hover:text-text disabled:cursor-default disabled:opacity-55';
const primary = `${without(button, 'border-border', 'bg-card', 'text-text', 'hover:bg-subtle', 'hover:text-text')} border-accent bg-accent text-on-accent hover:bg-accent hover:text-on-accent`;
const heading = 'm-0 text-2xl font-semibold tracking-[-0.01em]';
const subLine = 'mt-1 mb-0 text-sm text-muted';
const field = 'min-h-9 rounded-lg border border-border bg-card px-3 text-sm text-text';
const LABELS = ['Current password', 'New password', 'New password again'] as const;

/** The values of the three fields, in their order. */
const values = (): string[] => LABELS.map((label) => (screen.getByLabelText(label) as HTMLInputElement).value);
/** Types the three, as a person would (the page's state follows each change). */
function fill(current: string, chosen: string, again: string): void {
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: chosen } });
  fireEvent.change(screen.getByLabelText('New password again'), { target: { value: again } });
}

afterEach(() => {
  at('/');
});

test('the current password and the new one twice change the password, and say so', async () => {
  at('/ui/password');
  const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((way) => vi.spyOn(console, way));
  const changed = later<void>();
  const { api, calls, sent } = fakeApi({ changePassword: () => changed.promise });
  const user = userEvent.setup();
  render(<App api={api} />);

  const title = await screen.findByRole('heading', { level: 1, name: 'Change password' });
  expect(classes(title)).toEqual(words(heading));
  const sub = screen.getByText('Your other sessions end when it changes.');
  expect(sub.tagName).toBe('P');
  expect(classes(sub)).toEqual(words(subLine));
  const page = screen.getByRole('main');
  expect(page.contains(title)).toBe(true);

  const form = screen.getByRole('form', { name: 'Change password' });
  expect(form.tagName).toBe('FORM');
  expect(classes(form)).toEqual(words('flex flex-col gap-3'));
  const box = form.closest('[data-slot="card"]');
  expect(classes(box)).toEqual(words(card, 'flex max-w-[480px] flex-col gap-3 p-6'));
  expect(page.contains(box)).toBe(true);
  expect(title.compareDocumentPosition(box!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const inputs = LABELS.map((label) => within(form).getByLabelText(label));
  for (const [index, label] of LABELS.entries()) {
    const input = inputs[index]!;
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', index === 0 ? 'current-password' : 'new-password');
    expect(classes(input)).toEqual(words(field));
    const element = within(form).getByText(label);
    expect(element.tagName).toBe('LABEL');
    expect(classes(element)).toEqual(words('text-sm font-medium'));
    // The label over its field, each field after the one before.
    expect(element.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    if (index > 0) expect(inputs[index - 1]!.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  const submit = within(form).getByRole('button', { name: 'Change password' });
  expect(submit).toHaveAttribute('type', 'submit');
  expect(submit).toBeEnabled();
  expect(classes(submit)).toEqual(words(primary, 'self-start'));
  expect(within(form).getAllByRole('button')).toEqual([submit]);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();

  await user.type(inputs[0]!, 'a long password of mine');
  await user.type(inputs[1]!, 'another long password');
  await user.type(inputs[2]!, 'another long password');
  await user.click(submit);
  // While it is sent: the button says so and is disabled, and a second submit sends nothing.
  expect(screen.getByRole('button', { name: 'Changing' })).toBeDisabled();
  expect(within(form).queryByRole('button', { name: 'Change password' })).toBeNull();
  fireEvent.submit(form);
  expect(sent('changePassword')).toEqual([['changePassword', 'csrf-token-for-tests', 'a long password of mine', 'another long password']]);

  await act(async () => changed.resolve());
  const status = screen.getByRole('status');
  expect(status.tagName).toBe('P');
  expect(status.textContent).toBe(CHANGED);
  expect(classes(status)).toEqual(words('text-sm text-ok'));
  // In the card, above the form.
  expect(status.parentElement).toBe(box);
  expect(status.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(values()).toEqual(['', '', '']);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: 'Change password' })).toBeEnabled();
  // The person stays here, signed in as they were: who is signed in is not read again.
  expect(window.location.pathname).toBe('/ui/password');
  expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  expect(calls.filter(([name]) => name === 'me')).toHaveLength(1);
  // No password or name is kept anywhere the page writes to.
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(window.location.href).toBe('http://localhost:3000/ui/password');
  for (const spy of logged) for (const args of spy.mock.calls) expect(args.map(String).join(' ')).not.toMatch(/long password|octo-admin/);
});

test('each refusal reads as pinned, and nothing is sent for two new ones that differ or a length out of bounds', async () => {
  at('/ui/password');
  const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((way) => vi.spyOn(console, way));
  const refusals: [() => Promise<void>, string][] = [
    [() => Promise.reject(new RequestFailed(400, 'wrong_password')), WRONG],
    [() => Promise.reject(new RequestFailed(400, 'password_length')), LENGTH],
    [() => Promise.reject(new RequestFailed(503, 'unknown')), BUSY],
    [() => Promise.reject(new RequestFailed(0, 'network')), UNREACHABLE],
    [() => Promise.reject(new RequestFailed(500, 'internal_error')), FAILED],
    [() => Promise.reject(new RequestFailed(403, 'csrf')), FAILED],
    [() => Promise.reject(new RequestFailed(409, 'github_account')), FAILED],
    [() => Promise.reject(new RequestFailed(400, 'bad_request')), FAILED],
    [() => Promise.reject(new RequestFailed(400, 'same_password')), FAILED],
    [() => Promise.reject(new RequestFailed(400, '__proto__')), FAILED],
    [() => Promise.reject(new TypeError('Failed to fetch')), FAILED],
  ];
  // A change first, so that each refusal is seen to take the place of what was said.
  const answers: (() => Promise<void>)[] = [() => Promise.resolve(), ...refusals.map(([refusal]) => refusal)];
  const { api, sent } = fakeApi({ changePassword: () => answers.shift()!() });
  const user = userEvent.setup();
  render(<App api={api} />);
  await screen.findByRole('heading', { level: 1, name: 'Change password' });
  const form = screen.getByRole('form', { name: 'Change password' });

  /** Sends the three, and gives the alert said, after checking it is the one line, above the form, with the fields emptied. */
  const said = async (current: string, chosen: string, again: string): Promise<string> => {
    fill(current, chosen, again);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    const alert = await screen.findByRole('alert');
    expect(alert.tagName).toBe('P');
    expect(classes(alert)).toEqual(words('text-sm text-bad'));
    expect(alert.parentElement).toBe(form.closest('[data-slot="card"]'));
    expect(alert.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(values()).toEqual(['', '', '']);
    expect(screen.getByRole('button', { name: 'Change password' })).toBeEnabled();
    expect(screen.getByRole('heading', { level: 1, name: 'Change password' })).toBeInTheDocument();
    return alert.textContent ?? '';
  };

  fill('a long password of mine', 'another long password', 'another long password');
  await user.click(screen.getByRole('button', { name: 'Change password' }));
  expect(await screen.findByRole('status')).toHaveTextContent(CHANGED);

  // Before sending: the two the same, then the length, counted as code points.
  const face = String.fromCodePoint(0x1f600);
  expect(await said('a long password of mine', 'another long password', 'another long passwrod')).toBe(NOT_THE_SAME);
  expect(await said('a long password of mine', 'eleven char', 'eleven char')).toBe(LENGTH);
  expect(await said('a long password of mine', 'short', 'shorter')).toBe(NOT_THE_SAME);
  expect(await said('a long password of mine', 'x'.repeat(129), 'x'.repeat(129))).toBe(LENGTH);
  expect(await said('a long password of mine', face.repeat(11), face.repeat(11))).toBe(LENGTH);
  expect(await said('a long password of mine', '', '')).toBe(LENGTH);
  expect(sent('changePassword')).toHaveLength(1);

  // Sent: each refusal of the service, by its code, then its status.
  const texts: string[] = [];
  for (let index = 0; index < refusals.length; index += 1) {
    texts.push(await said('another long password', index % 2 === 0 ? face.repeat(12) : 'y'.repeat(128), index % 2 === 0 ? face.repeat(12) : 'y'.repeat(128)));
  }
  expect(texts).toEqual(refusals.map(([, text]) => text));
  expect(sent('changePassword')).toEqual([
    ['changePassword', 'csrf-token-for-tests', 'a long password of mine', 'another long password'],
    ...refusals.map((_, index) => ['changePassword', 'csrf-token-for-tests', 'another long password', index % 2 === 0 ? face.repeat(12) : 'y'.repeat(128)]),
  ]);
  // As on a change: no password or name typed is kept anywhere the page writes to, whatever refused it.
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(window.location.href).toBe('http://localhost:3000/ui/password');
  const typed = ['long password', 'passwrod', 'eleven char', 'short', 'x'.repeat(129), 'y'.repeat(128), face, 'octo-admin'];
  for (const spy of logged) {
    for (const args of spy.mock.calls) for (const value of typed) expect(args.map(String).join(' ')).not.toContain(value);
  }
});

test('an empty current password is not sent, and says so', async () => {
  at('/ui/password');
  const { api, sent } = fakeApi({ changePassword: () => Promise.resolve() });
  const user = userEvent.setup();
  render(<App api={api} />);
  await screen.findByRole('heading', { level: 1, name: 'Change password' });
  const form = screen.getByRole('form', { name: 'Change password' });

  // Checked first: with it empty, two new ones that differ or a length out of bounds say the same.
  for (const [chosen, again] of [['another long password', 'another long password'], ['short', 'shorter'], ['', '']] as const) {
    fill('', chosen, again);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(MISSING);
    expect(alert.tagName).toBe('P');
    expect(classes(alert)).toEqual(words('text-sm text-bad'));
    expect(alert.parentElement).toBe(form.closest('[data-slot="card"]'));
    expect(alert.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(values()).toEqual(['', '', '']);
    expect(screen.getByRole('button', { name: 'Change password' })).toBeEnabled();
  }
  expect(sent('changePassword')).toEqual([]);

  // Written, it is sent.
  fill('a long password of mine', 'another long password', 'another long password');
  await user.click(screen.getByRole('button', { name: 'Change password' }));
  expect(await screen.findByRole('status')).toHaveTextContent(CHANGED);
  expect(sent('changePassword')).toEqual([['changePassword', 'csrf-token-for-tests', 'a long password of mine', 'another long password']]);
});

test('a change answered 401 shows the sign-in page', async () => {
  at('/ui/password');
  const { api, sent } = fakeApi({ changePassword: () => Promise.reject(new RequestFailed(401, 'signed_out')) });
  const user = userEvent.setup();
  render(<App api={api} />);
  await screen.findByRole('heading', { level: 1, name: 'Change password' });
  fill('a long password of mine', 'another long password', 'another long password');
  await user.click(screen.getByRole('button', { name: 'Change password' }));

  expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  expect(screen.queryByRole('form', { name: 'Change password' })).toBeNull();
  expect(sent('changePassword')).toHaveLength(1);
  // The sign-in page's own fields are empty: nothing typed on the other page reaches them.
  expect([...document.querySelectorAll('input')].map((input) => input.value)).toEqual(['', '']);
});
