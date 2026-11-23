import { isGrounded } from '../reconcile/grounding.ts';
import type { AuditEntry, ChatMessage, Effort, ModelClient, ModelResponse, Usage } from '../types.ts';
import { ProviderError } from './errors.ts';
import type { ProviderErrorKind } from './errors.ts';
import { SUBMIT_REVIEW, parseSubmitReview, submitToolFor } from './submit-review.ts';
import type { SubmitReviewArgs } from './submit-review.ts';

// `models` and `providers`: those that answered, in call order.
export type BatchAnswer =
  | { ok: true; value: SubmitReviewArgs; usage: Usage; models: string[]; providers: string[]; audit: AuditEntry[] }
  | { ok: false; code: 'invalid_output' | ProviderErrorKind; reason: string; usage: Usage; models: string[]; providers: string[]; audit: AuditEntry[] };

const MAX_ANSWER_CHARS = 2000;
const MAX_REASON_CHARS = 200;
const UNGROUNDED = 'ungrounded: the overview must name at least one changed file by its path';

const zeroUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 });
function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cost: a.cost + b.cost,
  };
}

type Verdict = { ok: true; value: SubmitReviewArgs } | { ok: false; reason: string };

function judge(response: ModelResponse, prPaths: string[], withThreads: boolean, withAcceptance: boolean): Verdict {
  if (response.toolName !== SUBMIT_REVIEW || response.toolArguments === null) return { ok: false, reason: 'not_a_tool_call' };
  const parsed = parseSubmitReview(response.toolArguments, withThreads, withAcceptance);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (!isGrounded(parsed.value, prPaths)) return { ok: false, reason: UNGROUNDED };
  return { ok: true, value: parsed.value };
}

function rejectedText(response: ModelResponse): string {
  const text = response.toolArguments ?? response.text ?? '(no answer)';
  return text.slice(0, MAX_ANSWER_CHARS);
}

export async function callBatch(
  args: { messages: ChatMessage[]; effort: Effort; timeoutMs: number; prPaths: string[]; withThreads?: boolean; withAcceptance?: boolean },
  model: ModelClient,
): Promise<BatchAnswer> {
  const withThreads = args.withThreads === true;
  const withAcceptance = args.withAcceptance === true;
  const tool = submitToolFor(withThreads, withAcceptance);
  let usage = zeroUsage();
  const audit: AuditEntry[] = [];
  const models: string[] = [];
  const providers: string[] = [];
  let messages = args.messages;
  let reason = '';
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await model.complete({
        messages, tools: [tool], forcedTool: SUBMIT_REVIEW, effort: args.effort, timeoutMs: args.timeoutMs,
      });
      usage = addUsage(usage, response.usage);
      models.push(response.model);
      if (response.provider !== null) providers.push(response.provider);
      const verdict = judge(response, args.prPaths, withThreads, withAcceptance);
      if (verdict.ok) return { ok: true, value: verdict.value, usage, models, providers, audit };
      reason = verdict.reason;
      if (attempt === 0) {
        audit.push({ stage: 'model', action: 'retry', subject: 'batch', reason });
        messages = [
          ...args.messages,
          { role: 'assistant', content: rejectedText(response) },
          { role: 'user', content: `Your answer was rejected: ${reason.slice(0, MAX_REASON_CHARS)}. Call submit_review again.` },
        ];
      }
    }
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    audit.push({ stage: 'model', action: 'failed', subject: 'batch', reason: error.kind });
    return { ok: false, code: error.kind, reason: error.message, usage, models, providers, audit };
  }
  audit.push({ stage: 'model', action: 'failed', subject: 'batch', reason: 'invalid_output' });
  return { ok: false, code: 'invalid_output', reason, usage, models, providers, audit };
}
