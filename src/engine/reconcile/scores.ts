import type { FileContext } from '../context/build.ts';
import type { RawBlock, RawFile, RawPart, SubmitReviewArgs } from '../model/submit-review.ts';
import { inlineText } from '../context/untrusted.ts';
import { SPLIT_ABOVE, fileDiffHash, linesOf, parseAnchor, splitBlock } from '../score/blocks.ts';
import { floorFor } from '../score/floors.ts';
import type { TeamFloors } from '../score/floors.ts';
import { CATEGORIES } from '../score/types.ts';
import type { Anchor, Block, BlockScore, Category, FileLevelSource, FileScore, ScoreEntry, Verdict } from '../score/types.ts';
import type { AuditEntry } from '../types.ts';
import { normalizePath } from './placement.ts';

const REASON_REQUIRED_FROM = 40;

// The order that settles a tie between candidates for the file's level.
const SOURCE_ORDER: FileLevelSource[] = [
  'builtin_floor', 'team_floor', 'team_file_invalid', 'not_scored', 'whole_file', 'rule_rename', 'rule_asset',
];

const isScore = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;

const isCategory = (value: string | undefined): value is Category => (CATEGORIES as readonly string[]).includes(value ?? '');

type Raw = { score?: number; category?: string; reason?: string };

// Checks one score the model gave. Nothing it says is kept until it passes here.
function entryOf(raw: Raw, subject: string, audit: AuditEntry[]): ScoreEntry | null {
  if (!isScore(raw.score)) {
    audit.push({ stage: 'reconcile', action: 'score_invalid', subject, reason: 'not_a_whole_number_from_0_to_100' });
    return null;
  }
  const reason = inlineText(raw.reason ?? '').trim();
  if (raw.score >= REASON_REQUIRED_FROM && reason === '') {
    audit.push({ stage: 'reconcile', action: 'reason_missing', subject, reason: String(raw.score) });
  }
  return { score: raw.score, category: isCategory(raw.category) ? raw.category : 'other', reason };
}

const blockScore = (block: Block, entry: ScoreEntry | null): BlockScore => ({
  id: block.id,
  hunk: block.hunk,
  hunkHash: block.hunkHash,
  hash: block.hash,
  changedLines: block.changed.length,
  span: block.span,
  lines: linesOf(block),
  entry,
});

interface ValidPart { first: Anchor; last: Anchor; entry: ScoreEntry }

function validParts(parts: RawPart[], subject: string, audit: AuditEntry[]): ValidPart[] {
  const valid: ValidPart[] = [];
  for (const part of parts) {
    const first = parseAnchor(part.first);
    const last = parseAnchor(part.last);
    if (first === null || last === null || !isScore(part.score)) {
      audit.push({ stage: 'reconcile', action: 'part_invalid', subject, reason: 'anchors_or_score' });
      continue;
    }
    const entry = entryOf(part, subject, audit);
    if (entry !== null) valid.push({ first, last, entry });
  }
  return valid;
}

// The blocks that replace `block`: itself with an entry, or its parts and rest.
function blocksFor(path: string, block: Block, item: RawBlock | undefined, audit: AuditEntry[]): BlockScore[] {
  const subject = `${path} ${block.id}`;
  if (item === undefined) return [blockScore(block, null)];
  if (item.score !== undefined) return [blockScore(block, entryOf(item, subject, audit))];
  if (item.parts === undefined) return [blockScore(block, null)];

  const parts = validParts(item.parts, subject, audit);
  if (parts.length === 0) return [blockScore(block, null)];
  if (block.changed.length <= SPLIT_ABOVE) {
    audit.push({ stage: 'reconcile', action: 'split_ignored', subject, reason: 'block_has_30_changed_lines_or_fewer' });
    let best = parts[0]!;
    for (const part of parts) if (part.entry.score > best.entry.score) best = part;
    return [blockScore(block, best.entry)];
  }

  const split = splitBlock(block, parts.map((p) => ({ first: p.first, last: p.last })));
  const out: BlockScore[] = [];
  for (const [i, made] of split.parts.entries()) {
    if (made === null) {
      audit.push({ stage: 'reconcile', action: 'part_invalid', subject, reason: 'lines_overlap_or_unchanged' });
    } else {
      out.push(blockScore(made, parts[i]!.entry));
    }
  }
  if (split.rest !== null) out.push(blockScore(split.rest, null));
  return out;
}

