// The UI's route: the built files, the sign-in routes, the JSON reads of the frame and Activity, and the accounts, under one
// group (UI design 3.1, 3.2 and 5; calls 12, 13, 17, 23, 27 and 30; the password design 4.1, 4.3 and 4.5, calls 19 to 21). Every
// answer is built by headers.ts or files.ts. No answer or log line holds a name, a login, a password or a hash, but the one-time
// password in the answer of the route that made it.
import { codeOf } from '../shell/codes.ts';
import type { UiAnswer, UiRequest, UiRoute } from '../shell/http.ts';
import { accountOf } from './accounts.ts';
import type { AccountChanges, Actor, Made, Refusal } from './accounts.ts';
import { activity, me, reviews } from './api.ts';
import type { ApiDeps } from './api.ts';
import type { AccountAnswer, Accounts, OneTime, Role, Ways } from './api-types.ts';
import { CSRF_HEADER, cookiesOf, csrfOk } from './auth.ts';
import type { Auth, Session } from './auth.ts';
import { fileAnswer } from './files.ts';
import type { UiFiles } from './files.ts';
import { SECURITY_HEADERS, json, redirect } from './headers.ts';
import type { PasswordAuth } from './password-auth.ts';

/** The fixed name a failed handler is logged with (call 30). */
type Handler = 'me' | 'activity' | 'reviews' | 'signout' | 'ways' | 'own_password' | 'accounts' | 'account_new' | 'account_role' | 'account_reset' | 'account_remove';

/** The API's paths, each with the one method it answers. A path here with no case of its own below is not found. */
export const METHODS: ReadonlyMap<string, string> = new Map([
  ['/api/auth/ways', 'GET'], ['/api/auth/start', 'GET'], ['/api/auth/callback', 'GET'],
  ['/api/auth/password', 'POST'], ['/api/auth/first-password', 'POST'], ['/api/auth/signout', 'POST'],
  ['/api/me', 'GET'], ['/api/me/password', 'POST'], ['/api/activity', 'GET'], ['/api/reviews', 'GET'],
  ['/api/accounts', 'GET'], ['/api/accounts/new', 'POST'], ['/api/accounts/role', 'POST'], ['/api/accounts/reset', 'POST'], ['/api/accounts/remove', 'POST'],
]);

/** The status each refusal of an account change answers with. `bad_login` is the command's: the API names an account by its id. */
const REFUSED: Readonly<Record<Refusal, number>> = {
  signed_out: 401, forbidden: 403, not_found: 404, bad_name: 400, bad_login: 400,
  name_taken: 409, full: 409, last_admin: 409, github_account: 409, own_account: 409,
};
/** An account's id in a body: a whole number from 1 to this. */
const MAX_ID = 2147483647;
/** A name in a body is at most this many characters; its rule is the work's. */
const MAX_NAME = 200;

const refused = (status: number, code: string, extra: Record<string, string> = {}): UiAnswer => json(status, { error: code }, extra);
const refusal = (code: Refusal): UiAnswer => refused(REFUSED[code], code);
const noContent = (): UiAnswer => ({ status: 204, headers: { 'cache-control': 'no-store', ...SECURITY_HEADERS }, body: '' });

/** A content-type of JSON: its first value, lower-cased, is `application/json` or starts with `application/json;`. */
function isJson(type: string | undefined): boolean {
  if (type === undefined) return false;
  const lower = type.toLowerCase();
  return lower === 'application/json' || lower.startsWith('application/json;');
}

type Body = Record<string, unknown>;

/** The body, read as UTF-8, as a plain object; null when it is not JSON, or not an object (an array, null, a number, a string). */
function objectOf(body: Buffer): Body | null {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Body : null;
}

/** Exactly these keys, each the object's own. */
function hasExactly(body: Body, keys: readonly string[]): boolean {
  return Object.keys(body).length === keys.length && keys.every((key) => Object.hasOwn(body, key));
}
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_ID;
const isRole = (value: unknown): value is Role => value === 'admin' || value === 'viewer';

