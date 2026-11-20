import { buildFileContexts } from './context/build.ts';
import type { FileContext } from './context/build.ts';
import { packBatches } from './context/batches.ts';
import type { Batch } from './context/batches.ts';
import { orderByPriority } from './context/priority.ts';
import { attachThreads } from './context/threads.ts';
import type { ShownThread } from './context/threads.ts';
import { buildMessages, fixedTokens, headerStripCounts } from './context/prompt.ts';
import { callBatch } from './model/call.ts';
import type { BatchAnswer } from './model/call.ts';
import type { SubmitReviewArgs } from './model/submit-review.ts';
import { inPool } from './pool.ts';
import type { Control } from './pool.ts';
import { reconcile } from './reconcile/index.ts';
import { normalizePath } from './reconcile/placement.ts';
import { reconcileScores, verdictOf } from './reconcile/scores.ts';
import { REPO_FILE, parseRepoFile } from './score/floors.ts';
import { askScorer, summariesOf } from './scorer/ask.ts';
import type {
  AuditEntry, ChangedFile, Effort, NotReviewed, PullRequestInfo, RepoConfig, ReviewDeps, ReviewInput, ReviewResult, Source, Usage,
} from './types.ts';

const CONCURRENCY = 2;
const PROVIDER_CODES = new Set(['auth', 'no_credit', 'provider', 'timeout', 'rate_limited']);
const ELEVATED_FILES = 15;
const ELEVATED_ADDITIONS = 500;
const SOURCE_CODE = /^[a-z][a-z0-9_]{0,39}$/;

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

type Answered = { models: string[]; providers: string[] };
const noneAnswered = (): Answered => ({ models: [], providers: [] });

// A review that did not finish never tells anyone that a pull request needs no person.
function failedResult(
  stage: 'context' | 'model', code: string, usage: Usage, audit: AuditEntry[], model: 'ok' | 'error', threshold: number,
  answered: Answered = noneAnswered(),
): ReviewResult {
  return {
    scores: [], verdict: { threshold, needsHuman: true, highest: 100 }, teamFileInvalid: null,
    status: 'failed', failure: { stage, code }, mode: 'full', overview: '', findings: [], unplaced: [], beyondDiff: [],
    coverage: { reviewed: [], notReviewed: [] }, usage, ...answered, dependencies: { model }, audit,
  };
}

function okResult(overview: string, threshold: number, rest: Partial<ReviewResult>): ReviewResult {
  return {
    scores: [], verdict: verdictOf([], threshold), teamFileInvalid: null,
    status: 'ok', failure: null, mode: 'full', overview, findings: [], unplaced: [], beyondDiff: [],
    coverage: { reviewed: [], notReviewed: [] }, usage: zeroUsage(), models: [], providers: [], dependencies: { model: 'ok' }, audit: [], ...rest,
  };
}

const distinct = (values: string[]): string[] => [...new Set(values)];

interface BatchOutcome {
  answers: { value: SubmitReviewArgs; files: string[]; threads?: string[] }[]; // each answer with the paths of the files it was given, and, in a run with threads, the keys of their threads
  reviewed: string[];
  failedFiles: string[];
  failedCodes: string[]; // codes of the parts that ended failed, in order
  usage: Usage;
  models: string[];
  providers: string[];
  audit: AuditEntry[];
}

interface Run {
  contexts: FileContext[];
  limits: ReviewInput['limits'];
  effort: Effort;
  token: string;
  pr: PullRequestInfo;
  deps: ReviewDeps;
  fileCount: number;
  batchCount: number;
  withThreads: boolean; // the run shows earlier threads: its calls take the tool with verdicts
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
    { messages, effort: run.effort, timeoutMs: run.limits.modelTimeoutSeconds * 1000, prPaths: files.map((f) => f.file.path), ...(run.withThreads ? { withThreads: true } : {}) },
    run.deps.model,
  );
  safeLog(run.deps, {
    event: 'model_call', files: files.length, effort: run.effort, code: answer.ok ? 'ok' : answer.code, usage: answer.usage,
    model: answer.models.at(-1) ?? null, provider: answer.providers.at(-1) ?? null,
  });
  return answer;
}

