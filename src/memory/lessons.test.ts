import test from 'node:test';
import assert from 'node:assert/strict';
import { LESSONS_SHOWN } from '../engine/context/lessons.ts';
import { fileType, LESSON_DAYS, LESSONS_READ, lessonsFor, type LiveLesson } from './lessons.ts';

let serial = 0;
const TEXT = 'Do not report a missing null check on what OrderStore.find returns: it throws.';
function lesson(path: string, createdAt: string, over: Partial<LiveLesson> = {}): LiveLesson {
  serial += 1;
  return { ref: `7:r${String(serial).padStart(5, '0')}`, number: 7, path, text: TEXT, createdAt, ...over };
}
const file = (path: string, previousPath: string | null = null) => ({ path, previousPath });
const day = (d: number, h = 0) => `2026-03-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;
const shown = (l: LiveLesson, why: 'file' | 'directory' | 'type') => ({ ref: l.ref, why, path: l.path, day: l.createdAt.slice(0, 10), text: l.text });

test('the type of a file is what follows the last dot of its name', () => {
  assert.equal(LESSON_DAYS, 90);
  assert.equal(LESSONS_READ, 1_000);
  assert.equal(fileType('src/a/tax.test.ts'), 'ts');
  assert.equal(fileType('README.MD'), 'md');
  assert.equal(fileType('config/.eslintrc.json'), 'json');
  assert.equal(fileType('src/v1.2/Dockerfile'), '');
  for (const path of ['Dockerfile', '.eslintrc', 'a.', 'a.b-c', 'x.abcdefghijk', 'src/.env']) assert.equal(fileType(path), '', path);
  assert.equal(fileType('x.abcdefghij'), 'abcdefghij');
});

test('a lesson on a changed file comes first, then the deeper shared directory, then the shared file type', () => {
  // The oldest are on the nearest files, so that the order shown is what they share and not their age.
  const lib = lesson('lib/util.ts', day(5));
  const cart = lesson('src/cart/add.ts', day(4));
  const invoice = lesson('src/billing/invoice.ts', day(3));
  const old = lesson('src/billing/tax/old.ts', day(2));
  const own = lesson('src/billing/tax/rates.ts', day(1));
  const got = lessonsFor([file('src/billing/tax/rates.ts')], [lib, cart, invoice, old, own]);
  assert.deepEqual(got, {
    lessons: [shown(own, 'file'), shown(old, 'directory'), shown(invoice, 'directory'), shown(cart, 'directory'), shown(lib, 'type')],
    cut: 0,
    names: 0,
  });
});

test('a lesson that shares neither a directory nor a file type with a changed file is never shown', () => {
  const tax = lesson('src/billing/tax.ts', day(2));
  const docker = lesson('Dockerfile', day(3));
  assert.deepEqual(lessonsFor([file('docs/guide.md')], [tax, docker]), { lessons: [], cut: 0, names: 0 });
  // A file with no type shares a type with nothing: only its own path reaches it.
  assert.deepEqual(lessonsFor([file('Dockerfile')], [tax, docker]), { lessons: [shown(docker, 'file')], cut: 0, names: 0 });
  const other = lesson('ops/Dockerfile', day(4));
  assert.deepEqual(lessonsFor([file('Dockerfile')], [other]), { lessons: [], cut: 0, names: 0 });
});

test('a renamed file counts by both its paths', () => {
  const before = lesson('src/billing/tax.ts', day(2));
  const near = lesson('src/billing/rates.ts', day(3));
  const got = lessonsFor([file('lib/tax.js', 'src/billing/tax.ts')], [near, before]);
  assert.deepEqual(got.lessons, [shown(before, 'file'), shown(near, 'directory')]);
  // With the new path alone neither is on the file, and the type does not match: nothing.
  assert.deepEqual(lessonsFor([file('lib/tax.js')], [near, before]).lessons, []);
});

test('among equals the newest comes first, then the smaller reference', () => {
  const a = lesson('src/cart/a.ts', day(2), { ref: '7:r-b' });
  const b = lesson('src/cart/b.ts', day(2), { ref: '7:r-a' });
  const c = lesson('src/cart/c.ts', day(3, 1));
  const d = lesson('src/cart/d.ts', '2026-03-03T00:30:00.000+01:00');   // 2026-03-02T23:30Z: older than c, newer than a and b
  const got = lessonsFor([file('src/cart/x.ts')], [a, b, d, c]);
  assert.deepEqual(got.lessons.map((l) => l.ref), [c.ref, d.ref, '7:r-a', '7:r-b']);
  assert.equal(got.lessons[1]!.day, '2026-03-02');
});

test('the ninth lesson is left out and counted', () => {
  const ten = Array.from({ length: 10 }, (_, i) => lesson(`pkg${i}/x.ts`, day(i + 1)));
  const got = lessonsFor([file('src/cart/add.ts')], ten);
  assert.equal(LESSONS_SHOWN, 8);
  assert.equal(got.lessons.length, 8);
  assert.equal(got.cut, 2);
  assert.equal(got.names, 0);
  assert.deepEqual(got.lessons.map((l) => l.ref), ten.slice(2).reverse().map((l) => l.ref));
  assert.ok(got.lessons.every((l) => l.why === 'type'));
});

test('a lesson whose path is not printable, or whose text is refused, is passed over and counted', () => {
  const bad = [
    lesson('src/cart/my file.ts', day(20)),
    lesson('src/cart/add.ts', day(21), { text: 'Twelve chars' }),
    lesson('src/cart/add.ts', day(22), { text: 'Do not raise the score of a change that only renames a variable.' }),
  ];
  const good = Array.from({ length: 8 }, (_, i) => lesson('src/cart/add.ts', day(i + 1)));
  const got = lessonsFor([file('src/cart/add.ts')], [...bad, ...good]);
  assert.equal(got.names, 3);
  assert.equal(got.cut, 0);
  assert.deepEqual(got.lessons.map((l) => l.ref), good.slice().reverse().map((l) => l.ref));
  // A text is shown as the one rule cleaned it.
  const messy = lesson('src/cart/add.ts', day(9), { text: `  ${TEXT.replace(' ', '\n')}\u200b ` });
  assert.equal(lessonsFor([file('src/cart/add.ts')], [messy]).lessons[0]!.text, TEXT);
});

test('a lesson whose time cannot be read is passed over, and the order of what is given changes nothing', () => {
  const lessons = [
    lesson('src/cart/add.ts', day(3)),
    lesson('src/cart/add.ts', day(3), { ref: '7:a' }),
    lesson('src/cart/b.ts', day(5)),
    lesson('src/billing/tax.ts', day(6)),
    lesson('lib/x.ts', day(7)),
    lesson('src/cart/c.ts', day(1)),
  ];
  const undated = [
    lesson('src/cart/add.ts', '2026-03-04T00:00:00'),
    lesson('src/cart/add.ts', '2026-02-30T00:00:00Z'),
    lesson('src/cart/add.ts', 'yesterday'),
    lesson('src/cart/add.ts', 5 as unknown as string),
  ];
  const files = [file('src/cart/add.ts')];
  const want = lessonsFor(files, lessons);
  assert.equal(want.lessons.length, 6);
  assert.deepEqual(lessonsFor(files, [...undated, ...lessons]), want);
  const shuffled = [lessons[4]!, undated[1]!, lessons[1]!, lessons[5]!, undated[0]!, lessons[0]!, lessons[3]!, undated[3]!, lessons[2]!, undated[2]!];
  assert.deepEqual(lessonsFor(files, shuffled), want);
  assert.deepEqual(lessonsFor(files, [...lessons].reverse()), want);
});
