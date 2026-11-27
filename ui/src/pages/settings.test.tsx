import { fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { RequestFailed } from '../api.ts';
import type { Api } from '../api.ts';
import type { Activity, Me, Reviews, Setting, SettingSource, SettingsView, SettingValue } from '../api-types.ts';
import { App } from '../app.tsx';
import { LABELS, whereOf } from './settings-parts.tsx';

const NOW = '2026-03-01T10:00:00.000Z';
const ME: Me = { name: 'octo-admin', kind: 'password', role: 'admin', csrf: 'csrf-1', mode: 'live', repositories: ['acme/shop'] };
const ACTIVITY: Activity = { now: NOW, places: { reviews: 2, withdrawals: 2 }, paused: null, jobs: [], withdrawals: [] };
const REVIEWS: Reviews = { now: NOW, windowDays: 30, total: 0, reviews: [], next: null };

const FILE: SettingSource = { by: 'config.yml', name: null, at: '2026-03-01T09:00:00.000Z' };
const UI: SettingSource = { by: 'ui', name: 'octo-admin', at: '2026-03-01T09:30:00.000Z' };
const written = (value: SettingValue, source: SettingSource = FILE, flags: Partial<Setting> = {}): Setting => ({ written: true, value, source, restart: false, waits: false, ...flags });
const byDefault = (value: SettingValue): Setting => ({ written: false, value, source: null, restart: false, waits: false });

const GLOBAL: Record<string, Setting> = {
  dryRun: written(true, FILE, { restart: true, waits: true }),
  learning: written(false, FILE, { restart: true }),
  'limits.spendPerDay': written(40, UI),
  'limits.queueConcurrency': written(2, FILE, { restart: true }),
  'limits.inputTokensPerCall': byDefault(200000),
  'limits.batchesPerReview': byDefault(6),
  'model.baseUrl': written('https://llm.example.test/v1', FILE, { restart: true }),
  'model.model': written('vendor/model-a'),
  'model.fallbacks': written(['vendor/model-b']),
  'model.effort.default': written({}),
  'model.effort.elevated': written({ reasoning: { effort: 'high' } }),
  'model.toolChoice': written('forced', FILE, { restart: true }),
  'model.timeoutSeconds': written(240, FILE, { restart: true }),
  'model.prices': written({ inputPerMillion: 1, cachedInputPerMillion: 0.1, outputPerMillion: 4 }),
  'model.extraBody': byDefault({}),
  'model.extraHeaders': byDefault({}),
  'scorer.model': written('vendor/decision-model', FILE, { restart: true }),
  'scorer.baseUrl': written('https://scorer.example.test/v1', FILE, { restart: true }),
  'scorer.timeoutSeconds': written(120),
};

function viewOf(over: { version?: number; global?: Record<string, Setting>; access?: SettingsView['access']; scorer?: SettingsView['scorer'] } = {}): SettingsView {
  return {
    now: NOW,
    version: over.version ?? 14,
    global: { ...GLOBAL, ...over.global },
    defaults: {},
    repositories: [],
    scorer: over.scorer ?? { on: true, waits: true },
    secrets: [
      { kind: 'model_key', of: null, variable: 'OPENROUTER_API_KEY' },
      { kind: 'scorer_key', of: null, variable: 'SCORER_API_KEY' },
      { kind: 'alert_webhook', of: null, variable: null },
      { kind: 'extension', of: 'example, option secret', variable: 'EXAMPLE_SECRET' },
      { kind: 'mcp_header', of: 'docs', variable: 'DOCS_TOKEN' },
    ],
    access: over.access ?? { publicUrl: 'https://visto.example.test', github: true, accounts: ['octo-lead', 'octo-dev'], team: null },
  };
}
const VIEW = viewOf();

/** An API that answers what `over` answers (every other call fails) and records its calls. */
function fakeApi(over: Partial<Api> = {}) {
  const calls: unknown[][] = [];
  const api: Api = {
    me: () => Promise.resolve(ME),
    activity: () => Promise.resolve(ACTIVITY),
    reviews: () => Promise.resolve(REVIEWS),
    signOut: () => Promise.resolve(),
    ways: () => Promise.resolve({ github: true }),
    passwordSignIn: () => Promise.reject(new RequestFailed(500, 'not_expected')),
    firstPassword: () => Promise.reject(new RequestFailed(500, 'not_expected')),
    changePassword: () => Promise.reject(new RequestFailed(500, 'not_expected')),
    accounts: () => Promise.resolve({ now: NOW, accounts: [] }),
    makeAccount: () => Promise.reject(new RequestFailed(500, 'not_expected')),
    setRole: () => Promise.reject(new RequestFailed(500, 'not_expected')),
    resetPassword: () => Promise.reject(new RequestFailed(500, 'not_expected')),
    removeAccount: () => Promise.reject(new RequestFailed(500, 'not_expected')),
    review: () => Promise.reject(new RequestFailed(404, 'not_found')),
    pullReviews: () => Promise.resolve({ now: NOW, total: 0, reviews: [] }),
    settings: () => {
      calls.push(['settings']);
      return over.settings ? over.settings() : Promise.resolve(VIEW);
    },
    saveSettings: (csrf, save) => {
      calls.push(['saveSettings', csrf, save]);
      return over.saveSettings ? over.saveSettings(csrf, save) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    settingChanges: () => Promise.reject(new RequestFailed(500, 'not_expected')),
    settingsExport: () => Promise.reject(new RequestFailed(500, 'not_expected')),
  };
  const sent = (name: string): unknown[][] => calls.filter(([called]) => called === name);
  return { api, sent };
}

const visit = (address: string): void => window.history.replaceState(null, '', address);
const classes = (element: Element | null | undefined): string[] => [...(element?.classList ?? [])].sort();
const words = (...parts: string[]): string[] => parts.join(' ').split(' ').filter(Boolean).sort();

/** The control's row: the box that holds its label and its control. */
const ctlOf = (control: HTMLElement): HTMLElement => {
  const ctl = control.closest('[data-slot="setting-control"]');
  if (ctl === null) throw new Error('No control box.');
  return ctl as HTMLElement;
};
/** The row of a label's text. */
const rowOf = (label: string): HTMLElement => {
  const row = screen.getByText(label, { selector: 'label, strong' }).closest('[data-slot="setting-row"]');
  if (row === null) throw new Error(`No row for ${label}.`);
  return row as HTMLElement;
};
const section = (name: string): HTMLElement => screen.getByRole('region', { name });

const SUB = 'Saved settings apply from the next review. A review already running keeps the settings it started with.';

afterEach(() => visit('/'));

async function open(over: Partial<Api> = {}) {
  visit('/ui/settings');
  const made = fakeApi(over);
  render(<App api={made.api} />);
  await screen.findByRole('region', { name: 'General' });
  return made;
}

test('Settings shows its header, its sections and their rows as drawn, with where each value came from', async () => {
  await open();

  const title = screen.getByRole('heading', { level: 1, name: 'Settings' });
  expect(screen.getAllByRole('heading', { level: 1 })).toEqual([title]);
  const sub = screen.getByText(SUB);
  expect(sub.tagName).toBe('P');
  const line = screen.getByText('No unsaved changes');
  expect(classes(line)).toEqual(words('text-[13px] text-muted'));
  expect(classes(line.parentElement)).toEqual(words('flex flex-wrap items-center gap-2.5'));
  expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

  // The nav, and the sections it leads to, in the order of the page.
  const nav = screen.getByRole('navigation', { name: 'Settings sections' });
  expect(classes(nav)).toEqual(words('flex flex-wrap gap-2'));
  const links = within(nav).getAllByRole('link');
  expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['General', '#general'], ['Model', '#model'], ['Repositories', '#repos'], ['Secrets', '#secrets'], ['Access', '#access'], ['Accounts', '#accounts'],
  ]);
  for (const link of links) expect(link.className).toContain('min-h-9');
  const order = ['general', 'model', 'repos', 'secrets', 'access', 'accounts'].map((id) => document.getElementById(id));
  for (const [index, element] of order.entries()) {
    expect(element?.tagName).toBe('SECTION');
    if (index > 0) expect(order[index - 1]!.compareDocumentPosition(element!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  }

  const general = section('General');
  expect(general).toBe(document.getElementById('general'));
  expect(classes(general)).toEqual(words('flex flex-col rounded-[12px] border border-border bg-card px-6 py-5 shadow-card'));
  const h2 = within(general).getByRole('heading', { level: 2, name: 'General' });
  expect(classes(h2)).toEqual(words('m-0 text-[17px] font-semibold mb-1'));
  expect(general.getAttribute('aria-labelledby')).toBe(h2.id);
  expect(classes(section('Secrets'))).toEqual(words('flex flex-col rounded-[12px] border border-border bg-card px-6 py-5 shadow-card gap-2'));

  // The rows: a label, its help, its control.
  const dry = rowOf('Dry run');
  expect(classes(dry)).toEqual(words('flex flex-wrap items-start gap-x-8 gap-y-3 border-t border-border py-4 first-of-type:border-t-0'));
  expect(within(dry).getByText('Reviews are run and recorded, and nothing is posted to GitHub.')).toBeInTheDocument();
  expect(classes(within(dry).getByText('Reviews are run and recorded, and nothing is posted to GitHub.'))).toEqual(words('text-[13px] leading-[1.45] text-muted'));
  const lbl = within(dry).getByText('Dry run').closest('[data-slot="setting-label"]');
  expect(classes(lbl)).toEqual(words('flex min-w-0 shrink grow basis-[260px] flex-col gap-1'));
  expect(classes(ctlOf(within(dry).getByRole('switch')))).toEqual(words('flex min-w-0 shrink grow basis-[300px] flex-wrap items-center gap-2.5'));
  const dryRun = within(dry).getByRole('switch', { name: 'Dry run' });
  expect(dryRun).toHaveAttribute('aria-checked', 'true');
  expect(within(dry).getByText('On')).toBeInTheDocument();
  expect(within(rowOf('Learning')).getByRole('switch', { name: 'Learning' })).toHaveAttribute('aria-checked', 'false');
  expect(within(rowOf('Learning')).getByText('Off')).toBeInTheDocument();
  expect(within(rowOf('Learning')).getByText('Learn from what people do on pull requests: where they stepped in, reverts, and replies to findings.')).toBeInTheDocument();

  expect(screen.getByLabelText('Daily spend limit')).toHaveValue(40);
  expect(screen.getByLabelText('Daily spend limit')).toHaveClass('max-w-[140px]');
  expect(screen.getByLabelText('Reviews at once')).toHaveValue(2);
  expect(screen.getByLabelText('Input tokens per call')).toHaveValue(200000);
  expect(screen.getByLabelText('Input tokens per call')).toHaveClass('max-w-[180px]');
  expect(screen.getByLabelText('Batches per review')).toHaveValue(6);
  expect(within(rowOf('Daily spend limit')).getByText("Reviews wait once the day's model spend reaches it. An alert is raised at 80%.")).toBeInTheDocument();
  expect(within(rowOf('Batches per review')).getByText('Files past the last batch are listed as not reviewed.')).toBeInTheDocument();

  // Where each value came from.
  const from = within(dry).getByText('From config.yml at the start of 2026-03-01 09:00 UTC');
  expect(classes(from)).toEqual(words('text-xs text-muted'));
  expect(within(rowOf('Daily spend limit')).getByText('Changed in the UI by octo-admin, 2026-03-01 09:30 UTC')).toBeInTheDocument();
  expect(within(rowOf('Input tokens per call')).getByText('The default')).toBeInTheDocument();

  // Accounts follows Access.
  expect(screen.getByRole('region', { name: 'Accounts' })).toBe(document.getElementById('accounts'));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a setting read once at start is marked, and one saved that waits for a restart says so', async () => {
  await open();
  for (const label of ['Dry run', 'Learning', 'Reviews at once', 'Endpoint', 'How the answer is asked for', 'Time limit per call']) {
    const badge = within(rowOf(label)).getByText('Needs a restart');
    expect(classes(badge)).toEqual(words('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs leading-5 font-medium bg-subtle text-muted'));
  }
  for (const label of ['Daily spend limit', 'Input tokens per call', 'Batches per review', 'Model', 'Fallbacks']) {
    expect(within(rowOf(label)).queryByText('Needs a restart')).toBeNull();
  }
  const waits = within(rowOf('Dry run')).getByText('Takes effect when the service restarts');
  expect(classes(waits)).toEqual(words('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs leading-5 font-medium bg-warn-bg text-warn'));
  expect(within(rowOf('Learning')).queryByText('Takes effect when the service restarts')).toBeNull();
  // The scorer's switch waits for a restart when the view says so.
  expect(within(rowOf('Second scorer')).getByText('On or off: needs a restart')).toBeInTheDocument();
  expect(within(rowOf('Second scorer')).getByText('Takes effect when the service restarts')).toBeInTheDocument();
});

test('changes are counted, Discard puts them back, and Save sends only what changed with the version', async () => {
  const user = userEvent.setup();
  const saved = viewOf({ version: 15, global: { learning: written(true, UI), 'limits.spendPerDay': written(45, UI) } });
  const { api, sent } = fakeApi({ saveSettings: () => Promise.resolve({ kind: 'saved', view: saved }) });
  visit('/ui/settings');
  render(<App api={api} />);
  await screen.findByRole('region', { name: 'General' });

  await user.click(screen.getByRole('switch', { name: 'Learning' }));
  expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
  await user.clear(screen.getByLabelText('Daily spend limit'));
  await user.type(screen.getByLabelText('Daily spend limit'), '45');
  expect(screen.getByText('2 unsaved changes')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Learning' })).toHaveAttribute('aria-checked', 'true');

  await user.click(screen.getByRole('button', { name: 'Discard' }));
  expect(screen.getByText('No unsaved changes')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Learning' })).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByLabelText('Daily spend limit')).toHaveValue(40);

  await user.click(screen.getByRole('switch', { name: 'Learning' }));
  await user.clear(screen.getByLabelText('Daily spend limit'));
  await user.type(screen.getByLabelText('Daily spend limit'), '45');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(sent('saveSettings')).toEqual([[
    'saveSettings', 'csrf-1', { version: 14, changes: [{ scope: 'global', path: 'learning', value: true }, { scope: 'global', path: 'limits.spendPerDay', value: 45 }] },
  ]]);
  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent('Saved.');
  expect(classes(status)).toEqual(words('text-[13px] text-muted'));
  expect(screen.getByText('No unsaved changes')).toBeInTheDocument();
  expect(screen.getByLabelText('Daily spend limit')).toHaveValue(45);
  expect(within(rowOf('Daily spend limit')).getByText('Changed in the UI by octo-admin, 2026-03-01 09:30 UTC')).toBeInTheDocument();
  // Until the next change.
  await user.click(screen.getByRole('switch', { name: 'Learning' }));
  expect(screen.queryByRole('status')).toBeNull();
});

test('a save refused shows each issue at its setting and all of them at the top, and keeps the changes', async () => {
  const user = userEvent.setup();
  const { api } = fakeApi({
    saveSettings: () =>
      Promise.resolve({
        kind: 'invalid',
        issues: [
          { scope: 'global', path: 'limits.spendPerDay', message: 'Invalid input: expected number, received string' },
          { scope: null, path: null, message: 'auditKey: must be at least 32 characters' },
        ],
      }),
  });
  visit('/ui/settings');
  render(<App api={api} />);
  await screen.findByRole('region', { name: 'General' });
  await user.click(screen.getByRole('switch', { name: 'Learning' }));
  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  const alert = await screen.findByRole('alert');
  expect(classes(alert)).toEqual(words('rounded-[12px] border border-border bg-bad-bg px-5 py-3 text-sm text-bad'));
  expect(alert).toHaveTextContent('Not saved. Each issue is shown at its setting:');
  const items = within(alert).getAllByRole('listitem').map((item) => item.textContent);
  expect(items).toEqual(['General, Daily spend limit: Invalid input: expected number, received string', 'auditKey: must be at least 32 characters']);
  const issue = within(rowOf('Daily spend limit')).getByText('Invalid input: expected number, received string');
  expect(issue.tagName).toBe('P');
  expect(classes(issue)).toEqual(words('w-full text-[13px] text-bad'));
  expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Learning' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.queryByRole('status')).toBeNull();
});

test('a save that met another keeps the changes and reads the settings again', async () => {
  const user = userEvent.setup();
  const second = viewOf({ version: 16, global: { 'limits.batchesPerReview': written(8, UI) } });
  let reads = 0;
  const { api, sent } = fakeApi({
    settings: () => Promise.resolve(++reads === 1 ? VIEW : second),
    saveSettings: () => Promise.reject(new RequestFailed(409, 'changed')),
  });
  visit('/ui/settings');
  render(<App api={api} />);
  await screen.findByRole('region', { name: 'General' });
  await user.click(screen.getByRole('switch', { name: 'Learning' }));
  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Settings were saved meanwhile, here or in config.yml at a start. They were read again, and your changes are kept: save again.');
  expect(sent('settings')).toHaveLength(2);
  expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Learning' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByLabelText('Batches per review')).toHaveValue(8);
  expect(screen.queryByRole('status')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(sent('saveSettings')[1]).toEqual(['saveSettings', 'csrf-1', { version: 16, changes: [{ scope: 'global', path: 'learning', value: true }] }]);
});

test('other failures of a save are said, and the changes kept', async () => {
  const user = userEvent.setup();
  const failures = [
    [new RequestFailed(500, 'boom'), 'The settings could not be saved.'],
    [new RequestFailed(503, 'busy'), 'The service is busy. Try again in a moment.'],
    [new RequestFailed(0, 'unreachable'), 'The service could not be reached. Try again in a moment.'],
  ] as const;
  let n = 0;
  const { api } = fakeApi({ saveSettings: () => Promise.reject(failures[n++]![0]) });
  visit('/ui/settings');
  render(<App api={api} />);
  await screen.findByRole('region', { name: 'General' });
  await user.click(screen.getByRole('switch', { name: 'Learning' }));
  for (const [, text] of failures) {
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
  }
});

test("the model's rows read and write their values", async () => {
  const user = userEvent.setup();
  const { api, sent } = fakeApi({ saveSettings: () => Promise.reject(new RequestFailed(500, 'boom')) });
  visit('/ui/settings');
  render(<App api={api} />);
  await screen.findByRole('region', { name: 'Model' });
  const save = async (): Promise<unknown> => {
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('alert');
    return sent('saveSettings').at(-1)![2];
  };
  const changesAfter = async (): Promise<unknown> => ((await save()) as { changes: unknown[] }).changes;
  const discard = (): Promise<void> => user.click(screen.getByRole('button', { name: 'Discard' }));

  // Read.
  expect(screen.getByLabelText('Endpoint')).toHaveValue('https://llm.example.test/v1');
  expect(screen.getByLabelText('Endpoint')).toHaveClass('font-mono', 'w-full');
  expect(screen.getByLabelText('Model', { selector: 'input' })).toHaveValue('vendor/model-a');
  expect(screen.getByRole('combobox', { name: 'Default' })).toHaveValue('none');
  expect(within(screen.getByRole('combobox', { name: 'Default' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['Provider default', 'Low', 'Medium', 'High']);
  expect(screen.getByRole('combobox', { name: 'Elevated' })).toHaveValue('high');
  expect(screen.getByRole('button', { name: 'Forced' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByLabelText('Time limit per call')).toHaveValue(240);
  expect(screen.getByLabelText('Input')).toHaveValue(1);
  expect(screen.getByLabelText('Cached')).toHaveValue(0.1);
  expect(screen.getByLabelText('Output')).toHaveValue(4);
  expect(screen.getByLabelText('Input')).toHaveClass('w-[100px]');
  expect(screen.getByLabelText('Scorer model')).toHaveValue('vendor/decision-model');
  expect(screen.getByLabelText('Scorer model')).toBeEnabled();
  expect(screen.getByLabelText('Second scorer endpoint')).toHaveValue('https://scorer.example.test/v1');
  expect(screen.getByLabelText('Second scorer time limit')).toHaveValue(120);
  expect(screen.getByRole('switch', { name: 'Second scorer' })).toHaveAttribute('aria-checked', 'true');

  // Fallbacks.
  await user.click(screen.getByRole('button', { name: 'Remove vendor/model-b' }));
  await user.click(screen.getByRole('button', { name: 'Add a model' }));
  await user.type(screen.getByRole('textbox', { name: 'Add to Fallbacks' }), 'vendor/model-c{Enter}');
  expect(await changesAfter()).toEqual([{ scope: 'global', path: 'model.fallbacks', value: ['vendor/model-c'] }]);
  await discard();

  // Effort.
  await user.selectOptions(screen.getByRole('combobox', { name: 'Default' }), 'low');
  expect(await changesAfter()).toEqual([{ scope: 'global', path: 'model.effort.default', value: { reasoning: { effort: 'low' } } }]);
  await discard();

  // A custom value is kept and named.
  await user.click(screen.getByRole('button', { name: 'Auto' }));
  expect(await changesAfter()).toEqual([{ scope: 'global', path: 'model.toolChoice', value: 'auto' }]);
  await discard();

  // Prices: emptied is null; one filled writes the three.
  await user.clear(screen.getByLabelText('Input'));
  await user.clear(screen.getByLabelText('Cached'));
  await user.clear(screen.getByLabelText('Output'));
  expect(await changesAfter()).toEqual([{ scope: 'global', path: 'model.prices', value: null }]);
  await user.type(screen.getByLabelText('Input'), '1');
  expect(await changesAfter()).toEqual([
    { scope: 'global', path: 'model.prices', value: { inputPerMillion: 1, cachedInputPerMillion: '', outputPerMillion: '' } },
  ]);
  await discard();

  // Extra body: a field not valid blocks the save; a valid one writes its value.
  const body = screen.getByLabelText('Extra body');
  expect(body.tagName).toBe('TEXTAREA');
  expect(classes(body)).toEqual(expect.arrayContaining(['min-h-24', 'w-full', 'py-2', 'font-mono', 'text-[12.5px]']));
  fireEvent.change(body, { target: { value: '{' } });
  const bad = within(rowOf('Extra body')).getByText('Not valid JSON.');
  expect(classes(bad)).toEqual(words('w-full text-[13px] text-bad'));
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  fireEvent.change(body, { target: { value: '{"a":1}' } });
  expect(within(rowOf('Extra body')).queryByText('Not valid JSON.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  expect(await changesAfter()).toEqual([{ scope: 'global', path: 'model.extraBody', value: { a: 1 } }]);
  fireEvent.change(body, { target: { value: '{' } });
  await discard();
  expect(screen.getByLabelText('Extra body')).toHaveValue('{}');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  expect(screen.queryByText('Not valid JSON.')).toBeNull();

  // The scorer off writes the three scorer settings not written, and the page does not show the old value as the default.
  await user.click(screen.getByRole('switch', { name: 'Second scorer' }));
  expect(screen.getByRole('switch', { name: 'Second scorer' })).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByLabelText('Scorer model')).toBeDisabled();
  expect(screen.getByLabelText('Scorer model')).toHaveValue('');
  expect(screen.queryByDisplayValue('vendor/decision-model')).toBeNull();
  expect(screen.queryByLabelText('Second scorer endpoint')).toBeNull();
  expect(screen.queryByLabelText('Second scorer time limit')).toBeNull();
  expect(within(rowOf('Second scorer')).getByText('Not written')).toBeInTheDocument();
  expect(await changesAfter()).toEqual([
    { scope: 'global', path: 'scorer.baseUrl' }, { scope: 'global', path: 'scorer.model' }, { scope: 'global', path: 'scorer.timeoutSeconds' },
  ]);
  // On again with nothing typed writes an empty model.
  await user.click(screen.getByRole('switch', { name: 'Second scorer' }));
  expect(screen.getByLabelText('Scorer model')).toBeEnabled();
  expect(screen.getByLabelText('Second scorer endpoint')).toBeInTheDocument();
});

test('an effort written otherwise reads as written in config.yml, and a scorer off to on writes the typed model', async () => {
  const user = userEvent.setup();
  const view = viewOf({
    global: {
      'model.effort.default': written({ reasoning: { effort: 'high', summary: 'auto' } }),
      'scorer.model': byDefault(''),
      'scorer.baseUrl': byDefault(''),
      'scorer.timeoutSeconds': byDefault(120),
    },
    scorer: { on: false, waits: false },
  });
  const { api, sent } = fakeApi({ settings: () => Promise.resolve(view), saveSettings: () => Promise.reject(new RequestFailed(500, 'boom')) });
  visit('/ui/settings');
  render(<App api={api} />);
  await screen.findByRole('region', { name: 'Model' });
  const select = screen.getByRole('combobox', { name: 'Default' });
  expect(select).toHaveValue('custom');
  expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Provider default', 'Low', 'Medium', 'High', 'As written in config.yml']);
  expect(within(screen.getByRole('combobox', { name: 'Elevated' })).queryByRole('option', { name: 'As written in config.yml' })).toBeNull();
  expect(screen.getByRole('switch', { name: 'Second scorer' })).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByLabelText('Scorer model')).toBeDisabled();
  expect(screen.queryByLabelText('Second scorer endpoint')).toBeNull();
  await user.click(screen.getByRole('switch', { name: 'Second scorer' }));
  await user.type(screen.getByLabelText('Scorer model'), 'vendor/decision-model');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await screen.findByRole('alert');
  expect(sent('saveSettings')[0]![2]).toEqual({ version: 14, changes: [{ scope: 'global', path: 'scorer.model', value: 'vendor/decision-model' }] });
});

test('every switch the page draws has a name', async () => {
  await open();
  const switches = screen.getAllByRole('switch');
  expect(switches.length).toBeGreaterThanOrEqual(3);
  for (const one of switches) expect(one).toHaveAccessibleName();
});

test('the secrets show only their variable and whether it is set, and Access shows what config.yml says', async () => {
  await open();
  const secrets = section('Secrets');
  expect(within(secrets).getByText('Read from the environment at start. Never shown or changed here.')).toBeInTheDocument();
  const row = (label: string): HTMLElement => within(secrets).getByText(label, { exact: false }).closest('[data-slot="secret-row"]') as HTMLElement;
  expect(row('Model key')).toHaveTextContent('Model key OPENROUTER_API_KEY');
  expect(within(row('Model key')).getByText('Set')).toBeInTheDocument();
  expect(classes(within(row('Model key')).getByText('OPENROUTER_API_KEY'))).toEqual(words('font-mono text-[12.5px] text-muted'));
  expect(row('Alert webhook')).toHaveTextContent(/^Alert webhookNot set$/);
  expect(classes(within(row('Alert webhook')).getByText('Not set'))).toEqual(words('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs leading-5 font-medium bg-subtle text-muted'));
  expect(row('Extension example, option secret')).toHaveTextContent('EXAMPLE_SECRET');
  expect(row('MCP server docs')).toHaveTextContent('DOCS_TOKEN');
  expect(within(secrets).getAllByText('Set')).toHaveLength(4);
  expect(secrets.textContent).not.toMatch(/key-for-tests/);

  const access = section('Access');
  expect(within(rowOf('Address')).getByText('https://visto.example.test')).toHaveClass('font-mono');
  expect(within(rowOf('Team that may sign in through GitHub')).getByText('None')).toBeInTheDocument();
  expect(within(rowOf('Team that may sign in through GitHub')).getByText('Its active members may sign in through the GitHub App, as viewers until an admin says otherwise. Set in config.yml.')).toBeInTheDocument();
  const accounts = rowOf('Accounts that may sign in through GitHub');
  expect(within(accounts).getByText('octo-lead')).toBeInTheDocument();
  expect(within(accounts).getByText('octo-dev')).toBeInTheDocument();
  expect(within(accounts).queryByRole('button')).toBeNull();
  expect(within(access).queryByText(/Sign-in through GitHub is off/)).toBeNull();
});

test('Access names the team, or says GitHub sign-in is off', async () => {
  const team = viewOf({ access: { publicUrl: 'https://visto.example.test', github: true, accounts: [], team: 'acme/visto-admins' } });
  const first = await open({ settings: () => Promise.resolve(team) });
  expect(first).toBeDefined();
  expect(within(rowOf('Team that may sign in through GitHub')).getByText('acme/visto-admins')).toHaveClass('font-mono');
  expect(within(rowOf('Accounts that may sign in through GitHub')).getByText('None')).toBeInTheDocument();
});

test('GitHub sign-in off says so in place of the two rows', async () => {
  const off = viewOf({ access: { publicUrl: 'https://visto.example.test', github: false, accounts: [], team: null } });
  await open({ settings: () => Promise.resolve(off) });
  const access = section('Access');
  expect(within(access).getByText('Sign-in through GitHub is off: config.yml names neither accounts nor a team.')).toBeInTheDocument();
  expect(within(access).queryByText('Team that may sign in through GitHub')).toBeNull();
  expect(within(access).queryByText('Accounts that may sign in through GitHub')).toBeNull();
  expect(within(access).getByText('Address')).toBeInTheDocument();
});

test('a row names its setting in the list of issues as the page labels it', () => {
  expect(whereOf('global', 'limits.spendPerDay')).toBe('General');
  expect(whereOf('global', 'dryRun')).toBe('General');
  expect(whereOf('global', 'model.model')).toBe('Model');
  expect(whereOf('global', 'scorer.model')).toBe('Model');
  expect(whereOf('defaults', 'newHead')).toBe('Defaults for all');
  expect(whereOf('acme/shop', 'gate.mode')).toBe('acme/shop');
  for (const path of Object.keys(GLOBAL)) expect(LABELS[path], path).toBeTypeOf('string');
  expect(LABELS['limits.spendPerDay']).toBe('Daily spend limit');
});

test('settings that cannot be read say so, and the accounts stay', async () => {
  const user = userEvent.setup();
  let reads = 0;
  const { api, sent } = fakeApi({ settings: () => (++reads === 1 ? Promise.reject(new RequestFailed(500, 'boom')) : Promise.resolve(VIEW)) });
  visit('/ui/settings');
  render(<App api={api} />);
  expect(await screen.findByText('The settings could not be read.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  expect(screen.getByText(SUB)).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Accounts' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'General' })).toBeNull();
  // The accounts' own Try again is in its section; this one is in the page's.
  const again = screen.getAllByRole('button', { name: 'Try again' }).find((button) => !section('Accounts').contains(button))!;
  await user.click(again);
  expect(await screen.findByRole('region', { name: 'General' })).toBeInTheDocument();
  expect(sent('settings')).toHaveLength(2);
});

test('while the settings are read, the page says so and the accounts stay', async () => {
  visit('/ui/settings');
  const { api } = fakeApi({ settings: () => new Promise<never>(() => {}) });
  render(<App api={api} />);
  const reading = await screen.findByText('Reading the settings.');
  expect(reading.tagName).toBe('P');
  expect(screen.getByRole('region', { name: 'Accounts' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
});

test('a viewer reaching Settings sees Not found and no settings are read', async () => {
  visit('/ui/settings');
  const { api, sent } = fakeApi();
  const viewer: Api = { ...api, me: () => Promise.resolve({ ...ME, role: 'viewer' as const }) };
  render(<App api={viewer} />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
  expect(sent('settings')).toEqual([]);
});
