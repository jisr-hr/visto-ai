import type { ForgeEvent, PullRequestAction, PullRequestFacts, PullRequestRef } from '../types.ts';
import { isObject } from './http.ts';
import { authorOf, generalCommentOf, idOf, inlineCommentOf, reviewOf } from './objects.ts';
import { revertedNumber } from '../../memory/reverts.ts';

export const MAX_ID_CHARS = 200;
const MAX_INT = 2147483647;
const PR_ACTIONS = new Set<string>(['opened', 'reopened', 'ready_for_review', 'synchronize', 'closed']);
const malformed: ForgeEvent = { kind: 'ignored', reason: 'malformed' };
const unknownAction: ForgeEvent = { kind: 'ignored', reason: 'unknown_action' };

const bad = (): Error => new Error('malformed');

function obj(v: unknown): Record<string, unknown> {
  if (!isObject(v)) throw bad();
  return v;
}

function str(v: unknown): string {
  if (typeof v !== 'string' || v === '') throw bad();
  return v;
}

function short(v: string | null): void {
  if (v !== null && v.length > MAX_ID_CHARS) throw bad();
}

function whole(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_INT) throw bad();
  return v;
}

function optionalWhole(v: unknown): void {
  if (v !== undefined && v !== null) whole(v);
}

function iso(v: unknown): string {
  const ms = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  if (Number.isNaN(ms)) throw bad();
  const date = new Date(ms);
  if (date.getUTCFullYear() < 1970 || date.getUTCFullYear() > 9999) throw bad();
  return date.toISOString();
}

const isoOrNull = (v: unknown): string | null => (v === undefined || v === null ? null : iso(v));

function refOf(p: Record<string, unknown>, number: unknown): PullRequestRef {
  const repository = obj(p.repository);
  const owner = str(obj(repository.owner).login);
  const repo = str(repository.name);
  short(owner);
  short(repo);
  return { service: 'github', owner, repo, number: whole(number) };
}

function installationOf(p: Record<string, unknown>): string | null {
  const id = isObject(p.installation) ? p.installation.id : undefined;
  if (id !== undefined && typeof id !== 'number' && typeof id !== 'string') throw bad();
  return id === undefined ? null : String(id);
}

function factsOf(p: Record<string, unknown>): PullRequestFacts {
  const pr = obj(p.pull_request);
  const base = obj(pr.base);
  const head = obj(pr.head);
  if (typeof pr.draft !== 'boolean') throw bad();
  const merged = pr.merged === true;
  if (!merged && pr.state !== 'open' && pr.state !== 'closed') throw bad();
  let mergeCommit: string | null = null;
  if (merged && pr.merge_commit_sha !== undefined && pr.merge_commit_sha !== null) mergeCommit = str(pr.merge_commit_sha);
  const installation = installationOf(p);
  return {
    ref: refOf(p, p.number), ...authorOf(pr.user),
    baseBranch: str(base.ref), headBranch: str(head.ref), headSha: str(head.sha), draft: pr.draft,
    state: merged ? 'merged' : (pr.state as 'open' | 'closed'),
    mergedAt: isoOrNull(pr.merged_at), closedAt: isoOrNull(pr.closed_at), mergeCommit,
    installation, updatedAt: iso(pr.updated_at),
    // The title as written, an empty one included; with none that is text, no key, and what is stored stays.
    ...(typeof pr.title === 'string' ? { title: pr.title } : {}),
  };
}

function pullRequestEvent(p: Record<string, unknown>): ForgeEvent {
  let action: PullRequestAction = 'other';
  if (typeof p.action === 'string' && PR_ACTIONS.has(p.action)) action = p.action as PullRequestAction;
  else if (p.action === 'edited' && isObject(p.changes) && p.changes.base !== undefined) action = 'retargeted';
  return { kind: 'pull_request', action, facts: withReverts(factsOf(p), p) };
}

// What the description says the pull request reverts (6.5, 7.1): only the number leaves here, never a word of the
// description. Once merged, only the merge's own delivery may say it; any other event of it keeps what is stored, and
// its description is not read. With no reference the facts are the object they were.
function withReverts(facts: PullRequestFacts, p: Record<string, unknown>): PullRequestFacts {
  if (facts.state === 'merged' && p.action !== 'closed') return { ...facts, reverts: 'kept' };
  const reverts = revertedNumber(obj(p.pull_request).body, { owner: facts.ref.owner, repo: facts.ref.repo });
  return reverts === null ? facts : { ...facts, reverts };
}

