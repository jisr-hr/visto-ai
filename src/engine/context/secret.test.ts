import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChangedFile } from '../types.ts';
import { isSecretFile, isSecretPath } from './secret.ts';

test('secret paths', () => {
  for (const p of ['.env', 'app/.env.production', 'deploy/.ENV.Local', '.env.example.local', 'home/.ssh/config', 'keys/ID_RSA', '.npmrc', 'pkg/_netrc']) {
    assert.equal(isSecretPath(p), true, p);
  }
});

test('paths that are not secret', () => {
  for (const p of ['.env.example', 'deploy/.env.sample', '.env.template', 'src/env.ts', 'environment.env', 'ssh/config', 'docs/npmrc.md']) {
    assert.equal(isSecretPath(p), false, p);
  }
});

test('a file renamed away from a secret path is secret', () => {
  const file: ChangedFile = {
    path: 'config/settings.txt', previousPath: '.env', status: 'renamed', additions: 0, deletions: 0, patch: null,
  };
  assert.equal(isSecretFile(file), true);
  assert.equal(isSecretFile({ ...file, previousPath: 'config/old.txt' }), false);
});
