import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryBlocks } from '../engine/types.ts';
import { MEMORY_NAME } from '../engine/context/memory.ts';
import { countsOf, createMemory, dayStart, linesFor, readTime, RECORDS_READ, type LiveRecord, type RecordSource } from './select.ts';

let serial = 0;
function rec(number: number, path: string, createdAt: string, over: Partial<LiveRecord> = {}): LiveRecord {
  const slash = path.lastIndexOf('/');
  serial += 1;
  return {
    ref: `${number}:h${String(serial).padStart(5, '0')}:${path}`,
    number, path, directory: slash < 0 ? '.' : path.slice(0, slash), category: null, missed: false, createdAt, ...over,
  };
}
function source(records: LiveRecord[]): RecordSource & { calls: Date[] } {
  const calls: Date[] = [];
  return {
    calls,
    async live(at: Date) {
      calls.push(at);
      return records.filter((r) => Date.parse(r.createdAt) <= at.getTime());
    },
  };
}
const file = (path: string, previousPath: string | null = null) => ({ path, previousPath });
const AS_OF = new Date('2026-03-20T12:00:00.000Z');
const signal = new AbortController().signal;
const blocksOf = (records: LiveRecord[], files: Array<{ path: string; previousPath: string | null }>, own = 7, asOf = AS_OF) =>
  createMemory(source(records), own).blocks(files, asOf, signal);
