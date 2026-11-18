import { posix } from 'node:path';

import type { ChangedFile } from '../types.ts';

export type ScorePlan =
  | { kind: 'model' }                                        // it has a diff: the model scores its blocks
  | { kind: 'model_whole' }                                  // moved to another directory with no content change
  | { kind: 'rule'; score: 30; source: 'rule_rename' }
  | { kind: 'rule'; score: 10; source: 'rule_asset' }
  | { kind: 'none'; reason: 'no_diff' | 'too_large' | 'unchanged' }; // nothing to show the model

// Raster images and fonts: binary, so no diff exists and the content cannot carry logic.
// svg is left out on purpose: it is text and can carry script.
const ASSET_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'avif', 'heic', 'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

export function isAsset(path: string): boolean {
  return ASSET_EXTENSIONS.has(posix.extname(path).slice(1).toLowerCase());
}

export function scorePlan(file: ChangedFile, skip: 'no_diff' | 'too_large' | 'unchanged' | null): ScorePlan {
  if (skip === null) return { kind: 'model' };
  if (skip === 'too_large') return { kind: 'none', reason: 'too_large' };
  if (skip === 'no_diff') {
    return isAsset(file.path) ? { kind: 'rule', score: 10, source: 'rule_asset' } : { kind: 'none', reason: 'no_diff' };
  }
  if (file.status === 'renamed' && file.previousPath !== null) {
    return posix.dirname(file.previousPath) === posix.dirname(file.path)
      ? { kind: 'rule', score: 30, source: 'rule_rename' }
      : { kind: 'model_whole' };
  }
  return { kind: 'none', reason: 'unchanged' };
}
