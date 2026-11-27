import { fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { RequestFailed } from '../api.ts';
import type { Api } from '../api.ts';
import type { Activity, Me, Reviews, SecretState, Setting, SettingIssue, SettingSource, SettingsView, SettingValue } from '../api-types.ts';
import { App } from '../app.tsx';

const NOW = '2026-03-01T10:00:00.000Z';
const ME: Me = { name: 'octo-admin', kind: 'password', role: 'admin', csrf: 'csrf-1', mode: 'live', repositories: ['acme/shop'] };
const ACTIVITY: Activity = { now: NOW, places: { reviews: 2, withdrawals: 2 }, paused: null, jobs: [], withdrawals: [] };
const REVIEWS: Reviews = { now: NOW, windowDays: 30, total: 0, reviews: [], next: null };
const FILE: SettingSource = { by: 'config.yml', name: null, at: '2026-03-01T09:00:00.000Z' };
const written = (value: SettingValue, source: SettingSource = FILE): Setting => ({ written: true, value, source, restart: false, waits: false });
const byDefault = (value: SettingValue): Setting => ({ written: false, value, source: null, restart: false, waits: false });

const DEFAULTS: Record<string, Setting> = {
  primaryBranches: written(['main', 'master']),
  ignoredAuthors: written(['dependabot[bot]']),
  baseBranches: byDefault([]),
  newHead: byDefault(null),
  'score.threshold': written(70),
  'score.inlineNotes': written(true),
  'score.autoApprove': byDefault(false),
  'score.approvalThreads': byDefault('strict'),
  'score.auditShare': byDefault(5),
  'gate.enabled': byDefault(false),
  'gate.branches': byDefault([]),
  'gate.checkName': byDefault('AI Review'),
  'gate.mode': byDefault('enforce'),
  'gate.clearByReply': byDefault(true),
  'gate.skipTeam': byDefault(null),
  'gate.requiredChecks': byDefault([]),
};
const SHOP: Record<string, Setting> = {
  primaryBranches: written(['trunk']),
  'score.threshold': written(80),
  'gate.enabled': written(true),
};

function viewOf(over: { defaults?: Record<string, Setting>; shop?: Record<string, Setting>; secrets?: SecretState[] } = {}): SettingsView {
  return {
    now: NOW,
    version: 14,
    global: {},
    defaults: { ...DEFAULTS, ...over.defaults },
    repositories: [
      { name: 'acme/shop', settings: over.shop ?? SHOP },
      { name: 'acme/web', settings: {} },
    ],
    scorer: { on: false, waits: false },
    endpoints: { model: 'https://llm.example.test/v1', scorer: null },
    secrets: over.secrets ?? [{ kind: 'audit_key', of: null, variable: 'AUDIT_KEY' }],
    access: { publicUrl: 'https://visto.example.test', github: true, accounts: [], team: null },
  };
}

function fakeApi(view: SettingsView, over: Partial<Api> = {}) {
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
    settings: () => Promise.resolve(view),
    saveSettings: (csrf, save) => {
      calls.push(['saveSettings', csrf, save]);
      return over.saveSettings ? over.saveSettings(csrf, save) : Promise.reject(new RequestFailed(500, 'not_expected'));
    },
    settingChanges: () => Promise.reject(new RequestFailed(500, 'not_expected')),
    settingsExport: () => Promise.reject(new RequestFailed(500, 'not_expected')),
  };
  return { api, sent: () => calls.filter(([called]) => called === 'saveSettings') };
}

async function open(view: SettingsView = viewOf(), over: Partial<Api> = {}) {
  window.history.replaceState(null, '', '/ui/settings');
  const made = fakeApi(view, over);
  render(<App api={made.api} />);
  await screen.findByRole('region', { name: 'Repositories' });
  return made;
}

afterEach(() => window.history.replaceState(null, '', '/'));

const option = (name: RegExp | string): HTMLElement => screen.getByRole('option', { name });
const rowOf = (label: string): HTMLElement => {
  const row = screen.getByText(label, { selector: 'label, strong' }).closest('[data-slot="setting-row"]');
  if (row === null) throw new Error(`No row for ${label}.`);
  return row as HTMLElement;
};
const classes = (element: Element | null | undefined): string[] => [...(element?.classList ?? [])].sort();
const words = (text: string): string[] => text.split(' ').filter(Boolean).sort();

