# Score Engine and Backtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine scores every block of a pull request for how much it needs a person's judgement and returns a verdict, and that score can be measured against a repository's past human reviews.

**Architecture:** Scoring shares the model call with findings: `submit_review` gains `files[]`. The service cuts each file's diff into blocks, checks the model's answer against them, applies the rules and floors that need no model, and computes each file's final score and the pull request's verdict. A read-only importer writes a history file from merged pull requests. A backtest replays the engine on that file and reports Safety, Benefit and Focus with the counts behind them, plus a noise report. Nothing in this plan writes to a git service or a database.

**Tech Stack:** Unchanged from plan 1: Node 26 running TypeScript directly, npm, `node:test` and `node:assert`, `tsc --noEmit`, ESLint, `zod`, `yaml`, `diff`. No new dependency. Glob matching uses Node's own `path.posix.matchesGlob`.

**Spec:** `docs/superpowers/specs/2026-11-13-visto-ai-design.md`. Executors read both. Section numbers below refer to it. Plan 1 is `docs/superpowers/plans/2026-11-16-skeleton-and-findings-engine.md`; the decisions taken while it ran are in the notes file beside it.

## Scope

This is plan 2 of several. It covers build stage 3 of section 18.

| In this plan | Left to a later plan, and why |
|---|---|
| 6.1 the rubric and the categories. 6.2 blocks, parts, whole-file scores, the two rules, floors, the final score of a file. 6.3 the verdict and the `Human review` section. 5.3 block headers. 5.5 `files[]`. 5.6 step 2 for scores, and step 8 | **Scores across reviews and across pull requests** (6.2, D17): "a block is scored once", the worst-case rule, the 30-day reuse. They need stored scores, which arrive with the shell (stage 4). This plan produces the block and file hashes they key on, and shows every block as not scored |
| 11.2 the file a team commits, read from the default branch | **Inline notes** (6.3, D22): publishing, stage 4. **Automatic approval and the audit sample** (6.4, 6.5): stage 9. **Reverts:** stage 8 |
| 7.5 the history importer, local file output only. 6.6 labels, the three numbers, the backtest, the noise report | **The importer's database output, memory "as of" a case, `human_signal` records:** stage 8. The backtest passes each case's date as `asOf` and reads no memory. **Thread resolutions in the history file:** GitHub serves them only through an API that is not a GET, and the eval's source refuses anything else. They arrive with capture (stage 4) |
| 15.1 the findings replay run again with scoring in the call | **Live numbers and the UI:** stage 10 |

## Calls made in this plan

None of these is in the design. Each is the planner's call, listed so the owner can overrule it.

1. **Block header.** Each hunk opens with `### Block B<n> (<k> changed lines, not scored)`. Ids count hunks from 1 within a file.
2. **A split the rules do not allow.** `parts` on a block with 30 changed lines or fewer are not used to split it. The block takes the highest-scoring valid part's score. Nothing is lost and the score is never lower than the model meant.
3. **A score that is not a whole number from 0 to 100** is dropped, and the block or file counts as not scored (100%). It is not rounded and not retried.
4. **A missing reason at 40% or more** keeps the score. The entry is shown without a reason and the audit list records it.
5. **The file a team commits** (`.visto-ai.yml`) has one key, `human_review`, a list of glob patterns. A file that cannot be used (not YAML, an unknown key, a bad list) makes every file in the pull request need a person, and the review says why. A broken file must not quietly remove protection, and only a merge to the default branch can break it.
6. **Built-in floors** cover CI definitions of other common systems as well as GitHub's: the list is in Task 7.
7. **A file listed as changed whose two contents are identical and that was not renamed** (a mode change, usually) scores 100% as not scored. The design gives no low score to a file with no diff to read.
8. **The image and font rule** applies only when the file has no text diff. A file named `.png` that arrives with a text patch is read by the model.
9. **Links to a block's lines** are permanent links to the file at the reviewed commit: the head for added lines, the base for a block that only removes lines.
10. **The head a person first reviewed** is the commit of the earliest review or inline comment by someone who is neither the author nor a bot. A pull request nobody reviewed is replayed at its last head and carries no labels.
11. **A bot, in history,** is an account GitHub types as a bot or whose login ends in `[bot]`.
12. **Safety counts a block as left to the bot** when neither the block nor its file as a whole is flagged at the threshold.
13. **Noise is measured per hunk,** not per part, because two runs may split the same hunk differently.
14. **The history file stores the patches of the last head before the merge.** The stricter label needs them, and it keeps the label computable offline. The file therefore holds code and is private (15.3). The diff at the replayed head is not stored: the backtest fetches it, as the findings replay does.

## Global Constraints

Every constraint of plan 1 still holds. The ones that bite most often, and the new ones:

- **Runtime and language:** Node 26 or later, npm, no build step. Erasable TypeScript only: no `enum`, no `namespace`, no parameter properties. Type imports use `import type`. Relative imports end in `.ts`.
- **ASCII only in source and tests.** A non-ASCII character is written as an escape. After each task: `LC_ALL=C grep -rn -P '[^\x00-\x7F]' src contract test` prints nothing.
- **No test reaches the network.** `test/setup.ts` blocks it. Every boundary is stubbed.
- **Fixtures are synthetic and invented.** No real repository names, pull request numbers, logins or code. No task in this plan needs the predecessor's source.
- **Nothing internal in this repository,** including commit messages. Eval data stays outside the project folder; the CLI refuses paths inside it. No number from a paid run goes into a commit.
- **The engine does no I/O of its own.** `src/engine/**` imports nothing from `forge/github`, `eval`, or Node's file and network modules. `node:crypto` and `node:path` are allowed. Only `src/forge/github/**` and `src/eval/cli.ts` import the GitHub modules, and those make GET requests only.
- **Scores (6.1):** whole numbers from 0 to 100. Bands: 0 to 19, 20 to 39, 40 to 69, 70 to 89, 90 to 100. Default threshold 70. A reason is required only for 40 or more. A block may be split only when it has more than 30 changed lines.
- **Rules without the model (6.2):** a rename that keeps the file in its directory with no content change scores 30. A raster image or a font scores 10. A file the review did not cover, a file the model returned nothing for, and a block with no score count as 100.
- **Floors (6.2):** 100, checked against the old path and the new one.
- **Model-written text shown to people** (`reason`, `change_summary`) is one line of at most 300 characters: it goes through `inlineText`.
- **Limits (section 12):** unchanged. 200,000 input tokens per call, 6 batches, two at a time.
- **Git:** the repository is public and every push is public at once. Work on a branch named `stage-3`. Commit locally; push nothing without the owner's go-ahead. Before the first commit, `git config user.email` must print the owner's public address. A commit made by an agent ends with that agent's own co-author line.

## Review Focus

Inputs the spec implies and a person will meet, most likely first. Each has a test in the task named.

1. **A model answer that scores only some blocks, or leaves a file out.** Expect: the missing blocks count as 100% for this run, the file is flagged as a whole and is not covered, and there is no retry. (Task 8)
2. **A split whose parts overlap, are reversed, or name a line outside the block.** Expect: the bad part is dropped and the lines it would have covered stay without a score. (Tasks 3, 8)
3. **A file moved out of a protected path.** Expect: both kinds of floor are checked against the old path as well as the new one. (Tasks 7, 8)
4. **A `.visto-ai.yml` that cannot be used.** Expect: every file needs a person, and the review body says why. (Tasks 7, 10)
5. **A person's comment made on a commit other than the replayed head, or on a line outside every block.** Expect: it counts for the file only. (Task 13)

## File Structure

```
contract/review-contract.md                 gains the rubric and the files[] rules
config.example.yml  README.md               the score block, the new commands
src/config/schema.ts  load.ts               score.threshold
src/forge/types.ts                          Source.getDefaultBranchFile, the history types
src/forge/github/http.ts                    the GET-only transport, shared
src/forge/github/read-source.ts             uses http.ts, reads the default-branch file
src/forge/github/history-source.ts          merged pull requests, reviews, comments, compare
src/forge/github/links.ts                   a permanent link to lines of a file
src/engine/types.ts                         scores and verdict in the result
src/engine/score/types.ts                   categories, Block, BlockScore, FileScore, Verdict
src/engine/score/blocks.ts                  blocks of a diff, hashes, splitting
src/engine/score/rules.ts                   which files the model scores, which a rule scores
src/engine/score/floors.ts                  built-in floors, the team's file
src/engine/context/diff.ts  section.ts  build.ts  batches.ts     block headers, the moved-file section
src/engine/model/submit-review.ts           files[]
src/engine/reconcile/scores.ts              the model's scores checked, the final score of a file
src/engine/review.ts                        wires floors, scores and the verdict in
src/engine/render/body.ts                   the Human review section
src/eval/pool.ts                            the case pool, shared by replay and backtest
src/eval/history/file.ts  import.ts         the history file and the importer
src/eval/backtest/labels.ts  metrics.ts  noise.ts  run.ts
src/eval/cli.ts                             import-history, backtest, score-noise
```

Each module has its test beside it as `<name>.test.ts`.

## Shared Types

Task 3 creates `src/engine/score/types.ts` exactly as written. Later tasks import from it. `src/engine/types.ts` re-exports these types.

