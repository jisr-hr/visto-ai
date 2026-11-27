// The page of one review (UI plan 2, Task 7; calls 7, 8 and 19 to 24): its states, its header, the selector between the
// reviews of its pull request, and the banner saying why it approved or not. The page reads its review once for each run and
// each try, and the list of the pull request's reviews once for each pull request (call 20); neither is polled.
import { Fragment, useEffect, useId, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { usePoll } from '../api.ts';
import type { ApprovalEntry, GateShown, OneReview, ReviewDependency, ReviewFile, ReviewFinding } from '../api-types.ts';
import { PageHeader } from '../components/layout.tsx';
import { AlertIcon } from '../components/icons.tsx';
import { Badge } from '../components/ui/badge.tsx';
import type { BadgeTone } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Select } from '../components/ui/select.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import { useApp } from '../context.tsx';
import { ago, codeSpans, count, money, plural, sentence, took } from '../format.ts';
import { Link, navigate } from '../router.tsx';
import { AskedBy, CARD, CARD_TITLE, MODES, MONO, SCORE, scoreTone } from './activity.tsx';

const LARGEST_RUN = 2147483647;
const RUN_DIGITS = /^[1-9][0-9]{0,9}$/;
const REVIEWS_PREFIX = '/ui/reviews/';

/** The run of an address under /ui/reviews/: its digits when they match ^[1-9][0-9]{0,9}$ and are at most 2147483647, else null. */
export function runOfPath(path: string): number | null {
  if (!path.startsWith(REVIEWS_PREFIX)) return null;
  const digits = path.slice(REVIEWS_PREFIX.length);
  if (!RUN_DIGITS.test(digits)) return null;
  const run = Number(digits);
  return run <= LARGEST_RUN ? run : null;
}

const mono = (text: string): ReactElement => <span className={MONO}>{text}</span>;

function Breadcrumb({ last }: { last: string }): ReactElement {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[13px] text-muted">
      <Link to="/ui/activity">Activity</Link>
      <span aria-hidden="true">/</span>
      <span>{last}</span>
    </nav>
  );
}

function NotFoundHeader(): ReactElement {
  return <PageHeader title="Review not found" sub="No review is stored under this number." />;
}

/** The breadcrumb and the not-found header, reading nothing. */
export function ReviewNotFound(): ReactElement {
  return (
    <>
      <Breadcrumb last="Review" />
      <NotFoundHeader />
    </>
  );
}

interface Tone { border: string; icon: string }
const TONES: Readonly<Record<'ok' | 'warn' | 'bad' | 'muted', Tone>> = {
  warn: { border: 'border-warn bg-warn-bg', icon: 'text-warn' },
  ok: { border: 'border-ok bg-ok-bg', icon: 'text-ok' },
  bad: { border: 'border-bad bg-bad-bg', icon: 'text-bad' },
  muted: { border: 'border-border bg-card', icon: 'text-muted' },
};

/** Text with each backtick span in the code face. */
function Spans({ text }: { text: string }): ReactElement {
  return (
    <>
      {codeSpans(text).map((part, i) => (
        <Fragment key={i}>{part.code ? mono(part.text) : part.text}</Fragment>
      ))}
    </>
  );
}

/** ` (<code>)`, left out when there is none. */
const withCode = (code: string | null): ReactNode => (code === null ? null : <>{' ('}{mono(code)}{')'}</>);

/** The merge gate's state in a sentence (call 22). */
function GateSentence({ gate }: { gate: GateShown }): ReactElement {
  const shadow = gate.mode === 'shadow' ? ', in shadow mode,' : '';
  const head = `The merge gate's check${shadow}`;
  let rest: ReactNode;
  switch (gate.state) {
    case 'passed':
      rest = ' says nothing blocks the merge.';
      break;
    case 'blocked':
      rest = ` says ${plural(gate.blocking, 'blocking finding is', 'blocking findings are')} open.`;
      break;
    case 'waiting':
      rest = <>{' waits for '}{mono('/done')}{'.'}</>;
      break;
    case 'reviewing':
      rest = ' waits for the review under way.';
      break;
    case 'paused':
      rest = <>{' waits: reviews are paused'}{withCode(gate.code)}{'.'}</>;
      break;
    case 'failed':
      rest = <>{' failed'}{withCode(gate.code)}{'.'}</>;
      break;
    case 'skipped':
      rest = ' was skipped by a team member.';
      break;
    case 'bypassed':
      rest = ' passes: the gate is in bypass mode.';
      break;
    case 'unwithdrawn':
      rest = <>{' fails: an earlier approval is not withdrawn'}{withCode(gate.code)}{'.'}</>;
      break;
    case 'closed':
      rest = ' was not written: the pull request is closed.';
      break;
    case 'not_found':
      rest = ' was not written: the pull request was not found.';
      break;
    default:
      rest = <>{' says '}{mono(gate.state)}{'.'}</>;
  }
  return (
    <>
      {head}
      {rest}
    </>
  );
}

