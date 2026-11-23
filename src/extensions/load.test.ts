import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { ExtensionConfig } from '../config/load.ts';
import type { PullRequestInfo } from '../forge/types.ts';
import { alertSinksOf, contextProvidersOf, loadExtensions, notifiersOf } from './load.ts';
import type { FeedbackAnswer, FeedbackOutcome, LoadedExtension, ReviewNotice, RouteRequest } from './types.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PR: PullRequestInfo = {
  ref: { service: 'github', owner: 'acme', repo: 'shop', number: 7 },
  title: 'Add the cart', description: 'For SHOP-12.', author: 'octo-dev',
  baseBranch: 'main', headBranch: 'shop-12-cart', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), draft: false,
};
const NOTICE: ReviewNotice = {
  run: 12, repository: 'acme/shop', number: 7, title: 'Add the cart', author: 'octo-dev', headSha: 'b'.repeat(40),
  mode: 'full', trigger: 'automatic', reviewUrl: 'https://git.example.test/acme/shop/pull/7#review-1',
  pullRequestUrl: 'https://git.example.test/acme/shop/pull/7', needsHuman: true, highestScore: 4,
  findings: { blocker: 0, major: 1, minor: 2 }, body: 'The review.',
};
const fn = async () => ({ status: 'empty' as const });

function harness(overrides: {
  importModule?: (specifier: string) => Promise<unknown>;
  setupTimeoutMs?: number;
  feedback?: FeedbackOutcome;
} = {}) {
  const logged: Array<Record<string, unknown>> = [];
  const reported: Array<[string, FeedbackAnswer]> = [];
  const deps = {
    configDir: ROOT,
    log: (entry: Record<string, unknown>) => { logged.push(entry); },
    reportFeedback: async (extension: string, answer: FeedbackAnswer): Promise<FeedbackOutcome> => {
      reported.push([extension, answer]);
      return overrides.feedback ?? { ok: true };
    },
    ...(overrides.importModule ? { importModule: overrides.importModule } : {}),
    ...(overrides.setupTimeoutMs !== undefined ? { setupTimeoutMs: overrides.setupTimeoutMs } : {}),
  };
  return { deps, logged, reported };
}
const withDefault = (value: unknown) => async () => ({ default: value });
const exampleConfig = (secret: unknown): ExtensionConfig => ({ name: 'example', module: './examples/extension-example.ts', options: { secret } });
const request = (over: Partial<RouteRequest>): RouteRequest => ({
  method: 'POST', path: '/feedback', query: '', headers: {}, body: Buffer.from(''), ...over,
});
const signal = () => new AbortController().signal;

test('the example module is loaded from its path by the real import, and its parts are named', async () => {
  const h = harness();
  const loaded = await loadExtensions([exampleConfig('s3')], h.deps);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.name, 'example');
  assert.deepEqual(Object.keys(loaded[0]!.parts), ['context', 'notify', 'route']);
  assert.equal(loaded[0]!.parts.alert, undefined);
  assert.deepEqual(h.logged, [{ event: 'extension_loaded', extension: 'example', parts: ['context', 'notify', 'route'] }]);
});

test('the example answers a fixed text and two criteria, logs a notice, and reports an answer only to a caller that knows the secret', async () => {
  const h = harness();
  const [example] = await loadExtensions([exampleConfig('s3')], h.deps);
  const parts = example!.parts;
  assert.deepEqual(await parts.context!(PR, signal()), {
    status: 'ok', label: 'example note',
    text: 'This text comes from the example extension. A real module would return the ticket of the pull request here.',
    criteria: ['The change has a test.', 'The pull request says what it changes.'],
  });
  h.logged.length = 0;
  await parts.notify!(NOTICE, signal());
  assert.deepEqual(h.logged, [{ what: 'review_published', run: 12, needs_human: true, event: 'extension_log', extension: 'example' }]);

  const good = JSON.stringify({ run: 12, login: 'octo-dev', vote: 'down', reason: 'missed the point' });
  const secret = { 'x-example-secret': 's3' };
  assert.equal((await parts.route!(request({ method: 'GET', headers: secret, body: Buffer.from(good) }), signal())).status, 404);
  assert.deepEqual(await parts.route!(request({ path: '/other', headers: secret, body: Buffer.from(good) }), signal()), { status: 404, body: 'not_found' });
  for (const headers of [{}, { 'x-example-secret': 'wrong' }, { 'x-example-secret': 's3x' }]) {
    assert.deepEqual(await parts.route!(request({ headers, body: Buffer.from(good) }), signal()), { status: 401, body: 'unauthorized' });
  }
  const empty = harness();
  const [refusing] = await loadExtensions([exampleConfig('')], empty.deps);
  for (const headers of [{}, { 'x-example-secret': '' }]) {
    assert.deepEqual(await refusing!.parts.route!(request({ headers, body: Buffer.from(good) }), signal()), { status: 401, body: 'unauthorized' });
  }
  const notString = harness();
  const [refusing2] = await loadExtensions([exampleConfig(5)], notString.deps);
  assert.deepEqual(await refusing2!.parts.route!(request({ headers: { 'x-example-secret': '5' }, body: Buffer.from(good) }), signal()), { status: 401, body: 'unauthorized' });
  assert.deepEqual([...h.reported, ...empty.reported, ...notString.reported], []);

  for (const body of ['not json', '[]', 'null', JSON.stringify({ run: '12', login: 'octo-dev', vote: 'up' }), JSON.stringify({ run: 12, login: 'octo-dev', vote: 'up', reason: 5 })]) {
    assert.deepEqual(await parts.route!(request({ headers: secret, body: Buffer.from(body) }), signal()), { status: 400, body: 'bad_request' }, body);
  }
  assert.deepEqual(h.reported, []);
  assert.deepEqual(await parts.route!(request({ headers: secret, body: Buffer.from(good) }), signal()), {
    status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}',
  });
  assert.deepEqual(h.reported, [['example', { run: 12, login: 'octo-dev', vote: 'down', reason: 'missed the point' }]]);

  const failing = harness({ feedback: { ok: false, code: 'unknown_run' } });
  const [other] = await loadExtensions([exampleConfig('s3')], failing.deps);
  assert.deepEqual(await other!.parts.route!(request({ headers: secret, body: Buffer.from(JSON.stringify({ run: 99, login: 'octo-lead', vote: 'up' })) }), signal()), {
    status: 422, body: 'unknown_run',
  });
  assert.deepEqual(failing.reported, [['example', { run: 99, login: 'octo-lead', vote: 'up' }]]);
});

