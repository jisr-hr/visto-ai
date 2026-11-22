# Scores Answer for Their Surroundings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stored score is reused for a block, with the model not asked, only when the block's changed lines and the unchanged lines around them are the ones the score was given for.

**Architecture:** Each block gets a second hash, `around`, of every line of its hunk. It travels with a block's score into the stored result and into `block_scores`. The one function that decides what a file's history settles (`keptScores`) and the lookup across pull requests compare the pair (`hash`, `around`) where they compared `hash`. Nothing else changes: `hash`, `hunkHash` and the file's diff hash stay as they are, so inline notes, what an incremental review reads, the test for a push that tells nothing new, the threads and the backtest's labels are untouched.

**Tech Stack:** TypeScript on Node 26 (type stripping, `.ts` import suffixes), `node:test`, PGlite through `testDb()`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-13-visto-ai-design.md`, section 6 under "Scores across reviews of one pull request (D17)" and "Across pull requests". The rule is the paragraph that begins "A stored score spares the model only among the same lines". This plan closes call 19 of `2026-11-20-scores-that-hold-and-reading-less.md`, which the owner ruled on 2026-11-22.

**Notes:** `docs/superpowers/plans/2026-11-22-scores-answer-for-their-surroundings-notes.md` is written when the build ends.

## Calls made in this plan

None of these is in the owner's ruling. Each is the planner's call, listed so the owner can overrule it.

1. **`hash` is not changed; a second hash is added.** Changing what `hash` covers would also change when a note is given again, what an incremental review reads, when a push tells nothing new and how the backtest labels a hunk. The ruling is about a score being reused with the model not asked, and only that is changed.
2. **The surroundings are those of the hunk, not of the block.** A part of a split hunk has its hunk's `around`. A part holds no line outside its own changed lines, so a hash of the part's lines would not see the hunk moved.
3. **A stored score among other lines holds its own block, not the file.** A block that is asked again because its surroundings changed cannot score below the highest score stored for its changed lines (`held`, by block). The file's floor stays what it is: the highest stored score whose `hash` no present block has. As first written this plan put the moved block's score into the file's floor; the plan's review showed that every block of the file scored in the same run would then be raised to it, and, with inline notes on, each given a note. One exception is left to the worst-case rule that exists: the parts of a split hunk are not held one by one. When their hunk stands among other lines the hunk is asked again as one block, the parts' hashes are in the diff no more, and their scores are the file's floor, as when a split hunk is edited today.
4. **A score stored before this plan answers for no block.** It has no `around`. Costs: at the first review after this is deployed, every block of every open pull request is scored again once, each held to its own stored score; a file that held a split hunk has its new scores held to the highest of the parts; no file is covered any more, so every file is sent again, and in a pull request larger than the batches allow, a file that finds no room is not read and goes to a person (100, `not_scored`) where it was left out as covered before. It settles over the next reviews. The same happens, for the files concerned, after a merge of the base branch that changes lines beside their blocks. Old rows of `block_scores` are reused by no one and age out in 30 days.
6. **The surroundings decide only whether the model is asked. What a block keeps is decided by its changed lines alone, as before this plan.** As first built, each pair of changed lines and surroundings kept its own score. The review of the whole branch, which drove the engine through several hundred lives of a pull request against a copy of `main`, found two ways a score could then fall where it could not before: a block back among lines it had been scored among took that older, lower score; and of two hunks with the same changed lines, editing or removing the higher let the file fall to the lower. Now the history keeps, for each `hash`, the highest score stored for it, as it always did, and beside it the surroundings among which a score was stored. A block among known surroundings is not asked for and keeps that highest score; a block among others is asked for and held to it. No score can fall where it could not before this plan.
5. **Not covered, and said in the README:** lines moved to a place whose neighbours read the same; a hunk with no unchanged line (a new file); the lines an incremental review shows as removed, which are still told by `hash` (`leftBlocksOf`).

## Global Constraints

- The engine imports nothing from `src/db`, `src/shell`, `src/eval` or `src/forge/github`. Only `src/db/**` imports a Postgres client.
- Every test that could reach GitHub, Postgres or a model is stubbed at the boundary. Database tests use `testDb()`.
- Source and tests are ASCII. A character outside ASCII in a test is written as an escape.
- Nothing internal goes into the repository: no real repository name, no figure from a private run. Example values are invented.
- A stored result may be old or damaged: every field read from one is checked, and an absent or wrong `around` reads as none.
- `hash`, `hunkHash` and `fileDiffHash` give the same values as before for the same input. A test pins it.
- Commits end with the co-author line of the model that made them.

## Review Focus

Each has its test in the task below.

1. **Lines scored in one place and moved to another in a later push:** the model is asked again, the score cannot fall below the stored one, and no other block of the file is raised by it.
2. **A result stored before this plan** (no `around`): no block is kept from it, each block is held to the score stored for its own changed lines, and nothing throws.
3. **A split hunk whose surroundings changed:** none of its parts is kept.
4. **A block that stood under its file's whole-file score, moved:** it is no longer stood for, so the file is not settled and is sent.
5. **A row of `block_scores` with no `around`, and an answer of the lookup with a wrong or missing `around`:** neither gives a block a score.

---

### Task 1: The surroundings of a block, and the pair in every reuse

**Files:**
- Modify: `src/engine/score/types.ts`, `src/engine/score/blocks.ts`, `src/engine/score/history.ts`, `src/engine/reconcile/scores.ts`, `src/engine/review.ts`, `src/engine/types.ts`, `src/shell/history.ts`, `src/shell/review-job.ts`, `src/db/block-scores.ts`
- Create: `src/db/migrations/0007_score_surroundings.sql`
- Test: `src/engine/score/blocks.test.ts`, `src/engine/score/history.test.ts`, `src/engine/reconcile/scores.test.ts`, `src/engine/review.test.ts`, `src/shell/history.test.ts`, `src/shell/review-job.test.ts`, `src/db/block-scores.test.ts`, `src/db/migrate.test.ts`
- Any other test or eval file that builds a `Block`, a `StoredEntry`, a `StoredSplit`, a `FileHistory` or a lookup answer by hand is brought up to the new shapes; the type check finds most, and a search for `stoodFor`, `splits:` and `reusableScores` finds the rest.

**Interfaces:**

```ts
// src/engine/score/types.ts
export interface Block { /* as today, and: */ around: string }
//   around: sha256, hex, of every line of the block's hunk, the unchanged ones included, without line numbers; a part has its hunk's
export interface BlockScore { /* as today, and: */ around?: string }   // absent on a result stored before it existed
export interface StoredEntry { hash: string; arounds: string[]; entry: ScoreEntry; raisedFrom: number | null }
//   one for each hash, as before this plan: the highest score stored for these changed lines.
//   arounds: the surroundings among which a score was stored for them; empty when none was stored with surroundings
export interface StoredSplit { hunkHash: string; around: string | null; parts: Array<{ hash: string; range: [number, number] }> }
export interface FileHistory { /* as today, but: */ blocks: StoredEntry[]; /* one for each hash */ stoodFor: Array<{ hash: string; around: string | null }> /* every stood-for pair, also of a hash that has an entry */ }

