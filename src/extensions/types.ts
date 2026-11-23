// The whole contract of an extension module (section 11.3). A module imports these with `import type`.
import type { ContextAnswer } from '../engine/types.ts';
import type { PullRequestInfo } from '../forge/types.ts';

export type { ContextAnswer, PullRequestInfo };

/** What a notifier is told of one published review. */
export interface ReviewNotice {
  run: number;                 // the id an answer is reported with
  repository: string;          // "owner/name"
  number: number;
  title: string;               // written by the pull request's author: untrusted
  author: string;              // the author's login on the git service
  headSha: string;             // the commit the review read
  mode: 'full' | 'incremental' | 'recheck';
  trigger: 'automatic' | 'manual';
  reviewUrl: string;
  pullRequestUrl: string;
  needsHuman: boolean;
  highestScore: number;
  findings: { blocker: number; major: number; minor: number };   // the findings placed on the diff
  body: string;                // the review as it was published; it holds text a model wrote
}
export interface AlertNotice { code: string; at: string; details: Record<string, string | number | boolean | null> }
export interface RouteRequest {
  method: string;
  path: string;                // what follows /extensions/<name>, beginning with '/'; '/' when nothing follows. Not decoded
  query: string;               // what follows the first '?', without it; '' when there is none. Not decoded
  headers: Record<string, string | undefined>;   // names in lower case; a header given several times arrives as Node hands it over (most are joined with a comma)
  body: Buffer;                // the bytes received, at most 1 MiB
}
export interface RouteAnswer { status: number; headers?: Record<string, string>; body?: string }
export interface FeedbackAnswer { run: number; login: string; vote: 'up' | 'down'; reason?: string }
export type FeedbackOutcome = { ok: true } | { ok: false; code: 'bad_answer' | 'unknown_run' | 'store_failed' };
export interface ExtensionSetup {
  name: string;
  options: Record<string, unknown>;                              // a copy; secrets already read from the environment
  log(entry: Record<string, unknown>): void;                     // one line in the service's log, tagged with the module's name
  reportFeedback(answer: FeedbackAnswer): Promise<FeedbackOutcome>;   // never rejects
}
/** The parts a module provides; at least one. Each is given a signal that aborts at its limit. */
export interface Extension {
  context?(pr: PullRequestInfo, signal: AbortSignal): Promise<ContextAnswer>;
  notify?(notice: ReviewNotice, signal: AbortSignal): Promise<void>;
  alert?(alert: AlertNotice, signal: AbortSignal): Promise<void>;
  route?(request: RouteRequest, signal: AbortSignal): Promise<RouteAnswer>;
}
/** A module's default export: called once, at start. */
export type ExtensionFactory = (setup: ExtensionSetup) => Extension | Promise<Extension>;
export interface LoadedExtension { name: string; parts: Extension }
