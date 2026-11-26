// The application (Task 10, rules 3, 4 and 8; the password design 4.7): who is signed in is read once; signed out, the sign-in
// page, which reads it again once a sign-in made a session; signed in, the layout around the page of the path. Any read of the
// pages answered 401 shows the sign-in page; one answered 403 forbidden reads who is signed in again, the page kept on screen,
// so a role changed meanwhile shows at the next request to an admin route (call 25).
import { useEffect, useMemo, useRef, useState } from 'react';
import { RequestFailed } from './api.ts';
import type { Api } from './api.ts';
import type { Me } from './api-types.ts';
import { Layout, REVIEW_PATH } from './components/layout.tsx';
import { Button } from './components/ui/button.tsx';
import { ActivityPage } from './pages/activity.tsx';
import { Later } from './pages/later.tsx';
import { NotFound } from './pages/not-found.tsx';
import { PasswordPage } from './pages/password.tsx';
import { SignIn } from './pages/sign-in.tsx';
import { navigate, useLocation } from './router.tsx';

type State = { kind: 'reading' } | { kind: 'signed_out' } | { kind: 'unreachable' } | { kind: 'signed_in'; me: Me };

const isSignedOut = (error: unknown): boolean => error instanceof RequestFailed && error.status === 401;
/** The API's refusal of a role (call 20): the role the page knew may have changed. */
const isForbidden = (error: unknown): boolean => error instanceof RequestFailed && error.status === 403 && error.code === 'forbidden';

/** Signed in, the sign-in page's address leads to the overview, in its place in the history. */
function ToOverview() {
  useEffect(() => {
    navigate('/ui/', true);
  }, []);
  return null;
}

/** The page of the path; Settings is an admin's, Change password a password account's, and the not-found page to anyone else. */
function Page({ path, me }: { path: string; me: Me }) {
  switch (path) {
    case '/ui/':
      return <Later title="Overview" />;
    case '/ui/activity':
      return <ActivityPage />;
    case '/ui/repositories':
      return <Later title="Repositories" />;
    case '/ui/memory':
      return <Later title="Memory" />;
    case '/ui/settings':
      return me.role === 'admin' ? <Later title="Settings" /> : <NotFound />;
    case '/ui/password':
      return me.kind === 'password' ? <PasswordPage /> : <NotFound />;
    case '/ui/signin':
      return <ToOverview />;
    default:
      return REVIEW_PATH.test(path) ? <Later title="Review" /> : <NotFound />;
  }
}

export function App({ api }: { api: Api }) {
  const [state, setState] = useState<State>({ kind: 'reading' });
  const [tries, setTries] = useState(0);
  const { path, search } = useLocation();

  useEffect(() => {
    let live = true;
    api.me().then(
      (me) => {
        if (live) setState({ kind: 'signed_in', me });
      },
      (error: unknown) => {
        if (live) setState({ kind: isSignedOut(error) ? 'signed_out' : 'unreachable' });
      },
    );
    return () => {
      live = false;
    };
  }, [api, tries]);

  // The session signed in at the last render, by its token for changes: a read again belongs to the one that asked it.
  const session = useRef<string | null>(null);
  session.current = state.kind === 'signed_in' ? state.me.csrf : null;

  // The API the pages read: one of its reads answered 401 signs the person out here; one answered 403 forbidden reads who is
  // signed in again.
  const watched = useMemo<Api>(() => {
    /**
     * Who is signed in, read again with the raw API (so a refusal of this read reads nothing again) while the page stays: its
     * answer replaces who was signed in and a 401 signs out, each only while the session that asked is still the one signed in
     * (a sign-out and another person's sign-in meanwhile leave that person as they are); any other failure keeps who was.
     */
    const readAgain = (): void => {
      const asked = session.current;
      const still = (last: State): boolean => last.kind === 'signed_in' && last.me.csrf === asked;
      api.me().then(
        (me) => setState((last) => (still(last) ? { kind: 'signed_in', me } : last)),
        (error: unknown) => {
          if (isSignedOut(error)) setState((last) => (still(last) ? { kind: 'signed_out' } : last));
        },
      );
    };
    const watch = <T,>(read: Promise<T>): Promise<T> =>
      read.catch((error: unknown) => {
        if (isSignedOut(error)) setState({ kind: 'signed_out' });
        else if (isForbidden(error)) readAgain();
        throw error;
      });
    return {
      me: () => watch(api.me()),
      activity: () => watch(api.activity()),
      reviews: (query) => watch(api.reviews(query)),
      signOut: (csrf) => watch(api.signOut(csrf)),
      ways: () => watch(api.ways()),
      passwordSignIn: (name, password) => watch(api.passwordSignIn(name, password)),
      firstPassword: (name, oneTimePassword, password) => watch(api.firstPassword(name, oneTimePassword, password)),
      changePassword: (csrf, current, password) => watch(api.changePassword(csrf, current, password)),
      accounts: () => watch(api.accounts()),
      makeAccount: (csrf, name, role) => watch(api.makeAccount(csrf, name, role)),
      setRole: (csrf, id, role) => watch(api.setRole(csrf, id, role)),
      resetPassword: (csrf, id) => watch(api.resetPassword(csrf, id)),
      removeAccount: (csrf, id) => watch(api.removeAccount(csrf, id)),
    };
  }, [api]);

  if (state.kind === 'reading') return <div aria-busy="true"></div>;
  if (state.kind === 'signed_out') {
    // The raw API: a sign-in answered 401 is a refusal said on the page, not a sign-out.
    return (
      <SignIn
        api={api}
        error={path === '/ui/signin' ? new URLSearchParams(search).get('error') : null}
        onSignedIn={() => {
          setState({ kind: 'reading' });
          setTries((n) => n + 1);
        }}
      />
    );
  }
  if (state.kind === 'unreachable') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg px-4 font-sans text-text">
        <p className="text-sm">Could not reach the service.</p>
        <Button
          type="button"
          onClick={() => {
            setState({ kind: 'reading' });
            setTries((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  return (
    <Layout api={watched} me={state.me} onSignedOut={() => setState({ kind: 'signed_out' })}>
      <Page path={path} me={state.me} />
    </Layout>
  );
}
