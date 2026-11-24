import test from 'node:test';
import assert from 'node:assert/strict';
import type { PullRequestRef } from '../forge/types.ts';
import { auditIdentity, drawnForAudit } from './audit.ts';

const AUDIT_TEST_KEY = 'audit-key-for-tests-only-0123456789';
const AUDIT_TEST_KEY_CHANGED = 'audit-key-for-tests-only-0123456788';
const AUDIT_OTHER_KEY = 'another-audit-key-for-tests-0123456789';
const REF: PullRequestRef = { service: 'github', owner: 'acme', repo: 'shop', number: 7 };
const SHOP_8: PullRequestRef = { ...REF, number: 8 };
const OTHER_7: PullRequestRef = { ...REF, repo: 'other' };

/** The numbers from 1 to `last` of acme/`repo` drawn at `share` under `key`. */
function drawnNumbers(key: string, share: number, last: number, repo = 'shop'): number[] {
  const drawn: number[] = [];
  for (let number = 1; number <= last; number++) {
    if (drawnForAudit(key, { ...REF, repo, number }, share)) drawn.push(number);
  }
  return drawn;
}

test('the identity is the pull request as the service stores it: JSON of the service, the owner and the repository lower-cased, and the number', () => {
  assert.equal(auditIdentity(REF), '["github","acme","shop",7]');
  assert.equal(auditIdentity({ ...REF, owner: 'Acme', repo: 'Shop' }), '["github","acme","shop",7]');
  assert.equal(auditIdentity({ ...REF, owner: 'ac\u0000me' }), '["github","acme","shop",7]');
});

test('the draw is pinned by three vectors', () => {
  const vectors: Array<[string, PullRequestRef, number, number]> = [
    ['acme/shop 7', REF, 18.88, 18.9], ['acme/shop 8', SHOP_8, 4.5, 5], ['acme/other 7', OTHER_7, 42.44, 42.45],
  ];
  for (const [name, ref, below, above] of vectors) {
    assert.equal(drawnForAudit(AUDIT_TEST_KEY, ref, below), false, `${name} at ${below}`);
    assert.equal(drawnForAudit(AUDIT_TEST_KEY, ref, above), true, `${name} at ${above}`);
    assert.equal(drawnForAudit(AUDIT_TEST_KEY, ref, 0), false, `${name} at 0`);
    assert.equal(drawnForAudit(AUDIT_TEST_KEY, ref, 100), true, `${name} at 100`);
  }
  const at = (key: string, share: number): boolean[] => [REF, SHOP_8, OTHER_7].map((ref) => drawnForAudit(key, ref, share));
  assert.deepEqual(at(AUDIT_TEST_KEY, 5), [false, true, false]);
  const shouted: PullRequestRef = { ...SHOP_8, owner: 'Acme', repo: 'Shop' };
  assert.equal(drawnForAudit(AUDIT_TEST_KEY, shouted, 5), true);
  assert.equal(drawnForAudit(AUDIT_TEST_KEY, shouted, 4.5), false);
  assert.deepEqual(at(AUDIT_TEST_KEY_CHANGED, 5), [false, false, false]);
  assert.deepEqual(at(AUDIT_TEST_KEY, 37.5), [true, true, false]);
});

test('at 0 nothing is drawn, and no key is needed', () => {
  assert.equal(drawnForAudit(undefined, REF, 0), false);
  assert.equal(drawnForAudit('', REF, 0), false);
  assert.equal(drawnForAudit(AUDIT_TEST_KEY, REF, -0), false);
  assert.equal(drawnForAudit(undefined, REF, -0), false);
});

test('what cannot be told is drawn: no key, an empty key, a share that is no number from 0 to 100, a pull request of the wrong shape', () => {
  const cases: Array<[string, () => boolean]> = [
    ['no key', () => drawnForAudit(undefined, REF, 5)],
    ['an empty key', () => drawnForAudit('', REF, 5)],
    ['a share NaN', () => drawnForAudit(AUDIT_TEST_KEY, REF, NaN)],
    ['a share -1', () => drawnForAudit(AUDIT_TEST_KEY, REF, -1)],
    ['a share 101', () => drawnForAudit(AUDIT_TEST_KEY, REF, 101)],
    ['a share written as text', () => drawnForAudit(AUDIT_TEST_KEY, REF, '5' as never)],
    ['a key that is a number', () => drawnForAudit(7 as never, REF, 5)],
    ['no pull request', () => drawnForAudit(AUDIT_TEST_KEY, null as never, 5)],
    ['an owner that is a number', () => drawnForAudit(AUDIT_TEST_KEY, { ...REF, owner: 7 } as never, 5)],
  ];
  for (const [name, draw] of cases) assert.equal(draw(), true, name);
});

test('over 20,000 pull requests the share drawn is the share written', () => {
  const count = (share: number): number => drawnNumbers(AUDIT_TEST_KEY, share, 20_000).length;
  const within = (share: number, low: number, high: number): void => {
    const drawn = count(share);
    assert.ok(drawn >= low && drawn <= high, `${drawn} drawn at ${share}, not between ${low} and ${high}`);
  };
  within(5, 877, 1_123);
  within(37.5, 7_226, 7_774);
  within(50, 9_717, 10_283);
  assert.equal(count(0), 0);
  assert.equal(count(100), 20_000);
});

test('a pull request drawn at a share is drawn at every higher one, and another key or repository draws another set', () => {
  const atFive = drawnNumbers(AUDIT_TEST_KEY, 5, 2_000);
  assert.ok(atFive.length > 0, 'none drawn at 5');
  for (const number of atFive) {
    assert.equal(drawnForAudit(AUDIT_TEST_KEY, { ...REF, number }, 10), true, `acme/shop ${number} at 10`);
    assert.equal(drawnForAudit(AUDIT_TEST_KEY, { ...REF, number }, 37.5), true, `acme/shop ${number} at 37.5`);
  }
  const inBoth = (a: number[], b: number[]): number => a.filter((number) => b.includes(number)).length;
  const otherKey = drawnNumbers(AUDIT_OTHER_KEY, 5, 2_000);
  assert.ok(otherKey.length > 0, 'none drawn at 5 under the other key');
  assert.ok(inBoth(atFive, otherKey) < 20, `${inBoth(atFive, otherKey)} drawn under both keys`);
  const otherRepo = drawnNumbers(AUDIT_TEST_KEY, 5, 2_000, 'other');
  assert.ok(otherRepo.length > 0, 'none of acme/other drawn at 5');
  assert.ok(inBoth(atFive, otherRepo) < 20, `${inBoth(atFive, otherRepo)} numbers drawn in both repositories`);
});
