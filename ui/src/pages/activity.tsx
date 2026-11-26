// The Activity screen as drawn in Activity.dc.html (lines 72 to 125; Task 11; UI design 1, item 2; calls 13, 14, 19 to 23 and
// 33): what runs now with its stage, the withdrawals waiting to try again, and the reviews of the last 30 days, filtered by
// repository and outcome, searched by title or number, and paged. Every age and time left is counted from the `now` the answer
// carries, never from the browser's clock (call 22).
import { useEffect, useState } from 'react';
import { usePoll } from '../api.ts';
import type { ReviewQuery } from '../api.ts';
import type { ActivityJob, JobStage, RecentReview, ReviewOutcome, Withdrawal } from '../api-types.ts';
import { PageHeader } from '../components/layout.tsx';
import { Segmented } from '../components/segmented.tsx';
import type { SegmentedOption } from '../components/segmented.tsx';
import { Badge } from '../components/ui/badge.tsx';
import type { BadgeTone } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Select } from '../components/ui/select.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import { reviewCounts, useApp } from '../context.tsx';
import { ago, left, money, plural, took } from '../format.ts';
import { Link } from '../router.tsx';

/** How often the first page of the reviews is read again (call 23); a later page is read once. */
export const REVIEWS_MS = 15000;
/** How long the search waits after the last key before it is sent. */
export const SEARCH_MS = 300;

// The mockup's .card with its overflow, as a section of its own (the Card component is a div).
const CARD = 'overflow-hidden rounded-[12px] border border-border bg-card shadow-card';
const CARD_HEADER = 'flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-[18px]';
const CARD_TITLE = 'm-0 text-base font-semibold';
const TITLE_BOX = 'flex min-w-[220px] flex-col gap-0.5';
const TITLE_LINK = 'font-medium text-text no-underline hover:text-accent-text hover:underline';
const SUB_LINE = 'text-[13px] text-muted';
const DETAIL = 'text-[13px] text-muted';
const MONO = 'font-mono text-[12.5px]';
const SCORE = 'inline-flex min-w-11 items-center justify-center rounded-md px-2 py-0.5 text-[13px] font-semibold';
const WITHDRAWAL_LINE = 'flex flex-wrap items-center gap-2.5 border-t border-border px-5 py-3 text-[13px]';
const FOOT = 'flex flex-wrap items-center justify-between gap-2.5 border-t border-border px-5 py-3';

/** A score's colour (call 21): red at or above the run's own threshold, 70 when it holds none; blue at 40 or above; green below. */
const DEFAULT_THRESHOLD = 70;
const BLUE_FROM = 40;

type Outcome = '' | NonNullable<ReviewQuery['outcome']>;
const OUTCOMES: readonly SegmentedOption<Outcome>[] = [
  { value: '', label: 'All' },
  { value: 'approved', label: 'Approved' },
  { value: 'needs_person', label: 'Needs a person' },
  { value: 'failed', label: 'Failed' },
];

const STAGES: ReadonlyMap<string, { tone: BadgeTone; label: string }> = new Map<JobStage, { tone: BadgeTone; label: string }>([
  ['waiting', { tone: 'muted', label: 'Waiting for pushes to settle' }],
  ['retrying', { tone: 'muted', label: 'Waiting to try again' }],
  ['queued', { tone: 'muted', label: 'Queued' }],
  ['preparing', { tone: 'info', label: 'Preparing' }],
  ['reviewing', { tone: 'info', label: 'Reviewing' }],
  ['judging_threads', { tone: 'info', label: 'Judging threads' }],
  ['publishing', { tone: 'info', label: 'Publishing' }],
  ['stopped', { tone: 'warn', label: 'Stopped' }],
]);

/** Why a job runs, said in words; a command is said in mono with who asked. */
const REASONS: ReadonlyMap<string, string> = new Map([
  ['synchronize', 'A push'],
  ['opened', 'Opened'],
  ['reopened', 'Reopened'],
  ['ready_for_review', 'Marked ready for review'],
  ['retargeted', 'Retargeted'],
  ['rerun', 'A re-run of the check'],
  ['rerun_retry', 'A re-run of the check'],
]);
const COMMANDS: ReadonlyMap<string, string> = new Map([
  ['command', '/review'],
  ['command_retry', '/review'],
  ['done', '/done'],
  ['done_retry', '/done'],
]);

