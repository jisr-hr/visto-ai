// The nights over an export (plan "evals with lessons", calls 6, 7): every 00:00 UTC from the day after the first reply
// up to the export's day, the night's rules (`runNight`, src/memory/night.ts) run over a store that is the file and what
// the nights before kept. The store answers as the service's database does (src/db/reply-verdicts.ts, memory-records.ts),
// but for what the database cannot tell: a later review counts only once its run was published before the night. The
// simulation stops after a night that did not end done or at the cap, or in which a call failed at the provider.
// It logs nothing.
import type { Asked, Classification, JudgeInput, Outcome } from '../../memory/judge.ts';
import { JUDGE_ATTEMPTS, runNight } from '../../memory/night.ts';
import type { NightLesson, NightReply, NightStore, NightVerdict, RunEnd } from '../../memory/night.ts';
import { dayStart } from '../../memory/select.ts';
import type { PullRequestRef } from '../../forge/types.ts';
import type { ExportedFinding, ExportedLater, ExportedReply, FindingsFile } from './findings.ts';

export interface SimVerdict { repo: string; number: number; reply: string; finding: string; classification: Classification | null; outcome: Outcome; attempts: number; night: string }
export interface SimLesson { ref: string; repo: string; number: number; reply: string; path: string; text: string; createdAt: string; madeAt: string; expiresAt: string }   // no quote: nothing reads it
export interface Simulated {
  complete: boolean; end: RunEnd | null;          // end: why it stopped; null when every night ended done or lesson_cap
  nights: number; first_night: string | null; last_night: string | null;
  waiting: number;                                // replies with no classification and fewer than JUDGE_ATTEMPTS attempts after the last night
  verdicts: SimVerdict[]; lessons: SimLesson[];
  judged: number; given_up: number; failed: number; calls: number; cost: number;
}
export type SimAsk = (reply: NightReply, input: JudgeInput) => Promise<Asked>;

const DAY_MS = 86_400_000;
const WITH_ACCESS: ReadonlySet<unknown> = new Set(['owner', 'member', 'collaborator']);

// A time of the file in milliseconds. The export writes every time it holds; one that cannot be read is no export.
function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error('bad_findings_time');
  return ms;
}

// A repository as the database keys it: owner and name in lower case.
const keyOf = (owner: string, repo: string): string => `${owner}/${repo}`.toLowerCase();

// The export writes owner/name: a repository with no owner is no export.
function refOf(f: ExportedFinding): PullRequestRef {
  const slash = f.repo.indexOf('/');
  if (slash <= 0) throw new Error('bad_findings_repo');
  return { service: 'github', owner: f.repo.slice(0, slash).toLowerCase(), repo: f.repo.slice(slash + 1).toLowerCase(), number: f.pr_number };
}

/** A reply of the file, with what the queue sorts and filters it by. */
interface Entry { ref: PullRequestRef; finding: ExportedFinding; reply: ExportedReply; at: number }
interface Kept { verdict: SimVerdict; judgedAt: number }
interface KeptLesson { key: string; lesson: SimLesson; created: number; expires: number }

interface State {
  entries: Entry[];
  later: Map<string, Array<ExportedLater & { started: number; published: number | null }>>;   // by repository, number and finding
  verdicts: Map<string, Kept>;    // by reply, as reply_verdicts is keyed
  lessons: KeptLesson[];          // in the order they were made
}

const threadKey = (ref: PullRequestRef, finding: string): string => `${keyOf(ref.owner, ref.repo)}#${ref.number}#${finding}`;

function stateOf(file: FindingsFile): State {
  const entries: Entry[] = [];
  const later: State['later'] = new Map();
  for (const f of file.findings) {
    if (f.severity === 'note') continue;
    const ref = refOf(f);
    for (const r of f.replies) entries.push({ ref, finding: f, reply: r, at: timeOf(r.at) });
    const key = threadKey(ref, f.comment_id);
    const list = later.get(key) ?? [];
    for (const l of f.later) list.push({ ...l, started: timeOf(l.started_at), published: l.published_at === null ? null : timeOf(l.published_at) });
    later.set(key, list);
  }
  return { entries, later, verdicts: new Map(), lessons: [] };
}

// What the queue holds of a reply's verdict (rule 2): none, or one with no classification and fewer attempts than `max`.
function open(state: State, e: Entry, max: number): boolean {
  const kept = state.verdicts.get(e.reply.id);
  return kept === undefined || (kept.verdict.classification === null && kept.verdict.attempts < max);
}

const accessFirst = (e: Entry): number => (WITH_ACCESS.has(e.reply.association) ? 0 : 1);

