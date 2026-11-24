import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVERT_DAYS, REVERT_DESCRIPTION_CHARS, REVERT_FILES, revertedFiles, revertedNumber, revertsOf,
  type RevertInput,
} from './reverts.ts';

const REPO = { owner: 'acme', repo: 'shop' };
const TAX = { path: 'src/billing/tax.ts', previousPath: null };
const ADD = { path: 'src/cart/add.ts', previousPath: null };
const input = (over: Partial<RevertInput> = {}): RevertInput => ({
  number: 9, mergedAt: '2026-03-10T12:00:00Z', reverted: 7, revertedStored: true, revertedMergedAt: '2026-03-05T09:00:00Z',
  files: [TAX, ADD], ...over,
});

test('the sizes are the plan\'s', () => {
  assert.equal(REVERT_DAYS, 180);
  assert.equal(REVERT_DESCRIPTION_CHARS, 4_000);
  assert.equal(REVERT_FILES, 300);
});

test('the line the revert button writes, as the first line that is not blank, names the pull request it reverts', () => {
  assert.equal(revertedNumber('Reverts acme/shop#7', REPO), 7);
  assert.equal(revertedNumber('Reverts acme/shop#7\n\nThis reverts the totals.\nMore text.', REPO), 7);
  assert.equal(revertedNumber('\n\n \t \nReverts acme/shop#7', REPO), 7);
  for (const tail of [' because the totals were wrong', '.', '/files', ' -->']) {
    assert.equal(revertedNumber(`Reverts acme/shop#7\n${tail}`, REPO), 7, tail);
  }
  assert.equal(revertedNumber('Reverts acme/shop#7  \t ', REPO), 7);
  assert.equal(revertedNumber('Reverts acme/shop#7 \t\nmore', REPO), 7);
});

// A character by its code point, so that no invisible character is written in this file.
const ch = (code: number) => String.fromCodePoint(code);

test('every line end is read as one, before anything else, and nothing is stripped', () => {
  assert.equal(revertedNumber('Reverts acme/shop#7\r3', REPO), 7);
  assert.equal(revertedNumber('Reverts acme/shop#7\r\n3', REPO), 7);
  for (const end of [0x2028, 0x2029, 0x85, 0x0c, 0x0b]) {
    assert.equal(revertedNumber(`Reverts acme/shop#7${ch(end)}3`, REPO), 7, end.toString(16));
    assert.equal(revertedNumber(`Fix the totals.${ch(end)}Reverts acme/shop#7`, REPO), null, end.toString(16));
  }
  assert.equal(revertedNumber('Reverts acme/\nshop#7', REPO), null);
  assert.equal(revertedNumber('Reverts acme/\rshop#7', REPO), null);
  assert.equal(revertedNumber(`Rev${ch(0x200b)}erts acme/shop#7`, REPO), null);
  assert.equal(revertedNumber(`${ch(0x200b)}\nReverts acme/shop#7`, REPO), null);
  assert.equal(revertedNumber(`${ch(0xa0)}\nReverts acme/shop#7`, REPO), null);
  for (const control of [0x202e, 0x2066]) {
    assert.equal(revertedNumber(`${ch(control)}Reverts acme/shop#7`, REPO), null, control.toString(16));
    assert.equal(revertedNumber(`Reverts acme/shop#7${ch(control)}3`, REPO), null, control.toString(16));
    assert.equal(revertedNumber(`Reverts acme/shop#1${ch(control)}2`, REPO), null, control.toString(16));
    assert.equal(revertedNumber(`Reverts acme/shop#7${ch(control)}`, REPO), null, control.toString(16));
  }
  assert.equal(revertedNumber(`Reverts acme/shop#7${ch(0xa0)}`, REPO), null);
  assert.equal(revertedNumber(`Reverts acme/shop#7${ch(0x200b)}`, REPO), null);
  assert.equal(revertedNumber(`Reverts acme/shop${ch(0x200b)}#7`, REPO), null);
});

test('the reference counts only as the first line that is not blank, from its first character, in its exact form', () => {
  const none = [
    'Fix the totals.\nReverts acme/shop#7', '<!--\nReverts acme/shop#7\n-->', '<details>\n\nReverts acme/shop#7\n</details>',
    '```\nReverts acme/shop#7\n```',
    ' Reverts acme/shop#7', '    Reverts acme/shop#7', '\tReverts acme/shop#7', '> Reverts acme/shop#7', '- Reverts acme/shop#7',
    'This reverts acme/shop#7', 'reverts acme/shop#7', 'Reverts #7', 'Reverts acme/shop #7', 'Reverts  acme/shop#7',
    'Reverts acme/shop#07', 'Reverts acme/shop#7a', 'Reverts acme/shop#7_', 'Reverts acme/shop#', 'Revert acme/shop#7', 'Reverts acme/shop/x#7',
    'Reverts acme/shop#0', 'Reverts\tacme/shop#7', 'Reverts acme/shop#7.', 'Reverts acme/shop#7 because it broke', 'Reverts acme/shop#7 -->',
    'Reverts acme/shop#7/files', 'REVERTS acme/shop#7',
  ];
  for (const text of none) assert.equal(revertedNumber(text, REPO), null, JSON.stringify(text));
});

