// The lessons file of the eval (plan "evals with lessons", calls 7, 15, 16): what the nights over an export made, for the
// evals to show a case the lessons live at its date. It holds private text (lessons), so mode 600; summary.md holds counts.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { Memory } from '../../engine/types.ts';
import { LESSONS_READ } from '../../memory/lessons.ts';
import type { LiveLesson } from '../../memory/lessons.ts';
import { createMemory } from '../../memory/select.ts';
import type { JudgeSetting } from './answers.ts';
import type { SimLesson, SimVerdict } from './nights.ts';

export interface LessonsFile {
  version: 1; findings_file: string; findings_sha256: string; exported_at: string; setting: JudgeSetting; rules_sha256: string;
  complete: boolean; end: string | null; nights: number; first_night: string | null; last_night: string | null; cost: number;
  verdicts: SimVerdict[]; lessons: SimLesson[];
}

const text = z.string();
const lessonsSchema = z.strictObject({
  version: z.literal(1), findings_file: text, findings_sha256: text, exported_at: text,
  setting: z.strictObject({ model: text, fallbacks: z.array(text), toolChoice: z.enum(['forced', 'auto']) }),
  rules_sha256: text, complete: z.boolean(), end: text.nullable(), nights: z.number().int(), first_night: text.nullable(), last_night: text.nullable(), cost: z.number(),
  verdicts: z.array(z.strictObject({
    repo: text, number: z.number().int(), reply: text, finding: text, classification: z.enum(['confirmed_fix', 'valid_pushback', 'invalid_pushback', 'question', 'noise']).nullable(),
    outcome: text, attempts: z.number().int(), night: text,
  })),
  lessons: z.array(z.strictObject({
    ref: text, repo: text, number: z.number().int(), reply: text, path: text, text, createdAt: text, madeAt: text, expiresAt: text,
  })),
});

function summaryOf(file: LessonsFile): string {
  const count = (values: Array<string | null>): string[] => {
    const by = new Map<string, number>();
    for (const v of values) by.set(v ?? 'none', (by.get(v ?? 'none') ?? 0) + 1);
    return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `- ${k}: ${n}`);
  };
  return [
    '# Lessons made from an export', '',
    `- whole: ${file.complete ? 'yes' : 'no'}${file.end === null ? '' : ` (stopped: ${file.end})`}`,
    `- nights: ${file.nights}`, `- verdicts: ${file.verdicts.length}`, `- lessons: ${file.lessons.length}`, `- cost: ${file.cost}`, '',
    '## By classification', ...count(file.verdicts.map((v) => v.classification)), '',
    '## By outcome', ...count(file.verdicts.map((v) => v.outcome)), '',
  ].join('\n');
}

/** lessons.json (mode 600) and summary.md; each is removed first, so a link left in place sends the write nowhere. */
export function writeLessons(dir: string, file: LessonsFile): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ['lessons.json', 'summary.md']) rmSync(join(dir, name), { force: true });
  writeFileSync(join(dir, 'lessons.json'), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  chmodSync(join(dir, 'lessons.json'), 0o600);
  writeFileSync(join(dir, 'summary.md'), summaryOf(file));
}

export function loadLessons(path: string): { file: LessonsFile; sha256: string } {
  const bytes = readFileSync(path);
  let file: LessonsFile;
  try {
    file = lessonsSchema.parse(JSON.parse(bytes.toString('utf8'))) as LessonsFile;
  } catch {
    throw new Error('bad_lessons_file');
  }
  if (!file.complete) throw new Error('lessons_incomplete');
  return { file, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The repository's lessons live at `at`: made at or before it (madeAt and createdAt), expiring after it; newest createdAt first, then ref; at most LESSONS_READ + 1. */
export function lessonsAt(file: LessonsFile, repo: string, at: Date): LiveLesson[] {
  const key = repo.toLowerCase();
  const ms = at.getTime();
  return file.lessons
    .filter((l) => l.repo === key && Date.parse(l.madeAt) <= ms && Date.parse(l.createdAt) <= ms && ms < Date.parse(l.expiresAt))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || byCodeUnit(a.ref, b.ref))
    .slice(0, LESSONS_READ + 1)
    .map((l): LiveLesson => ({ ref: l.ref, number: l.number, path: l.path, text: l.text, createdAt: l.createdAt }));
}

/** Memory with no records and these lessons, for one pull request: createMemory over a source whose live() is empty. */
export function lessonsMemory(file: LessonsFile, repo: string, own: number): Memory {
  return createMemory({ live: async () => [], lessons: async (at) => lessonsAt(file, repo, at) }, own);
}
