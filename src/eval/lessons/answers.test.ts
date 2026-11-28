import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Usage } from '../../engine/types.ts';
import type { Asked, JudgeInput } from '../../memory/judge.ts';
import type { NightReply } from '../../memory/night.ts';
import { judgeInputSha256, keptAsk } from './answers.ts';
import type { JudgeSetting } from './answers.ts';

const USAGE: Usage = { calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, cost: 0.25 };
const SETTING: JudgeSetting = { model: 'vendor/model-a', fallbacks: ['vendor/model-b'], toolChoice: 'forced' };
const INPUT: JudgeInput = { path: 'src/billing/tax.ts', severity: 'major', finding: 'Rounds before the discount.', reply: 'We round half up on purpose.' };
const tmp = (): string => join(mkdtempSync(tmpdir() + '/'), 'answers.jsonl');
const reply = (id: string, attempts = 0): NightReply => ({
  ref: { service: 'github', owner: 'acme', repo: 'shop', number: 7 }, reply: id, association: 'member', body: INPUT.reply, at: '2026-02-27T10:00:00.000Z',
  finding: 'c-1', path: INPUT.path, side: 'RIGHT', line: 12, severity: 'major', findingText: INPUT.finding, attempts,
});
const lesson = (): Asked => ({ ok: true, value: { classification: 'valid_pushback', lesson: 'Invoices round half up on purpose.', quote: 'round half up on purpose' }, usage: { ...USAGE } });
function counting(answer: () => Asked = lesson): { fresh: (input: JudgeInput) => Promise<Asked>; calls: JudgeInput[] } {
  const calls: JudgeInput[] = [];
  return { calls, fresh: async (input) => { calls.push(input); return answer(); } };
}

test('an answer is kept by reply, attempt, setting and input, and a changed reply, attempt, model, fallback or tool choice asks again', async () => {
  const path = tmp();
  const first = counting();
  const a = keptAsk(path, SETTING, first.fresh);
  assert.deepEqual(await a.ask(reply('r1'), INPUT), lesson());
  assert.equal(first.calls.length, 1);
  assert.equal(a.asked(), 1);
  assert.equal(a.spent(), 0.25);

  const same = counting();
  const b = keptAsk(path, SETTING, same.fresh);
  assert.deepEqual(await b.ask(reply('r1'), INPUT), lesson());
  assert.equal(same.calls.length, 0);
  assert.equal(b.asked(), 0);
  assert.equal(b.spent(), 0);

  const changed: Array<[string, JudgeSetting, NightReply, JudgeInput]> = [
    ['another body', SETTING, reply('r1'), { ...INPUT, reply: 'Another body entirely.' }],
    ['another finding', SETTING, reply('r1'), { ...INPUT, finding: 'Another finding.' }],
    ['another attempt', SETTING, reply('r1', 1), INPUT],
    ['another reply', SETTING, reply('r2'), INPUT],
    ['another model', { ...SETTING, model: 'vendor/model-c' }, reply('r1'), INPUT],
    ['another fallback list', { ...SETTING, fallbacks: [] }, reply('r1'), INPUT],
    ['auto in place of forced', { ...SETTING, toolChoice: 'auto' }, reply('r1'), INPUT],
  ];
  for (const [name, setting, r, input] of changed) {
    const fresh = counting();
    const c = keptAsk(path, setting, fresh.fresh);
    await c.ask(r, input);
    assert.equal(fresh.calls.length, 1, name);
  }
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.notEqual(judgeInputSha256(INPUT), judgeInputSha256({ ...INPUT, path: 'src/other.ts' }));
});

test('a kept-answers file with a bad line is refused by its number, and a last line cut short is dropped', async () => {
  const path = tmp();
  const seed = keptAsk(path, SETTING, counting().fresh);
  await seed.ask(reply('r1'), INPUT);
  await seed.ask(reply('r2'), INPUT);
  const good = readFileSync(path, 'utf8').split('\n');
  writeFileSync(path, `${good[0]}\nthis is private text, not json\n${good[1]}\n`);
  assert.throws(() => keptAsk(path, SETTING, counting().fresh), (e: unknown) => e instanceof Error && e.message === 'bad_answers_line_2');

  // a run killed while writing: the first line whole, the second cut short with no line end
  writeFileSync(path, `${good[0]}\n${good[1]!.slice(0, 40)}`);
  const fresh = counting();
  const kept = keptAsk(path, SETTING, fresh.fresh);
  await kept.ask(reply('r1'), INPUT);
  assert.equal(fresh.calls.length, 0);
  await kept.ask(reply('r2'), INPUT);
  assert.equal(fresh.calls.length, 1);
  // the new line stands on a line of its own: the file reads whole again
  const again = counting();
  const reread = keptAsk(path, SETTING, again.fresh);
  await reread.ask(reply('r2'), INPUT);
  assert.equal(again.calls.length, 0);
  appendFileSync(path, '');
});

test('a failure at the provider is never kept, and an answer with no verdict is', async () => {
  const path = tmp();
  const timeout = counting(() => ({ ok: false, code: 'timeout', usage: { ...USAGE, cost: 0.1 } }));
  const a = keptAsk(path, SETTING, timeout.fresh);
  assert.deepEqual(await a.ask(reply('r1'), INPUT), { ok: false, code: 'timeout', usage: { ...USAGE, cost: 0.1 } });
  assert.equal(a.spent(), 0.1);
  assert.equal(readFileSync(path, 'utf8'), '');

  const none = counting(() => ({ ok: false, code: 'invalid_output', usage: { ...USAGE, calls: 2, cost: 0.5 } }));
  const b = keptAsk(path, SETTING, none.fresh);
  await b.ask(reply('r1'), INPUT);
  const after = counting();
  const c = keptAsk(path, SETTING, after.fresh);
  const kept = await c.ask(reply('r1'), INPUT);
  assert.equal(after.calls.length, 0);
  assert.deepEqual(kept, { ok: false, code: 'invalid_output', usage: { ...USAGE, calls: 2, cost: 0.5 } });
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1);
});
