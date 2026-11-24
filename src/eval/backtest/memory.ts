// Memory as a deployment would have had it at each case's date, built from a history file alone (7.4, 7.5, call 27).
// The signals come from the rule the service runs, and the choice of the two blocks from the code the service runs:
// they cannot disagree. A history file holds no score of the bot, so every signal is for a file, with no category
// and no miss. The reverts come from the rule of a revert the service runs, over the file's descriptions and files
// (call 20). No database, no network, no clock.
import type { FileScore } from '../../engine/score/types.ts';
import type { Memory } from '../../engine/types.ts';
import { revertedNumber, revertsOf } from '../../memory/reverts.ts';
import type { Revert } from '../../memory/reverts.ts';
import { createMemory, RECORDS_READ, REVERTS_READ } from '../../memory/select.ts';
import type { LiveRecord } from '../../memory/select.ts';
import { signalsOf } from '../../memory/signals.ts';
import type { PersonComment, Signal } from '../../memory/signals.ts';
import { historyKey } from '../history/file.ts';
import type { HistoryActivity, HistoryCase } from '../history/file.ts';
import { labelCase } from './labels.ts';

export interface HistoryMemory {
  /** Memory as a deployment would have had it at the case's date: from the file's other pull requests alone (7.4, 7.5). */
  of(c: HistoryCase): Memory;
  /** How many signals of other pull requests of the case's repository are live at its date. */
  records(c: HistoryCase): number;
  /** named: the pull requests of the memory file whose description names a revert of their own repository; held: of those, the ones whose records were made. */
  reverts(): { named: number; held: number };
}
export interface MemoryCountRow {
  key: string; records: number; lines: number; changed: number; near: number;
  labelled_files: number;        // files of the case a person who is not the author commented on, as labelCase labels a file
  labelled_with_line: number;    // of those, the files that got a line of their own (near false)
}
export interface MemoryCount {
  cases: number; with_lines: number; with_labelled_line: number; rows: MemoryCountRow[];
  // cases: the cases that would be shown at least one reverted line; rows: those cases, in the file's order, each with its number of reverted lines
  reverts: { named: number; held: number; cases: number; rows: Array<{ key: string; lines: number }> };
}

interface Held { signal: Signal; created: number; expires: number }
interface HeldRevert { revert: Revert; created: number; expires: number }

const repoOf = (name: string): string => name.toLowerCase();

function personComment(a: HistoryActivity): PersonComment {
  return {
    id: a.id, author: a.author, bot: a.bot, association: a.association, at: a.at, body: a.body,
    path: a.path ?? null, side: a.side ?? null, line: a.line ?? null, startLine: a.start_line ?? null,
    fileLevel: a.file_level ?? false, commit: a.commit ?? null, replyTo: a.reply_to ?? null,
  };
}

/** A case's inline comments, in the file's order, as the signal rule takes them: a missing field is null, a missing `file_level` false. */
export function personComments(c: HistoryCase): PersonComment[] {
  return c.activity.filter((a) => a.kind === 'inline').map(personComment);
}

const recordOf = (s: Signal): LiveRecord => ({
  ref: s.sourceRef, number: s.number, path: s.path, directory: s.directory, category: s.category, missed: s.missed, createdAt: s.createdAt,
});

const revertRecordOf = (r: Revert): LiveRecord => ({
  ref: r.sourceRef, number: r.number, path: r.path, directory: r.directory, category: null, missed: false, createdAt: r.createdAt, reverted: r.reverted,
});

// Live at a time: made at or before it, expiring after it.
const liveAt = (held: { created: number; expires: number }, at: number): boolean => held.created <= at && held.expires > at;

// The owner and the name of a case's repository, split at its first slash; null when it has none.
function ownerAndName(repo: string): { owner: string; repo: string } | null {
  const slash = repo.indexOf('/');
  return slash < 0 ? null : { owner: repo.slice(0, slash), repo: repo.slice(slash + 1) };
}

// The records of the reverts the file's descriptions name, by repository and source reference, the first kept; and the two counts.
function revertsOfFile(cases: HistoryCase[]): { byRepo: Map<string, Map<string, HeldRevert>>; named: number; held: number } {
  const byRepo = new Map<string, Map<string, HeldRevert>>();
  // A pull request held twice in the file is counted and used once: its first case.
  const first = new Map<string, HistoryCase>();
  for (const c of cases) {
    const key = `${repoOf(c.repo)}#${c.pr_number}`;
    if (!first.has(key)) first.set(key, c);
  }
  let named = 0;
  let held = 0;
  for (const c of first.values()) {
    const repo = ownerAndName(c.repo);
    // The body is read as the file holds it (calls 2 and 20).
    const reverted = repo === null ? null : revertedNumber(c.body, repo);
    if (reverted === null) continue;
    named += 1;
    const target = first.get(`${repoOf(c.repo)}#${reverted}`);
    if (target === undefined) continue;
    const result = revertsOf({
      number: c.pr_number, mergedAt: c.merged_at, reverted, revertedStored: true, revertedMergedAt: target.merged_at,
      files: target.final_files.map((f) => ({ path: f.path, previousPath: f.previous_path })),
    });
    if (result.code !== 'recorded') continue;
    held += 1;
    const records = byRepo.get(repoOf(c.repo)) ?? new Map<string, HeldRevert>();
    byRepo.set(repoOf(c.repo), records);
    for (const revert of result.records) {
      if (records.has(revert.sourceRef)) continue;
      records.set(revert.sourceRef, { revert, created: Date.parse(revert.createdAt), expires: Date.parse(revert.expiresAt) });
    }
  }
  return { byRepo, named, held };
}

