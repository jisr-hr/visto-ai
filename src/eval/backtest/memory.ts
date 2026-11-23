// Memory as a deployment would have had it at each case's date, built from a history file alone (7.4, 7.5, call 27).
// The signals come from the rule the service runs, and the choice of the two blocks from the code the service runs:
// they cannot disagree. A history file holds no score of the bot, so every signal is for a file, with no category
// and no miss. No database, no network, no clock.
import type { FileScore } from '../../engine/score/types.ts';
import type { Memory } from '../../engine/types.ts';
import { createMemory, RECORDS_READ } from '../../memory/select.ts';
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
}
export interface MemoryCountRow {
  key: string; records: number; lines: number; changed: number; near: number;
  labelled_files: number;        // files of the case a person who is not the author commented on, as labelCase labels a file
  labelled_with_line: number;    // of those, the files that got a line of their own (near false)
}
export interface MemoryCount { cases: number; with_lines: number; with_labelled_line: number; rows: MemoryCountRow[] }

interface Held { signal: Signal; created: number; expires: number }

const repoOf = (name: string): string => name.toLowerCase();

function personComment(a: HistoryActivity): PersonComment {
  return {
    id: a.id, author: a.author, bot: a.bot, association: a.association, at: a.at, body: a.body,
    path: a.path ?? null, side: a.side ?? null, line: a.line ?? null, startLine: a.start_line ?? null,
    fileLevel: a.file_level ?? false, commit: a.commit ?? null, replyTo: a.reply_to ?? null,
  };
}

const recordOf = (s: Signal): LiveRecord => ({
  ref: s.sourceRef, number: s.number, path: s.path, directory: s.directory, category: s.category, missed: s.missed, createdAt: s.createdAt,
});

// Live at a time: made at or before it, expiring after it.
const liveAt = (held: Held, at: number): boolean => held.created <= at && held.expires > at;

export function historyMemory(cases: HistoryCase[]): HistoryMemory {
  // Derived once, by repository. A pull request held twice gives each record once, as the database's unique source reference would.
  const byRepo = new Map<string, Map<string, Held>>();
  for (const c of cases) {
    const signals = signalsOf({
      number: c.pr_number, author: c.author, closedAt: c.merged_at,
      comments: c.activity.filter((a) => a.kind === 'inline').map(personComment),
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
      }, c.pr_number);
    },
    records(c) {
      const t = new Date(c.review_at).getTime();
      return heldFor(c).filter((h) => h.signal.number !== c.pr_number && liveAt(h, t)).length;
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
  }
  return {
    cases: rows.length,
    with_lines: rows.filter((r) => r.lines > 0).length,
    with_labelled_line: rows.filter((r) => r.labelled_with_line > 0).length,
    rows,
  };
}
