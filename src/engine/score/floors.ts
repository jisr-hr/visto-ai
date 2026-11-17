import { parse } from 'yaml';

export const REPO_FILE = '.visto-ai.yml';

const MAX_FILE_CHARS = 20_000;
const MAX_PATTERNS = 200;
const MAX_PATTERN_CHARS = 200;

/** `invalid` is a short code when the file cannot be used. */
export interface TeamFloors { patterns: string[]; invalid: string | null }

const unusable = (invalid: string): TeamFloors => ({ patterns: [], invalid });

export function parseRepoFile(text: string | null): TeamFloors {
  if (text === null) return { patterns: [], invalid: null };
  if (text.length > MAX_FILE_CHARS) return unusable('too_large');
  // A NUL byte means the file is not text, such as one saved as UTF-16.
  if (text.includes('\u0000')) return unusable('not_text');
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return unusable('not_yaml');
  }
  if (doc === null || doc === undefined) return { patterns: [], invalid: null };
  if (typeof doc !== 'object' || Array.isArray(doc)) return unusable('not_a_mapping');
  const entries = Object.entries(doc);
  if (entries.some(([key]) => key !== 'human_review')) return unusable('unknown_key');
  const list: unknown = (doc as Record<string, unknown>).human_review;
  if (list === undefined || list === null) return { patterns: [], invalid: null };
  if (!Array.isArray(list) || list.length > MAX_PATTERNS) return unusable('bad_patterns');
  const patterns: string[] = [];
  for (const item of list) {
    const pattern = typeof item === 'string' ? normalisePattern(item) : null;
    if (pattern === null) return unusable('bad_patterns');
    patterns.push(pattern);
  }
  return { patterns, invalid: null };
}

// null when the entry cannot be used.
function normalisePattern(entry: string): string | null {
  const trimmed = entry.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_PATTERN_CHARS || trimmed.startsWith('!')) return null;
  let pattern = trimmed.replace(/\/+$/, '');
  if (pattern === '') return null;
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  else if (!pattern.includes('/')) pattern = `**/${pattern}`;
  if (pattern.split('/').some((segment) => segment === '')) return null;
  return pattern;
}

// One path segment against one pattern segment: `*` is any run, `?` is one character.
// Two pointers with a single backtrack point, so a long run of stars cannot make it slow.
function matchesSegment(text: string, pattern: string): boolean {
  let t = 0;
  let p = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p;
      resume = t;
      p += 1;
    } else if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * Whether a normalised pattern covers the path: the whole path, or a directory above it.
 * A segment of exactly `**` spans any number of directories. Not compiled to a regular
 * expression, because the path comes from a pull request.
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  const parts = pattern.split('/');
  const segments = filePath.split('/');
  // reach[j]: the pattern segments handled so far match the first j path segments.
  let reach: boolean[] = Array.from({ length: segments.length + 1 }, (_, j) => j === 0);
  for (const part of parts) {
    const next: boolean[] = new Array<boolean>(segments.length + 1).fill(false);
    for (let j = 0; j <= segments.length; j += 1) {
      if (part === '**') {
        next[j] = reach[j]! || (j > 0 && next[j - 1]!);
      } else if (j > 0 && reach[j - 1]! && matchesSegment(segments[j - 1]!, part)) {
        next[j] = true;
      }
    }
    reach = next;
  }
  return reach.some(Boolean);
}

const BUILTIN_FILES = new Set([
  REPO_FILE,
  'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS',
  '.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '.travis.yml',
]);
const BUILTIN_DIRECTORIES = ['.github/workflows/', '.circleci/', '.buildkite/'];

export function builtinFloor(filePath: string): boolean {
  return BUILTIN_FILES.has(filePath) || BUILTIN_DIRECTORIES.some((dir) => filePath.startsWith(dir));
}

export function floorFor(
  file: { path: string; previousPath: string | null },
  floors: TeamFloors,
): 'builtin_floor' | 'team_floor' | 'team_file_invalid' | null {
  // A file moved out of a protected path is still protected, so both names are checked.
  const names = file.previousPath === null ? [file.path] : [file.path, file.previousPath];
  if (names.some(builtinFloor)) return 'builtin_floor';
  if (floors.invalid !== null) return 'team_file_invalid';
  if (names.some((name) => floors.patterns.some((pattern) => matchesPattern(name, pattern)))) return 'team_floor';
  return null;
}
