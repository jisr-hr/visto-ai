import { expect, test } from 'vitest';
import type { AlertShown, DependencyShown } from './api-types.ts';
import { alertWords, approvalWords, dependencyWords, partsWords } from './words.ts';

const NOW = '2026-03-01T10:00:00.000Z';
/** The time `minutes` before 10:00 on the first of March 2026. */
const before = (minutes: number): string => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

function alert(code: string, details: AlertShown['details'], open: boolean, raisedAt = before(12)): AlertShown {
  return { id: 1, code, details, raisedAt, open };
}

test('each alert code reads with its tone, its badge, its title and its detail', () => {
  const words = (shown: AlertShown) => alertWords(shown, NOW);
  expect(words(alert('model_error', { reason: 'auth', seen_by: 'check' }, true))).toEqual({
    tone: 'bad', badge: 'Failing', title: 'The review model refused the key', detail: 'Seen by the key check, 12 min ago.',
  });
  expect(words(alert('model_error', { reason: 'no_credit', seen_by: 'review' }, true))).toMatchObject({
    title: 'The review model is out of credit', detail: 'Seen by a review, 12 min ago.',
  });
  expect(words(alert('spend_limit', { spent: 50.2, limit: 50 }, true))).toEqual({
    tone: 'bad', badge: 'Failing', title: 'Spend reached the daily limit', detail: '$50.20 of $50.00. Reviews start again with the next UTC day.',
  });
  expect(words(alert('spend_80', { spent: 40.2, limit: 50 }, false))).toEqual({
    tone: 'muted', badge: 'Resolved', title: 'Spend reached 80% of the daily limit', detail: '$40.20 of $50.00, 12 min ago.',
  });
  expect(words(alert('cost_unknown', {}, false))).toEqual({
    tone: 'muted', badge: 'Recent', title: 'A review used tokens but cost nothing', detail: 'Without prices the daily limit sees no spend, 12 min ago.',
  });
  expect(words(alert('mcp_error', { server: 'docs', reason: 'mcp_timeout' }, true))).toEqual({
    tone: 'warn', badge: 'Warning', title: 'MCP server docs is failing', detail: '`mcp_timeout`, 12 min ago.',
  });
  expect(words(alert('mcp_error', { server: 'docs', reason: 'mcp_timeout' }, false))).toMatchObject({ tone: 'muted', badge: 'Resolved' });
  expect(words(alert('extension_error', { extension: 'example', part: 'notify', reason: 'ext_failed' }, true))).toEqual({
    tone: 'warn', badge: 'Warning', title: 'Extension example is failing', detail: 'Its notify part: `ext_failed`, 12 min ago.',
  });
  expect(words(alert('memory_error', { reason: 'db_down' }, true))).toEqual({
    tone: 'bad', badge: 'Failing', title: 'Memory could not be read', detail: '`db_down`, 12 min ago. Reviews go on without it.',
  });
  expect(words(alert('learning_stale', { hours: 30 }, false))).toEqual({
    tone: 'muted', badge: 'Recent', title: 'Learning has not run for 30 hours', detail: '12 min ago.',
  });
  expect(words(alert('lessons_stale', { hours: 50 }, false))).toMatchObject({ title: 'Lessons have not been judged for 50 hours', detail: '12 min ago.' });
  expect(words(alert('gate_check_failed', { reason: 'forbidden' }, false))).toMatchObject({
    title: 'A merge gate check could not be set', detail: '`forbidden`, 12 min ago.',
  });
  expect(words(alert('gate_bypass', {}, false))).toEqual({
    tone: 'muted', badge: 'Recent', title: "A repository's merge gate is in bypass", detail: 'Said at each start, 12 min ago.',
  });
  expect(words(alert('feature_off', { feature: 'the merge gate', missing: 'checks:write' }, true))).toEqual({
    tone: 'warn', badge: 'Warning', title: 'The GitHub App lacks `checks:write`', detail: 'So the merge gate is off. A start finds it once it is granted.',
  });
  expect(words(alert('redelivery_failed', { reason: 'rate_limited' }, false))).toMatchObject({
    title: 'Missed deliveries could not all be asked for again', detail: '`rate_limited`, 12 min ago.',
  });
  expect(words(alert('dismissal_failed', { repo: 'acme/shop', number: 128, reason: 'forbidden' }, true))).toEqual({
    tone: 'bad', badge: 'Failing', title: 'An approval could not be withdrawn', detail: 'acme/shop #128, `forbidden`.',
  });
  expect(words(alert('stale_approval_merged', { repo: 'acme/shop', number: 128 }, false))).toMatchObject({
    title: 'An approval stood when its pull request merged', detail: 'acme/shop #128, 12 min ago.',
  });
  expect(words(alert('something_new', {}, false))).toEqual({ tone: 'muted', badge: 'Recent', title: 'something_new', detail: '12 min ago.' });
});

function dependency(over: Partial<DependencyShown> & Pick<DependencyShown, 'kind'>): DependencyShown {
  return { name: null, model: null, status: 'working', code: null, since: null, seenAt: null, parts: [], missing: [], ...over };
}

