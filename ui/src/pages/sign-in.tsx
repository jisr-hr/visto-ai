import { Brand } from '../components/layout.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';

// What each `error` the way back (src/ui/auth.ts) sends to /ui/signin says; any other code is a failed sign-in.
const REASONS: Readonly<Record<string, string>> = {
  denied: 'GitHub did not give access. Sign in again to try once more.',
  not_allowed: 'This GitHub account may not open this page.',
  unverified: 'The team membership could not be read, so the sign-in was refused.',
  state: 'The sign-in took too long or was started in another window. Sign in again.',
  github: 'GitHub could not be reached. Sign in again in a moment.',
};
const FAILED = 'The sign-in failed.';

/** The reason's own text, read as the object's own key only (a code such as `__proto__` is any other). */
const reasonOf = (error: string): string => (Object.hasOwn(REASONS, error) ? REASONS[error] ?? FAILED : FAILED);

/** The page of a person not signed in; `error` is the reason the sign-in was sent back with, none when null or empty. */
export function SignIn({ error }: { error: string | null }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 font-sans text-text">
      <Card className="flex w-full max-w-[400px] flex-col gap-4 p-8">
        <Brand />
        <h1 className="m-0 text-2xl font-semibold tracking-[-0.01em]">Sign in</h1>
        <p className="text-sm text-muted">Sign in with the GitHub account this deployment lets in.</p>
        {error ? (
          <p role="alert" className="text-sm text-bad">
            {reasonOf(error)}
          </p>
        ) : null}
        <Button asChild variant="primary" className="self-start">
          <a href="/api/auth/start">Sign in with GitHub</a>
        </Button>
      </Card>
    </div>
  );
}