// src/engine/types.ts
reusableScores?: (blocks: Array<{ path: string; hash: string; around: string }>) => Promise<Array<{ path: string; hash: string; around: string; entry: ScoreEntry }>>;

// src/engine/score/history.ts
export interface KeptScores { /* as today, and: */ held: Map<string, number> }
//   held, by block id: the highest score stored for the block's changed lines among other lines, or with no surroundings;
//   only for a block that is asked again. Empty for a moved file.
export function keptScores(context: FileContext, history: ScoreHistory | null, reused: Array<{ hash: string; around: string; entry: ScoreEntry }>): KeptScores | null;
export function blocksToLookUp(contexts: FileContext[], history: ScoreHistory | null): Array<{ path: string; hash: string; around: string }>;

// src/db/block-scores.ts
export interface StoredBlockScore { path: string; hash: string; around: string | null; score: number; category: string; reason: string }
export async function reusableScores(db: Db, ref: PullRequestRef, by: 'model' | 'scorer', blocks: Array<{ path: string; hash: string; around: string }>, since: string): Promise<Array<StoredBlockScore & { around: string }>>;   // the join leaves no row without surroundings

// src/shell/history.ts
export function scoresToStore(result: unknown): Array<{ path: string; hash: string; around: string | null; score: number; category: string; reason: string }>;
```

**Rules:**

1. **`around`.** For a hunk, sha256 over each of its lines that is not a `meta` line, in order: `+`, `-` or a space for its kind, then its text and a line feed. `blocksOf` computes it. `splitBlock` and `partsAt` give each part, and the rest, the `around` of the block they cut. `hash`, `hunkHash` and `fileDiffHash` are computed as today.
2. **Two questions, two keys** (call 6). Whether the model is asked for a block is decided by the pair. What score a block keeps, or is held to, is decided by its `hash` alone: the highest score stored for it, wherever the lines stood. A stored entry, split or stood-for pair with no surroundings spares the model for no block; a stored entry holds its block all the same.
3. **`keptScores`.** The model **was asked for a block among its lines** when one of these is stored: an entry of the block's `hash` with the block's `around` among its `arounds`; a stood-for pair that is the block's pair; a split with the block's `hunkHash` and `around`. Then, for each block:
   - asked before, and its `hash` has an entry: it is kept whole at that entry's score and not asked for, also when a split is stored for it;
   - asked before, no entry, and a split is stored for its pair: the split is kept when each part's `hash` has an entry whose `arounds` hold the hunk's `around`; a split that does not fit leaves the block open;
   - asked before, no entry, a stood-for pair: it is stood for by the kept whole-file score, as today;
   - otherwise the block is open: it is asked for, and when its `hash` has an entry it is held (`held`, under its id) at that entry's score. A score taken from another pull request (its `hash` and `around` are the block's) for a held block is raised to the higher of the floor and its hold, as it is raised to the floor today.
   The floor is computed as before this plan, by `hash`: the highest stored score whose `hash` no present block has. Where the histories of a path and of its earlier name are joined, the higher entry is kept for each `hash`, with the `arounds` of both. The search that lets a file shown as added answer to the other paths that held one of its blocks goes by `hash`, as today.
4. **`blocksToLookUp`** returns the `around` of each block it asks for; two blocks with the same path, `hash` and `around` are asked once.
5. **`keepScores` in `review.ts`** asks with the three values, and takes from the answer only a row whose `path`, `hash` and `around` are strings and are one of those asked. Any other row is skipped, as a row with an unknown hash is today.
6. **`reconcile/scores.ts`.** `blockScore` writes the block's `around` on every `BlockScore` it builds, kept or given in this run. In `scoreFile`, where a score given in this run for a block is raised to the file's floor (`atFloor`, and the whole-file score that stands in place of a block score), the bound is the higher of the file's floor and the block's hold; the given score is kept in `raisedFrom` as today. The parts the model cuts a held block into are each held.
7. **`historyOf` in `src/shell/history.ts`** reads `around` from each stored block: a string that is not empty, else null. The entries are kept as before this plan, one for each `hash`, the highest, with the same rule on a tie; each also gets `arounds`: every `around`, null left out, among which a block of that `hash` had an entry given by `by` in any earlier run, whatever its score. The rule that a hunk does not stand below its own parts goes by `hunkHash`, as before. The blocks of a stored file are grouped into hunks by the hunk's pair (`hunkHash`, `around`), so that two hunks with the same changed lines among different lines are two groups, and there is one split for each hunk pair, with its `around`. The stood-for blocks are pairs, every one of them: a pair whose `hash` also has an entry tells that the model was asked among those lines. `coveredAt` and `readAt` are built as today. The existing test of `src/shell/history.test.ts` "two blocks of one run with the same changed lines both stand at the higher score" keeps what it asserted before this plan. The test helper `historyFrom` in `src/engine/review.test.ts` mirrors `historyOf`: it is brought up the same way, so that the end-to-end tests go on testing the real shape.
8. **`scoresToStore`** adds each block's `around`, or null.
9. **The database.** `0007_score_surroundings.sql` is `alter table visto_ai.block_scores add column around text;`. `recordBlockScores` writes it. `reusableScores` joins on `path`, `hash` and `around`, answers the highest score for each of the three, and returns `around`. A row whose `around` is null matches no pair.
10. **`review-job.ts`** passes `around` both ways between the engine's lookup and `reusableScores`.

- [ ] **Step 1: Write the failing tests.** Names and what each asserts; fixtures are built the way the file's other tests build theirs.

```ts
// src/engine/score/blocks.test.ts
test("a block's surroundings are every line of its hunk, the unchanged ones too", () => { /* two hunks with the same added and removed lines between different unchanged lines: equal hash, different around; one literal value of `around` for a small hunk; the same text as an added, a removed and an unchanged line gives three different values */ });
test('surroundings do not count line numbers, nor a line that says the file has no final line feed', () => { /* the same hunk at other line numbers, and with a meta line: equal around */ });
test('a part and the rest have the surroundings of the hunk they were cut from', () => { /* splitBlock and partsAt: every part.around === hunk.around */ });
test('the hash of a block, of its hunk and of a file diff are what they were', () => { /* for one patch with unchanged lines, a line saying the file has no final line feed, and a hunk cut in two by splitBlock: the hash and hunkHash of the hunk and of each part, and fileDiffHash, as literal values; the literals are got by running the code as it is BEFORE blocks.ts is touched, and the report quotes that run */ });