test('a first line that names another repository or a number no pull request can have names nothing, and no later line is read', () => {
  assert.equal(revertedNumber('Reverts other/shop#7', REPO), null);
  assert.equal(revertedNumber('Reverts acme/store#7', REPO), null);
  assert.equal(revertedNumber('Reverts acme/shop#2147483648', REPO), null);
  assert.equal(revertedNumber('Reverts acme/shop#99999999999', REPO), null);
  assert.equal(revertedNumber('Reverts acme/shop#12345678901', REPO), null);
  assert.equal(revertedNumber('Reverts acme/shop#1234567890', REPO), 1234567890);
  assert.equal(revertedNumber('Reverts acme/shop#2147483647', REPO), 2147483647);
  assert.equal(revertedNumber('Reverts other/shop#3\nReverts acme/shop#7', REPO), null);
});

test('the owner and the name are compared in lower case', () => {
  assert.equal(revertedNumber('Reverts Acme/Shop#7', REPO), 7);
  assert.equal(revertedNumber('Reverts acme/shop#7', { owner: 'ACME', repo: 'Shop' }), 7);
});

test('a repository that is no repository names nothing, and nothing throws', () => {
  for (const repo of [null, undefined, {}, { owner: 7, repo: 'shop' }, { owner: 'acme', repo: null }]) {
    assert.equal(revertedNumber('Reverts acme/shop#7', repo as never), null, JSON.stringify(repo));
  }
});

test('only the first 4,000 characters are read, and a reference that ends at the last of them names nothing', () => {
  const ref = 'Reverts acme/shop#7';
  const short = `${' '.repeat(3_979)}\n${ref}`;
  assert.equal(short.length, 3_999);
  assert.equal(revertedNumber(short, REPO), 7);
  const exact = `${' '.repeat(3_980)}\n${ref}`;
  assert.equal(exact.length, 4_000);
  assert.equal(revertedNumber(exact, REPO), null);
  assert.equal(revertedNumber(`${'\n'.repeat(4_000)}${ref}`, REPO), null);
  const over = `${' '.repeat(3_980)}\nReverts acme/shop#71`;
  assert.equal(over.length, 4_001);
  assert.equal(revertedNumber(over, REPO), null);
  const padded = `${' '.repeat(3_970)}\n${ref}   `;
  assert.equal(padded.length, 3_993);
  assert.equal(revertedNumber(padded, REPO), 7);
  const paddedAtCut = `${' '.repeat(3_977)}\n${ref}   `;
  assert.equal(paddedAtCut.length, 4_000);
  assert.equal(revertedNumber(paddedAtCut, REPO), null);
  const endsBeforeCut = `${' '.repeat(3_979)}\n${ref}\n`;
  assert.equal(endsBeforeCut.length, 4_000);
  assert.equal(revertedNumber(endsBeforeCut, REPO), 7);
  assert.equal(revertedNumber('Reverts acme/shop#7\r\nmore', REPO), 7);
});

test('what is no string names nothing, and nothing throws', () => {
  for (const value of [null, undefined, 7, {}, ['Reverts acme/shop#7']]) {
    assert.equal(revertedNumber(value, REPO), null);
  }
});

test('the files of a stored review are their paths and old paths, and what cannot be read is passed over', () => {
  const two = [{ path: 'src/billing/tax.ts', previousPath: null }, { path: 'src/cart/add.ts', previousPath: 'src/cart/old.ts' }];
  assert.deepEqual(revertedFiles(two), two);
  assert.deepEqual(revertedFiles([{ path: 'src/billing/tax.ts', previousPath: null, diffHash: 'd', blocks: [] }]), [{ path: 'src/billing/tax.ts', previousPath: null }]);
  for (const value of [null, 'x', {}]) assert.deepEqual(revertedFiles(value), []);
  const odd = [null, 5, { path: 3 }, { path: '' }, { path: null, previousPath: null }, { path: 'a.ts', previousPath: 7 }, { path: 'b.ts', previousPath: '' }];
  assert.deepEqual(revertedFiles(odd), [{ path: 'a.ts', previousPath: null }, { path: 'b.ts', previousPath: null }]);
});

