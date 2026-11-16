import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareSummaries } from './compare.ts';
import { main } from './cli.ts';
import type { SummaryFile } from './replay.ts';

const HASH = 'a'.repeat(64);
const file = (summary: Record<string, number | string | null>, hash: string | null = HASH): SummaryFile =>
  ({ summary, ...(hash === null ? {} : { cases_sha256: hash }), cases_file: 'c.jsonl', case_count: 3, max_cases: 60, stopped_reason: null, cases_not_started: 0, scored: [] }) as unknown as SummaryFile;

const base = file({ label: 'old', valid_recall: 0.2, invalid_blocking_rate: 0.1, failed_cases: 0, cases: 3, total_cost: null });
const cand = file({ label: 'new', valid_recall: 0.3, invalid_blocking_rate: 0.12, failed_cases: 1, cases: 3, total_cost: 0.5 });
const base2 = file({ label: 'old2', valid_recall: 0.2, invalid_blocking_rate: 0.13, failed_cases: 0, cases: 3 });

test('different case files are refused', () => {
  assert.throws(() => compareSummaries(base, { ...cand, cases_sha256: 'f'.repeat(64) }, null), /^Error: different_case_files$/);
});
test('a summary without a case hash is refused', () => {
  assert.throws(() => compareSummaries(file({ label: 'x' }, null), cand, null), /^Error: missing_case_hash$/);
  assert.throws(() => compareSummaries(base, file({ label: 'x' }, null), null), /^Error: missing_case_hash$/);
});
test('direction and noise marks', () => {
  const out = compareSummaries(base, cand, base2);
  assert.match(out, /\| valid_recall \| 0\.2 \| 0\.3 \| 0\.1 \| better \|/);
  assert.match(out, /\| invalid_blocking_rate \| 0\.1 \| 0\.12 \| 0\.02 \| noise \|/);
  assert.match(out, /\| failed_cases \| 0 \| 1 \| 1 \| worse \|/);
});
test('header uses the labels, with defaults when absent', () => {
  assert.equal(compareSummaries(base, cand, null).split('\n')[0], '| metric | old | new | delta | |');
  assert.equal(compareSummaries(file({}), file({}), null).split('\n')[0], '| metric | baseline | candidate | delta | |');
});
test('no direction, null value, zero delta and no third summary', () => {
  const out = compareSummaries(base, cand, null);
  assert.match(out, /\| invalid_blocking_rate \| 0\.1 \| 0\.12 \| 0\.02 \| worse \|/);
  assert.match(out, /\| total_cost \| \u2014 \| 0\.5 \| \u2014 \| \|/);
  assert.match(out, /\| cases \| 3 \| 3 \| 0 \| \|/);
  assert.match(out, /\| median_duration_s \| \u2014 \| \u2014 \| \u2014 \| \|/);
  assert.equal(out.split('\n').filter((l) => l.startsWith('|')).length, 2 + 24);
});
test('a null value in the third summary is not a noise band', () => {
  const third = file({ label: 't', valid_recall: null });
  assert.match(compareSummaries(base, cand, third), /\| valid_recall \| 0\.2 \| 0\.3 \| 0\.1 \| better \|/);
});
test('no warning when the runs are comparable', () => {
  assert.doesNotMatch(compareSummaries(base, file({ label: 'n', failed_cases: 0, cases: 3 }), null), /warning/);
});
test('a warning for each condition that makes two runs hard to compare', () => {
  const stopped = { ...file({ label: 'n', failed_cases: 2, cases: 5 }), stopped_reason: 'max_cost' } as SummaryFile;
  const lines = compareSummaries(base, stopped, null).split('\n');
  assert.deepEqual(lines.slice(2 + 24), [
    'warning: case counts differ (3 and 5)',
    'warning: a run was stopped early (max_cost)',
    'warning: failed cases (0 and 2)',
  ]);
  assert.deepEqual(compareSummaries(stopped, base, null).split('\n').slice(2 + 24), [
    'warning: case counts differ (5 and 3)',
    'warning: a run was stopped early (max_cost)',
    'warning: failed cases (2 and 0)',
  ]);
  assert.deepEqual(compareSummaries(base, cand, null).split('\n').slice(2 + 24), ['warning: failed cases (0 and 1)']);
});

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function run(argv: string[], env: Record<string, string | undefined> = { GITHUB_TOKEN: 't' }): Promise<[number, string[]]> {
  const lines: string[] = [];
  const code = await main(argv, env, (l) => lines.push(l));
  return [code, lines];
}
const dir = mkdtempSync(tmpdir() + '/');
writeFileSync(join(dir, 'cases.jsonl'), '');
writeFileSync(join(dir, 'config.yml'), '');
const required = ['--cases', join(dir, 'cases.jsonl'), '--out', join(dir, 'out'), '--label', 'x', '--config', join(dir, 'config.yml')];
const replay = (...extra: string[]) => run(['replay', ...required, ...extra]);

