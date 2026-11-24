import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  GeneralComment, HistorySource, HumanInlineComment, HumanReview, MergedPullRequest, RepoRef,
} from '../../forge/types.ts';
import { revertedNumber } from '../../memory/reverts.ts';
import { parseHistory } from './file.ts';
import { firstReviewedHead, importPullRequest, runImport } from './import.ts';

const repo: RepoRef = { owner: 'acme', repo: 'shop' };
const pr: MergedPullRequest = {
  number: 12, title: 'Add cart totals', description: 'Adds totals.', author: 'dev-one', authorIsBot: false,
  baseBranch: 'main', headBranch: 'cart-totals', baseSha: 'base0', headSha: 'c4', mergedAt: '2026-01-06T12:00:00Z',
};

const review = (over: Partial<HumanReview>): HumanReview => ({
  id: 'r', author: 'dev-two', authorIsBot: false, association: 'member', state: 'commented', commit: 'c1', at: '2026-01-05T09:00:00Z', body: '', ...over,
});
const inlineComment = (over: Partial<HumanInlineComment>): HumanInlineComment => ({
  id: 'i', author: 'dev-two', authorIsBot: false, association: 'member', at: '2026-01-05T09:00:00Z', commit: 'c1',
  path: 'src/cart.ts', side: 'RIGHT', line: 4, startLine: null, fileLevel: false, replyTo: null, body: 'x', ...over,
});
const general = (over: Partial<GeneralComment>): GeneralComment => ({
  id: 'g', author: 'dev-one', authorIsBot: false, association: 'owner', at: '2026-01-05T09:00:00Z', body: 'x', ...over,
});

const reviews = [
  review({ id: 'r-bot', author: 'review-bot', authorIsBot: true, commit: 'c1', at: '2026-01-05T09:30:00Z', body: 'bot says' }),
  review({ id: 'r-ok', state: 'approved', commit: 'c3', at: '2026-01-05T11:00:00Z' }),
  review({ id: 'r-own', author: 'dev-one', commit: 'c0', at: '2026-01-05T08:00:00Z' }),
];
const inline = [inlineComment({ id: 'i1', commit: 'c2', at: '2026-01-05T10:00:00Z' })];
const comments = [general({ id: 'g1', at: '2026-01-05T09:00:00Z', body: 'ready' })];

test('the first review by a person sets the head', () => {
  assert.deepEqual(firstReviewedHead(pr, reviews, inline), { head: 'c2', at: '2026-01-05T10:00:00Z', byPerson: true });
});

test('a review without a commit does not set the head', () => {
  const noCommit = [review({ commit: null, at: '2026-01-05T08:00:00Z' }), ...reviews];
  assert.equal(firstReviewedHead(pr, noCommit, inline).head, 'c2');
});

test('nobody reviewed: the last head, at the merge time', () => {
  assert.deepEqual(firstReviewedHead(pr, [], []), { head: pr.headSha, at: pr.mergedAt, byPerson: false });
});

const listed = (pullRequests: MergedPullRequest[], pageLimitReached = false) => ({ pullRequests, pageLimitReached });

function stub(over: Partial<HistorySource> = {}): HistorySource {
  return {
    listMergedPullRequests: async () => listed([pr]),
    listReviews: async () => reviews,
    listInlineComments: async () => inline,
    listGeneralComments: async () => comments,
    pullRequest: async () => null,
    compare: async (_repo, _base, head) => (head === 'c2'
      ? { mergeBase: 'mb1', files: [] }
      : { mergeBase: 'mb2', files: [{ path: 'src/cart.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' }] }),
    ...over,
  };
}

test('an imported case carries both bases, the final patches and the activity in time order', async () => {
  const out = await importPullRequest(repo, pr, stub());
  assert.ok('case' in out);
  assert.equal(out.case.repo, 'acme/shop');
  assert.equal(out.case.review_head, 'c2');
  assert.equal(out.case.review_at, '2026-01-05T10:00:00Z');
  assert.equal(out.case.reviewed_by_person, true);
  assert.equal(out.case.review_base, 'mb1');
  assert.equal(out.case.final_head, 'c4');
  assert.equal(out.case.final_base, 'mb2');
  assert.equal(out.case.final_files[0]!.patch, '@@ -1 +1 @@\n-a\n+b');
  assert.deepEqual(out.case.activity.map((a) => a.kind), ['review', 'comment', 'review', 'inline', 'review']);
  assert.deepEqual(out.case.activity.map((a) => a.id), ['r-own', 'g1', 'r-bot', 'i1', 'r-ok']);
  assert.equal(out.case.activity.find((a) => a.id === 'r-bot')!.bot, true);
});

