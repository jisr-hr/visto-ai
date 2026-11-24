import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Comparison, HistorySource, MergedPullRequest } from '../../forge/types.ts';
import { parseCases } from '../cases.ts';
import { parseHistory, serializeCase } from '../history/file.ts';
import { parseAacr, runAacrImport, toEvalCase, toHistoryCase } from './convert.ts';
import type { AacrRecord } from './convert.ts';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);

const comment = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  path: 'src/cart.ts', side: 'right', from_line: '4', to_line: '6', note: 'The total ignores the discount.', ...over,
});
const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  githubPrUrl: 'https://github.com/acme/shop/pull/12', source_commit: BASE, target_commit: HEAD,
  created_at: '2026-01-05T09:00:00Z', merged_at: '2026-01-06T12:00:00Z', comments: [comment()], extra: 'ignored', ...over,
});
const file = (...records: Record<string, unknown>[]): string => JSON.stringify(records);

const pr: MergedPullRequest = {
  number: 12, title: 'Add cart totals', description: 'Adds totals.', author: 'dev-one', authorIsBot: false,
  baseBranch: 'main', headBranch: 'cart-totals', baseSha: BASE, headSha: HEAD, mergedAt: '2026-01-06T12:00:00Z',
};

function record(): AacrRecord {
  const { records } = parseAacr(file(raw({ comments: [comment(), comment({ path: 'src/tax.ts', from_line: 2, to_line: 2, note: 'Round once.' })] })));
  return records[0]!;
}

test('parseAacr reads integer strings and upper-cases the side', () => {
  const { records, skipped } = parseAacr(file(raw()));
  assert.deepEqual(skipped, { bad_record: 0, bad_comment: 0, duplicate: 0 });
  assert.deepEqual(records, [{
    url: 'https://github.com/acme/shop/pull/12', owner: 'acme', repo: 'shop', number: 12, base: BASE, head: HEAD,
    createdAt: '2026-01-05T09:00:00Z', mergedAt: '2026-01-06T12:00:00Z',
    comments: [{ path: 'src/cart.ts', side: 'RIGHT', fromLine: 4, toLine: 6, text: 'The total ignores the discount.' }],
  }]);
});

test('parseAacr reorders reversed lines', () => {
  const { records } = parseAacr(file(raw({ comments: [comment({ from_line: 9, to_line: 5 })] })));
  assert.equal(records[0]!.comments[0]!.fromLine, 5);
  assert.equal(records[0]!.comments[0]!.toLine, 9);
});

test('parseAacr skips one bad comment, not the record', () => {
  const { records, skipped } = parseAacr(file(raw({ comments: [comment({ to_line: 'x' }), comment()] })));
  assert.equal(records[0]!.comments.length, 1);
  assert.deepEqual(skipped, { bad_record: 0, bad_comment: 1, duplicate: 0 });
});

test('parseAacr skips the comments that are not usable', () => {
  const bad = [
    comment({ note: '' }), comment({ path: '' }), comment({ side: 'both' }), comment({ from_line: 0 }), comment({ to_line: -3 }),
    comment({ from_line: 1.5 }), comment({ to_line: '2.5' }), comment({ to_line: null }),
  ];
  const { skipped } = parseAacr(file(raw({ comments: [...bad, comment({ side: 'LEFT' })] })));
  assert.equal(skipped.bad_comment, bad.length);
  assert.equal(skipped.bad_record, 0);
});

test('parseAacr skips a record with no usable comment', () => {
  const { records, skipped } = parseAacr(file(raw({ comments: [comment({ note: '' })] })));
  assert.deepEqual(records, []);
  assert.equal(skipped.bad_record, 1);
});

