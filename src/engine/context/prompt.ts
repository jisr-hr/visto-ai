import type { ChatMessage, PullRequestInfo } from '../types.ts';
import { estimateTokens } from './batches.ts';
import type { Batch } from './batches.ts';
import type { FileContext } from './build.ts';
import { ANCHOR_LEGEND } from './diff.ts';
import { inlineText, stripControl, wrapData } from './untrusted.ts';

// Everything the pull request author wrote is untrusted: text printed outside a
// data wrapper goes through inlineText, text inside one is stripped first.
export function pullRequestHeader(pr: PullRequestInfo, fileCount: number, token: string): string {
  return [
    `Repository: ${inlineText(pr.ref.owner)}/${inlineText(pr.ref.repo)}`,
    `Pull request: #${pr.ref.number}`,
    `Base branch: ${inlineText(pr.baseBranch)}`,
    `Head branch: ${inlineText(pr.headBranch)}`,
    `Author: ${inlineText(pr.author)}`,
    `Files in this review: ${fileCount}`,
    wrapData('title', stripControl(pr.title).text, token),
    wrapData('description', stripControl(pr.description).text, token),
  ].join('\n');
}

function fileSection(c: FileContext, k: number, fileCount: number, token: string): string {
  const path = c.file.path;
  const lines = [
    `## File ${k}/${fileCount}: ${inlineText(path)}`,
    `status: ${c.file.status}`,
    `additions: ${c.file.additions}`,
    `deletions: ${c.file.deletions}`,
  ];
  if (c.file.previousPath !== null) {
    lines.push(`previous path: ${inlineText(c.file.previousPath)}`);
  }
  if (c.diffText !== null) {
    lines.push(wrapData(`diff ${path}`, c.diffText, token));
  }
  if (c.full !== null) {
    lines.push(
      c.full.kind === 'full'
        ? '### Full file (kind: full)'
        : `### Full file (kind: excerpt of ${c.full.totalLines} lines)`,
      wrapData(`full file ${path}`, c.full.text, token),
    );
  }
  if (c.test !== null) {
    lines.push(
      `### Paired test: ${inlineText(c.test.path)}`,
      wrapData(`test ${c.test.path}`, c.test.text, token),
    );
  }
  return lines.join('\n');
}

export function buildMessages(args: {
  contract: string;
  pr: PullRequestInfo;
  fileCount: number;
  firstFileNumber: number;
  batch: Batch;
  batchIndex: number;
  batchCount: number;
  token: string;
}): ChatMessage[] {
  const { contract, pr, fileCount, firstFileNumber, batch, batchIndex, batchCount, token } = args;
  const parts: string[] = [];
  if (batchCount > 1) {
    parts.push(`Batch ${batchIndex + 1} of ${batchCount}.`);
  }
  parts.push(ANCHOR_LEGEND);
  batch.files.forEach((c, i) => {
    parts.push(fileSection(c, firstFileNumber + i, fileCount, token));
  });
  return [
    { role: 'system', content: contract },
    { role: 'user', content: pullRequestHeader(pr, fileCount, token) },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

export function fixedTokens(contract: string, pr: PullRequestInfo): number {
  return (
    estimateTokens(contract) +
    estimateTokens(pullRequestHeader(pr, 9999, 'x'.repeat(16))) +
    estimateTokens(ANCHOR_LEGEND)
  );
}
