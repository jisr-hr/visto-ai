import { render, screen, within, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RequestFailed } from '../api.ts';
import type { Api } from '../api.ts';
import type { Me, SettingChangeRow, SettingChanges } from '../api-types.ts';
import { AppContext } from '../context.tsx';
import { ChangesSection, ExportSection } from './settings-record.tsx';

const ME: Me = { name: 'octo-admin', kind: 'password', role: 'admin', csrf: 'csrf-1', mode: 'live', repositories: [] };

const ROW_UI: SettingChangeRow = { id: 9, at: '2026-03-01T09:30:00.000Z', by: 'ui', name: 'octo-admin', scope: 'global', path: 'limits.spendPerDay', before: '50', after: '40' };
const ROW_FILE: SettingChangeRow = { id: 8, at: '2026-03-01T09:00:00.000Z', by: 'config.yml', name: null, scope: 'acme/shop', path: 'gate.mode', before: null, after: '"block"' };
const ROW_OLD: SettingChangeRow = { id: 3, at: '2026-02-20T08:05:00.000Z', by: 'ui', name: 'octo-lead', scope: 'global', path: 'model.zzz', before: '1', after: '<b>2</b>' };

function apiOf(over: Partial<Api>): Api {
  return over as Api;
}
function renderWith(over: Partial<Api>, ui: React.ReactElement) {
  return render(<AppContext.Provider value={{ api: apiOf(over), me: ME, activity: null, activityFailed: false }}>{ui}</AppContext.Provider>);
}

const TEXT = 'limits:\n  spendPerDay: 40\n';

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true });
});
afterEach(() => vi.restoreAllMocks());

test('the changes are listed newest first, with who made them, where, and before and after', async () => {
  const first: SettingChanges = { changes: [ROW_UI, ROW_FILE], next: 3 };
  const settingChanges = vi.fn((before?: number) => Promise.resolve(before === undefined ? first : ({ changes: [ROW_OLD], next: null } as SettingChanges)));
  renderWith({ settingChanges }, <ChangesSection reads={0} />);

  const card = await screen.findByRole('region', { name: 'Changes' });
  expect(card.id).toBe('changes');
  expect(card.className).toBe('overflow-hidden rounded-[12px] border border-border bg-card shadow-card');
  expect(within(card).getByText('The latest first. A change in config.yml is recorded at the start that read it.')).toBeInTheDocument();
  const heads = within(card).getAllByRole('columnheader').map((h) => h.textContent);
  expect(heads).toEqual(['When', 'Who', 'Where', 'Setting', 'Before', 'After']);

  const rows = within(card).getAllByRole('row').slice(1);
  const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent);
  expect(cells(rows[0]!)).toEqual(['2026-03-01 09:30 UTC', 'octo-admin', 'General', 'Daily spend limit', '50', '40']);
  expect(cells(rows[1]!)).toEqual(['2026-03-01 09:00 UTC', 'config.yml', 'acme/shop', 'Gate mode', 'Not set', '"block"']);
  expect(within(rows[1]!).getByText('config.yml').className).toContain('font-mono');
  expect(within(rows[1]!).getByText('Not set').className).toContain('text-muted');
  expect(within(rows[0]!).getByText('50').className).toContain('font-mono');

  await userEvent.click(within(card).getByRole('button', { name: 'Older' }));
  expect(settingChanges).toHaveBeenLastCalledWith(3);
  const more = await within(card).findByText('model.zzz');
  expect(more.className).toContain('font-mono');
  // Values are text, never HTML.
  expect(within(card).getByText('<b>2</b>')).toBeInTheDocument();
  expect(card.querySelector('b')).toBeNull();
  expect(within(card).getAllByRole('row')).toHaveLength(4);
  expect(within(card).queryByRole('button', { name: 'Older' })).toBeNull();
});

test('no change yet, and a failed read, are said', async () => {
  const none = renderWith({ settingChanges: () => Promise.resolve({ changes: [], next: null }) }, <ChangesSection reads={0} />);
  expect(await screen.findByText('No change yet.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Older' })).toBeNull();
  none.unmount();
  renderWith({ settingChanges: () => Promise.reject(new RequestFailed(500, 'x')) }, <ChangesSection reads={0} />);
  expect(await screen.findByText('The changes could not be read.')).toBeInTheDocument();
});

