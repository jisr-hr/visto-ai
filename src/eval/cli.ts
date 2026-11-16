// The composition root: the only place real clients are built.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '../config/load.ts';
import { createModelClient } from '../engine/model/client.ts';
import type { ReviewDeps } from '../engine/types.ts';
import { createGithubReadSource } from '../forge/github/read-source.ts';
import { compareSummaries } from './compare.ts';
import { loadCases } from './cases.ts';
import { assertOutsideProject, runReplay } from './replay.ts';
import type { SummaryFile } from './replay.ts';

class UsageError extends Error {}
const SHORT_CODE = /^[a-z][a-z0-9_]*$/;
const REPLAY_OPTIONS = ['cases', 'out', 'label', 'config', 'max-cases', 'max-cost', 'concurrency'];

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

async function replay(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<void> {
  const parsed = parse(argv, REPLAY_OPTIONS, ['force']);
  if (parsed.positional.length > 0) throw new UsageError('usage: replay takes no positional arguments');
  const get = (name: string): string => {
    const v = parsed.options.get(name);
    if (v === undefined) throw new UsageError(`usage: replay needs --${name}`);
    return v;
  };
  const casesPath = get('cases');
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
  outsideProject(casesPath, projectRoot, 'cases');
  outsideProject(outDir, projectRoot, 'out');
  if (!parsed.flags.has('force') && existsSync(outDir) && (safeList(outDir)?.length ?? 1) > 0) {
    throw new UsageError('usage: --out is not empty; use --force to reuse it');
  }

  const config = readable('config', () => loadConfig(configPath, env));
  const { cases, sha256 } = readable('cases', () => loadCases(casesPath));
  const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });
  const deps: ReviewDeps = {
    source: createGithubReadSource({ token: githubToken, fetch: globalThis.fetch }),
    model: createModelClient(config.model, { fetch: globalThis.fetch, sleep }),
    contract: readFileSync(join(projectRoot, 'contract', 'review-contract.md'), 'utf8'),
    clock: () => new Date(),
    token: () => randomBytes(8).toString('hex'),
    log: (entry) => { process.stderr.write(JSON.stringify(entry) + '\n'); },
  };
  const file = await runReplay({ cases, casesFile: casesPath, casesSha256: sha256, label, outDir, maxCases, maxCost, concurrency, config, deps });
  out(`cases ${file.summary.cases}, failed ${file.summary.failed_cases}, not started ${file.cases_not_started}, total_cost ${file.summary.total_cost}`);
  if (file.stopped_reason !== null) out(`stopped: ${file.stopped_reason}`);
}

// A file that cannot be read is a usage error; one that is read but invalid is not.
function readable<T>(name: string, load: () => T): T {
  try {
    return load();
  } catch (error) {
    const fileError = error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string' && typeof (error as NodeJS.ErrnoException).syscall === 'string';
    if (fileError) throw new UsageError(`usage: cannot read --${name}`);
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

function compare(argv: string[], out: (line: string) => void): void {
  const parsed = parse(argv, ['noise'], []);
  if (parsed.positional.length !== 2) throw new UsageError('usage: compare <baseline summary.json> <candidate summary.json> [--noise <summary.json>]');
  const noisePath = parsed.options.get('noise');
  const table = compareSummaries(readSummary(parsed.positional[0]!), readSummary(parsed.positional[1]!), noisePath === undefined ? null : readSummary(noisePath));
  for (const line of table.split('\n')) out(line);
}

export async function main(argv: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === 'replay') await replay(rest, env, out);
    else if (command === 'compare') compare(rest, out);
    else throw new UsageError('usage: cli <replay|compare> ...');
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
