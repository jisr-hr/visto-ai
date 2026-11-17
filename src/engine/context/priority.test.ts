import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChangedFile } from '../types.ts';
import { isLowPriority, orderByPriority, priorityScore } from './priority.ts';

const f = (path: string, additions = 10, deletions = 0): ChangedFile => ({
  path,
  previousPath: null,
  status: 'modified',
  additions,
  deletions,
  patch: null,
});

test('source and risk words raise the score', () => {
  assert.equal(priorityScore(f('app/services/payment_service.rb')), 10 + 120 + 160);
  assert.equal(priorityScore(f('src/api/routes.ts')), 10 + 120 + 100);
});

test('words match whole, not as substrings', () => {
  assert.equal(priorityScore(f('src/capital.ts')), 10 + 120);
  assert.equal(priorityScore(f('src/apiary/x.ts')), 10 + 120);
});

test('each row applies at most once per file', () => {
  assert.equal(priorityScore(f('src/lib/auth/payment_service.ts')), 10 + 120 + 160);
});

test('test words and low-priority penalties', () => {
  assert.equal(priorityScore(f('x/__tests__/a.ts')), 10 + 40);
  assert.equal(priorityScore(f('docs/guide.md')), 10 - 220 - 120);
});

test('low-priority files', () => {
  for (const p of ['docs/guide.md', 'vendor/lib.js', 'web/app.min.js', 'package-lock.json', 'a/b.lock', 'img/logo.png'])
    assert.equal(isLowPriority(p), true, p);
  assert.equal(isLowPriority('src/doc_builder.ts'), false);
});

test('order: score, then size, then path', () => {
  const out = orderByPriority([f('z.txt', 1), f('a.txt', 1), f('src/x.ts', 1), f('README.md', 500)]);
  assert.deepEqual(out.map((x) => x.path), ['README.md', 'src/x.ts', 'a.txt', 'z.txt']);
});

test('equal scores: the larger change comes first, then the path', () => {
  const out = orderByPriority([f('src/b.rb', 10), f('tmp/a.rb', 130), f('src/a.rb', 10)]);
  assert.deepEqual(out.map((x) => x.path), ['tmp/a.rb', 'src/a.rb', 'src/b.rb']);
});

test('ordering does not mutate its input', () => {
  const input = [f('b.txt'), f('src/a.ts')];
  orderByPriority(input);
  assert.deepEqual(input.map((x) => x.path), ['b.txt', 'src/a.ts']);
});

test('words split at case boundaries', () => {
  assert.equal(priorityScore(f('src/billing/PaymentService.ts')), 10 + 120 + 160);
  assert.equal(priorityScore(f('src/PaymentService.ts')), 10 + 120 + 160);
  assert.equal(priorityScore(f('src/APIClient.ts')), 10 + 120 + 100);
  assert.equal(priorityScore(f('src/Capital.ts')), 10 + 120);
});

test('an equal score with different sizes is ordered by size', () => {
  const out = orderByPriority([f('src/small.ts', 1), f('src/large.ts', 9)]);
  assert.deepEqual(out.map((x) => x.path), ['src/large.ts', 'src/small.ts']);
  assert.equal(priorityScore(f('src/small.ts', 1)) - 1, priorityScore(f('src/large.ts', 9)) - 9);
});

test('plural words match their singular', () => {
  assert.equal(priorityScore(f('src/services/x.ts')), 10 + 120 + 160);
  assert.equal(priorityScore(f('src/routes/x.ts')), 10 + 120 + 100);
});

test('a .min.js name and a name with no dot', () => {
  assert.equal(priorityScore(f('web/app.min.js')), 10 - 120);
  assert.equal(priorityScore(f('Makefile')), 10);
  assert.equal(priorityScore(f('src/Dockerfile')), 10 + 120);
});
