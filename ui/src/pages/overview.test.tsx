import { act, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { RequestFailed } from '../api.ts';
import type { Api } from '../api.ts';
import type { Activity, ActivityJob, AlertShown, Health, Me, Overview, OverviewQuality, Reviews } from '../api-types.ts';
import { App } from '../app.tsx';
import { OVERVIEW_MS, HEALTH_MS } from './overview.tsx';

const NOW = '2026-03-01T10:00:00.000Z';
/** The time `seconds` after 10:00:00 on the first of March 2026, before it when negative. */
const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

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
  const queries = (): unknown[] => calls.filter(([name]) => name === 'reviews').map(([, query]) => query);
  return { api, calls, queries };
}

function job(stage: string, id: number): ActivityJob {
  return {
    job: id, stage, repository: 'acme/shop', number: 130 + id, title: 'Cache the tax table per region', url: 'https://github.example.test/acme/shop/pull/131',
    head: 'a41c09e2b7d3', batch: null, batches: null, threadsDue: null, startedAt: null, runAt: NOW, askedBy: { reason: 'synchronize', login: null },
  } as ActivityJob;
}

/** The 30 days up to the first of March 2026, `published` and the rest as `over` says for a day's index. */
function perDay(over: (i: number) => Partial<Overview['perDay'][number]> = () => ({})): Overview['perDay'] {
  return Array.from({ length: 30 }, (_, i) => ({
    day: new Date(Date.parse('2026-03-01T00:00:00.000Z') - (29 - i) * 86_400_000).toISOString().slice(0, 10), published: 6, failed: 0, other: 0, cost: 1, ...over(i),
  }));
}

const APPROVAL = { enabled: true, threads: 'strict', auditShare: 5 } as const;
function quality(repository: string, over: Partial<OverviewQuality> = {}): OverviewQuality {
  return {
    repository, threshold: 70, state: 'ready', safety: { share: 0.041, part: 3, of: 74 }, benefit: { share: 0.41, part: 52, of: 127 },
    focus: { share: 0.18, part: 0, of: 0 }, reverts: { merged: 2, approved: 0 }, approval: APPROVAL, ...over,
  };
}

const OVERVIEW: Overview = {
  now: NOW, days: 30, repositories: 4,
  reviews: { total: 1234, published: 398, dryRun: 9, failed: 5, nothingNew: 0, notPosted: 0 },
  spend: { today: 12.4, limit: 50 }, approvals: { approved: 38, audited: 6 },
  perDay: perDay(), quality: [quality('acme/shop')], qualityCut: 0,
};

const HEALTH: Health = { now: NOW, dependencies: [], open: [], recent: [] };

function alert(id: number, code: string, details: AlertShown['details'], open: boolean): AlertShown {
  return { id, code, details, raisedAt: at(-720), open };
}

/** The Overview opened in the app, with `api` behind it. */
function open(api: Api) {
  window.history.replaceState(null, '', '/ui/');
  return render(<App api={api} />);
}
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const classes = (element: Element | null | undefined): string[] => [...(element?.classList ?? [])].sort();
const words = (...parts: string[]): string[] => parts.join(' ').split(' ').filter(Boolean).sort();
/** The card of a summary label: its parent. */
const box = (label: string): HTMLElement => screen.getByText(label, { selector: 'span' }).parentElement!;
const cardOf = (heading: string): HTMLElement => screen.getByRole('heading', { level: 2, name: heading }).closest('[data-slot="card"]') as HTMLElement;
const tones = { bad: 'bg-bad-bg text-bad', warn: 'bg-warn-bg text-warn', muted: 'bg-subtle text-muted', ok: 'bg-ok-bg text-ok' } as const;
const badge = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs leading-5 font-medium';

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

