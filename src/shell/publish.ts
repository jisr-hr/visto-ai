import type { ApprovalCode } from '../approval/rule.ts';
import { liveRefusal, storedRefusal } from '../approval/rule.ts';
import { approvalParagraph } from '../approval/text.ts';
import { openForApproval } from '../approval/threads.ts';
import type { ApprovalThreads } from '../config/load.ts';
import type { StoredComment } from '../db/review-comments.ts';
import type { StoredRun } from '../db/review-runs.ts';
import { fitBody, renderReview } from '../engine/render/body.ts';
import type { Span } from '../engine/score/types.ts';
import type { ReviewResult } from '../engine/types.ts';
import type {
  ForgeAccess, ForgeApprovals, ForgeWriter, LivePullRequest, PullRequestInfo, PullRequestRef, ReviewDraft, ReviewThread,
} from '../forge/types.ts';
import { codeOf } from './codes.ts';
import { missedComments } from './earlier.ts';
import { isNoteText } from './posted.ts';

export type PublishOutcome =
  | {
    kind: 'published'; reviewId: string; body: string; inlineDropped: boolean; notesDropped: boolean; adopted: boolean;
    // A decision this publication made (code), or an adopted review GitHub holds as an approval (code null); absent: neither.
    approval?: { approved: boolean; code: ApprovalCode | null; dismissed: boolean };
  }
  | { kind: 'moved'; head: string }          // the head or the base is not the one the review was computed for
  | { kind: 'closed' }
  | { kind: 'unlisted' }                     // held, and the git service lists no review of the app's own for it: nothing was posted
  | { kind: 'rejected' }
  | { kind: 'failed'; code: string };

export interface PublishDeps {
  forge: ForgeAccess; writer: ForgeWriter;
  lineUrl: (pr: PullRequestInfo, file: { path: string; previousPath: string | null }, span: Span) => string;
  commentUrl: (ref: PullRequestRef, commentId: string) => string;
  approvals?: ForgeApprovals;
}

/** What the decision on automatic approval is made from, besides the live reads. Given only when approval is on for the repository. */
export interface ApprovalContext {
  rule: ApprovalThreads; clearByReply: boolean; threshold: number;
  runs: StoredRun[] | null;                                      // every run of the pull request, this one included; null: could not be read
  stored: Array<StoredComment & { run: number }> | null;         // the app's stored comments; null: could not be read
  /** The gate's check name where the gate enforces on this base branch; null elsewhere. A branch that requires it holds condition 8. */
  enforcedCheck: (baseBranch: string) => string | null;
  drawn: () => boolean;   // 6.5: asked once, last, only when every other condition held; a throw or any answer but false is drawn
}

/** A decision, with the short code of the read that failed when it names one. */
interface Decision { code: ApprovalCode; detail?: string }

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/**
 * The decision on automatic approval at the moment of posting (6.4): each condition only when the ones before it held, so that a
 * read is made only when needed: the stored runs and comments, the live pull request, its threads, the base branch's rule, and
 * last the audit sample (6.5). What cannot be read, or told, is never approved.
 */
