import { hunksOf } from '../../engine/context/build.ts';
import { blocksOf, fileDiffHash } from '../../engine/score/blocks.ts';
import type { FileScore } from '../../engine/score/types.ts';
import type { HistoryActivity, HistoryCase } from '../history/file.ts';

export interface Label { loose: boolean; strict: boolean }
export interface Labels {
  blocks: Map<string, Label>; // key: path, a line feed, the block id
  files: Map<string, Label>;  // key: path
  // in_bot_thread: comments by a person left out because a bot started their thread.
  comments: { counted: number; off_head: number; outside_diff: number; in_bot_thread: number };
  final_missing: number; // labelled (loose) blocks and files whose path has no final patch
}

interface FinalFile { diffHash: string | null; hunkHashes: Set<string> }

export const blockKey = (path: string, id: string): string => `${path}\n${id}`;

// Follows reply_to to the first comment of the thread. A parent missing from the case ends the chain;
// a chain that loops is treated as having no bot at its start.
function startedByBot(comment: HistoryActivity, byId: Map<string, HistoryActivity>): boolean {
  const seen = new Set<string>([comment.id]);
  let current = comment;
  while (current.reply_to !== undefined && current.reply_to !== null) {
    const parent = byId.get(current.reply_to);
    if (parent === undefined) return current.bot;
    if (seen.has(parent.id)) return false;
    seen.add(parent.id);
    current = parent;
  }
  return current.bot;
}

function finalFiles(c: HistoryCase): Map<string, FinalFile> {
  const out = new Map<string, FinalFile>();
  for (const f of c.final_files) {
    if (f.patch === null) continue;
    // Built the way the engine builds the replayed hunks, so that equal patches hash equal.
    const { hunks } = hunksOf(f.patch);
    out.set(f.path, { diffHash: fileDiffHash(hunks), hunkHashes: new Set(blocksOf(hunks).map((b) => b.hash)) });
  }
  return out;
}

export function labelCase(c: HistoryCase, scores: FileScore[]): Labels {
  const blocks = new Map<string, Label>();
  const files = new Map<string, Label>();
  const comments = { counted: 0, off_head: 0, outside_diff: 0, in_bot_thread: 0 };
  const loose = new Set<string>();
  const looseFiles = new Set<string>();
  const byPath = new Map(scores.map((s) => [s.path, s]));
  // Reviews, inline comments and general comments are numbered apart: a reply points at an inline comment.
  const byId = new Map(c.activity.filter((a) => a.kind === 'inline').map((a) => [a.id, a]));

  for (const a of c.activity) {
    if (a.kind !== 'inline' || a.bot || a.author === c.author) continue;
    if (startedByBot(a, byId)) { comments.in_bot_thread += 1; continue; }
    const score = a.path === undefined ? undefined : byPath.get(a.path);
    if (score === undefined) { comments.outside_diff += 1; continue; }
    if (a.commit !== c.review_head) { comments.off_head += 1; looseFiles.add(score.path); continue; }
    if (a.file_level === true || a.line === undefined || a.line === null) { looseFiles.add(score.path); continue; }
    const side = a.side ?? 'RIGHT';
    const first = a.start_line ?? a.line;
    const touched = score.blocks.filter((b) => b.lines[side].some(([start, end]) => first <= end && a.line! >= start));
    if (touched.length === 0) { looseFiles.add(score.path); continue; }
    comments.counted += 1;
    looseFiles.add(score.path);
    for (const b of touched) loose.add(blockKey(score.path, b.id));
  }

  const final = finalFiles(c);
  let finalMissing = 0;
  for (const s of scores) {
    const f = final.get(s.path);
    for (const b of s.blocks) {
      const key = blockKey(s.path, b.id);
      const isLoose = loose.has(key);
      if (isLoose && f === undefined) finalMissing += 1;
      blocks.set(key, { loose: isLoose, strict: isLoose && (f === undefined || !f.hunkHashes.has(b.hunkHash)) });
    }
    const isLoose = looseFiles.has(s.path);
    if (isLoose && f === undefined) finalMissing += 1;
    files.set(s.path, { loose: isLoose, strict: isLoose && (f === undefined || f.diffHash !== s.diffHash) });
  }
  return { blocks, files, comments, final_missing: finalMissing };
}
