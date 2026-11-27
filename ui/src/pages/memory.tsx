// The Memory screen as drawn in Memory.dc.html (lines 69 to 106; Task 12; UI design 1, item 5, and calls 30 to 33): what the
// service learned from people, reverts and replies, with the counts, the records filtered by kind, repository and a search,
// and paged, and for an admin a switch on each record. Read once for a query and again after a switch, never polled. What a
// person wrote is shown as text, in a <bdi>; the switch shows the record the service answered, never a state it refused.
import { useEffect, useState } from 'react';
import type { MemoryQuery } from '../api.ts';
import type { MemoryKind, MemoryRecordShown, MemoryView } from '../api-types.ts';
import { PageHeader } from '../components/layout.tsx';
import { Segmented } from '../components/segmented.tsx';
import type { SegmentedOption } from '../components/segmented.tsx';
import { Badge } from '../components/ui/badge.tsx';
import type { BadgeTone } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Input } from '../components/ui/input.tsx';
import { Select } from '../components/ui/select.tsx';
import { Switch } from '../components/ui/switch.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import { useApp } from '../context.tsx';
import { ago, plural, shortDay } from '../format.ts';
import { CARD, MONO, SEARCH_MS } from './activity.tsx';

/** The longest search the API takes (a trimmed `q` over it is `bad_request`). */
const SEARCH_MAX = 100;

type Kind = '' | MemoryKind;
const KINDS: readonly SegmentedOption<Kind>[] = [
  { value: '', label: 'All' },
  { value: 'human_signal', label: 'People stepped in' },
  { value: 'revert', label: 'Reverts' },
  { value: 'lesson', label: 'Lessons' },
];

const BADGES: Readonly<Record<MemoryKind, { tone: BadgeTone; label: string }>> = {
  human_signal: { tone: 'info', label: 'A person stepped in' },
  revert: { tone: 'bad', label: 'Reverted' },
  lesson: { tone: 'accent', label: 'Lesson' },
};

const COUNT_CARD = 'flex flex-col gap-1.5 px-[18px] py-4';
const COUNT_LABEL = 'text-[13px] font-medium text-muted';
const COUNT_LINE = 'text-[13px] text-muted';
const HEAD = 'flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4';
const DATE = 'whitespace-nowrap text-[13px] text-muted';
const NOTE = 'm-0 border-t border-border px-5 pb-4 pt-3 text-[13px] text-muted';
const FOOT = 'flex flex-wrap items-center justify-between gap-2.5 border-t border-border px-5 py-3';

/** The query sent: only what is chosen, and the page to read from. */
function queryOf(kind: Kind, repo: string, q: string, before: number | undefined): MemoryQuery {
  const query: MemoryQuery = {};
  if (kind !== '') query.kind = kind;
  if (repo !== '') query.repo = repo;
  if (q !== '') query.q = q;
  if (before !== undefined) query.before = before;
  return query;
}

/** The record's text, said: a person's words (or that they commented), what a revert is, a lesson's own text. */
function textOf(record: MemoryRecordShown): string {
  if (record.kind === 'revert') return 'This file was part of a pull request that was reverted.';
  if (record.kind === 'human_signal' && record.text === '') return 'A person commented on these lines.';
  return record.text;
}

function fromOf(record: MemoryRecordShown): string {
  if (record.kind === 'revert') return `#${record.number} reverted #${record.reverted ?? ''}`;
  if (record.kind === 'lesson') return `A reply on #${record.number}`;
  return `#${record.number}${record.by === null ? '' : `, by ${record.by}`}`;
}

