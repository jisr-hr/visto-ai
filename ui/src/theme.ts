// The theme (call 18): the viewer's choice in local storage, else the system's, followed live while no choice is stored; the
// class dark or light on <html> switches the mockup's tokens (index.css). A storage that throws reads as no choice.
export type Theme = 'light' | 'dark';

const KEY = 'visto-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const listeners = new Set<() => void>();

export function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  try {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function currentTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

/** The theme the page shows: its class, or the system's while it has none (index.css follows the system then). */
export function shownTheme(): Theme {
  const classes = document.documentElement.classList;
  if (classes.contains('dark')) return 'dark';
  if (classes.contains('light')) return 'light';
  return systemTheme();
}

/** Called after each change of the class; gives the function that stops it. */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The class dark or light on <html>, never both. */
export function applyTheme(theme: Theme): void {
  const classes = document.documentElement.classList;
  classes.remove(theme === 'dark' ? 'light' : 'dark');
  classes.add(theme);
  for (const listener of [...listeners]) listener();
}

/** Stores the choice and applies it; a storage that refuses it still leaves the page in the theme chosen. */
export function chooseTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // Not stored: this page keeps it until it is left.
  }
  applyTheme(theme);
}

/** While no choice is stored, applies the system's theme each time it changes; gives the function that stops it. */
export function followSystem(): () => void {
  const changed = (event: { matches: boolean }): void => {
    if (storedTheme() === null) applyTheme(event.matches ? 'dark' : 'light');
  };
  let query: MediaQueryList;
  try {
    query = window.matchMedia(DARK_QUERY);
    query.addEventListener('change', changed);
  } catch {
    return () => {};
  }
  return () => query.removeEventListener('change', changed);
}
