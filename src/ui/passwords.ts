// Passwords, one-time passwords and names (the password design 4.2 and 4.3; calls 11 and 12). Pure: scrypt from node:crypto,
// no database, no log. A hash names its own parameters, within bounds that no stored value can raise above PASSWORD_COST.
// No error's message holds anything but its short code.
import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import type { BinaryLike, ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

export interface PasswordCost { log2N: number; r: number; p: number }
/** N 2^15, r 8, p 1: the cost of every hash made in production, and the most a stored value may name. */
export const PASSWORD_COST: PasswordCost = { log2N: 15, r: 8, p: 1 };
/** A password account's name: 1 to 39 lower-case letters, digits, dots, underscores and hyphens, starting with a letter or a digit. */
export const NAME = /^[a-z0-9][a-z0-9._-]{0,38}$/;
/** 31 characters: no 0, 1, i, l or o, no capital. */
export const ONE_TIME_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const ONE_TIME_LENGTH = 20;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** `scrypt$<log2N>$<r>$<p>$<salt>$<key>`, the salt and the key in base64url without padding. */
const STORED = /^scrypt\$(\d{1,2})\$(\d)\$(\d)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;
// The overload with options: promisify alone would take scrypt's first, which has none.
const scryptAsync = promisify<BinaryLike, BinaryLike, number, ScryptOptions, Buffer>(scrypt);

/** Rule 1: whole numbers, p exactly 1, log2N 4 to 15, r 1 to 8, and r exactly 8 at log2N 15; so none exceeds PASSWORD_COST. */
function costOk({ log2N, r, p }: PasswordCost): boolean {
  return Number.isInteger(log2N) && Number.isInteger(r) && Number.isInteger(p) && p === 1
    && log2N >= 4 && log2N <= 15 && r >= 1 && r <= 8 && (log2N < 15 || r === 8);
}

/** The key of `password` with `salt` at a cost within the bounds; maxmem 256 N r, 64 MiB at PASSWORD_COST (call 11). */
async function keyOf(password: string, salt: Buffer, { log2N, r, p }: PasswordCost): Promise<Buffer> {
  try {
    return await scryptAsync(Buffer.from(password, 'utf8'), salt, KEY_BYTES, { N: 2 ** log2N, r, p, maxmem: 256 * 2 ** log2N * r });
  } catch {
    throw new Error('scrypt_failed');
  }
}

/** The cost, salt and key of a hash of ours within the bounds, written as hashPassword writes it; null for anything else. */
function parse(stored: string): { cost: PasswordCost; salt: Buffer; key: Buffer } | null {
  const match = STORED.exec(stored);
  if (match === null) return null;
  const [, log2NText = '', rText = '', pText = '', saltText = '', keyText = ''] = match;
  const cost = { log2N: Number(log2NText), r: Number(rText), p: Number(pText) };
  // A leading zero, or a salt or a key in another spelling of the same bytes, is not written by hashPassword.
  if (String(cost.log2N) !== log2NText || !costOk(cost)) return null;
  const salt = Buffer.from(saltText, 'base64url');
  const key = Buffer.from(keyText, 'base64url');
  if (salt.toString('base64url') !== saltText || key.toString('base64url') !== keyText) return null;
  return { cost, salt, key };
}

/** 12 to 128 code points. */
export function passwordLengthOk(password: string): boolean {
  const length = [...password].length;
  return length >= 12 && length <= 128;
}

/** 20 characters of the alphabet, each drawn by randomInt, which has no modulo bias. */
export function oneTimePassword(): string {
  return Array.from({ length: ONE_TIME_LENGTH }, () => ONE_TIME_ALPHABET[randomInt(ONE_TIME_ALPHABET.length)]).join('');
}

/** `scrypt$<log2N>$<r>$<p>$<salt>$<key>`; rejects `bad_cost` for a cost out of bounds, before any work. */
export async function hashPassword(password: string, cost: PasswordCost = PASSWORD_COST): Promise<string> {
  const { log2N, r, p } = cost;
  if (!costOk({ log2N, r, p })) throw new Error('bad_cost');
  const salt = randomBytes(SALT_BYTES);
  const key = await keyOf(password, salt, { log2N, r, p });
  return `scrypt$${log2N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Whether `password` is the one `stored` was made of; false for anything that is not a hash of ours within the bounds. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (parsed === null) return false;
  const key = await keyOf(password, parsed.salt, parsed.cost);
  return timingSafeEqual(key, parsed.key);
}
