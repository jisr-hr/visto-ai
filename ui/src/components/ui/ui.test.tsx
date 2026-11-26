import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { NetworkBlockedError } from '../../test/setup.ts';
import { Segmented } from '../segmented.tsx';
import { Badge } from './badge.tsx';
import { Button } from './button.tsx';
import { Card } from './card.tsx';
import { Input } from './input.tsx';
import { Select } from './select.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table.tsx';

// The mockup's pieces (Activity.dc.html: .btn, .card, .badge, .t, .input, .seg) in the plan's classes.
const button =
  'inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-sm font-medium text-text no-underline hover:bg-subtle hover:text-text disabled:cursor-default disabled:opacity-55';
const primary = 'border-accent bg-accent text-on-accent hover:bg-accent hover:text-on-accent';
const card = 'rounded-[12px] border border-border bg-card shadow-card';
const badge = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs leading-5 font-medium';
const tones = [
  ['ok', 'bg-ok-bg text-ok'],
  ['warn', 'bg-warn-bg text-warn'],
  ['bad', 'bg-bad-bg text-bad'],
  ['info', 'bg-info-bg text-info'],
  ['muted', 'bg-subtle text-muted'],
  ['accent', 'bg-accent-soft text-accent-text'],
] as const;
const dot = 'inline-block size-1.5 rounded-full bg-current';
const table = 'w-full border-collapse text-sm';
const head = 'whitespace-nowrap border-b border-border px-4 py-2.5 text-left text-xs font-medium text-muted';
const cell = 'border-b border-border px-4 py-3 align-middle';
const body = '[&_tr:last-child_td]:border-b-0';
const hoverRow = 'hover:[&>td]:bg-subtle';
const field = 'min-h-9 rounded-lg border border-border bg-card px-3 text-sm text-text';
const group = 'inline-flex flex-wrap gap-0.5 rounded-[9px] bg-subtle p-[3px]';
const segment = 'min-h-8 cursor-pointer rounded-[7px] border-0 bg-transparent px-3 py-1.5 text-[13px] font-medium text-muted';
const segmentOn = 'bg-card text-text shadow-card';

function classes(element: Element | null | undefined): string[] {
  return [...(element?.classList ?? [])].sort();
}
function words(...parts: string[]): string[] {
  return parts.join(' ').split(' ').filter(Boolean).sort();
}
function without(names: string, ...removed: string[]): string {
  return names.split(' ').filter((name) => !removed.includes(name)).join(' ');
}

test('a button, a card, a badge of each tone, a table, an input and a select carry the mockup classes', () => {
  render(
    <>
      <Button>Save</Button>
      <Button size="icon" aria-label="Sign out" />
      <Button variant="primary">Sign in with GitHub</Button>
      <Button asChild>
        <a href="/ui/activity">Activity</a>
      </Button>
      <Card>In review now</Card>
      {tones.map(([tone]) => (
        <Badge key={tone} tone={tone}>
          {tone}
        </Badge>
      ))}
      <Badge tone="ok" dot>
        Live
      </Badge>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Pull request</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow hover>
            <TableCell>acme/shop #7</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <Input aria-label="Search" />
      <Select aria-label="Repository">
        <option value="">All repositories</option>
      </Select>
    </>,
  );

  expect(classes(screen.getByRole('button', { name: 'Save' }))).toEqual(words(button));
  expect(classes(screen.getByRole('button', { name: 'Sign out' }))).toEqual(words(without(button, 'px-3.5'), 'px-2.5'));
  expect(classes(screen.getByRole('button', { name: 'Sign in with GitHub' }))).toEqual(
    words(without(button, 'border-border', 'bg-card', 'text-text', 'hover:bg-subtle', 'hover:text-text'), primary),
  );
  const link = screen.getByRole('link', { name: 'Activity' });
  expect(link.tagName).toBe('A');
  expect(link).toHaveAttribute('href', '/ui/activity');
  expect(classes(link)).toEqual(words(button));
  expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();

  expect(classes(screen.getByText('In review now'))).toEqual(words(card));

  for (const [tone, names] of tones) expect(classes(screen.getByText(tone))).toEqual(words(badge, names));
  const live = screen.getByText('Live');
  expect(classes(live)).toEqual(words(badge, 'bg-ok-bg text-ok'));
  expect(live.firstChild).toBe(live.firstElementChild);
  expect(live.firstElementChild?.tagName).toBe('SPAN');
  expect(classes(live.firstElementChild)).toEqual(words(dot));
  expect(live.firstElementChild).toBeEmptyDOMElement();

  expect(classes(screen.getByRole('table'))).toEqual(words(table));
  expect(classes(screen.getByRole('columnheader', { name: 'Pull request' }))).toEqual(words(head));
  expect(classes(screen.getByRole('cell', { name: 'acme/shop #7' }))).toEqual(words(cell));
  const [, rows] = screen.getAllByRole('rowgroup');
  expect(classes(rows)).toEqual(words(body));
  const [headRow, bodyRow] = screen.getAllByRole('row');
  expect(classes(headRow)).toEqual([]);
  expect(classes(bodyRow)).toEqual(words(hoverRow));

  expect(classes(screen.getByRole('textbox', { name: 'Search' }))).toEqual(words(field));
  expect(classes(screen.getByRole('combobox', { name: 'Repository' }))).toEqual(words(field));
});

test('the segmented control marks the one on, and tells which was pressed', async () => {
  const onChange = vi.fn();
  render(
    <Segmented
      label="Outcome"
      options={[
        { value: 'all', label: 'All' },
        { value: 'approved', label: 'Approved' },
      ]}
      value="all"
      onChange={onChange}
    />,
  );

  expect(classes(screen.getByRole('group', { name: 'Outcome' }))).toEqual(words(group));
  const all = screen.getByRole('button', { name: 'All' });
  const approved = screen.getByRole('button', { name: 'Approved' });
  expect(all).toHaveAttribute('type', 'button');
  expect(all).toHaveAttribute('aria-pressed', 'true');
  expect(classes(all)).toEqual(words(without(segment, 'bg-transparent', 'text-muted'), segmentOn));
  expect(approved).toHaveAttribute('type', 'button');
  expect(approved).toHaveAttribute('aria-pressed', 'false');
  expect(classes(approved)).toEqual(words(segment));

  await userEvent.setup().click(approved);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith('approved');
});

test('the network is blocked in tests', async () => {
  await expect(fetch('/api/me')).rejects.toBeInstanceOf(NetworkBlockedError);
  expect(() => new XMLHttpRequest()).toThrow(NetworkBlockedError);
  expect(() => new WebSocket('wss://visto.example.test/api/socket')).toThrow(NetworkBlockedError);
  expect(() => new EventSource('/api/events')).toThrow(NetworkBlockedError);
});

test("the page's storage is jsdom's, cleared after each test", () => {
  localStorage.setItem('k', 'v');
  expect(localStorage.getItem('k')).toBe('v');
  expect(localStorage).toBeInstanceOf(window.Storage);
  document.documentElement.className = 'dark';
});

test('the next test reads the storage and the page class cleared', () => {
  expect(localStorage.getItem('k')).toBeNull();
  expect(document.documentElement.className).toBe('');
});