interface Banner { tone: keyof typeof TONES; title: string; body: ReactNode }

function bannerOf(review: OneReview): Banner {
  const { decision, code, text } = review.approval;
  switch (decision) {
    case 'approved':
      return { tone: 'ok', title: 'Approved automatically', body: text === null ? 'Posted as an approval.' : <Spans text={sentence(text)} /> };
    case 'not_approved':
      return {
        tone: 'warn',
        title: 'Not approved automatically',
        body: text === null ? <>{'Decided as '}{code === null ? null : mono(code)}{'.'}</> : <Spans text={sentence(text)} />,
      };
    case 'not_decided':
      return {
        tone: 'muted',
        title: 'No approval decided',
        body: 'Automatic approval was off for this repository when this review was posted, or the review was already on GitHub.',
      };
    case 'dry_run':
      return {
        tone: 'muted',
        title: 'Not decided in dry run',
        body: 'In dry run the service decides no approval: it reads neither threads nor branch rules.',
      };
    case 'not_posted':
      return { tone: 'muted', title: 'Not posted', body: 'This review was recorded and not posted, so no approval was decided.' };
    case 'nothing_new':
      return {
        tone: 'muted',
        title: 'Nothing new',
        body: 'This review found nothing new to tell, so it was not posted and decided no approval.',
      };
    default: {
      const failure = review.failure;
      return {
        tone: 'bad',
        title: 'Review failed',
        body: (
          <>
            {'The review did not finish ('}
            {failure === null ? null : mono(failure.stage)}
            {failure === null || failure.code === null ? null : <>{': '}{mono(failure.code)}</>}
            {'), so no approval was decided.'}
          </>
        ),
      };
    }
  }
}

function ApprovalBanner({ review }: { review: OneReview }): ReactElement {
  const banner = bannerOf(review);
  const tone = TONES[banner.tone];
  return (
    <section aria-label="Approval" className={`flex items-start gap-3.5 rounded-[12px] border px-[18px] py-4 shadow-card ${tone.border}`}>
      <span className={`mt-0.5 flex-none ${tone.icon}`}>
        <AlertIcon />
      </span>
      <div className="flex flex-col gap-1 text-sm text-text">
        <strong className="font-semibold">{banner.title}</strong>
        <span>
          {banner.body}
          {review.gate === null ? null : (
            <>
              {' '}
              <GateSentence gate={review.gate} />
            </>
          )}
        </span>
      </div>
    </section>
  );
}

/** The select between the reviews of the pull request; this run is always one of its options (call 19). */
function Selector({ review, list }: { review: OneReview; list: { now: string; total: number; reviews: Array<{ run: number; ordinal: number; at: string }> } }): ReactElement {
  const id = useId();
  const listed = list.reviews.some((entry) => entry.run === review.run);
  return (
    <>
      <label htmlFor={id} className="sr-only">
        Review
      </label>
      <Select id={id} value={String(review.run)} onChange={(event) => navigate(`${REVIEWS_PREFIX}${event.target.value}`)}>
        {list.reviews.map((entry) => (
          <option key={entry.run} value={String(entry.run)}>
            {`Review ${entry.ordinal} of ${list.total}, ${ago(entry.at, list.now)}`}
          </option>
        ))}
        {listed ? null : (
          <option value={String(review.run)}>{`Review ${review.ordinal} of ${review.runs}, ${ago(review.finishedAt, review.now)}`}</option>
        )}
      </Select>
    </>
  );
}

