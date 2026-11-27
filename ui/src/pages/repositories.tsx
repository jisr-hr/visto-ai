// The Repositories screen as drawn in Repositories.dc.html (lines 67 to 113; Task 11; UI design 1, item 4, and 3.3 and 3.4; calls 23
// to 29): one tab for each repository reviewed, and for the one shown, at a window, the live score quality: the headline numbers at
// the repository's threshold, the numbers at each threshold, the blocks a person stepped in on, and the reviewers' feedback. The
// list is read once, the quality once for each repository and window, and again every few seconds while the server measures it.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { usePoll } from '../api.ts';
import type { Measure, Quality, QualityAnswer, QualityRow, QualityWindow } from '../api-types.ts';
import { PageHeader } from '../components/layout.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Select } from '../components/ui/select.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import { useApp } from '../context.tsx';
import { count, percent, plural, sentence } from '../format.ts';
import { Link, navigate, useLocation } from '../router.tsx';
import { CARD, CARD_TITLE, MONO } from './activity.tsx';

/** How long after an answer that the repository is still being measured, it is read again. */
export const QUALITY_RETRY_MS = 5000;
/** The fewest labelled blocks that make Safety mean something. */
const ENOUGH_LABELS = 10;
/** The pull requests one measure reads, as the server cuts it. */
const PULLS_READ = 300;

const WINDOWS: ReadonlyArray<{ value: string; window: QualityWindow; label: string }> = [
  { value: '30', window: 30, label: 'Last 30 days' },
  { value: '90', window: 90, label: 'Last 90 days' },
  { value: 'all', window: 'all', label: 'Since install' },
];

const SUMMARY = 'flex flex-col gap-2 p-[18px]';
const LABEL = 'text-[13px] font-medium text-muted';
const BIG = 'text-[30px] font-semibold leading-[1.1] tracking-[-0.02em]';
const LINE = 'text-[13px] text-muted';
const HALF = 'flex min-w-0 grow basis-[360px] flex-col gap-3 px-5 py-[18px]';
const TAB = '-mb-px min-h-11 cursor-pointer border-0 border-b-2 border-transparent bg-transparent px-3.5 py-2.5 text-sm font-medium text-muted';

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted">{children}</span>;
}

function Card4({ label, big, children }: { label: string; big: ReactNode; children: ReactNode }) {
  return (
    <Card className={SUMMARY}>
      <span className={LABEL}>{label}</span>
      <span className={BIG}>{big}</span>
      <span className={LINE}>{children}</span>
    </Card>
  );
}

/** The row at the repository's threshold. */
function currentRow(quality: Quality): QualityRow | undefined {
  return quality.rows.find((row) => row.current) ?? quality.rows.find((row) => row.threshold === quality.threshold);
}

function Headline({ quality }: { quality: Quality }) {
  const row = currentRow(quality);
  const none: Measure = { share: null, part: 0, of: 0 };
  const blocks = row?.safetyBlocks ?? none;
  const benefit = row?.benefit ?? none;
  const focus = row?.focus ?? none;
  const t = quality.threshold;
  const { reverts, audits } = quality;
  return (
    <section aria-label="Headline numbers at the threshold" className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-4">
      <Card4 label="Safety, by block" big={percent(blocks.share)}>
        {`${blocks.part} of ${blocks.of} blocks that needed a person were under ${t}%. Lower is better.${blocks.of < ENOUGH_LABELS ? ' Not enough labels yet to mean much.' : ''}`}
      </Card4>
      <Card4 label="Benefit" big={percent(benefit.share)}>
        {`In ${benefit.part} of ${benefit.of} pull requests nothing reached ${t}%.`}
      </Card4>
      <Card4 label="Focus" big={percent(focus.share)}>
        {`of ${count(focus.of)} changed lines in pull requests that needed a person were flagged for them.`}
      </Card4>
      <Card4
        label="Outside signals"
        big={
          <>
            {reverts.merged} <span className="text-base font-medium text-muted">{reverts.merged === 1 ? 'revert' : 'reverts'}</span>
          </>
        }
      >
        {`${reverts.approved} of them approved by the bot. Audit: ${audits.drawn} drawn, ${audits.needed} needed a person.`}
      </Card4>
    </section>
  );
}

