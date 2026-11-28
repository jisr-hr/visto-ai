import assert from 'node:assert/strict';
import test from 'node:test';

import { findingsText, parseFindings } from './findings.ts';
import type { ExportedFinding, FindingsFile } from './findings.ts';

const finding = (over: Partial<ExportedFinding> = {}): ExportedFinding => ({
  repo: 'acme/shop', pr_number: 7,
  run: { id: 1, head_sha: 'h1', base_sha: 'b1', started_at: '2026-03-09T10:00:00.000Z' },
  comment_id: 'c-1', path: 'src/a.ts', side: 'RIGHT', line: 10, severity: 'major', finding: 'Rounds too early.',
  replies: [{ id: 'r-1', order: 4, association: 'member', body: 'On purpose.', at: '2026-03-10T10:00:00.000Z' }, { id: 'r-2', order: 5, association: null, body: 'Same.', at: '2026-03-10T11:00:00.000Z' }],
  later: [{ run: 2, started_at: '2026-03-11T10:00:00.000Z', published_at: '2026-03-11T10:01:00.000Z', verdict: 'open' }, { run: 3, started_at: '2026-03-12T10:00:00.000Z', published_at: null, verdict: 'fixed' }],
  ...over,
});
const FILE: FindingsFile = { exported_at: '2026-03-20T08:00:00.000Z', findings: [finding(), finding({ comment_id: 'c-2', line: null, finding: null, replies: [], later: [] })] };

test('a findings file reads back what was written, and a bad line is named by its number only', () => {
  const text = findingsText(FILE);
  assert.deepEqual(parseFindings(text), FILE);
  assert.equal(text.split('\n')[0], '{"version":1,"kind":"findings_export","exported_at":"2026-03-20T08:00:00.000Z"}');
  assert.ok(text.split('\n')[1]!.startsWith('{"version":1,"repo":"acme/shop"'));
  assert.equal(findingsText(parseFindings(text)), text);
  const lines = text.split('\n');
  lines[2] = JSON.stringify({ ...JSON.parse(lines[2]!) as object, line: 'secret-line-text' });
  assert.throws(() => parseFindings(lines.join('\n')), (error: unknown) => error instanceof Error && error.message === 'bad_findings_line_3');
  assert.throws(() => parseFindings(text.replace('"version":1,"repo"', '"version":2,"repo"')), { message: 'bad_findings_line_2' });
  assert.throws(() => parseFindings(`${lines[0]}\nnot json at all`), (error: unknown) => error instanceof Error && error.message === 'bad_findings_line_2');
});

test('a findings file without its header, or with two, is refused', () => {
  const [header, one] = findingsText(FILE).split('\n') as [string, string];
  assert.throws(() => parseFindings(`${one}\n`), { message: 'bad_findings_line_1' });
  assert.throws(() => parseFindings(''), { message: 'bad_findings_line_1' });
  assert.throws(() => parseFindings(`${header}\n${one}\n${header}\n`), { message: 'bad_findings_line_3' });
  assert.throws(() => parseFindings(`${header}\n${header}\n`), { message: 'bad_findings_line_2' });
  assert.deepEqual(parseFindings(`${header}\n`), { exported_at: FILE.exported_at, findings: [] });
});
