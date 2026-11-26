import type { FileContext } from '../context/build.ts';
import { lineTexts } from '../context/diff.ts';
import { fullFileLines } from '../context/full-file.ts';
import type { LineTexts, Ranges } from '../context/diff.ts';
import type { SubmitReviewArgs } from '../model/submit-review.ts';
import type { AuditEntry, Finding, RawFinding, Side, UnplacedFinding } from '../types.ts';
import { normalizePath, place, quoteMatches } from './placement.ts';

const MAX_OVERVIEW_CHARS = 4000;

// Cut to at most `limit` characters, ending in an ellipsis when cut, never splitting a surrogate pair.
function cutOverview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\u2026`;
}

/** The one commentable line, in the other files of the batch, whose text is the quote; null for none or several. */
function refileTarget(quote: string, own: string, batch: string[], textsByPath: ReadonlyMap<string, LineTexts | null>):
  { path: string; side: Side; line: number } | null {
  const hits: { path: string; side: Side; line: number }[] = [];
  for (const other of new Set(batch)) {
    const texts = other === own ? null : textsByPath.get(other) ?? null;
    if (texts !== null) hits.push(...quoteMatches(quote, texts).map((m) => ({ path: other, ...m })));
    if (hits.length > 1) return null;
  }
  return hits[0] ?? null;
}

/** `files` are the paths of the batch that produced the answer: a finding on any other file is dropped. */
export function reconcile(answers: { value: SubmitReviewArgs; files: string[] }[], contexts: FileContext[]):
  { overview: string; findings: Finding[]; unplaced: UnplacedFinding[]; beyondDiff: RawFinding[]; audit: AuditEntry[] } {
  const rangesByPath = new Map<string, Ranges | null>(contexts.map((c) => [c.file.path, c.ranges]));
  const textsByPath = new Map<string, LineTexts | null>(contexts.map((c) => [c.file.path, c.ranges === null ? null : lineTexts(c.hunks)]));
  const fullByPath = new Map(contexts.map((c) => [c.file.path, c.full]));
  // A file that takes no findings (a test, documentation, generated, vendored or lock file): a finding on it is dropped.
  const noFindings: ReadonlySet<string> = new Set(contexts.filter((c) => c.findings === false).map((c) => c.file.path));
  const headLines = new Map<string, Map<number, string>>();
  // The model named a line of the head outside the diff, and that line holds its quote: the finding is about
  // code the diff does not show, and neither its quote nor another file decides where it goes.
  const namesCodeOutsideDiff = (f: RawFinding): boolean => {
    const full = fullByPath.get(f.path) ?? null;
    if (f.side !== 'RIGHT' || full === null || f.quote.trim() === '') return false;
    if (!headLines.has(f.path)) headLines.set(f.path, fullFileLines(full));
    return headLines.get(f.path)!.get(f.line)?.trim() === f.quote.trim();
  };
  const known: ReadonlySet<string> = new Set(rangesByPath.keys());
  const findings: Finding[] = [];
  const unplaced: UnplacedFinding[] = [];
  const beyondDiff: RawFinding[] = [];
  const audit: AuditEntry[] = [];
  const dropped = (raw: RawFinding, reason: string): void => {
    audit.push({ stage: 'reconcile', action: 'dropped', subject: raw.path, reason });
  };

  for (const answer of answers) {
    const batch: ReadonlySet<string> = new Set(answer.files);
    for (const raw of answer.value.findings) {
      const path = normalizePath(raw.path, known);
      if (path === null) {
        dropped(raw, 'path_not_in_pull_request');
        continue;
      }
      if (!batch.has(path)) {
        dropped(raw, 'path_not_in_batch');
        continue;
      }
      if (noFindings.has(path)) {
        audit.push({ stage: 'reconcile', action: 'dropped', subject: path, reason: 'findings_not_asked' });
        continue;
      }
      if (raw.beyond_diff) {
        beyondDiff.push({ ...raw, path });
        continue;
      }
      const outside = namesCodeOutsideDiff({ ...raw, path });
      const result = place({ ...raw, path }, rangesByPath.get(path) ?? null, outside ? null : textsByPath.get(path) ?? null);
      if ('unplaced' in result) {
        const target = outside ? null : refileTarget(raw.quote, path, answer.files.filter((p) => !noFindings.has(p)), textsByPath);
        if (target === null) {
          unplaced.push(result.unplaced);
          continue;
        }
        const u = result.unplaced;
        findings.push({ severity: u.severity, body: u.body, quote: u.quote, ...target, requestedLine: null });
        audit.push({ stage: 'reconcile', action: 'refiled', subject: `${path}:${raw.line}`, reason: `to ${target.path}:${target.side}:${target.line}` });
        continue;
      }
      findings.push(result.placed);
      if (result.how === 'quote') {
        audit.push({ stage: 'reconcile', action: 'placed_by_quote', subject: `${path}:${raw.side}:${raw.line}`, reason: `to ${result.placed.side}:${result.placed.line}` });
      } else if (result.placed.requestedLine !== null) {
        audit.push({ stage: 'reconcile', action: 'moved', subject: `${path}:${result.placed.requestedLine}`, reason: `to ${result.placed.line}` });
      }
    }
  }

  const overview = answers
    .map((a) => cutOverview(a.value.overview.trim(), MAX_OVERVIEW_CHARS))
    .filter((o) => o !== '')
    .join('\n\n');
  return { overview, findings, unplaced, beyondDiff, audit };
}
