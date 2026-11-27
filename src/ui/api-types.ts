// The answers of the UI's API (UI design 3.1; calls 13, 14, 19, 20 and 28). Types only, and it imports nothing: the frontend
// reads it through ui/src/api-types.ts.
export interface ApiError { error: string }
/** The answer of a password sign-in and of a first password (the password design 4.3; call 13). */
export interface SignInStep { next: 'signed_in' | 'choose_password' }
export type AccountKind = 'password' | 'github';
export type Role = 'admin' | 'viewer';
/** Who is signed in (the password design 4.5; call 19): the account's name, kind and role as they are at this request. */
export interface Me { name: string; kind: AccountKind; role: Role; csrf: string; mode: 'live' | 'dry_run'; repositories: string[] }
/** The ways of signing in the page offers besides a password (call 25). */
export interface Ways { github: boolean }
/** An account as the API shows it (the password design 4.2 and 4.8): never its hash. */
export interface Account {
  id: number; kind: AccountKind; name: string; role: Role;
  password: 'set' | 'one_time' | 'expired' | null;   // null for a GitHub account
  waitsUntil: string | null;                         // while it waits after five wrong tries
  madeAt: string; madeBy: { kind: 'password' | 'github' | 'command' | 'sign_in'; name: string | null };
  lastSignInAt: string | null; you: boolean;
}
export interface Accounts { now: string; accounts: Account[] }
export interface OneTime { account: Account; oneTimePassword: string; expiresAt: string }
export interface AccountAnswer { account: Account }
export type JobStage = 'waiting' | 'retrying' | 'queued' | 'preparing' | 'reviewing' | 'judging_threads' | 'publishing' | 'stopped';
export interface ActivityJob {
  job: number; repository: string; number: number; title: string | null; url: string; head: string | null;
  stage: JobStage; batch: number | null; batches: number | null; threadsDue: number | null;
  startedAt: string | null; runAt: string; askedBy: { reason: string; login: string | null };
}
export interface Withdrawal { repository: string; number: number; code: string | null; runAt: string }
export interface Activity {
  now: string; places: { reviews: number; withdrawals: number }; paused: 'spend_limit' | 'model_error' | null;
  jobs: ActivityJob[]; withdrawals: Withdrawal[];
}
export type ReviewOutcome = 'approved' | 'needs_person' | 'audit' | 'reviewed' | 'nothing_new' | 'not_posted' | 'failed';
export interface RecentReview {
  run: number; repository: string; number: number; title: string | null; outcome: ReviewOutcome; failureCode: string | null;
  highest: number | null; threshold: number | null; findings: { blocker: number; major: number; minor: number };
  mode: 'full' | 'incremental' | 'recheck'; dryRun: boolean; cost: number; tookMs: number; at: string;
}
export interface Reviews { now: string; windowDays: number; total: number; reviews: RecentReview[]; next: number | null }
/** One file of a review, with the score that decides it (the One review design; calls 9, 10 and 14). */
export interface ReviewFile {
  path: string;
  score: number | null;              // the file's final score; null for a path not reviewed that has no score
  notReviewed: string | null;        // why it was not reviewed (coverage.notReviewed's reason; 'unknown' when it is no short code); null when it was
  source: string | null;             // the file level's source when it decides the score (call 9; 'unknown' when no short code); null when a block does
  reason: string;                    // the model's reason for the score that decides; '' when none, or written on another pull request
  category: string | null;           // the deciding block's category when its score was given on another pull request; else null
  blocks: number;                    // how many blocks the file has
  highest: { side: 'LEFT' | 'RIGHT'; first: number; last: number } | null;   // the deciding block's lines; null when the file level decides
  kept: 'earlier_run' | 'other_pull_request' | null;                           // where the deciding block's score came from
  raisedFrom: number | null;         // the score the deciding block was given before a floor raised it; null when none did
}
export type FindingKind = 'placed' | 'unplaced' | 'unchanged' | 'beyond_diff';
export type ThreadState = 'none' | 'not_posted' | 'no_thread' | 'open' | 'resolved' | 'fixed' | 'answered';
export interface ReviewFinding {
  kind: FindingKind; severity: 'blocker' | 'major' | 'minor'; path: string; side: 'LEFT' | 'RIGHT'; line: number; body: string;
  thread: { state: ThreadState; by: string | null };   // by: who resolved it, for 'resolved' only
}
export type ApprovalDecision = 'approved' | 'not_approved' | 'not_decided' | 'dry_run' | 'not_posted' | 'nothing_new' | 'failed';
export type Posting = 'published' | 'not_posted' | 'dry_run' | 'nothing_new' | 'failed';
export interface GateShown { mode: string; state: string; code: string | null; blocking: number }
export interface ApprovalEntry {
  run: number; ordinal: number; head: string;
  state: 'stands' | 'withdrawn' | 'dismissed_on_github' | 'withdrawal_failed';
  code: string | null; retryAt: string | null; stoodAtMerge: boolean;
}
export interface ReviewDependency {
  kind: 'model' | 'memory' | 'lessons' | 'mcp' | 'extension'; name: string | null;
  status: 'ok' | 'empty' | 'skipped' | 'error'; code: string | null; count: number | null;
}
export interface FeedbackReason { reason: string; login: string | null }   // login: only of GitHub's shape (call 15)
export interface OneReview {
  now: string; run: number; ordinal: number; runs: number;
  pullRequest: { repository: string; number: number; title: string | null; author: string | null; headBranch: string | null; baseBranch: string | null; url: string };
  head: string; askedBy: { reason: string; login: string | null };
  mode: 'full' | 'incremental' | 'recheck'; posting: Posting; failure: { stage: string; code: string | null } | null;   // stage 'unknown' when it is no short code
  startedAt: string; finishedAt: string; publishedAt: string | null;
  approval: { decision: ApprovalDecision; code: string | null; text: string | null };
  gate: GateShown | null; threshold: number | null;
  files: ReviewFile[]; filesCut: number; read: { files: number; reviewed: number };
  findings: ReviewFinding[]; findingsCut: number; counts: { blocker: number; major: number; minor: number };
  earlier: { cleared: number; open: number; unjudged: number; discussed: number };
  usage: { models: string[]; calls: number; inputTokens: number; cachedTokens: number; outputTokens: number; cost: number };
  approvals: ApprovalEntry[]; dependencies: ReviewDependency[];
  feedback: { helpful: number; notHelpful: number; reasons: FeedbackReason[] };
}
export interface PullReview { run: number; ordinal: number; at: string }
export interface PullReviews { now: string; total: number; reviews: PullReview[] }
