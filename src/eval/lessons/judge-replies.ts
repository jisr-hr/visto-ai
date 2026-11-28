// The steps of `judge-replies` (plan "evals with lessons", calls 7, 15, 16): the nights over an export, each reply judged
// by the model or answered from the kept answers, and lessons.json written. It returns the lines to print: counts, costs
// and short codes, never a reply, a finding, a lesson, a quote, a path or a login.
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { mkdirSync } from 'node:fs';

import type { ModelClient } from '../../engine/types.ts';
import { askJudge, JUDGE_RULES, JUDGE_TOOL } from '../../memory/judge.ts';
import { keptAsk } from './answers.ts';
import type { JudgeSetting } from './answers.ts';
import { loadFindings } from './findings.ts';
import { writeLessons } from './lessons-file.ts';
import { simulateNights } from './nights.ts';

export interface JudgeRepliesArgs {
  findingsPath: string; outDir: string; maxCost: number; setting: JudgeSetting;
  model: ModelClient; token: () => string; timeoutMs: number;
}

export async function judgeReplies(args: JudgeRepliesArgs): Promise<string[]> {
  const { file, sha256 } = loadFindings(args.findingsPath);
  mkdirSync(args.outDir, { recursive: true });
  const kept = keptAsk(join(args.outDir, 'answers.jsonl'), args.setting, (input) =>
    askJudge(args.model, input, args.token(), args.setting.toolChoice === 'auto', args.timeoutMs));
  const sim = await simulateNights(file, kept.ask, () => (kept.spent() >= args.maxCost ? 'spend_limit' : null));
  writeLessons(args.outDir, {
    version: 1, findings_file: basename(args.findingsPath), findings_sha256: sha256, exported_at: file.exported_at,
    setting: { model: args.setting.model, fallbacks: [...args.setting.fallbacks], toolChoice: args.setting.toolChoice },
    rules_sha256: createHash('sha256').update(JSON.stringify([JUDGE_RULES, JUDGE_TOOL])).digest('hex'),
    complete: sim.complete, end: sim.end, nights: sim.nights, first_night: sim.first_night, last_night: sim.last_night, cost: sim.cost,
    verdicts: sim.verdicts, lessons: sim.lessons,
  });
  const lines = [
    `nights ${sim.nights}, judged ${sim.judged}, lessons ${sim.lessons.length}, given up ${sim.given_up}, waiting ${sim.waiting}, calls ${sim.calls}, `
    + `asked now ${kept.asked()}, cost ${sim.cost.toFixed(4)}, spent now ${kept.spent().toFixed(4)}`,
  ];
  if (!sim.complete) lines.push(`stopped: ${sim.end ?? 'unknown'}`);
  return lines;
}
