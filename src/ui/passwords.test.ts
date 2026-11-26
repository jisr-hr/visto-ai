import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { NAME, ONE_TIME_ALPHABET, ONE_TIME_LENGTH, PASSWORD_COST, hashPassword, oneTimePassword, passwordLengthOk, verifyPassword } from './passwords.ts';
import type { PasswordCost } from './passwords.ts';

// Call 4: every hash of these tests is made at COST, but the one that shows the production cost runs on Node.
const COST: PasswordCost = { log2N: 4, r: 1, p: 1 };
const PASSWORD = 'a long password of mine';
const AT_COST = /^scrypt\$4\$1\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The hash with its field at `index` (1 log2N, 2 r, 3 p, 4 salt, 5 key) written as `value`. */
const withField = (hash: string, index: number, value: string): string => {
  const fields = hash.split('$');
  fields[index] = value;
  return fields.join('$');
};
const fieldOf = (hash: string, index: number): string => hash.split('$')[index] ?? '';
/** The text with its last character changed only in the bits base64url leaves unused, so it decodes to the same bytes. */
const lastBitsChanged = (text: string): string => text.slice(0, -1) + (BASE64URL[BASE64URL.indexOf(text.slice(-1)) ^ 1] ?? '');

test('a password is hashed with its own salt and its parameters, and only it verifies', async () => {
  const hash = await hashPassword(PASSWORD, COST);
  assert.match(hash, AT_COST);
  const again = await hashPassword(PASSWORD, COST);
  assert.match(again, AT_COST);
  assert.notEqual(again, hash);
  assert.notEqual(fieldOf(again, 4), fieldOf(hash, 4));
  // The key is scrypt's of the password's UTF-8 bytes with the salt written beside it, 32 bytes.
  const salt = Buffer.from(fieldOf(hash, 4), 'base64url');
  assert.equal(salt.length, 16);
  assert.equal(fieldOf(hash, 5), scryptSync(Buffer.from(PASSWORD, 'utf8'), salt, 32, { N: 16, r: 1, p: 1 }).toString('base64url'));
  assert.equal(await verifyPassword(PASSWORD, hash), true);
  assert.equal(await verifyPassword(PASSWORD, again), true);
  for (const other of ['a long password of minE', '', 'a long password of mine ']) {
    assert.equal(await verifyPassword(other, hash), false, other);
  }
});

