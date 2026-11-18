// The composition root: the only place real clients are built.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '../config/load.ts';
import type { DeploymentConfig } from '../config/load.ts';
import { createModelClient } from '../engine/model/client.ts';
import { createJevScorer } from '../engine/scorer/jev.ts';
import type { ReviewDeps } from '../engine/types.ts';
import { createGithubHistorySource } from '../forge/github/history-source.ts';
import { createGithubReadSource } from '../forge/github/read-source.ts';
import { compareSummaries } from './compare.ts';
import { loadCases } from './cases.ts';
import { THRESHOLDS } from './backtest/metrics.ts';
import type { CaseScores } from './backtest/metrics.ts';
import { scoreNoise } from './backtest/noise.ts';
import { readCaseScores, runBacktest } from './backtest/run.ts';
import type { BacktestSummary } from './backtest/run.ts';
import { loadHistory } from './history/file.ts';
import { runImport } from './history/import.ts';
import { assertOutsideProject, runReplay } from './replay.ts';
import type { SummaryFile } from './replay.ts';

class UsageError extends Error {}
const SHORT_CODE = /^[a-z][a-z0-9_]*$/;
const EM_DASH = '\u2014';
const IMPORT_OPTIONS = ['repo', 'since', 'until', 'out', 'max-prs'];

interface Parsed { options: Map<string, string>; flags: Set<string>; positional: string[] }

function parse(args: string[], valued: string[], flags: string[]): Parsed {
  const parsed: Parsed = { options: new Map(), flags: new Set(), positional: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) { parsed.positional.push(arg); continue; }
    const name = arg.slice(2);
    if (flags.includes(name)) parsed.flags.add(name);
    else if (valued.includes(name)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`usage: option --${name} needs a value`);
      parsed.options.set(name, value);
      i += 1;
    } else throw new UsageError(`usage: unknown option --${name}`);
  }
  return parsed;
}

function positive(parsed: Parsed, name: string, fallback: number): number {
  const raw = parsed.options.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n <= 0) throw new UsageError(`usage: --${name} must be a positive number`);
  return n;
}

function outsideProject(path: string, projectRoot: string, name: string): void {
  try { assertOutsideProject(path, projectRoot); } catch { throw new UsageError(`usage: --${name} must be outside the project folder`); }
}

interface RunSetup {
  inputPath: string; outDir: string; label: string; maxCases: number; maxCost: number; concurrency: number;
  config: DeploymentConfig; deps: ReviewDeps;
}

// What `replay` and `backtest` share: the same options, the same checks, and the same real clients.
function prepareRun(command: string, inputName: string, argv: string[], env: Record<string, string | undefined>): RunSetup {
  const parsed = parse(argv, [inputName, 'out', 'label', 'config', 'max-cases', 'max-cost', 'concurrency'], ['force']);
  if (parsed.positional.length > 0) throw new UsageError(`usage: ${command} takes no positional arguments`);
  const get = (name: string): string => {
    const v = parsed.options.get(name);
    if (v === undefined) throw new UsageError(`usage: ${command} needs --${name}`);
    return v;
  };
  const inputPath = get(inputName);
  const outDir = get('out');
  const label = get('label');
  const configPath = get('config');
  const maxCases = positive(parsed, 'max-cases', 60);
  const maxCost = positive(parsed, 'max-cost', 10);
  const concurrency = positive(parsed, 'concurrency', 2);
  if (![1, 2, 3].includes(concurrency)) throw new UsageError('usage: --concurrency must be 1, 2 or 3');
  const githubToken = env.GITHUB_TOKEN;
  if (githubToken === undefined || githubToken === '') throw new UsageError('usage: GITHUB_TOKEN is not set');
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  outsideProject(inputPath, projectRoot, inputName);
  outsideProject(outDir, projectRoot, 'out');
  if (!parsed.flags.has('force') && existsSync(outDir) && (safeList(outDir)?.length ?? 1) > 0) {
    throw new UsageError('usage: --out is not empty; use --force to reuse it');
  }

  const config = readable('config', () => loadConfig(configPath, env));
  const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });
  const deps: ReviewDeps = {
    source: createGithubReadSource({ token: githubToken, fetch: globalThis.fetch }),
    model: createModelClient(config.model, { fetch: globalThis.fetch, sleep }),
    contract: readFileSync(join(projectRoot, 'contract', 'review-contract.md'), 'utf8'),
    clock: () => new Date(),
    token: () => randomBytes(8).toString('hex'),
    log: (entry) => { process.stderr.write(JSON.stringify(entry) + '\n'); },
    ...(config.scorer === null ? {} : { scorer: createJevScorer(config.scorer, { fetch: globalThis.fetch, sleep }) }),
  };
  return { inputPath, outDir, label, maxCases, maxCost, concurrency, config, deps };
}

