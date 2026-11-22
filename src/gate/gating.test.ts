import test from 'node:test';
import assert from 'node:assert/strict';
import { GATE_OFF } from '../config/load.ts';
import type { GateSettings, RepoSettings } from '../config/load.ts';
import { gatingOf, reviewedOnRequest } from './gating.ts';

const settings = (gate: Partial<GateSettings>): RepoSettings => ({
  primaryBranches: ['main'], scoreThreshold: 70, ignoredAuthors: [], baseBranches: [], newHead: null, inlineNotes: false,
  gate: { ...GATE_OFF, ...gate },
});

test('a pull request is gated when its repository has the gate on and its base branch is listed', () => {
  assert.equal(gatingOf(settings({ enabled: false, branches: ['main'] }), 'main'), 'off');
  assert.equal(gatingOf(settings({ enabled: true, branches: ['main'] }), 'feature/x'), 'off');
  assert.equal(gatingOf(settings({ enabled: true, branches: ['main'] }), 'Main'), 'off');
  assert.equal(gatingOf(settings({ enabled: true, branches: ['main'], mode: 'enforce' }), 'main'), 'enforce');
  assert.equal(gatingOf(settings({ enabled: true, branches: ['main', 'release'], mode: 'shadow' }), 'release'), 'shadow');
  assert.equal(gatingOf(settings({ enabled: true, branches: ['main'], mode: 'bypass' }), 'main'), 'bypass');
});
test('enforce and bypass are reviewed only when asked; shadow and off are not', () => {
  assert.equal(reviewedOnRequest('enforce'), true);
  assert.equal(reviewedOnRequest('bypass'), true);
  assert.equal(reviewedOnRequest('shadow'), false);
  assert.equal(reviewedOnRequest('off'), false);
});
