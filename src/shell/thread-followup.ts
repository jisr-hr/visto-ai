import { clearingReply, hasMarker, hasMarkerOf, openAgainReply, openReply } from '../engine/render/thread-reply.ts';
import type { ThreadVerdict } from '../engine/types.ts';
import type { ForgeWriter, ReviewThread } from '../forge/types.ts';
import { codeOf } from './codes.ts';

export type FollowUp =
  | { kind: 'reply'; thread: string; body: string; resolve: boolean }
  | { kind: 'edit'; thread: string; comment: string; body: string; resolve: boolean }
  | { kind: 'resolve'; thread: string };

export const FOLLOW_UP_PAUSE_MS = 1000;

/** What to write in the threads for these verdicts. `missing` counts verdicts whose thread is no longer there. Writes nothing. */
export function planFollowUp(args: { verdicts: ThreadVerdict[]; threads: ReviewThread[]; reviewId: string; head: string; canResolve: boolean }): { actions: FollowUp[]; missing: number } {
  const actions: FollowUp[] = [];
  let missing = 0;
  for (const verdict of args.verdicts) {
    const thread = args.threads.find((t) => t.id === verdict.threadId);
    if (thread === undefined) {
      missing += 1;
      continue;
    }
    // The first comment is the finding and is never rewritten.
    const last = thread.comments.length > 1 ? thread.comments[thread.comments.length - 1]! : null;
    const wantsResolve = args.canResolve && !thread.resolved;
    if (verdict.verdict === 'open') {
      if (last !== null && last.byApp && hasMarker(last.body)) {
        actions.push({ kind: 'edit', thread: thread.id, comment: last.node, body: openAgainReply(verdict, args.head), resolve: false });
      } else if (last !== null && !last.byApp) {
        const body = openReply(verdict);
        if (body !== null) actions.push({ kind: 'reply', thread: thread.id, body, resolve: false });
      }
      continue;
    }
    if (last !== null && last.byApp && hasMarkerOf(last.body, args.reviewId, args.head)) {
      if (wantsResolve) actions.push({ kind: 'resolve', thread: thread.id });
    } else if (last !== null && last.byApp) {
      actions.push({ kind: 'edit', thread: thread.id, comment: last.node, body: clearingReply(verdict, args.reviewId, args.head), resolve: wantsResolve });
    } else {
      actions.push({ kind: 'reply', thread: thread.id, body: clearingReply(verdict, args.reviewId, args.head), resolve: wantsResolve });
    }
  }
  return { actions, missing };
}

/** Makes each write once, in order. Never rejects. */
export async function followUp(
  deps: { writer: ForgeWriter; sleep: (ms: number) => Promise<void>; log: (entry: Record<string, unknown>) => void },
  args: { installation: string; actions: FollowUp[] },
): Promise<{ replied: number; edited: number; resolved: number; failed: number }> {
  const out = { replied: 0, edited: 0, resolved: 0, failed: 0 };
  let first = true;
  const log = (entry: Record<string, unknown>): void => {
    try {
      deps.log(entry);
    } catch {
      // a logger that throws changes nothing
    }
  };
  // One writer call, after the pause when it is not the first. True when it landed.
  const write = async (action: string, thread: string, call: () => Promise<void>): Promise<boolean> => {
    if (!first) {
      try {
        await deps.sleep(FOLLOW_UP_PAUSE_MS);
      } catch {
        // a sleep that rejects only shortens the wait
      }
    }
    first = false;
    try {
      await call();
      return true;
    } catch (error) {
      out.failed += 1;
      log({ event: 'thread_write_failed', action, thread, reason: codeOf(error) });
      return false;
    }
  };
  for (const action of args.actions) {
    let landed: boolean;
    if (action.kind === 'reply') {
      landed = await write('reply', action.thread, () => deps.writer.replyToThread(args.installation, action.thread, action.body));
      if (landed) out.replied += 1;
    } else if (action.kind === 'edit') {
      landed = await write('edit', action.thread, () => deps.writer.editThreadComment(args.installation, action.comment, action.body));
      if (landed) out.edited += 1;
    } else {
      if (await write('resolve', action.thread, () => deps.writer.resolveThread(args.installation, action.thread))) out.resolved += 1;
      continue;
    }
    if (landed && action.resolve && (await write('resolve', action.thread, () => deps.writer.resolveThread(args.installation, action.thread)))) out.resolved += 1;
  }
  return out;
}
