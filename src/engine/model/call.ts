import { estimateTokens } from '../context/batches.ts';
import { isGrounded } from '../reconcile/grounding.ts';
import type { AuditEntry, ChatMessage, Effort, ModelClient, ModelRequest, ModelResponse, ToolCall, ToolDefinition, Usage } from '../types.ts';
import { ProviderError } from './errors.ts';
import type { ProviderErrorKind } from './errors.ts';
import { SUBMIT_REVIEW, parseSubmitReview, submitToolFor } from './submit-review.ts';
import type { SubmitReviewArgs } from './submit-review.ts';
import type { ToolOutcome } from './tools.ts';

// `models` and `providers`: those that answered, in call order.
export type BatchAnswer =
  | { ok: true; value: SubmitReviewArgs; usage: Usage; models: string[]; providers: string[]; audit: AuditEntry[] }
  | { ok: false; code: 'invalid_output' | ProviderErrorKind; reason: string; usage: Usage; models: string[]; providers: string[]; audit: AuditEntry[] };

export const OPEN_TURNS_PER_CALL = 4;
export const FINAL_LINE = 'No more tool calls are run in this call. Call submit_review now, with what you have.';
export interface ToolLoop {
  definitions: ToolDefinition[];                                  // the servers' functions as offered; never empty
  run(call: ToolCall, open: boolean): Promise<ToolOutcome>;       // never rejects; with open false the call is not run and is answered so
  now(): number;                                                  // milliseconds; read for the time of the open turns
  room: number;                                                   // tokens the open turns of one model call may append; at that count the next turn must end the call
}

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

// The line that asks again for an answer that was rejected, as today.
const rejectionLine = (reason: string): ChatMessage =>
  ({ role: 'user', content: `Your answer was rejected: ${reason.slice(0, MAX_REASON_CHARS)}. Call submit_review again.` });

// The answer of a turn of the loop (rule 3): the response itself when its first call is submit_review, else the
// response read as its first call to submit_review among its calls; null when it has none. The answer keeps no
// list of calls, so that it is judged and shown by the arguments of that one call. `chosen` is the entry of
// `toolCalls` that is the answer, when it is one of them.
function answerIn(response: ModelResponse): { answer: ModelResponse; chosen: ToolCall | null } | null {
  const { toolCalls } = response;
  const rest: ModelResponse = { ...response };
  delete rest.toolCalls;
  delete rest.assistant;
  if (response.toolName === SUBMIT_REVIEW) {
    const first = toolCalls?.[0];
    const chosen = first !== undefined && first.name === SUBMIT_REVIEW && first.arguments === response.toolArguments ? first : null;
    return { answer: rest, chosen };
  }
  const chosen = toolCalls?.find((c) => c.name === SUBMIT_REVIEW);
  if (chosen === undefined) return null;
  return { answer: { ...rest, toolName: SUBMIT_REVIEW, toolArguments: chosen.arguments }, chosen };
}

type Closed = 'call_cap' | 'tool_error' | 'room' | 'deadline' | 'nothing_sent' | 'turn_cap';

