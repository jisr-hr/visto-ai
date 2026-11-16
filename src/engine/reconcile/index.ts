import type { FileContext } from '../context/build.ts';
import type { Ranges } from '../context/diff.ts';
import type { SubmitReviewArgs } from '../model/submit-review.ts';
import type { AuditEntry, Finding, RawFinding, UnplacedFinding } from '../types.ts';
import { normalizePath, place } from './placement.ts';

export function reconcile(answers: SubmitReviewArgs[], contexts: FileContext[]):
  { overview: string; findings: Finding[]; unplaced: UnplacedFinding[]; beyondDiff: RawFinding[]; audit: AuditEntry[] } {
  const rangesByPath = new Map<string, Ranges | null>(contexts.map((c) => [c.file.path, c.ranges]));
  const known: ReadonlySet<string> = new Set(rangesByPath.keys());
  const findings: Finding[] = [];
  const unplaced: UnplacedFinding[] = [];
  const beyondDiff: RawFinding[] = [];
  const audit: AuditEntry[] = [];

  for (const answer of answers) {
    for (const raw of answer.findings) {
      if (raw.beyond_diff) {
        beyondDiff.push(raw);
        continue;
      }
      const path = normalizePath(raw.path, known);
      if (path === null) {
        audit.push({ stage: 'reconcile', action: 'dropped', subject: raw.path, reason: 'path_not_in_pull_request' });
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

  const overview = answers.map((a) => a.overview.trim()).filter((o) => o !== '').join('\n\n');
  return { overview, findings, unplaced, beyondDiff, audit };
}
