import type { ScorerConfig } from '../../config/load.ts';
import { ProviderError, classify, isTimeout } from '../model/errors.ts';
import type { ScoreAnswer, ScoreRequest, ScoredItem, Scorer, Usage } from '../types.ts';
import { combine } from './jev-combine.ts';
import type { Answers } from './jev-combine.ts';
import { SIGNAL_NAMES, WHOLE_LEAD, WHOLE_PREFIX, blockLead, questionsFor } from './jev-questions.ts';
import type { NoulQuestion } from './jev-questions.ts';

export const BLOCKS_PER_REQUEST = 4;

type Io = { fetch: typeof fetch; sleep: (ms: number) => Promise<void> };
type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// An item exists only when every one of the thirteen answers for the prefix is a probability.
function itemFor(prefix: string, answers: Json): ScoredItem | null {
  const p: Partial<Answers> = {};
  for (const name of SIGNAL_NAMES) {
    const a = answers[`${prefix}_${name}`];
    if (!isRecord(a) || a.type !== 'noul' || typeof a.noul !== 'number' || !(a.noul >= 0 && a.noul <= 1)) return null;
    p[name] = a.noul;
  }
  return combine(p as Answers);
}

export function createJevScorer(config: ScorerConfig, io: Io): Scorer {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/decisions`;

  async function attempt(text: string, questions: Record<string, NoulQuestion>, total: Usage): Promise<Json> {
    let res: Response;
    try {
      res = await io.fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, state: text, questions }),
        signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
      });
    } catch (err) {
      if (isTimeout(err)) throw new ProviderError('timeout', 'timeout: request aborted', null, null);
      throw new ProviderError('provider', 'provider: network failure', null, null);
    }
    let raw: string;
    try {
      raw = await res.text();
    } catch (err) {
      if (isTimeout(err)) throw new ProviderError('timeout', 'timeout: response aborted', res.status, null);
      throw new ProviderError('provider', 'provider: response body unreadable', res.status, null);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (isRecord(parsed) && isRecord(parsed.usage)) {
      total.calls += 1;
      total.inputTokens += count(parsed.usage.input_tokens);
      total.outputTokens += count(parsed.usage.output_tokens);
      total.cost += count(parsed.usage.cost);
    }
    if (res.status < 200 || res.status > 299) throw classify(res.status, parsed, res.headers.get('retry-after'), config.apiKey) ?? new ProviderError('provider', 'provider: unexpected status', res.status, null);
    if (!isRecord(parsed) || !isRecord(parsed.answers)) throw new ProviderError('provider', 'provider: no answers in the response', res.status, null);
    return parsed.answers;
  }

  async function ask(text: string, questions: Record<string, NoulQuestion>, total: Usage): Promise<Json> {
    try {
      return await attempt(text, questions, total);
    } catch (err) {
      if (!(err instanceof ProviderError) || err.kind === 'auth' || err.kind === 'no_credit') throw err;
      if (err.kind === 'rate_limited') await io.sleep(err.retryAfterMs ?? 5_000);
      return attempt(text, questions, total);
    }
  }

  async function score(request: ScoreRequest): Promise<ScoreAnswer> {
    const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
    const blocks: Record<string, ScoredItem> = {};
    let whole: ScoredItem | null = null;
    let failure: string | null = null;

    const groups: { prefix: string; lead: string }[][] = [];
    if (request.blocks.length === 0) groups.push([{ prefix: WHOLE_PREFIX, lead: WHOLE_LEAD }]);
    for (let i = 0; i < request.blocks.length; i += BLOCKS_PER_REQUEST) {
      groups.push(request.blocks.slice(i, i + BLOCKS_PER_REQUEST).map((id) => ({ prefix: id, lead: blockLead(id) })));
    }

    for (const group of groups) {
      const questions: Record<string, NoulQuestion> = {};
      for (const { prefix, lead } of group) Object.assign(questions, questionsFor(prefix, lead));
      let answers: Json;
      try {
        answers = await ask(request.text, questions, usage);
      } catch (err) {
        failure = err instanceof ProviderError ? err.kind : 'provider';
        break;
      }
      for (const { prefix } of group) {
        const item = itemFor(prefix, answers);
        if (item === null) failure ??= 'bad_answer';
        else if (request.blocks.length === 0) whole = item;
        else blocks[prefix] = item;
      }
    }
    return { blocks, whole, usage, failure };
  }

  return { score };
}
