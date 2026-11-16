// Replays frozen pull requests through the engine and writes the run's results.
// It builds no clients: the caller hands in `deps`.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { repoConfigFor } from '../config/load.ts';
import type { DeploymentConfig } from '../config/load.ts';
import { review } from '../engine/review.ts';
import type { ReviewDeps, ReviewInput } from '../engine/types.ts';
import type { EvalCase } from './cases.ts';
import { caseKey } from './cases.ts';
import { METRICS, scoreCase, summarize } from './score.ts';
import type { CaseResult, CaseScore, ReplayFinding, Summary } from './score.ts';

export interface SummaryFile {
  summary: Summary; cases_file: string; cases_sha256: string; case_count: number; max_cases: number;
  stopped_reason: 'max_cost' | null; cases_not_started: number; scored: CaseScore[];
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
    limits: { ...config.limits, modelTimeoutSeconds: config.model.timeoutSeconds },
    asOf,
    earlier: null,
  };
}

// Case data is private: only a short code, or the error's name, is recorded.
function evalFailure(c: EvalCase, error: unknown, duration_ms: number): CaseResult {
  const reason = error instanceof Error && SHORT_CODE.test(error.message) ? error.message : 'unexpected_error';
  return { key: caseKey(c), status: 'failed', failure_stage: 'eval', failure_reason: reason, total_cost: 0, total_tokens: 0, duration_ms, findings: [] };
}

export async function replayCase(c: EvalCase, config: DeploymentConfig, deps: ReviewDeps): Promise<CaseResult> {
  const started = Date.now();
  try {
    const result = await review(toReviewInput(c, config, deps.clock()), deps);
    const findings: ReplayFinding[] = result.findings.map((f) => ({ path: f.path, line: f.line, side: f.side, severity: f.severity, body: f.body }));
    return {
      key: caseKey(c),
      status: result.status,
      failure_stage: result.failure ? result.failure.stage : null,
      failure_reason: result.failure ? result.failure.code : null,
      total_cost: result.usage.cost,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
      duration_ms: Date.now() - started,
      findings,
    };
  } catch (error) {
    return evalFailure(c, error, Date.now() - started);
  }
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

export function assertOutsideProject(path: string, projectRoot: string): void {
  const p = resolve(path);
  const root = resolve(projectRoot);
  if (p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('path_inside_project');
}

function summaryTable(summary: Summary): string {
  const rows = METRICS.map((m) => `| ${m.name} | ${summary[m.name] ?? EM_DASH} |`);
  return ['| metric | value |', '| --- | --- |', ...rows].join('\n') + '\n';
}

export async function runReplay(args: {
  cases: EvalCase[]; casesFile: string; casesSha256: string; label: string; outDir: string;
  maxCases: number; maxCost: number; concurrency: number; config: DeploymentConfig; deps: ReviewDeps;
}): Promise<SummaryFile> {
  mkdirSync(args.outDir, { recursive: true });
  const resultsPath = join(args.outDir, 'results.jsonl');
  writeFileSync(resultsPath, '');

  const selected = args.cases.slice(0, args.maxCases);
  const results: (CaseResult | undefined)[] = new Array<CaseResult | undefined>(selected.length).fill(undefined);
  let next = 0;
  let spent = 0;
  let stoppedByCost = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (next >= selected.length) return;
      if (spent >= args.maxCost) { stoppedByCost = true; return; }
      const index = next;
      next += 1;
      const result = await replayCase(selected[index]!, args.config, args.deps);
      results[index] = result;
      spent += result.total_cost;
      appendFileSync(resultsPath, JSON.stringify(result) + '\n');
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));

  const started: { c: EvalCase; r: CaseResult }[] = [];
  selected.forEach((c, i) => { const r = results[i]; if (r) started.push({ c, r }); });
  const scored = started.map(({ c, r }) => scoreCase(c, r));
  const summary = summarize(args.label, scored, started.map((s) => s.r));
  const notStarted = selected.length - started.length;
  const file: SummaryFile = {
    summary, cases_file: args.casesFile, cases_sha256: args.casesSha256, case_count: args.cases.length, max_cases: args.maxCases,
    stopped_reason: stoppedByCost && notStarted > 0 ? 'max_cost' : null, cases_not_started: notStarted, scored,
  };
  writeFileSync(join(args.outDir, 'summary.json'), JSON.stringify(file, null, 2) + '\n');
  writeFileSync(join(args.outDir, 'summary.md'), summaryTable(summary));
  const sample = sampleUnmatched(scored, args.casesSha256, UNMATCHED_SAMPLE_SIZE);
  writeFileSync(join(args.outDir, 'unmatched-sample.jsonl'), sample.map((f) => JSON.stringify(f) + '\n').join(''));
  return file;
}
