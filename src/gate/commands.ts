import type { RepoSettings } from '../config/load.ts';
import { recordSkip } from '../db/gate.ts';
import { commentBody } from '../db/human-activity.ts';
import { askGate, enqueueJob, finishJob, requeueJob, reviewJobsOf } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';
import type { Db } from '../db/types.ts';
import { codeOf } from '../shell/codes.ts';
import { mayCommand, skipReasonOf } from '../shell/commands.ts';
import { MAX_STARTS } from '../shell/runner.ts';
import { doneFailed, doneRefused, nothingLeft, skipFailed, skipRefused } from './answers.ts';
import type { SkipRefusal } from './answers.ts';
import { gatingOf } from './gating.ts';
import type { Gating } from './gating.ts';
import { GATE_RETRY_WAITS_MS, planNow, underWay } from './job.ts';
import type { GateJobDeps } from './job.ts';

/** What is said on the command's comment once its job has ended. */
type Answer =
  | { kind: 'none' }
  | { kind: 'eyes'; required: { head: string; names: string[] } | null }   // required: the checks to ask about, on that head
  | { kind: 'refused'; text: string };

/** How a command ends. `review`: a review is wanted, with the pull request's gating; the end decides whether it joins one. */
interface Ending {
  status: 'done' | 'dropped';
  outcome: string;
  code: string | null;
  ask: boolean;
  answer: Answer;
  review?: Gating;
  skip?: { headSha: string; actor: string; reason: string; commentId: string };
}

/** A job finished meanwhile: its end is not stored again and nothing is answered. */
class Gone extends Error {}

const accepted = (outcome: string, extra: Partial<Ending> = {}): Ending =>
  ({ status: 'done', outcome, code: null, ask: true, answer: { kind: 'eyes', required: null }, ...extra });
const refused = (code: string, text: string, ask: boolean): Ending =>
  ({ status: 'done', outcome: 'refused', code, ask, answer: { kind: 'refused', text } });
const silent = (outcome: string, ask: boolean, extra: Partial<Ending> = {}): Ending =>
  ({ status: 'done', outcome, code: null, ask, answer: { kind: 'none' }, ...extra });
const NOT_FOUND: Ending = { status: 'dropped', outcome: 'not_found', code: null, ask: false, answer: { kind: 'none' } };

/** A gate job of reason done, skip or rerun, once rule 1 of Task 7 has let it through. Never rejects. */
export async function runGateCommand(job: Job, deps: GateJobDeps, at: { installation: string; settings: RepoSettings; now: Date }): Promise<void> {
  const log = (entry: Record<string, unknown>): void => {
    try { deps.log(entry); } catch { /* a logger that throws changes nothing */ }
  };
  const now = at.now.toISOString();
  const entry = { event: 'gate', job: job.id, repo: `${job.ref.owner}/${job.ref.repo}`, number: job.ref.number, reason: job.reason, outcome: null as string | null, code: null as string | null };

  let ending: Ending;
  try {
    ending = await decide(job, deps, at);
    const outcome = await end(job, deps, ending, now);
    ending = { ...ending, outcome };
  } catch (error) {
    if (error instanceof Gone) {
      entry.outcome = 'gone';
      log(entry);
      return;
    }
    const code = codeOf(error);
    if (job.starts < MAX_STARTS) {
      try {
        const wait = GATE_RETRY_WAITS_MS[job.starts <= 1 ? 0 : 1]!;
        const answer = await requeueJob(deps.db, job.id, new Date(at.now.getTime() + wait).toISOString(), now, false);
        entry.outcome = answer === 'requeued' ? 'put_back' : 'superseded';
      } catch {
        entry.outcome = 'error';
      }
      log(entry);
      return;
    }
    const text = job.reason === 'done' ? doneFailed(job.requestedBy, code) : skipFailed(job.requestedBy, code);
    ending = { status: 'done', outcome: 'failed', code, ask: true, answer: job.reason === 'rerun' ? { kind: 'none' } : { kind: 'refused', text } };
    try {
      await end(job, deps, ending, now);
    } catch {
      // Left as it is: it runs again after the next start.
      entry.outcome = 'error';
      log(entry);
      return;
    }
  }
  entry.outcome = ending.outcome;
  entry.code = ending.code;
  try { deps.onQueued(); } catch { /* the runners look at their next tick */ }
  await answer(job, deps, at.installation, ending.answer, log);
  log(entry);
}

/** What the command comes to; rejects when a read does, and the job is tried again. */
async function decide(job: Job, deps: GateJobDeps, at: { installation: string; settings: RepoSettings }): Promise<Ending> {
  if (job.reason === 'done') return decideDone(job, deps, at);
  if (job.reason === 'skip') return decideSkip(job, deps, at);
  return decideRerun(job, deps, at);
}

async function decideDone(job: Job, deps: GateJobDeps, at: { installation: string; settings: RepoSettings }): Promise<Ending> {
  const refuse = (code: 'not_allowed' | 'closed', ask: boolean): Ending => refused(code, doneRefused(job.requestedBy, code), ask);
  if (!mayCommand(job.association)) return refuse('not_allowed', true);
  const live = await deps.forge.readPullRequest(job.ref, at.installation);
  if (live === null) return NOT_FOUND;
  if (live.state !== 'open') return refuse('closed', false);
  const gating = gatingOf(at.settings, live.info.baseBranch);
  // Not gated: here /done is a /review, and there is no check to bring up to date.
  if (gating === 'off') return accepted('review_queued', { ask: false, review: gating });
  const { plan } = await planNow(deps, { ref: job.ref, installation: at.installation, settings: at.settings, gating, live });
  if (plan.state === 'passed' || plan.state === 'skipped' || plan.state === 'bypassed') {
    const names = at.settings.gate.requiredChecks;
    return accepted('already_green', { answer: { kind: 'eyes', required: names.length > 0 ? { head: live.info.headSha, names } : null } });
  }
  return accepted('review_queued', { review: gating });
}

