import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ModelRequest, ModelResponse, Usage } from '../../engine/types.ts';
import { caseKey } from '../cases.ts';
import type { EvalCase, Label } from '../cases.ts';
import type { CaseResult, ReplayFinding } from '../score.ts';
import { SUBMIT_MATCHES } from './match.ts';
import { runJudge } from './run.ts';

const usage = (cost: number): Usage => ({ calls: 1, inputTokens: 10, outputTokens: 1, cachedTokens: 0, cost });
const label = (path: string, text: string, line = 5): Label =>
  ({ comment_id: 'c', path, line, side: 'RIGHT', severity: '', label: 'valid', text, start_line: line - 1 });
const mkCase = (n: number, labels: Label[]): EvalCase =>
  ({ repo: 'acme/shop', pr_number: n, head_sha: `${n}`.padEnd(12, 'a'), compare_base: 'b', title: 't', body: '', branch: '', base_branch: '', author: '', labels });
const finding = (path: string, body: string, line = 5): ReplayFinding => ({ path, line, side: 'RIGHT', severity: 'minor', body });
const result = (c: EvalCase, over: Partial<CaseResult> = {}): CaseResult => ({
  key: caseKey(c), status: 'ok', failure_stage: null, failure_reason: null, total_cost: 0, total_tokens: 0, duration_ms: 0, calls: 1, cached_tokens: 0,
  models: [], unplaced: 0, files_reviewed: 1, not_reviewed: {}, findings: [], highest_score: null, needs_human: null, ...over,
});

function runDir(results: CaseResult[], extra: Record<string, unknown> = { plain: false }): string {
  const dir = mkdtempSync(join(tmpdir(), 'judge-'));
  writeFileSync(join(dir, 'results.jsonl'), results.map((r) => JSON.stringify(r) + '\n').join(''));
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ summary: { label: 'run-a' }, ...extra }));
  return dir;
}

// The stub answers by the finding's text: "A:1,2" names references 1 and 2 (1-based, as sent); anything else matches none.
function stub(cost = 0.01) {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request: ModelRequest): Promise<ModelResponse> => {
      requests.push(request);
      const user = request.messages[1]!.content as string;
      const m = /A:([\d,]*)/.exec(user);
      const matches = m && m[1] ? m[1].split(',').map(Number) : [];
      return { toolName: SUBMIT_MATCHES, toolArguments: JSON.stringify({ matches, reason: 'why' }), text: null, model: 'm', provider: null, usage: usage(cost) };
    },
  };
}

