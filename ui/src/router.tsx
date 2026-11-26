// A small router over the page's own history: the path and the query of the address, a way to change it, and a link that
// changes it without loading the page again (the service answers index.html for every path under /ui/, call 17).
import { useSyncExternalStore } from 'react';
import type { MouseEvent, ReactNode } from 'react';

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

/** The address as one string, so that an unchanged address is the same snapshot. */
const address = (): string => window.location.pathname + window.location.search;

export function useLocation(): { path: string; search: string } {
  const href = useSyncExternalStore(subscribe, address);
  // A path holds no `?`: the first one starts the query.
  const mark = href.indexOf('?');
  return mark < 0 ? { path: href, search: '' } : { path: href.slice(0, mark), search: href.slice(mark) };
}

/** An address of this application: `/ui`, or one under `/ui/` that is still there once its dot segments are read. */
function inUi(to: string): boolean {
  if (to !== '/ui' && !to.startsWith('/ui/')) return false;
  const { pathname } = new URL(to, window.location.href);
  return pathname === '/ui' || pathname.startsWith('/ui/');
}

/**
 * Goes to `to` on this origin; the address the page is at already, or `replace`, takes no new entry in the history. An address
 * outside the application changes nothing.
 */
export function navigate(to: string, replace = false): void {
  if (!inUi(to)) return;
  if (replace || to === address()) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  for (const listener of [...listeners]) listener();
}

/**
 * A plain click on an address of the application goes to `to` in the page; a click with a modifier, another button, or an
 * address anywhere else is the browser's.
 */
export function Link({ to, className, children, 'aria-current': current }: {
  to: string; className?: string; children: ReactNode; 'aria-current'?: 'page';
}) {
  function clicked(event: MouseEvent<HTMLAnchorElement>): void {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!inUi(to)) return;
    event.preventDefault();
    navigate(to);
  }
  return (
    <a href={to} className={className} aria-current={current} onClick={clicked}>
      {children}
    </a>
  );
}
