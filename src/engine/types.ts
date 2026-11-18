// src/engine/types.ts
import type { ChangedFile, PullRequestInfo, Side, Source } from '../forge/types.ts';
import type { FileScore, Verdict } from './score/types.ts';

export type Severity = 'blocker' | 'major' | 'minor';
export interface AuditEntry { stage: string; action: string; subject: string; reason: string }
export interface Usage { calls: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type Effort = 'default' | 'elevated';
export interface ModelRequest { messages: ChatMessage[]; tools: ToolDefinition[]; forcedTool: string; effort: Effort; timeoutMs: number }
export interface ModelResponse { toolName: string | null; toolArguments: string | null; text: string | null; model: string; provider: string | null; usage: Usage }
export interface ModelClient { complete(request: ModelRequest): Promise<ModelResponse> }

export interface Limits { inputTokensPerCall: number; batchesPerReview: number; modelTimeoutSeconds: number }
export interface RepoConfig { primaryBranches: string[]; scoreThreshold: number }

export interface ReviewInput {
  pullRequest: PullRequestInfo;
  trigger: 'automatic' | 'manual';
  repoConfig: RepoConfig;
  limits: Limits;
  asOf: Date;
  earlier: null;              // a pull request's earlier state arrives with a later plan
}
export interface ReviewDeps {
  source: Source;
  model: ModelClient;
  contract: string;
  clock: () => Date;
  token: () => string;        // fresh random text for data markers, 16 hex characters
  log: (entry: Record<string, unknown>) => void;
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
  mode: 'full';
  overview: string;
  findings: Finding[];
  unplaced: UnplacedFinding[];
  beyondDiff: RawFinding[];
  coverage: { reviewed: string[]; notReviewed: NotReviewed[] };
  usage: Usage;
  models: string[];           // models that answered, distinct, in first-seen order
  providers: string[];        // upstream providers that answered, distinct, in first-seen order
  dependencies: { model: 'ok' | 'error' };
  audit: AuditEntry[];
  scores: FileScore[];        // one per changed file; empty when the review failed
  verdict: Verdict;
  teamFileInvalid: string | null; // why the repository's .visto-ai.yml cannot be used; null when it can, or on a failed review
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