export function reconcileScores(
  answers: { value: SubmitReviewArgs; files: string[] }[],
  contexts: FileContext[],
  notRead: ReadonlySet<string>,
  floors: TeamFloors,
): { scores: FileScore[]; audit: AuditEntry[] } {
  const audit: AuditEntry[] = [];
  const known: ReadonlySet<string> = new Set(contexts.map((c) => c.file.path));

  // The first entry for a file, from an answer whose batch held it, is the one that counts.
  const counted = new Map<string, RawFile>();
  for (const answer of answers) {
    const batch: ReadonlySet<string> = new Set(answer.files);
    for (const raw of answer.value.files) {
      const path = normalizePath(raw.path, known);
      if (path === null) {
        audit.push({ stage: 'reconcile', action: 'score_path_not_in_pull_request', subject: raw.path, reason: 'dropped' });
      } else if (!batch.has(path)) {
        audit.push({ stage: 'reconcile', action: 'score_path_not_in_batch', subject: path, reason: 'dropped' });
      } else if (counted.has(path)) {
        audit.push({ stage: 'reconcile', action: 'score_duplicate', subject: path, reason: 'dropped' });
      } else {
        counted.set(path, raw);
      }
    }
  }

  const scores = contexts.map((context) => scoreFile(context, counted.get(context.file.path), notRead, floors, audit));
  return { scores, audit };
}

function scoreFile(
  context: FileContext,
  entry: RawFile | undefined,
  notRead: ReadonlySet<string>,
  floors: TeamFloors,
  audit: AuditEntry[],
): FileScore {
  const { file, plan } = context;
  const path = file.path;
  const wholeFile = entry === undefined || entry.score === undefined ? null : entryOf(entry, path, audit);

  const blocks: BlockScore[] = [];
  if (entry !== undefined) {
    const items = new Map<string, RawBlock>();
    for (const item of entry.blocks) {
      if (!context.blocks.some((b) => b.id === item.id)) {
        audit.push({ stage: 'reconcile', action: 'block_not_in_file', subject: `${path} ${item.id}`, reason: 'dropped' });
      } else if (items.has(item.id)) {
        audit.push({ stage: 'reconcile', action: 'block_duplicate', subject: `${path} ${item.id}`, reason: 'dropped' });
      } else {
        items.set(item.id, item);
      }
    }
    for (const block of context.blocks) blocks.push(...blocksFor(path, block, items.get(block.id), audit));
    if (wholeFile === null) {
      for (const block of blocks) {
        if (block.entry === null) audit.push({ stage: 'reconcile', action: 'block_not_scored', subject: `${path} ${block.id}`, reason: 'counts_as_100' });
      }
    }
  } else {
    blocks.push(...context.blocks.map((b) => blockScore(b, null)));
  }

  const notScored =
    plan.kind === 'none' ||
    notRead.has(path) ||
    (plan.kind !== 'rule' && entry === undefined) ||
    (plan.kind === 'model_whole' && wholeFile === null) ||
    (plan.kind === 'model' && wholeFile === null && blocks.some((b) => b.entry === null));

  const candidates: { score: number; source: FileLevelSource }[] = [];
  const floor = floorFor(file, floors);
  if (floor !== null) candidates.push({ score: 100, source: floor });
  if (plan.kind === 'rule') candidates.push({ score: plan.score, source: plan.source });
  if (notScored) candidates.push({ score: 100, source: 'not_scored' });
  if (wholeFile !== null) candidates.push({ score: wholeFile.score, source: 'whole_file' });
  candidates.sort((a, c) => c.score - a.score || SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(c.source));
  const fileLevel = candidates[0] ?? null;

  const finalScore = Math.max(fileLevel?.score ?? 0, ...blocks.map((b) => b.entry?.score ?? 0));

  let covered: boolean;
  if (plan.kind === 'rule') covered = true;
  else if (plan.kind === 'none') covered = false;
  else covered = entry !== undefined && !notRead.has(path) && (wholeFile !== null || (plan.kind === 'model' && blocks.every((b) => b.entry !== null)));

  return {
    path,
    previousPath: file.previousPath,
    diffHash: fileDiffHash(context.hunks),
    changeSummary: entry === undefined ? '' : inlineText(entry.change_summary),
    changedLines: context.blocks.length === 0 ? file.additions + file.deletions : context.blocks.reduce((n, b) => n + b.changed.length, 0),
    blocks,
    wholeFile,
    fileLevel,
    finalScore,
    covered,
  };
}

export function verdictOf(scores: FileScore[], threshold: number): Verdict {
  const highest = Math.max(0, ...scores.map((s) => s.finalScore));
  return { threshold, needsHuman: highest >= threshold, highest };
}
