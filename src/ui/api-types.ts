// The answers of the UI's API (UI design 3.1; calls 13, 14, 19, 20 and 28). Types only, and it imports nothing: the frontend
// reads it through ui/src/api-types.ts.
export interface ApiError { error: string }
export interface Me { login: string; csrf: string; mode: 'live' | 'dry_run'; repositories: string[] }
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
