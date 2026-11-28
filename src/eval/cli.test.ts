import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { measure, share, THRESHOLDS } from './backtest/metrics.ts';
import type { CaseScores } from './backtest/metrics.ts';
import { scoreMoves } from './backtest/noise.ts';
import { A, B, block, C, file } from './backtest/test-cases.ts';
import { main, prepareRun } from './cli.ts';
import { serializeCase } from './history/file.ts';
import type { HistoryCase } from './history/file.ts';

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

function runDir(name: string, sha: string, scores: string, extra: { contract_sha256?: string; models?: string[]; scorer?: string | null; memory_file?: string; memory_sha256?: string } = {}): string {
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

test('score-noise on two runs scored by different scorers refuses', async () => {
  const [code, lines] = await run(['score-noise', runDir('s1', 'c'.repeat(64), '', { scorer: null }), runDir('s2', 'c'.repeat(64), '', { scorer: 'vendor/decision-model' })]);
  assert.notEqual(code, 0);
  assert.deepEqual(lines, ['different_scorers']);
});

test('score-noise counts a summary without the scorer field as null', async () => {
  const [code, lines] = await run(['score-noise', runDir('s3', 'c'.repeat(64), ''), runDir('s4', 'c'.repeat(64), '', { scorer: null })]);
  assert.equal(code, 0);
  assert.equal(lines.length, 6);
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

test('the eval commands load no module', () => {
  const text = readFileSync(join(projectRoot, 'src', 'eval', 'cli.ts'), 'utf8');
  assert.equal(/from '\.\.\/extensions\//.test(text), false);
  assert.equal(text.includes('loadExtensions'), false);
  assert.equal(text.includes('contextProviders'), false);
});

test('the eval commands pass the tool choice of the config on', () => {
  const folder = mkdtempSync(tmpdir() + '/');
  const config = join(folder, 'config.yml');
  const argv = ['--cases', join(folder, 'cases.yml'), '--out', join(folder, 'out'), '--label', 'one', '--config', config];
  const env = { GITHUB_TOKEN: 't', MODEL_KEY: 'k' };
  const base = 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n';
  writeFileSync(config, `${base}  toolChoice: auto\n`);
  assert.equal(prepareRun('replay', 'cases', argv, env).deps.toolChoice, 'auto');
  writeFileSync(config, `${base}  toolChoice: forced\n`);
  assert.equal('toolChoice' in prepareRun('replay', 'cases', argv, env).deps, false);
  writeFileSync(config, base);
  assert.equal('toolChoice' in prepareRun('replay', 'cases', argv, env).deps, false);
});

test('the eval commands build no MCP client', () => {
  const folder = mkdtempSync(tmpdir() + '/');
  const config = join(folder, 'config.yml');
  const argv = ['--cases', join(folder, 'cases.yml'), '--out', join(folder, 'out'), '--label', 'one', '--config', config];
  const env = { GITHUB_TOKEN: 't', MODEL_KEY: 'k', DOCS_KEY: 'Bearer t0k' };
  writeFileSync(config, [
    'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n',
    'mcpServers:\n  - name: docs\n    url: https://docs.example.test/mcp\n    headers:\n      Authorization: { env: DOCS_KEY }\n    tools: [search]\n',
  ].join(''));
  const setup = prepareRun('replay', 'cases', argv, env);
  assert.equal(setup.config.mcpServers.length, 1);
  assert.equal('mcpServers' in setup.deps, false);
  const text = readFileSync(join(projectRoot, 'src', 'eval', 'cli.ts'), 'utf8');
  assert.equal(/from '\.\.\/mcp\//.test(text), false);
  // the variable a header names is still needed
  assert.throws(() => prepareRun('replay', 'cases', argv, { GITHUB_TOKEN: 't', MODEL_KEY: 'k' }));
});

test('backtest takes --memory with a file, refuses it with a scorer in the config, and replay does not take it', async () => {
  writeFileSync(join(dir, 'config.yml'), 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n');
  const scorerConfig = join(dir, 'scorer-config.yml');
  writeFileSync(scorerConfig, 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\nscorer:\n  apiKey: { env: SCORER_KEY }\n  model: vendor/decider\n' +
    'repositories:\n  defaults:\n    score:\n      threshold: 80\n');
  const memoryFile = join(dir, 'memory-none.jsonl');
  const cases: [string, string[], Record<string, string | undefined>, string][] = [
    ['no value', [...backtestArgs(), '--memory'], backtestEnv, 'usage: option --memory needs a value'],
    ['inside the project', [...backtestArgs(), '--memory', join(projectRoot, 'm.jsonl')], backtestEnv, 'usage: --memory must be outside the project folder'],
    ['a scorer in the config', [...backtestArgs({ config: scorerConfig }), '--memory', memoryFile], { ...backtestEnv, SCORER_KEY: 's' }, 'usage: --memory cannot be used with a scorer in the config'],
    ['history that does not exist', [...backtestArgs(), '--memory', memoryFile], backtestEnv, 'usage: cannot read --history'],
    ['replay', ['replay', '--cases', join(dir, 'c.yml'), '--memory', memoryFile], backtestEnv, 'usage: unknown option --memory'],
  ];
  for (const [name, argv, env, message] of cases) {
    const [code, lines] = await run(argv, env);
    assert.equal(code, 2, name);
    assert.deepEqual(lines, [message], name);
  }
  writeFileSync(join(dir, 'h-present.jsonl'), '');
  const [code, lines] = await run([...backtestArgs({ history: join(dir, 'h-present.jsonl'), out: join(dir, 'run-memory-out') }), '--memory', memoryFile], backtestEnv);
  assert.deepEqual([code, lines], [2, ['usage: cannot read --memory']]);
  const setup = prepareRun('backtest', 'history', [...backtestArgs().slice(1), '--memory', memoryFile], backtestEnv, ['memory']);
  assert.deepEqual(setup.options, { memory: memoryFile });
  assert.deepEqual(prepareRun('backtest', 'history', backtestArgs().slice(1), backtestEnv, ['memory']).options, {});
});

const TAX = 'src/billing/tax.ts';
function historyCase(pr: number, mergedAt: string, activity: HistoryCase['activity'] = []): HistoryCase {
  return {
    version: 1, repo: 'acme/shop', pr_number: pr, title: 'Change', body: 'Changes.', author: 'octo-dev', branch: 'topic', base_branch: 'main',
    merged_at: mergedAt, review_head: `head${pr}`.padEnd(12, '0'), review_base: 'base0000', review_at: mergedAt, reviewed_by_person: true,
    final_head: 'final000', final_base: 'base0000', final_files: [{ path: TAX, previous_path: null, status: 'modified', patch: null }], activity,
  };
}

test('memory-count needs its two files, outside the project, and no token', async () => {
  const folder = mkdtempSync(tmpdir() + '/');
  const history = join(folder, 'history.jsonl');
  const memory = join(folder, 'memory.jsonl');
  const lead = { kind: 'inline' as const, id: 'm1', author: 'octo-lead', bot: false, association: 'member' as const, at: '2026-03-01T10:00:00Z', body: 'x', commit: 'head10000000', path: TAX, side: 'RIGHT' as const, line: 2 };
  writeFileSync(memory, [historyCase(1, '2026-03-01T12:00:00Z', [lead]), historyCase(2, '2026-03-05T12:00:00Z')].map(serializeCase).join('\n') + '\n');
  writeFileSync(history, [historyCase(2, '2026-03-05T12:00:00Z'), historyCase(3, '2026-03-06T12:00:00Z', [{ ...lead, id: 'm3', commit: 'head30000000' }])].map(serializeCase).join('\n') + '\n');
  const args = (over: Record<string, string> = {}, drop: string[] = []): string[] => {
    const options: Record<string, string> = { history, memory, ...over };
    for (const name of drop) delete options[name];
    return ['memory-count', ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v])];
  };
  const bad: [string, string[], string][] = [
    ['no arguments', ['memory-count'], 'usage: memory-count needs --history'],
    ['missing memory', args({}, ['memory']), 'usage: memory-count needs --memory'],
    ['history inside the project', args({ history: join(projectRoot, 'h.jsonl') }), 'usage: --history must be outside the project folder'],
    ['memory inside the project', args({ memory: join(projectRoot, 'm.jsonl') }), 'usage: --memory must be outside the project folder'],
    ['history that does not exist', args({ history: join(folder, 'none.jsonl') }), 'usage: cannot read --history'],
    ['memory that does not exist', args({ memory: join(folder, 'none.jsonl') }), 'usage: cannot read --memory'],
    ['max-cases 0', [...args(), '--max-cases', '0'], 'usage: --max-cases must be a positive number'],
    ['positional argument', [...args(), 'extra'], 'usage: memory-count takes no positional arguments'],
    ['unknown option', [...args(), '--config', 'x'], 'usage: unknown option --config'],
  ];
  for (const [name, argv, message] of bad) {
    const [code, lines] = await run(argv, {});
    assert.equal(code, 2, name);
    assert.deepEqual(lines, [message], name);
  }
  const before = readdirSync(folder).sort();
  const [code, lines] = await run(args(), {});
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    'cases 2, with a line 2, with a labelled file that got a line 1',
    'acme/shop#2@head20000000: records 1, lines 1, changed 1, near 0, labelled files 0, labelled with a line 0',
    'acme/shop#3@head30000000: records 1, lines 1, changed 1, near 0, labelled files 1, labelled with a line 1',
    'reverts named 0, with their pull request in the file 0, cases shown a reverted line 0',
  ]);
  const [, one] = await run([...args(), '--max-cases', '1'], {});
  assert.deepEqual(one, [
    'cases 1, with a line 1, with a labelled file that got a line 0',
    'acme/shop#2@head20000000: records 1, lines 1, changed 1, near 0, labelled files 0, labelled with a line 0',
    'reverts named 0, with their pull request in the file 0, cases shown a reverted line 0',
  ]);
  assert.deepEqual(readdirSync(folder).sort(), before);
});

const scoresLine = (c: CaseScores): string => JSON.stringify({
  key: c.key, threshold: c.threshold, status: c.status, scores: c.scores,
  labels: { blocks: Object.fromEntries(c.labels.blocks), files: Object.fromEntries(c.labels.files), comments: c.labels.comments, final_missing: c.labels.final_missing },
});
interface Row { key: string; status: 'ok' | 'failed'; calls: number; memory?: { status: string; code: string; lines: number } | null }
const resultLine = (r: Row): string => JSON.stringify({ failure_stage: null, failure_code: null, cost: 0, tokens: 0, duration_ms: 1, verdict: null, ...r });

function compareDir(name: string, cases: CaseScores[], rows: Row[], extra: Record<string, unknown> = {}): string {
  const d = join(dir, name);
  mkdirSync(d);
  writeFileSync(join(d, 'summary.json'), JSON.stringify({ label: name, history_sha256: 'f'.repeat(64), contract_sha256: 'd'.repeat(64), models: ['m'], scorer: null, ...extra }));
  writeFileSync(join(d, 'scores.jsonl'), cases.map(scoresLine).join('\n') + '\n');
  writeFileSync(join(d, 'results.jsonl'), rows.map(resultLine).join('\n') + '\n');
  return d;
}

const shown = { status: 'ok', code: 'ok', lines: 2 };
const nothing = { status: 'empty', code: 'no_records', lines: 0 };
const skipped = { status: 'skipped', code: 'no_room', lines: 0 };
const k = (c: CaseScores, key: string, scores = c.scores): CaseScores => ({ ...c, key, scores });
const baseline = [k(A, 'k1'), k(B, 'k2'), k(C, 'k3'), k(A, 'k4')];
const candidate = [
  k(A, 'k1', [file('a.ts', [block('B1', 80, 10), block('B2', 75, 5)], 15)]),
  k(B, 'k2', [file('b.ts', [block('B1', 45, 10), block('B2', 50, 10)], 20)]),
  k(C, 'k3', [file('c1.ts', [block('B1', 20, 8)], 8, 100), file('c2.ts', [block('B2', 80, 12)], 12)]),
  k(A, 'k4'),
];
const baseRows: Row[] = ['k1', 'k2', 'k3', 'k4'].map((key) => ({ key, status: 'ok', calls: 1 }));
const candRows: Row[] = [
  { key: 'k1', status: 'ok', calls: 1, memory: shown }, { key: 'k2', status: 'ok', calls: 2, memory: shown },
  { key: 'k3', status: 'ok', calls: 1, memory: nothing }, { key: 'k4', status: 'ok', calls: 1, memory: skipped },
];
const EM = '\u2014';
const cellOf = (value: number | null, n: number): string => `${value ?? EM} (n=${n}, step ${share(1, n) ?? EM})`;
// focus is a share of lines and its count is of pull requests: no step is printed for it.
const focusOf = (value: number | null, n: number): string => `${value ?? EM} (n=${n})`;
const WITH_MEMORY = { memory_file: '/elsewhere/h.jsonl', memory_sha256: 'e'.repeat(64) };
const movesTable = (rows: ReturnType<typeof scoreMoves>): string[] => [
  '| threshold | blocks_raised | blocks_lowered | blocks_n | prs_raised | prs_lowered | prs_n |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.threshold} | ${r.blocks_raised} | ${r.blocks_lowered} | ${r.blocks_n} | ${r.prs_raised} | ${r.prs_lowered} | ${r.prs_n} |`),
];

test('score-compare reports the cases shown memory apart, with their counts and the smallest step they can show', async () => {
  const noiseRun = [k(A, 'k1', [file('a.ts', [block('B1', 60, 10), block('B2', 30, 5)], 15)]), k(B, 'k2'), k(C, 'k3'), k(A, 'k4')];
  const a = compareDir('cmp-base', baseline, baseRows);
  const b = compareDir('cmp-cand', candidate, candRows, WITH_MEMORY);
  const n = compareDir('cmp-noise', noiseRun, baseRows);
  const names = ['safety_blocks', 'safety_blocks_loose', 'safety_files', 'safety_files_loose', 'benefit', 'focus'] as const;
  const numbers: string[] = [];
  for (const t of [...THRESHOLDS, 'own' as const]) {
    for (const [run, cases] of [['baseline', baseline], ['candidate', candidate]] as const) {
      const m = measure(cases.slice(0, 2), t);
      numbers.push(`| ${t} | ${run} | ${names.map((x) => (x === 'focus' ? focusOf : cellOf)(m[x], m[`${x}_n`])).join(' | ')} |`);
    }
  }
  const head = [
    'compared: 4 cases that both runs hold with the status ok; in one run only: 0; in both runs but not ok in one: 0',
    'shown memory: 2; none to show: 1; other: 1; of the cases shown memory, with another number of model calls: 1',
    'Cases shown memory: the numbers of each run, each with its count n and its step, the smallest difference that count can show (focus, a share of lines, has its count of pull requests and no step):',
    '| threshold | run | safety_blocks | safety_blocks_loose | safety_files | safety_files_loose | benefit | focus |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...numbers,
    'Cases shown memory: moves from the baseline to the candidate:',
    ...movesTable(scoreMoves(baseline.slice(0, 2), candidate.slice(0, 2), THRESHOLDS)),
  ];
  const tail = [
    'Cases with none to show: their requests were the same in both runs, so what moved is noise:',
    ...movesTable(scoreMoves([baseline[2]!], [candidate[2]!], THRESHOLDS)),
  ];
  const [code, lines] = await run(['score-compare', a, b]);
  assert.equal(code, 0);
  assert.deepEqual(lines, [...head, ...tail]);
  // the numbers are not all the same in both runs: the test compares something
  assert.notEqual(numbers[4], numbers[5]);
  assert.equal(lines.includes('| 70 | 0 | 0 | 0 | 0 | 0 | 0 |'), false);
  const noise = [
    'Noise: moves from the baseline to the second baseline on the cases shown memory:',
    ...movesTable(scoreMoves(baseline.slice(0, 2), noiseRun.slice(0, 2), THRESHOLDS)),
  ];
  const [withCode, withNoise] = await run(['score-compare', a, b, '--noise', n]);
  assert.equal(withCode, 0);
  assert.deepEqual(withNoise, [...head, ...noise, ...tail]);
});

test('score-compare compares only the cases both runs hold, and says how many are in one only', async () => {
  const a = compareDir('only-base', [...baseline, k(A, 'k5')], [...baseRows, { key: 'k5', status: 'ok', calls: 1 }]);
  const failedK2 = candidate.map((c) => (c.key === 'k2' ? { ...c, status: 'failed' as const, scores: [] } : c));
  const rows = candRows.map((r) => (r.key === 'k2' ? { ...r, status: 'failed' as const, memory: null } : r));
  const b = compareDir('only-cand', [...failedK2, k(B, 'k6')], [...rows, { key: 'k6', status: 'ok', calls: 1, memory: shown }], WITH_MEMORY);
  const [code, lines] = await run(['score-compare', a, b]);
  assert.equal(code, 0);
  assert.equal(lines[0], 'compared: 3 cases that both runs hold with the status ok; in one run only: 2; in both runs but not ok in one: 1');
  assert.equal(lines[1], 'shown memory: 1; none to show: 1; other: 1; of the cases shown memory, with another number of model calls: 0');
  const own = lines.find((l) => l.startsWith('| own | baseline |'))!;
  const m = measure([k(A, 'k1')], 'own');
  assert.equal(own.split(' | ')[2], cellOf(m.safety_blocks, m.safety_blocks_n));
});

test('score-compare refuses different history files, contracts and scorers', async () => {
  const a = compareDir('ref-base', baseline, baseRows);
  const cases: [string, Record<string, unknown>, string][] = [
    ['ref-history', { history_sha256: '0'.repeat(64) }, 'different_history_files'],
    ['ref-contract', { contract_sha256: '0'.repeat(64) }, 'different_contracts'],
    ['ref-scorer', { scorer: 'vendor/decider' }, 'different_scorers'],
  ];
  for (const [name, extra, message] of cases) {
    const [code, lines] = await run(['score-compare', a, compareDir(name, candidate, candRows, { ...WITH_MEMORY, ...extra })]);
    assert.equal(code, 1, name);
    assert.deepEqual(lines, [message], name);
  }
  const [warned, warning] = await run(['score-compare', a, compareDir('ref-models', candidate, candRows, { ...WITH_MEMORY, models: ['m', 'fallback-m'] })]);
  assert.equal(warned, 0);
  // the counts of the cases compared come first, then the warning
  assert.match(warning[0]!, /^compared: 4 cases /);
  assert.equal(warning[1], 'warning: the runs were answered by different models: m; m, fallback-m');
  assert.match(warning[2]!, /^shown memory: /);
  for (const argv of [['score-compare'], ['score-compare', a], ['score-compare', a, a, a], ['score-compare', a, join(dir, 'nowhere')]]) {
    const [code, lines] = await run(argv);
    assert.equal(code, 2, argv.join(' '));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^usage: /);
  }
});

test('score-noise refuses a run with memory against one without, and two runs with different memory files', async () => {
  const sha = 'c'.repeat(64);
  const memoryA = { memory_file: '/elsewhere/a.jsonl', memory_sha256: '1'.repeat(64) };
  const memoryB = { memory_file: '/elsewhere/b.jsonl', memory_sha256: '2'.repeat(64) };
  for (const [x, y] of [[{}, memoryA], [memoryA, {}], [memoryA, memoryB]]) {
    const [code, lines] = await run(['score-noise', runDir(`mem-${Math.random().toString(16).slice(2)}`, sha, '', x), runDir(`mem-${Math.random().toString(16).slice(2)}`, sha, '', y)]);
    assert.equal(code, 1);
    assert.deepEqual(lines, ['different_memory']);
  }
  const [code, lines] = await run(['score-noise', runDir('mem-same-1', sha, '', memoryA), runDir('mem-same-2', sha, '', memoryA)]);
  assert.equal(code, 0);
  assert.equal(lines.length, 6);
});

test('seed-memory needs --history and --config, a database in the config, and a history file outside the project', async () => {
  const folder = mkdtempSync(tmpdir() + '/');
  const history = join(folder, 'history.jsonl');
  writeFileSync(history, serializeCase(historyCase(7, '2026-03-05T12:00:00Z')) + '\n');
  const withDatabase = join(folder, 'deployment.yml');
  writeFileSync(withDatabase, 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\ndatabase:\n  url: { env: DATABASE_URL }\n');
  const withoutDatabase = join(folder, 'no-database.yml');
  writeFileSync(withoutDatabase, 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n');
  // No token of the git service in the environment; a database that is never reached, since every case ends before it is opened.
  const env = { MODEL_KEY: 'k', DATABASE_URL: 'postgres://seed@db.invalid:5432/visto' };
  const args = (over: Record<string, string> = {}, drop: string[] = []): string[] => {
    const options: Record<string, string> = { history, config: withDatabase, ...over };
    for (const name of drop) delete options[name];
    return ['seed-memory', ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v])];
  };
  const bad: [string, string[], Record<string, string>, string][] = [
    ['no arguments', ['seed-memory'], env, 'usage: seed-memory needs --history'],
    ['missing config', args({}, ['config']), env, 'usage: seed-memory needs --config'],
    ['history inside the project', args({ history: join(projectRoot, 'h.jsonl') }), env, 'usage: --history must be outside the project folder'],
    ['no database in the config', args({ config: withoutDatabase }), env, 'usage: seed-memory needs a database in the config'],
    ['config that does not exist', args({ config: join(folder, 'none.yml') }), env, 'usage: cannot read --config'],
    ['history that does not exist', args({ history: join(folder, 'none.jsonl') }), env, 'usage: cannot read --history'],
    ['positional argument', [...args(), 'extra'], env, 'usage: seed-memory takes no positional arguments'],
    ['unknown option', [...args(), '--force'], env, 'usage: unknown option --force'],
  ];
  for (const [name, argv, environment, message] of bad) {
    const [code, lines] = await run(argv, environment);
    assert.equal(code, 2, name);
    assert.deepEqual(lines, [message], name);
  }
  // The variable the database block names must be set, and the message never quotes its value.
  const [code, lines] = await run(args(), { MODEL_KEY: 'k' });
  assert.deepEqual([code, lines], [2, ['config: database.url: environment variable DATABASE_URL is not set']]);
});

test('the script eval:seed-memory runs the command seed-memory', () => {
  const scripts = (JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts['eval:seed-memory'], 'node src/eval/cli.ts seed-memory');
});

test('export-findings needs --config and --out, a database in the config, and an out path outside the project', async () => {
  const folder = mkdtempSync(tmpdir() + '/');
  const withDatabase = join(folder, 'deployment.yml');
  writeFileSync(withDatabase, 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\ndatabase:\n  url: { env: DATABASE_URL }\n');
  const withoutDatabase = join(folder, 'no-database.yml');
  writeFileSync(withoutDatabase, 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n');
  const env = { MODEL_KEY: 'k', DATABASE_URL: 'postgres://export@db.invalid:5432/visto' };
  const args = (over: Record<string, string> = {}, drop: string[] = []): string[] => {
    const options: Record<string, string> = { config: withDatabase, out: join(folder, 'findings.jsonl'), ...over };
    for (const name of drop) delete options[name];
    return ['export-findings', ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v])];
  };
  const bad: [string, string[], string][] = [
    ['no arguments', ['export-findings'], 'usage: export-findings needs --config'],
    ['missing out', args({}, ['out']), 'usage: export-findings needs --out'],
    ['out inside the project', args({ out: join(projectRoot, 'findings.jsonl') }), 'usage: --out must be outside the project folder'],
    ['no database in the config', args({ config: withoutDatabase }), 'usage: export-findings needs a database in the config'],
    ['config that does not exist', args({ config: join(folder, 'none.yml') }), 'usage: cannot read --config'],
    ['positional argument', [...args(), 'extra'], 'usage: export-findings takes no positional arguments'],
    ['unknown option', [...args(), '--history', 'x'], 'usage: unknown option --history'],
  ];
  for (const [name, argv, message] of bad) {
    const [code, lines] = await run(argv, env);
    assert.equal(code, 2, name);
    assert.deepEqual(lines, [message], name);
  }
});

test('the script eval:export-findings runs the command export-findings', () => {
  const scripts = (JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts['eval:export-findings'], 'node src/eval/cli.ts export-findings');
});

test('score-compare prints the count of focus and no step for it', async () => {
  const a = compareDir('focus-base', baseline, baseRows);
  const b = compareDir('focus-cand', candidate, candRows, WITH_MEMORY);
  const [code, lines] = await run(['score-compare', a, b]);
  assert.equal(code, 0);
  const m = measure(baseline.slice(0, 2), 70);
  const row = lines.find((l) => l.startsWith('| 70 | baseline |'))!;
  assert.equal(row.split(' | ').at(-1), `${focusOf(m.focus, m.focus_n)} |`);
  assert.equal(row.includes(`${m.focus} (n=${m.focus_n}, step`), false);
  assert.equal(row.split(' | ')[6], cellOf(m.benefit, m.benefit_n));
});

test('score-compare refuses a candidate run without memory and a baseline run with it, before any table', async () => {
  const plain = compareDir('dir-plain', baseline, baseRows);
  const plain2 = compareDir('dir-plain-2', candidate, candRows);
  const withMemory = compareDir('dir-memory', baseline, baseRows, WITH_MEMORY);
  const withMemory2 = compareDir('dir-memory-2', candidate, candRows, WITH_MEMORY);
  const cases: [string, string, string, string][] = [
    ['neither has memory', plain, plain2, 'candidate_without_memory'],
    ['given the wrong way round', withMemory, plain2, 'candidate_without_memory'],
    ['both have memory', withMemory, withMemory2, 'baseline_with_memory'],
  ];
  for (const [name, x, y, message] of cases) {
    const [code, lines] = await run(['score-compare', x, y]);
    assert.equal(code, 1, name);
    assert.deepEqual(lines, [message], name);
  }
});

test('backtest without --memory hands no memory, from the command line to the files it writes', async () => {
  const folder = mkdtempSync(tmpdir() + '/');
  const history = join(folder, 'history.jsonl');
  const lead = { kind: 'inline' as const, id: 'm1', author: 'octo-lead', bot: false, association: 'member' as const, at: '2026-03-01T10:00:00Z', body: 'x', commit: 'head10000000', path: TAX, side: 'RIGHT' as const, line: 2 };
  // The second case would be shown the first's comment if the history file were made its memory.
  writeFileSync(history, [historyCase(1, '2026-03-01T12:00:00Z', [lead]), historyCase(2, '2026-03-05T12:00:00Z')].map(serializeCase).join('\n') + '\n');
  const config = join(folder, 'config.yml');
  writeFileSync(config, 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n');
  const out = join(folder, 'out');
  // The suite blocks the network: every case fails at the git service, and the rows and the summary are still written.
  const [code, lines] = await run(['backtest', '--history', history, '--out', out, '--label', 'plain', '--config', config], { GITHUB_TOKEN: 't', MODEL_KEY: 'k' });
  assert.equal(code, 0);
  assert.equal(lines[0], 'cases 2, failed 2, not started 0, total_cost 0');
  const rows = readFileSync(join(out, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal('memory' in row, false);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(summary).filter((key) => key.startsWith('memory')), []);
  assert.equal(readFileSync(join(out, 'summary.md'), 'utf8').includes('Memory:'), false);
});

test('memory-count reads no config: one that is not valid YAML in its working folder changes nothing', async () => {
  const folder = mkdtempSync(tmpdir() + '/');
  const history = join(folder, 'history.jsonl');
  writeFileSync(history, [historyCase(1, '2026-03-01T12:00:00Z'), historyCase(2, '2026-03-05T12:00:00Z')].map(serializeCase).join('\n') + '\n');
  writeFileSync(join(folder, 'config.yml'), 'model: [unclosed\n  : : :\n');
  const before = process.cwd();
  process.chdir(folder);
  try {
    const [code, lines] = await run(['memory-count', '--history', history, '--memory', history], {});
    assert.equal(code, 0);
    assert.equal(lines[0], 'cases 2, with a line 0, with a labelled file that got a line 0');
    assert.equal(lines.length, 4);
  } finally {
    process.chdir(before);
  }
});

test('memory-count prints the reverts after its rows, and one line for each case shown a reverted line', async () => {
  const folder = mkdtempSync(tmpdir() + '/');
  const history = join(folder, 'history.jsonl');
  const reverted = historyCase(7, '2026-03-05T12:00:00Z');
  const revert: HistoryCase = { ...historyCase(9, '2026-03-10T12:00:00Z'), body: 'Reverts acme/shop#7', final_files: [{ path: 'src/cart/undo.ts', previous_path: null, status: 'modified', patch: null }] };
  const after = historyCase(8, '2026-03-11T12:00:00Z');
  writeFileSync(history, [reverted, revert, after].map(serializeCase).join('\n') + '\n');
  const before = readdirSync(folder).sort();
  const [code, lines] = await run(['memory-count', '--history', history, '--memory', history], {});
  assert.equal(code, 0);
  assert.deepEqual(lines.slice(-2), [
    'reverts named 1, with their pull request in the file 1, cases shown a reverted line 1',
    'acme/shop#8@head80000000: reverted lines 1',
  ]);
  assert.deepEqual(readdirSync(folder).sort(), before);
});

test('memory-count prints the reverts the file names and those it holds each in its place, and its old numbers count no reverted line', async () => {
  const folder = mkdtempSync(tmpdir() + '/');
  const history = join(folder, 'history.jsonl');
  const undo = (pr: number, mergedAt: string, body: string): HistoryCase =>
    ({ ...historyCase(pr, mergedAt), body, final_files: [{ path: `src/cart/undo${pr}.ts`, previous_path: null, status: 'modified', patch: null }] });
  const lead = { kind: 'inline' as const, id: 'm8', author: 'octo-lead', bot: false, association: 'member' as const, at: '2026-03-11T10:00:00Z', body: 'x', commit: 'head80000000', path: TAX, side: 'RIGHT' as const, line: 2 };
  // 9 reverts 7, which the file holds; 12 names 99, which it does not; 8 changes the file 7 changed, and a member commented on it.
  const cases = [historyCase(7, '2026-03-05T12:00:00Z'), undo(9, '2026-03-10T12:00:00Z', 'Reverts acme/shop#7'), historyCase(8, '2026-03-12T12:00:00Z', [lead]), undo(12, '2026-03-09T12:00:00Z', 'Reverts acme/shop#99')];
  writeFileSync(history, cases.map(serializeCase).join('\n') + '\n');
  const [code, lines] = await run(['memory-count', '--history', history, '--memory', history], {});
  assert.equal(code, 0);
  assert.equal(lines[0], 'cases 4, with a line 0, with a labelled file that got a line 0');
  assert.equal(lines[3], 'acme/shop#8@head80000000: records 0, lines 0, changed 0, near 0, labelled files 1, labelled with a line 0');
  assert.deepEqual(lines.slice(-2), [
    'reverts named 2, with their pull request in the file 1, cases shown a reverted line 1',
    'acme/shop#8@head80000000: reverted lines 1',
  ]);
});

test('memory-count prints the number of cases shown a reverted line, not the number of reverts it holds', async () => {
  const folder = mkdtempSync(tmpdir() + '/');
  const history = join(folder, 'history.jsonl');
  // One revert held, of the file 7 changed, which 8 and 10 change after it: two cases are shown its line.
  const revert: HistoryCase = { ...historyCase(9, '2026-03-10T12:00:00Z'), body: 'Reverts acme/shop#7', final_files: [{ path: 'src/cart/undo.ts', previous_path: null, status: 'modified', patch: null }] };
  const cases = [historyCase(7, '2026-03-05T12:00:00Z'), revert, historyCase(8, '2026-03-11T12:00:00Z'), historyCase(10, '2026-03-12T12:00:00Z')];
  writeFileSync(history, cases.map(serializeCase).join('\n') + '\n');
  const [code, lines] = await run(['memory-count', '--history', history, '--memory', history], {});
  assert.equal(code, 0);
  assert.deepEqual(lines.slice(-3), [
    'reverts named 1, with their pull request in the file 1, cases shown a reverted line 2',
    'acme/shop#8@head80000000: reverted lines 1',
    'acme/shop#10@head10000000: reverted lines 1',
  ]);
});

function aacrArgs(over: Record<string, string> = {}, drop: string[] = []): string[] {
  const options: Record<string, string> = {
    input: join(dir, 'aacr.json'), 'cases-out': join(dir, 'aacr-cases.jsonl'), 'history-out': join(dir, 'aacr-history.jsonl'), ...over,
  };
  for (const name of drop) delete options[name];
  return ['import-aacr', ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v])];
}

test('import-aacr needs --input', async () => {
  const [code, lines] = await run(aacrArgs({}, ['input']));
  assert.equal(code, 2);
  assert.deepEqual(lines, ['usage: import-aacr needs --input']);
});

test('import-aacr refuses a file inside the project folder', async () => {
  for (const name of ['input', 'cases-out', 'history-out']) {
    const [code, lines] = await run(aacrArgs({ [name]: join(projectRoot, 'x.json') }));
    assert.equal(code, 2, name);
    assert.deepEqual(lines, [`usage: --${name} must be outside the project folder`], name);
  }
});

test('import-aacr refuses two paths that are the same file, and keeps the input', async () => {
  const input = join(dir, 'aacr-same.json');
  writeFileSync(input, '[]');
  const cases: Record<string, string>[] = [{ 'cases-out': input }, { 'history-out': input }, { 'history-out': join(dir, 'aacr-cases.jsonl') }];
  for (const over of cases) {
    const [code, lines] = await run(aacrArgs({ input, ...over }));
    assert.equal(code, 2);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^usage: /);
    assert.equal(readFileSync(input, 'utf8'), '[]');
  }
});

