// One review through the real MCP client, with a fetch that plays the server. No socket is opened.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServerConfig } from '../config/load.ts';
import { SUBMIT_REVIEW } from '../engine/model/submit-review.ts';
import { review } from '../engine/review.ts';
import type { ChangedFile, ModelRequest, ModelResponse, ReviewDeps, ReviewInput, Source, Usage } from '../engine/types.ts';
import { mcpServersOf } from '../main.ts';

const URL_ = 'https://docs.example.test/mcp';
const DOCS: McpServerConfig = { name: 'docs', url: URL_, headers: { Authorization: 'Bearer t0k' }, tools: ['search'] };
const TOKEN = 'abcdef0123456789';
const FOUND = 'A cart keeps its total in cents.';

const input: ReviewInput = {
  pullRequest: {
    ref: { service: 'github', owner: 'acme', repo: 'shop', number: 7 },
    title: 'Add things', description: 'Adds things.', author: 'octo-dev',
    baseBranch: 'main', headBranch: 'topic', baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40), draft: false, fromFork: false,
  },
  trigger: 'automatic', repoConfig: { primaryBranches: ['main'], scoreThreshold: 70 },
  limits: { inputTokensPerCall: 200_000, batchesPerReview: 6, modelTimeoutSeconds: 30 }, asOf: new Date(0), earlier: null,
};
const fileA: ChangedFile = {
  path: 'src/a.ts', previousPath: null, status: 'modified', additions: 2, deletions: 0,
  patch: '@@ -1,1 +1,3 @@\n head\n+const total = 0.1 + 0.2;\n+export { total };',
};

interface Seen { method: string; rpc: string | null; name: string | null; headers: Headers }

/** A fetch that plays a server: initialize as JSON with a session, the notification with 202, tools/list as an event stream, tools/call as JSON, DELETE with 200. */
function playedServer(): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.equal(String(url), URL_);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const params = body?.params as { name?: unknown } | undefined;
    seen.push({ method, rpc: typeof body?.method === 'string' ? body.method : null, name: typeof params?.name === 'string' ? params.name : null, headers: new Headers(init?.headers) });
    if (method === 'DELETE') return new Response(null, { status: 200 });
    const id = body?.id;
    switch (body?.method) {
      case 'initialize':
        return Response.json(
          { jsonrpc: '2.0', id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'docs', version: '1' } } },
          { headers: { 'Mcp-Session-Id': 's-1' } },
        );
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list': {
        const tools = [
          { name: 'search', description: 'Search the docs.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
          { name: 'delete_page', description: 'Delete one page.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
        ];
        const event = `: keep-alive\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { tools } })}\n\n`;
        return new Response(event, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      case 'tools/call':
        return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: FOUND }] } });
      default:
        throw new Error('no_handler');
    }
  };
  return { fetch: fetchFn as typeof fetch, seen };
}

const usage = (): Usage => ({ calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, cost: 0.01 });
const ASSISTANT = {
  role: 'assistant', content: null,
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'docs__search', arguments: '{"query":"cart"}' } }],
};
const steps: ModelResponse[] = [
  {
    toolName: 'docs__search', toolArguments: '{"query":"cart"}', text: null, model: 'm', provider: null, usage: usage(),
    toolCalls: [{ id: 'c1', name: 'docs__search', arguments: '{"query":"cart"}' }], assistant: ASSISTANT,
  },
  {
    toolName: SUBMIT_REVIEW, text: null, model: 'm', provider: null, usage: usage(),
    toolArguments: JSON.stringify({
      overview: 'The total is a float.',
      findings: [{ path: 'src/a.ts', side: 'RIGHT', line: 2, severity: 'major', body: 'Keep the total in cents.', quote: '', beyond_diff: false }],
      files: [],
    }),
  },
];

test('a review with a server calls its tool through the real client and comes back with the call recorded', async () => {
  const server = playedServer();
  const requests: ModelRequest[] = [];
  const source: Source = {
    listFiles: () => Promise.resolve([fileA]), getFileContent: () => Promise.resolve(null), getDefaultBranchFile: () => Promise.resolve(null),
  };
  const deps: ReviewDeps = {
    source,
    model: { complete: (request) => { requests.push(request); const next = steps[requests.length - 1]; return next === undefined ? Promise.reject(new Error('exhausted')) : Promise.resolve(next); } },
    contract: 'You review pull requests.', clock: () => new Date(0), token: () => TOKEN, log: () => {},
    ...mcpServersOf([DOCS], server.fetch),
  };
  assert.deepEqual(deps.mcpServers!.map((s) => [s.name, s.tools]), [['docs', ['search']]]);

  const r = await review(input, deps);

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]!.tools.map((t) => t.function.name), [SUBMIT_REVIEW, 'docs__search']);
  assert.equal(JSON.stringify(requests[0]!.tools).includes('delete_page'), false);
  const last = requests[1]!.messages.slice(-2);
  assert.deepEqual([last[0]!.role, last[0]!.wire], ['assistant', ASSISTANT]);
  assert.deepEqual(last[1], { role: 'tool', toolCallId: 'c1', content: `<<<data ${TOKEN} tool result docs__search>>>\n${FOUND}\n<<<end ${TOKEN}>>>` });

  assert.deepEqual(server.seen.map((s) => [s.method, s.rpc, s.name]), [
    ['POST', 'initialize', null], ['POST', 'notifications/initialized', null], ['POST', 'tools/list', null], ['POST', 'tools/call', 'search'], ['DELETE', null, null],
  ]);
  assert.deepEqual(server.seen.map((s) => s.headers.get('mcp-session-id')), [null, 's-1', 's-1', 's-1', 's-1']);
  assert.ok(server.seen.every((s) => s.headers.get('authorization') === 'Bearer t0k'));

  assert.equal(r.status, 'ok');
  assert.deepEqual(r.dependencies.mcp, { docs: { status: 'ok', code: 'ok', calls: 1 } });
  assert.ok(r.audit.some((e) => e.stage === 'tools' && e.action === 'tool_call' && e.subject === 'docs__search' && e.reason === `ok:${FOUND.length}`));
  // Nothing of the server's address or headers is in the result.
  const text = JSON.stringify(r);
  assert.equal(text.includes('t0k') || text.includes('docs.example.test') || text.includes(FOUND), false);
});

test('a config that names no server gives the engine no mcpServers key', () => {
  const server = playedServer();
  assert.deepEqual(mcpServersOf([], server.fetch), {});
  assert.deepEqual(server.seen, []);
});
