// The UI's route: the built files, the sign-in routes and the JSON reads of the frame and Activity, under one group (UI design
// 3.1, 3.2 and 5; calls 12, 13, 17, 23, 27 and 30). Every answer is built by headers.ts or files.ts.
import { codeOf } from '../shell/codes.ts';
import type { UiAnswer, UiRequest, UiRoute } from '../shell/http.ts';
import { activity, me, reviews } from './api.ts';
import type { ApiDeps } from './api.ts';
import { CSRF_HEADER, cookiesOf, csrfOk } from './auth.ts';
import type { Auth, Session } from './auth.ts';
import { fileAnswer } from './files.ts';
import type { UiFiles } from './files.ts';
import { json, redirect } from './headers.ts';

/** The fixed name a failed handler is logged with (call 30). */
type Handler = 'me' | 'activity' | 'reviews' | 'signout';

/** The API's paths, each with the one method it answers. A path here with no case of its own below is not found. */
export const METHODS: ReadonlyMap<string, string> = new Map([
  ['/api/auth/start', 'GET'], ['/api/auth/callback', 'GET'], ['/api/auth/signout', 'POST'],
  ['/api/me', 'GET'], ['/api/activity', 'GET'], ['/api/reviews', 'GET'],
]);

const refused = (status: number, code: string, extra: Record<string, string> = {}): UiAnswer => json(status, { error: code }, extra);

export function createUiRoute(deps: { auth: Auth; api: ApiDeps; files: UiFiles; log: (entry: Record<string, unknown>) => void }): UiRoute {
  const { auth, api, files } = deps;

  /**
   * A handler behind a session: none is signed_out. One that rejects is internal_error, logged with its route's fixed name and its
   * short code only.
   */
  async function behindSession(request: UiRequest, handler: Handler, work: (session: Session) => Promise<UiAnswer>): Promise<UiAnswer> {
    try {
      const session = await auth.sessionOf(cookiesOf(request.headers.cookie));
      if (session === null) return refused(401, 'signed_out');
      return await work(session);
    } catch (error) {
      deps.log({ event: 'ui_failed', route: handler, reason: codeOf(error) });
      return refused(500, 'internal_error');
    }
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
      case '/api/auth/start':
        return auth.start();
      case '/api/auth/callback':
        return auth.finish(new URLSearchParams(request.query), cookiesOf(request.headers.cookie));
      case '/api/auth/signout':
        return behindSession(request, 'signout', async (session) =>
          (csrfOk(session, request.headers[CSRF_HEADER]) ? auth.signOut(session) : refused(403, 'csrf')));
      case '/api/me':
        return behindSession(request, 'me', async (session) => json(200, await me(api, session)));
      case '/api/activity':
        return behindSession(request, 'activity', async () => json(200, await activity(api)));
      case '/api/reviews':
        return behindSession(request, 'reviews', async () => {
          const found = await reviews(api, new URLSearchParams(request.query));
          return found === 'bad_request' ? refused(400, 'bad_request') : json(200, found);
        });
      default:
        // A path of METHODS with no case of its own reads nothing.
        return refused(404, 'not_found');
    }
  };
}
