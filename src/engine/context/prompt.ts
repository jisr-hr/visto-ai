import type { ChatMessage, PullRequestInfo } from '../types.ts';
import { estimateTokens } from './batches.ts';
import type { Batch } from './batches.ts';
import { ANCHOR_LEGEND } from './diff.ts';
import { extensionPart } from './extensions.ts';
import type { ExtensionContext } from './extensions.ts';
import { memoryParts } from './memory.ts';
import type { MemoryContext } from './memory.ts';
import { submitToolFor } from '../model/submit-review.ts';
import { MEASURE_NUMBER, MEASURE_TOKEN, fileSection } from './section.ts';
import { THREAD_HEADING, THREAD_RULES, threadsPart } from './threads.ts';
import { cutText, inlineText, stripControl, wrapData } from './untrusted.ts';

// Room kept for the retry turn: the rejected answer (cut to 2,000 characters) and the rejection line.
export const RETRY_ALLOWANCE_TOKENS = 800;
// The longest last review overview a call is shown.
export const LAST_OVERVIEW_CHARS = 4000;

const LAST_OVERVIEW_LINE = 'The last review of this pull request summarized it as below. It describes an earlier state of the code and proves nothing about the code you are given.';

// Everything the pull request author wrote is untrusted: text printed outside a
// data wrapper goes through inlineText, text inside one is stripped first.
export function pullRequestHeader(pr: PullRequestInfo, fileCount: number, token: string, lastOverview?: string): string {
  return [
    `Repository: ${inlineText(pr.ref.owner)}/${inlineText(pr.ref.repo)}`,
    `Pull request: #${pr.ref.number}`,
    `Base branch: ${inlineText(pr.baseBranch)}`,
    `Head branch: ${inlineText(pr.headBranch)}`,
    `Author: ${inlineText(pr.author)}`,
    `Files in this review: ${fileCount}`,
    wrapData('title', stripControl(pr.title).text, token),
    wrapData('description', stripControl(pr.description).text, token),
    ...(lastOverview === undefined ? [] : [LAST_OVERVIEW_LINE, wrapData('last review overview', cutText(lastOverview, LAST_OVERVIEW_CHARS), token)]),
  ].join('\n');
}

// What stripping removes from the title and the description, for the audit.
export function headerStripCounts(pr: PullRequestInfo): { title: number; description: number } {
  return { title: stripControl(pr.title).removed, description: stripControl(pr.description).removed };
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
  lastOverview?: string;   // the last review's overview, in an incremental review or a re-check that has one
  extension?: ExtensionContext;   // what the context providers gave, the same for every call of a review
  memory?: MemoryContext;         // where people stepped in before, the same for every call of a review
}): ChatMessage[] {
  const { contract, pr, fileCount, firstFileNumber, batch, batchIndex, batchCount, token, lastOverview, extension, memory } = args;
  const parts: string[] = [];
  if (batchCount > 1) {
    parts.push(`Batch ${batchIndex + 1} of ${batchCount}.`);
  }
  parts.push(ANCHOR_LEGEND);
  batch.files.forEach((c, i) => {
    parts.push(fileSection(c, firstFileNumber + i, fileCount, token));
  });
  const threads = threadsPart(
    batch.files.flatMap((c) => c.threads ?? []).sort((x, y) => Number(x.key.slice(1)) - Number(y.key.slice(1))), token,
  );
  if (threads !== '') parts.push(threads);
  const header = pullRequestHeader(pr, fileCount, token, lastOverview);
  const part = extension === undefined ? '' : extensionPart(extension, token);
  // Memory holds no token: the repository part stands before anything about the pull request, so a stable prefix stays
  // stable, and the pull request part after the header, before what the providers gave (5.3, 5.4).
  const remembered = memory === undefined ? undefined : memoryParts(memory);
  const top = remembered === undefined ? header : `${header}\n${remembered.pullRequest}`;
  return [
    { role: 'system', content: contract },
    ...(remembered === undefined || remembered.repository === '' ? [] : [{ role: 'user' as const, content: remembered.repository }]),
    { role: 'user', content: part === '' ? top : `${top}\n${part}` },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

// Everything in a call except the file sections: the contract, the header, the
// batch line, the legend, the tool definition, the retry turn, what the context providers gave, and memory.
export function fixedTokens(
  contract: string, pr: PullRequestInfo, withThreads = false, lastOverview?: string, extension?: ExtensionContext, memory?: MemoryContext,
): number {
  const part = extension === undefined ? '' : extensionPart(extension, MEASURE_TOKEN);
  const remembered = memory === undefined ? undefined : memoryParts(memory);
  return (
    estimateTokens(contract) +
    estimateTokens(pullRequestHeader(pr, MEASURE_NUMBER, MEASURE_TOKEN, lastOverview)) +
    estimateTokens(`Batch ${MEASURE_NUMBER} of ${MEASURE_NUMBER}.\n\n`) +
    estimateTokens(`${ANCHOR_LEGEND}\n\n`) +
    // A call that shows criteria is sent the tool that takes rows.
    estimateTokens(JSON.stringify(submitToolFor(withThreads, part !== '' && extension!.criteria.length > 0))) +
    (withThreads ? estimateTokens(`${THREAD_HEADING}\n\n${THREAD_RULES}\n\n`) : 0) +
    RETRY_ALLOWANCE_TOKENS +
    (part === '' ? 0 : estimateTokens(`\n${part}`)) +
    (remembered === undefined ? 0 : estimateTokens(remembered.repository) + estimateTokens(`\n${remembered.pullRequest}`))
  );
}
