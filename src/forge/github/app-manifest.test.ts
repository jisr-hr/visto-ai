import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from './app-manifest.json' with { type: 'json' };
import { missingFor } from './app-info.ts';

const ALL = { check: true, statuses: true, members: true };
const infoWith = (permissions: Record<string, string>, events: string[]) => ({ botLogin: 'x[bot]', permissions, events });

test('an app made from the manifest lacks nothing the service needs', () => {
  const info = infoWith(manifest.default_permissions, manifest.default_events);
  assert.deepEqual([missingFor(info, true, ALL), missingFor(info, false, ALL)], [[], []]);
});

test('the manifest asks for no permission the service does not use', () => {
  const names = Object.keys(manifest.default_permissions).filter((name) => name !== 'metadata');
  assert.deepEqual(names.sort(), ['checks', 'contents', 'issues', 'members', 'pull_requests', 'statuses']);
  for (const name of names) {
    const permissions: Record<string, string> = { ...manifest.default_permissions };
    delete permissions[name];
    const missing = missingFor(infoWith(permissions, manifest.default_events), false, ALL).map((m) => m.missing);
    assert.ok(missing.some((m) => m.startsWith(`${name}:`)), name);
  }
});

test('the manifest asks for no event the service does not use', () => {
  assert.equal(manifest.default_events.length, 6);
  for (const event of manifest.default_events) {
    const missing = missingFor(infoWith(manifest.default_permissions, manifest.default_events.filter((e) => e !== event)), false, ALL).map((m) => m.missing);
    assert.ok(missing.includes(`event:${event}`), event);
  }
});

test('the manifest asks to write pull requests, issues, contents and checks because a feature needs each', () => {
  for (const name of ['pull_requests', 'issues', 'contents', 'checks']) {
    const permissions = { ...manifest.default_permissions, [name]: 'read' };
    const missing = missingFor(infoWith(permissions, manifest.default_events), false, ALL).map((m) => m.missing);
    assert.ok(missing.includes(`${name}:write`), name);
  }
});

test('the manifest is private, has an active hook and no address to come back to', () => {
  assert.equal(manifest.name, 'visto-ai');
  assert.equal(manifest.public, false);
  assert.deepEqual(manifest.hook_attributes, { url: 'https://example.invalid/webhooks/github', active: true });
  assert.equal('redirect_url' in manifest, false);
  assert.deepEqual(manifest.default_permissions, { pull_requests: 'write', contents: 'write', issues: 'write', checks: 'write', statuses: 'read', members: 'read', metadata: 'read' });
  assert.deepEqual(manifest.default_events, ['pull_request', 'issue_comment', 'pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread', 'check_run']);
});
