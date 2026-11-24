// Replays frozen pull requests through the engine and writes the run's results.
// It builds no clients: the caller hands in `deps`.
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { repoConfigFor } from '../config/load.ts';
import type { DeploymentConfig } from '../config/load.ts';
import { review } from '../engine/review.ts';
import type { ReviewDeps, ReviewInput } from '../engine/types.ts';
import type { EvalCase } from './cases.ts';
import { caseKey } from './cases.ts';
import { plainCase } from './plain.ts';
import { runPool } from './pool.ts';
import { METRICS, scoreCase, summarize } from './score.ts';
import type { CaseResult, CaseScore, ReplayFinding, Summary } from './score.ts';

export interface RunCoverage {
  files_reviewed: number; files_not_reviewed: Record<string, number>; cases_with_files_not_reviewed: number; calls: number; models: string[];
}
export interface SummaryFile {
  summary: Summary; cases_file: string; cases_sha256: string; case_count: number; max_cases: number;
  stopped_reason: 'max_cost' | null; cases_not_started: number; coverage: RunCoverage; scored: CaseScore[]; plain: boolean;
}

const EM_DASH = '\u2014';
const UNMATCHED_SAMPLE_SIZE = 40;
const SHORT_CODE = /^[a-z][a-z0-9_]*$/;

export function toReviewInput(c: EvalCase, config: DeploymentConfig, asOf: Date): ReviewInput {
  const parts = c.repo.split('/');
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo) throw new Error('bad_case_repo');
  return {
    pullRequest: {
      ref: { service: 'github', owner, repo, number: c.pr_number },
      title: c.title, description: c.body, author: c.author,
      baseBranch: c.base_branch, headBranch: c.branch,
      baseSha: c.compare_base, headSha: c.head_sha, draft: false,
    },
    trigger: 'automatic',
    repoConfig: repoConfigFor(config, c.repo),
    limits: {
      inputTokensPerCall: config.limits.inputTokensPerCall, batchesPerReview: config.limits.batchesPerReview,
      modelTimeoutSeconds: config.model.timeoutSeconds,
    },
    asOf,
    earlier: null,
  };
}

// Case data is private: only a short code, or the error's name, is recorded.
function evalFailure(c: EvalCase, error: unknown, duration_ms: number): CaseResult {
  const reason = error instanceof Error && SHORT_CODE.test(error.message) ? error.message : 'unexpected_error';
  return {
    key: caseKey(c), status: 'failed', failure_stage: 'eval', failure_reason: reason, total_cost: 0, total_tokens: 0, duration_ms,
    calls: 0, cached_tokens: 0, models: [], unplaced: 0, files_reviewed: 0, not_reviewed: {}, findings: [], highest_score: null, needs_human: null,
  };
}

export async function replayCase(c: EvalCase, config: DeploymentConfig, deps: ReviewDeps): Promise<CaseResult> {
  const started = Date.now();
  try {
    const result = await review(toReviewInput(c, config, deps.clock()), deps);
    const shown = (f: ReplayFinding): ReplayFinding => ({ path: f.path, line: f.line, side: f.side, severity: f.severity, body: f.body });
    const findings: ReplayFinding[] = result.findings.map(shown);
    const extra_findings: ReplayFinding[] = [...result.unplaced.map(shown), ...result.beyondDiff.map(shown)];
    return {
      key: caseKey(c),
      status: result.status,
      failure_stage: result.failure ? result.failure.stage : null,
      failure_reason: result.failure ? result.failure.code : null,
      total_cost: result.usage.cost,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
      duration_ms: Date.now() - started,
      calls: result.usage.calls,
      cached_tokens: result.usage.cachedTokens,
      models: result.models,
      unplaced: result.unplaced.length,
      files_reviewed: result.coverage.reviewed.length,
      not_reviewed: countBy(result.coverage.notReviewed.map((n) => n.reason)),
      findings,
      extra_findings,
      highest_score: result.verdict.highest,
      needs_human: result.verdict.needsHuman,
    };
  } catch (error) {
    return evalFailure(c, error, Date.now() - started);
  }
}

function countBy(keys: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}

