import type { AuditEntry, NotReviewed } from '../types.ts';
import type { FileContext } from './build.ts';
import { MEASURE_NUMBER, MEASURE_TOKEN, fileSection } from './section.ts';

export interface Batch { files: FileContext[]; tokens: number }

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

// A file's size for packing: its rendered section, with the separator that follows it.
export function unitTokens(c: FileContext): number {
  return estimateTokens(`${fileSection(c, MEASURE_NUMBER, MEASURE_NUMBER, MEASURE_TOKEN)}\n\n`);
}

export function packBatches(
  contexts: FileContext[],
  budget: number,
  maxBatches: number,
): { batches: Batch[]; notReviewed: NotReviewed[]; audit: AuditEntry[] } {
  const batches: Batch[] = [];
  const notReviewed: NotReviewed[] = [];
  const audit: AuditEntry[] = [];
  let current: Batch | null = null;
  let full = false; // the batch limit is reached and the last batch is closed

  for (const original of contexts) {
    const path = original.file.path;
    if (original.skip === 'unchanged') {
      audit.push({ stage: 'context', action: 'skipped', subject: path, reason: 'unchanged' });
      continue;
    }
    if (original.skip !== null) {
      notReviewed.push({ path, reason: original.skip });
      continue;
    }
    // Shed the test, then the full file, until the unit fits an empty call.
    let c = original;
    const cuts: AuditEntry[] = [];
    const cut = (action: string): void => {
      cuts.push({ stage: 'context', action, subject: path, reason: 'over_call_budget' });
    };
    if (unitTokens(c) > budget && c.test !== null) {
      c = { ...c, test: null };
      cut('test_file_cut');
    }
    if (unitTokens(c) > budget && c.full !== null) {
      c = { ...c, full: null };
      cut('full_file_cut');
    }
    if (unitTokens(c) > budget) {
      notReviewed.push({ path, reason: 'too_large' });
      continue;
    }
    if (full) {
      notReviewed.push({ path, reason: 'over_batch_limit' });
      continue;
    }
    const tokens = unitTokens(c);
    if (current === null || current.tokens + tokens > budget) {
      if (batches.length >= maxBatches) {
        full = true;
        notReviewed.push({ path, reason: 'over_batch_limit' });
        continue;
      }
      current = { files: [], tokens: 0 };
      batches.push(current);
    }
    current.files.push(c);
    current.tokens += tokens;
    audit.push(...cuts);
  }
  return { batches, notReviewed, audit };
}
