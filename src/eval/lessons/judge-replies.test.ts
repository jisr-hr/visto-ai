import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ProviderError } from '../../engine/model/errors.ts';
import type { ModelClient, ModelResponse } from '../../engine/types.ts';
import { SUBMIT_VERDICT } from '../../memory/judge.ts';
import { findingsText } from './findings.ts';
import type { ExportedFinding, FindingsFile } from './findings.ts';
import { judgeReplies } from './judge-replies.ts';
import type { JudgeSetting } from './answers.ts';
import { loadLessons } from './lessons-file.ts';

const BODY = 'We round half up here on purpose, as the invoices require it.';
const QUOTE = 'round half up here on purpose';
const LESSON = 'A rounding finding on invoice totals is wrong: invoices round half up on purpose.';
const FINDING = 'Rounds before the discount is taken off.';
const PATH = 'src/billing/tax.ts';
const SETTING: JudgeSetting = { model: 'vendor/model-a', fallbacks: [], toolChoice: 'forced' };
const tmp = (): string => mkdtempSync(tmpdir() + '/');

let order = 0;
const finding = (id: string, replies: Array<[string, string]>): ExportedFinding => ({
  repo: 'acme/shop', pr_number: 7, run: { id: 1, head_sha: 'h1', base_sha: 'b1', started_at: '2026-02-27T10:00:00.000Z' },
  comment_id: id, path: PATH, side: 'RIGHT', line: 12, severity: 'major', finding: FINDING,
  replies: replies.map(([rid, at]) => ({ id: rid, order: (order += 1), association: 'member' as const, body: BODY, at })), later: [],
});
const exportFile = (findings: ExportedFinding[]): string => {
  const path = join(tmp(), 'findings.jsonl');
  const file: FindingsFile = { exported_at: '2026-03-05T08:00:00.000Z', findings };
  writeFileSync(path, findingsText(file));
  return path;
};
/** Three replies on three days: three judge calls of cost 0.25 each. */
const three = (): string => exportFile([finding('c-1', [['r1', '2026-03-01T10:00:00.000Z'], ['r2', '2026-03-02T10:00:00.000Z'], ['r3', '2026-03-03T10:00:00.000Z']])]);

function fake(fail: Error | null = null): { client: ModelClient; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    client: {
      complete: async (): Promise<ModelResponse> => {
        n += 1;
        if (fail !== null) throw fail;
        return {
          toolName: SUBMIT_VERDICT, toolArguments: JSON.stringify({ classification: 'valid_pushback', lesson: LESSON, quote: QUOTE }),
          text: null, model: 'm', provider: null, usage: { calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, cost: 0.25 },
        };
      },
    },
  };
}
const args = (findingsPath: string, outDir: string, model: ModelClient, over: { maxCost?: number } = {}) =>
  ({ findingsPath, outDir, maxCost: over.maxCost ?? 2, setting: SETTING, model, token: () => 't0k', timeoutMs: 1000 });
const printed = (lines: string[]): Record<string, number> => Object.fromEntries(
  lines[0]!.split(', ').map((p) => { const i = p.lastIndexOf(' '); return [p.slice(0, i), Number(p.slice(i + 1))]; }));

test('a second run over the same export asks nothing and writes the same lessons', async () => {
  const input = three();
  const out = tmp();
  const first = fake();
  const one = await judgeReplies(args(input, out, first.client));
  assert.equal(first.calls(), 3);
  assert.equal(printed(one)['asked now'], 3);
  assert.equal(printed(one)['spent now'], 0.75);
  const bytes = readFileSync(join(out, 'lessons.json'));

  const second = fake();
  const two = await judgeReplies(args(input, out, second.client));
  assert.equal(second.calls(), 0);
  assert.equal(printed(two)['asked now'], 0);
  assert.equal(printed(two)['spent now'], 0);
  assert.equal(printed(two).lessons, printed(one).lessons);
  assert.equal(printed(two).cost, printed(one).cost);
  assert.deepEqual(readFileSync(join(out, 'lessons.json')), bytes);
  assert.equal(statSync(join(out, 'answers.jsonl')).mode & 0o777, 0o600);
  assert.equal(statSync(join(out, 'lessons.json')).mode & 0o777, 0o600);
  assert.equal(loadLessons(join(out, 'lessons.json')).file.complete, true);
});

test('a run that met a failure at the provider writes complete false, and every reader refuses it', async () => {
  const out = tmp();
  const lines = await judgeReplies(args(three(), out, fake(new ProviderError('rate_limited', 'rate_limited', 429, null)).client));
  assert.equal(lines.at(-1), 'stopped: rate_limited');
  const text = JSON.parse(readFileSync(join(out, 'lessons.json'), 'utf8')) as { complete: boolean; end: string };
  assert.equal(text.complete, false);
  assert.equal(text.end, 'rate_limited');
  assert.throws(() => loadLessons(join(out, 'lessons.json')), { message: 'lessons_incomplete' });
  assert.equal(readFileSync(join(out, 'answers.jsonl'), 'utf8'), '');
});

test('the spend limit counts only what this run spends', async () => {
  const input = three();
  const out = tmp();
  const model = fake();
  const lines = await judgeReplies(args(input, out, model.client, { maxCost: 0.5 }));
  assert.equal(model.calls(), 2);
  assert.equal(lines.at(-1), 'stopped: spend_limit');
  assert.equal(printed(lines)['spent now'], 0.5);
  // a second run answers the two kept for nothing, asks the third, and is whole
  const next = fake();
  const rest = await judgeReplies(args(input, out, next.client, { maxCost: 0.5 }));
  assert.equal(next.calls(), 1);
  assert.equal(rest.length, 1);
  assert.equal(loadLessons(join(out, 'lessons.json')).file.complete, true);
});

test('nothing printed or in summary.md holds a reply, a finding, a lesson, a quote, a path or a login', async () => {
  const input = three();
  const out = tmp();
  const lines = await judgeReplies(args(input, out, fake().client));
  const hay = lines.join('\n') + '\n' + readFileSync(join(out, 'summary.md'), 'utf8');
  for (const secret of [BODY, QUOTE, LESSON, FINDING, PATH, input, out, 'acme', 'shop', 'ana', 'r1']) assert.ok(!hay.includes(secret), secret);
  assert.match(lines[0]!, /^nights \d+, judged \d+, lessons \d+, given up \d+, waiting \d+, calls \d+, asked now \d+, cost [\d.]+, spent now [\d.]+$/);
});

test('a run that dies leaves no lessons.json or summary.md of an older run behind', async () => {
  const out = tmp();
  await judgeReplies(args(three(), out, fake().client));
  assert.ok(existsSync(join(out, 'lessons.json')) && existsSync(join(out, 'summary.md')));
  writeFileSync(join(out, 'answers.jsonl'), 'not json\n');
  await assert.rejects(judgeReplies(args(three(), out, fake().client)), { message: 'bad_answers_line_1' });
  assert.equal(existsSync(join(out, 'lessons.json')), false);
  assert.equal(existsSync(join(out, 'summary.md')), false);
});