function Header({ review, selector }: { review: OneReview; selector: ReactNode }): ReactElement {
  const pull = review.pullRequest;
  const name = `${pull.repository} #${pull.number}`;
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="m-0 text-2xl font-semibold tracking-[-0.01em]">{pull.title ?? name}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted">
          <span>{pull.author === null ? name : `${name} by ${pull.author}`}</span>
          {pull.headBranch === null || pull.baseBranch === null ? null : (
            <span>
              {mono(pull.headBranch)}
              {' into '}
              {mono(pull.baseBranch)}
            </span>
          )}
          {review.head === '' ? null : (
            <span>
              {'head '}
              {mono(review.head)}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2.5">
        {selector}
        {pull.url.startsWith('https://') ? (
          <Button asChild>
            <a href={pull.url} rel="noreferrer">
              Open on GitHub
            </a>
          </Button>
        ) : null}
      </div>
    </header>
  );
}

const CARD_HEADER = 'flex flex-wrap items-baseline justify-between gap-3 px-5 pb-3 pt-[18px]';

/** `line <a>` or `lines <a> to <b>`, with `old ` before it on the side LEFT. */
function linesOf(highest: NonNullable<ReviewFile['highest']>): string {
  const old = highest.side === 'LEFT' ? 'old ' : '';
  return highest.first === highest.last ? `${old}line ${highest.first}` : `${old}lines ${highest.first} to ${highest.last}`;
}

/** The sub-line under a file's path (rule 2); null when there is none. */
function subLineOf(file: ReviewFile): string | null {
  if (file.notReviewed !== null) return null;
  if (file.source !== null) return 'Whole file';
  const kept =
    file.kept === 'earlier_run' ? ', kept from an earlier review' : file.kept === 'other_pull_request' ? ', scored on another pull request' : '';
  if (file.highest === null) return file.blocks === 0 ? null : plural(file.blocks, 'block', 'blocks');
  if (file.blocks === 1) return `1 block${kept === '' ? `, at ${linesOf(file.highest)}` : kept}`;
  return `${file.blocks} blocks, the highest at ${linesOf(file.highest)}${kept}`;
}

const NOT_REVIEWED: ReadonlyMap<string, string> = new Map([
  ['no_diff', 'GitHub shows no diff for it, so it was not read.'],
  ['too_large', 'Its diff is too large to send to the model.'],
  ['over_batch_limit', 'It did not fit in the batches one review may send.'],
  ['batch_failed', 'The model call that held it failed.'],
  ['secret_file', 'It may hold secrets, so it is never sent to the model.'],
]);

const SOURCES: ReadonlyMap<string, string> = new Map([
  ['builtin_floor', "It changes the reviewer's own file, code owners or CI."],
  ['team_floor', 'A path the team marked as always needing a person.'],
  ['team_file_invalid', "The repository's .visto-ai.yml cannot be used, so every file needs a person."],
  ['hidden_characters', 'A changed line holds invisible or direction-changing characters.'],
  ['not_scored', 'Not read, or left without a score.'],
  ['rule_rename', 'Renamed within its folder, so it is scored by rule.'],
  ['rule_asset', 'An image or a font, so it is scored by rule.'],
]);

/** The why of a file (rule 2 and the table of texts) and whether it is shown muted. */
function whyOf(file: ReviewFile): { muted: boolean; body: ReactNode } {
  if (file.notReviewed !== null) {
    const known = NOT_REVIEWED.get(file.notReviewed);
    return {
      muted: true,
      body: (
        <>
          {known ?? mono(file.notReviewed)}
          {file.score === null ? null : ` Counted as ${file.score}%.`}
        </>
      ),
    };
  }
  if (file.source !== null) {
    if (file.source === 'whole_file') return { muted: false, body: file.reason === '' ? 'Scored as a whole file.' : file.reason };
    return { muted: false, body: SOURCES.get(file.source) ?? mono(file.source) };
  }
  let body: ReactNode;
  if (file.kept === 'other_pull_request') {
    body = file.category === null ? 'Scored on another pull request.' : <>{'Scored on another pull request as '}{mono(file.category)}{'.'}</>;
  } else {
    body = file.reason === '' ? 'No reason given.' : file.reason;
  }
  const empty = file.kept !== 'other_pull_request' && file.reason === '';
  return {
    muted: empty,
    body: (
      <>
        {body}
        {file.raisedFrom === null || file.score === null ? null : ` ${file.raisedFrom}% was given; a block this file lost had scored ${file.score}%.`}
      </>
    ),
  };
}

function FileRow({ file, threshold }: { file: ReviewFile; threshold: number | null }): ReactElement {
  const sub = subLineOf(file);
  const why = whyOf(file);
  let score: ReactNode;
  if (file.notReviewed !== null) score = <Badge tone="muted">Not reviewed</Badge>;
  else if (file.score === null) score = <span className="text-muted">None</span>;
  else score = <span className={`${SCORE} ${scoreTone(file.score, threshold)}`}>{`${file.score}%`}</span>;
  return (
    <TableRow>
      <TableCell className="align-top">
        <span className={MONO}>{file.path}</span>
        {sub === null ? null : <div className="mt-1 text-xs text-muted">{sub}</div>}
      </TableCell>
      <TableCell className="align-top">{score}</TableCell>
      <TableCell className={`align-top text-[13px] ${why.muted ? 'text-muted' : ''}`}>{why.body}</TableCell>
    </TableRow>
  );
}

function ScoresCard({ review }: { review: OneReview }): ReactElement {
  const id = useId();
  const failed = review.failure !== null;
  return (
    <section aria-labelledby={id} className={CARD}>
      <div className={CARD_HEADER}>
        <h2 id={id} className={CARD_TITLE}>
          Scores by file
        </h2>
        {review.threshold === null ? null : <span className="text-[13px] text-muted">{`Threshold ${review.threshold}%`}</span>}
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <tr>
              <TableHead scope="col">File</TableHead>
              <TableHead scope="col">Score</TableHead>
              <TableHead scope="col">Why</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {review.files.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="align-top text-muted">
                  {failed ? 'The review did not finish, so no file was scored.' : 'No file was scored.'}
                </TableCell>
              </TableRow>
            ) : (
              review.files.map((file, i) => <FileRow key={`${file.path} ${i}`} file={file} threshold={review.threshold} />)
            )}
          </TableBody>
        </Table>
      </div>
      {review.filesCut > 0 ? (
        <p className="m-0 px-5 py-3 text-[13px] text-muted">{`${plural(review.filesCut, 'more file is', 'more files are')} not shown.`}</p>
      ) : null}
    </section>
  );
}