```ts
// src/engine/score/types.ts
import type { Side } from '../../forge/types.ts';
import type { Ranges } from '../context/diff.ts';

export const CATEGORIES = [
  'generated', 'formatting', 'documentation', 'test', 'weakened_test', 'disabled_check', 'dependency', 'rename', 'refactor',
  'fix', 'feature', 'business_rule', 'data_model', 'public_contract', 'permission', 'calculation', 'structure',
  'authentication', 'tenant_isolation', 'migration', 'billing', 'security_configuration', 'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Anchor { side: Side; line: number }
/** A block's changed lines on the new side when it adds any, else on the old side. */
export interface Span { side: Side; first: number; last: number }

export interface Block {
  id: string;         // 'B1', 'B2', ... in diff order. A part of a split block is 'B3.1'; its unscored remainder is 'B3.rest'
  hunk: string;       // the id of the diff hunk it came from: 'B3' for 'B3.1'
  hunkHash: string;   // the hash of that whole hunk; equal to `hash` for a block that is not a part
  hash: string;       // sha256, hex, of the block's changed lines, without line numbers
  anchors: Anchor[];  // every anchored line of the block, context included, in diff order
  changed: Anchor[];  // its added and removed lines, in diff order
  span: Span;
}

export interface ScoreEntry { score: number; category: Category; reason: string } // reason is '' when none was given

export interface BlockScore {
  id: string; hunk: string; hunkHash: string; hash: string;
  changedLines: number;
  span: Span;
  lines: Ranges;      // the block's anchored lines on each side, context included
  entry: ScoreEntry | null; // null: the model gave this block no score of its own
}

export type FileLevelSource =
  | 'builtin_floor' | 'team_floor' | 'team_file_invalid' | 'not_scored' | 'whole_file' | 'rule_rename' | 'rule_asset';

export interface FileScore {
  path: string; previousPath: string | null;
  diffHash: string | null;   // null when the file has no diff
  changeSummary: string;
  changedLines: number;
  blocks: BlockScore[];
  wholeFile: ScoreEntry | null; // the model's own whole-file score, when it gave one
  fileLevel: { score: number; source: FileLevelSource } | null; // the highest score that applies to the file as a whole
  finalScore: number;        // the highest of fileLevel and the blocks' own scores
  covered: boolean;          // 5.2: every block has a score, its own or its file's
}

export interface Verdict { threshold: number; needsHuman: boolean; highest: number }
```

Changes to existing shared types, each made by the task named:

```ts
// src/engine/types.ts
export interface RepoConfig { primaryBranches: string[]; scoreThreshold: number }          // Task 2
export interface ReviewResult { /* as now, plus: */ scores: FileScore[]; verdict: Verdict } // Task 9

// src/forge/types.ts
export interface Source {
  listFiles(pr: PullRequestInfo): Promise<ChangedFile[]>;
  getFileContent(pr: PullRequestInfo, path: string, sha: string): Promise<string | null>;
  /** The file's text on the repository's default branch; null when it is absent or is not text. */
  getDefaultBranchFile(pr: PullRequestInfo, path: string): Promise<string | null>;        // Task 7
}
```

---

### Task 1: Carry-overs from plan 1

**Files:**
- Modify: `src/engine/context/priority.test.ts`, `src/eval/cli.ts`, `src/eval/compare.ts` (comment only), `README.md`, `docs/superpowers/plans/2026-11-16-skeleton-and-findings-engine-notes.md`

Three items the notes of plan 1 left for this plan, and one found when its Task 19 ran.

- [ ] **Step 1: Make the size tie-break test reach the tie-break.** Size is part of the score, so two files tie on score with different sizes only when their paths differ too. A `src` segment adds 120, and `misc` adds nothing: `f('src/a.rb', 10)` and `f('misc/a.rb', 130)` both score 130. Add to `priority.test.ts`:

```ts
test('equal scores: the larger change comes first, then the path', () => {
  const out = orderByPriority([f('src/b.rb', 10), f('misc/a.rb', 130), f('src/a.rb', 10)]);
  assert.deepEqual(out.map((x) => x.path), ['misc/a.rb', 'src/a.rb', 'src/b.rb']);
});
```

- [ ] **Step 2: Run it.** `node --import ./test/setup.ts --test src/engine/context/priority.test.ts`. Expected: PASS (the code was already right). Then break the size comparison in `orderByPriority` by hand, see the new test fail, and restore it.
- [ ] **Step 3: Say what `--noise` is.** The compare command treats `--noise` as a second run of the **baseline**: the band is the distance between the two baseline runs. Plan 1's Task 19 passed a second candidate run, which gave wrong marks. Change the usage text in `cli.ts` to `usage: compare <baseline summary.json> <candidate summary.json> [--noise <second baseline summary.json>]`, update the test that pins the text, and fix the header comment of `compare.ts` to match.
- [ ] **Step 4: Bring the status up to date.** In `README.md`, section `Status`: the findings row reads "Built. Compared with the predecessor on a frozen case set", the replay row reads "Built and run", and the score row reads "In progress". In the notes file of plan 1, replace the line saying Task 19 was not run with: "Task 19 ran on 2026-11-17. The owner accepted the result with one caveat: one metric was worse on a small sample with no like-for-like baseline. The numbers are private." No number goes into either file.
- [ ] **Step 5: Run everything and commit.** `npm test && npm run typecheck && npm run lint`. Expected: PASS. `git add -A && git commit -m "chore: carry-overs from plan 1"`

### Task 2: Config: the score threshold

**Files:**
- Modify: `src/config/schema.ts`, `src/config/load.ts`, `src/engine/types.ts`, `config.example.yml`
- Test: `src/config/load.test.ts`

**Interfaces:**
- Produces: `RepoConfig.scoreThreshold: number`. In the file it is `repositories.defaults.score.threshold` and `repositories.overrides.<owner/name>.score.threshold`: a whole number from 1 to 100, default 70. `repoConfigFor` returns the override's value when it sets one.

The `score` block will also carry automatic approval, the audit share, the thread rule and inline notes (11.1). Those keys arrive with their stages; until then they are unknown keys and an error.

- [ ] **Step 1: Write the failing tests.**

```ts
test('the threshold defaults to 70', () => assert.equal(repoConfigFor(parse(base), 'acme/shop').scoreThreshold, 70));
test('a repository can lower it', () => {
  const c = parse(base + 'repositories:\n  defaults: { score: { threshold: 80 } }\n  overrides:\n    acme/shop: { score: { threshold: 40 } }\n');
  assert.equal(repoConfigFor(c, 'acme/shop').scoreThreshold, 40);
  assert.equal(repoConfigFor(c, 'acme/other').scoreThreshold, 80);
});
test('0, 101, 69.5 and an unknown key in score are errors', () => { /* each throws ConfigError naming repositories.defaults.score */ });
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add the `score` object to the defaults and to the override schema, map it to `scoreThreshold` in `load.ts`, and add the block with a one-line comment to `config.example.yml`. Every place that builds a `RepoConfig` in tests gains `scoreThreshold: 70`.
- [ ] **Step 4: Run everything.** `npm test && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: score threshold in the config"`

### Task 3: Blocks and their hashes

**Files:**
- Create: `src/engine/score/types.ts` (as in Shared Types), `src/engine/score/blocks.ts`
- Test: `src/engine/score/blocks.test.ts`

**Interfaces:**
- Consumes: `Hunk`, `HunkLine`, `parsePatch` from `context/diff.ts`.
- Produces:

```ts
export const SPLIT_ABOVE = 30; // a block may be split when it has more changed lines than this
export function blocksOf(hunks: Hunk[]): Block[];
export function fileDiffHash(hunks: Hunk[]): string | null; // null when there are no hunks
export function linesOf(block: Block): Ranges;              // its anchored lines per side, as ranges
export function parseAnchor(text: string): Anchor | null;   // 'R142' is RIGHT 142, 'L98' is LEFT 98; anything else is null
export function splitBlock(block: Block, parts: { first: Anchor; last: Anchor }[]): { parts: (Block | null)[]; rest: Block | null };
```

Rules:

- One block per hunk, ids `B1`, `B2`, ... in diff order. `hunk` equals `id` and `hunkHash` equals `hash`.
- **Hash.** sha256 over the block's changed lines in diff order, each written as its marker (`+` or `-`), its text and a line feed. Line numbers and context lines are not part of it, so a block that only moved has the same hash.
- `fileDiffHash` is the same hash over every changed line of the file, in order.
- `anchors`: an added or context line is `{ side: 'RIGHT', line: newLine }`; a removed line is `{ side: 'LEFT', line: oldLine }`. `meta` lines have no anchor.
- `span`: when the block has an added line, side RIGHT from its lowest to its highest added line. Otherwise side LEFT over its removed lines.
- **`splitBlock`.** Each requested part is checked in order. It is kept when both anchors are anchored lines of the block, `first` does not come after `last` in diff order, the lines from `first` to `last` hold at least one changed line, and it shares no line with a part already kept. A part that fails is `null` at its position. A kept part is a `Block` with id `<block id>.<position>`, counting positions from 1, the parent's `hunk` and `hunkHash`, and its own `hash`, `anchors`, `changed` and `span`. `rest` holds the block's changed lines that are in no kept part, with id `<block id>.rest`; its `anchors` are those changed lines. `rest` is `null` when every changed line is in a kept part. The caller decides whether a block may be split at all.

- [ ] **Step 1: Write the failing tests.**

```ts
const patch = (start: number) => [`@@ -${start},4 +${start},5 @@`, ' keep', '-old one', '+new one', '+new two', ' keep', ' keep'].join('\n');
test('one block per hunk, with anchors, changed lines and span', () => {
  const [b] = blocksOf(parsePatch(patch(10)));
  assert.equal(b!.id, 'B1');
  assert.deepEqual(b!.changed, [{ side: 'LEFT', line: 11 }, { side: 'RIGHT', line: 11 }, { side: 'RIGHT', line: 12 }]);
  assert.equal(b!.anchors.length, 6);
  assert.deepEqual(b!.span, { side: 'RIGHT', first: 11, last: 12 });
  assert.deepEqual(linesOf(b!), { RIGHT: [[10, 14]], LEFT: [[11, 11]] });
});
test('a block that only moved keeps its hash; a changed line changes it; a context line does not', () => {
  const at = (p: string) => blocksOf(parsePatch(p))[0]!.hash;
  assert.equal(at(patch(10)), at(patch(40)));
  assert.notEqual(at(patch(10)), at(patch(10).replace('+new two', '+new 2')));
  assert.equal(at(patch(10)), at(patch(10).replace(' keep', ' kept')));
  assert.match(at(patch(10)), /^[0-9a-f]{64}$/);
});
test('a block that only removes lines has a span on the old side', () => { /* span.side === 'LEFT' */ });
test('two hunks are B1 and B2, and the file hash covers both', () => { /* fileDiffHash differs from either block hash; null for [] */ });
test('parseAnchor', () => {
  assert.deepEqual(parseAnchor('R142'), { side: 'RIGHT', line: 142 });
  assert.deepEqual(parseAnchor(' L98 '), { side: 'LEFT', line: 98 });
  for (const bad of ['142', 'R0', 'R-1', 'X5', 'R1.5', '']) assert.equal(parseAnchor(bad), null);
});
```

