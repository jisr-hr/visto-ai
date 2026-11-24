import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import {
  APPROVAL_OFF, ConfigError, GATE_OFF, approvalOf, approvalUseOf, contractFile, gateUseOf, parseConfig, repoConfigFor, repoSettingsFor, serviceConfig,
} from './load.ts';

const minimal = 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n';

test('defaults', () => {
  const c = parseConfig(minimal, { MODEL_KEY: 'k' });
  assert.equal(c.model.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(c.model.apiKey, 'k');
  assert.deepEqual(c.limits, { inputTokensPerCall: 200000, batchesPerReview: 6, spendPerDay: 50, queueConcurrency: 2 });
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

// Removes the "# " after the indent of `first` from that line and from the commented lines that follow it at that indent.
function uncomment(text: string, first: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(first);
  assert.notEqual(start, -1, first);
  const indent = first.slice(0, first.indexOf('#'));
  for (let i = start; i < lines.length && lines[i]!.startsWith(`${indent}#`); i += 1) {
    lines[i] = indent + lines[i]!.slice(indent.length).replace(/^# ?/, '');
  }
  return lines.join('\n');
}
const example = (): string => readFileSync(new URL('../../config.example.yml', import.meta.url), 'utf8');
const exampleEnv = { OPENROUTER_API_KEY: 'k', SCORER_API_KEY: 'scorer-key' };

test('the example file as shipped names no scorer and has a threshold of 70', () => {
  const c = parseConfig(example(), exampleEnv);
  assert.equal(c.scorer, null);
  assert.equal(c.repositories.defaults.scoreThreshold, 70);
});

test('the example with its scorer block switched on is refused until its threshold is written', () => {
  const withScorer = uncomment(example(), '# scorer:');
  assert.throws(
    () => parseConfig(withScorer, exampleEnv),
    (e: ConfigError) => e.issues.includes('repositories.defaults.score.threshold: must be written when scorer is set'),
  );
  const c = parseConfig(uncomment(withScorer, '    # score:'), exampleEnv);
  assert.notEqual(c.scorer, null);
  assert.equal(c.repositories.defaults.scoreThreshold, 70);
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

const withScorer = minimal + 'scorer:\n  apiKey: { env: SCORER_KEY }\n  model: vendor/decider\n';
const writtenThreshold = 'repositories:\n  defaults:\n    score:\n      threshold: 80\n';
const scorerEnv = { MODEL_KEY: 'k', SCORER_KEY: 'scorer-secret-value' };

test('without a scorer block the scorer is null', () => {
  assert.equal(parseConfig(minimal, { MODEL_KEY: 'k' }).scorer, null);
});

test('a scorer block with the threshold written gets its defaults and its resolved key', () => {
  const c = parseConfig(withScorer + writtenThreshold, scorerEnv);
  assert.deepEqual(c.scorer, {
    baseUrl: 'https://openrouter.ai/api/alpha',
    apiKey: 'scorer-secret-value',
    model: 'vendor/decider',
    timeoutSeconds: 60,
  });
});

test('the review model gets the contract without block scores when a scorer is named, and both files exist', () => {
  const plain = contractFile(parseConfig(minimal, { MODEL_KEY: 'k' }));
  const scored = contractFile(parseConfig(withScorer + writtenThreshold, scorerEnv));
  assert.equal(plain, 'review-contract.md');
  assert.equal(scored, 'review-contract-scorer.md');
  for (const name of [plain, scored]) assert.ok(existsSync(new URL(`../../contract/${name}`, import.meta.url)), name);
});

test('a scorer key that is not set names its variable and prints no value', () => {
  for (const env of [{ MODEL_KEY: 'k' }, { MODEL_KEY: 'k', SCORER_KEY: '' }]) {
    assert.throws(
      () => parseConfig(withScorer + writtenThreshold, env),
      (e: ConfigError) => e.issues.includes('scorer.apiKey: environment variable SCORER_KEY is not set'),
    );
  }
});

test('an unknown key inside scorer is an error that names it', () => {
  assert.throws(
    () => parseConfig(withScorer + '  temperature: 0\n' + writtenThreshold, scorerEnv),
    (e: ConfigError) => e.issues.some((i) => i.startsWith('scorer') && i.includes('temperature')),
  );
});

test('scorer.baseUrl must be an http or https URL', () => {
  assert.throws(
    () => parseConfig(withScorer + '  baseUrl: ftp://x\n' + writtenThreshold, scorerEnv),
    (e: ConfigError) => e.issues.some((i) => i.startsWith('scorer.baseUrl') && !i.includes('ftp')),
  );
});

test('a scorer without a written threshold is refused and the message echoes no value', () => {
  assert.throws(
    () => parseConfig(withScorer, scorerEnv),
    (e: ConfigError) =>
      e.issues.includes('repositories.defaults.score.threshold: must be written when scorer is set') &&
      !e.message.includes('scorer-secret-value'),
  );
});

test('a threshold written only in an override does not satisfy the scorer rule', () => {
  const override = 'repositories:\n  overrides:\n    acme/shop:\n      score:\n        threshold: 80\n';
  assert.throws(
    () => parseConfig(withScorer + override, scorerEnv),
    (e: ConfigError) => e.issues.includes('repositories.defaults.score.threshold: must be written when scorer is set'),
  );
});

test('the threshold is not required while no scorer is named', () => {
  assert.equal(parseConfig(minimal, { MODEL_KEY: 'k' }).repositories.defaults.scoreThreshold, 70);
});

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const service = minimal + 'app:\n  id: 12345\n  privateKey: { env: APP_KEY }\n  webhookSecret: { env: HOOK }\ndatabase:\n  url: { env: DB_URL }\ndryRun: true\n';
const serviceEnv = { MODEL_KEY: 'k', APP_KEY: PEM, HOOK: 'hook-secret-value', DB_URL: 'postgres://u:db-password-value@db:5432/visto' };

test('without the service blocks app and database are null and the port is 8080', () => {
  const c = parseConfig(minimal, { MODEL_KEY: 'k' });
  assert.equal(c.app, null);
  assert.equal(c.database, null);
  assert.deepEqual(c.server, { port: 8080 });
});

test('the service blocks resolve their secrets', () => {
  const c = parseConfig(service, serviceEnv);
  assert.deepEqual(c.app, { id: '12345', privateKey: PEM, webhookSecret: 'hook-secret-value' });
  assert.equal(c.database?.url, serviceEnv.DB_URL);
});

test('server.port is read and must be a port number', () => {
  assert.equal(parseConfig(minimal + 'server:\n  port: 9000\n', { MODEL_KEY: 'k' }).server.port, 9000);
  for (const body of ['port: 0', 'port: 65536', 'port: 80.5', 'port: 80\n  host: x']) {
    assert.throws(
      () => parseConfig(minimal + `server:\n  ${body}\n`, { MODEL_KEY: 'k' }),
      (e: ConfigError) => e instanceof ConfigError && e.issues.some((i) => i.startsWith('server')),
      body,
    );
  }
});

test('an unset service variable names itself', () => {
  assert.throws(
    () => parseConfig(service, { MODEL_KEY: 'k', APP_KEY: PEM, DB_URL: serviceEnv.DB_URL }),
    (e: ConfigError) => e.issues.includes('app.webhookSecret: environment variable HOOK is not set'),
  );
  assert.throws(
    () => parseConfig(service, { MODEL_KEY: 'k', APP_KEY: PEM, HOOK: 'hook-secret-value' }),
    (e: ConfigError) => e.issues.includes('database.url: environment variable DB_URL is not set'),
  );
});

test('the database URL must be a postgres URL and is never printed', () => {
  assert.throws(
    () => parseConfig(service, { ...serviceEnv, DB_URL: 'mysql://u:db-password-value@db/x' }),
    (e: ConfigError) => e.issues.includes('database.url: must be a postgres URL') && !e.message.includes('db-password-value'),
  );
  for (const url of ['postgres://u:p@db/x', 'postgresql://u:p@db/x']) {
    assert.equal(parseConfig(service, { ...serviceEnv, DB_URL: url }).database?.url, url);
  }
});

test('a webhook secret written inline is rejected and never printed', () => {
  assert.throws(
    () => parseConfig(minimal + 'app:\n  webhookSecret: hook-secret-value\n', serviceEnv),
    (e: ConfigError) => e instanceof ConfigError && !e.message.includes('hook-secret-value'),
  );
});

test('an unknown key inside app or database names the key', () => {
  assert.throws(
    () => parseConfig(service + 'app2: {}\n', serviceEnv),
    (e: ConfigError) => e.issues.some((i) => i.includes('app2')),
  );
  assert.throws(
    () => parseConfig(minimal + 'app:\n  id: 12345\n  privateKey: { env: APP_KEY }\n  webhookSecret: { env: HOOK }\n  appId: 1\n', serviceEnv),
    (e: ConfigError) => e.issues.some((i) => i.startsWith('app') && i.includes('appId')),
  );
  assert.throws(
    () => parseConfig(minimal + 'database:\n  url: { env: DB_URL }\n  pool: 5\n', serviceEnv),
    (e: ConfigError) => e.issues.some((i) => i.startsWith('database') && i.includes('pool')),
  );
});

test('serviceConfig names each missing block and returns a complete config', () => {
  assert.throws(
    () => serviceConfig(parseConfig(`${minimal}dryRun: true\n`, { MODEL_KEY: 'k' })),
    (e: ConfigError) =>
      e instanceof ConfigError &&
      JSON.stringify(e.issues) === JSON.stringify(['app: required to run the service', 'database: required to run the service']),
  );
  const c = parseConfig(service, serviceEnv);
  assert.equal(serviceConfig(c), c);
});

test('the example file has no service blocks as shipped, and loads with them switched on', () => {
  const shipped = parseConfig(example(), exampleEnv);
  assert.equal(shipped.dryRun, true);
  assert.equal(shipped.app, null);
  assert.equal(shipped.database, null);
  assert.deepEqual(shipped.server, { port: 8080 });
  const text = uncomment(example(), '# app:');
  const env = { ...exampleEnv, APP_PRIVATE_KEY: PEM, ALERT_WEBHOOK_URL: 'https://alerts.example.test/in/abc', WEBHOOK_SECRET: 'hook-secret-value', DATABASE_URL: 'postgres://u:p@db:5432/visto' };
  const c = parseConfig(text, env);
  assert.equal(c.app?.webhookSecret, 'hook-secret-value');
  assert.equal(c.alerts?.webhook, env.ALERT_WEBHOOK_URL);
  assert.equal(c.database?.url, env.DATABASE_URL);
  assert.equal(c.server.port, 8080);
});

const SERVICE_YAML = `
model: { apiKey: { env: MODEL_KEY }, model: m }
app: { id: 12345, privateKey: { env: APP_KEY }, webhookSecret: { env: HOOK } }
database: { url: { env: DB } }
dryRun: true
`;
const ENV = { MODEL_KEY: 'k', APP_KEY: PEM, HOOK: 's', DB: 'postgres://u:p@db:5432/visto' };

test('the app block carries the id as text, the key and the secret', () => {
  assert.deepEqual(parseConfig(SERVICE_YAML, ENV).app, { id: '12345', privateKey: PEM, webhookSecret: 's' });
});
test('a private key written on one line with backslash-n is read as its lines', () => {
  assert.equal(parseConfig(SERVICE_YAML, { ...ENV, APP_KEY: PEM.replaceAll('\n', '\\n') }).app?.privateKey, PEM);
});
test('a private key that is not an RSA key is refused and never printed', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  for (const value of ['not-a-key-value', ec]) {
    assert.throws(() => parseConfig(SERVICE_YAML, { ...ENV, APP_KEY: value }), (e: unknown) =>
      e instanceof ConfigError && e.issues.length === 1 && e.issues[0] === 'app.privateKey: must be an RSA private key in PEM form'
      && !e.message.includes('not-a-key-value'));
  }
});
test('an app block without an id or a key is refused', () => {
  const yaml = SERVICE_YAML.replace('id: 12345, privateKey: { env: APP_KEY }, ', '');
  assert.throws(() => parseConfig(yaml, ENV), ConfigError);
});
test('what this plan adds has these defaults', () => {
  const c = parseConfig('model: { apiKey: { env: MODEL_KEY }, model: m }', ENV);
  assert.equal(c.dryRun, true);
  assert.equal(c.alerts, null);
  assert.deepEqual(c.limits, { inputTokensPerCall: 200000, batchesPerReview: 6, spendPerDay: 50, queueConcurrency: 2 });
  assert.deepEqual(c.repositories.defaults.ignoredAuthors, ['dependabot[bot]']);
  assert.deepEqual(c.repositories.defaults.baseBranches, []);
});
test('the alert webhook is read by reference, must be an http or https URL, and is never printed', () => {
  const yaml = `${SERVICE_YAML}alerts: { webhook: { env: HOOK_URL } }\n`;
  assert.deepEqual(parseConfig(yaml, { ...ENV, HOOK_URL: 'https://alerts.example.test/in/abc' }).alerts, { webhook: 'https://alerts.example.test/in/abc' });
  assert.throws(() => parseConfig(yaml, { ...ENV, HOOK_URL: 'ftp://alerts.example.test/abc' }), (e: unknown) =>
    e instanceof ConfigError && e.issues[0] === 'alerts.webhook: must be an http or https URL' && !e.message.includes('alerts.example.test'));
});
test('the queue concurrency is a whole number from 1 to 20, and the daily limit is positive', () => {
  for (const limits of ['{ queueConcurrency: 0 }', '{ queueConcurrency: 21 }', '{ queueConcurrency: 1.5 }', '{ spendPerDay: 0 }']) {
    assert.throws(() => parseConfig(`${SERVICE_YAML}limits: ${limits}\n`, ENV), ConfigError);
  }
});
test('a config with no dryRun key is in dry run, and only dryRun: false leaves it', () => {
  const none = SERVICE_YAML.replace('dryRun: true\n', '');
  assert.equal(serviceConfig(parseConfig(none, ENV)).dryRun, true);
  assert.equal(serviceConfig(parseConfig(none + 'dryRun: false\n', ENV)).dryRun, false);
  assert.throws(() => parseConfig(none + 'dryRun: no\n', ENV), ConfigError);
});
test('serviceConfig accepts a config in dry run and one out of it, and still names a missing block', () => {
  assert.equal(serviceConfig(parseConfig(SERVICE_YAML, ENV)).dryRun, true);
  assert.equal(serviceConfig(parseConfig(SERVICE_YAML.replace('dryRun: true', 'dryRun: false'), ENV)).dryRun, false);
  assert.throws(
    () => serviceConfig(parseConfig('model: { apiKey: { env: MODEL_KEY }, model: m }\ndryRun: false\n', ENV)),
    (e: unknown) => e instanceof ConfigError && JSON.stringify(e.issues) === JSON.stringify(['app: required to run the service', 'database: required to run the service']),
  );
});
test('repoSettingsFor applies an override key by key, and repoConfigFor still returns the two keys the engine reads', () => {
  const c = parseConfig(`${SERVICE_YAML}repositories:\n  overrides:\n    Acme/Shop: { baseBranches: [main], ignoredAuthors: [] }\n`, ENV);
  assert.deepEqual(repoSettingsFor(c, 'acme/shop'), { primaryBranches: ['main', 'master'], scoreThreshold: 70, ignoredAuthors: [], baseBranches: ['main'], newHead: null, inlineNotes: false, gate: GATE_OFF });
  assert.deepEqual(repoSettingsFor(c, 'acme/other').ignoredAuthors, ['dependabot[bot]']);
  assert.deepEqual(repoConfigFor(c, 'acme/shop'), { primaryBranches: ['main', 'master'], scoreThreshold: 70 });
});
test('how a new head is reviewed can be set for all repositories or for one, and is not set otherwise', () => {
  const unset = parseConfig(SERVICE_YAML, ENV);
  assert.equal(repoSettingsFor(unset, 'acme/shop').newHead, null);
  const all = parseConfig(`${SERVICE_YAML}repositories:\n  defaults: { newHead: full }\n`, ENV);
  assert.deepEqual([repoSettingsFor(all, 'acme/shop').newHead, repoSettingsFor(all, 'acme/other').newHead], ['full', 'full']);
  const one = parseConfig(`${SERVICE_YAML}repositories:\n  defaults: { newHead: full }\n  overrides:\n    acme/shop: { newHead: incremental }\n`, ENV);
  assert.deepEqual([repoSettingsFor(one, 'acme/shop').newHead, repoSettingsFor(one, 'acme/other').newHead], ['incremental', 'full']);
  const onlyOne = parseConfig(`${SERVICE_YAML}repositories:\n  overrides:\n    acme/shop: { newHead: full }\n`, ENV);
  assert.deepEqual([repoSettingsFor(onlyOne, 'acme/shop').newHead, repoSettingsFor(onlyOne, 'acme/other').newHead], ['full', null]);
});
test('another word for newHead is refused', () => {
  for (const yaml of [`${SERVICE_YAML}repositories:\n  defaults: { newHead: recheck }\n`, `${SERVICE_YAML}repositories:\n  overrides:\n    acme/shop: { newHead: partial }\n`]) {
    assert.throws(() => parseConfig(yaml, ENV), (e: unknown) => e instanceof ConfigError && e.issues.some((i) => i.includes('newHead')));
  }
});
test('inline notes are off unless the config switches them on, for all repositories or for one', () => {
  const unset = parseConfig(SERVICE_YAML, ENV);
  assert.equal(repoSettingsFor(unset, 'acme/shop').inlineNotes, false);
  const all = parseConfig(`${SERVICE_YAML}repositories:\n  defaults: { score: { inlineNotes: true } }\n`, ENV);
  assert.deepEqual([repoSettingsFor(all, 'acme/shop').inlineNotes, repoSettingsFor(all, 'acme/other').inlineNotes], [true, true]);
  assert.equal(repoSettingsFor(all, 'acme/shop').scoreThreshold, 70);
  const one = parseConfig(`${SERVICE_YAML}repositories:\n  defaults: { score: { inlineNotes: true } }\n  overrides:\n    acme/shop: { score: { inlineNotes: false } }\n`, ENV);
  assert.deepEqual([repoSettingsFor(one, 'acme/shop').inlineNotes, repoSettingsFor(one, 'acme/other').inlineNotes], [false, true]);
  const onlyOne = parseConfig(`${SERVICE_YAML}repositories:\n  overrides:\n    acme/shop: { score: { inlineNotes: true } }\n`, ENV);
  assert.deepEqual([repoSettingsFor(onlyOne, 'acme/shop').inlineNotes, repoSettingsFor(onlyOne, 'acme/other').inlineNotes], [true, false]);
});
test('a value for inlineNotes that is not true or false is refused', () => {
  assert.throws(
    () => parseConfig(`${SERVICE_YAML}repositories:\n  defaults: { score: { inlineNotes: 'yes' } }\n`, ENV),
    (e: unknown) => e instanceof ConfigError && e.issues.some((i) => i.includes('repositories.defaults.score.inlineNotes')),
  );
  assert.throws(
    () => parseConfig(`${SERVICE_YAML}repositories:\n  overrides:\n    acme/shop: { score: { inlineNotes: 1 } }\n`, ENV),
    (e: unknown) => e instanceof ConfigError && e.issues.some((i) => i.includes('inlineNotes')),
  );
  for (const yaml of [`${SERVICE_YAML}repositories:\n  defaults: { score: { inlineNotes: null } }\n`, `${SERVICE_YAML}repositories:\n  overrides:\n    acme/shop: { score: { inlineNotes: null } }\n`]) {
    assert.throws(() => parseConfig(yaml, ENV), (e: unknown) => e instanceof ConfigError && e.issues.some((i) => i.includes('inlineNotes')), yaml);
  }
});
test('an unknown key beside inlineNotes is refused', () => {
  for (const yaml of [`${SERVICE_YAML}repositories:\n  defaults: { score: { inlineNotes: true, inlineNote: true } }\n`, `${SERVICE_YAML}repositories:\n  overrides:\n    acme/shop: { score: { inlineNotes: true, notes: 1 } }\n`]) {
    assert.throws(() => parseConfig(yaml, ENV), (e: unknown) => e instanceof ConfigError && e.issues.some((i) => i.includes('score')), yaml);
  }
});
test('an override that writes only a threshold keeps the notes of the defaults', () => {
  const c = parseConfig(`${SERVICE_YAML}repositories:\n  defaults: { score: { inlineNotes: true } }\n  overrides:\n    acme/shop: { score: { threshold: 50 } }\n`, ENV);
  assert.deepEqual([repoSettingsFor(c, 'acme/shop').inlineNotes, repoSettingsFor(c, 'acme/shop').scoreThreshold], [true, 50]);
});
test('the example with its score block switched on turns inline notes off, as written', () => {
  const c = parseConfig(uncomment(example(), '    # score:'), exampleEnv);
  assert.equal(c.repositories.defaults.inlineNotes, false);
  assert.match(example(), /^ {4}# {3}inlineNotes: false$/m);
});

const GATE_ISSUE = 'must name at least one branch when the gate is enabled';
const issuesOf = (yaml: string): string[] => {
  try {
    parseConfig(yaml, ENV);
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
};
test('the gate is off unless a repository switches it on, and an override replaces only the keys it sets', () => {
  assert.deepEqual(parseConfig(SERVICE_YAML, ENV).repositories.defaults.gate, GATE_OFF);
  const c = parseConfig(
    `${SERVICE_YAML}repositories:\n  defaults: { gate: { enabled: true, branches: [main], mode: bypass } }\n  overrides:\n    acme/shop: { gate: { branches: [main, release] } }\n`,
    ENV,
  );
  const shop = repoSettingsFor(c, 'Acme/Shop').gate;
  assert.deepEqual([shop.enabled, shop.branches, shop.mode], [true, ['main', 'release'], 'bypass']);
  assert.deepEqual(repoSettingsFor(c, 'acme/other').gate.branches, ['main']);
});
test('an enabled gate with no branch is refused, for the defaults and for one repository', () => {
  assert.deepEqual(issuesOf(`${SERVICE_YAML}repositories:\n  defaults: { gate: { enabled: true } }\n`), [`repositories.defaults.gate.branches: ${GATE_ISSUE}`]);
  assert.ok(
    issuesOf(`${SERVICE_YAML}repositories:\n  overrides:\n    acme/shop: { gate: { enabled: true } }\n`).includes(`repositories.overrides.acme/shop.gate.branches: ${GATE_ISSUE}`),
  );
  const ok = parseConfig(`${SERVICE_YAML}repositories:\n  defaults: { gate: { branches: [main] } }\n  overrides:\n    acme/shop: { gate: { enabled: true } }\n`, ENV);
  assert.equal(repoSettingsFor(ok, 'acme/shop').gate.enabled, true);
});
test('a gate key of the wrong kind, an unknown gate key and a malformed team are refused by name', () => {
  const bad = [
    'mode: audit', "checkName: ''", 'checkName: "a\\nb"', 'skipTeam: release-managers', "skipTeam: 'acme/release managers'",
    `requiredChecks: [${Array.from({ length: 21 }, (_, i) => `c${i}`).join(', ')}]`, 'colour: red',
  ];
  for (const key of bad) {
    const issues = issuesOf(`${SERVICE_YAML}repositories:\n  defaults: { gate: { ${key} } }\n`);
    assert.ok(issues.length > 0, key);
    for (const issue of issues) {
      assert.ok(issue.startsWith('repositories.defaults.gate'), issue);
      for (const value of ['audit', 'release-managers', 'release managers']) assert.ok(!issue.includes(value), issue);
      if (key.startsWith('colour')) assert.ok(!/\bred\b/.test(issue), issue);
    }
  }
});
test('what of the gate is in use is read from every repository', () => {
  const none = gateUseOf(parseConfig(SERVICE_YAML, ENV));
  assert.deepEqual(none, { check: false, statuses: false, members: false, bypass: false });
  const one = parseConfig(`${SERVICE_YAML}repositories:\n  overrides:\n    acme/shop: { gate: { enabled: true, branches: [main], requiredChecks: [build] } }\n`, ENV);
  assert.deepEqual(gateUseOf(one), { check: true, statuses: true, members: false, bypass: false });
  const all = parseConfig(`${SERVICE_YAML}repositories:\n  defaults: { gate: { enabled: true, branches: [main], mode: bypass, skipTeam: acme/release-managers } }\n`, ENV);
  assert.deepEqual(gateUseOf(all), { check: true, statuses: false, members: true, bypass: true });
  const off = parseConfig(`${SERVICE_YAML}repositories:\n  defaults: { gate: { skipTeam: acme/release-managers } }\n`, ENV);
  assert.equal(gateUseOf(off).members, false);
  const idle = parseConfig(`${SERVICE_YAML}repositories:\n  defaults: { gate: { enabled: false, branches: [main], mode: bypass, skipTeam: acme/release-managers, requiredChecks: [build] } }\n`, ENV);
  assert.deepEqual(gateUseOf(idle), { check: false, statuses: false, members: false, bypass: false });
});
test('bad gate defaults are reported once, even when an override sets only the mode', () => {
  assert.throws(
    () => parseConfig(`${SERVICE_YAML}repositories:\n  defaults: { gate: { enabled: true } }\n  overrides:\n    acme/shop: { gate: { mode: shadow } }\n`, ENV),
    (e: ConfigError) => e.issues.length === 1 && e.issues[0]!.includes('defaults'),
  );
});
test('the example with its gate block switched on parses to a gate on main', () => {
  const c = parseConfig(uncomment(example(), '    # gate:'), exampleEnv);
  assert.deepEqual(c.repositories.defaults.gate, {
    enabled: true, branches: ['main'], checkName: 'AI Review', mode: 'enforce', clearByReply: true, skipTeam: 'acme/release-managers', requiredChecks: ['build'],
  });
  assert.deepEqual(parseConfig(uncomment(example(), '    # score:'), exampleEnv).repositories.defaults.gate, GATE_OFF);
});

const ext = (body: string): string => `${minimal}extensions:\n${body}`;
const KEY = { MODEL_KEY: 'k' };

test('a config with no extensions block has none', () => {
  assert.deepEqual(parseConfig(minimal, KEY).extensions, []);
  assert.deepEqual(parseConfig(example(), exampleEnv).extensions, []);
});

test('an extension has a name, a module and options, and options not written are empty', () => {
  const c = parseConfig(
    ext('  - name: tickets\n    module: ./extensions/tickets.ts\n    options: { project: SHOP }\n  - name: chat\n    module: acme-visto-chat\n'),
    KEY,
  );
  assert.deepEqual(c.extensions, [
    { name: 'tickets', module: './extensions/tickets.ts', options: { project: 'SHOP' } },
    { name: 'chat', module: 'acme-visto-chat', options: {} },
  ]);
});

test('a name that is no short code, a name used twice, an unknown key and a module that is neither a path nor a package are refused by key', () => {
  const issuesOf = (text: string): string[] => {
    try {
      parseConfig(text, KEY);
    } catch (e) {
      return (e as ConfigError).issues;
    }
    return [];
  };
  const one = (name: string, module = './m.ts'): string => ext(`  - name: '${name}'\n    module: '${module}'\n`);
  for (const bad of ['Tickets', '9a', 'a-b', '', 'a'.repeat(41)]) {
    const issues = issuesOf(one(bad));
    assert.ok(issues.length > 0, `name ${bad}`);
    assert.ok(issues.every((i) => i.startsWith('extensions.0.name: must be a short code')), issues.join());
    assert.ok(issues.every((i) => !i.includes(bad) || bad === ''), bad);
  }
  assert.equal(issuesOf(one('a'.repeat(40))).length, 0);
  const twice = issuesOf(ext('  - { name: chat, module: ./a.ts }\n  - { name: chat, module: ./b.ts }\n'));
  assert.deepEqual(twice, ['extensions.1.name: is already used by another extension']);
  const unknown = issuesOf(ext('  - { name: chat, module: ./a.ts, path: ./x.ts }\n'));
  assert.ok(unknown.some((i) => i.startsWith('extensions.0') && i.includes('path')), unknown.join());
  for (const bad of ['', 'file:///x.ts', 'node:fs', '.hidden', 'C:\\x.ts', 'extensions/tickets.ts', 'fs', 'child_process']) {
    const issues = issuesOf(one('chat', bad));
    assert.deepEqual(issues, ['extensions.0.module: must be a path that starts with ./, ../ or /, or the name of a package'], bad);
  }
  for (const good of ['@acme/visto-chat', 'acme-visto-chat/tickets', './a.ts', '../a.ts', '/opt/a.ts']) {
    assert.equal(issuesOf(one('chat', good)).length, 0, good);
  }
  const many = Array.from({ length: 21 }, (_, i) => `  - { name: m${i}, module: ./m.ts }\n`).join('');
  const over = issuesOf(ext(many));
  assert.ok(over.length > 0 && over.every((i) => i.startsWith('extensions')), over.join());
  assert.equal(issuesOf(ext(many.split('\n').slice(0, 20).join('\n') + '\n')).length, 0);
});

test('a reference inside options is replaced by the variable, at any depth and in a list', () => {
  const text = ext(
    '  - name: chat\n    module: ./c.ts\n    options:\n      token: { env: CHAT_TOKEN }\n      nested: { key: { env: K2 } }\n      hooks: [{ env: H1 }, plain]\n',
  );
  const c = parseConfig(text, { ...KEY, CHAT_TOKEN: 'v1', K2: 'v2', H1: 'v3' });
  assert.deepEqual(c.extensions[0]!.options, { token: 'v1', nested: { key: 'v2' }, hooks: ['v3', 'plain'] });
});

test('a reference to a variable that is not set, or that names none, stops the config, and the issue names the key and never a value', () => {
  const at = (opt: string): string => ext(`  - name: chat\n    module: ./c.ts\n    options:\n      secret: sk-inline-77\n      ${opt}\n`);
  const issuesOf = (text: string, env: Record<string, string | undefined>): string[] => {
    try {
      parseConfig(text, env);
    } catch (e) {
      return (e as ConfigError).issues;
    }
    return [];
  };
  for (const env of [KEY, { ...KEY, CHAT_TOKEN: '' }]) {
    assert.deepEqual(issuesOf(at('token: { env: CHAT_TOKEN }'), env), ['extensions.0.options.token: environment variable CHAT_TOKEN is not set']);
  }
  for (const bad of ['{ env: 5 }', "{ env: '' }"]) {
    assert.deepEqual(issuesOf(at(`token: ${bad}`), KEY), ['extensions.0.options.token: env must name an environment variable']);
  }
  assert.deepEqual(issuesOf(at('hooks: [plain, { env: NOPE }]'), KEY), ['extensions.0.options.hooks.1: environment variable NOPE is not set']);
  const kept = parseConfig(at('token: { env: A, other: 1 }'), KEY);
  assert.deepEqual(kept.extensions[0]!.options.token, { env: 'A', other: 1 });
  for (const issue of issuesOf(at('token: { env: CHAT_TOKEN }'), KEY)) assert.ok(!issue.includes('sk-inline-77'));
});

test('the example with its extensions block switched on names the example module', () => {
  const c = parseConfig(uncomment(example(), '# extensions:'), { ...exampleEnv, EXAMPLE_FEEDBACK_SECRET: 'fb-secret' });
  assert.deepEqual(c.extensions, [{ name: 'example', module: './examples/extension-example.ts', options: { secret: 'fb-secret' } }]);
  const appEnv = { ...exampleEnv, APP_PRIVATE_KEY: PEM, ALERT_WEBHOOK_URL: 'https://alerts.example.test/in/abc', WEBHOOK_SECRET: 'w', DATABASE_URL: 'postgres://u:p@db:5432/visto' };
  assert.deepEqual(parseConfig(uncomment(example(), '# app:'), appEnv).extensions, []);
});

test('options stay a mapping: a mapping with the one key env at the top of options is an option named env', () => {
  const c = parseConfig(ext('  - name: chat\n    module: ./c.ts\n    options: { env: SOME_VAR }\n'), KEY);
  assert.deepEqual(c.extensions[0]!.options, { env: 'SOME_VAR' });
  const down = parseConfig(ext('  - name: chat\n    module: ./c.ts\n    options: { token: { env: SOME_VAR } }\n'), { ...KEY, SOME_VAR: 'v' });
  assert.deepEqual(down.extensions[0]!.options, { token: 'v' });
});

test('a module name holds no control character, no space and no DEL', () => {
  for (const bad of ['./a\\tb.ts', './a b.ts', './a\\0b.ts', './a\\x7fb.ts']) {
    assert.throws(
      () => parseConfig(ext(`  - name: chat\n    module: "${bad}"\n`), KEY),
      (e: ConfigError) => e.issues.length === 1 && e.issues[0] === 'extensions.0.module: must be a path that starts with ./, ../ or /, or the name of a package',
      bad,
    );
  }
});

const mcp = (body: string): string => `${minimal}mcpServers:\n${body}`;
const mcpIssues = (text: string, env: Record<string, string | undefined> = KEY): string[] => {
  try {
    parseConfig(text, env);
  } catch (e) {
    return (e as ConfigError).issues;
  }
  return [];
};

test('a config with no mcpServers block has none, and the tool choice is forced', () => {
  const c = parseConfig(minimal, KEY);
  assert.deepEqual(c.mcpServers, []);
  assert.equal(c.model.toolChoice, 'forced');
  const shipped = parseConfig(example(), exampleEnv);
  assert.deepEqual(shipped.mcpServers, []);
  assert.equal(shipped.model.toolChoice, 'forced');
  assert.deepEqual(parseConfig(mcp('  []\n'), KEY).mcpServers, []);
});

test('toolChoice takes forced or auto and nothing else', () => {
  assert.equal(parseConfig(minimal + '  toolChoice: auto\n', KEY).model.toolChoice, 'auto');
  assert.equal(parseConfig(minimal + '  toolChoice: forced\n', KEY).model.toolChoice, 'forced');
  for (const bad of ['required', "''", 'true']) {
    const issues = mcpIssues(minimal + `  toolChoice: ${bad}\n`);
    assert.equal(issues.length, 1, bad);
    assert.ok(issues[0]!.startsWith('model.toolChoice: '), issues.join());
    assert.ok(!issues[0]!.includes('required') && !issues[0]!.includes('true'), issues.join());
  }
});

test('a server has a name, an address, headers and tools, and headers not written are empty', () => {
  const c = parseConfig(
    mcp(
      '  - name: docs\n    url: https://docs.example.test/mcp\n    headers: { X-Team: shop }\n    tools: [search, get_page]\n' +
        '  - name: wiki\n    url: http://wiki.example.test:8080/mcp?x=1\n    tools: [find]\n',
    ),
    KEY,
  );
  assert.deepEqual(c.mcpServers, [
    { name: 'docs', url: 'https://docs.example.test/mcp', headers: { 'X-Team': 'shop' }, tools: ['search', 'get_page'] },
    { name: 'wiki', url: 'http://wiki.example.test:8080/mcp?x=1', headers: {}, tools: ['find'] },
  ]);
});

test('a header value is plain text or a reference, and a reference is replaced by its variable', () => {
  const c = parseConfig(
    mcp('  - name: docs\n    url: https://docs.example.test/mcp\n    headers:\n      Authorization: { env: DOCS_MCP_AUTHORIZATION }\n      X-Team: shop\n    tools: [search]\n'),
    { ...KEY, DOCS_MCP_AUTHORIZATION: 'Bearer t0k' },
  );
  assert.deepEqual(c.mcpServers[0]!.headers, { Authorization: 'Bearer t0k', 'X-Team': 'shop' });
});

test('a server that is badly written is refused by key, and no issue holds a value', () => {
  const ok = 'url: https://docs.example.test/mcp\n    tools: [search]\n';
  const entry = (extra: string): string => `  - ${extra}\n`;
  const withName = (name: string): string => entry(`name: '${name}'\n    ${ok}`);
  const NAME = 'mcpServers.0.name: must be a short code of at most 20 characters (a lower-case letter, then lower-case letters, digits or underscores)';
  for (const bad of ['Docs', '9a', 'a-b', '', 'a'.repeat(21)]) assert.deepEqual(mcpIssues(mcp(withName(bad))), [NAME], bad);
  assert.deepEqual(mcpIssues(mcp(withName('a'.repeat(20)))), []);
  assert.deepEqual(
    mcpIssues(mcp(`  - { name: docs, url: https://a.example.test/m, tools: [x] }\n  - { name: docs, url: https://b.example.test/m, tools: [x] }\n`)),
    ['mcpServers.1.name: is already used by another server'],
  );
  const unknown = mcpIssues(mcp(entry(`name: docs\n    token: sk-secret-1\n    ${ok}`)));
  assert.ok(unknown.some((i) => i.startsWith('mcpServers.0') && i.includes('token')), unknown.join());
  const URL_ISSUE = 'mcpServers.0.url: must be an http or https URL with no user name and no password';
  for (const bad of ['', 'ftp://docs.example.test', 'docs.example.test/mcp', 'https://user:pw@docs.example.test/mcp', 'https://user@docs.example.test/mcp']) {
    const issues = mcpIssues(mcp(entry(`name: docs\n    url: '${bad}'\n    tools: [search]\n`)));
    assert.deepEqual(issues, [URL_ISSUE], bad);
  }
  for (const bad of ["' https://docs.example.test/mcp'", "'https://docs.example.test/mcp '", '"https://docs.example.test/\\nmcp"', '"https://docs.example.test/\\tmcp"', '"https://docs.example.test/m\\x01cp"']) {
    assert.deepEqual(mcpIssues(mcp(entry(`name: docs\n    url: ${bad}\n    tools: [search]\n`))), [URL_ISSUE], bad);
  }
  const TOOLS_MESSAGE = 'must name 1 to 20 tools';
  const TOOLS = 'mcpServers.0.tools: must name 1 to 20 tools';
  assert.deepEqual(mcpIssues(mcp(entry('name: docs\n    url: https://docs.example.test/mcp\n'))), ['mcpServers.0.tools: ' + TOOLS_MESSAGE]);
  assert.deepEqual(mcpIssues(mcp(entry('name: docs\n    url: https://docs.example.test/mcp\n    tools: []\n'))), [TOOLS]);
  const tools = (list: string): string[] => mcpIssues(mcp(entry(`name: docs\n    url: https://docs.example.test/mcp\n    tools: ${list}\n`)));
  assert.deepEqual(tools(JSON.stringify(Array.from({ length: 21 }, (_, i) => `t${i}`))), [TOOLS]);
  assert.deepEqual(tools(JSON.stringify(Array.from({ length: 20 }, (_, i) => `t${i}`))), []);
  const TOOL = 'must be 1 to 128 characters with no control character';
  assert.deepEqual(tools("['']"), [`mcpServers.0.tools.0: ${TOOL}`]);
  assert.deepEqual(tools(JSON.stringify(['x'.repeat(129)])), [`mcpServers.0.tools.0: ${TOOL}`]);
  assert.deepEqual(tools(JSON.stringify(['x'.repeat(128)])), []);
  assert.deepEqual(tools(JSON.stringify(['a', 'b\nc'])), [`mcpServers.0.tools.1: ${TOOL}`]);
  assert.deepEqual(tools(JSON.stringify(['a\u007fb'])), [`mcpServers.0.tools.0: ${TOOL}`]);
  assert.deepEqual(tools('[a, b, a]'), ['mcpServers.0.tools.2: is named twice']);
  const six = Array.from({ length: 6 }, (_, i) => `  - { name: s${i}, url: 'https://s${i}.example.test/m', tools: [x] }\n`).join('');
  const sixIssues = mcpIssues(mcp(six));
  assert.ok(sixIssues.length > 0 && sixIssues.every((i) => i.startsWith('mcpServers')), sixIssues.join());
  assert.deepEqual(mcpIssues(mcp(six.split('\n').slice(0, 5).join('\n') + '\n')), []);
  const headers = (h: string): string[] => mcpIssues(mcp(entry(`name: docs\n    url: https://docs.example.test/mcp\n    tools: [search]\n    headers: ${h}\n`)));
  const NAMEH = 'must be a header name of letters, digits and hyphens, at most 100';
  assert.deepEqual(headers("{ 'X Team': a }"), [`mcpServers.0.headers.X Team: ${NAMEH}`]);
  const control = headers('{ "X\\r\\nA": v }');
  assert.equal(control.length, 1);
  assert.ok(!/[\x00-\x1f\x7f]/.test(control[0]!), 'one line, no raw control character');
  assert.equal(control[0], `mcpServers.0.headers."X\\r\\nA": ${NAMEH}`);
  assert.deepEqual(headers(JSON.stringify({ ['x'.repeat(101)]: 'a' })), [`mcpServers.0.headers.${'x'.repeat(101)}: ${NAMEH}`]);
  for (const reserved of ['Content-Type', 'ACCEPT', 'Host', 'content-length', 'Connection', 'Transfer-Encoding', 'Mcp-Session-Id', 'mcp-protocol-version']) {
    assert.deepEqual(headers(`{ ${reserved}: a }`), [`mcpServers.0.headers.${reserved}: is set by the service`], reserved);
  }
  assert.deepEqual(headers('{ Authorization: a, authorization: b }'), ['mcpServers.0.headers.authorization: is written twice']);
  const many = (n: number): string => `{ ${Array.from({ length: n }, (_, i) => `H${i}: v`).join(', ')} }`;
  assert.ok(headers(many(21)).length > 0 && headers(many(21)).every((i) => i.startsWith('mcpServers.0.headers')));
  assert.deepEqual(headers(many(20)), []);
  assert.deepEqual(headers("{ A: '' }"), ['mcpServers.0.headers.A: must be 1 to 4,000 printable ASCII characters']);
  assert.deepEqual(headers('{ A: "a\\nb" }'), ['mcpServers.0.headers.A: must be 1 to 4,000 printable ASCII characters']);
  assert.deepEqual(headers(`{ A: '${'x'.repeat(4001)}' }`), ['mcpServers.0.headers.A: must be 1 to 4,000 printable ASCII characters']);
  assert.deepEqual(headers(`{ A: '${'x'.repeat(4000)}' }`), []);
  // No issue holds a value, an address or a secret.
  const all = [
    ...mcpIssues(mcp(entry(`name: docs\n    url: 'https://user:pw@docs.example.test/mcp'\n    tools: [search]\n    headers: { A: "sk-val-9\\n" }\n`))),
    ...unknown,
  ];
  for (const issue of all) assert.ok(!/pw|sk-val-9|docs\.example\.test|sk-secret-1/.test(issue), issue);
});

test('a reference to a variable that is not set stops the config, and a value read from a variable is checked like a written one', () => {
  const text = mcp('  - name: docs\n    url: https://docs.example.test/mcp\n    headers:\n      Authorization: { env: DOCS_MCP_AUTHORIZATION }\n    tools: [search]\n');
  const NOT_SET = ['mcpServers.0.headers.Authorization: environment variable DOCS_MCP_AUTHORIZATION is not set'];
  assert.deepEqual(mcpIssues(text, KEY), NOT_SET);
  assert.deepEqual(mcpIssues(text, { ...KEY, DOCS_MCP_AUTHORIZATION: '' }), NOT_SET);
  const bad = mcpIssues(text, { ...KEY, DOCS_MCP_AUTHORIZATION: 'Bearer sk-line-1\nsecond' });
  assert.deepEqual(bad, ['mcpServers.0.headers.Authorization: must be 1 to 4,000 printable ASCII characters']);
  assert.ok(!bad.join().includes('sk-line-1'));
  assert.deepEqual(mcpIssues(text, { ...KEY, DOCS_MCP_AUTHORIZATION: 'x'.repeat(4001) }).length, 1);
  assert.deepEqual(mcpIssues(text, { ...KEY, DOCS_MCP_AUTHORIZATION: 'x'.repeat(4000) }), []);
  const two = mcp('  - name: docs\n    url: https://docs.example.test/mcp\n    headers: { A: { env: ONE }, B: { env: TWO } }\n    tools: [search]\n');
  assert.deepEqual(mcpIssues(two, KEY), [
    'mcpServers.0.headers.A: environment variable ONE is not set',
    'mcpServers.0.headers.B: environment variable TWO is not set',
  ]);
});

test('a server may carry the name of an extension', () => {
  const text = `${minimal}extensions:\n  - { name: docs, module: ./a.ts }\nmcpServers:\n  - { name: docs, url: 'https://docs.example.test/mcp', tools: [search] }\n`;
  const c = parseConfig(text, KEY);
  assert.equal(c.extensions[0]!.name, 'docs');
  assert.equal(c.mcpServers[0]!.name, 'docs');
});

test('the example with its mcpServers block switched on names the docs server', () => {
  const c = parseConfig(uncomment(example(), '# mcpServers:'), { ...exampleEnv, DOCS_MCP_AUTHORIZATION: 'Bearer ex-1' });
  assert.deepEqual(c.mcpServers, [
    { name: 'docs', url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer ex-1' }, tools: ['search'] },
  ]);
  assert.deepEqual(parseConfig(uncomment(example(), '# extensions:'), { ...exampleEnv, EXAMPLE_FEEDBACK_SECRET: 's' }).mcpServers, []);
});

test('a config with no learning key has learning off, and so has the example as shipped', () => {
  assert.equal(parseConfig(minimal, KEY).learning, false);
  assert.equal(parseConfig(example(), exampleEnv).learning, false);
  assert.equal(parseConfig(minimal + 'learning: false\n', KEY).learning, false);
});

test('learning takes true or false and nothing else', () => {
  assert.equal(parseConfig(minimal + 'learning: true\n', KEY).learning, true);
  for (const bad of ['on', '1', 'null']) {
    const issues = mcpIssues(minimal + `learning: ${bad}\n`);
    assert.equal(issues.length, 1, bad);
    assert.ok(issues[0]!.startsWith('learning: '), issues.join());
    assert.ok(!issues[0]!.includes(`'${bad}'`) && !issues[0]!.includes(`"${bad}"`), issues.join());
  }
});

test('the example with its learning key written true is read, and the other blocks still uncomment beside it', () => {
  const on = example().replace('\nlearning: false\n', '\nlearning: true\n');
  assert.notEqual(on, example());
  assert.equal(parseConfig(on, exampleEnv).learning, true);
  assert.equal(parseConfig(uncomment(example(), '# extensions:'), { ...exampleEnv, EXAMPLE_FEEDBACK_SECRET: 's' }).learning, false);
});

test('learning is not a key of a repository', () => {
  const defaults = mcpIssues(minimal + 'repositories:\n  defaults:\n    learning: true\n');
  assert.equal(defaults.length, 1, defaults.join());
  assert.ok(defaults[0]!.startsWith('repositories.defaults'), defaults.join());
  const override = mcpIssues(minimal + 'repositories:\n  overrides:\n    acme/shop:\n      learning: true\n');
  assert.equal(override.length, 1, override.join());
  assert.ok(override[0]!.startsWith('repositories.overrides.acme/shop'), override.join());
});

const AUDIT_ISSUE = 'must be written as 0 while autoApprove is true: this release does not draw the audit sample yet';
const DEFAULTS_AUDIT = `repositories.defaults.score.auditShare: ${AUDIT_ISSUE}`;
const SHOP_AUDIT = `repositories.overrides.acme/shop.score.auditShare: ${AUDIT_ISSUE}`;
const repos = (body: string): string => `${SERVICE_YAML}repositories:\n${body}`;

test('approval is off unless the config writes it, and a config that writes none gives the settings it gave', () => {
  assert.deepEqual(APPROVAL_OFF, { enabled: false, threads: 'strict', auditShare: 5 });
  const others = repos('  overrides:\n    acme/shop: { score: { threshold: 40, inlineNotes: true }, gate: { mode: shadow } }\n');
  const configs = [parseConfig(minimal, KEY), parseConfig(SERVICE_YAML, ENV), parseConfig(example(), exampleEnv), parseConfig(others, ENV)];
  for (const c of configs) {
    assert.equal('approval' in c.repositories.defaults, false);
    for (const o of Object.values(c.repositories.overrides)) assert.equal('approval' in o, false);
    for (const name of ['acme/shop', 'acme/other']) {
      const settings = repoSettingsFor(c, name);
      assert.equal('approval' in settings, false, name);
      assert.deepEqual(approvalOf(settings), APPROVAL_OFF, name);
    }
    assert.equal(approvalUseOf(c), false);
  }
  assert.deepEqual(repoSettingsFor(parseConfig(others, ENV), 'acme/shop'), {
    primaryBranches: ['main', 'master'], scoreThreshold: 40, ignoredAuthors: ['dependabot[bot]'], baseBranches: [], newHead: null, inlineNotes: true,
    gate: { ...GATE_OFF, mode: 'shadow' },
  });
});

test('the three keys are read for all repositories and for one, and an override replaces only the keys it writes', () => {
  const c = parseConfig(
    repos('  defaults: { score: { autoApprove: true, auditShare: 0 } }\n  overrides:\n    acme/shop: { score: { approvalThreads: gate } }\n    acme/off: { score: { autoApprove: false } }\n'),
    ENV,
  );
  assert.deepEqual(c.repositories.defaults.approval, { enabled: true, threads: 'strict', auditShare: 0 });
  assert.deepEqual(c.repositories.overrides['acme/shop']!.approval, { threads: 'gate' });
  assert.deepEqual(c.repositories.overrides['acme/off']!.approval, { enabled: false });
  assert.deepEqual(repoSettingsFor(c, 'Acme/Shop').approval, { enabled: true, threads: 'gate', auditShare: 0 });
  assert.deepEqual(approvalOf(repoSettingsFor(c, 'acme/shop')), { enabled: true, threads: 'gate', auditShare: 0 });
  assert.deepEqual(approvalOf(repoSettingsFor(c, 'acme/other')), { enabled: true, threads: 'strict', auditShare: 0 });
  assert.deepEqual(approvalOf(repoSettingsFor(c, 'acme/off')), { enabled: false, threads: 'strict', auditShare: 0 });
  assert.deepEqual([repoSettingsFor(c, 'acme/shop').scoreThreshold, repoSettingsFor(c, 'acme/shop').inlineNotes], [70, false]);
  assert.equal(approvalUseOf(c), true);
  const one = parseConfig(repos('  overrides:\n    acme/shop: { score: { autoApprove: true, auditShare: 0 } }\n'), ENV);
  assert.deepEqual(approvalOf(repoSettingsFor(one, 'acme/shop')), { enabled: true, threads: 'strict', auditShare: 0 });
  assert.equal('approval' in one.repositories.defaults, false);
  assert.equal('approval' in repoSettingsFor(one, 'acme/other'), false);
  assert.equal(approvalUseOf(one), true);
  const idle = parseConfig(repos('  defaults: { score: { approvalThreads: gate, auditShare: 0 } }\n  overrides:\n    acme/shop: { score: { autoApprove: false } }\n'), ENV);
  assert.deepEqual(approvalOf(repoSettingsFor(idle, 'acme/other')), { enabled: false, threads: 'gate', auditShare: 0 });
  assert.equal(approvalUseOf(idle), false);
});

test('automatic approval is refused while the audit share is not written as 0, for the defaults and for one repository', () => {
  for (const score of ['{ autoApprove: true }', '{ autoApprove: true, auditShare: 5 }', '{ autoApprove: true, auditShare: 37.5, approvalThreads: gate }']) {
    assert.deepEqual(issuesOf(repos(`  defaults: { score: ${score} }\n`)), [DEFAULTS_AUDIT], score);
  }
  assert.deepEqual(issuesOf(repos('  overrides:\n    acme/shop: { score: { autoApprove: true } }\n')), [SHOP_AUDIT]);
  assert.deepEqual(issuesOf(repos('  defaults: { score: { autoApprove: true, auditShare: 0 } }\n  overrides:\n    acme/shop: { score: { auditShare: 5 } }\n')), [SHOP_AUDIT]);
  // Bad defaults are reported once for an override that writes neither autoApprove nor auditShare.
  for (const override of ['{ score: { inlineNotes: true } }', '{ score: { approvalThreads: gate } }', '{ newHead: full }']) {
    assert.deepEqual(issuesOf(repos(`  defaults: { score: { autoApprove: true } }\n  overrides:\n    acme/shop: ${override}\n`)), [DEFAULTS_AUDIT], override);
  }
  // One that writes either key is judged on its own.
  for (const fixed of ['{ autoApprove: false }', '{ auditShare: 0 }']) {
    assert.deepEqual(issuesOf(repos(`  defaults: { score: { autoApprove: true } }\n  overrides:\n    acme/shop: { score: ${fixed} }\n`)), [DEFAULTS_AUDIT], fixed);
  }
  for (const own of ['{ autoApprove: true }', '{ auditShare: 5 }']) {
    assert.deepEqual(issuesOf(repos(`  defaults: { score: { autoApprove: true } }\n  overrides:\n    acme/shop: { score: ${own} }\n`)), [DEFAULTS_AUDIT, SHOP_AUDIT], own);
  }
  assert.deepEqual(
    issuesOf(repos('  defaults: { gate: { enabled: true }, score: { autoApprove: true } }\n')),
    [`repositories.defaults.gate.branches: ${GATE_ISSUE}`, DEFAULTS_AUDIT],
  );
  for (const dryRun of ['true', 'false']) {
    const at = (body: string): string => repos(body).replace('dryRun: true', `dryRun: ${dryRun}`);
    for (const score of ['{ autoApprove: false, auditShare: 5 }', '{ auditShare: 0 }', '{ approvalThreads: gate }', '{ autoApprove: true, auditShare: 0 }']) {
      assert.deepEqual(issuesOf(at(`  defaults: { score: ${score} }\n`)), [], `${dryRun} ${score}`);
      assert.deepEqual(issuesOf(at(`  overrides:\n    acme/shop: { score: ${score} }\n`)), [], `${dryRun} ${score}`);
    }
    assert.deepEqual(issuesOf(at('  defaults: { score: { autoApprove: true } }\n')), [DEFAULTS_AUDIT], dryRun);
    assert.deepEqual(issuesOf(at('  overrides:\n    acme/shop: { score: { autoApprove: true, auditShare: 5 } }\n')), [SHOP_AUDIT], dryRun);
  }
});

test('an approval key of the wrong kind is refused by name, and the issue quotes no value', () => {
  const bad: [string, string][] = [
    ['approvalThreads', 'relaxed'], ['autoApprove', 'yes'], ['auditShare', '-1'], ['auditShare', '101'], ['auditShare', 'five'], ['auditShare', 'null'],
  ];
  for (const [key, value] of bad) {
    const at: [string, string][] = [
      [`  defaults: { score: { ${key}: ${value} } }\n`, `repositories.defaults.score.${key}`],
      [`  overrides:\n    acme/shop: { score: { ${key}: ${value} } }\n`, `repositories.overrides.acme/shop.score.${key}`],
    ];
    for (const [body, where] of at) {
      const issues = issuesOf(repos(body));
      assert.ok(issues.length > 0, `${key}: ${value}`);
      for (const issue of issues) {
        assert.ok(issue.startsWith(where), issue);
        for (const quoted of ['relaxed', 'yes', 'five', '-1', '101']) assert.ok(!issue.includes(quoted), issue);
      }
    }
  }
  const unknown = issuesOf(repos('  defaults: { score: { autoApproval: true } }\n'));
  assert.ok(unknown.length === 1 && unknown[0]!.startsWith('repositories.defaults.score') && unknown[0]!.includes('autoApproval'), unknown.join());
});

test('the example with its score block switched on reads approval as written: off, strict, share 0', () => {
  const c = parseConfig(uncomment(example(), '    # score:'), exampleEnv);
  assert.deepEqual(c.repositories.defaults.approval, { enabled: false, threads: 'strict', auditShare: 0 });
  for (const name of ['acme/shop', 'acme/other']) {
    assert.deepEqual(approvalOf(repoSettingsFor(c, name)), { enabled: false, threads: 'strict', auditShare: 0 }, name);
  }
  assert.equal(approvalUseOf(c), false);
  for (const line of ['autoApprove: false', 'approvalThreads: strict', 'auditShare: 0']) {
    assert.match(example(), new RegExp(`^ {4}# {3}${line}$`, 'm'), line);
  }
});
