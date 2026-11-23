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

// What is judged: under forced, the answer's first call, as read since the start; under auto, its first call to
// submit_review wherever it stands, the other calls being ignored since no other tool is offered.
function answerOf(response: ModelResponse, auto: boolean): { name: string | null; arguments: string | null } {
  if (auto && response.toolCalls !== undefined && response.toolCalls.length > 0) {
    const submit = response.toolCalls.find((c) => c.name === SUBMIT_REVIEW);
    return submit ?? { name: response.toolCalls[0]!.name, arguments: response.toolCalls[0]!.arguments };
  }
  return { name: response.toolName, arguments: response.toolArguments };
}

function judge(response: ModelResponse, auto: boolean, prPaths: string[], withThreads: boolean, withAcceptance: boolean): Verdict {
  const answer = answerOf(response, auto);
  if (answer.name !== SUBMIT_REVIEW || answer.arguments === null) return { ok: false, reason: 'not_a_tool_call' };
  const parsed = parseSubmitReview(answer.arguments, withThreads, withAcceptance);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (!isGrounded(parsed.value, prPaths)) return { ok: false, reason: UNGROUNDED };
  return { ok: true, value: parsed.value };
}

// Under auto an empty text becomes '(no answer)', since some endpoints refuse an assistant message with empty content,
// and a call to a function other than submit_review is named with its arguments.
function rejectedText(response: ModelResponse, auto: boolean): string {
  if (!auto) return (response.toolArguments ?? response.text ?? '(no answer)').slice(0, MAX_ANSWER_CHARS);
  const answer = answerOf(response, auto);
  const text = answer.name !== null && answer.name !== SUBMIT_REVIEW
    ? `called ${answer.name} with ${answer.arguments ?? '(no arguments)'}`
    : answer.arguments ?? response.text;
  return (text === null || text === '' ? '(no answer)' : text).slice(0, MAX_ANSWER_CHARS);
}

export async function callBatch(
  args: {
    messages: ChatMessage[]; effort: Effort; timeoutMs: number; prPaths: string[]; withThreads?: boolean; withAcceptance?: boolean;
    toolChoice?: 'forced' | 'auto';   // absent reads as 'forced'; 'auto' leaves the choice to the model (call 31)
  },
  model: ModelClient,
): Promise<BatchAnswer> {
  const withThreads = args.withThreads === true;
  const withAcceptance = args.withAcceptance === true;
  const tool = submitToolFor(withThreads, withAcceptance);
  const auto = args.toolChoice === 'auto';
  const forcedTool = auto ? null : SUBMIT_REVIEW;
  let usage = zeroUsage();
  const audit: AuditEntry[] = [];
  const models: string[] = [];
  const providers: string[] = [];
  let messages = args.messages;
  let reason = '';
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await model.complete({
        messages, tools: [tool], forcedTool, effort: args.effort, timeoutMs: args.timeoutMs,
      });
      usage = addUsage(usage, response.usage);
      models.push(response.model);
      if (response.provider !== null) providers.push(response.provider);
      const verdict = judge(response, auto, args.prPaths, withThreads, withAcceptance);
      if (verdict.ok) return { ok: true, value: verdict.value, usage, models, providers, audit };
      reason = verdict.reason;
      if (attempt === 0) {
        audit.push({ stage: 'model', action: 'retry', subject: 'batch', reason });
        messages = [
          ...args.messages,
          { role: 'assistant', content: rejectedText(response, auto) },
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