For splitting, build a new file of 40 added lines (`@@ -0,0 +1,40 @@`):

```ts
test('two parts cover the block', () => {
  const out = splitBlock(b, [{ first: R(1), last: R(20) }, { first: R(21), last: R(40) }]);
  assert.deepEqual(out.parts.map((p) => p?.id), ['B1.1', 'B1.2']);
  assert.equal(out.rest, null);
  assert.equal(out.parts[0]!.hunk, 'B1');
  assert.equal(out.parts[0]!.hunkHash, b.hash);
  assert.notEqual(out.parts[0]!.hash, b.hash);
});
test('lines in no part are the rest', () => {
  const out = splitBlock(b, [{ first: R(1), last: R(20) }]);
  assert.equal(out.rest!.id, 'B1.rest');
  assert.equal(out.rest!.changed.length, 20);
});
test('an overlapping, a reversed and an outside part are dropped, and their lines go to the rest', () => {
  const out = splitBlock(b, [{ first: R(1), last: R(20) }, { first: R(15), last: R(30) }, { first: R(40), last: R(31) }, { first: R(35), last: R(99) }]);
  assert.deepEqual(out.parts.map((p) => p?.id ?? null), ['B1.1', null, null, null]);
  assert.equal(out.rest!.changed.length, 20);
});
test('a part that holds only context lines is dropped', () => { /* on the patch(10) block: first R13, last R14 */ });
```

- [ ] **Step 2: Run.** `node --import ./test/setup.ts --test src/engine/score/blocks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `types.ts` as written and `blocks.ts`. Re-export the score types from `src/engine/types.ts`.
- [ ] **Step 4: Run everything.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/engine && git commit -m "feat: blocks of a diff, their hashes and splitting"`

### Task 4: Which files the model scores, and how the diff shows blocks

**Files:**
- Create: `src/engine/score/rules.ts`
- Modify: `src/engine/context/diff.ts`, `section.ts`, `build.ts`, `batches.ts`
- Test: `src/engine/score/rules.test.ts`, and the tests beside each modified file

**Interfaces:**
- Consumes: `blocksOf`, `ChangedFile`, `FileContext`.
- Produces:

```ts
// src/engine/score/rules.ts
export type ScorePlan =
  | { kind: 'model' }                                        // it has a diff: the model scores its blocks
  | { kind: 'model_whole' }                                  // moved to another directory with no content change
  | { kind: 'rule'; score: 30; source: 'rule_rename' }
  | { kind: 'rule'; score: 10; source: 'rule_asset' }
  | { kind: 'none'; reason: 'no_diff' | 'too_large' | 'unchanged' }; // nothing to show the model
export function isAsset(path: string): boolean;
export function scorePlan(file: ChangedFile, skip: 'no_diff' | 'too_large' | 'unchanged' | null): ScorePlan;

// src/engine/context/build.ts
export interface FileContext { /* as now, plus: */ blocks: Block[]; plan: ScorePlan }
```

`scorePlan`:

| `skip` | The file | Plan |
|---|---|---|
| `null` | any | `model` |
| `unchanged` | renamed, and the old and new paths are in the same directory | `rule`, 30, `rule_rename` |
| `unchanged` | renamed to another directory | `model_whole` |
| `unchanged` | not renamed | `none`, `unchanged` |
| `no_diff` | `isAsset(path)` | `rule`, 10, `rule_asset` |
| `no_diff` | any other | `none`, `no_diff` |
| `too_large` | any | `none`, `too_large` |

`isAsset`: the extension, compared without regard to case, is one of `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `ico`, `tif`, `tiff`, `avif`, `heic`, `woff`, `woff2`, `ttf`, `otf`, `eot`. Not `svg`: it is text and can carry script.

What the model sees:

- `renderAnchoredDiff` writes one line before each hunk's `@@` line: `### Block B<n> (<k> changed lines, not scored)`, with `1 changed line` in the singular.
- `fileSection` writes one more header line after `deletions:` and the previous path. For a `model` file: `whole-file score: allowed`. For a `model_whole` file: `whole-file score: required. The file moved to another directory and its content did not change. Score the move itself.` A `model_whole` file has no diff, no full file and no test in its section.
- `packBatches` packs the files whose plan is `model` or `model_whole`. A `rule` file is not packed and not listed as not reviewed; it adds the audit entry `{ stage: 'context', action: 'scored_by_rule', subject: path, reason: <source> }`. A `none` file is handled as its `skip` is today: `unchanged` is an audit entry only, `no_diff` and `too_large` are listed as not reviewed.

- [ ] **Step 1: Write the failing tests.** `twoHunks` is the patch of Task 3 at line 10 followed by a second hunk with one changed line.

```ts
test('scorePlan', () => {
  const file = (path: string, previousPath: string | null = null, status: FileStatus = 'modified') => ({ path, previousPath, status, additions: 0, deletions: 0, patch: null });
  assert.deepEqual(scorePlan(file('src/a.ts'), null), { kind: 'model' });
  assert.deepEqual(scorePlan(file('src/b.ts', 'src/a.ts', 'renamed'), 'unchanged'), { kind: 'rule', score: 30, source: 'rule_rename' });
  assert.deepEqual(scorePlan(file('app/pages/b.ts', 'src/a.ts', 'renamed'), 'unchanged'), { kind: 'model_whole' });
  assert.deepEqual(scorePlan(file('b.ts', 'a.ts', 'renamed'), 'unchanged'), { kind: 'rule', score: 30, source: 'rule_rename' }); // both at the root
  assert.deepEqual(scorePlan(file('bin/run'), 'unchanged'), { kind: 'none', reason: 'unchanged' });
  assert.deepEqual(scorePlan(file('img/Logo.PNG'), 'no_diff'), { kind: 'rule', score: 10, source: 'rule_asset' });
  assert.deepEqual(scorePlan(file('img/logo.svg'), 'no_diff'), { kind: 'none', reason: 'no_diff' });
  assert.deepEqual(scorePlan(file('img/logo.png'), null), { kind: 'model' });          // it arrived with a text diff
  assert.deepEqual(scorePlan(file('dist/app.js'), 'too_large'), { kind: 'none', reason: 'too_large' });
});
test('each hunk opens with its block header', () => {
  const text = renderAnchoredDiff(parsePatch(twoHunks));
  assert.match(text, /^### Block B1 \(3 changed lines, not scored\)\n@@ /);
  assert.match(text, /\n### Block B2 \(1 changed line, not scored\)\n@@ /);
});
test('a file moved to another directory with the same content is sent with no diff and a required whole-file score', async () => {
  // source: the same content at both commits; status renamed, patch null
  const { contexts } = await buildFileContexts(pr, [moved], source);
  assert.deepEqual(contexts[0]!.plan, { kind: 'model_whole' });
  const section = fileSection(contexts[0]!, 1, 1, 'tok');
  assert.match(section, /previous path: src\/a\.ts/);
  assert.match(section, /whole-file score: required/);
  assert.doesNotMatch(section, /<<<data/);
  assert.equal(packBatches(contexts, 100000, 6).batches[0]!.files.length, 1);
});
test('a rename inside its directory is scored by rule: not packed, not listed, one audit entry', () => { /* batches [], notReviewed [], audit action 'scored_by_rule' */ });
test('a file with a diff says a whole-file score is allowed', () => { /* /whole-file score: allowed/ */ });
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `buildFileContexts` sets `blocks: blocksOf(hunks)` and `plan: scorePlan(file, skip)`. Update the existing tests that pin the diff text or build a `FileContext` by hand.
- [ ] **Step 4: Run everything.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: block headers in the diff and the score plan of a file"`

### Task 5: The contract: the rubric

**Files:**
- Modify: `contract/review-contract.md`, `contract/review-contract.test.ts`

The contract gains what section 6.1 and 6.2 ask of the model. Its wording is the builder's (section 22). It must state all of this, in the contract's existing plain style:

- `submit_review` takes three arguments. `files` has one entry for every file section: `path`, `change_summary` (one sentence on what changed in that file), and `blocks`.
- A line `### Block B3 (...)` opens a block and gives its id. `blocks` has one entry for each block marked `not scored`, by `id`, and none for a block marked as scored.
- A `score` is a whole number from 0 to 100. It says how much the change needs a person's judgement. It is not the chance of a bug and not a probability; findings cover bugs. Pick the band from what the code change does, then a position inside the band. What the description or a code comment claims about the change is not evidence.
- The five bands with their examples, as the table in 6.1.
- A dependency added or moved to another version is a decision, in the manifest and in the lock file alike. Removing, skipping or loosening a test or an assertion, and switching off a lint rule, a type check or a CI step, are decisions.
- `category` is one value from the list of 6.1. `reason` is one sentence, required when the score is 40 or more and left out below that.
- A block with more than 30 changed lines may be returned as `parts` instead of one score. Each part has `first` and `last`, anchors copied from the diff, and its own `score`, `category` and `reason`. Parts do not overlap. A changed line in no part has no score.
- A file gets a score of its own, beside `path`, in three cases only: every block of it is the same kind of change (then the blocks need no scores); the decision lies in how several blocks fit together (then score the blocks too); or the file's header says a whole-file score is required.
- A finding does not make a block score high, and a high score is not a finding.

- [ ] **Step 1: Write the failing tests.**

```ts
import { CATEGORIES } from '../src/engine/score/types.ts';
test('answers with three arguments', () => { has(/`files`/); has(/`change_summary`/); });
test('the score is need for judgement, not bug likelihood', () => { has(/not a probability/i); has(/judgement/i); });
test('names the five bands', () => { for (const b of ['0 to 19', '20 to 39', '40 to 69', '70 to 89', '90 to 100']) has(new RegExp(b)); });
test('names every category', () => { for (const c of CATEGORIES) has(new RegExp('`' + c + '`')); });
test('a reason is required from 40', () => has(/40 or more/));
test('a block may be split above 30 changed lines', () => { has(/more than 30 changed lines/); has(/`parts`/); has(/`first`/); has(/`last`/); });
test('dependencies and weakened safeguards are decisions', () => { has(/lock file/i); has(/skipp/i); has(/lint/i); });
test('a whole-file score has three cases', () => has(/whole-file score is required/i));
test('claims in the description are not evidence', () => has(/not evidence/i));
test('stays under 150 lines', () => assert.ok(text.split('\n').length < 150));
```

