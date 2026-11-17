import path from 'node:path';
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
  if (list === undefined) return { patterns: [], invalid: null };
  if (!Array.isArray(list) || list.length > MAX_PATTERNS) return unusable('bad_patterns');
  const patterns: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') return unusable('bad_patterns');
    const trimmed = item.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_PATTERN_CHARS) return unusable('bad_patterns');
    const unrooted = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
    patterns.push(unrooted.endsWith('/') ? `${unrooted}**` : unrooted);
  }
  return { patterns, invalid: null };
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
  if (names.some((name) => floors.patterns.some((pattern) => path.posix.matchesGlob(name, pattern)))) return 'team_floor';
  return null;
}
