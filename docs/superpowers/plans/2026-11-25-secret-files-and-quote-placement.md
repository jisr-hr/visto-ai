# Secret Files and Quote Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Never send a secret file's text to a model, and place each finding on the line its quote names before falling back to the line number it gives.

**Architecture:** A pure path test (`isSecretPath`) runs before anything of a file is fetched; such a file gets no context, is listed as not reviewed and scores 100%. Placement gains a first step that matches the finding's `quote` against the text of the file's commentable lines, and a last step that re-files a finding that cannot be placed in its own file onto the one line of another file of its batch that its quote matches.

**Tech Stack:** TypeScript on Node (run directly, no build), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-13-visto-ai-design.md` (sections 5.3, 5.6, 6.2), with the design below, agreed in conversation on 2026-11-25 (items 1 and 2 of the comparison with alibaba/open-code-review).

## Design

**Secret files.**

- A path is secret when one of its segments is `.ssh`, or its last segment is one of `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `.netrc`, `_netrc`, `.npmrc`, `.pypirc`, `.dockercfg`, or its last segment is `.env` or starts with `.env.`, except exactly `.env.example`, `.env.sample` and `.env.template`. Segments are compared case-insensitively. The list is our own, after the one open-code-review publishes; no text of theirs is copied.
- A changed file is secret when its path or its previous path is secret.
- Nothing of a secret file is fetched or sent: no patch, no full file, no paired test, no blocks. Its context has `skip: 'secret_file'` and score plan `{ kind: 'none', reason: 'secret_file' }`, so it is listed under `Coverage` as `secret_file`, scores 100% and keeps the pull request from automatic approval. Its path is still shown where paths are shown.
- `replay --plain` leaves a secret file's patch out too, and counts it as not reviewed with `secret_file`.

**Placement by quote** (section 5.6, step 4, now in this order):

1. A quote is compared after trimming white space at both ends (this also removes a carriage return). An empty quote after trimming skips steps 2 and 3.
2. **As given.** When the finding's line is commentable on its side and its text equals the quote, it is kept.
3. **By quote, in its own file.** Otherwise, the commentable lines of the file whose text equals the quote are taken, first on the finding's side, then on the other side. On the first side with any, the one nearest the given line is taken, the earlier on a tie. The finding moves there, its side too, with no note (`requestedLine` stays null: it is not "just outside the diff"), and an audit entry `placed_by_quote`, subject `path:side:line`, reason `to side:line`.
4. **By line.** Otherwise the existing rules: a commentable line is kept; one within 3 lines is moved with its note; anything else is not placed.
5. **Re-filed.** A finding that step 4 would leave unplaced (`line_not_in_diff` or `file_has_no_patch`) is matched against the commentable lines, on both sides, of the other files of the batch that answered. When exactly one line in all of them matches, the finding moves to that file, side and line, with no note, and an audit entry `refiled`, subject `path:line`, reason `to path:side:line`. Zero or several matches leave it unplaced, as before.

**As built, after the final review.** Steps 2 and 3 were changed: a finding on a commentable line is kept whatever its quote (in incremental mode and a re-check, the line the model named decides whether the finding is on changed code, and a quote move would lose it), so the quote only places a finding whose line cannot take a comment. And when the full file shown to the model has the quote on exactly the line the finding names (new side, outside the diff), the finding is about code the diff does not show: neither the quote nor re-filing places it (a short quote such as `});` would otherwise carry it onto unrelated code, where it gates). Design section 5.6 states the rules as built.

`beyond_diff` findings are not placed, as before. A finding on a file outside the pull request or the batch is dropped before placement, as before.

## Global Constraints

- Every literal in a test is invented (`acme/shop`, invented paths and code).
- No test reaches GitHub, Postgres or a model.
- Run the whole suite with `npm test`, the types with `npm run typecheck` and the linter with `npm run lint`; all three must pass before each commit. A single test file runs with `node --import ./test/setup.ts --test <file>` (the setup blocks the network).
- Commits end with the co-author line your own session's attribution gives.

## Review Focus