test('the summary cards say the reviews, what is in review now, the spend and the approvals', async () => {
  const jobs = [job('reviewing', 1), job('reviewing', 2), job('waiting', 3), job('queued', 4)];
  const { api } = fakeApi({
    overview: () => Promise.resolve(OVERVIEW), health: () => Promise.resolve(HEALTH),
    activity: () => Promise.resolve({ ...ACTIVITY, jobs }),
  });
  open(api);

  expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  expect(await screen.findByText('Last 30 days across 4 repositories')).toBeInTheDocument();
  const summary = screen.getByRole('region', { name: 'Summary' });
  expect(classes(summary)).toEqual(words('grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4'));

  const reviews = box('Reviews');
  expect(within(reviews).getByText('1,234')).toBeInTheDocument();
  expect(within(reviews).getByText('398 published, 9 in dry run, 5 failed')).toBeInTheDocument();
  expect(classes(reviews)).toEqual(words('rounded-[12px] border border-border bg-card shadow-card flex flex-col gap-2 p-[18px]'));
  expect(classes(within(reviews).getByText('1,234'))).toEqual(words('text-[30px] font-semibold leading-[1.1] tracking-[-0.02em]'));
  expect(classes(within(reviews).getByText('Reviews'))).toEqual(words('text-[13px] font-medium text-muted'));

  const now = await screen.findByText('2 reviewing, 1 waiting for pushes to settle, 1 queued');
  const link = now.closest('a');
  expect(link).toHaveAttribute('href', '/ui/activity');
  expect(classes(link)).toEqual(words('rounded-[12px] border border-border bg-card shadow-card flex flex-col gap-2 p-[18px] text-text no-underline'));
  expect(within(link!).getByText('In review now')).toBeInTheDocument();
  expect(within(link!).getByText('3')).toBeInTheDocument();

  const spend = box('Spend today');
  expect(within(spend).getByText('$12.40')).toBeInTheDocument();
  expect(within(spend).getByText('of the $50.00 daily limit')).toBeInTheDocument();
  const bar = within(spend).getByRole('img', { name: '25 percent of the daily limit' });
  expect(classes(bar)).toEqual(words('h-1.5 overflow-hidden rounded-full bg-subtle'));
  expect(classes(bar.firstElementChild)).toEqual(words('block h-full rounded-full bg-accent'));
  expect((bar.firstElementChild as HTMLElement).style.width).toBe('25%');

  const approved = box('Approved automatically');
  expect(within(approved).getByText('38')).toBeInTheDocument();
  expect(within(approved).getByText('of 44 approvable, 6 drawn for the audit')).toBeInTheDocument();
});

test('the spend bar stops at the limit, a review not read says so, and a dry run does not decide approvals', async () => {
  const { api } = fakeApi({
    me: () => Promise.resolve({ ...ME, mode: 'dry_run' }), activity: () => Promise.reject(new RequestFailed(500, 'internal_error')),
    overview: () => Promise.resolve({ ...OVERVIEW, spend: { today: 60, limit: 50 }, reviews: { ...OVERVIEW.reviews, nothingNew: 2, notPosted: 3 } }),
    health: () => Promise.resolve(HEALTH),
  });
  open(api);

  expect(await screen.findByRole('img', { name: '100 percent of the daily limit' })).toBeInTheDocument();
  expect(screen.getByText('398 published, 9 in dry run, 5 failed, 2 with nothing new, 3 not posted')).toBeInTheDocument();
  const now = box('In review now');
  expect(within(now).getByText('0')).toBeInTheDocument();
  expect(within(now).getByText('Not read yet.')).toBeInTheDocument();
  expect(within(box('Approved automatically')).getByText('Not decided in dry run')).toBeInTheDocument();
  expect(screen.queryByText(/approvable/)).toBeNull();
});