test('a revert makes one record for each path of the reverted pull request, dated by the merge of the revert and expiring 180 days after', () => {
  const made = revertsOf(input());
  assert.equal(made.code, 'recorded');
  assert.equal(made.cut, 0);
  assert.deepEqual(made.records, [
    { sourceRef: '9:reverts:7:src/billing/tax.ts', number: 9, reverted: 7, path: 'src/billing/tax.ts', directory: 'src/billing', createdAt: '2026-03-10T12:00:00.000Z', expiresAt: '2026-09-06T12:00:00.000Z' },
    { sourceRef: '9:reverts:7:src/cart/add.ts', number: 9, reverted: 7, path: 'src/cart/add.ts', directory: 'src/cart', createdAt: '2026-03-10T12:00:00.000Z', expiresAt: '2026-09-06T12:00:00.000Z' },
  ]);
  const sameTime = revertsOf(input({ revertedMergedAt: '2026-03-10T12:00:00Z' }));
  assert.equal(sameTime.code, 'recorded');
  assert.equal(sameTime.records.length, 2);
});

test('a renamed file is recorded under both its paths, and a path is recorded once', () => {
  const renamed = { path: 'src/cart/add.ts', previousPath: 'src/cart/old.ts' };
  const made = revertsOf(input({ files: [renamed, renamed] }));
  assert.equal(made.code, 'recorded');
  assert.deepEqual(made.records.map((r) => r.path), ['src/cart/add.ts', 'src/cart/old.ts']);
});

test('a path that is not printable makes no record, and the paths past three hundred are left out', () => {
  const made = revertsOf(input({ files: [TAX, { path: 'src/my file.ts', previousPath: null }, { path: `src/${'a'.repeat(117)}`, previousPath: null }, ADD] }));
  assert.equal(`src/${'a'.repeat(117)}`.length, 121);
  assert.deepEqual(made.records.map((r) => r.path), ['src/billing/tax.ts', 'src/cart/add.ts']);
  assert.equal(made.cut, 0);
  const withBad = revertsOf(input({ files: [...Array.from({ length: 300 }, (_, i) => ({ path: `src/cart/f${i}.ts`, previousPath: null })), { path: 'src/my file.ts', previousPath: 'src/a`b.ts' }] }));
  assert.equal(withBad.records.length, 300);
  assert.equal(withBad.cut, 0);
  const many = Array.from({ length: 301 }, (_, i) => ({ path: `src/cart/f${i}.ts`, previousPath: null }));
  const capped = revertsOf(input({ files: many }));
  assert.equal(capped.records.length, 300);
  assert.equal(capped.cut, 1);
  assert.deepEqual(capped.records.map((r) => r.path), many.slice(0, 300).map((f) => f.path));
  const none = revertsOf(input({ files: [{ path: 'src/my file.ts', previousPath: 'src/a`b.ts' }] }));
  assert.deepEqual(none, { code: 'no_files', records: [], cut: 0 });
});

test('a pull request that names itself, one that is not stored, one that is not merged or was merged later, and one with no file make no record, each with its code', () => {
  const cases: Array<[Partial<RevertInput>, string]> = [
    [{ reverted: 9 }, 'same'],
    [{ revertedStored: false }, 'not_stored'],
    [{ revertedMergedAt: null }, 'not_merged'],
    [{ revertedMergedAt: '2026-03-10T12:00:01Z' }, 'not_merged'],
    [{ mergedAt: null }, 'not_merged'],
    [{ files: [] }, 'no_files'],
    [{ reverted: 9, revertedStored: false }, 'same'],
    [{ revertedStored: false, files: [] }, 'not_stored'],
    [{ mergedAt: null, revertedMergedAt: '1969-12-31T00:00:00Z' }, 'not_merged'],
  ];
  for (const [over, code] of cases) assert.deepEqual(revertsOf(input(over)), { code, records: [], cut: 0 }, JSON.stringify(over));
});

test('a time is read only with its zone, and the records are the same bytes under any zone of the host', () => {
  assert.deepEqual(revertsOf(input({ mergedAt: '2026-03-10 12:00:00' })), { code: 'not_merged', records: [], cut: 0 });
  const zone = process.env.TZ;
  try {
    process.env.TZ = 'America/Sao_Paulo';
    const one = revertsOf(input());
    process.env.TZ = 'Asia/Tokyo';
    const two = revertsOf(input());
    assert.deepEqual(one, two);
    assert.equal(one.code, 'recorded');
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test('a merge whose expiry cannot be written as a time is no record', () => {
  assert.deepEqual(revertsOf(input({ mergedAt: '9999-12-31T00:00:00Z' })), { code: 'not_merged', records: [], cut: 0 });
  assert.equal(revertsOf(input({ mergedAt: '9999-01-01T00:00:00Z' })).code, 'recorded');
});
