import test from 'node:test';
import assert from 'node:assert/strict';
import { fitBody, MAX_BODY_CHARS, renderReview } from './body.ts';
import type { Finding, NotReviewed, RawFinding, ReviewResult, UnplacedFinding } from '../types.ts';

const usage = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
const finding = (over: Partial<Finding> = {}): Finding => ({
  path: 'src/a.ts', side: 'RIGHT', line: 10, severity: 'major', body: 'Breaks on empty input.', quote: 'q', requestedLine: null, ...over,
});
const unplaced = (over: Partial<UnplacedFinding> = {}): UnplacedFinding => ({
  path: 'src/b.ts', side: 'RIGHT', line: 4, severity: 'minor', body: 'Name is unclear.', quote: 'q', reason: 'line_not_in_diff', ...over,
});
const beyond = (over: Partial<RawFinding> = {}): RawFinding => ({
  path: 'src/c.ts', side: 'RIGHT', line: 7, severity: 'minor', body: 'Caller ignores the error.', quote: 'q', beyond_diff: true, ...over,
});
const result = (over: Partial<ReviewResult> = {}): ReviewResult => ({
  status: 'ok', failure: null, mode: 'full', overview: 'Changes a.ts.', findings: [], unplaced: [], beyondDiff: [],
  coverage: { reviewed: [], notReviewed: [] }, usage, models: [], providers: [], dependencies: { model: 'ok' }, audit: [], ...over,
});
const auto = { trigger: 'automatic', requestedBy: null } as const;
const notReviewed = (n: number): NotReviewed[] =>
  (['no_diff', 'too_large', 'over_batch_limit', 'batch_failed'] as const).slice(0, n).map((reason, i) => ({ path: `f${i}.bin`, reason }));
const full = result({
  findings: [finding({ severity: 'blocker', line: 3 }), finding({ line: 5 }), finding({ line: 6, requestedLine: 15 })],
  unplaced: [unplaced({ side: 'LEFT' })],
  beyondDiff: [beyond()],
  coverage: { reviewed: ['src/a.ts'], notReviewed: notReviewed(3) },
});

