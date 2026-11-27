// Labels for the live score quality: what people said on a pull request, laid on the runs that scored it.
// Pure: no database, no clock.
import type { Ranges } from '../../engine/context/diff.ts';
import type { FileScore } from '../../engine/score/types.ts';
import { blockKey } from '../backtest/labels.ts';
import type { Label, Labels } from '../backtest/labels.ts';
import type { CaseScores, ScoredBlock, ScoredFile } from '../backtest/metrics.ts';

export { blockKey };

export interface LiveBlock extends ScoredBlock { hunkHash: string; lines: Ranges }
export interface LiveFile extends ScoredFile { diffHash: string | null; blocks: readonly LiveBlock[] }
type IsLiveFile<F extends LiveFile> = F;
/** The engine's score of a file is a LiveFile, checked by the type check: a measured field the engine renames fails it here. */
export type EngineLiveFile = IsLiveFile<FileScore>;
export interface LiveRun { id: number; head: string; scores: readonly LiveFile[] }
export interface LiveComment {
  id: string; author: string; path: string | null; side: 'LEFT' | 'RIGHT' | null; line: number | null; startLine: number | null;
  fileLevel: boolean; commit: string | null; replyTo: string | null;
}
export interface LivePull {
  number: number; author: string | null; threshold: number;
  last: LiveRun | null;                          // its last run; null when it has none or it could not be read
  atHead: ReadonlyMap<string, LiveRun>;          // at each head a comment was made on, the newest run that did not fail, started at or before the close
  comments: readonly LiveComment[];
  findingThreads: ReadonlySet<string>;           // the ids of the app's first comments of findings on this pull request
}
export interface LiveCases {
  pulls: CaseScores<LiveFile>[];      // one per pull request with a last run: its last run's scores, no label (Benefit, Focus)
  labelled: CaseScores<LiveFile>[];   // one per run that holds a label: its scores and its labels (Safety)
  strict: Set<number>;                // the pull requests with a strict block or file
}

const emptyLabels = (): Labels => ({
  blocks: new Map(), files: new Map(),
  comments: { counted: 0, off_head: 0, outside_diff: 0, in_bot_thread: 0 }, final_missing: 0,
});

/** Whether the comment's thread starts with one of the app's findings. A parent that is no stored comment, or a chain that loops, ends the walk. */
function inFindingThread(comment: LiveComment, byId: ReadonlyMap<string, LiveComment>, findingThreads: ReadonlySet<string>): boolean {
  const seen = new Set<string>([comment.id]);
  let current = comment;
  while (current.replyTo !== null) {
    if (findingThreads.has(current.replyTo)) return true;
    const parent = byId.get(current.replyTo);
    if (parent === undefined || seen.has(parent.id)) return false;
    seen.add(parent.id);
    current = parent;
  }
  return false;
}

/**
 * The comments `liveCases` counts on a pull request, in their order: on a path, by an account other than its author (letter case
 * aside), and not in a thread one of the app's findings starts. The one rule, for liveCases and for whoever chooses what it reads.
 */
export function countedComments(pull: Pick<LivePull, 'author' | 'comments' | 'findingThreads'>): Array<LiveComment & { path: string }> {
  const byId = new Map(pull.comments.map((c) => [c.id, c]));
  const author = pull.author === null ? null : pull.author.toLowerCase();
  return pull.comments.filter((c): c is LiveComment & { path: string } =>
    c.path !== null && c.author.toLowerCase() !== author && !inFindingThread(c, byId, pull.findingThreads));
}

interface Loose { run: LiveRun; blocks: Set<string>; files: Set<string> }

