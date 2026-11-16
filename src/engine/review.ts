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

// A failing logger must never change a review.
function safeLog(deps: ReviewDeps, entry: Record<string, unknown>): void {
  try {
    deps.log(entry);
  } catch {
    // ignored on purpose
  }
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
  safeLog(run.deps, {
    event: 'model_call', files: files.length, effort: run.effort, code: answer.ok ? 'ok' : answer.code, usage: answer.usage,
  });
  return answer;
}

interface Control { stopped: boolean; error: unknown; failed: boolean }

// Never rejects: an unexpected error is recorded in `ctl`, which stops every worker from starting more work.
async function runBatch(run: Run, ctl: Control, batch: Batch, firstFileNumber: number, batchIndex: number): Promise<BatchOutcome> {
  const out: BatchOutcome = { answers: [], reviewed: [], failedFiles: [], failedCodes: [], usage: zeroUsage(), audit: [] };
  try {
    await attempt(run, ctl, out, batch, firstFileNumber, batchIndex);
  } catch (error) {
    if (!ctl.failed) {
      ctl.failed = true;
      ctl.error = error;
    }
    ctl.stopped = true;
  }
  return out;
}

async function attempt(run: Run, ctl: Control, out: BatchOutcome, batch: Batch, firstFileNumber: number, batchIndex: number): Promise<void> {
  const take = (answer: BatchAnswer, files: FileContext[]): void => {
    out.usage = addUsage(out.usage, answer.usage);
    out.audit.push(...answer.audit);
    if (answer.ok) {
      out.answers.push(answer.value);
      out.reviewed.push(...files.map((f) => f.file.path));
    }
  };
  const giveUp = (code: string, files: FileContext[]): void => {
    for (const f of files) out.failedFiles.push(f.file.path);
    out.failedCodes.push(code);
    out.audit.push({ stage: 'model', action: 'batch_failed', subject: files.map((f) => f.file.path).join(', '), reason: code });
    if (code === 'auth' || code === 'no_credit') ctl.stopped = true;
  };

  const first = await oneCall(run, batch.files, firstFileNumber, batchIndex);
  take(first, batch.files);
  if (first.ok) return;
  if (first.code === 'auth' || first.code === 'no_credit') ctl.stopped = true;

  const splits = first.code === 'timeout' && batch.files.length > 1;
  const again = first.code === 'timeout' || first.code === 'provider' || first.code === 'rate_limited';
  if (ctl.stopped || !again) {
    giveUp(first.code, batch.files);
    return;
  }
  const parts = splits
    ? [batch.files.slice(0, Math.ceil(batch.files.length / 2)), batch.files.slice(Math.ceil(batch.files.length / 2))]
    : [batch.files];
  let number = firstFileNumber;
  for (const part of parts) {
    if (ctl.stopped) {
      giveUp(first.code, part);
    } else {
      const answer = await oneCall(run, part, number, batchIndex);
      take(answer, part);
      if (!answer.ok) giveUp(answer.code, part);
    }
    number += part.length;
  }
}

async function inPool<T>(count: number, width: number, ctl: Control, work: (index: number) => Promise<T>): Promise<Array<T | undefined>> {
  const results: Array<T | undefined> = new Array<T | undefined>(count).fill(undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count && !ctl.stopped) {
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
    const ctl: Control = { stopped: false, error: null, failed: false };
    const settled = await inPool(packed.batches.length, CONCURRENCY, ctl, (i) => runBatch(run, ctl, packed.batches[i]!, firsts[i]!, i));
    const outcomes = settled.filter((o): o is BatchOutcome => o !== undefined);

    for (const o of outcomes) {
      usage = addUsage(usage, o.usage);
      audit.push(...o.audit);
    }
    if (ctl.failed) throw ctl.error;
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
    safeLog(deps, { event: 'internal_error', stage, name });
    return failedResult(stage, code, usage, audit, 'ok');
  }
}
