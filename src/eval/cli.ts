// The composition root: the only place real clients are built.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, contractFile, loadConfig } from '../config/load.ts';
import type { DeploymentConfig } from '../config/load.ts';
import { postgresDb } from '../db/postgres.ts';
import { createModelClient } from '../engine/model/client.ts';
import { createJevScorer } from '../engine/scorer/jev.ts';
import type { ReviewDeps } from '../engine/types.ts';
import { createGithubHistorySource } from '../forge/github/history-source.ts';
import { createGithubReadSource } from '../forge/github/read-source.ts';
import { parseAacr, runAacrImport } from './aacr/convert.ts';
import { compareSummaries } from './compare.ts';
import { caseKey, loadCases } from './cases.ts';
import { historyMemory, memoryCount } from './backtest/memory.ts';
import { THRESHOLDS, measure, share as shareOf } from './backtest/metrics.ts';
import type { CaseScores } from './backtest/metrics.ts';
import { scoreMoves, scoreNoise } from './backtest/noise.ts';
import type { MoveRow } from './backtest/noise.ts';
import { readCaseScores, runBacktest } from './backtest/run.ts';
import type { BacktestSummary } from './backtest/run.ts';
import { runJudge } from './judge/run.ts';
import { loadHistory } from './history/file.ts';
import { runImport } from './history/import.ts';
import { seedCommand } from './history/seed.ts';
import { lessonCases } from './lessons/cases.ts';
import { exportCommand } from './lessons/export.ts';
import { loadFindings } from './lessons/findings.ts';
import { judgeReplies } from './lessons/judge-replies.ts';
import { loadLessons } from './lessons/lessons-file.ts';
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
  options: Record<string, string>; // the values given of the command's own options
  flags: Set<string>;              // the command's own flags that were given
}

// What `replay` and `backtest` share: the same options, the same checks, and the same real clients.
// `own`: the options with a value that the command takes beside the shared ones; `ownFlags`: its flags.
export function prepareRun(command: string, inputName: string, argv: string[], env: Record<string, string | undefined>, own: string[] = [], ownFlags: string[] = []): RunSetup {
  const parsed = parse(argv, [inputName, 'out', 'label', 'config', 'max-cases', 'max-cost', 'concurrency', ...own], ['force', ...ownFlags]);
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
    contract: readFileSync(join(projectRoot, 'contract', contractFile(config)), 'utf8'),
    clock: () => new Date(),
    token: () => randomBytes(8).toString('hex'),
    log: (entry) => { process.stderr.write(JSON.stringify(entry) + '\n'); },
    ...(config.scorer === null ? {} : { scorer: createJevScorer(config.scorer, { fetch: globalThis.fetch, sleep }) }),
    ...(config.model.toolChoice === 'auto' ? { toolChoice: 'auto' as const } : {}),
  };
  const options: Record<string, string> = {};
  for (const name of own) {
    const value = parsed.options.get(name);
    if (value !== undefined) options[name] = value;
  }
  return { inputPath, outDir, label, maxCases, maxCost, concurrency, config, deps, options, flags: parsed.flags };
}

