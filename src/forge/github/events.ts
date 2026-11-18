import type { ForgeEvent, PullRequestAction, PullRequestFacts, PullRequestRef } from '../types.ts';
import { isObject } from './http.ts';
import { authorOf, generalCommentOf, inlineCommentOf, reviewOf } from './objects.ts';

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
  return new Date(ms).toISOString();
}

const isoOrNull = (v: unknown): string | null => (v === undefined || v === null ? null : iso(v));

function refOf(p: Record<string, unknown>, number: unknown): PullRequestRef {
  const repository = obj(p.repository);
  return { service: 'github', owner: str(obj(repository.owner).login), repo: str(repository.name), number: whole(number) };
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
  const id = isObject(p.installation) ? p.installation.id : undefined;
  if (id !== undefined && typeof id !== 'number' && typeof id !== 'string') throw bad();
  return {
    ref: refOf(p, p.number), ...authorOf(pr.user),
    baseBranch: str(base.ref), headBranch: str(head.ref), headSha: str(head.sha), draft: pr.draft,
    state: merged ? 'merged' : (pr.state as 'open' | 'closed'),
    mergedAt: isoOrNull(pr.merged_at), closedAt: isoOrNull(pr.closed_at), mergeCommit,
    installation: id === undefined ? null : String(id), updatedAt: iso(pr.updated_at),
  };
}

function pullRequestEvent(p: Record<string, unknown>): ForgeEvent {
  let action: PullRequestAction = 'other';
  if (typeof p.action === 'string' && PR_ACTIONS.has(p.action)) action = p.action as PullRequestAction;
  else if (p.action === 'edited' && isObject(p.changes) && p.changes.base !== undefined) action = 'retargeted';
  return { kind: 'pull_request', action, facts: factsOf(p) };
}

const prNumber = (p: Record<string, unknown>): unknown => obj(p.pull_request).number;

function build(name: string, p: Record<string, unknown>): ForgeEvent {
  switch (name) {
    case 'ping':
      return { kind: 'ping' };
    case 'pull_request':
      return pullRequestEvent(p);
    case 'pull_request_review': {
      if (p.action !== 'submitted') return unknownAction;
      const ref = refOf(p, prNumber(p));
      const review = reviewOf(p.review);
      if (review === null) return unknownAction;
      return { kind: 'review', ref, review: { ...review, at: iso(review.at) } };
    }
    case 'pull_request_review_comment': {
      if (p.action !== 'created') return unknownAction;
      const ref = refOf(p, prNumber(p));
      const raw = obj(p.comment);
      optionalWhole(raw.original_line);
      optionalWhole(raw.original_start_line);
      const comment = inlineCommentOf(raw);
      return { kind: 'inline_comment', ref, comment: { ...comment, at: iso(comment.at) } };
    }
    case 'issue_comment': {
      if (p.action !== 'created') return unknownAction;
      const issue = obj(p.issue);
      const ref = refOf(p, issue.number);
      if (issue.pull_request === undefined || issue.pull_request === null) return { kind: 'ignored', reason: 'not_a_pull_request' };
      const comment = generalCommentOf(p.comment);
      return { kind: 'general_comment', ref, comment: { ...comment, at: iso(comment.at) } };
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
      const sender = authorOf(p.sender);
      return { kind: 'thread', ref, action: p.action, thread: str(thread.node_id), rootComment, actor: sender.author, actorIsBot: sender.authorIsBot };
    }
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
