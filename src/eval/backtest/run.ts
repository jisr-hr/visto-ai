// Replays the score on frozen pull requests and writes the run's results. It builds no clients: the
// caller hands in `deps`. Everything written here holds paths and model-written text, so it is as
// private as the history file.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoConfigFor } from '../../config/load.ts';
import type { DeploymentConfig } from '../../config/load.ts';
import { review } from '../../engine/review.ts';
import type { FileScore } from '../../engine/score/types.ts';
import type { ReviewDeps, ReviewInput, Verdict } from '../../engine/types.ts';
import { historyKey } from '../history/file.ts';
import type { HistoryCase } from '../history/file.ts';
import { runPool } from '../pool.ts';
import { labelCase } from './labels.ts';
import type { Label, Labels } from './labels.ts';
import { THRESHOLDS, measure } from './metrics.ts';
import type { CaseScores, Numbers } from './metrics.ts';

export interface BacktestSummary {
  label: string; history_file: string; history_sha256: string; case_count: number; max_cases: number;
  stopped_reason: 'max_cost' | null; cases_not_started: number; cases: number; failed_cases: number;
  reviewed_by_person: number; total_cost: number;
  models: string[];        // the models that answered, distinct, in first-seen order
  contract_sha256: string; // sha256 of the contract text the run used
  scorer: string | null;   // the decision model that scored the blocks, or null when the review model did
  scorer_failed_files: number; // the rows' scorer_failed_files, summed
  comments: Labels['comments'];
  final_missing: number;
  numbers: Numbers[]; // one per THRESHOLDS entry, then 'own'
}

interface ResultRow {
  key: string; status: 'ok' | 'failed'; failure_stage: string | null; failure_code: string | null;
  cost: number; tokens: number; duration_ms: number; calls: number; verdict: Verdict | null;
  blocks: number; blocks_unscored: number; files_flagged_whole: number;
  scorer_failed_files: number; // files the scorer failed on or was not asked about
}
interface ScoresLine {
  key: string; threshold: number; status: 'ok' | 'failed'; scores: FileScore[];
  labels: { blocks: Record<string, Label>; files: Record<string, Label>; comments: Labels['comments']; final_missing: number };
}
interface Outcome { total_cost: number; row: ResultRow; scores: CaseScores; reviewedByPerson: boolean; models: string[] }

const SHORT_CODE = /^[a-z][a-z0-9_]*$/;
const EM_DASH = '\u2014';

export function toBacktestInput(c: HistoryCase, config: DeploymentConfig): ReviewInput {
  const parts = c.repo.split('/');
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo) throw new Error('bad_case_repo');
  return {
    pullRequest: {
      ref: { service: 'github', owner, repo, number: c.pr_number },
      title: c.title, description: c.body, author: c.author,
      baseBranch: c.base_branch, headBranch: c.branch,
      baseSha: c.review_base, headSha: c.review_head, draft: false,
    },
    trigger: 'automatic',
    repoConfig: repoConfigFor(config, c.repo),
    limits: {
      inputTokensPerCall: config.limits.inputTokensPerCall, batchesPerReview: config.limits.batchesPerReview,
      modelTimeoutSeconds: config.model.timeoutSeconds,
    },
    asOf: new Date(c.review_at),
    earlier: null,
  };
}

const emptyLabels = (): Labels => ({
  blocks: new Map(), files: new Map(), comments: { counted: 0, off_head: 0, outside_diff: 0, in_bot_thread: 0 }, final_missing: 0,
});

function counts(scores: FileScore[], threshold: number): Pick<ResultRow, 'blocks' | 'blocks_unscored' | 'files_flagged_whole'> {
  return {
    blocks: scores.reduce((n, f) => n + f.blocks.length, 0),
    blocks_unscored: scores.reduce((n, f) => n + f.blocks.filter((b) => b.entry === null).length, 0),
    files_flagged_whole: scores.filter((f) => f.fileLevel !== null && f.fileLevel.score >= threshold).length,
  };
}

