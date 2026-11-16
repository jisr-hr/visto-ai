import type { Finding, NotReviewed, RawFinding, ReviewResult, Side, UnplacedFinding } from '../types.ts';

export interface InlineComment { path: string; side: Side; line: number; body: string }
export const MAX_BODY_CHARS = 65_536;

const MAX_LISTED = 25;
const FIRST_LINE_CHARS = 300;
const UNPLACED_HEADING = '## Findings not placed on the diff';
const OVERALL_HEADING = '## Overall';
const UNPLACED_NOTE = "GitHub cannot show these inline: the line is outside this pull request's diff, or the file has no diff GitHub can comment on. They do not block the merge.";

type Meta = { trigger: 'automatic' | 'manual'; requestedBy: string | null };

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

function codeSpan(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function bullets(items: string[]): string[] {
  const shown = items.slice(0, MAX_LISTED);
  return items.length > shown.length ? [...shown, `- \u2026and ${items.length - shown.length} more.`] : shown;
}

const located = (f: Finding | RawFinding): string =>
  `- **[${f.severity}]** ${codeSpan(`${f.path}:${f.line}`)} \u2014 ${firstLine(f.body)}`;
const unplacedLine = (f: UnplacedFinding): string =>
  `- ${codeSpan(`${f.path}:${f.line}`)}${f.side === 'LEFT' ? ' (old file)' : ''} \u2014 ${firstLine(f.body)}`;
const notReviewedLine = (n: NotReviewed): string => `- ${codeSpan(n.path)}: ${n.reason}`;

function commentBody(f: Finding): string {
  const moved = f.requestedLine === null ? '' : `_(Refers to ${f.side === 'LEFT' ? 'old line' : 'line'} ${f.requestedLine}, just outside the diff.)_ `;
  return `**[${f.severity}]** ${moved}${f.body}`;
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
  return parts.join(' ');
}

export function renderReview(result: ReviewResult, meta: Meta): { body: string; comments: InlineComment[] } {
  const sections: string[] = [];
  if (meta.trigger === 'manual') {
    sections.push(meta.requestedBy === null ? '**Full review** requested.' : `**Full review** requested by @${meta.requestedBy}.`);
  }
  const overview = result.overview.trim();
  if (overview !== '') sections.push(`## Summary\n\n${overview}`);
  if (result.findings.length > 0) sections.push(['## Findings', '', ...bullets(result.findings.map(located))].join('\n'));
  if (result.unplaced.length > 0) {
    sections.push([UNPLACED_HEADING, '', UNPLACED_NOTE, '', ...bullets(result.unplaced.map(unplacedLine))].join('\n'));
  }
  if (result.beyondDiff.length > 0) sections.push(['## Beyond the diff', '', ...bullets(result.beyondDiff.map(located))].join('\n'));
  if (result.coverage.notReviewed.length > 0) {
    sections.push(['## Coverage', '', 'These files were not reviewed:', '', ...bullets(result.coverage.notReviewed.map(notReviewedLine))].join('\n'));
  }
  sections.push(`${OVERALL_HEADING}\n\n${overallLine(result)}`);
  const comments = result.findings.map((f) => ({ path: f.path, side: f.side, line: f.line, body: commentBody(f) }));
  return { body: fitBody(sections.join('\n\n')), comments };
}

const cutMarker = (removed: number): string => `_[\u2026 ${removed} characters of the review were cut to fit GitHub's limit]_`;

// Close a code fence that a cut left open, at the opening fence's own indent.
function closeOpenFence(text: string): string {
  let open: { indent: string; char: string; size: number } | null = null;
  for (const line of text.split('\n')) {
    if (open === null) {
      const m = /^( *)(`{3,}|~{3,})/.exec(line);
      if (m) open = { indent: m[1]!, char: m[2]![0]!, size: m[2]!.length };
    } else {
      const m = /^ *(`{3,}|~{3,}) *$/.exec(line);
      if (m && m[1]![0] === open.char && m[1]!.length >= open.size) open = null;
    }
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

function tailStart(body: string): number {
  for (const heading of [UNPLACED_HEADING, OVERALL_HEADING]) {
    const m = new RegExp(`^${heading}[ \\t]*$`, 'm').exec(body);
    if (m) return m.index;
  }
  return -1;
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

export function fitBody(body: string, limit: number = MAX_BODY_CHARS): string {
  if (body.length <= limit) return body;
  const start = tailStart(body);
  if (start > 0) {
    const tail = body.slice(start);
    if (tail.length <= limit) return assemble(body.slice(0, start), tail, limit);
  }
  // No tail to protect, or the tail alone is over the limit: cut from the end.
  return assemble(body, '', limit);
}
