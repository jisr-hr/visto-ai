import type { AuditEntry, NotReviewed } from '../types.ts';
import type { FileContext } from './build.ts';

export interface Batch { files: FileContext[]; tokens: number }

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function unitTokens(c: FileContext): { diff: number; full: number; test: number } {
  return {
    diff: c.diffText === null ? 0 : estimateTokens(c.diffText),
    full: c.full === null ? 0 : estimateTokens(c.full.text),
    test: c.test === null ? 0 : estimateTokens(c.test.text),
  };
}

function total(c: FileContext): number {
  const t = unitTokens(c);
  return t.diff + t.full + t.test;
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
    if (original.ranges === null) {
      notReviewed.push({ path, reason: 'no_diff' });
      continue;
    }
    // Shed the test, then the full file, until the unit fits an empty call.
    let c = original;
    const cuts: AuditEntry[] = [];
    const cut = (action: string): void => {
      cuts.push({ stage: 'context', action, subject: path, reason: 'over_call_budget' });
    };
    if (total(c) > budget && c.test !== null) {
      c = { ...c, test: null };
      cut('test_file_cut');
    }
    if (total(c) > budget && c.full !== null) {
      c = { ...c, full: null };
      cut('full_file_cut');
    }
    if (total(c) > budget) {
      notReviewed.push({ path, reason: 'too_large' });
      continue;
    }
    if (full) {
      notReviewed.push({ path, reason: 'over_batch_limit' });
      continue;
    }
    const tokens = total(c);
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