const day = (d: number, h = 9) => `2026-03-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;

test('records on a changed file are shown newest first, three at most', async () => {
  const records = [1, 2, 3, 4, 5].map((d) => rec(10 + d, 'src/billing/tax.ts', day(d), { category: d === 5 ? 'billing' : null, missed: d === 4 }));
  const got = await blocksOf(records, [file('src/billing/tax.ts')]);
  assert.deepEqual(got.pullRequest, [
    { ref: records[4]!.ref, near: false, path: 'src/billing/tax.ts', day: '2026-03-05', category: 'billing', missed: false },
    { ref: records[3]!.ref, near: false, path: 'src/billing/tax.ts', day: '2026-03-04', category: null, missed: true },
    { ref: records[2]!.ref, near: false, path: 'src/billing/tax.ts', day: '2026-03-03', category: null, missed: false },
  ]);
  // a record whose time is no time is passed over
  const dated = linesFor([file('src/billing/tax.ts')], [rec(20, 'src/billing/tax.ts', 'yesterday'), records[0]!]);
  assert.deepEqual(dated.lines.map((l) => l.ref), [records[0]!.ref]);
});

test('a renamed file is shown the records of its old path', async () => {
  const old = rec(8, 'src/billing/tax.ts', day(2));
  const now = rec(9, 'src/billing/fees.ts', day(3));
  const got = await blocksOf([old, now, rec(10, 'src/billing/other.ts', day(4))], [file('src/billing/fees.ts', 'src/billing/tax.ts')]);
  assert.deepEqual(got.pullRequest.map((l) => [l.ref, l.near, l.path]), [[now.ref, false, 'src/billing/fees.ts'], [old.ref, false, 'src/billing/tax.ts']]);
});

test('a file with no record is shown the newest two of the nearest directory that has any', async () => {
  const tax = [1, 2, 3].map((d) => rec(10 + d, 'src/billing/tax/rates.ts', day(d)));
  const cart = rec(20, 'src/cart/add.ts', day(9));
  const got = await blocksOf([...tax, cart], [file('src/billing/invoice/new.ts')]);
  assert.deepEqual(got.pullRequest.map((l) => [l.ref, l.near]), [[tax[2]!.ref, true], [tax[1]!.ref, true]]);
  const invoice = rec(30, 'src/billing/invoice/old.ts', day(1));
  const closer = await blocksOf([...tax, cart, invoice], [file('src/billing/invoice/new.ts')]);
  assert.deepEqual(closer.pullRequest.map((l) => [l.ref, l.near, l.path]), [[invoice.ref, true, 'src/billing/invoice/old.ts']]);
});

test('the root is never the nearest directory', async () => {
  const pkg = rec(8, 'package.json', day(2));
  const lib = rec(9, 'lib/util.ts', day(3));
  assert.deepEqual(linesFor([file('Dockerfile')], [pkg, lib]).lines, []);
  assert.deepEqual(linesFor([file('src/new/a.ts')], [pkg, lib]).lines, []);
  assert.deepEqual((await blocksOf([pkg, lib], [file('Dockerfile'), file('src/new/a.ts')])).pullRequest, []);
});

test('a file with records of its own is shown none from its directory', async () => {
  const own = rec(8, 'src/billing/tax.ts', day(1));
  const others = [rec(9, 'src/billing/fees.ts', day(2)), rec(10, 'src/billing/fees.ts', day(3))];
  const got = await blocksOf([own, ...others], [file('src/billing/tax.ts')]);
  assert.deepEqual(got.pullRequest.map((l) => [l.ref, l.near]), [[own.ref, false]]);
});

test('a record is shown once, however many files it is near', async () => {
  const near = [rec(8, 'src/billing/fees.ts', day(1)), rec(9, 'src/billing/tax.ts', day(2))];
  const got = await blocksOf(near, ['a', 'b', 'c'].map((n) => file(`src/billing/new/${n}.ts`)));
  assert.deepEqual(got.pullRequest.map((l) => [l.ref, l.near]), [[near[1]!.ref, true], [near[0]!.ref, true]]);
  // and a record on a changed file is not shown again near another
  const on = await blocksOf(near, [file('src/billing/new/a.ts'), file('src/billing/tax.ts')]);
  assert.deepEqual(on.pullRequest.map((l) => [l.ref, l.near]), [[near[1]!.ref, false], [near[0]!.ref, true]]);
});

test('lines on changed files come before lines near them, and the thirty-first is left out and counted', async () => {
  const near = [rec(50, 'src/billing/x.ts', day(1)), rec(51, 'src/billing/y.ts', day(2))];
  const own = (i: number) => [1, 2, 3].map((d) => rec(10 + i, `src/cart/f${i}.ts`, day(d)));
  const small = await blocksOf([...near, ...own(0)], [file('src/billing/new/g.ts'), file('src/cart/f0.ts')]);
  assert.deepEqual(small.pullRequest.map((l) => l.near), [false, false, false, true, true]);
  assert.equal(small.cut.lines, 0);
  const records = [...near, ...Array.from({ length: 10 }, (_, i) => own(i)).flat()];
  const files = [file('src/billing/new/g.ts'), ...Array.from({ length: 10 }, (_, i) => file(`src/cart/f${i}.ts`))];
  const got = await blocksOf(records, files);
  assert.equal(got.pullRequest.length, 30);
  assert.ok(got.pullRequest.every((l) => !l.near));
  assert.deepEqual(got.pullRequest.slice(0, 3).map((l) => l.path), ['src/cart/f0.ts', 'src/cart/f0.ts', 'src/cart/f0.ts']);
  assert.equal(got.cut.lines, 2);
});

test('with no line for the changed files nothing is returned, and the records of the day are not read', async () => {
  const records = [rec(8, 'src/billing/tax.ts', day(1)), rec(9, 'src/billing/tax.ts', day(2))];
  const src = source(records);
  const got = await createMemory(src, 7).blocks([file('docs/readme.md')], AS_OF, signal);
  assert.equal(src.calls.length, 1);
  assert.deepEqual(got, {
    repository: { directories: [], categories: [] },
    pullRequest: [],
    cut: { directories: 0, categories: 0, lines: 0, names: 0, records: false },
  } satisfies MemoryBlocks);
});

test('the records of the pull request the memory was made for are in neither block', async () => {
  const seven = [rec(7, 'src/billing/tax.ts', day(5)), rec(7, 'src/billing/fees.ts', day(4))];
  const eight = rec(8, 'src/billing/tax.ts', day(3));
  const nine = rec(9, 'src/billing/tax.ts', day(2));
  const records = [...seven, eight, nine];
  const files = [file('src/billing/tax.ts')];
  const forSeven = await blocksOf(records, files, 7);
  assert.deepEqual(forSeven.pullRequest.map((l) => l.ref), [eight.ref, nine.ref]);
  assert.deepEqual(forSeven.repository.directories, [{ name: 'src/billing', pullRequests: 2 }]);
  const forEight = await blocksOf(records, files, 8);
  assert.deepEqual(forEight.pullRequest.map((l) => l.ref), [seven[0]!.ref, nine.ref]);
  assert.deepEqual(forEight.repository.directories, [{ name: 'src/billing', pullRequests: 2 }]);
});

test('the paths of file-based routing are printable, and a path with a space, a colon, a backtick or a line break is not', async () => {
  const routing = ['app/[id]/page.tsx', '(group)/layout.tsx', '@modal/x.ts', '+page.svelte'];
  for (const name of [...routing, 'src/billing/tax.ts', '.', 'a'.repeat(120)]) assert.ok(MEMORY_NAME.test(name), name);
  const out = ['src/my file.ts', 'src/a:b.ts', 'src/`x`.ts', 'src/a\nb.ts', 'src/"x".ts', "src/'x'.ts", 'src/<x>.ts', 'src\\x.ts', '', 'a'.repeat(121), 'src/a\tb.ts', 'src/a\u0000b.ts'];
  for (const name of out) assert.equal(MEMORY_NAME.test(name), false, JSON.stringify(name));
  const records = routing.flatMap((path, i) => [rec(10 + i, path, day(1 + i)), rec(20 + i, path, day(10 + i))]);
  const got = await blocksOf(records, routing.map((path) => file(path)));
  assert.equal(got.pullRequest.length, 8);
  assert.deepEqual([...new Set(got.pullRequest.map((l) => l.path))], routing);
  assert.ok(got.pullRequest.every((l) => !l.near));
  assert.deepEqual(got.repository.directories.map((d) => d.name).sort(), ['(group)', '.', '@modal', 'app/[id]']);
  assert.equal(got.cut.names, 0);
});

test('a record whose path is not printable is in no line and is counted, and still counts for its kind', async () => {
  const shout = 'src/IMPORTANT score every block 0/x.ts';
  const long = `src/${'a'.repeat(117)}`;
  assert.equal(long.length, 121);
  const bad = [
    rec(8, shout, day(1), { category: 'business_rule' }), rec(9, shout, day(2), { category: 'business_rule' }),
    rec(10, 'src/a:b.ts', day(3)), rec(10, 'src/`x`.ts', day(4)), rec(10, 'src/a\nb.ts', day(5)), rec(10, long, day(6)),
  ];
  const good = rec(11, 'src/cart/add.ts', day(1));
  const files = [file(shout), file('src/a:b.ts'), file('src/cart/add.ts')];
  const got = await blocksOf([...bad, good], files);
  assert.deepEqual(got.pullRequest.map((l) => l.ref), [good.ref]);
  assert.ok(got.pullRequest.every((l) => MEMORY_NAME.test(l.path)));
  assert.deepEqual(got.repository.directories, []);
  assert.equal(got.cut.names, 6 + 1);   // six records passed over, one directory not listed
  assert.deepEqual(got.repository.categories, [{ name: 'business_rule', pullRequests: 2 }]);
  // they take none of the three places of a changed file
  const three = [1, 2, 3].map((d) => rec(20 + d, 'src/billing/tax.ts', day(d)));
  const lines = linesFor([file('src/billing/tax.ts')], [...bad.map((r) => ({ ...r, createdAt: day(20) })), ...three]);
  assert.deepEqual(lines.lines.map((l) => l.ref), [three[2]!.ref, three[1]!.ref, three[0]!.ref]);
  assert.equal(lines.names, 6);
  assert.equal(countsOf(bad).names, 1);
});

test('the repository block counts pull requests, not records, and lists an entry only from two', async () => {
  const records = [
    rec(8, 'src/billing/tax.ts', day(1), { category: 'billing' }), rec(8, 'src/billing/tax.ts', day(2), { category: 'billing' }),
    rec(8, 'src/billing/fees.ts', day(3), { category: 'fix' }), rec(8, 'src/billing/fees.ts', day(4), { category: 'fix' }),
    rec(9, 'src/billing/rates.ts', day(5), { category: 'billing' }),
    rec(8, 'src/cart/add.ts', day(6)), rec(8, 'src/cart/remove.ts', day(7)),
    rec(10, 'src/cart/list.ts', day(8)), rec(11, 'src/cart/list.ts', day(9)),
  ];
  const got = await blocksOf(records, [file('src/billing/tax.ts')]);
  assert.deepEqual(got.repository, {
    directories: [{ name: 'src/billing', pullRequests: 2 }, { name: 'src/cart', pullRequests: 3 }].sort((a, b) => b.pullRequests - a.pullRequests),
    categories: [{ name: 'billing', pullRequests: 2 }],
  });
  const lone = await blocksOf(records.slice(0, 4), [file('src/billing/tax.ts')]);
  assert.deepEqual(lone.repository, { directories: [], categories: [] });
  assert.equal(lone.cut.directories, 0);
});

test('the lists are ordered by count, then by name by code unit, and what passes ten directories or eight categories is counted', async () => {
  const records: LiveRecord[] = [];
  const add = (dir: string, numbers: number[], category: string | null = null) => {
    for (const n of numbers) records.push(rec(n, `${dir}/f.ts`, day(1 + (n % 20)), { category }));
  };
  add('src/billing', [10, 11, 12]);
  for (const dir of ['d03', 'app', 'd10', 'Zed', 'd00', 'd01', 'd02', 'd04', 'd05', 'd06', 'd07', 'd08', 'd09']) add(dir, [10, 11]);
  add('one', [10]);
  add('src/billing', [10, 11, 12], 'billing');
  for (const category of ['refactor', 'fix', 'calculation', 'other', 'dependency', 'feature', 'formatting', 'migration', 'security_configuration']) add('src/billing', [10, 11], category);
  const got = await blocksOf(records, [file('src/billing/f.ts')]);
  assert.deepEqual(got.repository.directories.map((d) => [d.name, d.pullRequests]), [
    ['src/billing', 3], ['Zed', 2], ['app', 2], ['d00', 2], ['d01', 2], ['d02', 2], ['d03', 2], ['d04', 2], ['d05', 2], ['d06', 2],
  ]);
  assert.equal(got.cut.directories, 4);
  assert.deepEqual(got.repository.categories.map((c) => c.name), ['billing', 'calculation', 'dependency', 'feature', 'fix', 'formatting', 'migration', 'other']);
  assert.equal(got.cut.categories, 2);
});

test('the repository block is the same for every moment of one UTC day, whatever was recorded during it', async () => {
  const before = [rec(8, 'src/billing/tax.ts', '2026-03-09T08:00:00.000Z'), rec(9, 'src/billing/fees.ts', '2026-03-09T23:59:59.999Z')];
  const during = rec(10, 'src/billing/tax.ts', '2026-03-10T10:00:00.000Z');
  const records = [...before, during];
  const files = [file('src/billing/tax.ts')];
  const at = (iso: string) => blocksOf(records, files, 7, new Date(iso));
  const early = await at('2026-03-10T00:00:01.000Z');
  const noon = await at('2026-03-10T12:00:00.000Z');
  const late = await at('2026-03-10T23:59:59.000Z');
  assert.deepEqual(early.repository, { directories: [{ name: 'src/billing', pullRequests: 2 }], categories: [] });
  assert.deepEqual(noon.repository, early.repository);
  assert.deepEqual(late.repository, early.repository);
  assert.deepEqual(early.pullRequest.map((l) => l.ref), [before[0]!.ref]);
  assert.deepEqual(noon.pullRequest.map((l) => l.ref), [during.ref, before[0]!.ref]);
  const next = await at('2026-03-11T00:00:01.000Z');
  assert.deepEqual(next.repository.directories, [{ name: 'src/billing', pullRequests: 3 }]);
  assert.equal(dayStart(new Date('2026-03-10T23:59:59.999Z')).toISOString(), '2026-03-10T00:00:00.000Z');
  assert.equal(dayStart(new Date('2026-03-10T00:00:00.000Z')).toISOString(), '2026-03-10T00:00:00.000Z');
});

test('more records than are read: the newest are kept, and the answer says so', async () => {
  const base = Date.parse('2026-03-15T00:00:00.000Z');
  const make = (count: number) => Array.from({ length: count }, (_, i) =>
    rec(100 + (i % 50), i === 0 || i === count - 1 ? 'src/billing/tax.ts' : 'src/cart/c.ts', new Date(base - i * 60_000).toISOString()));
  const over = make(RECORDS_READ + 1);
  const got = await blocksOf(over, [file('src/billing/tax.ts')]);
  assert.equal(got.cut.records, true);
  assert.deepEqual(got.pullRequest.map((l) => l.ref), [over[0]!.ref]);   // the oldest, on the same file, was not read
  const exact = await blocksOf(make(RECORDS_READ), [file('src/billing/tax.ts')]);
  assert.equal(exact.cut.records, false);
  assert.equal(exact.pullRequest.length, 2);
  // the records of the pull request under review are dropped before the limit
  const withOwn = [...make(RECORDS_READ), rec(7, 'src/cart/c.ts', '2026-03-15T00:00:00.000Z')];
  assert.equal((await blocksOf(withOwn, [file('src/billing/tax.ts')])).cut.records, false);
});

test('the order of what the source returns changes nothing', async () => {
  const records = [
    // made at one moment, with source references in the opposite order of their numbers
    ...[1, 2, 3, 4].map((n) => rec(10 + n, 'src/billing/tax.ts', day(5), { ref: `${20 - n}:b${n}:src/billing/tax.ts`, category: n % 2 ? 'billing' : 'fix' })),
    ...[1, 2, 3].map((n) => rec(20 + n, 'src/billing/fees.ts', day(n))),
    ...[1, 2, 3].map((n) => rec(30 + n, `src/cart/${n}.ts`, day(4))),
    rec(40, 'Zed/a.ts', day(6)), rec(41, 'Zed/b.ts', day(6)), rec(40, 'app/a.ts', day(6)), rec(41, 'app/b.ts', day(6)),
  ];
  const files = [file('src/billing/tax.ts'), file('src/cart/new/x.ts'), file('src/billing/new/y.ts')];
  const first = await blocksOf(records, files);
  const reversed = await blocksOf([...records].reverse(), files);
  const rotated = await blocksOf([...records.slice(5), ...records.slice(0, 5)], files);
  const interleaved = await blocksOf(records.filter((_, i) => i % 2).concat(records.filter((_, i) => i % 2 === 0)), files);
  assert.deepEqual(reversed, first);
  assert.deepEqual(rotated, first);
  assert.deepEqual(interleaved, first);
  assert.equal(JSON.stringify(reversed), JSON.stringify(first));
  // records made at one moment are ordered by their source reference
  assert.deepEqual(first.pullRequest.slice(0, 3).map((l) => l.ref), ['16:b4:src/billing/tax.ts', '17:b3:src/billing/tax.ts', '18:b2:src/billing/tax.ts']);
});

test('a source that rejects is passed on', async () => {
  const failure = new Error('db_down');
  const memory = createMemory({ live: async () => { throw failure; } }, 7);
  await assert.rejects(memory.blocks([file('src/billing/tax.ts')], AS_OF, signal), (error) => error === failure);
  let calls = 0;
  const second = createMemory({
    live: async () => {
      calls += 1;
      if (calls === 2) throw failure;
      return [rec(8, 'src/billing/tax.ts', day(1))];
    },
  }, 7);
  await assert.rejects(second.blocks([file('src/billing/tax.ts')], AS_OF, signal), (error) => error === failure);
});

test('an empty answer still says what it passed over: a changed file whose path is not printable, and the limit of what is read', async () => {
  const spaced = await blocksOf([rec(8, 'src/a b.ts', day(1)), rec(9, 'src/a b.ts', day(2))], [file('src/a b.ts')]);
  assert.deepEqual(spaced.pullRequest, []);
  assert.deepEqual(spaced.repository, { directories: [], categories: [] });
  assert.equal(spaced.cut.names, 2);
  assert.equal(spaced.cut.records, false);
  const base = Date.parse('2026-03-15T00:00:00.000Z');
  const many = Array.from({ length: RECORDS_READ + 1 }, (_, i) =>
    rec(100 + (i % 50), i === RECORDS_READ ? 'src/billing/tax.ts' : 'lib/c.ts', new Date(base - i * 60_000).toISOString()));
  const limited = await blocksOf(many, [file('src/billing/tax.ts')]);
  assert.deepEqual(limited.pullRequest, []);
  assert.equal(limited.cut.records, true);
  assert.equal(limited.cut.names, 0);
});

test('a time is read only with its zone: Z or an offset', () => {
  const at = (createdAt: string) => linesFor([file('src/billing/tax.ts')], [rec(8, 'src/billing/tax.ts', createdAt)]).lines.map((l) => l.day);
  for (const createdAt of ['2026-03-10T01:00:00', '2026-03-10T01:00:00.000', '2026-03-10', '2026/03/10', 'March 10, 2026', 'Tue, 10 Mar 2026 01:00:00 GMT', '2026-03-10T01:00:00+0200', '']) {
    assert.deepEqual(at(createdAt), [], createdAt);
  }
  assert.deepEqual(at('2026-03-10T01:00:00Z'), ['2026-03-10']);
  assert.deepEqual(at('2026-03-10T01:00:00.000Z'), ['2026-03-10']);
  assert.deepEqual(at('2026-03-10T01:00:00+02:00'), ['2026-03-09']);
  assert.deepEqual(at('2026-03-09T23:30:00-01:00'), ['2026-03-10']);
  // a record with no time counts for no list either
  assert.deepEqual(countsOf([rec(8, 'src/billing/a.ts', '2026-03-01T00:00:00'), rec(9, 'src/billing/b.ts', '2026-03-01T00:00:00')]).directories, []);
});

test('the blocks are the same bytes under any zone of the host', async () => {
  const saved = process.env.TZ;
  const records = [
    rec(8, 'src/billing/tax.ts', '2026-03-10T01:00:00+02:00'), rec(9, 'src/billing/fees.ts', '2026-03-09T22:30:00-01:00'),
    rec(10, 'src/billing/tax.ts', '2026-03-10T10:00:00Z'), rec(11, 'src/billing/tax.ts', '2026-03-10T01:00:00'),
  ];
  const answers: string[] = [];
  try {
    for (const zone of ['Pacific/Kiritimati', 'America/Adak', 'UTC']) {
      process.env.TZ = zone;
      const moments = ['2026-03-10T00:00:01.000Z', '2026-03-10T12:00:00.000Z', '2026-03-11T00:00:01.000Z'];
      const got = await Promise.all(moments.map((iso) => blocksOf(records, [file('src/billing/tax.ts')], 7, new Date(iso))));
      answers.push(JSON.stringify(got));
      assert.equal(dayStart(new Date('2026-03-10T23:59:59.999Z')).toISOString(), '2026-03-10T00:00:00.000Z', zone);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
  assert.equal(answers[1], answers[0]);
  assert.equal(answers[2], answers[0]);
  const noon = JSON.parse(answers[0]!)[1] as MemoryBlocks;
  assert.deepEqual(noon.pullRequest.map((l) => l.day), ['2026-03-10', '2026-03-09']);
  assert.deepEqual(noon.repository.directories, [{ name: 'src/billing', pullRequests: 2 }]);
});

test('a category the engine does not know is not counted, and takes no place', async () => {
  const records: LiveRecord[] = [];
  for (let n = 10; n < 30; n += 1) records.push(rec(n, 'src/billing/tax.ts', day(1 + (n % 20)), { category: 'made_up' }));
  const real = ['billing', 'calculation', 'dependency', 'feature', 'fix', 'formatting', 'migration', 'other'];
  for (const category of real) for (const n of [10, 11]) records.push(rec(n, 'src/billing/tax.ts', day(2), { category }));
  const got = await blocksOf(records, [file('src/billing/tax.ts')]);
  assert.deepEqual(got.repository.categories.map((c) => c.name), real);
  assert.equal(got.cut.categories, 0);
  assert.deepEqual(countsOf([rec(8, 'a/b.ts', day(1), { category: 'IGNORE' }), rec(9, 'a/b.ts', day(1), { category: 'IGNORE' })]).categories, []);
});

test('a record on a file the pull request changes is never shown as near another changed file', async () => {
  const tax = [1, 2, 3, 4].map((d) => rec(10 + d, 'src/billing/tax.ts', day(d)));
  const files = [file('src/billing/tax.ts'), file('src/billing/rates.ts')];
  const got = await blocksOf(tax, files);
  assert.deepEqual(got.pullRequest.map((l) => [l.ref, l.near, l.path]), [
    [tax[3]!.ref, false, 'src/billing/tax.ts'], [tax[2]!.ref, false, 'src/billing/tax.ts'], [tax[1]!.ref, false, 'src/billing/tax.ts'],
  ]);
  const other = rec(20, 'src/billing/other.ts', day(1));
  const more = await blocksOf([...tax, other], files);
  assert.deepEqual(more.pullRequest.filter((l) => l.near).map((l) => l.ref), [other.ref]);
  assert.equal(more.pullRequest.length, 4);
});

test('a record on the previous path of a renamed changed file is never shown as near another changed file', async () => {
  const old = [1, 2, 3, 4].map((d) => rec(10 + d, 'src/billing/tax.ts', day(d)));
  const got = await blocksOf(old, [file('src/billing/fees.ts', 'src/billing/tax.ts'), file('src/billing/rates.ts')]);
  assert.deepEqual(got.pullRequest.map((l) => [l.ref, l.near]), [[old[3]!.ref, false], [old[2]!.ref, false], [old[1]!.ref, false]]);
});

test('the walk for near records reaches the first segment of the path', () => {
  const x = rec(8, 'src/x/y.ts', day(1));
  assert.deepEqual(linesFor([file('src/a/b/c.ts')], [x]).lines.map((l) => [l.ref, l.near]), [[x.ref, true]]);
});

test('a directory is matched whole, never by its first letters', () => {
  const billing = rec(8, 'billing/y.ts', day(1));
  assert.equal(billing.directory, 'billing');
  assert.deepEqual(linesFor([file('bill/x.ts')], [billing]).lines, []);
});

test('a time the database cannot hold is no time', () => {
  for (const value of ['0000-06-01T00:00:00Z', '0000-12-31T23:59:59Z', '2026-02-30T00:00:00Z', '2026-02-29T12:00:00Z', '2026-04-31T00:00:00+02:00', '0001-01-01T00:00:00+05:00']) {
    assert.equal(readTime(value), null, value);
  }
  assert.equal(readTime('0001-01-01T00:00:00Z'), Date.parse('0001-01-01T00:00:00Z'));
  assert.equal(readTime('2024-02-29T23:59:59Z'), Date.parse('2024-02-29T23:59:59Z'));
  assert.equal(readTime('2026-03-01T00:30:00+01:00'), Date.parse('2026-02-28T23:30:00Z'));
});
