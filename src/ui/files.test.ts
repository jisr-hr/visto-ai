import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileAnswer, loadUiFiles } from './files.ts';
import type { UiFile, UiFiles } from './files.ts';
import { CSP, SECURITY_HEADERS, json, plain, redirect } from './headers.ts';
import type { UiAnswer } from '../shell/http.ts';

// Call 17, written out here apart from the code.
const POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; "
  + "manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SECURITY = {
  'content-security-policy': POLICY, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
};
const YEAR = 'public, max-age=31536000, immutable';
const NOT_FOUND: UiAnswer = {
  status: 404, body: 'not_found', headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY },
};

const INDEX: UiFile = { body: Buffer.from('<!doctype html><title>Visto AI</title>'), type: 'text/html; charset=utf-8' };
const SCRIPT: UiFile = { body: Buffer.from('export const a = 1;\n'), type: 'text/javascript; charset=utf-8' };
const ICON: UiFile = { body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), type: 'image/svg+xml' };
const FILES: UiFiles = new Map([['/ui/index.html', INDEX], ['/ui/assets/index-a1.js', SCRIPT], ['/ui/favicon.svg', ICON]]);
const served = (file: UiFile, cache: string): UiAnswer => ({
  status: 200, body: file.body, headers: { 'content-type': file.type, 'cache-control': cache, ...SECURITY },
});

const NO_INDEX: UiFiles = new Map([['/ui/assets/index-a1.js', SCRIPT]]);
const answer = fileAnswer;
const FOUND = ['/ui/assets/index-a1.js', '/ui/', '/ui/index.html', '/ui/favicon.svg'];
const NO_FILE = ['/ui/activity', '/ui/reviews/9001', '/ui/%2e%2e/package.json', '/ui/../src/main.ts', '/ui/assets', '/ui/ASSETS/nope.js'];
const MISSING_ASSET = ['/ui/assets/nope.js', '/ui/assets/', '/ui/assets/../index.html', '/ui/assets/%2e%2e/index.html', '/ui/assets/index-a1.js/'];
const REFUSED = [['POST', '/ui/'], ['HEAD', '/ui/'], ['PUT', '/ui/assets/index-a1.js'], ['DELETE', '/ui'], ['get', '/ui/'], ['', '/ui/x']] as const;

