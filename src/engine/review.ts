import { buildFileContexts } from './context/build.ts';
import type { FileContext } from './context/build.ts';
import { packBatches } from './context/batches.ts';
import type { Batch } from './context/batches.ts';
import { orderByPriority } from './context/priority.ts';
import { buildMessages, fixedTokens } from './context/prompt.ts';
import { callBatch } from './model/call.ts';
import type { BatchAnswer } from './model/call.ts';
import type { SubmitReviewArgs } from './model/submit-review.ts';
import { reconcile } from './reconcile/index.ts';
import type {
  AuditEntry, ChangedFile, Effort, NotReviewed, PullRequestInfo, RepoConfig, ReviewDeps, ReviewInput, ReviewResult, Source, Usage,
} from './types.ts';

const CONCURRENCY = 2;
const PROVIDER_CODES = new Set(['auth', 'no_credit', 'provider', 'timeout', 'rate_limited']);
const ELEVATED_FILES = 15;
const ELEVATED_ADDITIONS = 500;

const zeroUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 });
function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cost: a.cost + b.cost,
  };
}

export function chooseEffort(pr: PullRequestInfo, files: ChangedFile[], repo: RepoConfig): Effort {
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  return files.length > ELEVATED_FILES || additions > ELEVATED_ADDITIONS || repo.primaryBranches.includes(pr.baseBranch)
    ? 'elevated'
    : 'default';
}

function failedResult(stage: 'context' | 'model', code: string, usage: Usage, audit: AuditEntry[], model: 'ok' | 'error'): ReviewResult {
  return {
    status: 'failed', failure: { stage, code }, mode: 'full', overview: '', findings: [], unplaced: [], beyondDiff: [],
    coverage: { reviewed: [], notReviewed: [] }, usage, dependencies: { model }, audit,
  };
}

function okResult(overview: string, rest: Partial<ReviewResult>): ReviewResult {
  return {
    status: 'ok', failure: null, mode: 'full', overview, findings: [], unplaced: [], beyondDiff: [],
    coverage: { reviewed: [], notReviewed: [] }, usage: zeroUsage(), dependencies: { model: 'ok' }, audit: [], ...rest,
  };
}

interface BatchOutcome {
  answers: SubmitReviewArgs[];
  reviewed: string[];
  failedFiles: string[];
  failedCodes: string[]; // codes of the parts that ended failed, in order
  usage: Usage;
  audit: AuditEntry[];
}

interface Run {
  contexts: FileContext[];
  limits: ReviewInput['limits'];
  prPaths: string[];
  effort: Effort;
  token: string;
  pr: PullRequestInfo;
  deps: ReviewDeps;
  fileCount: number;
  batchCount: number;
}

async function oneCall(run: Run, files: FileContext[], firstFileNumber: number, batchIndex: number): Promise<BatchAnswer> {
  const batch: Batch = { files, tokens: 0 };
  const messages = buildMessages({
    contract: run.deps.contract, pr: run.pr, fileCount: run.fileCount, firstFileNumber, batch,
    batchIndex, batchCount: run.batchCount, token: run.token,
  });
  const answer = await callBatch(
    { messages, effort: run.effort, timeoutMs: run.limits.modelTimeoutSeconds * 1000, prPaths: run.prPaths },
    run.deps.model,
  );
  run.deps.log({
    event: 'model_call', files: files.length, effort: run.effort, code: answer.ok ? 'ok' : answer.code, usage: answer.usage,
  });
  return answer;
}

async function runBatch(run: Run, batch: Batch, firstFileNumber: number, batchIndex: number): Promise<BatchOutcome> {
  const out: BatchOutcome = { answers: [], reviewed: [], failedFiles: [], failedCodes: [], usage: zeroUsage(), audit: [] };
  const take = (answer: BatchAnswer, files: FileContext[]): void => {
    out.usage = addUsage(out.usage, answer.usage);
    out.audit.push(...answer.audit);
    if (answer.ok) {
      out.answers.push(answer.value);
      out.reviewed.push(...files.map((f) => f.file.path));
    }
  };
  const giveUp = (answer: Extract<BatchAnswer, { ok: false }>, files: FileContext[]): void => {
    for (const f of files) out.failedFiles.push(f.file.path);
    out.failedCodes.push(answer.code);
    out.audit.push({ stage: 'model', action: 'batch_failed', subject: files.map((f) => f.file.path).join(', '), reason: answer.code });
  };

  const first = await oneCall(run, batch.files, firstFileNumber, batchIndex);
  take(first, batch.files);
  if (first.ok) return out;

  if (first.code === 'timeout' && batch.files.length > 1) {
    const mid = Math.ceil(batch.files.length / 2);
    const halves = [batch.files.slice(0, mid), batch.files.slice(mid)];
    let number = firstFileNumber;
    for (const half of halves) {
      const answer = await oneCall(run, half, number, batchIndex);
      take(answer, half);
      if (!answer.ok) giveUp(answer, half);
      number += half.length;
    }
    return out;
  }
  if (first.code === 'timeout' || first.code === 'provider' || first.code === 'rate_limited') {
    const second = await oneCall(run, batch.files, firstFileNumber, batchIndex);
    take(second, batch.files);
    if (!second.ok) giveUp(second, batch.files);
    return out;
  }
  giveUp(first, batch.files);
  return out;
}

