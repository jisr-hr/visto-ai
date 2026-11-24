import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubWriter } from './writer.ts';
import { MAX_REPLY_PAGES, MAX_THREAD_PAGES } from './threads.ts';
import type { AppAuth } from './app-auth.ts';

const REF = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
const auth: AppAuth = { appToken: () => 'jwt', installationToken: async (id) => `tok-${id}` };
const info = { read: async () => ({ botLogin: 'visto-test[bot]', permissions: {}, events: [] }) };
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
const KINDS = ['reviewThreads', 'node(id', 'addPullRequestReviewThreadReply', 'updatePullRequestReviewComment', 'resolveReviewThread'];

type Answer = Response | Error;
/** Answers by the first kind of query the request's text contains, taking the next answer of that kind's list. */
function github(routes: Record<string, Answer[]>) {
  const seen: Array<{ method: string; path: string; authorization: string | null; variables: unknown; redirect: unknown }> = [];
  const lists = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, [...v]]));
  const stub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: unknown };
    seen.push({ method: init?.method ?? 'GET', path: String(url).replace('https://api.github.com', ''),
      authorization: new Headers(init?.headers).get('authorization'), variables: body.variables, redirect: init?.redirect });
    const kind = KINDS.find((k) => body.query.includes(k));
    const next = kind === undefined ? undefined : lists[kind]?.shift();
    if (next === undefined) return json({ message: 'Not Found' }, 404);
    if (next instanceof Error) throw next;
    return next;
  };
  return { seen, writer: createGithubWriter({ auth, info, fetch: stub as typeof fetch }) };
}

const THREAD = (over: Record<string, unknown> = {}) => ({
  id: 'PRRT_1', isResolved: false, path: 'src/a.ts', line: 12, diffSide: 'RIGHT', resolvedBy: null,
  comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
    { id: 'PRRC_1', fullDatabaseId: '9001', body: '**\\[major]** x', createdAt: '2026-03-01T10:00:00Z', author: { login: 'visto-test', __typename: 'Bot' }, pullRequestReview: { fullDatabaseId: 501 } },
    { id: 'PRRC_2', fullDatabaseId: 9002, body: 'Meant to be so.', createdAt: '2026-03-01T11:00:00Z', author: { login: 'octo-dev', __typename: 'User' }, pullRequestReview: { fullDatabaseId: '777' } },
  ] }, ...over,
});
const COMMENT = (n: number, over: Record<string, unknown> = {}) => ({
  id: `PRRC_${n}`, fullDatabaseId: n, body: `c${n}`, createdAt: '2026-03-01T10:00:00Z', author: { login: 'octo-dev', __typename: 'User' }, pullRequestReview: { fullDatabaseId: 1 }, ...over,
});
const connection = (nodes: unknown[], next: string | null = null) => ({ pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes });
const threadWith = (comments: unknown) => THREAD({ comments });
const page = (nodes: unknown[], next: string | null = null) =>
  json({ data: { repository: { pullRequest: { reviewThreads: connection(nodes, next) } } } });
const commentsPage = (nodes: unknown[], next: string | null = null) => json({ data: { node: { comments: connection(nodes, next) } } });
const one = (over: Record<string, unknown>) => page([THREAD(over)]);
const firstComment = (c: Record<string, unknown>) => threadWith(connection([COMMENT(1, c)]));