function Notes({ quality }: { quality: Quality }) {
  const { cut, unreadable, pullRequests } = quality;
  const lines: string[] = [];
  if (cut.pulls) lines.push(`Measured on the newest ${PULLS_READ} pull requests closed in this window.`);
  if (cut.comments || cut.runs) lines.push('Some comments or runs were past what one measure reads, and were left out.');
  if (unreadable > 0) lines.push(`${plural(unreadable, 'pull request', 'pull requests')} left out: their stored scores could not be read.`);
  if (pullRequests === 0) lines.push('No pull request closed in this window.');
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {lines.map((line) => (
        <span key={line} className="text-[13px] text-muted">
          {line}
        </span>
      ))}
    </div>
  );
}

function Cell({ measure, current, withCount = true }: { measure: Measure; current: boolean; withCount?: boolean }) {
  return (
    <TableCell className={current ? 'bg-accent-soft' : undefined}>
      <span className="font-semibold">{percent(measure.share)}</span>
      {withCount ? <> <Muted>{`${measure.part} of ${measure.of}`}</Muted></> : null}
    </TableCell>
  );
}

function Thresholds({ quality }: { quality: Quality }) {
  return (
    <section data-slot="card" aria-labelledby="rp-thresholds" className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-5 pb-3 pt-[18px]">
        <h2 id="rp-thresholds" className={CARD_TITLE}>
          At each threshold
        </h2>
        <span className="text-[13px] text-muted">The highlighted row is the repository&apos;s own threshold</span>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Threshold</TableHead>
              <TableHead scope="col">Safety, by block</TableHead>
              <TableHead scope="col">Safety, by file</TableHead>
              <TableHead scope="col">Benefit</TableHead>
              <TableHead scope="col">Focus</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {quality.rows.map((row) => (
              <TableRow key={row.threshold}>
                <TableCell className={row.current ? 'bg-accent-soft' : undefined}>
                  {row.current ? (
                    <>
                      <strong>{`${row.threshold}%`}</strong>
                      <Badge tone="accent" className="ml-1.5">
                        current
                      </Badge>
                    </>
                  ) : (
                    `${row.threshold}%`
                  )}
                </TableCell>
                <Cell measure={row.safetyBlocks} current={row.current} />
                <Cell measure={row.safetyFiles} current={row.current} />
                <Cell measure={row.benefit} current={row.current} />
                <Cell measure={row.focus} current={row.current} withCount={false} />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="m-0 border-t border-border px-5 pt-3 pb-4 text-[13px] text-muted">
        A block needed a person when someone other than the author commented on its lines and the lines changed in a later commit, as the pull request&apos;s last
        review saw them: the diff at the merge is not stored. Labels per block are fewer than per file, so the block numbers need more history before they mean much.
      </p>
    </section>
  );
}

function Stepped({ quality }: { quality: Quality }) {
  return (
    <Card className={HALF}>
      <h2 className={CARD_TITLE}>Blocks a person stepped in on, under the threshold</h2>
      {quality.stepped.length === 0 ? (
        <span className="text-sm text-muted">None in this window.</span>
      ) : (
        <div className="flex flex-col gap-2.5 text-sm">
          {quality.stepped.map((block) => (
            <div key={`${block.number} ${block.path}`} className="flex flex-wrap justify-between gap-2.5">
              <span>
                <span className={MONO}>{block.path}</span> <Muted>{`#${block.number}`}</Muted>
              </span>
              <Muted>{`scored ${block.score}%`}</Muted>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Feedback({ quality }: { quality: Quality }) {
  const { helpful, notHelpful, reasons } = quality.feedback;
  const total = helpful + notHelpful;
  return (
    <Card className={HALF}>
      <h2 className={CARD_TITLE}>Reviewer feedback</h2>
      {total === 0 ? (
        <>
          <span className={BIG}>None</span>
          <span className={LINE}>No answer in this window.</span>
        </>
      ) : (
        <>
          <div className="flex items-baseline gap-2.5">
            <span className={BIG}>{percent(helpful / total)}</span>
            <span className={LINE}>{`helpful, ${helpful} of ${plural(total, 'answer', 'answers')}`}</span>
          </div>
          <div className="flex flex-col gap-1.5 text-[13px]">
            <Muted>Reasons given when not helpful</Muted>
            <span>{reasons.length === 0 ? 'None given.' : sentence(reasons.map((one) => `${one.reason} (${one.count})`).join(', '))}</span>
          </div>
        </>
      )}
    </Card>
  );
}

function Numbers({ quality }: { quality: Quality }) {
  return (
    <>
      <Headline quality={quality} />
      <Notes quality={quality} />
      <Thresholds quality={quality} />
      <section className="flex flex-wrap gap-4">
        <Stepped quality={quality} />
        <Feedback quality={quality} />
      </section>
    </>
  );
}

function Failure({ children, onRetry }: { children: string; onRetry: () => void }) {
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
      <span className="text-sm">{children}</span>
      <Button type="button" onClick={onRetry}>
        Try again
      </Button>
    </Card>
  );
}

/** What the quality of the repository shown reads, as the answer, the failure or the wait. */
function Body({ repository, window }: { repository: string; window: QualityWindow }) {
  const { api } = useApp();
  const [tries, setTries] = useState(0);
  const base = `${repository} ${window}`;
  const polled = usePoll(() => api.quality(repository, window), 0, `${base} ${tries}`);
  // The last answer for this repository and window, shown while the next read of the same is out.
  const [held, setHeld] = useState<{ base: string; answer: QualityAnswer } | null>(null);
  if (polled.data !== null && (held === null || held.answer !== polled.data || held.base !== base)) setHeld({ base, answer: polled.data });
  const answer = polled.data ?? (held !== null && held.base === base ? held.answer : null);

  useEffect(() => {
    if (polled.data?.state !== 'computing') return undefined;
    const timer = setTimeout(() => setTries((n) => n + 1), QUALITY_RETRY_MS);
    return () => clearTimeout(timer);
  }, [polled.data]);

  const retry = () => setTries((n) => n + 1);
  if (polled.data === null && polled.failed) return <Failure onRetry={retry}>The numbers could not be read.</Failure>;
  if (answer === null) return <div aria-busy="true"></div>;
  if (answer.state === 'computing') return <span className="text-sm text-muted">Measuring this repository&apos;s pull requests.</span>;
  if (answer.state === 'failed' || answer.quality === null) {
    return <Failure onRetry={retry}>The numbers could not be measured. They are measured again a minute after the failure.</Failure>;
  }
  return <Numbers quality={answer.quality} />;
}

export function RepositoriesPage() {
  const { api, me } = useApp();
  const { search } = useLocation();
  const [tries, setTries] = useState(0);
  const [windowValue, setWindowValue] = useState('30');
  const list = usePoll(() => api.repositories(), 0, `list ${tries}`);
  const names = list.data?.repositories ?? null;
  const asked = (new URLSearchParams(search).get('repo') ?? '').toLowerCase();
  const repository = names === null ? null : (names.find((name) => name.toLowerCase() === asked) ?? names[0] ?? null);
  const window = WINDOWS.find((one) => one.value === windowValue)?.window ?? 30;

  return (
    <>
      <PageHeader title="Repositories" sub="How well the score tells what needs a person, measured from what people did">
        <div className="flex flex-wrap gap-2.5">
          <label htmlFor="rp-window" className="sr-only">
            Window
          </label>
          <Select id="rp-window" value={windowValue} onChange={(event) => setWindowValue(event.target.value)}>
            {WINDOWS.map((one) => (
              <option key={one.value} value={one.value}>
                {one.label}
              </option>
            ))}
          </Select>
          {me.role === 'admin' && repository !== null ? (
            <Button asChild>
              <Link to="/ui/settings">{`Settings of ${repository}`}</Link>
            </Button>
          ) : null}
        </div>
      </PageHeader>
      {names === null ? (
        list.failed ? <Failure onRetry={() => setTries((n) => n + 1)}>The numbers could not be read.</Failure> : <div aria-busy="true"></div>
      ) : repository === null ? (
        <span className="text-sm text-muted">No repository has been reviewed yet.</span>
      ) : (
        <>
          <div role="tablist" aria-label="Repository" className="flex flex-wrap gap-1 border-b border-border">
            {names.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={name === repository}
                className={`${TAB}${name === repository ? ' border-accent text-text' : ''}`}
                onClick={() => navigate(`/ui/repositories?repo=${name}`, true)}
              >
                {name}
              </button>
            ))}
          </div>
          <Body repository={repository} window={window} />
        </>
      )}
    </>
  );
}
