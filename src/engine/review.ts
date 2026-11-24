import { buildFileContexts } from './context/build.ts';
import type { FileContext } from './context/build.ts';
import { packBatches } from './context/batches.ts';
import type { Batch } from './context/batches.ts';
import { extensionPart, gatherContext } from './context/extensions.ts';
import type { ExtensionContext } from './context/extensions.ts';
import { changedLines, leftBlocksOf } from './context/increment.ts';
import type { Changed } from './context/increment.ts';
import { askLessons } from './context/lessons.ts';
import type { LessonsContext } from './context/lessons.ts';
import { askMemory, withoutReverted } from './context/memory.ts';
import type { MemoryContext } from './context/memory.ts';
import { renderAnchoredDiff } from './context/diff.ts';
import { orderByPriority } from './context/priority.ts';
import { attachThreads, isDue } from './context/threads.ts';
import { inlineText, stripControl } from './context/untrusted.ts';
import type { ShownThread } from './context/threads.ts';
import { buildMessages, fixedTokens, headerStripCounts } from './context/prompt.ts';
import { MEASURE_TOKEN } from './context/section.ts';
import { callBatch } from './model/call.ts';
import type { BatchAnswer, ToolLoop } from './model/call.ts';
import { TOOL_ROOM_MARGIN_TOKENS, TOOL_ROOM_TOKENS, TOOL_RULES, openTools, toolRoomTokens } from './model/tools.ts';
import type { ReviewTools } from './model/tools.ts';
import type { SubmitReviewArgs } from './model/submit-review.ts';
import { NOTHING_READ, filesToSend } from './plan.ts';
import { inPool } from './pool.ts';
import type { Control } from './pool.ts';
import { readAcceptance, reconcileAcceptance } from './reconcile/acceptance.ts';
import { reconcile } from './reconcile/index.ts';
import { onChangedLine, reconcileMode } from './reconcile/mode.ts';
import { normalizePath } from './reconcile/placement.ts';
import { reconcileScores, verdictOf } from './reconcile/scores.ts';
import { dropDuplicates, reconcileVerdicts } from './reconcile/threads.ts';
import { REPO_FILE, parseRepoFile } from './score/floors.ts';
import { blocksToLookUp, keptScores } from './score/history.ts';
import { shownOf } from './score/shown.ts';
import type { ScoredBy, ScoreEntry, ScoreHistory } from './score/types.ts';
import { askScorer, summariesOf } from './scorer/ask.ts';
import type {
  AcceptanceRow, AuditEntry, ChangedFile, Discussed, EarlierThread, Effort, ExtensionStatus, Finding, LessonsStatus, Memory, MemoryStatus, NotReviewed, PullRequestInfo, RepoConfig, ReviewDeps, ReviewInput, ReviewResult,
  Severity, Side, Source, ToolDefinition, Usage,
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

// The mode a run was given, and the head of the last review it reads on from.
interface Said { mode: ReviewResult['mode']; since?: string }

// A review that did not finish never tells anyone that a pull request needs no person.
function failedResult(
  stage: 'context' | 'model', code: string, usage: Usage, audit: AuditEntry[], model: 'ok' | 'error', threshold: number, due: number, said: Said,
  answered: Answered = noneAnswered(),
): ReviewResult {
  return {
    threadVerdicts: [], threadsDue: due, alreadyDiscussed: [],
    scores: [], verdict: { threshold, needsHuman: true, highest: 100 }, teamFileInvalid: null,
    status: 'failed', failure: { stage, code }, ...said, overview: '', findings: [], unplaced: [], beyondDiff: [],
    coverage: { reviewed: [], notReviewed: [] }, usage, ...answered, dependencies: { model }, audit,
  };
}

function okResult(overview: string, threshold: number, due: number, said: Said, rest: Partial<ReviewResult>): ReviewResult {
  return {
    threadVerdicts: [], threadsDue: due, alreadyDiscussed: [],
    scores: [], verdict: verdictOf([], threshold), teamFileInvalid: null,
    status: 'ok', failure: null, ...said, overview, findings: [], unplaced: [], beyondDiff: [],
    coverage: { reviewed: [], notReviewed: [] }, usage: zeroUsage(), models: [], providers: [], dependencies: { model: 'ok' }, audit: [], ...rest,
  };
}

const distinct = (values: string[]): string[] => [...new Set(values)];

// A major or blocker finding dropped as a duplicate, with the thread that already raised it; a minor one is not kept.
function discussed(f: { path: string; side: Side; line: number; severity: Severity; body: string }, thread: EarlierThread): Discussed[] {
  if (f.severity === 'minor') return [];
  return [{
    path: f.path, side: f.side, line: f.line, severity: f.severity, body: f.body,
    commentId: thread.commentId, resolved: thread.resolved, settled: thread.settled,
  }];
}

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
  lastOverview: string | undefined; // the last review's overview, shown in every call's header; undefined when there is none to show
  extension: ExtensionContext | undefined; // what the context providers gave, as it is shown in every call's header; undefined when nothing is
  withAcceptance: boolean; // the criteria are shown: the run's calls take the tool with rows
  tools: Offered | undefined; // the servers' tools, when the review offers them; undefined when it offers none
  memory: MemoryContext | undefined; // where people stepped in before, as it is shown in every call; undefined when nothing is
  lessons: LessonsContext | undefined; // lessons from earlier reviews, as they are shown in every call; undefined when none are
}