async function decide(deps: PublishDeps, ref: PullRequestRef, installation: string, run: StoredRun, info: PullRequestInfo, ctx: ApprovalContext): Promise<Decision> {
  const runs = ctx.runs;
  const read = ctx.stored;
  // A list that is no list could not be read either.
  if (!Array.isArray(runs) || !Array.isArray(read)) return { code: 'record_unreadable' };
  const stored = storedRefusal(run, runs, ctx.threshold);
  if (stored !== null) return { code: stored };
  const live = liveRefusal(info);
  if (live !== null) return { code: live };

  let threads: ReviewThread[];
  try {
    const listed: unknown = await deps.writer.listThreads(ref, installation);
    if (!Array.isArray(listed)) return { code: 'threads_unreadable', detail: 'internal_error' };
    threads = listed as ReviewThread[];
  } catch (error) {
    return { code: 'threads_unreadable', detail: codeOf(error) };
  }
  // The stored comments, with the first comments of the app's threads the database did not hold; a repair that fails leaves them as read.
  let comments = read;
  try {
    comments = [...read, ...missedComments({ runs, stored: read, threads })];
  } catch {
    // as read
  }
  if (openForApproval({ threads, stored: comments, runs, run, rule: ctx.rule, author: info.author, clearByReply: ctx.clearByReply }) > 0) {
    return { code: 'open_thread' };
  }

  if (deps.approvals === undefined) return { code: 'rule_unreadable', detail: 'internal_error' };
  let rule: unknown;
  try {
    // Where the gate enforces, a branch that requires its check also holds a new commit until the commit is reviewed.
    const check = ctx.enforcedCheck(info.baseBranch);
    rule = await deps.approvals.staleApprovals(ref, installation, info.baseBranch, check ?? undefined);
  } catch (error) {
    return { code: 'rule_unreadable', detail: codeOf(error) };
  }
  // Any answer but the three is no answer.
  if (rule !== 'dismissed' && rule !== 'gated') return rule === 'kept' ? { code: 'rule_off' } : { code: 'rule_unreadable', detail: 'internal_error' };

  // 6. The audit sample, asked once and last: only an answer of exactly false approves; any other, or a throw, sends it to a person.
  let drawn: unknown;
  try {
    drawn = ctx.drawn();
  } catch {
    return { code: 'audit_sample' };
  }
  return drawn === false ? { code: 'approved' } : { code: 'audit_sample' };
}

