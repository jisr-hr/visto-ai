import type { ModelConfig } from '../../config/load.ts';
import type { ModelClient, ModelRequest, ModelResponse, Usage } from '../types.ts';
import { ProviderError, classify } from './errors.ts';

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

function readChoice(body: Json): Pick<ModelResponse, 'toolName' | 'toolArguments' | 'text' | 'model'> {
  const choice = (body.choices as unknown[])[0];
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
  const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as unknown[]) : [];
  const fn = isRecord(calls[0]) && isRecord(calls[0].function) ? calls[0].function : null;
  return {
    toolName: fn !== null && typeof fn.name === 'string' ? fn.name : null,
    toolArguments: fn !== null && typeof fn.arguments === 'string' ? fn.arguments : null,
    text: typeof message.content === 'string' ? message.content : null,
    model: typeof body.model === 'string' ? body.model : '',
  };
}

export function createModelClient(config: ModelConfig, io: Io): ModelClient {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  async function attempt(model: string, request: ModelRequest, total: Usage): Promise<Json> {
    const body = {
      model,
      messages: request.messages,
      tools: request.tools,
      tool_choice: { type: 'function', function: { name: request.forcedTool } },
      ...config.effort[request.effort],
      ...config.extraBody,
    };
    let res: Response;
    try {
      res = await io.fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', ...config.extraHeaders },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new ProviderError('timeout', 'timeout: request aborted', null, null);
      throw new ProviderError('provider', 'provider: network failure', null, null);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await res.text());
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
    const failure = classify(res.status, parsed, res.headers.get('retry-after'));
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

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const total: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
      let last: ProviderError | null = null;
      for (const model of [config.model, ...config.fallbacks]) {
        try {
          const body = await onModel(model, request, total);
          return { ...readChoice(body), usage: total };
        } catch (err) {
          if (!(err instanceof ProviderError) || err.kind !== 'provider') throw err;
          last = err;
        }
      }
      throw last ?? new ProviderError('provider', 'provider: no model configured', null, null);
    },
  };
}
