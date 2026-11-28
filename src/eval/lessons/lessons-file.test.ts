import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LESSONS_READ } from '../../memory/lessons.ts';
import { lessonsAt, lessonsMemory, loadLessons, writeLessons } from './lessons-file.ts';
import type { LessonsFile } from './lessons-file.ts';
import type { SimLesson, SimVerdict } from './nights.ts';

const MADE = '2026-03-02T00:00:00.000Z';
const EXPIRES = '2026-05-31T00:00:00.000Z';
const SECRET = 'Invoices round half up on purpose.';
const lesson = (over: Partial<SimLesson> = {}): SimLesson => ({
  ref: '7:r1', repo: 'acme/shop', number: 7, reply: 'r1', path: 'src/billing/tax.ts', text: SECRET,
  createdAt: '2026-03-01T00:00:00.000Z', madeAt: MADE, expiresAt: EXPIRES, ...over,
});
const verdict = (over: Partial<SimVerdict> = {}): SimVerdict => ({
  repo: 'acme/shop', number: 7, reply: 'r1', finding: 'c-1', classification: 'valid_pushback', outcome: 'lesson', attempts: 1, night: MADE, ...over,
});
const fileOf = (over: Partial<LessonsFile> = {}): LessonsFile => ({
  version: 1, findings_file: 'findings.jsonl', findings_sha256: 'a'.repeat(64), exported_at: '2026-03-20T08:00:00.000Z',
  setting: { model: 'vendor/model-a', fallbacks: [], toolChoice: 'forced' }, rules_sha256: 'b'.repeat(64),
  complete: true, end: null, nights: 19, first_night: MADE, last_night: '2026-03-20T00:00:00.000Z', cost: 1.5,
  verdicts: [verdict(), verdict({ reply: 'r2', classification: null, outcome: 'finding_unknown' })], lessons: [lesson()], ...over,
});
const tmp = (): string => mkdtempSync(tmpdir() + '/');
const FILES = [{ path: 'src/billing/tax.ts', previousPath: null }];
const signal = new AbortController().signal;

test('a lesson is live from the night that made it until it expires, and never for its own pull request', async () => {
  const file = fileOf({ lessons: [lesson(), lesson({ ref: '8:r9', number: 8, reply: 'r9', createdAt: '2026-03-01T12:00:00.000Z', text: 'Discounts apply before tax in this shop, so a finding on the order of the two is wrong.' })] });
  const at = (iso: string) => Date.parse(iso);
  const refs = (repo: string, iso: string): string[] => lessonsAt(file, repo, new Date(iso)).map((l) => l.ref);
  assert.deepEqual(refs('acme/shop', new Date(at(MADE) - 1).toISOString()), []);
  assert.deepEqual(refs('acme/shop', MADE), ['8:r9', '7:r1']);   // newest createdAt first
  assert.deepEqual(refs('acme/shop', new Date(at(EXPIRES) - 1).toISOString()).length, 2);
  assert.deepEqual(refs('acme/shop', EXPIRES), []);
  assert.deepEqual(refs('acme/web', MADE), []);
  assert.deepEqual(refs('acme/SHOP', MADE), refs('acme/shop', MADE));
  // made at the night, though created before: not live before the night that made it, whatever createdAt says
  assert.deepEqual(refs('acme/shop', '2026-03-01T06:00:00.000Z'), []);

  const memory = lessonsMemory(file, 'acme/shop', 7);
  const shown = await memory.lessons!(FILES, new Date(MADE), signal);
  assert.deepEqual(shown.lessons.map((l) => l.ref), ['8:r9']);
  const none = await memory.blocks(FILES, new Date(MADE), signal);
  assert.deepEqual(none.pullRequest, []);
});

test('lessons are newest first, then by ref, and at most LESSONS_READ + 1', () => {
  const many = Array.from({ length: LESSONS_READ + 5 }, (_, i) => lesson({ ref: `${i}:r`, number: 100 + i, createdAt: new Date(Date.parse('2026-03-01T00:00:00.000Z') - i * 1000).toISOString() }));
  const got = lessonsAt(fileOf({ lessons: many }), 'acme/shop', new Date(MADE));
  assert.equal(got.length, LESSONS_READ + 1);
  assert.equal(got[0]!.ref, '0:r');
  const tie = lessonsAt(fileOf({ lessons: [lesson({ ref: '9:b' }), lesson({ ref: '2:a' })] }), 'acme/shop', new Date(MADE));
  assert.deepEqual(tie.map((l) => l.ref), ['2:a', '9:b']);
});

test('lessons.json is written mode 600 with a summary of counts, and loads back; a file that is not whole is refused', () => {
  const dir = tmp();
  const file = fileOf();
  writeLessons(dir, file);
  assert.equal(statSync(join(dir, 'lessons.json')).mode & 0o777, 0o600);
  const loaded = loadLessons(join(dir, 'lessons.json'));
  assert.deepEqual(loaded.file, file);
  assert.match(loaded.sha256, /^[0-9a-f]{64}$/);
  const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
  assert.match(summary, /valid_pushback/);
  assert.match(summary, /finding_unknown/);
  assert.ok(!summary.includes(SECRET));
  assert.ok(!summary.includes('src/billing'));
  assert.ok(!summary.includes('acme'));

  writeLessons(dir, fileOf({ complete: false, end: 'rate_limited' }));
  assert.throws(() => loadLessons(join(dir, 'lessons.json')), { message: 'lessons_incomplete' });
  writeFileSync(join(dir, 'lessons.json'), '{"version":1,"private":"text"}');
  assert.throws(() => loadLessons(join(dir, 'lessons.json')), (e: unknown) => e instanceof Error && e.message === 'bad_lessons_file');
  writeFileSync(join(dir, 'lessons.json'), 'not json');
  assert.throws(() => loadLessons(join(dir, 'lessons.json')), { message: 'bad_lessons_file' });
});
