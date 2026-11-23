import type { ModelConfig } from '../../config/load.ts';
import type { ChatMessage, ModelClient, ModelRequest, ModelResponse, ToolCall, Usage } from '../types.ts';
import { ProviderError, classify, isTimeout } from './errors.ts';
import { SUBMIT_REVIEW } from './submit-review.ts';

export { ProviderError, classify } from './errors.ts';
export type { ProviderErrorKind } from './errors.ts';

type Io = { fetch: typeof fetch; sleep: (ms: number) => Promise<void> };
type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readUsage(body: unknown, prices: ModelConfig['prices']): Usage | null {
  if (!isRecord(body) || !isRecord(body.usage)) return null;
  const u = body.usage;
  const inputTokens = num(u.prompt_tokens);
  const outputTokens = num(u.completion_tokens);
  const cachedTokens = isRecord(u.prompt_tokens_details) ? num(u.prompt_tokens_details.cached_tokens) : 0;
  let cost = 0;
  if (typeof u.cost === 'number') cost = u.cost;
  else if (prices !== null) {
    cost = ((inputTokens - cachedTokens) * prices.inputPerMillion + cachedTokens * prices.cachedInputPerMillion + outputTokens * prices.outputPerMillion) / 1e6;
  }
  return { calls: 1, inputTokens, outputTokens, cachedTokens, cost };
}

// Header names the engine sets itself; configuration cannot replace them.
const OWN_HEADERS = new Set(['authorization', 'content-type']);

/** Calls of one answer that are read. */
export const TOOL_CALLS_READ = 16;

// A message as the endpoint takes it: an echoed assistant message as received, a tool answer in its own shape,
// and any other message as the object it is, so its bytes are today's.
function onWire(message: ChatMessage): unknown {
  if (message.wire !== undefined) return message.wire;
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  return message;
}

// The entries of tool_calls that have an id of their own and a name: the first TOOL_CALLS_READ, and the first
// call to submit_review after them when none of those is one.
function keptCalls(calls: unknown[]): { entry: Json; call: ToolCall }[] {
  const seen = new Set<string>();
  const kept: { entry: Json; call: ToolCall }[] = [];
  let submitKept = false;
  for (const entry of calls) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id === '' || seen.has(entry.id)) continue;
    const fn = entry.function;
    if (!isRecord(fn) || typeof fn.name !== 'string' || fn.name === '') continue;
    seen.add(entry.id);
    const isSubmit = fn.name === SUBMIT_REVIEW;
    if (kept.length < TOOL_CALLS_READ || (isSubmit && !submitKept)) {
      kept.push({ entry, call: { id: entry.id, name: fn.name, arguments: typeof fn.arguments === 'string' ? fn.arguments : null } });
      if (isSubmit) submitKept = true;
      if (kept.length >= TOOL_CALLS_READ && submitKept) break;
    }
  }
  return kept;
}

function readChoice(body: Json, requested: string): Omit<ModelResponse, 'usage'> {
  const choice = (body.choices as unknown[])[0];
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
  const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as unknown[]) : [];
  const fn = isRecord(calls[0]) && isRecord(calls[0].function) ? calls[0].function : null;
  const read: Omit<ModelResponse, 'usage'> = {
    toolName: fn !== null && typeof fn.name === 'string' ? fn.name : null,
    toolArguments: fn !== null && typeof fn.arguments === 'string' ? fn.arguments : null,
    text: typeof message.content === 'string' ? message.content : null,
    model: typeof body.model === 'string' ? body.model : requested,
    provider: typeof body.provider === 'string' ? body.provider : null,
  };
  const kept = keptCalls(calls);
  if (kept.length === 0) return read;
  const assistant: Json = {
    role: 'assistant',
    content: typeof message.content === 'string' ? message.content : null,
    tool_calls: kept.map((k) => k.entry),
  };
  if (Array.isArray(message.reasoning_details)) assistant.reasoning_details = message.reasoning_details;
  else if (typeof message.reasoning === 'string') assistant.reasoning = message.reasoning;
  return { ...read, toolCalls: kept.map((k) => k.call), assistant };
}

export function createModelClient(config: ModelConfig, io: Io): ModelClient {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const extraHeaders = Object.fromEntries(Object.entries(config.extraHeaders).filter(([name]) => !OWN_HEADERS.has(name.toLowerCase())));

  async function attempt(model: string, request: ModelRequest, total: Usage): Promise<Json> {
    const body = {
      ...config.effort[request.effort],
      ...config.extraBody,
      model,
      messages: request.messages.map(onWire),
      tools: request.tools,
      tool_choice: request.forcedTool === null ? 'auto' : { type: 'function', function: { name: request.forcedTool } },
      stream: false,
    };
    let res: Response;
    try {
      res = await io.fetch(url, {
        method: 'POST',
        headers: { ...extraHeaders, Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (err) {
      if (isTimeout(err)) throw new ProviderError('timeout', 'timeout: request aborted', null, null);
      throw new ProviderError('provider', 'provider: network failure', null, null);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (isTimeout(err)) throw new ProviderError('timeout', 'timeout: response aborted', res.status, null);
      const byStatus = res.status >= 200 && res.status <= 299 ? null : classify(res.status, undefined, res.headers.get('retry-after'), config.apiKey);
      throw byStatus ?? new ProviderError('provider', 'provider: response body unreadable', res.status, null);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const usage = readUsage(parsed, config.prices);
    if (usage !== null) {
      total.calls += usage.calls;
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.cachedTokens += usage.cachedTokens;
      total.cost += usage.cost;
    }
    const failure = classify(res.status, parsed, res.headers.get('retry-after'), config.apiKey);
    if (failure !== null) throw failure;
    return parsed as Json;
  }

  async function onModel(model: string, request: ModelRequest, total: Usage): Promise<Json> {
    try {
      return await attempt(model, request, total);
    } catch (err) {
      if (!(err instanceof ProviderError) || err.kind !== 'rate_limited') throw err;
      await io.sleep(err.retryAfterMs ?? 5_000);
      return attempt(model, request, total);
    }
  }

  async function run(request: ModelRequest): Promise<ModelResponse> {
    const total: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
    let last: ProviderError | null = null;
    for (const model of [config.model, ...config.fallbacks]) {
      try {
        const body = await onModel(model, request, total);
        return { ...readChoice(body, model), usage: total };
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== 'provider') throw err;
        last = err;
      }
    }
    throw last ?? new ProviderError('provider', 'provider: no model configured', null, null);
  }

  return {
    complete: run,
  };
}
