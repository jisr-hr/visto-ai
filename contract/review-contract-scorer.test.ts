import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The contract the review model gets when a second scorer scores the blocks.
const read = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8');
const base = read('./review-contract.md');
const text = read('./review-contract-scorer.md');
const has = (re: RegExp) => assert.match(text, re);
const filesArgument = (t: string): string => t.split('\n').find((line) => line.startsWith('- `files`:')) ?? '';
// Everything before the section on blocks, without the line that describes the `files` argument.
const shared = (t: string): string => t.slice(0, t.indexOf('\n## Blocks\n')).split('\n').filter((line) => !line.startsWith('- `files`:')).join('\n');

test('up to the section on blocks it is the review contract, but for the files argument', () => {
  assert.ok(base.includes('\n## Blocks\n') && text.includes('\n## Blocks\n'));
  assert.notEqual(filesArgument(base), '');
  assert.equal(shared(text), shared(base));
});
test('the files argument asks for a path and a summary, and for no blocks', () => {
  const line = filesArgument(text);
  assert.match(line, /one entry for every file section/);
  assert.match(line, /`path`/);
  assert.match(line, /`change_summary`/);
  assert.doesNotMatch(line, /`blocks`/);
});
test('no block gets a score', () => { has(/Give no block a score/); has(/`blocks` is empty in every entry/); });
test('a block header is explained', () => has(/`### Block B3 \(12 changed lines, not scored\)`/));
test('it does not explain parts', () => assert.doesNotMatch(text, /`parts`|`first`|`last`/));
test('a whole-file score has one case, the moved file', () => {
  has(/in one case only/);
  has(/whole-file score is required/i);
  has(/old and new path/);
  has(/public URL/);
});
test('a file whose header allows a whole-file score gets none', () => has(/`whole-file score: allowed` gets no score/));
test('a reason is required from 40', () => has(/A file gets a `score` and `category` of its own, and `reason` when the score is 40 or more/));
test('stays under 150 lines', () => assert.ok(text.split('\n').length < 150));
test('it is shorter than the review contract', () => assert.ok(text.length < base.length));
