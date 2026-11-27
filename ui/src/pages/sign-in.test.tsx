import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { RequestFailed } from '../api.ts';
import type { Api } from '../api.ts';
import type { SignInStep, Ways } from '../api-types.ts';
import { SignIn } from './sign-in.tsx';

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
const field = 'min-h-9 rounded-lg border border-border bg-card px-3 text-sm text-text';

const REFUSED = 'The name or the password is wrong. After five wrong tries in a row, an account waits 15 minutes.';
const EXPIRED = 'This one-time password has expired. Ask an admin for a new one.';
const ALREADY_CHOSEN = 'This account has its own password already. Sign in with it.';
const LENGTH = 'A password has 12 to 128 characters.';
const SAME = 'Choose a password other than the one-time password.';
const NOT_THE_SAME = 'The two passwords are not the same.';
const BUSY = 'The service is busy. Try again in a moment.';
const UNREACHABLE = 'The service could not be reached. Try again in a moment.';
const FAILED = 'The sign-in failed.';
const OR_GITHUB = 'Or with the GitHub account this deployment lets in:';
const ONE_TIME = 'k7m2q9xh4wz8r3bt6pn5';

const notExpected = (): Promise<never> => Promise.reject(new RequestFailed(500, 'not_expected'));

/** An API whose ways say GitHub is on, or what `over` answers; a call `over` does not answer is not expected. Each is recorded. */
function fakeApi(over: Partial<Api> = {}) {
  const calls: unknown[][] = [];
  const api: Api = {
    me: () => {
      calls.push(['me']);
      return notExpected();
    },
    activity: () => {
      calls.push(['activity']);
      return notExpected();
    },
    reviews: (query) => {
      calls.push(['reviews', query]);
      return notExpected();
    },
    signOut: (csrf) => {
      calls.push(['signOut', csrf]);
      return notExpected();
    },
    ways: () => {
      calls.push(['ways']);
      return over.ways ? over.ways() : Promise.resolve({ github: true });
    },
    accounts: () => {
      calls.push(['accounts']);
      return notExpected();
    },
    passwordSignIn: (name, password) => {
      calls.push(['passwordSignIn', name, password]);
      return over.passwordSignIn ? over.passwordSignIn(name, password) : notExpected();
    },
    firstPassword: (name, oneTimePassword, password) => {
      calls.push(['firstPassword', name, oneTimePassword, password]);
      return over.firstPassword ? over.firstPassword(name, oneTimePassword, password) : notExpected();
    },
    changePassword: (csrf, current, password) => {
      calls.push(['changePassword', csrf, current, password]);
      return notExpected();
    },
    makeAccount: (csrf, name, role) => {
      calls.push(['makeAccount', csrf, name, role]);
      return notExpected();
    },
    setRole: (csrf, id, role) => {
      calls.push(['setRole', csrf, id, role]);
      return notExpected();
    },
    resetPassword: (csrf, id) => {
      calls.push(['resetPassword', csrf, id]);
      return notExpected();
    },
    removeAccount: (csrf, id) => {
      calls.push(['removeAccount', csrf, id]);
      return notExpected();
    },
    review: (run) => {
      calls.push(['review', run]);
      return over.review ? over.review(run) : Promise.reject(new RequestFailed(404, 'not_found'));
    },
    pullReviews: (repository, number) => {
      calls.push(['pullReviews', repository, number]);
      return over.pullReviews ? over.pullReviews(repository, number) : Promise.resolve({ now: '2026-03-01T10:00:00.000Z', total: 0, reviews: [] });
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

/** The values of the fields of the choice, in their order. */
const chosenValues = (): string[] => [screen.getByLabelText('New password'), screen.getByLabelText('New password again')].map((input) => (input as HTMLInputElement).value);

test('each reason GitHub sent back reads as pinned, above the form, and none or an empty one shows no alert', async () => {
  const reasons = [
    ['denied', 'GitHub did not give access. Sign in again to try once more.'],
    ['not_allowed', 'This GitHub account may not open this page.'],
    ['unverified', 'The team membership could not be read, so the sign-in was refused.'],
    ['state', 'The sign-in took too long or was started in another window. Sign in again.'],
    ['github', 'GitHub could not be reached. Sign in again in a moment.'],
    ['full', 'This deployment keeps 1,000 accounts at most. An admin can remove one.'],
    ['failed', FAILED],
    ['busy', FAILED],
    ['__proto__', FAILED],
    ['toString', FAILED],
  ] as const;
  for (const [error, text] of reasons) {
    const { api } = fakeApi();
    const { unmount } = render(<SignIn api={api} error={error} onSignedIn={() => {}} />);
    expect(await screen.findByRole('link', { name: 'Sign in with GitHub' })).toBeInTheDocument();
    // One alert at a time: getByRole refuses two.
    const alert = screen.getByRole('alert');
    expect(alert.tagName).toBe('P');
    expect(alert.textContent).toBe(text);
    expect(classes(alert)).toEqual(words('text-sm text-bad'));
    const form = screen.getByRole('form', { name: 'Sign in with a password' });
    expect(alert.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();
  }

  for (const error of [null, '']) {
    const { api } = fakeApi();
    const { unmount } = render(<SignIn api={api} error={error} onSignedIn={() => {}} />);
    expect(await screen.findByRole('link', { name: 'Sign in with GitHub' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();
  }
});

test('the sign-in page is a centred card with the brand, its heading, the password form, and the way through GitHub only when it is on', async () => {
  const ways = later<Ways>();
  const { api, sent } = fakeApi({ ways: () => ways.promise });
  const user = userEvent.setup();
  const { unmount } = render(<SignIn api={api} error={null} onSignedIn={() => {}} />);

  const title = screen.getByRole('heading', { level: 1, name: 'Sign in' });
  expect(classes(title)).toEqual(words(heading));
  const box = title.closest('[data-slot="card"]');
  expect(classes(box)).toEqual(words(card, 'flex w-full max-w-[400px] flex-col gap-4 p-8'));
  expect(classes(box?.parentElement)).toEqual(words('flex min-h-screen items-center justify-center bg-bg px-4 font-sans text-text'));
  expect(screen.getByText('Visto AI').tagName).toBe('STRONG');
  expect(screen.getByText('Review service')).toBeInTheDocument();
  const line = screen.getByText('Sign in with your name and password.');
  expect(line.tagName).toBe('P');
  expect(classes(line)).toEqual(words('text-sm text-muted'));

  const form = screen.getByRole('form', { name: 'Sign in with a password' });
  expect(form.tagName).toBe('FORM');
  expect(classes(form)).toEqual(words('flex flex-col gap-3'));
  expect(line.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const name = within(form).getByLabelText('Name') as HTMLInputElement;
  expect(name.tagName).toBe('INPUT');
  expect(name.type).toBe('text');
  expect(name).toHaveAttribute('autocomplete', 'username');
  expect(name).toHaveAttribute('autocapitalize', 'none');
  expect(name).toHaveAttribute('spellcheck', 'false');
  expect(classes(name)).toEqual(words(field));
  const password = within(form).getByLabelText('Password');
  expect(password).toHaveAttribute('type', 'password');
  expect(password).toHaveAttribute('autocomplete', 'current-password');
  expect(classes(password)).toEqual(words(field));
  for (const [label, input] of [['Name', name], ['Password', password]] as const) {
    const element = within(form).getByText(label);
    expect(element.tagName).toBe('LABEL');
    expect(classes(element)).toEqual(words('text-sm font-medium'));
    // The label over its field.
    expect(element.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  const submit = within(form).getByRole('button', { name: 'Sign in' });
  expect(submit).toHaveAttribute('type', 'submit');
  expect(submit).toBeEnabled();
  expect(classes(submit)).toEqual(words(primary, 'self-start'));
  expect(screen.getAllByRole('button')).toEqual([submit]);

  // Until the ways answer, no GitHub part.
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByText(OR_GITHUB)).toBeNull();
  await act(async () => ways.resolve({ github: true }));
  const link = screen.getByRole('link', { name: 'Sign in with GitHub' });
  expect(link.tagName).toBe('A');
  expect(link).toHaveAttribute('href', '/api/auth/start');
  expect(classes(link)).toEqual(words(button, 'self-start'));
  const or = screen.getByText(OR_GITHUB);
  expect(or.tagName).toBe('P');
  expect(classes(or)).toEqual(words('text-sm text-muted'));
  expect(form.contains(or)).toBe(false);
  expect(form.compareDocumentPosition(or) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(or.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The ways are read once, whatever is typed.
  await user.type(name, 'octo-admin');
  expect(sent('ways')).toEqual([['ways']]);
  unmount();

  // GitHub sign-in off, ways that fail, and an answer that is not a yes: no GitHub part.
  const offs: (() => Promise<Ways>)[] = [
    () => Promise.resolve({ github: false }),
    () => Promise.reject(new RequestFailed(500, 'internal_error')),
    () => Promise.reject(new RequestFailed(0, 'network')),
    () => Promise.resolve({ github: 'true' } as unknown as Ways),
    () => Promise.resolve(null as unknown as Ways),
  ];
  for (const off of offs) {
    const fake = fakeApi({ ways: off });
    const shown = render(<SignIn api={fake.api} error={null} onSignedIn={() => {}} />);
    await act(async () => {});
    expect(screen.getByRole('form', { name: 'Sign in with a password' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(OR_GITHUB)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fake.sent('ways')).toEqual([['ways']]);
    shown.unmount();
  }
});

test('a right password signs in, and a refusal says its sentence and keeps the name', async () => {
  const answer = later<SignInStep>();
  const { api, sent } = fakeApi({ passwordSignIn: () => answer.promise });
  const onSignedIn = vi.fn();
  const user = userEvent.setup();
  const { unmount } = render(<SignIn api={api} error="denied" onSignedIn={onSignedIn} />);
  await screen.findByRole('link', { name: 'Sign in with GitHub' });

  await user.type(screen.getByLabelText('Name'), 'octo-admin');
  await user.type(screen.getByLabelText('Password'), 'a long password of mine');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  // While it is sent: the button says so and is disabled, the reason GitHub sent back is gone, and a second submit sends nothing.
  expect(screen.getByRole('button', { name: 'Signing in' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.submit(screen.getByRole('form', { name: 'Sign in with a password' }));
  expect(sent('passwordSignIn')).toEqual([['passwordSignIn', 'octo-admin', 'a long password of mine']]);
  expect(onSignedIn).not.toHaveBeenCalled();

  await act(async () => answer.resolve({ next: 'signed_in' }));
  expect(onSignedIn).toHaveBeenCalledTimes(1);
  // Signed in, the page waits for the app and sends nothing more.
  expect(screen.getByRole('button', { name: 'Signing in' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('form', { name: 'Sign in with a password' }));
  expect(sent('passwordSignIn')).toHaveLength(1);
  expect(onSignedIn).toHaveBeenCalledTimes(1);
  unmount();

  const refusals: [() => Promise<SignInStep>, string][] = [
    [() => Promise.reject(new RequestFailed(401, 'refused')), REFUSED],
    [() => Promise.reject(new RequestFailed(401, 'expired')), EXPIRED],
    [() => Promise.reject(new RequestFailed(400, 'bad_request')), FAILED],
    [() => Promise.reject(new RequestFailed(403, 'origin')), FAILED],
    [() => Promise.reject(new RequestFailed(500, 'internal_error')), FAILED],
    [() => Promise.reject(new RequestFailed(503, 'unknown')), BUSY],
    [() => Promise.reject(new RequestFailed(0, 'network')), UNREACHABLE],
    [() => Promise.reject(new TypeError('Failed to fetch')), FAILED],
    [() => Promise.resolve({ next: 'elsewhere' } as unknown as SignInStep), FAILED],
  ];
  const answers = refusals.map(([refusal]) => refusal);
  const refusing = fakeApi({ passwordSignIn: () => answers.shift()!() });
  const refused = vi.fn();
  render(<SignIn api={refusing.api} error="denied" onSignedIn={refused} />);
  await user.type(screen.getByLabelText('Name'), 'octo-admin');
  for (const [, text] of refusals) {
    await user.type(screen.getByLabelText('Password'), 'another long password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(text);
    expect(classes(alert)).toEqual(words('text-sm text-bad'));
    expect(alert.compareDocumentPosition(screen.getByRole('form', { name: 'Sign in with a password' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('Name')).toHaveValue('octo-admin');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  }
  expect(refusing.sent('passwordSignIn')).toEqual(refusals.map(() => ['passwordSignIn', 'octo-admin', 'another long password']));
  expect(refused).not.toHaveBeenCalled();
});

test('a one-time password leads to choosing a password, twice, which signs in', async () => {
  const chosen = later<SignInStep>();
  const { api, sent } = fakeApi({ passwordSignIn: () => Promise.resolve({ next: 'choose_password' }), firstPassword: () => chosen.promise });
  const onSignedIn = vi.fn();
  const user = userEvent.setup();
  render(<SignIn api={api} error="denied" onSignedIn={onSignedIn} />);
  await screen.findByRole('link', { name: 'Sign in with GitHub' });
  const typed = [screen.getByLabelText('Name'), screen.getByLabelText('Password')];
  await user.type(screen.getByLabelText('Name'), 'octo-new');
  await user.type(screen.getByLabelText('Password'), ONE_TIME);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  const title = await screen.findByRole('heading', { level: 1, name: 'Choose your password' });
  // The first step's fields are gone, not reused as the choice's.
  expect(typed.map((input) => input.isConnected)).toEqual([false, false]);
  expect(classes(title)).toEqual(words(heading));
  const box = title.closest('[data-slot="card"]');
  expect(classes(box)).toEqual(words(card, 'flex w-full max-w-[400px] flex-col gap-4 p-8'));
  expect(screen.getByText('Visto AI').tagName).toBe('STRONG');
  const line = screen.getByText('This was a one-time password. Choose the password you will sign in with: 12 to 128 characters.');
  expect(classes(line)).toEqual(words('text-sm text-muted'));
  expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
  expect(screen.queryByRole('form', { name: 'Sign in with a password' })).toBeNull();
  expect(screen.queryByLabelText('Name')).toBeNull();
  expect(screen.queryByLabelText('Password')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByText(OR_GITHUB)).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  // The one-time password is in no field of the page; the name is, in the choice's hidden field for a password manager.
  expect([...document.querySelectorAll('input')].map((input) => input.value)).toEqual(['octo-new', '', '']);
  expect(onSignedIn).not.toHaveBeenCalled();

  const form = screen.getByRole('form', { name: 'Choose your password' });
  expect(form.tagName).toBe('FORM');
  expect(classes(form)).toEqual(words('flex flex-col gap-3'));
  expect(line.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const first = within(form).getByLabelText('New password');
  const again = within(form).getByLabelText('New password again');
  for (const [label, input] of [['New password', first], ['New password again', again]] as const) {
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    expect(classes(input)).toEqual(words(field));
    const element = within(form).getByText(label);
    expect(element.tagName).toBe('LABEL');
    expect(classes(element)).toEqual(words('text-sm font-medium'));
    expect(element.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  expect(first.compareDocumentPosition(again) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(first).toHaveFocus();
  const submit = within(form).getByRole('button', { name: 'Choose and sign in' });
  expect(submit).toHaveAttribute('type', 'submit');
  expect(classes(submit)).toEqual(words(primary));
  const cancel = within(form).getByRole('button', { name: 'Cancel' });
  expect(cancel).toHaveAttribute('type', 'button');
  expect(classes(cancel)).toEqual(words(button));
  expect(submit.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  await user.type(first, 'a long password of mine');
  await user.type(again, 'a long password of mine');
  await user.click(submit);
  // While it is sent: the button says so, neither button can be pressed, and a second submit sends nothing.
  expect(screen.getByRole('button', { name: 'Signing in' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  fireEvent.submit(form);
  expect(sent('firstPassword')).toEqual([['firstPassword', 'octo-new', ONE_TIME, 'a long password of mine']]);

  await act(async () => chosen.resolve({ next: 'signed_in' }));
  expect(onSignedIn).toHaveBeenCalledTimes(1);
  expect(sent('passwordSignIn')).toEqual([['passwordSignIn', 'octo-new', ONE_TIME]]);
  expect(sent('firstPassword')).toHaveLength(1);
});

test('the choice checks the two passwords and their length before sending', async () => {
  const { api, sent } = fakeApi({
    passwordSignIn: () => Promise.resolve({ next: 'choose_password' }),
    // A refusal that keeps the choice, said only once a choice was sent.
    firstPassword: () => Promise.reject(new RequestFailed(400, 'same_password')),
  });
  const user = userEvent.setup();
  render(<SignIn api={api} error={null} onSignedIn={() => {}} />);
  await user.type(screen.getByLabelText('Name'), 'octo-new');
  await user.type(screen.getByLabelText('Password'), ONE_TIME);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { level: 1, name: 'Choose your password' });

  const choose = async (one: string, two: string): Promise<string> => {
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: one } });
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: two } });
    await user.click(screen.getByRole('button', { name: 'Choose and sign in' }));
    const alert = await screen.findByRole('alert');
    expect(chosenValues()).toEqual(['', '']);
    expect(screen.getByRole('heading', { level: 1, name: 'Choose your password' })).toBeInTheDocument();
    return alert.textContent ?? '';
  };
  // A code point beyond the first plane is two code units: eleven of them are 22 units and still too short.
  const face = String.fromCodePoint(0x1f600);

  expect(await choose('a long password of mine', 'a long password of mien')).toBe(NOT_THE_SAME);
  expect(await choose('eleven char', 'eleven char')).toBe(LENGTH);
  expect(await choose('short', 'shorter')).toBe(NOT_THE_SAME);
  expect(await choose('x'.repeat(129), 'x'.repeat(129))).toBe(LENGTH);
  expect(await choose(face.repeat(11), face.repeat(11))).toBe(LENGTH);
  expect(await choose('', '')).toBe(LENGTH);
  expect(sent('firstPassword')).toEqual([]);

  // Twelve code points and 128 are sent.
  expect(await choose(face.repeat(12), face.repeat(12))).toBe(SAME);
  expect(await choose('y'.repeat(128), 'y'.repeat(128))).toBe(SAME);
  expect(sent('firstPassword')).toEqual([
    ['firstPassword', 'octo-new', ONE_TIME, face.repeat(12)],
    ['firstPassword', 'octo-new', ONE_TIME, 'y'.repeat(128)],
  ]);
});

test('each refusal of the choice reads as pinned, and Cancel goes back', async () => {
  // Refusals after which the one-time password may still work: the choice stays.
  const kept: [() => Promise<SignInStep>, string][] = [
    [() => Promise.reject(new RequestFailed(400, 'same_password')), SAME],
    [() => Promise.reject(new RequestFailed(400, 'password_length')), LENGTH],
    [() => Promise.reject(new RequestFailed(503, 'unknown')), BUSY],
    [() => Promise.reject(new RequestFailed(0, 'network')), UNREACHABLE],
    [() => Promise.reject(new RequestFailed(500, 'internal_error')), FAILED],
    [() => Promise.reject(new RequestFailed(400, 'bad_request')), FAILED],
    [() => Promise.reject(new RequestFailed(400, 'constructor')), FAILED],
    [() => Promise.reject(new TypeError('Failed to fetch')), FAILED],
    [() => Promise.resolve({ next: 'choose_password' }), FAILED],
  ];
  // Refusals after which it can no longer work, each followed by the new one-time password an admin gave.
  const dead: [RequestFailed, string, string][] = [
    [new RequestFailed(401, 'refused'), REFUSED, 'h4n7r2w9x3k8m5t6q2zb'],
    [new RequestFailed(401, 'expired'), EXPIRED, 'w5q8t3m7k2x9n4r6h3ce'],
    [new RequestFailed(409, 'already_chosen'), ALREADY_CHOSEN, 'r6t2k9w4m8q3x7n5h2df'],
  ];
  const answers = [...kept.map(([refusal]) => refusal), ...dead.map(([failure]) => () => Promise.reject(failure))];
  const lastChoice = later<SignInStep>();
  answers.push(() => lastChoice.promise);
  const { api, sent } = fakeApi({ passwordSignIn: () => Promise.resolve({ next: 'choose_password' }), firstPassword: () => answers.shift()!() });
  const onSignedIn = vi.fn();
  const user = userEvent.setup();
  render(<SignIn api={api} error="denied" onSignedIn={onSignedIn} />);
  await screen.findByRole('link', { name: 'Sign in with GitHub' });
  await user.type(screen.getByLabelText('Name'), 'octo-new');
  await user.type(screen.getByLabelText('Password'), ONE_TIME);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { level: 1, name: 'Choose your password' });

  for (const [, text] of kept) {
    await user.type(screen.getByLabelText('New password'), 'a long password of mine');
    await user.type(screen.getByLabelText('New password again'), 'a long password of mine');
    await user.click(screen.getByRole('button', { name: 'Choose and sign in' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(text);
    expect(alert.tagName).toBe('P');
    expect(classes(alert)).toEqual(words('text-sm text-bad'));
    expect(alert.compareDocumentPosition(screen.getByRole('form', { name: 'Choose your password' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Choose your password' })).toBeInTheDocument();
    expect(chosenValues()).toEqual(['', '']);
    expect(screen.getByRole('button', { name: 'Choose and sign in' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  }
  expect(sent('firstPassword')).toEqual(kept.map(() => ['firstPassword', 'octo-new', ONE_TIME, 'a long password of mine']));

  // Each of these does what Cancel does and says its sentence above the first form; the next press signs in with a password and
  // never sends the dead one-time password again.
  let oneTime = ONE_TIME;
  for (const [, text, next] of dead) {
    await user.type(screen.getByLabelText('New password'), 'a long password of mine');
    await user.type(screen.getByLabelText('New password again'), 'a long password of mine');
    await user.click(screen.getByRole('button', { name: 'Choose and sign in' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(text);
    expect(alert.tagName).toBe('P');
    expect(classes(alert)).toEqual(words('text-sm text-bad'));
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Choose your password' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Choose your password' })).toBeNull();
    expect(alert.compareDocumentPosition(screen.getByRole('form', { name: 'Sign in with a password' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('Name')).toHaveValue('octo-new');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Sign in with GitHub' })).toBeInTheDocument();
    expect(sent('firstPassword').at(-1)).toEqual(['firstPassword', 'octo-new', oneTime, 'a long password of mine']);
    const chosen = sent('firstPassword').length;

    await user.type(screen.getByLabelText('Password'), next);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(sent('passwordSignIn').at(-1)).toEqual(['passwordSignIn', 'octo-new', next]);
    expect(sent('firstPassword')).toHaveLength(chosen);
    await screen.findByRole('heading', { level: 1, name: 'Choose your password' });
    expect(screen.queryByRole('alert')).toBeNull();
    oneTime = next;
  }
  expect(sent('firstPassword')).toHaveLength(kept.length + dead.length);
  expect(onSignedIn).not.toHaveBeenCalled();

  // Cancel: the first step again, the name kept, no password and no alert, GitHub's way back.
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Choose your password' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByLabelText('Name')).toHaveValue('octo-new');
  expect(screen.getByLabelText('Password')).toHaveValue('');
  expect(screen.getByRole('link', { name: 'Sign in with GitHub' })).toBeInTheDocument();

  // The one-time password was forgotten: the next choice sends the one typed now.
  await user.type(screen.getByLabelText('Password'), 'p3x8w2m9k4h7t5r6n2qa');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { level: 1, name: 'Choose your password' });
  expect(chosenValues()).toEqual(['', '']);
  expect(screen.queryByRole('alert')).toBeNull();
  await user.type(screen.getByLabelText('New password'), 'another long password');
  await user.type(screen.getByLabelText('New password again'), 'another long password');
  await user.click(screen.getByRole('button', { name: 'Choose and sign in' }));
  await act(async () => lastChoice.resolve({ next: 'signed_in' }));
  expect(onSignedIn).toHaveBeenCalledTimes(1);
  expect(sent('passwordSignIn')).toEqual([ONE_TIME, ...dead.map(([, , next]) => next), 'p3x8w2m9k4h7t5r6n2qa'].map((typed) => ['passwordSignIn', 'octo-new', typed]));
  expect(sent('firstPassword').at(-1)).toEqual(['firstPassword', 'octo-new', 'p3x8w2m9k4h7t5r6n2qa', 'another long password']);
});

test('the choice sends the name its one-time password was given for, and the first step cannot be typed into while it is sent', async () => {
  const first = later<SignInStep>();
  const { api, sent } = fakeApi({ passwordSignIn: () => first.promise, firstPassword: () => Promise.resolve({ next: 'signed_in' }) });
  const onSignedIn = vi.fn();
  const user = userEvent.setup();
  render(<SignIn api={api} error={null} onSignedIn={onSignedIn} />);
  const name = screen.getByLabelText('Name');
  const password = screen.getByLabelText('Password');
  await user.type(name, 'octo-new');
  await user.type(password, ONE_TIME);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  // While the first step is sent: neither field takes what is typed.
  expect(name).toBeDisabled();
  expect(password).toBeDisabled();
  await user.type(name, '-admin');
  expect(name).toHaveValue('octo-new');
  // A change that reaches the field all the same (fireEvent goes past disabled) is not the name the choice sends.
  fireEvent.change(name, { target: { value: 'octo-admin' } });
  await act(async () => first.resolve({ next: 'choose_password' }));
  const form = await screen.findByRole('form', { name: 'Choose your password' });
  expect(form.querySelector('input[autocomplete="username"]')).toHaveValue('octo-new');
  await user.type(screen.getByLabelText('New password'), 'a long password of mine');
  await user.type(screen.getByLabelText('New password again'), 'a long password of mine');
  await user.click(screen.getByRole('button', { name: 'Choose and sign in' }));
  expect(sent('passwordSignIn')).toEqual([['passwordSignIn', 'octo-new', ONE_TIME]]);
  expect(sent('firstPassword')).toEqual([['firstPassword', 'octo-new', ONE_TIME, 'a long password of mine']]);
  expect(onSignedIn).toHaveBeenCalledTimes(1);
});

test('the choice holds the name it is for, read-only, hidden and out of the tab order, for a password manager', async () => {
  const { api } = fakeApi({ passwordSignIn: () => Promise.resolve({ next: 'choose_password' }) });
  const user = userEvent.setup();
  render(<SignIn api={api} error={null} onSignedIn={() => {}} />);
  await user.type(screen.getByLabelText('Name'), 'octo-new');
  await user.type(screen.getByLabelText('Password'), ONE_TIME);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  const form = await screen.findByRole('form', { name: 'Choose your password' });

  const names = form.querySelectorAll('input[autocomplete="username"]');
  expect(names).toHaveLength(1);
  const held = names[0] as HTMLInputElement;
  expect(held.value).toBe('octo-new');
  expect(held.type).toBe('text');
  expect(held.readOnly).toBe(true);
  expect(held).toHaveAttribute('tabindex', '-1');
  // Hidden by the utility class, never by an inline style (the content security policy refuses one).
  expect(classes(held)).toEqual(['sr-only']);
  expect(held).not.toHaveAttribute('style');
  // Before the new password, where a password manager looks for the name.
  expect(held.compareDocumentPosition(screen.getByLabelText('New password')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  // Tab goes round the page and never reaches it.
  const reached: (Element | null)[] = [];
  for (let press = 0; press < 6; press += 1) {
    await user.tab();
    reached.push(document.activeElement);
  }
  expect(reached).toContain(screen.getByRole('button', { name: 'Cancel' }));
  expect(reached).not.toContain(held);
});

test('the choice cannot be typed into while it is sent, and can again once it is refused', async () => {
  const answer = later<SignInStep>();
  const { api, sent } = fakeApi({ passwordSignIn: () => Promise.resolve({ next: 'choose_password' }), firstPassword: () => answer.promise });
  const user = userEvent.setup();
  render(<SignIn api={api} error={null} onSignedIn={() => {}} />);
  await user.type(screen.getByLabelText('Name'), 'octo-new');
  await user.type(screen.getByLabelText('Password'), ONE_TIME);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { level: 1, name: 'Choose your password' });
  const first = screen.getByLabelText('New password');
  const again = screen.getByLabelText('New password again');
  expect(first).toBeEnabled();
  expect(again).toBeEnabled();
  await user.type(first, 'a long password of mine');
  await user.type(again, 'a long password of mine');
  await user.click(screen.getByRole('button', { name: 'Choose and sign in' }));

  // While it is sent: neither of the two new passwords takes what is typed.
  expect(first).toBeDisabled();
  expect(again).toBeDisabled();
  await user.type(first, ' more');
  await user.type(again, ' more');
  expect(chosenValues()).toEqual(['a long password of mine', 'a long password of mine']);
  expect(sent('firstPassword')).toEqual([['firstPassword', 'octo-new', ONE_TIME, 'a long password of mine']]);

  // A refusal that keeps the choice: both are emptied and take what is typed again.
  await act(async () => answer.resolve({ next: 'choose_password' }));
  expect(screen.getByRole('alert')).toHaveTextContent(FAILED);
  expect(screen.getByLabelText('New password')).toBeEnabled();
  expect(screen.getByLabelText('New password again')).toBeEnabled();
  await user.type(screen.getByLabelText('New password'), 'another long password');
  expect(chosenValues()).toEqual(['another long password', '']);
});

test('the name the choice holds for a password manager is hidden from assistive technology too', async () => {
  const { api } = fakeApi({ passwordSignIn: () => Promise.resolve({ next: 'choose_password' }) });
  const user = userEvent.setup();
  render(<SignIn api={api} error={null} onSignedIn={() => {}} />);
  await user.type(screen.getByLabelText('Name'), 'octo-new');
  await user.type(screen.getByLabelText('Password'), ONE_TIME);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  const form = await screen.findByRole('form', { name: 'Choose your password' });

  const held = form.querySelector('input[autocomplete="username"]');
  expect(held).toHaveValue('octo-new');
  expect(held).toHaveAttribute('aria-hidden', 'true');
  // So no text field of the choice is in the accessibility tree.
  expect(within(form).queryAllByRole('textbox')).toEqual([]);
});

test('neither form lets its submit reload the page, also while it is sent', async () => {
  const first = later<SignInStep>();
  const chosen = later<SignInStep>();
  const { api, sent } = fakeApi({ passwordSignIn: () => first.promise, firstPassword: () => chosen.promise });
  const onSignedIn = vi.fn();
  const user = userEvent.setup();
  render(<SignIn api={api} error={null} onSignedIn={onSignedIn} />);
  /** Submits `form` as a browser would, and says whether the page's own submission was stopped. */
  const prevented = (form: HTMLElement): boolean => {
    const event = createEvent.submit(form);
    fireEvent(form, event);
    return event.defaultPrevented;
  };

  const signIn = screen.getByRole('form', { name: 'Sign in with a password' });
  await user.type(screen.getByLabelText('Name'), 'octo-new');
  await user.type(screen.getByLabelText('Password'), ONE_TIME);
  expect(prevented(signIn)).toBe(true);
  expect(prevented(signIn)).toBe(true);
  expect(sent('passwordSignIn')).toEqual([['passwordSignIn', 'octo-new', ONE_TIME]]);

  await act(async () => first.resolve({ next: 'choose_password' }));
  const choice = await screen.findByRole('form', { name: 'Choose your password' });
  // Refused before sending, then sent, then sent already.
  expect(prevented(choice)).toBe(true);
  expect(await screen.findByRole('alert')).toHaveTextContent(LENGTH);
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a long password of mine' } });
  fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'a long password of mine' } });
  expect(prevented(choice)).toBe(true);
  expect(prevented(choice)).toBe(true);
  expect(sent('firstPassword')).toEqual([['firstPassword', 'octo-new', ONE_TIME, 'a long password of mine']]);
  await act(async () => chosen.resolve({ next: 'signed_in' }));
  expect(onSignedIn).toHaveBeenCalledTimes(1);
});