- A quote with different indentation, or with the trailing carriage return of a CRLF file: it matches after trimming. Owner: Task 2.
- A quote that matches a context line on RIGHT and a removed line on LEFT: the finding's own side wins. Owner: Task 2.
- A one-character quote such as `}` that matches many lines of another file: no re-file (not exactly one). Owner: Task 3.
- `deploy/.env.example` is not secret, `deploy/.ENV.Local` and `.env.example.local` are, and `src/env.ts` is not. Owner: Task 1.
- A file renamed from `.env` to `config/settings.txt`: secret, nothing of it is fetched. Owner: Task 1.

---

### Task 1: Secret files are never sent

**Files:**
- Create: `src/engine/context/secret.ts`, `src/engine/context/secret.test.ts`
- Modify: `src/engine/context/build.ts` (the `skip` type and the top of the per-file loop), `src/engine/score/rules.ts` (`ScorePlan`, `scorePlan`), `src/engine/types.ts:176` (`NotReviewedReason`), `src/eval/plain.ts:133-139`
- Test: `src/engine/context/build.test.ts`, `src/eval/plain.test.ts`
- Docs: design 5.3 (a bullet after the file list: secret files) and 6.2 (the 100% paragraph names them); README, "How the engine works" step 2 and the control's paragraph under the benchmark

**Interfaces:**
- Produces: `isSecretPath(path: string): boolean` and `isSecretFile(file: ChangedFile): boolean` in `src/engine/context/secret.ts`; `NotReviewedReason` gains `'secret_file'`; `FileContext['skip']` and `ScorePlan` `none` reasons gain `'secret_file'`.

- [ ] **Step 1: Write the failing tests** in `secret.test.ts`: `isSecretPath` is true for `.env`, `app/.env.production`, `deploy/.ENV.Local`, `.env.example.local`, `home/.ssh/config`, `keys/ID_RSA`, `.npmrc`, `pkg/_netrc`; false for `.env.example`, `deploy/.env.sample`, `.env.template`, `src/env.ts`, `environment.env`, `ssh/config`, `docs/npmrc.md`. `isSecretFile` is true for a rename with `previousPath: '.env'` and `path: 'config/settings.txt'`.
- [ ] **Step 2: Write the failing build test** in `build.test.ts`: a pull request with `app/.env.production` (a patch) and `src/a.ts`: the secret file's context has `skip: 'secret_file'`, `hunks: []`, `diffText: null`, `full: null`, `test: null`, `blocks: []`, `plan: { kind: 'none', reason: 'secret_file' }`; the stub source's `calls` hold no path of it (no content fetch, no test probe); and `packBatches` lists it in `notReviewed` with reason `secret_file`.
- [ ] **Step 3: Run** `node --import ./test/setup.ts --test src/engine/context/secret.test.ts src/engine/context/build.test.ts`. Expected: FAIL (module not found, then assertions).
- [ ] **Step 4: Implement** `secret.ts`, then in `buildFileContexts` push the secret context and `continue` at the top of the loop, before any fetch; `scorePlan` returns `{ kind: 'none', reason: 'secret_file' }` for `skip === 'secret_file'`. `packBatches` needs no change (it already lists `none` reasons other than `unchanged`).
- [ ] **Step 5: Write the failing control test**: `replay --plain` on a case whose files are `.npmrc` and `src/a.ts`, both with patches: the user message sent to the stub model holds no text of `.npmrc`'s patch, and the result's `not_reviewed` counts `secret_file: 1`. Then implement it in `plain.ts`: secret files leave `withPatch` and are counted as `secret_file`.
- [ ] **Step 6: Run** `npm test`, `npm run typecheck` and `npm run lint`. Expected: PASS.
- [ ] **Step 7: Update the docs** named above, then commit: `feat: a secret file is never sent to a model, is listed as not reviewed and scores 100%`.

### Task 2: Placement by quote in the finding's own file

**Files:**
- Modify: `src/engine/context/diff.ts` (add `lineTexts`), `src/engine/reconcile/placement.ts` (`place`), `src/engine/reconcile/index.ts` (pass the texts, write the audit entry)
- Test: `src/engine/context/diff.test.ts`, `src/engine/reconcile/placement.test.ts`, `src/engine/reconcile/index.test.ts`