test('the repositories are listed with their overrides, the defaults first', async () => {
  const user = userEvent.setup();
  await open();
  const list = screen.getByRole('listbox', { name: 'Repository' });
  expect(classes(list)).toEqual(words('flex flex-col gap-0.5'));
  expect(classes(list.parentElement)).toEqual(words('flex max-w-[260px] shrink grow basis-[200px] flex-col gap-0.5'));
  // A listbox holds options only: the button that adds one is beside it.
  expect(within(list).queryByRole('button')).toBeNull();
  expect(within(list.parentElement!).getByRole('button', { name: 'Add a repository' })).toBeInTheDocument();
  const options = within(list).getAllByRole('option');
  expect(options.map((one) => one.textContent)).toEqual(['Defaults for allDefaults', 'acme/shop3 overrides', 'acme/webDefaults']);
  expect(options[0]).toHaveAttribute('aria-selected', 'true');
  expect(options[1]).toHaveAttribute('aria-selected', 'false');
  expect(classes(options[0])).toContain('bg-accent-soft');
  expect(classes(options[1])).toContain('hover:bg-subtle');
  expect(classes(within(options[1]!).getByText('3 overrides'))).toContain('bg-accent-soft');
  expect(classes(within(options[2]!).getByText('Defaults'))).toContain('bg-subtle');
  expect(screen.getByText('Every repository starts from these')).toBeInTheDocument();

  await user.click(option(/acme\/shop/));
  expect(option(/acme\/shop/)).toHaveAttribute('aria-selected', 'true');
  expect(option(/Defaults for all/)).toHaveAttribute('aria-selected', 'false');
  expect(screen.getByText('Settings not overridden come from the defaults')).toBeInTheDocument();
  expect(screen.getByText('acme/shop', { selector: 'strong' })).toHaveClass('text-base');
});

test('a setting not overridden comes from the defaults, and one overridden says what it overrides and can use the default again', async () => {
  const user = userEvent.setup();
  const { api, sent } = fakeApi(viewOf(), {
    saveSettings: () => Promise.resolve({ kind: 'saved', view: viewOf() }),
  });
  window.history.replaceState(null, '', '/ui/settings');
  render(<App api={api} />);
  await screen.findByRole('region', { name: 'Repositories' });
  await user.click(option(/acme\/shop/));

  const primary = rowOf('Primary branches');
  expect(within(primary).getByText('trunk')).toBeInTheDocument();
  const over = within(primary).getByText('Overrides main, master');
  expect(classes(over)).toEqual(words('text-xs font-medium text-accent-text'));
  expect(within(primary).getByText('From config.yml at the start of 2026-03-01 09:00 UTC')).toBeInTheDocument();
  expect(within(rowOf('Ignored authors')).getByText('From the defaults')).toBeInTheDocument();
  expect(within(rowOf('Ignored authors')).queryByRole('button', { name: /^Use the default/ })).toBeNull();

  const use = within(primary).getByRole('button', { name: 'Use the default for Primary branches' });
  expect(use).toHaveClass('min-h-7', 'px-2', 'text-xs');
  await user.click(use);
  expect(within(rowOf('Primary branches')).getByText('main')).toBeInTheDocument();
  expect(within(rowOf('Primary branches')).getByText('master')).toBeInTheDocument();
  expect(within(rowOf('Primary branches')).getByText('From the defaults')).toBeInTheDocument();
  expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(sent()).toEqual([['saveSettings', 'csrf-1', { version: 14, changes: [{ scope: 'acme/shop', path: 'primaryBranches' }] }]]);
  expect(sent()[0]![2]).not.toHaveProperty('changes.0.value');
});