test('usage errors exit 2 with one line', async () => {
  const bad: [string, Promise<[number, string[]]>][] = [
    ['no command', run([])],
    ['unknown command', run(['bogus'])],
    ['missing option', run(['replay', '--cases', 'a', '--out', 'b', '--label', 'x'])],
    ['unknown option', replay('--nope', '1')],
    ['concurrency 4', replay('--concurrency', '4')],
    ['concurrency 0', replay('--concurrency', '0')],
    ['max-cases 0', replay('--max-cases', '0')],
    ['max-cost -1', replay('--max-cost', '-1')],
    ['max-cost text', replay('--max-cost', 'lots')],
    ['no token', run(['replay', ...required], {})],
    ['cases inside project', run(['replay', ...required.map((v, i) => (i === 1 ? join(projectRoot, 'x.jsonl') : v))])],
    ['out inside project', run(['replay', ...required.map((v, i) => (i === 3 ? join(projectRoot, 'runs', 'x') : v))])],
    ['compare needs two files', run(['compare', 'one.json'])],
    ['compare unknown option', run(['compare', 'a', 'b', '--x', 'y'])],
  ];
  for (const [name, p] of bad) {
    const [code, lines] = await p;
    assert.equal(code, 2, name);
    assert.equal(lines.length, 1, name);
  }
});

test('a non-empty --out needs --force', async () => {
  const full = mkdtempSync(tmpdir() + '/');
  writeFileSync(join(full, 'old.txt'), 'x');
  const [code, lines] = await run(['replay', ...required.map((v, i) => (i === 3 ? full : v))]);
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
});

test('compare prints the table for two summaries', async () => {
  writeFileSync(join(dir, 'a.json'), JSON.stringify(base));
  writeFileSync(join(dir, 'b.json'), JSON.stringify(cand));
  writeFileSync(join(dir, 'c.json'), JSON.stringify(base2));
  const [code, lines] = await run(['compare', join(dir, 'a.json'), join(dir, 'b.json'), '--noise', join(dir, 'c.json')]);
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /\| invalid_blocking_rate \| 0\.1 \| 0\.12 \| 0\.02 \| noise \|/);
});

test('compare of different case files exits 1 with the error code only', async () => {
  writeFileSync(join(dir, 'd.json'), JSON.stringify({ ...cand, cases_sha256: 'b'.repeat(64) }));
  const [code, lines] = await run(['compare', join(dir, 'a.json'), join(dir, 'd.json')]);
  assert.equal(code, 1);
  assert.deepEqual(lines, ['different_case_files']);
});

test('a config error prints each issue on its own line and exits 2', async () => {
  const d = mkdtempSync(tmpdir() + '/');
  writeFileSync(join(d, 'cases.jsonl'), '');
  writeFileSync(join(d, 'config.yml'), 'model:\n  apiKey: { env: MODEL_KEY }\n  modle: x\nlimits:\n  inputTokensPerCall: 5\n');
  const [code, lines] = await run(['replay', '--cases', join(d, 'cases.jsonl'), '--out', join(d, 'out'), '--label', 'x', '--config', join(d, 'config.yml')]);
  assert.equal(code, 2);
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((l) => l.startsWith('config: ')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('modle')));
  assert.ok(lines.some((l) => l.includes('limits.inputTokensPerCall')));
});
test('a --cases or --config file that cannot be read is a usage error', async () => {
  const d = mkdtempSync(tmpdir() + '/');
  writeFileSync(join(d, 'cases.jsonl'), '');
  writeFileSync(join(d, 'config.yml'), 'model:\n  apiKey: { env: MODEL_KEY }\n  model: m\n');
  const args = (cases: string, config: string) => ['replay', '--cases', cases, '--out', join(d, 'out'), '--label', 'x', '--config', config];
  assert.deepEqual(await run(args(join(d, 'cases.jsonl'), join(d, 'missing.yml')), { GITHUB_TOKEN: 't', MODEL_KEY: 'k' }), [2, ['usage: cannot read --config']]);
  assert.deepEqual(await run(args(join(d, 'missing.jsonl'), join(d, 'config.yml')), { GITHUB_TOKEN: 't', MODEL_KEY: 'k' }), [2, ['usage: cannot read --cases']]);
});
test('replay runs end to end under the blocked network, and prints nothing from the cases', async () => {
  const d = mkdtempSync(tmpdir() + '/');
  const privateText = ['acme-private/shop-secret', 'Title only in the case file', 'Body only in the case file', 'author-only-in-case'];
  const caseLine = (n: number): string => JSON.stringify({
    repo: privateText[0], pr_number: n, head_sha: 'f'.repeat(40), compare_base: 'e'.repeat(40), title: privateText[1], body: privateText[2],
    branch: 'topic', base_branch: 'main', author: privateText[3], labels: [{ path: 'src/a.ts', line: 3, label: 'valid', severity: 'major' }],
  });
  writeFileSync(join(d, 'cases.jsonl'), `${caseLine(1)}\n${caseLine(2)}\n`);
  writeFileSync(join(d, 'config.yml'), 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n');
  const out = join(d, 'out');
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let result: [number, string[]];
  try {
    result = await run(['replay', '--cases', join(d, 'cases.jsonl'), '--out', out, '--label', 'blocked', '--config', join(d, 'config.yml')], { GITHUB_TOKEN: 'dummy-token', MODEL_KEY: 'dummy-key' });
  } finally {
    process.stderr.write = write;
  }
  const [code, lines] = result;
  assert.equal(code, 0, lines.join('\n'));
  for (const name of ['results.jsonl', 'summary.json', 'summary.md', 'unmatched-sample.jsonl']) assert.ok(existsSync(join(out, name)), name);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as SummaryFile;
  assert.equal(summary.summary.failed_cases, 2);
  const printed = [...lines, ...stderr].join('\n');
  for (const text of privateText) assert.ok(!printed.includes(text), text);
});