test('items with the same time keep the order comments, reviews, inline comments; an empty review is kept', async () => {
  const at = '2026-01-05T10:00:00Z';
  const out = await importPullRequest(repo, pr, stub({
    listReviews: async () => [review({ id: 'r1', at, body: '' })],
    listInlineComments: async () => [inlineComment({ id: 'i1', at })],
    listGeneralComments: async () => [general({ id: 'g1', at })],
  }));
  assert.ok('case' in out);
  assert.deepEqual(out.case.activity.map((a) => a.id), ['g1', 'r1', 'i1']);
  assert.equal(out.case.activity[1]!.body, '');
});

test('a head that can no longer be read skips the pull request', async () => {
  assert.deepEqual(await importPullRequest(repo, pr, stub({ compare: async () => null })), { skipped: 'head_unreadable' });
  assert.deepEqual(await importPullRequest(repo, pr, stub({ compare: async (_r, _b, head) => (head === 'c4' ? null : { mergeBase: 'm', files: [] }) })), { skipped: 'head_unreadable' });
});

test('source limits skip the pull request under their names and other errors are thrown', async () => {
  const failing = (code: string): Partial<HistorySource> => ({ compare: async () => { throw new Error(code); } });
  assert.deepEqual(await importPullRequest(repo, pr, stub(failing('too_many_files'))), { skipped: 'too_many_files' });
  assert.deepEqual(await importPullRequest(repo, pr, stub(failing('github_too_many_pages'))), { skipped: 'too_many_pages' });
  assert.deepEqual(await importPullRequest(repo, pr, stub({ listGeneralComments: async () => { throw new Error('github_too_many_pages'); } })), { skipped: 'too_many_pages' });
  await assert.rejects(importPullRequest(repo, pr, stub(failing('github_500'))), /github_500/);
});

test('long bodies are cut and control characters removed', async () => {
  const out = await importPullRequest({ ...repo }, { ...pr, description: 'd'.repeat(5000) }, stub({
    listGeneralComments: async () => [general({ id: 'g1', body: 'a\u200bb' + 'x'.repeat(5000) })],
  }));
  assert.ok('case' in out);
  assert.equal(out.case.body.length, 4000);
  const body = out.case.activity.find((a) => a.id === 'g1')!.body;
  assert.equal(body.length, 2000);
  assert.equal(body.startsWith('ab'), true);
});

const window = { since: '2026-01-01', until: '2026-02-01' };
function tempFile(): string { return join(mkdtempSync(tmpdir() + '/'), 'history.jsonl'); }

test('runImport writes one line per imported pull request and prints the counts', async () => {
  const outFile = tempFile();
  const pr2 = { ...pr, number: 13 };
  const pr3 = { ...pr, number: 14 };
  const calls: number[] = [];
  const lines: string[] = [];
  await runImport({ repo, ...window, maxPrs: 200, outFile }, stub({
    listMergedPullRequests: async () => listed([pr, pr2, pr3]),
    listReviews: async (_r, n) => { calls.push(n); return reviews; },
    compare: async (_r, _b, head) => (head === 'c4' && calls.at(-1) === 14 ? null : { mergeBase: 'mb', files: [] }),
  }), (l) => lines.push(l));
  assert.deepEqual(parseHistory(readFileSync(outFile, 'utf8')).map((c) => c.pr_number), [12, 13]);
  assert.deepEqual(calls, [12, 13, 14]);
  assert.deepEqual(lines, ['pull requests 3, written 2, skipped 1', 'head_unreadable 1']);
});

test('runImport says when the limit was reached', async () => {
  const lines: string[] = [];
  await runImport({ repo, ...window, maxPrs: 1, outFile: tempFile() }, stub(), (l) => lines.push(l));
  assert.deepEqual(lines, ['pull requests 1, written 1, skipped 0', 'the limit of 1 pull requests was reached; older ones in the window were not read']);
});

test('runImport imports one pull request at a time', async () => {
  let running = 0;
  let peak = 0;
  await runImport({ repo, ...window, maxPrs: 200, outFile: tempFile() }, stub({
    listMergedPullRequests: async () => listed([pr, { ...pr, number: 13 }]),
    listReviews: async () => { running += 1; peak = Math.max(peak, running); await new Promise((r) => { setTimeout(r, 5); }); running -= 1; return []; },
  }), () => {});
  assert.equal(peak, 1);
});

