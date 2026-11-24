import type { Association, GeneralComment, HumanInlineComment, HumanReview } from '../types.ts';
import { isObject } from './http.ts';

const bad = (): Error => new Error('github_bad_response');

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function required(v: unknown): string {
  if (typeof v !== 'string' || v === '') throw bad();
  return v;
}

export function idOf(v: unknown): string {
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  if (typeof v === 'string' && v !== '') return v;
  throw bad();
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

export function authorOf(v: unknown): { author: string; authorIsBot: boolean } {
  if (!isObject(v) || typeof v.login !== 'string' || v.login === '') return { author: 'ghost', authorIsBot: false };
  return { author: v.login, authorIsBot: v.type === 'Bot' || v.login.endsWith('[bot]') };
}

const ASSOCIATION = new Map<string, Association>([['OWNER', 'owner'], ['MEMBER', 'member'], ['COLLABORATOR', 'collaborator']]);
export const associationOf = (v: unknown): Association => ASSOCIATION.get(typeof v === 'string' ? v : '') ?? 'none';

const REVIEW_STATE = new Map<string, HumanReview['state']>([
  ['APPROVED', 'approved'], ['CHANGES_REQUESTED', 'changes_requested'], ['COMMENTED', 'commented'], ['DISMISSED', 'dismissed'],
]);

function objectItem(v: unknown): Record<string, unknown> {
  if (!isObject(v)) throw bad();
  return v;
}

// A list answer writes a review's state in capitals and a webhook in lower case.
export function reviewOf(raw: unknown): HumanReview | null {
  const r = objectItem(raw);
  const id = idOf(r.id);
  const state = text(r.state).toUpperCase();
  if (state === 'PENDING') return null;
  return {
    id, ...authorOf(r.user), association: associationOf(r.author_association),
    state: REVIEW_STATE.get(state) ?? 'commented',
    commit: typeof r.commit_id === 'string' ? r.commit_id : null,
    at: required(r.submitted_at), body: text(r.body),
  };
}

export function inlineCommentOf(raw: unknown): HumanInlineComment {
  const c = objectItem(raw);
  return {
    id: idOf(c.id), ...authorOf(c.user), association: associationOf(c.author_association), at: required(c.created_at),
    commit: required(c.original_commit_id), path: required(c.path),
    side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT',
    line: numberOrNull(c.original_line), startLine: numberOrNull(c.original_start_line),
    fileLevel: c.subject_type === 'file',
    replyTo: c.in_reply_to_id === undefined || c.in_reply_to_id === null ? null : idOf(c.in_reply_to_id),
    body: text(c.body),
  };
}

export function generalCommentOf(raw: unknown): GeneralComment {
  const c = objectItem(raw);
  return {
    id: idOf(c.id), ...authorOf(c.user), association: associationOf(c.author_association),
    at: required(c.created_at), body: text(c.body),
  };
}