async function backtestCase(c: HistoryCase, config: DeploymentConfig, deps: ReviewDeps): Promise<Outcome> {
  const started = Date.now();
  const key = historyKey(c);
  try {
    const result = await review(toBacktestInput(c, config), deps);
    const failed = result.status === 'failed';
    const labels = failed ? emptyLabels() : labelCase(c, result.scores);
    return {
      total_cost: result.usage.cost,
      reviewedByPerson: c.reviewed_by_person,
      models: result.models,
      row: {
        key, status: result.status, failure_stage: result.failure?.stage ?? null, failure_code: result.failure?.code ?? null,
        cost: result.usage.cost, tokens: result.usage.inputTokens + result.usage.outputTokens, duration_ms: Date.now() - started,
        calls: result.usage.calls, verdict: result.verdict, ...counts(result.scores, result.verdict.threshold),
        scorer_failed_files: failed ? 0 : result.audit.filter((e) => e.stage === 'scorer' && (e.action === 'file_failed' || e.action === 'file_not_asked')).length,
      },
      scores: { key, threshold: result.verdict.threshold, status: result.status, scores: result.scores, labels },
    };
  } catch (error) {
    // Case data is private: only a short code, or the error's name, is recorded.
    const code = error instanceof Error && SHORT_CODE.test(error.message) ? error.message : 'unexpected_error';
    return {
      total_cost: 0,
      reviewedByPerson: c.reviewed_by_person,
      models: [],
      row: {
        key, status: 'failed', failure_stage: 'eval', failure_code: code, cost: 0, tokens: 0, duration_ms: Date.now() - started,
        calls: 0, verdict: null, blocks: 0, blocks_unscored: 0, files_flagged_whole: 0, scorer_failed_files: 0,
      },
      scores: { key, threshold: config.repositories.defaults.scoreThreshold, status: 'failed', scores: [], labels: emptyLabels() },
    };
  }
}

function scoresLine(c: CaseScores): ScoresLine {
  return {
    key: c.key, threshold: c.threshold, status: c.status, scores: c.scores,
    labels: {
      blocks: Object.fromEntries(c.labels.blocks), files: Object.fromEntries(c.labels.files), comments: c.labels.comments,
      final_missing: c.labels.final_missing,
    },
  };
}

/** Reads a run's scores.jsonl back into the shape `scoreNoise` takes. */
export function readCaseScores(path: string): CaseScores[] {
  const out: CaseScores[] = [];
  readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    let data: ScoresLine;
    try { data = JSON.parse(line) as ScoresLine; } catch { throw new Error(`bad_scores_line_${index + 1}`); }
    if (typeof data.key !== 'string' || !Array.isArray(data.scores) || typeof data.labels !== 'object' || data.labels === null) throw new Error(`bad_scores_line_${index + 1}`);
    out.push({
      key: data.key, threshold: data.threshold, status: data.status, scores: data.scores,
      labels: {
        blocks: new Map(Object.entries(data.labels.blocks)), files: new Map(Object.entries(data.labels.files)), comments: data.labels.comments,
        final_missing: data.labels.final_missing,
      },
    });
  });
  return out;
}

const cell = (value: number | null): string => (value === null ? EM_DASH : String(value));

function summaryMarkdown(summary: BacktestSummary): string {
  return `${summaryTable(summary.numbers)}\nComments by a person left out because a bot started their thread: ${summary.comments.in_bot_thread}. ` +
    `Labelled blocks and files with no final patch: ${summary.final_missing}.\n` +
    `Scorer: ${summary.scorer ?? 'the review model'}\n` +
    (summary.scorer === null ? '' : `Files the scorer failed on or was not asked about: ${summary.scorer_failed_files}\n`);
}

