import { isChanged } from '../context/increment.ts';
import type { Changed } from '../context/increment.ts';
import type { AuditEntry, Block, Finding } from '../types.ts';

/**
 * In an incremental review and a re-check, a placed finding on a line unchanged since its file was last read:
 * a blocker is kept, a major is listed in the body only, a minor is dropped. A file without `changed` is not touched.
 */
export function reconcileMode(
  findings: Finding[], changedOf: (path: string) => Changed | null, blocksOf: (path: string) => Block[],
): { kept: Finding[]; unchanged: Finding[]; audit: AuditEntry[] } {
  const kept: Finding[] = [];
  const unchanged: Finding[] = [];
  const audit: AuditEntry[] = [];
  for (const finding of findings) {
    const changed = changedOf(finding.path);
    if (changed === null || finding.severity === 'blocker' || isChanged(changed, blocksOf(finding.path), finding.side, finding.line)) {
      kept.push(finding);
    } else if (finding.severity === 'major') {
      unchanged.push(finding);
    } else {
      audit.push({ stage: 'reconcile', action: 'dropped', subject: `${finding.path}:${finding.line}`, reason: 'unchanged_line' });
    }
  }
  return { kept, unchanged, audit };
}
