// Reading the stored result of a review field by field (the One review design; calls 6, 9, 10, 13, 14, 17 and 18). Pure: every function
// takes the result as `unknown`, skips a value of another shape than the one read, and never throws.
import { isShortCode } from '../shell/codes.ts';
import type { OneReview, ReviewDependency, ReviewFile, ReviewFinding } from './api-types.ts';

export const FILES_SHOWN = 500;
export const FINDINGS_SHOWN = 200;
export const REASON_CHARS = 2000;
export const BODY_CHARS = 4000;

/** A finding as read from the result: the quote serves matching only and is never answered. */
export type ReadFinding = Omit<ReviewFinding, 'thread'> & { quote: string };

type Bag = Record<string, unknown>;
const isBag = (value: unknown): value is Bag => typeof value === 'object' && value !== null && !Array.isArray(value);
const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const isScore = (value: unknown): value is number => isWhole(value) && value >= 0 && value <= 100;
const isFinite_ = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const field = (value: unknown, key: string): unknown => (isBag(value) ? value[key] : undefined);
const codeOrUnknown = (value: unknown): string => (typeof value === 'string' && isShortCode(value) ? value : 'unknown');
const byUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** At most `max` UTF-16 units, never ending inside a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xD800 && last <= 0xDBFF) end -= 1;
  return text.slice(0, end);
}

export function thresholdOf(result: unknown): number | null {
  const threshold = field(field(result, 'verdict'), 'threshold');
  return isFinite_(threshold) ? threshold : null;
}

export function nothingNew(result: unknown): boolean {
  return field(result, 'nothingToDo') === true;
}

export function readOf(result: unknown): OneReview['read'] {
  const files = listOf(field(result, 'scores')).filter((entry) => isBag(entry) && typeof entry.path === 'string').length;
  const reviewed = listOf(field(field(result, 'coverage'), 'reviewed')).filter((path) => typeof path === 'string').length;
  return { files, reviewed };
}

export function modelsOf(result: unknown): string[] {
  return listOf(field(result, 'models')).filter((name): name is string => typeof name === 'string' && /^[\x21-\x7E]{1,200}$/.test(name)).slice(0, 10);
}

interface ReadEntry { score: number; category: string; reason: string }
const entryOf = (value: unknown): ReadEntry | null => {
  if (!isBag(value) || !isFinite_(value.score) || typeof value.category !== 'string' || typeof value.reason !== 'string') return null;
  return { score: value.score, category: value.category, reason: value.reason };
};
interface ReadBlock { entry: ReadEntry | null; span: ReviewFile['highest']; origin: ReviewFile['kept']; raisedFrom: number | null }
const blockOf = (value: Bag): ReadBlock => {
  const span = value.span;
  const origin = value.origin;
  return {
    entry: entryOf(value.entry),
    span: isBag(span) && (span.side === 'LEFT' || span.side === 'RIGHT') && isWhole(span.first) && isWhole(span.last)
      ? { side: span.side, first: span.first, last: span.last } : null,
    origin: origin === 'earlier_run' || origin === 'other_pull_request' ? origin : null,
    raisedFrom: isScore(value.raisedFrom) ? value.raisedFrom : null,
  };
};

/** The rows of the files, the reviewed ones first by score, then the others by path. */
export function filesOf(result: unknown): { files: ReviewFile[]; cut: number } {
  const reasons = new Map<string, string>();
  for (const entry of listOf(field(field(result, 'coverage'), 'notReviewed'))) {
    if (isBag(entry) && typeof entry.path === 'string' && !reasons.has(entry.path)) reasons.set(entry.path, codeOrUnknown(entry.reason));
  }
  const rows: ReviewFile[] = [];
  const seen = new Set<string>();
  for (const scored of listOf(field(result, 'scores'))) {
    if (!isBag(scored) || typeof scored.path !== 'string' || !isScore(scored.finalScore)) continue;
    const blocks = listOf(scored.blocks).filter(isBag).map(blockOf);
    let deciding: ReadBlock | null = null;
    for (const candidate of blocks) {
      if (candidate.entry !== null && (deciding === null || candidate.entry.score > (deciding.entry as ReadEntry).score)) deciding = candidate;
    }
    const level = isBag(scored.fileLevel) && isFinite_(scored.fileLevel.score) && typeof scored.fileLevel.source === 'string'
      ? { score: scored.fileLevel.score, source: scored.fileLevel.source } : null;
    const row: ReviewFile = {
      path: scored.path, score: scored.finalScore, notReviewed: reasons.get(scored.path) ?? null, source: null, reason: '', category: null,
      blocks: blocks.length, highest: null, kept: null, raisedFrom: null,
    };
    if (level !== null && (deciding === null || level.score > (deciding.entry as ReadEntry).score)) {
      row.source = codeOrUnknown(level.source);
      const whole = entryOf(scored.wholeFile);
      if (level.source === 'whole_file' && whole !== null) row.reason = clip(whole.reason, REASON_CHARS);
    } else if (deciding !== null) {
      const entry = deciding.entry as ReadEntry;
      const other = deciding.origin === 'other_pull_request';
      row.reason = other ? '' : clip(entry.reason, REASON_CHARS);
      row.category = other && isShortCode(entry.category) ? entry.category : null;
      row.highest = deciding.span;
      row.kept = deciding.origin;
      row.raisedFrom = deciding.raisedFrom;
    }
    rows.push(row);
    seen.add(scored.path);
  }
  for (const [path, reason] of reasons) {
    if (!seen.has(path)) {
      rows.push({ path, score: null, notReviewed: reason, source: null, reason: '', category: null, blocks: 0, highest: null, kept: null, raisedFrom: null });
    }
  }
  const reviewed = rows.filter((row) => row.notReviewed === null).sort((a, b) => ((b.score as number) - (a.score as number)) || byUnits(a.path, b.path));
  const rest = rows.filter((row) => row.notReviewed !== null).sort((a, b) => byUnits(a.path, b.path));
  const all = [...reviewed, ...rest];
  return { files: all.slice(0, FILES_SHOWN), cut: Math.max(0, all.length - FILES_SHOWN) };
}