/** Publishes one recorded review, or says why not. Writes nothing to the database. Never rejects. */
export async function publishRun(deps: PublishDeps, args: {
  ref: PullRequestRef; installation: string; run: StoredRun; trigger: 'automatic' | 'manual'; requestedBy: string | null;
  /** The ids of the reviews the database holds as published for this pull request. */
  known: ReadonlySet<string>;
  /** The run was recorded by an earlier start: its review is posted without its notes. */
  resumed: boolean;
  /** The run is too young to be posted by a later start: the git service may hold its review and not list it yet. */
  hold: boolean;
  /** Present when approval is on for the repository: the review is then decided, posted as an approval or not, and says why. */
  approval?: ApprovalContext;
  /** false: the run was recorded by another job, whose trigger and requester its text keeps; absent reads as true. */
  ownRun?: boolean;
}): Promise<PublishOutcome> {
  const { ref, installation, run } = args;
  const ownRun = args.ownRun !== false;
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
    const links = {
      lineUrl: (file: { path: string; previousPath: string | null }, span: Span) => deps.lineUrl(info, file, span),
      commentUrl: (id: string) => deps.commentUrl(ref, id),
    };
    /**
     * The review as it is written when the inline comments are not posted, ending with `paragraph` when one is given. A run another job
     * recorded is written as that job asked for it: its own trigger, and no requester, since this job's may not be the one who asked.
     */
    const bodyOnly = (paragraph?: string): string => renderReview(run.result as ReviewResult, {
      trigger: ownRun ? args.trigger : run.trigger, requestedBy: ownRun ? args.requestedBy : null, lineUrl: links.lineUrl, inline: false,
      commentUrl: links.commentUrl, ...(paragraph === undefined ? {} : { approval: paragraph }),
    }).body;
    const post = (body: string, comments: Array<Record<string, unknown>>, event?: ReviewDraft['event']): Promise<{ id: string }> =>
      deps.writer.publishReview(ref, installation, { commit: run.headSha, body, comments: comments as never, ...(event === undefined ? {} : { event }) });

    // 2. Already posted? Only a review of the app's own on this commit that the database does not know.
    const own = await deps.writer.listOwnReviews(ref, installation);
    const same = own.find((review) => review.commit === run.headSha && !args.known.has(review.id));
    if (same !== undefined) {
      let inlineDropped = false;
      let notesDropped = false;
      if (recorded.length > 0) {
        const posted = await deps.writer.listReviewComments(ref, installation, same.id);
        if (posted !== null) {
          // A note GitHub holds is told by the part of its text the service wrote, as the read-back tells it.
          const noteBodies = notes.map((c) => c.body).filter((b): b is string => typeof b === 'string');
          const heldNotes = posted.filter((c) => typeof c.body === 'string' && noteBodies.some((b) => isNoteText(b, c.body))).length;
          notesDropped = hadNotes && heldNotes === 0;
          inlineDropped = findings.length > 0 && posted.length - heldNotes === 0;
        }
      }
      // It keeps what GitHub holds: an approval (only an approval can be dismissed here), or a comment; it is not decided again.
      const held = same.state === 'approved' || same.state === 'dismissed' ? { approval: { approved: true, code: null, dismissed: same.state === 'dismissed' } } : {};
      return { kind: 'published', reviewId: same.id, body: inlineDropped ? bodyOnly() : run.body, inlineDropped, notesDropped, adopted: true, ...held };
    }
    if (args.hold) return { kind: 'unlisted' };

    // 3. The decision, with approval on; the paragraph the body ends with says it.
    const ctx = args.approval;
    let decision: Decision | null = ctx === undefined ? null : await decide(deps, ref, installation, run, info, ctx);
    /** The paragraph of the decision as it stands; none with approval off. */
    const paragraph = (): string | undefined => (ctx === undefined || decision === null ? undefined
      : approvalParagraph(decision.code, { head: run.headSha, threshold: ctx.threshold, rule: ctx.rule, ...(decision.detail === undefined ? {} : { code: decision.detail }) }));
    /** The body posted with its inline comments: with approval off, the recorded one; with approval on, with the paragraph. */
    const bodyFor = (): string => {
      const p = paragraph();
      if (p === undefined) return run.body;
      // A run another job recorded is never written again with this job's trigger or requester.
      if (!ownRun) return fitBody(run.body, p);
      try {
        return renderReview(run.result as ReviewResult, {
          trigger: args.trigger, requestedBy: args.requestedBy, lineUrl: links.lineUrl, inline: true, commentUrl: links.commentUrl, approval: p,
        }).body;
      } catch {
        // The recorded body, with the paragraph decided now kept whole; the decision stands.
        return fitBody(run.body, p);
      }
    };
    const told = (): Pick<Extract<PublishOutcome, { kind: 'published' }>, 'approval'> =>
      decision === null ? {} : { approval: { approved: decision.code === 'approved', code: decision.code, dismissed: false } };

    // 4. The post: with every recorded comment, or the findings' alone for a review a later start publishes.
    let notesDropped = args.resumed && hadNotes;
    if (decision?.code === 'approved') {
      // An approval is sent once: GitHub refusing it makes the review a comment that says so.
      const body = bodyFor();
      try {
        const posted = await post(body, notesDropped ? findings : recorded, 'approve');
        return { kind: 'published', reviewId: posted.id, body, inlineDropped: false, notesDropped, adopted: false, ...told() };
      } catch (error) {
        if (codeOf(error) !== 'review_rejected') return { kind: 'failed', code: codeOf(error) };
        decision = { code: 'refused', detail: 'review_rejected' };
      }
    }
    // Every other decision, a refused approval, and approval off: as a comment.
    const body = bodyFor();
    try {
      const posted = await post(body, notesDropped ? findings : recorded);
      return { kind: 'published', reviewId: posted.id, body, inlineDropped: false, notesDropped, adopted: false, ...told() };
    } catch (error) {
      if (codeOf(error) !== 'review_rejected') return { kind: 'failed', code: codeOf(error) };
    }

    // 5. Refused with notes: posted again without them, the findings still inline.
    if (hadNotes && !notesDropped) {
      notesDropped = true;
      try {
        const posted = await post(body, findings);
        return { kind: 'published', reviewId: posted.id, body, inlineDropped: false, notesDropped, adopted: false, ...told() };
      } catch (error) {
        if (codeOf(error) !== 'review_rejected') return { kind: 'failed', code: codeOf(error) };
      }
    }
    if (findings.length === 0) return { kind: 'rejected' };

    // 6. The fallback: the body written whole, with no comment.
    let whole: string;
    try {
      whole = bodyOnly(paragraph());
    } catch {
      return { kind: 'failed', code: 'render_failed' };
    }
    try {
      const posted = await post(whole, []);
      return { kind: 'published', reviewId: posted.id, body: whole, inlineDropped: true, notesDropped, adopted: false, ...told() };
    } catch (error) {
      // 7. Any other rejection is a failure; a post is never repeated.
      const code = codeOf(error);
      return code === 'review_rejected' ? { kind: 'rejected' } : { kind: 'failed', code };
    }
  } catch (error) {
    return { kind: 'failed', code: codeOf(error) };
  }
}
