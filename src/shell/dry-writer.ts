import type { ForgeWriter } from '../forge/types.ts';

const refused = (): Promise<never> => Promise.reject(new Error('dry_run'));

/** A writer for dry run: every method rejects with Error('dry_run'). */
export function dryWriter(): ForgeWriter {
  return { publishReview: refused, listOwnReviews: refused, listReviewComments: refused, react: refused, comment: refused };
}
