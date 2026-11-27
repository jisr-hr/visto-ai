// The record of setting changes and the export as config.yml (UI design 4.3 and 4.4; calls 10 and 24). The record's values are
// the service's parsed JSON text, shown as text; the export is text to copy: the page never writes the file.
import { useEffect, useRef, useState } from 'react';
import type { SettingChangeRow } from '../api-types.ts';
import { Button } from '../components/ui/button.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import { useApp } from '../context.tsx';
import { utc } from '../format.ts';
import { H2, LABELS, MONO, whereOf } from './settings-parts.tsx';

const CARD = 'overflow-hidden rounded-[12px] border border-border bg-card shadow-card';
const CARD_HEADER = 'flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-[18px]';
const COLUMNS = ['When', 'Who', 'Where', 'Setting', 'Before', 'After'] as const;
const FAILED_CHANGES = 'The changes could not be read.';

/** A value as the record has it: its text in mono, or Not set, muted, when it was not written. */
function Value({ text }: { text: string | null }) {
  return text === null ? <span className="text-muted">Not set</span> : <span className={MONO}>{text}</span>;
}

function ChangeLine({ row }: { row: SettingChangeRow }) {
  const label = LABELS[row.path];
  return (
    <TableRow hover>
      <TableCell>{utc(row.at)}</TableCell>
      <TableCell>{row.by === 'config.yml' ? <span className={MONO}>config.yml</span> : (row.name ?? 'The UI')}</TableCell>
      <TableCell>{whereOf(row.scope, row.path)}</TableCell>
      <TableCell>{label === undefined ? <span className={MONO}>{row.path}</span> : label}</TableCell>
      <TableCell>
        <Value text={row.before} />
      </TableCell>
      <TableCell>
        <Value text={row.after} />
      </TableCell>
    </TableRow>
  );
}

/** The changes, the latest first; `reads` is bumped by the page after each save. */
export function ChangesSection({ reads }: { reads: number }) {
  const { api } = useApp();
  const [rows, setRows] = useState<SettingChangeRow[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [older, setOlder] = useState(false);
  // Counts the reads of the first page: an Older answer that belongs to an earlier one is dropped.
  const generation = useRef(0);

  useEffect(() => {
    let live = true;
    generation.current += 1;
    setOlder(false);
    api.settingChanges().then(
      (answer) => {
        if (!live) return;
        setRows(answer.changes);
        setNext(answer.next);
        setFailed(false);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [api, reads]);

  function more(): void {
    if (next === null || older) return;
    setOlder(true);
    const mine = generation.current;
    api.settingChanges(next).then(
      (answer) => {
        if (mine !== generation.current) return;
        setRows((last) => [...(last ?? []), ...answer.changes]);
        setNext(answer.next);
        setFailed(false);
        setOlder(false);
      },
      () => {
        if (mine !== generation.current) return;
        setFailed(true);
        setOlder(false);
      },
    );
  }

  return (
    <section id="changes" data-slot="card" aria-labelledby="changes-title" className={CARD}>
      <div className={CARD_HEADER}>
        <h2 id="changes-title" className={`${H2} text-base`}>
          Changes
        </h2>
        <span className="text-[13px] text-muted">The latest first. A change in config.yml is recorded at the start that read it.</span>
      </div>
      {rows === null ? (
        <p className="px-5 py-3 text-sm text-muted">{failed ? FAILED_CHANGES : 'Reading the changes.'}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {COLUMNS.map((column) => (
                    <TableHead key={column} scope="col">
                      {column}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={COLUMNS.length} className="text-muted">
                      No change yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => <ChangeLine key={row.id} row={row} />)
                )}
              </TableBody>
            </Table>
          </div>
          {failed ? <p className="px-5 py-3 text-sm text-muted">{FAILED_CHANGES}</p> : null}
          {next === null ? null : (
            <div className="px-5 py-3">
              <Button type="button" disabled={older} onClick={more}>
                Older
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The saved settings as config.yml writes them, to copy. */
export function ExportSection({ reads }: { reads: number }) {
  const { api } = useApp();
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copy, setCopy] = useState<'not_yet' | 'copied' | 'refused'>('not_yet');

  useEffect(() => {
    let live = true;
    api.settingsExport().then(
      (answer) => {
        if (!live) return;
        setText(answer.text);
        setFailed(false);
        setCopy('not_yet');
      },
      () => {
        if (!live) return;
        setFailed(true);
        setCopy('not_yet');
      },
    );
    return () => {
      live = false;
    };
  }, [api, reads]);

  async function copyText(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopy('copied');
    } catch {
      setCopy('refused');
    }
  }

  return (
    <section id="export" data-slot="card" aria-labelledby="export-title" className={`${CARD} flex flex-col gap-3 px-5 py-[18px]`}>
      <h2 id="export-title" className={`${H2} text-base`}>
        In config.yml
      </h2>
      <p className="text-[13px] text-muted">
        The saved settings, as config.yml writes them. Replace these keys of the file with this text to keep it in step: the UI never writes the file, and a setting changed in the file wins at the next start.
      </p>
      {text === null ? (
        <p className="m-0 text-sm text-muted">{failed ? 'The text could not be read.' : 'Reading the text.'}</p>
      ) : (
        <>
          {failed ? <p className="m-0 text-[13px] text-bad">The text could not be read again. What is shown may be out of date.</p> : null}
          <pre className="m-0 overflow-x-auto rounded-lg bg-subtle p-3.5 font-mono text-[12.5px]">{text}</pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => void copyText(text)}>
              {copy === 'copied' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {copy === 'refused' ? <p className="m-0 text-[13px] text-bad">The copy was refused: select the text and copy it by hand.</p> : null}
        </>
      )}
    </section>
  );
}
