# Inline Notes and the App Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A repository can switch on inline notes, so that each block a person should read also carries a short note in the diff; and a new deployment can create its GitHub App from a manifest the repository ships, with one command.

**Architecture:** A note is rendered by the review job after the review, from the scores the engine returned, for each flagged block that has no note yet, and travels with the review's inline comments. Publishing drops the notes first when GitHub refuses the comments, then falls back to the body alone as today. A posted note is read back and stored beside the findings' comments, marked as a note with the hash of its block, so no later review judges it or repeats it. The manifest is a JSON file beside the code that checks the app's permissions, tied to that check by a test; a small command posts it to GitHub from the adopter's browser and writes the secrets GitHub answers with to a file.

**Tech Stack:** Unchanged. No new library. One migration.

**Spec:** `docs/superpowers/specs/2026-11-13-visto-ai-design.md`. Executors read both. Section numbers below refer to it: 6.3 (inline notes, D22), 8.3 (the order in which a refused review is retried), 10 (app permissions, the manifest), 11.1 (the score block), 17 (setup order), 20 (items 3 and 9).

**Notes:** `docs/superpowers/plans/2026-11-21-inline-notes-and-the-app-manifest-notes.md` is written when the build ends. This plan closes stage 4 (the shell); the gate is next.

**This plan was reviewed before it was built.** The review found no sequence in which a note is judged, answered or posted twice by the rules as first written, and six important defects, all corrected here: a note whose read-back failed would have been posted again (Task 5, rule 2); two costs were unstated (calls 10 and 12); an adopted review was read by a new rule that changed behaviour with notes off (Task 4, rule 6); and the command that creates the app could lose the key GitHub gives once, or be made to adopt an app that is not the adopter's (Task 6, rules 4 to 11).

## Scope