test('the production cost is N 2^15, r 8, p 1, and a hash made at it verifies', async () => {
  assert.deepEqual(PASSWORD_COST, { log2N: 15, r: 8, p: 1 });
  const hash = await hashPassword(PASSWORD);
  assert.ok(hash.startsWith('scrypt$15$8$1$'), hash.slice(0, 14));
  assert.match(hash, /^scrypt\$15\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.equal(await verifyPassword(PASSWORD, hash), true);
});

test('a stored value that is not a hash of ours, or names a cost out of bounds, verifies nothing and never throws', async () => {
  const good = await hashPassword(PASSWORD, COST);
  const key = fieldOf(good, 5);
  const firstChanged = (key.startsWith('A') ? 'B' : 'A') + key.slice(1);
  assert.deepEqual(Buffer.from(lastBitsChanged(key), 'base64url'), Buffer.from(key, 'base64url'));
  assert.deepEqual(Buffer.from(lastBitsChanged(fieldOf(good, 4)), 'base64url'), Buffer.from(fieldOf(good, 4), 'base64url'));
  const refused: Record<string, string> = {
    'empty': '',
    'x': 'x',
    'key cut to 42': good.slice(0, -1),
    'key changed': withField(good, 5, firstChanged),
    'log2N 16': withField(good, 1, '16'),
    'log2N 3': withField(good, 1, '3'),
    'r 9': withField(good, 2, '9'),
    'p 2': withField(good, 3, '2'),
    'p 3': withField(good, 3, '3'),
    'first $ doubled': good.replace('$', () => '$$'),
    'every $ doubled': good.split('$').join('$$'),
    'log2N 15, r 1': withField(withField(good, 1, '15'), 2, '1'),
    'log2N 15, r 7': withField(withField(good, 1, '15'), 2, '7'),
    'log2N 15, r 8, p 2': withField(withField(withField(good, 1, '15'), 2, '8'), 3, '2'),
    // Costs scrypt itself refuses, so a verify that reached it would reject.
    'log2N 0': withField(good, 1, '0'),
    'log2N 99': withField(good, 1, '99'),
    'r 0': withField(good, 2, '0'),
    'p 0': withField(good, 3, '0'),
    // Not written as a hash of ours: a number with a leading zero, a salt or a key in another spelling of the same bytes.
    'log2N 04': withField(good, 1, '04'),
    'salt spelled otherwise': withField(good, 4, lastBitsChanged(fieldOf(good, 4))),
    'key spelled otherwise': withField(good, 5, lastBitsChanged(key)),
  };
  for (const [what, stored] of Object.entries(refused)) {
    assert.notEqual(stored, good, what);
    assert.equal(await verifyPassword(PASSWORD, stored), false, what);
  }
  assert.equal(await verifyPassword(PASSWORD, good), true);
});

test('a cost out of bounds is refused before any hash', async () => {
  const refused: PasswordCost[] = [
    { log2N: 3, r: 1, p: 1 }, { log2N: 16, r: 1, p: 1 }, { log2N: 4.5, r: 1, p: 1 },
    { log2N: 4, r: 0, p: 1 }, { log2N: 4, r: 9, p: 1 },
    { log2N: 4, r: 1, p: 0 }, { log2N: 4, r: 1, p: 2 }, { log2N: 4, r: 1, p: 3 },
    { log2N: 15, r: 1, p: 1 }, { log2N: 15, r: 4, p: 1 }, { log2N: 15, r: 7, p: 1 },
  ];
  for (const cost of refused) {
    await assert.rejects(hashPassword(PASSWORD, cost), (error: unknown) => error instanceof Error && error.message === 'bad_cost', JSON.stringify(cost));
  }
  assert.match(await hashPassword(PASSWORD, COST), AT_COST);
});

test('a one-time password is 20 characters of an alphabet with no look-alike, drawn evenly', () => {
  assert.equal(ONE_TIME_ALPHABET.length, 31);
  assert.equal(new Set(ONE_TIME_ALPHABET).size, 31);
  for (const lookAlike of ['0', '1', 'i', 'l', 'o']) assert.ok(!ONE_TIME_ALPHABET.includes(lookAlike), lookAlike);
  assert.doesNotMatch(ONE_TIME_ALPHABET, /[A-Z]/);
  assert.equal(ONE_TIME_LENGTH, 20);
  const counts = new Map<string, number>([...ONE_TIME_ALPHABET].map((letter) => [letter, 0]));
  for (let draw = 0; draw < 1000; draw += 1) {
    const password = oneTimePassword();
    assert.equal(password.length, 20);
    for (const letter of password) {
      const count = counts.get(letter);
      assert.ok(count !== undefined, letter);
      counts.set(letter, count + 1);
    }
  }
  // 20,000 characters over 31: 645 each expected.
  for (const [letter, count] of counts) assert.ok(count >= 400 && count <= 900, `${letter} ${count}`);
});

test('a password has 12 to 128 characters, counted as a person sees them', () => {
  assert.equal(passwordLengthOk('a'.repeat(11)), false);
  assert.equal(passwordLengthOk('a'.repeat(12)), true);
  assert.equal(passwordLengthOk('a'.repeat(128)), true);
  assert.equal(passwordLengthOk('a'.repeat(129)), false);
  assert.equal(passwordLengthOk('\u{1F511}'.repeat(12)), true);
  assert.equal(passwordLengthOk('\u{1F511}'.repeat(129)), false);
  assert.equal(passwordLengthOk(('e' + String.fromCharCode(0x301)).repeat(6)), true);
});

test('a name is 1 to 39 lower-case letters, digits, dots, underscores and hyphens, starting with a letter or a digit', () => {
  for (const name of ['octo-admin', 'a', '9lives', 'a.b_c-d', 'a'.repeat(39)]) assert.match(name, NAME);
  for (const name of ['', 'Octo', '-x', '.x', '_x', 'a'.repeat(40), 'octo admin', 'octo@x', 'octo/x']) assert.doesNotMatch(name, NAME);
});
