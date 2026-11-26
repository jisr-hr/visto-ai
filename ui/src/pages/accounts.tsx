// Settings, which opens on Accounts (the password design 4.2, 4.3 and 4.7; calls 9, 12 and 25): the table of the accounts, New
// account, and per row its role changed, its password reset and its removal, asked in the row first. A one-time password is
// shown once, kept in this page's state only, until Done or the page is left: it is never written to storage, the address or
// the console. After each change (or a not_found, or a make that may have made its account all the same) the list is read again;
// it is not polled. Every role is the API's to check: a refusal 403 forbidden makes the app read who is signed in again.
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { RequestFailed } from '../api.ts';
import type { Account, Accounts, OneTime, Role } from '../api-types.ts';
import { PageHeader } from '../components/layout.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Select } from '../components/ui/select.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.tsx';
import { useApp } from '../context.tsx';
import { ago, plural, utc } from '../format.ts';

/** The rule of a name an account is made with (the service's own, in src/ui/passwords.ts): checked before sending. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,38}$/;

// The section as Activity's: the mockup's .card with its overflow, its head, its heading.
const CARD = 'overflow-hidden rounded-[12px] border border-border bg-card shadow-card';
const CARD_HEADER = 'flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-[18px]';
const CARD_TITLE = 'm-0 text-base font-semibold';
const LINE = 'text-[13px] text-muted';
const COLUMNS = ['Name', 'Signs in with', 'Role', 'Last sign-in', 'Made', 'Actions'] as const;

const SUB = 'Who may open the service, and what they may do. The other settings come in a later plan.';
const HELP = '1 to 39 characters: lower-case letters, digits, dots, underscores and hyphens, starting with a letter or a digit.';
const BAD_NAME = 'A name is 1 to 39 characters: lower-case letters, digits, dots, underscores and hyphens, starting with a letter or a digit.';
// What each refusal of a change says, by its code.
const REFUSALS: Readonly<Record<string, string>> = {
  last_admin: 'The last admin cannot be made a viewer or removed. Make another admin first: one who has not chosen a password yet does not count.',
  own_account: 'Change your own password from the sidebar.',
  not_found: 'This account no longer exists.',
  name_taken: 'An account with this name exists already.',
  bad_name: BAD_NAME,
  full: 'This deployment keeps 1,000 accounts at most. Remove one first.',
};
const BUSY = 'The service is busy. Try again in a moment.';
const UNREACHABLE = 'The service could not be reached. Try again in a moment.';
const FAILED = 'The change failed.';
const REFUSED_COPY = 'The copy was refused: select the password and copy it by hand.';

/** How an account signs in; a kind this frontend does not know is said as it is. */
const WAYS: ReadonlyMap<string, string> = new Map([['password', 'Password'], ['github', 'GitHub']]);

/** What a refusal says: its code's sentence (the object's own key only), else a busy service, one not reached, or a failed change. */
function refusalOf(error: unknown): string {
  if (!(error instanceof RequestFailed)) return FAILED;
  if (Object.hasOwn(REFUSALS, error.code)) return REFUSALS[error.code] ?? FAILED;
  if (error.status === 503) return BUSY;
  if (error.status === 0) return UNREACHABLE;
  return FAILED;
}
const isNotFound = (error: unknown): boolean => error instanceof RequestFailed && error.code === 'not_found';
/** A make whose account may be there all the same: one of that name exists already, or its answer was lost (none, a 5xx, unreadable). */
const mayBeMade = (error: unknown): boolean =>
  error instanceof RequestFailed && (error.code === 'name_taken' || error.code === 'unreadable' || error.status === 0 || error.status >= 500);

// The ids of a row's name, which describes each of its buttons, and of its Reset password, where Done puts focus back.
const nameId = (id: number): string => `account-${id}-name`;
const resetId = (id: number): string => `account-${id}-reset`;

/** The lines under a password account's way in: no password chosen yet, an expired one-time password, a wait. */
function linesOf(account: Account): string[] {
  if (account.kind !== 'password') return [];
  const lines: string[] = [];
  if (account.password === 'one_time') lines.push('Has not chosen a password yet');
  if (account.password === 'expired') lines.push('Its one-time password has expired');
  if (account.waitsUntil !== null) lines.push(`Waiting after five wrong tries, until ${utc(account.waitsUntil)}`);
  return lines;
}

/** Who made an account; none for an account's maker with no name, or a maker this frontend does not know. */
function madeByOf(madeBy: Account['madeBy']): string | null {
  switch (madeBy.kind) {
    case 'password':
    case 'github':
      return madeBy.name === null ? null : `by ${madeBy.name}`;
    case 'command':
      return 'by the command';
    case 'sign_in':
      return 'at its first sign-in';
    default:
      return null;
  }
}

/** A label over its field. */
function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * A one-time password on screen, for whom, until when, whether Copy worked, and what opened it: New account for a make, the id
 * of the account whose Reset password it was.
 */
