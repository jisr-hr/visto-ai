import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { RequestFailed } from '../api.ts';
import type { Api, MemoryQuery } from '../api.ts';
import type { Activity, MemoryRecordShown, MemoryView, Me, Reviews } from '../api-types.ts';
import { App } from '../app.tsx';

const NOW = '2026-03-01T10:00:00.000Z';
const ME: Me = { name: 'octo-lead', kind: 'github', role: 'admin', csrf: 'csrf-token-for-tests', mode: 'live', repositories: ['acme/shop', 'acme/web'] };
const VIEWER: Me = { ...ME, name: 'octo-viewer', role: 'viewer' };
const ACTIVITY: Activity = { now: NOW, places: { reviews: 2, withdrawals: 2 }, paused: null, jobs: [], withdrawals: [] };
const REVIEWS: Reviews = { now: NOW, windowDays: 30, total: 0, reviews: [], next: null };

/** An API that answers what `over` says for a method, canned values for the layout's reads, and rejects any other; records each call. */
function fakeApi(over: Partial<Record<keyof Api, (...args: unknown[]) => Promise<unknown>>> = {}) {
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
  const memoryCalls = (): unknown[] => calls.filter(([name]) => name === 'memory').map(([, query]) => query);
  return { api, calls, memoryCalls };
}

function record(over: Partial<MemoryRecordShown> & Pick<MemoryRecordShown, 'id' | 'kind'>): MemoryRecordShown {
  return {
    repository: 'acme/shop', number: 104, text: '', path: 'src/cart/price.ts', directory: null, by: null, reverted: null,
    createdAt: '2026-11-12T08:30:00.000Z', expiresAt: '2027-05-11T08:30:00.000Z', on: true, ...over,
  };
}
const SIGNAL = record({ id: 1, kind: 'human_signal', text: 'Rounds after tax, not before', by: 'octo-lead' });
const REVERT = record({ id: 2, kind: 'revert', number: 70, reverted: 68, path: 'src/tax/table.ts' });
const LESSON = record({ id: 3, kind: 'lesson', number: 188, text: 'Do not flag the cache key here', path: null, directory: 'src/cache', on: false });

function view(over: Partial<MemoryView> = {}): MemoryView {
  return {
    now: NOW, learning: { on: true, ranAt: new Date(Date.parse(NOW) - 180_000).toISOString() },
    counts: { signals: 146, signalRepositories: 4, reverts: 5, lessons: 12, off: 1 }, total: 3, records: [SIGNAL, REVERT, LESSON], next: null, ...over,
  };
}

function open(api: Api) {
  window.history.replaceState(null, '', '/ui/memory');
  return render(<App api={api} />);
}
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const classes = (element: Element | null | undefined): string[] => [...(element?.classList ?? [])].sort();
const rowOf = (text: string): HTMLElement => screen.getByText(text).closest('tr') as HTMLElement;

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

test('the records show their kind, text, place, source, dates and state', async () => {
  const { api } = fakeApi({ memory: () => Promise.resolve(view()) });
  open(api);

  expect(await screen.findByText('Rounds after tax, not before')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: 'Memory' })).toBeInTheDocument();
  const columns = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
  expect(columns).toEqual(['Record', 'Where', 'From', 'Made', 'Expires', 'Shown to reviews']);

  const signal = within(rowOf('Rounds after tax, not before'));
  expect(signal.getByText('A person stepped in')).toBeInTheDocument();
  expect(signal.getByText('Rounds after tax, not before').closest('bdi')).not.toBeNull();
  expect(signal.getByText('src/cart/price.ts')).toBeInTheDocument();
  expect(signal.getByText('acme/shop')).toBeInTheDocument();
  expect(signal.getByText(/#104, by/)).toHaveTextContent('#104, by octo-lead');
  expect(signal.getByText('Nov 12')).toBeInTheDocument();
  expect(signal.getByText('May 11')).toBeInTheDocument();
  expect(signal.getByText('On')).toBeInTheDocument();
  expect(signal.getByRole('switch', { name: 'Turn off: src/cart/price.ts' })).toHaveAttribute('aria-checked', 'true');
  expect(classes(rowOf('Rounds after tax, not before'))).not.toContain('[&>td]:opacity-60');
  expect(classes(signal.getByText('A person stepped in'))).toContain('self-start');

  const revert = within(rowOf('This file was part of a pull request that was reverted.'));
  expect(revert.getByText('Reverted')).toBeInTheDocument();
  expect(revert.getByText('#70 reverted #68')).toBeInTheDocument();
  expect(revert.getByText('src/tax/table.ts')).toBeInTheDocument();

  const lessonRow = rowOf('Do not flag the cache key here');
  const lesson = within(lessonRow);
  expect(lesson.getByText('Lesson')).toBeInTheDocument();
  expect(lesson.getByText('A reply on #188')).toBeInTheDocument();
  // The directory stands where the path is none.
  expect(lesson.getByText('src/cache')).toBeInTheDocument();
  expect(lesson.getByText('Off')).toBeInTheDocument();
  expect(classes(lessonRow)).toContain('[&>td]:opacity-60');
  expect(lesson.getByRole('switch', { name: 'Turn on: src/cache' })).toHaveAttribute('aria-checked', 'false');

  expect(screen.getByText('3 of 3 records')).toBeInTheDocument();
  expect(screen.getByText(/Nothing learned can lower a score\.$/)).toBeInTheDocument();
});

