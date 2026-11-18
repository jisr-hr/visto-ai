import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from './cli.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = mkdtempSync(tmpdir() + '/');
const outFile = join(dir, 'history.jsonl');

async function run(argv: string[], env: Record<string, string | undefined> = { GITHUB_TOKEN: 't' }): Promise<[number, string[]]> {
  const lines: string[] = [];
  const code = await main(argv, env, (l) => lines.push(l));
  return [code, lines];
}

function importArgs(over: Record<string, string> = {}, drop: string[] = []): string[] {
  const options: Record<string, string> = { repo: 'acme/shop', since: '2026-01-01', until: '2026-02-01', out: outFile, ...over };
  for (const name of drop) delete options[name];
  return ['import-history', ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v])];
}

test('import-history usage errors exit 2 with one line', async () => {
  writeFileSync(join(dir, 'full.jsonl'), 'x');
  const bad: [string, Promise<[number, string[]]>][] = [
    ['no token', run(importArgs(), {})],
    ['empty token', run(importArgs(), { GITHUB_TOKEN: '' })],
    ['no arguments', run(['import-history'])],
    ['missing repo', run(importArgs({}, ['repo']))],
    ['missing out', run(importArgs({}, ['out']))],
    ['repo without owner', run(importArgs({ repo: 'shop' }))],
    ['out inside the project', run(importArgs({ out: join(projectRoot, 'history.jsonl') }))],
    ['since not a date', run(importArgs({ since: 'yesterday' }))],
    ['until in another format', run(importArgs({ until: '2026-2-1' }))],
    ['a day that does not exist', run(importArgs({ since: '2026-02-30' }))],
    ['since after until', run(importArgs({ since: '2026-03-01' }))],
    ['since equal to until', run(importArgs({ since: '2026-02-01' }))],
    ['max-prs 0', run([...importArgs(), '--max-prs', '0'])],
    ['max-prs 1.5', run([...importArgs(), '--max-prs', '1.5'])],
    ['unknown option', run([...importArgs(), '--nope', '1'])],
    ['existing file without --force', run(importArgs({ out: join(dir, 'full.jsonl') }))],
  ];
  for (const [name, p] of bad) {
    const [code, lines] = await p;
    assert.equal(code, 2, name);
    assert.equal(lines.length, 1, name);
    assert.match(lines[0]!, /^usage: /, name);
  }
});

test('the dates are checked before anything else', async () => {
  const [code, lines] = await run(importArgs({ since: '2026-02-30', out: join(projectRoot, 'x.jsonl') }), {});
  assert.equal(code, 2);
  assert.match(lines[0]!, /--since/);
});

test('the usage line of an unknown command names import-history', async () => {
  const [, lines] = await run(['bogus']);
  assert.match(lines[0]!, /import-history/);
});

test('--out naming an existing directory is a usage error, with and without --force', async () => {
  const folder = join(dir, 'a-folder');
  mkdirSync(folder);
  for (const extra of [[], ['--force']]) {
    const [code, lines] = await run([...importArgs({ out: folder }), ...extra]);
    assert.equal(code, 2);
    assert.deepEqual(lines, ['usage: --out must be a file']);
  }
});

function backtestArgs(over: Record<string, string> = {}, drop: string[] = []): string[] {
  const options: Record<string, string> = { history: join(dir, 'h.jsonl'), out: join(dir, 'run-out'), label: 'one', config: join(dir, 'config.yml'), ...over };
  for (const name of drop) delete options[name];
  return ['backtest', ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v])];
}

const backtestEnv = { GITHUB_TOKEN: 't', MODEL_KEY: 'k' };

