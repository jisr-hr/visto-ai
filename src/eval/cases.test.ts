import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { caseKey, loadCases, parseCases } from './cases.ts';

const caseA = {
  repo: 'acme/shop',
  pr_number: 7,
  head_sha: 'abcdef0123456789abcdef0123456789abcdef01',
  compare_base: '0123456789abcdef0123456789abcdef01234567',
  labels: [{ path: 'src/cart.ts', label: 'valid' }],
};

function badLine(text: string): string {
  try {
    parseCases(text);
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal('cause' in error, false);
    return error.message;
  }
  return 'no error';
}

test('unknown keys in a case are ignored and the key is stable', () => {
  const [c] = parseCases(JSON.stringify({ ...caseA, some_other_field: 'x' }) + '\n');
  assert.equal(caseKey(c!), 'acme/shop#7@abcdef012345');
});

test('defaults are applied to optional case and label fields', () => {
  const [c] = parseCases(JSON.stringify(caseA));
  assert.deepEqual(c, {
    repo: 'acme/shop', pr_number: 7, head_sha: caseA.head_sha, compare_base: caseA.compare_base,
    title: '', body: '', branch: '', base_branch: '', author: '',
    labels: [{ comment_id: '', path: 'src/cart.ts', line: null, side: 'RIGHT', severity: '', label: 'valid' }],
  });
});

test('optional label fields are kept when present', () => {
  const label = { comment_id: 'k1', path: 'a.ts', line: 4, side: 'LEFT', severity: 'major', label: 'late', tolerance: 5, first_head: true, same_head: false };
  const [c] = parseCases(JSON.stringify({ ...caseA, labels: [label], review_round: 2 }));
  assert.deepEqual(c!.labels, [label]);
  assert.equal(c!.review_round, 2);
});

test('blank lines are skipped but counted in the numbering', () => {
  const text = `\n${JSON.stringify(caseA)}\n\n   \n${JSON.stringify({ ...caseA, pr_number: 8 })}\n`;
  assert.deepEqual(parseCases(text).map((c) => c.pr_number), [7, 8]);
  assert.equal(badLine(`${JSON.stringify(caseA)}\n\n{nope`), 'bad_case_line_3');
});

test('a bad line throws only its number, never its content', () => {
  assert.equal(badLine('not json at all secret-token-123'), 'bad_case_line_1');
  assert.equal(badLine(JSON.stringify({ ...caseA, pr_number: 'seven' })), 'bad_case_line_1');
  assert.equal(badLine(JSON.stringify({ ...caseA, pr_number: 7.5 })), 'bad_case_line_1');
  assert.equal(badLine(JSON.stringify({ ...caseA, labels: 'x' })), 'bad_case_line_1');
  assert.equal(badLine(JSON.stringify({ ...caseA, labels: [{ path: 'a.ts', label: 'weird' }] })), 'bad_case_line_1');
  assert.equal(badLine(JSON.stringify({ ...caseA, labels: [{ label: 'valid' }] })), 'bad_case_line_1');
  assert.equal(badLine('[1,2]'), 'bad_case_line_1');
  const missing: Record<string, unknown> = { ...caseA };
  delete missing['head_sha'];
  assert.equal(badLine(`${JSON.stringify(caseA)}\n${JSON.stringify(missing)}`), 'bad_case_line_2');
});

test('loadCases returns the cases and the sha-256 of the file bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-cases-'));
  const file = join(dir, 'cases.jsonl');
  const text = JSON.stringify(caseA) + '\n';
  writeFileSync(file, text);
  const loaded = loadCases(file);
  assert.equal(loaded.cases.length, 1);
  assert.equal(loaded.sha256, createHash('sha256').update(Buffer.from(text)).digest('hex'));
  assert.match(loaded.sha256, /^[0-9a-f]{64}$/);
});

test('parseCases keeps text and start_line on a label', () => {
  const label = { comment_id: 'k1', path: 'a.ts', line: 6, side: 'RIGHT', severity: '', label: 'valid', text: 'Check the total.', start_line: 4 };
  const [c] = parseCases(JSON.stringify({ ...caseA, labels: [label] }));
  assert.deepEqual(c!.labels, [label]);
});

test('parseCases refuses a start_line that is not an integer', () => {
  for (const start_line of ['4', 4.5, null]) {
    assert.equal(badLine(JSON.stringify({ ...caseA, labels: [{ path: 'a.ts', label: 'valid', start_line }] })), 'bad_case_line_1');
  }
  assert.equal(badLine(JSON.stringify({ ...caseA, labels: [{ path: 'a.ts', label: 'valid', text: 5 }] })), 'bad_case_line_1');
});

test('a case file reads a review_at when there is one, and refuses one that is no time', () => {
  const [kept] = parseCases(JSON.stringify({ ...caseA, review_at: '2026-03-04T10:00:00Z' }));
  assert.equal(kept!.review_at, '2026-03-04T10:00:00Z');
  const [plain] = parseCases(JSON.stringify(caseA));
  assert.equal('review_at' in plain!, false);
  assert.equal(badLine(JSON.stringify({ ...caseA, review_at: 'soon' })), 'bad_case_line_1');
  assert.equal(badLine(JSON.stringify({ ...caseA, review_at: 5 })), 'bad_case_line_1');
});
