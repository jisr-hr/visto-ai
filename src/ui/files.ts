// The built files of the UI, read once at start and served from memory (call 17).
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { UiAnswer } from '../shell/http.ts';
import { plain, redirect, SECURITY_HEADERS } from './headers.ts';

export interface UiFile { body: Buffer; type: string }
export type UiFiles = ReadonlyMap<string, UiFile>;   // by the path it is served at: '/ui/' + its path in the folder, with forward slashes

const TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.json', 'application/json'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
]);
const ASSETS = '/ui/assets/';
const INDEX = '/ui/index.html';
const YEAR = 'public, max-age=31536000, immutable';   // Vite's names under assets/ carry a hash

/**
 * Every file under `dir`, read whole. A folder that is not there, is no folder, or cannot be walked (a loop the walk fails on)
 * gives none. No link is followed: a link to a file is no file, and the walk, which goes through a link to a folder, finds files
 * whose real path is not their path in the folder (outside it, or back inside it through a loop); they are left out.
 */
export function loadUiFiles(dir: string): UiFiles {
  const files = new Map<string, UiFile>();
  let root: string;
  let entries: Dirent[];
  try {
    root = realpathSync(dir);
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const inFolder = relative(dir, full);
    let real: string;
    try {
      real = realpathSync(full);
    } catch {
      continue;
    }
    // Its real path is its path in the folder: inside the folder (a link out leads elsewhere), and reached through no link
    // (a loop's files are inside the folder too, but at another path).
    if (real !== join(root, inFolder)) continue;
    const served = '/ui/' + inFolder.split(sep).join('/');
    files.set(served, { body: readFileSync(full), type: TYPES.get(extname(entry.name)) ?? 'application/octet-stream' });
  }
  return files;
}

function served(file: UiFile, cache: string): UiAnswer {
  return { status: 200, headers: { 'content-type': file.type, 'cache-control': cache, ...SECURITY_HEADERS }, body: file.body };
}

/** The answer for `/ui` or a path under `/ui/`. The path is looked up as it came: never decoded, never joined to a folder. */
export function fileAnswer(files: UiFiles, method: string, path: string): UiAnswer {
  if (method !== 'GET') {
    const refused = plain(405, 'method_not_allowed');
    return { ...refused, headers: { ...refused.headers, allow: 'GET' } };
  }
  if (path === '/ui') return redirect('/ui/');
  const key = path === '/ui/' ? INDEX : path;
  const file = files.get(key);
  if (key.startsWith(ASSETS)) return file === undefined ? plain(404, 'not_found') : served(file, YEAR);
  if (file !== undefined) return served(file, 'no-store');
  const index = files.get(INDEX);
  return index === undefined ? plain(404, 'not_found') : served(index, 'no-store');
}