test('the period is sent to the server, and the overview is read again every minute and health every fifteen seconds', async () => {
  vi.useFakeTimers();
  const { api, calls } = fakeApi({ overview: () => Promise.resolve(OVERVIEW), health: () => Promise.resolve(HEALTH) });
  const count = (name: string): number => calls.filter(([one]) => one === name).length;
  open(api);
  await settle();

  expect(OVERVIEW_MS).toBe(60000);
  expect(HEALTH_MS).toBe(15000);
  expect(calls.filter(([name]) => name === 'overview')).toEqual([['overview', 30]]);
  const period = screen.getByRole('group', { name: 'Period' });
  expect(within(period).getAllByRole('button').map((button) => button.textContent)).toEqual(['7 days', '30 days', '90 days']);
  expect(within(period).getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');

  await act(() => vi.advanceTimersByTimeAsync(14999));
  expect(count('health')).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(count('health')).toBe(2);
  await act(() => vi.advanceTimersByTimeAsync(15000));
  expect(count('health')).toBe(3);
  expect(count('overview')).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(count('overview')).toBe(2);

  await act(async () => {
    within(period).getByRole('button', { name: '7 days' }).click();
  });
  await settle();
  expect(calls.filter(([name]) => name === 'overview').at(-1)).toEqual(['overview', 7]);
  expect(within(period).getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('Last 7 days across 4 repositories')).toBeInTheDocument();

  // A page that is hidden reads nothing.
  const reads = calls.length;
  const state = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  const overviews = count('overview');
  const healths = count('health');
  await act(() => vi.advanceTimersByTimeAsync(180000));
  expect([count('overview'), count('health')]).toEqual([overviews, healths]);
  expect(calls.length).toBeGreaterThanOrEqual(reads);
  Reflect.deleteProperty(document, 'visibilityState');
  if (state !== undefined) Object.defineProperty(Document.prototype, 'visibilityState', state);
});

test('reviews per day draw one column a day with its counts and spend in its title', async () => {
  const days = perDay((i) => (i === 5 ? { published: 22 } : i === 14 ? { published: 12, failed: 1, cost: 3.1 } : {}));
  const { api } = fakeApi({ overview: () => Promise.resolve({ ...OVERVIEW, perDay: days }), health: () => Promise.resolve(HEALTH) });
  const first = open(api);

  const chart = await screen.findByRole('img', { name: 'Reviews per day over the last 30 days, between 6 and 22 a day' });
  expect(classes(chart)).toEqual(words('flex h-[180px] items-end gap-[5px] border-b border-border pt-2'));
  expect(chart.children).toHaveLength(30);
  const column = within(chart).getByTitle('Feb 14: 12 published, 0 dry run or not posted, 1 failed, $3.10 spent');
  expect(classes(column)).toEqual(words('flex h-full flex-1 flex-col justify-end gap-0.5'));
  // The failed part is on top of the published one, each as tall as its share of the busiest day.
  expect([...column.children].map((part) => classes(part))).toEqual([
    words('rounded-[3px] bg-bad'), words('rounded-t-[4px] rounded-b-[2px] bg-accent opacity-90'),
  ]);
  expect((column.children[1] as HTMLElement).style.height).toBe(`${(12 / 22) * 100}%`);
  expect((column.children[0] as HTMLElement).style.height).toBe(`${(1 / 22) * 100}%`);
  const tallest = chart.children[5] as HTMLElement;
  expect(tallest.children).toHaveLength(1);
  expect((tallest.firstElementChild as HTMLElement).style.height).toBe('100%');

  // The legend and the axis.
  const card = cardOf('Reviews per day');
  expect(classes(card)).toEqual(words('rounded-[12px] border border-border bg-card shadow-card flex min-w-0 grow-[2] basis-[520px] flex-col gap-4 p-5'));
  expect(within(card).getByText('Published')).toBeInTheDocument();
  expect(within(card).getByText('Failed')).toBeInTheDocument();
  expect(within(card).queryByText('Dry run or not posted')).toBeNull();
  const square = within(card).getByText('Published').firstElementChild;
  expect(classes(square)).toEqual(words('size-2.5 rounded-[3px] bg-accent'));
  expect(within(card).getByText('Today')).toBeInTheDocument();
  expect(within(card).getByText('Jan 31')).toBeInTheDocument();
  expect(within(card).getByText(chartMiddle(days))).toBeInTheDocument();
  first.unmount();

  const other = perDay((i) => (i === 3 ? { other: 1 } : {}));
  const { api: second } = fakeApi({ overview: () => Promise.resolve({ ...OVERVIEW, perDay: other }), health: () => Promise.resolve(HEALTH) });
  open(second);
  const again = await screen.findByRole('img', { name: /^Reviews per day over the last 30 days/ });
  expect(within(cardOf('Reviews per day')).getByText('Dry run or not posted')).toBeInTheDocument();
  expect([...again.children[3]!.children].map((part) => classes(part))).toEqual([
    words('rounded-[3px] bg-muted'), words('rounded-t-[4px] rounded-b-[2px] bg-accent opacity-90'),
  ]);
});

/** The label of the middle day of the axis, as the first plan's `shortDay` says it. */
function chartMiddle(days: Overview['perDay']): string {
  const day = days[Math.floor(days.length / 2)]!.day;
  const [, month, date] = day.split('-');
  return `${['Jan', 'Feb', 'Mar'][Number(month) - 1]} ${Number(date)}`;
}

test('alerts list the open ones then the recent ones, and say when there is none', async () => {
  const recent = ['gate_bypass', 'cost_unknown', 'learning_stale', 'lessons_stale', 'redelivery_failed', 'gate_check_failed', 'stale_approval_merged'];
  const health: Health = {
    ...HEALTH,
    open: [alert(1, 'dismissal_failed', { repo: 'acme/shop', number: 128, reason: 'forbidden' }, true), alert(2, 'mcp_error', { server: 'docs', reason: 'mcp_timeout' }, true)],
    recent: recent.map((code, i) => alert(10 + i, code, { hours: 30, reason: 'rate_limited' }, false)),
  };
  const { api } = fakeApi({ overview: () => Promise.resolve(OVERVIEW), health: () => Promise.resolve(health) });
  const first = open(api);

  const count = await screen.findByText('2 open');
  expect(classes(count)).toEqual(words(badge, tones.bad));
  const card = cardOf('Alerts');
  expect(classes(card)).toEqual(words('rounded-[12px] border border-border bg-card shadow-card flex min-w-0 grow basis-[320px] flex-col gap-3.5 p-5'));
  const titles = within(card).getAllByText(/./, { selector: 'strong' }).map((title) => title.textContent);
  expect(titles).toEqual([
    'An approval could not be withdrawn', 'MCP server docs is failing', "A repository's merge gate is in bypass", 'A review used tokens but cost nothing',
    'Learning has not run for 30 hours', 'Lessons have not been judged for 30 hours', 'Missed deliveries could not all be asked for again',
  ]);
  expect(within(card).getByText('Failing')).toBeInTheDocument();
  expect(classes(within(card).getByText('Failing'))).toEqual(words(badge, tones.bad, 'mt-0.5'));
  expect(classes(within(card).getByText('Warning'))).toEqual(words(badge, tones.warn, 'mt-0.5'));
  expect(within(card).getAllByText('Recent')).toHaveLength(5);
  expect(classes(within(card).getByText('mcp_timeout'))).toEqual(words('font-mono text-[12.5px]'));
  expect(classes(within(card).getByText('Warning').nextElementSibling?.firstElementChild)).toEqual(words('font-semibold'));
  expect(classes(within(card).getByText('Warning').nextElementSibling?.lastElementChild)).toEqual(words('text-[13px] text-muted'));
  first.unmount();

  const { api: none } = fakeApi({ overview: () => Promise.resolve(OVERVIEW), health: () => Promise.resolve(HEALTH) });
  const second = open(none);
  const quiet = await screen.findByText('None open');
  expect(classes(quiet)).toEqual(words(badge, tones.muted));
  expect(screen.getByText('No alert in the last 7 days.')).toBeInTheDocument();
  expect(classes(screen.getByText('No alert in the last 7 days.'))).toEqual(words('text-sm text-muted'));
  second.unmount();

  // The answer holds the 50 newest open alerts: at 50 the badge says there may be more.
  const fifty: Health = { ...HEALTH, open: Array.from({ length: 50 }, (_, i) => alert(100 + i, 'mcp_error', { server: `server-${i}`, reason: 'mcp_timeout' }, true)) };
  const { api: many } = fakeApi({ overview: () => Promise.resolve(OVERVIEW), health: () => Promise.resolve(fifty) });
  const third = open(many);
  expect(classes(await screen.findByText('50+ open'))).toEqual(words(badge, tones.bad));
  third.unmount();
  const { api: almost } = fakeApi({ overview: () => Promise.resolve(OVERVIEW), health: () => Promise.resolve({ ...fifty, open: fifty.open.slice(1) }) });
  const fourth = open(almost);
  expect(await screen.findByText('49 open')).toBeInTheDocument();
  fourth.unmount();

  const { api: failed } = fakeApi({ overview: () => Promise.resolve(OVERVIEW), health: () => Promise.reject(new RequestFailed(500, 'internal_error')) });
  open(failed);
  expect(await screen.findByText('The alerts could not be read.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

/** The row of the table that holds the link named `name`. */
const rowOf = (name: string): HTMLElement => screen.getByRole('link', { name }).closest('tr')!;
const cellsOf = (name: string): HTMLElement[] => within(rowOf(name)).getAllByRole('cell');

test('score quality by repository shows each number with its count, and too few labels as such', async () => {
  const rows = [
    quality('acme/shop'),
    quality('acme/quiet', { reverts: { merged: 0, approved: 0 } }),
    quality('acme/infra', { safety: { share: null, part: 0, of: 4 }, benefit: { share: null, part: 0, of: 0 }, focus: { share: null, part: 0, of: 0 }, reverts: { merged: 3, approved: 1 }, approval: { enabled: false, threads: 'strict', auditShare: 5 } }),
  ];
  const { api } = fakeApi({ overview: () => Promise.resolve({ ...OVERVIEW, quality: rows, qualityCut: 1 }), health: () => Promise.resolve(HEALTH) });
  open(api);

  const section = await screen.findByRole('region', { name: 'Score quality by repository' });
  expect(section.tagName).toBe('SECTION');
  expect(classes(section)).toEqual(words('rounded-[12px] border border-border bg-card shadow-card overflow-hidden'));
  expect(within(section).getAllByRole('columnheader').map((head) => head.textContent)).toEqual([
    'Repository', 'Threshold', 'Safety (lower is better)', 'Benefit', 'Focus', 'Reverts', 'Automatic approval',
  ]);
  expect(within(section).getByRole('link', { name: 'All numbers' })).toHaveAttribute('href', '/ui/repositories');
  expect(screen.getByRole('link', { name: 'acme/shop' })).toHaveAttribute('href', '/ui/repositories?repo=acme%2Fshop');

  const shop = cellsOf('acme/shop');
  expect(shop.map((cell) => cell.textContent)).toEqual(['acme/shop', '70%', '4% 3 of 74 blocks', '41% 52 of 127', '18% of lines', '2 (0 approved)', 'On, strict, 5% audit']);
  expect(within(shop[2]!).getByText('4%').tagName).toBe('STRONG');
  expect(classes(within(shop[2]!).getByText('3 of 74 blocks'))).toEqual(words('text-muted'));
  expect(classes(within(shop[6]!).getByText('On, strict, 5% audit'))).toEqual(words(badge, tones.ok));

  expect(cellsOf('acme/quiet')[5]!.textContent).toBe('0');
  const infra = cellsOf('acme/infra');
  expect(infra.map((cell) => cell.textContent)).toEqual(['acme/infra', '70%', 'Not enough labels yet, 0 of 4 blocks', 'None', 'None', '3 (1 approved)', 'Off']);
  expect(classes(within(infra[2]!).getByText('Not enough labels yet, 0 of 4 blocks'))).toEqual(words('text-muted'));
  expect(classes(within(infra[3]!).getByText('None'))).toEqual(words('text-muted'));
  expect(classes(within(infra[5]!).getByText('(1 approved)'))).toEqual(words('text-muted'));

  expect(within(section).getByText(
    'Safety: of the blocks a person stepped in on, the share the score would have left to the bot. Benefit: the share of pull requests where nothing reached the threshold. '
    + 'Focus: in pull requests that needed a person, the share of changed lines flagged for them.',
  )).toHaveClass('border-t', 'border-border', 'px-5', 'pt-3', 'pb-4', 'text-[13px]', 'text-muted');
  expect(within(section).getByText('And 1 more repository, in Repositories.')).toBeInTheDocument();
});

test('no repository reviewed, and several cut, are said', async () => {
  const { api } = fakeApi({ overview: () => Promise.resolve({ ...OVERVIEW, repositories: 0, quality: [] }), health: () => Promise.resolve(HEALTH) });
  const first = open(api);
  const none = await screen.findByText('No repository was reviewed in the last 30 days.');
  expect(none.tagName).toBe('TD');
  expect(none).toHaveAttribute('colspan', '7');
  expect(screen.getByText('Last 30 days, no repository reviewed')).toBeInTheDocument();
  first.unmount();

  const { api: one } = fakeApi({ overview: () => Promise.resolve({ ...OVERVIEW, repositories: 1, quality: [quality('acme/shop')], qualityCut: 5 }), health: () => Promise.resolve(HEALTH) });
  open(one);
  expect(await screen.findByText('And 5 more repositories, in Repositories.')).toBeInTheDocument();
  expect(screen.getByText('Last 30 days across 1 repository')).toBeInTheDocument();
});

test('a repository not measured yet, or whose measuring failed, says so in its row', async () => {
  const rows = [
    quality('acme/shop', { state: 'computing', safety: null, benefit: null, focus: null, reverts: null }),
    quality('acme/web', { state: 'failed', threshold: 60, safety: null, benefit: null, focus: null, reverts: null, approval: { enabled: true, threads: 'gate', auditShare: 10 } }),
  ];
  const { api } = fakeApi({ overview: () => Promise.resolve({ ...OVERVIEW, quality: rows }), health: () => Promise.resolve(HEALTH) });
  open(api);

  await screen.findByRole('link', { name: 'acme/shop' });
  const shop = cellsOf('acme/shop');
  expect(shop.map((cell) => cell.textContent)).toEqual(['acme/shop', '70%', 'Not measured yet', 'On, strict, 5% audit']);
  expect(shop[2]).toHaveAttribute('colspan', '4');
  expect(shop[2]).toHaveClass('text-muted');
  const web = cellsOf('acme/web');
  expect(web.map((cell) => cell.textContent)).toEqual(['acme/web', '60%', 'Could not be measured', 'On, gate rule, 10% audit']);
});

test('the dependencies show each with its state', async () => {
  const health: Health = {
    ...HEALTH,
    dependencies: [
      { kind: 'model', name: null, model: 'vendor/model-a', status: 'working', code: null, since: null, seenAt: at(-120), parts: [], missing: [] },
      { kind: 'mcp', name: 'docs', model: null, status: 'failing', code: 'mcp_timeout', since: '2026-03-01T09:42:00.000Z', seenAt: null, parts: [], missing: [] },
      { kind: 'app', name: null, model: null, status: 'failing', code: null, since: null, seenAt: null, parts: [], missing: [{ feature: 'reviews', missing: 'event:pull_request_review' }] },
    ],
  };
  const { api } = fakeApi({ overview: () => Promise.resolve(OVERVIEW), health: () => Promise.resolve(health) });
  open(api);

  const card = (await screen.findByText('Review model')).closest('[data-slot="card"]') as HTMLElement;
  expect(within(card).getByRole('heading', { level: 2, name: 'Dependencies' })).toBeInTheDocument();
  expect(classes(card)).toEqual(words('rounded-[12px] border border-border bg-card shadow-card flex flex-col gap-3.5 p-5'));
  const boxes = card.querySelectorAll<HTMLElement>('[data-slot="dependency"]');
  expect(boxes).toHaveLength(3);
  expect(classes(boxes[0])).toEqual(words('flex flex-col gap-1.5 rounded-[10px] border border-border px-3.5 py-3'));
  expect(classes(boxes[0]!.parentElement)).toEqual(words('grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3'));
  expect(boxes[0]).toHaveTextContent('Review modelWorkingvendor/model-a, checked 2 min ago');
  expect(classes(within(boxes[0]!).getByText('vendor/model-a'))).toEqual(words('font-mono text-[12.5px]'));
  expect(classes(within(boxes[0]!).getByText('Review model'))).toEqual(words('text-sm font-semibold'));
  expect(classes(within(boxes[0]!).getByText('Working'))).toEqual(words(badge, tones.ok));
  expect(within(boxes[0]!).getByText('Working').firstElementChild).toHaveClass('size-1.5');
  expect(boxes[1]).toHaveTextContent('MCP server docsFailingmcp_timeout since 2026-03-01 09:42 UTC');
  expect(classes(within(boxes[1]!).getByText('Failing'))).toEqual(words(badge, tones.bad));
  expect(boxes[2]).toHaveTextContent('GitHub AppMissing 1Event pull_request_review not subscribed');
  expect(classes(within(boxes[2]!).getByText('Missing 1'))).toEqual(words(badge, tones.warn));
  expect(classes(within(boxes[2]!).getByText(/not subscribed/))).toEqual(words('text-[13px] text-muted'));
});

test('dependencies that cannot be read say so', async () => {
  const { api } = fakeApi({ overview: () => Promise.resolve(OVERVIEW), health: () => Promise.reject(new RequestFailed(500, 'internal_error')) });
  open(api);
  expect(await screen.findByText('The dependencies could not be read.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('an overview that cannot be read says so with no alert role, keeps its header, and Try again reads again', async () => {
  let answer: () => Promise<Overview> = () => Promise.reject(new RequestFailed(500, 'internal_error'));
  const { api, calls } = fakeApi({ overview: () => answer(), health: () => Promise.reject(new RequestFailed(500, 'internal_error')) });
  open(api);

  expect(await screen.findByText('The overview could not be read.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  expect(screen.getByText('Last 30 days')).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Period' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('Reviews per day')).toBeNull();

  answer = () => Promise.resolve(OVERVIEW);
  const before = calls.filter(([name]) => name === 'overview').length;
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Last 30 days across 4 repositories')).toBeInTheDocument();
  expect(calls.filter(([name]) => name === 'overview').length).toBeGreaterThan(before);
  expect(screen.queryByText('The overview could not be read.')).toBeNull();
});

test('while the overview is read, the page shows its header and a busy mark', async () => {
  const { api } = fakeApi({ overview: () => new Promise<Overview>(() => undefined), health: () => new Promise<Health>(() => undefined) });
  open(api);

  expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  expect(screen.getByText('Last 30 days')).toBeInTheDocument();
  expect(screen.getByRole('main').querySelector('div[aria-busy="true"]')).not.toBeNull();
  expect(screen.queryByText('The overview could not be read.')).toBeNull();
});

test('an open alert shows from the health read alone, before the overview answers and when it fails', async () => {
  const health: Health = { ...HEALTH, open: [alert(1, 'feature_off', { feature: 'gate', missing: 'checks:write' }, true)] };
  const { api } = fakeApi({ overview: () => new Promise<Overview>(() => undefined), health: () => Promise.resolve(health) });
  const first = open(api);
  expect(await screen.findByText('The GitHub App lacks checks:write')).toBeInTheDocument();
  expect(screen.getByText('gate')).toHaveClass('font-mono');
  expect(screen.getByText('1 open')).toBeInTheDocument();
  expect(screen.getByText('Dependencies')).toBeInTheDocument();
  first.unmount();

  const { api: failed } = fakeApi({ overview: () => Promise.reject(new RequestFailed(500, 'internal_error')), health: () => Promise.resolve(health) });
  open(failed);
  expect(await screen.findByText('The overview could not be read.')).toBeInTheDocument();
  expect(screen.getByText('The GitHub App lacks checks:write')).toBeInTheDocument();
});
