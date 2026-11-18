import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChangedFile, FileStatus } from '../../forge/types.ts';
import { isAsset, scorePlan } from './rules.ts';

const file = (path: string, previousPath: string | null = null, status: FileStatus = 'modified'): ChangedFile => ({
  path, previousPath, status, additions: 0, deletions: 0, patch: null,
});

test('scorePlan', () => {
  assert.deepEqual(scorePlan(file('src/a.ts'), null), { kind: 'model' });
  assert.deepEqual(scorePlan(file('src/b.ts', 'src/a.ts', 'renamed'), 'unchanged'), { kind: 'rule', score: 30, source: 'rule_rename' });
  assert.deepEqual(scorePlan(file('app/pages/b.ts', 'src/a.ts', 'renamed'), 'unchanged'), { kind: 'model_whole' });
  assert.deepEqual(scorePlan(file('b.ts', 'a.ts', 'renamed'), 'unchanged'), { kind: 'rule', score: 30, source: 'rule_rename' }); // both at the root
  assert.deepEqual(scorePlan(file('bin/run'), 'unchanged'), { kind: 'none', reason: 'unchanged' });
  assert.deepEqual(scorePlan(file('img/Logo.PNG'), 'no_diff'), { kind: 'rule', score: 10, source: 'rule_asset' });
  assert.deepEqual(scorePlan(file('img/logo.svg'), 'no_diff'), { kind: 'none', reason: 'no_diff' });
  assert.deepEqual(scorePlan(file('img/logo.png'), null), { kind: 'model' }); // it arrived with a text diff
  assert.deepEqual(scorePlan(file('dist/app.js'), 'too_large'), { kind: 'none', reason: 'too_large' });
});

test('isAsset is true for raster images and fonts, whatever the case, and false for svg and plain files', () => {
  for (const name of ['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a.ico', 'a.tif', 'a.tiff', 'a.avif', 'a.heic', 'a.woff', 'a.woff2', 'a.ttf', 'a.otf', 'a.eot']) {
    assert.equal(isAsset(`static/${name}`), true, name);
  }
  for (const name of ['static/a.svg', 'static/png', 'static/a.png.txt', 'Makefile']) {
    assert.equal(isAsset(name), false, name);
  }
});
