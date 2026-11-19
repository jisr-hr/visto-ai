import test from 'node:test';
import assert from 'node:assert/strict';
import { fitBody, inert, MAX_BODY_CHARS, renderReview } from './body.ts';
import type { Finding, NotReviewed, RawFinding, ReviewResult, UnplacedFinding } from '../types.ts';
import type { BlockScore, Category, FileLevelSource, FileScore, Span } from '../score/types.ts';

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
  coverage: { reviewed: [], notReviewed: [] }, usage, models: [], providers: [], dependencies: { model: 'ok' }, audit: [],
  scores: [], verdict: { threshold: 70, needsHuman: false, highest: 0 }, teamFileInvalid: null, ...over,
});
const auto = { trigger: 'automatic', requestedBy: null, lineUrl: null, inline: true } as const;
const notReviewed = (n: number): NotReviewed[] =>
  (['no_diff', 'too_large', 'over_batch_limit', 'batch_failed'] as const).slice(0, n).map((reason, i) => ({ path: `f${i}.bin`, reason }));
const full = result({
  findings: [finding({ severity: 'blocker', line: 3 }), finding({ line: 5 }), finding({ line: 6, requestedLine: 15 })],
  unplaced: [unplaced({ side: 'LEFT' })],
  beyondDiff: [beyond()],
  coverage: { reviewed: ['src/a.ts'], notReviewed: notReviewed(3) },
});

