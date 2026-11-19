import assert from 'node:assert/strict';
import test from 'node:test';

import { createGithubHookDeliveries } from './hook-deliveries.ts';
import type { AppAuth } from './app-auth.ts';

const auth: AppAuth = { appToken: () => 'jwt', installationToken: async () => 'unused' };

function setup(answers: Array<Response | Error>) {
  const calls: Array<{ url: string; method: string; authorization: string }> = [];
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), method: init?.method ?? 'GET', authorization: headers.get('authorization') ?? '' });
    const next = answers.shift();
    if (next === undefined) throw new Error('no answer left');
    if (next instanceof Error) throw next;
    return next;
  };
  return { hooks: createGithubHookDeliveries({ auth, fetch: stub as typeof fetch }), calls };
}

const item = (id: number, guid: string, deliveredAt: string, statusCode: number) => ({
  id, guid, delivered_at: deliveredAt, redelivery: false, duration: 0.1, status: 'x', status_code: statusCode,
  event: 'pull_request', action: 'opened', installation_id: 99, repository_id: 1,
});
const page = (items: unknown[], next?: string): Response =>
  new Response(JSON.stringify(items), { status: 200, headers: next === undefined ? {} : { link: `<${next}>; rel="next"` } });
const FIRST = 'https://api.github.com/app/hook/deliveries?per_page=100';
const SECOND = 'https://api.github.com/app/hook/deliveries?per_page=100&cursor=c2';

test('deliveries are listed with the app token, following the next link', async () => {
  const { hooks, calls } = setup([
    page([item(12, 'g2', '2026-03-01T10:06:00Z', 503)], SECOND),
    page([item(11, 'g1', '2026-03-01T10:05:00Z', 202)]),
  ]);
  assert.deepEqual(await hooks.listSince('2026-03-01T10:00:00.000Z'), {
    deliveries: [
      { id: '12', guid: 'g2', at: '2026-03-01T10:06:00.000Z', ok: false },
      { id: '11', guid: 'g1', at: '2026-03-01T10:05:00.000Z', ok: true },
    ],
    complete: true,
  });
  assert.deepEqual(calls.map((c) => [c.url, c.authorization]), [[FIRST, 'Bearer jwt'], [SECOND, 'Bearer jwt']]);
});
test('the listing stops at the page whose last delivery is older than asked for, and leaves older ones out', async () => {
  const { hooks, calls } = setup([page([item(12, 'g2', '2026-03-01T10:06:00Z', 503), item(11, 'g1', '2026-03-01T09:00:00Z', 503)], SECOND)]);
  const listed = await hooks.listSince('2026-03-01T10:00:00.000Z');
  assert.deepEqual([listed.deliveries.map((d) => d.id), listed.complete, calls.length], [['12'], true, 1]);
});
test('the listing stops after ten pages and says it is not complete', async () => {
  const pages = Array.from({ length: 12 }, (_, i) => page([item(100 - i, `g${i}`, '2026-03-01T10:06:00Z', 503)], `${FIRST}&cursor=c${i}`));
  const { hooks, calls } = setup(pages);
  const listed = await hooks.listSince('2026-03-01T10:00:00.000Z');
  assert.deepEqual([listed.deliveries.length, listed.complete, calls.length], [10, false, 10]);
});
test('a next link that leaves the deliveries listing is not followed', async () => {
  const { hooks, calls } = setup([page([item(12, 'g2', '2026-03-01T10:06:00Z', 503)], 'https://elsewhere.example.test/app/hook/deliveries?cursor=c2')]);
  const listed = await hooks.listSince('2026-03-01T10:00:00.000Z');
  assert.deepEqual([listed.complete, calls.length], [false, 1]);
});
test('the next entry is found among several entries of the link header', async () => {
  const link = `<${FIRST}&cursor=c0>; rel="prev", <${SECOND}>; rel="next"`;
  const { hooks, calls } = setup([
    new Response(JSON.stringify([item(12, 'g2', '2026-03-01T10:06:00Z', 503)]), { status: 200, headers: { link } }),
    page([item(11, 'g1', '2026-03-01T10:05:00Z', 202)]),
  ]);
  const listed = await hooks.listSince('2026-03-01T10:00:00.000Z');
  assert.deepEqual([listed.deliveries.length, listed.complete, calls.map((c) => c.url)], [2, true, [FIRST, SECOND]]);
});
test('a delivery is ok when its status code is from 200 to 399', async () => {
  const { hooks } = setup([page([200, 202, 399, 0, 400, 503].map((code, i) => item(i + 1, `g${i}`, '2026-03-01T10:06:00Z', code)))]);
  assert.deepEqual((await hooks.listSince('2026-03-01T10:00:00.000Z')).deliveries.map((d) => d.ok), [true, true, true, false, false, false]);
});
test('an item of another shape is refused', async () => {
  await assert.rejects(setup([page([{ id: 'x' }])]).hooks.listSince('2026-03-01T10:00:00.000Z'), /^Error: github_bad_response$/);
});
test('redeliver posts to the attempts of that delivery', async () => {
  const { hooks, calls } = setup([new Response('{}', { status: 202 })]);
  await hooks.redeliver('11');
  assert.deepEqual([calls[0]!.url, calls[0]!.method, calls[0]!.authorization], ['https://api.github.com/app/hook/deliveries/11/attempts', 'POST', 'Bearer jwt']);
});
test('a rate limit has its own code, and any other refusal carries its status', async () => {
  await assert.rejects(setup([new Response('', { status: 429 })]).hooks.redeliver('11'), /^Error: github_rate_limited$/);
  await assert.rejects(setup([new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })]).hooks.redeliver('11'), /^Error: github_rate_limited$/);
  await assert.rejects(setup([new Response('', { status: 422 })]).hooks.redeliver('11'), /^Error: github_422$/);
});
test('a delivery id that is not digits is refused before any request', async () => {
  const { hooks, calls } = setup([]);
  await assert.rejects(hooks.redeliver('1/1'), /^Error: github_bad_path$/);
  assert.equal(calls.length, 0);
});