// src/engine/score/history.test.ts
test('a stored score answers for a block only among the same lines', () => { /* same hash and around: kept as earlier_run, hunk in scoredHunks, nothing held; same hash, other around: no entry, hunk not in scoredHunks, held at the stored score, and the floor is 0 */ });
test('a score stored with no surroundings answers for no block and holds it', () => { /* around null: held, floor 0 */ });
test('a block is held to the highest score stored for its changed lines, and a stored score whose lines are gone is still the floor', () => { /* two stored entries of one hash among different lines; another hash no present block has */ });
test('a score from another pull request is raised to the hold of a held block', () => { /* reused below the hold: raised, raisedFrom is the reused score */ });
test('a file shown as added answers to the path that held its blocks, and keeps an entry only for the same pair', () => { /* the rename-as-added case: same hash and around kept; same hash among other lines held */ });
test('a split is kept only when its hunk stands among the same lines', () => { /* Review Focus 3 */ });
test('a block is stood for by the whole-file score only among the same lines', () => { /* Review Focus 4: moved, it is open and the file is not settled */ });
test('a score from another pull request is taken only for the same surroundings', () => { /* reused with another around: not taken */ });
test('the lookup asks with the surroundings, once for each path, hash and surroundings', () => { /* blocksToLookUp; a block whose lines are stored among other lines is asked for */ });
test('of a path and its earlier name the higher entry is kept for each hash, with the surroundings of both', () => { /* a renamed file */ });
test('a block back among lines it was scored among keeps the highest score its changed lines had, and is not asked for', () => { /* stored 20 among A1, then 60 among A2: among A1 again it is kept at 60, hunk in scoredHunks */ });
test('of two hunks with the same changed lines, each among known lines, both stand at the higher score', () => { /* 85 and 10: both kept at 85; with the 85 one gone from the diff the other still stands at 85 */ });
test('a block the model left to the whole-file score among these lines, whose changed lines have a score, is kept at that score and not asked for', () => { /* scored 20 among A1; among A2 the model gave the file 50 and the block nothing: among A2 again it is kept at 20 as earlier_run, the file is settled once its diff was read, and nothing is held; with the two stored under a path and its earlier name it is the same */ });
test('a hunk split among these lines and scored whole among others is kept whole at its score', () => { /* parts 10 and 20 among A1, whole 70 among A2: among A1 again it is one block kept at 70, not the parts */ });
test('a hunk scored whole, then split among other lines, does not stand below its highest part when it is back', () => { /* whole 10 among A1, parts up to 90 among A2: among A1 it is kept at 90 */ });
test('a hunk whose stored split is found but no longer fits is held to the score stored for its changed lines', () => { /* the implementer\'s first gap */ });

