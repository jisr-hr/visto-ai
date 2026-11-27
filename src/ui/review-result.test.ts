import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BODY_CHARS, clip, countsOf, dependenciesOf, earlierOf, filesOf, findingsOf, modelsOf, nothingNew, paragraphOf, readOf, thresholdOf,
} from './review-result.ts';

const block = (score: number, extra: Record<string, unknown> = {}) => ({
  entry: { score, category: 'calculation', reason: `Reason ${score}.` }, span: { side: 'RIGHT', first: 38, last: 51 }, ...extra,
});
const scored = (path: string, finalScore: number, blocks: unknown[] = [], extra: Record<string, unknown> = {}) => ({ path, finalScore, blocks, fileLevel: null, ...extra });

test('each scored file reads with the score that decides it, its reason, its blocks and the lines of its highest', () => {
  const price = { path: 'src/cart/price.ts', finalScore: 74, fileLevel: null, blocks: [
    { entry: { score: 74, category: 'calculation', reason: 'Changes the amount every order total is built from.' }, span: { side: 'RIGHT', first: 38, last: 51 } },
    { entry: { score: 40, category: 'style', reason: 'Low.' }, span: { side: 'RIGHT', first: 1, last: 2 } },
  ] };
  assert.deepEqual(filesOf({ scores: [price] }).files, [{
    path: 'src/cart/price.ts', score: 74, notReviewed: null, source: null, reason: 'Changes the amount every order total is built from.', category: null,
    blocks: 2, highest: { side: 'RIGHT', first: 38, last: 51 }, kept: null, raisedFrom: null,
  }]);
  const one = (b: unknown[]) => filesOf({ scores: [scored('a.ts', 60, b)] }).files[0];
  assert.equal(one([block(60, { origin: 'earlier_run' })])?.kept, 'earlier_run');
  const tie = one([block(60, { span: { side: 'LEFT', first: 1, last: 2 } }), block(60)]);
  assert.deepEqual(tie?.highest, { side: 'LEFT', first: 1, last: 2 });
  assert.equal(one([block(80, { raisedFrom: 55 })])?.raisedFrom, 55);
  assert.equal(one([block(80, { raisedFrom: 101 })])?.raisedFrom, null);
  assert.equal(one([block(80, { raisedFrom: 'x' })])?.raisedFrom, null);
  assert.equal(one([block(80, { span: 'x' })])?.highest, null);
});

test('a file whose file level is above its blocks reads as decided by it, and a reason from another pull request is never read', () => {
  const one = (extra: Record<string, unknown>, blocks: unknown[]) => filesOf({ scores: [scored('a.ts', 50, blocks, extra)] }).files[0];
  const floor = one({ fileLevel: { score: 100, source: 'builtin_floor' } }, [block(30)]);
  assert.equal(floor?.source, 'builtin_floor');
  assert.equal(floor?.reason, '');
  assert.equal(floor?.highest, null);
  const whole = one({ fileLevel: { score: 12, source: 'whole_file' }, wholeFile: { score: 12, category: 'test', reason: 'Tests only.' } }, []);
  assert.equal(whole?.source, 'whole_file');
  assert.equal(whole?.reason, 'Tests only.');
  assert.equal(whole?.category, null);
  const equal = one({ fileLevel: { score: 30, source: 'builtin_floor' } }, [block(30)]);
  assert.equal(equal?.source, null);
  assert.equal(equal?.reason, 'Reason 30.');
  const other = one({}, [block(30, { origin: 'other_pull_request', entry: { score: 30, category: 'calculation', reason: 'OTHER-PR-REASON' } })]);
  assert.equal(other?.reason, '');
  assert.equal(other?.category, 'calculation');
  assert.equal(other?.kept, 'other_pull_request');
  assert.equal(one({ fileLevel: { score: 100, source: 'Not A Code' } }, [])?.source, 'unknown');
});