test('import-aacr needs GITHUB_TOKEN', async () => {
  for (const env of [{}, { GITHUB_TOKEN: '' }]) {
    const [code, lines] = await run(aacrArgs(), env);
    assert.equal(code, 2);
    assert.deepEqual(lines, ['usage: GITHUB_TOKEN is not set']);
  }
});

test('import-aacr reports an input that is not a list, with a short code', async () => {
  writeFileSync(join(dir, 'aacr-bad.json'), '{"a":1}');
  const [code, lines] = await run(aacrArgs({ input: join(dir, 'aacr-bad.json') }));
  assert.equal(code, 1);
  assert.deepEqual(lines, ['bad_aacr_file']);
});

test('import-aacr reports an input that cannot be read', async () => {
  const [code, lines] = await run(aacrArgs({ input: join(dir, 'aacr-missing.json') }));
  assert.equal(code, 2);
  assert.deepEqual(lines, ['usage: cannot read --input']);
});

test('replay accepts --plain, and backtest does not', () => {
  const folder = mkdtempSync(tmpdir() + '/');
  const config = join(folder, 'config.yml');
  writeFileSync(config, 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n');
  const env = { GITHUB_TOKEN: 't', MODEL_KEY: 'k' };
  const argv = ['--cases', join(folder, 'cases.yml'), '--out', join(folder, 'out'), '--label', 'one', '--config', config];
  assert.equal(prepareRun('replay', 'cases', argv, env, [], ['plain']).flags.has('plain'), false);
  assert.equal(prepareRun('replay', 'cases', [...argv, '--plain'], env, [], ['plain']).flags.has('plain'), true);
  assert.throws(() => prepareRun('replay', 'cases', [...argv, '--plain'], env), /unknown option --plain/);
});

function judgeArgs(over: Record<string, string> = {}, drop: string[] = []): string[] {
  const options: Record<string, string> = { cases: join(dir, 'judge-cases.jsonl'), run: join(dir, 'judge-run'), config: join(dir, 'judge-config.yml'), ...over };
  for (const name of drop) delete options[name];
  return ['judge', ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v])];
}

