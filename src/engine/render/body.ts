import type { Finding, NotReviewed, RawFinding, ReviewResult, Side, UnplacedFinding } from '../types.ts';
import type { BlockScore, FileLevelSource, FileScore, ScoreEntry, Span } from '../score/types.ts';

export interface InlineComment { path: string; side: Side; line: number; body: string }
export const MAX_BODY_CHARS = 65_536;

const MAX_LISTED = 25;
const MAX_REVIEW_ENTRIES = 50;
const FIRST_LINE_CHARS = 300;
const UNPLACED_HEADING = '## Findings not placed on the diff';
const OVERALL_HEADING = '## Overall';
const UNPLACED_NOTE = "GitHub cannot show these inline: the line is outside this pull request's diff, or the file has no diff GitHub can comment on. They do not block the merge.";

type FileRef = { path: string; previousPath: string | null };
type Meta = {
  trigger: 'automatic' | 'manual';
  requestedBy: string | null;
  // Builds a link to a span of a file; null when the service has no such link.
  lineUrl: ((file: FileRef, span: Span) => string) | null;
  // true: each finding is an inline comment; false: its whole text is written in the body.
  inline: boolean;
};

const WHOLE_FILE_TEXT: Record<Exclude<FileLevelSource, 'whole_file' | 'team_file_invalid'>, string> = {
  builtin_floor: "it changes the reviewer's own file, code owners or CI",
  team_floor: 'a path the team marked as always needing a person',
  hidden_characters: 'a changed line holds invisible or direction-changing characters',
  not_scored: 'not read, or left without a score',
  rule_rename: 'scored by rule',
  rule_asset: 'scored by rule',
};

