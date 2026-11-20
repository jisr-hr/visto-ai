import type { FileContext } from '../context/build.ts';
import { stripControl } from '../context/untrusted.ts';
import type { ShownThread } from '../context/threads.ts';
import type { SubmitReviewArgs } from '../model/submit-review.ts';
import { fileDiffHash } from '../score/blocks.ts';
import type { AuditEntry, ChangedFile, EarlierThread, Severity, Side, ThreadVerdict } from '../types.ts';

const MAX_REPLY_CHARS = 600;
const MAX_SUBJECT_CHARS = 40;
const NEAR_LINES = 3;
const VERDICTS: ReadonlySet<string> = new Set(['fixed', 'answered', 'open']);

// Cut to at most `limit` characters, never splitting a surrogate pair.
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Judges each verdict of each answer, in order: the first rule that applies drops it; one that passes them all is kept. */
export function reconcileVerdicts(
  answers: { value: SubmitReviewArgs; files: string[]; threads?: string[] }[], shown: ShownThread[], contexts: FileContext[], headSha: string,
): { verdicts: ThreadVerdict[]; audit: AuditEntry[] } {
  const verdicts: ThreadVerdict[] = [];
  const audit: AuditEntry[] = [];
  const judged = new Set<string>();
  for (const answer of answers) {
    const seen: ReadonlySet<string> = new Set(answer.threads ?? []);
    for (const raw of answer.value.thread_verdicts ?? []) {
      const drop = (reason: string): void => {
        audit.push({ stage: 'reconcile', action: 'verdict_dropped', subject: cut(raw.thread_id, MAX_SUBJECT_CHARS), reason });
      };
      const s = shown.find((t) => t.key === raw.thread_id.trim());
      if (s === undefined) {
        drop('unknown_thread');
        continue;
      }
      // Characters nobody can see are taken out first, so a reason made only of them is empty.
      const reply = cut(oneLine(stripControl(raw.reply ?? '').text), MAX_REPLY_CHARS);
      let reason: string | null = null;
      if (!seen.has(s.key)) reason = 'not_shown';
      else if (!s.due) reason = 'not_due';
      else if (!VERDICTS.has(raw.verdict)) reason = 'bad_verdict';
      else if (judged.has(s.key)) reason = 'repeated';
      else if (raw.verdict !== 'open' && reply === '') reason = 'no_reason';
      else if (raw.verdict === 'answered' && !s.thread.replies.some((r) => r.kind === 'person' || r.kind === 'bot')) reason = 'no_reply';
      else if (raw.verdict === 'fixed' && headSha === s.thread.openedAt.head) reason = 'same_head';
      if (reason !== null) {
        drop(reason);
        continue;
      }
      judged.add(s.key);
      const verdict = raw.verdict as ThreadVerdict['verdict'];
      const before = s.thread.openedAt.diffHash;
      const ctx = contexts.find((c) => c.file.path === s.file);
      const fileChanged = verdict === 'fixed' && before !== null && ctx !== undefined && fileDiffHash(ctx.hunks) !== before;
      verdicts.push({ threadId: s.thread.id, commentId: s.thread.commentId, verdict, reply, fileChanged, replies: s.thread.replies.length });
    }
  }
  return { verdicts, audit };
}

const blocking = (severity: Severity): boolean => severity !== 'minor';

/** Drops each finding that an earlier thread on its file already raised: within 3 lines of a thread of its class on the same side, or quoting the code of a thread whose line is gone. The first thread that matches, in the order given, decides. */
export function dropDuplicates<F extends { path: string; side: Side; line: number; severity: Severity; quote: string }>(
  findings: F[], threads: EarlierThread[], verdicts: ThreadVerdict[], files: ChangedFile[],
): { kept: F[]; dropped: Array<{ finding: F; thread: EarlierThread }>; audit: AuditEntry[] } {
  const kept: F[] = [];
  const dropped: Array<{ finding: F; thread: EarlierThread }> = [];
  const audit: AuditEntry[] = [];
  const latest = (t: EarlierThread): ThreadVerdict['verdict'] | null => verdicts.find((v) => v.threadId === t.id)?.verdict ?? t.lastVerdict;
  for (const finding of findings) {
    const previous = files.find((f) => f.path === finding.path)?.previousPath ?? null;
    const quote = oneLine(finding.quote);
    let match: { thread: EarlierThread; reason: string } | null = null;
    for (const thread of threads) {
      if (thread.path !== finding.path && (previous === null || thread.path !== previous)) continue;
      if (latest(thread) === 'fixed') continue;
      if (thread.severity === 'minor' && blocking(finding.severity)) continue;
      // The quote decides only for a thread whose line is no longer in the diff: a short line such as a closing brace recurs far away.
      if (thread.line === null && quote !== '' && quote === oneLine(thread.quote)) {
        match = { thread, reason: 'same_quote' };
      } else if (thread.line !== null && thread.side === finding.side && Math.abs(thread.line - finding.line) <= NEAR_LINES
        && blocking(thread.severity) === blocking(finding.severity)) {
        match = { thread, reason: 'near_thread' };
      }
      if (match !== null) break;
    }
    if (match === null) {
      kept.push(finding);
      continue;
    }
    dropped.push({ finding, thread: match.thread });
    audit.push({ stage: 'reconcile', action: 'duplicate', subject: `${finding.path}:${finding.line}`, reason: match.reason });
  }
  return { kept, dropped, audit };
}
