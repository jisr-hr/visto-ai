// Sign-in through the GitHub App with PKCE, sessions in the database that each belong to an account, the token for changes,
// and who may open the UI (UI design 3.2; calls 10, 11, 12 and 30; the password design 4.4 and 4.5, calls 17, 18 and 24). No
// answer, log line or error holds a code, a state, a verifier, a session id, the token, the client secret, a login or a name,
// but the cookies and the location the step itself sets.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { UiConfig } from '../config/load.ts';
import type { Db } from '../db/types.ts';
import { MAX_ACCOUNTS, githubSignIn } from '../db/ui-accounts.ts';
import type { AccountKind, AccountRow, Role } from '../db/ui-accounts.ts';
import { createSession, deleteExpired, deleteSession, liveStates, readSession, saveState, takeState } from '../db/ui-sessions.ts';
import { SIGN_IN_TIMEOUT_MS } from '../forge/types.ts';
import type { ForgeChecks, ForgeSignIn, SignedIn } from '../forge/types.ts';
import { codeOf } from '../shell/codes.ts';
import type { UiAnswer } from '../shell/http.ts';
import { SECURITY_HEADERS, json, redirect } from './headers.ts';

export const SESSION_COOKIE = '__Host-visto_session';
export const STATE_COOKIE = '__Host-visto_oauth';
export const CSRF_HEADER = 'x-visto-csrf';
export const SESSION_MS = 12 * 3_600_000;
export const STATE_MS = 10 * 60_000;
export const SWEEP_MS = 60_000;      // expired rows are deleted at most once in this time
export const MAX_LIVE_STATES = 1000;
export interface AuthDeps {
  db: Db;
  // Never the client id or secret, which only the adapter holds: the config's `ui` itself is refused by type.
  ui: Pick<UiConfig, 'accounts' | 'teams' | 'publicUrl'> & { clientId?: never; clientSecret?: never };
  signIn: ForgeSignIn | null;   // null: GitHub sign-in off
  checks: Pick<ForgeChecks, 'isTeamMember'>;
  clock: () => Date; log: (entry: Record<string, unknown>) => void;
  random?: () => string;   // 32 random bytes in base64url; absent: randomBytes(32)
}
/** `login`: the account's name. */
export interface Session { login: string; idHash: string; csrf: string; accountId: number; kind: AccountKind; role: Role }
export interface Auth {
  start(): Promise<UiAnswer>;                                                          // GET /api/auth/start
  finish(query: URLSearchParams, cookies: Record<string, string>): Promise<UiAnswer>;  // GET /api/auth/callback
  sessionOf(cookies: Record<string, string>): Promise<Session | null>;
  signOut(session: Session): Promise<UiAnswer>;                                        // POST /api/auth/signout, once the token is checked
}

/** A session id: 32 random bytes in base64url. */
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
/** The state cookie: the state and the verifier, each 32 random bytes in base64url. */
const STATE_VALUE = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;

// Rule 3: no Domain, so the __Host- prefix holds.
const stateCookie = (state: string, verifier: string): string =>
  `${STATE_COOKIE}=${state}.${verifier}; Path=/; Max-Age=${STATE_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
const STATE_CLEARED = `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
}
const SESSION_CLEARED = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

export function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
const challengeOf = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');
const tokenOf = (id: string): string => createHash('sha256').update('csrf:' + id).digest('base64url');
/** A time as an ISO string; a clock that gives no time throws here, as a database step would. */
const iso = (ms: number): string => new Date(ms).toISOString();

/** Two secrets compared in constant time; strings of different lengths are never equal. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The work, or a rejection with github_network once SIGN_IN_TIMEOUT_MS have passed, whichever comes first; the timer is cleared
 * as soon as either settles, so none is left running.
 */
async function inTime<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error('github_network')); }, SIGN_IN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A cookie the request sent, read as the object's own key only. */
const own = (cookies: Record<string, string>, name: string): string | undefined => (Object.hasOwn(cookies, name) ? cookies[name] : undefined);

