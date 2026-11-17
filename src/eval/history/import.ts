import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { stripControl } from '../../engine/context/untrusted.ts';
import type {
  GeneralComment, HistorySource, HumanInlineComment, HumanReview, MergedPullRequest, RepoRef,
} from '../../forge/types.ts';
import { serializeCase } from './file.ts';
import type { HistoryActivity, HistoryCase } from './file.ts';

export type ImportSkip = 'head_unreadable' | 'too_many_files' | 'too_many_pages';
const SKIPS: ImportSkip[] = ['head_unreadable', 'too_many_files', 'too_many_pages'];
const BODY_LIMIT = 2000;
const DESCRIPTION_LIMIT = 4000;

function clean(text: string, limit: number): string {
  return stripControl(text).text.slice(0, limit);
}

// A person is an account that is neither a bot nor the pull request's author.
function isPerson(pr: MergedPullRequest, login: string, bot: boolean): boolean {
  return !bot && login !== pr.author;
}

export function firstReviewedHead(
  pr: MergedPullRequest, reviews: HumanReview[], inline: HumanInlineComment[],
): { head: string; at: string; byPerson: boolean } {
  const candidates: { head: string; at: string }[] = [];
  for (const r of reviews) {
    if (r.commit !== null && isPerson(pr, r.author, r.authorIsBot)) candidates.push({ head: r.commit, at: r.at });
  }
  for (const c of inline) {
    if (isPerson(pr, c.author, c.authorIsBot)) candidates.push({ head: c.commit, at: c.at });
  }
  let first: { head: string; at: string } | undefined;
  for (const c of candidates) {
    if (first === undefined || Date.parse(c.at) < Date.parse(first.at)) first = c;
  }
  return first === undefined ? { head: pr.headSha, at: pr.mergedAt, byPerson: false } : { ...first, byPerson: true };
}

// At the same time, general comments come first, then reviews, then inline comments.
const KIND_ORDER: Record<HistoryActivity['kind'], number> = { comment: 0, review: 1, inline: 2 };

function activityOf(reviews: HumanReview[], inline: HumanInlineComment[], comments: GeneralComment[]): HistoryActivity[] {
  const items: HistoryActivity[] = [
    ...comments.map((c): HistoryActivity => ({
      kind: 'comment', id: c.id, author: c.author, bot: c.authorIsBot, association: c.association, at: c.at, body: clean(c.body, BODY_LIMIT),
    })),
    ...reviews.map((r): HistoryActivity => ({
      kind: 'review', id: r.id, author: r.author, bot: r.authorIsBot, association: r.association, at: r.at, body: clean(r.body, BODY_LIMIT),
      state: r.state, commit: r.commit,
    })),
    ...inline.map((c): HistoryActivity => ({
      kind: 'inline', id: c.id, author: c.author, bot: c.authorIsBot, association: c.association, at: c.at, body: clean(c.body, BODY_LIMIT),
      commit: c.commit, path: c.path, side: c.side, line: c.line, start_line: c.startLine, file_level: c.fileLevel, reply_to: c.replyTo,
    })),
  ];
  // Array.prototype.sort is stable, so equal keys keep the order they were built in.
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

function skipReason(error: unknown): ImportSkip | null {
  if (!(error instanceof Error)) return null;
  if (error.message === 'too_many_files') return 'too_many_files';
  if (error.message === 'github_too_many_pages') return 'too_many_pages';
  return null;
}

export async function importPullRequest(
  repo: RepoRef, pr: MergedPullRequest, source: HistorySource,
): Promise<{ case: HistoryCase } | { skipped: ImportSkip }> {
  try {
    const reviews = await source.listReviews(repo, pr.number);
    const inline = await source.listInlineComments(repo, pr.number);
    const comments = await source.listGeneralComments(repo, pr.number);
    const reviewed = firstReviewedHead(pr, reviews, inline);
    const atReview = await source.compare(repo, pr.baseSha, reviewed.head);
    const atFinal = await source.compare(repo, pr.baseSha, pr.headSha);
    if (atReview === null || atFinal === null) return { skipped: 'head_unreadable' };
    return {
      case: {
        version: 1,
        repo: `${repo.owner}/${repo.repo}`, pr_number: pr.number, title: pr.title, body: clean(pr.description, DESCRIPTION_LIMIT),
        author: pr.author, branch: pr.headBranch, base_branch: pr.baseBranch, merged_at: pr.mergedAt,
        review_head: reviewed.head, review_base: atReview.mergeBase, review_at: reviewed.at, reviewed_by_person: reviewed.byPerson,
        final_head: pr.headSha, final_base: atFinal.mergeBase,
        final_files: atFinal.files.map((f) => ({ path: f.path, previous_path: f.previousPath, status: f.status, patch: f.patch })),
        activity: activityOf(reviews, inline, comments),
      },
    };
  } catch (error) {
    const reason = skipReason(error);
    if (reason === null) throw error;
    return { skipped: reason };
  }
}

export async function runImport(
  args: { repo: RepoRef; since: string; until: string; maxPrs: number; outFile: string },
  source: HistorySource,
  out: (line: string) => void,
): Promise<void> {
  // Create the file first so an unusable path fails before any request is made.
  mkdirSync(dirname(args.outFile), { recursive: true });
  writeFileSync(args.outFile, '');
  const { pullRequests: listed, pageLimitReached } = await source.listMergedPullRequests(args.repo, { since: args.since, until: args.until }, args.maxPrs);
  let written = 0;
  const skipped = new Map<ImportSkip, number>();
  // One at a time: the source is rate limited. Each line is appended at once, so a failure keeps what was read.
  for (const pr of listed) {
    const result = await importPullRequest(args.repo, pr, source);
    if ('case' in result) {
      appendFileSync(args.outFile, serializeCase(result.case) + '\n');
      written += 1;
    } else skipped.set(result.skipped, (skipped.get(result.skipped) ?? 0) + 1);
  }
  const skippedTotal = listed.length - written;
  out(`pull requests ${listed.length}, written ${written}, skipped ${skippedTotal}`);
  for (const reason of SKIPS) {
    const n = skipped.get(reason);
    if (n !== undefined) out(`${reason} ${n}`);
  }
  if (listed.length === args.maxPrs) out(`the limit of ${args.maxPrs} pull requests was reached; older ones in the window were not read`);
  if (pageLimitReached) out('the listing stopped at its page limit; older pull requests in the window were not read');
}
