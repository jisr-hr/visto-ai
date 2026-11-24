// src/engine/types.ts
import type { ChangedFile, PullRequestInfo, Side, Source } from '../forge/types.ts';
import type { FileScore, ScoreEntry, ScoreHistory, Verdict } from './score/types.ts';

export type Severity = 'blocker' | 'major' | 'minor';
export interface AuditEntry { stage: string; action: string; subject: string; reason: string }
export interface Usage { calls: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }

export interface ToolCall { id: string; name: string; arguments: string | null }   // arguments: the JSON text as the model wrote it; null when the endpoint gave no text
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;                  // on a 'tool' message: the id of the call it answers
  wire?: Record<string, unknown>;       // on an 'assistant' message that called tools: the message as the endpoint gave it; it is sent in place of this one
}
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type Effort = 'default' | 'elevated';
export interface ModelRequest { messages: ChatMessage[]; tools: ToolDefinition[]; forcedTool: string | null; effort: Effort; timeoutMs: number }   // forcedTool null: the model chooses
export interface ModelResponse {
  toolName: string | null; toolArguments: string | null; text: string | null; model: string; provider: string | null; usage: Usage;   // as today
  toolCalls?: ToolCall[];                   // the calls of the answer that have a name and an id of their own, in order; absent: none
  assistant?: Record<string, unknown>;      // present with toolCalls: the answer's message, to be sent back unchanged before its calls are answered
}
export interface ModelClient { complete(request: ModelRequest): Promise<ModelResponse> }

export interface Limits { inputTokensPerCall: number; batchesPerReview: number; modelTimeoutSeconds: number }
export interface RepoConfig { primaryBranches: string[]; scoreThreshold: number }

export interface EarlierReply { author: string; kind: 'person' | 'bot' | 'app'; body: string }
export interface EarlierThread {
  id: string;                         // the git service's id of the thread
  commentId: string;                  // its first comment
  path: string; side: Side; line: number | null;   // where it sits now
  severity: Severity; quote: string;  // of the finding that opened it
  body: string;                       // the first comment's text, as the git service has it
  openedAt: { head: string; diffHash: string | null };   // the head of the run that posted it, and the hash of its file's diff in that run
  resolved: boolean;
  settled: boolean;                   // resolved in a way that needs no further verdict
  lastVerdict: 'fixed' | 'answered' | 'open' | null;     // the newest verdict an earlier published run kept
  replies: EarlierReply[];            // oldest first
  closedForApproval?: boolean;        // closed under the thread rule before this run; absent with approval off
}
export interface EarlierState { head: string; threads: EarlierThread[] }   // head: of the last published review
export interface ThreadVerdict {
  threadId: string; commentId: string;
  verdict: 'fixed' | 'answered' | 'open';
  reply: string;              // the model's reason as one line: every run of white space made one space, trimmed, at most 600 characters; '' when it gave none
  fileChanged: boolean;       // for `fixed`: the thread's file has another diff than when the thread was opened
  replies?: number;           // how many replies the thread had when it was judged; absent on a verdict stored before this was recorded
}
export interface Discussed {
  path: string; side: Side; line: number; severity: 'blocker' | 'major'; body: string;
  commentId: string;                    // the first comment of the thread that already raised it
  resolved: boolean; settled: boolean;  // that thread, at the moment the finding was dropped
  closedForApproval?: boolean;          // that thread's, when the finding was dropped
}

export type AcceptanceStatus = 'met' | 'not_met' | 'not_verified';
export interface AcceptanceRow {
  criterion: string;                       // the criterion's text, as the model was shown it
  status: AcceptanceStatus;
  note: string;                            // the model's reason on one line, at most 300 characters; '' when there is none
  from: 'review' | 'earlier' | 'none';     // judged by this run; kept from an earlier review; judged by neither
}

export interface ReviewInput {
  pullRequest: PullRequestInfo;
  trigger: 'automatic' | 'manual';
  repoConfig: RepoConfig;
  limits: Limits;
  asOf: Date;
  earlier: EarlierState | null; // what the last published review left on the pull request; null for a first review
  history?: ScoreHistory | null;   // the scores of the pull request's earlier runs; absent reads as none
  mode?: 'full' | 'incremental' | 'recheck';   // absent reads as 'full'
  earlierAcceptance?: AcceptanceRow[];   // the rows of the newest published review that has any; absent reads as none
}
export interface ScoreRequest { text: string; blocks: string[] } // blocks: ids to score, in diff order; never empty
export interface ScoredItem { score: number; category: string; reason: string }
export interface ScoreAnswer {
  blocks: Record<string, ScoredItem>; // by block id; a block the scorer could not answer for is absent
  usage: Usage;
  failure: string | null;             // a short code when some request for this file failed; what was answered before it is kept
}
export interface Scorer { score(request: ScoreRequest): Promise<ScoreAnswer> }