const SEVERITIES = ['blocker', 'major', 'minor'] as const;
const KINDS: ReadonlyArray<[string, ReviewFinding['kind']]> = [['findings', 'placed'], ['unplaced', 'unplaced'], ['unchanged', 'unchanged'], ['beyondDiff', 'beyond_diff']];

/** All the findings, sorted by severity and keeping the kinds' order within each. */
export function findingsOf(result: unknown): ReadFinding[] {
  const found: ReadFinding[] = [];
  for (const [key, kind] of KINDS) {
    for (const item of listOf(field(result, key))) {
      if (!isBag(item)) continue;
      const { severity, path, side, line, body } = item;
      if (severity !== 'blocker' && severity !== 'major' && severity !== 'minor') continue;
      if (typeof path !== 'string' || (side !== 'LEFT' && side !== 'RIGHT') || !isWhole(line) || line < 0 || typeof body !== 'string') continue;
      found.push({ kind, severity, path, side, line, body: clip(body, BODY_CHARS), quote: typeof item.quote === 'string' ? item.quote : '' });
    }
  }
  return found.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

export function countsOf(findings: readonly ReadFinding[]): { blocker: number; major: number; minor: number } {
  const counts = { blocker: 0, major: 0, minor: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function earlierOf(result: unknown): OneReview['earlier'] {
  const verdicts = listOf(field(result, 'threadVerdicts')).filter(isBag);
  const open = verdicts.filter((verdict) => verdict.verdict === 'open').length;
  const cleared = verdicts.length - open;
  const due = field(result, 'threadsDue');
  const discussed = field(result, 'alreadyDiscussed');
  return {
    cleared, open, unjudged: Math.max(0, (isWhole(due) && due >= 0 ? due : 0) - cleared - open),
    discussed: Array.isArray(discussed) ? discussed.length : 0,
  };
}

type Status = ReviewDependency['status'];
const count = (value: unknown): number | null => (isWhole(value) && value >= 0 ? value : null);
const statusOf = (value: unknown, allowed: readonly Status[]): Status | null => (allowed.includes(value as Status) ? value as Status : null);
const codeOf = (status: Status, value: unknown): string | null => (status !== 'ok' && typeof value === 'string' && isShortCode(value) ? value : null);

export function dependenciesOf(result: unknown): ReviewDependency[] {
  const dependencies = field(result, 'dependencies');
  const out: ReviewDependency[] = [];
  const model = field(dependencies, 'model');
  if (model === 'ok' || model === 'error') out.push({ kind: 'model', name: null, status: model, code: null, count: null });
  const memory = field(dependencies, 'memory');
  const memoryStatus = statusOf(field(memory, 'status'), ['ok', 'empty', 'skipped', 'error']);
  if (memoryStatus !== null) {
    out.push({ kind: 'memory', name: null, status: memoryStatus, code: codeOf(memoryStatus, field(memory, 'code')), count: count(field(memory, 'lines')) });
  }
  const lessons = field(memory, 'lessons');
  const lessonsStatus = statusOf(field(lessons, 'status'), ['ok', 'empty', 'skipped', 'error']);
  if (lessonsStatus !== null) {
    out.push({ kind: 'lessons', name: null, status: lessonsStatus, code: codeOf(lessonsStatus, field(lessons, 'code')), count: count(field(lessons, 'shown')) });
  }
  const named = (source: unknown, kind: 'mcp' | 'extension', allowed: readonly Status[], counted: string | null): void => {
    if (!isBag(source)) return;
    const names = Object.keys(source).filter((name) => /^[A-Za-z0-9._-]{1,64}$/.test(name)).sort(byUnits).slice(0, 50);
    for (const name of names) {
      const status = statusOf(field(source[name], 'status'), allowed);
      if (status === null) continue;
      out.push({ kind, name, status, code: codeOf(status, field(source[name], 'code')), count: counted === null ? null : count(field(source[name], counted)) });
    }
  };
  named(field(dependencies, 'mcp'), 'mcp', ['ok', 'skipped', 'error'], 'calls');
  named(field(dependencies, 'extensions'), 'extension', ['ok', 'empty', 'skipped', 'error'], null);
  return out;
}

const LEAD_APPROVED = '**Approved automatically** ';
const LEAD_NOT_APPROVED = '**Not approved automatically:** ';

/** The approval paragraph of a posted body's tail: its last paragraph when it starts with the lead of its decision; else null. */
export function paragraphOf(tail: string | null, approved: boolean): string | null {
  if (tail === null) return null;
  const cut = tail.lastIndexOf('\n\n');
  const paragraph = cut < 0 ? tail : tail.slice(cut + 2);
  if (!/^[\x20-\x7E]+$/.test(paragraph) || paragraph.length > 2000) return null;
  const lead = approved ? LEAD_APPROVED : LEAD_NOT_APPROVED;
  if (!paragraph.startsWith(lead)) return null;
  const answer = paragraph.slice(lead.length);
  return answer === '' ? null : answer;
}