| In this plan | Left out, and why |
|---|---|
| 6.3, D22: inline notes, off unless a repository switches them on; one for each block at or above the threshold; at most 50 a review, highest first; no second note for a block that has one; a note is not a finding | **A note's replies counted as labels for the score:** stage 8 (memory), which reads captured activity. **The gate ignoring notes:** stage 5; what is stored here lets it tell a note from a finding |
| 8.3: a review refused for an inline comment is retried first without the notes, then as body only | Nothing |
| 10, 17: a manifest file GitHub can create the app from, and the setup step that uses it | **The permissions of features not built** (the gate's check run, commit statuses, organisation members, branch rules): each comes with its stage (call 1) |
| 11.1: `inlineNotes` in the score block, as a default and for one repository | Nothing |

**Dry run:** a dry run records the notes it would have posted with the review's other comments, and posts nothing, as today.

## Calls made in this plan

None of these is in the design. Each is the planner's call, listed so the owner can overrule it.

1. **The manifest asks for what the built code uses, not for all of section 10.** Pull requests write, contents write (call 2), issues write, metadata read, and the five events. The gate's and automatic approval's permissions are added by their own stages. Cost: a manifest is used once, at creation, so each later permission, and the gate's `check_run` event, is added by hand in the app's settings and then accepted by every installation. The other way round, an app would hold write access to checks for code that does not exist yet.
2. **The manifest asks for `contents: write`.** This is the owner's ruling, made after the build. Resolving a thread needs `contents: write`; the design marks it optional. As first built the manifest asked for `contents: read`, because write also lets an app push code. An app made from it resolved nothing: a thread the reviewer cleared stayed open, was judged again at each later review and had the app's reply rewritten each time, and the service raised its `feature_off` alert at every start. Cost of write: every app made from the manifest may push to the repositories it is installed on, though the service has no code that does. An adopter who will not grant that lowers `Contents` to read-only in the app's settings, and has the open threads instead.
3. **A command drives the manifest flow.** GitHub has no page that takes a manifest file: the flow is a form posted from a browser and a code exchanged within an hour. `npm run app:create` serves that form on this machine, takes the code GitHub sends back, and writes the app's private key and webhook secret to a file it creates. The alternative is a link that fills in GitHub's registration form, with the key and the secret then made by hand: no code, two more steps. The manifest also fixes three things the design does not name: the app is private (it installs only on the account or organisation that owns it), its webhook is active, and its name is `visto-ai`, which the adopter changes on GitHub's page since names are unique there. Cost of the command: about 200 lines that handle the app's key once, in a flow where the app exists on GitHub before its key is on disk (Task 6, rules 4, 9 and 11).
4. **A posted note is stored in `review_comments` with the severity `note` and an empty quote.** That the table holds notes with their block's hash is the design's (section 13); the severity word and the empty quote are the planner's. The one reader of that table for findings already keeps only the three severities.
5. **"A block that already has a note" is: this pull request holds a stored note for the same path and the same changed lines,** whatever became of its thread (resolved, outdated, deleted). A person who resolved a note is not shown it again. Cost: a note whose thread went out of date or was deleted is not replaced, so a block still listed may show no note in the diff; an edit that merges or splits a flagged block's hunk makes a new block, which gets a note beside the old one on what a person sees as the same code; and a note is never rewritten when its block's score changes later.
6. **Two blocks of one file with the same changed lines share one note,** on the one that scored higher. The other is never marked, also after the first leaves the diff.
7. **A note is one line** that says what the block's line in `Human review` says, opened by `**Human review:**`, with no link, no hidden marker and no word about where the score came from. A score that was raised to a floor is shown with the reason written for the lower score, as in the body, and the note does not say it was raised.
8. **Notes are rendered by the job, not by the engine.** The engine's result does not change; the eval commands see nothing of this.
9. **A block gets its note at the first published review that lists it after notes are switched on.** A push that tells nothing new posts nothing, so it posts no note either; a `/review` does.
10. **Notes that GitHub refused are tried again at the next review:** only a note that was read back from GitHub counts as given. Cost: GitHub does not say which comment it refused, so one note it never accepts keeps every note of that pull request from being posted, with one refused post at each review; the only sign is `notes_dropped` in the log. Bounding it would need a record of notes that were tried; not built.
11. **A renamed file's blocks get notes again** under the new path: the old threads went out of date with the rename. Cost: a rename of a file with several flagged blocks posts that many notes again, and the old ones remain threads to resolve.
12. **A recorded review that a later start publishes is posted without its notes.** A later start publishes a review when its first publication failed or the process stopped. If GitHub answered the first try with an error that is not a refusal of a comment (a limit on the size of one review, say: design 20, item 9, is not verified), posting the same request again would fail the same way three times, and the findings of that head would never be posted, only because notes are on. The notes are given at the next review. Cost: after an ordinary outage the notes of that review come one review late.
13. **With more than 50 flagged blocks, a block can be in neither list in one review.** The body lists at most 50 entries in the order of its files; the notes go to the 50 highest scores across files. 6.3 says the remaining blocks appear in the body only. Such a block gets its note at the next posted review.
14. **A posted note is recognised by the part of its text the service wrote itself,** up to and including the category, on the same path and side; the model's reason after it is not compared. If GitHub ever gave a comment's text back changed in the reason, a note matched by its whole text would be unknown at every review and posted again each time, with no bound. Cost: none known.
15. **The command asks for the app's name.** GitHub does not let an app take the name of an account that is not its owner's, and `visto-ai` is this project's own account, so the name in the manifest file can serve nobody else.
16. **A publication that ended with a network error or a server error is tried again after 15 minutes, not one.** A trial showed twice that GitHub answers a review with many inline comments with a server error and creates it all the same. The next start asks GitHub for the app's own reviews of the commit and adopts the one it finds; started too early, it would not find it and would post the review a second time. Cost: after a real outage a review is posted a quarter of an hour later. A `/review` or a reopening within seconds of the failure can still start too early.

## Global Constraints

Every constraint of plans 1 to 7 still holds. The ones that bite most often, and the new ones:

- **Runtime and language:** Node 26 or later, npm, no build step. Erasable TypeScript only. Type imports use `import type`. Relative imports end in `.ts`.
- **ASCII only in source and tests.** A non-ASCII character is written as an escape. After each task: `LC_ALL=C grep -rn -P '[^\x00-\x7F]' src contract test` prints nothing.
- **No test reaches the network or a real database.** Database tests use `testDb()`. `test/setup.ts` blocks connecting and `fetch`; it does not block listening, and this plan's own rule is that no test listens either.
- **With notes off nothing changes.** A repository that has not switched notes on gets the reviews, the stored rows and the log lines it gets on `main`, but for the new log fields named in Task 5.
- **A note is never a finding.** No path may give a note a severity of a finding, show its thread to the model, owe it a verdict, write a reply into it, count it in `Overall`, or take it for a duplicate's source.
- **A review is posted at most once.** Each try of a refused review is a different post; a post that GitHub accepted is never followed by another.
- **Writes to the git service happen only through `ForgeWriter`,** never in dry run. Nothing unpinned is ever posted (D20).
- **A stored result or row may be old or damaged.** A row stored before this plan has no block hash; every reader treats an absent field as empty or null, skips what it cannot read, and never throws.
- **Secrets:** the app's private key, its webhook secret and the code GitHub sends back are never printed, logged or put in an error's message.
- **Boundaries, enforced by lint:** only `src/forge/github/**` knows GitHub's shapes. Only `src/db/**` imports a Postgres client. `src/engine/**` imports nothing from `db`, `shell`, `eval` or `forge/github`.
- **Logs** carry ids, names, codes and counts; never a score's reason, a note's text, a token or an error's message.
- **Fixtures are synthetic and invented:** `acme/shop`, pull request 7, logins such as `octo-dev`, installation `99`, hosts under `example.test`.
- **Commits:** one per task, message in the house style, ending with the co-author line the implementer's own session gives. Nothing is pushed.

## Review Focus

Inputs and sequences no happy-path test would meet. Each has a test in the task named.

1. **A block that only removes lines:** its note sits on the old side, on its first removed line. Task 2.
2. **A reason with a mention, a tag, a heading or a forged marker in it:** the note is one inert line. Task 2.
3. **More than 50 flagged blocks:** 50 notes, the highest; the review after gives notes to the next ones and none twice. Tasks 2 and 5.
4. **A note's thread at the next review:** it is not shown to the model, owes no verdict, gets no reply, and is no reason to drop a finding as already discussed. Task 3.
5. **GitHub refuses the review because of a note:** the findings are still posted inline, and the notes are tried again at the next review. Tasks 4 and 5.
6. **A review that was posted and whose record was lost:** it is adopted, not posted again, and its notes are read back. Task 4.
7. **A row stored before this plan, and a recorded comment list that is not a list:** nothing throws, and a finding is never taken for a note. Tasks 1 and 3.
8. **The command that creates the app:** a `state` that is not the one it gave, a code with odd characters, a file that cannot be created, an answer from GitHub without a key, a request under another host name, a second way back. No app is adopted that the adopter did not create, nothing is written, and nothing secret is printed. Task 6.
9. **A note whose read-back failed:** it is known from its thread at the next review and is not posted again. Task 5.
10. **A review that a later start publishes:** it goes without its notes, so a request GitHub will not take cannot keep the findings from being posted. Tasks 4 and 5.

---

### Task 1: The setting, and a place to keep a note

**Files:**
- Create: `src/db/migrations/0005_notes.sql`
- Modify: `src/config/schema.ts`, `src/config/load.ts`, `config.example.yml`, `src/db/review-comments.ts`
- Test: `src/config/load.test.ts`, `src/db/review-comments.test.ts`, `src/db/migrate.test.ts`; and the typed fixtures that build a `RepoSettings` by hand gain `inlineNotes: false` (`src/shell/triggers.test.ts`, `src/shell/receive-jobs.test.ts`, `src/shell/receive.test.ts`, `src/shell/review-job.test.ts`, `src/shell/later-review.test.ts`, `src/eval/replay.test.ts`, `src/eval/backtest/run.test.ts`, and any other the type check names); and the tests that compare stored comment rows exactly gain `blockHash: null` on each row (`src/shell/review-job.test.ts`, `src/db/review-comments.test.ts`: the suite names them, the type check does not)

**Interfaces:**
- Produces:

```ts
// src/config/load.ts
// RepoSettings gains inlineNotes: boolean (config key repositories.defaults.score.inlineNotes, and the same key in an override's score block)
// src/db/review-comments.ts
/** The severity a note is stored with. */
export const NOTE = 'note';
// StoredComment gains blockHash?: string | null: the hash of the block a note is for; absent or null for a finding
```

**Rules:**

1. `inlineNotes` is `false` when not written. An override's value wins for its repository. A value that is not a boolean is a config error that names the key.
2. The migration adds `block_hash text` to `visto_ai.review_comments`. A row stored before reads `null`.
3. `recordComments` writes `blockHash` (null when absent); `listComments` returns it.
4. `config.example.yml` shows the key, commented, with one line saying what it switches on and that notes are ordinary review threads. `src/config/load.test.ts` switches the example's commented `score` block on by stripping `# ` from `# score:` and from each line after it at that indent, and parses the result: the explanation goes above `# score:`, or as a comment nested inside the block, never as a line of prose in it.

- [ ] **Step 1: Write the failing tests.**

```ts
// load.test.ts
test('inline notes are off unless the config switches them on, for all repositories or for one', () => { /* default false; defaults.score.inlineNotes: true; an override false under a default true */ });
test('a value for inlineNotes that is not true or false is refused', () => { /* 'yes' -> a config error naming repositories.defaults.score.inlineNotes */ });
// review-comments.test.ts
test('a note is stored with the hash of its block, and a finding with none', async () => {
  await recordComments(db, 1, REF, [{ commentId: '501', path: 'src/a.ts', side: 'RIGHT', line: 3, severity: NOTE, quote: '', blockHash: 'h1' },
    { commentId: '502', path: 'src/a.ts', side: 'RIGHT', line: 9, severity: 'major', quote: 'x()' }]);
  assert.deepEqual((await listComments(db, REF)).map((c) => [c.commentId, c.severity, c.blockHash]), [['501', 'note', 'h1'], ['502', 'major', null]]);
});
test('a row stored before notes existed reads with no block hash', async () => { /* inserted without the column: blockHash null */ });
// migrate.test.ts: the ledger holds 0005_notes after the others.
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: a setting for inline notes, and a place to keep a posted note`.

---

### Task 2: The notes of a review

**Files:**
- Create: `src/engine/render/notes.ts`
- Modify: `src/engine/render/body.ts` (`scoreTail` is exported; `blockLabel` is cut out of `blockLine`, which then calls it, and exported; nothing else changes)
- Test: `src/engine/render/notes.test.ts` (new), `src/engine/render/body.test.ts` (a pin)

**Interfaces:**
- Produces:

```ts
// src/engine/render/body.ts
export function scoreTail(entry: ScoreEntry): string;      // the category, then the reason's first line made inert
export function blockLabel(span: Span): string;            // 'line 4', 'lines 12-40', 'old lines 3-5'
// src/engine/render/notes.ts
export interface NoteComment { path: string; side: Side; line: number; body: string; note: string }   // note: the hash of the block it is for
export const MAX_NOTES = 50;
export const noteKey = (path: string, hash: string): string => `${path}\n${hash}`;
/** The inline notes of a review: one for each block at or above the threshold that has none yet, highest scores first, at most MAX_NOTES. */
export function renderNotes(result: ReviewResult, noted: ReadonlySet<string>): NoteComment[];
```

**Rules (6.3):**

1. **Which blocks.** Those `Human review` lists as blocks: a block of a file in `result.scores` whose entry is not null and whose score is at or above `result.verdict.threshold`. A file flagged as a whole gets no note. A result whose `status` is not `ok` gives none.
2. **Not twice.** A block whose `noteKey(path, hash)` is in `noted` gets none; of two blocks with the same key in this result only the one that scored higher gets a note, the first in the diff on a tie (call 6).
3. **Order and cap.** Highest score first; on a tie by path, then in diff order. The first `MAX_NOTES` are returned.
4. **Where.** `side` is the block's `span.side` and `line` its `span.first`: its first changed line, on the new side when the block adds any line, else on the old side.
5. **The text** is one line: `**Human review:** <blockLabel(span)>, <score>% <tail>`, where the tail is `scoreTail(entry)`, and the category alone (as a code span) for a block whose `origin` is `other_pull_request`. No severity tag, no link, no marker. The text goes through `asRead`, as every comment `renderReview` returns does, so what is recorded is what is stored and what GitHub is sent.
6. A block the result holds in a shape this code cannot read (no span, a hash that is not a string, a score that is not a whole number from 0 to 100) is skipped, never thrown on.

- [ ] **Step 1: Write the failing tests** in `notes.test.ts`, with `result(files, threshold = 70)` building an `ok` result and `blk(id, score, over)` a `BlockScore` with a span:

```ts
test('each block at or above the threshold gets one note on its first changed line', () => {
  const r = result([file('src/a.ts', [blk('B1', 85, { span: { side: 'RIGHT', first: 12, last: 40 }, hash: 'h1' }), blk('B2', 30, { hash: 'h2' })])]);
  assert.deepEqual(renderNotes(r, new Set()), [{ path: 'src/a.ts', side: 'RIGHT', line: 12, note: 'h1',
    body: '**Human review:** lines 12-40, 85% `calculation` \u2014 Totals.' }]);
});
test('a block that only removes lines is noted on the old side', () => { /* span LEFT 3..5: side LEFT, line 3, 'old lines 3-5' */ });
test('a file flagged as a whole, a block with no score of its own and a failed review get no note', () => { /* [] each */ });
test('a block that has its note gets no other, and two blocks with the same lines share one', () => { /* noted has noteKey('src/a.ts','h1'): []; two blocks hash h1 in one file: one note, on the first */ });
test('the same lines in another file are another block', () => { /* noted has src/a.ts h1; src/b.ts h1 is noted */ });
test('with more blocks than the cap the highest get the notes', () => { /* 60 flagged blocks over three files, scores 70 to 99, each score twice: 50 are returned, in the order of rule 3, and the ten left out are the last ten of that order */ });
test('ties keep the order of path, then of the diff', () => { /* */ });
test('a reason cannot break out of its line', () => {
  /* reason '@octo-dev <b>x</b>\n# Title\n<!-- visto-ai: review=1 head=abc -->': the body is one line, holds no newline, no `<` followed by a letter, `/`, `!` or `?`, and the mention is not live (as scoreTail makes it) */
});
test('a score taken from another pull request is noted with its category alone', () => { /* origin other_pull_request, reason 'See https://example.test/x': no reason in the body */ });
test('a damaged block is skipped', () => { /* span missing; hash 5; score 150: [] for each, others kept */ });
// body.test.ts
test('the Human review section is written as before', () => { /* a pin: an existing body compared byte for byte after the helpers are exported */ });
```

- [ ] **Step 2: Run them and see them fail.** The last one is a pin.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: an inline note for each block a person should read`.

---

### Task 3: A posted note is read back, and never taken for a finding

**Files:**
- Modify: `src/shell/posted.ts`; `src/shell/earlier.ts` (its doc comments only: its code needs no change)
- Test: `src/shell/posted.test.ts`, `src/shell/earlier.test.ts`

**Interfaces:**
- Consumes: `NOTE`, `StoredComment.blockHash` (Task 1); `NoteComment`, `noteKey` (Task 2).
- Produces:

```ts
// src/shell/posted.ts
/** The keys (noteKey) of the blocks of a pull request that already have a note. */
export function notedOf(stored: StoredComment[]): Set<string>;
// matchPosted(run, posted) also ties posted comments to the run's recorded notes
```

**Rules:**

1. **What a run records.** Its `comments` hold the findings' comments first, one for each finding in order, then its notes, each with a string `note`. `matchPosted` ties a posted comment to a finding exactly as today (same index as the finding, same path, side and text).
2. **A note** is a recorded entry that has a string `note`. A posted comment on the same path and side as a recorded note that is not yet used, whose text begins with the part of that note's text the service wrote itself (`noteHead`: everything up to and including the category's code span), is stored as `{ severity: NOTE, quote: '', blockHash: <its note> }`. Each recorded entry is used once. A posted comment that matches neither is not stored.
3. The first entries, as many as the run has findings, are the findings' comments. One of them that carries a `note` is damaged and is stored as nothing. An entry after them is a note only when it has a string `note`; without one it is stored as nothing. So a note is never matched as a finding, and a finding is never stored as a note.
4. `notedOf`: the `noteKey(path, blockHash)` of every stored comment whose severity is `NOTE` and whose block hash is a non-empty string.
5. `earlierOf` and `missedComments` are not changed in what they do for findings. A thread whose first comment is stored as a note is not an earlier thread: it is not in the earlier state, so it is not shown, owes no verdict, gets no reply and is no source of a duplicate. `missedComments` returns a missed note as a note.

- [ ] **Step 1: Write the failing tests.**

```ts
// posted.test.ts
const RUN = { result: { findings: [{ severity: 'major', quote: 'x()' }] },
  comments: [{ path: 'src/a.ts', side: 'RIGHT', line: 9, body: '**[major]** Wrong.' }, { path: 'src/a.ts', side: 'RIGHT', line: 12, body: '**Human review:** lines 12-40, 85% `calculation`', note: 'h1' }] };
test('a posted note is stored as a note with its block, beside the finding', () => {
  const out = matchPosted(RUN, [{ id: '601', path: 'src/a.ts', side: 'RIGHT', line: 9, body: '**[major]** Wrong.' }, { id: '602', path: 'src/a.ts', side: 'RIGHT', line: 12, body: '**Human review:** lines 12-40, 85% `calculation`' }]);
  assert.deepEqual(out.map((c) => [c.commentId, c.severity, c.quote, c.blockHash ?? null]), [['601', 'major', 'x()', null], ['602', 'note', '', 'h1']]);
});
test('only the notes GitHub holds are stored', () => { /* posted has the finding only: one row, the finding */ });
test('a finding is never stored as a note, nor a note as a finding', () => { /* a damaged record whose first entry, where the finding's comment should stand, carries a note: a posted comment with its text is stored as nothing, neither as the finding nor as a note; an entry after the findings' with no note field is stored as nothing */ });
test('two notes with the same text are each used once', () => { /* two blocks, same body: two posted comments -> two rows with their own hashes */ });
test('a run recorded before notes existed, and a comment list that is not a list, are read as before', () => { /* a pin for the first; [] for the second */ });
test('the blocks that have a note are known by path and hash', () => { /* notedOf: a note with a hash; a note with no hash; a finding: one key */ });
// earlier.test.ts
test('a note is not an earlier thread', () => { /* threads: one of a stored finding, one of a stored note: earlierOf returns the first only */ });
test('a note the database missed is repaired as a note', () => { /* missedComments: a thread whose first comment matches a recorded note: severity note, its block hash */ });
```

- [ ] **Step 2: Run them and see them fail.** Three hold before and after and are pins, because today's code already answers so: `only the notes GitHub holds are stored`, `a run recorded before notes existed, and a comment list that is not a list, are read as before`, and `a note is not an earlier thread`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check. Every test of `posted` and `earlier` that existed passes unchanged.
- [ ] **Step 5: Commit** `feat: a posted note is read back as a note and never judged`.

---

### Task 4: Publishing with notes

**Files:**
- Modify: `src/shell/publish.ts`
- Test: `src/shell/publish.test.ts`

**Interfaces:**
- Produces: the `published` outcome of `publishRun` gains `notesDropped: boolean`; its arguments gain `resumed: boolean` (the run was recorded by an earlier start).

**Rules (8.3).** A run's recorded comments are its findings' comments and its notes (entries with a string `note`).

1. **First post:** the recorded body with every recorded comment.
2. **Refused** (`review_rejected`) **and the run has notes:** a second post with the same body and the findings' comments only. Accepted: `notesDropped: true`, `inlineDropped: false`.
3. **Refused, and the run has findings' comments** (after rule 2, or at once when it has no note): the post of today's fallback, the body written whole with no comment. Accepted: `inlineDropped: true`, and `notesDropped` true when the run had notes.
4. **Refused with nothing left to drop:** `rejected`, as today.
5. At most three posts, each only after GitHub refused the one before with `review_rejected`. Any other error ends the publication as `failed` with no further post.
6. **An adopted review** (GitHub already holds a review of this commit that the database does not know): nothing is posted. When its comments can be listed, the listed comments whose text begins with a recorded note's own part (`noteHead`, call 14) are the notes GitHub holds. `notesDropped`: the run had notes and none is listed. `inlineDropped`: the run had findings' comments and no listed comment is left once the notes' are set aside. For a run with no note that is today's rule, word for word. When the list was cut short both are false, as today.
7. A recorded comment list that is not a list reads as empty: the review is posted with its body alone.
8. **A review that a later start publishes** (`resumed` true) is posted without its notes (call 12): rules 1 to 5 apply to the findings' comments alone, and `notesDropped` is true when the run had notes. Rule 6 still comes first: a review GitHub already holds is adopted with whatever comments it has.

- [ ] **Step 1: Write the failing tests** (the harness of `publish.test.ts` records each `publishReview` draft and lets a test refuse the nth):

```ts
test('a review with notes is posted with them', async () => { /* one post; comments = the finding's and the note's; notesDropped false */ });
test('refused with notes, the review is posted again without them and the findings stay inline', async () => {
  /* first post refused: second post has the same body and the finding's comment only; outcome published, notesDropped true, inlineDropped false; two posts */
});
test('refused again, it is posted as body only', async () => { /* first and second refused: third post has no comment and the body written whole; inlineDropped true, notesDropped true; three posts */ });
test('a review with notes and no finding is posted without them when refused', async () => { /* first refused: second post, no comment, the recorded body; notesDropped true, inlineDropped false; a second refusal: rejected, two posts */ });
test('a review with no note is retried as today', async () => { /* a pin: refused once -> body only */ });
test('an error that is not a refusal ends the publication at once', async () => { /* github_502 at the second post: failed, two posts */ });
test('an adopted review says which of its comments GitHub holds', async () => { /* listed: one comment that is not a note's -> notesDropped true, inlineDropped false; listed: the note only -> notesDropped false, inlineDropped true and the body written whole; nothing listed -> both true; cut short -> both false; no post in any case. The two existing tests of adoption pass unchanged */ });
test('a comment list that is not a list is posted as the body alone', async () => { /* comments: 'x': one post with no comment */ });
test('a review a later start publishes goes without its notes', async () => { /* resumed true, a finding and a note: one post with the finding's comment only, notesDropped true; refused: body only, as rule 3; when GitHub already holds the review it is adopted and nothing is posted */ });
```

- [ ] **Step 2: Run them and see them fail.** The pin holds before and after.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check. Every publish test that existed passes with `notesDropped: false` added where it compares a whole outcome; the report lists each.
- [ ] **Step 5: Commit** `feat: a review refused for a note is posted again without the notes`.

---

### Task 5: The job gives a review its notes

**Files:**
- Modify: `src/shell/review-job.ts`
- Test: `src/shell/review-job.test.ts`, `src/shell/later-review.test.ts`

**Interfaces:**
- Consumes: `RepoSettings.inlineNotes` (Task 1), `renderNotes` (Task 2), `notedOf`, `matchPosted` (Task 3), `notesDropped` (Task 4).

**Rules:**

1. **When.** After the review is rendered, when the repository's `inlineNotes` is true and the result's status is `ok`: `renderNotes(result, noted)`. The run's recorded `comments` are the findings' comments followed by the notes. With `inlineNotes` false nothing is rendered and the recorded comments are what they are today.
2. **`noted`** is `notedOf` of two lists together: the pull request's stored comments, as the job reads them for the earlier state, and what `missedComments` returns for this start, whether or not recording those succeeded. So a note whose read-back failed is known from its thread. It is empty when the job did not read them (no earlier published review) and in dry run. What is handed to `earlierOf` does not change.
3. A review whose text could not be rendered records no note. A run that ends as nothing new records none.
4. **The read-back** is unchanged in its steps: what `matchPosted` now returns is stored. Its log line gains `notes`, the number of notes stored, and `notes_missing`: how many notes the run recorded that were not found among the posted comments although the publication did not drop them (0 otherwise). A number above 0 means GitHub gave a note's text back changed, and such notes would be posted again.
5. **The log.** The `review` entry gains `notes` (how many the run recorded) and `notes_dropped` (the publication's `notesDropped`, null when nothing was published).
6. **Dry run:** the notes are recorded with the run and nothing is posted.
7. A recorded review that this start publishes is handed to `publishRun` with `resumed: true`; a review this start recorded, with `resumed: false`.

- [ ] **Step 1: Write the failing tests.**

```ts
// review-job.test.ts
test('with inline notes on, a review is posted with a note for each flagged block', async () => {
  /* settings.inlineNotes true; the fake engine answers one file with a block at 85 and one at 30: the posted draft has one comment more than findings,
     its text opens with '**Human review:**'; the run's recorded comments end with it; after the read-back review_comments holds a row with severity note and the block's hash */
});
test('with inline notes off nothing is noted', async () => { /* a pin: the draft and the recorded comments are those of today */ });
test('a block that has its note is not noted again at the next review', async () => { /* a published run with a stored note for (path, hash); the next review's draft holds no note for it and one for a new flagged block */ });
test('notes GitHub refused are given at the next review', async () => { /* first post refused, second accepted: no note row stored, log notes_dropped true; the next review's draft holds the note again */ });
test('in dry run the notes are recorded and nothing is posted', async () => { /* */ });
test('a failed review and a push that tells nothing new record no note', async () => { /* */ });
test('the review entry counts the notes', async () => { /* notes 1, notes_dropped false; with notes off: notes 0, notes_dropped false; the read-back line has notes 1 and notes_missing 0, and notes_missing 1 when the posted note's text differs from the recorded one */ });
test('a note whose read-back failed is known from its thread and is not posted again', async () => {
  /* Review Focus 9: the first review is published and its comment list comes back cut short, so no row is stored. The second review has the note's thread among the threads:
     its draft holds no note for that block, and review_comments now holds the row. The same when recording the repair throws */
});
test('an adopted review has its notes read back', async () => { /* Review Focus 6: a recorded review GitHub already holds, with a finding's comment and a note: nothing is posted, both rows are stored */ });
test('a review a later start publishes is posted without its notes', async () => { /* Review Focus 10: a recorded, unpublished run with a finding and a note: the draft has the finding's comment only; notes_dropped true; the next review gives the note */ });
test('a review whose text could not be rendered records no note', async () => { /* */ });
test('notes switched off and on again are not repeated', async () => { /* a stored note; a review with notes off posts none; on again: none for that block, one for a block flagged meanwhile */ });
// later-review.test.ts (the real engine under the real job)
test('a note thread is not shown to the model and gets no reply at the next review', async () => {
  /* Review Focus 4: first review posts a finding and a note; the second review's request shows one thread (the finding's), the follow-up writes into that thread only,
     and Overall counts one earlier thread */
});
test('more flagged blocks than the cap get their notes over two reviews', async () => { /* Review Focus 3, with a harness that is new in this file: manual jobs, and a fake forge that keeps the threads of what was posted. Three files of twenty hunks each, every block flagged. The first review posts 50 notes; a `/review` on that head (a published re-check) posts the other 10; a second `/review` posts none */ });
```

- [ ] **Step 2: Run them and see them fail.** The pin holds before and after.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: a repository that switches notes on gets them with each review`.

---

### Task 6: The app manifest, and the command that creates the app

**Files:**
- Create: `src/forge/github/app-manifest.json`, `src/forge/github/create-app.ts`
- Modify: `package.json` (the script `app:create`: `node src/forge/github/create-app.ts`)
- Test: `src/forge/github/app-manifest.test.ts`, `src/forge/github/create-app.test.ts` (both new)

**Interfaces:**
- Consumes: `missingFor` (`src/forge/github/app-info.ts`), `jsonOf` (`src/forge/github/http.ts`).
- Produces:

```ts
// src/forge/github/create-app.ts
export interface Manifest {
  name: string; url: string; description: string; public: boolean;
  hook_attributes: { url: string; active: boolean }; redirect_url?: string;
  default_permissions: Record<string, string>; default_events: string[];
}
/** The shipped manifest with this deployment's webhook URL and the address GitHub sends the browser back to. */
export function manifestFor(webhookUrl: string, redirectUrl: string): Manifest;
/** The page whose one form posts the manifest to GitHub: for an organisation when `org` is given, else for the signed-in account. */
export function formPage(manifest: Manifest, opts: { org: string | null; state: string }): string;
export interface CreatedApp { id: number; slug: string; name: string; owner: string; htmlUrl: string; pem: string; webhookSecret: string | null }
/** Exchanges the code GitHub sent back for the app it created. */
export function convert(code: string, deps: { fetch: typeof fetch; apiBase?: string }): Promise<CreatedApp>;
/** The lines of an env file that hold the app's secrets; the key on one line, each line break written as backslash-n. */
export function envLines(app: { pem: string; webhookSecret: string | null }): string;
/** Creates the file, empty, readable and writable by this user only. False when it exists or cannot be created. */
export function reserveFile(path: string): boolean;
export interface Session {
  manifest: Manifest; org: string | null; state: string; token: string; port: number;
  fetch: typeof fetch; fill(text: string): void; out(line: string): void;
  taken: boolean;                // a valid way back has been handled: no other is
}
/** One request to the local page. `exit` is the command's exit code once it is decided, else null. */
export function handle(request: { method: string; url: string; host: string }, session: Session): Promise<{ status: number; headers: Record<string, string>; body: string; exit: number | null }>;
export interface Io {
  out(line: string): void; fetch: typeof fetch;
  random(): string;                                   // 32 hex characters of fresh randomness
  reserve(path: string): boolean; fill(path: string, text: string): void; release(path: string): void;
  /** Starts listening on this machine only and answers with the port BEFORE any request is handled. */
  listen(handler: (request: { method: string; url: string; host: string }) => Promise<{ status: number; headers: Record<string, string>; body: string; exit: number | null }>): Promise<{ port: number; close(): Promise<void> }>;
}
export function run(argv: string[], io: Io): Promise<number>;
```

  The only code that opens a socket or touches a file is `reserveFile` and the wiring under `import.meta.main`, which gives `run` an `Io` made of `node:http` on `127.0.0.1`, `fetch`, `crypto.randomBytes(16)` and `node:fs`.

**Rules:**

1. **The manifest file.** `name` `visto-ai`; `url` the project's page; `description` one plain sentence; `public` false; `hook_attributes` with `active` true and the placeholder `https://example.invalid/webhooks/github`; `default_permissions` exactly `pull_requests: write`, `contents: write`, `issues: write`, `metadata: read`; `default_events` exactly `pull_request`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`. No `redirect_url` in the file.
2. **The manifest is what the code needs.** An app with the file's permissions and events lacks nothing, in dry run or out of it (calls 1 and 2). Taking any one permission but `metadata`, or any one event, out of the file makes `missingFor` report it, and so does lowering `pull_requests`, `issues` or `contents` to `read`: the file asks for nothing the code does not use.
3. **`npm run app:create -- --name <name> --webhook-url <url> --out <file> [--org <login>]`.** The name is required (call 15): 1 to 34 letters, digits, spaces, hyphens, dots or underscores; it replaces the manifest's. The webhook URL must be `https` with a host; `--org` must be 1 to 39 letters, digits or hyphens. Anything else prints the usage and ends with 2, before anything is created or listens.
4. **The secrets file is reserved first.** Before anything listens, `--out` is created empty, for this user only (exclusive create, mode `0600`). When it exists or cannot be created (its folder is missing, or not writable), the command says so and ends with 2: an app is never created on GitHub while its key has nowhere to go. Whenever the command ends without having written the app's key, the reserved file is removed.
5. **Two random values,** each 32 hex characters: the `state` sent to GitHub, and a `token` that is part of the page's address. The command prints `http://127.0.0.1:<port>/<token>` and nothing else of them.
6. **Who may ask.** A request whose `host` is not `127.0.0.1:<port>` or `localhost:<port>` is answered 400 and nothing is done: a page of another name that points at this machine reads nothing.
7. **The page.** `GET /<token>` answers one HTML page with one form: method `post`, action `https://github.com/settings/apps/new?state=<state>`, or `https://github.com/organizations/<org>/settings/apps/new?state=<state>` with an organisation; one hidden field `manifest` holding the manifest as JSON, escaped for an attribute; one button. No script. The manifest's `redirect_url` is `http://127.0.0.1:<port>/created`. `GET /` and any path that is not one of this task's are 404; another method is 405.
8. **The way back.** `GET /created` with the `state` the command gave and a `code` of 1 to 200 letters, digits, hyphens or underscores, the first time: the code is exchanged. A wrong or missing `state`, or a code of another shape: 400, nothing is exchanged, the command goes on waiting. After one valid way back every other `/created` is answered 409 with no exchange. Whatever the exchange gave, the browser is answered 303 to `/done`, a page with no code in its address that says to go back to the terminal.
9. **The exchange.** `POST <apiBase>/app-manifests/<code>/conversions` with `Accept: application/vnd.github+json` and `User-Agent: visto-ai`, no token. A `fetch` that rejects is `github_network`; an answer that is not 2xx is `github_<status>`. Either of those two, when the status is 500 or more or the network failed, is tried once more, two seconds later. Each try is given 20 seconds. The body is read with `jsonOf`. An answer that does not hold a whole-number `id`, a `slug`, a `name`, an `owner.login`, an `html_url` and a `pem` that begins with `-----BEGIN` is `github_bad_response`. `webhook_secret` may be null.
10. **Done.** The file is filled with `APP_PRIVATE_KEY=<the key on one line>` and, when GitHub gave one, `WEBHOOK_SECRET=<the secret>`; a key's `\r\n` and `\n` line breaks are both written as backslash-n. The command prints: the app's name and the account that owns it, its id (for `app.id` in the config), its slug, the page where it is installed (`<html_url>/installations/new`), the file's name, and, when GitHub gave no webhook secret, that one must be set by hand in the app's settings. The name, the owner and the addresses are printed with every character that is not printable ASCII replaced; and when `--org` was given and the owner is another account, a line says so. It ends with 0.
11. **Failed after the way back.** Nothing is written and the reserved file is removed. The command prints the short code, then that an app may now exist on GitHub with no key in anyone's hands, where its settings are (`https://github.com/settings/apps`, or `https://github.com/organizations/<org>/settings/apps`), and that a private key and a webhook secret can be generated there or the app deleted. It ends with 1.
12. **Never printed, logged or put in an error:** the key, the secret, the code, the `state`, and the address of the exchange (it holds the code).
13. The listener binds `127.0.0.1` only, on a port the system picks. That, and the wiring of the file calls, is in code no test reaches: `reserveFile` is exported and tested on a temporary folder; the bind address is read by eye, and the task's report quotes the line. The key is written through the descriptor the reservation opened, never by the file's path again. Stopping the command (an interrupt, a termination, a closed terminal) removes the reserved file while the key is not written, and says that an app may exist when the way back had been taken.

- [ ] **Step 1: Write the failing tests.**

```ts
// app-manifest.test.ts
test('an app made from the manifest lacks nothing the service needs', () => {
  const info = { botLogin: 'x[bot]', permissions: manifest.default_permissions, events: manifest.default_events };
  assert.deepEqual([missingFor(info, true), missingFor(info, false)], [[], []]);
});
test('the manifest asks for nothing the service does not use', () => { /* for each permission but metadata and each event: without it missingFor(info, false) names it; pull_requests, issues or contents lowered to read is named too */ });
test('the manifest is private, has an active hook and no address to come back to', () => { /* */ });
// create-app.test.ts
test('the manifest carries the webhook address and the way back', () => { /* manifestFor('https://reviews.example.test/webhooks/github', 'http://127.0.0.1:4010/created') */ });
test('the page posts the manifest to the account, or to the organisation', () => { /* the action in both forms; the hidden field decodes to the manifest; a quote and an angle bracket in the description are escaped; no <script */ });
test('the code is exchanged for the app', async () => { /* a stub fetch: the URL, the method, the headers (no Authorization); the answer mapped, owner.login and name too */ });
test('an answer without a key, one that is not JSON, and one that is not a success are refused by a short code', async () => { /* github_bad_response twice; github_422 with one call */ });
test('a failed network call and a server error are tried once more', async () => { /* fetch rejects then answers: the app; 502 then 201: the app; 502 twice: github_502 after two calls; rejects twice: github_network, and the error holds nothing of the address */ });
test('the secrets file holds the key on one line and the secret', () => { /* envLines: two lines; \r\n and \n both written as backslash-n; with a null secret: the key's line alone */ });
test('a reserved file is empty, for this user only, and is not reserved twice', () => { /* reserveFile in a temporary folder: true, mode 0600, size 0; again: false and the file untouched; in a folder that does not exist: false */ });
test('the way back with the right state fills the file and ends the command', async () => {
  /* run with a fake listen that drives handle: GET /<token>, then GET /created?code=abc&state=<state>: one exchange, one fill of the out path with the env lines, the browser sent to /done,
     exit 0; the printed lines hold the name, the owner, the id, the slug, the install page and the file name, and neither the key, the secret, the code nor the state */
});
test('the page is served only at its own address', async () => { /* GET / is 404; GET /<another token> is 404; the printed address is the one that answers */ });
test('a request under another host name is refused', async () => { /* host 'evil.example.test:4010': 400 for /<token> and for /created with the right state; no exchange */ });
test('a wrong state, a missing state and an odd code change nothing', async () => { /* 400 each; no fetch, no fill; the command still waits */ });
test('the way back is taken once', async () => { /* a second /created with the right state: 409, no second exchange, the file as it was */ });
test('a failed exchange writes nothing, releases the file and says what to do', async () => { /* github_422: exit 1, release called, the printed lines hold the code github_422 and the settings address (the organisation's when --org was given) */ });
test('an app with no webhook secret is written with its key alone, and the command says so', async () => { /* */ });
test('bad arguments stop the command before anything is created', async () => { /* http url; no host; an org with a slash: usage, exit 2, reserve and listen never called */ });
test('a file that exists, or cannot be created, stops the command before it listens', async () => { /* reserve answers false: exit 2, listen never called */ });
test('another path is not found and another method is refused', async () => { /* /favicon.ico 404; POST /<token> 405 */ });
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** The manifest is imported with `import manifest from './app-manifest.json' with { type: 'json' }`.
- [ ] **Step 4: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 5: Commit** `feat: an app manifest, and a command that creates the app from it`.

---

### Task 7: The README and a real run

**Files:**
- Modify: `README.md`, `config.example.yml` (its comment for `inlineNotes`, if Task 1 left it short), `env.example` (one line saying the command can write the two secrets)

**Rules:**

1. **README.** Each sentence states only what the code does, and names its cost where it has one:
   - **Creating the app:** `npm run app:create`, what it asks GitHub for and why each permission (the manifest's list), what it writes and where, what it prints, and what is left to do by hand: put the id in the config, lower `Contents` to read-only if the app is not to hold write access, and install the app on repositories. Also: the command runs on the machine whose browser is used, with Node 26 and nothing installed; the webhook URL is the service's public address with the path `/webhooks/github`; the app's name must be unique on GitHub and is changed on GitHub's own page before creating; the app is private, so for an organisation's repositories it is created with `--org`; and what to do when the command fails after GitHub created the app. The permissions the service checks at start are the manifest's; the by-hand list stays for an adopter who creates the app in GitHub's own form.
   - **Inline notes:** off unless `score.inlineNotes` is true, for all repositories or for one; one note for each block at or above the threshold, on its first changed line, saying what the body's line says; at most 50 a review, the highest first, the next ones at the next review that is posted; none twice; a note is an ordinary review thread that someone has to resolve where a repository requires resolved conversations; no later review judges it; when GitHub refuses the review for a comment, the notes are dropped first and given at the next review, and if it refuses them again they are dropped again: a note GitHub never accepts keeps every note of that pull request from being posted. What else it costs: a block flagged only through its file's whole-file score gets no note, so a model that answers files as a whole gives few; with more than 50 flagged blocks a block can be in neither the body's list nor the notes of one review; a review that a later start publishes goes without its notes; each note is a thread, so the limits on reading a pull request's threads and comments are reached sooner; the app never resolves a note; in dry run each head records its notes as if none had been given.
   - The `## Status` section: inline notes and the app manifest are built, and not tried against a real GitHub App; a review with many notes in particular was not tried.
   - Every sentence that says inline notes or the manifest are not built is corrected wherever it stands.
2. **A real run under Docker,** made by the controller after the fix wave, on its code, as in plan 7: the previous release on a fresh database; this branch on that database (the ledger gains `0005_notes`; old comment rows read with no block hash); a note row written and read on a real Postgres; a start out of dry run that goes on without GitHub; a log of ids, codes and counts only. The command of Task 6 is not run there: it needs a browser signed in to GitHub.

- [ ] **Step 1: Write the README.** For each sentence written or kept in the sections touched, name the code that makes it true in the report.
- [ ] **Step 2: Run** the suite, the type check, the lint and the ASCII check.
- [ ] **Step 3: Commit** `docs: the README says how the app is created and what inline notes are`.

---

## To verify with a real app

Each of these needs the owner's go-ahead. The last also needs him at the browser: creating an app is his to do.

1. **One review can carry 50 inline notes on top of its findings** (design 20, item 9). Tried first, because its failure is the worst this plan can cause. If GitHub answers with something other than a refusal of a comment, the log shows `publish_code` with a `github_` code and the job is started again; from the second start the review goes without its notes (call 12).
2. **A note's text comes back from GitHub as it was sent:** the read-back's `notes_missing` is 0, and the next review of the pull request shows no note thread to the model, replies to none and repeats none.
3. How a note reads in the diff, and that a mention or a tag in a reason is not live there.
4. A review GitHub refuses for one comment: which try is accepted.
5. A note resolved by a person stays resolved and is not given again.
6. **The manifest flow accepts this permission set** (design 20, item 3): `npm run app:create` against GitHub, the page, the way back to `127.0.0.1` on a port the system picked, the exchange, the file; then a start of the service with what it wrote.

## What was built

All seven tasks were built and reviewed, and corrected after a review of the whole branch; the rules above are the rules as built (calls 14 to 16 came from that review and from the trial; call 2 was turned round by the owner after the merge). What was decided on the way, what the real run and a trial with a real app showed, and what was put off are in `2026-11-21-inline-notes-and-the-app-manifest-notes.md`.

Of "To verify with a real app": items 1, 2, 3 and 5 were seen. Item 1 with a twist: GitHub took the review and answered with a server error; the next start adopted it. Item 4 was not met. Item 6, the manifest flow, was not tried: it needs a person at a browser.