export type ExtensionState = 'ok' | 'empty' | 'skipped' | 'error';
export interface ExtensionStatus { status: ExtensionState; code: string } // code: a short code
/** What a context provider answers. Nothing of it is trusted: the engine checks it field by field. */
export interface ContextAnswer {
  status: ExtensionState;
  code?: string;          // a short code that says why, such as no_ticket
  label?: string;         // names the text for the model, such as "ticket SHOP-12"
  text?: string;
  criteria?: string[];    // acceptance criteria, one for each entry
}
export interface ContextProvider {
  name: string;           // the module's name
  provide(pr: PullRequestInfo, signal: AbortSignal): Promise<ContextAnswer>;
}

/** One tool as a server lists it. Only `name` is checked by the client; the rest is as the server sent it. */
export interface McpTool { name: string; description?: unknown; inputSchema?: unknown }
/** What a call gave: the `result` of tools/call as the server sent it, or the short code of a tool error. */
export type McpAnswer = { ok: true; result: unknown } | { ok: false; code: string };
export interface McpSession {
  tools: McpTool[];                                                                                 // every tool the server listed
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpAnswer>;      // never rejects
  close(signal: AbortSignal): Promise<void>;                                                        // never rejects
}
export interface McpServer {
  name: string;                                    // the config's name
  tools: string[];                                 // the names the model may be offered, in the config's order
  open(signal: AbortSignal): Promise<McpSession>;  // rejects with Error(<short code>)
}
export type McpState = 'ok' | 'skipped' | 'error';
export interface McpStatus { status: McpState; code: string; calls: number }   // code: a short code; calls: the calls sent to the server in this review

/** One line of the pull request block: one record, as the model is shown it. It has no field for what a person wrote. The engine checks every field. */
export interface MemoryLine {
  ref: string;               // the record's source reference, for the audit; never shown to the model
  near: boolean;             // false: on a file the run sends; true: on a file near one
  path: string;              // the record's own file
  day: string;               // YYYY-MM-DD, UTC: the day the record was made
  category: string | null;   // the kind of change the review had given that code; null when it had given none
  missed: boolean;           // the review had left that code below the threshold
  // The line stands for a pull request that changed this file and was reverted; absent on every other line. Such a line has near false, category null and missed false.
  reverted?: true;
}
export interface MemoryCount { name: string; pullRequests: number }
export interface MemoryBlocks {
  repository: { directories: MemoryCount[]; categories: MemoryCount[] };   // both empty when `pullRequest` is
  pullRequest: MemoryLine[];                                               // in the order shown
  // What was left out: by the fixed sizes; `names`, because a path or a directory is not printable; `records`, because the repository has more records than are read.
  cut: { directories: number; categories: number; lines: number; names: number; records: boolean };
}
/** One lesson, as a memory hands it over. Its text is words a model wrote from a person's reply: the engine cleans it, checks it and shows it only between data markers. */
export interface MemoryLesson {
  ref: string;                             // the record's source reference, for the audit; never shown to the model
  why: 'file' | 'directory' | 'type';      // what it shares with the files under review
  path: string;                            // the file the finding was on
  day: string;                             // YYYY-MM-DD, UTC: the day the lesson is live from
  text: string;
}
export interface MemoryLessons { lessons: MemoryLesson[]; cut: { lessons: number; names: number; records: boolean } }   // in the order shown
export interface Memory {
  /** The two blocks for these files as of that time (7.4). Reads only. May reject or never settle: the engine bounds it. */
  blocks(files: Array<{ path: string; previousPath: string | null }>, asOf: Date, signal: AbortSignal): Promise<MemoryBlocks>;
  /** The lessons for these files as of that time (7.4). Absent: the memory has no lessons, and a review is what it was. Reads only. May reject or never settle. */
  lessons?(files: Array<{ path: string; previousPath: string | null }>, asOf: Date, signal: AbortSignal): Promise<MemoryLessons>;
}
export type MemoryState = 'ok' | 'empty' | 'skipped' | 'error';
export interface LessonsStatus { status: MemoryState; code: string; shown: number }   // code: a short code; shown: the lessons shown
// lessons: absent when the memory has no `lessons`, and when the review ended before they were asked.
export interface MemoryStatus { status: MemoryState; code: string; lines: number; lessons?: LessonsStatus }   // code: a short code; lines: the lines shown

