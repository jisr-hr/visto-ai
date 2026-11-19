import { isShortCode } from './codes.ts';

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

/** Whether a commenter with this association with the repository may command the service: an owner, a member or a collaborator. */
export function mayCommand(association: string | null): boolean {
  return association === 'owner' || association === 'member' || association === 'collaborator';
}

/** The command a comment gives, read from its first line that is not empty. */
export function commandOf(body: string): 'review' | null {
  const first = body.split(/\r\n|\r|\n/).map((line) => line.trim()).find((line) => line !== '');
  return first !== undefined && /^\/review([ \t]|$)/i.test(first) ? 'review' : null;
}

function sentence(login: string | null, text: string, code: string): string {
  const who = login !== null && LOGIN.test(login) ? `@${login} ` : '';
  const shown = isShortCode(code) ? code : 'internal_error';
  return `${who}${text} (\`${shown}\`).`;
}

/** The one sentence the service answers a refused command with. */
export function refusalText(login: string | null, code: string): string {
  return sentence(login, 'The review was not started', code);
}

/** The one sentence it answers a command that failed with. */
export function failureText(login: string | null, code: string): string {
  return sentence(login, 'The review did not finish', code);
}