interface Shown { name: string; password: string; expiresAt: string; copy: 'not_yet' | 'copied' | 'refused'; from: 'new' | number }

/** What a row's buttons do. */
interface RowChanges { role: (role: Role) => void; reset: () => void; ask: () => void; remove: () => void; cancel: () => void }

function AccountLine({ account, now, asking, sending, change }: { account: Account; now: string; asking: boolean; sending: boolean; change: RowChanges }) {
  const admin = account.role === 'admin';
  const by = madeByOf(account.madeBy);
  // Each button of the row is described by the row's name, so that a button read alone says whose it is.
  const name = nameId(account.id);
  return (
    <TableRow hover>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          <span id={name} className="font-medium">
            {account.name}
          </span>
          {account.kind === 'github' ? <Badge tone="muted">GitHub</Badge> : null}
          {account.you ? <Badge tone="accent">You</Badge> : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span>{WAYS.get(account.kind) ?? account.kind}</span>
          {linesOf(account).map((line) => (
            <span key={line} className={LINE}>
              {line}
            </span>
          ))}
        </div>
      </TableCell>
      <TableCell>{admin ? <Badge tone="accent">Admin</Badge> : <Badge tone="muted">Viewer</Badge>}</TableCell>
      {account.lastSignInAt === null ? (
        <TableCell className="text-muted">Never</TableCell>
      ) : (
        <TableCell>{ago(account.lastSignInAt, now)}</TableCell>
      )}
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span>{ago(account.madeAt, now)}</span>
          {by === null ? null : <span className={LINE}>{by}</span>}
        </div>
      </TableCell>
      <TableCell>
        {/* The question's Cancel stands where the row's Remove stands, so React keeps one button for both, unkeyed: focus goes
            from Remove to Cancel and back with it. */}
        {asking ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px]">{`Remove ${account.name}? Their sessions end at once.`}</span>
            <Button type="button" variant="primary" aria-describedby={name} disabled={sending} onClick={change.remove}>
              Remove
            </Button>
            <Button type="button" aria-describedby={name} onClick={change.cancel}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button type="button" aria-describedby={name} disabled={sending} onClick={() => change.role(admin ? 'viewer' : 'admin')}>
              {admin ? 'Make viewer' : 'Make admin'}
            </Button>
            {/* The API refuses an admin's reset of their own account (call 9), and a GitHub account has no password. */}
            {account.kind === 'password' && account.you === false ? (
              <Button type="button" id={resetId(account.id)} aria-describedby={name} disabled={sending} onClick={change.reset}>
                Reset password
              </Button>
            ) : null}
            <Button type="button" aria-describedby={name} onClick={change.ask}>
              Remove
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

/** The page, for a signed-in admin (the app shows anyone else the not-found page here). */
export function AccountsPage() {
  const { api, me } = useApp();
  // The latest read of the list; a failed one drops what was shown.
  const [read, setRead] = useState<{ data: Accounts | null; failed: boolean }>({ data: null, failed: false });
  const [reads, setReads] = useState(0);
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  // One change at a time: the ref refuses a second at once, the state says which is sent.
  const inFlight = useRef(false);
  const [sending, setSending] = useState<'make' | 'row' | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  // The id of the account whose removal is asked in its row.
  const [asking, setAsking] = useState<number | null>(null);
  const newAccount = useRef<HTMLButtonElement>(null);
  // The control focus goes to once the page is drawn again, when the one that had it is gone: none when null.
  const focusNext = useRef<(() => HTMLElement | null) | null>(null);

  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    next?.()?.focus();
  });

  useEffect(() => {
    let live = true;
    api.accounts().then(
      (data) => {
        if (live) setRead({ data, failed: false });
      },
      () => {
        if (live) setRead({ data: null, failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, [api, reads]);

  const readAgain = (): void => setReads((n) => n + 1);

  /**
   * A change sent: its answer applied and the list read again; a refusal said, and the list read again after a not_found, and
   * after a make that may have made its account all the same (`name_taken`, or an answer lost).
   */
  async function send<T>(which: 'make' | 'row', change: () => Promise<T>, done: (answer: T) => void): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(which);
    setAlert(null);
    setAsking(null);
    try {
      done(await change());
      readAgain();
    } catch (error) {
      // A 401 has signed the person out already (the app's watched API); the page is gone with it.
      setAlert(refusalOf(error));
      if (isNotFound(error) || (which === 'make' && mayBeMade(error))) readAgain();
    } finally {
      inFlight.current = false;
      setSending(null);
    }
  }

  /** The one-time password of an account made or reset, in place of any shown before; `from` is what opened it. */
  const show = (made: OneTime, from: Shown['from']): void =>
    setShown({ name: made.account.name, password: made.oneTimePassword, expiresAt: made.expiresAt, copy: 'not_yet', from });

  /** Done: the one-time password forgotten, and focus back on what opened it, New account or the row's Reset password. */
  function done(from: Shown['from']): void {
    setShown(null);
    focusNext.current = () => (from === 'new' ? newAccount.current : document.getElementById(resetId(from)));
  }

  function closeForm(): void {
    setMaking(false);
    setName('');
    setRole('viewer');
  }

  function make(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (inFlight.current) return;
    // Sent as typed: a name is made only when it already matches the rule (call 16).
    if (!NAME.test(name)) {
      setAlert(BAD_NAME);
      return;
    }
    void send('make', () => api.makeAccount(me.csrf, name, role), (made) => {
      show(made, 'new');
      closeForm();
    });
  }

  /** Copy, and what came of it, said on the box it was pressed in only. */
  async function copy(password: string): Promise<void> {
    const mark = (result: Shown['copy']): void => setShown((last) => (last !== null && last.password === password ? { ...last, copy: result } : last));
    try {
      await navigator.clipboard.writeText(password);
      mark('copied');
    } catch {
      mark('refused');
    }
  }

  const changesOf = (account: Account): RowChanges => ({
    role: (to) => void send('row', () => api.setRole(me.csrf, account.id, to), () => {}),
    reset: () => void send('row', () => api.resetPassword(me.csrf, account.id), (made) => show(made, account.id)),
    ask: () => setAsking(account.id),
    remove: () => void send('row', () => api.removeAccount(me.csrf, account.id), () => {}),
    cancel: () => setAsking(null),
  });

  const data = read.data;
  return (
    <>
      <PageHeader title="Settings" sub={SUB} />
      <section data-slot="card" aria-labelledby="accounts-title" className={CARD}>
        <div className={CARD_HEADER}>
          <div className="flex items-center gap-2.5">
            <h2 id="accounts-title" className={CARD_TITLE}>
              Accounts
            </h2>
            {data === null ? null : <Badge tone="muted">{plural(data.accounts.length, 'account', 'accounts')}</Badge>}
          </div>
          {making ? null : (
            <Button ref={newAccount} type="button" variant="primary" onClick={() => setMaking(true)}>
              New account
            </Button>
          )}
        </div>
        {making ? (
          <form aria-label="New account" className="flex flex-wrap items-end gap-3 border-t border-border px-5 py-4" onSubmit={make}>
            <Field id="account-name" label="Name">
              {/* Opened by New account, which is gone with it: focus comes here. */}
              <Input
                id="account-name"
                autoComplete="off"
                autoCapitalize="none"
                autoFocus
                aria-describedby="account-name-help"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field id="account-role" label="Role">
              <Select id="account-role" value={role} onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'viewer')}>
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
            <Button type="submit" variant="primary" disabled={sending !== null}>
              {sending === 'make' ? 'Making' : 'Make the account'}
            </Button>
            <Button
              type="button"
              onClick={() => {
                closeForm();
                setAlert(null);
                focusNext.current = () => newAccount.current;
              }}
            >
              Cancel
            </Button>
            <p id="account-name-help" className="w-full text-[13px] text-muted">
              {HELP}
            </p>
          </form>
        ) : null}
        {shown === null ? null : (
          <div role="status" className="flex flex-col gap-2 border-t border-border bg-subtle px-5 py-4">
            <strong className="text-sm">{`One-time password for ${shown.name}`}</strong>
            <code className="font-mono text-[15px]">{shown.password}</code>
            <p className="text-[13px] text-muted">
              {`Shown once. ${shown.name} signs in with it once, then chooses a password. It expires ${utc(shown.expiresAt)}.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void copy(shown.password)}>
                {shown.copy === 'copied' ? 'Copied' : 'Copy'}
              </Button>
              <Button type="button" onClick={() => done(shown.from)}>
                Done
              </Button>
            </div>
            {shown.copy === 'refused' ? <p className="text-[13px] text-bad">{REFUSED_COPY}</p> : null}
          </div>
        )}
        {alert === null ? null : (
          <p role="alert" className="border-t border-border px-5 py-3 text-sm text-bad">
            {alert}
          </p>
        )}
        {data === null ? (
          read.failed ? (
            <div className="flex flex-wrap items-center gap-3 px-5 py-3">
              <p className="text-sm text-muted">The accounts could not be read.</p>
              <Button
                type="button"
                onClick={() => {
                  setRead({ data: null, failed: false });
                  readAgain();
                }}
              >
                Try again
              </Button>
            </div>
          ) : (
            <p className="px-5 py-3 text-sm text-muted">Reading the accounts.</p>
          )
        ) : (
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
                {data.accounts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={COLUMNS.length} className="text-muted">
                      No account yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  data.accounts.map((account) => (
                    <AccountLine
                      key={account.id}
                      account={account}
                      now={data.now}
                      asking={asking === account.id}
                      sending={sending !== null}
                      change={changesOf(account)}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </>
  );
}