Remove the old `stays under 90 lines` test. Every other existing test stays and still passes.

- [ ] **Step 2: Run.** `node --import ./test/setup.ts --test contract/review-contract.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the contract text.**
- [ ] **Step 4: Run everything.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: the score rubric in the contract"`

### Task 6: `submit_review`: `files[]`

**Files:**
- Modify: `src/engine/model/submit-review.ts`
- Test: `src/engine/model/submit-review.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RawPart { first: string; last: string; score: number; category: string; reason?: string }
export interface RawBlock { id: string; score?: number; category?: string; reason?: string; parts?: RawPart[] }
export interface RawFile { path: string; change_summary: string; score?: number; category?: string; reason?: string; blocks: RawBlock[] }
export interface SubmitReviewArgs { overview: string; findings: RawFinding[]; files: RawFile[] }
```

The schema checks shape only. Whether a score is a whole number in range, whether a category is on the list, and whether an id names a real block are checked in reconcile (Task 8), where a bad value costs one block and not the whole answer.

- `files` is required and is an array, possibly empty. Without it the answer is rejected and the one retry is used.
- In a file: `path` is a non-empty string after trimming, `change_summary` a string, `blocks` an array that defaults to empty. `score` is a number when present; `category` and `reason` are strings when present.
- In a block: `id` is a non-empty string. In a part: `first`, `last` and `category` are strings and `score` is a number.
- Unknown keys inside `files` are ignored. `findings` stays strict, as now.
- The tool's description becomes: `Submit your review of the pull request. Call this tool exactly once, with your overview, all of your findings, and one entry for each file.`

- [ ] **Step 1: Write the failing tests.**

```ts
const ok = { overview: 'Changes src/a.ts.', findings: [], files: [{ path: 'src/a.ts', change_summary: 'Adds a guard.', blocks: [{ id: 'B1', score: 45, category: 'fix', reason: 'Changes when the job runs.' }] }] };
test('a full answer parses', () => assert.deepEqual(parse(ok).value.files[0]!.blocks[0], { id: 'B1', score: 45, category: 'fix', reason: 'Changes when the job runs.' }));
test('files is required', () => assert.match(reasonOf({ overview: 'o', findings: [] }), /^files: /));
test('a score written as text is rejected, naming where', () => assert.match(reasonOf(withScore('45')), /^files\[0\]\.blocks\[0\]\.score: /));
test('an unknown key inside files is ignored', () => assert.ok(parse(withExtraKey).ok));
test('a block may carry parts instead of a score', () => { /* parts: [{ first: 'R1', last: 'R20', score: 30, category: 'test' }] parses */ });
test('blocks defaults to empty', () => { /* a file with no blocks key parses with blocks: [] */ });
test('the tool schema names files', () => assert.ok(JSON.stringify(submitReviewTool).includes('"files"')));
test('an unknown key in a finding is still rejected', () => { /* unchanged behaviour */ });
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Every test in the suite that builds an answer gains `files: []`.
- [ ] **Step 4: Run everything.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: files and block scores in submit_review"`

### Task 7: Floors, and the file a team commits

**Files:**
- Create: `src/engine/score/floors.ts`
- Modify: `src/forge/types.ts`, `src/forge/github/read-source.ts`
- Test: `src/engine/score/floors.test.ts`, `src/forge/github/read-source.test.ts`

**Interfaces:**
- Produces:

```ts
// src/engine/score/floors.ts
export const REPO_FILE = '.visto-ai.yml';
export interface TeamFloors { patterns: string[]; invalid: string | null } // invalid: a short code when the file cannot be used
export function parseRepoFile(text: string | null): TeamFloors;
export function builtinFloor(path: string): boolean;
export function floorFor(file: { path: string; previousPath: string | null }, floors: TeamFloors): 'builtin_floor' | 'team_floor' | 'team_file_invalid' | null;
```

and `Source.getDefaultBranchFile` (Shared Types).

**The file.** One key, `human_review`: a list of path patterns.

```yaml
# .visto-ai.yml
human_review:
  - db/migrate/
  - "app/**/policy.rb"
```

`parseRepoFile`:

- `null` (no file), an empty file, or a file holding only comments: no patterns, valid.
- More than 20,000 characters: `invalid: 'too_large'`. Not YAML: `'not_yaml'`. Not a mapping: `'not_a_mapping'`. A key other than `human_review`: `'unknown_key'`. `human_review` that is not a list of at most 200 strings, each 1 to 200 characters after trimming: `'bad_patterns'`.
- Each pattern is trimmed, loses one leading `/`, and gains `**` when it ends in `/`.

A path matches a pattern by `path.posix.matchesGlob(path, pattern)`.

**Built-in floors.** `builtinFloor` is true for exactly: `.visto-ai.yml`; `CODEOWNERS`, `.github/CODEOWNERS`, `docs/CODEOWNERS`, `.gitlab/CODEOWNERS`; `.gitlab-ci.yml`, `Jenkinsfile`, `azure-pipelines.yml`, `bitbucket-pipelines.yml`, `.travis.yml`; and any path under `.github/workflows/`, `.circleci/` or `.buildkite/`. Paths are compared as written, from the repository root.

**`floorFor`** checks `path` and, when it is not null, `previousPath` (6.2). In order: a built-in floor on either path gives `'builtin_floor'`; an invalid file gives `'team_file_invalid'` for every file; a team pattern on either path gives `'team_floor'`; otherwise `null`.

**The source.** GitHub serves the default branch when no `ref` is given: `GET /repos/{owner}/{repo}/contents/{path}`, with the same accept header, 404 handling, binary check and size limit as `getFileContent`.

- [ ] **Step 1: Write the failing tests.**

```ts
test('built-in floors', () => {
  for (const p of ['.visto-ai.yml', 'CODEOWNERS', 'docs/CODEOWNERS', '.github/workflows/ci.yml', '.circleci/config.yml', 'Jenkinsfile']) assert.equal(builtinFloor(p), true, p);
  for (const p of ['sub/.visto-ai.yml', 'src/CODEOWNERS', '.github/dependabot.yml', 'docs/Jenkinsfile.md']) assert.equal(builtinFloor(p), false, p);
});
test('patterns are normalised', () => {
  assert.deepEqual(parseRepoFile('human_review:\n  - db/migrate/\n  - " /app/**/policy.rb "\n'), { patterns: ['db/migrate/**', 'app/**/policy.rb'], invalid: null });
});
test('no file, an empty file and a file of comments have no patterns', () => {
  for (const t of [null, '', '# nothing yet\n']) assert.deepEqual(parseRepoFile(t), { patterns: [], invalid: null });
});
test('a file that cannot be used says why', () => {
  assert.equal(parseRepoFile('human_review: [unclosed').invalid, 'not_yaml');
  assert.equal(parseRepoFile('- a\n- b\n').invalid, 'not_a_mapping');
  assert.equal(parseRepoFile('human_review: [a]\nthreshold: 10\n').invalid, 'unknown_key');
  assert.equal(parseRepoFile('human_review: db/migrate\n').invalid, 'bad_patterns');
  assert.equal(parseRepoFile('human_review: [""]\n').invalid, 'bad_patterns');
  assert.equal(parseRepoFile('x'.repeat(20001)).invalid, 'too_large');
});
const floors = parseRepoFile('human_review:\n  - db/migrate/\n');
test('a file moved out of a protected path is still floored', () => {
  assert.equal(floorFor({ path: 'lib/old_migration.rb', previousPath: 'db/migrate/1_add.rb' }, floors), 'team_floor');
  assert.equal(floorFor({ path: 'db/migrate/2_drop.rb', previousPath: null }, floors), 'team_floor');
  assert.equal(floorFor({ path: 'lib/x.rb', previousPath: null }, floors), null);
});
test('a workflow moved elsewhere is still a built-in floor', () => assert.equal(floorFor({ path: 'old/ci.yml', previousPath: '.github/workflows/ci.yml' }, floors), 'builtin_floor'));
test('an unusable file floors every file', () => assert.equal(floorFor({ path: 'lib/x.rb', previousPath: null }, parseRepoFile('- a\n')), 'team_file_invalid'));
```

For the source: `getDefaultBranchFile(pr, '.visto-ai.yml')` requests `/repos/acme/shop/contents/.visto-ai.yml` with no `ref` in the URL, returns the text, returns `null` on 404, and throws `github_500` after one retry on a 500.

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Every stub of `Source` in the tests gains `getDefaultBranchFile`, returning `null`.
- [ ] **Step 4: Run everything.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: floors and the file a team commits"`

### Task 8: Reconcile: the model's scores and the final score of a file

**Files:**
- Create: `src/engine/reconcile/scores.ts`
- Test: `src/engine/reconcile/scores.test.ts`

**Interfaces:**
- Consumes: `FileContext` (with `blocks`, `plan`), `SubmitReviewArgs`, `normalizePath`, `splitBlock`, `parseAnchor`, `linesOf`, `fileDiffHash`, `SPLIT_ABOVE`, `floorFor`, `inlineText`, `CATEGORIES`.
- Produces:

```ts
export function reconcileScores(
  answers: { value: SubmitReviewArgs; files: string[] }[], // each answer with the paths of the batch that produced it
  contexts: FileContext[],
  notRead: ReadonlySet<string>, // paths that were due to be read and were not: too large, over the batch limit, in a failed batch
  floors: TeamFloors,
): { scores: FileScore[]; audit: AuditEntry[] };
export function verdictOf(scores: FileScore[], threshold: number): Verdict;
```

One `FileScore` per context, in the order of `contexts`. Audit entries have `stage: 'reconcile'`, an `action` from the list below, the path (and the block id, as `path B3`) as `subject`.

