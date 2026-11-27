import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { RequestFailed } from '../api.ts';
import type { Api } from '../api.ts';
import type { Account, AccountAnswer, Accounts, Activity, Me, OneTime, Reviews } from '../api-types.ts';
import { App } from '../app.tsx';

const NOW = '2026-03-01T10:00:00.000Z';
/** The time `seconds` after 10:00:00 on the first of March 2026, before it when negative. */
const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

const ME: Me = { name: 'octo-admin', kind: 'password', role: 'admin', csrf: 'csrf-token-for-tests', mode: 'live', repositories: ['acme/shop'] };
const ACTIVITY: Activity = { now: NOW, places: { reviews: 2, withdrawals: 2 }, paused: null, jobs: [], withdrawals: [] };
const REVIEWS: Reviews = { now: NOW, windowDays: 30, total: 0, reviews: [], next: null };

function account(over: Partial<Account> & Pick<Account, 'id' | 'name'>): Account {
  return {
    kind: 'password', role: 'viewer', password: 'set', waitsUntil: null, madeAt: at(-300), madeBy: { kind: 'password', name: 'octo-admin' },
    lastSignInAt: null, you: false, ...over,
  };
}
const ADMIN = account({ id: 1, name: 'octo-admin', role: 'admin', madeAt: at(-3 * 86_400), madeBy: { kind: 'command', name: null }, lastSignInAt: at(-120), you: true });
const LEAD = account({
  id: 2, kind: 'github', name: 'octo-lead', role: 'admin', password: null, madeAt: at(-2 * 86_400), madeBy: { kind: 'sign_in', name: null }, lastSignInAt: at(-3600),
});
const VIEWER = account({ id: 3, name: 'octo-viewer', password: 'one_time' });
const NEW = account({ id: 4, name: 'octo-new', password: 'expired', madeAt: at(-4 * 86_400), madeBy: { kind: 'github', name: 'octo-lead' } });
const DEV = account({
  id: 5, kind: 'github', name: 'octo-dev', password: null, madeAt: at(-30 * 3600), madeBy: { kind: 'sign_in', name: null }, lastSignInAt: at(-45),
});
const LIST: Accounts = { now: NOW, accounts: [ADMIN, LEAD, VIEWER, NEW, DEV] };

const PASSWORD = 'k7m2q9xh4wz8r3bt6pn5';
const ONE_TIME: OneTime = { account: VIEWER, oneTimePassword: PASSWORD, expiresAt: '2026-03-04T10:00:00.000Z' };

const HELP = '1 to 39 characters: lower-case letters, digits, dots, underscores and hyphens, starting with a letter or a digit.';
const LAST_ADMIN = 'The last admin cannot be made a viewer or removed. Make another admin first: one who has not chosen a password yet does not count.';
const OWN_ACCOUNT = 'Change your own password from the sidebar.';
const NOT_FOUND = 'This account no longer exists.';
const NAME_TAKEN = 'An account with this name exists already.';
const BAD_NAME = 'A name is 1 to 39 characters: lower-case letters, digits, dots, underscores and hyphens, starting with a letter or a digit.';
const FULL = 'This deployment keeps 1,000 accounts at most. Remove one first.';
const BUSY = 'The service is busy. Try again in a moment.';
const UNREACHABLE = 'The service could not be reached. Try again in a moment.';
const FAILED = 'The change failed.';
const REFUSED_COPY = 'The copy was refused: select the password and copy it by hand.';

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
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function visit(address: string): void {
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
const follows = (first: Node, second: Node): boolean => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/** The Accounts section of the page. */
const section = (): HTMLElement => screen.getByRole('region', { name: 'Accounts' });
/** The row of the account named `name`. */
function rowOf(name: string): HTMLElement {
  const row = within(section()).getByText(name, { selector: '.font-medium' }).closest('tr');
  if (row === null) throw new Error(`No row holds ${name}.`);
  return row;
}
/** The last cell of a row: its actions. */
const actionsOf = (name: string): HTMLElement => within(rowOf(name)).getAllByRole('cell').at(-1)!;
/** The texts of a cell, one for each element that holds no other; the cell's own when it holds none. */
function textsOf(cell: Element): string[] {
  const leaves = [...cell.querySelectorAll('*')].filter((element) => element.childElementCount === 0);
  return leaves.length === 0 ? [cell.textContent ?? ''] : leaves.map((element) => element.textContent ?? '');
}
/** Each row of the table, each cell's texts. */
const table = (): string[][][] =>
  within(section()).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map(textsOf));

// The classes of the first plan's pieces and of rules 1 to 6.
const card = 'overflow-hidden rounded-[12px] border border-border bg-card shadow-card';
const cardHeader = 'flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-[18px]';
const h2 = 'm-0 text-base font-semibold';
const heading = 'm-0 text-2xl font-semibold tracking-[-0.01em]';
const subLine = 'mt-1 mb-0 text-sm text-muted';
const badge = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs leading-5 font-medium';
const muted = 'bg-subtle text-muted';
const accent = 'bg-accent-soft text-accent-text';
const button =
  'inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-sm font-medium text-text no-underline hover:bg-subtle hover:text-text disabled:cursor-default disabled:opacity-55';
const primary = `${without(button, 'border-border', 'bg-card', 'text-text', 'hover:bg-subtle', 'hover:text-text')} border-accent bg-accent text-on-accent hover:bg-accent hover:text-on-accent`;
const tableClasses = 'w-full border-collapse text-sm';
const headCell = 'whitespace-nowrap border-b border-border px-4 py-2.5 text-left text-xs font-medium text-muted';
const cell = 'border-b border-border px-4 py-3 align-middle';
const field = 'min-h-9 rounded-lg border border-border bg-card px-3 text-sm text-text';
const formClasses = 'flex flex-wrap items-end gap-3 border-t border-border px-5 py-4';
const boxClasses = 'flex flex-col gap-2 border-t border-border bg-subtle px-5 py-4';
const alertClasses = 'border-t border-border px-5 py-3 text-sm text-bad';
const line = 'text-[13px] text-muted';
const COLUMNS = ['Name', 'Signs in with', 'Role', 'Last sign-in', 'Made', 'Actions'];

afterEach(() => {
  vi.useRealTimers();
  visit('/');
});

