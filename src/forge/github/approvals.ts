import type { ForgeApprovals, OwnReviewState, PullRequestRef } from '../types.ts';
import type { AppAuth } from './app-auth.ts';
import { createGithubHttp, isObject, jsonOf } from './http.ts';

export const MAX_RULE_PAGES = 10;

const JSON_ACCEPT = 'application/vnd.github+json';
// A review's state as listOwnReviews maps it; any other is 'other'.
const OWN_STATE = new Map<string, OwnReviewState>([['APPROVED', 'approved'], ['DISMISSED', 'dismissed'], ['COMMENTED', 'commented']]);

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

// Whether a ruleset's pull request rule dismisses an approval when new commits are pushed. Every item is checked first:
// a list with one item of another shape says nothing.
function rulesDismiss(items: unknown[]): boolean {
  let dismisses = false;
  for (const item of items) {
    if (!isObject(item) || typeof item.type !== 'string') throw bad();
    if (item.type === 'pull_request' && isObject(item.parameters) && item.parameters.dismiss_stale_reviews_on_push === true) dismisses = true;
  }
  return dismisses;
}

export function createGithubApprovals(opts: { auth: AppAuth; fetch: typeof fetch; apiBase?: string }): ForgeApprovals {
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

  // Whether the branch's classic protection dismisses stale approvals. A 404 is no protection.
  async function protectionDismisses(http: ReturnType<typeof createGithubHttp>, url: string): Promise<boolean> {
    const res = await http.send('GET', url, JSON_ACCEPT);
    if (res.status === 404) return false;
    if (res.status !== 200) throw new Error(`github_${res.status}`);
    const body = await jsonOf(res);
    if (!isObject(body)) throw bad();
    const reviews = body.required_pull_request_reviews;
    return isObject(reviews) && reviews.dismiss_stale_reviews === true;
  }

  return {
    async staleApprovals(ref: PullRequestRef, installation: string, branch: string): Promise<'dismissed' | 'kept'> {
      digits(installation);
      const name = branchOf(branch);
      const { http } = await httpFor(installation, ref);
      const repo = http.repoUrl(ref);
      // Either form saying so is enough; a form that could not be read is no answer, and the first failure is the one given.
      let failure: unknown = null;
      try {
        if (rulesDismiss(await http.paged(`${repo}/rules/branches/${name}`, MAX_RULE_PAGES))) return 'dismissed';
      } catch (error) {
        failure = error;
      }
      try {
        if (await protectionDismisses(http, `${repo}/branches/${name}/protection`)) return 'dismissed';
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
      return { state: OWN_STATE.get(body.state) ?? 'other', commit: typeof body.commit_id === 'string' ? body.commit_id : null };
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
