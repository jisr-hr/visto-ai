import { expect, test, vi } from 'vitest';
import { applyTheme, chooseTheme, currentTheme, followSystem, storedTheme } from './theme.ts';

type Changed = (event: { matches: boolean }) => void;

/** A system that prefers the given theme, with the listeners the page added to it. */
function system(dark: boolean) {
  const listeners: Changed[] = [];
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (media: string) =>
      ({
        media,
        matches: dark,
        addEventListener: (_: string, listener: Changed) => listeners.push(listener),
        removeEventListener: (_: string, listener: Changed) => listeners.splice(listeners.indexOf(listener), 1),
      }) as unknown as MediaQueryList,
  );
  return {
    listeners,
    turn(next: boolean) {
      dark = next;
      for (const listener of [...listeners]) listener({ matches: next });
    },
  };
}

/**
 * The text of index.css as written. Not `import './index.css?raw'`: while the tests do not process CSS (vitest's default),
 * vitest gives every stylesheet, `?raw` too, as an empty string. Node's own fs is reached through the worker's process.
 */
function stylesheet(): string {
  const { process } = globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(path: string, encoding: 'utf8'): string } };
  };
  // A path beside this file's, from its own URL: Vite rewrites `new URL('./x', import.meta.url)` to the address it serves.
  const here = decodeURIComponent(new URL(import.meta.url).pathname);
  return process.getBuiltinModule('node:fs').readFileSync(here.slice(0, here.lastIndexOf('/') + 1) + 'index.css', 'utf8');
}

/** The text of a file of this package, given by its path from the folder of this file, read as the stylesheet is. */
function packageFile(path: string): string {
  const { process } = globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(path: string, encoding: 'utf8'): string } };
  };
  const here = decodeURIComponent(new URL(import.meta.url).pathname);
  return process.getBuiltinModule('node:fs').readFileSync(here.slice(0, here.lastIndexOf('/') + 1) + path, 'utf8');
}
/** Runs public/theme.js as the page's head runs it, before any module. */
const runThemeScript = (): void => {
  new Function(packageFile('../public/theme.js'))();
};

/** The text inside the first block that opens after `from`. */
function blockAt(text: string, from: number): string {
  const open = text.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') depth -= 1;
    if (depth === 0) return text.slice(open + 1, i);
  }
  return '';
}
const declarations = (block: string): string[] =>
  block.split(';').map((line) => line.trim()).filter((line) => line.startsWith('--'));

test('the stored choice wins, else the system, and a storage that throws reads as none', () => {
  localStorage.setItem('visto-theme', 'dark');
  expect(storedTheme()).toBe('dark');
  expect(currentTheme()).toBe('dark');
  localStorage.setItem('visto-theme', 'light');
  system(true);
  expect(currentTheme()).toBe('light');

  localStorage.clear();
  expect(storedTheme()).toBeNull();
  expect(currentTheme()).toBe('dark');
  localStorage.setItem('visto-theme', 'purple');
  expect(storedTheme()).toBeNull();
  expect(currentTheme()).toBe('dark');

  localStorage.setItem('visto-theme', 'light');
  vi.spyOn(window.Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('The storage is refused.');
  });
  expect(storedTheme()).toBeNull();
  expect(currentTheme()).toBe('dark');

  applyTheme('dark');
  expect(document.documentElement.className).toBe('dark');
  applyTheme('light');
  expect(document.documentElement.className).toBe('light');
  applyTheme('light');
  expect(document.documentElement.className).toBe('light');
});

test('a choice is stored and applied, and applied still when the storage refuses it', () => {
  chooseTheme('dark');
  expect(localStorage.getItem('visto-theme')).toBe('dark');
  expect(document.documentElement.className).toBe('dark');

  vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('The storage is full.');
  });
  chooseTheme('light');
  expect(document.documentElement.className).toBe('light');
});

test('while no choice is stored the page follows the system as it changes, and a choice stops that', () => {
  const media = system(false);
  applyTheme(currentTheme());
  const stop = followSystem();
  expect(document.documentElement.className).toBe('light');
  media.turn(true);
  expect(document.documentElement.className).toBe('dark');
  media.turn(false);
  expect(document.documentElement.className).toBe('light');

  chooseTheme('dark');
  media.turn(false);
  expect(document.documentElement.className).toBe('dark');

  stop();
  expect(media.listeners).toEqual([]);
});

test('the head\'s theme script applies a stored choice before the page paints, only its own class, and a storage that throws changes nothing', () => {
  system(true);
  document.documentElement.className = 'dark';
  localStorage.setItem('visto-theme', 'light');
  runThemeScript();
  expect(document.documentElement.className).toBe('light');
  localStorage.setItem('visto-theme', 'dark');
  runThemeScript();
  expect(document.documentElement.className).toBe('dark');

  // No choice, or one it does not know: the page keeps what it has, and the CSS follows the system.
  for (const stored of [null, 'purple']) {
    document.documentElement.className = '';
    if (stored === null) localStorage.removeItem('visto-theme');
    else localStorage.setItem('visto-theme', stored);
    runThemeScript();
    expect(document.documentElement.className).toBe('');
  }

  localStorage.setItem('visto-theme', 'dark');
  vi.spyOn(window.Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('The storage is refused.');
  });
  expect(runThemeScript).not.toThrow();
  expect(document.documentElement.className).toBe('');
});

test('the page loads the theme script in its head, before the module, and holds no inline script or style', () => {
  const page = packageFile('../index.html');
  const head = page.slice(page.indexOf('<head>'), page.indexOf('</head>'));
  expect(head).toContain('<script src="/ui/theme.js"></script>');
  expect(page.indexOf('<script src="/ui/theme.js"></script>')).toBeLessThan(page.indexOf('<script type="module"'));
  expect(page.match(/<script\b[^>]*>/g)).toEqual(['<script src="/ui/theme.js">', '<script type="module" src="/src/main.tsx">']);
  expect(page).not.toMatch(/<style\b|\sstyle=/);
});

test("the page's start applies the theme stored, before the first render", async () => {
  localStorage.setItem('visto-theme', 'dark');
  await import('./main.tsx');
  expect(document.documentElement.className).toBe('dark');
});

test('before any script, the CSS follows the system', () => {
  const css = stylesheet();
  const media = css.indexOf('@media (prefers-color-scheme: dark)');
  expect(media).toBeGreaterThanOrEqual(0);
  const inMedia = blockAt(css, media);
  const notLight = inMedia.indexOf(':root:not(.light)');
  expect(notLight).toBeGreaterThanOrEqual(0);
  const followed = declarations(blockAt(inMedia, notLight));
  expect(followed).toContain('--bg: #0F1218');

  const dark = css.indexOf(':root.dark');
  expect(dark).toBeGreaterThanOrEqual(0);
  const chosen = declarations(blockAt(css, dark));
  expect(chosen).toContain('--bg: #0F1218');
  expect(chosen).toEqual(followed);
  expect(chosen).toHaveLength(19);
});
