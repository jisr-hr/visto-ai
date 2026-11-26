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