test('the export shows the saved settings as config.yml writes them, and copies them', async () => {
  renderWith({ settingsExport: () => Promise.resolve({ text: TEXT }) }, <ExportSection reads={0} />);
  const card = await screen.findByRole('region', { name: 'In config.yml' });
  expect(card.id).toBe('export');
  const line = within(card).getByText(/^The saved settings, as config.yml writes them\./);
  expect(line.className).toBe('text-[13px] text-muted');
  const pre = card.querySelector('pre')!;
  expect(pre.textContent).toBe(TEXT);
  expect(pre.className).toBe('m-0 overflow-x-auto rounded-lg bg-subtle p-3.5 font-mono text-[12.5px]');

  await userEvent.click(within(card).getByRole('button', { name: 'Copy' }));
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(TEXT);
  expect(await within(card).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
});

test('a refused copy says so, and a failed export read says so', async () => {
  (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no'));
  const first = renderWith({ settingsExport: () => Promise.resolve({ text: TEXT }) }, <ExportSection reads={0} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
  expect(await screen.findByText('The copy was refused: select the text and copy it by hand.')).toBeInTheDocument();
  first.unmount();
  renderWith({ settingsExport: () => Promise.reject(new RequestFailed(500, 'x')) }, <ExportSection reads={0} />);
  expect(await screen.findByText('The text could not be read.')).toBeInTheDocument();
});

test('when reads changes the changes and the export are read again', async () => {
  const settingChanges = vi.fn(() => Promise.resolve({ changes: [ROW_UI], next: null } as SettingChanges));
  const settingsExport = vi.fn(() => Promise.resolve({ text: TEXT }));
  const tree = (reads: number) => (
    <AppContext.Provider value={{ api: { settingChanges, settingsExport } as unknown as Api, me: ME, activity: null, activityFailed: false }}>
      <ChangesSection reads={reads} />
      <ExportSection reads={reads} />
    </AppContext.Provider>
  );
  const view = render(tree(0));
  await screen.findByText('Daily spend limit');
  expect(settingChanges).toHaveBeenCalledTimes(1);
  expect(settingsExport).toHaveBeenCalledTimes(1);
  view.rerender(tree(1));
  await waitFor(() => expect(settingChanges).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(settingsExport).toHaveBeenCalledTimes(2));
});

test('an export that cannot be read again says its text may be old, and Copied goes back to Copy', async () => {
  let fail = false;
  const settingsExport = vi.fn(() => (fail ? Promise.reject(new RequestFailed(500, 'x')) : Promise.resolve({ text: TEXT })));
  const tree = (reads: number) => (
    <AppContext.Provider value={{ api: { settingsExport } as unknown as Api, me: ME, activity: null, activityFailed: false }}>
      <ExportSection reads={reads} />
    </AppContext.Provider>
  );
  const view = render(tree(0));
  await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  expect(screen.queryByText(/could not be read again/)).toBeNull();
  fail = true;
  view.rerender(tree(1));
  expect(await screen.findByText('The text could not be read again. What is shown may be out of date.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  expect(document.querySelector('pre')!.textContent).toBe(TEXT);
});

test('an Older answer that arrives after a save read the changes again is dropped', async () => {
  const fresh: SettingChanges = { changes: [{ ...ROW_UI, id: 10 }, ROW_UI, ROW_FILE], next: 8 };
  let release: (answer: SettingChanges) => void = () => {};
  const slow = new Promise<SettingChanges>((yes) => {
    release = yes;
  });
  const settingChanges = vi.fn((before?: number) => {
    if (before === 3) return slow;
    return Promise.resolve(fresh.changes.length === 3 && settingChanges.mock.calls.length > 2 ? fresh : ({ changes: [ROW_UI, ROW_FILE], next: 3 } as SettingChanges));
  });
  const tree = (reads: number) => (
    <AppContext.Provider value={{ api: { settingChanges } as unknown as Api, me: ME, activity: null, activityFailed: false }}>
      <ChangesSection reads={reads} />
    </AppContext.Provider>
  );
  const view = render(tree(0));
  const card = await screen.findByRole('region', { name: 'Changes' });
  await screen.findByText('Daily spend limit');
  await userEvent.click(within(card).getByRole('button', { name: 'Older' }));
  expect(settingChanges).toHaveBeenLastCalledWith(3);
  // A save read the first page again while Older was out.
  view.rerender(tree(1));
  await waitFor(() => expect(settingChanges).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(within(card).getAllByRole('row')).toHaveLength(4));
  release({ changes: [ROW_OLD], next: null });
  await new Promise((done) => setTimeout(done, 20));
  // Nothing of the late answer: no row twice, the page's own `next` kept.
  expect(within(card).getAllByRole('row')).toHaveLength(4);
  expect(within(card).queryByText('model.zzz')).toBeNull();
  expect(within(card).getByRole('button', { name: 'Older' })).toBeEnabled();
  await userEvent.click(within(card).getByRole('button', { name: 'Older' }));
  expect(settingChanges).toHaveBeenLastCalledWith(8);
});