// src/engine/reconcile/scores.test.ts
test("a block's score carries its surroundings", () => { /* given in this run, and kept */ });
test('a held block scored below its hold is raised to it, and no other block of the file is', () => { /* given 5 with a hold of 40 and a floor of 0: 40 with raisedFrom 5; cut by the model into two parts given 5 and 7: both 40; a second open block of the file given 5 stays 5; a whole-file score that stands in place of the held block's score is raised too; with a floor of 60 and a hold of 40 the bound is 60 */ });

// src/engine/review.test.ts
test('lines scored in one place and moved to another are scored again and cannot score lower', async () => { /* Review Focus 1: a first review's result, read back through the same shape a stored result has, is the history of a second review of the same changed lines between other unchanged lines; the model is sent the hunk without `scored`; it answers lower: the stored score stands with raisedFrom; it answers higher: the higher stands; a second, new block of the same file that the model scores low keeps its low score */ });
test('no score falls: a block whose neighbours change and change back, and two hunks with the same changed lines of which the higher is edited', async () => { /* the two sequences of the whole-branch review, each through three reviews with the history read back each time: 20, 60, then 60 with the model not asked; and 85 and 10, then the first edited and scored 15: the file still stands at 85; and the two of the re-review: a block the model leaves to a whole-file score is not asked for at the review after, and a hunk split 10 and 20, scored 70 as one among other lines, is at 70 when it is back */ });
test('a result stored with no surroundings: every block is asked for again and each is held to its own stored score', async () => { /* Review Focus 2: a file of two blocks stored at 80 and 10 with no around; the file is sent, both hunks shown without `scored`; answers of 5 and 5 end as 80 and 10 */ });
test('an answer of the lookup with other surroundings, or none, gives no score', async () => { /* Review Focus 5 */ });