const SEVERITY: Readonly<Record<ReviewFinding['severity'], { tone: BadgeTone; label: string }>> = {
  blocker: { tone: 'bad', label: 'Blocker' },
  major: { tone: 'bad', label: 'Major' },
  minor: { tone: 'muted', label: 'Minor' },
};

function threadOf(finding: ReviewFinding): { tone: BadgeTone; label: string } {
  const { state, by } = finding.thread;
  switch (state) {
    case 'open':
      return { tone: 'warn', label: 'Thread open' };
    case 'resolved':
      return { tone: 'ok', label: by === null ? 'Resolved' : `Resolved by ${by}` };
    case 'fixed':
      return { tone: 'ok', label: 'Fixed in a later review' };
    case 'answered':
      return { tone: 'info', label: 'Answered in its thread' };
    case 'no_thread':
      return { tone: 'muted', label: 'No thread recorded' };
    case 'not_posted':
      return { tone: 'muted', label: 'Not posted' };
    default:
      return {
        tone: 'muted',
        label: finding.kind === 'unchanged' ? 'On unchanged code' : finding.kind === 'beyond_diff' ? 'Beyond the diff' : 'Not on the diff',
      };
  }
}

function FindingItem({ finding }: { finding: ReviewFinding }): ReactElement {
  const severity = SEVERITY[finding.severity];
  const thread = threadOf(finding);
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={severity.tone}>{severity.label}</Badge>
        <span>
          {mono(`${finding.path}:${finding.line}`)}
          {finding.side === 'LEFT' ? ' (old file)' : null}
        </span>
        <Badge tone={thread.tone} className="ml-auto">
          {thread.label}
        </Badge>
      </div>
      <p className="m-0 whitespace-pre-line text-sm leading-normal">
        <Spans text={finding.body} />
      </p>
    </div>
  );
}