function summaryTable(numbers: Numbers[]): string {
  const names = ['safety_blocks', 'safety_blocks_loose', 'safety_files', 'safety_files_loose', 'benefit', 'focus'] as const;
  const header = ['threshold', ...names.flatMap((n) => [n, `${n}_n`])];
  const rows = numbers.map((x) => [String(x.threshold), ...names.flatMap((n) => [cell(x[n]), String(x[`${n}_n`])])]);
  return [header, header.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n') + '\n';
}

export async function runBacktest(args: {
  cases: HistoryCase[]; historyFile: string; historySha256: string; label: string; outDir: string;
  maxCases: number; maxCost: number; concurrency: number; config: DeploymentConfig; deps: ReviewDeps;
}): Promise<BacktestSummary> {
  const keys = new Set<string>();
  for (const c of args.cases) {
    const key = historyKey(c);
    if (keys.has(key)) throw new Error('duplicate_history_case');
    keys.add(key);
  }
  mkdirSync(args.outDir, { recursive: true });
  // Files from an earlier run must not sit beside this run's files.
  // A link left at a result file would send the writes elsewhere, so the files are removed, not truncated.
  for (const name of ['summary.json', 'summary.md', 'results.jsonl', 'scores.jsonl']) rmSync(join(args.outDir, name), { force: true });
  const resultsPath = join(args.outDir, 'results.jsonl');
  const scoresPath = join(args.outDir, 'scores.jsonl');
  writeFileSync(resultsPath, '');
  writeFileSync(scoresPath, '');

  const selected = args.cases.slice(0, args.maxCases);
  const outcomes: (Outcome | undefined)[] = new Array<Outcome | undefined>(selected.length).fill(undefined);
  const { stoppedByCost, notStarted } = await runPool(
    selected, { concurrency: args.concurrency, maxCost: args.maxCost }, (c) => backtestCase(c, args.config, args.deps),
    (outcome, index) => {
      outcomes[index] = outcome;
      appendFileSync(resultsPath, JSON.stringify(outcome.row) + '\n');
      appendFileSync(scoresPath, JSON.stringify(scoresLine(outcome.scores)) + '\n');
    },
  );

  const done = outcomes.filter((o): o is Outcome => o !== undefined);
  const scored = done.map((o) => o.scores);
  const comments = { counted: 0, off_head: 0, outside_diff: 0, in_bot_thread: 0 };
  let finalMissing = 0;
  for (const c of scored) {
    if (c.status !== 'ok') continue;
    comments.counted += c.labels.comments.counted;
    comments.off_head += c.labels.comments.off_head;
    comments.outside_diff += c.labels.comments.outside_diff;
    comments.in_bot_thread += c.labels.comments.in_bot_thread;
    finalMissing += c.labels.final_missing;
  }
  const summary: BacktestSummary = {
    label: args.label, history_file: args.historyFile, history_sha256: args.historySha256,
    case_count: args.cases.length, max_cases: args.maxCases,
    stopped_reason: stoppedByCost && notStarted > 0 ? 'max_cost' : null, cases_not_started: notStarted,
    cases: done.length, failed_cases: done.filter((o) => o.row.status === 'failed').length,
    reviewed_by_person: done.filter((o) => o.row.status === 'ok' && o.reviewedByPerson).length,
    total_cost: Number(done.reduce((sum, o) => sum + o.total_cost, 0).toFixed(6)),
    models: [...new Set(done.flatMap((o) => o.models))],
    contract_sha256: createHash('sha256').update(args.deps.contract).digest('hex'),
    scorer: args.config.scorer?.model ?? null,
    scorer_failed_files: done.reduce((n, o) => n + o.row.scorer_failed_files, 0),
    comments,
    final_missing: finalMissing,
    numbers: [...THRESHOLDS, 'own' as const].map((t) => measure(scored, t)),
  };
  writeFileSync(join(args.outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(args.outDir, 'summary.md'), summaryMarkdown(summary));
  return summary;
}