function runCoverage(results: CaseResult[]): RunCoverage {
  const notReviewed: Record<string, number> = {};
  for (const r of results) {
    for (const [reason, n] of Object.entries(r.not_reviewed)) notReviewed[reason] = (notReviewed[reason] ?? 0) + n;
  }
  return {
    files_reviewed: results.reduce((n, r) => n + r.files_reviewed, 0),
    files_not_reviewed: notReviewed,
    cases_with_files_not_reviewed: results.filter((r) => Object.values(r.not_reviewed).some((n) => n > 0)).length,
    calls: results.reduce((n, r) => n + r.calls, 0),
    models: [...new Set(results.flatMap((r) => r.models))],
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function sampleUnmatched(scored: CaseScore[], seed: string, size: number): (ReplayFinding & { key: string })[] {
  return scored
    .flatMap((s) => s.unmatched.filter((f) => f.severity === 'major' || f.severity === 'blocker').map((f) => ({ ...f, key: s.key })))
    .map((f) => ({ f, order: sha256(`${seed}|${f.key}|${f.path}|${f.line}`) }))
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    .slice(0, size)
    .map((x) => x.f);
}

// Follows links through the deepest ancestor that exists, then appends the part
// that does not exist yet. A dangling link counts as not existing.
function realPathOf(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      lstatSync(existing);
      return join(realpathSync.native(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return join(existing, ...rest);
      rest.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ''));
      existing = parent;
    }
  }
}

export function assertOutsideProject(path: string, projectRoot: string): void {
  const p = realPathOf(path);
  const root = realPathOf(projectRoot);
  if (p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('path_inside_project');
}

function summaryTable(summary: Summary): string {
  const rows = METRICS.map((m) => `| ${m.name} | ${summary[m.name] ?? EM_DASH} |`);
  return ['| metric | value |', '| --- | --- |', ...rows].join('\n') + '\n';
}

export async function runReplay(args: {
  cases: EvalCase[]; casesFile: string; casesSha256: string; label: string; outDir: string;
  maxCases: number; maxCost: number; concurrency: number; config: DeploymentConfig; deps: ReviewDeps;
  plain?: boolean; // run the plain control in place of the engine; absent reads as false
}): Promise<SummaryFile> {
  mkdirSync(args.outDir, { recursive: true });
  // Files from an earlier run must not sit beside this run's files.
  // A link left at results.jsonl would send the writes elsewhere, so it is removed, not truncated.
  for (const name of ['summary.json', 'summary.md', 'unmatched-sample.jsonl', 'results.jsonl']) rmSync(join(args.outDir, name), { force: true });
  const resultsPath = join(args.outDir, 'results.jsonl');
  writeFileSync(resultsPath, '');

  const plain = args.plain === true;
  const selected = args.cases.slice(0, args.maxCases);
  const results: (CaseResult | undefined)[] = new Array<CaseResult | undefined>(selected.length).fill(undefined);
  const { stoppedByCost, notStarted } = await runPool(
    selected, { concurrency: args.concurrency, maxCost: args.maxCost }, (c) => (plain ? plainCase(c, args.config, args.deps) : replayCase(c, args.config, args.deps)),
    (result, index) => { results[index] = result; appendFileSync(resultsPath, JSON.stringify(result) + '\n'); },
  );

  const started: { c: EvalCase; r: CaseResult }[] = [];
  selected.forEach((c, i) => { const r = results[i]; if (r) started.push({ c, r }); });
  const scored = started.map(({ c, r }) => scoreCase(c, r));
  const summary = summarize(args.label, scored, started.map((s) => s.r));
  const file: SummaryFile = {
    summary, cases_file: args.casesFile, cases_sha256: args.casesSha256, case_count: args.cases.length, max_cases: args.maxCases,
    stopped_reason: stoppedByCost && notStarted > 0 ? 'max_cost' : null, cases_not_started: notStarted,
    coverage: runCoverage(started.map((s) => s.r)), scored, plain,
  };
  writeFileSync(join(args.outDir, 'summary.json'), JSON.stringify(file, null, 2) + '\n');
  writeFileSync(join(args.outDir, 'summary.md'), summaryTable(summary));
  const sample = sampleUnmatched(scored, args.casesSha256, UNMATCHED_SAMPLE_SIZE);
  writeFileSync(join(args.outDir, 'unmatched-sample.jsonl'), sample.map((f) => JSON.stringify(f) + '\n').join(''));
  return file;
}
