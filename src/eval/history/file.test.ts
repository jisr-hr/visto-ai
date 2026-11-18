import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { historyKey, loadHistory, parseHistory, serializeCase } from './file.ts';
import type { HistoryCase } from './file.ts';

function makeCase(number: number): HistoryCase {
  return {
    version: 1, repo: 'acme/shop', pr_number: number, title: 'Add cart totals', body: 'Adds totals.', author: 'dev-one',
    branch: 'cart-totals', base_branch: 'main', merged_at: '2026-01-06T12:00:00Z',
    review_head: '0123456789abcdef0123456789abcdef01234567', review_base: 'mb1', review_at: '2026-01-05T10:00:00Z', reviewed_by_person: true,
    final_head: 'fedcba9876543210fedcba9876543210fedcba98', final_base: 'mb2',
    final_files: [
      { path: 'src/cart.ts', previous_path: null, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
      { path: 'img/logo.png', previous_path: 'img/old.png', status: 'renamed', patch: null },
    ],
    activity: [
      { kind: 'comment', id: 'g1', author: 'dev-one', bot: false, association: 'owner', at: '2026-01-05T09:00:00Z', body: 'ready' },
      { kind: 'review', id: 'r1', author: 'dev-two', bot: false, association: 'member', at: '2026-01-05T11:00:00Z', body: '', state: 'approved', commit: 'c3' },
      {
        kind: 'inline', id: 'i1', author: 'dev-two', bot: false, association: 'member', at: '2026-01-05T10:00:00Z', body: 'rename this',
        commit: 'c2', path: 'src/cart.ts', side: 'RIGHT', line: 4, start_line: null, file_level: false, reply_to: null,
      },
    ],
  };
}

test('the file round-trips, and a bad line names its number', () => {
  const c1 = makeCase(12);
  const c2 = makeCase(13);
  assert.deepEqual(parseHistory([serializeCase(c1), serializeCase(c2)].join('\n') + '\n'), [c1, c2]);
  assert.throws(() => parseHistory(serializeCase(c1) + '\n{"version":2}\n'), /bad_history_line_2/);
  assert.throws(() => parseHistory(serializeCase(c1) + '\nnot json\n'), /^Error: bad_history_line_2$/);
});

test('a case with a wrong field type is refused without echoing the value', () => {
  const line = JSON.stringify({ ...makeCase(1), pr_number: 'secret-value' });
  assert.throws(() => parseHistory(line), (e: Error) => e.message === 'bad_history_line_1' && !('cause' in e));
});

test('historyKey', () => assert.equal(historyKey(makeCase(12)), 'acme/shop#12@0123456789ab'));

test('serializeCase is one line and writes keys in the interface order', () => {
  const line = serializeCase(makeCase(12));
  assert.equal(line.includes('\n'), false);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).slice(0, 4), ['version', 'repo', 'pr_number', 'title']);
  assert.equal(Object.keys(parsed).at(-1), 'activity');
  const shuffled = { ...makeCase(12) };
  const reordered = Object.fromEntries(Object.entries(shuffled).reverse()) as unknown as HistoryCase;
  assert.equal(serializeCase(reordered), line);
  const inline = (JSON.parse(line) as { activity: Record<string, unknown>[] }).activity[2]!;
  assert.deepEqual(Object.keys(inline), ['kind', 'id', 'author', 'bot', 'association', 'at', 'body', 'commit', 'path', 'side', 'line', 'start_line', 'file_level', 'reply_to']);
});

test('loadHistory hashes the bytes of the file', () => {
  const dir = mkdtempSync(tmpdir() + '/');
  const text = serializeCase(makeCase(12)) + '\n';
  writeFileSync(join(dir, 'h.jsonl'), text);
  const { cases, sha256 } = loadHistory(join(dir, 'h.jsonl'));
  assert.equal(cases.length, 1);
  assert.equal(sha256, createHash('sha256').update(readFileSync(join(dir, 'h.jsonl'))).digest('hex'));
});
