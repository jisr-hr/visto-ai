# The Docs Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split this repository's README into the docs pages that `visto-ai.com/docs` publishes. The pages live in `docs/guide/`, the README shrinks to a summary that links to them, a check in CI keeps them valid, and a workflow tells the website to rebuild when a release changes them.

**Architecture:**
- The README's sections move, word for word, into plain Markdown pages under `docs/guide/`. Each page has the frontmatter Starlight reads, and `sidebar.json` orders them.
- A test in this repository enforces the rules the website's build enforces, so a broken page fails here, in the pull request, and not later in the website's deploy.
- On every release to `main` that touches `docs/guide/`, a workflow sends `docs-changed` to the private website repository.
- A small change in the website repository points "Edit page" links at `dev`, where pull requests go.

**Tech Stack:** Node 26 with `node --test` (this repository's runner), GitHub Actions, and Markdown. In the website repository (`visto-ai/website`, private): Astro, Starlight, Vitest.

**Spec:** the website design, `docs/superpowers/specs/2026-11-26-the-website-design.md` in the website repository (`visto-ai/website`), section "The docs pages and the README". Its rules:
- the pages are the one source;
- they are written in plain Markdown that reads well on GitHub;
- they live in a folder of their own, `docs/guide/`;
- the README keeps the pitch, the status table and links to the pages;
- no text is lost;
- anchors other files link to are updated.

## Global Constraints

- **Branches.** Work in this repository on branch `docs-guide`, made from `origin/dev`, which is the default branch where pull requests go. `main` receives releases (`.github/workflows/release.yml`). Work in the website repository on a branch `edit-on-dev` made from its `main`.
- **Word for word.** README text moves without being rewritten. The only changes allowed are:
  - heading levels, so each page's sections start at `##`;
  - the "(optional)" suffix dropped from a title when it becomes the page's own title;
  - links rewritten to their new pages (see Task 2);
  - one new frontmatter `description` per page.

  No new prose, with one exception: the index page's short list of links, and the README's.
- **Page rules**, which are the website's build rules (`scripts/docs-source.ts` and `scripts/fetch-docs.ts` there). A page that breaks them fails the website build.
  - Frontmatter has `title` and a one-line `description`.
  - There is no body heading `# ` outside fenced code. Starlight renders the title as the page's only h1.
  - `index.md` exists.
  - `sidebar.json` lists every page once and only pages that exist. A slug is the file name without `.md`, and `""` stands for `index.md`.
  - Links between pages are relative (`automatic-approval.md#the-permission`). A link that leaves the guide is relative too (`../../README.md`), and the website turns it into a GitHub link.
  - Use only inline links `[text](target)`. The website does not rewrite reference-style links.
  - No GitHub alerts (`> [!NOTE]`); Starlight shows them as plain text. A plain blockquote is fine.
  - No images.
- **History stays as it is.** Leave `docs/superpowers/plans/**` and `docs/superpowers/specs/**` unchanged: they record history. Update links in every other tracked file.
- **Nothing private.** Example values stay as the README has them.
- **Commits.**
  - Commit messages are conventional (`docs:`, `test:`, `ci:`, `fix:`). `commits.yml` checks them.
  - Each commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Public commits use the Gmail author that is already configured. Do not change the git identity.
  - Do not push.

## Review Focus

1. **A README link that pointed at an anchor in another section.**
   - **Problem:** after the split, an anchor such as `#automatic-approval-optional` no longer exists in the page the link now sits in. On GitHub it silently goes nowhere.
   - **Expected:** every link resolves to an existing file and heading.
   - **Test:** in Task 1, the guide check resolves `file.md#anchor` against GitHub's heading slugs.
2. **A section whose text sits under a different heading level after the move**, for example an `####` under `###`.
   - **Problem:** the hierarchy on the page breaks, or a heading comes out at h1.
   - **Expected:** each page starts at `##` and its levels never skip.
   - **Test:** in Task 1, a check that heading levels never jump by more than one.
3. **A reader who arrives at an old README anchor from an outside link or a bookmark.**
   - **Expected:** the shrunk README still shows where that section went.
   - **Test:** in Task 3, the README's docs list names every page. The plan accepts that old `#…` anchors in the README die; the list replaces them.
4. **A release that changes only the README or code.**
   - **Expected:** it must not wake the website for nothing.
   - **Test:** in Task 4, the workflow's `paths` filter is `docs/guide/**`, and a test pins that filter.
5. **The dispatch token missing**, before the owner adds it.
   - **Expected:** the release must not fail; the workflow skips with a notice.
   - **Test:** in Task 4, a test pins that the gate comes first.

---

## Page map

All files are in `docs/guide/`. The headings are the current README's, on `origin/dev`. Copy the text of each named heading, together with all its subsections, up to the next heading of the same or a higher level.

| Page | Title | Comes from |
|---|---|---|
| `index.md` | Introduction | the opening paragraph and the status blockquote; "Why"; "What it is designed to do". Then a list linking every page, grouped as in the sidebar, and one line linking the README's "Status" on GitHub. |
| `quick-start.md` | Quick start | "Run the service", its own text before "Creating the app" |
| `create-the-github-app.md` | Create the GitHub App | "Creating the app" |
| `leave-dry-run.md` | Leave dry run | "Leaving dry run", then "Reading what a review would have posted" as a `##` section |
| `the-score.md` | The score | "The score" |
| `how-a-review-runs.md` | How a review runs | "How the engine works" |
| `scores-across-reviews.md` | Scores across reviews | "Scores kept across reviews" |
| `automatic-approval.md` | Automatic approval | "Automatic approval (optional)" |
| `merge-gate.md` | The merge gate | "The merge gate (optional)", including "What was tried against GitHub, and what was not" |
| `inline-notes.md` | Inline notes | "Inline notes (optional)" |
| `memory.md` | Memory | "Memory (optional)", without "Reverts" and "Lessons" |
| `lessons-and-reverts.md` | Lessons and reverts | "Lessons", then "Reverts" |
| `second-scorer.md` | A second scorer | "A second scorer (optional)" |
| `the-ui.md` | The UI | "The UI (optional)" |
| `extension-modules.md` | Extension modules | "Extensions (optional)" |
| `extension-contract.md` | The extension contract | the whole of `docs/extensions.md`, moved here with `git mv`; its `# ` title becomes frontmatter |
| `mcp-tools.md` | MCP tools | "MCP tools (optional)" |
| `configuration.md` | Configuration | "Configuration", its own text before "Inline notes" |
| `visto-ai-yml.md` | .visto-ai.yml | "The file a team commits" |
| `running-the-service.md` | Running the service | "Running it", with its "Setup notes" and "What to know before you expose it" |
| `development.md` | Development | "Development" |
| `repository-layout.md` | Repository layout | "Repository layout" |
| `replay.md` | Replay | "Replay" |
| `backtest.md` | Backtest | "Backtest", including "The backtest with memory" |
| `benchmark.md` | Benchmark | "Benchmark (AACR-Bench)" |

**`sidebar.json`:**

```json
[
  { "label": "Start here", "items": ["", "quick-start", "create-the-github-app", "leave-dry-run"] },
  { "label": "Concepts", "items": ["the-score", "how-a-review-runs", "scores-across-reviews"] },
  { "label": "Features", "items": ["automatic-approval", "merge-gate", "inline-notes", "memory", "lessons-and-reverts", "second-scorer", "the-ui"] },
  { "label": "Extend", "items": ["extension-modules", "extension-contract", "mcp-tools"] },
  { "label": "Reference", "items": ["configuration", "visto-ai-yml", "running-the-service", "development", "repository-layout"] },
  { "label": "Measure", "items": ["replay", "backtest", "benchmark"] }
]
```

**What stays in the README only:**
- the icon;
- the title;
- the opening paragraph and the status blockquote;
- "Status", with its whole table;
- "Licence";
- a new "Documentation" section: one line pointing at `visto-ai.com/docs` once the site is live, the same grouped links as `index.md` (to the files in `docs/guide/`), and the two sentences of "Why" as the pitch.

**Calls I made** (the website design did not settle these):
- The design's sidebar names "Findings", "Threads and /review", "GitHub permissions" and "Alerts and codes". None of them has a README section of its own. Writing them would be new prose, so they are left out. Their text stays where the README has it today: the findings rules in "Why" and in "How the engine works", and `/review`, the permissions and the alert codes inside the feature sections.
- `Development`, `Repository layout` and `Running the service` go under Reference.
- "Status" stays in the README only, as the design says, and `index.md` links to it.
- `docs/extensions.md` moves into the guide, so the docs site shows the contract.

---

### Task 1: The guide check

**Files:**
- Create: `test/guide/check.ts`, `test/guide/check.test.ts`

**Interfaces:**
- Produces:
  - `slugify(heading: string): string`. It applies GitHub's heading-anchor rule: lowercase; drop every character that is not a letter, digit, space, `-` or `_`; turn each space into `-`. So `"Automatic approval (optional)"` becomes `"automatic-approval-optional"`, and `"What was tried against GitHub, and what was not"` becomes `"what-was-tried-against-github-and-what-was-not"`. A heading that repeats in the same file gets `-1`, `-2` and so on.
  - `checkGuide(dir: string, repoRoot: string): string[]` returns a list of problems, empty when the guide is valid. Each problem names its file. The checks, outside fenced code:
    - frontmatter `title` and `description` are present and not empty;
    - no `# ` body heading;
    - heading levels start at `##` and never skip a level;
    - `index.md` exists;
    - `sidebar.json` lists every page once and only pages that exist;
    - no reference-style link definitions;
    - no `> [!` alert lines;
    - no images `![`;
    - every relative link resolves: the target file exists inside `repoRoot`, and its `#anchor`, if given, is a heading slug in that file (anchors are checked only for `.md` targets).
  - `checkLinks(file: string, repoRoot: string): string[]` runs the link check alone. Task 3 uses it on `README.md`.

- [ ] **Step 1: Write the failing tests.** Each builds a temp directory with the pages it needs.

```ts
// test/guide/check.test.ts (node:test, node:assert/strict)
test('slugs follow GitHub', () => {
  assert.equal(slugify('Automatic approval (optional)'), 'automatic-approval-optional');
  assert.equal(slugify('What was tried against GitHub, and what was not'), 'what-was-tried-against-github-and-what-was-not');
  assert.equal(slugify('The file a team commits'), 'the-file-a-team-commits');
});
test('a valid guide has no problems', ...);                    // index.md + a.md + sidebar.json [["", "a"]] -> []
test('a missing description is named', ...);                   // -> [/a\.md: .*description/]
test('a body h1 outside fences is refused, inside fences is not', ...);
test('a level that skips is refused', ...);                    // "## A" then "#### B" -> [/a\.md: .*level/]
test('no index.md is refused', ...);
test('the sidebar must list every page once', ...);            // unlisted, missing and duplicate slugs each named
test('a broken link or anchor is named', ...);                 // [x](b.md) with no b.md; [x](a.md#nope)
test('a link out of the guide resolves in the repo', ...);     // [x](../../README.md#licence) passes when README has "## Licence"
test('reference links, alerts and images are refused', ...);
```

- [ ] **Step 2: Run `node --test test/guide/check.test.ts`.** Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement `test/guide/check.ts`.**
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit.** `test: a check that keeps the docs guide valid for the website`

---

### Task 2: The guide pages

**Files:**
- Create: every page in the Page map, and `docs/guide/sidebar.json`.
- Move: `docs/extensions.md` → `docs/guide/extension-contract.md` (with `git mv`).
- Modify: `test/guide/check.test.ts`, adding the test below.

**Interfaces:**
- Consumes: `checkGuide` from Task 1.

**Link rewriting while moving the text:**
- A README link `(#x)` whose heading now lives in page `p.md` becomes `(p.md#x2)`, where `x2` is that heading's slug in `p.md`. When the heading has become the page's title, drop the anchor and keep only `p.md`.
- A link to a heading on the same page stays `(#x2)`.
- A link from the guide to a file elsewhere in the repository becomes relative from `docs/guide/`, for example `../../config.example.yml` and `../benchmarks/…`.
- In the moved contract (`extension-contract.md`), the internal anchors such as `(#feedback)` keep working as they are.

- [ ] **Step 1: Write the failing test.**

```ts
test("the repository's guide is valid", () => {
  assert.deepEqual(checkGuide('docs/guide', '.'), []);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL, because there is no `docs/guide`.
- [ ] **Step 3: Write the pages from the Page map.** Copy the text word for word, with only the changes in Global Constraints. Give each page one `description` sentence, taken from its section's first sentence where it can serve.
- [ ] **Step 4: Prove that no text is lost.** Check that every non-blank line of the README's moved sections appears in some page. Lines may differ only by:
  - heading markers;
  - link targets;
  - the heading that became a title.

  Do it with a throwaway script, report the result, and do not commit the script.
- [ ] **Step 5: Run `npm test`.** Expected: PASS, with the guide check clean.
- [ ] **Step 6: Commit.** `docs: the README's sections as the docs guide`

---

### Task 3: The README, shrunk, and the links that pointed into it

**Files:**
- Modify: `README.md`, `config.example.yml` (its two `docs/extensions.md` lines), `docs/benchmarks/*.md` (links to README sections), and any other tracked file outside `docs/superpowers/` that links to `README.md#…` or `docs/extensions.md`. Find them with `git grep -n -E "README\.md#|docs/extensions\.md"`.
- Modify: `test/guide/check.test.ts`.

- [ ] **Step 1: Write the failing tests.**

```ts
test("the README's links resolve", () => {
  assert.deepEqual(checkLinks('README.md', '.'), []);
});
test('the README links every page', () => {
  const readme = readFileSync('README.md', 'utf8');
  for (const page of readdirSync('docs/guide').filter((f) => f.endsWith('.md')))
    assert.ok(readme.includes(`docs/guide/${page}`), page);
});
test('no tracked file outside the history links to a gone README section or to docs/extensions.md', ...);
// for each file from `git ls-files '*.md' '*.yml'` outside docs/superpowers/: checkLinks(...) is []
// and the text never names docs/extensions.md
```

- [ ] **Step 2: Run the tests.** Expected: FAIL. The README still holds everything, which is not a failure in itself, but the "links every page" test fails, and the benchmark docs still point at moved anchors.
- [ ] **Step 3: Shrink `README.md`** to what the Page map keeps. Point every other link at its page.
- [ ] **Step 4: Run `npm test`, `npm run typecheck` and `npm run lint`.** Expected: PASS.
- [ ] **Step 5: Commit.** `docs: the README is a summary that links to the docs guide`

---

### Task 4: Tell the website when a release changes the docs

**Files:**
- Create: `.github/workflows/docs-site.yml`
- Create: `test/guide/workflow.test.ts`

**Interfaces:**
- The workflow:
  - `on: push: branches: [main], paths: ['docs/guide/**']`, plus `workflow_dispatch`;
  - `permissions: contents: read`;
  - one job with `env: TOKEN_SET: ${{ secrets.WEBSITE_DISPATCH_TOKEN != '' }}`. Its first step prints a notice and ends when the token is not set. The next step, gated on `TOKEN_SET`, runs `gh api repos/visto-ai/website/dispatches -f event_type=docs-changed -f 'client_payload[ref]=${{ github.sha }}'`, with `GH_TOKEN: ${{ secrets.WEBSITE_DISPATCH_TOKEN }}`. Pass the SHA through `env`, never interpolate it into `run:`.
- The test reads the YAML with the `yaml` package (already a dependency) and asserts:
  - the trigger branch is `main` and the only path is `docs/guide/**`;
  - the first step is the token check;
  - the dispatch's `event_type` is `docs-changed`;
  - no `run:` line contains `${{`.

- [ ] **Step 1: Write the failing test.** Then run it. Expected: FAIL.
- [ ] **Step 2: Write the workflow.** Then run `npm test`. Expected: PASS.
- [ ] **Step 3: Add the README line.** One line in the README's Documentation section: the website is rebuilt from `main` when a release changes `docs/guide/`.
- [ ] **Step 4: Commit.** `ci: tell the website to rebuild when a release changes the docs guide`

---

### Task 5: The website edits on `dev`, and the token step (website repository)

Work in the website repository (`visto-ai/website`), on branch `edit-on-dev` made from `main`.

**Files:**
- Modify: `scripts/fetch-docs.ts`, `tests/unit/fetch-docs.test.ts`, `tests/e2e/docs.spec.ts`, `docs/launch.md`, `README.md`

**Interfaces:**
- Today `editUrl` is `${APP_REPO}/edit/${ref}/docs/guide/<file>`, built from `DOCS_REF`. Change it to always use the branch `dev` (a constant `EDIT_BRANCH = 'dev'`), whatever ref the docs are built from. The docs are built from `main` or from a release SHA; edits go to `dev`, where pull requests go.
- `lastUpdated` still comes from the built ref.

- [ ] **Step 1: Update the failing tests.**
  - The e2e test expects `https://github.com/visto-ai/visto-ai/edit/dev/docs/guide/the-score.md`.
  - The unit test runs app mode with `DOCS_REF` set to a SHA, and expects the edit URL on `dev`.
- [ ] **Step 2: Run the tests.** Expected: FAIL. Then implement until they PASS.
- [ ] **Step 3: Update `docs/launch.md` step 2.**
  - **The token:** in the app repository, the secret `WEBSITE_DISPATCH_TOKEN` must be a fine-grained token that can only create repository dispatch events on `visto-ai/website` (Contents: read and write on that one repository; GitHub requires write access for dispatches).
  - **The docs:** they are built from `main`, which is the released state.
  - Add the same to the README.
- [ ] **Step 4: Run `npm test` and `npm run test:e2e`.** Expected: PASS.
- [ ] **Step 5: Commit.** `fix: edit links open the docs on dev, where pull requests go`
