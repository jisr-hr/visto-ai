import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

/** GitHub's heading-anchor rule: lowercase, drop all but letters, digits, spaces, `-` and `_`, spaces become `-`. */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N} _-]/gu, '')
    .replaceAll(' ', '-');
}

type Line = { text: string; number: number };

/** The lines outside fenced code. A fence closes on the same character, repeated at least as many times, with no info string. */
function proseLines(markdown: string, firstLine = 1): Line[] {
  const out: Line[] = [];
  let fence: { char: string; length: number } | null = null;
  markdown.split('\n').forEach((text, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence === null) {
      if (m && !(m[1]![0] === '`' && m[2]!.includes('`'))) fence = { char: m[1]![0]!, length: m[1]!.length };
      else out.push({ text, number: firstLine + i });
    } else if (m && m[1]![0] === fence.char && m[1]!.length >= fence.length && m[2]!.trim() === '') {
      fence = null;
    }
  });
  return out;
}

const withoutInlineCode = (text: string) => text.replace(/(`+)(?:(?!\1)[\s\S])+?\1/g, '');
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

function split(markdown: string): { front: string | null; body: string; bodyStart: number } {
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(markdown);
  if (!m) return { front: null, body: markdown, bodyStart: 1 };
  return { front: m[1]!, body: markdown.slice(m[0].length), bodyStart: m[0].split('\n').length };
}

type Heading = { level: number; text: string; number: number };

function headingsOf(markdown: string): Heading[] {
  const { body, bodyStart } = split(markdown);
  const out: Heading[] = [];
  for (const { text, number } of proseLines(body, bodyStart)) {
    const m = HEADING.exec(text);
    if (m) out.push({ level: m[1]!.length, text: (m[2] ?? '').replace(/[ \t]+#+$/, '').replace(/^#+$/, ''), number });
  }
  return out;
}

/** Every anchor GitHub gives the headings of a file: a repeated heading gets -1, -2 and so on. */
function anchorsOf(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const h of headingsOf(markdown)) {
    const base = slugify(h.text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

const INLINE_LINK = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function linkProblems(markdown: string, file: string, repoRoot: string, label: string): string[] {
  const problems: string[] = [];
  const root = resolve(repoRoot);
  const own = anchorsOf(markdown);
  const { body, bodyStart } = split(markdown);
  for (const { text, number } of proseLines(body, bodyStart)) {
    for (const m of withoutInlineCode(text).matchAll(INLINE_LINK)) {
      if (m[1] === '!') continue;
      const target = m[2]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
      const hash = target.indexOf('#');
      const path = hash === -1 ? target : target.slice(0, hash);
      let anchor = hash === -1 ? '' : target.slice(hash + 1);
      try {
        anchor = decodeURIComponent(anchor);
      } catch {
        // keep the raw anchor
      }
      const where = `${label}: line ${number}`;
      if (path === '') {
        if (anchor !== '' && !own.has(anchor)) problems.push(`${where}: link "${target}" points at an anchor that is not a heading here`);
        continue;
      }
      const resolved = resolve(dirname(file), decodeURI(path));
      if (resolved !== root && !resolved.startsWith(root + sep)) {
        problems.push(`${where}: link "${target}" leaves the repository`);
      } else if (!existsSync(resolved)) {
        problems.push(`${where}: link "${target}" points at a file that does not exist`);
      } else if (anchor !== '' && resolved.endsWith('.md') && statSync(resolved).isFile()) {
        if (!anchorsOf(readFileSync(resolved, 'utf8')).has(anchor)) {
          problems.push(`${where}: link "${target}" points at an anchor that is not a heading in ${relative(root, resolved)}`);
        }
      }
    }
  }
  return problems;
}

/** The link check alone: every relative link resolves to a file in the repository and, for .md targets, to a heading. */
export function checkLinks(file: string, repoRoot: string): string[] {
  return linkProblems(readFileSync(file, 'utf8'), file, repoRoot, basename(file));
}

function filled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function pageProblems(file: string, repoRoot: string): string[] {
  const label = basename(file);
  const markdown = readFileSync(file, 'utf8');
  const problems: string[] = [];
  const { front, body, bodyStart } = split(markdown);
  let meta: Record<string, unknown> = {};
  if (front === null) {
    problems.push(`${label}: no frontmatter, so no title and no description`);
  } else {
    try {
      const parsed: unknown = parse(front);
      if (parsed !== null && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch (error) {
      problems.push(`${label}: the frontmatter is not valid YAML (${(error as Error).message.split('\n')[0]})`);
    }
  }
  for (const key of ['title', 'description']) {
    if (!filled(meta[key])) problems.push(`${label}: frontmatter ${key} is missing or empty`);
  }
  let previous = 1;
  for (const { text, number } of proseLines(body, bodyStart)) {
    const heading = HEADING.exec(text);
    if (heading) {
      const level = heading[1]!.length;
      if (level === 1) {
        problems.push(`${label}: line ${number}: "${text.trim()}" is a body heading with "# "; the title is the page's h1, so use ## or deeper`);
      } else if (level > previous + 1) {
        problems.push(`${label}: line ${number}: heading level jumps from ${previous} to ${level}`);
        previous = level;
      } else {
        previous = level;
      }
    }
    const prose = withoutInlineCode(text);
    if (/^ {0,3}\[[^\]]+\]:\s*\S/.test(text)) problems.push(`${label}: line ${number}: reference-style link definition; use an inline link`);
    if (/^\s*>\s*\[!/.test(text)) problems.push(`${label}: line ${number}: GitHub alert; use a plain blockquote`);
    if (/!\[/.test(prose)) problems.push(`${label}: line ${number}: image; the guide has none`);
  }
  return [...problems, ...linkProblems(markdown, file, repoRoot, label)];
}

function sidebarProblems(dir: string, slugs: string[]): string[] {
  const path = resolve(dir, 'sidebar.json');
  if (!existsSync(path)) return ['sidebar.json: missing'];
  let groups: unknown;
  try {
    groups = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return ['sidebar.json: not valid JSON'];
  }
  if (!Array.isArray(groups) || !groups.every((g) => g && typeof g === 'object' && Array.isArray((g as { items?: unknown }).items))) {
    return ['sidebar.json: must be a list of groups, each with an items list'];
  }
  const name = (slug: string) => (slug === '' ? 'index' : slug);
  const listed = (groups as { items: string[] }[]).flatMap((g) => g.items);
  return [
    ...[...new Set(listed)].filter((s) => !slugs.includes(s)).map((s) => `sidebar.json: lists "${name(s)}" but there is no such page`),
    ...slugs.filter((s) => !listed.includes(s)).map((s) => `sidebar.json: page "${name(s)}" is listed in no group`),
    ...[...new Set(listed.filter((s, i) => listed.indexOf(s) !== i))].map((s) => `sidebar.json: lists "${name(s)}" more than once`),
  ];
}

/** Everything the website's build needs from the guide, plus its links. Returns the problems; empty means valid. */
export function checkGuide(dir: string, repoRoot: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const problems: string[] = [];
  if (!files.includes('index.md')) problems.push('index.md: missing, so /docs/ would have no page');
  for (const f of files) problems.push(...pageProblems(resolve(dir, f), repoRoot));
  problems.push(...sidebarProblems(dir, files.map((f) => (f === 'index.md' ? '' : f.slice(0, -3)))));
  return problems;
}
