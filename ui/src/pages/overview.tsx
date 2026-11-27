// The Overview screen as drawn in Main.dc.html (lines 73 to 137; Task 10; UI design 1, item 1, and 3.4; calls 15 to 22): the
// reviews, what is in review now, the spend and the automatic approvals; the reviews of each day; the alerts; the score
// quality of each repository; and the dependencies. The overview is read every minute, health every fifteen seconds; the header
// shows whatever the reads did, and a read that failed carries no alert role, as on Activity.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { usePoll } from '../api.ts';
import type { AlertShown, Health, Measure, Overview, OverviewQuality, WindowDays } from '../api-types.ts';
import { PageHeader } from '../components/layout.tsx';
import { Segmented } from '../components/segmented.tsx';
import type { SegmentedOption } from '../components/segmented.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import { reviewCounts, useApp } from '../context.tsx';
import { count, dollars, percent, plural, shortDay } from '../format.ts';
import { Link } from '../router.tsx';
import { alertWords, approvalWords, dependencyWords } from '../words.ts';
import { CARD, CARD_TITLE } from './activity.tsx';
import { Spans } from './review.tsx';

/** How often the overview is read again, and health. */
export const OVERVIEW_MS = 60000;
export const HEALTH_MS = 15000;
/** The fewest labelled blocks that make Safety a share. */
export const ENOUGH_LABELS = 10;
/** The recent alerts shown after the open ones. */
const RECENT_SHOWN = 5;
/** The open alerts the server answers at most: at this many there may be more. */
const OPEN_SHOWN = 50;

const PERIODS: readonly SegmentedOption<`${WindowDays}`>[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

const SUMMARY = 'flex flex-col gap-2 p-[18px]';
const LABEL = 'text-[13px] font-medium text-muted';
const BIG = 'text-[30px] font-semibold leading-[1.1] tracking-[-0.02em]';
const LINE = 'text-[13px] text-muted';

function SummaryCard({ label, big, children }: { label: string; big: string; children: ReactNode }) {
  return (
    <Card className={SUMMARY}>
      <span className={LABEL}>{label}</span>
      <span className={BIG}>{big}</span>
      {children}
    </Card>
  );
}

function Summary({ overview }: { overview: Overview }) {
  const { me, activity } = useApp();
  const { reviews, spend, approvals } = overview;
  let published = `${reviews.published} published, ${reviews.dryRun} in dry run, ${reviews.failed} failed`;
  if (reviews.nothingNew > 0) published += `, ${reviews.nothingNew} with nothing new`;
  if (reviews.notPosted > 0) published += `, ${reviews.notPosted} not posted`;

  let running = '0';
  let now = 'Not read yet.';
  if (activity !== null) {
    const counts = reviewCounts(activity.jobs);
    const waiting = activity.jobs.filter((job) => job.stage === 'waiting').length;
    running = count(counts.running);
    now = `${counts.running - waiting} reviewing, ${waiting} waiting for pushes to settle`;
    if (counts.queued > 0) now += `, ${counts.queued} queued`;
  }
  const share = spend.limit > 0 ? Math.min(100, Math.round((spend.today / spend.limit) * 100)) : 0;

  return (
    <section aria-label="Summary" className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
      <SummaryCard label="Reviews" big={count(reviews.total)}>
        <span className={LINE}>{published}</span>
      </SummaryCard>
      <Link to="/ui/activity" className={`rounded-[12px] border border-border bg-card shadow-card ${SUMMARY} text-text no-underline`}>
        <span className={LABEL}>In review now</span>
        <span className={BIG}>{running}</span>
        <span className={LINE}>{now}</span>
      </Link>
      <SummaryCard label="Spend today" big={dollars(spend.today)}>
        <div role="img" aria-label={`${share} percent of the daily limit`} className="h-1.5 overflow-hidden rounded-full bg-subtle">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${share}%` }} />
        </div>
        <span className={LINE}>{`of the ${dollars(spend.limit)} daily limit`}</span>
      </SummaryCard>
      <SummaryCard label="Approved automatically" big={count(approvals.approved)}>
        <span className={LINE}>
          {me.mode === 'dry_run' ? 'Not decided in dry run' : `of ${approvals.approved + approvals.audited} approvable, ${approvals.audited} drawn for the audit`}
        </span>
      </SummaryCard>
    </section>
  );
}

function Legend({ tone, children }: { tone: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-2.5 rounded-[3px] ${tone}`} />
      {children}
    </span>
  );
}

/** A part's height: its count over the window's busiest day, as a percent. */
const height = (count: number, most: number): string => `${(count / most) * 100}%`;