export function cookiesOf(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined) return cookies;
  for (const piece of header.split(';')) {
    const pair = piece.trim();
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq);
    if (Object.hasOwn(cookies, name)) continue;
    // Defined, not assigned: a name such as __proto__ is a key like any other.
    Object.defineProperty(cookies, name, { value: pair.slice(eq + 1), enumerable: true, writable: true, configurable: true });
  }
  return cookies;
}

export function csrfOk(session: Session, header: string | undefined): boolean {
  return header !== undefined && sameSecret(header, session.csrf);
}

type Outcome = 'denied' | 'state' | 'github' | 'not_allowed' | 'unverified' | 'full' | 'failed';
type Ending = { outcome: Outcome; reason: string | null } | { outcome: 'ok'; reason: null; id: string };
const refuse = (outcome: Outcome, reason: string | null = null): Ending => ({ outcome, reason });

/** One for the service: it keeps when it last deleted expired rows. */
export function createAuth(deps: AuthDeps): Auth {
  const random = deps.random ?? ((): string => randomBytes(32).toString('base64url'));
  const callback = `${deps.ui.publicUrl}/api/auth/callback`;
  const accounts = new Set(deps.ui.accounts.map((login) => login.toLowerCase()));
  const teams = deps.ui.teams;
  let sweptAt: number | null = null;

  // Call 11: a login named in the file, else an active member of one of the teams. Every team is read at once; the first one
  // written that answers yes lets the person in. With no yes, a team that could not be read refuses as it does alone.
  async function wayIn(signIn: ForgeSignIn, login: string): Promise<{ via: string } | Ending> {
    if (accounts.has(login.toLowerCase())) return { via: 'account' };
    const answers = await Promise.all(teams.map((team) => memberOf(signIn, team, login)));
    const at = answers.indexOf(true);
    if (at >= 0) return { via: teams[at]! };
    return answers.find((answer) => answer !== false && answer !== true) ?? refuse('not_allowed');
  }

  // Whether the login is an active member of the team, read through the app's installation on its organisation; an Ending
  // when it cannot be read.
  async function memberOf(signIn: ForgeSignIn, team: string, login: string): Promise<boolean | Ending> {
    let installation: string | null;
    try {
      installation = await signIn.orgInstallation(team.split('/')[0] ?? '');
    } catch (error) {
      return refuse('unverified', codeOf(error));
    }
    if (installation === null) return refuse('unverified', 'not_installed');
    try {
      // The gate's adapter tries a call again and waits up to a minute each time: the sign-in waits for it 10 seconds at most.
      return (await inTime(deps.checks.isTeamMember(installation, team, login))) === true;
    } catch (error) {
      return refuse('unverified', codeOf(error));
    }
  }

  async function decide(signIn: ForgeSignIn, query: URLSearchParams, cookies: Record<string, string>): Promise<Ending> {
    if (query.has('error')) return refuse('denied');
    const code = query.get('code');
    const state = query.get('state');
    const cookie = own(cookies, STATE_COOKIE);
    const parts = cookie === undefined ? null : STATE_VALUE.exec(cookie);
    // A parameter written empty is none. Nothing is taken until the cookie and the query name the same state.
    if (code === null || code === '' || state === null || state === '' || parts === null || !sameSecret(parts[1]!, state)) return refuse('state');
    const verifier = parts[2]!;
    let now: number;
    let taken: { verifierHash: string } | null;
    try {
      now = deps.clock().getTime();
      taken = await takeState(deps.db, hashOf(state), iso(now));
    } catch {
      return refuse('failed');
    }
    if (taken === null || !sameSecret(hashOf(verifier), taken.verifierHash)) return refuse('state');

    let user: SignedIn;
    try {
      user = await signIn.signedIn(code, verifier, callback);
    } catch (error) {
      return refuse('github', codeOf(error));
    }
    if (user.isBot) return refuse('not_allowed');
    const way = await wayIn(signIn, user.login);
    if (!('via' in way)) return way;

    // Call 18: the account of the login, made as a viewer at its first sign-in; a row made is logged as soon as it is, so also
    // when its session then fails.
    let account: AccountRow;
    try {
      const found = await githubSignIn(deps.db, user.login, iso(now), MAX_ACCOUNTS);
      if (found === 'full') return refuse('full');
      if (found.made) deps.log({ event: 'ui_account', change: 'made', role: found.account.role });
      account = found.account;
    } catch {
      return refuse('failed');
    }
    try {
      const id = random();
      await createSession(deps.db, {
        idHash: hashOf(id), login: account.name, via: way.via, accountId: account.id, at: iso(now), expiresAt: iso(now + SESSION_MS),
      });
      return { outcome: 'ok', reason: null, id };
    } catch {
      return refuse('failed');
    }
  }

  // Call 11: the way a session was let in must still hold in this config, whatever else the config names.
  function stillHolds(row: { login: string; via: string }): boolean {
    if (row.via === 'account') return accounts.has(row.login.toLowerCase());
    return teams.some((team) => row.via.toLowerCase() === team.toLowerCase());
  }

  // A password account's session holds while it is one, whatever the file names; a GitHub account's while its way in holds.
  function holds(row: { login: string; via: string; kind: AccountKind }): boolean {
    if (row.kind === 'password') return row.via === 'password';
    return row.kind === 'github' && stillHolds(row);
  }

  return {
    async start() {
      // GitHub sign-in off: nothing is read or logged.
      if (deps.signIn === null) return json(404, { error: 'not_found' });
      const signIn = deps.signIn;
      try {
        const now = deps.clock().getTime();
        if (sweptAt === null || now - sweptAt >= SWEEP_MS) {
          await deleteExpired(deps.db, iso(now));
          sweptAt = now;
        }
        if (await liveStates(deps.db, iso(now)) >= MAX_LIVE_STATES) return json(503, { error: 'busy' });
        const state = random();
        const verifier = random();
        await saveState(deps.db, { stateHash: hashOf(state), verifierHash: hashOf(verifier), expiresAt: iso(now + STATE_MS) });
        return redirect(signIn.authorizeUrl(state, challengeOf(verifier), callback), { 'set-cookie': stateCookie(state, verifier) });
      } catch {
        return redirect('/ui/signin?error=failed');
      }
    },

    async finish(query, cookies) {
      if (deps.signIn === null) return json(404, { error: 'not_found' });
      const ending = await decide(deps.signIn, query, cookies);
      deps.log({ event: 'ui_signin', way: 'github', outcome: ending.outcome, reason: ending.reason });
      if (ending.outcome === 'ok' && 'id' in ending) return redirect('/ui/', { 'set-cookie': [sessionCookie(ending.id), STATE_CLEARED] });
      return redirect(`/ui/signin?error=${ending.outcome}`, { 'set-cookie': STATE_CLEARED });
    },

    async sessionOf(cookies) {
      const id = own(cookies, SESSION_COOKIE);
      if (id === undefined || !SESSION_ID.test(id)) return null;
      const idHash = hashOf(id);
      let now: string;
      try {
        now = iso(deps.clock().getTime());
      } catch {
        // A clock that gives no time reads no session.
        return null;
      }
      // A database that rejects (the read or the last use's write) is an error for the route, never a sign-out.
      const row = await readSession(deps.db, idHash, now);
      if (row === null || !holds(row)) return null;
      return { login: row.login, idHash, csrf: tokenOf(id), accountId: row.accountId, kind: row.kind, role: row.role };
    },

    async signOut(session) {
      await deleteSession(deps.db, session.idHash);
      return { status: 204, headers: { 'set-cookie': SESSION_CLEARED, 'cache-control': 'no-store', ...SECURITY_HEADERS }, body: '' };
    },
  };
}