test('files not reviewed read with their reason, after the reviewed ones sorted by score, and the rest past 500 are counted', () => {
  const result = {
    scores: [scored('b.ts', 58), scored('a.ts', 74), scored('c.ts', 12), scored('lock.json', 100)],
    coverage: { reviewed: [], notReviewed: [{ path: 'lock.json', reason: 'too_large' }, { path: 'gone.ts', reason: 'secret_file' }] },
  };
  const { files, cut } = filesOf(result);
  assert.deepEqual(files.map((f) => f.path), ['a.ts', 'b.ts', 'c.ts', 'gone.ts', 'lock.json']);
  assert.equal(cut, 0);
  assert.equal(files[4]?.score, 100);
  assert.equal(files[4]?.notReviewed, 'too_large');
  assert.deepEqual(files[3], { path: 'gone.ts', score: null, notReviewed: 'secret_file', source: null, reason: '', category: null, blocks: 0, highest: null, kept: null, raisedFrom: null });
  const odd = filesOf({ scores: [scored('a.ts', 5)], coverage: { notReviewed: [{ path: 'a.ts', reason: 'Too Large!' }] } });
  assert.equal(odd.files[0]?.notReviewed, 'unknown');
  const many = filesOf({ scores: Array.from({ length: 503 }, (_, i) => scored(`f${String(i).padStart(4, '0')}.ts`, 10)) });
  assert.equal(many.files.length, 500);
  assert.equal(many.cut, 3);
  const long = filesOf({ scores: [scored('a.ts', 9, [block(9, { entry: { score: 9, category: 'x', reason: 'r'.repeat(3000) } })])] });
  assert.equal(long.files[0]?.reason.length, 2000);
});

test('findings of each kind read with their place and text, sorted by severity, and are counted', () => {
  const f = (severity: string, path: string, line: number, extra: Record<string, unknown> = {}) => ({ severity, path, side: 'RIGHT', line, body: `b ${path}`, ...extra });
  const result = {
    findings: [f('minor', 'a', 3, { quote: 'q' }), f('major', 'a', 9)], unplaced: [f('major', 'b', 1)],
    unchanged: [f('blocker', 'c', 2)], beyondDiff: [f('minor', 'd', 4)],
  };
  const found = findingsOf(result);
  assert.deepEqual(found.map((x) => `${x.severity} ${x.kind} ${x.path}`), [
    'blocker unchanged c', 'major placed a', 'major unplaced b', 'minor placed a', 'minor beyond_diff d',
  ]);
  assert.equal(found[3]?.quote, 'q');
  assert.equal(found[0]?.quote, '');
  assert.deepEqual(countsOf(found), { blocker: 1, major: 2, minor: 2 });
  assert.equal(findingsOf({ findings: [f('major', 'a', 1, { body: 'x'.repeat(5000) })] })[0]?.body.length, BODY_CHARS);
  assert.equal(findingsOf({ findings: [f('major', 'a', -1), f('major', 'a', 1.5), f('huge', 'a', 1)] }).length, 0);
});

test("earlier threads and duplicates are counted as the review's last line counts them", () => {
  const v = (verdict: string) => ({ verdict });
  assert.deepEqual(earlierOf({ threadVerdicts: [v('fixed'), v('answered'), v('open'), 'x'], threadsDue: 4, alreadyDiscussed: [{}] }), { cleared: 2, open: 1, unjudged: 1, discussed: 1 });
  assert.equal(earlierOf({ threadVerdicts: [v('fixed'), v('open')], threadsDue: 1 }).unjudged, 0);
});