const prNumber = (p: Record<string, unknown>): unknown => obj(p.pull_request).number;

/** The pull request a check run belongs to: the number the check carries, else the first one GitHub lists; null with neither. */
function checkRunNumber(run: Record<string, unknown>): number | null {
  const carried = run.external_id;
  if (typeof carried === 'string' && /^[0-9]{1,10}$/.test(carried)) {
    const n = Number(carried);
    if (n > 0 && n <= MAX_INT) return n;
  }
  const listed: unknown = Array.isArray(run.pull_requests) ? run.pull_requests[0] : undefined;
  return listed === undefined ? null : whole(obj(listed).number);
}

function checkRunEvent(p: Record<string, unknown>): ForgeEvent {
  if (p.action !== 'rerequested') return unknownAction;
  const run = obj(p.check_run);
  const check = str(run.name);
  const headSha = str(run.head_sha);
  short(check);
  short(headSha);
  const appId = obj(run.app).id;
  if (typeof appId !== 'number' && typeof appId !== 'string') throw bad();
  const app = str(String(appId));
  short(app);
  const actor = str(obj(p.sender).login);
  const number = checkRunNumber(run);
  const ref = refOf(p, number ?? 1);
  if (number === null) return { kind: 'ignored', reason: 'not_a_pull_request' };
  return { kind: 'check_rerun', ref, installation: installationOf(p), app, check, headSha, actor };
}

function build(name: string, p: Record<string, unknown>): ForgeEvent {
  switch (name) {
    case 'ping':
      return { kind: 'ping' };
    case 'pull_request':
      return pullRequestEvent(p);
    case 'pull_request_review': {
      if (p.action === 'dismissed') {
        // Whoever dismissed it, and whoever wrote it: only the review's id leaves here.
        const ref = refOf(p, prNumber(p));
        const review = idOf(obj(p.review).id);
        short(review);
        return { kind: 'review_dismissed', ref, installation: installationOf(p), review };
      }
      if (p.action !== 'submitted') return unknownAction;
      const ref = refOf(p, prNumber(p));
      const review = reviewOf(p.review);
      if (review === null) return unknownAction;
      short(review.id);
      return { kind: 'review', ref, review: { ...review, at: iso(review.at) } };
    }
    case 'pull_request_review_comment': {
      if (p.action !== 'created') return unknownAction;
      const ref = refOf(p, prNumber(p));
      const raw = obj(p.comment);
      optionalWhole(raw.original_line);
      optionalWhole(raw.original_start_line);
      const comment = inlineCommentOf(raw);
      short(comment.id);
      short(comment.replyTo);
      return { kind: 'inline_comment', ref, installation: installationOf(p), comment: { ...comment, at: iso(comment.at) } };
    }
    case 'issue_comment': {
      if (p.action !== 'created') return unknownAction;
      const issue = obj(p.issue);
      const ref = refOf(p, issue.number);
      if (issue.pull_request === undefined || issue.pull_request === null) return { kind: 'ignored', reason: 'not_a_pull_request' };
      const comment = generalCommentOf(p.comment);
      short(comment.id);
      return { kind: 'general_comment', ref, installation: installationOf(p), comment: { ...comment, at: iso(comment.at) } };
    }
    case 'pull_request_review_thread': {
      if (p.action !== 'resolved' && p.action !== 'unresolved') return unknownAction;
      const ref = refOf(p, prNumber(p));
      const thread = obj(p.thread);
      if (!Array.isArray(thread.comments)) throw bad();
      const first: unknown = thread.comments[0];
      let rootComment: string | null = null;
      if (first !== undefined) {
        const id = obj(first).id;
        if (typeof id !== 'number' || !Number.isInteger(id)) throw bad();
        rootComment = String(id);
      }
      const threadId = str(thread.node_id);
      short(threadId);
      const sender = authorOf(p.sender);
      return { kind: 'thread', ref, installation: installationOf(p), action: p.action, thread: threadId, rootComment, actor: sender.author, actorIsBot: sender.authorIsBot };
    }
    case 'check_run':
      return checkRunEvent(p);
    default:
      return { kind: 'ignored', reason: 'unknown_event' };
  }
}

export function eventOf(name: string, payload: unknown): ForgeEvent {
  try {
    return build(name, obj(payload));
  } catch {
    return malformed;
  }
}