1. **Which entry counts.** The first `files[]` entry, across the answers in order, whose path normalises to this file and whose answer's batch held the file. A path that is no file of the pull request: `score_path_not_in_pull_request`. A path outside that answer's batch: `score_path_not_in_batch`. A second entry for a file: `score_duplicate`.
2. **A valid score** is a whole number from 0 to 100. Anything else is dropped with `score_invalid`. A category outside `CATEGORIES` becomes `other`. `reason` and `change_summary` go through `inlineText`. A score of 40 or more with an empty reason is kept and adds `reason_missing`.
3. **Whole-file score.** The entry's own `score`, when valid, is `wholeFile`.
4. **Blocks.** Start from the context's blocks, each with `entry: null`. For each item of the entry's `blocks`:
   - an `id` that is no block of the file: `block_not_in_file`; an `id` seen before: `block_duplicate`;
   - with a `score`: the block's entry, when valid. `parts` on the same item are ignored;
   - with `parts` only: each part needs anchors that `parseAnchor` accepts and a valid score, or it is dropped with `part_invalid`. When the block has more than 30 changed lines it is split by `splitBlock`: each kept part becomes a `BlockScore` with its entry, a part `splitBlock` drops adds `part_invalid`, and `rest` becomes a `BlockScore` with `entry: null`. The parts and the rest replace the block, in the block's place. When the block has 30 changed lines or fewer it is not split: it takes the entry of the highest-scoring valid part, the first on a tie, and adds `split_ignored`.
   A block left with `entry: null` adds `block_not_scored`, unless the file has a whole-file score.
5. **File level.** The candidates, each a score and a source:
   - `floorFor(file, floors)`: 100 with that source;
   - a `rule` plan: its score and source;
   - `not_scored`, 100, when any of these holds: the plan is `none`; the path is in `notRead`; the plan is `model` or `model_whole` and no entry counted; the plan is `model_whole` and there is no whole-file score; the plan is `model`, there is no whole-file score, and a block has `entry: null`;
   - `whole_file`: the whole-file score.
   `fileLevel` is the highest candidate. On a tie the source is the first of `builtin_floor`, `team_floor`, `team_file_invalid`, `not_scored`, `whole_file`, `rule_rename`, `rule_asset`. With no candidate it is `null`.
6. **`finalScore`** is the highest of `fileLevel` and the blocks' own scores.
7. **`covered`.** A `rule` plan is covered. A `none` plan is not. Otherwise the file is covered when an entry counted, the path is not in `notRead`, and either it has a whole-file score or every block has an entry.
8. `diffHash` is `fileDiffHash(hunks)`. `changedLines` is the sum over its blocks, or `additions + deletions` for a file with no blocks. `BlockScore.lines` is `linesOf(block)`.

`verdictOf`: `highest` is the highest `finalScore`, 0 with no files. `needsHuman` is `highest >= threshold`.

- [ ] **Step 1: Write the failing tests.** Build contexts with a helper that takes a path and a patch and fills `blocks` and `plan` as Task 4 does. `twoHunks` is the patch of Task 3 at line 10 (changed lines `L11`, `R11`, `R12`) followed by a second hunk with one changed line. `fortyAdded` is a new file of 40 added lines.

```ts
test('every block scored: the file takes the highest', () => {
  const [s] = run([file('src/a.ts', [b('B1', 20, 'rename'), b('B2', 75, 'business_rule', 'Changes who may refund.')])], [ctx('src/a.ts', twoHunks)]).scores;
  assert.equal(s!.finalScore, 75);
  assert.equal(s!.fileLevel, null);
  assert.equal(s!.covered, true);
  assert.deepEqual(s!.blocks.map((x) => x.entry?.score), [20, 75]);
});
test('a skipped block counts as 100 and the file is not covered', () => {
  const out = run([file('src/a.ts', [b('B1', 20, 'rename')])], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.fileLevel, { score: 100, source: 'not_scored' });
  assert.equal(out.scores[0]!.covered, false);
  assert.ok(out.audit.some((a) => a.action === 'block_not_scored' && a.subject === 'src/a.ts B2'));
});
test('a whole-file score stands for blocks with none', () => {
  const [s] = run([{ ...file('pnpm-lock.yaml', []), score: 72, category: 'dependency', reason: 'Moves a library to a new major version.' }], [ctx('pnpm-lock.yaml', twoHunks)]).scores;
  assert.deepEqual(s!.fileLevel, { score: 72, source: 'whole_file' });
  assert.equal(s!.finalScore, 72);
  assert.equal(s!.covered, true);
});
test('a block above the whole-file score still counts', () => { /* whole file 45, B1 80: finalScore 80 */ });
test('a file the model returned nothing for is 100, not_scored', () => { /* answers hold no entry for it */ });
test('a file that was not read is 100 even with an entry', () => { /* path in notRead */ });
test('bad values cost one block', () => {
  const out = run([file('src/a.ts', [b('B1', 45.5, 'fix', 'x'), b('B2', 101, 'fix', 'x')])], [ctx('src/a.ts', twoHunks)]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => x.entry), [null, null]);
  assert.equal(out.audit.filter((a) => a.action === 'score_invalid').length, 2);
});
test('an unknown category is stored as other', () => { /* category 'nonsense' */ });
test('a reason is cleaned to one line, and a missing one at 70 is kept and recorded', () => {
  const out = run([file('src/a.ts', [b('B1', 70, 'permission'), b('B2', 45, 'fix', 'first line\nsecond line')])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.entry!.reason, '');
  assert.equal(out.scores[0]!.blocks[1]!.entry!.reason, 'first line second line');
  assert.ok(out.audit.some((a) => a.action === 'reason_missing'));
});
test('a long block is split into parts, each a block of its own', () => {
  const out = run([file('src/new.ts', [{ id: 'B1', parts: [part('R1', 'R20', 30, 'test'), part('R21', 'R40', 80, 'data_model', 'Adds a table.')] }])], [ctx('src/new.ts', fortyAdded)]);
  assert.deepEqual(out.scores[0]!.blocks.map((x) => [x.id, x.hunk, x.entry?.score]), [['B1.1', 'B1', 30], ['B1.2', 'B1', 80]]);
  assert.equal(out.scores[0]!.finalScore, 80);
});
test('a dropped part leaves its lines without a score', () => { /* parts R1-R20 and R15-R30: blocks B1.1 and B1.rest (entry null), fileLevel not_scored, audit part_invalid */ });
test('parts on a short block are not a split: the highest part stands', () => {
  const out = run([file('src/a.ts', [{ id: 'B1', parts: [part('R11', 'R11', 30, 'rename'), part('R12', 'R12', 75, 'calculation', 'Changes rounding.')] }, b('B2', 10, 'formatting')])], [ctx('src/a.ts', twoHunks)]);
  assert.equal(out.scores[0]!.blocks[0]!.id, 'B1');
  assert.equal(out.scores[0]!.blocks[0]!.entry!.score, 75);
  assert.ok(out.audit.some((a) => a.action === 'split_ignored'));
});
test('a rename inside its directory scores 30 by rule and is covered', () => { /* plan rule: fileLevel { 30, rule_rename }, covered true, no entry needed */ });
test('a floor beats a rule, on the old path too', () => { /* the same rename, previousPath under db/migrate/: fileLevel { 100, team_floor } */ });
test('a moved file needs its whole-file score', () => { /* plan model_whole: with score 60 -> { 60, whole_file }; without -> { 100, not_scored } */ });
test('scores for another batch or another pull request are dropped', () => { /* audit score_path_not_in_batch, score_path_not_in_pull_request */ });
test('the verdict', () => {
  assert.deepEqual(verdictOf([score(69)], 70), { threshold: 70, needsHuman: false, highest: 69 });
  assert.deepEqual(verdictOf([score(69), score(70)], 70), { threshold: 70, needsHuman: true, highest: 70 });
  assert.deepEqual(verdictOf([], 70), { threshold: 70, needsHuman: false, highest: 0 });
});
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run everything.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/engine/reconcile && git commit -m "feat: reconcile scores and the final score of a file"`

### Task 9: Engine: scores and the verdict in the result

**Files:**
- Modify: `src/engine/types.ts`, `src/engine/review.ts`
- Test: `src/engine/review.test.ts`

**Interfaces:**
- Consumes: `parseRepoFile`, `REPO_FILE`, `reconcileScores`, `verdictOf`.
- Produces: `ReviewResult.scores` and `ReviewResult.verdict` on every result.

In `review()`:

- The repository file is read once, in the context stage, through the guarded source: `parseRepoFile(await source.getDefaultBranchFile(pr, REPO_FILE))`. When the source rejects, the review fails at the context stage with the source's code, as any other source error does.
- After the findings are reconciled: `reconcileScores(answers, contexts, notRead, floors)`, where `notRead` holds the paths of `packed.notReviewed` and of every failed batch. Its audit entries join the result's. `verdict` is `verdictOf(scores, input.repoConfig.scoreThreshold)`.
- A pull request with no files: `scores: []` and `verdictOf([], threshold)`.
- A pull request with files and nothing to send (no batch): the scores are still computed, from rules, floors and `not_scored`, with no answers.
- A failed review: `scores: []` and `verdict: { threshold, needsHuman: true, highest: 100 }`. A review that did not finish never says a pull request needs no person.

- [ ] **Step 1: Write the failing tests.** With the stub source and a stub model that answers with `files[]`:

```ts
test('a review returns scores and a verdict', async () => {
  const r = await review(input, deps(answer({ files: [file('src/a.ts', [b('B1', 45, 'fix', 'Changes the retry delay.')])] })));
  assert.equal(r.scores.length, 1);
  assert.deepEqual(r.verdict, { threshold: 70, needsHuman: false, highest: 45 });
});
test('the threshold comes from the repository config', async () => { /* scoreThreshold 40: needsHuman true */ });
test('a model that returns no files sends the pull request to a person', async () => { /* files: [] -> highest 100, needsHuman true */ });
test('a team floor is read from the default branch', async () => {
  // source.getDefaultBranchFile returns 'human_review:\n  - src/\n'
  assert.deepEqual(r.scores[0]!.fileLevel, { score: 100, source: 'team_floor' });
});
test('an unusable repository file floors every file', async () => { /* returns '- a\n': source team_file_invalid, needsHuman true */ });
test('a failed read of the repository file fails the review at the context stage', async () => { /* rejects with Error('github_500'): status failed, failure { stage: 'context', code: 'github_500' }, needsHuman true */ });
test('a failed review needs a person', async () => { /* the model rejects every call: verdict.needsHuman true, scores [] */ });
test('no files: nothing to judge', async () => { /* verdict { threshold: 70, needsHuman: false, highest: 0 } */ });
test('files in a failed batch are not scored', async () => { /* two batches, one fails: its files have fileLevel not_scored */ });
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run everything.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: scores and the verdict in the review result"`