test('each dependency reads with its title, badge and line', () => {
  const words = (shown: DependencyShown) => dependencyWords(shown, NOW);
  expect(words(dependency({ kind: 'model', model: 'vendor/model-a', seenAt: before(2) }))).toEqual({
    title: 'Review model', tone: 'ok', badge: 'Working', line: '`vendor/model-a`, checked 2 min ago',
  });
  expect(words(dependency({ kind: 'model', model: 'vendor/model-a', status: 'unknown' }))).toEqual({
    title: 'Review model', tone: 'muted', badge: 'Not checked yet', line: '`vendor/model-a`, not checked yet',
  });
  expect(words(dependency({ kind: 'model', model: 'vendor/model-a', status: 'failing', code: 'auth', since: '2026-03-01T09:42:00.000Z' }))).toEqual({
    title: 'Review model', tone: 'bad', badge: 'Failing', line: '`auth` since 2026-03-01 09:42 UTC',
  });
  expect(words(dependency({ kind: 'scorer', model: 'vendor/decision-model', seenAt: before(1) }))).toMatchObject({
    title: 'Second scorer', line: '`vendor/decision-model`',
  });
  expect(words(dependency({ kind: 'scorer', model: 'vendor/decision-model', status: 'unknown' }))).toMatchObject({ line: '`vendor/decision-model`, not used yet' });
  expect(words(dependency({ kind: 'memory', seenAt: before(5) }))).toMatchObject({ title: 'Memory', badge: 'Working', line: 'Last lookup 5 min ago' });
  expect(words(dependency({ kind: 'memory', status: 'unknown' }))).toMatchObject({ line: 'No lookup yet' });
  expect(words(dependency({ kind: 'mcp', name: 'docs', status: 'failing', code: 'mcp_timeout', since: '2026-03-01T09:42:00.000Z' }))).toEqual({
    title: 'MCP server docs', tone: 'bad', badge: 'Failing', line: '`mcp_timeout` since 2026-03-01 09:42 UTC',
  });
  expect(words(dependency({ kind: 'mcp', name: 'docs', seenAt: before(3) }))).toMatchObject({ line: 'Last used 3 min ago' });
  expect(words(dependency({ kind: 'mcp', name: 'docs', status: 'unknown' }))).toMatchObject({ badge: 'Not checked yet', line: 'Not used yet' });
  const parts = [
    { part: 'context' as const, status: 'working' as const, code: null, since: null },
    { part: 'notify' as const, status: 'working' as const, code: null, since: null },
  ];
  expect(words(dependency({ kind: 'extension', name: 'example', parts }))).toEqual({
    title: 'Extension example', tone: 'ok', badge: 'Working', line: 'Context and notices',
  });
  expect(words(dependency({ kind: 'extension', name: 'example', parts, status: 'unknown' }))).toMatchObject({ line: 'Context and notices, not used yet' });
  expect(words(dependency({
    kind: 'extension', name: 'example', status: 'failing', code: 'ext_failed', since: '2026-03-01T09:42:00.000Z',
    parts: [parts[0]!, { part: 'notify', status: 'failing', code: 'ext_failed', since: '2026-03-01T09:42:00.000Z' }],
  }))).toMatchObject({ badge: 'Failing', line: 'Notices failing: `ext_failed` since 2026-03-01 09:42 UTC' });
  expect(words(dependency({ kind: 'app' }))).toEqual({ title: 'GitHub App', tone: 'ok', badge: 'Working', line: 'Permissions and events as needed' });
  expect(words(dependency({ kind: 'app', status: 'unknown' }))).toMatchObject({ tone: 'muted', badge: 'Not checked yet', line: 'Not checked yet' });
  expect(words(dependency({
    kind: 'app', missing: [{ feature: 'reviews', missing: 'event:pull_request_review' }, { feature: 'gate', missing: 'checks:write' }],
  }))).toEqual({ title: 'GitHub App', tone: 'warn', badge: 'Missing 2', line: 'Event `pull_request_review` not subscribed, and 1 more' });
  expect(words(dependency({ kind: 'app', missing: [{ feature: 'gate', missing: 'checks:write' }] }))).toMatchObject({
    badge: 'Missing 1', line: 'Permission `checks` (write) not granted',
  });
});

test('a list of parts reads as words joined with a comma and an and', () => {
  expect(partsWords(['context', 'notify'])).toBe('Context and notices');
  expect(partsWords(['context', 'notify', 'alert'])).toBe('Context, notices and alerts');
  expect(partsWords(['route'])).toBe('A route');
  expect(partsWords([])).toBe('');
});

test('automatic approval reads in short', () => {
  expect(approvalWords({ enabled: false, threads: 'strict', auditShare: 5 })).toEqual({ tone: 'muted', text: 'Off' });
  expect(approvalWords({ enabled: true, threads: 'strict', auditShare: 5 })).toEqual({ tone: 'ok', text: 'On, strict, 5% audit' });
  expect(approvalWords({ enabled: true, threads: 'gate', auditShare: 10 })).toEqual({ tone: 'ok', text: 'On, gate rule, 10% audit' });
  expect(approvalWords({ enabled: true, threads: 'strict', auditShare: 0 })).toEqual({ tone: 'ok', text: 'On, strict, no audit' });
});
