// The application (Task 10, rules 3, 4 and 8): who is signed in is read once; signed out, the sign-in page; signed in, the
// layout around the page of the path. Any read answered 401 shows the sign-in page.
import { useEffect, useMemo, useState } from 'react';
import { RequestFailed } from './api.ts';
import type { Api } from './api.ts';
import type { Me } from './api-types.ts';
import { Layout, REVIEW_PATH } from './components/layout.tsx';
import { Button } from './components/ui/button.tsx';
import { ActivityPage } from './pages/activity.tsx';
import { Later } from './pages/later.tsx';
import { NotFound } from './pages/not-found.tsx';
import { SignIn } from './pages/sign-in.tsx';
import { navigate, useLocation } from './router.tsx';

type State = { kind: 'reading' } | { kind: 'signed_out' } | { kind: 'unreachable' } | { kind: 'signed_in'; me: Me };

const isSignedOut = (error: unknown): boolean => error instanceof RequestFailed && error.status === 401;

/** Signed in, the sign-in page's address leads to the overview, in its place in the history. */
function ToOverview() {
  useEffect(() => {
    navigate('/ui/', true);
  }, []);
  return null;
}

function Page({ path }: { path: string }) {
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
      return <Later title="Settings" />;
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

  // The API the pages read: one of its reads answered 401 signs the person out here.
  const watched = useMemo<Api>(() => {
    const watch = <T,>(read: Promise<T>): Promise<T> =>
      read.catch((error: unknown) => {
        if (isSignedOut(error)) setState({ kind: 'signed_out' });
        throw error;
      });
    return {
      me: () => watch(api.me()),
      activity: () => watch(api.activity()),
      reviews: (query) => watch(api.reviews(query)),
      signOut: (csrf) => watch(api.signOut(csrf)),
    };
  }, [api]);

  if (state.kind === 'reading') return <div aria-busy="true"></div>;
  if (state.kind === 'signed_out') return <SignIn error={path === '/ui/signin' ? new URLSearchParams(search).get('error') : null} />;
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
      <Page path={path} />
    </Layout>
  );
}
