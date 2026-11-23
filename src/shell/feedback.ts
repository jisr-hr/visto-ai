import { recordFeedback } from '../db/feedback.ts';
import type { Db } from '../db/types.ts';
import type { FeedbackAnswer, FeedbackOutcome } from '../extensions/types.ts';
import { storable } from '../db/text.ts';

export const LOGIN_MAX_CHARS = 100;
export const REASON_MAX_CHARS = 1_000;

const MAX_RUN = 2_147_483_647;
const LOGIN_SHAPE = /^[^\s\p{Cc}]+$/u;

interface Checked { run: number | null; vote: 'up' | 'down' | null; login: string | null; reason: string | null; good: boolean }

/** Reads a module's answer field by field. Never throws: a field that throws when read makes the answer bad. */
function check(answer: unknown): Checked {
  const out: Checked = { run: null, vote: null, login: null, reason: null, good: false };
  try {
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return out;
    const a = answer as Record<string, unknown>;
    const run = a['run'];
    if (typeof run === 'number' && Number.isInteger(run) && run >= 1 && run <= MAX_RUN) out.run = run;
    const vote = a['vote'];
    if (vote === 'up' || vote === 'down') out.vote = vote;
    const login = a['login'];
    if (typeof login === 'string') {
      let l = login.trim();
      if (l.startsWith('@')) l = l.slice(1);
      if (l.length >= 1 && [...l].length <= LOGIN_MAX_CHARS && LOGIN_SHAPE.test(l)) out.login = storable(l).toLowerCase();
    }
    const reason = a['reason'];
    let reasonOk = true;
    if (reason === undefined || reason === null) out.reason = null;
    else if (typeof reason === 'string') {
      let r = storable(reason).trim();
      if (r.length > REASON_MAX_CHARS) {
        r = r.slice(0, REASON_MAX_CHARS);
        const last = r.charCodeAt(r.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) r = r.slice(0, -1);   // do not split a pair
      }
      out.reason = r === '' ? null : r;
    } else reasonOk = false;
    out.good = out.run !== null && out.vote !== null && out.login !== null && reasonOk;
  } catch {
    out.good = false;
  }
  return out;
}

/** The one function a module reports an answer through (11.3). What it returns never rejects. */
export function createFeedback(deps: { db: Db; clock: () => Date; log: (entry: Record<string, unknown>) => void }):
  (extension: string, answer: FeedbackAnswer) => Promise<FeedbackOutcome> {
  return async (extension, answer) => {
    const c = check(answer);
    let outcome: 'stored' | 'bad_answer' | 'unknown_run' | 'store_failed';
    if (!c.good) outcome = 'bad_answer';
    else {
      try {
        const stored = await recordFeedback(deps.db, {
          run: c.run!, login: c.login!, vote: c.vote!, reason: c.reason, extension, at: deps.clock().toISOString(),
        });
        outcome = stored ? 'stored' : 'unknown_run';
      } catch {
        outcome = 'store_failed';
      }
    }
    try { deps.log({ event: 'feedback', extension, run: c.run, vote: c.vote, outcome }); } catch { /* a logger that throws stops nothing */ }
    return outcome === 'stored' ? { ok: true } : { ok: false, code: outcome };
  };
}
