// Compares two run summaries, with an optional second run of the baseline as a noise band:
// the band is the distance between the two baseline runs.
import { basename } from 'node:path';
import { METRICS } from './score.ts';
import type { SummaryFile } from './replay.ts';

const EM_DASH = '\u2014';

const valueOf = (file: SummaryFile, name: string): number | null => {
  const v = file.summary[name];
  return typeof v === 'number' ? v : null;
};
const show = (v: number | null): string => (v === null ? EM_DASH : String(v));
const round = (v: number): number => Number(v.toFixed(3));
const labelOf = (file: SummaryFile, fallback: string): string => (typeof file.summary.label === 'string' ? file.summary.label : fallback);

export function compareSummaries(baseline: SummaryFile, candidate: SummaryFile, noise: SummaryFile | null): string {
  if (!baseline.cases_sha256 || !candidate.cases_sha256) throw new Error('missing_case_hash');
  if (baseline.cases_sha256 !== candidate.cases_sha256) throw new Error('different_case_files');
  // Runs shown different lessons measure something else; the file name says nothing, its hash does.
  if (baseline.lessons_sha256 !== undefined && candidate.lessons_sha256 !== undefined && baseline.lessons_sha256 !== candidate.lessons_sha256) throw new Error('different_lessons');
  const rows = METRICS.map((m) => {
    const b = valueOf(baseline, m.name);
    const c = valueOf(candidate, m.name);
    const delta = b === null || c === null ? null : round(c - b);
    let mark = '';
    if (m.better !== null && delta !== null && delta !== 0) {
      const third = noise ? valueOf(noise, m.name) : null;
      if (third !== null && Math.abs(delta) <= round(Math.abs(b! - third))) mark = 'noise';
      else mark = (delta > 0) === (m.better === 'higher') ? 'better' : 'worse';
    }
    return `| ${m.name} | ${show(b)} | ${show(c)} | ${show(delta)} | ${mark}${mark === '' ? '' : ' '}|`;
  });
  return [
    `| metric | ${labelOf(baseline, 'baseline')} | ${labelOf(candidate, 'candidate')} | delta | |`, '| --- | --- | --- | --- | --- |', ...rows,
    ...warnings(baseline, candidate),
    ...lessonsLine(baseline, candidate),
  ].join('\n');
}

// Only when a run has lessons: which file each run was shown.
function lessonsLine(a: SummaryFile, b: SummaryFile): string[] {
  if (a.lessons_sha256 === undefined && b.lessons_sha256 === undefined) return [];
  const name = (f: SummaryFile): string => (f.lessons_sha256 === undefined || f.lessons_file === undefined ? 'none' : basename(f.lessons_file));
  return [`lessons: ${name(a)}; ${name(b)}`];
}

// Conditions under which the two runs are not comparable as they stand.
function warnings(a: SummaryFile, b: SummaryFile): string[] {
  const out: string[] = [];
  const casesA = valueOf(a, 'cases');
  const casesB = valueOf(b, 'cases');
  if (casesA !== casesB) out.push(`warning: case counts differ (${show(casesA)} and ${show(casesB)})`);
  const reasons = [...new Set([a.stopped_reason, b.stopped_reason].filter((r): r is NonNullable<typeof r> => typeof r === 'string'))];
  if (reasons.length > 0) out.push(`warning: a run was stopped early (${reasons.join(', ')})`);
  const failedA = valueOf(a, 'failed_cases');
  const failedB = valueOf(b, 'failed_cases');
  if ((failedA ?? 0) > 0 || (failedB ?? 0) > 0) out.push(`warning: failed cases (${show(failedA)} and ${show(failedB)})`);
  return out;
}