// The tools a review offers, shared by its batches: one count of calls for the whole review (5.4, 12).
interface Offered {
  review: ReviewTools;
  definitions: ToolDefinition[]; // never empty
  system: string;                // the system message of a call that is offered them: the contract, then the rules for tools
  withheld: boolean;             // set once the endpoint refused them: no call is offered them from then on (call 21)
}

// A failing logger must never change a review.
function safeLog(deps: ReviewDeps, entry: Record<string, unknown>): void {
  try {
    deps.log(entry);
  } catch {
    // ignored on purpose
  }
}

// `withTools`: the batch's first call, which is offered the review's tools while they are not withheld. Every
// other call is made as in a review with no server. `given` says whether this one was offered them.
async function oneCall(run: Run, files: FileContext[], firstFileNumber: number, batchIndex: number, withTools = false): Promise<BatchAnswer & { given: boolean }> {
  const batch: Batch = { files, tokens: 0 };
  const offered = withTools && run.tools !== undefined && !run.tools.withheld ? run.tools : undefined;
  const loop: ToolLoop | undefined = offered === undefined ? undefined : {
    definitions: offered.definitions,
    run: (call, open) => offered.review.run(call, run.token, open),
    now: () => run.deps.clock().getTime(),
    room: TOOL_ROOM_TOKENS - TOOL_ROOM_MARGIN_TOKENS,
  };
  const messages = buildMessages({
    contract: offered === undefined ? run.deps.contract : offered.system, pr: run.pr, fileCount: run.fileCount, firstFileNumber, batch,
    batchIndex, batchCount: run.batchCount, token: run.token, ...(run.lastOverview === undefined ? {} : { lastOverview: run.lastOverview }),
    ...(run.extension === undefined ? {} : { extension: run.extension }),
    ...(run.memory === undefined ? {} : { memory: run.memory }),
    ...(run.lessons === undefined ? {} : { lessons: run.lessons }),
  });
  const answer = await callBatch(
    { messages, effort: run.effort, timeoutMs: run.limits.modelTimeoutSeconds * 1000, prPaths: files.map((f) => f.file.path), ...(run.withThreads ? { withThreads: true } : {}),
      ...(run.withAcceptance ? { withAcceptance: true } : {}), ...(run.deps.toolChoice === undefined ? {} : { toolChoice: run.deps.toolChoice }),
      ...(loop === undefined ? {} : { tools: loop }) },
    run.deps.model,
  );
  safeLog(run.deps, {
    event: 'model_call', files: files.length, effort: run.effort, code: answer.ok ? 'ok' : answer.code, usage: answer.usage,
    model: answer.models.at(-1) ?? null, provider: answer.providers.at(-1) ?? null,
    ...(loop === undefined ? {} : { tool_calls: answer.audit.filter((e) => e.stage === 'tools' && e.action === 'tool_call').length }),
  });
  return { ...answer, given: loop !== undefined };
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

  const first = await oneCall(run, batch.files, firstFileNumber, batchIndex, true);
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
      // A first call offered tools that the endpoint refused, and a second try without them that worked: the
      // endpoint is taken to refuse the tools, which are withheld for the rest of the review (call 21).
      if (answer.ok && first.given && first.code === 'provider' && run.tools !== undefined && !run.tools.withheld) {
        run.tools.withheld = true;
        run.tools.review.withhold('error', 'model_refused_tools');
        out.audit.push({ stage: 'model', action: 'tools_refused', subject: 'batch', reason: 'provider' });
      }
    }
    number += part.length;
  }
}

const isWholeScore = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100;

/**
 * Sets on each context what its history, or another pull request, already settles, and shows those hunks as scored.
 * Touches nothing when there is no history and no lookup. A failed lookup is named in the audit and counts as no answer.
 */
