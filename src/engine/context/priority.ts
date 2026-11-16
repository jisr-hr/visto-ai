import type { ChangedFile } from '../types.ts';

const SOURCE_SEGMENTS = new Set(['app', 'src', 'lib']);
const RISK_WORDS = new Set([
  'service', 'controller', 'model', 'worker', 'job', 'policy', 'auth', 'authorization',
  'permission', 'payment', 'invoice', 'billing', 'migration', 'migrate',
]);
const INTERFACE_WORDS = new Set(['schema', 'route', 'config', 'api', 'graphql', 'serializer', 'client', 'adapter']);
const TEST_WORDS = new Set(['spec', 'test', '__tests__']);
const LOW_SEGMENTS = new Set([
  'doc', 'docs', 'generated', 'fixture', 'fixtures', 'snapshot', 'snapshots', 'vendor', 'dist', 'build', 'coverage',
]);
const LOW_EXTENSIONS = new Set(['md', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'lock', 'map', 'snap']);
const LOW_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'go.sum']);

function segmentsOf(path: string): string[] {
  return path.toLowerCase().split('/');
}

function wordsOf(segments: string[]): string[] {
  return segments.flatMap((segment) => [segment, ...segment.split(/[._-]/)]).filter((word) => word !== '');
}

function matchesAny(words: string[], keywords: Set<string>): boolean {
  return words.some((word) => keywords.has(word) || (word.endsWith('s') && keywords.has(word.slice(0, -1))));
}

function isLowByName(segments: string[]): boolean {
  const name = segments[segments.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot + 1);
  return LOW_EXTENSIONS.has(extension) || name.endsWith('.min.js') || LOW_NAMES.has(name);
}

function isLowBySegment(segments: string[]): boolean {
  return segments.some((segment) => LOW_SEGMENTS.has(segment));
}

export function isLowPriority(path: string): boolean {
  const segments = segmentsOf(path);
  return isLowBySegment(segments) || isLowByName(segments);
}

export function priorityScore(file: ChangedFile): number {
  const segments = segmentsOf(file.path);
  const words = wordsOf(segments);
  let score = file.additions + file.deletions;
  if (segments.some((segment) => SOURCE_SEGMENTS.has(segment))) score += 120;
  if (matchesAny(words, RISK_WORDS)) score += 160;
  if (matchesAny(words, INTERFACE_WORDS)) score += 100;
  if (matchesAny(words, TEST_WORDS)) score += 40;
  if (isLowBySegment(segments)) score -= 220;
  if (isLowByName(segments)) score -= 120;
  return score;
}

export function orderByPriority<T extends ChangedFile>(files: T[]): T[] {
  return files
    .map((file) => ({ file, score: priorityScore(file), size: file.additions + file.deletions }))
    .sort((a, b) => b.score - a.score || b.size - a.size || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0))
    .map((entry) => entry.file);
}
