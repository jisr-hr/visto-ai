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
  fromFork?: boolean;         // whether the head branch lies in another repository than the base; absent: not known
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
  /** null when the pull request does not exist or was not merged */
  pullRequest(repo: RepoRef, number: number): Promise<MergedPullRequest | null>;
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
  // a number: the description names that pull request as the one it reverts; absent: it names none;
  // 'kept': this event may not say (an event of a merged pull request other than its `closed` one): what is stored stays
  reverts?: number | 'kept';
  title?: string;   // the title the event carries; absent: it carries none, and what is stored stays
}
export type PullRequestAction = 'opened' | 'reopened' | 'ready_for_review' | 'synchronize' | 'retargeted' | 'closed' | 'other';
export type ForgeEvent =
  | { kind: 'ping' }
  | { kind: 'pull_request'; action: PullRequestAction; facts: PullRequestFacts }
  | { kind: 'review'; ref: PullRequestRef; review: HumanReview }
  // installation: the app installation the event came through, when the event names one (a gate job asked by it carries it)
  | { kind: 'inline_comment'; ref: PullRequestRef; installation?: string | null; comment: HumanInlineComment }
  | { kind: 'general_comment'; ref: PullRequestRef; installation: string | null; comment: GeneralComment }
  | { kind: 'thread'; ref: PullRequestRef; installation?: string | null; action: 'resolved' | 'unresolved'; thread: string; rootComment: string | null; actor: string; actorIsBot: boolean }
  | { kind: 'check_rerun'; ref: PullRequestRef; installation: string | null; app: string; check: string; headSha: string; actor: string }
  | { kind: 'review_dismissed'; ref: PullRequestRef; installation: string | null; review: string }
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
/** What the configured gate uses of the app; all false when no gate is configured. */
export interface GateNeeds { check: boolean; statuses: boolean; members: boolean }
export interface FeatureOff { feature: 'reviews' | 'publishing' | 'resolving' | 'commands' | 'capture' | 'gate' | 'approval' | 'ui'; missing: string }
export interface AppIdentity {
  read(): Promise<AppInfo>;
  /** What the app lacks: one entry for each permission or event a feature needs and the app has not got. `approval`: whether any repository has approval on.
   *  `uiTeam`: whether the UI lets in the members of a team. */
  lacks(dryRun: boolean, gate?: GateNeeds, approval?: boolean, uiTeam?: boolean): Promise<FeatureOff[]>;
  /** True when the app may resolve a review thread: its `contents` permission is write or admin. */
  canResolve(): Promise<boolean>;
}
export interface ReviewDraft {
  commit: string;                            // the commit the review was computed for
  body: string;
  comments: Array<{ path: string; side: Side; line: number; body: string }>;
  event?: 'approve';                         // absent: a comment
}
export type OwnReviewState = 'approved' | 'dismissed' | 'commented' | 'other';
export interface PostedComment { id: string; path: string; side: Side; line: number | null; body: string }
export interface ThreadComment {
  id: string;                 // the comment's number, as text
  node: string;               // the git service's own id of the comment, used to edit it
  author: string; authorIsBot: boolean;
  byApp: boolean;             // written by this app's own account
  reviewId: string | null;    // the review the comment belongs to
  body: string; at: string;
  association?: Association;  // as the git service reports it for the comment; absent: not reported
}
export interface ReviewThread {
  id: string;                 // the git service's id of the thread
  path: string; side: Side;
  line: number | null;        // where the thread sits now; null when its line is no longer in the diff
  resolved: boolean; resolvedByApp: boolean;
  comments: ThreadComment[];  // oldest first, never empty; the first one opened the thread
}
export interface ForgeWriter {
  /** Posts one review, as a comment, or as an approval when the draft says so, pinned to `draft.commit`. Rejects `review_rejected` when the git service refuses what it holds; any other failure rejects with a short code and says nothing about whether the review was created. */
  publishReview(ref: PullRequestRef, installation: string, draft: ReviewDraft): Promise<{ id: string }>;
  /** The app's own reviews of the pull request that have a body, newest first, each with the commit it is pinned to and, when the git service gives one, its state. One whose commit is null is not listed. */
  listOwnReviews(ref: PullRequestRef, installation: string): Promise<Array<{ id: string; commit: string; state?: OwnReviewState }>>;
  /** The inline comments of one review, read from the pull request's own comment list. null when that list was cut short. */
  listReviewComments(ref: PullRequestRef, installation: string, reviewId: string): Promise<PostedComment[] | null>;
  /** Puts a reaction on a general comment of a pull request. */
  react(ref: PullRequestRef, installation: string, commentId: string, reaction: 'eyes' | 'confused'): Promise<void>;
  /** Writes a general comment on the pull request. */
  comment(ref: PullRequestRef, installation: string, body: string): Promise<void>;
  /** Every review thread of the pull request, with all its comments. Rejects with a short code; `github_too_many_pages` when a paging cap is reached. */
  listThreads(ref: PullRequestRef, installation: string): Promise<ReviewThread[]>;
  /** Replies in a thread. Sent once. */
  replyToThread(installation: string, threadId: string, body: string): Promise<void>;
  /** Rewrites one comment, named by its `node`. Sent once. */
  editThreadComment(installation: string, commentNode: string, body: string): Promise<void>;
  /** Marks a thread resolved. Sent once. */
  resolveThread(installation: string, threadId: string): Promise<void>;
}