export interface ReviewDeps {
  source: Source;
  model: ModelClient;
  contract: string;           // the rules the review model is given; with a scorer, the contract that asks for no block scores
  clock: () => Date;
  token: () => string;        // fresh random text for data markers, 16 hex characters
  log: (entry: Record<string, unknown>) => void;
  scorer?: Scorer;            // scores the blocks in place of the review model, when set
  /** The highest scores other pull requests of the repository stored for these blocks, among the same lines, in the last 30 days. May reject. */
  reusableScores?: (blocks: Array<{ path: string; hash: string; around: string }>) => Promise<Array<{ path: string; hash: string; around: string; entry: ScoreEntry }>>;
  contextProviders?: ContextProvider[]; // asked once for each review; absent reads as none
  toolChoice?: 'forced' | 'auto';       // how the model is made to call submit_review; absent reads as 'forced'
  mcpServers?: McpServer[];             // opened once for each review; absent reads as none
  memory?: Memory;                      // where people stepped in before; absent: the review has no memory, and is what it was
}

export interface RawFinding { path: string; side: Side; line: number; severity: Severity; body: string; quote: string; beyond_diff: boolean }
export interface Finding { path: string; side: Side; line: number; severity: Severity; body: string; quote: string; requestedLine: number | null }
export type UnplacedReason = 'file_has_no_patch' | 'line_not_in_diff';
export interface UnplacedFinding { path: string; side: Side; line: number; severity: Severity; body: string; quote: string; reason: UnplacedReason }
export type NotReviewedReason = 'no_diff' | 'too_large' | 'over_batch_limit' | 'batch_failed';
export interface NotReviewed { path: string; reason: NotReviewedReason }

export interface ReviewResult {
  status: 'ok' | 'failed';
  failure: { stage: 'context' | 'model'; code: string } | null;
  mode: 'full' | 'incremental' | 'recheck';
  since?: string;             // the head of the last review this run reads on from; absent in a full review, or with no last review
  overview: string;
  findings: Finding[];
  unplaced: UnplacedFinding[];
  beyondDiff: RawFinding[];
  coverage: { reviewed: string[]; notReviewed: NotReviewed[] };
  usage: Usage;
  models: string[];           // models that answered, distinct, in first-seen order
  providers: string[];        // upstream providers that answered, distinct, in first-seen order
  // extensions: absent when no provider was asked; mcp: absent when no server was considered; memory: absent when no memory was given, and when the review ended before it was asked
  dependencies: { model: 'ok' | 'error'; extensions?: Record<string, ExtensionStatus>; mcp?: Record<string, McpStatus>; memory?: MemoryStatus };
  audit: AuditEntry[];
  scores: FileScore[];        // one per changed file; empty when the review failed
  verdict: Verdict;
  teamFileInvalid: string | null; // why the repository's .visto-ai.yml cannot be used; null when it can, or on a failed review
  // Each optional because a result stored before these existed has none: read as empty, or 0. The engine always sets them.
  threadVerdicts?: ThreadVerdict[];   // the verdicts this run kept
  threadsDue?: number;                // how many threads this run owed a verdict
  alreadyDiscussed?: Discussed[];     // major and blocker findings dropped as duplicates of an earlier thread
  nothingToDo?: boolean;              // true when an incremental review or a re-check read nothing and would tell a person what the newest published review tells
  unchanged?: Finding[];              // in an incremental review and a re-check: majors on lines unchanged since their file was last read, listed in the body only
  blockingOnUnchanged?: number;       // in a full review of a later head: its blocker and major findings on lines unchanged since their file was last read
  acceptance?: AcceptanceRow[];       // one row for each criterion, in the order shown; absent when no criterion was supplied, and on a failed review
}
export type { ChangedFile, PullRequestInfo, Side, Source };
export type {
  Anchor,
  Block,
  BlockScore,
  Category,
  FileLevelSource,
  FileScore,
  ScoreEntry,
  Span,
  Verdict,
} from './score/types.ts';
export { CATEGORIES } from './score/types.ts';