test('the built files are loaded by the path they are served at, and a folder that is not there gives none', () => {
  const root = mkdtempSync(join(tmpdir(), 'visto-ai-ui-files-'));
  try {
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets', 'fonts'), { recursive: true });
    const written: Array<[string, string, string]> = [
      ['index.html', '<!doctype html>', 'text/html; charset=utf-8'],
      ['assets/index-a1.js', 'export {};', 'text/javascript; charset=utf-8'],
      ['assets/fonts/x.woff2', 'wOF2', 'font/woff2'],
      ['favicon.svg', '<svg/>', 'image/svg+xml'],
      ['assets/index-b2.css', 'a{}', 'text/css; charset=utf-8'],
      ['assets/fonts/y.woff', 'wOFF', 'font/woff'],
      ['manifest.json', '{}', 'application/json'],
      ['icon.png', 'png', 'image/png'],
      ['favicon.ico', 'ico', 'image/x-icon'],
      ['robots.txt', 'User-agent: *', 'text/plain; charset=utf-8'],
      ['assets/index-a1.js.map', '{}', 'application/octet-stream'],
      ['LICENSE', 'text', 'application/octet-stream'],
    ];
    for (const [path, text] of written) writeFileSync(join(dist, ...path.split('/')), text);
    writeFileSync(join(root, 'outside.txt'), 'outside');
    symlinkSync(join(root, 'outside.txt'), join(dist, 'linked.txt'));
    // a link to a folder outside the built folder, and one that loops back into it
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', 'secret.txt'), 'outside');
    symlinkSync(join(root, 'outside'), join(dist, 'linkdir'));
    symlinkSync('..', join(dist, 'assets', 'up'));

    const files = loadUiFiles(dist);
    assert.deepEqual([...files.keys()].sort(), written.map(([path]) => `/ui/${path}`).sort());
    for (const [path, text, type] of written) {
      const file = files.get(`/ui/${path}`);
      assert.deepEqual(file, { body: Buffer.from(text), type }, path);
      assert.ok(Buffer.isBuffer(file?.body), path);
    }
    for (const key of ['/ui/index.html', '/ui/assets/index-a1.js', '/ui/assets/fonts/x.woff2', '/ui/favicon.svg']) assert.ok(files.has(key), key);
    assert.equal(files.has('/ui/linked.txt'), false);
    for (const key of ['/ui/linkdir/secret.txt', '/ui/assets/up/index.html', '/ui/assets/up/assets/index-a1.js']) assert.equal(files.has(key), false, key);
    assert.equal([...files.keys()].some((key) => key.startsWith('/ui/linkdir/') || key.startsWith('/ui/assets/up/')), false);

    assert.equal(loadUiFiles(join(root, 'nope')).size, 0);
    assert.equal(loadUiFiles(join(dist, 'index.html')).size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two links that loop back into the built folder are never entered, and the walk ends within 2 seconds with the real files', () => {
  const root = mkdtempSync(join(tmpdir(), 'visto-ai-ui-files-'));
  try {
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    mkdirSync(join(dist, 'real'));
    for (const path of ['index.html', 'assets/index-a1.js', 'real/notes.txt']) writeFileSync(join(dist, ...path.split('/')), path);
    symlinkSync('..', join(dist, 'assets', 'up'));
    symlinkSync('..', join(dist, 'real', 'up'));

    const start = performance.now();
    const files = loadUiFiles(dist);
    const took = performance.now() - start;
    assert.ok(took < 2000, `took ${took} ms`);
    assert.deepEqual([...files.keys()].sort(), ['/ui/assets/index-a1.js', '/ui/index.html', '/ui/real/notes.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Root reads a folder whatever its mode, so the refusal cannot be made there.
test('a folder below the top that cannot be read gives no files at all', { skip: process.getuid?.() === 0 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'visto-ai-ui-files-'));
  const dist = join(root, 'dist');
  const sub = join(dist, 'assets');
  try {
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    writeFileSync(join(sub, 'index-a1.js'), 'export {};');
    assert.deepEqual([...loadUiFiles(dist).keys()].sort(), ['/ui/assets/index-a1.js', '/ui/index.html']);
    chmodSync(sub, 0);
    assert.equal(loadUiFiles(dist).size, 0);
  } finally {
    if (existsSync(sub)) chmodSync(sub, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a built folder reached through a link is loaded as the folder itself', () => {
  const root = mkdtempSync(join(tmpdir(), 'visto-ai-ui-files-'));
  try {
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets', 'fonts'), { recursive: true });
    for (const path of ['index.html', 'assets/index-a1.js', 'assets/fonts/x.woff2']) writeFileSync(join(dist, ...path.split('/')), path);
    const via = join(root, 'via');
    symlinkSync(dist, via);

    const keys = ['/ui/assets/fonts/x.woff2', '/ui/assets/index-a1.js', '/ui/index.html'];
    assert.deepEqual([...loadUiFiles(dist).keys()].sort(), keys);
    assert.deepEqual([...loadUiFiles(via).keys()].sort(), [...loadUiFiles(dist).keys()].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a hashed asset is served with its type and cached for a year; index.html is never stored', () => {
  assert.deepEqual(answer(FILES, 'GET', '/ui/assets/index-a1.js'), served(SCRIPT, YEAR));
  assert.deepEqual(answer(FILES, 'GET', '/ui/'), served(INDEX, 'no-store'));
  assert.deepEqual(answer(FILES, 'GET', '/ui/index.html'), served(INDEX, 'no-store'));
  assert.deepEqual(answer(FILES, 'GET', '/ui/favicon.svg'), served(ICON, 'no-store'));
  assert.equal(answer(FILES, 'GET', '/ui/assets/index-a1.js').body, SCRIPT.body);
});

test('a path that is no file is answered with index.html, and a missing asset is not found', () => {
  for (const path of NO_FILE) assert.deepEqual(answer(FILES, 'GET', path), served(INDEX, 'no-store'), path);
  for (const path of MISSING_ASSET) assert.deepEqual(answer(FILES, 'GET', path), NOT_FOUND, path);
  for (const path of ['/ui/', '/ui/index.html', '/ui/activity']) assert.deepEqual(answer(NO_INDEX, 'GET', path), NOT_FOUND, path);
  assert.deepEqual(answer(NO_INDEX, 'GET', '/ui/assets/index-a1.js'), served(SCRIPT, YEAR));
  assert.deepEqual(answer(new Map(), 'GET', '/ui/'), NOT_FOUND);
  // never decoded: each decodes to a key, and neither is one
  assert.deepEqual(answer(FILES, 'GET', '/ui/assets/index%2Da1.js'), NOT_FOUND);
  assert.deepEqual(answer(FILES, 'GET', '/ui/favicon%2esvg'), served(INDEX, 'no-store'));
});

test('/ui is sent to /ui/, and a method other than GET is refused', () => {
  assert.deepEqual(answer(FILES, 'GET', '/ui'), { status: 302, body: '', headers: { location: '/ui/', 'cache-control': 'no-store', ...SECURITY } });
  const refused: UiAnswer = { status: 405, body: 'method_not_allowed', headers: { ...NOT_FOUND.headers, allow: 'GET' } };
  for (const [method, path] of REFUSED) assert.deepEqual(answer(FILES, method, path), refused, `${method} ${path}`);
});

test('every answer carries the content security policy and the three other headers, exactly', () => {
  assert.equal(CSP, POLICY);
  assert.deepEqual({ ...SECURITY_HEADERS }, SECURITY);
  assert.ok(Object.isFrozen(SECURITY_HEADERS));

  assert.deepEqual(plain(400, 'bad_request'), { ...NOT_FOUND, status: 400, body: 'bad_request' });
  assert.deepEqual(json(200, { a: [1, 'b'] }), {
    status: 200, body: '{"a":[1,"b"]}', headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY },
  });
  const cookies = ['a=1', 'b=2'];
  const withCookies = json(200, null, { 'set-cookie': cookies });
  assert.equal(withCookies.headers['set-cookie'], cookies);
  assert.equal(withCookies.body, 'null');
  assert.deepEqual(redirect('/ui/', { 'set-cookie': cookies }), {
    status: 302, body: '', headers: { location: '/ui/', 'cache-control': 'no-store', 'set-cookie': cookies, ...SECURITY },
  });
  // what a caller adds never replaces the type, the cache or a security header
  const loud = { 'content-type': 'text/html', 'cache-control': 'public', location: '/elsewhere', ...Object.fromEntries(Object.keys(SECURITY).map((k) => [k, 'x'])) };
  assert.deepEqual(json(500, { error: 'internal_error' }, loud).headers, {
    ...loud, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY,
  });
  assert.deepEqual(redirect('/ui/', loud).headers, { ...loud, location: '/ui/', 'cache-control': 'no-store', ...SECURITY });

  const all: Array<[string, UiAnswer]> = [
    ...[...FOUND, ...NO_FILE, ...MISSING_ASSET, '/ui'].map((path): [string, UiAnswer] => [path, answer(FILES, 'GET', path)]),
    ...['/ui/', '/ui/activity'].map((path): [string, UiAnswer] => [`no index ${path}`, answer(NO_INDEX, 'GET', path)]),
    ...REFUSED.map(([method, path]): [string, UiAnswer] => [`${method} ${path}`, answer(FILES, method, path)]),
    ['plain', plain(503, 'busy')], ['json', json(401, { error: 'signed_out' })], ['redirect', redirect('/ui/')], ['extra', json(200, {}, loud)],
  ];
  for (const [name, a] of all) {
    assert.equal(a.headers['content-security-policy'], POLICY, name);
    assert.equal(a.headers['x-content-type-options'], 'nosniff', name);
    assert.equal(a.headers['referrer-policy'], 'same-origin', name);
    assert.equal(a.headers['x-frame-options'], 'DENY', name);
  }
});

test('what a caller adds replaces neither the type, the cache nor a security header, whatever the case of its names', () => {
  assert.deepEqual(json(200, {}, { 'Content-Type': 'text/html', 'Content-Security-Policy': 'default-src *' }), {
    status: 200, body: '{}', headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY },
  });
  const cookies = ['a=1', 'b=2'];
  assert.deepEqual(redirect('/ui/', { Location: '/elsewhere', 'Cache-Control': 'public', 'X-Frame-Options': 'SAMEORIGIN', 'Set-Cookie': cookies }), {
    status: 302, body: '', headers: { location: '/ui/', 'cache-control': 'no-store', 'set-cookie': cookies, ...SECURITY },
  });
});