export interface OwnCheck {
  id: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;         // as the git service names it; null while the check is not completed
  title: string; summary: string;    // '' when the check has none
}
export interface CheckWrite {
  id: string | null;                 // the check to rewrite; null creates one on `commit`
  commit: string; name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'action_required' | 'failure' | null;   // set exactly when the status is completed
  title: string; summary: string;
}
export interface ForgeChecks {
  /** The app's own check of that name on a commit, the newest when there are several; null when there is none. Rejects with a short code. */
  findCheck(ref: PullRequestRef, installation: string, commit: string, name: string): Promise<OwnCheck | null>;
  /** Creates the check, or rewrites the one named by `id`. Sent once. Rejects with a short code and says nothing about whether it took effect. */
  writeCheck(ref: PullRequestRef, installation: string, check: CheckWrite): Promise<{ id: string }>;
  /** Those of `names` that are green on the commit: every commit status and newest check run of that name says success, and at least one reports it. Rejects with a short code. */
  greenChecks(ref: PullRequestRef, installation: string, commit: string, names: string[]): Promise<string[]>;
  /** Whether `login` is an active member of the team `<org>/<slug>`. Rejects with a short code when the git service did not say. */
  isTeamMember(installation: string, team: string, login: string): Promise<boolean>;
}

export interface ForgeApprovals {
  /** 'dismissed' when an active ruleset's pull request rule, or the branch protection, dismisses an approval when new commits are pushed;
   *  else 'gated' when `check` is given and either requires a check of that name that only this app may report; 'kept' when both
   *  were read and neither says so. Rejects with a short code when neither said so and one could not be read. */
  staleApprovals(ref: PullRequestRef, installation: string, branch: string, check?: string): Promise<'dismissed' | 'gated' | 'kept'>;
  /** One review as the git service holds it now; its commit is null when the service gives none. null when it answers that there is none. Rejects with a short code. */
  readReview(ref: PullRequestRef, installation: string, reviewId: string): Promise<{ state: OwnReviewState; commit: string | null } | null>;
  /** Dismisses one review. Sent once. Rejects with a short code and says nothing about whether it took effect. */
  dismissReview(ref: PullRequestRef, installation: string, reviewId: string, message: string): Promise<void>;
}
export interface SignedIn { login: string; isBot: boolean }
/** How long each of sign-in's calls to GitHub may take, the UI's read of a team membership included; a call cut off is github_network. */
export const SIGN_IN_TIMEOUT_MS = 10_000;
export interface ForgeSignIn {
  /** The page where a person approves the sign-in; `challenge` is the base64url SHA-256 of the PKCE verifier. */
  authorizeUrl(state: string, challenge: string, redirectUri: string): string;
  /** The account that approved: the code is exchanged once, with the verifier, for a user token, which reads the account once and is dropped. Rejects with a short code. */
  signedIn(code: string, verifier: string, redirectUri: string): Promise<SignedIn>;
  /** The app's installation on an organisation, read with the app's own token; null when it is not installed there. Rejects with a short code. */
  orgInstallation(org: string): Promise<string | null>;
}