// Cut a string to at most `limit` UTF-16 units without splitting a surrogate pair.
function safeSlice(text: string, limit: number): string {
  let end = Math.max(0, Math.min(limit, text.length));
  const last = text.charCodeAt(end - 1);
  if (end > 0 && end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function firstLine(body: string): string {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line.length > FIRST_LINE_CHARS ? `${safeSlice(line, FIRST_LINE_CHARS - 1)}\u2026` : line;
}

// A path shown in a bullet stays on its line: newlines and tabs become spaces first.
function codeSpan(raw: string): string {
  const text = raw.replace(/[\r\n\t]/g, ' ');
  if (!text.includes('`')) return `\`${text}\``;
  const longest = Math.max(...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

// A model-written line must not become a heading of the review body.
function noHeading(text: string): string {
  return text.replace(/^( {0,3})#/gm, '$1\\#');
}

const ZW = '\u200b';

// Mentions and raw HTML in a stretch of prose. `before` is the character in front of it.
function inertProse(text: string, before: string): string {
  return text.replace(/<|@(?=[\p{L}\p{N}])/gu, (m, at: number) => {
    if (m === '<') return '&lt;';
    return /[\p{L}\p{N}_]/u.test(at > 0 ? text[at - 1]! : before) ? m : `@${ZW}`;
  });
}

// One line: an inline span closed on the same line is code, and everything else is prose.
function inertLine(line: string): string {
  let out = '';
  let from = 0; // start of the prose not yet written
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') { i += 1; continue; }
    let j = i;
    while (line[j] === '`') j += 1;
    let close = -1;
    if (i === 0 || line[i - 1] !== '\\') {
      for (const run of line.slice(j).matchAll(/`+/g)) {
        if (run[0].length === j - i) { close = j + run.index + run[0].length; break; }
      }
    }
    if (close === -1) { i = j; continue; }
    out += inertProse(line.slice(from, i), line[from - 1] ?? '');
    out += line.slice(i, close);
    from = i = close;
  }
  return out + inertProse(line.slice(from), line[from - 1] ?? '');
}

// Text of one line that is written after other text: no fence can open in it.
function inertInline(text: string): string {
  return text.split('\n').map(inertLine).join('\n');
}

/** Text the model wrote, made safe to post. Outside code: a mention gets a zero-width space after its `@`, and every `<` is written as `&lt;`. A fence left open is closed. */
export function inert(text: string): string {
  let open: Fence | null = null;
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (open !== null) {
      if (fenceCloses(line, open)) open = null;
      lines.push(line);
      continue;
    }
    open = fenceOpens(line);
    lines.push(open !== null ? line : inertLine(line));
  }
  return closeOpenFence(lines.join('\n'));
}

function bullets(items: string[], cap: boolean = true): string[] {
  const shown = cap ? items.slice(0, MAX_LISTED) : items;
  return items.length > shown.length ? [...shown, `- \u2026and ${items.length - shown.length} more.`] : shown;
}

const located = (f: Finding | RawFinding): string =>
  `- **[${f.severity}]** ${codeSpan(`${f.path}:${f.line}`)} \u2014 ${inertInline(firstLine(f.body))}`;
const unplacedLine = (f: UnplacedFinding): string =>
  `- ${codeSpan(`${f.path}:${f.line}`)}${f.side === 'LEFT' ? ' (old file)' : ''} \u2014 ${inertInline(firstLine(f.body))}`;
// A bullet with the whole text of its finding under it, as a continuation of the item.
const locatedWhole = (f: Finding): string => {
  const text = noHeading(inert(f.body)).split('\n').map((l) => (l === '' ? l : `  ${l}`)).join('\n');
  return `${located(f)}\n\n${text}`;
};
const notReviewedLine = (n: NotReviewed): string => `- ${codeSpan(n.path)}: ${n.reason}`;

function commentBody(f: Finding): string {
  const moved = f.requestedLine === null ? '' : `_(Refers to ${f.side === 'LEFT' ? 'old line' : 'line'} ${f.requestedLine}, just outside the diff.)_ `;
  return `**[${f.severity}]** ${moved}${inert(f.body)}`;
}

// The part after the score: the category in a code span, then the dash and the reason when there is one.
function scoreTail(entry: ScoreEntry): string {
  const reason = inertInline(firstLine(entry.reason));
  return `${codeSpan(entry.category)}${reason === '' ? '' : ` \u2014 ${reason}`}`;
}

function wholeFileLine(file: FileScore, level: NonNullable<FileScore['fileLevel']>, teamFileInvalid: string | null): string {
  const head = `- whole file, ${level.score}%`;
  if (level.source === 'team_file_invalid') {
    return `${head} \u2014 the repository's .visto-ai.yml cannot be used (${teamFileInvalid ?? 'unknown'}), so every file needs a person`;
  }
  if (level.source !== 'whole_file') return `${head} \u2014 ${WHOLE_FILE_TEXT[level.source]}`;
  return file.wholeFile === null ? head : `${head} ${scoreTail(file.wholeFile)}`;
}

function blockLine(file: FileScore, block: BlockScore, entry: ScoreEntry, lineUrl: Meta['lineUrl']): string {
  const { span } = block;
  const range = span.first === span.last ? `line ${span.first}` : `lines ${span.first}-${span.last}`;
  const label = `${span.side === 'LEFT' ? 'old ' : ''}${range}`;
  const shown = lineUrl === null ? label : `[${label}](${lineUrl(file, span)})`;
  return `- ${shown}, ${entry.score}% ${scoreTail(entry)}`;
}

// The lines a person should read, grouped by file; a file's heading is not an entry.
function humanReviewSection(result: ReviewResult, lineUrl: Meta['lineUrl']): string {
  const { threshold, highest } = result.verdict;
  const groups: { file: FileScore; lines: string[] }[] = [];
  const files = result.scores
    .map((file, index) => ({ file, index }))
    .sort((a, b) => b.file.finalScore - a.file.finalScore || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : a.index - b.index))
    .map((x) => x.file);
  for (const file of files) {
    const lines: string[] = [];
    if (file.fileLevel !== null && file.fileLevel.score >= threshold) lines.push(wholeFileLine(file, file.fileLevel, result.teamFileInvalid));
    const flagged = file.blocks
      .map((block, index) => ({ block, index, entry: block.entry }))
      .filter((x): x is { block: BlockScore; index: number; entry: ScoreEntry } => x.entry !== null && x.entry.score >= threshold)
      .sort((a, b) => b.entry.score - a.entry.score || a.index - b.index);
    for (const x of flagged) lines.push(blockLine(file, x.block, x.entry, lineUrl));
    if (lines.length > 0) groups.push({ file, lines });
  }
  if (groups.length === 0) return `## Human review\n\nNothing here is at or above ${threshold}%. The highest score is ${highest}%.`;
  const total = groups.reduce((n, g) => n + g.lines.length, 0);
  let room = MAX_REVIEW_ENTRIES;
  const out: string[] = [`## Human review\n\nA person should read these parts. Each is at or above ${threshold}%.`];
  for (const { file, lines } of groups) {
    if (room === 0) break;
    const written = lines.slice(0, room);
    room -= written.length;
    out.push([`**${codeSpan(file.path)}**`, ...written].join('\n'));
  }
  if (total > MAX_REVIEW_ENTRIES) out[out.length - 1] += `\n- \u2026and ${total - MAX_REVIEW_ENTRIES} more.`;
  return out.join('\n\n');
}

function overallLine(result: ReviewResult): string {
  const placed = result.findings;
  const count = (s: Finding['severity']) => placed.filter((f) => f.severity === s).length;
  const u = result.unplaced.length;
  const k = result.coverage.notReviewed.length;
  const parts: string[] = [];
  if (placed.length === 0 && u === 0) parts.push('No findings.');
  else {
    parts.push(`${count('blocker')} blocker, ${count('major')} major, ${count('minor')} minor.`);
    if (u > 0) parts.push(`${u} could not be placed on the diff.`);
  }
  if (k > 0) parts.push(`${k} files were not reviewed.`);
  const { needsHuman, highest } = result.verdict;
  parts.push(`Human review: ${needsHuman ? 'needed' : 'not needed'} (highest score ${highest}%).`);
  return parts.join(' ');
}

export function renderReview(result: ReviewResult, meta: Meta): { body: string; comments: InlineComment[] } {
  const prefix: string[] = [];
  if (meta.trigger === 'manual') {
    prefix.push(meta.requestedBy === null ? '**Full review** requested.' : `**Full review** requested by @${meta.requestedBy}.`);
  }
  if (result.status === 'failed') {
    const failure = result.failure === null ? 'unknown' : `${result.failure.stage}: ${result.failure.code}`;
    return { body: [...prefix, `${OVERALL_HEADING}\n\nThe review could not be completed (${failure}).\n\nHuman review: needed, because the review did not finish.`].join('\n\n'), comments: [] };
  }
  // The tail is kept whole when the body is cut: from the unplaced section on, or the Overall section alone.
  const head: string[] = [...prefix];
  const tail: string[] = [];
  const overview = result.overview.trim();
  if (overview !== '') head.push(`## Summary\n\n${noHeading(inert(overview))}`);
  head.push(humanReviewSection(result, meta.lineUrl));
  if (result.findings.length > 0) {
    const items = meta.inline ? bullets(result.findings.map(located)) : bullets(result.findings.map(locatedWhole), false);
    head.push(['## Findings', '', ...items].join('\n'));
  }
  const rest = result.unplaced.length > 0 ? tail : head;
  if (result.unplaced.length > 0) {
    tail.push([UNPLACED_HEADING, '', UNPLACED_NOTE, '', ...bullets(result.unplaced.map(unplacedLine))].join('\n'));
  }
  if (result.beyondDiff.length > 0) rest.push(['## Beyond the diff', '', ...bullets(result.beyondDiff.map(located))].join('\n'));
  if (result.coverage.notReviewed.length > 0) {
    rest.push(['## Coverage', '', 'These files were not reviewed:', '', ...bullets(result.coverage.notReviewed.map(notReviewedLine))].join('\n'));
  }
  tail.push(`${OVERALL_HEADING}\n\n${overallLine(result)}`);
  const comments = !meta.inline ? [] : result.findings.map((f) => ({ path: f.path, side: f.side, line: f.line, body: commentBody(f) }));
  return { body: fitBody(head.join('\n\n'), tail.join('\n\n')), comments };
}

const cutMarker = (removed: number): string => `_[\u2026 ${removed} characters of the review were cut to fit GitHub's limit]_`;

type Fence = { indent: string; char: string; size: number };

// A line indented by at most three spaces that opens with three or more backticks or tildes; for backticks the rest of the line holds none.
function fenceOpens(line: string): Fence | null {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, ''));
  if (m === null || (m[2]![0] === '`' && m[3]!.includes('`'))) return null;
  return { indent: m[1]!, char: m[2]![0]!, size: m[2]!.length };
}

// The same character at the same or a greater length, and nothing else but spaces.
function fenceCloses(line: string, open: Fence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,}) *$/.exec(line.replace(/\r$/, ''));
  return m !== null && m[1]![0] === open.char && m[1]!.length >= open.size;
}

// Close a code fence that a cut left open, at the opening fence's own indent.
function closeOpenFence(text: string): string {
  let open: Fence | null = null;
  for (const line of text.split('\n')) {
    if (open === null) open = fenceOpens(line);
    else if (fenceCloses(line, open)) open = null;
  }
  return open === null ? text : `${text}\n${open.indent}${open.char.repeat(open.size)}`;
}

// The longest prefix that fits and ends at a line break, or a plain cut when no line break fits.
function cutAtLineBreak(text: string, room: number): string {
  if (room >= text.length) return text;
  const slice = safeSlice(text, room);
  if (text[slice.length] === '\n') return slice;
  const at = slice.lastIndexOf('\n');
  return at > 0 ? slice.slice(0, at) : slice;
}

// Keep as much of `head` as fits in `room` after the cut, then the marker, then `tail`.
function assemble(head: string, tail: string, limit: number): string {
  let room = limit - tail.length - cutMarker(head.length).length - 4;
  while (room > 0) {
    const kept = cutAtLineBreak(head, room).trimEnd();
    const out = `${closeOpenFence(kept)}\n\n${cutMarker(head.length - kept.length)}${tail === '' ? '' : `\n\n${tail}`}`;
    if (out.length <= limit) return out;
    room -= out.length - limit;
  }
  const compact = `${cutMarker(head.length)}\n\n${tail}`;
  return compact.length <= limit ? compact : tail;
}

/** `tail` is kept whole when it fits: the cut takes the end of `head`. */
export function fitBody(head: string, tail: string, limit: number = MAX_BODY_CHARS): string {
  const body = head === '' ? tail : tail === '' ? head : `${head}\n\n${tail}`;
  if (body.length <= limit) return body;
  if (head !== '' && tail !== '' && tail.length <= limit) return assemble(head, tail, limit);
  // No tail to protect, or the tail alone is over the limit: cut from the end.
  return assemble(body, '', limit);
}