test('no findings', () => {
  assert.match(renderReview(result(), auto).body, /## Summary\n\nChanges a\.ts\.\n\n## Overall\n\nNo findings\.$/);
  assert.equal(renderReview(result(), auto).body, '## Summary\n\nChanges a.ts.\n\n## Overall\n\nNo findings.');
});
test('an empty overview leaves the summary out', () => {
  assert.equal(renderReview(result({ overview: '  ' }), auto).body, '## Overall\n\nNo findings.');
});
test('an inline comment carries its tag, and a moved one its note', () => {
  const { comments } = renderReview(result({ findings: [finding({ line: 12, requestedLine: 15 })] }), auto);
  assert.deepEqual(comments, [{ path: 'src/a.ts', side: 'RIGHT', line: 12, body: '**[major]** _(Refers to line 15, just outside the diff.)_ Breaks on empty input.' }]);
});
test('an unmoved comment has no note', () => {
  assert.equal(renderReview(result({ findings: [finding({ severity: 'minor' })] }), auto).comments[0]!.body, '**[minor]** Breaks on empty input.');
});
test('the left side says old line', () => {
  const { comments } = renderReview(result({ findings: [finding({ side: 'LEFT', line: 8, requestedLine: 9 })] }), auto);
  assert.equal(comments[0]!.body, '**[major]** _(Refers to old line 9, just outside the diff.)_ Breaks on empty input.');
  assert.equal(comments[0]!.side, 'LEFT');
});
test('sections appear in order and only when they have content', () => {
  const b = renderReview(full, auto).body;
  const order = ['## Summary', '## Findings', '## Findings not placed on the diff', '## Beyond the diff', '## Coverage', '## Overall'].map((h) => b.indexOf(h + '\n'));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  assert.ok(order.every((i) => i >= 0));
  const bare = renderReview(result(), auto).body;
  for (const h of ['## Findings', '## Beyond the diff', '## Coverage']) assert.equal(bare.includes(h), false);
});
test('the overall line counts', () => {
  assert.match(renderReview(full, auto).body, /1 blocker, 2 major, 0 minor\. 1 could not be placed on the diff\. 3 files were not reviewed\.$/);
});
test('overall: unplaced only, and not-reviewed only', () => {
  assert.match(renderReview(result({ unplaced: [unplaced()] }), auto).body, /## Overall\n\n0 blocker, 0 major, 0 minor\. 1 could not be placed on the diff\.$/);
  assert.match(renderReview(result({ coverage: { reviewed: [], notReviewed: notReviewed(2) } }), auto).body, /## Overall\n\nNo findings\. 2 files were not reviewed\.$/);
  assert.match(renderReview(result({ findings: [finding()], coverage: { reviewed: [], notReviewed: notReviewed(1) } }), auto).body, /0 blocker, 1 major, 0 minor\. 1 files were not reviewed\.$/);
});
test('beyond-the-diff items do not count in the overall line', () => {
  assert.match(renderReview(result({ beyondDiff: [beyond()] }), auto).body, /## Overall\n\nNo findings\.$/);
});
test('finding, unplaced, beyond and coverage bullets have the exact shape', () => {
  const b = renderReview(full, auto).body;
  assert.ok(b.includes('\n- **[blocker]** `src/a.ts:3` \u2014 Breaks on empty input.\n'));
  assert.ok(b.includes('\n- `src/b.ts:4` (old file) \u2014 Name is unclear.\n'));
  assert.ok(b.includes('## Beyond the diff\n\n- **[minor]** `src/c.ts:7` \u2014 Caller ignores the error.\n'));
  assert.ok(b.includes("GitHub cannot show these inline: the line is outside this pull request's diff, or the file has no diff GitHub can comment on. They do not block the merge.\n\n- `src/b.ts:4`"));
  assert.ok(b.includes('## Coverage\n\nThese files were not reviewed:\n\n- `f0.bin`: no_diff\n- `f1.bin`: too_large\n- `f2.bin`: over_batch_limit\n\n## Overall'));
});
test('a right-side unplaced item has no old-file note', () => {
  assert.ok(renderReview(result({ unplaced: [unplaced()] }), auto).body.includes('- `src/b.ts:4` \u2014 Name is unclear.\n'));
});
test('the first line is the first non-empty line, cut to 300 characters', () => {
  const long = '\n\n  ' + 'y'.repeat(400) + '\nsecond';
  const b = renderReview(result({ findings: [finding({ body: long })] }), auto).body;
  assert.ok(b.includes(` \u2014 ${'y'.repeat(299)}\u2026\n`));
  assert.equal(b.includes('second'), false);
});
test('the first-line cut never splits a surrogate pair', () => {
  const b = renderReview(result({ findings: [finding({ body: 'y'.repeat(298) + '\u{1F600}\u{1F600}' })] }), auto).body;
  assert.ok(b.isWellFormed());
});
test('a path with a backtick is shown between double backticks', () => {
  const b = renderReview(result({ findings: [finding({ path: 'a`b.ts' })], beyondDiff: [beyond({ path: 'x`y' })] }), auto).body;
  assert.ok(b.includes('`` a`b.ts:10 `` \u2014'));
  assert.ok(b.includes('`` x`y:7 `` \u2014'));
});
test('a manual run is prefixed', () => {
  assert.match(renderReview(result(), { trigger: 'manual', requestedBy: 'dev-one' }).body, /^\*\*Full review\*\* requested by @dev-one\.\n\n## Summary/);
  assert.match(renderReview(result(), { trigger: 'manual', requestedBy: null }).body, /^\*\*Full review\*\* requested\.\n\n## Summary/);
  assert.doesNotMatch(renderReview(result(), auto).body, /Full review/);
});
test('a long list is capped at 25', () => {
  const many = Array.from({ length: 30 }, (_, i) => unplaced({ line: i + 1 }));
  const b = renderReview(result({ unplaced: many }), auto).body;
  assert.equal((b.match(/^- `src\/b\.ts:/gm) ?? []).length, 25);
  assert.ok(b.includes('\n- \u2026and 5 more.\n'));
  assert.match(b, /30 could not be placed on the diff\.$/);
});
test('the other lists are capped too', () => {
  const nr = Array.from({ length: 27 }, (_, i): NotReviewed => ({ path: `p${i}`, reason: 'no_diff' }));
  const b = renderReview(result({ findings: Array.from({ length: 26 }, (_, i) => finding({ line: i + 1 })), coverage: { reviewed: [], notReviewed: nr } }), auto).body;
  assert.ok(b.includes('- \u2026and 1 more.'));
  assert.ok(b.includes('- \u2026and 2 more.'));
  assert.equal(renderReview(result({ findings: Array.from({ length: 26 }, (_, i) => finding({ line: i + 1 })) }), auto).comments.length, 26);
});
test('renderReview returns a body within the limit', () => {
  const huge = result({ overview: 'x\n'.repeat(60_000), findings: [finding()] });
  const { body } = renderReview(huge, auto);
  assert.ok(body.length <= MAX_BODY_CHARS);
  assert.match(body, /cut to fit GitHub's limit\]_/);
  assert.match(body, /## Overall\n\n0 blocker, 1 major, 0 minor\.$/);
});

const MARKER_RE = /^_\[\u2026 (\d+) characters of the review were cut to fit GitHub's limit\]_$/m;
const OVERALL = '## Overall\n\nNo findings.';
const UNPLACED = "## Findings not placed on the diff\n\nGitHub cannot show these inline.\n\n- `a.ts:9` \u2014 text";

test('a body within the limit is returned unchanged', () => {
  assert.equal(fitBody('## Summary\n\nshort', '', 100), '## Summary\n\nshort');
  assert.equal(fitBody('x'.repeat(100), '', 100), 'x'.repeat(100));
  assert.equal(fitBody('## Summary\n\nshort', OVERALL, 100), `## Summary\n\nshort\n\n${OVERALL}`);
  assert.equal(fitBody('', OVERALL, 100), OVERALL);
});
test('a body over the limit keeps its tail and says how much was cut', () => {
  const out = fitBody('## Summary\n\n' + 'x\n'.repeat(60_000), '## Overall\n\nNo findings.', 1_000);
  assert.ok(out.length <= 1_000);
  assert.match(out, /cut to fit GitHub's limit\]_\n\n## Overall\n\nNo findings\.$/);
});
test('the tail is kept whole after the cut, and the count is exact', () => {
  const head = '## Summary\n\n' + 'x\n'.repeat(2_000) + '\n';
  const tail = `${UNPLACED}\n\n## Coverage\n\nc\n\n${OVERALL}`;
  const out = fitBody(head, tail, 1_000);
  assert.ok(out.length <= 1_000);
  assert.ok(out.endsWith(`\n\n${tail}`));
  const m = out.match(MARKER_RE)!;
  const kept = out.slice(0, m.index).replace(/\n+$/, '');
  assert.ok(head.startsWith(kept));
  assert.match(head.slice(kept.length), /^\s*\n/);
  assert.equal(Number(m[1]), head.length - kept.length);
});
test('a cut never splits an astral character', () => {
  for (const long of [`## Summary\n${'\u{1F600}'.repeat(40_000)}\n\n${OVERALL}`, `## Summary\n${'\u{1F600}'.repeat(40_000)}`]) {
    const out = fitBody(long, '', 1_001);
    assert.ok(out.length <= 1_001);
    assert.ok(out.isWellFormed());
  }
  const withTail = fitBody(`## Summary\n${'\u{1F600}'.repeat(40_000)}`, OVERALL, 1_001);
  assert.ok(withTail.isWellFormed());
  assert.match(withTail, MARKER_RE);
});
test('the count excludes the fence close it adds, and the fence is closed', () => {
  const head = '## Summary\n```ts\n' + 'x\n'.repeat(40_000);
  const long = `${head}\`\`\``;
  const out = fitBody(long, OVERALL, 1_000);
  assert.ok(out.length <= 1_000);
  assert.ok(out.endsWith(`\n\n${OVERALL}`));
  const m = out.match(MARKER_RE)!;
  const before = out.slice(0, m.index).replace(/\n+$/, '');
  assert.ok(before.endsWith('\n```'));
  const kept = before.slice(0, -'\n```'.length);
  assert.ok(long.startsWith(kept));
  assert.equal(Number(m[1]), long.length - kept.length);
  assert.equal((out.match(/^```/gm) ?? []).length % 2, 0);
});
test('a fence left open inside a list item is closed at the same indent', () => {
  const out = fitBody('## Summary\n- item\n  ```ts\n' + '  x\n'.repeat(40_000) + '  ```', OVERALL, 1_000);
  const lines = out.split('\n');
  const at = lines.findIndex((l) => MARKER_RE.test(l));
  assert.ok(at > 1);
  assert.equal(lines[at - 1], '');
  assert.equal(lines[at - 2], '  ```');
});
test('a tail that fits but leaves no room for the head is kept behind the marker, or alone', () => {
  const tail = `## Overall\n\n${'v'.repeat(1_000 - 12 - 90)}`;
  const out = fitBody(`## Summary\n${'h\n'.repeat(500)}`, tail, 1_000);
  assert.ok(out.length <= 1_000);
  assert.ok(out.endsWith(tail));
  const exact = `## Overall\n\n${'v'.repeat(1_000 - 12)}`;
  assert.equal(fitBody(`## Summary\n${'h\n'.repeat(500)}`, exact, 1_000), exact);
});
test('a tail over the limit is cut from the end, with the marker', () => {
  const out = fitBody('## Summary\nshort', `## Overall\n\n${'z'.repeat(5_000)}`, 1_000);
  assert.ok(out.length <= 1_000);
  assert.match(out, /^## Summary\nshort\n/);
  assert.match(out, /cut to fit GitHub's limit\]_$/);
});
test('a body with no tail is cut from the end, and never split mid-pair', () => {
  for (const long of [`## Summary\n${'x'.repeat(5_000)}`, `## Summary\n${'\u{1F600}'.repeat(5_000)}`]) {
    const out = fitBody(long, '', 1_000);
    assert.ok(out.length <= 1_000);
    assert.ok(out.isWellFormed());
    assert.match(out, MARKER_RE);
  }
});
test('the default limit is 65,536', () => {
  assert.equal(MAX_BODY_CHARS, 65_536);
  const out = fitBody('a\n'.repeat(40_000), '');
  assert.ok(out.length <= 65_536);
  assert.equal(fitBody('a'.repeat(65_536), '').length, 65_536);
});

test('a failed review renders only its Overall line, after the manual prefix', () => {
  const failed = result({ status: 'failed', failure: { stage: 'model', code: 'no_credit' }, overview: 'x', findings: [finding()], unplaced: [unplaced()] });
  assert.deepEqual(renderReview(failed, auto), { body: '## Overall\n\nThe review could not be completed (model: no_credit).', comments: [] });
  const manual = renderReview(failed, { trigger: 'manual', requestedBy: 'dev-one' });
  assert.equal(manual.body, '**Full review** requested by @dev-one.\n\n## Overall\n\nThe review could not be completed (model: no_credit).');
  assert.deepEqual(manual.comments, []);
});
test('an Overall line written by the model cannot move the cut', () => {
  const overview = `Intro.\n## Overall\n\nAll fine.\n${'w\n'.repeat(40_000)}`;
  const plain = renderReview(result({ overview, findings: [finding()] }), auto).body;
  assert.ok(plain.length <= MAX_BODY_CHARS);
  assert.match(plain, /cut to fit GitHub's limit\]_\n\n## Overall\n\n0 blocker, 1 major, 0 minor\.$/);
  const withUnplaced = renderReview(result({ overview, findings: [finding()], unplaced: [unplaced()] }), auto).body;
  assert.ok(withUnplaced.length <= MAX_BODY_CHARS);
  assert.ok(withUnplaced.includes('## Findings not placed on the diff\n'));
  assert.ok(withUnplaced.includes('\n- `src/b.ts:4` \u2014 Name is unclear.\n'));
  assert.match(withUnplaced, /\n## Overall\n\n0 blocker, 1 major, 0 minor\. 1 could not be placed on the diff\.$/);
});
test('an HTML comment opener written by the model is neutralised', () => {
  const r = renderReview(result({ overview: 'See <!-- hidden -->.', findings: [finding({ body: 'Bad <!-- x' })], beyondDiff: [beyond({ body: 'Also <!-- y' })] }), auto);
  assert.equal(r.body.includes('<!--'), false);
  assert.ok(r.body.includes('See &lt;!-- hidden -->.'));
  assert.ok(r.body.includes('Bad &lt;!-- x'));
  assert.ok(r.body.includes('Also &lt;!-- y'));
  assert.equal(r.comments[0]!.body, '**[major]** Bad &lt;!-- x');
});
test('a heading line in the overview is escaped', () => {
  const b = renderReview(result({ overview: 'Text.\n## Overall\n   # Title\n    # code\nnot # a heading' }), auto).body;
  assert.ok(b.includes('## Summary\n\nText.\n\\## Overall\n   \\# Title\n    # code\nnot # a heading\n\n## Overall\n\nNo findings.'));
  assert.equal((b.match(/^## Overall$/gm) ?? []).length, 1);
});
test('a path with a newline or a tab stays on its bullet line', () => {
  const b = renderReview(result({ beyondDiff: [beyond({ path: 'src/c.ts\n## Overall\tx' })], unplaced: [unplaced({ path: 'src/b\r\n.ts' })] }), auto).body;
  assert.ok(b.includes('- **[minor]** `src/c.ts ## Overall x:7` \u2014 Caller ignores the error.\n'));
  assert.ok(b.includes('- `src/b  .ts:4` \u2014 Name is unclear.\n'));
  assert.equal((b.match(/^## Overall$/gm) ?? []).length, 1);
});