function RecordRow({ record, admin, busy, onSwitch }: { record: MemoryRecordShown; admin: boolean; busy: boolean; onSwitch: () => void }) {
  const badge = BADGES[record.kind] ?? { tone: 'muted', label: record.kind };
  const where = record.path ?? record.directory ?? '';
  return (
    <TableRow hover className={record.on ? undefined : '[&>td]:opacity-60'}>
      <TableCell className="max-w-[420px]">
        <div className="flex flex-col gap-1.5">
          <Badge tone={badge.tone} className="self-start">
            {badge.label}
          </Badge>
          <span className="text-sm leading-normal">
            {record.kind === 'revert' ? textOf(record) : <bdi>{textOf(record)}</bdi>}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <span className={MONO}>{where}</span>
        <div className="mt-1 text-xs text-muted">{record.repository}</div>
      </TableCell>
      <TableCell className="text-[13px] text-muted">
        {record.kind === 'human_signal' && record.by !== null ? (
          <>
            {`#${record.number}, by `}
            <bdi>{record.by}</bdi>
          </>
        ) : (
          fromOf(record)
        )}
      </TableCell>
      {/* A time the server could not write (one an operator set to infinity) is said, never a failure of the page. */}
      <TableCell className={DATE}>{record.createdAt === null ? 'Unknown' : shortDay(record.createdAt.slice(0, 10))}</TableCell>
      <TableCell className={DATE}>{record.expiresAt === null ? 'Never' : shortDay(record.expiresAt.slice(0, 10))}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2.5">
          <Switch
            checked={record.on}
            label={`${record.on ? 'Turn off' : 'Turn on'}: ${where}`}
            disabled={!admin || busy}
            title={admin ? undefined : 'Only an admin can turn a record on or off.'}
            onChange={onSwitch}
          />
          <span className="text-[13px] text-muted">{record.on ? 'On' : 'Off'}</span>
        </div>
      </TableCell>
    </TableRow>
  );
}

function Said({ children }: { children: string }) {
  return (
    <TableRow>
      <TableCell colSpan={6} className="text-muted">
        {children}
      </TableCell>
    </TableRow>
  );
}

/** What was read for one query: the answer, or that it failed; a later query's read starts again from nothing. */
interface Read { key: string; view: MemoryView | null; failed: boolean }

