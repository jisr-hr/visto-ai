import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinFloor, floorFor, parseRepoFile } from './floors.ts';

test('built-in floors', () => {
  for (const p of ['.visto-ai.yml', 'CODEOWNERS', 'docs/CODEOWNERS', '.github/workflows/ci.yml', '.circleci/config.yml', 'Jenkinsfile']) assert.equal(builtinFloor(p), true, p);
  for (const p of ['sub/.visto-ai.yml', 'src/CODEOWNERS', '.github/dependabot.yml', 'docs/Jenkinsfile.md']) assert.equal(builtinFloor(p), false, p);
});
test('patterns are normalised', () => {
  assert.deepEqual(parseRepoFile('human_review:\n  - db/migrate/\n  - " /app/**/policy.rb "\n'), { patterns: ['db/migrate/**', 'app/**/policy.rb'], invalid: null });
});
test('no file, an empty file and a file of comments have no patterns', () => {
  for (const t of [null, '', '# nothing yet\n']) assert.deepEqual(parseRepoFile(t), { patterns: [], invalid: null });
});
test('a file that cannot be used says why', () => {
  assert.equal(parseRepoFile('human_review: [unclosed').invalid, 'not_yaml');
  assert.equal(parseRepoFile('- a\n- b\n').invalid, 'not_a_mapping');
  assert.equal(parseRepoFile('human_review: [a]\nthreshold: 10\n').invalid, 'unknown_key');
  assert.equal(parseRepoFile('human_review: db/migrate\n').invalid, 'bad_patterns');
  assert.equal(parseRepoFile('human_review: [""]\n').invalid, 'bad_patterns');
  assert.equal(parseRepoFile('x'.repeat(20001)).invalid, 'too_large');
});
const floors = parseRepoFile('human_review:\n  - db/migrate/\n');
test('a file moved out of a protected path is still floored', () => {
  assert.equal(floorFor({ path: 'lib/old_migration.rb', previousPath: 'db/migrate/1_add.rb' }, floors), 'team_floor');
  assert.equal(floorFor({ path: 'db/migrate/2_drop.rb', previousPath: null }, floors), 'team_floor');
  assert.equal(floorFor({ path: 'lib/x.rb', previousPath: null }, floors), null);
});
test('a workflow moved elsewhere is still a built-in floor', () => assert.equal(floorFor({ path: 'old/ci.yml', previousPath: '.github/workflows/ci.yml' }, floors), 'builtin_floor'));
test('an unusable file floors every file', () => assert.equal(floorFor({ path: 'lib/x.rb', previousPath: null }, parseRepoFile('- a\n')), 'team_file_invalid'));