test('a person commenting with no words is said, and a login is shown as text', async () => {
  const { api } = fakeApi({ memory: () => Promise.resolve(view({ records: [record({ id: 9, kind: 'human_signal', text: '', by: '<b>x</b>' })], total: 1 })) });
  open(api);

  const row = within(await screen.findByText('A person commented on these lines.').then((cell) => cell.closest('tr') as HTMLElement));
  expect(row.getByText('<b>x</b>').tagName).toBe('BDI');
  expect(screen.getByText('1 of 1 record')).toBeInTheDocument();
});

test('an admin switches a record, which is then read again', async () => {
  let on = true;
  const { api, calls, memoryCalls } = fakeApi({
    memory: () => Promise.resolve(view({ records: [{ ...SIGNAL, on }] })),
    switchMemory: (...args: unknown[]) => {
      on = args[2] as boolean;
      return Promise.resolve({ record: { ...SIGNAL, on } });
    },
  });
  const user = userEvent.setup();
  open(api);

  await user.click(await screen.findByRole('switch', { name: 'Turn off: src/cart/price.ts' }));
  expect(calls.filter(([name]) => name === 'switchMemory')).toEqual([['switchMemory', 'csrf-token-for-tests', 1, false]]);
  expect(await screen.findByRole('switch', { name: 'Turn on: src/cart/price.ts' })).toHaveAttribute('aria-checked', 'false');
  expect(memoryCalls()).toEqual([{}, {}]);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a refused switch says so, and the record stays as it was', async () => {
  const { api } = fakeApi({
    memory: () => Promise.resolve(view({ records: [SIGNAL] , total: 1 })),
    switchMemory: () => Promise.reject(new RequestFailed(403, 'forbidden')),
  });
  const user = userEvent.setup();
  open(api);

  await user.click(await screen.findByRole('switch', { name: 'Turn off: src/cart/price.ts' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The record could not be switched.');
  expect(classes(alert)).toEqual(['m-0', 'pt-3', 'px-5', 'text-bad', 'text-sm']);
  const again = screen.getByRole('switch', { name: 'Turn off: src/cart/price.ts' });
  expect(again).toHaveAttribute('aria-checked', 'true');
  expect(again).toBeEnabled();
});

test('a viewer sees every switch disabled, and why', async () => {
  const { api, calls } = fakeApi({ me: () => Promise.resolve(VIEWER), memory: () => Promise.resolve(view()) });
  open(api);

  const switches = await screen.findAllByRole('switch');
  expect(switches).toHaveLength(3);
  for (const one of switches) expect(one).toBeDisabled();
  expect(screen.getByText(/Only an admin can turn a record on or off\.$/)).toBeInTheDocument();
  expect(calls.some(([name]) => name === 'switchMemory')).toBe(false);
});

test('the kind, the repository and the search are sent to the server, and paging goes forward and back', async () => {
  // Driven with fireEvent: Testing Library's async wrapper waits on a timer that a fake clock never runs.
  vi.useFakeTimers();
  const pageOf = (query: MemoryQuery): MemoryView => view({ total: 120, next: query.before === undefined ? 51 : query.before === 51 ? 12 : null });
  const { api, memoryCalls } = fakeApi({ memory: (...args: unknown[]) => Promise.resolve(pageOf(args[0] as MemoryQuery)) });
  open(api);
  await settle();
  const press = async (button: HTMLElement) => {
    fireEvent.click(button);
    await settle();
  };
  const kinds = screen.getByRole('group', { name: 'Kind' });
  expect(within(kinds).getAllByRole('button').map((button) => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([
    ['All', 'true'], ['People stepped in', 'false'], ['Reverts', 'false'], ['Lessons', 'false'],
  ]);
  expect(memoryCalls()).toEqual([{}]);

  await press(within(kinds).getByRole('button', { name: 'Lessons' }));
  expect(memoryCalls().at(-1)).toEqual({ kind: 'lesson' });
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'acme/shop' } });
  await settle();
  expect(memoryCalls().at(-1)).toEqual({ kind: 'lesson', repo: 'acme/shop' });

  const key = (value: string) => fireEvent.change(screen.getByLabelText('Search records'), { target: { value } });
  key('c');
  await act(() => vi.advanceTimersByTimeAsync(100));
  key('cart');
  await act(() => vi.advanceTimersByTimeAsync(299));
  expect(memoryCalls()).toHaveLength(3);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(memoryCalls()).toHaveLength(4);
  expect(memoryCalls().at(-1)).toEqual({ kind: 'lesson', repo: 'acme/shop', q: 'cart' });
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(memoryCalls()).toHaveLength(4);

  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  await press(screen.getByRole('button', { name: 'Next' }));
  expect(memoryCalls().at(-1)).toEqual({ kind: 'lesson', repo: 'acme/shop', q: 'cart', before: 51 });
  await press(screen.getByRole('button', { name: 'Next' }));
  expect(memoryCalls().at(-1)).toEqual({ kind: 'lesson', repo: 'acme/shop', q: 'cart', before: 12 });
  await press(screen.getByRole('button', { name: 'Previous' }));
  expect(memoryCalls().at(-1)).toEqual({ kind: 'lesson', repo: 'acme/shop', q: 'cart', before: 51 });
  await press(screen.getByRole('button', { name: 'Previous' }));
  expect(memoryCalls().at(-1)).toEqual({ kind: 'lesson', repo: 'acme/shop', q: 'cart' });
  // A filter change starts again from the first page.
  await press(screen.getByRole('button', { name: 'Next' }));
  await press(within(kinds).getByRole('button', { name: 'Reverts' }));
  expect(memoryCalls().at(-1)).toEqual({ kind: 'revert', repo: 'acme/shop', q: 'cart' });
});

test('learning and the counts are said, and so are an empty and a failed list', async () => {
  const first = fakeApi({ memory: () => Promise.resolve(view()) });
  const on = open(first.api);
  expect(await screen.findByText('Learning is on')).toBeInTheDocument();
  expect(screen.getByText('Last pass 3 min ago')).toBeInTheDocument();
  const counts = within(screen.getByRole('region', { name: 'Records' }));
  expect(counts.getByText('146')).toBeInTheDocument();
  expect(counts.getByText('across 4 repositories')).toBeInTheDocument();
  expect(counts.getByText('files of reverted pull requests')).toBeInTheDocument();
  expect(counts.getByText('from replies to findings')).toBeInTheDocument();
  expect(counts.getByText('shown to no review')).toBeInTheDocument();
  expect(classes(counts.getByText('146'))).toEqual(['font-semibold', 'text-[26px]']);
  on.unmount();

  const off = fakeApi({ memory: () => Promise.resolve(view({ learning: { on: false, ranAt: null }, counts: { signals: 1, signalRepositories: 1, reverts: 0, lessons: 0, off: 0 }, records: [], total: 0 })) });
  const second = open(off.api);
  expect(await screen.findByText('Learning is off')).toBeInTheDocument();
  expect(screen.getByText('No record is made, and none is shown to reviews.')).toBeInTheDocument();
  expect(screen.getByText('across 1 repository')).toBeInTheDocument();
  expect(screen.getByText('No record yet.')).toBeInTheDocument();
  second.unmount();

  const never = fakeApi({ memory: () => Promise.resolve(view({ learning: { on: true, ranAt: null }, records: [], total: 0 })) });
  const third = open(never.api);
  expect(await screen.findByText('No pass yet')).toBeInTheDocument();
  third.unmount();

  const user = userEvent.setup();
  const none = fakeApi({ memory: () => Promise.resolve(view({ records: [], total: 0 })) });
  const fourth = open(none.api);
  await user.click(await screen.findByRole('button', { name: 'Reverts' }));
  expect(await screen.findByText('No record matches.')).toBeInTheDocument();
  fourth.unmount();

  const broken = fakeApi({ memory: () => Promise.reject(new RequestFailed(500, 'boom')) });
  open(broken.api);
  expect(await screen.findByText('The records could not be read.')).toBeInTheDocument();
  expect(screen.getByText('What the service learned from people, reverts and replies, told to later reviews as context')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('Learning is on')).toBeNull();
});