const OUTCOME_WORDS: ReadonlyMap<string, { tone: BadgeTone; label: string }> = new Map<ReviewOutcome, { tone: BadgeTone; label: string }>([
  ['approved', { tone: 'ok', label: 'Approved' }],
  ['needs_person', { tone: 'warn', label: 'Needs a person' }],
  ['audit', { tone: 'accent', label: 'Drawn for the audit' }],
  ['reviewed', { tone: 'muted', label: 'Reviewed' }],
  ['nothing_new', { tone: 'muted', label: 'Nothing new' }],
  ['not_posted', { tone: 'muted', label: 'Not posted' }],
  ['failed', { tone: 'bad', label: 'Failed' }],
]);
const MODES: ReadonlyMap<string, string> = new Map([['full', 'Full'], ['incremental', 'Incremental'], ['recheck', 'Re-check']]);
const SEVERITIES = ['blocker', 'major', 'minor'] as const;

/** A number searched for, with or without `#`. */
const NUMBER = /^#?(\d+)$/;

/** The words of a stage; one this frontend does not know is said as it is, muted. */
function stageOf(stage: string): { tone: BadgeTone; label: string } {
  return STAGES.get(stage) ?? { tone: 'muted', label: stage };
}

/** What follows a stage's badge, or null. */
function detailOf(job: ActivityJob, now: string, paused: boolean): string | null {
  switch (job.stage) {
    case 'waiting':
    case 'retrying':
      return `${left(job.runAt, now)} left`;
    case 'queued':
      return paused ? 'waits while reviews are paused' : 'starts when a place is free';
    case 'reviewing':
      return job.batch === null || job.batches === null ? null : `batch ${job.batch} of ${job.batches}`;
    case 'judging_threads':
      return job.threadsDue === null ? null : `${job.threadsDue} due`;
    case 'stopped':
      return 'runs again at the next start';
    default:
      return null;
  }
}

/** A batch's share of the bar (call 33): 10 at the first batch, up to 90; 10 while the batches are not known. */
function batchPercent(job: ActivityJob): number {
  if (job.batch === null || job.batches === null || job.batches <= 0) return 10;
  return Math.min(90, Math.max(10, 10 + Math.round((80 * (job.batch - 1)) / job.batches)));
}

/** The bar's width and what it says (call 33); a job that does not run is at 0. */
function progressOf(job: ActivityJob): { percent: number; label: string } {
  const about = (percent: number) => ({ percent, label: `About ${percent} percent` });
  switch (job.stage) {
    case 'preparing':
      return about(5);
    case 'reviewing':
    case 'judging_threads':
      return about(batchPercent(job));
    case 'publishing':
      return about(95);
    case 'queued':
      return { percent: 0, label: 'Queued' };
    case 'stopped':
      return { percent: 0, label: 'Stopped' };
    default:
      return { percent: 0, label: 'Waiting' };
  }
}

/** The search and the repository applied to what runs now, in the page: the repository equal, the search in the title without
 * letter case or equal to the number. */
function matches(job: ActivityJob, repo: string, q: string): boolean {
  if (repo !== '' && job.repository !== repo) return false;
  if (q === '') return true;
  const digits = NUMBER.exec(q)?.[1];
  if (digits !== undefined && Number(digits) === job.number) return true;
  return job.title !== null && job.title.toLowerCase().includes(q.toLowerCase());
}

/** The query sent for the reviews: only what is chosen, and the page to read from. */
function queryOf(repo: string, outcome: Outcome, q: string, before: number | undefined): ReviewQuery {
  const query: ReviewQuery = {};
  if (repo !== '') query.repo = repo;
  if (outcome !== '') query.outcome = outcome;
  if (q !== '') query.q = q;
  if (before !== undefined) query.before = before;
  return query;
}

function scoreTone(highest: number, threshold: number | null): string {
  if (highest >= (threshold ?? DEFAULT_THRESHOLD)) return 'bg-bad-bg text-bad';
  if (highest >= BLUE_FROM) return 'bg-info-bg text-info';
  return 'bg-ok-bg text-ok';
}

function AskedBy({ reason, login }: ActivityJob['askedBy']) {
  const command = COMMANDS.get(reason);
  if (command !== undefined) {
    return (
      <>
        <span className={MONO}>{command}</span>
        {login === null ? null : ` by ${login}`}
      </>
    );
  }
  return <>{REASONS.get(reason) ?? <span className={MONO}>{reason}</span>}</>;
}

