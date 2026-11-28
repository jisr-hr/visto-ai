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

// -- the settings (the plan "The UI's Settings"; UI design 3.2, 4 and 5; calls 12, 15 to 18, 22 to 24 and 27) --------------
export type SettingValue = null | boolean | number | string | SettingValue[] | { [key: string]: SettingValue };
export interface SettingSource { by: 'config.yml' | 'ui'; name: string | null; at: string }
/** One setting: its value (the saved one when written, else the default's), where the saved one came from, and what a save of it waits for. */
export interface Setting { written: boolean; value: SettingValue; source: SettingSource | null; restart: boolean; waits: boolean }
export interface RepositorySettings { name: string; settings: Record<string, Setting> }
export type SecretKind = 'model_key' | 'scorer_key' | 'app_private_key' | 'webhook_secret' | 'app_client_secret' | 'database' | 'audit_key' | 'alert_webhook' | 'extension' | 'mcp_header';
/** A secret as the screen shows it: what it is for and the variable that holds it, never its value; `variable` null: not set. */
export interface SecretState { kind: SecretKind; of: string | null; variable: string | null }
export interface SettingsView {
  /** `started`: when the running start read the settings; a restart gives a newer one. */
  now: string; started: string; version: number;
  global: Record<string, Setting>; defaults: Record<string, Setting>; repositories: RepositorySettings[];
  scorer: { on: boolean; waits: boolean };
  /** Where the keys are sent: set in config.yml only (no admin can change it here); `scorer` is read from the file (its default when the block writes none), so it shows while the scorer is off; null only when the file has no scorer block. */
  endpoints: { model: string; scorer: string | null };
  secrets: SecretState[];
  access: { publicUrl: string; github: boolean; accounts: string[]; teams: string[] };
}
/** The answer to a save: the settings as they now are, and whether the service is restarting for one that waits. */
export type SettingsSaved = SettingsView & { restarting: boolean };
export interface SettingsSave { version: number; changes: Array<{ scope: string; path: string; value?: SettingValue }> }
export interface SettingIssue { scope: string | null; path: string | null; message: string }
export interface SettingsInvalid { error: 'invalid'; issues: SettingIssue[] }
export interface SettingChangeRow {
  id: number; at: string; by: 'config.yml' | 'ui'; name: string | null; scope: string; path: string;
  /** The value's JSON text, cut at 200 characters; null: not written. */
  before: string | null; after: string | null;
}
export interface SettingChanges { changes: SettingChangeRow[]; next: number | null }
export interface SettingsExport { text: string }

// -- live score quality and the repositories (the plan "The UI's Overview, Repositories and Memory"; calls 23 to 29) ---------
export type WindowDays = 7 | 30 | 90;
export type QualityWindow = WindowDays | 'all';
/** `share`: `part` of `of`, three decimals; null when `of` is 0. */
export interface Measure { share: number | null; part: number; of: number }
export interface ApprovalShort { enabled: boolean; threads: 'strict' | 'gate'; auditShare: number }
export interface QualityRow { threshold: number; current: boolean; safetyBlocks: Measure; safetyFiles: Measure; benefit: Measure; focus: Measure }
export interface SteppedBlock { path: string; number: number; score: number }
/** `closed`: the pull requests closed in the window that were read (at most 300); `pullRequests`: those of them measured (a last run read). */
export interface Quality {
  repository: string; window: QualityWindow; threshold: number;
  closed: number; pullRequests: number; unreadable: number; cut: { pulls: boolean; comments: boolean; runs: boolean };
  rows: QualityRow[]; stepped: SteppedBlock[];
  reverts: { merged: number; approved: number }; audits: { drawn: number; needed: number };
  feedback: { helpful: number; notHelpful: number; reasons: Array<{ reason: string; count: number }> };
}
export type QualityState = 'ready' | 'computing' | 'failed';
/** `quality` only when `state` is ready. */
export interface QualityAnswer { now: string; state: QualityState; quality: Quality | null }
export interface Repositories { now: string; repositories: string[] }

// -- the Overview and dependency health (the same plan; calls 14 to 18 and 22) -------------------------------------------------
export interface OverviewQuality {
  repository: string; threshold: number; state: QualityState;   // the numbers and reverts only when ready
  safety: Measure | null; benefit: Measure | null; focus: Measure | null; reverts: { merged: number; approved: number } | null;
  approval: ApprovalShort;
}
export interface Overview {
  now: string; days: WindowDays; repositories: number;
  reviews: { total: number; published: number; dryRun: number; failed: number; nothingNew: number; notPosted: number };
  spend: { today: number; limit: number };
  approvals: { approved: number; audited: number };
  perDay: Array<{ day: string; published: number; failed: number; other: number; cost: number }>;   // oldest first; day 'YYYY-MM-DD', UTC
  quality: OverviewQuality[]; qualityCut: number;
}
export type DependencyKind = 'model' | 'scorer' | 'memory' | 'extension' | 'mcp' | 'app';
export type DependencyStatus = 'working' | 'failing' | 'unknown';
export interface DependencyPart { part: 'context' | 'notify' | 'alert' | 'route'; status: DependencyStatus; code: string | null; since: string | null }
export interface DependencyShown {
  kind: DependencyKind; name: string | null; model: string | null; status: DependencyStatus; code: string | null;
  since: string | null; seenAt: string | null; parts: DependencyPart[]; missing: Array<{ feature: string; missing: string }>;
}
export interface AlertShown { id: number; code: string; details: Record<string, string | number | boolean>; raisedAt: string; open: boolean }
export interface Health { now: string; dependencies: DependencyShown[]; open: AlertShown[]; recent: AlertShown[] }

// -- Memory (the same plan; calls 30 to 33 and 35) ------------------------------------------------------------------------------
export type MemoryKind = 'human_signal' | 'revert' | 'lesson';
/** `text`: the excerpt of a person's record, the lesson of a lesson, '' for a revert. `by`: the commenter of a person's record. `reverted`: the pull request a revert undid. */
export interface MemoryRecordShown {
  id: number; kind: MemoryKind; repository: string; number: number; text: string; path: string | null; directory: string | null;
  by: string | null; reverted: number | null; createdAt: string | null; expiresAt: string | null; on: boolean;   // a time no ISO time writes is none
}
export interface MemoryView {
  now: string; learning: { on: boolean; ranAt: string | null };
  counts: { signals: number; signalRepositories: number; reverts: number; lessons: number; off: number };
  total: number; records: MemoryRecordShown[]; next: number | null;
}
export interface MemorySwitched { record: MemoryRecordShown }