test('a path is resolved against the config folder, and a package name is imported as written', async () => {
  const seen: string[] = [];
  const h = harness({ importModule: async (specifier) => { seen.push(specifier); return { default: () => ({ notify: fn }) }; } });
  await loadExtensions([
    { name: 'a', module: './x.ts', options: {} },
    { name: 'b', module: '../y.ts', options: {} },
    { name: 'c', module: '/abs/z.ts', options: {} },
    { name: 'd', module: 'acme-visto-chat', options: {} },
  ], { ...h.deps, configDir: '/srv/conf' });
  assert.deepEqual(seen, ['file:///srv/conf/x.ts', 'file:///srv/y.ts', 'file:///abs/z.ts', 'acme-visto-chat']);
});

test('a module that does not load stops the loading and is named, without its path or the error text', async () => {
  const fails = async (config: ExtensionConfig, code: string, over: Parameters<typeof harness>[0] = {}, cause: string | null = null) => {
    const h = harness(over);
    await assert.rejects(loadExtensions([config], h.deps), (error: Error) => error.message === code, code);
    assert.equal(h.logged.length, 1, code);
    const line = h.logged[0]!;
    assert.equal(line.event, 'extension_failed');
    assert.equal(line.extension, config.name);
    assert.equal(line.code, code);
    assert.equal(line.cause, cause, code);
    const text = JSON.stringify(h.logged);
    for (const bad of ['boom', '/srv', 'no-such-file', 'examples']) assert.ok(!text.includes(bad), `${code}: ${bad}`);
    return line;
  };
  await fails({ name: 'tickets', module: './examples/no-such-file.ts', options: {} }, 'extension_import_failed', {}, 'ERR_MODULE_NOT_FOUND');
  await fails({ name: 'tickets', module: 'acme-visto-chat', options: {} }, 'extension_bad_export', { importModule: async () => ({}) });
  await fails({ name: 'tickets', module: 'acme-visto-chat', options: {} }, 'extension_bad_export', { importModule: withDefault(5) });
  await fails({ name: 'tickets', module: 'acme-visto-chat', options: {} }, 'extension_bad_export', { importModule: async () => null });
  const thrown = await fails({ name: 'tickets', module: 'acme-visto-chat', options: {} }, 'extension_setup_failed', {
    importModule: withDefault(() => { throw new Error('boom at /srv/secret'); }),
  });
  assert.equal(thrown.error, 'Error');
  await fails({ name: 'tickets', module: 'acme-visto-chat', options: {} }, 'extension_setup_failed', {
    importModule: withDefault(async () => { throw new TypeError('boom at /srv/secret'); }),
  });
  await fails({ name: 'tickets', module: 'acme-visto-chat', options: {} }, 'extension_setup_failed', {
    importModule: withDefault(() => { throw 'boom at /srv/secret'; }),
  });
  await fails({ name: 'tickets', module: 'acme-visto-chat', options: {} }, 'extension_setup_failed', {
    importModule: withDefault(() => { throw new Error('timeout'); }), setupTimeoutMs: 1000,
  });
  const hung = await fails({ name: 'tickets', module: 'acme-visto-chat', options: {} }, 'extension_setup_timeout', {
    importModule: withDefault(() => new Promise(() => {})), setupTimeoutMs: 5,
  });
  assert.equal(hung.error, null);
  for (const shape of [null, [], {}, { notifier: fn }, { notify: 'x' }, { context: fn, extra: 1 }, 5, { notify: undefined }]) {
    await fails({ name: 'tickets', module: 'acme-visto-chat', options: {} }, 'extension_bad_shape', { importModule: withDefault(() => shape) });
  }
  const h = harness({ importModule: withDefault(() => ({ notify: fn, alert: undefined })) });
  const loaded = await loadExtensions([{ name: 'chat', module: 'acme-visto-chat', options: {} }], h.deps);
  assert.equal(typeof loaded[0]!.parts.notify, 'function');
  assert.deepEqual(h.logged, [{ event: 'extension_loaded', extension: 'chat', parts: ['notify'] }]);
});

