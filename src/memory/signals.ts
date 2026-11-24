// The one rule that turns a pull request's inline comments into signals (6.6, 7.2): where a person with access,
// other than the author, stepped in, and what the review had scored there. Pure: no database, no clock, no
// input or output. The service's learning pass, the importer and the eval's backtest all run it, so a
// record is the same, byte for byte, however and whenever it is derived from the same comments.
// Nothing here is shown to a model: the excerpt is stored for the UI to come.
import { cleanLine } from '../engine/context/extensions.ts';
import { stripControl } from '../engine/context/untrusted.ts';
import { CATEGORIES } from '../engine/score/types.ts';
import type { Association, Side } from '../forge/types.ts';
import { readTime } from './select.ts';

export const SIGNAL_DAYS = 180;
export const EXCERPT_CHARS = 200;
export const REASON_CHARS = 300;

/** One inline comment, as the database or a history file holds it. */
export interface PersonComment {
  id: string; author: string; bot: boolean; association: Association | null; at: string; body: string;
  path: string | null; side: Side | null; line: number | null; startLine: number | null; fileLevel: boolean;
  commit: string | null; replyTo: string | null;
}
export interface ScoredBlock { hash: string; lines: { LEFT: Array<[number, number]>; RIGHT: Array<[number, number]> }; category: string | null; reason: string | null; missed: boolean }
/** The blocks of one run, by path. */
export type ScoredRun = ReadonlyMap<string, ScoredBlock[]>;
export interface SignalInput {
  number: number;
  author: string;                                    // the pull request's author
  closedAt: string | null;                           // null while it is open
  comments: PersonComment[];                         // every inline comment held, by anyone, in any order
  posted?: ReadonlyMap<string, 'finding' | 'note'>;  // the app's own inline comments, by id; absent: none known
  scored?: ReadonlyMap<string, ScoredRun>;           // by commit; absent: no run known
}
export interface Signal {
  sourceRef: string; number: number; path: string; directory: string; block: string | null;
  category: string | null; reason: string | null; missed: boolean; excerpt: string; comment: string;
  createdAt: string; expiresAt: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WITH_ACCESS: ReadonlySet<unknown> = new Set<Association>(['owner', 'member', 'collaborator']);
const CATEGORY_SET: ReadonlySet<unknown> = new Set<string>(CATEGORIES);
const FILE = 'file';

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// The time of a value, read the one way the memory part reads a time; null when it is none, or one whose expiry could not be written.
function timeOf(value: unknown): number | null {
  const ms = readTime(value);
  if (ms === null || !Number.isFinite(new Date(ms + SIGNAL_DAYS * DAY_MS).getTime())) return null;
  return ms;
}

/** 'src/a/b.ts' gives 'src/a'; 'b.ts' gives '.'. */
export function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '.' : path.slice(0, slash);
}

// Every way a line can end is made a line feed: a quote cannot hide behind a line end the cleaner would strip.
const LINE_ENDS = /\r\n|\r|\u2028|\u2029|\u0085/g;
// Any number of list markers ('-', '*', '+', or digits and '.' or ')', each followed by spaces) may stand before a quote or a fence.
const LIST = '(?:(?:[-*+]|\\d{1,9}[.)])[ \\t]+)*';
const FENCE = new RegExp(`^[ \\t]*${LIST}(\`{3,}|~{3,})`);
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
const QUOTE = new RegExp(`^[ \\t]*${LIST}>`);
const HTML_OPEN = /<(blockquote|details)(?=[\s>/]|$)/gi;
const HTML_CLOSE = /<\/(blockquote|details)(?=[\s>]|$)/gi;
const BLANK = /^[ \t]*$/;

// How far a line moves the depth of html quotes and details: opening tags less closing tags.
function htmlDepth(line: string): { opens: number; net: number } {
  const opens = line.match(HTML_OPEN)?.length ?? 0;
  const closes = line.match(HTML_CLOSE)?.length ?? 0;
  return { opens, net: opens - closes };
}

/**
 * What a comment says in its writer's own words, with its line feeds. Left out: fenced blocks (closed only by a
 * line of the same character, at least as long, with nothing after it; an unclosed fence takes the rest), quoted lines
 * (after any list markers, at any depth) and the lines right after them up to a blank line, and html quotes and details
 * through their closing tag (an unclosed one takes the rest).
 */