function FindingsCard({ review }: { review: OneReview }): ReactElement {
  const id = useId();
  const { counts, earlier } = review;
  const named: string[] = [];
  if (counts.blocker > 0) named.push(`${counts.blocker} blocker`);
  if (counts.major > 0) named.push(`${counts.major} major`);
  if (counts.minor > 0) named.push(`${counts.minor} minor`);
  const threads = earlier.cleared !== 0 || earlier.open !== 0 || earlier.unjudged !== 0;
  return (
    <section aria-labelledby={id} className={`${CARD} flex flex-col gap-3.5 px-5 py-[18px]`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id={id} className={CARD_TITLE}>
          Findings
        </h2>
        <span className="text-[13px] text-muted">{named.length === 0 ? 'None' : named.join(', ')}</span>
      </div>
      {review.findings.length === 0 ? (
        <p className="m-0 text-sm text-muted">{review.failure !== null ? 'The review did not finish.' : 'No findings.'}</p>
      ) : (
        review.findings.map((finding, i) => <FindingItem key={i} finding={finding} />)
      )}
      {review.findingsCut > 0 ? (
        <p className="m-0 text-[13px] text-muted">{`${plural(review.findingsCut, 'more finding is', 'more findings are')} not shown.`}</p>
      ) : null}
      {threads || earlier.discussed > 0 ? (
        <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-3 text-[13px] text-muted">
          {threads ? (
            <span>
              {'Earlier threads: '}
              <strong className="font-semibold text-text">{`${earlier.cleared} cleared`}</strong>
              {`, ${earlier.open} still open`}
              {earlier.unjudged > 0 ? `, ${earlier.unjudged} could not be judged` : null}
            </span>
          ) : null}
          {earlier.discussed > 0 ? <span>{`${plural(earlier.discussed, 'finding', 'findings')} dropped as already discussed`}</span> : null}
        </div>
      ) : null}
    </section>
  );
}

function SideCard({ title, gap, children }: { title: string; gap: string; children: ReactNode }): ReactElement {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`${CARD} flex flex-col ${gap} px-5 py-[18px]`}>
      <h2 id={id} className={CARD_TITLE}>
        {title}
      </h2>
      {children}
    </section>
  );
}

const FACTS = 'm-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2.5 text-sm';
const FACT_TERM = 'text-muted';
const FACT_VALUE = 'm-0 text-right font-medium';
const ROWS = 'flex flex-col gap-2.5 text-sm';
const ROW = 'flex justify-between gap-2.5';
const NOTE = 'text-[13px] text-muted';

function askedOf(review: OneReview): ReactNode {
  const { reason, login } = review.askedBy;
  if (reason === 'automatic') return 'Automatic';
  if (reason === 'manual') return 'By hand';
  return <AskedBy reason={reason} login={login} />;
}

function outcomeOf(review: OneReview): ReactNode {
  switch (review.posting) {
    case 'published':
      return <Badge tone="ok">Published</Badge>;
    case 'not_posted':
      return <Badge tone="muted">Not posted</Badge>;
    case 'dry_run':
      return <Badge tone="warn">Dry run</Badge>;
    case 'nothing_new':
      return <Badge tone="muted">Nothing new</Badge>;
    case 'failed': {
      const code = review.failure?.code ?? null;
      return (
        <>
          <Badge tone="bad">Failed</Badge>
          {code === null ? null : <>{' '}<span className={`${MONO} text-muted`}>{code}</span></>}
        </>
      );
    }
  }
}

function ThisReviewCard({ review }: { review: OneReview }): ReactElement {
  const { read } = review;
  const mode = MODES.get(review.mode) ?? review.mode;
  const readText = read.files > 0 ? `, ${read.reviewed} of ${plural(read.files, 'file', 'files')} read` : '';
  return (
    <SideCard title="This review" gap="gap-3.5">
      <dl className={FACTS}>
        <dt className={FACT_TERM}>Asked by</dt>
        <dd className={FACT_VALUE}>{askedOf(review)}</dd>
        <dt className={FACT_TERM}>Mode</dt>
        <dd className={FACT_VALUE}>{`${mode}${readText}`}</dd>
        <dt className={FACT_TERM}>Outcome</dt>
        <dd className={FACT_VALUE}>{outcomeOf(review)}</dd>
        <dt className={FACT_TERM}>Took</dt>
        <dd className={FACT_VALUE}>{took(Date.parse(review.finishedAt) - Date.parse(review.startedAt))}</dd>
        <dt className={FACT_TERM}>Posted</dt>
        <dd className={FACT_VALUE}>{review.publishedAt === null ? 'Not posted' : ago(review.publishedAt, review.now)}</dd>
      </dl>
    </SideCard>
  );
}