// The config loads and the history file does not exist, so a case that passes its own check ends at
// "cannot read --history" and the test names which check was meant to stop it.
test('backtest usage errors exit 2 with one exact line', async () => {
  mkdirSync(join(dir, 'busy'), { recursive: true });
  writeFileSync(join(dir, 'busy', 'x'), 'x');
  writeFileSync(join(dir, 'config.yml'), 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n');
  const cases: [string, string[], Record<string, string | undefined>, string][] = [
    ['no arguments', ['backtest'], backtestEnv, 'usage: backtest needs --history'],
    ['missing history', backtestArgs({}, ['history']), backtestEnv, 'usage: backtest needs --history'],
    ['missing out', backtestArgs({}, ['out']), backtestEnv, 'usage: backtest needs --out'],
    ['missing label', backtestArgs({}, ['label']), backtestEnv, 'usage: backtest needs --label'],
    ['missing config', backtestArgs({}, ['config']), backtestEnv, 'usage: backtest needs --config'],
    ['no token', backtestArgs(), { MODEL_KEY: 'k' }, 'usage: GITHUB_TOKEN is not set'],
    ['history inside the project', backtestArgs({ history: join(projectRoot, 'h.jsonl') }), backtestEnv, 'usage: --history must be outside the project folder'],
    ['out inside the project', backtestArgs({ out: join(projectRoot, 'run') }), backtestEnv, 'usage: --out must be outside the project folder'],
    ['out not empty without --force', backtestArgs({ out: join(dir, 'busy') }), backtestEnv, 'usage: --out is not empty; use --force to reuse it'],
    ['concurrency 4', [...backtestArgs(), '--concurrency', '4'], backtestEnv, 'usage: --concurrency must be 1, 2 or 3'],
    ['max-cases 0', [...backtestArgs(), '--max-cases', '0'], backtestEnv, 'usage: --max-cases must be a positive number'],
    ['positional argument', [...backtestArgs(), 'extra'], backtestEnv, 'usage: backtest takes no positional arguments'],
    ['unknown option', [...backtestArgs(), '--nope', '1'], backtestEnv, 'usage: unknown option --nope'],
    ['history that does not exist', backtestArgs(), backtestEnv, 'usage: cannot read --history'],
    ['config that does not exist', backtestArgs({ config: join(dir, 'none.yml') }), backtestEnv, 'usage: cannot read --config'],
  ];
  for (const [name, argv, env, message] of cases) {
    const [code, lines] = await run(argv, env);
    assert.equal(code, 2, name);
    assert.deepEqual(lines, [message], name);
  }
});

function runDir(name: string, sha: string, scores: string, extra: { contract_sha256?: string; models?: string[] } = {}): string {
  const d = join(dir, name);
  mkdirSync(d);
  writeFileSync(join(d, 'summary.json'), JSON.stringify({ label: name, history_sha256: sha, contract_sha256: 'd'.repeat(64), models: ['m'], ...extra }));
  writeFileSync(join(d, 'scores.jsonl'), scores);
  return d;
}

test('score-noise usage errors exit 2', async () => {
  for (const argv of [['score-noise'], ['score-noise', 'one'], ['score-noise', 'a', 'b', 'c'], ['score-noise', join(dir, 'nowhere'), join(dir, 'nowhere')]]) {
    const [code, lines] = await run(argv);
    assert.equal(code, 2, argv.join(' '));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^usage: /);
  }
});

test('score-noise on two runs of different history files refuses', async () => {
  const [code, lines] = await run(['score-noise', runDir('n1', 'a'.repeat(64), ''), runDir('n2', 'b'.repeat(64), '')]);
  assert.notEqual(code, 0);
  assert.deepEqual(lines, ['different_history_files']);
});

test('score-noise prints one row per threshold, with a dash where nothing was compared', async () => {
  const [code, lines] = await run(['score-noise', runDir('m1', 'c'.repeat(64), ''), runDir('m2', 'c'.repeat(64), '')]);
  assert.equal(code, 0);
  assert.equal(lines.length, 6);
  assert.equal(lines[2], '| 20 | \u2014 | 0 | \u2014 | 0 |');
  assert.match(lines[5]!, /^\| 90 \|/);
});

test('score-noise on two runs made with different contracts refuses', async () => {
  const [code, lines] = await run(['score-noise', runDir('k1', 'c'.repeat(64), ''), runDir('k2', 'c'.repeat(64), '', { contract_sha256: 'e'.repeat(64) })]);
  assert.notEqual(code, 0);
  assert.deepEqual(lines, ['different_contracts']);
});

test('score-noise warns in one line when the runs were answered by different models', async () => {
  const [code, lines] = await run(['score-noise', runDir('w1', 'c'.repeat(64), '', { models: ['m'] }), runDir('w2', 'c'.repeat(64), '', { models: ['m', 'fallback-m'] })]);
  assert.equal(code, 0);
  assert.equal(lines.length, 7);
  assert.equal(lines[0], 'warning: the runs were answered by different models: m; m, fallback-m');
  assert.match(lines[1]!, /^\| threshold \|/);
});

test('the usage line of an unknown command names backtest and score-noise', async () => {
  const [, lines] = await run(['bogus']);
  assert.match(lines[0]!, /backtest\|score-noise/);
});