/** The body of /api/accounts/new; null when it is not of its shape. */
function newOf(body: Body): { name: string; role: Role } | null {
  if (!hasExactly(body, ['name', 'role'])) return null;
  const { name, role } = body;
  return typeof name === 'string' && name.length <= MAX_NAME && isRole(role) ? { name, role } : null;
}

/** The body of /api/accounts/role; null when it is not of its shape. */
function roleOf(body: Body): { id: number; role: Role } | null {
  if (!hasExactly(body, ['id', 'role'])) return null;
  const { id, role } = body;
  return isId(id) && isRole(role) ? { id, role } : null;
}

/** The body of /api/accounts/reset and /remove; null when it is not of its shape. */
function idOf(body: Body): number | null {
  if (!hasExactly(body, ['id'])) return null;
  const { id } = body;
  return isId(id) ? id : null;
}

/** What a handler behind a session needs past the session: the token for a change, the admin role. */
interface Needs { change: boolean; admin: boolean }
const READ: Needs = { change: false, admin: false };
const CHANGE: Needs = { change: true, admin: false };
const ADMIN_READ: Needs = { change: false, admin: true };
const ADMIN_CHANGE: Needs = { change: true, admin: true };

export function createUiRoute(deps: {
  auth: Auth; passwords: PasswordAuth; accounts: AccountChanges; api: ApiDeps; files: UiFiles;
  ui: { publicUrl: string; github: boolean }; log: (entry: Record<string, unknown>) => void;
}): UiRoute {
  const { auth, passwords, accounts, api, files } = deps;

  /** The work; one that rejects is internal_error, logged with its route's fixed name and its short code only. */
  async function guarded(handler: Handler, work: () => Promise<UiAnswer>): Promise<UiAnswer> {
    try {
      return await work();
    } catch (error) {
      deps.log({ event: 'ui_failed', route: handler, reason: codeOf(error) });
      return refused(500, 'internal_error');
    }
  }

  /**
   * A handler behind a session, its checks in order (call 20): a session (signed_out), the token for a change (csrf), the admin
   * role (forbidden). Each refusal reads nothing after it; the role is the account's at this request.
   */
  function behindSession(request: UiRequest, handler: Handler, needs: Needs, work: (session: Session) => Promise<UiAnswer>): Promise<UiAnswer> {
    return guarded(handler, async () => {
      const session = await auth.sessionOf(cookiesOf(request.headers.cookie));
      if (session === null) return refused(401, 'signed_out');
      if (needs.change && !csrfOk(session, request.headers[CSRF_HEADER])) return refused(403, 'csrf');
      if (needs.admin && session.role !== 'admin') return refused(403, 'forbidden');
      return work(session);
    });
  }

  /** The body's checks, in order: a type of JSON (not_json), then a plain object (bad_request); then the work. */
  async function withBody(request: UiRequest, work: (body: Body) => Promise<UiAnswer>): Promise<UiAnswer> {
    if (!isJson(request.headers['content-type'])) return refused(415, 'not_json');
    const body = objectOf(request.body);
    if (body === null) return refused(400, 'bad_request');
    return work(body);
  }

  /** The two routes that change something without a session (call 21): the origin, exactly the UI's, before anything else. */
  async function fromThePage(request: UiRequest, work: (body: Body) => Promise<UiAnswer>): Promise<UiAnswer> {
    if (request.headers.origin !== deps.ui.publicUrl) return refused(403, 'origin');
    return withBody(request, work);
  }

  /** The actor of a change: the session sessionOf read, read again under the lock by the work. */
  const actorOf = (session: Session): Actor => ({ by: 'session', idHash: session.idHash });
  const oneTimeOf = (made: Made, session: Session): OneTime => ({
    account: accountOf(made.account, api.clock(), session.accountId), oneTimePassword: made.oneTimePassword, expiresAt: made.expiresAt,
  });

  /** An account change behind a session, the token and the admin role, with a body of its shape (rule 1). */
  function change<T>(request: UiRequest, handler: Handler, shape: (body: Body) => T | null, work: (session: Session, given: T) => Promise<UiAnswer>): Promise<UiAnswer> {
    return behindSession(request, handler, ADMIN_CHANGE, (session) => withBody(request, async (body) => {
      const given = shape(body);
      return given === null ? refused(400, 'bad_request') : work(session, given);
    }));
  }

  return async (request) => {
    const { method, path } = request;
    // A method other than GET is the files' own refusal.
    if (path === '/') return method === 'GET' ? redirect('/ui/') : fileAnswer(files, method, path);
    if (path === '/ui' || path.startsWith('/ui/')) return fileAnswer(files, method, path);
    const allowed = METHODS.get(path);
    if (allowed === undefined) return refused(404, 'not_found');
    // Before any read: a known path with another method is refused whoever asks.
    if (method !== allowed) return refused(405, 'method_not_allowed', { allow: allowed });
    switch (path) {
      case '/api/auth/ways':
        return guarded('ways', async () => json(200, { github: deps.ui.github } satisfies Ways));
      // GitHub sign-in off: not found, and nothing is read.
      case '/api/auth/start':
        return deps.ui.github ? auth.start() : refused(404, 'not_found');
      case '/api/auth/callback':
        return deps.ui.github ? auth.finish(new URLSearchParams(request.query), cookiesOf(request.headers.cookie)) : refused(404, 'not_found');
      // Each answers and logs its own failures, and never rejects.
      case '/api/auth/password':
        return fromThePage(request, (body) => passwords.signIn(body));
      case '/api/auth/first-password':
        return fromThePage(request, (body) => passwords.firstPassword(body));
      case '/api/auth/signout':
        return behindSession(request, 'signout', CHANGE, (session) => auth.signOut(session));
      case '/api/me':
        return behindSession(request, 'me', READ, async (session) => json(200, await me(api, session)));
      case '/api/me/password':
        return behindSession(request, 'own_password', CHANGE, (session) => withBody(request, (body) => passwords.change(session, body)));
      case '/api/activity':
        return behindSession(request, 'activity', READ, async () => json(200, await activity(api)));
      case '/api/reviews':
        return behindSession(request, 'reviews', READ, async () => {
          const found = await reviews(api, new URLSearchParams(request.query));
          return found === 'bad_request' ? refused(400, 'bad_request') : json(200, found);
        });
      case '/api/accounts':
        return behindSession(request, 'accounts', ADMIN_READ, async (session) => {
          const now = api.clock();
          const rows = await accounts.list();
          return json(200, { now: now.toISOString(), accounts: rows.map((row) => accountOf(row, now, session.accountId)) } satisfies Accounts);
        });
      case '/api/accounts/new':
        return change(request, 'account_new', newOf, async (session, given) => {
          const made = await accounts.make(actorOf(session), given.name, given.role);
          return typeof made === 'string' ? refusal(made) : json(201, oneTimeOf(made, session));
        });
      case '/api/accounts/role':
        return change(request, 'account_role', roleOf, async (session, given) => {
          const roled = await accounts.setRole(actorOf(session), { id: given.id }, given.role);
          if (typeof roled === 'string') return refusal(roled);
          return json(200, { account: accountOf(roled.account, api.clock(), session.accountId) } satisfies AccountAnswer);
        });
      case '/api/accounts/reset':
        return change(request, 'account_reset', idOf, async (session, id) => {
          const made = await accounts.reset(actorOf(session), { id });
          return typeof made === 'string' ? refusal(made) : json(200, oneTimeOf(made, session));
        });
      case '/api/accounts/remove':
        return change(request, 'account_remove', idOf, async (session, id) => {
          const gone = await accounts.remove(actorOf(session), id);
          return typeof gone === 'string' ? refusal(gone) : noContent();
        });
      default:
        // A path of METHODS with no case of its own reads nothing.
        return refused(404, 'not_found');
    }
  };
}
