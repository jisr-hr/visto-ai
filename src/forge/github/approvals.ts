import type { ForgeApprovals, PullRequestRef } from '../types.ts';
import type { AppAuth } from './app-auth.ts';
import { createGithubHttp, isObject, jsonOf } from './http.ts';
import { ownReviewStateOf } from './objects.ts';

export const MAX_RULE_PAGES = 10;

const JSON_ACCEPT = 'application/vnd.github+json';

const bad = (): Error => new Error('github_bad_response');
const badPath = (): Error => new Error('github_bad_path');

function digits(value: string): string {
  if (!/^[0-9]+$/.test(value)) throw badPath();
  return value;
}
// A branch is one segment of the path: its slashes are encoded. A name the URL would read as a step up,
// or that cannot be encoded, is refused; git allows neither.
function branchOf(value: string): string {
  if (value === '' || value === '.' || value === '..' || !value.isWellFormed()) throw badPath();
  return encodeURIComponent(value);
}

type Rule = 'dismissed' | 'gated' | 'kept';

// Whether a list of required checks names `check` with this app as its only source: a check any source may report
// does not hold a merge to the gate.
function requires(list: unknown, appKey: 'integration_id' | 'app_id', check: string | undefined, appId: string): boolean {
  return check !== undefined && Array.isArray(list)
    && list.some((c) => isObject(c) && c.context === check && typeof c[appKey] === 'number' && String(c[appKey]) === appId);
}

// What a ruleset's rules say: a pull request rule that dismisses an approval when new commits are pushed, else the check
// required from this app. Every item is checked first: a list with one item of another shape says nothing.
function rulesSay(items: unknown[], check: string | undefined, appId: string): Rule {
  let dismisses = false;
  let gated = false;
  for (const item of items) {
    if (!isObject(item) || typeof item.type !== 'string') throw bad();
    if (!isObject(item.parameters)) continue;
    if (item.type === 'pull_request' && item.parameters.dismiss_stale_reviews_on_push === true) dismisses = true;
    if (item.type === 'required_status_checks' && requires(item.parameters.required_status_checks, 'integration_id', check, appId)) gated = true;
  }
  return dismisses ? 'dismissed' : gated ? 'gated' : 'kept';
}

export function createGithubApprovals(opts: { auth: AppAuth; appId: string; fetch: typeof fetch; apiBase?: string }): ForgeApprovals {
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');

  // The repository's name and the pull request's number are checked before a token is asked for.
  const probe = createGithubHttp({ token: '', fetch: opts.fetch, apiBase });
  async function httpFor(installation: string, ref: PullRequestRef) {
    probe.repoUrl(ref);
    if (!Number.isSafeInteger(ref.number) || ref.number <= 0) throw badPath();
    const token = await opts.auth.installationToken(installation);
    return { token, http: createGithubHttp({ token, fetch: opts.fetch, apiBase }) };
  }

  // The only place this adapter writes. Once, whatever came back, because it may have taken effect; a redirect is not followed.
  async function put(token: string, url: string, body: unknown): Promise<Response> {
    try {
      return await opts.fetch(url, {
        method: 'PUT',
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'visto-ai',
          Accept: JSON_ACCEPT,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('github_network');
    }
  }

  // What the branch's classic protection says, as the rules do. A 404 is no protection.
  async function protectionSays(http: ReturnType<typeof createGithubHttp>, url: string, check: string | undefined): Promise<Rule> {
    const res = await http.send('GET', url, JSON_ACCEPT);
    if (res.status === 404) return 'kept';
    if (res.status !== 200) throw new Error(`github_${res.status}`);
    const body = await jsonOf(res);
    if (!isObject(body)) throw bad();
    const reviews = body.required_pull_request_reviews;
    if (isObject(reviews) && reviews.dismiss_stale_reviews === true) return 'dismissed';
    const checks = body.required_status_checks;
    return isObject(checks) && requires(checks.checks, 'app_id', check, opts.appId) ? 'gated' : 'kept';
  }

  return {
    async staleApprovals(ref: PullRequestRef, installation: string, branch: string, check?: string): Promise<Rule> {
      digits(installation);
      const name = branchOf(branch);
      const { http } = await httpFor(installation, ref);
      const repo = http.repoUrl(ref);
      // Either form saying so is enough; a form that could not be read is no answer, and the first failure is the one given.
      let failure: unknown = null;
      try {
        const said = rulesSay(await http.paged(`${repo}/rules/branches/${name}`, MAX_RULE_PAGES), check, opts.appId);
        if (said !== 'kept') return said;
      } catch (error) {
        failure = error;
      }
      try {
        const said = await protectionSays(http, `${repo}/branches/${name}/protection`, check);
        if (said !== 'kept') return said;
      } catch (error) {
        if (failure === null) failure = error;
      }
      if (failure !== null) throw failure;
      return 'kept';
    },

    async readReview(ref: PullRequestRef, installation: string, reviewId: string) {
      digits(installation);
      digits(reviewId);
      const { http } = await httpFor(installation, ref);
      const res = await http.send('GET', `${http.repoUrl(ref)}/pulls/${ref.number}/reviews/${reviewId}`, JSON_ACCEPT);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`github_${res.status}`);
      const body = await jsonOf(res);
      if (!isObject(body) || typeof body.state !== 'string') throw bad();
      return { state: ownReviewStateOf(body.state), commit: typeof body.commit_id === 'string' ? body.commit_id : null };
    },

    async dismissReview(ref: PullRequestRef, installation: string, reviewId: string, message: string): Promise<void> {
      digits(installation);
      digits(reviewId);
      const { token, http } = await httpFor(installation, ref);
      const res = await put(token, `${http.repoUrl(ref)}/pulls/${ref.number}/reviews/${reviewId}/dismissals`, { message, event: 'DISMISS' });
      if (!res.ok) throw new Error(`github_${res.status}`);
      let answer: unknown;
      try {
        answer = await jsonOf(res);
      } catch {
        throw new Error('dismiss_not_taken');
      }
      if (!isObject(answer) || answer.state !== 'DISMISSED') throw new Error('dismiss_not_taken');
    },
  };
}