function JobLine({ job, now, paused }: { job: ActivityJob; now: string; paused: boolean }) {
  const stage = stageOf(job.stage);
  const detail = detailOf(job, now, paused);
  const progress = progressOf(job);
  const name = `${job.repository} #${job.number}`;
  return (
    <TableRow hover>
      <TableCell>
        <div className={TITLE_BOX}>
          <a href={job.url} rel="noreferrer" className={TITLE_LINK}>
            {job.title ?? name}
          </a>
          <span className={SUB_LINE}>
            {name}
            {job.head === null ? null : (
              <>
                {' '}
                <span className={MONO}>{job.head}</span>
              </>
            )}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <Badge tone={stage.tone} dot>
          {stage.label}
        </Badge>
        {detail === null ? null : (
          <>
            {' '}
            <span className={DETAIL}>{detail}</span>
          </>
        )}
      </TableCell>
      <TableCell>
        <AskedBy {...job.askedBy} />
      </TableCell>
      <TableCell className="text-muted">{job.startedAt === null ? 'Not yet' : ago(job.startedAt, now)}</TableCell>
      <TableCell>
        <div role="img" aria-label={progress.label} className="h-1.5 overflow-hidden rounded-full bg-subtle">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${progress.percent}%` }} />
        </div>
      </TableCell>
    </TableRow>
  );
}

function WithdrawalLine({ withdrawal, now }: { withdrawal: Withdrawal; now: string }) {
  // A time already past, or one that cannot be read, is 0 s.
  const wait = took(Math.max(0, Date.parse(withdrawal.runAt) - Date.parse(now)));
  return (
    <div className={WITHDRAWAL_LINE}>
      <Badge tone="warn">Withdrawal</Badge>
      <span>
        {`${withdrawal.repository} #${withdrawal.number}: dismissing an earlier approval failed`}
        {withdrawal.code === null ? null : (
          <>
            {' ('}
            <span className={MONO}>{withdrawal.code}</span>
            {')'}
          </>
        )}
        {`, tried again in ${wait}.`}
      </span>
    </div>
  );
}

/** A failed run has no score, a nothing-new one kept the last; any other with none reads as a failed one. */
function ScoreCell({ review }: { review: RecentReview }) {
  if (review.outcome === 'nothing_new') return <TableCell className="text-muted">Kept</TableCell>;
  if (review.outcome === 'failed' || review.highest === null) return <TableCell className="text-muted">None</TableCell>;
  return (
    <TableCell>
      <span className={`${SCORE} ${scoreTone(review.highest, review.threshold)}`}>{`${review.highest}%`}</span>
    </TableCell>
  );
}

function ReviewLine({ review, now }: { review: RecentReview; now: string }) {
  const name = `${review.repository} #${review.number}`;
  const outcome = OUTCOME_WORDS.get(review.outcome) ?? { tone: 'muted', label: review.outcome };
  const findings = SEVERITIES.filter((severity) => review.findings[severity] > 0).map((severity) => `${review.findings[severity]} ${severity}`);
  const mode = (MODES.get(review.mode) ?? review.mode) + (review.dryRun ? ', dry run' : '');
  return (
    <TableRow hover>
      <TableCell>
        <div className={TITLE_BOX}>
          <Link to={`/ui/reviews/${review.run}`} className={TITLE_LINK}>
            {review.title ?? name}
          </Link>
          <span className={SUB_LINE}>{name}</span>
        </div>
      </TableCell>
      <TableCell>
        <Badge tone={outcome.tone}>{outcome.label}</Badge>
        {review.outcome === 'failed' && review.failureCode !== null ? (
          <>
            {' '}
            <span className={`${MONO} text-muted`}>{review.failureCode}</span>
          </>
        ) : null}
      </TableCell>
      <ScoreCell review={review} />
      {findings.length === 0 ? <TableCell className="text-muted">None</TableCell> : <TableCell>{findings.join(', ')}</TableCell>}
      <TableCell>{mode}</TableCell>
      <TableCell>{money(review.cost)}</TableCell>
      <TableCell>{took(review.tookMs)}</TableCell>
      <TableCell className="text-muted">{ago(review.at, now)}</TableCell>
    </TableRow>
  );
}

/** A table's one cell across its columns, for when it has no row to show. */
function Said({ columns, children }: { columns: number; children: string }) {
  return (
    <TableRow>
      <TableCell colSpan={columns} className="text-muted">
        {children}
      </TableCell>
    </TableRow>
  );
}