### Task 10: Rendering: the `Human review` section

**Files:**
- Create: `src/forge/github/links.ts`
- Modify: `src/engine/render/body.ts`
- Test: `src/engine/render/body.test.ts`, `src/forge/github/links.test.ts`

**Interfaces:**
- Produces:

```ts
// src/forge/github/links.ts
export function githubLineUrl(pr: PullRequestInfo, file: { path: string; previousPath: string | null }, span: Span): string;

// src/engine/render/body.ts: Meta gains
lineUrl: ((file: { path: string; previousPath: string | null }, span: Span) => string) | null;
```

`githubLineUrl`: a RIGHT span links the file at the head, `https://github.com/<owner>/<repo>/blob/<headSha>/<path>#L<first>-L<last>`. A LEFT span links it at the base, under `previousPath` when there is one. Each path segment is URL-encoded. A one-line span ends in `#L<first>`.

**The section** comes after `Summary`. With nothing at or above the threshold it is one line:

```
## Human review

Nothing here is at or above 70%. The highest score is 45%.
```

Otherwise:

```
## Human review

A person should read these parts. Each is at or above 70%.

**`src/billing/invoice.ts`**
- [lines 40-58](<url>), 85% `calculation` <dash> Changes how tax is rounded.
- [old lines 12-14](<url>), 72% `business_rule` <dash> Removes the refund limit.

**`db/migrate/20260101_add_plan.rb`**
- whole file, 100% <dash> a path the team marked as always needing a person
```

`<dash>` is an em dash. Rules:

- Files are ordered by final score, highest first, then by path. A file appears when its `fileLevel` or one of its blocks is at or above the threshold.
- A file flagged as a whole (`fileLevel.score >= threshold`) gets a `whole file` line first. Its text by source: `builtin_floor`: `it changes the reviewer's own file, code owners or CI`. `team_floor`: `a path the team marked as always needing a person`. `team_file_invalid`: `the repository's .visto-ai.yml cannot be used, so every file needs a person`. `not_scored`: `not read, or left without a score`. `rule_rename` and `rule_asset`: `scored by rule`. `whole_file`: the category in a code span, then the dash and the reason.
- Then its blocks at or above the threshold, highest first, then in diff order. The label is `line 40` for a one-line span, `lines 40-58` otherwise, with `old ` in front for a LEFT span. With `lineUrl` null the label is plain text.
- The dash and the reason are left out when the reason is empty. That is always so below 40 (6.3).
- At most 50 lines of entries are written; then `- <ellipsis>and N more.`
- `Overall` gains a last sentence: `Human review: needed (highest score 85%).` or `Human review: not needed (highest score 45%).`
- A failed review's body gains the line `Human review: needed, because the review did not finish.`
- Every model-written string passes through `noComment`, as the rest of the body does.

- [ ] **Step 1: Write the failing tests.** Pin the two section texts above exactly, built from a result with those scores and `lineUrl: (f, s) => 'u:' + f.path + ':' + s.first`. Add:

```ts
test('github links', () => {
  assert.equal(githubLineUrl(pr, { path: 'src/a b.ts', previousPath: null }, { side: 'RIGHT', first: 40, last: 58 }), 'https://github.com/acme/shop/blob/' + pr.headSha + '/src/a%20b.ts#L40-L58');
  assert.equal(githubLineUrl(pr, { path: 'new/a.ts', previousPath: 'old/a.ts' }, { side: 'LEFT', first: 12, last: 12 }), 'https://github.com/acme/shop/blob/' + pr.baseSha + '/old/a.ts#L12');
});
test('without a link builder the label is plain text', () => { /* '- lines 40-58, 85% ' */ });
test('a block below 40 at a low threshold shows its category and no reason', () => { /* threshold 20: '- line 7, 25% `rename`' and nothing after */ });
test('an unusable repository file is named', () => { /* 'whole file, 100% ... .visto-ai.yml cannot be used' */ });
test('the list stops at 50 entries', () => { /* 60 flagged blocks: 50 lines, then 'and 10 more.' */ });
test('Overall says whether a person is needed', () => { /* both sentences */ });
test('a failed review says a person is needed', () => { /* the failed body ends with that line */ });
test('a reason cannot open an HTML comment', () => { /* reason 'x <!-- y' appears as 'x &lt;!-- y' */ });
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run everything.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: the Human review section of the review body"`

### Task 11: GitHub history source

**Files:**
- Create: `src/forge/github/http.ts`, `src/forge/github/history-source.ts`
- Modify: `src/forge/types.ts`, `src/forge/github/read-source.ts`
- Test: `src/forge/github/history-source.test.ts`; the tests of `read-source.ts` pass unchanged

**Interfaces:**
- Produces, in `src/forge/types.ts`:

```ts
export type Association = 'owner' | 'member' | 'collaborator' | 'none';
export interface RepoRef { owner: string; repo: string }
export interface MergedPullRequest {
  number: number; title: string; description: string; author: string; authorIsBot: boolean;
  baseBranch: string; headBranch: string; baseSha: string; headSha: string; mergedAt: string;
}
export interface HumanReview {
  id: string; author: string; authorIsBot: boolean; association: Association;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed'; commit: string | null; at: string; body: string;
}
export interface HumanInlineComment {
  id: string; author: string; authorIsBot: boolean; association: Association; at: string;
  commit: string; path: string; side: Side; line: number | null; startLine: number | null; fileLevel: boolean; replyTo: string | null; body: string;
}
export interface GeneralComment { id: string; author: string; authorIsBot: boolean; association: Association; at: string; body: string }
export interface Comparison { mergeBase: string; files: ChangedFile[] }
export interface HistorySource {
  listMergedPullRequests(repo: RepoRef, window: { since: string; until: string }, limit: number): Promise<MergedPullRequest[]>;
  listReviews(repo: RepoRef, number: number): Promise<HumanReview[]>;
  listInlineComments(repo: RepoRef, number: number): Promise<HumanInlineComment[]>;
  listGeneralComments(repo: RepoRef, number: number): Promise<GeneralComment[]>;
  /** null when either commit can no longer be read */
  compare(repo: RepoRef, base: string, head: string): Promise<Comparison | null>;
}
```

and `createGithubHistorySource(opts: { token: string; fetch: typeof fetch; apiBase?: string }): HistorySource`.

`http.ts` holds what `read-source.ts` does today to send a request: GET only (anything else throws `ReadOnlyViolation`), the headers, one retry on a 5xx or a network failure, the owner and repository name check. It adds `paged(url, maxPages)`: it requests `page=1`, `page=2`, ... with `per_page=100` until a page has fewer than 100 items, and throws `github_too_many_pages` past `maxPages`. `read-source.ts` is changed to use it, with no change in behaviour.

Requests, all GET:

| Method | Request | Notes |
|---|---|---|
| `listMergedPullRequests` | `/repos/{o}/{r}/pulls?state=closed&sort=updated&direction=desc` | Keeps items whose `merged_at` is set and inside `[since, until)`. Stops at the first item whose `updated_at` is before `since`, at `limit` kept items, or after 20 pages |
| `listReviews` | `/repos/{o}/{r}/pulls/{n}/reviews` | Skips a review whose state is `PENDING`. `commit` is `commit_id` |
| `listInlineComments` | `/repos/{o}/{r}/pulls/{n}/comments` | `commit` is `original_commit_id`, `line` is `original_line`, `startLine` is `original_start_line`, `fileLevel` is `subject_type === 'file'`, `replyTo` is `in_reply_to_id` |
| `listGeneralComments` | `/repos/{o}/{r}/issues/{n}/comments` | |
| `compare` | `/repos/{o}/{r}/compare/{base}...{head}?per_page=1` | `mergeBase` is `merge_base_commit.sha`. A 404 is `null`. 300 files or more throws `too_many_files` |

Mapping: `authorIsBot` is true when `user.type` is `Bot` or the login ends in `[bot]`. A missing user is the author `ghost`, not a bot. `author_association` `OWNER`, `MEMBER` and `COLLABORATOR` map to their lower-case names, anything else to `none`. Review states are lower-cased; an unknown state is `commented`. Ids are strings. Lists allow 10 pages. Failures: `github_<status>`, `github_network`, `github_bad_response`.

- [ ] **Step 1: Write the failing tests,** with invented fixtures served by a stub `fetch`: two pages of pull requests where the window keeps two and the listing stops at an item updated before `since`; a merged item outside the window is left out; an unmerged closed item is left out; a review by `dependabot[bot]` and one by a user of type `Bot` are both bots; a pending review is skipped; an inline comment keeps its original commit and line when `line` is `null`; a file-level comment; a reply carries `replyTo`; a deleted user becomes `ghost`; `compare` returns the merge base and the files, and `null` on 404; a list of more than 10 pages throws `github_too_many_pages`; every request the stub saw was a GET.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run everything.** Expected: PASS, the read source's tests included.
- [ ] **Step 5: Commit.** `git commit -am "feat: read-only GitHub history source"`

### Task 12: The history file and the importer

**Files:**
- Create: `src/eval/history/file.ts`, `src/eval/history/import.ts`
- Modify: `src/eval/cli.ts`, `package.json`
- Test: `src/eval/history/file.test.ts`, `src/eval/history/import.test.ts`, `src/eval/cli.test.ts`

**Interfaces:**
- Consumes: `HistorySource` and its types, `stripControl`.
- Produces:

```ts
// src/eval/history/file.ts
export interface HistoryActivity {
  kind: 'review' | 'inline' | 'comment';
  id: string; author: string; bot: boolean; association: Association; at: string; body: string;
  state?: HumanReview['state']; commit?: string | null;                                         // review, inline
  path?: string; side?: Side; line?: number | null; start_line?: number | null; file_level?: boolean; reply_to?: string | null; // inline
}
export interface HistoryCase {
  version: 1;
  repo: string; pr_number: number; title: string; body: string; author: string; branch: string; base_branch: string; merged_at: string;
  review_head: string; review_base: string; review_at: string; reviewed_by_person: boolean;
  final_head: string; final_base: string;
  final_files: { path: string; previous_path: string | null; status: FileStatus; patch: string | null }[];
  activity: HistoryActivity[];
}
export function historyKey(c: HistoryCase): string;              // '<repo>#<pr_number>@<first 12 characters of review_head>'
export function parseHistory(jsonl: string): HistoryCase[];      // a bad line throws Error('bad_history_line_<n>')
export function loadHistory(path: string): { cases: HistoryCase[]; sha256: string };
export function serializeCase(c: HistoryCase): string;           // one line of JSON

// src/eval/history/import.ts
export type ImportSkip = 'head_unreadable' | 'too_many_files' | 'too_many_pages';
export function firstReviewedHead(pr: MergedPullRequest, reviews: HumanReview[], inline: HumanInlineComment[]): { head: string; at: string; byPerson: boolean };
export async function importPullRequest(repo: RepoRef, pr: MergedPullRequest, source: HistorySource): Promise<{ case: HistoryCase } | { skipped: ImportSkip }>;
```

Rules:

- **A person** is an account that is not a bot and is not the pull request's author.
- **`firstReviewedHead`.** Among the reviews by a person that carry a commit, and the inline comments by a person, take the earliest by time. Its commit is the head and its time is `at`. With none, the head is the pull request's last head, `at` is `mergedAt`, and `byPerson` is false.
- **`importPullRequest`.** `compare(baseSha, review_head)` gives `review_base` (its merge base). `compare(baseSha, headSha)` gives `final_base` and `final_files` with their patches. Either comparison returning `null` skips the pull request as `head_unreadable`. `too_many_files` and `github_too_many_pages` from the source skip it under those names. Any other error is thrown.
- **Activity** holds every review, inline comment and general comment, bots included, in time order. Bodies have control characters stripped and are cut to 2,000 characters. The description is cut to 4,000.
- **The file** is JSON lines. `parseHistory` checks each line's shape with `zod` and refuses a `version` other than 1.

**Command.** `node src/eval/cli.ts import-history --repo <owner/name> --since <YYYY-MM-DD> --until <YYYY-MM-DD> --out <file> [--max-prs 200] [--force]`, with `GITHUB_TOKEN` set. `--out` must be outside the project folder. An existing file that is not empty is refused without `--force`. It writes one line per imported pull request and prints `pull requests <n>, written <w>, skipped <s>`, then one line per skip reason with its count. Files of several repositories are joined by concatenating them. Add the script `"eval:import-history": "node src/eval/cli.ts import-history"`.

- [ ] **Step 1: Write the failing tests.**

```ts
test('the first review by a person sets the head', () => {
  // the author comments at 09:00 on c1, a bot reviews at 09:30 on c1, a person comments inline at 10:00 on c2, a person approves at 11:00 on c3
  assert.deepEqual(firstReviewedHead(pr, reviews, inline), { head: 'c2', at: '2026-01-05T10:00:00Z', byPerson: true });
});
test('nobody reviewed: the last head, at the merge time', () => assert.deepEqual(firstReviewedHead(pr, [], []), { head: pr.headSha, at: pr.mergedAt, byPerson: false }));
test('an imported case carries both bases, the final patches and the activity in time order', async () => {
  const out = await importPullRequest(repo, pr, stubSource);
  assert.ok('case' in out);
  assert.equal(out.case.review_base, 'mb1');
  assert.equal(out.case.final_base, 'mb2');
  assert.equal(out.case.final_files[0]!.patch, '@@ -1 +1 @@\n-a\n+b');
  assert.deepEqual(out.case.activity.map((a) => a.kind), ['comment', 'review', 'inline', 'review']);
});
test('a head that can no longer be read skips the pull request', async () => { /* compare returns null: { skipped: 'head_unreadable' } */ });
test('long bodies are cut and control characters removed', async () => { /* a 5,000-character comment is 2,000; a zero-width space is gone */ });
test('the file round-trips, and a bad line names its number', () => {
  assert.deepEqual(parseHistory([serializeCase(c1), serializeCase(c2)].join('\n') + '\n'), [c1, c2]);
  assert.throws(() => parseHistory(serializeCase(c1) + '\n{"version":2}\n'), /bad_history_line_2/);
});
test('historyKey', () => assert.equal(historyKey(c1), 'acme/shop#12@0123456789ab'));
```

For the command: no `GITHUB_TOKEN` is a usage error with exit code 2; `--out` inside the project is refused; a bad date is refused; with a stub source it writes the lines and prints the counts.

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run everything.** Expected: PASS. Then `node src/eval/cli.ts import-history` with no arguments. Expected: exit code 2 and a one-line usage error.
- [ ] **Step 5: Commit.** `git add src/eval package.json && git commit -m "feat: history file and importer for merged pull requests"`

### Task 13: Labels: which blocks needed a person

**Files:**
- Create: `src/eval/backtest/labels.ts`
- Test: `src/eval/backtest/labels.test.ts`

**Interfaces:**
- Consumes: `HistoryCase`, `FileScore`, `parsePatch`, `blocksOf`, `fileDiffHash`.
- Produces:

```ts
export interface Label { loose: boolean; strict: boolean }
export interface Labels {
  blocks: Map<string, Label>; // key: path, a line feed, the block id
  files: Map<string, Label>;  // key: path
  comments: { counted: number; off_head: number; outside_diff: number };
}
export function labelCase(c: HistoryCase, scores: FileScore[]): Labels;
```

Section 6.6, applied to a history case:

- **A comment counts** when it is an inline comment by a person, and the first comment of its thread was not written by a bot. The thread's first comment is found by following `reply_to` through the case's activity; a comment whose parent is not in the file is treated as a first comment.
- **For a block.** The comment was made on the replayed head (`commit === review_head`), is not file-level, has a line, and its lines (`start_line` to `line`, or `line` alone) on its side touch the block's `lines`. Every block it touches is labelled. It adds to `counted`.
- **For the file only.** A comment on another commit (`off_head`), a file-level comment, or one whose lines touch no block of its file. A comment on a path that is not in `scores` adds to `outside_diff` and labels nothing.
- **A file is labelled** when one of its blocks is, or a comment counted for the file only.
- **Strict.** A labelled block is strict when the last diff before the merge has no hunk with the block's `hunkHash` on the same path. A labelled file is strict when its `diffHash` differs from the hash of its final diff. A path missing from `final_files`, or present with a `null` patch, counts as changed. The final hashes come from `final_files` through `parsePatch`, `blocksOf` and `fileDiffHash`.
- Every block and file of `scores` has an entry; unlabelled ones are `{ loose: false, strict: false }`.

- [ ] **Step 1: Write the failing tests.** One case with two files, each with two blocks, and scores built by `reconcileScores` from invented patches:

```ts
test('a comment on a changed line of the replayed head labels its block', () => { /* blocks.get('src/a.ts\nB1') is loose; B2 is not; the file is loose */ });
test('a comment on a context line of a block counts', () => { /* line = a context line inside B2 */ });
test('a multi-line comment labels every block it touches', () => { /* start_line in B1, line in B2 */ });
test('a comment on another commit counts for the file only', () => {
  assert.deepEqual(l.blocks.get('src/a.ts\nB1'), { loose: false, strict: false });
  assert.equal(l.files.get('src/a.ts')!.loose, true);
  assert.equal(l.comments.off_head, 1);
});
test('a comment on a line outside every block, and a file-level comment, count for the file only', () => { /* both */ });
test('the author, a bot, and a person replying inside a bot thread do not count', () => { /* three comments, no label */ });
test('a person replying inside a person thread counts', () => { /* reply_to a comment by another person */ });
test('strict: the block changed before the merge', () => {
  // final_files holds src/a.ts with B1 rewritten and B2 untouched, and src/b.ts untouched
  assert.deepEqual(l.blocks.get('src/a.ts\nB1'), { loose: true, strict: true });
  assert.deepEqual(l.blocks.get('src/a.ts\nB2'), { loose: true, strict: false });
  assert.deepEqual(l.files.get('src/b.ts'), { loose: true, strict: false });
});
test('a part of a split block is strict by its hunk', () => { /* B1.1 labelled; the final diff still holds the whole hunk: strict false */ });
test('a comment on a path outside the diff is counted apart', () => { /* comments.outside_diff === 1 */ });
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run everything.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/eval/backtest && git commit -m "feat: labels for blocks and files that needed a person"`

### Task 14: The three numbers, and the noise report

**Files:**
- Create: `src/eval/backtest/metrics.ts`, `src/eval/backtest/noise.ts`
- Test: `src/eval/backtest/metrics.test.ts`, `src/eval/backtest/noise.test.ts`

**Interfaces:**
- Produces:

```ts
// src/eval/backtest/metrics.ts
export const THRESHOLDS = [20, 40, 70, 90];
export interface CaseScores { key: string; threshold: number; status: 'ok' | 'failed'; scores: FileScore[]; labels: Labels }
export interface Numbers {
  threshold: number | 'own';
  safety_blocks: number | null; safety_blocks_n: number;             // strict labels
  safety_blocks_loose: number | null; safety_blocks_loose_n: number;
  safety_files: number | null; safety_files_n: number;               // strict labels
  safety_files_loose: number | null; safety_files_loose_n: number;
  benefit: number | null; benefit_n: number;
  focus: number | null; focus_n: number;                             // focus_n counts the pull requests that need a person
}
export function measure(cases: CaseScores[], threshold: number | 'own'): Numbers;

// src/eval/backtest/noise.ts
export interface NoiseRow { threshold: number; blocks_flipped: number | null; blocks_n: number; prs_flipped: number | null; prs_n: number }
export function scoreNoise(a: CaseScores[], b: CaseScores[], thresholds: number[]): NoiseRow[];
```