async function keepScores(contexts: FileContext[], history: ScoreHistory | null, deps: ReviewDeps): Promise<AuditEntry[]> {
  if (history === null && deps.reusableScores === undefined) return [];
  const audit: AuditEntry[] = [];
  const wanted = blocksToLookUp(contexts, history);
  const reused: Array<{ path: string; hash: string; around: string; entry: ScoreEntry }> = [];
  if (wanted.length > 0 && deps.reusableScores !== undefined) {
    const asked = new Set(wanted.map((w) => `${w.path}\n${w.hash}\n${w.around}`));
    let answer: unknown = [];
    try {
      answer = await deps.reusableScores(wanted);
    } catch (error) {
      const reason = error instanceof Error && SOURCE_CODE.test(error.message) ? error.message : 'internal_error';
      audit.push({ stage: 'context', action: 'reuse_failed', subject: 'scores', reason });
    }
    for (const one of Array.isArray(answer) ? (answer as unknown[]) : []) {
      if (typeof one !== 'object' || one === null) continue;
      const { path, hash, around, entry } = one as { path?: unknown; hash?: unknown; around?: unknown; entry?: { score?: unknown } | null };
      if (typeof path !== 'string' || typeof hash !== 'string' || typeof around !== 'string' || !asked.has(`${path}\n${hash}\n${around}`)) continue;
      if (typeof entry !== 'object' || entry === null || !isWholeScore(entry.score)) continue;
      reused.push({ path, hash, around, entry: entry as ScoreEntry });
    }
  }
  for (const context of contexts) {
    const kept = keptScores(context, history, reused.filter((r) => r.path === context.file.path));
    if (kept === null) continue;
    context.kept = kept;
    if (kept.scoredHunks.size > 0) context.diffText = renderAnchoredDiff(context.hunks, kept.scoredHunks);
  }
  return audit;
}

type Content = (path: string, sha: string) => Promise<string | null>;
const everything = (): Changed => ({ all: true, right: [], leftBlocks: [] });
const errorCode = (error: unknown): string => (error instanceof Error && SOURCE_CODE.test(error.message) ? error.message : 'source_error');

/** What of a file changed since a published review last read it. A read that rejects is passed on. */
async function changedSince(c: FileContext, headSha: string, content: Content): Promise<Changed> {
  const readAt = c.kept?.readAt ?? null;
  if (readAt === null) return everything();
  if (readAt.head === headSha) return { all: false, right: [], leftBlocks: [] };
  const leftBlocks = leftBlocksOf(c.blocks, readAt.hashes);
  if (c.file.status === 'removed') return { all: false, right: [], leftBlocks };
  const now = await content(c.file.path, headSha);
  if (now === null) return everything();
  let before = await content(c.file.path, readAt.head);
  if (before === null && c.file.previousPath !== null) before = await content(c.file.previousPath, readAt.head);
  if (before === null) return everything();
  const right = changedLines(before.replaceAll('\r\n', '\n'), now.replaceAll('\r\n', '\n'));
  return right === null ? everything() : { all: false, right, leftBlocks };
}

/**
 * In a full review of a later head: how many placed blocker and major findings sit on a line unchanged since their file was last read.
 * A read that rejects leaves the count out and is named in the audit: the review is already paid for.
 */
async function countUnchanged(findings: Finding[], contexts: FileContext[], headSha: string, content: Content, audit: AuditEntry[]): Promise<number | undefined> {
  const blocking = findings.filter((f) => f.severity !== 'minor');
  const known = new Map<string, { changed: Changed; blocks: FileContext['blocks'] }>();
  for (const path of distinct(blocking.map((f) => f.path))) {
    const c = contexts.find((one) => one.file.path === path && one.plan.kind === 'model');
    if (c === undefined) continue;
    try {
      known.set(path, { changed: await changedSince(c, headSha, content), blocks: c.blocks });
    } catch (error) {
      audit.push({ stage: 'reconcile', action: 'unchanged_count_failed', subject: path, reason: errorCode(error) });
      return undefined;
    }
  }
  return blocking.filter((f) => {
    const one = known.get(f.path);
    // The same test as an incremental review's: the line it was placed on, or the line the model named.
    return one !== undefined && !onChangedLine(f, one.changed, one.blocks);
  }).length;
}

type Packing = ReturnType<typeof packBatches>;

/**
 * Whether what the providers gave is shown, and the packing the review then uses (5.3, call 8). It is shown only
 * when packing the files with it counted cuts nothing more and leaves nothing more unreviewed than packing them without it.
 */
