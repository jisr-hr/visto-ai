import { commandText } from '../shell/commands.ts';

export type SkipRefusal = 'not_allowed' | 'closed' | 'not_gated' | 'stale_head' | 'missing_reason' | 'no_skip_team' | 'not_team_member' | 'membership_unverified';

const SKIP_REFUSED: Record<SkipRefusal, string> = {
  not_allowed: '`/ai-review-skip` was not accepted',
  closed: '`/ai-review-skip` was not accepted',
  not_gated: '`/ai-review-skip` was not accepted: this pull request is not gated',
  stale_head: '`/ai-review-skip` was not accepted: a commit was pushed since you commented. Look at it and comment again',
  missing_reason: '`/ai-review-skip` needs a reason on its line, as in `/ai-review-skip urgent fix, checked by hand`',
  no_skip_team: '`/ai-review-skip` is not available here: no team is named for it',
  not_team_member: 'Only a member of the team that may skip can skip the review',
  membership_unverified: 'Membership of the team that may skip could not be verified just now, so nothing was skipped. Try again in a minute',
};

export function doneRefused(login: string | null, code: 'not_allowed' | 'closed'): string {
  return commandText(login, '`/done` was not accepted', code);
}
export function doneFailed(login: string | null, code: string): string {
  return commandText(login, '`/done` could not be handled', code);
}
export function skipRefused(login: string | null, code: SkipRefusal): string {
  return commandText(login, SKIP_REFUSED[code], code);
}
export function skipFailed(login: string | null, code: string): string {
  return commandText(login, '`/ai-review-skip` could not be handled', code);
}
/** The first 12 characters of a commit, with everything but letters and digits removed. */
export const head12 = (head: string): string => head.slice(0, 12).replace(/[^A-Za-z0-9]/g, '');
export function nothingLeft(login: string | null, head: string): string {
  const who = login !== null && /^[A-Za-z0-9-]{1,39}$/.test(login) ? `@${login} ` : '';
  return `${who}Nothing is left to run on \`${head12(head)}\`: the required checks and the review's check are green.`;
}