test('runImport with nothing to import writes an empty file', async () => {
  const outFile = tempFile();
  const lines: string[] = [];
  await runImport({ repo, ...window, maxPrs: 200, outFile }, stub({ listMergedPullRequests: async () => listed([]) }), (l) => lines.push(l));
  assert.equal(existsSync(outFile), true);
  assert.equal(readFileSync(outFile, 'utf8'), '');
  assert.deepEqual(lines, ['pull requests 0, written 0, skipped 0']);
});

test('runImport creates the file, and a missing parent directory, before the first request', async () => {
  const outFile = join(mkdtempSync(tmpdir() + '/'), 'nested', 'deeper', 'history.jsonl');
  let existedAtFirstRead: boolean | null = null;
  await runImport({ repo, ...window, maxPrs: 200, outFile }, stub({
    listReviews: async () => { existedAtFirstRead ??= existsSync(outFile); return []; },
  }), () => {});
  assert.equal(existedAtFirstRead, true);
});

test('runImport empties an existing file before the first request', async () => {
  const outFile = tempFile();
  writeFileSync(outFile, 'old\n');
  let contentAtFirstRead: string | null = null;
  await runImport({ repo, ...window, maxPrs: 200, outFile }, stub({
    listMergedPullRequests: async () => listed([pr]),
    listReviews: async () => { contentAtFirstRead ??= readFileSync(outFile, 'utf8'); return []; },
  }), () => {});
  assert.equal(contentAtFirstRead, '');
});

test('a failure in the middle keeps the lines written before it', async () => {
  const outFile = tempFile();
  await assert.rejects(runImport({ repo, ...window, maxPrs: 200, outFile }, stub({
    listMergedPullRequests: async () => listed([pr, { ...pr, number: 13 }, { ...pr, number: 14 }]),
    listReviews: async (_r, n) => { if (n === 14) throw new Error('github_500'); return []; },
  }), () => {}), /github_500/);
  assert.deepEqual(parseHistory(readFileSync(outFile, 'utf8')).map((c) => c.pr_number), [12, 13]);
});

test('runImport says when the listing stopped at its page limit', async () => {
  const lines: string[] = [];
  await runImport({ repo, ...window, maxPrs: 200, outFile: tempFile() }, stub({ listMergedPullRequests: async () => listed([pr], true) }), (l) => lines.push(l));
  assert.equal(lines.at(-1), 'the listing stopped at its page limit; older pull requests in the window were not read');
  const quiet: string[] = [];
  await runImport({ repo, ...window, maxPrs: 200, outFile: tempFile() }, stub(), (l) => quiet.push(l));
  assert.ok(!quiet.some((l) => l.includes('page limit')));
});

test('a dangling link at the output path is replaced, never followed', async () => {
  const outFile = join(mkdtempSync(tmpdir() + '/'), 'history.jsonl');
  const target = join(mkdtempSync(tmpdir() + '/'), 'elsewhere.jsonl');
  symlinkSync(target, outFile);
  await runImport({ repo, ...window, maxPrs: 200, outFile }, stub(), () => {});
  assert.equal(lstatSync(outFile).isFile(), true);
  assert.equal(existsSync(target), false);
  assert.equal(parseHistory(readFileSync(outFile, 'utf8')).length, 1);
});

test('a description is written to the file as it was sent, cut at 4,000 characters, so a revert is read there as the service reads it', async () => {
  const zeroWidth = String.fromCodePoint(0x200b);
  const lineSeparator = String.fromCodePoint(0x2028);
  const descriptions = [
    `Reverts acme/shop#7${zeroWidth}`,
    'Reverts acme/shop#7\r3',
    `Reverts acme/shop#7${lineSeparator}3`,
    `${zeroWidth}\r\nReverts acme/shop#7\r\n`,
    `Reverts acme/shop#7${lineSeparator}` + `x${zeroWidth}\r`.repeat(2_000),
  ];
  const outFile = tempFile();
  const prs = descriptions.map((description, i) => ({ ...pr, number: 20 + i, description }));
  await runImport({ repo, ...window, maxPrs: 200, outFile }, stub({ listMergedPullRequests: async () => listed(prs) }), () => {});
  const raw = readFileSync(outFile, 'utf8');
  const bodies = parseHistory(raw).map((c) => c.body);
  assert.deepEqual(bodies, descriptions.map((d) => d.slice(0, 4000)));
  for (const body of bodies) assert.ok(raw.includes(JSON.stringify(body)));
  assert.deepEqual(bodies.map((b) => revertedNumber(b, repo)), descriptions.map((d) => revertedNumber(d, repo)));
  assert.deepEqual(bodies.map((b) => revertedNumber(b, repo)), [null, 7, 7, null, 7]);
});