function chooseRoom(
  extension: ExtensionContext, first: Packing, budgetWith: (shown: ExtensionContext) => number, pack: (budget: number) => Packing,
): { packed: Packing; shown: ExtensionContext | undefined; audit: AuditEntry[] } {
  if (first.batches.length === 0) return { packed: first, shown: undefined, audit: [] };
  const whole = extension;
  const candidates = [whole, { ...extension, blocks: [] }];   // then the criteria alone
  const same = JSON.stringify([first.notReviewed, first.audit]);
  let packed = first;
  let shown: ExtensionContext | undefined;
  for (const candidate of candidates) {
    if (extensionPart(candidate, MEASURE_TOKEN) === '') continue;   // a candidate that shows nothing is passed over
    const budget = budgetWith(candidate);
    if (budget <= 0) continue;
    const again = pack(budget);
    if (JSON.stringify([again.notReviewed, again.audit]) === same) {
      packed = again;
      shown = candidate;
      break;
    }
  }
  const audit: AuditEntry[] = [];
  if (extensionPart(whole, MEASURE_TOKEN) !== '' && shown !== whole) {
    audit.push({ stage: 'context', action: 'extension_context_cut', subject: shown === undefined ? 'extensions' : 'texts', reason: 'over_call_budget' });
  }
  return { packed, shown, audit };
}

// What a review asked of its dependencies: the providers' statuses once they are asked, the servers' tools once they are
// opened, and how memory did once it was asked or passed over.
interface Asked { statuses?: Record<string, ExtensionStatus>; tools?: ReviewTools; memory?: MemoryStatus }

const memorySkipped = (code: string): MemoryStatus => ({ status: 'skipped', code, lines: 0 });

/**
 * Asks memory once, for the files of the first packing, and shows it only when packing the files with it counted cuts
 * nothing more and leaves nothing more unreviewed than the first packing (5.3, call 23). Never rejects, never fails a review.
 */
async function chooseMemory(
  deps: ReviewDeps, first: Packing, asOf: Date, budgetWith: (shown: MemoryContext) => number, pack: (budget: number) => Packing,
): Promise<{ packed: Packing; shown: MemoryContext | undefined; status: MemoryStatus | undefined; audit: AuditEntry[] }> {
  const memory = deps.memory;
  if (memory === undefined) return { packed: first, shown: undefined, status: undefined, audit: [] };
  // With a second scorer the review model gives no block scores: memory could move only findings (call 4).
  if (deps.scorer !== undefined) return { packed: first, shown: undefined, status: memorySkipped('second_scorer'), audit: [] };
  if (first.batches.length === 0) return { packed: first, shown: undefined, status: memorySkipped('no_model_call'), audit: [] };
  const files = first.batches.flatMap((b) => b.files).map((c) => ({ path: c.file.path, previousPath: c.file.previousPath }));
  let asked: Awaited<ReturnType<typeof askMemory>>;
  try {
    asked = await askMemory(memory, files, asOf);
  } catch {
    // askMemory never rejects; guarded all the same, as the providers' call is.
    asked = { context: undefined, status: { status: 'error', code: 'lookup_failed', lines: 0 }, audit: [{ stage: 'context', action: 'memory_failed', subject: 'memory', reason: 'lookup_failed' }] };
  }
  const audit = [...asked.audit];
  const context = asked.context;
  if (context === undefined) return { packed: first, shown: undefined, status: asked.status, audit };
  const budget = budgetWith(context);
  const again = budget > 0 ? pack(budget) : null;
  if (again === null || JSON.stringify([again.notReviewed, again.audit]) !== JSON.stringify([first.notReviewed, first.audit])) {
    // Reverted lines are the first to give way for room: the same memory without them is tried before it gives up (call 14).
    const smaller = context.lines.some((l) => l.reverted === true) ? withoutReverted(context) : undefined;
    if (smaller !== undefined) {
      const less = budgetWith(smaller);
      const retry = less > 0 ? pack(less) : null;
      if (retry !== null && JSON.stringify([retry.notReviewed, retry.audit]) === JSON.stringify([first.notReviewed, first.audit])) {
        audit.push({ stage: 'context', action: 'memory_cut', subject: 'reverted', reason: 'over_call_budget' });
        for (const line of smaller.lines) {
          audit.push({ stage: 'context', action: 'memory_shown', subject: inlineText(line.ref), reason: line.near ? 'near' : 'changed' });
        }
        return { packed: retry, shown: smaller, status: { status: 'ok', code: 'ok', lines: smaller.lines.length }, audit };
      }
    }
    audit.push({ stage: 'context', action: 'memory_cut', subject: 'memory', reason: 'over_call_budget' });
    return { packed: first, shown: undefined, status: memorySkipped('no_room'), audit };
  }
  for (const line of context.lines) {
    audit.push({ stage: 'context', action: 'memory_shown', subject: inlineText(line.ref), reason: line.near ? 'near' : 'changed' });
  }
  return { packed: again, shown: context, status: asked.status, audit };
}