async function inPool<T>(count: number, width: number, work: (index: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array<T>(count);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) {
      const index = next;
      next += 1;
      results[index] = await work(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, count) }, worker));
  return results;
}

export async function review(input: ReviewInput, deps: ReviewDeps): Promise<ReviewResult> {
  let stage: 'context' | 'model' = 'context';
  let sourceFailed = false;
  let usage = zeroUsage();
  const audit: AuditEntry[] = [];
  try {
    const pr = input.pullRequest;
    const guard = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        sourceFailed = true;
        throw error;
      }
    };
    const source: Source = {
      listFiles: (p) => guard(() => deps.source.listFiles(p)),
      getFileContent: (p, path, sha) => guard(() => deps.source.getFileContent(p, path, sha)),
    };

    const files = await source.listFiles(pr);
    if (files.length === 0) return okResult('No changes to review.', {});

    const budget = input.limits.inputTokensPerCall - fixedTokens(deps.contract, pr);
    if (budget <= 0) return failedResult('context', 'budget_too_small', usage, audit, 'ok');

    const built = await buildFileContexts(pr, orderByPriority(files), source);
    const packed = packBatches(built.contexts, budget, input.limits.batchesPerReview);
    audit.push(...built.audit, ...packed.audit);
    if (packed.batches.length === 0) {
      return okResult('No reviewable changes.', { coverage: { reviewed: [], notReviewed: packed.notReviewed }, audit });
    }

    stage = 'model';
    const run: Run = {
      contexts: built.contexts, limits: input.limits, prPaths: files.map((f) => f.path),
      effort: chooseEffort(pr, files, input.repoConfig), token: deps.token(), pr, deps,
      fileCount: packed.batches.reduce((n, b) => n + b.files.length, 0), batchCount: packed.batches.length,
    };
    const firsts: number[] = [];
    let seen = 0;
    for (const b of packed.batches) {
      firsts.push(seen + 1);
      seen += b.files.length;
    }
    const outcomes = await inPool(packed.batches.length, CONCURRENCY, (i) => runBatch(run, packed.batches[i]!, firsts[i]!, i));

    for (const o of outcomes) {
      usage = addUsage(usage, o.usage);
      audit.push(...o.audit);
    }
    const codes = outcomes.flatMap((o) => o.failedCodes);
    const modelState = codes.some((c) => PROVIDER_CODES.has(c)) ? 'error' : 'ok';
    const fatal = codes.find((c) => c === 'auth' || c === 'no_credit');
    const everyBatchFailed = outcomes.every((o) => o.answers.length === 0);
    if (fatal !== undefined || everyBatchFailed) {
      return failedResult('model', fatal ?? codes[0] ?? 'internal_error', usage, audit, modelState);
    }

    const rec = reconcile(outcomes.flatMap((o) => o.answers), built.contexts);
    audit.push(...rec.audit);
    const notReviewed: NotReviewed[] = [
      ...packed.notReviewed,
      ...outcomes.flatMap((o) => o.failedFiles.map((path): NotReviewed => ({ path, reason: 'batch_failed' }))),
    ];
    return okResult(rec.overview, {
      findings: rec.findings, unplaced: rec.unplaced, beyondDiff: rec.beyondDiff,
      coverage: { reviewed: outcomes.flatMap((o) => o.reviewed), notReviewed },
      usage, dependencies: { model: modelState }, audit,
    });
  } catch (error) {
    const code = stage === 'model' ? 'internal_error' : sourceFailed ? 'source_error' : 'internal_error';
    const name = error instanceof Error ? error.name : 'unknown';
    try {
      deps.log({ event: 'internal_error', stage, name });
    } catch {
      // logging must not make review throw
    }
    return failedResult(stage, code, usage, audit, 'ok');
  }
}