**Interfaces:**
- Produces: `interface LineTexts { RIGHT: Map<number, string>; LEFT: Map<number, string> }` and `lineTexts(hunks: Hunk[]): LineTexts` in `diff.ts` (the same lines `commentableRanges` counts: add and context lines on RIGHT, removed lines on LEFT, keyed by their line number, text as in the hunk); `place(f: RawFinding, ranges: Ranges | null, texts: LineTexts | null): { placed: Finding; how: 'as_given' | 'quote' | 'line' } | { unplaced: UnplacedFinding }`; `quoteMatches(quote: string, texts: LineTexts): { side: Side; line: number }[]` (every match, RIGHT first, each side in line order; `[]` for an empty quote), exported for Task 3.

- [ ] **Step 1: Write the failing tests.** `lineTexts` of a hunk with one context, one removed and one added line gives the expected two maps. In `placement.test.ts`, with texts for RIGHT 10-13 and LEFT 11:
  - the line's own text equals the quote: kept, `how: 'as_given'`;
  - the quote is on RIGHT 12 and the finding says RIGHT 10: placed at 12, `requestedLine: null`, `how: 'quote'`;
  - the quote is on RIGHT 11 and RIGHT 13 and the finding says RIGHT 12: placed at 11 (a tie goes to the earlier);
  - the quote is `'    total = a + b\r'` against the line text `'total = a + b'`: matches;
  - the quote is only on LEFT 11 and the finding says RIGHT 30: placed at LEFT 11;
  - the quote matches both RIGHT 10 and LEFT 11, finding on LEFT 2: LEFT 11;
  - an empty or white-space quote, finding on RIGHT 15: the line rule, placed at 13 with `requestedLine: 15`, `how: 'line'`;
  - a quote that matches nothing, finding on RIGHT 12: kept at 12, `how: 'line'`;
  - `texts: null` behaves as today (every existing test keeps passing with `null`).
  In `index.test.ts`: a finding moved by its quote yields one audit entry `{ stage: 'reconcile', action: 'placed_by_quote', subject: 'src/a.ts:RIGHT:10', reason: 'to RIGHT:12' }` and no `moved` entry.
- [ ] **Step 2: Run** `node --import ./test/setup.ts --test src/engine/context/diff.test.ts src/engine/reconcile/placement.test.ts src/engine/reconcile/index.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `lineTexts`, `quoteMatches` and the new `place`, then in `reconcile` build a `Map<string, LineTexts>` from each context's `hunks` (null when `ranges` is null) and pass it.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck` and `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: a finding is placed on the line its quote names before the line it gives`.

### Task 3: A finding re-filed by its quote within its batch

**Files:**
- Modify: `src/engine/reconcile/index.ts`
- Test: `src/engine/reconcile/index.test.ts`
- Docs: design 5.6 step 4 (the five steps of the design above), README "How the engine works" step 5

**Interfaces:**
- Consumes: `quoteMatches`, `LineTexts`, `place` from Task 2.

- [ ] **Step 1: Write the failing tests** in `index.test.ts` (contexts with real hunks for `src/a.ts`, `src/b.ts`, `src/c.ts`):
  - a finding on `src/a.ts` RIGHT 40 (far outside its ranges) whose quote is on exactly one line, `src/b.ts` RIGHT 11: placed on `src/b.ts` RIGHT 11, `requestedLine: null`; audit `{ action: 'refiled', subject: 'src/a.ts:40', reason: 'to src/b.ts:RIGHT:11' }`;
  - the same quote on one line of `src/b.ts` and one of `src/c.ts`: unplaced `line_not_in_diff`, no `refiled` entry;
  - the quote `}` on several lines of `src/b.ts`: unplaced;
  - the quote's only match is in `src/c.ts`, which is not in the answering batch: unplaced;
  - a finding on `img/logo.bin` (no patch) whose quote is on one line of `src/b.ts`: re-filed there;
  - a finding on `src/a.ts` placed by its line (RIGHT 12 inside the range) whose quote is only in `src/b.ts`: stays on `src/a.ts` (re-filing runs only for a finding its own file cannot take).
- [ ] **Step 2: Run** `node --import ./test/setup.ts --test src/engine/reconcile/index.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `reconcile`: on `unplaced`, collect `quoteMatches` over the other paths of `answer.files` that have texts; on exactly one, push the finding with that path, side and line and the audit entry; otherwise keep it unplaced.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck` and `npm run lint`. Expected: PASS.
- [ ] **Step 5: Update the docs** named above, then commit: `feat: a finding its own file cannot take is re-filed on the one line of its batch its quote names`.
