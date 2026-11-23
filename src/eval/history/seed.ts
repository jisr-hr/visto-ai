// The importer's database output (7.5, D19, call 29): a history file's activity of people, and the signals of its pull
// requests, written into a deployment's database so that a new deployment does not start empty. It reads the file, never
// the git service. Every insert leaves an existing row as it is; nothing is deleted; no row of pull_requests is written;
// the only update is the marker of a comment looked at, on a pull request the service does not store.
import { recordActivity } from '../../db/human-activity.ts';
import type { Activity } from '../../db/human-activity.ts';
import { markLearned } from '../../db/learning.ts';
import { addRecords } from '../../db/memory-records.ts';
import type { NewRecord } from '../../db/memory-records.ts';
import { isApplied } from '../../db/migrate.ts';
import { getPullRequest } from '../../db/pull-requests.ts';
import type { Db } from '../../db/types.ts';
import type { PullRequestRef } from '../../forge/types.ts';
import { readTime } from '../../memory/select.ts';
import { signalsOf } from '../../memory/signals.ts';
import type { Signal } from '../../memory/signals.ts';
import { personComments } from '../backtest/memory.ts';
import type { HistoryActivity, HistoryCase } from './file.ts';

export interface Seeded { cases: number; known: number; activity: number; signals: number }

const REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const MAX_NUMBER = 2_147_483_647;                        // the largest number the database's integer column takes
const MIN_NUMBER = -2_147_483_648;                       // the smallest

// A line the integer column takes: null, or a number within its range.
const storableLine = (value: unknown): boolean =>
  typeof value !== 'number' || (value >= MIN_NUMBER && value <= MAX_NUMBER);

// An activity of a person as capture stores it (rule 4). It came from no delivery and no thread event.
function activityOf(ref: PullRequestRef, a: HistoryActivity): Activity {
  const base = {
    ref, sourceId: a.id, author: a.author, association: a.association, body: a.body, at: a.at,
    state: null, path: null, side: null, line: null, startLine: null, fileLevel: null, commit: null, replyTo: null,
    thread: null, delivery: null,
  };
  if (a.kind === 'review') return { ...base, kind: 'review', state: a.state ?? null, commit: a.commit ?? null };
  if (a.kind === 'inline') {
    return {
      ...base, kind: 'inline_comment', path: a.path ?? null, side: a.side ?? null, line: a.line ?? null, startLine: a.start_line ?? null,
      fileLevel: a.file_level ?? false, commit: a.commit ?? null, replyTo: a.reply_to ?? null,
    };
  }
  return { ...base, kind: 'general_comment' };
}

const recordOf = (s: Signal): NewRecord => ({
  kind: 'human_signal', sourceRef: s.sourceRef, number: s.number, path: s.path, directory: s.directory,
  category: s.category, reason: s.reason, missed: s.missed, excerpt: s.excerpt, comment: s.comment,
  createdAt: s.createdAt, expiresAt: s.expiresAt,
});

/** One case, in one transaction (rule 3). */
async function seedCase(tx: Db, c: HistoryCase, ref: PullRequestRef, now: string): Promise<{ known: boolean; activity: number; signals: number }> {
  let activity = 0;
  for (const a of c.activity) {
    if (a.bot !== false) continue;
    if (await recordActivity(tx, activityOf(ref, a))) activity += 1;
  }
  // A pull request the service stores: the pass makes its signals, from its comments not yet looked at (rule 6).
  if (await getPullRequest(tx, ref) !== null) return { known: true, activity, signals: 0 };
  const comments = c.activity.filter((a) => a.kind === 'inline' && a.bot === false).map((a) => a.id);
  // No close: no row of pull_requests is there to mark, and none is written (rule 5).
  await markLearned(tx, ref, comments, now, null);
  const signals = signalsOf({ number: c.pr_number, author: c.author, closedAt: c.merged_at, comments: personComments(c) });
  const added = await addRecords(tx, { service: ref.service, owner: ref.owner, repo: ref.repo }, signals.map(recordOf));
  return { known: false, activity, signals: added };
}

/** Writes each case's activity of people and, for a pull request the service does not store, its signals. Every insert leaves an existing row as it is. */
export async function seedMemory(db: Db, cases: HistoryCase[], now: Date): Promise<Seeded> {
  const at = now.toISOString();
  const out: Seeded = { cases: 0, known: 0, activity: 0, signals: 0 };
  for (const c of cases) {
    const repo = typeof c.repo === 'string' ? REPO.exec(c.repo) : null;
    if (repo === null) throw new Error('bad_case_repo');
    // Refused before its transaction opens: such a case would stop every run with an error of the driver, and say nothing of why.
    if (!Number.isInteger(c.pr_number) || c.pr_number < 1 || c.pr_number > MAX_NUMBER) throw new Error('bad_case_number');
    if (!c.activity.every((a) => storableLine(a.line) && storableLine(a.start_line))) throw new Error('bad_case_number');
    if (readTime(c.merged_at) === null || !c.activity.every((a) => readTime(a.at) !== null)) throw new Error('bad_case_time');
    const ref: PullRequestRef = { service: 'github', owner: repo[1]!, repo: repo[2]!, number: c.pr_number };
    const done = await db.transaction((tx) => seedCase(tx, c, ref, at));
    out.cases += 1;
    if (done.known) out.known += 1;
    out.activity += done.activity;
    out.signals += done.signals;
  }
  return out;
}

/** The command's steps once connected: refuses a database 0011_lessons is not applied to before any write (records are written through a statement that writes the column it adds), never migrates, seeds, and returns the one line to print. */
export async function seedCommand(db: Db, cases: HistoryCase[], now: Date): Promise<string> {
  if (!(await isApplied(db, '0011_lessons'))) throw new Error('database_not_migrated');
  const s = await seedMemory(db, cases, now);
  return `cases ${s.cases}, known ${s.known}, activity ${s.activity}, signals ${s.signals}`;
}
