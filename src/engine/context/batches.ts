import type { AuditEntry, NotReviewed } from '../types.ts';
import type { FileContext } from './build.ts';
import { MEASURE_NUMBER, MEASURE_TOKEN, fileSection } from './section.ts';
import { threadText } from './threads.ts';

export interface Batch { files: FileContext[]; tokens: number }

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

// A file's size for packing: its rendered section, with the separator that follows it.
export function unitTokens(c: FileContext): number {
  const threads = (c.threads ?? []).reduce((n, t) => n + estimateTokens(`${threadText(t, MEASURE_TOKEN)}\n\n`), 0);
  return estimateTokens(`${fileSection(c, MEASURE_NUMBER, MEASURE_NUMBER, MEASURE_TOKEN)}\n\n`) + threads;
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
    const plan = original.plan;
    if (plan.kind === 'rule') {
      audit.push({ stage: 'context', action: 'scored_by_rule', subject: path, reason: plan.source });
      continue;
    }
    if (plan.kind === 'none') {
      if (plan.reason === 'unchanged') audit.push({ stage: 'context', action: 'skipped', subject: path, reason: 'unchanged' });
      else notReviewed.push({ path, reason: plan.reason });
      continue;
    }
    // Shed the test, then the full file, until the unit fits an empty call; when the threads must go too,
    // start again from the file as given without its threads, and shed only as much of it as that unit needs.
    let cuts: AuditEntry[] = [];
    const shed = (from: FileContext): FileContext => {
      let c = from;
      cuts = [];
      if (unitTokens(c) > budget && c.test !== null) {
        c = { ...c, test: null };
        cuts.push({ stage: 'context', action: 'test_file_cut', subject: path, reason: 'over_call_budget' });
      }
      if (unitTokens(c) > budget && c.full !== null) {
        c = { ...c, full: null };
        cuts.push({ stage: 'context', action: 'full_file_cut', subject: path, reason: 'over_call_budget' });
      }
      return c;
    };
    let c = shed(original);
    if (unitTokens(c) > budget && (c.threads ?? []).length > 0) {
      c = shed({ ...original, threads: [] });
      for (const t of original.threads ?? []) cuts.push({ stage: 'context', action: 'thread_not_shown', subject: t.key, reason: 'over_call_budget' });
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