const base = { casesSha256: 'sha', keep: null, withRunLabel: null, maxCost: 5, concurrency: 1, auto: false, timeoutMs: 1000, token: () => 'tok' };
const lines = (dir: string, name: string): unknown[] => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('runJudge asks once per finding that has references and writes the three files', async () => {
  const c = mkCase(1, [label('a.ts', 'ref one'), label('a.ts', 'ref two')]);
  const dir = runDir([result(c, { findings: [finding('a.ts', 'A:1'), finding('a.ts', 'A:')] })]);
  const model = stub();
  const s = await runJudge({ ...base, cases: [c], runDir: dir, model });
  assert.equal(model.requests.length, 2);
  assert.equal(s.findings, 2);
  assert.equal(s.references, 2);
  assert.equal(s.matched_findings, 1);
  assert.equal(s.covered_references, 1);
  assert.equal(s.precision, 0.5);
  assert.equal(s.recall, 0.5);
  const row = lines(dir, 'judge.jsonl')[0] as { key: string; status: string; references: number; covered: number; findings: { matched: number[]; counted: boolean; reason: string; extra: boolean }[] };
  assert.equal(row.key, caseKey(c));
  assert.equal(row.references, 2);
  assert.equal(row.covered, 1);
  assert.deepEqual(row.findings[0]!.matched, [0]);
  assert.equal(row.findings[0]!.reason, 'why');
  const file = JSON.parse(readFileSync(join(dir, 'judge-summary.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(file.cases_sha256, 'sha');
  assert.equal(file.run_label, 'run-a');
  assert.equal(file.plain, false);
  assert.equal(file.with_run_label, null);
  assert.equal(file.stopped_reason, null);
  assert.equal(file.cases_not_judged, 0);
  assert.match(readFileSync(join(dir, 'judge-summary.md'), 'utf8'), /^\| field \| value \|\n\| --- \| --- \|\n\| label \| run-a \|/);
});

test('runJudge reads plain true from the run and records with_run_label', async () => {
  const c = mkCase(1, [label('a.ts', 'r')]);
  const dir = runDir([result(c)], { plain: true });
  await runJudge({ ...base, cases: [c], runDir: dir, model: stub(), withRunLabel: 'run-b' });
  const file = JSON.parse(readFileSync(join(dir, 'judge-summary.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(file.plain, true);
  assert.equal(file.with_run_label, 'run-b');
});

test('runJudge asks nothing for a finding in a file with no reference', async () => {
  const c = mkCase(1, [label('a.ts', 'ref')]);
  const dir = runDir([result(c, { findings: [finding('other.ts', 'A:1')] })]);
  const model = stub();
  const s = await runJudge({ ...base, cases: [c], runDir: dir, model });
  assert.equal(model.requests.length, 0);
  assert.equal(s.findings, 1);
  assert.equal(s.matched_findings, 0);
  assert.equal((lines(dir, 'judge.jsonl')[0] as { findings: { judge: string }[] }).findings[0]!.judge, 'no_reference');
});

test('runJudge maps a file\'s reference numbers back to the case\'s references', async () => {
  const c = mkCase(1, [label('a.ts', 'a1'), label('b.ts', 'b1'), label('a.ts', 'a2'), label('b.ts', 'b2')]);
  const dir = runDir([result(c, { findings: [finding('b.ts', 'A:2'), finding('a.ts', 'A:2')] })]);
  const model = stub();
  await runJudge({ ...base, cases: [c], runDir: dir, model });
  const sent = (model.requests[0]!.messages[1]!.content as string);
  assert.match(sent, /b1/);
  assert.doesNotMatch(sent, /a1|a2/);
  const row = lines(dir, 'judge.jsonl')[0] as { covered: number; findings: { matched: number[] }[] };
  assert.deepEqual(row.findings.map((f) => f.matched), [[3], [2]]);
  assert.equal(row.covered, 2);
});

test('runJudge leaves a failed replay case out of the rates', async () => {
  const ok = mkCase(1, [label('a.ts', 'r')]);
  const bad = mkCase(2, [label('a.ts', 'r')]);
  const dir = runDir([result(ok, { findings: [finding('a.ts', 'A:1')] }), result(bad, { status: 'failed' })]);
  const s = await runJudge({ ...base, cases: [ok, bad], runDir: dir, model: stub() });
  assert.equal(s.cases, 2);
  assert.equal(s.failed_cases, 1);
  assert.equal(s.references, 1);
  assert.equal(s.recall, 1);
});

test('runJudge stops with run_case_mismatch when the run holds a key the cases lack, and calls nothing', async () => {
  const known = mkCase(1, [label('a.ts', 'r')]);
  const stranger = mkCase(9, [label('a.ts', 'r')]);
  const dir = runDir([result(known, { findings: [finding('a.ts', 'A:1')] }), result(stranger, { findings: [finding('a.ts', 'A:1')] })]);
  const model = stub();
  await assert.rejects(runJudge({ ...base, cases: [known], runDir: dir, model }), /run_case_mismatch/);
  assert.equal(model.requests.length, 0);
});

test('runJudge starts no case once max cost is reached', async () => {
  const cs = [1, 2, 3].map((n) => mkCase(n, [label('a.ts', 'r')]));
  const dir = runDir(cs.map((c) => result(c, { findings: [finding('a.ts', 'A:1')] })));
  const model = stub(1);
  const s = await runJudge({ ...base, cases: cs, runDir: dir, model, maxCost: 1 });
  assert.equal(model.requests.length, 1);
  assert.equal(s.cases, 1);
  const file = JSON.parse(readFileSync(join(dir, 'judge-summary.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(file.stopped_reason, 'max_cost');
  assert.equal(file.cases_not_judged, 2);
  assert.equal(lines(dir, 'judge.jsonl').length, 1);
});

test('runJudge judges extra findings too, marked extra', async () => {
  const c = mkCase(1, [label('a.ts', 'r')]);
  const dir = runDir([result(c, { findings: [finding('a.ts', 'A:')], extra_findings: [finding('a.ts', 'A:1', 40)] })]);
  const model = stub();
  const s = await runJudge({ ...base, cases: [c], runDir: dir, model });
  assert.equal(model.requests.length, 2);
  assert.equal(s.findings, 2);
  assert.equal(s.matched_findings, 1);
  const row = lines(dir, 'judge.jsonl')[0] as { findings: { extra: boolean; counted: boolean }[] };
  assert.deepEqual(row.findings.map((f) => f.extra), [false, true]);
  assert.deepEqual(row.findings.map((f) => f.counted), [false, true]);
});

test('runJudge with keep judges and counts only those keys', async () => {
  const a = mkCase(1, [label('a.ts', 'r')]);
  const b = mkCase(2, [label('a.ts', 'r')]);
  const dir = runDir([result(a, { findings: [finding('a.ts', 'A:1')] }), result(b, { findings: [finding('a.ts', 'A:1')] })]);
  const model = stub();
  const s = await runJudge({ ...base, cases: [a, b], runDir: dir, model, keep: new Set([caseKey(b)]) });
  assert.equal(model.requests.length, 1);
  assert.equal(s.cases, 1);
  assert.deepEqual(lines(dir, 'judge.jsonl').map((r) => (r as { key: string }).key), [caseKey(b)]);
});

test('runJudge removes earlier judge files and leaves the run\'s files alone', async () => {
  const c = mkCase(1, [label('a.ts', 'r')]);
  const dir = runDir([result(c)]);
  writeFileSync(join(dir, 'judge.jsonl'), 'old\n');
  const before = readFileSync(join(dir, 'results.jsonl'), 'utf8');
  await runJudge({ ...base, cases: [c], runDir: dir, model: stub() });
  assert.equal(readFileSync(join(dir, 'results.jsonl'), 'utf8'), before);
  assert.doesNotMatch(readFileSync(join(dir, 'judge.jsonl'), 'utf8'), /old/);
});