function UsageCard({ review }: { review: OneReview }): ReactElement {
  const { usage } = review;
  return (
    <SideCard title="Usage" gap="gap-3.5">
      <dl className={FACTS}>
        <dt className={FACT_TERM}>Model</dt>
        <dd className={FACT_VALUE}>{usage.models.length === 0 ? 'None' : mono(usage.models.join(', '))}</dd>
        <dt className={FACT_TERM}>Calls</dt>
        <dd className={FACT_VALUE}>{count(usage.calls)}</dd>
        <dt className={FACT_TERM}>Input tokens</dt>
        <dd className={FACT_VALUE}>{count(usage.inputTokens)}</dd>
        <dt className={FACT_TERM}>Cached</dt>
        <dd className={FACT_VALUE}>{count(usage.cachedTokens)}</dd>
        <dt className={FACT_TERM}>Output tokens</dt>
        <dd className={FACT_VALUE}>{count(usage.outputTokens)}</dd>
        <dt className={FACT_TERM}>Cost</dt>
        <dd className={FACT_VALUE}>{money(usage.cost)}</dd>
      </dl>
    </SideCard>
  );
}

function decisionBadge(review: OneReview): ReactElement {
  const { decision, code } = review.approval;
  switch (decision) {
    case 'approved':
      return <Badge tone="ok">{code ?? 'approved'}</Badge>;
    case 'not_approved':
      return <Badge tone={code === 'audit_sample' ? 'accent' : 'warn'}>{code ?? 'not_approved'}</Badge>;
    case 'dry_run':
      return <Badge tone="muted">Not decided in dry run</Badge>;
    case 'not_posted':
      return <Badge tone="muted">Not posted</Badge>;
    case 'nothing_new':
      return <Badge tone="muted">Nothing new</Badge>;
    default:
      return <Badge tone="muted">None</Badge>;
  }
}

const WITHDRAWAL: Readonly<Record<ApprovalEntry['state'], { tone: BadgeTone; label: string }>> = {
  stands: { tone: 'ok', label: 'Stands' },
  withdrawn: { tone: 'muted', label: 'Withdrawn' },
  dismissed_on_github: { tone: 'muted', label: 'Dismissed on GitHub' },
  withdrawal_failed: { tone: 'bad', label: 'Withdrawal failed' },
};

function ApprovalItem({ entry, review }: { entry: ApprovalEntry; review: OneReview }): ReactElement {
  const word = WITHDRAWAL[entry.state];
  let retry = '';
  if (entry.state === 'withdrawal_failed' && entry.retryAt !== null) {
    const wait = Date.parse(entry.retryAt) - Date.parse(review.now);
    retry = Math.round(wait / 1000) > 0 ? ` Tried again in ${took(wait)}.` : ' Trying again now.';
  }
  return (
    <>
      <div className={`${ROW} items-start`}>
        <span>
          {entry.run === review.run ? 'Approval of this review, head ' : `Approval of review ${entry.ordinal}, head `}
          {mono(entry.head)}
        </span>
        <Badge tone={word.tone}>{word.label}</Badge>
      </div>
      {entry.state !== 'withdrawal_failed' ? null : (
        <span className={NOTE}>
          {'Dismissing it failed'}
          {entry.code === null ? null : <>{' ('}{mono(entry.code)}{')'}</>}
          {'.'}
          {retry}
        </span>
      )}
      {entry.stoodAtMerge ? <span className={NOTE}>It stood when the pull request was merged.</span> : null}
    </>
  );
}

function ApprovalRecordCard({ review }: { review: OneReview }): ReactElement {
  return (
    <SideCard title="Approval record" gap="gap-3">
      <div className={ROWS}>
        <div className={ROW}>
          <span>This review</span>
          {decisionBadge(review)}
        </div>
        {review.approvals.map((entry, i) => (
          <ApprovalItem key={`${entry.run} ${i}`} entry={entry} review={review} />
        ))}
      </div>
    </SideCard>
  );
}

function dependencyName(dep: ReviewDependency): string {
  switch (dep.kind) {
    case 'model':
      return 'Review model';
    case 'memory':
      return dep.count === null ? 'Memory' : `Memory, ${plural(dep.count, 'record', 'records')} shown`;
    case 'lessons':
      return dep.count === null ? 'Lessons' : `Lessons, ${dep.count} shown`;
    case 'mcp':
      return `MCP server ${dep.name ?? ''}`.trimEnd();
    default:
      return `Extension ${dep.name ?? ''}`.trimEnd();
  }
}