export function ActivityPage() {
  const { api, me, activity, activityFailed } = useApp();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [repo, setRepo] = useState('');
  const [outcome, setOutcome] = useState<Outcome>('');
  // The `before` of each page after the first: Next pushes the page's `next`, Previous pops.
  const [pages, setPages] = useState<readonly number[]>([]);

  // The search is sent SEARCH_MS after the last key, and starts again from the first page.
  useEffect(() => {
    const wanted = search.trim();
    if (wanted === q) return undefined;
    const timer = setTimeout(() => {
      setQ(wanted);
      setPages([]);
    }, SEARCH_MS);
    return () => clearTimeout(timer);
  }, [search, q]);

  const before = pages.at(-1);
  const query = queryOf(repo, outcome, q, before);
  const reviews = usePoll(() => api.reviews(query), before === undefined ? REVIEWS_MS : 0, JSON.stringify(query));
  const page = reviews.data;
  const filtered = repo !== '' || outcome !== '' || q !== '';
  const next = page === null ? null : page.next;

  function forward(): void {
    if (next !== null) setPages([...pages, next]);
  }
  function back(): void {
    setPages(pages.slice(0, -1));
  }
  function chooseRepo(value: string): void {
    if (value === repo) return;
    setRepo(value);
    setPages([]);
  }
  function chooseOutcome(value: Outcome): void {
    if (value === outcome) return;
    setOutcome(value);
    setPages([]);
  }

  const counts = activity === null ? null : reviewCounts(activity.jobs);
  const jobs = activity === null ? [] : activity.jobs.filter((job) => matches(job, repo, q));

  return (
    <>
      <PageHeader title="Activity" sub="What the service is doing now, and what it did lately">
        <div className="flex flex-wrap items-center gap-2.5">
          <label htmlFor="act-search" className="sr-only">
            Search pull requests
          </label>
          <Input
            id="act-search"
            type="search"
            placeholder="Search pull requests"
            className="w-[240px]"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <label htmlFor="act-repo" className="sr-only">
            Repository
          </label>
          <Select id="act-repo" value={repo} onChange={(event) => chooseRepo(event.target.value)}>
            <option value="">All repositories</option>
            {me.repositories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
          {activityFailed || reviews.failed ? (
            <Badge tone="warn" dot>
              Not updating
            </Badge>
          ) : (
            <Badge tone="ok" dot>
              Updating live
            </Badge>
          )}
        </div>
      </PageHeader>

      <section data-slot="card" aria-labelledby="act-now" className={CARD}>
        <div className={CARD_HEADER}>
          <div className="flex items-center gap-2.5">
            <h2 id="act-now" className={CARD_TITLE}>
              In review now
            </h2>
            {counts === null ? null : <Badge tone="accent">{`${counts.running} running, ${counts.queued} queued`}</Badge>}
          </div>
          {activity === null ? null : (
            <span className="text-[13px] text-muted">
              {`${plural(activity.places.reviews, 'place', 'places')} for reviews, ${activity.places.withdrawals} for withdrawals`}
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Pull request</TableHead>
                <TableHead scope="col">Stage</TableHead>
                <TableHead scope="col">Asked by</TableHead>
                <TableHead scope="col">Started</TableHead>
                <TableHead scope="col" className="w-[200px]">
                  Progress
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody aria-busy={activity === null && !activityFailed ? true : undefined}>
              {activity === null ? null : jobs.length === 0 ? (
                <Said columns={5}>Nothing is running or queued.</Said>
              ) : (
                jobs.map((job) => <JobLine key={job.job} job={job} now={activity.now} paused={activity.paused !== null} />)
              )}
            </TableBody>
          </Table>
        </div>
        {activity === null
          ? null
          : activity.withdrawals.map((withdrawal, i) => (
              <WithdrawalLine key={`${i} ${withdrawal.repository}#${withdrawal.number}`} withdrawal={withdrawal} now={activity.now} />
            ))}
      </section>

      <section data-slot="card" aria-labelledby="act-recent" className={CARD}>
        <div className={CARD_HEADER}>
          <h2 id="act-recent" className={CARD_TITLE}>
            Recent reviews
          </h2>
          <Segmented label="Outcome" options={OUTCOMES} value={outcome} onChange={chooseOutcome} />
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Pull request</TableHead>
                <TableHead scope="col">Outcome</TableHead>
                <TableHead scope="col">Highest score</TableHead>
                <TableHead scope="col">Findings</TableHead>
                <TableHead scope="col">Mode</TableHead>
                <TableHead scope="col">Cost</TableHead>
                <TableHead scope="col">Took</TableHead>
                <TableHead scope="col">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody aria-busy={page === null && !reviews.failed ? true : undefined}>
              {page === null ? (
                reviews.failed ? (
                  <Said columns={8}>The reviews could not be read.</Said>
                ) : null
              ) : page.reviews.length === 0 ? (
                <Said columns={8}>{filtered ? 'No review matches.' : `No review in the last ${page.windowDays} days.`}</Said>
              ) : (
                page.reviews.map((review) => <ReviewLine key={review.run} review={review} now={page.now} />)
              )}
            </TableBody>
          </Table>
        </div>
        <div className={FOOT}>
          <span className="text-[13px] text-muted">
            {page === null ? null : `${page.reviews.length} of ${plural(page.total, 'review', 'reviews')} in the last ${page.windowDays} days`}
          </span>
          <div className="flex gap-2">
            <Button type="button" disabled={pages.length === 0} onClick={back}>
              Previous
            </Button>
            <Button type="button" disabled={next === null} onClick={forward}>
              Next
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
