// The Change password page of a password account (the password design 4.3 and 4.7; call 25): the current password and the new
// one twice. A change ends the account's other sessions and keeps this one. The passwords live in the fields only, emptied once
// the service answered or a check refused them; none is written anywhere else.
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { RequestFailed } from '../api.ts';
import { PageHeader } from '../components/layout.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { Input } from '../components/ui/input.tsx';
import { useApp } from '../context.tsx';

const LENGTH = 'A password has 12 to 128 characters.';
// What each refusal of the change says, by its code.
const REFUSALS: Readonly<Record<string, string>> = {
  wrong_password: 'The current password is wrong, or the account is waiting after five wrong tries (15 minutes).',
  password_length: LENGTH,
};
const NOT_THE_SAME = 'The two passwords are not the same.';
const BUSY = 'The service is busy. Try again in a moment.';
const UNREACHABLE = 'The service could not be reached. Try again in a moment.';
const FAILED = 'The password could not be changed.';
const CHANGED = 'Your password is changed. Your other sessions have ended.';
// An empty current password is not sent: the service would count it as a wrong try toward the wait.
const MISSING = 'Write your current password.';

/** What a refusal says: its code's sentence (the object's own key only), else a busy service, one not reached, or a failure. */
function refusalOf(error: unknown): string {
  if (!(error instanceof RequestFailed)) return FAILED;
  if (Object.hasOwn(REFUSALS, error.code)) return REFUSALS[error.code] ?? FAILED;
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

/** The page, for a signed-in password account (the app shows a GitHub one the not-found page here). */
export function PasswordPage() {
  const { api, me } = useApp();
  const [current, setCurrent] = useState('');
  const [chosen, setChosen] = useState('');
  const [again, setAgain] = useState('');
  const [sending, setSending] = useState(false);
  // One line at a time: the change made, or why it was not.
  const [said, setSaid] = useState<{ changed: boolean; text: string } | null>(null);

  /** The three fields emptied and the line said; the form can be sent again. */
  function answered(changed: boolean, text: string): void {
    setSaid({ changed, text });
    setCurrent('');
    setChosen('');
    setAgain('');
    setSending(false);
  }

  async function change(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (sending) return;
    // Before sending: the current password written, the two the same, then the length.
    if (current === '') return answered(false, MISSING);
    if (chosen !== again) return answered(false, NOT_THE_SAME);
    if (!lengthOk(chosen)) return answered(false, LENGTH);
    setSending(true);
    setSaid(null);
    try {
      await api.changePassword(me.csrf, current, chosen);
      answered(true, CHANGED);
    } catch (failure) {
      // A 401 has signed the person out already (the app's watched API); the page is gone with it.
      answered(false, refusalOf(failure));
    }
  }

  return (
    <>
      <PageHeader title="Change password" sub="Your other sessions end when it changes." />
      <Card className="flex max-w-[480px] flex-col gap-3 p-6">
        {said === null ? null : said.changed ? (
          <p role="status" className="text-sm text-ok">
            {said.text}
          </p>
        ) : (
          <p role="alert" className="text-sm text-bad">
            {said.text}
          </p>
        )}
        <form aria-label="Change password" className="flex flex-col gap-3" onSubmit={change}>
          <Field id="password-current" label="Current password">
            <Input
              id="password-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </Field>
          <Field id="password-new" label="New password">
            <Input id="password-new" type="password" autoComplete="new-password" value={chosen} onChange={(event) => setChosen(event.target.value)} />
          </Field>
          <Field id="password-again" label="New password again">
            <Input id="password-again" type="password" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} />
          </Field>
          <Button type="submit" variant="primary" className="self-start" disabled={sending}>
            {sending ? 'Changing' : 'Change password'}
          </Button>
        </form>
      </Card>
    </>
  );
}
