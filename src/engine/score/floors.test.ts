import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinFloor, floorFor, matchesPattern, parseRepoFile } from './floors.ts';

test('built-in floors', () => {
  for (const p of ['.visto-ai.yml', 'CODEOWNERS', 'docs/CODEOWNERS', '.github/workflows/ci.yml', '.circleci/config.yml', 'Jenkinsfile']) assert.equal(builtinFloor(p), true, p);
  for (const p of ['sub/.visto-ai.yml', 'src/CODEOWNERS', '.github/dependabot.yml', 'docs/Jenkinsfile.md']) assert.equal(builtinFloor(p), false, p);
});
test('patterns are normalised', () => {
  assert.deepEqual(parseRepoFile('human_review:\n  - db/migrate/\n  - " /app/**/policy.rb "\n'), { patterns: ['db/migrate', 'app/**/policy.rb'], invalid: null });
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

const team = (...p: string[]) => parseRepoFile(`human_review:\n${p.map((x) => `  - ${JSON.stringify(x)}\n`).join('')}`);
const floored = (pattern: string, path: string): boolean => floorFor({ path, previousPath: null }, team(pattern)) === 'team_floor';

test('patterns are stored in their normal form', () => {
  assert.deepEqual(team('*.sql', 'Dockerfile', '/Dockerfile').patterns, ['**/*.sql', '**/Dockerfile', 'Dockerfile']);
});
test('a directory pattern covers everything under it, dot-files included', () => {
  for (const p of ['db/migrate/1_add.rb', 'db/migrate/.keep', 'db/migrate/sub/x.rb']) assert.equal(floored('db/migrate/', p), true, p);
  for (const p of ['db/migrate_old/x.rb', 'lib/db/migrate/x.rb']) assert.equal(floored('db/migrate/', p), false, p);
});
test('a bare name matches at any depth', () => {
  for (const p of ['secrets/.env', 'config/secrets/a/b']) assert.equal(floored('secrets', p), true, p);
  assert.equal(floored('secrets', 'secrets.rb'), false);
  for (const p of ['a.sql', 'db/x/y.sql', '.hidden.sql']) assert.equal(floored('*.sql', p), true, p);
  assert.equal(floored('*.sql', 'a.sql.bak'), false);
});
test('a leading slash ties the pattern to the root', () => {
  assert.equal(floored('/Dockerfile', 'Dockerfile'), true);
  assert.equal(floored('/Dockerfile', 'docker/Dockerfile'), false);
  for (const p of ['Dockerfile', 'docker/Dockerfile']) assert.equal(floored('Dockerfile', p), true, p);
});
test('a double star spans directories and dot-directories', () => {
  for (const p of ['app/policy.rb', 'app/a/b/policy.rb', 'app/.x/policy.rb']) assert.equal(floored('app/**/policy.rb', p), true, p);
  assert.equal(floored('app/**/policy.rb', 'lib/policy.rb'), false);
});
test('a single star reaches dot-files and a directory pattern covers below it', () => {
  for (const p of ['config/.env', 'config/sub/x.yml']) assert.equal(floored('config/*', p), true, p);
});
test('a question mark is exactly one character', () => {
  assert.equal(floored('src/a?c.ts', 'src/abc.ts'), true);
  for (const p of ['src/ac.ts', 'src/a/c.ts']) assert.equal(floored('src/a?c.ts', p), false, p);
});
test('characters special in regular expressions match only themselves', () => {
  assert.equal(floored('a+b/(x).rb', 'a+b/(x).rb'), true);
  assert.equal(floored('a+b/(x).rb', 'aab/x.rb'), false);
  assert.equal(floored('a.b', 'axb'), false);
});
test('matching is case-sensitive', () => assert.equal(matchesPattern('Db/x', '**/db'), false));
test('patterns that cannot be used make the file invalid', () => {
  for (const p of ['!db/schema.rb', '/', 'a//b', 'a'.repeat(201), '   ']) assert.equal(team(p).invalid, 'bad_patterns', p);
  assert.equal(team(...Array.from({ length: 201 }, (_, i) => `p${i}`)).invalid, 'bad_patterns');
  assert.equal(parseRepoFile('human_review: [1]\n').invalid, 'bad_patterns');
});
test('a key with no value has no patterns', () => assert.deepEqual(parseRepoFile('human_review:\n'), { patterns: [], invalid: null }));
test('many stars against a long segment finish quickly', () => {
  const started = Date.now();
  assert.equal(matchesPattern('a'.repeat(250), `${'a*'.repeat(100)}b`), false);
  assert.equal(matchesPattern('a'.repeat(250), '*'.repeat(100) + 'b'), false);
  assert.equal(Date.now() - started < 1000, true);
});