function PerDay({ overview }: { overview: Overview }) {
  const { perDay, days } = overview;
  const totals = perDay.map((day) => day.published + day.failed + day.other);
  const most = Math.max(1, ...totals);
  const least = totals.length === 0 ? 0 : Math.min(...totals);
  const anyOther = perDay.some((day) => day.other > 0);
  const middle = perDay[Math.floor(perDay.length / 2)];
  const first = perDay[0];
  return (
    <Card className="flex min-w-0 grow-[2] basis-[520px] flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className={CARD_TITLE}>Reviews per day</h2>
        <div className="flex gap-3.5 text-xs text-muted">
          <Legend tone="bg-accent">Published</Legend>
          {anyOther ? <Legend tone="bg-muted">Dry run or not posted</Legend> : null}
          <Legend tone="bg-bad">Failed</Legend>
        </div>
      </div>
      <div
        role="img"
        aria-label={`Reviews per day over the last ${days} days, between ${least} and ${Math.max(0, ...totals)} a day`}
        className="flex h-[180px] items-end gap-[5px] border-b border-border pt-2"
      >
        {perDay.map((day) => (
          <div
            key={day.day}
            title={`${shortDay(day.day)}: ${day.published} published, ${day.other} dry run or not posted, ${day.failed} failed, ${dollars(day.cost)} spent`}
            className="flex h-full flex-1 flex-col justify-end gap-0.5"
          >
            {day.failed > 0 ? <div className="rounded-[3px] bg-bad" style={{ height: height(day.failed, most) }} /> : null}
            {day.other > 0 ? <div className="rounded-[3px] bg-muted" style={{ height: height(day.other, most) }} /> : null}
            {day.published > 0 ? <div className="rounded-t-[4px] rounded-b-[2px] bg-accent opacity-90" style={{ height: height(day.published, most) }} /> : null}
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted">
        <span>{first === undefined ? '' : shortDay(first.day)}</span>
        <span>{middle === undefined ? '' : shortDay(middle.day)}</span>
        <span>Today</span>
      </div>
    </Card>
  );
}

function AlertLine({ alert, now }: { alert: AlertShown; now: string }) {
  const words = alertWords(alert, now);
  return (
    <div className="flex items-start gap-3">
      <Badge tone={words.tone} className="mt-0.5">
        {words.badge}
      </Badge>
      <div className="flex flex-col gap-0.5 text-sm">
        <strong className="font-semibold">{words.title}</strong>
        <span className="text-[13px] text-muted">
          <Spans text={words.detail} />
        </span>
      </div>
    </div>
  );
}

function Alerts({ health, failed }: { health: Health | null; failed: boolean }) {
  const shown = health === null ? [] : [...health.open, ...health.recent.slice(0, RECENT_SHOWN)];
  return (
    <Card className="flex min-w-0 grow basis-[320px] flex-col gap-3.5 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className={CARD_TITLE}>Alerts</h2>
        {health === null ? null : health.open.length > 0 ? (
          <Badge tone="bad">{health.open.length >= OPEN_SHOWN ? `${OPEN_SHOWN}+ open` : `${health.open.length} open`}</Badge>
        ) : (
          <Badge tone="muted">None open</Badge>
        )}
      </div>
      {health === null ? (
        failed ? <span className="text-sm text-muted">The alerts could not be read.</span> : null
      ) : shown.length === 0 ? (
        <span className="text-sm text-muted">No alert in the last 7 days.</span>
      ) : (
        shown.map((alert) => <AlertLine key={alert.id} alert={alert} now={health.now} />)
      )}
    </Card>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted">{children}</span>;
}

function Share({ measure, unit }: { measure: Measure | null; unit: string }) {
  if (measure === null || measure.share === null) return <Muted>None</Muted>;
  return (
    <>
      <strong>{percent(measure.share)}</strong> <Muted>{unit}</Muted>
    </>
  );
}

function Safety({ measure }: { measure: Measure | null }) {
  if (measure === null) return <Muted>None</Muted>;
  if (measure.of < ENOUGH_LABELS) return <Muted>{`Not enough labels yet, ${measure.part} of ${measure.of} blocks`}</Muted>;
  return (
    <>
      <strong>{percent(measure.share)}</strong> <Muted>{`${measure.part} of ${measure.of} blocks`}</Muted>
    </>
  );
}

function QualityRow({ row }: { row: OverviewQuality }) {
  const approval = approvalWords(row.approval);
  return (
    <TableRow hover>
      <TableCell>
        <Link to={`/ui/repositories?repo=${encodeURIComponent(row.repository)}`} className="font-medium">
          {row.repository}
        </Link>
      </TableCell>
      <TableCell>{`${row.threshold}%`}</TableCell>
      {row.state === 'ready' ? (
        <>
          <TableCell>
            <Safety measure={row.safety} />
          </TableCell>
          <TableCell>
            {row.benefit === null || row.benefit.of === 0 ? <Muted>None</Muted> : (
              <>
                <strong>{percent(row.benefit.share)}</strong> <Muted>{`${row.benefit.part} of ${row.benefit.of}`}</Muted>
              </>
            )}
          </TableCell>
          <TableCell>
            <Share measure={row.focus} unit="of lines" />
          </TableCell>
          <TableCell>
            {row.reverts === null ? <Muted>None</Muted> : (
              <>
                {row.reverts.merged}
                {row.reverts.merged > 0 ? <Muted>{` (${row.reverts.approved} approved)`}</Muted> : null}
              </>
            )}
          </TableCell>
        </>
      ) : (
        <TableCell colSpan={4} className="text-muted">
          {row.state === 'computing' ? 'Not measured yet' : 'Could not be measured'}
        </TableCell>
      )}
      <TableCell>
        <Badge tone={approval.tone}>{approval.text}</Badge>
      </TableCell>
    </TableRow>
  );
}

function ScoreQuality({ overview }: { overview: Overview }) {
  return (
    <section data-slot="card" aria-labelledby="ov-quality" className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-5 pb-3 pt-[18px]">
        <h2 id="ov-quality" className={CARD_TITLE}>
          Score quality by repository
        </h2>
        <Link to="/ui/repositories" className="text-sm">
          All numbers
        </Link>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Repository</TableHead>
              <TableHead scope="col">Threshold</TableHead>
              <TableHead scope="col">Safety (lower is better)</TableHead>
              <TableHead scope="col">Benefit</TableHead>
              <TableHead scope="col">Focus</TableHead>
              <TableHead scope="col">Reverts</TableHead>
              <TableHead scope="col">Automatic approval</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overview.quality.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted">{`No repository was reviewed in the last ${overview.days} days.`}</TableCell>
              </TableRow>
            ) : (
              overview.quality.map((row) => <QualityRow key={row.repository} row={row} />)
            )}
          </TableBody>
        </Table>
      </div>
      {overview.qualityCut > 0 ? (
        <p className="m-0 px-5 pb-3 text-[13px] text-muted">{`And ${plural(overview.qualityCut, 'more repository', 'more repositories')}, in Repositories.`}</p>
      ) : null}
      <p className="m-0 border-t border-border px-5 pt-3 pb-4 text-[13px] text-muted">
        Safety: of the blocks a person stepped in on, the share the score would have left to the bot. Benefit: the share of pull requests where nothing reached the
        threshold. Focus: in pull requests that needed a person, the share of changed lines flagged for them.
      </p>
    </section>
  );
}

function Dependencies({ health, failed }: { health: Health | null; failed: boolean }) {
  return (
    <Card className="flex flex-col gap-3.5 p-5">
      <h2 className={CARD_TITLE}>Dependencies</h2>
      {health === null ? (
        failed ? <span className="text-sm text-muted">The dependencies could not be read.</span> : null
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          {health.dependencies.map((dependency, i) => {
            const words = dependencyWords(dependency, health.now);
            return (
              <div key={`${i} ${dependency.kind} ${dependency.name ?? ''}`} data-slot="dependency" className="flex flex-col gap-1.5 rounded-[10px] border border-border px-3.5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-sm font-semibold">{words.title}</strong>
                  <Badge tone={words.tone} dot>
                    {words.badge}
                  </Badge>
                </div>
                <span className="text-[13px] text-muted">
                  <Spans text={words.line} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function OverviewPage() {
  const { api } = useApp();
  const [days, setDays] = useState<WindowDays>(30);
  const [tries, setTries] = useState(0);
  const overview = usePoll(() => api.overview(days), OVERVIEW_MS, `${days}:${tries}`);
  const health = usePoll(() => api.health(), HEALTH_MS, 'health');
  const data = overview.data;

  const sub = data === null ? `Last ${days} days` : data.repositories === 0
    ? `Last ${days} days, no repository reviewed`
    : `Last ${days} days across ${plural(data.repositories, 'repository', 'repositories')}`;

  return (
    <>
      <PageHeader title="Overview" sub={sub}>
        <Segmented
          label="Period"
          options={PERIODS}
          value={`${days}`}
          onChange={(value) => setDays(Number(value) as WindowDays)}
        />
      </PageHeader>
      {data === null ? (
        overview.failed ? (
          <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
            <span className="text-sm">The overview could not be read.</span>
            <Button type="button" onClick={() => setTries((n) => n + 1)}>
              Try again
            </Button>
          </Card>
        ) : (
          <div aria-busy="true"></div>
        )
      ) : (
        <Summary overview={data} />
      )}
      <section className="flex flex-wrap gap-4">
        {data === null ? null : <PerDay overview={data} />}
        <Alerts health={health.data} failed={health.failed} />
      </section>
      {data === null ? null : <ScoreQuality overview={data} />}
      <Dependencies health={health.data} failed={health.failed} />
    </>
  );
}