export function ownWords(body: string): string {
  if (typeof body !== 'string') return '';
  // Invisible characters are stripped before lines are read, so that one cannot hide a quote or a fence.
  const lines = stripControl(body.replace(LINE_ENDS, '\n')).text.split('\n');
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;
  let html = 0;          // depth inside html quotes and details
  let quoted = false;    // the line before was quoted
  for (const line of lines) {
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line);
      if (close !== null && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (html > 0) {
      html = Math.max(0, html + htmlDepth(line).net);
      continue;
    }
    const open = FENCE.exec(line);
    if (open !== null) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      quoted = false;
      continue;
    }
    const tags = htmlDepth(line);
    if (tags.opens > 0) {
      html = Math.max(0, tags.net);
      quoted = false;
      continue;
    }
    if (QUOTE.test(line) || (quoted && !BLANK.test(line))) {
      quoted = true;
      continue;
    }
    quoted = false;
    kept.push(line);
  }
  return kept.join('\n');
}

/** The start of what a comment says in its writer's own words, one line, cut: `ownWords` cleaned to one line of EXCERPT_CHARS. */
export function excerptOf(body: string): string {
  return cleanLine(ownWords(body), EXCERPT_CHARS).text;
}

/** Whether the comment is by a person with access who is not the author, on a file. Its thread is not looked at here. */
export function mayCount(c: PersonComment, author: string): boolean {
  return c.bot === false
    && typeof c.author === 'string' && typeof author === 'string' && c.author.toLowerCase() !== author.toLowerCase()
    && WITH_ACCESS.has(c.association)
    && typeof c.path === 'string'
    && timeOf(c.at) !== null;
}

// A score that may be read: a whole number from 0 to 100.
const isWholeScore = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100;

// A score entry that may be read: an object with a whole score from 0 to 100.
function entryOf(v: unknown): Record<string, unknown> | null {
  return isObject(v) && isWholeScore(v.score) ? v : null;
}

// A list of pairs of whole numbers, copied into a list of our own; null when it is not one.
function rangesOf(v: unknown): Array<[number, number]> | null {
  if (!Array.isArray(v)) return null;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < v.length; i += 1) {
    const pair: unknown = v[i];
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [start, end]: unknown[] = [pair[0], pair[1]];
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    out.push([start as number, end as number]);
  }
  return out;
}

// A hash that keeps a source reference readable and apart from the file's: no colon, not the word for the file.
const isHash = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !v.includes(':') && v !== FILE;

function blockOf(v: unknown, wholeFile: Record<string, unknown> | null, fileLevelScore: number | null, threshold: number | null): ScoredBlock | null {
  if (!isObject(v) || !isHash(v.hash) || !isObject(v.lines)) return null;
  const LEFT = rangesOf(v.lines.LEFT);
  const RIGHT = rangesOf(v.lines.RIGHT);
  if (LEFT === null || RIGHT === null) return null;
  const own = entryOf(v.entry);
  const used = own ?? wholeFile;
  const category = used !== null && CATEGORY_SET.has(used.category) ? (used.category as string) : null;
  const reasonText = used !== null && typeof used.reason === 'string' ? cleanLine(used.reason, REASON_CHARS).text : '';
  const scores = [...(own !== null ? [own.score as number] : []), ...(fileLevelScore !== null ? [fileLevelScore] : [])];
  const missed = threshold !== null && scores.length > 0 && Math.max(...scores) < threshold;
  return { hash: v.hash, lines: { LEFT, RIGHT }, category, reason: reasonText === '' ? null : reasonText, missed };
}

/** Reads a run's stored scores. Total: what cannot be read is left out, and nothing throws. */
export function readScored(scores: unknown, threshold: unknown): ScoredRun {
  const run = new Map<string, ScoredBlock[]>();
  try {
    if (!Array.isArray(scores)) return run;
    const limit = isFiniteNumber(threshold) ? threshold : null;
    for (let i = 0; i < scores.length; i += 1) {
      try {
        const file: unknown = scores[i];
        if (!isObject(file) || typeof file.path !== 'string' || !Array.isArray(file.blocks)) continue;
        // A path stored twice is read once, the first time: a damaged result adds nothing.
        if (run.has(file.path)) continue;
        const wholeFile = entryOf(file.wholeFile);
        const fileLevelScore = isObject(file.fileLevel) && isWholeScore(file.fileLevel.score) ? file.fileLevel.score : null;
        const blocks: ScoredBlock[] = [];
        for (let j = 0; j < file.blocks.length; j += 1) {
          const b = blockOf(file.blocks[j], wholeFile, fileLevelScore, limit);
          if (b !== null) blocks.push(b);
        }
        run.set(file.path, blocks);
      } catch {
        // A file whose reading throws is passed over.
      }
    }
  } catch {
    // A result whose reading throws gives what was read before it.
  }
  return run;
}