const DEPENDENCY_STATUS: Readonly<Record<ReviewDependency['status'], { tone: BadgeTone; label: string }>> = {
  ok: { tone: 'ok', label: 'Working' },
  empty: { tone: 'muted', label: 'Nothing to add' },
  skipped: { tone: 'muted', label: 'Skipped' },
  error: { tone: 'bad', label: 'Failed' },
};

function DependenciesCard({ review }: { review: OneReview }): ReactElement {
  return (
    <SideCard title="Dependencies on this review" gap="gap-3">
      {review.dependencies.length === 0 ? (
        <span className="text-sm text-muted">None recorded.</span>
      ) : (
        <div className={ROWS}>
          {review.dependencies.map((dep, i) => {
            const status = DEPENDENCY_STATUS[dep.status];
            return (
              <div key={i} className={ROW}>
                <span>
                  {dependencyName(dep)}
                  {dep.code === null ? null : <span className="text-muted">{withCode(dep.code)}</span>}
                </span>
                <Badge tone={status.tone} dot>
                  {status.label}
                </Badge>
              </div>
            );
          })}
        </div>
      )}
    </SideCard>
  );
}

function FeedbackCard({ review }: { review: OneReview }): ReactElement {
  const { helpful, notHelpful, reasons } = review.feedback;
  return (
    <SideCard title="Feedback" gap="gap-3">
      {helpful === 0 && notHelpful === 0 ? (
        <span className="text-sm text-muted">No feedback on this review.</span>
      ) : (
        <div className="flex gap-2.5">
          <Badge tone="ok">{`${helpful} helpful`}</Badge>
          <Badge tone="bad">{`${notHelpful} not helpful`}</Badge>
        </div>
      )}
      {reasons.map((entry, i) => (
        <blockquote key={i} className="m-0 rounded-lg bg-subtle px-3 py-2.5 text-[13px] leading-normal">
          <bdi>{entry.reason}</bdi>
          {entry.login === null ? null : <>{' '}<span className="text-muted">{entry.login}</span></>}
        </blockquote>
      ))}
    </SideCard>
  );
}

export function ReviewPage({ run }: { run: number }): ReactElement {
  const { api } = useApp();
  const [tries, setTries] = useState(0);
  const [known, setKnown] = useState<{ repository: string; number: number } | null>(null);
  const review = usePoll(() => api.review(run), 0, `${run} ${tries}`);
  const list = usePoll(
    () => (known === null ? Promise.resolve(null) : api.pullReviews(known.repository, known.number)),
    0,
    known === null ? 'none' : `${known.repository}#${known.number}`,
  );

  const data = review.data;
  useEffect(() => {
    if (data === null) return;
    const { repository, number } = data.pullRequest;
    setKnown((last) => (last !== null && last.repository === repository && last.number === number ? last : { repository, number }));
  }, [data]);

  if (data === null) {
    if (!review.failed) {
      return (
        <>
          <Breadcrumb last={`Review ${run}`} />
          <div aria-busy="true"></div>
        </>
      );
    }
    return (
      <>
        <Breadcrumb last={`Review ${run}`} />
        {review.error !== null && review.error.status === 404 ? (
          <NotFoundHeader />
        ) : (
          <>
            <p className="text-sm">The review could not be read.</p>
            <div>
              <Button type="button" onClick={() => setTries((n) => n + 1)}>
                Try again
              </Button>
            </div>
          </>
        )}
      </>
    );
  }

  const pull = data.pullRequest;
  // The list belongs to the pull request it was read for; while the page moves to a review of another one it is not shown.
  const own = known !== null && known.repository === pull.repository && known.number === pull.number ? list.data : null;
  return (
    <>
      <Breadcrumb last={`${pull.repository} #${pull.number}`} />
      <Header review={data} selector={own === null ? null : <Selector review={data} list={own} />} />
      <ApprovalBanner review={data} />
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 grow-[2] basis-[560px] flex-col gap-5">
          <ScoresCard review={data} />
          <FindingsCard review={data} />
        </div>
        <div className="flex min-w-0 grow basis-[300px] flex-col gap-5">
          <ThisReviewCard review={data} />
          <UsageCard review={data} />
          <ApprovalRecordCard review={data} />
          <DependenciesCard review={data} />
          <FeedbackCard review={data} />
        </div>
      </div>
    </>
  );
}