const projectFolder = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function replay(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<void> {
  const setup = prepareRun('replay', 'cases', argv, env, ['lessons'], ['plain']);
  const lessonsPath = setup.options.lessons;
  if (lessonsPath !== undefined) {
    outsideProject(lessonsPath, projectFolder(), 'lessons');
    if (setup.flags.has('plain')) throw new UsageError('usage: --lessons cannot be used with --plain');
  }
  const { cases, sha256 } = readable('cases', () => loadCases(setup.inputPath));
  const lessonsFile = lessonsPath === undefined ? undefined : readable('lessons', () => loadLessons(lessonsPath));
  const { inputPath, outDir, label, maxCases, maxCost, concurrency, config, deps } = setup;
  const lessons = lessonsPath === undefined || lessonsFile === undefined ? {} : { lessons: { file: lessonsFile.file, path: lessonsPath, sha256: lessonsFile.sha256 } };
  const file = await runReplay({ outDir, label, maxCases, maxCost, concurrency, config, deps, cases, casesFile: inputPath, casesSha256: sha256, plain: setup.flags.has('plain'), ...lessons });
  out(`cases ${file.summary.cases}, failed ${file.summary.failed_cases}, not started ${file.cases_not_started}, total_cost ${file.summary.total_cost}`);
  if (file.stopped_reason !== null) out(`stopped: ${file.stopped_reason}`);
}

async function backtest(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<void> {
  const setup = prepareRun('backtest', 'history', argv, env, ['memory']);
  const memoryPath = setup.options.memory;
  if (memoryPath !== undefined) {
    outsideProject(memoryPath, projectFolder(), 'memory');
    // With a scorer memory is not asked: every case would be skipped (call 4).
    if (setup.config.scorer !== null) throw new UsageError('usage: --memory cannot be used with a scorer in the config');
  }
  const { cases, sha256 } = readable('history', () => loadHistory(setup.inputPath));
  const memoryFile = memoryPath === undefined ? undefined : readable('memory', () => loadHistory(memoryPath));
  const { inputPath, outDir, label, maxCases, maxCost, concurrency, config, deps } = setup;
  const memory = memoryPath === undefined || memoryFile === undefined
    ? {}
    : { memory: { of: historyMemory(memoryFile.cases).of, file: memoryPath, sha256: memoryFile.sha256 } };
  const summary = await runBacktest({ outDir, label, maxCases, maxCost, concurrency, config, deps, cases, historyFile: inputPath, historySha256: sha256, ...memory });
  out(`cases ${summary.cases}, failed ${summary.failed_cases}, not started ${summary.cases_not_started}, total_cost ${summary.total_cost}`);
  if (summary.stopped_reason !== null) out(`stopped: ${summary.stopped_reason}`);
}

function readRun(dir: string): { summary: BacktestSummary; scores: CaseScores[] } {
  const summary = readableAs('the run directory', () => JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as BacktestSummary);
  if (typeof summary !== 'object' || summary === null || typeof summary.history_sha256 !== 'string') throw new Error('bad_summary_file');
  return { summary, scores: readableAs('the run directory', () => readCaseScores(join(dir, 'scores.jsonl'))) };
}

interface RunRow { key: string; status: string; calls: number; memory: string | null }

// A run's results.jsonl: the key, the status, the model calls and the memory status of each case.
function readRows(dir: string): RunRow[] {
  const text = readableAs('the run directory', () => readFileSync(join(dir, 'results.jsonl'), 'utf8'));
  const rows: RunRow[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    let data: unknown;
    try { data = JSON.parse(line); } catch { throw new Error(`bad_results_line_${index + 1}`); }
    const row = data as { key?: unknown; status?: unknown; calls?: unknown; memory?: unknown };
    if (typeof data !== 'object' || data === null || typeof row.key !== 'string' || typeof row.status !== 'string' || typeof row.calls !== 'number') {
      throw new Error(`bad_results_line_${index + 1}`);
    }
    const memory = typeof row.memory === 'object' && row.memory !== null && typeof (row.memory as { status?: unknown }).status === 'string'
      ? (row.memory as { status: string }).status : null;
    rows.push({ key: row.key, status: row.status, calls: row.calls, memory });
  });
  return rows;
}

const modelsOf = (s: BacktestSummary): string => (Array.isArray(s.models) ? s.models.join(', ') : '');

// The refusals two runs share before their scores are compared; returns the warning on their models, or null.
function sameRuns(first: BacktestSummary, second: BacktestSummary, memory: boolean): string | null {
  if (first.history_sha256 !== second.history_sha256) throw new Error('different_history_files');
  if (first.contract_sha256 !== second.contract_sha256) throw new Error('different_contracts');
  if ((first.scorer ?? null) !== (second.scorer ?? null)) throw new Error('different_scorers');
  // A run with memory against one without, or two built from different memory files, measure memory and not noise.
  if (memory && (first.memory_sha256 ?? null) !== (second.memory_sha256 ?? null)) throw new Error('different_memory');
  return modelsOf(first) === modelsOf(second) ? null : `warning: the runs were answered by different models: ${modelsOf(first)}; ${modelsOf(second)}`;
}

function scoreNoiseCommand(argv: string[], out: (line: string) => void): void {
  const parsed = parse(argv, [], []);
  if (parsed.positional.length !== 2) throw new UsageError('usage: score-noise <run dir> <run dir>');
  const first = readRun(parsed.positional[0]!);
  const second = readRun(parsed.positional[1]!);
  const warning = sameRuns(first.summary, second.summary, true);
  if (warning !== null) out(warning);
  const rows = scoreNoise(first.scores, second.scores, THRESHOLDS);
  const share = (value: number | null): string => (value === null ? EM_DASH : String(value));
  out('| threshold | blocks_flipped | blocks_n | prs_flipped | prs_n |');
  out('| --- | --- | --- | --- | --- |');
  for (const r of rows) out(`| ${r.threshold} | ${share(r.blocks_flipped)} | ${r.blocks_n} | ${share(r.prs_flipped)} | ${r.prs_n} |`);
}

const MOVES_HEADER = ['| threshold | blocks_raised | blocks_lowered | blocks_n | prs_raised | prs_lowered | prs_n |', '| --- | --- | --- | --- | --- | --- | --- |'];
const moveLines = (rows: MoveRow[]): string[] => [
  ...MOVES_HEADER,
  ...rows.map((r) => `| ${r.threshold} | ${r.blocks_raised} | ${r.blocks_lowered} | ${r.blocks_n} | ${r.prs_raised} | ${r.prs_lowered} | ${r.prs_n} |`),
];
const NUMBER_NAMES = ['safety_blocks', 'safety_blocks_loose', 'safety_files', 'safety_files_loose', 'benefit', 'focus'] as const;
const dash = (value: number | null): string => (value === null ? EM_DASH : String(value));
// A number with its count and its step: the smallest difference that count can show.
const counted = (value: number | null, n: number): string => `${dash(value)} (n=${n}, step ${dash(shareOf(1, n))})`;
// focus is a share of lines, and its count is of pull requests: a step from that count would mislead, so none is printed.
const cellOf = (name: typeof NUMBER_NAMES[number], value: number | null, n: number): string => (name === 'focus' ? `${dash(value)} (n=${n})` : counted(value, n));
const hasMemory = (s: BacktestSummary): boolean => typeof s.memory_sha256 === 'string';

const COMPARE_USAGE = 'usage: score-compare <baseline run dir> <candidate run dir> [--noise <second baseline run dir>]';

function scoreCompareCommand(argv: string[], out: (line: string) => void): void {
  const parsed = parse(argv, ['noise'], []);
  if (parsed.positional.length !== 2) throw new UsageError(COMPARE_USAGE);
  const base = readRun(parsed.positional[0]!);
  const cand = readRun(parsed.positional[1]!);
  const baseRows = readRows(parsed.positional[0]!);
  const candRows = readRows(parsed.positional[1]!);
  const noisePath = parsed.options.get('noise');
  const noise = noisePath === undefined ? null : readRun(noisePath);
  // The two runs differ in memory by design; the second baseline must be a run of the baseline's kind.
  const warnings = [sameRuns(base.summary, cand.summary, false), noise === null ? null : sameRuns(base.summary, noise.summary, true)];
  // The candidate is the run with memory, the baseline the one without; two runs with memory are compared by score-noise.
  if (!hasMemory(cand.summary)) throw new Error('candidate_without_memory');
  if (hasMemory(base.summary)) throw new Error('baseline_with_memory');

  const first = new Map(baseRows.map((r) => [r.key, r]));
  const second = new Map(candRows.map((r) => [r.key, r]));
  const both: RunRow[] = [];
  let oneOnly = 0;
  let notOk = 0;
  for (const [key, row] of first) {
    const other = second.get(key);
    if (other === undefined) { oneOnly += 1; continue; }
    if (row.status !== 'ok' || other.status !== 'ok') { notOk += 1; continue; }
    both.push(other);
  }
  for (const key of second.keys()) if (!first.has(key)) oneOnly += 1;
  const shown = new Set(both.filter((r) => r.memory === 'ok').map((r) => r.key));
  const empty = new Set(both.filter((r) => r.memory === 'empty').map((r) => r.key));
  const otherCount = both.length - shown.size - empty.size;
  const otherCalls = both.filter((r) => shown.has(r.key) && first.get(r.key)!.calls !== r.calls).length;
  const only = (scores: CaseScores[], keys: Set<string>): CaseScores[] => scores.filter((c) => keys.has(c.key));

  out(`compared: ${both.length} cases that both runs hold with the status ok; in one run only: ${oneOnly}; in both runs but not ok in one: ${notOk}`);
  for (const warning of warnings) if (warning !== null) out(warning);
  out(`shown memory: ${shown.size}; none to show: ${empty.size}; other: ${otherCount}; of the cases shown memory, with another number of model calls: ${otherCalls}`);
  out('Cases shown memory: the numbers of each run, each with its count n and its step, the smallest difference that count can show (focus, a share of lines, has its count of pull requests and no step):');
  out(`| threshold | run | ${NUMBER_NAMES.join(' | ')} |`);
  out(`| ${['threshold', 'run', ...NUMBER_NAMES].map(() => '---').join(' | ')} |`);
  for (const t of [...THRESHOLDS, 'own' as const]) {
    for (const [name, run] of [['baseline', base], ['candidate', cand]] as const) {
      const m = measure(only(run.scores, shown), t);
      out(`| ${t} | ${name} | ${NUMBER_NAMES.map((x) => cellOf(x, m[x], m[`${x}_n`])).join(' | ')} |`);
    }
  }
  out('Cases shown memory: moves from the baseline to the candidate:');
  for (const line of moveLines(scoreMoves(only(base.scores, shown), only(cand.scores, shown), THRESHOLDS))) out(line);
  if (noise !== null) {
    out('Noise: moves from the baseline to the second baseline on the cases shown memory:');
    for (const line of moveLines(scoreMoves(only(base.scores, shown), only(noise.scores, shown), THRESHOLDS))) out(line);
  }
  out('Cases with none to show: their requests were the same in both runs, so what moved is noise:');
  for (const line of moveLines(scoreMoves(only(base.scores, empty), only(cand.scores, empty), THRESHOLDS))) out(line);
}

async function memoryCountCommand(argv: string[], out: (line: string) => void): Promise<void> {
  const parsed = parse(argv, ['history', 'memory', 'max-cases'], []);
  if (parsed.positional.length > 0) throw new UsageError('usage: memory-count takes no positional arguments');
  const get = (name: string): string => {
    const v = parsed.options.get(name);
    if (v === undefined) throw new UsageError(`usage: memory-count needs --${name}`);
    return v;
  };
  const historyPath = get('history');
  const memoryPath = get('memory');
  const maxCases = positive(parsed, 'max-cases', Number.POSITIVE_INFINITY);
  outsideProject(historyPath, projectFolder(), 'history');
  outsideProject(memoryPath, projectFolder(), 'memory');
  const history = readable('history', () => loadHistory(historyPath));
  const memory = readable('memory', () => loadHistory(memoryPath));
  const count = await memoryCount(history.cases.slice(0, maxCases), historyMemory(memory.cases));
  out(`cases ${count.cases}, with a line ${count.with_lines}, with a labelled file that got a line ${count.with_labelled_line}`);
  for (const r of count.rows) {
    out(`${r.key}: records ${r.records}, lines ${r.lines}, changed ${r.changed}, near ${r.near}, labelled files ${r.labelled_files}, labelled with a line ${r.labelled_with_line}`);
  }
  out(`reverts named ${count.reverts.named}, with their pull request in the file ${count.reverts.held}, cases shown a reverted line ${count.reverts.cases}`);
  for (const r of count.reverts.rows) out(`${r.key}: reverted lines ${r.lines}`);
}

// The importer's database output (7.5, call 29): reads a history file, never the git service, and never migrates.
async function seedMemoryCommand(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<void> {
  const parsed = parse(argv, ['history', 'config'], []);
  if (parsed.positional.length > 0) throw new UsageError('usage: seed-memory takes no positional arguments');
  const get = (name: string): string => {
    const v = parsed.options.get(name);
    if (v === undefined) throw new UsageError(`usage: seed-memory needs --${name}`);
    return v;
  };
  const historyPath = get('history');
  const configPath = get('config');
  outsideProject(historyPath, projectFolder(), 'history');
  const config = readable('config', () => loadConfig(configPath, env));
  if (config.database === null) throw new UsageError('usage: seed-memory needs a database in the config');
  const { cases } = readable('history', () => loadHistory(historyPath));
  const db = postgresDb(config.database.url, (entry) => { process.stderr.write(JSON.stringify(entry) + '\n'); });
  try {
    out(await seedCommand(db, cases, new Date()));
    // The close after a failure is not tested in the suite, which opens no database here: the real run under Docker checks it.
  } finally {
    try {
      await db.close();
    } catch {
      // a close that fails changes nothing of what was written
    }
  }
}

// The operator's export: one read-only transaction against a deployment, one file outside the project, mode 600.
async function exportFindingsCommand(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<void> {
  const parsed = parse(argv, ['config', 'out'], ['force']);
  if (parsed.positional.length > 0) throw new UsageError('usage: export-findings takes no positional arguments');
  const get = (name: string): string => {
    const v = parsed.options.get(name);
    if (v === undefined) throw new UsageError(`usage: export-findings needs --${name}`);
    return v;
  };
  const configPath = get('config');
  const outPath = get('out');
  outsideProject(outPath, projectFolder(), 'out');
  const config = readable('config', () => loadConfig(configPath, env));
  if (config.database === null) throw new UsageError('usage: export-findings needs a database in the config');
  const db = postgresDb(config.database.url, (entry) => { process.stderr.write(JSON.stringify(entry) + '\n'); });
  try {
    out(await exportCommand(db, outPath, parsed.flags.has('force'), new Date()));
  } finally {
    try {
      await db.close();
    } catch {
      // a close that fails changes nothing of what was written
    }
  }
}

// Dated, labelled replay cases from a deployment's export, the judge's lessons file and a history file: no model, no network.
function lessonCasesCommand(argv: string[], out: (line: string) => void): void {
  const parsed = parse(argv, ['history', 'findings', 'lessons', 'out'], ['only-shown', 'force']);
  if (parsed.positional.length > 0) throw new UsageError('usage: lesson-cases takes no positional arguments');
  const get = (name: string): string => {
    const v = parsed.options.get(name);
    if (v === undefined) throw new UsageError(`usage: lesson-cases needs --${name}`);
    return v;
  };
  const historyPath = get('history');
  const findingsPath = get('findings');
  const lessonsPath = get('lessons');
  const outPath = get('out');
  for (const [name, path] of [['history', historyPath], ['findings', findingsPath], ['lessons', lessonsPath], ['out', outPath]] as const) outsideProject(path, projectFolder(), name);
  const force = parsed.flags.has('force');
  if (!force && existsSync(outPath)) throw new Error('out_exists');
  const history = readable('history', () => loadHistory(historyPath));
  const findings = readable('findings', () => loadFindings(findingsPath));
  const lessons = readable('lessons', () => loadLessons(lessonsPath));
  if (lessons.file.findings_sha256 !== findings.sha256) throw new Error('different_export');
  const found = lessonCases(history.cases, findings.file, lessons.file);
  const shown = new Set(found.rows.filter((r) => r.shown > 0).map((r) => r.key));
  const kept = parsed.flags.has('only-shown') ? found.cases.filter((c) => shown.has(caseKey(c))) : found.cases;
  try {
    writeFileSync(outPath, kept.map((c) => JSON.stringify(c) + '\n').join(''), { mode: 0o600, flag: force ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('out_exists');
    throw error;
  }
  chmodSync(outPath, 0o600);
  out(`cases ${found.cases.length}, labels valid ${found.labels.valid} invalid ${found.labels.invalid}, cases shown a lesson ${found.shown_cases}, invalid labels in them ${found.shown_invalid}, skipped not in history ${found.skipped.not_in_history}, no base ${found.skipped.no_base}, same head ${found.skipped.same_head}`);
  for (const r of found.rows) out(`${r.key}: lessons ${r.shown}, invalid ${r.invalid}, valid ${r.valid}`);
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

async function importAacr(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<void> {
  const parsed = parse(argv, ['input', 'cases-out', 'history-out'], []);
  if (parsed.positional.length > 0) throw new UsageError('usage: import-aacr takes no positional arguments');
  const get = (name: string): string => {
    const v = parsed.options.get(name);
    if (v === undefined) throw new UsageError(`usage: import-aacr needs --${name}`);
    return v;
  };
  const input = get('input');
  const casesOut = get('cases-out');
  const historyOut = get('history-out');
  const githubToken = env.GITHUB_TOKEN;
  if (githubToken === undefined || githubToken === '') throw new UsageError('usage: GITHUB_TOKEN is not set');
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  outsideProject(input, projectRoot, 'input');
  outsideProject(casesOut, projectRoot, 'cases-out');
  outsideProject(historyOut, projectRoot, 'history-out');
  for (const [name, path] of [['cases-out', casesOut], ['history-out', historyOut]] as const) {
    if (isDirectory(path)) throw new UsageError(`usage: --${name} must be a file`);
  }
  // Each output is emptied before the first write: the same path twice would destroy the input or one output.
  if (new Set([resolve(input), resolve(casesOut), resolve(historyOut)]).size < 3) throw new UsageError('usage: --input, --cases-out and --history-out must be three different files');
  const { records, skipped } = parseAacr(readable('input', () => readFileSync(input, 'utf8')));
  const source = createGithubHistorySource({ token: githubToken, fetch: globalThis.fetch });
  const result = await runAacrImport({ records, source, casesOut, historyOut });
  out(`records ${records.length}, written ${result.written}, bad_record ${skipped.bad_record}, bad_comment ${skipped.bad_comment}, duplicate ${skipped.duplicate}, `
    + `pr_unreadable ${result.skipped.pr_unreadable}, head_unreadable ${result.skipped.head_unreadable}, too_many_files ${result.skipped.too_many_files}`);
}

// Judges a replay run against the case file's reference comments; needs no GITHUB_TOKEN and writes into the run folder.
async function judgeCommand(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<void> {
  const parsed = parse(argv, ['cases', 'run', 'config', 'with', 'max-cost', 'concurrency'], []);
  if (parsed.positional.length > 0) throw new UsageError('usage: judge takes no positional arguments');
  const get = (name: string): string => {
    const v = parsed.options.get(name);
    if (v === undefined) throw new UsageError(`usage: judge needs --${name}`);
    return v;
  };
  const casesPath = get('cases');
  const runDir = get('run');
  const configPath = get('config');
  const withDir = parsed.options.get('with');
  const maxCost = positive(parsed, 'max-cost', 5);
  const concurrency = positive(parsed, 'concurrency', 2);
  if (![1, 2, 3].includes(concurrency)) throw new UsageError('usage: --concurrency must be 1, 2 or 3');
  const root = projectFolder();
  outsideProject(casesPath, root, 'cases');
  outsideProject(runDir, root, 'run');
  if (withDir !== undefined) outsideProject(withDir, root, 'with');

  const config = readable('config', () => loadConfig(configPath, env));
  const { cases, sha256 } = readable('cases', () => loadCases(casesPath));
  let keep: Set<string> | null = null;
  let withRunLabel: string | null = null;
  if (withDir !== undefined) {
    const okKeys = (dir: string): Set<string> => new Set(readRows(dir).filter((r) => r.status === 'ok').map((r) => r.key));
    const other = okKeys(withDir);
    keep = new Set([...okKeys(runDir)].filter((k) => other.has(k)));
    withRunLabel = readableAs('the --with run directory', () => readSummary(join(withDir, 'summary.json')).summary.label);
  }
  const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });
  const summary = await runJudge({
    cases, casesSha256: sha256, runDir, keep, withRunLabel, maxCost, concurrency,
    model: createModelClient(config.model, { fetch: globalThis.fetch, sleep }),
    auto: config.model.toolChoice === 'auto', timeoutMs: config.model.timeoutSeconds * 1000,
    token: () => randomBytes(8).toString('hex'),
  });
  out(`cases ${summary.cases}, failed ${summary.failed_cases}, findings ${summary.findings}, references ${summary.references}, `
    + `precision ${dash(summary.precision)}, recall ${dash(summary.recall)}, f1 ${dash(summary.f1)}, judge_failed ${summary.judge_failed}, judge_cost ${summary.judge_cost}`);
  if (summary.stopped_reason !== null) out(`stopped: ${summary.stopped_reason}, cases not judged ${summary.cases_not_judged}`);
}

// The eval's judge of replies: needs no GITHUB_TOKEN; paths outside the project; prints counts and codes only.
async function judgeRepliesCommand(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<void> {
  const parsed = parse(argv, ['findings', 'config', 'out', 'max-cost'], []);
  if (parsed.positional.length > 0) throw new UsageError('usage: judge-replies takes no positional arguments');
  const get = (name: string): string => {
    const v = parsed.options.get(name);
    if (v === undefined) throw new UsageError(`usage: judge-replies needs --${name}`);
    return v;
  };
  const findingsPath = get('findings');
  const configPath = get('config');
  const outDir = get('out');
  const maxCost = positive(parsed, 'max-cost', 2);
  outsideProject(findingsPath, projectFolder(), 'findings');
  outsideProject(outDir, projectFolder(), 'out');
  const config = readable('config', () => loadConfig(configPath, env));
  const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });
  readable('findings', () => loadFindings(findingsPath));   // a file that cannot be read is a usage error, before any call
  const lines = await judgeReplies({
    findingsPath, outDir, maxCost,
    setting: { model: config.model.model, fallbacks: [...config.model.fallbacks], toolChoice: config.model.toolChoice === 'auto' ? 'auto' : 'forced' },
    model: createModelClient(config.model, { fetch: globalThis.fetch, sleep }),
    token: () => randomBytes(8).toString('hex'), timeoutMs: config.model.timeoutSeconds * 1000,
  });
  for (const line of lines) out(line);
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
    else if (command === 'judge') await judgeCommand(rest, env, out);
    else if (command === 'backtest') await backtest(rest, env, out);
    else if (command === 'score-noise') scoreNoiseCommand(rest, out);
    else if (command === 'import-history') await importHistory(rest, env, out);
    else if (command === 'import-aacr') await importAacr(rest, env, out);
    else if (command === 'memory-count') await memoryCountCommand(rest, out);
    else if (command === 'score-compare') scoreCompareCommand(rest, out);
    else if (command === 'seed-memory') await seedMemoryCommand(rest, env, out);
    else if (command === 'export-findings') await exportFindingsCommand(rest, env, out);
    else if (command === 'judge-replies') await judgeRepliesCommand(rest, env, out);
    else if (command === 'lesson-cases') lessonCasesCommand(rest, out);
    else throw new UsageError('usage: cli <replay|judge|compare|import-history|import-aacr|backtest|score-noise|memory-count|score-compare|seed-memory|export-findings|judge-replies|lesson-cases> ...');
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