test('Reviewed on every push shows every branch as *, and says what the merge gate does beside it', async () => {
  const user = userEvent.setup();
  const { sent } = await open(viewOf(), { saveSettings: () => Promise.resolve({ kind: 'saved', view: viewOf() }) });
  const row = rowOf('Reviewed on every push');
  const control = (): HTMLElement => within(rowOf('Reviewed on every push')).getByText('*', { selector: '[data-slot="setting-control"] span' }).closest('[data-slot="setting-control"]') as HTMLElement;
  expect(within(control()).getByText('*')).toBeInTheDocument();
  expect(within(row).queryByRole('button', { name: /^Remove/ })).toBeNull();
  expect(row).toHaveTextContent('On a branch where the merge gate is on, pushes wait for /done instead, unless the gate is in Shadow mode.');
  expect(row).toHaveTextContent('* means every branch');
  await user.click(within(row).getByRole('button', { name: 'Add' }));
  await user.keyboard('trunk{Enter}');
  expect(within(rowOf('Reviewed on every push')).getByText('trunk')).toBeInTheDocument();
  expect(within(rowOf('Reviewed on every push')).queryByText('*', { selector: '[data-slot="setting-control"] span' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(sent()[0]![2]).toEqual({ version: 14, changes: [{ scope: 'defaults', path: 'baseBranches', value: ['trunk'] }] });
});

test("the merge gate's rows show while it is on, with what each mode does", async () => {
  const user = userEvent.setup();
  await open();
  const gate = screen.getByRole('switch', { name: 'Merge gate' });
  expect(gate).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByText('How it works', { selector: 'strong' })).toBeInTheDocument();
  const box = gate.closest('div')!.parentElement!.parentElement!;
  expect(within(box).getAllByRole('listitem')).toHaveLength(4);
  for (const label of ['Gated branches', 'Check name', 'Required checks']) expect(screen.queryByText(label, { selector: 'label, strong' })).toBeNull();

  await user.click(gate);
  for (const label of ['Gated branches', 'Check name', 'A reply clears a blocking finding', 'Team that may skip', 'Required checks']) {
    expect(rowOf(label)).toBeInTheDocument();
  }
  expect(screen.getByText('Mode', { selector: 'strong' })).toBeInTheDocument();
  expect(screen.getByLabelText('Check name')).toHaveClass('max-w-[240px]');
  expect(screen.getByLabelText('Team that may skip')).toHaveClass('max-w-[320px]', 'font-mono');
  const branches = rowOf('Gated branches');
  expect(branches).toHaveTextContent('they wait for /done');
  expect(branches.querySelector('[data-slot="setting-label"] > span')?.textContent?.endsWith(' A * here is not every branch: it is read as a branch of that name.')).toBe(true);

  const mode = screen.getByRole('group', { name: 'Gate mode' });
  expect(within(mode).getAllByRole('button').map((one) => one.textContent)).toEqual(['Enforce', 'Shadow', 'Bypass']);
  expect(screen.getByText(/^Enforce: the check works as described above/)).toBeInTheDocument();
  await user.click(within(mode).getByRole('button', { name: 'Shadow' }));
  expect(screen.getByText(/^Shadow: the check is written, but pushes are still reviewed/)).toBeInTheDocument();
  await user.click(within(mode).getByRole('button', { name: 'Bypass' }));
  expect(screen.getByText(/^Bypass: the check always passes/)).toBeInTheDocument();

  const team = screen.getByLabelText('Team that may skip');
  await user.type(team, 'acme/release-managers');
  await user.clear(team);
  expect(screen.getByText(/unsaved change/)).toBeInTheDocument();
  expect(team).toHaveValue('');
});

test('emptying the team that may skip writes null', async () => {
  const user = userEvent.setup();
  const view = viewOf({ defaults: { 'gate.enabled': written(true), 'gate.skipTeam': written('acme/release-managers') } });
  const { sent } = await open(view, { saveSettings: () => Promise.resolve({ kind: 'saved', view }) });
  const team = screen.getByLabelText('Team that may skip');
  await user.clear(team);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(sent()[0]![2]).toEqual({ version: 14, changes: [{ scope: 'defaults', path: 'gate.skipTeam', value: null }] });
});

test("automatic approval shows its rules while on, the thread rule's help, and whether the audit key is set", async () => {
  const user = userEvent.setup();
  const { sent } = await open(viewOf(), { saveSettings: () => Promise.resolve({ kind: 'saved', view: viewOf() }) });
  const approve = screen.getByRole('switch', { name: 'Automatic approval' });
  expect(screen.queryByText('Thread rule', { selector: 'strong' })).toBeNull();
  await user.click(approve);
  expect(screen.getAllByText('How it works', { selector: 'strong' })).toHaveLength(2);
  expect(screen.getByText(/^Strict \(recommended\): closed when a later review/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Gate rule' }));
  expect(screen.getByText(/^Gate rule: closed when the merge gate would let it pass/)).toBeInTheDocument();
  const share = within(rowOf('Audit share'));
  expect(share.getByText('Audit key set')).toBeInTheDocument();
  expect(screen.getByLabelText('Audit share')).toHaveClass('max-w-[120px]');
  expect(
    screen.getByText("It approves only where the base branch's rules dismiss stale approvals, and never a draft or a pull request from a fork."),
  ).toHaveClass('mt-1', 'mb-2', 'text-[13px]', 'text-muted');
  fireEvent.change(screen.getByLabelText('Audit share'), { target: { value: '7' } });
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  const changes = (sent()[0]![2] as { changes: Array<{ path: string; value: unknown }> }).changes;
  expect(changes.find((one) => one.path === 'score.auditShare')?.value).toBe(7);
  expect(changes.find((one) => one.path === 'score.autoApprove')?.value).toBe(true);
  expect(changes.find((one) => one.path === 'score.approvalThreads')?.value).toBe('gate');
});

test('an audit key not set is said', async () => {
  const user = userEvent.setup();
  await open(viewOf({ secrets: [{ kind: 'audit_key', of: null, variable: null }] }));
  await user.click(screen.getByRole('switch', { name: 'Automatic approval' }));
  expect(within(rowOf('Audit share')).getByText('Audit key not set')).toBeInTheDocument();
});

test('the threshold writes a whole number and says whether it overrides the default', async () => {
  const user = userEvent.setup();
  const { sent } = await open(viewOf(), { saveSettings: () => Promise.resolve({ kind: 'saved', view: viewOf() }) });
  expect(screen.queryByText(/From the defaults: 70%/)).toBeNull();
  expect(screen.queryByText(/Overrides the default of/)).toBeNull();
  await user.click(option(/acme\/web/));
  const slider = screen.getByLabelText('Threshold');
  expect(slider).toHaveAttribute('type', 'range');
  expect(slider).toHaveAttribute('min', '1');
  expect(slider).toHaveAttribute('max', '100');
  expect(slider).toHaveClass('w-full', 'accent-accent');
  expect(screen.getByText('From the defaults: 70%')).toBeInTheDocument();
  // Said once: the threshold's own row does not add a second line.
  expect(within(rowOf('Threshold')).queryAllByText(/From the defaults/)).toHaveLength(1);
  expect(within(rowOf('Threshold')).getByText('70%')).toHaveClass('min-w-12', 'text-right', 'font-semibold');
  fireEvent.change(slider, { target: { value: '60' } });
  expect(within(rowOf('Threshold')).getByText('60%')).toBeInTheDocument();
  expect(screen.getByText('Overrides the default of 70%')).toBeInTheDocument();
  expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(sent()[0]![2]).toEqual({ version: 14, changes: [{ scope: 'acme/web', path: 'score.threshold', value: 60 }] });
});

test('a repository is added by its name, and refused in another shape', async () => {
  const user = userEvent.setup();
  await open();
  await user.click(screen.getByRole('button', { name: 'Add a repository' }));
  const input = screen.getByRole('textbox', { name: 'Repository to add' });
  expect(input).toHaveAttribute('placeholder', 'owner/name');
  expect(within(screen.getByRole('listbox', { name: 'Repository' })).queryByRole('textbox')).toBeNull();
  await user.type(input, 'acme');
  await user.click(within(screen.getByRole('listbox', { name: 'Repository' }).parentElement!).getByRole('button', { name: 'Add' }));
  expect(screen.getByText('Write it as owner/name.')).toHaveClass('text-[13px]', 'text-bad');
  await user.clear(input);
  await user.type(input, 'Acme/Tools');
  await user.click(within(screen.getByRole('listbox', { name: 'Repository' }).parentElement!).getByRole('button', { name: 'Add' }));
  expect(option(/acme\/tools/)).toHaveAttribute('aria-selected', 'true');
  expect(option(/acme\/tools/)).toHaveTextContent('Defaults');
  expect(screen.queryByRole('textbox', { name: 'Repository to add' })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Add a repository' }));
  await user.type(screen.getByRole('textbox', { name: 'Repository to add' }), 'acme/shop');
  await user.click(within(screen.getByRole('listbox', { name: 'Repository' }).parentElement!).getByRole('button', { name: 'Add' }));
  expect(option(/acme\/shop/)).toHaveAttribute('aria-selected', 'true');
  expect(screen.getAllByRole('option', { name: /acme\/shop/ })).toHaveLength(1);

  await user.click(screen.getByRole('button', { name: 'Add a repository' }));
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('textbox', { name: 'Repository to add' })).toBeNull();
});

test('a repository whose save was refused says so in the list, and its issue stands at its row', async () => {
  const user = userEvent.setup();
  const issues: SettingIssue[] = [{ scope: 'acme/shop', path: 'gate.branches', message: 'A branch name is not valid.' }];
  await open(viewOf(), { saveSettings: () => Promise.resolve({ kind: 'invalid', issues }) });
  await user.click(option(/acme\/shop/));
  await user.click(within(rowOf('Primary branches')).getByRole('button', { name: 'Use the default for Primary branches' }));
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  const shop = await screen.findByRole('option', { name: /acme\/shop/ });
  expect(within(shop).getByText('1 issue')).toHaveClass('bg-bad-bg', 'text-bad');
  expect(rowOf('Gated branches')).toHaveTextContent('A branch name is not valid.');
});

test('the heading switches show their override and can go back to the default', async () => {
  const user = userEvent.setup();
  const { sent } = await open(viewOf(), { saveSettings: () => Promise.resolve({ kind: 'saved', view: viewOf() }) });
  await user.click(option(/acme\/shop/));
  expect(screen.getByText('Overrides Off')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Use the default for Merge gate' }));
  expect(screen.getByRole('switch', { name: 'Merge gate' })).toHaveAttribute('aria-checked', 'false');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(sent()[0]![2]).toEqual({ version: 14, changes: [{ scope: 'acme/shop', path: 'gate.enabled' }] });
  expect(sent()[0]![2]).not.toHaveProperty('changes.0.value');
});

test('the defaults pane says where the gate switch came from', async () => {
  await open(viewOf({ defaults: { 'gate.enabled': written(true) } }));
  expect(screen.getByText('From config.yml at the start of 2026-03-01 09:00 UTC', { selector: 'div.mt-1 span' })).toBeInTheDocument();
});

test("a repository's pane starts fresh, and one with no setting says it is kept once it overrides one", async () => {
  const user = userEvent.setup();
  await open();
  await user.click(option(/acme\/web/));
  expect(screen.getByText('It is kept once it overrides a setting.')).toBeInTheDocument();
  await user.click(within(rowOf('Primary branches')).getByRole('button', { name: 'Add' }));
  expect(screen.getByRole('textbox', { name: 'Add to Primary branches' })).toBeInTheDocument();
  await user.click(option(/acme\/shop/));
  expect(screen.queryByRole('textbox', { name: 'Add to Primary branches' })).toBeNull();
  expect(screen.queryByText('It is kept once it overrides a setting.')).toBeNull();
  expect(option(/acme\/shop/)).toHaveClass('hover:bg-accent-soft');
});

test("the defaults' commit setting says what is not set, and a repository's override of it says what it overrides", async () => {
  const user = userEvent.setup();
  await open(viewOf({ shop: { newHead: written('full') } }));
  expect(within(rowOf('A new commit is reviewed')).getByText('Not set: incremental, and full where the merge gate holds pushes')).toBeInTheDocument();
  await user.click(option(/acme\/shop/));
  expect(within(rowOf('A new commit is reviewed')).getByText('Overrides incremental, and full where the merge gate holds pushes')).toBeInTheDocument();
  expect(within(rowOf('Threshold')).queryByText('Overrides 70%')).toBeNull();
});

test("a threshold override reads its default with a percent", async () => {
  const user = userEvent.setup();
  await open();
  await user.click(option(/acme\/shop/));
  expect(within(rowOf('Threshold')).getByText('Overrides 70%')).toBeInTheDocument();
});
