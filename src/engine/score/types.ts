import type { Side } from '../../forge/types.ts';
import type { Ranges } from '../context/diff.ts';

export const CATEGORIES = [
  'generated', 'formatting', 'documentation', 'test', 'weakened_test', 'disabled_check', 'dependency', 'rename', 'refactor',
  'fix', 'feature', 'business_rule', 'data_model', 'public_contract', 'permission', 'calculation', 'structure',
  'authentication', 'tenant_isolation', 'migration', 'billing', 'security_configuration', 'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Anchor { side: Side; line: number }
/** A block's changed lines on the new side when it adds any, else on the old side. */
export interface Span { side: Side; first: number; last: number }

export interface Block {
  id: string;         // 'B1', 'B2', ... in diff order. A part of a split block is 'B3.1'; its unscored remainder is 'B3.rest'
  hunk: string;       // the id of the diff hunk it came from: 'B3' for 'B3.1'
  hunkHash: string;   // the hash of that whole hunk; equal to `hash` for a block that is not a part
  hash: string;       // sha256, hex, of the block's changed lines, without line numbers
  anchors: Anchor[];  // every anchored line of the block, context included, in diff order
  changed: Anchor[];  // its added and removed lines, in diff order
  span: Span;
}

export interface ScoreEntry { score: number; category: Category; reason: string } // reason is '' when none was given

export interface BlockScore {
  id: string; hunk: string; hunkHash: string; hash: string;
  changedLines: number;
  span: Span;
  lines: Ranges;      // the block's lines on each side; a context line is on both, with its old and its new number
  entry: ScoreEntry | null; // null: the model gave this block no score of its own
}

export type FileLevelSource =
  | 'builtin_floor' | 'team_floor' | 'team_file_invalid' | 'hidden_characters' | 'not_scored' | 'whole_file' | 'rule_rename'
  | 'rule_asset';

export interface FileScore {
  path: string; previousPath: string | null;
  diffHash: string | null;   // null when the file has no diff
  changeSummary: string;
  changedLines: number;
  blocks: BlockScore[];
  wholeFile: ScoreEntry | null; // the model's own whole-file score, when it gave one
  fileLevel: { score: number; source: FileLevelSource } | null; // the highest score that applies to the file as a whole
  finalScore: number;        // the highest of fileLevel and the blocks' own scores
  covered: boolean;          // 5.2: every block has a score, its own or its file's
}

export interface Verdict { threshold: number; needsHuman: boolean; highest: number }
