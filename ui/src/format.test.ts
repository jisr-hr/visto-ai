import { expect, test } from 'vitest';
import { ago, initials, left, money, plural, took, utc } from './format.ts';

const NOW = '2026-03-01T10:00:00.000Z';
/** The time the given seconds before NOW; a negative count is after it. */
const before = (seconds: number): string => new Date(Date.parse(NOW) - seconds * 1000).toISOString();

test('initials, ages, durations, time left, money and plurals read as pinned', () => {
  expect(initials('octo-lead')).toBe('OL');
  expect(initials('octolead')).toBe('OC');
  expect(initials('')).toBe('?');
  expect(initials('octo_dev')).toBe('OD');
  expect(initials('octo.guest.x')).toBe('OG');
  expect(initials('o')).toBe('O');
  expect(initials('-')).toBe('?');

  expect(ago(before(48), NOW)).toBe('48 s ago');
  expect(ago(before(59.9), NOW)).toBe('59 s ago');
  expect(ago(before(60), NOW)).toBe('1 min ago');
  expect(ago(before(12 * 60), NOW)).toBe('12 min ago');
  expect(ago(before(3 * 3600), NOW)).toBe('3 h ago');
  expect(ago(before(30 * 3600), NOW)).toBe('yesterday');
  expect(ago(before(50 * 3600), NOW)).toBe('2 days ago');
  expect(ago(before(-30), NOW)).toBe('0 s ago');

  expect(took(41000)).toBe('41 s');
  expect(took(72000)).toBe('1 min 12 s');
  expect(took(120000)).toBe('2 min');
  expect(took(400)).toBe('0 s');
  expect(took(-5000)).toBe('0 s');

  expect(left(before(-102), NOW)).toBe('1:42');
  expect(left(before(-101.2), NOW)).toBe('1:42');
  expect(left(before(-9), NOW)).toBe('0:09');
  expect(left(before(5), NOW)).toBe('0:00');

  expect(money(0.084)).toBe('$0.084');
  expect(money(0)).toBe('$0.000');
  expect(money(1.5)).toBe('$1.500');

  expect(plural(1, 'repository', 'repositories')).toBe('1 repository');
  expect(plural(4, 'repository', 'repositories')).toBe('4 repositories');
  expect(plural(0, 'repository', 'repositories')).toBe('0 repositories');
});

test('a duration is rounded to the nearest second, a half up', () => {
  expect(took(1500)).toBe('2 s');
  expect(took(1499)).toBe('1 s');
  expect(took(59_500)).toBe('1 min');
});

test('a time is written in UTC to the minute', () => {
  expect(utc('2026-03-04T10:00:00.000Z')).toBe('2026-03-04 10:00 UTC');
  // The seconds are dropped, not rounded; an offset is read and written as UTC.
  expect(utc('2026-03-01T10:12:59.999Z')).toBe('2026-03-01 10:12 UTC');
  expect(utc('2026-03-04T12:05:00+02:00')).toBe('2026-03-04 10:05 UTC');
  expect(utc('2026-12-31T23:59:00.000-01:00')).toBe('2027-01-01 00:59 UTC');
  expect(utc('x')).toBe('');
  expect(utc('')).toBe('');
});
