import type { AppInfo, PullRequestRef, ReviewThread, ThreadComment } from '../types.ts';
import type { AppAuth } from './app-auth.ts';
import { isObject, jsonOf } from './http.ts';
import { authorOf } from './objects.ts';

export const MAX_THREAD_PAGES = 20;
export const MAX_REPLY_PAGES = 20;

const COMMENT_FIELDS = 'id fullDatabaseId body createdAt author{login __typename} pullRequestReview{fullDatabaseId}';

const LIST_THREADS = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo{hasNextPage endCursor}
        nodes {
          id isResolved path line diffSide resolvedBy{login}
          comments(first: 50) { pageInfo{hasNextPage endCursor} nodes { ${COMMENT_FIELDS} } }
        }
      }
    }
  }
}`;

const LIST_COMMENTS = `query($thread: ID!, $after: String) {
  node(id: $thread) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $after) { pageInfo{hasNextPage endCursor} nodes { ${COMMENT_FIELDS} } }
    }
  }
}`;

const REPLY = 'mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { id } } }';
const EDIT = 'mutation($comment: ID!, $body: String!) { updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $comment, body: $body}) { pullRequestReviewComment { id } } }';
const RESOLVE = 'mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { id } } }';

const bad = (): Error => new Error('github_bad_response');

function digits(id: string): string {
  if (!/^[0-9]+$/.test(id)) throw new Error('github_bad_path');
  return id;
}

/** A database id as GitHub writes it in GraphQL: a whole number, or a string of digits. */
function idText(v: unknown): string | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return v;
  return null;
}

const accountName = (login: string): string => login.toLowerCase().replace(/\[bot\]$/, '');

interface Connection { nodes: unknown[]; hasNext: boolean; cursor: string | null }

function connectionOf(v: unknown): Connection {
  if (!isObject(v) || !Array.isArray(v.nodes) || !isObject(v.pageInfo) || typeof v.pageInfo.hasNextPage !== 'boolean') throw bad();
  const cursor = v.pageInfo.endCursor;
  if (v.pageInfo.hasNextPage && (typeof cursor !== 'string' || cursor === '')) throw bad();
  return { nodes: v.nodes, hasNext: v.pageInfo.hasNextPage, cursor: typeof cursor === 'string' ? cursor : null };
}

export function createGithubThreads(opts: { auth: AppAuth; info: { read(): Promise<AppInfo> }; fetch: typeof fetch; apiBase?: string }) {
  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');

  async function once(token: string, query: string, variables: Record<string, unknown>): Promise<Response> {
    try {
      return await opts.fetch(`${apiBase}/graphql`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'visto-ai',
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw new Error('github_network');
    }
  }

  // The only place anything is sent to GraphQL. A mutation is sent once; a read is tried once more, at once,
  // after a network failure or a status of 500 or more.
  async function send(token: string, query: string, variables: Record<string, unknown>, read: boolean): Promise<Record<string, unknown>> {
    let res: Response | undefined;
    for (let attempt = 0; res === undefined; attempt += 1) {
      const retry = read && attempt === 0;
      try {
        const got = await once(token, query, variables);
        if (got.status >= 500 && retry) continue;
        res = got;
      } catch (error) {
        if (!retry) throw error;
      }
    }
    if (!res.ok) throw new Error(`github_${res.status}`);
    const answer = await jsonOf(res);
    if (isObject(answer) && Array.isArray(answer.errors) && answer.errors.length > 0) {
      const first = answer.errors[0];
      throw new Error(isObject(first) && first.type === 'FORBIDDEN' ? 'github_forbidden' : 'github_graphql');
    }
    if (!isObject(answer) || !isObject(answer.data)) throw bad();
    return answer.data;
  }

  const commentOf = (raw: unknown, botName: string): ThreadComment => {
    if (!isObject(raw) || typeof raw.id !== 'string') throw bad();
    const id = idText(raw.fullDatabaseId);
    if (id === null) throw bad();
    const user = isObject(raw.author) ? raw.author : null;
    const type = user === null ? undefined : user.__typename;
    const { author, authorIsBot } = authorOf(user === null ? null : { login: user.login, type });
    const review = isObject(raw.pullRequestReview) ? idText(raw.pullRequestReview.fullDatabaseId) : null;
    return {
      id, node: raw.id, author, authorIsBot: user === null ? true : authorIsBot,
      byApp: user !== null && type === 'Bot' && typeof user.login === 'string' && accountName(user.login) === botName,
      reviewId: review, body: typeof raw.body === 'string' ? raw.body : '', at: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    };
  };

  async function restOfComments(token: string, thread: string, first: Connection): Promise<unknown[]> {
    const nodes = [...first.nodes];
    let cursor = first.cursor;
    let more = first.hasNext;
    for (let pages = 0; more; pages += 1) {
      if (pages >= MAX_REPLY_PAGES) throw new Error('github_too_many_pages');
      const data = await send(token, LIST_COMMENTS, { thread, after: cursor }, true);
      const node = data.node;
      if (!isObject(node)) throw bad();
      const next = connectionOf(node.comments);
      nodes.push(...next.nodes);
      cursor = next.cursor;
      more = next.hasNext;
    }
    return nodes;
  }

  return {
    async listThreads(ref: PullRequestRef, installation: string): Promise<ReviewThread[]> {
      digits(installation);
      const token = await opts.auth.installationToken(installation);
      const botName = accountName((await opts.info.read()).botLogin);
      const threads: ReviewThread[] = [];
      let after: string | null = null;
      for (let pages = 0; ; pages += 1) {
        const data = await send(token, LIST_THREADS, { owner: ref.owner, name: ref.repo, number: ref.number, after }, true);
        const repository = data.repository;
        const pullRequest = isObject(repository) ? repository.pullRequest : undefined;
        if (!isObject(pullRequest)) throw bad();
        const connection = connectionOf(pullRequest.reviewThreads);
        for (const raw of connection.nodes) {
          if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.path !== 'string') throw bad();
          const first = connectionOf(raw.comments);
          const comments = (first.hasNext ? await restOfComments(token, raw.id, first) : first.nodes).map((c) => commentOf(c, botName));
          if (comments.length === 0) continue;
          const resolved = raw.isResolved === true;
          const by = isObject(raw.resolvedBy) && typeof raw.resolvedBy.login === 'string' ? raw.resolvedBy.login : null;
          threads.push({
            id: raw.id, path: raw.path, side: raw.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
            line: typeof raw.line === 'number' && Number.isInteger(raw.line) ? raw.line : null,
            resolved, resolvedByApp: resolved && by !== null && accountName(by) === botName, comments,
          });
        }
        if (!connection.hasNext) return threads;
        if (pages + 1 >= MAX_THREAD_PAGES) throw new Error('github_too_many_pages');
        after = connection.cursor;
      }
    },

    async replyToThread(installation: string, threadId: string, body: string): Promise<void> {
      digits(installation);
      await send(await opts.auth.installationToken(installation), REPLY, { thread: threadId, body }, false);
    },

    async editThreadComment(installation: string, commentNode: string, body: string): Promise<void> {
      digits(installation);
      await send(await opts.auth.installationToken(installation), EDIT, { comment: commentNode, body }, false);
    },

    async resolveThread(installation: string, threadId: string): Promise<void> {
      digits(installation);
      await send(await opts.auth.installationToken(installation), RESOLVE, { thread: threadId }, false);
    },
  };
}