async function decideSkip(job: Job, deps: GateJobDeps, at: { installation: string; settings: RepoSettings }): Promise<Ending> {
  const refuse = (code: SkipRefusal, ask: boolean): Ending => refused(code, skipRefused(job.requestedBy, code), ask);
  if (!mayCommand(job.association)) return refuse('not_allowed', true);
  const text = job.commentId === null ? null : await commentBody(deps.db, job.ref, job.commentId);
  const reason = skipReasonOf(text ?? '');
  if (reason === '' || job.commentId === null) return refuse('missing_reason', true);
  const team = at.settings.gate.skipTeam;
  const slash = team === null ? -1 : team.indexOf('/');
  if (team === null || slash <= 0 || team.slice(0, slash).toLowerCase() !== job.ref.owner.toLowerCase()) return refuse('no_skip_team', true);
  if (job.requestedBy === null) return refuse('not_team_member', true);
  let member: boolean;
  try {
    member = await deps.checks.isTeamMember(at.installation, team, job.requestedBy);
  } catch {
    // A lookup that failed is "could not verify", never "not a member".
    return refuse('membership_unverified', true);
  }
  if (!member) return refuse('not_team_member', true);
  const live = await deps.forge.readPullRequest(job.ref, at.installation);
  if (live === null) return NOT_FOUND;
  if (live.state !== 'open') return refuse('closed', false);
  if (gatingOf(at.settings, live.info.baseBranch) === 'off') return refuse('not_gated', false);
  const head = live.info.headSha;
  if (job.headSha !== '' && job.headSha !== head) return refuse('stale_head', true);
  return accepted('skipped', { skip: { headSha: head, actor: job.requestedBy, reason, commentId: job.commentId } });
}

async function decideRerun(job: Job, deps: GateJobDeps, at: { installation: string; settings: RepoSettings }): Promise<Ending> {
  const live = await deps.forge.readPullRequest(job.ref, at.installation);
  if (live === null) return NOT_FOUND;
  if (live.state !== 'open') return silent('closed', false);
  const gating = gatingOf(at.settings, live.info.baseBranch);
  if (gating === 'off') return silent('not_gated', false);
  if (live.info.headSha !== job.headSha) return silent('stale_head', true);
  if (gating === 'bypass') return silent('bypassed', true);
  return silent('review_queued', true, { review: gating });
}

/** The end of a command, in one transaction: its effect, the job finished, and the check asked for. Answers the outcome stored. */
async function end(job: Job, deps: GateJobDeps, ending: Ending, now: string): Promise<string> {
  return deps.db.transaction(async (tx: Db) => {
    let outcome = ending.outcome;
    if (ending.review !== undefined) {
      const jobs = await reviewJobsOf(tx, job.ref);
      const joins = underWay(jobs, ending.review, deps.reviewing(job.ref)) === 'running'
        || jobs.some((j) => j.status === 'pending' && j.trigger === 'manual');
      if (joins) {
        outcome = 'coalesced';
      } else {
        await enqueueJob(tx, {
          ref: job.ref, kind: 'review', reason: job.reason, headSha: '', runAt: now, now, delivery: null, replace: true, trigger: 'manual',
          requestedBy: job.requestedBy, commentId: job.commentId, association: job.association, installation: job.installation,
        });
        outcome = 'review_queued';
      }
    }
    if (ending.skip !== undefined) await recordSkip(tx, { ref: job.ref, ...ending.skip, at: now });
    if (!(await finishJob(tx, job.id, ending.status, outcome, now))) throw new Gone();
    if (ending.ask) await askGate(tx, job.ref, now);
    return outcome;
  });
}

/** The answer on the command's comment, each write once; a write that fails is logged and changes nothing. */
async function answer(job: Job, deps: GateJobDeps, installation: string, said: Answer, log: (e: Record<string, unknown>) => void): Promise<void> {
  const commentId = job.commentId;
  if (commentId === null || said.kind === 'none') return;
  const write = async (work: () => Promise<void>): Promise<void> => {
    try { await work(); } catch (error) { log({ event: 'answer_failed', job: job.id, reason: codeOf(error) }); }
  };
  if (said.kind === 'refused') {
    await write(() => deps.writer.react(job.ref, installation, commentId, 'confused'));
    await write(() => deps.writer.comment(job.ref, installation, said.text));
    return;
  }
  await write(() => deps.writer.react(job.ref, installation, commentId, 'eyes'));
  if (said.required === null) return;
  const { head, names } = said.required;
  let green: string[];
  try {
    green = await deps.checks.greenChecks(job.ref, installation, head, names);
  } catch (error) {
    log({ event: 'gate_checks_unread', job: job.id, reason: codeOf(error) });
    return;
  }
  if (names.every((n) => green.includes(n))) await write(() => deps.writer.comment(job.ref, installation, nothingLeft(job.requestedBy, head)));
}
