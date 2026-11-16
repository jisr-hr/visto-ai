import type { AuditEntry, ChangedFile, PullRequestInfo, Source } from '../types.ts';
import { commentableRanges, parsePatch, patchFromContents, renderAnchoredDiff } from './diff.ts';
import type { Hunk, Ranges } from './diff.ts';
import { fullFileContext, numberLines } from './full-file.ts';
import type { FullFile } from './full-file.ts';
import { isLowPriority, orderByPriority } from './priority.ts';
import { testCandidates } from './test-pair.ts';
import { stripControl } from './untrusted.ts';

export interface FileContext {
  file: ChangedFile;
  hunks: Hunk[];
  ranges: Ranges | null; // null: the file has no diff to comment on
  diffText: string | null; // anchored diff, control characters stripped
  full: FullFile | null;
  test: { path: string; text: string } | null;
}

const MAX_TEST_PROBES = 20;

function stripped(count: number, subject: string): AuditEntry[] {
  return count === 0
    ? []
    : [{ stage: 'context', action: 'control_characters_stripped', subject, reason: String(count) }];
}

export async function buildFileContexts(
  pr: PullRequestInfo,
  files: ChangedFile[],
  source: Source,
): Promise<{ contexts: FileContext[]; audit: AuditEntry[] }> {
  const cache = new Map<string, string | null>();
  let attempts = 0;
  const fetchContent = async (path: string, sha: string): Promise<string | null> => {
    const key = `${sha}:${path}`;
    if (cache.has(key)) return cache.get(key)!;
    const content = await source.getFileContent(pr, path, sha);
    cache.set(key, content);
    return content;
  };
  const changedPaths = new Set(files.map((f) => f.path));

  const findTest = async (path: string): Promise<{ path: string; content: string } | null> => {
    for (const candidate of testCandidates(path)) {
      if (changedPaths.has(candidate)) return null;
      if (!cache.has(`${pr.headSha}:${candidate}`)) {
        if (attempts >= MAX_TEST_PROBES) return null;
        attempts += 1;
      }
      const content = await fetchContent(candidate, pr.headSha);
      if (content !== null) return { path: candidate, content };
    }
    return null;
  };

  const contexts: FileContext[] = [];
  const audit: AuditEntry[] = [];

  for (const file of orderByPriority(files)) {
    let removed = 0;
    let patch: string | null = null;
    let head: string | null = null;
    let headFetched = false;

    if (file.patch !== null) {
      const clean = stripControl(file.patch);
      patch = clean.text;
      removed += clean.removed;
    } else if (file.status !== 'removed') {
      const old = file.status === 'added' ? '' : await fetchContent(file.previousPath ?? file.path, pr.baseSha);
      head = await fetchContent(file.path, pr.headSha);
      headFetched = true;
      if (old !== null && head !== null) {
        patch = patchFromContents(stripControl(old).text, stripControl(head).text);
      }
    }

    let hunks: Hunk[] = [];
    let ranges: Ranges | null = null;
    let diffText: string | null = null;
    if (patch !== null) {
      hunks = parsePatch(patch);
      ranges = commentableRanges(hunks);
      diffText = renderAnchoredDiff(hunks);
    }

    let full: FullFile | null = null;
    let test: FileContext['test'] = null;
    if (ranges !== null) {
      if (file.status !== 'removed' && !isLowPriority(file.path)) {
        if (!headFetched) head = await fetchContent(file.path, pr.headSha);
        if (head !== null) {
          const clean = stripControl(head);
          removed += clean.removed;
          full = fullFileContext(clean.text, hunks);
        }
      }
      if (file.status !== 'removed') {
        const found = await findTest(file.path);
        if (found !== null) {
          const clean = stripControl(found.content);
          test = { path: found.path, text: numberLines(clean.text) };
          audit.push(...stripped(clean.removed, found.path));
        }
      }
    }
    audit.push(...stripped(removed, file.path));
    contexts.push({ file, hunks, ranges, diffText, full, test });
  }
  return { contexts, audit };
}