test('parseAacr skips a record with a bad url, commit or date', () => {
  const { records, skipped } = parseAacr(file(
    raw({ githubPrUrl: 'https://example.com/acme/shop/pull/12' }), raw({ githubPrUrl: 'https://github.com/acme/shop/issues/12' }),
    raw({ source_commit: 'abc' }), raw({ target_commit: 'Z'.repeat(40) }), raw({ created_at: '' }), raw({ merged_at: undefined }),
    raw({ comments: 'none' }), 'text' as unknown as Record<string, unknown>,
    raw({ githubPrUrl: 'https://github.com/./shop/pull/12' }), raw({ githubPrUrl: 'https://github.com/acme/../pull/12' }),
    raw({ githubPrUrl: 'https://github.com/../shop/pull/12' }), raw({ githubPrUrl: 'https://github.com/acme/./pull/12' }),
  ));
  assert.deepEqual(records, []);
  assert.equal(skipped.bad_record, 12);
});

test('parseAacr sorts by the hash of url and head', () => {
  const urls = [1, 2, 3, 4].map((n) => `https://github.com/acme/shop/pull/${n}`);
  const { records } = parseAacr(file(...urls.map((githubPrUrl) => raw({ githubPrUrl }))));
  const hash = (u: string): string => createHash('sha256').update(`${u}@${HEAD}`).digest('hex');
  assert.deepEqual(records.map((r) => r.url), [...urls].sort((a, b) => (hash(a) < hash(b) ? -1 : 1)));
});

test('parseAacr refuses a file that is not an array', () => {
  assert.throws(() => parseAacr('{"a":1}'), { message: 'bad_aacr_file' });
  assert.throws(() => parseAacr('not json'), { message: 'bad_aacr_file' });
});

test('parseAacr keeps the first of two records with the same url and head', () => {
  const { records, skipped } = parseAacr(file(raw(), raw({ comments: [comment({ note: 'Another.' })] })));
  assert.equal(records.length, 1);
  assert.equal(records[0]!.comments[0]!.text, 'The total ignores the discount.');
  assert.equal(skipped.duplicate, 1);
});

test('parseAacr treats a trailing slash and another letter case as the same pull request', () => {
  const { records, skipped } = parseAacr(file(
    raw({ githubPrUrl: 'https://github.com/acme/shop/pull/12' }), raw({ githubPrUrl: 'https://github.com/acme/shop/pull/12/' }),
    raw({ githubPrUrl: 'https://github.com/Acme/Shop/pull/12' }), raw({ target_commit: 'B'.repeat(40) }),
  ));
  assert.equal(records.length, 1);
  assert.equal(skipped.duplicate, 3);
});

test('toEvalCase maps a comment to a valid label', () => {
  const c = toEvalCase(record(), pr, MERGE_BASE);
  assert.equal(c.compare_base, MERGE_BASE);
  assert.equal(c.head_sha, HEAD);
  assert.deepEqual([c.repo, c.pr_number, c.title, c.body, c.author, c.branch, c.base_branch],
    ['acme/shop', 12, 'Add cart totals', 'Adds totals.', 'dev-one', 'cart-totals', 'main']);
  assert.deepEqual(c.labels[0], {
    comment_id: 'aacr-1', path: 'src/cart.ts', line: 6, side: 'RIGHT', severity: '', label: 'valid', tolerance: 5,
    text: 'The total ignores the discount.', start_line: 4,
  });
  assert.equal(c.labels[1]!.comment_id, 'aacr-2');
  assert.equal(c.labels[1]!.tolerance, 3);
});

test('toEvalCase cuts the text at 2000 characters', () => {
  const long = parseAacr(file(raw({ comments: [comment({ note: 'x'.repeat(2500) })] }))).records[0]!;
  assert.equal(toEvalCase(long, pr, MERGE_BASE).labels[0]!.text!.length, 2000);
});

