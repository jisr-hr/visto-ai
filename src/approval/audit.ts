import { createHmac } from 'node:crypto';
import { storable } from '../db/text.ts';
import type { PullRequestRef } from '../forge/types.ts';

/** The pull request as the service stores it: JSON of [service, owner, repo, number], owner and repo through storable() and lower-cased. */
export function auditIdentity(ref: PullRequestRef): string {
  return JSON.stringify([ref.service, storable(ref.owner).toLowerCase(), storable(ref.repo).toLowerCase(), ref.number]);
}

/** Whether the pull request is drawn for the audit sample (6.5): keyed with `key`, over its identity, against `share` (0 to 100). Pure; never throws. */
export function drawnForAudit(key: string | undefined, ref: PullRequestRef, share: number): boolean {
  if (share === 0) return false;   // the sample is off, -0 too: the key is not read
  // What cannot be told is drawn: a share that is no number from 0 to 100, a key that is no text or empty.
  if (typeof share !== 'number' || Number.isNaN(share) || share < 0 || share > 100) return true;
  if (typeof key !== 'string' || key === '') return true;
  try {
    // The first four bytes of the digest, below 2^32; both sides are exact in a double, so the share is drawn as written.
    const u = createHmac('sha256', key).update(auditIdentity(ref), 'utf8').digest().readUInt32BE(0);
    return u * 100 < share * 2 ** 32;
  } catch {
    return true;                   // an identity that cannot be made: a pull request of the wrong shape
  }
}