async function replay(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<void> {
  const setup = prepareRun('replay', 'cases', argv, env);
  const { cases, sha256 } = readable('cases', () => loadCases(setup.inputPath));
  const { inputPath, ...rest } = setup;
  const file = await runReplay({ ...rest, cases, casesFile: inputPath, casesSha256: sha256 });
  out(`cases ${file.summary.cases}, failed ${file.summary.failed_cases}, not started ${file.cases_not_started}, total_cost ${file.summary.total_cost}`);
  if (file.stopped_reason !== null) out(`stopped: ${file.stopped_reason}`);
}

async function backtest(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<void> {
  const setup = prepareRun('backtest', 'history', argv, env);
  const { cases, sha256 } = readable('history', () => loadHistory(setup.inputPath));
  const { inputPath, ...rest } = setup;
  const summary = await runBacktest({ ...rest, cases, historyFile: inputPath, historySha256: sha256 });
  out(`cases ${summary.cases}, failed ${summary.failed_cases}, not started ${summary.cases_not_started}, total_cost ${summary.total_cost}`);
  if (summary.stopped_reason !== null) out(`stopped: ${summary.stopped_reason}`);
}

function readRun(dir: string): { summary: BacktestSummary; scores: CaseScores[] } {
  const summary = readableAs('the run directory', () => JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as BacktestSummary);
  if (typeof summary !== 'object' || summary === null || typeof summary.history_sha256 !== 'string') throw new Error('bad_summary_file');
  return { summary, scores: readableAs('the run directory', () => readCaseScores(join(dir, 'scores.jsonl'))) };
}

function scoreNoiseCommand(argv: string[], out: (line: string) => void): void {
  const parsed = parse(argv, [], []);
  if (parsed.positional.length !== 2) throw new UsageError('usage: score-noise <run dir> <run dir>');
  const first = readRun(parsed.positional[0]!);
  const second = readRun(parsed.positional[1]!);
  if (first.summary.history_sha256 !== second.summary.history_sha256) throw new Error('different_history_files');
  if (first.summary.contract_sha256 !== second.summary.contract_sha256) throw new Error('different_contracts');
  if ((first.summary.scorer ?? null) !== (second.summary.scorer ?? null)) throw new Error('different_scorers');
  const models = (s: BacktestSummary): string => (Array.isArray(s.models) ? s.models.join(', ') : '');
  if (models(first.summary) !== models(second.summary)) {
    out(`warning: the runs were answered by different models: ${models(first.summary)}; ${models(second.summary)}`);
  }
  const rows = scoreNoise(first.scores, second.scores, THRESHOLDS);
  const share = (value: number | null): string => (value === null ? EM_DASH : String(value));
  out('| threshold | blocks_flipped | blocks_n | prs_flipped | prs_n |');
  out('| --- | --- | --- | --- | --- |');
  for (const r of rows) out(`| ${r.threshold} | ${share(r.blocks_flipped)} | ${r.blocks_n} | ${share(r.prs_flipped)} | ${r.prs_n} |`);
}

// A file that cannot be read is a usage error; one that is read but invalid is not.
function readable<T>(name: string, load: () => T): T {
  return readableAs(`--${name}`, load);
}

function readableAs<T>(what: string, load: () => T): T {
  try {
    return load();
  } catch (error) {
    const fileError = error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string' && typeof (error as NodeJS.ErrnoException).syscall === 'string';
    if (fileError) throw new UsageError(`usage: cannot read ${what}`);
    throw error;
  }
}

function safeList(path: string): string[] | null {
  try { return readdirSync(path); } catch { return null; }
}

function readSummary(path: string): SummaryFile {
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof data !== 'object' || data === null || typeof (data as { summary?: unknown }).summary !== 'object' || (data as { summary: unknown }).summary === null) {
    throw new Error('bad_summary_file');
  }
  return data as SummaryFile;
}

// YYYY-MM-DD that is a real calendar date: 2026-02-30 does not round-trip.
function isoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isNonEmptyFile(path: string): boolean {
  try { return statSync(path).size > 0; } catch { return false; }
}

async function importHistory(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<void> {
  const parsed = parse(argv, IMPORT_OPTIONS, ['force']);
  if (parsed.positional.length > 0) throw new UsageError('usage: import-history takes no positional arguments');
  const get = (name: string): string => {
    const v = parsed.options.get(name);
    if (v === undefined) throw new UsageError(`usage: import-history needs --${name}`);
    return v;
  };
  const since = get('since');
  const until = get('until');
  if (!isoDate(since)) throw new UsageError('usage: --since must be a date as YYYY-MM-DD');
  if (!isoDate(until)) throw new UsageError('usage: --until must be a date as YYYY-MM-DD');
  if (since >= until) throw new UsageError('usage: --since must be before --until');
  const repoName = get('repo');
  const repoMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repoName);
  if (repoMatch === null) throw new UsageError('usage: --repo must be <owner/name>');
  const outFile = get('out');
  const maxPrs = positive(parsed, 'max-prs', 200);
  if (!Number.isInteger(maxPrs)) throw new UsageError('usage: --max-prs must be a whole number');
  const githubToken = env.GITHUB_TOKEN;
  if (githubToken === undefined || githubToken === '') throw new UsageError('usage: GITHUB_TOKEN is not set');
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  outsideProject(outFile, projectRoot, 'out');
  if (isDirectory(outFile)) throw new UsageError('usage: --out must be a file');
  if (!parsed.flags.has('force') && isNonEmptyFile(outFile)) throw new UsageError('usage: --out is not empty; use --force to overwrite it');

  const source = createGithubHistorySource({ token: githubToken, fetch: globalThis.fetch });
  await runImport({ repo: { owner: repoMatch[1]!, repo: repoMatch[2]! }, since, until, maxPrs, outFile }, source, out);
}

function compare(argv: string[], out: (line: string) => void): void {
  const parsed = parse(argv, ['noise'], []);
  if (parsed.positional.length !== 2) throw new UsageError('usage: compare <baseline summary.json> <candidate summary.json> [--noise <second baseline summary.json>]');
  const noisePath = parsed.options.get('noise');
  const table = compareSummaries(readSummary(parsed.positional[0]!), readSummary(parsed.positional[1]!), noisePath === undefined ? null : readSummary(noisePath));
  for (const line of table.split('\n')) out(line);
}

export async function main(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === 'replay') await replay(rest, env, out);
    else if (command === 'compare') compare(rest, out);
    else if (command === 'backtest') await backtest(rest, env, out);
    else if (command === 'score-noise') scoreNoiseCommand(rest, out);
    else if (command === 'import-history') await importHistory(rest, env, out);
    else throw new UsageError('usage: cli <replay|compare|import-history|backtest|score-noise> ...');
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { out(error.message); return 2; }
    // Issues name keys and variables, never values.
    if (error instanceof ConfigError) { for (const issue of error.issues) out(`config: ${issue}`); return 2; }
    out(error instanceof Error && SHORT_CODE.test(error.message) ? error.message : `unexpected_error ${error instanceof Error ? error.name : 'unknown'}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env, (line) => { process.stdout.write(line + '\n'); });
}
