// The kept answers of the eval's judge (plan "evals with lessons", call 7): every answer of the judge, and every answer
// with no verdict, is kept in a file keyed by the reply, the attempt, the setting and the input, so a second run asks
// only what is not kept. A failure at the provider is never kept. The file holds private text: mode 600, and a line that
// cannot be read is named by its number and nothing else.
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

import type { Usage } from '../../engine/types.ts';
import { JUDGE_RULES, JUDGE_TOOL } from '../../memory/judge.ts';
import type { Asked, JudgeAnswer, JudgeInput } from '../../memory/judge.ts';
import type { NightReply } from '../../memory/night.ts';
import type { SimAsk } from './nights.ts';

export interface JudgeSetting { model: string; fallbacks: string[]; toolChoice: 'forced' | 'auto' }
export interface KeptAnswer {
  reply: string; attempt: number; setting: JudgeSetting; input_sha256: string;
  asked: { ok: true; value: JudgeAnswer } | { ok: false; code: 'invalid_output' };
  usage: Usage;
}

const usageSchema = z.strictObject({ calls: z.number(), inputTokens: z.number(), outputTokens: z.number(), cachedTokens: z.number(), cost: z.number() });
const keptSchema = z.strictObject({
  reply: z.string(), attempt: z.number().int(),
  setting: z.strictObject({ model: z.string(), fallbacks: z.array(z.string()), toolChoice: z.enum(['forced', 'auto']) }),
  input_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  asked: z.union([
    z.strictObject({ ok: z.literal(true), value: z.strictObject({ classification: z.enum(['confirmed_fix', 'valid_pushback', 'invalid_pushback', 'question', 'noise']), lesson: z.string().nullable(), quote: z.string().nullable() }) }),
    z.strictObject({ ok: z.literal(false), code: z.literal('invalid_output') }),
  ]),
  usage: usageSchema,
});

export function judgeInputSha256(input: JudgeInput): string {
  return createHash('sha256').update(JSON.stringify([JUDGE_RULES, JUDGE_TOOL, input])).digest('hex');
}

const sameSetting = (a: JudgeSetting, b: JudgeSetting): boolean =>
  a.model === b.model && a.toolChoice === b.toolChoice && a.fallbacks.length === b.fallbacks.length && a.fallbacks.every((f, i) => f === b.fallbacks[i]);
const slot = (reply: string, attempt: number): string => `${reply}\u0000${attempt}`;

/** An ask that answers from the kept answers first; on a miss it calls `fresh`, keeps what it may and appends it to `path`.
    A line of `path` that cannot be read: bad_answers_line_<n>; a last line with no line end (a run killed while writing) is dropped. */
export function keptAsk(path: string, setting: JudgeSetting, fresh: (input: JudgeInput) => Promise<Asked>): { ask: SimAsk; spent: () => number; asked: () => number } {
  const kept = new Map<string, KeptAnswer[]>();
  const remember = (k: KeptAnswer): void => {
    const key = slot(k.reply, k.attempt);
    kept.set(key, [...(kept.get(key) ?? []), k]);
  };
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    const cut = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
    cut.split('\n').forEach((line, index, all) => {
      if (index === all.length - 1 && line === '') return;
      try {
        remember(keptSchema.parse(JSON.parse(line)) as KeptAnswer);
      } catch {
        throw new Error(`bad_answers_line_${index + 1}`);
      }
    });
    // The half line goes, so that the next answer stands on a line of its own.
    if (cut !== text) writeFileSync(path, cut, { mode: 0o600 });
    chmodSync(path, 0o600);
  } else {
    writeFileSync(path, '', { mode: 0o600 });
  }

  let spent = 0;
  let asked = 0;
  const ask: SimAsk = async (reply: NightReply, input: JudgeInput): Promise<Asked> => {
    const sha = judgeInputSha256(input);
    const hit = (kept.get(slot(reply.reply, reply.attempts)) ?? []).find((k) => k.input_sha256 === sha && sameSetting(k.setting, setting));
    if (hit !== undefined) return hit.asked.ok ? { ok: true, value: hit.asked.value, usage: { ...hit.usage } } : { ok: false, code: hit.asked.code, usage: { ...hit.usage } };
    const answer = await fresh(input);
    asked += 1;
    spent += answer.usage.cost;
    if (answer.ok || answer.code === 'invalid_output') {
      const entry: KeptAnswer = {
        reply: reply.reply, attempt: reply.attempts, setting: { model: setting.model, fallbacks: [...setting.fallbacks], toolChoice: setting.toolChoice }, input_sha256: sha,
        asked: answer.ok ? { ok: true, value: answer.value } : { ok: false, code: 'invalid_output' },
        usage: { ...answer.usage },
      };
      appendFileSync(path, JSON.stringify(entry) + '\n');
      remember(entry);
    }
    return answer;
  };
  return { ask, spent: () => spent, asked: () => asked };
}
