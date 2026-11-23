import { eventData } from './sse.ts';

export const MCP_ANSWER_BYTES = 1_048_576; // one answer, as JSON or as a whole event stream; and the body read of a 400
export const SERVER_REQUESTS_MAX = 8; // requests of the server's own answered during one exchange

export interface RpcTarget {
  url: string;
  headers: Record<string, string>; // sent on every request: the config's, then the session's
  fetch: typeof fetch;
}

export type RpcAnswer =
  | { ok: true; result: unknown; headers: Headers } // headers: of the HTTP answer
  | { ok: false; code: string; error?: Record<string, unknown> }; // code: a short code. error: the JSON-RPC error object when the server sent one; never logged

const TOO_LARGE = 'answer_too_large';
const ERROR_CODE_MAX = 999_999;

type Judged = { kind: 'answer'; answer: RpcAnswer } | { kind: 'request'; id: string | number; method: string } | { kind: 'other' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Cancels a body that is not read to its end. Never throws, never waits. */
function release(body: ReadableStream<Uint8Array> | null): void {
  if (body === null) return;
  try {
    body.cancel().catch(() => {});
  } catch {
    // already locked or gone
  }
}

function post(target: RpcTarget, message: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  return target.fetch(target.url, {
    method: 'POST',
    headers: { ...target.headers, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    redirect: 'manual',
    signal,
  });
}

const failure = (signal: AbortSignal): string => (signal.aborted ? 'timeout' : 'network');

/**
 * A view of a body that ends when the signal aborts: the body is then cancelled at once, and a read under way rejects.
 * It pulls from the body only when it is read itself. Cancelling it cancels the body.
 */
function guarded(body: ReadableStream<Uint8Array>, signal: AbortSignal): { stream: ReadableStream<Uint8Array>; dispose: () => void } {
  const reader = body.getReader();
  const cancelBody = () => {
    try {
      reader.cancel().catch(() => {});
    } catch {
      // already gone
    }
  };
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new Error('timeout'));
      cancelBody();
    };
  });
  aborted.catch(() => {});
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const dispose = () => signal.removeEventListener('abort', onAbort);
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const step = await Promise.race([reader.read(), aborted]);
        if (signal.aborted) throw new Error('timeout');
        if (step.done) controller.close();
        else controller.enqueue(step.value);
      },
      cancel() {
        cancelBody();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, dispose };
}

function errorAnswer(error: Record<string, unknown>): RpcAnswer {
  const code = error.code;
  const n = typeof code === 'number' && Number.isInteger(code) ? Math.abs(code) : -1;
  return { ok: false, code: n >= 0 && n <= ERROR_CODE_MAX ? `rpc_${n}` : 'rpc_error', error };
}

function judge(message: unknown, id: number, headers: Headers): Judged {
  if (!isRecord(message)) return { kind: 'other' };
  if (message.id === id) {
    if (Object.hasOwn(message, 'result')) return { kind: 'answer', answer: { ok: true, result: message.result, headers } };
    if (isRecord(message.error)) return { kind: 'answer', answer: errorAnswer(message.error) };
  }
  const requestId = message.id;
  if (typeof message.method === 'string' && (typeof requestId === 'string' || typeof requestId === 'number')) {
    return { kind: 'request', id: requestId, method: message.method };
  }
  return { kind: 'other' };
}

function parse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Reads a whole body within maxBytes. Throws Error('answer_too_large') past it, and cancels the body on every early end. */
async function readText(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let finished = false;
  let read = 0;
  let text = '';
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) {
        finished = true;
        return text + decoder.decode();
      }
      read += step.value.byteLength;
      if (read > maxBytes) throw new Error(TOO_LARGE);
      text += decoder.decode(step.value, { stream: true });
    }
  } finally {
    if (!finished) {
      try {
        reader.cancel().catch(() => {});
      } catch {
        // already gone
      }
    }
  }
}