export function historyMemory(cases: HistoryCase[]): HistoryMemory {
  // Derived once, by repository. A pull request held twice gives each record once, as the database's unique source reference would.
  const byRepo = new Map<string, Map<string, Held>>();
  for (const c of cases) {
    const signals = signalsOf({
      number: c.pr_number, author: c.author, closedAt: c.merged_at,
      comments: personComments(c),
    });
    const repo = repoOf(c.repo);
    const held = byRepo.get(repo) ?? new Map<string, Held>();
    byRepo.set(repo, held);
    for (const signal of signals) {
      if (held.has(signal.sourceRef)) continue;
      held.set(signal.sourceRef, { signal, created: Date.parse(signal.createdAt), expires: Date.parse(signal.expiresAt) });
    }
  }
  const heldFor = (c: HistoryCase): Held[] => [...(byRepo.get(repoOf(c.repo))?.values() ?? [])];
  const reverts = revertsOfFile(cases);
  const revertsFor = (c: HistoryCase): HeldRevert[] => [...(reverts.byRepo.get(repoOf(c.repo))?.values() ?? [])];

  return {
    of(c) {
      const held = heldFor(c);
      return createMemory({
        live(at) {
          const t = at.getTime();
          // The newest RECORDS_READ + 1 at most, as the database is asked.
          const live = held.filter((h) => liveAt(h, t)).sort((x, y) => y.created - x.created);
          return Promise.resolve(live.slice(0, RECORDS_READ + 1).map((h) => recordOf(h.signal)));
        },
        // The shared code drops the case's own: as the pull request that made the revert, and as the one reverted.
        reverts(at) {
          const t = at.getTime();
          const live = revertsFor(c).filter((h) => liveAt(h, t)).sort((x, y) => y.created - x.created);
          return Promise.resolve(live.slice(0, REVERTS_READ + 1).map((h) => revertRecordOf(h.revert)));
        },
      }, c.pr_number);
    },
    records(c) {
      const t = new Date(c.review_at).getTime();
      return heldFor(c).filter((h) => h.signal.number !== c.pr_number && liveAt(h, t)).length;
    },
    reverts() {
      return { named: reverts.named, held: reverts.held };
    },
  };
}

// One score for each final file, with no block: what labelCase needs to label a file.
function unscored(c: HistoryCase): FileScore[] {
  return c.final_files.map((f) => ({
    path: f.path, previousPath: f.previous_path, diffHash: null, changeSummary: '', changedLines: 0, blocks: [],
    wholeFile: null, fileLevel: null, finalScore: 0, covered: true,
  }));
}

/** For each case, with no model and no network: what memory would show for the files of its last head. */
export async function memoryCount(cases: HistoryCase[], memory: HistoryMemory): Promise<MemoryCount> {
  const rows: MemoryCountRow[] = [];
  const reverted: Array<{ key: string; lines: number }> = [];
  for (const c of cases) {
    const files = c.final_files.map((f) => ({ path: f.path, previousPath: f.previous_path }));
    const blocks = await memory.of(c).blocks(files, new Date(c.review_at), new AbortController().signal);
    const lines = blocks.pullRequest;
    const own = new Set(lines.filter((l) => !l.near).map((l) => l.path));
    const labels = labelCase(c, unscored(c));
    const labelled = c.final_files.filter((f) => labels.files.get(f.path)?.loose === true);
    rows.push({
      key: historyKey(c), records: memory.records(c), lines: lines.length,
      changed: lines.filter((l) => !l.near).length, near: lines.filter((l) => l.near).length,
      labelled_files: labelled.length,
      labelled_with_line: labelled.filter((f) => own.has(f.path) || (f.previous_path !== null && own.has(f.previous_path))).length,
    });
    const revertedLines = lines.filter((l) => l.reverted === true).length;
    if (revertedLines > 0) reverted.push({ key: historyKey(c), lines: revertedLines });
  }
  const file = memory.reverts();
  return {
    cases: rows.length,
    with_lines: rows.filter((r) => r.lines > 0).length,
    with_labelled_line: rows.filter((r) => r.labelled_with_line > 0).length,
    rows,
    reverts: { named: file.named, held: file.held, cases: reverted.length, rows: reverted },
  };
}