export function MemoryPage() {
  const { api, me } = useApp();
  const admin = me.role === 'admin';
  const [kind, setKind] = useState<Kind>('');
  const [repo, setRepo] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  // The `before` of each page after the first: Next pushes the page's `next`, Previous pops.
  const [pages, setPages] = useState<readonly number[]>([]);
  const [reads, setReads] = useState(0);
  const [read, setRead] = useState<Read>({ key: '', view: null, failed: false });
  // What the service answered to a switch, shown until the page is read again; the records switching now; a switch refused.
  const [answered, setAnswered] = useState<ReadonlyMap<number, MemoryRecordShown>>(new Map());
  const [switching, setSwitching] = useState<ReadonlySet<number>>(new Set());
  const [refused, setRefused] = useState(false);

  // The search is sent SEARCH_MS after the last key, and starts again from the first page.
  useEffect(() => {
    const wanted = search.trim().slice(0, SEARCH_MAX);
    if (wanted === q) return undefined;
    const timer = setTimeout(() => {
      setQ(wanted);
      setPages([]);
    }, SEARCH_MS);
    return () => clearTimeout(timer);
  }, [search, q]);

  const before = pages.at(-1);
  const query = queryOf(kind, repo, q, before);
  const key = JSON.stringify(query);

  // A refusal belongs to the page it was said on.
  useEffect(() => {
    setRefused(false);
  }, [key]);

  useEffect(() => {
    let live = true;
    api.memory(JSON.parse(key) as MemoryQuery).then(
      (view) => {
        if (!live) return;
        setRead({ key, view, failed: false });
        setAnswered(new Map());
      },
      () => {
        // A failed read again keeps what was shown for the same query.
        if (live) setRead((last) => ({ key, view: last.key === key ? last.view : null, failed: true }));
      },
    );
    return () => {
      live = false;
    };
  }, [api, key, reads]);

  const view = read.key === key ? read.view : null;
  const failed = read.key === key && read.failed && view === null;
  const filtered = kind !== '' || repo !== '' || q !== '';
  const next = view === null ? null : view.next;

  function chooseKind(value: Kind): void {
    if (value === kind) return;
    setKind(value);
    setPages([]);
  }
  function chooseRepo(value: string): void {
    if (value === repo) return;
    setRepo(value);
    setPages([]);
  }
  async function flip(record: MemoryRecordShown): Promise<void> {
    setRefused(false);
    setSwitching((now) => new Set(now).add(record.id));
    try {
      const done = await api.switchMemory(me.csrf, record.id, !record.on);
      setAnswered((now) => new Map(now).set(record.id, done.record));
      setReads((n) => n + 1);
    } catch {
      // A refusal (forbidden, csrf, not_found) or a failure: the record stays as the service has it.
      setRefused(true);
    } finally {
      setSwitching((now) => {
        const rest = new Set(now);
        rest.delete(record.id);
        return rest;
      });
    }
  }

  return (
    <>
      <PageHeader title="Memory" sub="What the service learned from people, reverts and replies, told to later reviews as context">
        {view === null ? null : (
          <div className="flex flex-wrap items-center gap-2.5">
            {view.learning.on ? (
              <>
                <Badge tone="ok" dot>
                  Learning is on
                </Badge>
                <span className="text-[13px] text-muted">{view.learning.ranAt === null ? 'No pass yet' : `Last pass ${ago(view.learning.ranAt, view.now)}`}</span>
              </>
            ) : (
              <>
                <Badge tone="muted" dot>
                  Learning is off
                </Badge>
                <span className="text-[13px] text-muted">No record is made, and none is shown to reviews.</span>
              </>
            )}
          </div>
        )}
      </PageHeader>

      {view === null ? null : (
        <section aria-label="Records" className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
          <Card className={COUNT_CARD}>
            <span className={COUNT_LABEL}>People stepped in</span>
            <span className="text-[26px] font-semibold">{view.counts.signals}</span>
            <span className={COUNT_LINE}>{`across ${plural(view.counts.signalRepositories, 'repository', 'repositories')}`}</span>
          </Card>
          <Card className={COUNT_CARD}>
            <span className={COUNT_LABEL}>Reverts</span>
            <span className="text-[26px] font-semibold">{view.counts.reverts}</span>
            <span className={COUNT_LINE}>files of reverted pull requests</span>
          </Card>
          <Card className={COUNT_CARD}>
            <span className={COUNT_LABEL}>Lessons</span>
            <span className="text-[26px] font-semibold">{view.counts.lessons}</span>
            <span className={COUNT_LINE}>from replies to findings</span>
          </Card>
          <Card className={COUNT_CARD}>
            <span className={COUNT_LABEL}>Turned off</span>
            <span className="text-[26px] font-semibold">{view.counts.off}</span>
            <span className={COUNT_LINE}>shown to no review</span>
          </Card>
        </section>
      )}

      <section data-slot="card" aria-label="Learned records" className={CARD}>
        <div className={HEAD}>
          <Segmented label="Kind" options={KINDS} value={kind} onChange={chooseKind} />
          <div className="flex flex-wrap gap-2.5">
            <label htmlFor="mem-search" className="sr-only">
              Search records
            </label>
            <Input
              id="mem-search"
              type="search"
              placeholder="Search path or text"
              className="w-[220px]"
              maxLength={SEARCH_MAX}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <label htmlFor="mem-repo" className="sr-only">
              Repository
            </label>
            <Select id="mem-repo" value={repo} onChange={(event) => chooseRepo(event.target.value)}>
              <option value="">All repositories</option>
              {me.repositories.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {refused ? (
          <p role="alert" className="m-0 px-5 pt-3 text-sm text-bad">
            The record could not be switched.
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Record</TableHead>
                <TableHead scope="col">Where</TableHead>
                <TableHead scope="col">From</TableHead>
                <TableHead scope="col">Made</TableHead>
                <TableHead scope="col">Expires</TableHead>
                <TableHead scope="col">Shown to reviews</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody aria-busy={view === null && !failed ? true : undefined}>
              {view === null ? (
                failed ? (
                  <Said>The records could not be read.</Said>
                ) : null
              ) : view.records.length === 0 ? (
                <Said>{filtered ? 'No record matches.' : 'No record yet.'}</Said>
              ) : (
                view.records.map((shown) => {
                  const record = answered.get(shown.id) ?? shown;
                  return <RecordRow key={record.id} record={record} admin={admin} busy={switching.has(record.id)} onSwitch={() => void flip(record)} />;
                })
              )}
            </TableBody>
          </Table>
        </div>
        <div className={FOOT}>
          <span className="text-[13px] text-muted">{view === null ? null : `${view.records.length} of ${plural(view.total, 'record', 'records')}`}</span>
          <div className="flex gap-2">
            <Button type="button" disabled={pages.length === 0} onClick={() => setPages(pages.slice(0, -1))}>
              Previous
            </Button>
            <Button type="button" disabled={next === null} onClick={() => next !== null && setPages([...pages, next])}>
              Next
            </Button>
          </div>
        </div>
        <p className={NOTE}>
          {`A record turned off is shown to no later review, at once. Turning it on again shows it from the next review. Nothing learned can lower a score.${admin ? '' : ' Only an admin can turn a record on or off.'}`}
        </p>
      </section>
    </>
  );
}