const readFailure = (error: unknown, signal: AbortSignal): string =>
  error instanceof Error && error.message === TOO_LARGE ? TOO_LARGE : failure(signal);

async function readJson(body: ReadableStream<Uint8Array>, id: number, headers: Headers, signal: AbortSignal): Promise<RpcAnswer> {
  let text: string;
  try {
    text = await readText(body, MCP_ANSWER_BYTES);
  } catch (error) {
    return { ok: false, code: readFailure(error, signal) };
  }
  const parsed = parse(text);
  if (!parsed.ok) return { ok: false, code: 'bad_answer' };
  const judged = judge(parsed.value, id, headers);
  return judged.kind === 'answer' ? judged.answer : { ok: false, code: 'bad_answer' };
}

async function readStream(target: RpcTarget, body: ReadableStream<Uint8Array>, id: number, headers: Headers, signal: AbortSignal): Promise<RpcAnswer> {
  let answered = 0;
  try {
    for await (const data of eventData(body, MCP_ANSWER_BYTES)) {
      const parsed = parse(data);
      if (!parsed.ok) continue;
      const judged = judge(parsed.value, id, headers);
      if (judged.kind === 'answer') return judged.answer;
      if (judged.kind !== 'request' || answered >= SERVER_REQUESTS_MAX) continue;
      answered += 1;
      const reply =
        judged.method === 'ping'
          ? { jsonrpc: '2.0', id: judged.id, result: {} }
          : { jsonrpc: '2.0', id: judged.id, error: { code: -32601, message: 'Method not found' } };
      await rpcSend(target, reply, signal);
    }
  } catch (error) {
    return { ok: false, code: readFailure(error, signal) };
  }
  return { ok: false, code: 'stream_ended' };
}

async function readRefusal(body: ReadableStream<Uint8Array> | null, status: number, signal: AbortSignal): Promise<RpcAnswer> {
  const code = `http_${status}`;
  if (status !== 400 || body === null) {
    release(body);
    return { ok: false, code };
  }
  const { stream, dispose } = guarded(body, signal);
  try {
    const parsed = parse(await readText(stream, MCP_ANSWER_BYTES));
    if (parsed.ok && isRecord(parsed.value) && isRecord(parsed.value.error)) return { ok: false, code, error: parsed.value.error };
  } catch {
    // a body that cannot be read changes nothing
  } finally {
    dispose();
  }
  return { ok: false, code };
}

const contentType = (headers: Headers): string => (headers.get('content-type') ?? '').toLowerCase();

/** Sends one request and reads its answer. Never rejects. */
export async function rpcRequest(target: RpcTarget, id: number, method: string, params: Record<string, unknown> | undefined, signal: AbortSignal): Promise<RpcAnswer> {
  let response: Response;
  try {
    const message: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    response = await post(target, message, signal);
  } catch {
    return { ok: false, code: failure(signal) };
  }
  try {
    const { status, headers, body } = response;
    if (status < 200 || status > 299) return await readRefusal(body, status, signal);
    const type = contentType(headers);
    const json = type.startsWith('application/json');
    if (body === null || (!json && !type.startsWith('text/event-stream'))) {
      release(body);
      return { ok: false, code: 'bad_answer' };
    }
    const { stream, dispose } = guarded(body, signal);
    try {
      return json ? await readJson(stream, id, headers, signal) : await readStream(target, stream, id, headers, signal);
    } finally {
      dispose();
    }
  } catch {
    release(response.body);
    return { ok: false, code: failure(signal) };
  }
}

/** Sends one notification, or one answer to a request of the server's. Never rejects. Resolves null, or the short code of the failure. */
export async function rpcSend(target: RpcTarget, message: Record<string, unknown>, signal: AbortSignal): Promise<string | null> {
  let response: Response;
  try {
    response = await post(target, message, signal);
  } catch {
    return failure(signal);
  }
  try {
    release(response.body);
    const status = response.status;
    return status >= 200 && status <= 299 ? null : `http_${status}`;
  } catch {
    return failure(signal);
  }
}
