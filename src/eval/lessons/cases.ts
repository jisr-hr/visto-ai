// Dated, labelled replay cases from a deployment (plan "evals with lessons", calls 8, 9, 12, 13): the export's findings
// joined with a history file (what the description and branches were) and the judge's verdicts (what a reply meant).
// It needs no model. A case is one published run with a labelled finding, reviewed whole at its head, dated by its start.
import type { Label } from '../cases.ts';
import type { EvalCase } from '../cases.ts';
import { caseKey } from '../cases.ts';
import type { HistoryCase } from '../history/file.ts';
import { lessonsFor } from '../../memory/lessons.ts';
import type { ExportedFinding, FindingsFile } from './findings.ts';
import type { LessonsFile } from './lessons-file.ts';
import { lessonsAt } from './lessons-file.ts';
import type { SimVerdict } from './nights.ts';

export interface LessonCaseRow { key: string; shown: number; invalid: number; valid: number }   // shown: lessons the count says it would be shown
export interface LessonCases {
  cases: EvalCase[]; rows: LessonCaseRow[];
  skipped: { not_in_history: number; no_base: number; same_head: number };
  labels: { valid: number; invalid: number }; shown_cases: number; shown_invalid: number;
}

const WITH_ACCESS: ReadonlySet<unknown> = new Set(['owner', 'member', 'collaborator']);

/** The first decisive reply of a person with access, in time order, labels the finding; with none, the newest later verdict of its thread, whatever its time. */
export function labelOf(f: ExportedFinding, verdicts: ReadonlyMap<string, SimVerdict>): 'valid' | 'invalid' | null {
  const replies = [...f.replies].sort((a, b) => a.order - b.order);
  for (const r of replies) {
    if (!WITH_ACCESS.has(r.association)) continue;
    const classification = verdicts.get(r.id)?.classification;
    if (classification === 'valid_pushback') return 'invalid';
    if (classification === 'confirmed_fix' || classification === 'invalid_pushback') return 'valid';
  }
  const newest = [...f.later].sort((a, b) => a.run - b.run).at(-1);
  return newest?.verdict === 'fixed' ? 'valid' : null;
}

const pullKey = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`;

export function lessonCases(history: HistoryCase[], findings: FindingsFile, lessons: LessonsFile): LessonCases {
  const verdicts = new Map(lessons.verdicts.map((v) => [v.reply, v]));
  const held = new Map<string, HistoryCase>();
  for (const h of history) if (!held.has(pullKey(h.repo, h.pr_number))) held.set(pullKey(h.repo, h.pr_number), h);

  // The runs: findings grouped by repository, number and run id; in run id order, the findings in the file's order.
  const runs = new Map<string, ExportedFinding[]>();
  for (const f of findings.findings) {
    const key = `${pullKey(f.repo, f.pr_number)}@${f.run.id}`;
    const list = runs.get(key) ?? [];
    list.push(f);
    runs.set(key, list);
  }
  const ordered = [...runs.values()].sort((a, b) => a[0]!.run.id - b[0]!.run.id);

  const cases: EvalCase[] = [];
  const rows: LessonCaseRow[] = [];
  const skipped = { not_in_history: 0, no_base: 0, same_head: 0 };
  const heads = new Set<string>();
  const rounds = new Map<string, number>();
  const totals = { valid: 0, invalid: 0 };
  let shownCases = 0;
  let shownInvalid = 0;

  for (const group of ordered) {
    const first = group[0]!;
    const labels: Label[] = [];
    for (const f of group) {
      const label = labelOf(f, verdicts);
      if (label === null) continue;
      labels.push({ comment_id: f.comment_id, path: f.path, line: f.line, side: f.side, severity: f.severity, label });
    }
    if (labels.length === 0) continue;
    const pull = pullKey(first.repo, first.pr_number);
    const h = held.get(pull);
    if (h === undefined) { skipped.not_in_history += 1; continue; }
    if (first.run.base_sha === null) { skipped.no_base += 1; continue; }
    const headKey = `${pull}@${first.run.head_sha}`;
    if (heads.has(headKey)) { skipped.same_head += 1; continue; }
    heads.add(headKey);
    const round = (rounds.get(pull) ?? 0) + 1;
    rounds.set(pull, round);

    const c: EvalCase = {
      repo: h.repo, pr_number: h.pr_number, head_sha: first.run.head_sha, compare_base: first.run.base_sha,
      title: h.title, body: h.body, branch: h.branch, base_branch: h.base_branch, author: h.author,
      labels, review_round: round, review_at: first.run.started_at,
    };
    const live = lessonsAt(lessons, h.repo, new Date(first.run.started_at)).filter((l) => l.number !== h.pr_number);
    const shown = lessonsFor(h.final_files.map((f) => ({ path: f.path, previousPath: f.previous_path })), live).lessons.length;
    const invalid = labels.filter((l) => l.label === 'invalid').length;
    const valid = labels.length - invalid;
    cases.push(c);
    rows.push({ key: caseKey(c), shown, invalid, valid });
    totals.valid += valid;
    totals.invalid += invalid;
    if (shown > 0) { shownCases += 1; shownInvalid += invalid; }
  }
  return { cases, rows, skipped, labels: totals, shown_cases: shownCases, shown_invalid: shownInvalid };
}
