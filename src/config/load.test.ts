import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConfigError, parseConfig, repoConfigFor } from './load.ts';

const minimal = 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n';

test('defaults', () => {
  const c = parseConfig(minimal, { MODEL_KEY: 'k' });
  assert.equal(c.model.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(c.model.apiKey, 'k');
  assert.deepEqual(c.limits, { inputTokensPerCall: 200000, batchesPerReview: 6 });
  assert.equal(c.model.timeoutSeconds, 240);
});

test('an unknown key is an error that names it', () => {
  assert.throws(
    () => parseConfig(minimal + 'modle: {}\n', { MODEL_KEY: 'k' }),
    (e: ConfigError) => e.issues.some((i) => i.includes('modle')),
  );
});

test('a missing secret names its variable and never prints a value', () => {
  assert.throws(
    () => parseConfig(minimal, { OTHER_KEY: 'sk-other-value-77' }),
    (e: ConfigError) =>
      e.issues.join().includes('MODEL_KEY') && !e.message.includes('sk-other-value-77') && !e.issues.join().includes('sk-other-value-77'),
  );
});

test('a secret written inline is rejected and never printed', () => {
  assert.throws(
    () => parseConfig('model:\n  apiKey: sk-inline\n  model: m\n', {}),
    (e: ConfigError) => e instanceof ConfigError && !e.message.includes('sk-inline') && !e.issues.join().includes('sk-inline'),
  );
});

test('effort fragments pass through untouched', () => {
  const c = parseConfig(minimal + '  effort:\n    elevated: { reasoning: { effort: high } }\n', { MODEL_KEY: 'k' });
  assert.deepEqual(c.model.effort.elevated, { reasoning: { effort: 'high' } });
});

test('repository overrides fall back to defaults', () => {
  const c = parseConfig(minimal + 'repositories:\n  overrides:\n    acme/shop: { primaryBranches: [trunk] }\n', { MODEL_KEY: 'k' });
  assert.deepEqual(repoConfigFor(c, 'acme/shop').primaryBranches, ['trunk']);
  assert.deepEqual(repoConfigFor(c, 'acme/other').primaryBranches, ['main', 'master']);
});

test('the example file parses', () => {
  const text = readFileSync(new URL('../../config.example.yml', import.meta.url), 'utf8');
  const c = parseConfig(text, { OPENROUTER_API_KEY: 'k' });
  assert.equal(c.model.apiKey, 'k');
});

test('a YAML syntax error never echoes file text', () => {
  const text = 'model:\n  apiKey: sk-SECRET123\n  model: [m\n';
  assert.throws(
    () => parseConfig(text, {}),
    (e: ConfigError) => e instanceof ConfigError && !e.message.includes('SECRET123') && !e.issues.join().includes('SECRET123') && !e.issues.join().includes('[m'),
  );
});

test('model.timeoutSeconds is at most 300', () => {
  assert.equal(parseConfig(minimal + '  timeoutSeconds: 300\n', { MODEL_KEY: 'k' }).model.timeoutSeconds, 300);
  assert.throws(
    () => parseConfig(minimal + '  timeoutSeconds: 301\n', { MODEL_KEY: 'k' }),
    (e: ConfigError) => e.issues.some((i) => i.startsWith('model.timeoutSeconds')),
  );
});

test('limits.inputTokensPerCall is at least 10,000', () => {
  const at = (n: number): string => `${minimal}limits:\n  inputTokensPerCall: ${n}\n`;
  assert.equal(parseConfig(at(10_000), { MODEL_KEY: 'k' }).limits.inputTokensPerCall, 10_000);
  assert.throws(() => parseConfig(at(9_999), { MODEL_KEY: 'k' }), (e: ConfigError) => e.issues.some((i) => i.startsWith('limits.inputTokensPerCall')));
});

test('model.baseUrl must be an http or https URL', () => {
  const at = (url: string): string => `${minimal}  baseUrl: '${url}'\n`;
  assert.equal(parseConfig(at('http://localhost:8080/v1'), { MODEL_KEY: 'k' }).model.baseUrl, 'http://localhost:8080/v1');
  assert.equal(parseConfig(at('https://models.example.test/api'), { MODEL_KEY: 'k' }).model.baseUrl, 'https://models.example.test/api');
  for (const bad of ['not a url', 'ftp://models.example.test', 'file:///etc/models', 'javascript:alert(1)', '//models.example.test']) {
    assert.throws(() => parseConfig(at(bad), { MODEL_KEY: 'k' }), (e: ConfigError) => e.issues.some((i) => i.startsWith('model.baseUrl')) && !e.message.includes(bad), bad);
  }
});

const score = (body: string) => minimal + `repositories:\n  defaults: { score: ${body} }\n`;
const threshold = (name: string) => repoConfigFor(parseConfig(minimal, { MODEL_KEY: 'k' }), name).scoreThreshold;

test('the threshold defaults to 70', () => assert.equal(threshold('acme/shop'), 70));

test('a repository can lower it', () => {
  const c = parseConfig(
    minimal + 'repositories:\n  defaults: { score: { threshold: 80 } }\n  overrides:\n    acme/shop: { score: { threshold: 40 } }\n',
    { MODEL_KEY: 'k' },
  );
  assert.equal(repoConfigFor(c, 'acme/shop').scoreThreshold, 40);
  assert.equal(repoConfigFor(c, 'acme/other').scoreThreshold, 80);
});

test('an override that sets only primaryBranches keeps the default threshold', () => {
  const c = parseConfig(minimal + 'repositories:\n  overrides:\n    acme/shop: { primaryBranches: [trunk] }\n', { MODEL_KEY: 'k' });
  assert.deepEqual(repoConfigFor(c, 'acme/shop'), { primaryBranches: ['trunk'], scoreThreshold: 70 });
});

test('0, 101, 69.5 and an unknown key in score are errors', () => {
  for (const body of ['{ threshold: 0 }', '{ threshold: 101 }', '{ threshold: 69.5 }', '{ threshold: 70, auto: true }']) {
    assert.throws(
      () => parseConfig(score(body), { MODEL_KEY: 'k' }),
      (e: ConfigError) => e instanceof ConfigError && e.issues.some((i) => i.startsWith('repositories.defaults.score')),
      body,
    );
  }
  assert.throws(
    () => parseConfig(minimal + 'repositories:\n  overrides:\n    acme/shop: { score: { threshold: 101 } }\n', { MODEL_KEY: 'k' }),
    (e: ConfigError) => e.issues.some((i) => i.startsWith('repositories.overrides.acme/shop.score')),
  );
});

test('a repository override applies whatever the letter case of the name', () => {
  const c = parseConfig(minimal + 'repositories:\n  overrides:\n    Acme/Shop: { score: { threshold: 40 } }\n', { MODEL_KEY: 'k' });
  assert.equal(repoConfigFor(c, 'acme/shop').scoreThreshold, 40);
  assert.equal(repoConfigFor(c, 'ACME/SHOP').scoreThreshold, 40);
  assert.equal(repoConfigFor(c, 'acme/other').scoreThreshold, 70);
});

test('two override keys that differ only by letter case are refused', () => {
  assert.throws(
    () => parseConfig(minimal + 'repositories:\n  overrides:\n    acme/shop: { score: { threshold: 40 } }\n    Acme/Shop: { score: { threshold: 90 } }\n', { MODEL_KEY: 'k' }),
    (e: ConfigError) => e instanceof ConfigError && e.issues.some((i) => i.startsWith('repositories.overrides')),
  );
});