test("dependencies read as the run stored them, in the page's order, with a code only where it says why", () => {
  const result = { dependencies: {
    model: 'ok',
    memory: { status: 'ok', code: 'ok', lines: 2, lessons: { status: 'empty', code: 'no_lessons', shown: 0 } },
    mcp: { docs: { status: 'error', code: 'mcp_timeout', calls: 0 }, 'bad name!': { status: 'ok', calls: 1 } },
    extensions: { example: { status: 'ok', code: 'ok' } },
  } };
  assert.deepEqual(dependenciesOf(result), [
    { kind: 'model', name: null, status: 'ok', code: null, count: null },
    { kind: 'memory', name: null, status: 'ok', code: null, count: 2 },
    { kind: 'lessons', name: null, status: 'empty', code: 'no_lessons', count: 0 },
    { kind: 'mcp', name: 'docs', status: 'error', code: 'mcp_timeout', count: 0 },
    { kind: 'extension', name: 'example', status: 'ok', code: null, count: null },
  ]);
  const bad = dependenciesOf({ dependencies: { mcp: { a: { status: 'skipped', code: 'Not A Code', calls: 0 } } } });
  assert.equal(bad[0]?.code, null);
});

test('the approval paragraph is the last paragraph of the body when it starts with one of the two leads', () => {
  const no = '**Not approved automatically:** ';
  const yes = '**Approved automatically** ';
  const text = 'a part of this change is at or above 70%, so a person should review it.';
  assert.equal(paragraphOf(`## Overall\n\nNo findings.\n\n${no}${text}`, false), text);
  assert.equal(paragraphOf(`x\n\n${yes}for commit \`3f9c2e1a7b04\`: every file...`, true), 'for commit `3f9c2e1a7b04`: every file...');
  assert.equal(paragraphOf(`x\n\n${yes}for it`, false), null);
  assert.equal(paragraphOf(`x\n\n${no}${text}`, true), null);
  assert.equal(paragraphOf(`x\n\n${no}caf${String.fromCharCode(0xE9)}`, false), null);
  assert.equal(paragraphOf('x\n\nplain', false), null);
  assert.equal(paragraphOf(null, false), null);
  assert.equal(paragraphOf(`${no}${'a'.repeat(2000)}`, false), null);
});

test('a result of another shape reads as empty parts, and never throws', () => {
  const shapes: unknown[] = [null, 'x', [], {}, { scores: 'x' }, { scores: [7, { path: 7 }, { path: 'a', finalScore: 'x' }] },
    { findings: [{ severity: 'major', path: 'a' }] }, { threadVerdicts: [null] }, { dependencies: { model: 'maybe', mcp: [] } }];
  for (const r of shapes) {
    assert.deepEqual(filesOf(r), { files: [], cut: 0 });
    assert.deepEqual(findingsOf(r), []);
    assert.deepEqual(dependenciesOf(r), []);
    assert.equal(thresholdOf(r), null);
    assert.equal(nothingNew(r), false);
    assert.deepEqual(earlierOf(r), { cleared: 0, open: 0, unjudged: 0, discussed: 0 });
    assert.deepEqual(modelsOf(r), []);
    assert.deepEqual(countsOf(findingsOf(r)), { blocker: 0, major: 0, minor: 0 });
  }
  assert.deepEqual(readOf(shapes[5]), { files: 1, reviewed: 0 });   // read counts any entry with a string path
  assert.deepEqual(readOf({ scores: [scored('a', 1), 3], coverage: { reviewed: ['a', 2, 'b'] } }), { files: 1, reviewed: 2 });
  assert.deepEqual(modelsOf({ models: ['vendor/model-a', 'a b', 7] }), ['vendor/model-a']);
  assert.equal(thresholdOf({ verdict: { threshold: 70 } }), 70);
  assert.equal(thresholdOf({ verdict: { threshold: Infinity } }), null);
  assert.equal(nothingNew({ nothingToDo: true }), true);
});

test('clip never ends inside a surrogate pair', () => {
  assert.equal(clip('abc', 5), 'abc');
  assert.equal(clip('abcd', 2), 'ab');
  assert.equal(clip(`a${String.fromCharCode(0xD83D, 0xDE00)}b`, 2), 'a');
  assert.equal(clip(`a${String.fromCharCode(0xD83D, 0xDE00)}b`, 3), `a${String.fromCharCode(0xD83D, 0xDE00)}`);
});
