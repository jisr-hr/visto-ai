# Scores Answer for Their Surroundings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stored score is reused for a block, with the model not asked, only when the block's changed lines and the unchanged lines around them are the ones the score was given for.

**Architecture:** Each block gets a second hash, `around`, of every line of its hunk. It travels with a block's score into the stored result and into `block_scores`. The one function that decides what a file's history settles (`keptScores`) and the lookup across pull requests compare the pair (`hash`, `around`) where they compared `hash`. Nothing else changes: `hash`, `hunkHash` and the file's diff hash stay as they are, so inline notes, what an incremental review reads, the test for a push that tells nothing new, the threads and the backtest's labels are untouched.

**Tech Stack:** TypeScript on Node 26 (type stripping, `.ts` import suffixes), `node:test`, PGlite through `testDb()`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-13-visto-ai-design.md`, section 6 under "Scores across reviews of one pull request (D17)" and "Across pull requests". The rule is the paragraph that begins "A stored score answers for a block only among the same lines". This plan closes call 19 of `2026-11-20-scores-that-hold-and-reading-less.md`, which the owner ruled on 2026-11-22.

**Notes:** `docs/superpowers/plans/2026-11-22-scores-answer-for-their-surroundings-notes.md` is written when the build ends.

## Calls made in this plan

None of these is in the owner's ruling. Each is the planner's call, listed so the owner can overrule it.

1. **`hash` is not changed; a second hash is added.** Changing what `hash` covers would also change when a note is given again, what an incremental review reads, when a push tells nothing new and how the backtest labels a hunk. The ruling is about a score being reused with the model not asked, and only that is changed.
2. **The surroundings are those of the hunk, not of the block.** A part of a split hunk has its hunk's `around`. A part holds no line outside its own changed lines, so a hash of the part's lines would not see the hunk moved.
3. **A stored score among other lines is a floor, by the rule that exists.** `keptScores` already computes "the highest stored score whose hash no present block has" and no new score of the file may be below it. That rule now reads "whose hash and surroundings no present block has". Cost: it is the file's floor, not the block's own, so when one block's surroundings change, every block of that file scored in the same run is held to that block's old score. A floor of the block's own would need a new mechanism; this one errs towards a person.
4. **A score stored before this plan answers for no block.** It has no `around`. Cost: at the first review after this is deployed, every block of every open pull request is scored again once, each file's new scores held to the highest block score the file had. Old rows of `block_scores` are reused by no one and age out in 30 days.
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

1. **Lines scored in one place and moved to another in a later push:** the model is asked again, and the score cannot fall below the stored one.
2. **A result stored before this plan** (no `around`): no block is kept from it, each file's highest stored block score is the floor, and nothing throws.
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
export interface StoredEntry { hash: string; around: string | null; entry: ScoreEntry; raisedFrom: number | null }
export interface StoredSplit { hunkHash: string; around: string | null; parts: Array<{ hash: string; range: [number, number] }> }
export interface FileHistory { /* as today, but: */ blocks: StoredEntry[]; /* one for each hash and around */ stoodFor: Array<{ hash: string; around: string | null }> }

// src/engine/types.ts
reusableScores?: (blocks: Array<{ path: string; hash: string; around: string }>) => Promise<Array<{ path: string; hash: string; around: string; entry: ScoreEntry }>>;

// src/engine/score/history.ts
export function keptScores(context: FileContext, history: ScoreHistory | null, reused: Array<{ hash: string; around: string; entry: ScoreEntry }>): KeptScores | null;
export function blocksToLookUp(contexts: FileContext[], history: ScoreHistory | null): Array<{ path: string; hash: string; around: string }>;

// src/db/block-scores.ts
export interface StoredBlockScore { path: string; hash: string; around: string | null; score: number; category: string; reason: string }
export async function reusableScores(db: Db, ref: PullRequestRef, by: 'model' | 'scorer', blocks: Array<{ path: string; hash: string; around: string }>, since: string): Promise<StoredBlockScore[]>;

// src/shell/history.ts
export function scoresToStore(result: unknown): Array<{ path: string; hash: string; around: string | null; score: number; category: string; reason: string }>;
```

**Rules:**

1. **`around`.** For a hunk, sha256 over each of its lines that is not a `meta` line, in order: `+`, `-` or a space for its kind, then its text and a line feed. `blocksOf` computes it. `splitBlock` and `partsAt` give each part, and the rest, the `around` of the block they cut. `hash`, `hunkHash` and `fileDiffHash` are computed as today.
2. **A stored score answers for a block** when the path is the block's (as today), and `hash` and `around` are both equal. A stored entry, split or stood-for block whose `around` is null answers for none.
3. **`keptScores`**, with "answers for" in place of "has the hash" in each of these, and nothing else changed:
   - a block is kept from an earlier run when a stored entry answers for it;
   - a split is kept when the stored split has the hunk's `hunkHash` and `around`, and a stored entry answers for each part;
   - a block is stood for by the kept whole-file score when a stored stood-for pair answers for it;
   - a score another pull request stored is taken when its `hash` and `around` are the block's;
   - the floor is the highest stored score whose pair (`hash`, `around`) no present block has. A block present with the same `hash` among other lines therefore leaves its stored score in the floor.
   Where the histories of a path and of its earlier name are joined, the higher entry is kept for each pair. The search that lets a file shown as added answer to the other paths that held one of its blocks still goes by `hash`: it only finds the histories to join.