test('the accounts are listed with how they sign in, their role, their last sign-in and who made them', async () => {
  visit('/ui/settings');
  const { api, sent } = fakeApi({ accounts: () => Promise.resolve(LIST) });
  const first = render(<App api={api} />);

  const title = await screen.findByRole('heading', { level: 1, name: 'Settings' });
  expect(classes(title)).toEqual(words(heading));
  const sub = screen.getByText('Who may open the service, and what they may do. The other settings come in a later plan.');
  expect(sub.tagName).toBe('P');
  expect(classes(sub)).toEqual(words(subLine));
  expect(screen.getAllByRole('heading', { level: 1 })).toEqual([title]);

  // The section, after the header, named by its heading.
  const box = section();
  expect(box.tagName).toBe('SECTION');
  expect(classes(box)).toEqual(words(card));
  expect(box).toHaveAttribute('data-slot', 'card');
  expect(screen.getByRole('main').contains(box)).toBe(true);
  expect(follows(title, box)).toBe(true);
  const name = within(box).getByRole('heading', { level: 2, name: 'Accounts' });
  expect(classes(name)).toEqual(words(h2));
  expect(box.getAttribute('aria-labelledby')).toBe(name.id);
  expect(name.id).not.toBe('');
  const count = await within(box).findByText('5 accounts');
  expect(classes(count)).toEqual(words(badge, muted));
  expect(count.parentElement).toBe(name.parentElement);
  expect(classes(name.parentElement)).toEqual(words('flex items-center gap-2.5'));
  const head = name.parentElement?.parentElement;
  expect(classes(head)).toEqual(words(cardHeader));
  expect(head?.parentElement).toBe(box);
  const open = within(box).getByRole('button', { name: 'New account' });
  expect(open).toHaveAttribute('type', 'button');
  expect(classes(open)).toEqual(words(primary));
  expect(open.parentElement).toBe(head);

  // The table, in its scrolling box, its columns as pinned.
  const grid = within(box).getByRole('table');
  expect(classes(grid)).toEqual(words(tableClasses));
  expect(classes(grid.parentElement)).toEqual(words('overflow-x-auto'));
  const columns = within(grid).getAllByRole('columnheader');
  expect(columns.map((column) => column.textContent)).toEqual(COLUMNS);
  for (const column of columns) {
    expect(column).toHaveAttribute('scope', 'col');
    expect(classes(column)).toEqual(words(headCell));
  }
  expect(table()).toEqual([
    [['octo-admin', 'You'], ['Password'], ['Admin'], ['2 min ago'], ['3 days ago', 'by the command'], ['Make viewer', 'Remove']],
    [['octo-lead', 'GitHub'], ['GitHub'], ['Admin'], ['1 h ago'], ['2 days ago', 'at its first sign-in'], ['Make viewer', 'Remove']],
    [
      ['octo-viewer'], ['Password', 'Has not chosen a password yet'], ['Viewer'], ['Never'], ['5 min ago', 'by octo-admin'],
      ['Make admin', 'Reset password', 'Remove'],
    ],
    [
      ['octo-new'], ['Password', 'Its one-time password has expired'], ['Viewer'], ['Never'], ['4 days ago', 'by octo-lead'],
      ['Make admin', 'Reset password', 'Remove'],
    ],
    [['octo-dev', 'GitHub'], ['GitHub'], ['Viewer'], ['45 s ago'], ['yesterday', 'at its first sign-in'], ['Make admin', 'Remove']],
  ]);

  // Each cell's look.
  for (const row of within(grid).getAllByRole('row').slice(1)) {
    const cells = within(row).getAllByRole('cell');
    for (const [index, each] of cells.entries()) {
      const never = index === 3 && each.textContent === 'Never';
      expect(classes(each)).toEqual(words(cell, never ? 'text-muted' : ''));
    }
    const [who, way, role, , made, actions] = cells;
    const shown = who!.querySelector('.font-medium')!;
    expect(shown.tagName).toBe('SPAN');
    expect(classes(shown)).toEqual(words('font-medium'));
    expect(classes(shown.parentElement)).toEqual(words('flex flex-wrap items-center gap-2'));
    expect(shown.parentElement?.parentElement).toBe(who);
    for (const mark of [...(shown.parentElement?.children ?? [])].slice(1)) {
      expect(classes(mark)).toEqual(words(badge, mark.textContent === 'You' ? accent : muted));
    }
    const [kind, ...lines] = [...(way!.firstElementChild?.children ?? [])];
    expect(classes(way!.firstElementChild)).toEqual(words('flex flex-col gap-0.5'));
    expect(classes(kind)).toEqual([]);
    for (const each of lines) expect(classes(each)).toEqual(words(line));
    const roleBadge = role!.firstElementChild!;
    expect(classes(roleBadge)).toEqual(words(badge, roleBadge.textContent === 'Admin' ? accent : muted));
    expect(classes(made!.firstElementChild)).toEqual(words('flex flex-col gap-0.5'));
    const [when, by] = [...(made!.firstElementChild?.children ?? [])];
    expect(classes(when)).toEqual([]);
    expect(classes(by)).toEqual(words(line));
    expect(classes(actions!.firstElementChild)).toEqual(words('flex flex-wrap gap-2'));
    for (const each of within(actions!).getAllByRole('button')) {
      expect(each).toHaveAttribute('type', 'button');
      expect(each).toBeEnabled();
      expect(classes(each)).toEqual(words(button));
    }
  }
  // Read once, and nothing else said.
  expect(sent('accounts')).toHaveLength(1);
  expect(within(box).queryByRole('form')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('Reading the accounts.')).toBeNull();
  first.unmount();

  // While an account waits after five wrong tries, until when, beside a one-time password not yet chosen over.
  const waiting: Accounts = {
    now: NOW,
    accounts: [
      account({ id: 3, name: 'octo-viewer', waitsUntil: at(12 * 60 + 59), madeBy: { kind: 'github', name: null } }),
      account({ id: 4, name: 'octo-new', password: 'one_time', waitsUntil: '2026-03-01T10:15:00.000Z' }),
    ],
  };
  const second = render(<App api={fakeApi({ accounts: () => Promise.resolve(waiting) }).api} />);
  expect(await screen.findByText('2 accounts')).toBeInTheDocument();
  expect(table()).toEqual([
    [
      ['octo-viewer'], ['Password', 'Waiting after five wrong tries, until 2026-03-01 10:12 UTC'], ['Viewer'], ['Never'], ['5 min ago'],
      ['Make admin', 'Reset password', 'Remove'],
    ],
    [
      ['octo-new'], ['Password', 'Has not chosen a password yet', 'Waiting after five wrong tries, until 2026-03-01 10:15 UTC'], ['Viewer'], ['Never'],
      ['5 min ago', 'by octo-admin'], ['Make admin', 'Reset password', 'Remove'],
    ],
  ]);
  second.unmount();

  // One account is said as one.
  render(<App api={fakeApi({ accounts: () => Promise.resolve({ now: NOW, accounts: [ADMIN] }) }).api} />);
  expect(classes(await screen.findByText('1 account'))).toEqual(words(badge, muted));
  expect(table()).toHaveLength(1);
});