test('a thread is read with its place, its state and every comment', async () => {
  const { writer, seen } = github({ reviewThreads: [page([THREAD()])] });
  assert.deepEqual(await writer.listThreads(REF, '99'), [{
    id: 'PRRT_1', path: 'src/a.ts', side: 'RIGHT', line: 12, resolved: false, resolvedByApp: false,
    comments: [
      { id: '9001', node: 'PRRC_1', author: 'visto-test', authorIsBot: true, byApp: true, reviewId: '501', body: '**\\[major]** x', at: '2026-03-01T10:00:00Z' },
      { id: '9002', node: 'PRRC_2', author: 'octo-dev', authorIsBot: false, byApp: false, reviewId: '777', body: 'Meant to be so.', at: '2026-03-01T11:00:00Z' },
    ],
  }]);
  assert.deepEqual([seen.length, seen[0]!.method, seen[0]!.path, seen[0]!.authorization], [1, 'POST', '/graphql', 'Bearer tok-99']);
  assert.equal(seen[0]!.redirect, 'manual');
  assert.deepEqual(seen[0]!.variables, { owner: 'acme', name: 'shop', number: 7, after: null });
});
test('threads are read page after page, and a long thread comment page after comment page', async () => {
  const long = threadWith(connection([COMMENT(1)], 'c-1'));
  const { writer, seen } = github({
    reviewThreads: [page([long], 't-1'), page([THREAD({ id: 'PRRT_2' })])],
    'node(id': [commentsPage([COMMENT(2)], 'c-2'), commentsPage([COMMENT(3)])],
  });
  const threads = await writer.listThreads(REF, '99');
  assert.deepEqual(threads.map((t) => t.id), ['PRRT_1', 'PRRT_2']);
  assert.deepEqual(threads[0]!.comments.map((c) => c.id), ['1', '2', '3']);
  assert.deepEqual(seen.map((s) => s.variables), [
    { owner: 'acme', name: 'shop', number: 7, after: null },
    { thread: 'PRRT_1', after: 'c-1' },
    { thread: 'PRRT_1', after: 'c-2' },
    { owner: 'acme', name: 'shop', number: 7, after: 't-1' },
  ]);
});
test('a list that would be cut is refused: 20 full pages of threads, or 20 more pages of one thread, reject github_too_many_pages', async () => {
  assert.equal(MAX_THREAD_PAGES, 20);
  assert.equal(MAX_REPLY_PAGES, 20);
  const full = github({ reviewThreads: Array.from({ length: MAX_THREAD_PAGES }, (_, i) => page([THREAD()], `t-${i}`)) });
  await assert.rejects(full.writer.listThreads(REF, '99'), { message: 'github_too_many_pages' });
  assert.equal(full.seen.length, MAX_THREAD_PAGES);
  // the last allowed page of threads is fine when it is the last
  const edge = github({ reviewThreads: [...Array.from({ length: MAX_THREAD_PAGES - 1 }, (_, i) => page([], `t-${i}`)), page([THREAD()])] });
  assert.equal((await edge.writer.listThreads(REF, '99')).length, 1);
  const long = github({
    reviewThreads: [page([threadWith(connection([COMMENT(1)], 'c-0'))])],
    'node(id': Array.from({ length: MAX_REPLY_PAGES }, (_, i) => commentsPage([COMMENT(i + 2)], `c-${i + 1}`)),
  });
  await assert.rejects(long.writer.listThreads(REF, '99'), { message: 'github_too_many_pages' });
  assert.equal(long.seen.length, 1 + MAX_REPLY_PAGES);
  const ok = github({
    reviewThreads: [page([threadWith(connection([COMMENT(1)], 'c-0'))])],
    'node(id': [...Array.from({ length: MAX_REPLY_PAGES - 1 }, (_, i) => commentsPage([COMMENT(i + 2)], `c-${i + 1}`)), commentsPage([COMMENT(99)])],
  });
  assert.equal((await ok.writer.listThreads(REF, '99'))[0]!.comments.length, MAX_REPLY_PAGES + 1);
});
test('an answer without the connection never reads as no threads', async () => {
  for (const data of [{ repository: null }, { repository: { pullRequest: {} } }, { repository: { pullRequest: { reviewThreads: { nodes: [] } } } }]) {
    const { writer } = github({ reviewThreads: [json({ data })] });
    await assert.rejects(writer.listThreads(REF, '99'), { message: 'github_bad_response' });
  }
  for (const answer of [json([]), json({ data: null }), json({}), new Response('not json')]) {
    await assert.rejects(github({ reviewThreads: [answer] }).writer.listThreads(REF, '99'), { message: 'github_bad_response' });
  }
  const noNodes = { pageInfo: { hasNextPage: false, endCursor: null } };
  const noFlag = { nodes: [], pageInfo: { endCursor: null } };
  for (const broken of [noNodes, noFlag]) {
    await assert.rejects(github({ reviewThreads: [one({ comments: broken })] }).writer.listThreads(REF, '99'), { message: 'github_bad_response' });
  }
  for (const over of [{ id: 1 }, { path: null }]) {
    await assert.rejects(github({ reviewThreads: [one(over)] }).writer.listThreads(REF, '99'), { message: 'github_bad_response' });
  }
});
test('errors in the answer come first, and the list is asked once more after a server error or a broken connection', async () => {
  const forbidden = github({ reviewThreads: [json({ errors: [{ type: 'FORBIDDEN', message: 'x' }] })] });
  await assert.rejects(forbidden.writer.listThreads(REF, '99'), { message: 'github_forbidden' });
  const withData = github({ reviewThreads: [json({ data: { repository: null }, errors: [{ type: 'FORBIDDEN' }] })] });
  await assert.rejects(withData.writer.listThreads(REF, '99'), { message: 'github_forbidden' });
  const other = github({ reviewThreads: [json({ data: { repository: { pullRequest: { reviewThreads: connection([]) } } }, errors: [{ message: 'x' }] })] });
  await assert.rejects(other.writer.listThreads(REF, '99'), { message: 'github_graphql' });
  const fine = github({ reviewThreads: [json({ data: { repository: { pullRequest: { reviewThreads: connection([]) } } }, errors: [] })] });
  assert.deepEqual(await fine.writer.listThreads(REF, '99'), []);

  const again = github({ reviewThreads: [json({ message: 'bad gateway' }, 502), page([THREAD()])] });
  assert.equal((await again.writer.listThreads(REF, '99')).length, 1);
  assert.equal(again.seen.length, 2);
  const twice = github({ reviewThreads: [json({}, 502), json({}, 502)] });
  await assert.rejects(twice.writer.listThreads(REF, '99'), { message: 'github_502' });
  assert.equal(twice.seen.length, 2);
  const down = github({ reviewThreads: [new Error('socket closed'), new Error('socket closed')] });
  await assert.rejects(down.writer.listThreads(REF, '99'), { message: 'github_network' });
  assert.equal(down.seen.length, 2);
  const healed = github({ reviewThreads: [new Error('socket closed'), page([THREAD()])] });
  assert.equal((await healed.writer.listThreads(REF, '99')).length, 1);
  const refused = github({ reviewThreads: [json({}, 403), page([THREAD()])] });
  await assert.rejects(refused.writer.listThreads(REF, '99'), { message: 'github_403' });
  assert.equal(refused.seen.length, 1);
  // the second form of the query is tried once more too
  const long = github({
    reviewThreads: [page([threadWith(connection([COMMENT(1)], 'c-0'))])],
    'node(id': [json({}, 500), commentsPage([COMMENT(2)])],
  });
  assert.equal((await long.writer.listThreads(REF, '99'))[0]!.comments.length, 2);
  assert.equal(long.seen.length, 3);
});
test("the app's own account is known by its type and its name, with or without the [bot] ending", async () => {
  const read = async (author: unknown, over: Record<string, unknown> = {}) => {
    const { writer } = github({ reviewThreads: [page([{ ...firstComment({ author }), ...over }])] });
    const [thread] = await writer.listThreads(REF, '99');
    return thread!;
  };
  assert.equal((await read({ login: 'visto-test', __typename: 'Bot' })).comments[0]!.byApp, true);
  assert.equal((await read({ login: 'visto-test[bot]', __typename: 'Bot' })).comments[0]!.byApp, true);
  assert.equal((await read({ login: 'Visto-Test', __typename: 'Bot' })).comments[0]!.byApp, true);
  assert.equal((await read({ login: 'visto-test', __typename: 'User' })).comments[0]!.byApp, false);
  const other = (await read({ login: 'other-app', __typename: 'Bot' })).comments[0]!;
  assert.deepEqual([other.authorIsBot, other.byApp], [true, false]);
  const ghost = (await read(null)).comments[0]!;
  assert.deepEqual([ghost.author, ghost.authorIsBot, ghost.byApp], ['ghost', true, false]);
  assert.equal((await read({ login: 'visto-test', __typename: 'Bot' }, { isResolved: true, resolvedBy: { login: 'visto-test' } })).resolvedByApp, true);
  assert.equal((await read({ login: 'visto-test', __typename: 'Bot' }, { isResolved: true, resolvedBy: { login: 'octo-dev' } })).resolvedByApp, false);
  assert.equal((await read({ login: 'visto-test', __typename: 'Bot' }, { isResolved: true, resolvedBy: null })).resolvedByApp, false);
});
test('an old-side thread, a thread with no line and a thread with no comment', async () => {
  const { writer } = github({ reviewThreads: [page([
    THREAD({ id: 'PRRT_L', diffSide: 'LEFT' }), THREAD({ id: 'PRRT_N', line: null }), THREAD({ id: 'PRRT_E', comments: connection([]) }),
  ])] });
  const threads = await writer.listThreads(REF, '99');
  assert.deepEqual(threads.map((t) => [t.id, t.side, t.line]), [['PRRT_L', 'LEFT', 12], ['PRRT_N', 'RIGHT', null]]);
});
test('an id is read as a number or as digits, and a comment without one is a bad answer', async () => {
  const read = (c: Record<string, unknown>) => github({ reviewThreads: [page([firstComment(c)])] }).writer.listThreads(REF, '99');
  assert.equal((await read({ fullDatabaseId: 9001 }))[0]!.comments[0]!.id, '9001');
  assert.equal((await read({ fullDatabaseId: '9001' }))[0]!.comments[0]!.id, '9001');
  for (const fullDatabaseId of [null, 'x1', 1.5, undefined]) await assert.rejects(read({ fullDatabaseId }), { message: 'github_bad_response' });
  await assert.rejects(read({ id: null }), { message: 'github_bad_response' });
  assert.equal((await read({ pullRequestReview: null }))[0]!.comments[0]!.reviewId, null);
});
test("a comment carries its author's access when GitHub reports it, and none when it does not", async () => {
  const reported: unknown[] = ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 5, undefined];
  const comments = reported.map((v, i) => COMMENT(i + 1, v === undefined ? {} : { authorAssociation: v }));
  const queries: string[] = [];
  const answers = [page([threadWith(connection(comments, 'c-1'))]), commentsPage([COMMENT(9, { authorAssociation: 'MEMBER' })])];
  const stub = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    queries.push((JSON.parse(String(init?.body)) as { query: string }).query);
    return answers.shift() ?? json({ message: 'Not Found' }, 404);
  };
  const writer = createGithubWriter({ auth, info, fetch: stub as typeof fetch });
  const [thread] = await writer.listThreads(REF, '99');
  assert.deepEqual(thread!.comments.map((c) => c.association),
    ['owner', 'member', 'collaborator', 'none', 'none', 'none', undefined, undefined, 'member']);
  assert.deepEqual(thread!.comments.map((c) => 'association' in c), [true, true, true, true, true, true, false, false, true]);
  assert.equal(queries.length, 2);
  for (const query of queries) assert.match(query, /authorAssociation/);
});
test('a reply, an edit and a resolve are each one mutation with their ids, sent once', async () => {
  const reply = github({ addPullRequestReviewThreadReply: [json({ data: { addPullRequestReviewThreadReply: { comment: { id: 'PRRC_9' } } } })] });
  await reply.writer.replyToThread('99', 'PRRT_1', 'Fixed.');
  assert.deepEqual(reply.seen[0]!.variables, { thread: 'PRRT_1', body: 'Fixed.' });
  assert.deepEqual([reply.seen[0]!.method, reply.seen[0]!.path, reply.seen[0]!.authorization], ['POST', '/graphql', 'Bearer tok-99']);
  const edit = github({ updatePullRequestReviewComment: [json({ data: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: 'PRRC_2' } } } })] });
  await edit.writer.editThreadComment('99', 'PRRC_2', 'Better.');
  assert.deepEqual(edit.seen[0]!.variables, { comment: 'PRRC_2', body: 'Better.' });
  const resolve = github({ resolveReviewThread: [json({ data: { resolveReviewThread: { thread: { id: 'PRRT_1' } } } })] });
  await resolve.writer.resolveThread('99', 'PRRT_1');
  assert.deepEqual(resolve.seen[0]!.variables, { thread: 'PRRT_1' });

  const calls: Array<[string, (w: ReturnType<typeof github>['writer']) => Promise<void>]> = [
    ['addPullRequestReviewThreadReply', (w) => w.replyToThread('99', 'PRRT_1', 'x')],
    ['updatePullRequestReviewComment', (w) => w.editThreadComment('99', 'PRRC_2', 'x')],
    ['resolveReviewThread', (w) => w.resolveThread('99', 'PRRT_1')],
  ];
  for (const [kind, call] of calls) {
    const failing = github({ [kind]: [json({}, 502), json({ data: {} })] });
    await assert.rejects(call(failing.writer), { message: 'github_502' });
    assert.equal(failing.seen.length, 1);
    const down = github({ [kind]: [new Error('socket closed'), json({ data: {} })] });
    await assert.rejects(call(down.writer), { message: 'github_network' });
    assert.equal(down.seen.length, 1);
    const denied = github({ [kind]: [json({ errors: [{ type: 'FORBIDDEN' }] })] });
    await assert.rejects(call(denied.writer), { message: 'github_forbidden' });
  }
});
test('a mutation answered without an object data is a bad response, and was sent once', async () => {
  for (const answer of [json({}), json({ data: null }), json([]), new Response('not json')]) {
    const { writer, seen } = github({ resolveReviewThread: [answer] });
    await assert.rejects(writer.resolveThread('99', 'PRRT_1'), { message: 'github_bad_response' });
    assert.equal(seen.length, 1);
  }
});
