import type { Activity } from '../db/human-activity.ts';
import type { ForgeEvent, PullRequestFacts } from '../forge/types.ts';

export type Capture =
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'handled'; pullRequest: PullRequestFacts | null; activity: Activity | null };

const BOT: Capture = { outcome: 'ignored', reason: 'bot_author' };

function handled(activity: Activity): Capture {
  return { outcome: 'handled', pullRequest: null, activity };
}

/** What an event stores. Pure: it reads no clock and no database. */
export function captureOf(event: ForgeEvent, delivery: string, receivedAt: Date): Capture {
  const empty = {
    state: null, body: '', path: null, side: null, line: null, startLine: null, fileLevel: null,
    commit: null, replyTo: null, thread: null,
  };
  switch (event.kind) {
    case 'ping':
      return { outcome: 'ignored', reason: 'ping' };
    case 'ignored':
      return { outcome: 'ignored', reason: event.reason };
    case 'pull_request':
      return { outcome: 'handled', pullRequest: event.facts, activity: null };
    case 'check_rerun':
    case 'review_dismissed':
      return { outcome: 'handled', pullRequest: null, activity: null };
    case 'review': {
      const r = event.review;
      if (r.authorIsBot) return BOT;
      return handled({
        ...empty, ref: event.ref, kind: 'review', sourceId: r.id, author: r.author, association: r.association,
        state: r.state, body: r.body, commit: r.commit, at: r.at, delivery,
      });
    }
    case 'inline_comment': {
      const c = event.comment;
      if (c.authorIsBot) return BOT;
      return handled({
        ...empty, ref: event.ref, kind: 'inline_comment', sourceId: c.id, author: c.author, association: c.association,
        body: c.body, path: c.path, side: c.side, line: c.line, startLine: c.startLine, fileLevel: c.fileLevel,
        commit: c.commit, replyTo: c.replyTo, at: c.at, delivery,
      });
    }
    case 'general_comment': {
      const c = event.comment;
      if (c.authorIsBot) return BOT;
      return handled({
        ...empty, ref: event.ref, kind: 'general_comment', sourceId: c.id, author: c.author, association: c.association,
        body: c.body, at: c.at, delivery,
      });
    }
    case 'thread':
      if (event.actorIsBot) return BOT;
      return handled({
        ...empty, ref: event.ref, kind: event.action === 'resolved' ? 'thread_resolved' : 'thread_unresolved',
        sourceId: delivery, author: event.actor, association: null, thread: event.thread, replyTo: event.rootComment,
        at: receivedAt.toISOString(), delivery,
      });
  }
}
