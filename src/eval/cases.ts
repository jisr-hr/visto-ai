import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { Side } from '../forge/types.ts';

export type LabelKind = 'valid' | 'invalid' | 'first' | 'late' | 'escaped';
export interface Label { comment_id: string; path: string; line: number | null; side: Side; severity: string; label: LabelKind; tolerance?: number; first_head?: boolean; same_head?: boolean; text?: string; start_line?: number }
export interface EvalCase { repo: string; pr_number: number; head_sha: string; compare_base: string; title: string; body: string; branch: string; base_branch: string; author: string; labels: Label[]; review_round?: number; review_at?: string }

const KINDS: readonly string[] = ['valid', 'invalid', 'first', 'late', 'escaped'];

export function caseKey(c: EvalCase): string {
  return `${c.repo}#${c.pr_number}@${c.head_sha.slice(0, 12)}`;
}

// Case files hold private data: a failure reports a line number and nothing else.
class BadField extends Error {}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function need<T>(ok: boolean, value: T): T {
  if (!ok) throw new BadField();
  return value;
}

function str(o: Obj, key: string): string {
  const v = o[key];
  return need(typeof v === 'string', v as string);
}

function strOr(o: Obj, key: string, fallback: string): string {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  return need(typeof v === 'string', v as string);
}

function parseLabel(raw: unknown): Label {
  need(isObj(raw), raw);
  const o = raw as Obj;
  const kind = str(o, 'label');
  need(KINDS.includes(kind), kind);
  const side = strOr(o, 'side', 'RIGHT');
  need(side === 'LEFT' || side === 'RIGHT', side);
  const line = o['line'] ?? null;
  need(line === null || Number.isInteger(line), line);
  const label: Label = {
    comment_id: strOr(o, 'comment_id', ''),
    path: str(o, 'path'),
    line: line as number | null,
    side: side as Side,
    severity: strOr(o, 'severity', ''),
    label: kind as LabelKind,
  };
  if (o['tolerance'] !== undefined) label.tolerance = need(typeof o['tolerance'] === 'number' && Number.isFinite(o['tolerance']), o['tolerance'] as number);
  if (o['first_head'] !== undefined) label.first_head = need(typeof o['first_head'] === 'boolean', o['first_head'] as boolean);
  if (o['same_head'] !== undefined) label.same_head = need(typeof o['same_head'] === 'boolean', o['same_head'] as boolean);
  if (o['text'] !== undefined) label.text = str(o, 'text');
  if (o['start_line'] !== undefined) label.start_line = need(Number.isInteger(o['start_line']), o['start_line'] as number);
  return label;
}

function parseCase(raw: unknown): EvalCase {
  need(isObj(raw), raw);
  const o = raw as Obj;
  const prNumber = o['pr_number'];
  need(Number.isInteger(prNumber), prNumber);
  const labels = o['labels'];
  need(Array.isArray(labels), labels);
  const c: EvalCase = {
    repo: str(o, 'repo'),
    pr_number: prNumber as number,
    head_sha: str(o, 'head_sha'),
    compare_base: str(o, 'compare_base'),
    title: strOr(o, 'title', ''),
    body: strOr(o, 'body', ''),
    branch: strOr(o, 'branch', ''),
    base_branch: strOr(o, 'base_branch', ''),
    author: strOr(o, 'author', ''),
    labels: (labels as unknown[]).map(parseLabel),
  };
  if (o['review_round'] !== undefined) c.review_round = need(Number.isInteger(o['review_round']), o['review_round'] as number);
  if (o['review_at'] !== undefined) c.review_at = need(typeof o['review_at'] === 'string' && Number.isFinite(Date.parse(o['review_at'])), o['review_at'] as string);
  return c;
}

export function parseCases(jsonl: string): EvalCase[] {
  const cases: EvalCase[] = [];
  jsonl.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      cases.push(parseCase(JSON.parse(line)));
    } catch {
      throw new Error(`bad_case_line_${index + 1}`);
    }
  });
  return cases;
}

export function loadCases(path: string): { cases: EvalCase[]; sha256: string } {
  const bytes = readFileSync(path);
  return { cases: parseCases(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
}