// Never rejects: an unexpected error is recorded in `ctl`, which stops every worker from starting more work.
async function runBatch(run: Run, ctl: Control, batch: Batch, firstFileNumber: number, batchIndex: number): Promise<BatchOutcome> {
  const out: BatchOutcome = { answers: [], reviewed: [], failedFiles: [], failedCodes: [], usage: zeroUsage(), models: [], providers: [], audit: [] };
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
    out.models.push(...answer.models);
    out.providers.push(...answer.providers);
    out.audit.push(...answer.audit);
    if (answer.ok) {
      const paths = files.map((f) => f.file.path);
      out.answers.push(run.withThreads
        ? { value: answer.value, files: paths, threads: files.flatMap((f) => (f.threads ?? []).map((t) => t.key)) }
        : { value: answer.value, files: paths });
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

export async function review(input: ReviewInput, deps: ReviewDeps): Promise<ReviewResult> {
  let stage: 'context' | 'model' = 'context';
  const sourceErrors = new Set<unknown>(); // what the source rejected with; a caught probe failure is not fatal
  let usage = zeroUsage();
  let answered = noneAnswered();
  const audit: AuditEntry[] = [];
  try {
    const pr = input.pullRequest;
    const guard = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        sourceErrors.add(error);
        throw error;
      }
    };
    const source: Source = {
      listFiles: (p) => guard(() => deps.source.listFiles(p)),
      getFileContent: (p, path, sha) => guard(() => deps.source.getFileContent(p, path, sha)),
      getDefaultBranchFile: (p, path) => guard(() => deps.source.getDefaultBranchFile(p, path)),
    };

    const threshold = input.repoConfig.scoreThreshold;
    const files = await source.listFiles(pr);
    if (files.length === 0) return okResult('No changes to review.', threshold, {});

    // Read only when there is something to floor; a rejection fails the review here, like any source error.
    const floors = parseRepoFile(await source.getDefaultBranchFile(pr, REPO_FILE));
    const teamFileInvalid = floors.invalid;
    if (teamFileInvalid !== null) audit.push({ stage: 'context', action: 'team_file_invalid', subject: REPO_FILE, reason: teamFileInvalid });

    let budget = input.limits.inputTokensPerCall - fixedTokens(deps.contract, pr);
    if (budget <= 0) return failedResult('context', 'budget_too_small', usage, audit, 'ok', threshold);

    const stripped = headerStripCounts(pr);
    for (const subject of ['title', 'description'] as const) {
      if (stripped[subject] > 0) audit.push({ stage: 'context', action: 'control_characters_stripped', subject, reason: String(stripped[subject]) });
    }
    const built = await buildFileContexts(pr, orderByPriority(files), source);
    const attached = attachThreads(built.contexts, input.earlier);
    const withThreads = attached.shown.length > 0;
    if (withThreads) {
      budget = input.limits.inputTokensPerCall - fixedTokens(deps.contract, pr, true);
      if (budget <= 0) return failedResult('context', 'budget_too_small', usage, audit, 'ok', threshold);
    }
    const packed = packBatches(attached.contexts, budget, input.limits.batchesPerReview);
    audit.push(...built.audit, ...attached.audit, ...packed.audit);
    if (packed.batches.length === 0) {
      for (const s of attached.shown) {
        if (packed.notReviewed.some((n) => n.path === s.file)) audit.push({ stage: 'context', action: 'thread_not_shown', subject: s.key, reason: 'file_not_reviewed' });
      }
      const scored = reconcileScores([], built.contexts, new Set(packed.notReviewed.map((n) => n.path)), floors);
      return okResult('No reviewable changes.', threshold, {
        coverage: { reviewed: [], notReviewed: packed.notReviewed }, audit: [...audit, ...scored.audit],
        scores: scored.scores, verdict: verdictOf(scored.scores, threshold), teamFileInvalid,
      });
    }

    stage = 'model';
    const run: Run = {
      contexts: built.contexts, limits: input.limits,
      effort: chooseEffort(pr, files, input.repoConfig), token: deps.token(), pr, deps,
      fileCount: packed.batches.reduce((n, b) => n + b.files.length, 0), batchCount: packed.batches.length, withThreads,
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
    answered = {
      models: distinct(outcomes.flatMap((o) => o.models)), providers: distinct(outcomes.flatMap((o) => o.providers)),
    };
    if (ctl.failed) throw ctl.error;
    const codes = outcomes.flatMap((o) => o.failedCodes);
    const modelState = codes.some((c) => PROVIDER_CODES.has(c)) ? 'error' : 'ok';
    const fatal = codes.find((c) => c === 'auth' || c === 'no_credit');
    const everyBatchFailed = outcomes.every((o) => o.answers.length === 0);
    if (fatal !== undefined || everyBatchFailed) {
      return failedResult('model', fatal ?? codes[0] ?? 'internal_error', usage, audit, modelState, threshold, answered);
    }

    const rec = reconcile(outcomes.flatMap((o) => o.answers), built.contexts);
    audit.push(...rec.audit);
    const notReviewed: NotReviewed[] = [
      ...packed.notReviewed,
      ...outcomes.flatMap((o) => o.failedFiles.map((path): NotReviewed => ({ path, reason: 'batch_failed' }))),
    ];
    const notRead = new Set(notReviewed.map((n) => n.path));
    // `shown` is kept for the verdicts that a later task judges.
    const shown: ShownThread[] = attached.shown;
    for (const s of shown) {
      if (notRead.has(s.file)) audit.push({ stage: 'context', action: 'thread_not_shown', subject: s.key, reason: 'file_not_reviewed' });
    }
    let scoreAnswers = outcomes.flatMap((o) => o.answers);
    if (deps.scorer !== undefined) {
      const reviewed = new Set(outcomes.flatMap((o) => o.reviewed));
      const asked = await askScorer({
        scorer: deps.scorer,
        // The copies the review model was sent, with the paired test or the full file cut where one was.
        contexts: packed.batches.flatMap((b) => b.files).filter((c) => reviewed.has(c.file.path) && c.plan.kind === 'model'),
        pr, token: run.token, summaries: summariesOf(scoreAnswers, built.contexts), log: (entry) => safeLog(deps, entry),
      });
      usage = addUsage(usage, asked.usage);
      audit.push(...asked.audit);
      // A file moved to another directory with no content change keeps the review model's own score.
      const known: ReadonlySet<string> = new Set(built.contexts.map((c) => c.file.path));
      const whole: ReadonlySet<string> = new Set(built.contexts.filter((c) => c.plan.kind === 'model_whole').map((c) => c.file.path));
      const wholeAnswers = scoreAnswers.map((a) => ({
        value: { ...a.value, files: a.value.files.filter((raw) => whole.has(normalizePath(raw.path, known) ?? '')) },
        files: a.files.filter((path) => whole.has(path)),
      }));
      scoreAnswers = [...asked.answers, ...wholeAnswers];
    }
    const scored = reconcileScores(scoreAnswers, built.contexts, notRead, floors);
    audit.push(...scored.audit);
    return okResult(rec.overview, threshold, {
      findings: rec.findings, unplaced: rec.unplaced, beyondDiff: rec.beyondDiff,
      coverage: { reviewed: outcomes.flatMap((o) => o.reviewed), notReviewed },
      usage, ...answered, dependencies: { model: modelState }, audit,
      scores: scored.scores, verdict: verdictOf(scored.scores, threshold), teamFileInvalid,
    });
  } catch (error) {
    let code = 'internal_error';
    if (stage === 'context' && sourceErrors.has(error)) {
      code = error instanceof Error && SOURCE_CODE.test(error.message) ? error.message : 'source_error';
    }
    const name = error instanceof Error ? error.name : 'unknown';
    safeLog(deps, { event: 'internal_error', stage, name });
    return failedResult(stage, code, usage, audit, 'ok', input.repoConfig.scoreThreshold, answered);
  }
}
