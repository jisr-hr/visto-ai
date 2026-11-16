import assert from 'node:assert/strict';
import test from 'node:test';

import { isTestPath, testCandidates } from './test-pair.ts';

test('test paths are recognised', () => {
  for (const p of ['spec/models/order_spec.rb', 'src/__tests__/a.ts', 'src/cart/total.test.ts', 'a/b_spec.rb', 'test/x.go']) {
    assert.equal(isTestPath(p), true, p);
  }
  for (const p of ['src/cart/total.ts', 'app/models/order.rb', 'src/latest/a.ts']) {
    assert.equal(isTestPath(p), false, p);
  }
});

test('test candidates', () => {
  assert.deepEqual(testCandidates('app/models/order.rb'), ['spec/models/order_spec.rb']);
  assert.deepEqual(testCandidates('src/cart/total.ts'), ['src/cart/total.test.ts', 'src/cart/total.spec.ts', 'src/cart/__tests__/total.test.ts']);
  assert.deepEqual(testCandidates('src/cart/total.test.ts'), []);
  assert.deepEqual(testCandidates('main.go'), []);
});

test('a lib ruby file maps to spec/lib', () => {
  assert.deepEqual(testCandidates('lib/tax/rate.rb'), ['spec/lib/tax/rate_spec.rb']);
});
