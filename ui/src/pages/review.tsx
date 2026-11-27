// The page of one review (UI plan 2, Task 7; calls 7, 8 and 19 to 24): its states, its header, the selector between the
// reviews of its pull request, and the banner saying why it approved or not. The page reads its review once for each run and
// each try, and the list of the pull request's reviews once for each pull request (call 20); neither is polled.
import { Fragment, useEffect, useId, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { usePoll } from '../api.ts';
import type { GateShown, OneReview } from '../api-types.ts';
import { PageHeader } from '../components/layout.tsx';
import { AlertIcon } from '../components/icons.tsx';
import { Button } from '../components/ui/button.tsx';
import { Select } from '../components/ui/select.tsx';
import { useApp } from '../context.tsx';
import { ago, codeSpans, plural, sentence } from '../format.ts';
import { Link, navigate } from '../router.tsx';
import { MONO } from './activity.tsx';

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
    </>
  );
}