// The night's store over the file and what was kept so far. `night`: the night's 00:00.
function storeOf(state: State, night: number): NightStore {
  const nightIso = new Date(night).toISOString();
  return {
    // repliesToJudge: at or after `since`, before `before`, open; those with access first, then by time, then as stored.
    replies: async (since, before, limit, maxAttempts) => {
      const from = timeOf(since);
      const to = timeOf(before);
      return state.entries
        .filter((e) => e.at >= from && e.at < to && open(state, e, maxAttempts))
        .sort((a, b) => accessFirst(a) - accessFirst(b) || a.at - b.at || a.reply.order - b.reply.order)
        .slice(0, Math.max(0, limit))
        .map((e): NightReply => ({
          ref: { ...e.ref }, reply: e.reply.id, association: e.reply.association, body: e.reply.body, at: new Date(e.at).toISOString(),
          finding: e.finding.comment_id, path: e.finding.path, side: e.finding.side, line: e.finding.line, severity: e.finding.severity,
          findingText: e.finding.finding,
          attempts: state.verdicts.get(e.reply.id)?.verdict.attempts ?? 0,
        }));
    },
    // lessonsMadeSince: the verdicts with the outcome lesson judged at or after `since`, in every repository.
    lessonsMadeSince: async (since) => {
      const from = timeOf(since);
      let n = 0;
      for (const k of state.verdicts.values()) if (k.verdict.outcome === 'lesson' && k.judgedAt >= from) n += 1;
      return n;
    },
    // laterVerdict: of the runs that kept a verdict for the thread, started after `after` and published before the night,
    // the one with the highest id.
    laterVerdict: async (ref, finding, after) => {
      const from = timeOf(after);
      let best: { run: number; verdict: string } | null = null;
      for (const l of state.later.get(threadKey(ref, finding)) ?? []) {
        if (!(l.started > from) || l.published === null || !(l.published < night)) continue;
        if (best === null || l.run > best.run) best = { run: l.run, verdict: l.verdict };
      }
      return best?.verdict ?? null;
    },
    // standingLessons: the repository's lessons that expire after `at`, newest made first (created, then the later made).
    standingLessons: async (repo, at, limit) => {
      const key = keyOf(repo.owner, repo.repo);
      const when = timeOf(at);
      return state.lessons
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.key === key && l.expires > when)
        .sort((a, b) => b.l.created - a.l.created || b.i - a.i)
        .slice(0, Math.max(0, limit))
        .map(({ l }) => l.lesson.text);
    },
    // noteVerdict: a verdict that has a classification is left as it is; one that has none is replaced. A lesson is kept
    // once for its repository and source, as addRecords keeps it.
    noteVerdict: async (v: NightVerdict, _call, lesson: NightLesson | null) => {
      const repo = keyOf(v.ref.owner, v.ref.repo);
      const kept = state.verdicts.get(v.reply);
      if (kept === undefined || kept.verdict.classification === null) {
        state.verdicts.set(v.reply, {
          verdict: { repo, number: v.ref.number, reply: v.reply, finding: v.finding, classification: v.classification, outcome: v.outcome, attempts: v.attempts, night: nightIso },
          judgedAt: timeOf(v.judgedAt),
        });
      }
      if (lesson !== null && !state.lessons.some((l) => l.key === repo && l.lesson.ref === lesson.sourceRef)) {
        state.lessons.push({
          key: repo, created: timeOf(lesson.createdAt), expires: timeOf(lesson.expiresAt),
          lesson: { ref: lesson.sourceRef, repo, number: lesson.number, reply: lesson.reply, path: lesson.path, text: lesson.text, createdAt: lesson.createdAt, madeAt: nightIso, expiresAt: lesson.expiresAt },
        });
      }
    },
    // noteCall: the eval keeps no row of its calls.
    noteCall: async () => {},
  };
}

/** The nights of the file, each over what the ones before kept. Rejects when `ask` or `paused` throws. */
export async function simulateNights(file: FindingsFile, ask: SimAsk, paused: () => string | null): Promise<Simulated> {
  const state = stateOf(file);
  const exported = timeOf(file.exported_at);
  const out: Simulated = {
    complete: true, end: null, nights: 0, first_night: null, last_night: null, waiting: 0,
    verdicts: [], lessons: [], judged: 0, given_up: 0, failed: 0, calls: 0, cost: 0,
  };

  let earliest: number | null = null;
  for (const e of state.entries) if (earliest === null || e.at < earliest) earliest = e.at;
  if (earliest !== null) {
    const last = dayStart(new Date(exported)).getTime();
    for (let night = dayStart(new Date(earliest)).getTime() + DAY_MS; night <= last; night += DAY_MS) {
      const failure: { code: RunEnd | null } = { code: null };
      const judged = await runNight(storeOf(state, night), {
        clock: () => new Date(night),
        ask: async (reply, input) => {
          const asked = await ask(reply, input);
          if (!asked.ok && asked.code !== 'invalid_output') failure.code = asked.code;
          return asked;
        },
        paused: async () => paused(),
      });
      const iso = new Date(night).toISOString();
      out.nights += 1;
      out.first_night ??= iso;
      out.last_night = iso;
      out.judged += judged.judged;
      out.given_up += judged.givenUp;
      out.failed += judged.failed;
      out.calls += judged.calls;
      out.cost += judged.cost;
      const finished = judged.end === 'done' || judged.end === 'lesson_cap';
      if (!finished || failure.code !== null) {
        out.complete = false;
        out.end = finished ? failure.code : judged.end;
        break;
      }
    }
  }

  for (const e of state.entries) if (open(state, e, JUDGE_ATTEMPTS)) out.waiting += 1;
  out.verdicts = [...state.verdicts.values()].map((k) => k.verdict);
  out.lessons = state.lessons.map((l) => l.lesson);
  return out;
}
