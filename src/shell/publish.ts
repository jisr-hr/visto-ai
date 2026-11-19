import type { StoredRun } from '../db/review-runs.ts';
import { renderReview } from '../engine/render/body.ts';
import type { Span } from '../engine/score/types.ts';
import type { ReviewResult } from '../engine/types.ts';
import type { ForgeAccess, ForgeWriter, LivePullRequest, PullRequestInfo, PullRequestRef } from '../forge/types.ts';
import { codeOf } from './codes.ts';

export type PublishOutcome =
  | { kind: 'published'; reviewId: string; body: string; inlineDropped: boolean; adopted: boolean }
  | { kind: 'moved'; head: string }          // the head or the base is not the one the review was computed for
  | { kind: 'closed' }
  | { kind: 'already_reviewed' }             // the app has a review on another commit of this pull request
  | { kind: 'rejected' }
  | { kind: 'failed'; code: string };

export interface PublishDeps {
  forge: ForgeAccess; writer: ForgeWriter;
  lineUrl: (pr: PullRequestInfo, file: { path: string; previousPath: string | null }, span: Span) => string;
}

/** Publishes one recorded review, or says why not. Writes nothing to the database. Never rejects. */
export async function publishRun(deps: PublishDeps, args: {
  ref: PullRequestRef; installation: string; run: StoredRun; trigger: 'automatic' | 'manual'; requestedBy: string | null;
}): Promise<PublishOutcome> {
  const { ref, installation, run } = args;
  try {
    // 1. The pull request now.
    const live: LivePullRequest | null = await deps.forge.readPullRequest(ref, installation);
    if (live === null || live.state !== 'open') return { kind: 'closed' };
    const info = live.info;
    if (info.headSha !== run.headSha || run.baseSha === null || info.baseSha !== run.baseSha) return { kind: 'moved', head: info.headSha };

    const hadInline = Array.isArray(run.comments) && run.comments.length > 0;
    /** The review as it is written when the inline comments are not posted. */
    const bodyOnly = (): string => renderReview(run.result as ReviewResult, {
      trigger: args.trigger, requestedBy: args.requestedBy, lineUrl: (file, span) => deps.lineUrl(info, file, span), inline: false,
    }).body;

    // 2. Already posted?
    const own = await deps.writer.listOwnReviews(ref, installation);
    const same = own.find((review) => review.commit === run.headSha);
    if (same !== undefined) {
      let inlineDropped = false;
      if (hadInline) {
        const posted = await deps.writer.listReviewComments(ref, installation, same.id);
        inlineDropped = posted !== null && posted.length === 0;
      }
      return { kind: 'published', reviewId: same.id, body: inlineDropped ? bodyOnly() : run.body, inlineDropped, adopted: true };
    }
    if (own.length > 0) return { kind: 'already_reviewed' };

    // 3. The post.
    try {
      const posted = await deps.writer.publishReview(ref, installation, { commit: run.headSha, body: run.body, comments: run.comments as never });
      return { kind: 'published', reviewId: posted.id, body: run.body, inlineDropped: false, adopted: false };
    } catch (error) {
      if (codeOf(error) !== 'review_rejected') return { kind: 'failed', code: codeOf(error) };
      if (!hadInline) return { kind: 'rejected' };
    }

    // 4. The fallback.
    let body: string;
    try {
      body = bodyOnly();
    } catch {
      return { kind: 'failed', code: 'render_failed' };
    }
    try {
      const posted = await deps.writer.publishReview(ref, installation, { commit: run.headSha, body, comments: [] });
      return { kind: 'published', reviewId: posted.id, body, inlineDropped: true, adopted: false };
    } catch (error) {
      // 5. Any other rejection is a failure; a post is never repeated.
      const code = codeOf(error);
      return code === 'review_rejected' ? { kind: 'rejected' } : { kind: 'failed', code };
    }
  } catch (error) {
    return { kind: 'failed', code: codeOf(error) };
  }
}