export function liveCases(pulls: readonly LivePull[]): LiveCases {
  const out: LiveCases = { pulls: [], labelled: [], strict: new Set() };
  for (const p of pulls) {
    const last = p.last;
    if (last === null) continue;
    out.pulls.push({ key: String(p.number), threshold: p.threshold, status: 'ok', scores: last.scores, labels: emptyLabels() });

    const loose = new Map<number, Loose>();
    const looseOf = (run: LiveRun): Loose => {
      let l = loose.get(run.id);
      if (l === undefined) { l = { run, blocks: new Set(), files: new Set() }; loose.set(run.id, l); }
      return l;
    };

    for (const c of countedComments(p)) {
      const scored = c.commit === null ? undefined : p.atHead.get(c.commit);
      const run = scored ?? last;
      const file = run.scores.find((f) => f.path === c.path);
      if (file === undefined) continue;
      const l = looseOf(run);
      l.files.add(file.path);
      if (scored === undefined || c.fileLevel || c.line === null) continue;
      const side = c.side ?? 'RIGHT';
      const first = c.startLine ?? c.line;
      for (const b of file.blocks) {
        if (b.lines[side].some(([start, end]) => first <= end && c.line! >= start)) l.blocks.add(blockKey(file.path, b.id));
      }
    }

    for (const l of loose.values()) {
      const labels = emptyLabels();
      const later = l.run.id !== last.id;
      for (const f of l.run.scores) {
        const now = last.scores.find((x) => x.path === f.path);
        const nowHashes = new Set(now?.blocks.map((b) => b.hunkHash));
        for (const b of f.blocks) {
          const isLoose = l.blocks.has(blockKey(f.path, b.id));
          const label: Label = { loose: isLoose, strict: isLoose && later && !nowHashes.has(b.hunkHash) };
          labels.blocks.set(blockKey(f.path, b.id), label);
        }
        const isLoose = l.files.has(f.path);
        labels.files.set(f.path, { loose: isLoose, strict: isLoose && later && (now === undefined || now.diffHash !== f.diffHash) });
      }
      out.labelled.push({ key: `${p.number}:${l.run.id}`, threshold: p.threshold, status: 'ok', scores: l.run.scores, labels });
      if ([...labels.blocks.values(), ...labels.files.values()].some((x) => x.strict)) out.strict.add(p.number);
    }
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isScore = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function rangesOf(v: unknown): [number, number][] | null {
  if (!Array.isArray(v)) return null;
  const out: [number, number][] = [];
  for (const r of v) {
    if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1])) return null;
    out.push([r[0] as number, r[1] as number]);
  }
  return out;
}

function blockOf(v: unknown): LiveBlock | null {
  if (!isObject(v) || typeof v.id !== 'string' || typeof v.hunkHash !== 'string' || !isCount(v.changedLines)) return null;
  let entry: { score: number } | null = null;
  if (v.entry !== null && v.entry !== undefined) {
    if (!isObject(v.entry) || !isScore(v.entry.score)) return null;
    entry = { score: v.entry.score };
  }
  if (!isObject(v.lines)) return null;
  const right = rangesOf(v.lines.RIGHT);
  const left = rangesOf(v.lines.LEFT);
  if (right === null || left === null) return null;
  return { id: v.id, hunkHash: v.hunkHash, changedLines: v.changedLines, entry, lines: { RIGHT: right, LEFT: left } };
}

function fileOf(v: unknown): LiveFile | null {
  if (!isObject(v) || typeof v.path !== 'string' || !isCount(v.changedLines) || !isScore(v.finalScore)) return null;
  if (v.diffHash !== null && typeof v.diffHash !== 'string') return null;
  let fileLevel: { score: number } | null = null;
  if (v.fileLevel !== null) {
    if (!isObject(v.fileLevel) || !isScore(v.fileLevel.score)) return null;
    fileLevel = { score: v.fileLevel.score };
  }
  if (!Array.isArray(v.blocks)) return null;
  const blocks: LiveBlock[] = [];
  for (const b of v.blocks) {
    const block = blockOf(b);
    if (block === null) return null;
    blocks.push(block);
  }
  return { path: v.path, diffHash: v.diffHash, changedLines: v.changedLines, finalScore: v.finalScore, fileLevel, blocks };
}

/** A run's stored `result.scores` reduced to the fields measured; null when any file is of another shape. Never throws. */
export function storedScores(value: unknown): LiveFile[] | null {
  if (!Array.isArray(value)) return null;
  const out: LiveFile[] = [];
  for (const f of value) {
    const file = fileOf(f);
    if (file === null) return null;
    out.push(file);
  }
  return out;
}
