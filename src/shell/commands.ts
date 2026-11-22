import { isShortCode } from './codes.ts';

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

/** Whether a commenter with this association with the repository may command the service: an owner, a member or a collaborator. */
export function mayCommand(association: string | null): boolean {
  return association === 'owner' || association === 'member' || association === 'collaborator';
}

export type Command = 'review' | 'done' | 'skip';

function firstLineOf(body: string): string | undefined {
  return body.split(/\r\n|\r|\n/).map((line) => line.trim()).find((line) => line !== '');
}

/** The command a comment gives, read from its first line that is not empty. */
export function commandOf(body: string): Command | null {
  const first = firstLineOf(body);
  if (first === undefined) return null;
  if (/^\/review([ \t]|$)/i.test(first)) return 'review';
  if (/^\/done([ \t]|$)/i.test(first)) return 'done';
  if (/^\/ai-review-skip([ \t]|$)/i.test(first)) return 'skip';
  return null;
}

/** The reason of a skip command: the rest of its line, trimmed; '' when there is none or the body gives no skip. */
export function skipReasonOf(body: string): string {
  const first = firstLineOf(body);
  if (first === undefined || !/^\/ai-review-skip([ \t]|$)/i.test(first)) return '';
  return first.slice('/ai-review-skip'.length).trim();
}

/** One sentence to the person who gave a command: "@login <text> (`code`)." The login is written only when it can be one; a code that is no short code is written internal_error. */
export function commandText(login: string | null, text: string, code: string): string {
  const who = login !== null && LOGIN.test(login) ? `@${login} ` : '';
  const shown = isShortCode(code) ? code : 'internal_error';
  return `${who}${text} (\`${shown}\`).`;
}

/** The one sentence the service answers a refused command with. */
export function refusalText(login: string | null, code: string): string {
  return commandText(login, 'The review was not started', code);
}

/** The one sentence it answers a command that failed with. */
export function failureText(login: string | null, code: string): string {
  return commandText(login, 'The review did not finish', code);
}