// Whether the comment's thread is one a person may teach in (rule 2).
function inCountingThread(c: PersonComment, byId: ReadonlyMap<string, PersonComment>, posted: ReadonlyMap<string, 'finding' | 'note'>): boolean {
  if (c.replyTo === null || c.replyTo === undefined) return true;
  const kind = posted.get(c.replyTo);
  if (kind !== undefined) return kind === 'note';
  const parent = byId.get(c.replyTo);
  return parent !== undefined && (parent.replyTo === null || parent.replyTo === undefined) && parent.bot === false;
}

interface Place { path: string; block: ScoredBlock | null }

// The places a counting comment touches (rule 3): the blocks it overlaps at its commit, else its file.
function placesOf(c: PersonComment & { path: string }, scored: ReadonlyMap<string, ScoredRun>): Place[] {
  const run = c.commit === null ? undefined : scored.get(c.commit);
  if (run === undefined || c.fileLevel === true || !Number.isInteger(c.line)) return [{ path: c.path, block: null }];
  const line = c.line as number;
  const first = Number.isInteger(c.startLine) ? (c.startLine as number) : line;
  const side: Side = c.side === 'LEFT' ? 'LEFT' : 'RIGHT';
  const seen = new Set<string>();
  const places: Place[] = [];
  for (const b of run.get(c.path) ?? []) {
    if (seen.has(b.hash)) continue;
    if (!b.lines[side].some(([start, end]) => first <= end && line >= start)) continue;
    seen.add(b.hash);
    places.push({ path: c.path, block: b });
  }
  return places.length > 0 ? places : [{ path: c.path, block: null }];
}

/** Every signal of the pull request, from what is held now. Total and pure; ordered by createdAt, then by sourceRef. */
export function signalsOf(input: SignalInput): Signal[] {
  const posted = input.posted ?? new Map<string, 'finding' | 'note'>();
  const scored = input.scored ?? new Map<string, ScoredRun>();
  let closed: number | null = null;
  if (input.closedAt !== null && input.closedAt !== undefined) {
    closed = timeOf(input.closedAt);
    // A close that is no time: what a signal would be dated by cannot be told, so none is made.
    if (closed === null) return [];
  }

  // Oldest first, then by id, then by body: the first comment at a place is the one that gives the signal, whatever the order held.
  const bodyOf = (c: PersonComment) => (typeof c.body === 'string' ? c.body : '');
  const comments = input.comments
    .filter((c) => isObject(c) && typeof c.id === 'string')
    .map((c) => ({ c, at: timeOf(c.at) }))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || byCodeUnit(a.c.id, b.c.id) || byCodeUnit(bodyOf(a.c), bodyOf(b.c)))
    .map(({ c }) => c);
  const byId = new Map<string, PersonComment>();
  for (const c of comments) if (!byId.has(c.id)) byId.set(c.id, c);

  const signals = new Map<string, Signal>();
  for (const c of comments) {
    // The app's own comments are no person's, whatever they were stored as.
    if (posted.has(c.id) || !mayCount(c, input.author) || !inCountingThread(c, byId, posted)) continue;
    const at = timeOf(c.at)!;
    const made = closed === null ? at : Math.max(closed, at);
    for (const place of placesOf(c as PersonComment & { path: string }, scored)) {
      const sourceRef = `${input.number}:${place.block?.hash ?? FILE}:${place.path}`;
      if (signals.has(sourceRef)) continue;
      signals.set(sourceRef, {
        sourceRef, number: input.number, path: place.path, directory: directoryOf(place.path), block: place.block?.hash ?? null,
        category: place.block?.category ?? null, reason: place.block?.reason ?? null, missed: place.block?.missed ?? false,
        excerpt: excerptOf(c.body), comment: c.id,
        createdAt: new Date(made).toISOString(), expiresAt: new Date(made + SIGNAL_DAYS * DAY_MS).toISOString(),
      });
    }
  }
  return [...signals.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || byCodeUnit(a.sourceRef, b.sourceRef));
}
