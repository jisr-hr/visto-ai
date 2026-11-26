import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const path = new URL('../../.github/workflows/docs-site.yml', import.meta.url);
const workflow = parse(readFileSync(path, 'utf8'));
const job = Object.values(workflow.jobs)[0] as {
  env: Record<string, string>;
  steps: { name?: string; if?: string; run?: string; env?: Record<string, string> }[];
};

test('the workflow runs on main, only for a change under docs/guide', () => {
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.deepEqual(workflow.on.push.paths, ['docs/guide/**']);
  assert.ok('workflow_dispatch' in workflow.on);
});

test('the workflow can only read the repository', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
});

test('the first step is the token check, so a missing token ends the job without a failure', () => {
  assert.match(job.env.TOKEN_SET ?? '', /secrets\.WEBSITE_DISPATCH_TOKEN/);
  const first = job.steps[0];
  assert.ok(first);
  assert.match(first.if ?? '', /TOKEN_SET/);
  assert.match(first.run ?? '', /^echo "::notice::/);
  assert.doesNotMatch(first.run ?? '', /exit [1-9]/);
});

test('the dispatch is gated on the token and sends docs-changed', () => {
  const dispatch = job.steps.find((step) => step.run?.includes('gh api'));
  assert.ok(dispatch, 'a step runs gh api');
  assert.match(dispatch.if ?? '', /TOKEN_SET/);
  assert.match(dispatch.run ?? '', /repos\/visto-ai\/website\/dispatches/);
  assert.match(dispatch.run ?? '', /event_type=docs-changed/);
  assert.equal(dispatch.env?.GH_TOKEN, '${{ secrets.WEBSITE_DISPATCH_TOKEN }}');
  assert.equal(dispatch.env?.SHA, '${{ github.sha }}');
});

test('no run line interpolates an expression', () => {
  for (const step of job.steps) assert.doesNotMatch(step.run ?? '', /\$\{\{/);
});
