// The engine's memory backed by the database (7.4): the repository's live signals, read under a statement limit of
// their own, and chosen by the rule the eval runs too. Only the columns a lookup needs are read: never an excerpt or a reason.
import { liveRecordsWithin } from '../db/memory-records.ts';
import type { Db } from '../db/types.ts';
import { MEMORY_TIMEOUT_MS } from '../engine/context/memory.ts';
import type { Memory } from '../engine/types.ts';
import type { PullRequestRef } from '../forge/types.ts';
import { createMemory, RECORDS_READ } from '../memory/select.ts';
import type { LiveRecord } from '../memory/select.ts';

/** The memory of the pull request's repository, read from the database (7.4), for a review of that pull request. */
export function recordsMemory(db: Db, ref: PullRequestRef): Memory {
  const repo = { service: ref.service, owner: ref.owner, repo: ref.repo };
  return createMemory({
    // The signal a lookup is given is not read: the statement limit is what ends a read nobody waits for.
    // The pull request's own records are left out by the read, so they take no place in it; createMemory drops them too.
    live: async (at) => {
      const rows = await liveRecordsWithin(db, repo, 'human_signal', at.toISOString(), RECORDS_READ + 1, MEMORY_TIMEOUT_MS, ref.number);
      const records: LiveRecord[] = [];
      for (const row of rows) {
        // A row with no path or no directory is passed over; nothing else of a row is dropped or invented.
        if (row.path === null || row.directory === null) continue;
        records.push({ ref: row.sourceRef, number: row.number, path: row.path, directory: row.directory, category: row.category, missed: row.missed, createdAt: row.createdAt });
      }
      return records;
    },
  }, ref.number);
}