test('no findings', () => {
  assert.match(renderReview(result(), auto).body, /## Summary\n\nChanges a\.ts\.\n\n## Human review\n\nNothing here is at or above 70%\. The highest score is 0%\.\n\n## Overall\n\nNo findings\. Human review: not needed \(highest score 0%\)\.$/);
  assert.equal(renderReview(result(), auto).body, '## Summary\n\nChanges a.ts.\n\n## Human review\n\nNothing here is at or above 70%. The highest score is 0%.\n\n## Overall\n\nNo findings. Human review: not needed (highest score 0%).');
});
test('an empty overview leaves the summary out', () => {
  assert.equal(renderReview(result({ overview: '  ' }), auto).body, '## Human review\n\nNothing here is at or above 70%. The highest score is 0%.\n\n## Overall\n\nNo findings. Human review: not needed (highest score 0%).');
});
test('an inline comment carries its tag, and a moved one its note', () => {
  const { comments } = renderReview(result({ findings: [finding({ line: 12, requestedLine: 15 })] }), auto);
  assert.deepEqual(comments, [{ path: 'src/a.ts', side: 'RIGHT', line: 12, body: '**[major]** _(Refers to line 15, just outside the diff.)_\n\nBreaks on empty input.' }]);
});
test('an unmoved comment has no note', () => {
  assert.equal(renderReview(result({ findings: [finding({ severity: 'minor' })] }), auto).comments[0]!.body, '**[minor]**\n\nBreaks on empty input.');
});
test('the left side says old line', () => {
  const { comments } = renderReview(result({ findings: [finding({ side: 'LEFT', line: 8, requestedLine: 9 })] }), auto);
  assert.equal(comments[0]!.body, '**[major]** _(Refers to old line 9, just outside the diff.)_\n\nBreaks on empty input.');
  assert.equal(comments[0]!.side, 'LEFT');
});
test('sections appear in order and only when they have content', () => {
  const b = renderReview(full, auto).body;
  const order = ['## Summary', '## Human review', '## Findings', '## Findings not placed on the diff', '## Beyond the diff', '## Coverage', '## Overall'].map((h) => b.indexOf(h + '\n'));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  assert.ok(order.every((i) => i >= 0));
  const bare = renderReview(result(), auto).body;
  for (const h of ['## Findings', '## Beyond the diff', '## Coverage']) assert.equal(bare.includes(h), false);
});
test('the overall line counts', () => {
  assert.match(renderReview(full, auto).body, /1 blocker, 2 major, 0 minor\. 1 could not be placed on the diff\. 3 files were not reviewed\. Human review: not needed \(highest score 0%\)\.$/);
});
test('overall: unplaced only, and not-reviewed only', () => {
  assert.match(renderReview(result({ unplaced: [unplaced()] }), auto).body, /## Overall\n\n0 blocker, 0 major, 0 minor\. 1 could not be placed on the diff\. Human review: not needed \(highest score 0%\)\.$/);
  assert.match(renderReview(result({ coverage: { reviewed: [], notReviewed: notReviewed(2) } }), auto).body, /## Overall\n\nNo findings\. 2 files were not reviewed\. Human review: not needed \(highest score 0%\)\.$/);
  assert.match(renderReview(result({ findings: [finding()], coverage: { reviewed: [], notReviewed: notReviewed(1) } }), auto).body, /0 blocker, 1 major, 0 minor\. 1 files were not reviewed\. Human review: not needed \(highest score 0%\)\.$/);
});
test('beyond-the-diff items do not count in the overall line', () => {
  assert.match(renderReview(result({ beyondDiff: [beyond()] }), auto).body, /## Overall\n\nNo findings\. Human review: not needed \(highest score 0%\)\.$/);
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
  assert.match(renderReview(result(), { trigger: 'manual', requestedBy: 'dev-one', lineUrl: null, inline: true }).body, /^\*\*Full review\*\* requested by @dev-one\.\n\n## Summary/);
  assert.match(renderReview(result(), { trigger: 'manual', requestedBy: null, lineUrl: null, inline: true }).body, /^\*\*Full review\*\* requested\.\n\n## Summary/);
  assert.doesNotMatch(renderReview(result(), auto).body, /Full review/);
});
test('a long list is capped at 25', () => {
  const many = Array.from({ length: 30 }, (_, i) => unplaced({ line: i + 1 }));
  const b = renderReview(result({ unplaced: many }), auto).body;
  assert.equal((b.match(/^- `src\/b\.ts:/gm) ?? []).length, 25);
  assert.ok(b.includes('\n- \u2026and 5 more.\n'));
  assert.match(b, /30 could not be placed on the diff\. Human review: not needed \(highest score 0%\)\.$/);
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
  assert.match(body, /## Overall\n\n0 blocker, 1 major, 0 minor\. Human review: not needed \(highest score 0%\)\.$/);
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
  assert.deepEqual(renderReview(failed, auto), { body: '## Overall\n\nThe review could not be completed (model: no_credit).\n\nHuman review: needed, because the review did not finish.', comments: [] });
  const manual = renderReview(failed, { trigger: 'manual', requestedBy: 'dev-one', lineUrl: null, inline: true });
  assert.equal(manual.body, '**Full review** requested by @dev-one.\n\n## Overall\n\nThe review could not be completed (model: no_credit).\n\nHuman review: needed, because the review did not finish.');
  assert.deepEqual(manual.comments, []);
});
test('an Overall line written by the model cannot move the cut', () => {
  const overview = `Intro.\n## Overall\n\nAll fine.\n${'w\n'.repeat(40_000)}`;
  const plain = renderReview(result({ overview, findings: [finding()] }), auto).body;
  assert.ok(plain.length <= MAX_BODY_CHARS);
  assert.match(plain, /cut to fit GitHub's limit\]_\n\n## Overall\n\n0 blocker, 1 major, 0 minor\. Human review: not needed \(highest score 0%\)\.$/);
  const withUnplaced = renderReview(result({ overview, findings: [finding()], unplaced: [unplaced()] }), auto).body;
  assert.ok(withUnplaced.length <= MAX_BODY_CHARS);
  assert.ok(withUnplaced.includes('## Findings not placed on the diff\n'));
  assert.ok(withUnplaced.includes('\n- `src/b.ts:4` \u2014 Name is unclear.\n'));
  assert.match(withUnplaced, /\n## Overall\n\n0 blocker, 1 major, 0 minor\. 1 could not be placed on the diff\. Human review: not needed \(highest score 0%\)\.$/);
});
test('an HTML comment opener written by the model is neutralised', () => {
  const r = renderReview(result({ overview: 'See <!-- hidden -->.', findings: [finding({ body: 'Bad <!-- x' })], beyondDiff: [beyond({ body: 'Also <!-- y' })] }), auto);
  assert.equal(r.body.includes('<!--'), false);
  assert.ok(r.body.includes('See &lt;!-- hidden -->.'));
  assert.ok(r.body.includes('Bad &lt;!-- x'));
  assert.ok(r.body.includes('Also &lt;!-- y'));
  assert.equal(r.comments[0]!.body, '**[major]**\n\nBad &lt;!-- x');
});
test('a heading line in the overview is escaped', () => {
  const b = renderReview(result({ overview: 'Text.\n## Overall\n   # Title\n    # code\nnot # a heading' }), auto).body;
  assert.ok(b.includes('## Summary\n\nText.\n\\## Overall\n   \\# Title\n    # code\nnot # a heading\n\n## Human review\n\nNothing here is at or above 70%. The highest score is 0%.\n\n## Overall\n\nNo findings. Human review: not needed (highest score 0%).'));
  assert.equal((b.match(/^## Overall$/gm) ?? []).length, 1);
});
test('a path with a newline or a tab stays on its bullet line', () => {
  const b = renderReview(result({ beyondDiff: [beyond({ path: 'src/c.ts\n## Overall\tx' })], unplaced: [unplaced({ path: 'src/b\r\n.ts' })] }), auto).body;
  assert.ok(b.includes('- **[minor]** `src/c.ts ## Overall x:7` \u2014 Caller ignores the error.\n'));
  assert.ok(b.includes('- `src/b  .ts:4` \u2014 Name is unclear.\n'));
  assert.equal((b.match(/^## Overall$/gm) ?? []).length, 1);
});

const lineUrl = (f: { path: string }, s: Span): string => 'u:' + f.path + ':' + s.first;
const withUrl = { trigger: 'automatic', requestedBy: null, lineUrl, inline: true } as const;
const span = (first: number, last: number, side: Span['side'] = 'RIGHT'): Span => ({ side, first, last });
const block = (id: string, s: Span, score: number | null, category: Category = 'calculation', reason = ''): BlockScore => ({
  id, hunk: id, hunkHash: 'h', hash: 'h', changedLines: s.last - s.first + 1, span: s,
  lines: { old: [], new: [] } as unknown as BlockScore['lines'],
  entry: score === null ? null : { score, category, reason },
});
const file = (path: string, over: Partial<FileScore> = {}): FileScore => {
  const blocks = over.blocks ?? [];
  const best = Math.max(0, over.fileLevel?.score ?? 0, ...blocks.map((b) => b.entry?.score ?? 0));
  return { path, previousPath: null, diffHash: 'd', changeSummary: '', changedLines: 1, blocks, wholeFile: null, fileLevel: null, finalScore: best, covered: true, ...over };
};
const level = (score: number, source: FileLevelSource): FileScore['fileLevel'] => ({ score, source });
const verdictOf = (scores: FileScore[], threshold = 70) => {
  const highest = Math.max(0, ...scores.map((f) => f.finalScore));
  return { threshold, needsHuman: highest >= threshold, highest };
};
const scored = (scores: FileScore[], threshold = 70): ReviewResult => result({ scores, verdict: verdictOf(scores, threshold) });
const section = (body: string): string => /## Human review\n\n([\s\S]*?)(?=\n\n## |$)/.exec(body)![1]!;

test('nothing at or above the threshold is one line', () => {
  const r = scored([file('src/a.ts', { blocks: [block('B1', span(1, 2), 45)] })]);
  const b = renderReview(r, withUrl).body;
  assert.ok(b.includes('## Human review\n\nNothing here is at or above 70%. The highest score is 45%.\n\n## Overall'));
});
test('the section lists what a person should read', () => {
  const r = scored([
    file('db/migrate/20260101_add_plan.rb', { fileLevel: level(100, 'team_floor') }),
    file('src/billing/invoice.ts', {
      blocks: [block('B1', span(85, 90), 40, 'refactor', 'Moves code.'), block('B2', span(12, 14, 'LEFT'), 72, 'business_rule', 'Removes the refund limit.'), block('B3', span(40, 58), 85, 'calculation', 'Changes how tax is rounded.')],
    }),
  ]);
  const b = renderReview(r, { ...withUrl }).body;
  assert.equal(section(b), [
    'A person should read these parts. Each is at or above 70%.',
    '',
    '**`db/migrate/20260101_add_plan.rb`**',
    '- whole file, 100% \u2014 a path the team marked as always needing a person',
    '',
    '**`src/billing/invoice.ts`**',
    '- [lines 40-58](u:src/billing/invoice.ts:40), 85% `calculation` \u2014 Changes how tax is rounded.',
    '- [old lines 12-14](u:src/billing/invoice.ts:12), 72% `business_rule` \u2014 Removes the refund limit.',
  ].join('\n'));
});
test('the section sits between Summary and Findings', () => {
  const b = renderReview(scored([file('src/a.ts', { blocks: [block('B1', span(1, 1), 90)] })]), { ...withUrl }).body;
  const order = ['## Summary', '## Human review'].map((h) => b.indexOf(h + '\n'));
  assert.ok(order[0]! >= 0 && order[0]! < order[1]!);
  const withFinding = renderReview({ ...scored([file('src/a.ts', { blocks: [block('B1', span(1, 1), 90)] })]), findings: [finding()] }, withUrl).body;
  assert.ok(withFinding.indexOf('## Human review') < withFinding.indexOf('## Findings\n'));
});
test('files are ordered by final score, then path', () => {
  const r = scored([
    file('b.ts', { blocks: [block('B1', span(1, 1), 80)] }),
    file('c.ts', { blocks: [block('B1', span(1, 1), 95)] }),
    file('a.ts', { blocks: [block('B1', span(1, 1), 80)] }),
  ]);
  const heads = section(renderReview(r, auto).body).split('\n').filter((l) => l.startsWith('**'));
  assert.deepEqual(heads, ['**`c.ts`**', '**`a.ts`**', '**`b.ts`**']);
});
test('blocks are ordered by score, then by position in the diff', () => {
  const r = scored([file('a.ts', { blocks: [block('B1', span(1, 1), 75), block('B2', span(5, 5), 90), block('B3', span(9, 9), 75)] })]);
  const lines = section(renderReview(r, auto).body).split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(lines.map((l) => l.split(' `')[0]), ['- line 5, 90%', '- line 1, 75%', '- line 9, 75%']);
});
test('a file flagged as a whole gets its whole file line first, then its blocks', () => {
  const r = scored([file('a.ts', { fileLevel: level(100, 'not_scored'), blocks: [block('B1', span(2, 3), 80, 'fix', 'Fixes it.'), block('B2', span(9, 9), 20)] })]);
  const lines = section(renderReview(r, auto).body).split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(lines, ['- whole file, 100% \u2014 not read, or left without a score', '- lines 2-3, 80% `fix` \u2014 Fixes it.']);
});
test('every whole-file source has its text', () => {
  const text: Record<string, string> = {
    builtin_floor: "it changes the reviewer's own file, code owners or CI",
    team_floor: 'a path the team marked as always needing a person',
    team_file_invalid: "the repository's .visto-ai.yml cannot be used (not_yaml), so every file needs a person",
    not_scored: 'not read, or left without a score',
    hidden_characters: 'a changed line holds invisible or direction-changing characters',
    rule_rename: 'scored by rule',
    rule_asset: 'scored by rule',
  };
  for (const [source, expected] of Object.entries(text)) {
    const r = { ...scored([file('a.ts', { fileLevel: level(100, source as FileLevelSource) })]), teamFileInvalid: 'not_yaml' };
    assert.ok(section(renderReview(r, auto).body).includes(`- whole file, 100% \u2014 ${expected}`), source);
  }
});
test('a whole-file score from the model shows its category and reason', () => {
  const r = scored([file('a.ts', { fileLevel: level(88, 'whole_file'), wholeFile: { score: 88, category: 'permission', reason: 'Widens access.' } })]);
  assert.ok(section(renderReview(r, auto).body).includes('- whole file, 88% `permission` \u2014 Widens access.'));
});
test('an unusable repository file is named, with the reason', () => {
  const r = { ...scored([file('a.ts', { fileLevel: level(100, 'team_file_invalid') })]), teamFileInvalid: 'bad_patterns' };
  assert.ok(renderReview(r, auto).body.includes("- whole file, 100% \u2014 the repository's .visto-ai.yml cannot be used (bad_patterns), so every file needs a person"));
});
test('without a link builder the label is plain text', () => {
  const r = scored([file('a.ts', { blocks: [block('B1', span(40, 58), 85, 'calculation', 'Changes tax.')] })]);
  assert.ok(section(renderReview(r, auto).body).includes('\n- lines 40-58, 85% `calculation` \u2014 Changes tax.'));
});
test('a block below 40 at a low threshold shows its category and no reason', () => {
  const r = scored([file('a.ts', { blocks: [block('B1', span(7, 7), 25, 'rename')] })], 20);
  const b = renderReview(r, auto).body;
  assert.ok(section(b).includes('Each is at or above 20%.'));
  assert.ok(section(b).endsWith('\n- line 7, 25% `rename`'));
});
test('the list stops at 50 entries', () => {
  const blocks = Array.from({ length: 60 }, (_, i) => block(`B${i + 1}`, span(i + 1, i + 1), 80));
  const lines = section(renderReview(scored([file('a.ts', { blocks })]), auto).body).split('\n');
  assert.equal(lines.filter((l) => l.startsWith('- ')).length, 51);
  assert.equal(lines.at(-1), '- \u2026and 10 more.');
  assert.equal(lines.at(-2), '- line 50, 80% `calculation`');
});
test('heading lines do not count toward the 50 entries, and a file with nothing written has no heading', () => {
  const a = file('a.ts', { blocks: Array.from({ length: 50 }, (_, i) => block(`B${i + 1}`, span(i + 1, i + 1), 90)) });
  const c = file('c.ts', { blocks: [block('B1', span(1, 1), 80), block('B2', span(2, 2), 80)] });
  const text = section(renderReview(scored([a, c]), auto).body);
  assert.equal(text.includes('c.ts'), false);
  assert.ok(text.endsWith('\n- \u2026and 2 more.'));
});
test('Overall says whether a person is needed', () => {
  const high = renderReview(scored([file('a.ts', { blocks: [block('B1', span(1, 1), 85)] })]), auto).body;
  assert.match(high, /## Overall\n\nNo findings\. Human review: needed \(highest score 85%\)\.$/);
  const low = renderReview(scored([file('a.ts', { blocks: [block('B1', span(1, 1), 45)] })]), auto).body;
  assert.match(low, /## Overall\n\nNo findings\. Human review: not needed \(highest score 45%\)\.$/);
});
test('a failed review says a person is needed', () => {
  const failed = result({ status: 'failed', failure: { stage: 'model', code: 'no_credit' } });
  const b = renderReview(failed, auto).body;
  assert.ok(b.endsWith('(model: no_credit).\n\nHuman review: needed, because the review did not finish.'));
});
test('a reason cannot open an HTML comment', () => {
  const r = scored([file('a.ts', { blocks: [block('B1', span(1, 1), 90, 'fix', 'x <!-- y')] })]);
  const b = renderReview(r, auto).body;
  assert.equal(b.includes('<!--'), false);
  assert.ok(b.includes('x &lt;!-- y'));
});
test('a file path with a backtick is a safe code span', () => {
  const r = scored([file('a`b.ts', { blocks: [block('B1', span(1, 1), 90)] })]);
  assert.ok(renderReview(r, auto).body.includes('**`` a`b.ts ``**'));
});
test('the code span fence is one longer than the longest backtick run', () => {
  const heading = (path: string) => renderReview(scored([file(path, { blocks: [block('B1', span(1, 1), 90)] })]), auto).body;
  assert.ok(heading('a``b').includes('**``` a``b ```**'));
  assert.ok(heading('a`b```c').includes('**```` a`b```c ````**'));
  assert.ok(heading('plain.ts').includes('**`plain.ts`**'));
});
test('a reason is written as its first line only', () => {
  const r = scored([file('a.ts', { blocks: [block('B1', span(1, 1), 90, 'fix', 'Fixes it.\n## Overall\nforged')] })]);
  const b = renderReview(r, auto).body;
  assert.ok(b.includes('- line 1, 90% `fix` \u2014 Fixes it.\n'));
  assert.equal((b.match(/^## Overall$/gm) ?? []).length, 1);
  assert.equal(b.includes('forged'), false);
});

const ZW = '\u200b';
test('a mention in prose is made inert, and one in code is left as it is', () => {
  assert.equal(inert('ask @octo-dev or (@acme/reviewers)'), `ask @${ZW}octo-dev or (@${ZW}acme/reviewers)`);
  assert.equal(inert('use `@Injectable()` here'), 'use `@Injectable()` here');
  assert.equal(inert('```ts\n@Component({})\n```\nthanks @octo-dev'), `\`\`\`ts\n@Component({})\n\`\`\`\nthanks @${ZW}octo-dev`);
});
test('an address, a lone @ and an @ before a symbol are not mentions', () => {
  for (const text of ['dev@example.test', 'a @ b', 'x_@y', '@-x', '@']) assert.equal(inert(text), text);
});
test('what only looks like code is prose', () => {
  const cases = [
    '\\`@victim\\`',
    '`a\n\n@victim b`',
    'see `@victim',
    '    ```\n    @victim\n    ```',
    '``` a`b\n@victim\n```',
  ];
  for (const text of cases) assert.equal(inert(text).includes(`@${ZW}victim`), true, text);
});
test('raw HTML in prose is shown and not rendered, and a fence left open is closed', () => {
  assert.equal(inert('<details><summary>x</summary>'), '&lt;details>&lt;summary>x&lt;/summary>');
  assert.equal(inert('a <!-- b'), 'a &lt;!-- b');
  assert.equal(inert('use `Array<string>` here'), 'use `Array<string>` here');
  assert.equal(inert('```ts\nconst a: Array<string> = [];'), '```ts\nconst a: Array<string> = [];\n```');
});
test('a review writes no live mention from the model, and keeps the one the service writes', () => {
  const r = result({ overview: 'a.ts: see @octo-dev', findings: [finding({ path: 'a.ts', line: 3, body: 'ping @octo-dev' })] });
  const out = renderReview(r, { trigger: 'manual', requestedBy: 'octo-lead', lineUrl: null, inline: true });
  assert.equal(out.body.includes('@octo-dev'), false);
  assert.equal(out.comments[0]!.body.includes('@octo-dev'), false);
  assert.equal(out.body.includes('requested by @octo-lead'), true);
});
test('a first line cut out of a span is prose', () => {
  const r = result({ findings: [finding({ path: 'a.ts', line: 3, body: '`@victim\nrest`' })] });
  const out = renderReview(r, { trigger: 'automatic', requestedBy: null, lineUrl: null, inline: true });
  assert.equal(out.body.includes('@victim'), false);
  assert.equal(out.body.includes(`@${ZW}victim`), true);
});
test('without inline comments, every finding carries its whole text in the body and cannot forge a heading', () => {
  const many = Array.from({ length: 30 }, (_, i) => finding({ path: 'a.ts', line: i + 1, body: `Finding ${i + 1}.\n\n## Overall\n\nDetail ${i + 1}.` }));
  const r = result({ findings: many });
  const inline = renderReview(r, { trigger: 'automatic', requestedBy: null, lineUrl: null, inline: true });
  const bodyOnly = renderReview(r, { trigger: 'automatic', requestedBy: null, lineUrl: null, inline: false });
  assert.deepEqual([inline.comments.length, bodyOnly.comments.length], [30, 0]);
  assert.equal(inline.body.includes('Detail 1.'), false);
  assert.equal(bodyOnly.body.includes('Detail 1.') && bodyOnly.body.includes('Detail 30.'), true);
  assert.equal(bodyOnly.body.match(/^## Overall$/gm)?.length, 1);
});
test('a fence opened by the first line of a finding does not swallow the next bullet', () => {
  const b = renderReview(result({ findings: [finding({ body: '```ts' }), finding({ line: 11, body: 'Next @octo-dev' })] }), auto).body;
  assert.equal(b.includes('```'), true);
  assert.equal(b.includes('@octo-dev'), false);
  assert.equal(/^```/m.test(b), false);
});
test('a score reason and the whole-file reason are made inert too', () => {
  const r = scored([file('a.ts', { blocks: [block('B1', span(1, 1), 90, 'fix', 'ask @octo-dev <b>')] })]);
  const b = renderReview(r, auto).body;
  assert.equal(b.includes('@octo-dev'), false);
  assert.ok(b.includes(`ask @${ZW}octo-dev &lt;b>`));
});

test('a fence is honoured only where it is certainly one', () => {
  const listed = inert('- ```\n  x\n  ```\n\n@victim');
  assert.equal(listed.includes(`@${ZW}victim`), true);
  assert.equal(listed.endsWith('```'), false);
  assert.equal(inert('```\nx\n```\t\n@victim'), `\`\`\`\nx\n\`\`\`\t\n@${ZW}victim`);
  assert.equal(inert('```\nx\n   ```\n@victim'), `\`\`\`\nx\n   \`\`\`\n@${ZW}victim`);
});
test('a span is honoured only where it is certainly one', () => {
  const live = (text: string): boolean => /(^|[^A-Za-z0-9_])@[A-Za-z0-9]/.test(inert(text));
  for (const text of [
    '\\`` x `@victim`',
    'x `a\n` @victim `y`',
    '| `a | @victim` |',
    '`a\r\r@victim\r\r`',
    '\u00e9@victim',
  ]) assert.equal(live(text), false, JSON.stringify(text));
  assert.equal(inert('use `@Injectable()` and `x` here'), 'use `@Injectable()` and `x` here');
  assert.equal(inert('a\n\nuse `@Injectable()` here'), 'a\n\nuse `@Injectable()` here');
});
test('a character reference cannot become a mention', () => {
  assert.equal(inert('ping &#64;octo-dev and &commat;octo-lead'), 'ping &amp;#64;octo-dev and &amp;commat;octo-lead');
  assert.equal(inert('a && b < c'), 'a &amp;&amp; b &lt; c');
  assert.equal(inert('use `a && b` here'), 'use `a && b` here');
});
test("an inline comment keeps the model's text off the service's own line", () => {
  const out = renderReview(result({ findings: [finding({ path: 'a.ts', line: 3, severity: 'minor', body: '~~~\n@victim\n~~~' })] }), auto);
  assert.equal(out.comments[0]!.body, '**[minor]**\n\n~~~\n@victim\n~~~');
  const uneven = result({ findings: [finding({ path: 'a.ts', line: 3, severity: 'minor', body: '```\n@victim\n````\nafter @victim' })] });
  assert.equal(renderReview(uneven, auto).comments[0]!.body, '**[minor]**\n\n```\n@victim\n````\nafter @' + ZW + 'victim');
});
test('the body-only form carries the note about a moved line', () => {
  const r = result({ findings: [finding({ path: 'a.ts', line: 3, body: 'Detail.', requestedLine: 5 })] });
  const out = renderReview(r, { trigger: 'automatic', requestedBy: null, lineUrl: null, inline: false });
  assert.equal(out.body.includes('Refers to line 5, just outside the diff.'), true);
});
