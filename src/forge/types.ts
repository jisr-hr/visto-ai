// src/forge/types.ts
export type Side = 'LEFT' | 'RIGHT';
export interface PullRequestRef { service: 'github'; owner: string; repo: string; number: number }
export interface PullRequestInfo {
  ref: PullRequestRef;
  title: string; description: string; author: string;
  baseBranch: string; headBranch: string;
  baseSha: string;            // the diff's base: the merge base with the base branch
  headSha: string;
  draft: boolean;
}
export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed';
export interface ChangedFile {
  path: string; previousPath: string | null; status: FileStatus;
  additions: number; deletions: number;
  patch: string | null;       // null when the service sent none
}
export interface Source {
  listFiles(pr: PullRequestInfo): Promise<ChangedFile[]>;
  /** null when the file is absent at that commit or is not text */
  getFileContent(pr: PullRequestInfo, path: string, sha: string): Promise<string | null>;
  /** The file's text on the repository's default branch, whatever its bytes; null only when it is absent. */
  getDefaultBranchFile(pr: PullRequestInfo, path: string): Promise<string | null>;
}

export interface LivePullRequest {
  info: PullRequestInfo;                 // for an open pull request, baseSha is the merge base of its base and its head
  state: 'open' | 'closed' | 'merged';
}
export interface ForgeAccess {
  /** The pull request as the git service has it now. null when it is not there. Rejects with a short code. */
  readPullRequest(ref: PullRequestRef, installation: string): Promise<LivePullRequest | null>;
  /** A read-only source for one review, with that installation's token. Rejects with a short code. */
  sourceFor(installation: string): Promise<Source>;
}

export interface HookDelivery { id: string; guid: string; at: string; ok: boolean }   // ok: the service answered it with success
export interface HookDeliveries {
  /** The app's own webhook deliveries made at or after `since`. `complete` is false when the listing stopped at its page limit. */
  listSince(since: string): Promise<{ deliveries: HookDelivery[]; complete: boolean }>;
  /** Asks the git service to send one delivery again. Rejects with a short code; `github_rate_limited` when told to slow down. */
  redeliver(id: string): Promise<void>;
}

export type Association = 'owner' | 'member' | 'collaborator' | 'none';
export interface RepoRef { owner: string; repo: string }
export interface MergedPullRequest {
  number: number; title: string; description: string; author: string; authorIsBot: boolean;
  baseBranch: string; headBranch: string; baseSha: string; headSha: string; mergedAt: string;
}
export interface HumanReview {
  id: string; author: string; authorIsBot: boolean; association: Association;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed'; commit: string | null; at: string; body: string;
}
export interface HumanInlineComment {
  id: string; author: string; authorIsBot: boolean; association: Association; at: string;
  commit: string; path: string; side: Side; line: number | null; startLine: number | null; fileLevel: boolean; replyTo: string | null; body: string;
}
export interface GeneralComment { id: string; author: string; authorIsBot: boolean; association: Association; at: string; body: string }
export interface Comparison { mergeBase: string; files: ChangedFile[] }
export interface HistorySource {
  /** pageLimitReached: the listing ran out of pages, so older pull requests in the window may be missing. */
  listMergedPullRequests(
    repo: RepoRef, window: { since: string; until: string }, limit: number,
  ): Promise<{ pullRequests: MergedPullRequest[]; pageLimitReached: boolean }>;
  listReviews(repo: RepoRef, number: number): Promise<HumanReview[]>;
  listInlineComments(repo: RepoRef, number: number): Promise<HumanInlineComment[]>;
  listGeneralComments(repo: RepoRef, number: number): Promise<GeneralComment[]>;
  /** null when either commit can no longer be read */
  compare(repo: RepoRef, base: string, head: string): Promise<Comparison | null>;
}

export interface PullRequestFacts {
  ref: PullRequestRef;
  author: string; authorIsBot: boolean;
  baseBranch: string; headBranch: string; headSha: string;
  draft: boolean;
  state: 'open' | 'closed' | 'merged';
  mergedAt: string | null; closedAt: string | null; mergeCommit: string | null;
  installation: string | null;   // the app installation the event came through
  updatedAt: string;             // the git service's "updated at" of the pull request in this event
}
export type PullRequestAction = 'opened' | 'reopened' | 'ready_for_review' | 'synchronize' | 'retargeted' | 'closed' | 'other';
export type ForgeEvent =
  | { kind: 'ping' }
  | { kind: 'pull_request'; action: PullRequestAction; facts: PullRequestFacts }
  | { kind: 'review'; ref: PullRequestRef; review: HumanReview }
  | { kind: 'inline_comment'; ref: PullRequestRef; comment: HumanInlineComment }
  | { kind: 'general_comment'; ref: PullRequestRef; comment: GeneralComment }
  | { kind: 'thread'; ref: PullRequestRef; action: 'resolved' | 'unresolved'; thread: string; rootComment: string | null; actor: string; actorIsBot: boolean }
  | { kind: 'ignored'; reason: 'unknown_event' | 'unknown_action' | 'not_a_pull_request' | 'malformed' };
export type WebhookReading =
  | { ok: false; reason: 'bad_signature' | 'not_json' | 'no_delivery_id' | 'no_event_name' }
  | { ok: true; delivery: string; name: string; action: string | null; event: ForgeEvent };
export interface WebhookReader {
  /** `headers`: the request's headers, names in lower case. `body`: the bytes as received. */
  read(headers: Record<string, string | undefined>, body: Buffer): WebhookReading;
}

export interface AppInfo {
  botLogin: string;                          // the app's own account: "<slug>[bot]"
  permissions: Record<string, string>;       // as the git service names them: { pull_requests: 'write', contents: 'read', ... }
  events: string[];                          // the events the app is subscribed to
}
export interface FeatureOff { feature: 'reviews' | 'publishing' | 'commands' | 'capture'; missing: string }
export interface AppIdentity {
  read(): Promise<AppInfo>;
  /** What the app lacks: one entry for each permission or event a feature needs and the app has not got. */
  lacks(dryRun: boolean): Promise<FeatureOff[]>;
}