/**
 * Asks for lessons once, for the files of the first packing, after memory, and shows them only when packing the files with
 * them and the memory shown counted cuts nothing more and leaves nothing more unreviewed than the packing memory chose
 * (5.3, call 19). With a second scorer too (call 20). Never rejects, never fails a review.
 */
async function chooseLessons(
  deps: ReviewDeps, first: Packing, chosen: Packing, asOf: Date, budgetWith: (shown: LessonsContext) => number, pack: (budget: number) => Packing,
): Promise<{ packed: Packing; shown: LessonsContext | undefined; status: LessonsStatus | undefined; audit: AuditEntry[] }> {
  const memory = deps.memory;
  if (memory === undefined) return { packed: chosen, shown: undefined, status: undefined, audit: [] };
  const failed = (): { packed: Packing; shown: undefined; status: LessonsStatus; audit: AuditEntry[] } => ({
    packed: chosen, shown: undefined, status: { status: 'error', code: 'lookup_failed', shown: 0 },
    audit: [{ stage: 'context', action: 'lessons_failed', subject: 'lessons', reason: 'lookup_failed' }],
  });
  // Read once, inside a guard: a getter may throw, or answer otherwise the second time.
  let lessons: unknown;
  try {
    lessons = memory.lessons;
  } catch {
    return failed();
  }
  if (typeof lessons !== 'function') return { packed: chosen, shown: undefined, status: undefined, audit: [] };
  const ask = lessons as NonNullable<Memory['lessons']>;
  // What was read is handed on, so that the lookup does not read the memory's property again; it is called on the memory.
  const once: Memory = { blocks: () => Promise.reject(new Error('not_asked')), lessons: (files, asOf, signal) => ask.call(memory, files, asOf, signal) };
  if (first.batches.length === 0) return { packed: chosen, shown: undefined, status: { status: 'skipped', code: 'no_model_call', shown: 0 }, audit: [] };
  const files = first.batches.flatMap((b) => b.files).map((c) => ({ path: c.file.path, previousPath: c.file.previousPath }));
  let asked: Awaited<ReturnType<typeof askLessons>>;
  try {
    asked = await askLessons(once, files, asOf);
  } catch {
    // askLessons never rejects; guarded all the same, as memory's lookup is.
    asked = { context: undefined, status: { status: 'error', code: 'lookup_failed', shown: 0 }, audit: [{ stage: 'context', action: 'lessons_failed', subject: 'lessons', reason: 'lookup_failed' }] };
  }
  const audit = [...asked.audit];
  const context = asked.context;
  if (context === undefined) return { packed: chosen, shown: undefined, status: asked.status, audit };
  const budget = budgetWith(context);
  const again = budget > 0 ? pack(budget) : null;
  if (again === null || JSON.stringify([again.notReviewed, again.audit]) !== JSON.stringify([chosen.notReviewed, chosen.audit])) {
    audit.push({ stage: 'context', action: 'lessons_cut', subject: 'lessons', reason: 'over_call_budget' });
    return { packed: chosen, shown: undefined, status: { status: 'skipped', code: 'no_room', shown: 0 }, audit };
  }
  for (const one of context.lessons) audit.push({ stage: 'context', action: 'lesson_shown', subject: inlineText(one.ref), reason: one.why });
  return { packed: again, shown: context, status: asked.status, audit };
}

export async function review(input: ReviewInput, deps: ReviewDeps): Promise<ReviewResult> {
  // Set once the providers are asked, or the servers opened: every result returned from then on says how each of them did.
  const asked: Asked = {};
  let result: ReviewResult;
  try {
    result = await reviewOnce(input, deps, asked);
  } finally {
    // Every session is ended before the review returns, whatever happened; a close that fails changes nothing.
    if (asked.tools !== undefined) {
      try {
        await asked.tools.close();
      } catch {
        // ignored on purpose: close never rejects, and the review is not failed if it did
      }
    }
  }
  if (asked.statuses !== undefined) result = { ...result, dependencies: { ...result.dependencies, extensions: asked.statuses } };
  // Read once the sessions are closed: a call ended by the close changes no status.
  if (asked.tools !== undefined) result = { ...result, dependencies: { ...result.dependencies, mcp: asked.tools.statuses() } };
  if (asked.memory !== undefined) result = { ...result, dependencies: { ...result.dependencies, memory: asked.memory } };
  return result;
}