test('judge needs --run', async () => {
  const [code, lines] = await run(judgeArgs({}, ['run']), {});
  assert.equal(code, 2);
  assert.deepEqual(lines, ['usage: judge needs --run']);
});

test('judge refuses a run folder inside the project folder', async () => {
  const [code, lines] = await run(judgeArgs({ run: join(projectRoot, 'run') }), {});
  assert.equal(code, 2);
  assert.deepEqual(lines, ['usage: --run must be outside the project folder']);
});

test('judge refuses a --with folder inside the project folder', async () => {
  const [code, lines] = await run([...judgeArgs(), '--with', join(projectRoot, 'other')], {});
  assert.equal(code, 2);
  assert.deepEqual(lines, ['usage: --with must be outside the project folder']);
});

test('judge refuses a case file inside the project folder, and needs no GITHUB_TOKEN', async () => {
  const [code, lines] = await run(judgeArgs({ cases: join(projectRoot, 'c.jsonl') }), {});
  assert.equal(code, 2);
  assert.deepEqual(lines, ['usage: --cases must be outside the project folder']);
});

test('judge prints judge_failed, and a stopped line when the cost cap ended it', async () => {
  const c = { repo: 'acme/shop', pr_number: 1, head_sha: 'a'.repeat(12), compare_base: 'b', title: 't', body: '', branch: '', base_branch: '', author: '',
    labels: [{ comment_id: 'c', path: 'a.ts', line: 5, side: 'RIGHT', severity: '', label: 'valid', text: 'ref', start_line: 4 }] };
  const runFolder = join(dir, 'judge-run-printed');
  mkdirSync(runFolder, { recursive: true });
  const row = (n: number): object => ({
    key: `acme/shop#${n}@${'a'.repeat(12)}`, status: 'ok', findings: [{ path: 'a.ts', line: 5, side: 'RIGHT', severity: 'minor', body: 'x' }],
  });
  const cases = [1, 2].map((n) => ({ ...c, pr_number: n }));
  writeFileSync(join(dir, 'judge-cases-printed.jsonl'), cases.map((x) => JSON.stringify(x) + '\n').join(''));
  writeFileSync(join(runFolder, 'results.jsonl'), [row(1), row(2)].map((r) => JSON.stringify(r) + '\n').join(''));
  writeFileSync(join(runFolder, 'summary.json'), JSON.stringify({ summary: { label: 'r' }, plain: false }));
  writeFileSync(join(dir, 'judge-config-printed.yml'), 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'no tool call' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 1 },
  }), { status: 200 })) as typeof fetch;
  try {
    const [code, lines] = await run(judgeArgs({ cases: join(dir, 'judge-cases-printed.jsonl'), run: runFolder, config: join(dir, 'judge-config-printed.yml'), 'max-cost': '1', concurrency: '1' }), { MODEL_KEY: 'k' });
    assert.equal(code, 0);
    assert.match(lines[0]!, /judge_failed 1,/);
    assert.equal(lines[1], 'stopped: max_cost, cases not judged 1');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('judge-replies needs --findings, --config and --out outside the project, a positive --max-cost and no GITHUB_TOKEN', async () => {
  const folder = mkdtempSync(tmpdir() + '/');
  const config = join(folder, 'deployment.yml');
  writeFileSync(config, 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n');
  const args = (over: Record<string, string> = {}, drop: string[] = []): string[] => {
    const options: Record<string, string> = { findings: join(folder, 'findings.jsonl'), config, out: join(folder, 'lessons'), ...over };
    for (const name of drop) delete options[name];
    return ['judge-replies', ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v])];
  };
  const bad: [string, string[], string][] = [
    ['no findings', args({}, ['findings']), 'usage: judge-replies needs --findings'],
    ['no config', args({}, ['config']), 'usage: judge-replies needs --config'],
    ['no out', args({}, ['out']), 'usage: judge-replies needs --out'],
    ['findings inside the project', args({ findings: join(projectRoot, 'findings.jsonl') }), 'usage: --findings must be outside the project folder'],
    ['out inside the project', args({ out: join(projectRoot, 'lessons') }), 'usage: --out must be outside the project folder'],
    ['max-cost zero', args({ 'max-cost': '0' }), 'usage: --max-cost must be a positive number'],
    ['config that does not exist', args({ config: join(folder, 'none.yml') }), 'usage: cannot read --config'],
    ['findings that does not exist', args(), 'usage: cannot read --findings'],
    ['positional argument', [...args(), 'extra'], 'usage: judge-replies takes no positional arguments'],
    ['unknown option', [...args(), '--history', 'x'], 'usage: unknown option --history'],
  ];
  for (const [name, argv, message] of bad) {
    const [code, lines] = await run(argv, { MODEL_KEY: 'k' });
    assert.equal(code, 2, name);
    assert.deepEqual(lines, [message], name);
  }
});

test('the script eval:judge-replies runs the command judge-replies', () => {
  const scripts = (JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts['eval:judge-replies'], 'node src/eval/cli.ts judge-replies');
});