// src/shell/history.test.ts
test('the history keeps one entry for each hash, the highest, with every surroundings a score was stored among', () => { /* the same hash stored at 20 among A1 and 60 among A2: one entry at 60 with arounds A1 and A2; an entry stored with no surroundings adds none */ });
test('two hunks with the same changed lines among different lines are two hunks: each has its own split and its own parts', () => { /* grouping by the hunk pair */ });
test('a hunk does not stand below its own parts, wherever they were scored', () => { /* a hunk entry below its highest part is raised, also by a part stored among other lines */ });
test('a result stored before surroundings were kept reads with none', () => { /* Review Focus 2: around null on entries, splits and stood-for; a damaged around (a number, an empty string) reads as null */ });
test('a split and the blocks a whole-file score stood for carry their surroundings', () => { /* */ });
test('the scores to store carry their surroundings', () => { /* scoresToStore */ });

// src/db/block-scores.test.ts
test('a score is reused only for the same path, hash and surroundings', async () => { /* another around: not found; the highest of two rows of one pair wins; two surroundings of one path and hash asked at once: each gets its own row */ });
test('a row stored with no surroundings is reused by no one', async () => { /* Review Focus 5 */ });

// src/db/migrate.test.ts: '0007_score_surroundings' comes right after '0006_publish_tried'.

// src/shell/review-job.test.ts
test('the engine looks up and stores scores with their surroundings', async () => { /* the existing lookup test, with around passed both ways and stored */ });
```

- [ ] **Step 2: Run them and see each fail for the reason expected.** `node --import ./test/setup.ts --test <file>`. A test that passes before the code is named in the report as a pin.
- [ ] **Step 3: Implement** rules 1 to 10. Existing tests whose fixtures name a hash are brought up to the pair; an existing test is changed only where its fixture needs the new field, never in what it asserts, unless a rule above changes that assertion, and each such change is listed in the report.
- [ ] **Step 4: Run** `npm test`, `npx tsc --noEmit`, `npx eslint .`. All pass.
- [ ] **Step 5: Commit** `feat: a stored score answers for a block only among the same lines`.

---

### Task 2: What the reader is told, and a run on a real Postgres

Done by the controller, not by the implementer.

1. **README**, under "Scores kept across reviews": the rule in one paragraph, and its costs: a block is scored again when the lines beside it change though its own do not, as after a merge of the base branch that touched them, and the other blocks of that file scored in the same run are then held to its old score; a push that only merges the base can therefore get a review where it got none; at the first review after an upgrade every block of an open pull request is scored again once; and what is not covered (call 5).
2. **A run under Docker** on the final code, in a network with no way out: the previous release's migrations, then this code's `0007_score_surroundings` and nothing else; a row of `block_scores` stored before reads with no surroundings and is reused by no one; a row written with surroundings is found by the lookup and by no other pair.
3. **The notes file.**

## To verify with a real model

Needs the owner's go-ahead, which he gave for this plan on 2026-11-22.

1. On the trial's database, whose stored results have no surroundings: the first review after the upgrade asks the model for every block again and no score falls.
2. A second review of the same head asks for nothing.
3. A push that moves a scored block to another place in its file: the block is asked for again.

## What was built

Task 1 was built and reviewed, and corrected in one fix wave after the review of the whole branch; the rules above are the rules as built (calls 3 and 6 came from the two reviews). What was decided on the way, what the run on a real Postgres and a trial with a real app and real models showed, and what is left are in `2026-11-22-scores-answer-for-their-surroundings-notes.md`.

Of "To verify with a real model": items 2 and 3 were seen, with a second scorer in force. Item 1 was not: with a scorer newly named, the trial's stored scores were not the scorer's, so nothing of them was at stake.
