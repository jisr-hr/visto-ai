import type { StoredRun } from '../db/review-runs.ts';
import { renderReview } from '../engine/render/body.ts';
import type { Span } from '../engine/score/types.ts';
import type { ReviewResult } from '../engine/types.ts';
import type { ForgeAccess, ForgeWriter, LivePullRequest, PullRequestInfo, PullRequestRef } from '../forge/types.ts';
import { codeOf } from './codes.ts';

export type PublishOutcome =
  | { kind: 'published'; reviewId: string; body: string; inlineDropped: boolean; notesDropped: boolean; adopted: boolean }
  | { kind: 'moved'; head: string }          // the head or the base is not the one the review was computed for
  | { kind: 'closed' }
  | { kind: 'rejected' }
  | { kind: 'failed'; code: string };

export interface PublishDeps {
  forge: ForgeAccess; writer: ForgeWriter;
  lineUrl: (pr: PullRequestInfo, file: { path: string; previousPath: string | null }, span: Span) => string;
  commentUrl: (ref: PullRequestRef, commentId: string) => string;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/** Publishes one recorded review, or says why not. Writes nothing to the database. Never rejects. */
export async function publishRun(deps: PublishDeps, args: {
  ref: PullRequestRef; installation: string; run: StoredRun; trigger: 'automatic' | 'manual'; requestedBy: string | null;
  /** The ids of the reviews the database holds as published for this pull request. */
  known: ReadonlySet<string>;
  /** The run was recorded by an earlier start: its review is posted without its notes. */
  resumed: boolean;
}): Promise<PublishOutcome> {
  const { ref, installation, run } = args;
  try {
    // 1. The pull request now.
    const live: LivePullRequest | null = await deps.forge.readPullRequest(ref, installation);
    if (live === null || live.state !== 'open') return { kind: 'closed' };
    const info = live.info;
    if (info.headSha !== run.headSha || run.baseSha === null || info.baseSha !== run.baseSha) return { kind: 'moved', head: info.headSha };

    // The recorded comments: the findings' first, then the notes (an entry with a string `note`).
    const recorded = (Array.isArray(run.comments) ? (run.comments as unknown[]) : []).filter(isObject);
    const notes = recorded.filter((c) => typeof c.note === 'string');
    const findings = recorded.filter((c) => typeof c.note !== 'string');
    const hadNotes = notes.length > 0;
    /** The review as it is written when the inline comments are not posted. */
    const bodyOnly = (): string => renderReview(run.result as ReviewResult, {
      trigger: args.trigger, requestedBy: args.requestedBy, lineUrl: (file, span) => deps.lineUrl(info, file, span), inline: false,
      commentUrl: (id) => deps.commentUrl(ref, id),
    }).body;
    const post = (body: string, comments: Array<Record<string, unknown>>): Promise<{ id: string }> =>
      deps.writer.publishReview(ref, installation, { commit: run.headSha, body, comments: comments as never });

    // 2. Already posted? Only a review of the app's own on this commit that the database does not know.
    const own = await deps.writer.listOwnReviews(ref, installation);
    const same = own.find((review) => review.commit === run.headSha && !args.known.has(review.id));
    if (same !== undefined) {
      let inlineDropped = false;
      let notesDropped = false;
      if (recorded.length > 0) {
        const posted = await deps.writer.listReviewComments(ref, installation, same.id);
        if (posted !== null) {
          const noteBodies = new Set(notes.map((c) => c.body).filter((b) => typeof b === 'string'));
          const heldNotes = posted.filter((c) => noteBodies.has(c.body)).length;
          notesDropped = hadNotes && heldNotes === 0;
          inlineDropped = findings.length > 0 && posted.length - heldNotes === 0;
        }
      }
      return { kind: 'published', reviewId: same.id, body: inlineDropped ? bodyOnly() : run.body, inlineDropped, notesDropped, adopted: true };
    }

    // 3. The post: with every recorded comment, or the findings' alone for a review a later start publishes.
    let notesDropped = args.resumed && hadNotes;
    try {
      const posted = await post(run.body, notesDropped ? findings : recorded);
      return { kind: 'published', reviewId: posted.id, body: run.body, inlineDropped: false, notesDropped, adopted: false };
    } catch (error) {
      if (codeOf(error) !== 'review_rejected') return { kind: 'failed', code: codeOf(error) };
    }

    // 4. Refused with notes: posted again without them, the findings still inline.
    if (hadNotes && !notesDropped) {
      notesDropped = true;
      try {
        const posted = await post(run.body, findings);
        return { kind: 'published', reviewId: posted.id, body: run.body, inlineDropped: false, notesDropped, adopted: false };
      } catch (error) {
        if (codeOf(error) !== 'review_rejected') return { kind: 'failed', code: codeOf(error) };
      }
    }
    if (findings.length === 0) return { kind: 'rejected' };

    // 5. The fallback: the body written whole, with no comment.
    let body: string;
    try {
      body = bodyOnly();
    } catch {
      return { kind: 'failed', code: 'render_failed' };
    }
    try {
      const posted = await post(body, []);
      return { kind: 'published', reviewId: posted.id, body, inlineDropped: true, notesDropped, adopted: false };
    } catch (error) {
      // 6. Any other rejection is a failure; a post is never repeated.
      const code = codeOf(error);
      return code === 'review_rejected' ? { kind: 'rejected' } : { kind: 'failed', code };
    }
  } catch (error) {
    return { kind: 'failed', code: codeOf(error) };
  }
}
