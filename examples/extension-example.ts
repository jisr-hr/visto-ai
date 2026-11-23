// An example extension module: a working sample of the contract in src/extensions/types.ts.
// Everything in it is invented. Name it in the config's `extensions` block to try it.
import { timingSafeEqual } from 'node:crypto';
import type { ExtensionFactory, RouteAnswer } from '../src/extensions/types.ts';

const example: ExtensionFactory = (setup) => {
  // The secret a caller must send to report feedback. With no secret set, every request is refused.
  const secret = typeof setup.options.secret === 'string' ? setup.options.secret : '';

  function knowsSecret(given: string | undefined): boolean {
    if (secret === '' || given === undefined) return false;
    const expected = Buffer.from(secret);
    const actual = Buffer.from(given);
    // timingSafeEqual needs buffers of equal length; a different length is a wrong secret.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  return {
    // Context for the reviewer. A real module would look up the pull request's ticket here.
    async context() {
      return {
        status: 'ok',
        label: 'example note',
        text: 'This text comes from the example extension. A real module would return the ticket of the pull request here.',
        criteria: ['The change has a test.', 'The pull request says what it changes.'],
      };
    },

    // Told once for each published review. A real module would send a chat message here.
    async notify(notice) {
      setup.log({ what: 'review_published', run: notice.run, needs_human: notice.needsHuman });
    },

    // Answers requests under /extensions/<name>/. Only POST /feedback is known.
    async route(request): Promise<RouteAnswer> {
      if (request.method !== 'POST' || request.path !== '/feedback') return { status: 404, body: 'not_found' };
      if (!knowsSecret(request.headers['x-example-secret'])) return { status: 401, body: 'unauthorized' };

      // The body must be JSON: { "run": 12, "login": "octo-dev", "vote": "up" or "down", "reason": "optional text" }.
      let answer: unknown;
      try {
        answer = JSON.parse(request.body.toString('utf8'));
      } catch {
        return { status: 400, body: 'bad_request' };
      }
      if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return { status: 400, body: 'bad_request' };
      const { run, login, vote, reason } = answer as Record<string, unknown>;
      if (typeof run !== 'number' || typeof login !== 'string' || (vote !== 'up' && vote !== 'down')
        || (reason !== undefined && typeof reason !== 'string')) {
        return { status: 400, body: 'bad_request' };
      }

      // The service checks the answer and stores it; it never rejects.
      const outcome = await setup.reportFeedback({ run, login, vote, ...(reason === undefined ? {} : { reason }) });
      if (!outcome.ok) return { status: 422, body: outcome.code };
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
    },
  };
};

export default example;
