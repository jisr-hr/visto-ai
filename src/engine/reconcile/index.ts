import type { FileContext } from '../context/build.ts';
import type { Ranges } from '../context/diff.ts';
import type { SubmitReviewArgs } from '../model/submit-review.ts';
import type { AuditEntry, Finding, RawFinding, UnplacedFinding } from '../types.ts';
import { normalizePath, place } from './placement.ts';

const MAX_OVERVIEW_CHARS = 4000;

// Cut to at most `limit` characters, ending in an ellipsis when cut, never splitting a surrogate pair.
function cutOverview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\u2026`;
}

/** `files` are the paths of the batch that produced the answer: a finding on any other file is dropped. */
export function reconcile(answers: { value: SubmitReviewArgs; files: string[] }[], contexts: FileContext[]):
  { overview: string; findings: Finding[]; unplaced: UnplacedFinding[]; beyondDiff: RawFinding[]; audit: AuditEntry[] } {
  const rangesByPath = new Map<string, Ranges | null>(contexts.map((c) => [c.file.path, c.ranges]));
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
      if (raw.beyond_diff) {
        beyondDiff.push({ ...raw, path });
        continue;
      }
      const result = place({ ...raw, path }, rangesByPath.get(path) ?? null);
      if ('unplaced' in result) {
        unplaced.push(result.unplaced);
        continue;
      }
      findings.push(result.placed);
      if (result.placed.requestedLine !== null) {
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