test('modules are set up in order, each once, and the second is not set up when the first fails', async () => {
  const calls: string[] = [];
  const factories: Record<string, () => unknown> = {
    first: () => { calls.push('first'); return { context: fn }; },
    second: () => { calls.push('second'); return { notify: fn }; },
    broken: () => { calls.push('broken'); return {}; },
  };
  const importModule = async (specifier: string) => ({ default: factories[specifier] });
  const ok = harness({ importModule });
  const loaded = await loadExtensions([
    { name: 'tickets', module: 'first', options: {} },
    { name: 'chat', module: 'second', options: {} },
  ], ok.deps);
  assert.deepEqual(loaded.map((e) => e.name), ['tickets', 'chat']);
  assert.deepEqual(calls, ['first', 'second']);
  calls.length = 0;
  const bad = harness({ importModule });
  await assert.rejects(loadExtensions([
    { name: 'tickets', module: 'broken', options: {} },
    { name: 'chat', module: 'second', options: {} },
  ], bad.deps), { message: 'extension_bad_shape' });
  assert.deepEqual(calls, ['broken']);
});

test('a module gets its name, a copy of its options, a tagged logger and its own feedback function', async () => {
  const options = { x: 1, nested: { y: [1, 2] } };
  let got: Parameters<import('./types.ts').ExtensionFactory>[0] | null = null;
  const h = harness({
    feedback: { ok: false, code: 'store_failed' },
    importModule: withDefault((setup: Parameters<import('./types.ts').ExtensionFactory>[0]) => {
      got = setup;
      setup.options.x = 2;
      (setup.options.nested as { y: number[] }).y.push(3);
      return { notify: fn };
    }),
  });
  await loadExtensions([{ name: 'chat', module: 'acme-visto-chat', options }], h.deps);
  assert.deepEqual(options, { x: 1, nested: { y: [1, 2] } });
  const setup = got as unknown as Parameters<import('./types.ts').ExtensionFactory>[0];
  assert.equal(setup.name, 'chat');
  h.logged.length = 0;
  setup.log({ event: 'review', a: 1 });
  setup.log({ extension: 'other', b: 2 });
  assert.doesNotThrow(() => setup.log(5 as unknown as Record<string, unknown>));
  assert.doesNotThrow(() => setup.log(null as unknown as Record<string, unknown>));
  assert.doesNotThrow(() => setup.log([1] as unknown as Record<string, unknown>));
  assert.deepEqual(h.logged, [
    { event: 'extension_log', extension: 'chat', a: 1 },
    { event: 'extension_log', extension: 'chat', b: 2 },
  ]);
  const answer: FeedbackAnswer = { run: 3, login: 'octo-lead', vote: 'up' };
  assert.deepEqual(await setup.reportFeedback(answer), { ok: false, code: 'store_failed' });
  assert.deepEqual(h.reported, [['chat', answer]]);
});

test('the three lists hold only the modules that have the part, in order', async () => {
  const seen: unknown[] = [];
  const context = async (pr: PullRequestInfo, s: AbortSignal) => { seen.push([pr, s]); return { status: 'skipped' as const }; };
  const notify = async () => {};
  const alert = async () => {};
  const loaded: LoadedExtension[] = [
    { name: 'tickets', parts: { context, alert } },
    { name: 'chat', parts: { notify, alert } },
    { name: 'example', parts: { context, notify } },
  ];
  const providers = contextProvidersOf(loaded);
  assert.deepEqual(providers.map((p) => p.name), ['tickets', 'example']);
  const s = signal();
  assert.deepEqual(await providers[0]!.provide(PR, s), { status: 'skipped' });
  assert.equal((seen[0] as unknown[])[0], PR);
  assert.equal((seen[0] as unknown[])[1], s);
  assert.deepEqual(notifiersOf(loaded).map((n) => [n.name, n.notify]), [['chat', notify], ['example', notify]]);
  assert.deepEqual(alertSinksOf(loaded).map((n) => [n.name, n.alert]), [['tickets', alert], ['chat', alert]]);
  assert.deepEqual([contextProvidersOf([]), notifiersOf([]), alertSinksOf([])], [[], [], []]);
});