4. **`blocksToLookUp`** returns the `around` of each block it asks for; two blocks with the same path, `hash` and `around` are asked once.
5. **`keepScores` in `review.ts`** asks with the three values, and takes from the answer only a row whose `path`, `hash` and `around` are strings and are one of those asked. Any other row is skipped, as a row with an unknown hash is today.
6. **`blockScore` in `reconcile/scores.ts`** writes the block's `around` on every `BlockScore` it builds, kept or given in this run.
7. **`historyOf` in `src/shell/history.ts`** reads `around` from each stored block: a string that is not empty, else null. Everything it keyed by a hash it keys by the pair: the highest entry for each pair; the parts of a hunk, by the hunk's pair; the splits, each with its hunk's `around`; the stood-for blocks, as pairs, less those that have an entry for the same pair; and the rule that a hunk does not stand below its own parts, by the hunk's pair and the parts' pairs. `coveredAt` and `readAt` are built as today.
8. **`scoresToStore`** adds each block's `around`, or null.
9. **The database.** `0007_score_surroundings.sql` is `alter table visto_ai.block_scores add column around text;`. `recordBlockScores` writes it. `reusableScores` joins on `path`, `hash` and `around`, answers the highest score for each of the three, and returns `around`. A row whose `around` is null matches no pair.
10. **`review-job.ts`** passes `around` both ways between the engine's lookup and `reusableScores`.

- [ ] **Step 1: Write the failing tests.** Names and what each asserts; fixtures are built the way the file's other tests build theirs.

```ts
// src/engine/score/blocks.test.ts
test("a block's surroundings are every line of its hunk, the unchanged ones too", () => { /* two hunks with the same added and removed lines between different unchanged lines: equal hash, different around */ });
test('surroundings do not count line numbers, nor a line that says the file has no final line feed', () => { /* the same hunk at other line numbers, and with a meta line: equal around */ });
test('a part and the rest have the surroundings of the hunk they were cut from', () => { /* splitBlock and partsAt: every part.around === hunk.around */ });
test('the hash of a block, of its hunk and of a file diff are what they were', () => { /* literal expected values taken from a run on the code before this task */ });

// src/engine/score/history.test.ts
test('a stored score answers for a block only among the same lines', () => { /* same hash and around: kept as earlier_run, hunk in scoredHunks; same hash, other around: no entry, hunk not in scoredHunks, floor is the stored score */ });
test('a score stored with no surroundings answers for no block and is the floor', () => { /* around null */ });
test('a split is kept only when its hunk stands among the same lines', () => { /* Review Focus 3 */ });
test('a block is stood for by the whole-file score only among the same lines', () => { /* Review Focus 4: moved, it is open and the file is not settled */ });
test('a score from another pull request is taken only for the same surroundings', () => { /* reused with another around: not taken */ });
test('the lookup asks with the surroundings, once for each path, hash and surroundings', () => { /* blocksToLookUp; a block whose lines are stored among other lines is asked for */ });
test('of a path and its earlier name the higher entry is kept for each pair', () => { /* a renamed file */ });

// src/engine/reconcile/scores.test.ts
test("a block's score carries its surroundings", () => { /* given in this run, and kept */ });

// src/engine/review.test.ts
test('lines scored in one place and moved to another are scored again and cannot score lower', async () => { /* Review Focus 1: a first review's result, read back through the same shape a stored result has, is the history of a second review of the same changed lines between other unchanged lines; the model is sent the hunk without `scored`; it answers lower: the stored score stands with raisedFrom; it answers higher: the higher stands */ });
test('an answer of the lookup with other surroundings, or none, gives no score', async () => { /* Review Focus 5 */ });

// src/shell/history.test.ts
test('the history keeps one entry for each hash and surroundings', () => { /* the same hash stored among two sets of lines: two entries, each with its around */ });
test('a result stored before surroundings were kept reads with none', () => { /* Review Focus 2: around null on entries, splits and stood-for; a damaged around (a number, an empty string) reads as null */ });
test('a split and the blocks a whole-file score stood for carry their surroundings', () => { /* */ });
test('the scores to store carry their surroundings', () => { /* scoresToStore */ });

// src/db/block-scores.test.ts
test('a score is reused only for the same path, hash and surroundings', async () => { /* another around: not found; the highest of two rows of one pair wins */ });
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