test('a new account shows its one-time password once, with Copy, until Done', async () => {
  visit('/ui/settings');
  const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((way) => vi.spyOn(console, way));
  // Before render: jsdom has no clipboard, and the setup attaches user-event's.
  const user = userEvent.setup();
  const made = later<OneTime>();
  const second: OneTime = {
    account: account({ id: 4, name: 'octo-new', password: 'one_time' }), oneTimePassword: 'p3n8w2x7k4r9t5b6m2qz', expiresAt: '2026-03-04T10:05:00.000Z',
  };
  const answers: (() => Promise<OneTime>)[] = [() => made.promise, () => Promise.resolve(second)];
  let list: Accounts = { now: NOW, accounts: [ADMIN] };
  const { api, sent } = fakeApi({ accounts: () => Promise.resolve(list), makeAccount: () => answers.shift()!() });
  const { unmount } = render(<App api={api} />);
  expect(await screen.findByText('1 account')).toBeInTheDocument();

  // The form, opened in place of its button.
  await user.click(screen.getByRole('button', { name: 'New account' }));
  expect(screen.queryByRole('button', { name: 'New account' })).toBeNull();
  const form = screen.getByRole('form', { name: 'New account' });
  expect(form.tagName).toBe('FORM');
  expect(classes(form)).toEqual(words(formClasses));
  expect(form.parentElement).toBe(section());
  expect(follows(within(section()).getByRole('heading', { level: 2, name: 'Accounts' }), form)).toBe(true);
  expect(follows(form, within(section()).getByRole('table'))).toBe(true);
  const name = within(form).getByLabelText('Name') as HTMLInputElement;
  expect(name.tagName).toBe('INPUT');
  expect(name).toHaveAttribute('autocomplete', 'off');
  expect(name).toHaveAttribute('autocapitalize', 'none');
  expect(classes(name)).toEqual(words(field));
  expect(name.value).toBe('');
  const role = within(form).getByLabelText('Role') as HTMLSelectElement;
  expect(role.tagName).toBe('SELECT');
  expect(classes(role)).toEqual(words(field));
  expect([...role.options].map((option) => [option.value, option.textContent])).toEqual([['viewer', 'Viewer'], ['admin', 'Admin']]);
  expect(role.value).toBe('viewer');
  for (const [label, input] of [['Name', name], ['Role', role]] as const) {
    const element = within(form).getByText(label);
    expect(element.tagName).toBe('LABEL');
    expect(classes(element)).toEqual(words('text-sm font-medium'));
    // The label over its field.
    expect(element.parentElement).toBe(input.parentElement);
    expect(classes(element.parentElement)).toEqual(words('flex flex-col gap-1'));
    expect(follows(element, input)).toBe(true);
  }
  expect(follows(name, role)).toBe(true);
  const submit = within(form).getByRole('button', { name: 'Make the account' });
  expect(submit).toHaveAttribute('type', 'submit');
  expect(classes(submit)).toEqual(words(primary));
  const cancel = within(form).getByRole('button', { name: 'Cancel' });
  expect(cancel).toHaveAttribute('type', 'button');
  expect(classes(cancel)).toEqual(words(button));
  expect(within(form).getAllByRole('button')).toEqual([submit, cancel]);
  expect(follows(role, submit)).toBe(true);
  const help = within(form).getByText(HELP);
  expect(help.tagName).toBe('P');
  expect(classes(help)).toEqual(words('w-full text-[13px] text-muted'));
  expect(follows(cancel, help)).toBe(true);

  // Cancel closes it and keeps nothing typed.
  await user.type(name, 'octo-viewer');
  await user.selectOptions(role, 'admin');
  await user.click(cancel);
  expect(screen.queryByRole('form', { name: 'New account' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'New account' }));
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('viewer');
  expect(sent('makeAccount')).toEqual([]);

  // Sent once: the button says so, and a second submit sends nothing.
  await user.type(screen.getByLabelText('Name'), 'octo-viewer');
  await user.click(screen.getByRole('button', { name: 'Make the account' }));
  expect(screen.getByRole('button', { name: 'Making' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('form', { name: 'New account' }));
  expect(sent('makeAccount')).toEqual([['makeAccount', ME.csrf, 'octo-viewer', 'viewer']]);
  list = { now: NOW, accounts: [ADMIN, VIEWER] };
  await act(async () => made.resolve(ONE_TIME));

  // The one-time password, in its box, above the table; the form closed, and the list read again.
  const box = screen.getByRole('status');
  expect(box.tagName).toBe('DIV');
  expect(classes(box)).toEqual(words(boxClasses));
  expect(box.parentElement).toBe(section());
  expect(follows(box, within(section()).getByRole('table'))).toBe(true);
  const strong = within(box).getByText('One-time password for octo-viewer');
  expect(strong.tagName).toBe('STRONG');
  expect(classes(strong)).toEqual(words('text-sm'));
  const code = within(box).getByText(PASSWORD);
  expect(code.tagName).toBe('CODE');
  expect(classes(code)).toEqual(words('font-mono text-[15px]'));
  const said = within(box).getByText('Shown once. octo-viewer signs in with it once, then chooses a password. It expires 2026-03-04 10:00 UTC.');
  expect(said.tagName).toBe('P');
  expect(classes(said)).toEqual(words('text-[13px] text-muted'));
  const copy = within(box).getByRole('button', { name: 'Copy' });
  const done = within(box).getByRole('button', { name: 'Done' });
  for (const each of [copy, done]) {
    expect(each).toHaveAttribute('type', 'button');
    expect(classes(each)).toEqual(words(button));
  }
  expect(within(box).getAllByRole('button')).toEqual([copy, done]);
  expect(follows(strong, code) && follows(code, said) && follows(said, copy)).toBe(true);
  expect(screen.queryByRole('form', { name: 'New account' })).toBeNull();
  expect(screen.getByRole('button', { name: 'New account' })).toBeInTheDocument();
  expect(await screen.findByText('2 accounts')).toBeInTheDocument();
  expect(sent('accounts')).toHaveLength(2);
  expect(screen.getAllByText(PASSWORD)).toEqual([code]);
  expect(screen.queryByRole('alert')).toBeNull();

  // Copy puts it on the clipboard, and says so.
  await user.click(copy);
  expect(await navigator.clipboard.readText()).toBe(PASSWORD);
  expect(await within(box).findByRole('button', { name: 'Copied' })).toBe(copy);
  expect(copy).toHaveTextContent('Copied');
  expect(within(box).queryByText(REFUSED_COPY)).toBeNull();

  // Done forgets it, and reads nothing again.
  await user.click(done);
  expect(screen.queryByRole('status')).toBeNull();
  expect(document.body.textContent).not.toContain(PASSWORD);
  expect(sent('accounts')).toHaveLength(2);

  // Another, shown, then the page left and opened again: gone.
  await user.click(screen.getByRole('button', { name: 'New account' }));
  await user.type(screen.getByLabelText('Name'), 'octo-new');
  await user.click(screen.getByRole('button', { name: 'Make the account' }));
  expect(await screen.findByText('One-time password for octo-new')).toBeInTheDocument();
  expect(screen.getByText('Shown once. octo-new signs in with it once, then chooses a password. It expires 2026-03-04 10:05 UTC.')).toBeInTheDocument();
  expect(within(screen.getByRole('status')).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  const nav = screen.getByRole('navigation', { name: 'Main' });
  await user.click(within(nav).getByRole('link', { name: 'Activity' }));
  await user.click(within(nav).getByRole('link', { name: 'Settings' }));
  expect(await screen.findByRole('region', { name: 'Accounts' })).toBeInTheDocument();
  expect(screen.queryByRole('status')).toBeNull();
  expect(document.body.textContent).not.toContain('p3n8w2x7k4r9t5b6m2qz');

  // And after a remount, none is anywhere.
  unmount();
  render(<App api={api} />);
  expect(await screen.findByRole('region', { name: 'Accounts' })).toBeInTheDocument();
  await act(async () => {});
  expect(screen.queryByRole('status')).toBeNull();
  for (const secret of [PASSWORD, 'p3n8w2x7k4r9t5b6m2qz']) {
    expect(document.body.textContent).not.toContain(secret);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.href).toBe('http://localhost:3000/ui/settings');
    for (const spy of logged) for (const args of spy.mock.calls) expect(args.map(String).join(' ')).not.toContain(secret);
  }
  expect(sent('makeAccount')).toEqual([['makeAccount', ME.csrf, 'octo-viewer', 'viewer'], ['makeAccount', ME.csrf, 'octo-new', 'viewer']]);
});

test('a name of another shape is refused before sending, and each refusal of the server reads as pinned', async () => {
  visit('/ui/settings');
  // Each refusal, by its code, then its status; whether the list is read again after it.
  const refusals: [unknown, string, boolean][] = [
    [new RequestFailed(409, 'last_admin'), LAST_ADMIN, false],
    [new RequestFailed(409, 'own_account'), OWN_ACCOUNT, false],
    [new RequestFailed(404, 'not_found'), NOT_FOUND, true],
    [new RequestFailed(409, 'name_taken'), NAME_TAKEN, true],
    [new RequestFailed(400, 'bad_name'), BAD_NAME, false],
    [new RequestFailed(409, 'full'), FULL, false],
    [new RequestFailed(503, 'unknown'), BUSY, true],
    [new RequestFailed(500, 'internal_error'), FAILED, true],
    [new RequestFailed(409, 'github_account'), FAILED, false],
    [new RequestFailed(400, 'bad_request'), FAILED, false],
    [new RequestFailed(403, 'csrf'), FAILED, false],
    [new RequestFailed(403, 'forbidden'), FAILED, false],
    [new RequestFailed(0, 'network'), UNREACHABLE, true],
    [new RequestFailed(400, '__proto__'), FAILED, false],
    [new TypeError('Failed to fetch'), FAILED, false],
  ];
  const answers = refusals.map(([error]) => () => Promise.reject(error));
  const { api, sent } = fakeApi({ accounts: () => Promise.resolve(LIST), makeAccount: () => answers.shift()!() });
  const user = userEvent.setup();
  render(<App api={api} />);
  expect(await screen.findByText('5 accounts')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'New account' }));
  const form = screen.getByRole('form', { name: 'New account' });
  const name = within(form).getByLabelText('Name') as HTMLInputElement;
  await user.selectOptions(within(form).getByLabelText('Role'), 'admin');

  /** Sends what the field holds, and gives the one alert said, after checking its place, its look and that the name stays. */
  const said = async (typed: string): Promise<string> => {
    fireEvent.change(name, { target: { value: typed } });
    await user.click(within(form).getByRole('button', { name: 'Make the account' }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    expect(alert.tagName).toBe('P');
    expect(classes(alert)).toEqual(words(alertClasses));
    expect(alert.parentElement).toBe(section());
    expect(follows(form, alert)).toBe(true);
    expect(follows(alert, within(section()).getByRole('table'))).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
    expect(name.value).toBe(typed);
    expect(within(form).getByRole('button', { name: 'Make the account' })).toBeEnabled();
    return alert.textContent ?? '';
  };

  // Before sending: a name of another shape, written as typed (neither trimmed nor lower-cased).
  const face = String.fromCodePoint(0x1f600);
  const shapes = ['', 'Octo-viewer', '-octo', '.octo', '_octo', 'octo viewer', ' octo-viewer', 'octo-viewer ', 'octo/viewer', 'octo@viewer', 'a'.repeat(40), face];
  for (const shape of shapes) expect(await said(shape)).toBe(BAD_NAME);
  expect(sent('makeAccount')).toEqual([]);

  // Sent: each refusal of the service, the name kept; the list read again after a not_found, a name_taken and a lost answer.
  const names = ['octo-viewer', 'x'.repeat(39), '7', 'octo.new_2-b'];
  const texts: string[] = [];
  const reads: number[] = [];
  for (const index of refusals.keys()) {
    texts.push(await said(names[index % names.length]!));
    await act(async () => {});
    reads.push(sent('accounts').length);
  }
  expect(texts).toEqual(refusals.map(([, text]) => text));
  let read = 1;
  expect(reads).toEqual(refusals.map(([, , again]) => (read += again ? 1 : 0)));
  expect(sent('makeAccount')).toEqual(refusals.map((_, index) => ['makeAccount', ME.csrf, names[index % names.length], 'admin']));
  // Still here, the form open.
  expect(screen.getByRole('form', { name: 'New account' })).toBe(form);
  expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
});

test('a role is changed, a password reset and an account removed after its confirmation, and the list read again', async () => {
  visit('/ui/settings');
  const user = userEvent.setup();
  const reset: OneTime = { account: VIEWER, oneTimePassword: 'p3n8w2x7k4r9t5b6m2qz', expiresAt: '2026-03-04T10:05:00.000Z' };
  const roles: (() => Promise<AccountAnswer>)[] = [
    () => Promise.resolve({ account: { ...VIEWER, role: 'admin' } }),
    () => Promise.reject(new RequestFailed(409, 'last_admin')),
  ];
  const removals: (() => Promise<void>)[] = [() => Promise.resolve(), () => Promise.reject(new RequestFailed(404, 'not_found'))];
  let list: Accounts = LIST;
  const { api, sent } = fakeApi({
    accounts: () => Promise.resolve(list),
    setRole: () => roles.shift()!(),
    resetPassword: () => Promise.resolve(reset),
    removeAccount: () => removals.shift()!(),
  });
  render(<App api={api} />);
  expect(await screen.findByText('5 accounts')).toBeInTheDocument();
  const reads = (): number => sent('accounts').length;

  // A viewer made an admin: sent with its id, and the list read again.
  const promoted = { ...VIEWER, role: 'admin' } as const;
  list = { now: NOW, accounts: [ADMIN, LEAD, promoted, NEW, DEV] };
  await user.click(within(actionsOf('octo-viewer')).getByRole('button', { name: 'Make admin' }));
  expect(sent('setRole')).toEqual([['setRole', ME.csrf, 3, 'admin']]);
  expect(await within(actionsOf('octo-viewer')).findByRole('button', { name: 'Make viewer' })).toBeInTheDocument();
  expect(textsOf(within(rowOf('octo-viewer')).getAllByRole('cell')[2]!)).toEqual(['Admin']);
  expect(reads()).toBe(2);
  expect(screen.queryByRole('alert')).toBeNull();

  // A password reset: its one-time password shown once, and the list read again.
  await user.click(within(actionsOf('octo-viewer')).getByRole('button', { name: 'Reset password' }));
  expect(sent('resetPassword')).toEqual([['resetPassword', ME.csrf, 3]]);
  const box = await screen.findByRole('status');
  expect(classes(box)).toEqual(words(boxClasses));
  expect(within(box).getByText('One-time password for octo-viewer')).toBeInTheDocument();
  expect(within(box).getByText('p3n8w2x7k4r9t5b6m2qz').tagName).toBe('CODE');
  expect(within(box).getByText('Shown once. octo-viewer signs in with it once, then chooses a password. It expires 2026-03-04 10:05 UTC.')).toBeInTheDocument();
  await act(async () => {});
  expect(reads()).toBe(3);

  // A copy refused says so, and the button keeps its word; one that works then says Copied, and the refusal goes.
  const refuse = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
  await user.click(within(box).getByRole('button', { name: 'Copy' }));
  expect(refuse).toHaveBeenCalledWith('p3n8w2x7k4r9t5b6m2qz');
  const refused = await within(box).findByText(REFUSED_COPY);
  expect(refused.tagName).toBe('P');
  expect(classes(refused)).toEqual(words('text-[13px] text-bad'));
  expect(refused.parentElement).toBe(box);
  expect(within(box).getAllByRole('button').map((each) => each.textContent)).toEqual(['Copy', 'Done']);
  await user.click(within(box).getByRole('button', { name: 'Copy' }));
  expect(await navigator.clipboard.readText()).toBe('p3n8w2x7k4r9t5b6m2qz');
  expect(await within(box).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  expect(within(box).getAllByRole('button').map((each) => each.textContent)).toEqual(['Copied', 'Done']);
  expect(within(box).queryByText(REFUSED_COPY)).toBeNull();
  await user.click(within(box).getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('status')).toBeNull();

  // Remove asks first, in the row; Cancel sends nothing.
  await user.click(within(actionsOf('octo-new')).getByRole('button', { name: 'Remove' }));
  const actions = actionsOf('octo-new');
  const ask = within(actions).getByText('Remove octo-new? Their sessions end at once.');
  expect(ask.tagName).toBe('SPAN');
  expect(classes(ask)).toEqual(words('text-[13px]'));
  expect(classes(ask.parentElement)).toEqual(words('flex flex-wrap items-center gap-2'));
  expect(ask.parentElement?.parentElement).toBe(actions);
  const confirm = within(actions).getByRole('button', { name: 'Remove' });
  const cancel = within(actions).getByRole('button', { name: 'Cancel' });
  expect(classes(confirm)).toEqual(words(primary));
  expect(classes(cancel)).toEqual(words(button));
  expect(within(actions).getAllByRole('button')).toEqual([confirm, cancel]);
  expect(follows(ask, confirm) && follows(confirm, cancel)).toBe(true);
  // The other rows keep their actions; one asked in another row takes the question there.
  expect(textsOf(actionsOf('octo-dev'))).toEqual(['Make admin', 'Remove']);
  await user.click(within(actionsOf('octo-dev')).getByRole('button', { name: 'Remove' }));
  expect(textsOf(actionsOf('octo-dev'))).toEqual(['Remove octo-dev? Their sessions end at once.', 'Remove', 'Cancel']);
  expect(textsOf(actionsOf('octo-new'))).toEqual(['Make admin', 'Reset password', 'Remove']);
  await user.click(within(actionsOf('octo-dev')).getByRole('button', { name: 'Cancel' }));
  expect(textsOf(actionsOf('octo-dev'))).toEqual(['Make admin', 'Remove']);
  expect(sent('removeAccount')).toEqual([]);
  expect(reads()).toBe(3);

  // Asked and confirmed: removed by its id, and the list read again.
  list = { now: NOW, accounts: [ADMIN, LEAD, promoted, DEV] };
  await user.click(within(actionsOf('octo-new')).getByRole('button', { name: 'Remove' }));
  await user.click(within(actionsOf('octo-new')).getByRole('button', { name: 'Remove' }));
  expect(sent('removeAccount')).toEqual([['removeAccount', ME.csrf, 4]]);
  expect(await screen.findByText('4 accounts')).toBeInTheDocument();
  expect(within(section()).queryByText('octo-new')).toBeNull();
  expect(reads()).toBe(4);
  expect(screen.queryByRole('alert')).toBeNull();

  // The last admin made a viewer: refused, said above the table, and not read again.
  await user.click(within(actionsOf('octo-admin')).getByRole('button', { name: 'Make viewer' }));
  expect(sent('setRole')).toEqual([['setRole', ME.csrf, 3, 'admin'], ['setRole', ME.csrf, 1, 'viewer']]);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(LAST_ADMIN);
  expect(classes(alert)).toEqual(words(alertClasses));
  expect(follows(alert, within(section()).getByRole('table'))).toBe(true);
  await act(async () => {});
  expect(reads()).toBe(4);

  // An account removed meanwhile: said in its place, and the list read again.
  list = { now: NOW, accounts: [ADMIN, LEAD, promoted] };
  await user.click(within(actionsOf('octo-dev')).getByRole('button', { name: 'Remove' }));
  await user.click(within(actionsOf('octo-dev')).getByRole('button', { name: 'Remove' }));
  expect(sent('removeAccount')).toEqual([['removeAccount', ME.csrf, 4], ['removeAccount', ME.csrf, 5]]);
  expect(await screen.findByText('3 accounts')).toBeInTheDocument();
  expect(screen.getAllByRole('alert').map((each) => each.textContent)).toEqual([NOT_FOUND]);
  expect(reads()).toBe(5);

  // A change that works takes the alert away.
  list = { now: NOW, accounts: [ADMIN, LEAD, VIEWER] };
  roles.push(() => Promise.resolve({ account: VIEWER }));
  await user.click(within(actionsOf('octo-viewer')).getByRole('button', { name: 'Make viewer' }));
  expect(await within(actionsOf('octo-viewer')).findByRole('button', { name: 'Make admin' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(sent('setRole').at(-1)).toEqual(['setRole', ME.csrf, 3, 'viewer']);
  expect(reads()).toBe(6);
});

test('reading, a failed read and Try again', async () => {
  vi.useFakeTimers();
  visit('/ui/settings');
  const first = later<Accounts>();
  const again = later<Accounts>();
  const answers: (() => Promise<Accounts>)[] = [() => first.promise, () => again.promise];
  const { api, sent } = fakeApi({ accounts: () => answers.shift()!() });
  render(<App api={api} />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const reads = (): number => sent('accounts').length;

  // The first read.
  const reading = screen.getByText('Reading the accounts.');
  expect(reading.tagName).toBe('P');
  expect(classes(reading)).toEqual(words('px-5 py-3 text-sm text-muted'));
  expect(reading.parentElement).toBe(section());
  expect(within(section()).queryByRole('table')).toBeNull();
  expect(section().querySelector('[data-slot="badge"]')).toBeNull();
  expect(within(section()).getByRole('button', { name: 'New account' })).toBeInTheDocument();
  expect(reads()).toBe(1);

  // A failed read, and Try again.
  await act(async () => first.reject(new RequestFailed(500, 'internal_error')));
  const failed = screen.getByText('The accounts could not be read.');
  expect(failed.tagName).toBe('P');
  expect(classes(failed)).toEqual(words('text-sm text-muted'));
  expect(classes(failed.parentElement)).toEqual(words('flex flex-wrap items-center gap-3 px-5 py-3'));
  expect(failed.parentElement?.parentElement).toBe(section());
  const tryAgain = within(section()).getByRole('button', { name: 'Try again' });
  expect(tryAgain).toHaveAttribute('type', 'button');
  expect(classes(tryAgain)).toEqual(words(button));
  expect(tryAgain.parentElement).toBe(failed.parentElement);
  expect(screen.queryByText('Reading the accounts.')).toBeNull();
  expect(within(section()).queryByRole('table')).toBeNull();
  expect(section().querySelector('[data-slot="badge"]')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();

  fireEvent.click(tryAgain);
  expect(screen.getByText('Reading the accounts.')).toBeInTheDocument();
  expect(screen.queryByText('The accounts could not be read.')).toBeNull();
  expect(reads()).toBe(2);

  // No row: one cell says so.
  await act(async () => again.resolve({ now: NOW, accounts: [] }));
  const empty = within(section()).getByRole('cell', { name: 'No account yet.' });
  expect(empty).toHaveAttribute('colspan', '6');
  expect(classes(empty)).toEqual(words(cell, 'text-muted'));
  expect(within(section()).getAllByRole('row')).toHaveLength(2);
  expect(within(section()).getAllByRole('columnheader').map((column) => column.textContent)).toEqual(COLUMNS);
  expect(classes(within(section()).getByText('0 accounts'))).toEqual(words(badge, muted));
  expect(screen.queryByText('Reading the accounts.')).toBeNull();

  // It is not polled.
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(reads()).toBe(2);
});

test('a one-time password shown is in neither the address nor the history, after a make and after a reset', async () => {
  visit('/ui/settings');
  const reset: OneTime = { account: VIEWER, oneTimePassword: 'p3n8w2x7k4r9t5b6m2qz', expiresAt: '2026-03-04T10:05:00.000Z' };
  const { api } = fakeApi({ accounts: () => Promise.resolve(LIST), makeAccount: () => Promise.resolve(ONE_TIME), resetPassword: () => Promise.resolve(reset) });
  const user = userEvent.setup();
  render(<App api={api} />);
  expect(await screen.findByText('5 accounts')).toBeInTheDocument();
  const entries = window.history.length;
  /** Right after a box shows: the address is the page's, the history has no entry more, and its entry holds no password. */
  const clean = (secret: string): void => {
    expect(window.location.href).toBe('http://localhost:3000/ui/settings');
    expect(window.history.length).toBe(entries);
    expect(JSON.stringify(window.history.state ?? null)).not.toContain(secret);
  };

  await user.click(screen.getByRole('button', { name: 'New account' }));
  await user.type(screen.getByLabelText('Name'), 'octo-viewer');
  await user.click(screen.getByRole('button', { name: 'Make the account' }));
  expect(within(screen.getByRole('status')).getByText(PASSWORD)).toBeInTheDocument();
  clean(PASSWORD);
  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Done' }));

  await user.click(within(actionsOf('octo-viewer')).getByRole('button', { name: 'Reset password' }));
  expect(within(screen.getByRole('status')).getByText('p3n8w2x7k4r9t5b6m2qz')).toBeInTheDocument();
  clean('p3n8w2x7k4r9t5b6m2qz');
});

test('one change at a time: a double click sends once, and so do two clicks before the page is drawn again', async () => {
  visit('/ui/settings');
  const first = later<AccountAnswer>();
  const answers: (() => Promise<AccountAnswer>)[] = [() => first.promise, () => new Promise<AccountAnswer>(() => {})];
  const { api, sent } = fakeApi({ accounts: () => Promise.resolve(LIST), setRole: () => answers.shift()!() });
  const user = userEvent.setup();
  render(<App api={api} />);
  expect(await screen.findByText('5 accounts')).toBeInTheDocument();

  await user.dblClick(within(actionsOf('octo-viewer')).getByRole('button', { name: 'Make admin' }));
  expect(sent('setRole')).toEqual([['setRole', ME.csrf, 3, 'admin']]);
  await act(async () => first.resolve({ account: { ...VIEWER, role: 'admin' } }));

  // Two clicks in one go, before the page is drawn again with its buttons disabled: the second sends nothing.
  const dev = within(actionsOf('octo-dev')).getByRole('button', { name: 'Make admin' });
  expect(dev).toBeEnabled();
  act(() => {
    dev.click();
    dev.click();
  });
  expect(sent('setRole')).toEqual([['setRole', ME.csrf, 3, 'admin'], ['setRole', ME.csrf, 5, 'admin']]);
});

test('a change sent closes the removal asked, whether it is that removal or a change in another row', async () => {
  visit('/ui/settings');
  const { api, sent } = fakeApi({
    accounts: () => Promise.resolve(LIST),
    setRole: () => Promise.resolve({ account: { ...VIEWER, role: 'admin' } }),
    removeAccount: () => Promise.reject(new RequestFailed(500, 'internal_error')),
  });
  const user = userEvent.setup();
  render(<App api={api} />);
  expect(await screen.findByText('5 accounts')).toBeInTheDocument();

  // Asked in octo-dev's row, then a change sent in octo-viewer's: the question is gone.
  await user.click(within(actionsOf('octo-dev')).getByRole('button', { name: 'Remove' }));
  expect(textsOf(actionsOf('octo-dev'))).toEqual(['Remove octo-dev? Their sessions end at once.', 'Remove', 'Cancel']);
  await user.click(within(actionsOf('octo-viewer')).getByRole('button', { name: 'Make admin' }));
  expect(sent('setRole')).toEqual([['setRole', ME.csrf, 3, 'admin']]);
  expect(textsOf(actionsOf('octo-dev'))).toEqual(['Make admin', 'Remove']);

  // The removal itself, sent and refused: the question is gone too, the refusal said.
  await user.click(within(actionsOf('octo-new')).getByRole('button', { name: 'Remove' }));
  await user.click(within(actionsOf('octo-new')).getByRole('button', { name: 'Remove' }));
  expect(sent('removeAccount')).toEqual([['removeAccount', ME.csrf, 4]]);
  expect(await screen.findByRole('alert')).toHaveTextContent(FAILED);
  expect(textsOf(actionsOf('octo-new'))).toEqual(['Make admin', 'Reset password', 'Remove']);
});

test('the form\'s Cancel takes the alert away with it', async () => {
  visit('/ui/settings');
  const { api, sent } = fakeApi({ accounts: () => Promise.resolve(LIST) });
  const user = userEvent.setup();
  render(<App api={api} />);
  expect(await screen.findByText('5 accounts')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'New account' }));
  await user.type(screen.getByLabelText('Name'), 'Octo-Viewer');
  await user.click(screen.getByRole('button', { name: 'Make the account' }));
  expect(screen.getByRole('alert')).toHaveTextContent(BAD_NAME);

  await user.click(within(screen.getByRole('form', { name: 'New account' })).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('form', { name: 'New account' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(sent('makeAccount')).toEqual([]);
});

test('a read again that fails after a change drops the table it would have replaced', async () => {
  visit('/ui/settings');
  const answers: (() => Promise<Accounts>)[] = [() => Promise.resolve(LIST), () => Promise.reject(new RequestFailed(500, 'internal_error'))];
  const { api, sent } = fakeApi({ accounts: () => answers.shift()!(), setRole: () => Promise.resolve({ account: { ...VIEWER, role: 'admin' } }) });
  const user = userEvent.setup();
  render(<App api={api} />);
  expect(await screen.findByText('5 accounts')).toBeInTheDocument();

  await user.click(within(actionsOf('octo-viewer')).getByRole('button', { name: 'Make admin' }));
  expect(await screen.findByText('The accounts could not be read.')).toBeInTheDocument();
  expect(sent('accounts')).toHaveLength(2);
  expect(within(section()).queryByRole('table')).toBeNull();
  expect(within(section()).queryByText('octo-viewer')).toBeNull();
  expect(section().querySelector('[data-slot="badge"]')).toBeNull();
  expect(within(section()).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
});

test('a copy that ends after another one-time password replaced its own marks nothing', async () => {
  visit('/ui/settings');
  const user = userEvent.setup();
  const reset: OneTime = { account: NEW, oneTimePassword: 'p3n8w2x7k4r9t5b6m2qz', expiresAt: '2026-03-04T10:05:00.000Z' };
  const { api } = fakeApi({ accounts: () => Promise.resolve(LIST), makeAccount: () => Promise.resolve(ONE_TIME), resetPassword: () => Promise.resolve(reset) });
  render(<App api={api} />);
  expect(await screen.findByText('5 accounts')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'New account' }));
  await user.type(screen.getByLabelText('Name'), 'octo-viewer');
  await user.click(screen.getByRole('button', { name: 'Make the account' }));
  expect(within(screen.getByRole('status')).getByText(PASSWORD)).toBeInTheDocument();

  // Copy is pressed for octo-viewer's, and ends once octo-new's reset has replaced it on screen.
  const copied = later<void>();
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockImplementationOnce(() => copied.promise);
  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Copy' }));
  expect(write).toHaveBeenCalledWith(PASSWORD);
  await user.click(within(actionsOf('octo-new')).getByRole('button', { name: 'Reset password' }));
  const box = screen.getByRole('status');
  expect(within(box).getByText('One-time password for octo-new')).toBeInTheDocument();
  await act(async () => copied.resolve());
  expect(within(box).getAllByRole('button').map((each) => each.textContent)).toEqual(['Copy', 'Done']);
  expect(within(box).queryByText(REFUSED_COPY)).toBeNull();

  // Its own Copy still marks it.
  await user.click(within(box).getByRole('button', { name: 'Copy' }));
  expect(await within(box).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
});

test('every row\'s buttons are described by the row\'s name, and the help line describes the name to type', async () => {
  visit('/ui/settings');
  const { api } = fakeApi({ accounts: () => Promise.resolve(LIST) });
  const user = userEvent.setup();
  render(<App api={api} />);
  expect(await screen.findByText('5 accounts')).toBeInTheDocument();

  /** Each button of the row of `name` is described by the row's name, held in that row. */
  const described = (name: string): void => {
    const buttons = within(actionsOf(name)).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button).toHaveAccessibleDescription(name);
      const by = document.getElementById(button.getAttribute('aria-describedby') ?? '');
      expect(by?.textContent).toBe(name);
      expect(rowOf(name).contains(by)).toBe(true);
    }
  };
  for (const { name } of LIST.accounts) described(name);
  // The question's buttons too.
  await user.click(within(actionsOf('octo-dev')).getByRole('button', { name: 'Remove' }));
  expect(within(actionsOf('octo-dev')).getAllByRole('button').map((each) => each.textContent)).toEqual(['Remove', 'Cancel']);
  described('octo-dev');

  await user.click(screen.getByRole('button', { name: 'New account' }));
  const name = screen.getByLabelText('Name');
  expect(name).toHaveAccessibleDescription(HELP);
  expect(document.getElementById(name.getAttribute('aria-describedby') ?? '')?.tagName).toBe('P');
});

test('focus goes where the control that had it went: New account to the name, Done and Cancel back to their button', async () => {
  visit('/ui/settings');
  const reset: OneTime = { account: VIEWER, oneTimePassword: 'p3n8w2x7k4r9t5b6m2qz', expiresAt: '2026-03-04T10:05:00.000Z' };
  const { api } = fakeApi({ accounts: () => Promise.resolve(LIST), makeAccount: () => Promise.resolve(ONE_TIME), resetPassword: () => Promise.resolve(reset) });
  const user = userEvent.setup();
  render(<App api={api} />);
  expect(await screen.findByText('5 accounts')).toBeInTheDocument();

  // New account opens the form on its Name; Cancel goes back to New account.
  await user.click(screen.getByRole('button', { name: 'New account' }));
  expect(screen.getByLabelText('Name')).toHaveFocus();
  await user.click(within(screen.getByRole('form', { name: 'New account' })).getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: 'New account' })).toHaveFocus();

  // A make's one-time password: Done goes back to New account.
  await user.click(screen.getByRole('button', { name: 'New account' }));
  await user.type(screen.getByLabelText('Name'), 'octo-viewer');
  await user.click(screen.getByRole('button', { name: 'Make the account' }));
  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('button', { name: 'New account' })).toHaveFocus();

  // A reset's: Done goes back to the row's Reset password.
  await user.click(within(actionsOf('octo-viewer')).getByRole('button', { name: 'Reset password' }));
  expect(await within(screen.getByRole('status')).findByText('p3n8w2x7k4r9t5b6m2qz')).toBeInTheDocument();
  await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Done' }));
  expect(within(actionsOf('octo-viewer')).getByRole('button', { name: 'Reset password' })).toHaveFocus();

  // A removal asked: on its Cancel; then Cancel: back to the row's Remove.
  await user.click(within(actionsOf('octo-dev')).getByRole('button', { name: 'Remove' }));
  expect(within(actionsOf('octo-dev')).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  await user.click(within(actionsOf('octo-dev')).getByRole('button', { name: 'Cancel' }));
  expect(within(actionsOf('octo-dev')).getByRole('button', { name: 'Remove' })).toHaveFocus();
});

test('after name_taken, or a make whose answer was lost, the list is read again', async () => {
  visit('/ui/settings');
  // Each refusal of a make, and whether the account may have been made: read again after it.
  const refusals: [RequestFailed | TypeError, boolean][] = [
    [new RequestFailed(409, 'name_taken'), true],
    [new RequestFailed(0, 'network'), true],
    [new RequestFailed(500, 'internal_error'), true],
    [new RequestFailed(502, 'unknown'), true],
    [new RequestFailed(503, 'unknown'), true],
    [new RequestFailed(201, 'unreadable'), true],
    [new RequestFailed(400, 'bad_name'), false],
    [new RequestFailed(409, 'full'), false],
    [new RequestFailed(400, 'bad_request'), false],
    [new RequestFailed(403, 'csrf'), false],
    [new TypeError('Failed to fetch'), false],
  ];
  const answers = refusals.map(([error]) => () => Promise.reject(error));
  const { api, sent } = fakeApi({ accounts: () => Promise.resolve(LIST), makeAccount: () => answers.shift()!() });
  const user = userEvent.setup();
  render(<App api={api} />);
  expect(await screen.findByText('5 accounts')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'New account' }));

  for (const [error, again] of refusals) {
    const before = sent('accounts').length;
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'octo-viewer' } });
    await user.click(screen.getByRole('button', { name: 'Make the account' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await act(async () => {});
    expect([String(error), sent('accounts').length - before]).toEqual([String(error), again ? 1 : 0]);
  }
  expect(sent('makeAccount')).toHaveLength(refusals.length);
  // The table read again stays, the form open.
  expect(screen.getByText('5 accounts')).toBeInTheDocument();
  expect(screen.getByRole('form', { name: 'New account' })).toBeInTheDocument();
});

test('focus goes to Copy after a make that works, and to New account after a confirmed removal', async () => {
  visit('/ui/settings');
  const { api } = fakeApi({ accounts: () => Promise.resolve(LIST), makeAccount: () => Promise.resolve(ONE_TIME), removeAccount: () => Promise.resolve() });
  const user = userEvent.setup();
  render(<App api={api} />);
  expect(await screen.findByText('5 accounts')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'New account' }));
  await user.type(screen.getByLabelText('Name'), 'octo-viewer');
  await user.click(screen.getByRole('button', { name: 'Make the account' }));
  expect(await within(screen.getByRole('status')).findByText(PASSWORD)).toBeInTheDocument();
  expect(within(screen.getByRole('status')).getByRole('button', { name: 'Copy' })).toHaveFocus();

  await user.click(within(actionsOf('octo-dev')).getByRole('button', { name: 'Remove' }));
  await user.click(within(actionsOf('octo-dev')).getByRole('button', { name: 'Remove' }));
  expect(await screen.findByRole('button', { name: 'New account' })).toHaveFocus();
});
