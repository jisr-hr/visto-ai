// Compares two run summaries, with an optional second baseline as a noise band.
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
  return [`| metric | ${labelOf(baseline, 'baseline')} | ${labelOf(candidate, 'candidate')} | delta | |`, '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}