Section 6.6, at a threshold `T`. With `'own'`, each case is judged at its own `threshold`. Only cases with status `ok` are measured.

- **Flagged.** A file is flagged as a whole when `fileLevel.score >= T`. A block is flagged when its own score is at or above `T` or its file is flagged as a whole.
- **Safety, blocks:** of the labelled blocks, the share that is not flagged. `_n` is the number of labelled blocks. The headline uses strict labels; `_loose` uses loose ones.
- **Safety, files:** of the labelled files, the share whose `finalScore` is below `T`.
- **Benefit:** the share of pull requests whose highest final score is below `T`. `_n` is the number of pull requests.
- **Focus:** over the pull requests that need a person at `T`, changed lines in flagged blocks and in files flagged as a whole, divided by all changed lines of those pull requests. A file flagged as a whole counts all its `changedLines`.
- A share is rounded to 3 decimals and is `null` when its count is 0.

**Noise**, between two runs on the same history file. A hunk's score in a run is the highest effective score among the blocks that came from it, where a block's effective score is the higher of its own score (0 when it has none) and its file's `fileLevel` score. Hunks are matched by case key, path and `hunk`. `blocks_flipped` is the share of matched hunks whose two scores fall on opposite sides of `T`. `prs_flipped` is the share of cases, `ok` in both runs, whose two highest scores do.

- [ ] **Step 1: Write the failing tests.** Three invented cases:

- Case A: one file, two blocks scoring 80 and 30. The 30 block is labelled strict.
- Case B: one file, two blocks scoring 45 and 10, 10 changed lines each. The 45 block is labelled loose only.
- Case C: a file under a team floor (`fileLevel` 100) with one block scoring 20, labelled strict, and a second file with one block scoring 50.

```ts
test('at 70', () => {
  const n = measure([A, B, C], 70);
  assert.equal(n.safety_blocks_n, 2);        // A's 30 block and C's floored block
  assert.equal(n.safety_blocks, 0.5);        // A's is left to the bot; C's is flagged with its file
  assert.equal(n.safety_blocks_loose_n, 3);
  assert.equal(n.benefit, 0.333);            // only B has nothing at or above 70
  assert.equal(n.benefit_n, 3);
  assert.equal(n.focus_n, 2);                // A and C need a person
});
test('at 40, B needs a person and its labelled block is flagged', () => { /* benefit 0; safety_blocks_loose counts B's block as flagged */ });
test('focus counts all lines of a file flagged as a whole', () => { /* pin the value for A and C at 70 from the fixtures' line counts */ });
test('own uses each case threshold', () => { /* B with threshold 40, the others 70 */ });
test('a failed case is left out, and an empty count gives null', () => { /* measure([failed], 70): every share null, every _n 0 */ });
test('noise: a hunk that crosses the threshold between runs is a flip', () => {
  // run 2 scores A's 80 block at 60 and leaves everything else as it was
  const rows = scoreNoise([A, B, C], [A2, B, C], [70]);
  assert.equal(rows[0]!.blocks_n, 6);
  assert.equal(rows[0]!.blocks_flipped, 0.167);
  assert.equal(rows[0]!.prs_flipped, 0.333);
});
test('noise: a hunk split in one run and whole in the other is still one hunk', () => { /* B1.1 = 30 and B1.2 = 80 against B1 = 75: no flip at 70 */ });
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run everything.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/eval/backtest && git commit -m "feat: safety, benefit, focus and the noise report"`

### Task 15: The backtest command

**Files:**
- Create: `src/eval/pool.ts`, `src/eval/backtest/run.ts`
- Modify: `src/eval/replay.ts`, `src/eval/score.ts`, `src/eval/cli.ts`, `package.json`, `README.md`
- Test: `src/eval/pool.test.ts`, `src/eval/backtest/run.test.ts`, `src/eval/cli.test.ts`

**Interfaces:**
- Consumes: `review`, `loadHistory`, `historyKey`, `labelCase`, `measure`, `scoreNoise`, `THRESHOLDS`, `repoConfigFor`, `assertOutsideProject`.
- Produces:

```ts
// src/eval/pool.ts: the loop runReplay has today, lifted out unchanged
export async function runPool<C, R extends { total_cost: number }>(
  cases: C[], opts: { concurrency: number; maxCost: number }, work: (c: C) => Promise<R>, onResult: (r: R) => void,
): Promise<{ stoppedByCost: boolean; notStarted: number }>;

// src/eval/backtest/run.ts
export function toBacktestInput(c: HistoryCase, config: DeploymentConfig): ReviewInput;
export interface BacktestSummary {
  label: string; history_file: string; history_sha256: string; case_count: number; max_cases: number;
  stopped_reason: 'max_cost' | null; cases_not_started: number; cases: number; failed_cases: number;
  reviewed_by_person: number; total_cost: number;
  comments: { counted: number; off_head: number; outside_diff: number };
  numbers: Numbers[]; // one per THRESHOLDS entry, then 'own'
}
export async function runBacktest(args: {
  cases: HistoryCase[]; historyFile: string; historySha256: string; label: string; outDir: string;
  maxCases: number; maxCost: number; concurrency: number; config: DeploymentConfig; deps: ReviewDeps;
}): Promise<BacktestSummary>;
```

- `toBacktestInput`: the pull request at `review_head` against `review_base`, `asOf` the case's `review_at`, the repository's config, `trigger: 'automatic'`, `earlier: null`.
- `runBacktest` runs `review` on each case through `runPool`, labels it with `labelCase`, and writes into `outDir`: `results.jsonl` (per case: key, status, failure stage and code, cost, tokens, duration, calls, the verdict, counts of blocks, of blocks with no score and of files flagged as a whole); `scores.jsonl` (per case: key, threshold, status, the scores, and the labels as plain objects); `summary.json` (the `BacktestSummary`); `summary.md` (one table: a row per threshold with the three numbers and their counts). Scores hold paths and model-written reasons, so the run directory is as private as the history file.
- `replay.ts` uses `runPool`; its behaviour and tests do not change. A replay result row gains `highest_score` and `needs_human`, both `null` for a case that failed in the eval itself.

**Commands.**

- `node src/eval/cli.ts backtest --history <file> --out <dir> --label <name> --config <config> [--max-cases 60] [--max-cost 10] [--concurrency 2] [--force]`, with `GITHUB_TOKEN` and the model key set. Paths must be outside the project folder; a directory that is not empty is refused without `--force`. It prints `cases <n>, failed <f>, not started <k>, total_cost <c>`.
- `node src/eval/cli.ts score-noise <run dir> <run dir>` reads each directory's `summary.json` and `scores.jsonl`, refuses two runs of different history files with `different_history_files`, and prints one row per threshold.
- Scripts: `"eval:backtest"` and `"eval:score-noise"`.

- [ ] **Step 1: Write the failing tests.** For `runPool`: results arrive through `onResult`, no case starts once the spend reaches `maxCost`, and `notStarted` counts the rest. For `runBacktest`, with a stub source and a stub model that scores from a table keyed by path: two cases produce the four files; `summary.json` has five `numbers` rows, the last with `threshold: 'own'`; a case whose review fails is counted in `failed_cases` and left out of the numbers; the run stops at `maxCost`. For the commands: usage errors exit with 2; `score-noise` on two runs of different history files prints `different_history_files` and exits non-zero.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Update the README.** `Status`: the score row reads "Built. Measured only where its owner has run the backtest". Add a section `Backtest` after `Replay` with the three commands and one sentence each on Safety, Benefit and Focus. Add a section `The file a team commits` with the `.visto-ai.yml` example of Task 7 and the sentence that an unusable file sends every pull request to a person.
- [ ] **Step 5: Run everything.** `npm test && npm run typecheck && npm run lint`, and the ASCII check. Expected: PASS and no output. Then `node src/eval/cli.ts backtest` with no arguments. Expected: exit code 2 and a one-line usage error.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: score backtest and noise commands"`

### Task 16: Measurements

This task spends money and reads private repositories. Each paid step needs the owner's go-ahead in the same message. Nothing from it is written inside the project folder, and no number from it goes into a commit. The owner supplies: the frozen case file and the two stage 2 baseline runs (already in the private eval folder), a read-only token, an OpenRouter key, and the repositories and window for the history file.

- [ ] **Step 1: Findings replay with scoring in the call (15.1).** Run the replay twice on the frozen case file, labels `score-1` and `score-2`, `--max-cost 10`. Compare each with the first stage 2 baseline, using the second baseline as the noise band: `compare <base-1>/summary.json <score-1>/summary.json --noise <base-2>/summary.json`. Report the tables, the change in cost and output tokens, and how many answers needed the retry.
- [ ] **Step 2: The gate of 15.1.** If a findings metric is `worse` outside the band in both runs, stop: scoring moves to a model call of its own, which is a plan of its own. Report it and wait for the owner. Known limit: on this case file two identical runs differed widely on recall, so only a large loss can show.
- [ ] **Step 3: Build a history file.** `import-history` for each repository the owner names, over the window the owner names. Report how many pull requests were written and skipped, and how many a person reviewed.
- [ ] **Step 4: A smoke backtest.** `backtest --max-cases 3 --max-cost 1`. Expected: `failed 0`. Check in `scores.jsonl` that blocks carry scores, categories and reasons, and count the blocks left without a score.
- [ ] **Step 5: Two full backtests,** labels `bt-1` and `bt-2`, then `score-noise <bt-1> <bt-2>`.
- [ ] **Step 6: Report to the owner,** in conversation: the three numbers at 20, 40, 70 and 90 with their counts, by block and by file; the noise at each threshold; the share of blocks the model left without a score; the cost of a run. State the limits: the label is a floor (6.6), block labels are few, and the history holds no thread resolutions.
- [ ] **Step 7: The decisions that are the owner's.** Whether 70 stays where the design placed it (section 21, point 2) is read from the numbers at 40 and 70. Whether the numbers justify anything further is the owner's call (6.6); stage 3 is done when they are reported.