export async function callBatch(
  args: {
    messages: ChatMessage[]; effort: Effort; timeoutMs: number; prPaths: string[]; withThreads?: boolean; withAcceptance?: boolean;
    toolChoice?: 'forced' | 'auto';   // absent reads as 'forced'; 'auto' leaves the choice to the model (call 31)
    tools?: ToolLoop;                 // absent: no open turn, as today
  },
  model: ModelClient,
): Promise<BatchAnswer> {
  const withThreads = args.withThreads === true;
  const withAcceptance = args.withAcceptance === true;
  const tool = submitToolFor(withThreads, withAcceptance);
  const auto = args.toolChoice === 'auto';
  const forcedTool = auto ? null : SUBMIT_REVIEW;
  if (args.tools !== undefined) return callWithTools(args, args.tools, model, tool, auto);
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
          rejectionLine(reason),
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

// The loop (calls 14 to 21): open turns in which the model may call the servers' tools, then, when they end without
// an answer, a closing turn over the transcript as it stands; and the one retry of an invalid answer, which is a
// closing turn too. Every request offers the same tools; a closing one forces submit_review under forced only.
async function callWithTools(
  args: { messages: ChatMessage[]; effort: Effort; timeoutMs: number; prPaths: string[]; withThreads?: boolean; withAcceptance?: boolean },
  tools: ToolLoop,
  model: ModelClient,
  tool: ToolDefinition,
  auto: boolean,
): Promise<BatchAnswer> {
  const withThreads = args.withThreads === true;
  const withAcceptance = args.withAcceptance === true;
  const all = [tool, ...tools.definitions];
  const request = (messages: ChatMessage[], closing: boolean): ModelRequest => ({
    messages, tools: all, forcedTool: closing && !auto ? SUBMIT_REVIEW : null, effort: args.effort, timeoutMs: args.timeoutMs,
  });
  let usage = zeroUsage();
  const audit: AuditEntry[] = [];
  const models: string[] = [];
  const providers: string[] = [];
  const ask = async (req: ModelRequest): Promise<ModelResponse> => {
    const response = await model.complete(req);
    usage = addUsage(usage, response.usage);
    models.push(response.model);
    if (response.provider !== null) providers.push(response.provider);
    return response;
  };
  const start = tools.now();
  const timeUp = (): boolean => tools.now() - start >= args.timeoutMs;
  const transcript: ChatMessage[] = [...args.messages];
  let appended = 0;
  const append = (message: ChatMessage, measured: unknown): void => {
    transcript.push(message);
    appended += estimateTokens(JSON.stringify(measured));
  };
  try {
    // What is judged, and the request it answered: the retry is built on that request's messages.
    let judged: { answer: ModelResponse; asked: ModelRequest } | null = null;
    for (let turn = 0; turn < OPEN_TURNS_PER_CALL; turn++) {
      const asked = request(transcript.slice(), false);
      const response = await ask(asked);
      const found = answerIn(response);
      if (found !== null) {
        const dropped = (response.toolCalls ?? []).filter((c) => c !== found.chosen).length;
        if (dropped > 0) audit.push({ stage: 'model', action: 'tool_calls_dropped', subject: 'batch', reason: String(dropped) });
        judged = { answer: found.answer, asked };
        break;
      }
      const calls = response.toolCalls ?? [];
      if (response.assistant === undefined || calls.length === 0) {
        judged = { answer: response, asked };
        break;
      }
      append({ role: 'assistant', content: response.text ?? '', wire: response.assistant }, response.assistant);
      let open = appended < tools.room;
      let stop: 'call_cap' | 'tool_error' | null = null;
      let sent = false;
      for (const call of calls) {
        if (open && timeUp()) open = false;
        const outcome = await tools.run(call, open);
        append({ role: 'tool', content: outcome.content, toolCallId: call.id }, outcome.content);
        audit.push(outcome.audit);
        if (outcome.sent) sent = true;
        if (outcome.stop !== null && stop === null) stop = outcome.stop;
        if (stop !== null || appended >= tools.room) open = false;
      }
      const closed: Closed | null = stop
        ?? (appended >= tools.room ? 'room'
          : timeUp() ? 'deadline'
            : !sent ? 'nothing_sent'
              : turn === OPEN_TURNS_PER_CALL - 1 ? 'turn_cap' : null);
      if (closed !== null) {
        audit.push({ stage: 'model', action: 'tools_closed', subject: 'batch', reason: closed });
        transcript.push({ role: 'user', content: FINAL_LINE });
        break;
      }
    }
    if (judged === null) {
      const asked = request(transcript.slice(), true);
      const response = await ask(asked);
      judged = { answer: answerIn(response)?.answer ?? response, asked };
    }
    let reason = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const verdict = judge(judged.answer, auto, args.prPaths, withThreads, withAcceptance);
      if (verdict.ok) return { ok: true, value: verdict.value, usage, models, providers, audit };
      reason = verdict.reason;
      if (attempt === 1) break;
      audit.push({ stage: 'model', action: 'retry', subject: 'batch', reason });
      // An answer to a request that left the choice to the model is never sent back empty, under forced too: some endpoints
      // refuse an assistant message with empty content.
      const shown = rejectedText(judged.answer, auto);
      const asked = request([
        ...judged.asked.messages,
        { role: 'assistant', content: shown === '' && judged.asked.forcedTool === null ? '(no answer)' : shown },
        rejectionLine(reason),
      ], true);
      const response = await ask(asked);
      judged = { answer: answerIn(response)?.answer ?? response, asked };
    }
    audit.push({ stage: 'model', action: 'failed', subject: 'batch', reason: 'invalid_output' });
    return { ok: false, code: 'invalid_output', reason, usage, models, providers, audit };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    audit.push({ stage: 'model', action: 'failed', subject: 'batch', reason: error.kind });
    return { ok: false, code: error.kind, reason: error.message, usage, models, providers, audit };
  }
}