async function reviewOnce(input: ReviewInput, deps: ReviewDeps, asked: Asked): Promise<ReviewResult> {
  let stage: 'context' | 'model' = 'context';
  const sourceErrors = new Set<unknown>(); // what the source rejected with; a caught probe failure is not fatal
  let usage = zeroUsage();
  let answered = noneAnswered();
  const audit: AuditEntry[] = [];
  let due = 0;
  const mode = input.mode ?? 'full';
  // A stored history may be old: a last review whose head or overview is not text reads as none.
  const last = mode === 'full' ? null : (input.history?.lastReview ?? null);
  const said: Said = typeof last?.head === 'string' ? { mode, since: last.head } : { mode };
  // An overview with nothing left once the characters nobody can see are stripped is not shown.
  const lastText = typeof last?.overview === 'string' ? stripControl(last.overview).text.trim() : '';
  const lastOverview = lastText !== '' && lastText !== NOTHING_READ ? last!.overview : undefined;
  try {
    // The rows of the newest published review that has any, each checked: a stored row may be old or damaged.
    const earlierRows = readAcceptance(input.earlierAcceptance ?? []);
    // Every thread the run owes a verdict, whether or not its file is shown.
    due = (input.earlier?.threads ?? []).filter(isDue).length;
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
    // Who gives the block scores of this run; a moved file's whole-file score is the review model's either way.
    const by: ScoredBy = deps.scorer !== undefined ? 'scorer' : 'model';
    const files = await source.listFiles(pr);
    if (files.length === 0) return okResult('No changes to review.', threshold, due, said, {});

    // Asked once for the whole review, before anything is packed; a provider never fails the review.
    let extension: ExtensionContext | undefined;
    const providers = deps.contextProviders ?? [];
    if (providers.length > 0) {
      const gathered = await gatherContext(providers, pr);
      asked.statuses = gathered.statuses;
      audit.push(...gathered.audit);
      extension = gathered.context;
      // In an incremental review and a re-check the model is told the status each criterion was left with, never the note.
      if (mode !== 'full' && extension.criteria.length > 0) {
        extension = { ...extension, lastStatus: extension.criteria.map((c) => earlierRows.find((r) => r.criterion === c && r.from !== 'none')?.status ?? null) };
      }
    }
    // One row for each criterion, whether or not the criteria were shown; none when there is no criterion.
    const criteria = extension?.criteria ?? [];
    const rowsOf = (answers: Array<{ value: SubmitReviewArgs }>): { acceptance?: AcceptanceRow[] } => {
      if (criteria.length === 0) return {};
      const rows = reconcileAcceptance(answers, criteria, earlierRows, mode !== 'full');
      audit.push(...rows.audit);
      return { acceptance: rows.rows };
    };

    // Read only when there is something to floor; a rejection fails the review here, like any source error.
    const floors = parseRepoFile(await source.getDefaultBranchFile(pr, REPO_FILE));
    const teamFileInvalid = floors.invalid;
    if (teamFileInvalid !== null) audit.push({ stage: 'context', action: 'team_file_invalid', subject: REPO_FILE, reason: teamFileInvalid });

    let budget = input.limits.inputTokensPerCall - fixedTokens(deps.contract, pr, false, lastOverview);
    if (budget <= 0) return failedResult('context', 'budget_too_small', usage, audit, 'ok', threshold, due, said);

    const stripped = headerStripCounts(pr);
    for (const subject of ['title', 'description'] as const) {
      if (stripped[subject] > 0) audit.push({ stage: 'context', action: 'control_characters_stripped', subject, reason: String(stripped[subject]) });
    }
    const built = await buildFileContexts(pr, orderByPriority(files), source);
    // Before the threads are attached, so that the copies attachThreads makes carry what is kept.
    const reuseAudit = await keepScores(built.contexts, input.history ?? null, deps);
    const attached = attachThreads(built.contexts, input.earlier);
    // What an earlier review covers is not sent: it is not a file that was not reviewed, and it is scored from what it keeps.
    const plan = filesToSend(attached.contexts, mode);
    const leftOutPaths = new Set<string>();
    const leaveOut = (c: FileContext): AuditEntry[] => {
      leftOutPaths.add(c.file.path);
      return [
        { stage: 'context', action: 'not_sent', subject: c.file.path, reason: 'covered' },
        ...(c.threads ?? []).map((t): AuditEntry => ({ stage: 'context', action: 'thread_not_shown', subject: t.key, reason: 'file_covered' })),
      ];
    };
    const leftOutAudit = plan.leftOut.flatMap(leaveOut);
    // Before packing, so that the size of a file counts its line of what changed; a read that rejects fails the review here.
    if (mode !== 'full') {
      for (const c of plan.send) if (c.plan.kind === 'model') c.changed = await changedSince(c, pr.headSha, built.content);
    }
    let shown: ShownThread[] = attached.shown.filter((s) => !leftOutPaths.has(s.file));
    const withThreads = shown.length > 0;
    if (withThreads) {
      budget = input.limits.inputTokensPerCall - fixedTokens(deps.contract, pr, true, lastOverview);
      if (budget <= 0) return failedResult('context', 'budget_too_small', usage, audit, 'ok', threshold, due, said);
    }
    const firstPacking = packBatches(plan.send, budget, input.limits.batchesPerReview);
    // Memory is fitted before extension context and the tools, which then count it (5.3, call 23).
    const remembered = await chooseMemory(
      deps, firstPacking, input.asOf,
      (shown) => input.limits.inputTokensPerCall - fixedTokens(deps.contract, pr, withThreads, lastOverview, undefined, shown),
      (b) => packBatches(plan.send, b, input.limits.batchesPerReview),
    );
    if (remembered.status !== undefined) asked.memory = remembered.status;
    // Lessons are fitted after memory, whatever it decided, and before extension context and the tools, which then count them (call 19).
    const taught = await chooseLessons(
      deps, firstPacking, remembered.packed, input.asOf,
      (shown) => input.limits.inputTokensPerCall - fixedTokens(deps.contract, pr, withThreads, lastOverview, undefined, remembered.shown, shown),
      (b) => packBatches(plan.send, b, input.limits.batchesPerReview),
    );
    if (taught.status !== undefined && asked.memory !== undefined) asked.memory = { ...asked.memory, lessons: taught.status };
    const room = extension === undefined
      ? { packed: taught.packed, shown: undefined, audit: [] }
      : chooseRoom(
        extension, taught.packed,
        (shown) => input.limits.inputTokensPerCall - fixedTokens(deps.contract, pr, withThreads, lastOverview, shown, remembered.shown, taught.shown),
        (b) => packBatches(plan.send, b, input.limits.batchesPerReview),
      );
    let packed = room.packed;
    // The servers are opened once for the review, only when it will call the model. Their tools are offered only
    // when their definitions and the room for what the open turns append cost the files nothing (5.3, call 14).
    const toolsAudit: AuditEntry[] = [];
    let offered: Offered | undefined;
    const servers = deps.mcpServers ?? [];
    if (servers.length > 0 && packed.batches.length > 0) {
      const opened = await openTools(servers, pr);
      asked.tools = opened;
      toolsAudit.push(...opened.audit);
      if (opened.definitions.length > 0) {
        const system = `${deps.contract}\n\n${TOOL_RULES}`;
        const withTools = input.limits.inputTokensPerCall - fixedTokens(system, pr, withThreads, lastOverview, room.shown, remembered.shown, taught.shown) - toolRoomTokens(opened.definitions);
        const again = withTools > 0 ? packBatches(plan.send, withTools, input.limits.batchesPerReview) : null;
        if (again !== null && JSON.stringify([again.notReviewed, again.audit]) === JSON.stringify([packed.notReviewed, packed.audit])) {
          packed = again;
          offered = { review: opened, definitions: opened.definitions, system, withheld: false };
        } else {
          opened.withhold('skipped', 'no_room');
          toolsAudit.push({ stage: 'context', action: 'tools_cut', subject: 'tools', reason: 'over_call_budget' });
        }
      }
      // With no tool to call, the sessions are ended now, not after the review: the statuses are final. The close in
      // `review`'s finally then has nothing left to end.
      if (offered === undefined) await opened.close();
    }
    audit.push(...built.audit, ...reuseAudit, ...attached.audit, ...leftOutAudit, ...packed.audit, ...remembered.audit, ...taught.audit, ...room.audit, ...toolsAudit);
    // A covered file that found no room was read, as it is, by an earlier review: it is left out too.
    const roomless = plan.send.filter((c) => c.kept?.covered === true && packed.notReviewed.some((n) => n.path === c.file.path && n.reason === 'over_batch_limit'));
    audit.push(...roomless.flatMap(leaveOut));
    const notSent: NotReviewed[] = packed.notReviewed.filter((n) => !leftOutPaths.has(n.path));
    shown = shown.filter((s) => !leftOutPaths.has(s.file));
    if (packed.batches.length === 0) {
      for (const s of shown) {
        if (notSent.some((n) => n.path === s.file)) audit.push({ stage: 'context', action: 'thread_not_shown', subject: s.key, reason: 'file_not_reviewed' });
      }
      const scored = reconcileScores([], built.contexts, new Set(notSent.map((n) => n.path)), floors, by);
      const rows = rowsOf([]);
      const result = okResult(mode === 'full' ? 'No reviewable changes.' : NOTHING_READ, threshold, due, said, {
        ...rows,
        coverage: { reviewed: [], notReviewed: notSent }, audit: [...audit, ...scored.audit],
        scores: scored.scores, verdict: verdictOf(scored.scores, threshold), teamFileInvalid,
      });
      if (mode === 'full' || due > 0) return result;
      // Nothing new: the review would tell a person what the newest published one already tells.
      const told = shownOf(result);
      return told !== null && told === input.history?.shown ? { ...result, nothingToDo: true } : result;
    }

    stage = 'model';
    const run: Run = {
      contexts: built.contexts, limits: input.limits,
      effort: chooseEffort(pr, files, input.repoConfig), token: deps.token(), pr, deps,
      fileCount: packed.batches.reduce((n, b) => n + b.files.length, 0), batchCount: packed.batches.length, withThreads, lastOverview,
      extension: room.shown, withAcceptance: (room.shown?.criteria.length ?? 0) > 0, tools: offered, memory: remembered.shown,
      lessons: taught.shown,
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
      return failedResult('model', fatal ?? codes[0] ?? 'internal_error', usage, audit, modelState, threshold, due, said, answered);
    }

    const rec = reconcile(outcomes.flatMap((o) => o.answers), built.contexts);
    audit.push(...rec.audit);
    const notReviewed: NotReviewed[] = [
      ...notSent,
      ...outcomes.flatMap((o) => o.failedFiles.map((path): NotReviewed => ({ path, reason: 'batch_failed' }))),
    ];
    const notRead = new Set(notReviewed.map((n) => n.path));
    for (const s of shown) {
      if (notRead.has(s.file)) audit.push({ stage: 'context', action: 'thread_not_shown', subject: s.key, reason: 'file_not_reviewed' });
    }
    const judged = reconcileVerdicts(outcomes.flatMap((o) => o.answers), shown, built.contexts, pr.headSha);
    audit.push(...judged.audit);
    const earlierThreads = input.earlier?.threads ?? [];
    const placed = dropDuplicates(rec.findings, earlierThreads, judged.verdicts, files);
    const away = dropDuplicates(rec.unplaced, earlierThreads, judged.verdicts, files);
    audit.push(...placed.audit, ...away.audit);
    const alreadyDiscussed = [...placed.dropped, ...away.dropped].flatMap(({ finding, thread }) => discussed(finding, thread));
    let findings = placed.kept;
    let byMode: { unchanged: Finding[] } | { blockingOnUnchanged: number } | Record<string, never> = {};
    if (mode !== 'full') {
      const sent = new Map(plan.send.map((c) => [c.file.path, c]));
      const moded = reconcileMode(placed.kept, (path) => sent.get(path)?.changed ?? null, (path) => sent.get(path)?.blocks ?? []);
      audit.push(...moded.audit);
      findings = moded.kept;
      byMode = { unchanged: moded.unchanged };
    } else if ((input.history?.lastReview ?? null) !== null) {
      const count = await countUnchanged(placed.kept, built.contexts, pr.headSha, built.content, audit);
      if (count !== undefined) byMode = { blockingOnUnchanged: count };
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
    const scored = reconcileScores(scoreAnswers, built.contexts, notRead, floors, by);
    audit.push(...scored.audit);
    const rows = rowsOf(outcomes.flatMap((o) => o.answers));
    return okResult(rec.overview, threshold, due, said, {
      ...rows,
      findings, ...byMode, unplaced: away.kept, beyondDiff: rec.beyondDiff,
      threadVerdicts: judged.verdicts, alreadyDiscussed,
      coverage: { reviewed: outcomes.flatMap((o) => o.reviewed), notReviewed },
      usage, ...answered, dependencies: { model: modelState }, audit,
      scores: scored.scores, verdict: verdictOf(scored.scores, threshold), teamFileInvalid,
    });
  } catch (error) {
    let code = 'internal_error';
    if (stage === 'context' && sourceErrors.has(error)) code = errorCode(error);
    let name = 'unknown';
    try {
      // An error whose name cannot be read is named unknown.
      if (error instanceof Error) name = error.name;
    } catch {
      name = 'unknown';
    }
    safeLog(deps, { event: 'internal_error', stage, name });
    return failedResult(stage, code, usage, audit, 'ok', input.repoConfig.scoreThreshold, due, said, answered);
  }
}