test('toHistoryCase writes one inline comment per reference on the head', () => {
  const r = record();
  const c = toHistoryCase(r, pr, MERGE_BASE);
  assert.equal(c.review_head, HEAD);
  assert.equal(c.final_head, HEAD);
  assert.equal(c.review_base, MERGE_BASE);
  assert.equal(c.final_base, MERGE_BASE);
  assert.deepEqual(c.final_files, []);
  assert.equal(c.review_at, r.createdAt);
  assert.equal(c.merged_at, r.mergedAt);
  assert.equal(c.reviewed_by_person, true);
  assert.deepEqual(c.activity[0], {
    kind: 'inline', id: 'aacr-1', author: 'aacr-reference', bot: false, association: 'member', at: r.createdAt,
    body: 'The total ignores the discount.', commit: HEAD, path: 'src/cart.ts', side: 'RIGHT', line: 6, start_line: 4,
    file_level: false, reply_to: null,
  });
  assert.equal(c.activity.length, 2);
  assert.deepEqual(parseHistory(serializeCase(c)), [c]);
});

function stub(over: Partial<HistorySource>): HistorySource {
  const unused = (): never => { throw new Error('unused'); };
  return {
    listMergedPullRequests: unused, listReviews: unused, listInlineComments: unused, listGeneralComments: unused,
    pullRequest: async () => pr, compare: async () => ({ mergeBase: MERGE_BASE, files: [] }), ...over,
  };
}

const outDir = mkdtempSync(join(tmpdir(), 'aacr-'));

function five(): AacrRecord[] {
  const { records } = parseAacr(file(...[1, 2, 3, 4, 5, 6].map((n) => raw({ githubPrUrl: `https://github.com/acme/shop/pull/${n}`, target_commit: String(n).repeat(40) }))));
  return records;
}

test('runAacrImport counts each skip', async () => {
  const records = five();
  const urlOfHead = (head: string): number => records.find((r) => r.head === head)!.number;
  const source = stub({
    pullRequest: async (_repo, number) => {
      if (number === 1) return null;
      if (number === 2) throw new Error('github_404');
      return pr;
    },
    compare: async (_repo, _base, head): Promise<Comparison | null> => {
      const n = urlOfHead(head);
      if (n === 3) return null;
      if (n === 4) throw new Error('too_many_files');
      if (n === 6) throw new Error('github_422');
      return { mergeBase: MERGE_BASE, files: [] };
    },
  });
  const casesOut = join(outDir, 'a-cases.jsonl');
  const historyOut = join(outDir, 'a-history.jsonl');
  writeFileSync(casesOut, 'stale\n');
  const result = await runAacrImport({ records, source, casesOut, historyOut });
  assert.deepEqual(result, { written: 1, skipped: { pr_unreadable: 2, head_unreadable: 2, too_many_files: 1 } });
  const caseLines = readFileSync(casesOut, 'utf8').trim().split('\n');
  const historyLines = readFileSync(historyOut, 'utf8').trim().split('\n');
  assert.equal(caseLines.length, 1);
  assert.equal(historyLines.length, 1);
  assert.equal(parseCases(readFileSync(casesOut, 'utf8'))[0]!.compare_base, MERGE_BASE);
  assert.equal(parseHistory(readFileSync(historyOut, 'utf8'))[0]!.review_base, MERGE_BASE);
});

test('runAacrImport ends on any other rejection', async () => {
  const source = stub({ compare: async () => { throw new Error('github_network'); } });
  await assert.rejects(
    runAacrImport({ records: five(), source, casesOut: join(outDir, 'b-cases.jsonl'), historyOut: join(outDir, 'b-history.jsonl') }),
    { message: 'github_network' },
  );
  assert.equal(existsSync(join(outDir, 'b-cases.jsonl')), true);
});

test('runAacrImport ends when pullRequest rejects with anything but a status', async () => {
  const source = stub({ pullRequest: async () => { throw new Error('github_network'); } });
  await assert.rejects(
    runAacrImport({ records: five(), source, casesOut: join(outDir, 'c-cases.jsonl'), historyOut: join(outDir, 'c-history.jsonl') }),
    { message: 'github_network' },
  );
});
