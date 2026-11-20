import test from 'node:test';
import assert from 'node:assert/strict';
import { dryWriter } from './dry-writer.ts';

test('in dry run every write is refused', async () => {
  const w = dryWriter();
  const ref = { service: 'github', owner: 'acme', repo: 'shop', number: 7 } as const;
  await assert.rejects(w.publishReview(ref, '99', { commit: 'h1', body: 'x', comments: [] }), /^Error: dry_run$/);
  await assert.rejects(w.listOwnReviews(ref, '99'), /^Error: dry_run$/);
  await assert.rejects(w.listReviewComments(ref, '99', '1'), /^Error: dry_run$/);
  await assert.rejects(w.react(ref, '99', '31', 'eyes'), /^Error: dry_run$/);
  await assert.rejects(w.comment(ref, '99', 'x'), /^Error: dry_run$/);
  await assert.rejects(w.listThreads(ref, '99'), /^Error: dry_run$/);
  await assert.rejects(w.replyToThread('99', 'PRRT_1', 'x'), /^Error: dry_run$/);
  await assert.rejects(w.editThreadComment('99', 'PRRC_1', 'x'), /^Error: dry_run$/);
  await assert.rejects(w.resolveThread('99', 'PRRT_1'), /^Error: dry_run$/);
});
