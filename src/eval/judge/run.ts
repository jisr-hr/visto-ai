// The command behind eval:judge: reads a replay run, asks the judge which references each finding raises, and writes
// the numbers beside the run. Only judge.jsonl, judge-summary.json and judge-summary.md are written; the run's own files are read, never changed.
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelClient, Usage } from '../../engine/types.ts';
import { caseKey } from '../cases.ts';
import type { EvalCase } from '../cases.ts';
import { runPool } from '../pool.ts';
import type { CaseResult, ReplayFinding } from '../score.ts';
import { askMatches, judgeSummary, matchCase } from './match.ts';
import type { JudgedFinding, JudgeSummary, MatchReference } from './match.ts';

export interface JudgeFile {
  summary: JudgeSummary; cases_sha256: string; run_label: string; plain: boolean; with_run_label: string | null;
  stopped_reason: 'max_cost' | null; cases_not_judged: number;
}

interface JudgedCase { key: string; status: 'ok' | 'failed'; references: number; covered: number; findings: JudgedFinding[] }
type Done = JudgedCase & { total_cost: number; usage: Usage };

const zeroUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 });
const addUsage = (a: Usage, b: Usage): Usage => ({
  calls: a.calls + b.calls, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
  cachedTokens: a.cachedTokens + b.cachedTokens, cost: a.cost + b.cost,
});

function readResults(runDir: string): CaseResult[] {
  const text = readFileSync(join(runDir, 'results.jsonl'), 'utf8');
  const rows: CaseResult[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    let data: unknown;
    try { data = JSON.parse(line); } catch { throw new Error(`bad_results_line_${index + 1}`); }
    const row = data as { key?: unknown; status?: unknown; findings?: unknown };
    if (typeof data !== 'object' || data === null || typeof row.key !== 'string' || (row.status !== 'ok' && row.status !== 'failed')) throw new Error(`bad_results_line_${index + 1}`);
    rows.push(data as CaseResult);
  });
  return rows;
}

function readRunSummary(runDir: string): { label: string; plain: boolean } {
  const data = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8')) as { summary?: { label?: unknown }; plain?: unknown };
  if (typeof data !== 'object' || data === null || typeof data.summary !== 'object' || data.summary === null || typeof data.summary.label !== 'string') throw new Error('bad_summary_file');
  return { label: data.summary.label, plain: data.plain === true };
}

async function judgeCase(c: EvalCase, result: CaseResult, args: { model: ModelClient; auto: boolean; timeoutMs: number; token: () => string }): Promise<Done> {
  const key = result.key;
  if (result.status !== 'ok') return { key, status: 'failed', references: 0, covered: 0, findings: [], total_cost: 0, usage: zeroUsage() };
  // The case's reference list: its labels that carry a text, in label order.
  const references = c.labels.filter((l) => typeof l.text === 'string');
  const toRef = (i: number): MatchReference => { const l = references[i]!; return { startLine: l.start_line ?? null, line: l.line, text: l.text! }; };
  const shown: { f: ReplayFinding; extra: boolean }[] = [
    ...(result.findings ?? []).map((f) => ({ f, extra: false })),
    ...(result.extra_findings ?? []).map((f) => ({ f, extra: true })),
  ];
  let usage = zeroUsage();
  const findings: JudgedFinding[] = [];
  for (const { f, extra } of shown) {
    const own = references.map((l, i) => (l.path === f.path ? i : -1)).filter((i) => i >= 0);
    const base = { path: f.path, line: f.line, extra, counted: false };
    if (own.length === 0) { findings.push({ ...base, matched: [], judge: 'no_reference', reason: null }); continue; }
    const asked = await askMatches(args.model, f.path, { line: f.line, body: f.body }, own.map(toRef), args.token(), args.auto, args.timeoutMs);
    usage = addUsage(usage, asked.usage);
    if (!asked.ok) { findings.push({ ...base, matched: [], judge: 'failed', reason: null }); continue; }
    findings.push({ ...base, matched: asked.value.matches.map((m) => own[m]!), judge: 'asked', reason: asked.value.reason });
  }
  const { counted, covered } = matchCase(findings, references.length);
  findings.forEach((f, i) => { f.counted = counted[i]!; });
  return { key, status: 'ok', references: references.length, covered, findings, total_cost: usage.cost, usage };
}

const summaryTable = (s: JudgeSummary): string =>
  ['| field | value |', '| --- | --- |', ...Object.entries(s).map(([k, v]) => `| ${k} | ${v === null ? '—' : String(v)} |`)].join('\n') + '\n';

export async function runJudge(args: {
  cases: EvalCase[]; casesSha256: string; runDir: string; keep: Set<string> | null; withRunLabel: string | null; maxCost: number; concurrency: number;
  model: ModelClient; auto: boolean; timeoutMs: number; token: () => string;
}): Promise<JudgeSummary & Pick<JudgeFile, 'stopped_reason' | 'cases_not_judged'>> {
  const results = readResults(args.runDir);
  const run = readRunSummary(args.runDir);
  const byKey = new Map(args.cases.map((c) => [caseKey(c), c]));
  if (results.some((r) => !byKey.has(r.key))) throw new Error('run_case_mismatch');
  // The case file's order, not the run's (completion order): a judge stopped by its cost cap then rates the first cases of the file.
  const position = new Map(args.cases.map((c, i) => [caseKey(c), i]));
  const chosen = results.filter((r) => args.keep === null || args.keep.has(r.key)).sort((x, y) => position.get(x.key)! - position.get(y.key)!);

  // Files from an earlier judging must not sit beside this one's; a link left in place would send the writes elsewhere.
  const names = ['judge.jsonl', 'judge-summary.json', 'judge-summary.md'];
  for (const name of names) rmSync(join(args.runDir, name), { force: true });
  const linesPath = join(args.runDir, names[0]!);
  writeFileSync(linesPath, '');

  const done: Done[] = [];
  const { stoppedByCost, notStarted } = await runPool(
    chosen, { concurrency: args.concurrency, maxCost: args.maxCost }, (r) => judgeCase(byKey.get(r.key)!, r, args),
    (d) => {
      done.push(d);
      appendFileSync(linesPath, JSON.stringify({ key: d.key, status: d.status, references: d.references, covered: d.covered, findings: d.findings }) + '\n');
    },
  );
  const usage = done.reduce((u, d) => addUsage(u, d.usage), zeroUsage());
  const summary = judgeSummary(run.label, done, usage);
  const file: JudgeFile = {
    summary, cases_sha256: args.casesSha256, run_label: run.label, plain: run.plain, with_run_label: args.withRunLabel,
    stopped_reason: stoppedByCost && notStarted > 0 ? 'max_cost' : null, cases_not_judged: notStarted,
  };
  writeFileSync(join(args.runDir, names[1]!), JSON.stringify(file, null, 2) + '\n');
  writeFileSync(join(args.runDir, names[2]!), summaryTable(summary));
  return { ...summary, stopped_reason: file.stopped_reason, cases_not_judged: file.cases_not_judged };
}
