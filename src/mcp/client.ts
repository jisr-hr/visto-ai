import type { McpServerConfig } from '../config/load.ts';
import type { McpAnswer, McpServer, McpSession, McpTool } from '../engine/types.ts';
import { rpcRequest, rpcSend, type RpcTarget } from './rpc.ts';

export const PROTOCOL_VERSION = '2025-11-25';
export const ACCEPTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const LIST_PAGES_MAX = 10;

const CLIENT_INFO = { name: 'visto-ai', version: '0.0.0' };
const CLOSE_MS = 1_000; // the end of a failed open, under a limit of the client's own
const SESSION_ID = /^[\x21-\x7E]{1,1024}$/;
const VERSION_HEADER = 'MCP-Protocol-Version';
const SESSION_HEADER = 'Mcp-Session-Id';
/** The names the client writes itself, here or in rpc.ts: a config header of one of these names is not sent. */
const OWN_HEADERS = new Set(['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A failed open, with its short code as the message. */
class OpenFailure extends Error {}

/** The config's headers, without any the client writes itself. */
function configHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !OWN_HEADERS.has(name.toLowerCase())));
}

/** Waits for `work` until the signal aborts, whichever comes first. Never rejects; leaves no listener once settled. */
function untilAborted(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
    );
  });
}

/** The DELETE that ends a session. Any status and any rejection end it quietly; the body is cancelled unread. Never rejects. */
async function endSession(fetchFn: typeof fetch, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<void> {
  try {
    const sent = fetchFn(url, { method: 'DELETE', headers: { ...headers }, redirect: 'manual', signal }).then((response) => {
      try {
        response.body?.cancel().catch(() => {});
      } catch {
        // already locked or gone
      }
    });
    await untilAborted(sent, signal);
  } catch {
    // a fetch that throws at once ends it too
  }
}

/** Ends a session under a second of the client's own, whatever the caller's signal says. The timer is cleared at the end. */
async function endBounded(fetchFn: typeof fetch, url: string, headers: Record<string, string>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOSE_MS);
  try {
    await endSession(fetchFn, url, headers, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** A server that speaks only another revision: an error -32022, or one that lists the versions it supports. */
function otherRevision(error: Record<string, unknown> | undefined): boolean {
  if (error === undefined) return false;
  return error.code === -32022 || (isRecord(error.data) && Array.isArray(error.data.supported));
}

function readTools(list: unknown[]): McpTool[] {
  const tools: McpTool[] = [];
  for (const entry of list) {
    if (isRecord(entry) && typeof entry.name === 'string' && entry.name !== '') {
      tools.push({ name: entry.name, description: entry.description, inputSchema: entry.inputSchema });
    }
  }
  return tools;
}

async function openSession(config: McpServerConfig, fetchFn: typeof fetch, signal: AbortSignal): Promise<McpSession> {
  const own = configHeaders(config.headers);
  const target: RpcTarget = { url: config.url, headers: { ...own }, fetch: fetchFn };
  let sessionId: string | null = null; // set once the server issued a usable one: from then on a failed open ends it
  let nextId = 1;
  let closed = false;

  const fail = async (code: string): Promise<never> => {
    if (sessionId !== null) await endBounded(fetchFn, config.url, target.headers);
    throw new OpenFailure(code);
  };

  const handshake = async (): Promise<McpSession> => {
    const init = await rpcRequest(target, nextId++, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, signal);
    if (!init.ok) return fail(otherRevision(init.error) ? 'protocol_version' : init.code);
    const issued = init.headers.get(SESSION_HEADER);
    const usable = issued !== null && SESSION_ID.test(issued) ? issued : null;
    const result = init.result;
    const version = isRecord(result) ? result.protocolVersion : undefined;
    if (typeof version !== 'string' || !ACCEPTED_VERSIONS.includes(version)) {
      if (usable !== null) {
        sessionId = usable;
        target.headers = { ...own, [SESSION_HEADER]: usable };
      }
      return fail('protocol_version');
    }
    target.headers = { ...own, [VERSION_HEADER]: version };
    if (usable !== null) {
      sessionId = usable;
      target.headers[SESSION_HEADER] = usable;
    }
    const capabilities = isRecord(result) ? result.capabilities : undefined;
    if (!isRecord(capabilities) || !isRecord(capabilities.tools)) return fail('no_tools');
    if (issued !== null && usable === null) return fail('bad_session_id');

    const notified = await rpcSend(target, { jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
    if (notified !== null) return fail(notified);

    const tools: McpTool[] = [];
    let cursor: string | null = null;
    for (let page = 1; ; page += 1) {
      if (page > LIST_PAGES_MAX) return fail('list_too_long');
      const listed = await rpcRequest(target, nextId++, 'tools/list', cursor === null ? undefined : { cursor }, signal);
      if (!listed.ok) return fail(listed.code);
      const body = listed.result;
      if (!isRecord(body) || !Array.isArray(body.tools)) return fail('bad_answer');
      tools.push(...readTools(body.tools));
      const next = body.nextCursor;
      if (typeof next !== 'string' || next === '') break;
      cursor = next;
    }

    return {
      tools,
      async call(name: string, args: Record<string, unknown>, callSignal: AbortSignal): Promise<McpAnswer> {
        try {
          if (closed) return { ok: false, code: 'closed' };
          const answer = await rpcRequest(target, nextId++, 'tools/call', { name, arguments: args }, callSignal);
          if (answer.ok) return { ok: true, result: answer.result };
          return { ok: false, code: answer.code === 'http_404' && sessionId !== null ? 'session_lost' : answer.code };
        } catch {
          return { ok: false, code: 'failed' };
        }
      },
      async close(closeSignal: AbortSignal): Promise<void> {
        if (closed) return;
        closed = true;
        if (sessionId === null) return;
        await endSession(fetchFn, config.url, target.headers, closeSignal);
      },
    };
  };

  try {
    return await handshake();
  } catch (error) {
    if (error instanceof OpenFailure) throw error;
    return fail('failed');
  }
}

/** One server for each entry, in order. Nothing is asked until `open` is called. */
export function createMcpServers(configs: McpServerConfig[], io: { fetch: typeof fetch }): McpServer[] {
  return configs.map((config) => ({
    name: config.name,
    tools: [...config.tools],
    async open(signal: AbortSignal): Promise<McpSession> {
      try {
        return await openSession(config, io.fetch, signal);
      } catch (error) {
        throw new Error(error instanceof OpenFailure ? error.message : 'failed');
      }
    },
  }));
}
