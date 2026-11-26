// The layout of the approved mockups (Activity.dc.html, lines 48 to 73): the sidebar with the brand, the entries, the mode, who
// is signed in, the theme switch and sign-out (call 24), around the page in the main box (Task 10, rules 3 and 5 to 8).
import { useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { usePoll } from '../api.ts';
import type { Api } from '../api.ts';
import type { Me } from '../api-types.ts';
import { AppContext, reviewCounts } from '../context.tsx';
import type { AppContextValue } from '../context.tsx';
import { initials, plural } from '../format.ts';
import { Link, navigate, useLocation } from '../router.tsx';
import { chooseTheme, shownTheme, subscribeTheme } from '../theme.ts';
import { ActivityIcon, CheckIcon, MemoryIcon, MoonIcon, OverviewIcon, RepositoriesIcon, SettingsIcon, SignOutIcon } from './icons.tsx';
import { Badge } from './ui/badge.tsx';
import { Button } from './ui/button.tsx';

/** How often the layout reads the activity (call 23). */
export const ACTIVITY_MS = 5000;
/** The address of one review's page. */
export const REVIEW_PATH = /^\/ui\/reviews\/\d+$/;

// Each entry's classes, whole: the one on loses the muted colour and the hover of the others.
const ENTRY_OFF = 'flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted no-underline hover:bg-subtle hover:text-text';
const ENTRY_ON =
  'flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium no-underline bg-accent-soft text-accent-text hover:bg-accent-soft hover:text-accent-text';
// The card's classes without its shadow: cn keeps shadow-card beside shadow-none, so the mode card is not a Card.
const MODE_CARD = 'flex flex-col gap-1.5 rounded-[12px] border border-border bg-card p-3 shadow-none';

const ENTRIES: readonly { name: string; to: string; icon: ReactNode; on: (path: string) => boolean }[] = [
  { name: 'Overview', to: '/ui/', icon: <OverviewIcon />, on: (path) => path === '/ui/' },
  { name: 'Activity', to: '/ui/activity', icon: <ActivityIcon />, on: (path) => path === '/ui/activity' || REVIEW_PATH.test(path) },
  { name: 'Repositories', to: '/ui/repositories', icon: <RepositoriesIcon />, on: (path) => path === '/ui/repositories' },
  { name: 'Memory', to: '/ui/memory', icon: <MemoryIcon />, on: (path) => path === '/ui/memory' },
  { name: 'Settings', to: '/ui/settings', icon: <SettingsIcon />, on: (path) => path === '/ui/settings' },
];

export function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-1.5">
      <div className="flex size-8 items-center justify-center rounded-[9px] bg-accent text-on-accent">
        <CheckIcon />
      </div>
      <div className="flex flex-col">
        <strong className="text-[15px]">Visto AI</strong>
        <span className="text-xs text-muted">Review service</span>
      </div>
    </div>
  );
}

/** A page's header: its heading, a sub-line, and what the page puts on the right. */
export function PageHeader({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="m-0 text-2xl font-semibold tracking-[-0.01em]">{title}</h1>
        {sub === undefined ? null : <p className="mt-1 mb-0 text-sm text-muted">{sub}</p>}
      </div>
      {children}
    </header>
  );
}

function Mode({ me }: { me: Me }) {
  if (me.mode === 'live') {
    return (
      <div data-slot="card" className={MODE_CARD}>
        <Badge tone="ok" dot className="self-start">
          Live
        </Badge>
        <span className="text-xs text-muted">{`Posting reviews on ${plural(me.repositories.length, 'repository', 'repositories')}. Dry run is off.`}</span>
      </div>
    );
  }
  return (
    <div data-slot="card" className={MODE_CARD}>
      <Badge tone="warn" dot className="self-start">
        Dry run
      </Badge>
      <span className="text-xs text-muted">Reviews are recorded, nothing is posted.</span>
    </div>
  );
}

/**
 * The frame of a signed-in person. It reads the activity every 5 seconds (not while the page is hidden) and puts it, with the
 * API and who is signed in, in the app's context. Signing out sends the token for changes; a failure leaves the person here.
 */
export function Layout({ api, me, onSignedOut, children }: { api: Api; me: Me; onSignedOut: () => void; children: ReactNode }) {
  const { path } = useLocation();
  const polled = usePoll(() => api.activity(), ACTIVITY_MS, 'activity');
  const value = useMemo<AppContextValue>(
    () => ({ api, me, activity: polled.data, activityFailed: polled.failed }),
    [api, me, polled.data, polled.failed],
  );
  const running = polled.data === null ? 0 : reviewCounts(polled.data.jobs).running;
  const theme = useSyncExternalStore(subscribeTheme, shownTheme);

  function signOut(): void {
    api.signOut(me.csrf).then(
      () => {
        navigate('/ui/signin');
        onSignedOut();
      },
      () => {
        // Still signed in: the layout stays.
      },
    );
  }

  return (
    <AppContext.Provider value={value}>
      <div className="flex min-h-screen flex-wrap bg-bg font-sans text-text">
        <aside className="flex max-w-full shrink grow basis-[232px] flex-col gap-6 border-r border-border bg-card px-3.5 py-5">
          <Brand />
          <nav aria-label="Main" className="flex flex-col gap-0.5">
            {ENTRIES.map((entry) => {
              const on = entry.on(path);
              return (
                <Link key={entry.to} to={entry.to} className={on ? ENTRY_ON : ENTRY_OFF} aria-current={on ? 'page' : undefined}>
                  {entry.icon}
                  {entry.name}
                  {entry.name === 'Activity' && running > 0 ? (
                    <Badge tone="accent" className="ml-auto">
                      {running}
                    </Badge>
                  ) : null}
                </Link>
              );
            })}
          </nav>
          <div className="mt-auto flex flex-col gap-3">
            <Mode me={me} />
            <div className="flex items-center gap-2.5 px-1.5">
              <div aria-hidden="true" className="flex size-[30px] items-center justify-center rounded-full bg-subtle text-xs font-semibold">
                {initials(me.name)}
              </div>
              <div className="flex min-w-0 flex-col">
                <span className="text-[13px] font-medium">{me.name}</span>
                <span className="text-xs text-muted">Signed in with GitHub</span>
              </div>
              <Button
                type="button"
                size="icon"
                className="ml-auto"
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                onClick={() => chooseTheme(theme === 'dark' ? 'light' : 'dark')}
              >
                <MoonIcon />
              </Button>
              <Button type="button" size="icon" aria-label="Sign out" onClick={signOut}>
                <SignOutIcon />
              </Button>
            </div>
          </div>
        </aside>
        <main className="flex min-w-0 shrink grow-[999] basis-[560px] flex-col gap-6 px-8 pb-12 pt-7">{children}</main>
      </div>
    </AppContext.Provider>
  );
}
