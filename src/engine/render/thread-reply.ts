import { asRead, inertInline } from './body.ts';
import type { ThreadVerdict } from '../types.ts';

const MARKER = /^<!-- visto-ai: review=([0-9]{1,20}) head=([A-Za-z0-9]{1,64}) -->$/;
const SHORT_HEAD = 12;

/** The hidden line that names the review that judged a thread and the commit it read. Throws Error('bad_marker') unless reviewId is 1 to 20 digits and head is 1 to 64 letters and digits. */
export function markerOf(reviewId: string, head: string): string {
  if (!/^[0-9]{1,20}$/.test(reviewId) || !/^[A-Za-z0-9]{1,64}$/.test(head)) throw new Error('bad_marker');
  return `<!-- visto-ai: review=${reviewId} head=${head} -->`;
}

// The last line of the body that is not empty, trimmed; '' when there is none.
function lastLine(body: string): string {
  const lines = body.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l !== '');
  return lines[lines.length - 1] ?? '';
}

/** Its last line is a marker of that form, for any review and head. */
export function hasMarker(body: string): boolean {
  return MARKER.test(lastLine(body));
}

/** Its last line is exactly that marker. */
export function hasMarkerOf(body: string, reviewId: string, head: string): boolean {
  let marker: string;
  try {
    marker = markerOf(reviewId, head);
  } catch {
    return false;
  }
  return lastLine(body) === marker;
}

// The model's reason as one inert line; '' when it gave none.
const reasonOf = (verdict: ThreadVerdict): string => inertInline(verdict.reply.replace(/\s+/g, ' ').trim());

/** The reply of a verdict that clears: 'fixed' or 'answered'. */
export function clearingReply(verdict: ThreadVerdict, reviewId: string, head: string): string {
  const marker = markerOf(reviewId, head);
  const reason = reasonOf(verdict);
  const lead = verdict.verdict === 'fixed' ? '**Fixed.**' : '**Answered.**';
  return asRead(`${lead}${reason === '' ? '' : ` ${reason}`}\n\n${marker}`);
}

/** The reply of an 'open' verdict to someone who wrote last; null when the model gave no reason. */
export function openReply(verdict: ThreadVerdict): string | null {
  const reason = reasonOf(verdict);
  return reason === '' ? null : asRead(`**Still open.** ${reason}`);
}

/** What the app's own confirmation is rewritten to when the thread is judged open again. */
export function openAgainReply(verdict: ThreadVerdict, head: string): string {
  const reason = reasonOf(verdict);
  const short = head.slice(0, SHORT_HEAD).replace(/[^A-Za-z0-9]/g, '');
  return asRead(`**Open again.** The review of \`${short}\` finds this open.${reason === '' ? '' : ` ${reason}`}`);
}
