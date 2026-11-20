import type { AppInfo, ForgeWriter, PostedComment, PullRequestRef, ReviewDraft } from '../types.ts';
import type { AppAuth } from './app-auth.ts';
import { createGithubHttp, isObject, jsonOf } from './http.ts';
import { createGithubThreads } from './threads.ts';

export const MAX_REVIEW_PAGES = 10;
export const MAX_COMMENT_PAGES = 20;

const bad = (): Error => new Error('github_bad_response');
const wholeNumber = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function digits(id: string): string {
  if (!/^[0-9]+$/.test(id)) throw new Error('github_bad_path');
  return id;
}

export function createGithubWriter(opts: { auth: AppAuth; info: { read(): Promise<AppInfo> }; fetch: typeof fetch; apiBase?: string }): ForgeWriter {
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');

  async function httpFor(installation: string) {
    const token = await opts.auth.installationToken(installation);
    const http = createGithubHttp({ token, fetch: opts.fetch, apiBase });
    return { token, http };
  }

  // The only place the writer sends anything. Once: a post is never repeated,
  // whatever came back, because it may have taken effect. A redirect is not followed: it is an answer like any other.
  async function post(token: string, url: string, body: unknown): Promise<Response> {
    try {
      return await opts.fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'visto-ai',
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('github_network');
    }
  }

  const timeOf = (v: unknown): number => {
    const at = typeof v === 'string' ? Date.parse(v) : Number.NaN;
    return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
  };

  return {
    ...createGithubThreads(opts),

    async publishReview(ref: PullRequestRef, installation: string, draft: ReviewDraft) {
      digits(installation);
      const { token, http } = await httpFor(installation);
      const body: Record<string, unknown> = { commit_id: draft.commit, body: draft.body, event: 'COMMENT' };
      if (draft.comments.length > 0) body.comments = draft.comments.map((c) => ({ path: c.path, side: c.side, line: c.line, body: c.body }));
      const res = await post(token, `${http.repoUrl(ref)}/pulls/${ref.number}/reviews`, body);
      if (res.status === 422) throw new Error('review_rejected');
      if (!res.ok) throw new Error(`github_${res.status}`);
      const answer = await jsonOf(res);
      if (!isObject(answer) || !wholeNumber(answer.id)) throw bad();
      return { id: String(answer.id) };
    },

    async listOwnReviews(ref: PullRequestRef, installation: string) {
      digits(installation);
      const { http } = await httpFor(installation);
      const { botLogin } = await opts.info.read();
      const items = await http.paged(`${http.repoUrl(ref)}/pulls/${ref.number}/reviews`, MAX_REVIEW_PAGES);
      const own: Array<{ id: string; commit: string; at: number }> = [];
      for (const item of items) {
        if (!isObject(item) || !wholeNumber(item.id)) throw bad();
        const user = item.user;
        // authorOf also counts a login ending in "[bot]" as a bot; the app itself must be of type Bot.
        if (!isObject(user) || user.login !== botLogin || user.type !== 'Bot') continue;
        if (typeof item.body !== 'string' || item.body === '') continue;
        if (typeof item.commit_id !== 'string') throw bad();
        own.push({ id: String(item.id), commit: item.commit_id, at: timeOf(item.submitted_at) });
      }
      own.sort((a, b) => (a.at === b.at ? 0 : a.at > b.at ? -1 : 1));
      return own.map(({ id, commit }) => ({ id, commit }));
    },

    async listReviewComments(ref: PullRequestRef, installation: string, reviewId: string) {
      digits(installation);
      digits(reviewId);
      const { http } = await httpFor(installation);
      let items: unknown[];
      try {
        items = await http.paged(`${http.repoUrl(ref)}/pulls/${ref.number}/comments`, MAX_COMMENT_PAGES);
      } catch (error) {
        if (error instanceof Error && error.message === 'github_too_many_pages') return null;
        throw error;
      }
      const comments: PostedComment[] = [];
      for (const item of items) {
        if (!isObject(item)) throw bad();
        if (!wholeNumber(item.pull_request_review_id) || String(item.pull_request_review_id) !== reviewId) continue;
        if (!wholeNumber(item.id) || typeof item.path !== 'string') throw bad();
        comments.push({
          id: String(item.id), path: item.path, side: item.side === 'LEFT' ? 'LEFT' : 'RIGHT',
          line: wholeNumber(item.line) ? item.line : wholeNumber(item.original_line) ? item.original_line : null,
          body: typeof item.body === 'string' ? item.body : '',
        });
      }
      return comments;
    },

    async react(ref: PullRequestRef, installation: string, commentId: string, reaction: 'eyes' | 'confused') {
      digits(installation);
      digits(commentId);
      const { token, http } = await httpFor(installation);
      const res = await post(token, `${http.repoUrl(ref)}/issues/comments/${commentId}/reactions`, { content: reaction });
      if (!res.ok) throw new Error(`github_${res.status}`);
    },

    async comment(ref: PullRequestRef, installation: string, body: string) {
      digits(installation);
      const { token, http } = await httpFor(installation);
      const res = await post(token, `${http.repoUrl(ref)}/issues/${ref.number}/comments`, { body });
      if (!res.ok) throw new Error(`github_${res.status}`);
    },
  };
}
