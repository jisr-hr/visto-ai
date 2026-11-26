// The sign-in page (the password design 4.3 and 4.7; calls 13, 15 and 25): a name and a password; a right one-time password
// turns the card into the choice of a password, sent with it again to sign in; GitHub's way in below, only while the service
// says GitHub sign-in is on. The one-time password lives in this page's memory only, with the name it was given for, until it
// is chosen over, Cancel forgets it, or the service says it can no longer work; no password, one-time password or name is
// written anywhere else.
import { Fragment, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { RequestFailed } from '../api.ts';
import type { Api } from '../api.ts';
import { Brand } from '../components/layout.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Input } from '../components/ui/input.tsx';

// What each `error` the way back (src/ui/auth.ts) sends to /ui/signin says; any other code is a failed sign-in.
const REASONS: Readonly<Record<string, string>> = {
  denied: 'GitHub did not give access. Sign in again to try once more.',
  not_allowed: 'This GitHub account may not open this page.',
  unverified: 'The team membership could not be read, so the sign-in was refused.',
  state: 'The sign-in took too long or was started in another window. Sign in again.',
  github: 'GitHub could not be reached. Sign in again in a moment.',
  full: 'This deployment keeps 1,000 accounts at most. An admin can remove one.',
};
const LENGTH = 'A password has 12 to 128 characters.';
// What each refusal of a password sign-in or a first password says, by its code (call 15).
const REFUSALS: Readonly<Record<string, string>> = {
  refused: 'The name or the password is wrong. After five wrong tries in a row, an account waits 15 minutes.',
  expired: 'This one-time password has expired. Ask an admin for a new one.',
  already_chosen: 'This account has its own password already. Sign in with it.',
  password_length: LENGTH,
  same_password: 'Choose a password other than the one-time password.',
};
const NOT_THE_SAME = 'The two passwords are not the same.';
const BUSY = 'The service is busy. Try again in a moment.';
const UNREACHABLE = 'The service could not be reached. Try again in a moment.';
const FAILED = 'The sign-in failed.';
// The refusals of the choice after which its one-time password can no longer work: the page goes back to the first step, as
// Cancel does, so that it is never sent again (each wrong try counts, and five make the account wait).
const DEAD: ReadonlySet<string> = new Set(['refused', 'expired', 'already_chosen']);
const HEADING = 'm-0 text-2xl font-semibold tracking-[-0.01em]';

/** A text of `texts`, read as the object's own key only (a code such as `__proto__` is any other); else a failed sign-in. */
const textOf = (texts: Readonly<Record<string, string>>, code: string): string => (Object.hasOwn(texts, code) ? texts[code] ?? FAILED : FAILED);

/** What a refusal of a request says: its code's sentence, else a busy service, one not reached, or a failed sign-in. */
function refusalOf(error: unknown): string {
  if (!(error instanceof RequestFailed)) return FAILED;
  if (Object.hasOwn(REFUSALS, error.code)) return textOf(REFUSALS, error.code);
  if (error.status === 503) return BUSY;
  if (error.status === 0) return UNREACHABLE;
  return FAILED;
}

/** A new password's length as the service counts it: 12 to 128 code points. */
function lengthOk(password: string): boolean {
  const length = [...password].length;
  return length >= 12 && length <= 128;
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
 * The page of a person not signed in; `error` is the reason GitHub's sign-in was sent back with, none when null or empty, shown
 * until the page has something of its own to say. `onSignedIn` is called once a sign-in made a session.
 */
export function SignIn({ api, error, onSignedIn }: { api: Api; error: string | null; onSignedIn: () => void }) {
  const [github, setGithub] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  // The choice of a password: the name and the one-time password the first step sent, kept together; null on the first step.
  const [choice, setChoice] = useState<{ name: string; oneTimePassword: string } | null>(null);
  const [chosen, setChosen] = useState('');
  const [again, setAgain] = useState('');
  const [sending, setSending] = useState(false);
  // What the page said last, which replaces the reason GitHub sent back; null until it says anything.
  const [said, setSaid] = useState<{ text: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    // Anything but a yes, and a failure, leave GitHub's way out.
    api.ways().then((ways) => {
      if (live && ways.github === true) setGithub(true);
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);

  /** A refusal: its sentence, the name kept, the password fields emptied. */
  function refuse(text: string): void {
    setSaid({ text });
    setPassword('');
    setChosen('');
    setAgain('');
    setSending(false);
  }

  async function signIn(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (sending) return;
    const typed = { name, password };
    setSending(true);
    setSaid({ text: null });
    try {
      const answer = await api.passwordSignIn(typed.name, typed.password);
      // Signed in, the page stays as it is until the app reads who is signed in.
      if (answer.next === 'signed_in') return onSignedIn();
      if (answer.next !== 'choose_password') return refuse(FAILED);
      setChoice({ name: typed.name, oneTimePassword: typed.password });
      setPassword('');
      setChosen('');
      setAgain('');
      setSending(false);
    } catch (failure) {
      refuse(refusalOf(failure));
    }
  }

  async function choose(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (sending || choice === null) return;
    // Before sending: the two the same, then the length.
    if (chosen !== again) return refuse(NOT_THE_SAME);
    if (!lengthOk(chosen)) return refuse(LENGTH);
    setSending(true);
    setSaid({ text: null });
    try {
      const answer = await api.firstPassword(choice.name, choice.oneTimePassword, chosen);
      if (answer.next === 'signed_in') return onSignedIn();
      refuse(FAILED);
    } catch (failure) {
      if (failure instanceof RequestFailed && DEAD.has(failure.code)) return back(refusalOf(failure));
      refuse(refusalOf(failure));
    }
  }

  /** Back to the first step, saying `text` (nothing when null): the one-time password is forgotten, the name kept. */
  function back(text: string | null): void {
    setChoice(null);
    setPassword('');
    setChosen('');
    setAgain('');
    setSaid({ text });
    setSending(false);
  }

  const alert = said === null ? (error ? textOf(REASONS, error) : null) : said.text;
  const alertLine = alert ? (
    <p role="alert" className="text-sm text-bad">
      {alert}
    </p>
  ) : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 font-sans text-text">
      <Card className="flex w-full max-w-[400px] flex-col gap-4 p-8">
        <Brand />
        {/* Each step its own, by its key: no field of one is reused as a field of the other. */}
        {choice === null ? (
          <Fragment key="password">
            <h1 className={HEADING}>Sign in</h1>
            <p className="text-sm text-muted">Sign in with your name and password.</p>
            {alertLine}
            <form aria-label="Sign in with a password" className="flex flex-col gap-3" onSubmit={signIn}>
              <Field id="signin-name" label="Name">
                <Input
                  id="signin-name"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={sending}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field id="signin-password" label="Password">
                <Input
                  id="signin-password"
                  type="password"
                  autoComplete="current-password"
                  disabled={sending}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              <Button type="submit" variant="primary" className="self-start" disabled={sending}>
                {sending ? 'Signing in' : 'Sign in'}
              </Button>
            </form>
            {github ? (
              <>
                <p className="text-sm text-muted">Or with the GitHub account this deployment lets in:</p>
                <Button asChild className="self-start">
                  <a href="/api/auth/start">Sign in with GitHub</a>
                </Button>
              </>
            ) : null}
          </Fragment>
        ) : (
          <Fragment key="choose">
            <h1 className={HEADING}>Choose your password</h1>
            <p className="text-sm text-muted">This was a one-time password. Choose the password you will sign in with: 12 to 128 characters.</p>
            {alertLine}
            <form aria-label="Choose your password" className="flex flex-col gap-3" onSubmit={choose}>
              {/* The name the new password is for, so a password manager keeps it under that name: hidden, also from assistive
                  technology, never tabbed to. */}
              <input type="text" className="sr-only" aria-hidden="true" autoComplete="username" readOnly tabIndex={-1} value={choice.name} />
              <Field id="signin-new" label="New password">
                <Input
                  id="signin-new"
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  disabled={sending}
                  value={chosen}
                  onChange={(event) => setChosen(event.target.value)}
                />
              </Field>
              <Field id="signin-again" label="New password again">
                <Input
                  id="signin-again"
                  type="password"
                  autoComplete="new-password"
                  disabled={sending}
                  value={again}
                  onChange={(event) => setAgain(event.target.value)}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" disabled={sending}>
                  {sending ? 'Signing in' : 'Choose and sign in'}
                </Button>
                <Button type="button" disabled={sending} onClick={() => back(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          </Fragment>
        )}
      </Card>
    </div>
  );
}
