import type { HistorySource, HumanReview, MergedPullRequest, RepoRef } from '../types.ts';
import { changedFilesOf, createGithubHttp, isObject, jsonOf } from './http.ts';
import { authorOf, generalCommentOf, inlineCommentOf, reviewOf } from './objects.ts';

const LIST_PAGES = 10;
const PULL_PAGES = 20;
const PAGE_SIZE = 100; // the page size the client asks for
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const bad = (): Error => new Error('github_bad_response');

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function required(v: unknown): string {
  if (typeof v !== 'string' || v === '') throw bad();
  return v;
}

function objectItem(v: unknown): Record<string, unknown> {
  if (!isObject(v)) throw bad();
  return v;
}

function dayStart(day: string): number {
  const ms = DAY.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(ms)) throw new Error('bad_window');
  return ms;
}

function pullOf(p: Record<string, unknown>): MergedPullRequest {
  const base = objectItem(p.base);
  const head = objectItem(p.head);
  if (typeof p.number !== 'number' || !Number.isInteger(p.number)) throw bad();
  return {
    number: p.number, title: text(p.title), description: text(p.body), ...authorOf(p.user),
    baseBranch: required(base.ref), headBranch: required(head.ref), baseSha: required(base.sha), headSha: required(head.sha),
    mergedAt: required(p.merged_at),
  };
}

export function createGithubHistorySource(opts: { token: string; fetch: typeof fetch; apiBase?: string }): HistorySource {
  const http = createGithubHttp(opts);

  return {
    async listMergedPullRequests(repo, window, limit) {
      const since = dayStart(window.since);
      const until = dayStart(window.until);
      const url = `${http.repoUrl(repo)}/pulls?state=closed&sort=updated&direction=desc`;
      const kept: MergedPullRequest[] = [];
      const done = (pageLimitReached: boolean) => ({ pullRequests: kept, pageLimitReached });
      let pagesRead = 0;
      // Newest update first: once an item was last touched before the window, no later item can have merged inside it.
      for await (const items of http.pages(url, PULL_PAGES)) {
        pagesRead += 1;
        for (const raw of items) {
          if (kept.length >= limit) return done(false);
          const p = objectItem(raw);
          const updated = Date.parse(text(p.updated_at));
          if (Number.isNaN(updated)) throw bad();
          if (updated < since) return done(false);
          if (typeof p.merged_at !== 'string') continue;
          const merged = Date.parse(p.merged_at);
          if (Number.isNaN(merged)) throw bad();
          if (merged >= since && merged < until) kept.push(pullOf(p));
        }
        if (kept.length >= limit) return done(false);
        // A full last page means more items were there to read.
        if (pagesRead >= PULL_PAGES) return done(items.length >= PAGE_SIZE);
      }
      return done(false);
    },

    async pullRequest(repo, number) {
      const res = await http.send('GET', `${http.repoUrl(repo)}/pulls/${number}`, 'application/vnd.github+json');
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`github_${res.status}`);
      const body = objectItem(await jsonOf(res));
      return typeof body.merged_at === 'string' ? pullOf(body) : null;
    },

    async listReviews(repo, number) {
      const items = await http.paged(`${http.repoUrl(repo)}/pulls/${number}/reviews`, LIST_PAGES);
      const out: HumanReview[] = [];
      for (const raw of items) {
        const review = reviewOf(raw);
        if (review !== null) out.push(review);
      }
      return out;
    },

    async listInlineComments(repo, number) {
      const items = await http.paged(`${http.repoUrl(repo)}/pulls/${number}/comments`, LIST_PAGES);
      return items.map(inlineCommentOf);
    },

    async listGeneralComments(repo, number) {
      const items = await http.paged(`${http.repoUrl(repo)}/issues/${number}/comments`, LIST_PAGES);
      return items.map(generalCommentOf);
    },

    async compare(repo: RepoRef, base: string, head: string) {
      const url = `${http.repoUrl(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`;
      const res = await http.send('GET', url, 'application/vnd.github+json');
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`github_${res.status}`);
      const body = await jsonOf(res);
      const files = changedFilesOf(body);
      return { mergeBase: required(objectItem(objectItem(body).merge_base_commit).sha), files };
    },
  };
}
