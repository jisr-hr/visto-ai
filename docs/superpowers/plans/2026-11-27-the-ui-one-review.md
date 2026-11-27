# The UI, One Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A row of Activity's Recent reviews opens the page of that review at `/ui/reviews/<run>`, for a viewer and an admin alike: why it approved or did not (the approval paragraph's code and text, or "Not decided in dry run"), the merge gate's state at its commit, the score of each file with why and its blocks, the files not reviewed and why, the findings with their severity, place and thread state, the earlier threads it cleared or left open and the findings it dropped as already discussed, its usage, the approval record (its own code, the approvals of the pull request up to it and their withdrawal), the status of each dependency as the run stored it, and the feedback people gave; a selector moves between the reviews of the pull request. Everything is read from what is stored: no migration, and nothing is read from GitHub on a view.

**Architecture:** Two read routes join the UI's API: `GET /api/reviews/{run}` and `GET /api/pulls/{owner}/{repo}/{number}/reviews`, dispatched by `src/ui/route.ts` before its table of exact paths, behind a session like Activity's reads. `src/db/review-page.ts` holds every statement (the run with its pull request and job, its first comments, people's thread events, later runs' verdicts, the gate's newest evaluation at the head, the approvals up to the run, a pending withdrawal, the feedback, the runs of a pull request). `src/ui/review-result.ts` reads the stored `result` field by field (it may be of an older shape), `src/ui/threads.ts` derives a finding's thread state, and `src/ui/review.ts` builds the two answers from an allowlist of fields. In `ui/`, the client gains two reads, and `ui/src/pages/review.tsx` draws the page of `Review.dc.html` with the existing components and the theme's token classes.

**Tech Stack:** Unchanged: Node 26 or later, type stripping, no build step, no new library in `src/` or in `ui/`; React 19, Vite, Tailwind v4 with the tokens of `ui/src/index.css`, Vitest and Testing Library on jsdom. No migration. No model call.

**Spec:** `docs/superpowers/specs/2026-11-25-the-ui-design.md` ("the design"; sections 1 item 3, 3.3 items 6 and 9, 3.4, 5, 6 and 8), its mockup `docs/superpowers/specs/2026-11-25-the-ui-mockups/Review.dc.html` ("the mockup"; its content, cards and wording; its colours are replaced by the theme's tokens, call 4), and the merged plans `docs/superpowers/plans/2026-11-25-the-ui-sign-in-and-activity.md` ("the first plan") and `docs/superpowers/plans/2026-11-26-password-sign-in-and-roles.md` ("the password plan") with their notes, whose calls and "as built" rules stand unless a call here changes them. Executors read the design and the first plan's calls 13, 17, 20, 21 and 22.

**Notes:** the notes file beside this plan, `docs/superpowers/plans/2026-11-27-the-ui-one-review-notes.md`, is written when the build ends. This is the second of the two plans of the frame (design 7, item 1; the first plan's call 1). It is built on a branch `ui-review` cut from `ui-theme` (`dev` and one commit of new colours, pull request 35, not merged when this plan was written); its pull request carries that commit unless pull request 35 merges first. This plan, `docs/superpowers/plans/2026-11-27-the-ui-one-review.md`, is committed on the branch before Task 1 as `docs: the plan of the UI's One review screen`.

**Words used below.** *The run*: the row of `visto_ai.review_runs` a page is for. *Its pull request*: the run's service, owner, repo and number (owner and repo stored lower-cased). *The result*: the run's stored `result` (the engine's `ReviewResult` as it was when stored; any field may be absent or of another shape). *A placed finding*: an entry of `result.findings`. *A first comment*: a row of `visto_ai.review_comments` of the run whose `severity` is `blocker`, `major` or `minor` (a note's is `note`). *A later run*: a published run of the same pull request with a higher id. *A signal*: a person's thread event or a later run's verdict on a first comment (Task 3). *The paragraph*: the sentence an approval decision ends a posted review with (`src/approval/text.ts`, `approvalParagraph`). *The ordinal*: a run's place among every run of its pull request by id, the first being 1. *As drawn*: the mockup's markup, texts and classes, translated to the tokens. *Short code*: as in the plans before (`isShortCode`, `src/shell/codes.ts`).

## Scope

| In this plan | Left out, and why |
|---|---|
| `GET /api/reviews/{run}` and `GET /api/pulls/{owner}/{repo}/{number}/reviews`, their shapes in `src/ui/api-types.ts` | **Any migration** (call 2): everything shown is read from what is stored |
| The reads of one run, its comments, thread events, later verdicts, the gate's state, approvals, a pending withdrawal and feedback (3.3, items 6 and 9) | **Dependency health over time and alerts** (3.3, items 3 and 4): plan 3's tables; the card shows what the run stored (call 14) |
| A finding's thread state derived from what is stored (3.3, item 9) | **The second scorer's calls and status apart** (calls 13, 14): stored nowhere apart |
| The page `/ui/reviews/<run>`: its states, the header, the selector, why it approved, the six cards | **Each block of a file listed** (call 9): the mockup's sub-line summarises them |
| `docs/guide/the-ui.md`, the README's status rows, three sentences of the design | **Polling the page** (call 20); **links into GitHub's threads** (the mockup draws none) |

**Dry run:** a dry-run review is shown as every other; its approval reads "Not decided in dry run" (3.4), it posts nothing, so its findings have no thread and it has no feedback.

## Not in this plan

- Settings, the Overview, Repositories and Memory (the design's plans 2 and 3); the tables of alerts and dependency health.
- Re-running a review from the UI (design 8); any write: both routes read.
- Any dropped idea (no finding verifier, no repository-wide context packs, no recall-first contract, no lens pass), and any model call.

## Calls

"(builder)" marks a call the builder took before the plan was written, restated with its cost; every other call is the planner's. Where the design or the mockup says otherwise, the call says so.

**The cut and the rules of the build**

1. **(builder) The second plan of the frame, ten tasks:** the reads, the reading of a stored result, the thread state, the two answers, the routes, the client, and the page in three tasks (its frame and why it approved; the scores and the findings; the side cards), then the documents. The run under Docker follows the last task. Cost: none new; Settings and the other screens still say "Coming in a later plan".
2. **(builder) No migration.** The design says the thread state and the feedback are derived from what is stored (3.3, items 6 and 9), and every other value the page shows is stored already. The next plan (Settings, planned beside this one) adds `0016_settings`; this plan adds none. Cost: what is not stored is not shown (calls 9, 13, 14).
3. **(builder) No new library**, in `src/` or in `ui/`; tests never reach the network, a real database or a model (PGlite through `testDb()`; the frontend's API stubbed, `fetch` blocked by `ui/src/test/setup.ts`). Cost: none new.
4. **(builder) Colours by the theme's tokens only.** The UI's colours move to the project icon's green in a separate change (branch `ui-theme`, pull request 35), which replaces the mockup's indigo; this plan's branch is cut from it, so its pages are built and checked in those colours. Every class of this plan is a token class of `ui/src/index.css`'s `@theme` (`bg-card`, `border-border`, `text-muted`, `bg-subtle`, `bg-accent`, `bg-accent-soft`, `text-accent-text`, `text-ok`, `bg-ok-bg`, `border-ok`, `text-warn`, `bg-warn-bg`, `border-warn`, `text-bad`, `bg-bad-bg`, `border-bad`, `text-info`, `bg-info-bg`, `shadow-card`) or a layout class; never a hex value, an `rgb()`, or a palette class such as `indigo-600`. Cost: none known.

**What is read, and what is shown**

5. **The run is read in the service, and answered by an allowlist** (Task 4 holds the fields; each field is one a task shows). Its `result` is read without the keys `audit`, `overview`, `acceptance` and `providers`, removed in the statement itself (Task 1), so the model's summary, the audit, the acceptance rows and the providers cannot reach the code; the rest is read into memory for the parts the page shows and is never answered as it is. Cost: a page view still reads one run's scores and findings, which can be large (one entry per changed file).
6. **The approval paragraph is read from the end of the stored body**, only for a run whose `approval_code` is set: the publisher posts the body with the paragraph last, in the part a cut keeps whole (`renderReview`'s tail, or `fitBody(run.body, paragraph)`), and stores it with `markPublished`. The statement reads `right(body, 4000)`; the paragraph is its last paragraph (after the last blank line), taken only when it starts with `**Approved automatically** ` for a run posted as an approval, or `**Not approved automatically:** ` for one that was not, holds printable ASCII only and is at most 2,000 characters; the answer holds its words after that lead. **Why not write it again from the code:** the threshold it was decided at, the thread rule and the detail code of `threads_unreadable`, `rule_unreadable` and `refused` are stored nowhere else. The body is otherwise never answered. Cost: a run posted before approval existed, or found already posted on GitHub (adopted), has no paragraph: its banner says a sentence of the page's own (Task 7).
7. **The decision** (design 1, item 3; 3.4), the first that holds: `failed` (the run failed); `dry_run`; `nothing_new` (not published, and the result says nothing new); `not_posted` (not published); `approved` (`approved` true); `not_approved` (`approval_code` set); `not_decided` (published with neither: approval was off for the repository, or the review was adopted). Cost: a dry run never reads as decided, as 3.4 says.
8. **The merge gate's state is the newest `gate_evaluations` row of the pull request at the run's head.** The row's `run` column is null for every state but `passed`, `blocked` and a failed evaluation (`src/gate/job.ts`), so the head, not the run, finds it. Cost: a later review at the same head (a re-check) shares that row; the page shows the gate's newest state for this commit, not the state when this review was posted.
9. **Scores by file**, as drawn: one row for each file of `result.scores`, and one for a path of `result.coverage.notReviewed` that has none. **The score that decides a file** is its file level (`fileLevel`) when it is above every block's own score, or when no block has one; otherwise its highest block (the first at a tie). **Why:** a block's reason, never one written on another pull request (`origin` `other_pull_request`: its category only, as the posted review does); the model's whole-file reason for a file level of source `whole_file`; a sentence of the page's for every other source and for a file not reviewed. **Its blocks** are shown as the mockup draws them: their number and the lines of the highest (`2 blocks, the highest at lines 38 to 51`), or `Whole file`; **the design says "its blocks", the mockup a summary: the page follows the mockup** and does not list each block. **A score a floor raised** is stored as such (`raisedFrom` on the block, the score given before a block the file lost raised it): the deciding block's is answered, and the Why ends with the posted review's own words, ` <given>% was given; a block this file lost had scored <score>%.` (`src/engine/render/body.ts`, `blockLine`). The mockup's "kept from review 2" names a review the result does not store: the page says `kept from an earlier review`. **The mockup's "Lock file, left out by the review's rules." matches no stored reason:** a file not reviewed says, in a sentence, the reason the run stored (`no_diff`, `too_large`, `over_batch_limit`, `batch_failed` or `secret_file`), and then what it counted as (` Counted as 100%.`), which the mockup does not say. Cost: a file's other blocks' scores and reasons are not on the page (the posted review lists those at or above the threshold).
10. **Findings:** every finding of the result, of four kinds (placed; `unplaced`, not on the diff; `unchanged`, on code unchanged since the last review; `beyondDiff`), sorted by severity (blocker, major, minor), each kind in that order and each in its stored order at a tie; the header counts all of them by severity. Under them, as drawn: the earlier threads this run judged, counted as the review's own last line counts them (a verdict other than `open` is cleared; `threadsDue` less the verdicts could not be judged), and how many findings it dropped as already discussed (`alreadyDiscussed`). The mockup draws placed findings only, no `could not be judged` clause and no ` (old file)`; the page adds them as the posted review says them. Cost: the header's counts can differ from Activity's, which counts placed findings only (the first plan's call 13).
11. **A finding's thread state (3.3, item 9).** A placed finding of a published run is matched to a first comment of the run with the same path, side, severity and quote (the stored comments hold no index of their finding), in two passes over the comments in their stored order: first each finding, in its order, takes the first unused comment with its own line; then each finding left takes the first unused comment whose line is null (GitHub's line, stored as it answered). So a null line never takes a comment another finding matches exactly. Its **signals**: each person's `thread_resolved` and `thread_unresolved` row of `human_activity` whose `reply_to` is that comment's id (the app's own resolutions are not stored: an event whose actor is a bot is dropped when it is received), and each later run's verdict on it (`result.threadVerdicts`, by `commentId`), timed at that later run's `started_at` (its threads are read as it starts). **The newest signal decides; at the same time a person's event wins; with none, the thread is open.** `resolved` reads "Resolved by <login>"; `unresolved` and a verdict `open` read open; `fixed` and `answered` read as such. A finding of a run that was not published reads "Not posted"; one of a published run with no first comment, "No thread recorded" (its inline comments were refused, or could not be read back). The judge's classifications of replies (`reply_verdicts`) are not read. The mockup draws `Thread open` and `Resolved by <login>`; every other state's words are the page's (Task 8). Cost: a thread a person resolved with no reply, which a later review still holds open, reads open although GitHub shows it resolved (the merge gate holds it open too); a thread event that never arrived reads as if nothing happened.
12. **The approval record:** this run's code; then the approvals of the pull request up to this run (`approved`, newest first, at most 20), each with its ordinal and head and its withdrawal: `withdrawn` (dismissed by the app), `dismissed_on_github`, `withdrawal_failed` with its code (while `dismiss_failure` stands) and, from the withdraw job waiting to try again (pending, with a start and a retry code, as Activity lists them), when it is tried again, or `stands`; and whether it stood at a merge. The mockup's "until then the gate check of this head fails" is left out: the page does not know whether a gate requires it. **The mockup's "Dismissing it was refused" reads `Dismissing it failed`:** the stored code may be a network failure, which is no refusal; a try whose time is now or past reads `Trying again now.`, not "in 0 s" (as built: a time less than half a second away reads so too, the seconds being rounded as `took` rounds them, and a failed withdrawal with no waiting withdraw job, `retryAt` null, says no retry at all and ends at `Dismissing it failed (<code>).`; one withdraw job's time is shown on every approval whose withdrawal failed, the job being the pull request's); the run's own approval reads `Approval of this review`, which the mockup does not draw. Cost: an approval after this run is shown on that run's page only.
13. **Usage:** the run's calls, input, cached and output tokens and cost, and the models that answered (`result.models`). **The mockup's "2, and 1 to the scorer" is not stored:** the second scorer's usage is added into the run's (`src/engine/review.ts`), so Calls is the total. Cost: a deployment with a second scorer cannot tell its calls here.
14. **Dependencies on this review, as the run stored them** (`result.dependencies`): the review model, memory with the records shown, its lessons, each MCP server and each extension, each with its status and, but when it worked, its short code. **The second scorer's state is not stored, so it has no row; dependency health and alerts are plan 3's tables**, not added here. The mockup draws no code and no lessons: the page adds the short code a run stored for a dependency that did not work, as ` (<code>)`, its lessons as a row of their own, and the words `Nothing to add` and `Skipped` for the statuses it does not draw. Cost: a second scorer that failed shows only in the run's failure, when it made the run fail.
15. **Feedback (3.3, item 6):** the run's helpful and not helpful counts, and the newest 20 reasons. **The login beside a reason is the module's claim** (`src/shell/feedback.ts` takes any 1 to 100 characters with no white space, stored lower-cased; a module cannot know who pressed its button), so it is answered only when it has GitHub's own shape, `^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$` on the stored lower-cased value (no hyphen first, last or doubled, at most 39 characters), and is not verified; another is answered as null, and the reason is shown with no name. Cost: older reasons are not shown; a module's user may answer under someone else's login, and the page shows it as that login.
16. **What this page answers that Activity's answers did not** (the first plan's call 13, extended to these two routes): the model's words (findings and score reasons of this pull request, those under the threshold included), file paths, the author's login and the branches of the pull request, the login of whoever resolved a thread, feedback reasons (text a person wrote, at most 1,000 characters as stored) with a login of GitHub's shape (call 15), the approval's dismissal facts (withdrawn, dismissed on GitHub, a failed withdrawal's code and when it is tried again, stood at a merge), a failed run's stage, and the merge gate's mode and state. **Still never answered:** the config, any secret, the body (but the paragraph), the comments as rendered, the model's summary, the audit, quotes, acceptance rows, providers, the replies in threads, a skip's actor and reason, the judge's verdicts, memory records, a reason written on another pull request, and the id of a review, a comment, a thread, an installation or a delivery, the base sha. Cost: everyone signed in, a viewer included, reads for every repository the service reviews what the model wrote and what people answered in feedback; part of it was never on GitHub: the reason of every block and file below the threshold (the posted review lists only those at or above it) and every finding of a dry run. So a person the deployment lets in, with no read access to a repository on GitHub, reads text about its code that GitHub never showed anyone.
17. **Bounds, not pages:** at most 500 files (the rest counted), 200 findings (the rest counted), 20 approvals, 20 feedback reasons, 50 MCP servers and 50 extensions, 10 models, 200 runs in the selector; a reason is cut at 2,000 and a finding's text at 4,000 UTF-16 units, never inside a pair. **The design says every list is paged and bounded (5); these lists are bounded and not paged.** The later runs' verdicts are read with no bound. Cost: a pull request of more than 500 files shows its highest 500 and a count, with no next page; a pull request reviewed many times reads the verdicts of each later published run on every view of an early one.

**The routes**

18. **The paths.** `GET /api/reviews/<run>` with `<run>` matching `^[1-9][0-9]{0,9}$` and at most 2147483647; `GET /api/pulls/<owner>/<repo>/<number>/reviews` with owner and repo lower-cased matching `^[a-z0-9_.-]{1,100}$` and the number as the run's. Another path under those prefixes is 404 `not_found` and reads nothing; another method is 405 with `allow: GET`, read nothing; both need a session (401 `signed_out`), viewers and admins alike; a run that is not stored is 404 `not_found`; a pull request with no run answers an empty list. Both count against the API's 4 places. A handler that rejects logs `ui_failed` with the route `review` or `pull_reviews`. **Stored words shown in the code face are short codes** (`isShortCode`), as the first plan holds every code it shows: a failure's stage and code, the approval code, a reason a file was not reviewed, a file level's source, a category, the gate's state and code, a withdrawal's code, a dependency's code and the reason a job ran; one that is not reads as `unknown` where the page must say something (a stage, a reason not reviewed, a source, a gate state, the reason a job ran, the approval code) and as null elsewhere. A model's name is printable ASCII with no space, at most 200 characters, or left out. Cost: a value an older release stored in another form reads `unknown`.
19. **"Review n of m"** counts every run of the pull request by id, dry runs and failed ones included; the selector lists the newest 200 and always holds this run. Cost: a pull request reviewed more than 200 times lists its newest 200 and this one.

**The screen**

20. **The page reads its review once** when it opens and when the run changes, and the selector's list once for each pull request: moving between the reviews of one pull request keeps the list it read. Neither is polled (Activity polls; a review changes little once it ended). A failed read says so with `Try again`. An address whose run is not `^[1-9][0-9]{0,9}$` up to 2147483647 (`/ui/reviews/007`, 400 digits) says `Review not found` and reads nothing. Cost: a page left open shows thread states, approvals and feedback as they were when it was opened, until it is opened again; a review made while the page is open joins the selector only when another pull request is opened, or the page is loaded again.
21. **States and texts the mockup does not draw**, with texts pinned in Tasks 7 to 9: reading, a review not stored, a review that cannot be read, a selector that cannot be read (left out), every empty card (`No file was scored.`, `No findings.`, `None recorded.`, `No feedback on this review.`), a cut list, a model or a usage of none, and the words of the statuses, decisions and kinds the mockup does not draw. Every text the mockup does draw is used as drawn, but where a call names the difference (calls 9 to 14). Cost: texts the owner did not see.
22. **The approval banner's words** are the page's for each decision the mockup does not draw (it draws `Not approved automatically`; Task 7), with the paragraph's own when there is one, and a sentence for the gate's state: the mockup's `says 1 blocking finding is open.` for `blocked`, and a sentence of the page's for each other state. Cost: texts the owner did not see for the decisions and states the mockup does not draw.
23. **A finding's text is shown as plain text** with its line breaks, a span between two backticks on one line in the code face, and nothing else of Markdown; the paragraph the same way. A feedback reason, which a person wrote, is set in a `<bdi>` so that a character that changes the direction of text cannot reach the login beside it. Cost: a model's list or link reads as written.
24. **Shared pieces of Activity** (the card classes, the score's colour of the first plan's call 21, the words of "Asked by", the modes) are exported from `ui/src/pages/activity.tsx` and reused, not copied. **The page words every reason a run was asked for:** a run whose job is gone (finished jobs are deleted after 14 days, `JOB_KEEP_MS`) has its trigger as its reason, which the page words itself, `Automatic` or `By hand`; every other reason goes to Activity's `AskedBy`, which words each one it knows and writes another in the code face, as Activity does. Cost: an older review's "Asked by" is less precise.

**The run**

25. **The run under Docker** (after Task 10), made by the controller on the final code in a network with no way out, as in the plans before, with rows written by statements (no model and no stub of GitHub: the browser signs in with a password): a published live run with every card filled, an earlier approval whose withdrawal failed, with its withdraw job waiting to try again (a start and a retry code), a dry run, a failed run; a real Chromium signs in with a password (the password plan's command), opens each from Activity, uses the selector, in light and dark; the console shows no violation of the content security policy. Cost: what a real review stores is shown only by an earlier run's rows.

## For the owner

1. **Nothing here cannot be undone:** no migration; the two routes only read.
2. **Rulings you may want to change** (each a small change): call 6 (the paragraph read from the end of the body), 8 (the gate's state by head), 9 (blocks summarised as the mockup draws them, not listed), 11 (the newest signal decides a thread), 13 (calls as one total), 15 (a feedback login shown only in GitHub's shape), 16 (what everyone signed in now reads), 17 (bounded lists, not paged), 20 (no polling).
3. **Not settled, and yours to weigh:** every viewer reads people's feedback text, and what the model wrote that GitHub never showed: the reasons of every block and file below the threshold, and every finding of a dry run, for every repository the service reviews, whatever that person may read on GitHub (call 16); a feedback login is the module's claim (call 15); a thread resolved by the app reads from the later review's verdict, since the app's own thread events are not stored (call 11).
4. **Not tried against GitHub:** that a person's resolution of a real thread arrives with the first comment's id the service stored (the code and the earlier plans assume it). It needs a real thread on the scratch repository.

## Global Constraints

Every constraint of the earlier plans still holds. The ones that bite most often, and the new ones:

- **The service:** Node 26 or later, npm, no build step, erasable TypeScript only, `import type` for types, relative imports ending in `.ts`, no new library in either `package.json`.
- **ASCII only** in `src`, `contract`, `test`, `examples`, `ui/src`, `ui/index.html`, `ui/public` and `ui/`'s config files. After each task `LC_ALL=C grep -rn -P '[^\x00-\x7F]' src contract test examples ui/src ui/index.html ui/public` prints nothing.
- **No migration.** No file is added to `src/db/migrations/`.
- **No test reaches the network, a real database or a model.** A database is `testDb()`; a clock is passed in; every wait has a bound; the frontend's tests stub the API object.
- **Reads only:** every statement of this plan is a `select`, runs only inside one of the two routes, and is plain SQL in the schema `visto_ai`; owner and repo are lower-cased on lookup; a list of ids is passed as one JSON text read with `jsonb_array_elements_text($n::jsonb)`. (The service's tests filter statements by `gate` and `visto_ai.pull_requests`; none of this plan's runs outside an API request.)
- **The allowlist:** each answer is built field by field into the shapes of `src/ui/api-types.ts`; nothing of call 16's "never" list is in it (Task 4 `an answer holds no field the screen does not show`).
- **Boundaries, by the lint as it is:** `src/db/**` imports nothing of `src/engine`; `src/ui/**` imports `src/db`, `src/shell` and type files; `ui/` reaches `src/` only through `ui/src/api-types.ts`.
- **Colours by tokens only** (call 4). After each frontend task, `grep -rnE '#[0-9A-Fa-f]{3,8}\b|rgb\(|(slate|gray|zinc|indigo|blue|green|red|amber|emerald)-[0-9]{2,3}' ui/src/pages/review.tsx` prints nothing (so no comment of the file writes `#` before digits, such as a pull request's number, which the check would read as a colour). No inline `style` in `review.tsx`.
- **No existing test is edited, but for these,** each named with its exact change in its task: `src/ui/route.test.ts`'s `without a session every read is signed_out, and the sign-in routes are open` (Task 5); the six frontend `fakeApi`s, in `ui/src/app.test.tsx`, `ui/src/components/layout.test.tsx`, `ui/src/pages/activity.test.tsx`, `ui/src/pages/sign-in.test.tsx`, `ui/src/pages/password.test.tsx` and `ui/src/pages/accounts.test.tsx`, and `ui/src/app.test.tsx`'s `a 401 from any method of the API the pages are given shows the sign-in page` (Task 6); `ui/src/app.test.tsx`'s `each sidebar entry leads to its page, the coming ones say so, and an unknown path is not found` and `ui/src/pages/activity.test.tsx`'s `recent reviews show each outcome, score, findings, mode, cost, time taken and age`, each of which expects the placeholder `Review` heading (Task 7). An implementer who finds another test that cannot hold stops and reports it.
- **Tests (as built):** a test written in this plan may be scoped to the part of the page it is about (the banner, a card, a heading's region) when a later task's mandated text repeats a word it looks up, as `Not decided in dry run` is in the banner and in the approval record; no test outside this plan is edited for that. `node:test` in `src`, Vitest in `ui`. `at(seconds)` from `2026-03-01T10:00:00.000Z`; the pull request `acme/shop` number 128, its author `octo-dev`, branches `fix/round-prices` into `main`; heads `3f9c2e1a7b04...` and `9a1e5c07b3d2...` (40 hex characters each, invented); the resolver `octo-lead`; a feedback login `octo-guest`; models `vendor/model-a`; an MCP server `docs`, an extension `example`; URLs under `https://github.example.test/`. In the frontend, the run 9001 (and 8990, 8977 for the pull request's others) and `now` `2026-03-01T10:00:00.000Z`. Every fixture is invented.
- **Commits:** one per task, message as given, ending with the co-author line the implementer's own session gives. Nothing is pushed.

## Review Focus

Inputs and sequences no happy-path test would meet. Each has a test in the task named.

1. **A stored result of an older or damaged shape:** no `scores`, a score that is no object, a finding with no line, a verdict that is no object, `dependencies` absent or of another shape, a result that is `null`. The page must answer, not fail. Task 2 `a result of another shape reads as empty parts, and never throws`; Task 4 `a run whose result is of another shape still reads`.
2. **Signals out of order:** resolved then a later verdict; a verdict then unresolved; a tie; two findings on one file with the same quote; a comment whose line GitHub gave as null, met before the comment another finding matches exactly. Task 3 `each placed finding takes the first unused comment of its place, severity and quote` and `the newest signal decides, a person's event wins a tie, and none reads as open`.
3. **A forged approval paragraph:** a run with no `approval_code` whose body ends with the lead (a model can write anything in the summary), a paragraph with a non-ASCII character, a lead that does not fit the decision. Task 2 `the approval paragraph is the last paragraph of the body when it starts with one of the two leads`; Task 4 `the paragraph is read only for a run that was decided, and only with the lead of its decision`.
4. **Something answered that the page must not show:** the body, the audit or the summary, a quote, a comment id, a reason written on another pull request, a thread's reply, a skip's reason, a feedback "login" that is an address. Task 1 `a run is read with its pull request, ...` (the result's keys removed in the statement); Task 4 `an answer holds no field the screen does not show`; Task 9 `the feedback shows its counts and the reasons people gave, and says when there is none`.
5. **A path a person types:** `/api/reviews/0`, `/api/reviews/007`, `/api/reviews/2147483648`, `/api/reviews/7x`, `/api/reviews/7/`, `/api/pulls/Acme/Shop/128/reviews`, `/api/pulls/acme/sh%6fp/128/reviews`, `/api/pulls/acme/shop/128`. Task 5 `a review path a person types wrongly is not found and reads nothing, and another method is refused`.

---

### Task 1: The reads of one review

**Files:**
- Create: `src/db/review-page.ts`, `src/db/review-page.test.ts`

**Interfaces:**

```ts
// src/db/review-page.ts. Every function reads; owner and repo of a ref are lower-cased before the statement.
export interface RunRow {
  id: number; service: 'github'; owner: string; repo: string; number: number; job: number | null;
  trigger: 'automatic' | 'manual'; mode: 'full' | 'incremental' | 'recheck'; dry_run: boolean; head_sha: string; base_branch: string | null;
  outcome: 'ok' | 'failed'; failure_stage: string | null; failure_code: string | null;
  result: unknown;   // without audit, overview, acceptance and providers; null when the stored result is no object (call 5)
  calls: number; input_tokens: number; output_tokens: number; cached_tokens: number; cost: number;
  started_at: Date; finished_at: Date; published: boolean; published_at: Date | null; approved: boolean; approval_code: string | null;
  body_tail: string | null;   // the body's last 4,000 characters, read only when approval_code is set (call 6)
  title: string | null; author: string | null; head_branch: string | null; pr_base_branch: string | null;   // of its pull request; null when it is not stored
  job_reason: string | null; job_requested_by: string | null;   // of its job; null when it has none or it was deleted
  ordinal: number; runs: number;
}
export async function runOf(db: Db, id: number): Promise<RunRow | null>;
export interface CommentRow { comment_id: string; path: string; side: string; line: number | null; severity: string; quote: string }
export async function runComments(db: Db, run: number): Promise<CommentRow[]>;
export interface ThreadEventRow { reply_to: string; kind: 'thread_resolved' | 'thread_unresolved'; author: string; at: Date }
export async function threadEvents(db: Db, ref: PullRequestRef, commentIds: string[]): Promise<ThreadEventRow[]>;
export interface VerdictRow { run: number; started_at: Date; comment_id: string; verdict: string | null }
export async function laterVerdicts(db: Db, ref: PullRequestRef, after: number, commentIds: string[]): Promise<VerdictRow[]>;
export interface GateRow { mode: string; state: string; code: string | null; blocking: number; refused_inline: number }
export async function gateAt(db: Db, ref: PullRequestRef, head: string): Promise<GateRow | null>;
export interface ApprovalRow {
  run: number; ordinal: number; head_sha: string; dismissed_at: Date | null; dismissed_by: string | null; dismiss_failure: string | null; stood_at_merge: Date | null;
}
export async function approvalsUpTo(db: Db, ref: PullRequestRef, run: number, limit: number): Promise<ApprovalRow[]>;
/** The withdraw job of the pull request waiting to try again after a failed try, as Activity lists them; null when none waits. */
export async function pendingWithdrawal(db: Db, ref: PullRequestRef): Promise<{ run_at: Date } | null>;
export interface FeedbackRow { reason: string; login: string }
export async function runFeedback(db: Db, run: number, limit: number): Promise<{ up: number; down: number; reasons: FeedbackRow[] }>;
export interface PullRunRow { id: number; finished_at: Date; ordinal: number; total: number }
export async function pullRuns(db: Db, ref: PullRequestRef, limit: number): Promise<PullRunRow[]>;
```

**Rules (3.3, items 6 and 9; calls 6, 8, 11, 12, 15, 19):** the statements, exactly; `$1` to `$4` are the pull request's service, owner, repo and number where a ref is given. `threadEvents` and `laterVerdicts` with no comment id answer `[]` and run nothing.

```sql
-- runOf ($1: the run's id)
select r.id, r.service, r.owner, r.repo, r.number, r.job, r.trigger, r.mode, r.dry_run, r.head_sha, r.base_branch, r.outcome,
       r.failure_stage, r.failure_code,
       case when jsonb_typeof(r.result) = 'object' then r.result - 'audit' - 'overview' - 'acceptance' - 'providers' end as result,
       r.calls, r.input_tokens, r.output_tokens, r.cached_tokens, r.cost::float8 as cost,
       r.started_at, r.finished_at, r.published, r.published_at, r.approved, r.approval_code,
       case when r.approval_code is not null then right(r.body, 4000) end as body_tail,
       p.title, p.author, p.head_branch, p.base_branch as pr_base_branch,
       j.reason as job_reason, j.requested_by as job_requested_by,
       (select count(*) from visto_ai.review_runs o
        where o.service = r.service and o.owner = r.owner and o.repo = r.repo and o.number = r.number and o.id <= r.id)::int as ordinal,
       (select count(*) from visto_ai.review_runs o
        where o.service = r.service and o.owner = r.owner and o.repo = r.repo and o.number = r.number)::int as runs
from visto_ai.review_runs r
left join visto_ai.pull_requests p on p.service = r.service and p.owner = r.owner and p.repo = r.repo and p.number = r.number
left join visto_ai.jobs j on j.id = r.job
where r.id = $1;
-- runComments ($1: the run)
select comment_id, path, side, line, severity, quote from visto_ai.review_comments
where run = $1 and severity in ('blocker', 'major', 'minor')
order by id;
-- threadEvents ($5: the comment ids as JSON)
select reply_to, kind, author, at from visto_ai.human_activity
where service = $1 and owner = $2 and repo = $3 and number = $4
  and kind in ('thread_resolved', 'thread_unresolved')
  and reply_to in (select jsonb_array_elements_text($5::jsonb))
order by at, id;
-- laterVerdicts ($5: the run, $6: the comment ids as JSON)
select r.id as run, r.started_at, v ->> 'commentId' as comment_id, v ->> 'verdict' as verdict
from visto_ai.review_runs r
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(r.result -> 'threadVerdicts') = 'array' then r.result -> 'threadVerdicts' else '[]'::jsonb end) as v
where r.service = $1 and r.owner = $2 and r.repo = $3 and r.number = $4 and r.published and r.id > $5
  and jsonb_typeof(v) = 'object'
  and v ->> 'commentId' in (select jsonb_array_elements_text($6::jsonb))
order by r.id;
-- gateAt ($5: the head)
select mode, state, code, blocking, refused_inline from visto_ai.gate_evaluations
where service = $1 and owner = $2 and repo = $3 and number = $4 and head_sha = $5
order by id desc limit 1;
-- approvalsUpTo ($5: the run, $6: the limit, 20)
select r.id as run, r.head_sha, r.dismissed_at, r.dismissed_by, r.dismiss_failure, r.stood_at_merge,
       (select count(*) from visto_ai.review_runs o
        where o.service = r.service and o.owner = r.owner and o.repo = r.repo and o.number = r.number and o.id <= r.id)::int as ordinal
from visto_ai.review_runs r
where r.service = $1 and r.owner = $2 and r.repo = $3 and r.number = $4 and r.approved and r.id <= $5
order by r.id desc limit $6;
-- pendingWithdrawal: Activity's filter (src/db/activity.ts, waitingWithdrawals)
select run_at from visto_ai.jobs
where service = $1 and owner = $2 and repo = $3 and number = $4 and kind = 'withdraw' and status = 'pending'
  and starts > 0 and retry_code is not null
order by id desc limit 1;
-- runFeedback ($1: the run, $2: the limit, 20): the counts, then the newest reasons
select (count(*) filter (where vote = 'up'))::int as up, (count(*) filter (where vote = 'down'))::int as down
from visto_ai.review_feedback where run = $1;
select reason, login from visto_ai.review_feedback
where run = $1 and reason is not null
order by at desc, id desc limit $2;
-- pullRuns ($5: the limit, 200)
select id, finished_at, (row_number() over (order by id))::int as ordinal, (count(*) over ())::int as total
from visto_ai.review_runs
where service = $1 and owner = $2 and repo = $3 and number = $4
order by id desc limit $5;
```

- [ ] **Step 1: Write the failing tests.** Rows are written with the db functions (`recordRun`, `markPublished`, `recordComments`, `recordActivity`, `recordEvaluation`, `recordFeedback`, `markDismissed`, `markDismissFailed`, `markStoodAtMerge`, `askWithdraw`, `enqueueJob`, `savePullRequest`).

```ts
// src/db/review-page.test.ts
test('a run is read with its pull request, its job, its place among the runs of its pull request, and the end of its body only when it was decided', async () => {
  /* three runs of acme/shop #128, the second from a job of reason 'command' requested by octo-dev, the pull request stored with title, author octo-dev,
     fix/round-prices into main: runOf(second) has title 'Round prices before tax', author 'octo-dev', head_branch 'fix/round-prices', job_reason 'command',
     job_requested_by 'octo-dev', ordinal 2, runs 3; body_tail null; markPublished with approvalCode 'needs_human' and a body of 5,000 characters ending
     '\n\n**Not approved automatically:** x': body_tail is its last 4,000 characters; a run of a pull request not stored: title, author, branches null;
     a result holding audit, overview, acceptance, providers and scores: result has scores and none of the four keys; a result stored as 7 or as a list: result null;
     runOf(999999) null */
});
test("the comments of a run are its findings', in the order stored, never its notes", async () => {
  /* recordComments with a major, a note (severity 'note', blockHash 'h'), a minor: runComments gives the major then the minor, with comment_id, path, side, line, quote */
});
test('thread events are read for those first comments only, oldest first', async () => {
  /* thread_resolved by octo-lead at at(20) replying to 'c-1', thread_unresolved at at(10) to 'c-1', one to 'c-9', an inline_comment to 'c-1':
     threadEvents(ref, ['c-1']) is [unresolved at(10), resolved at(20) by octo-lead]; with [] no statement runs */
});
test('the verdicts later published runs kept are read for those first comments only', async () => {
  /* an earlier published run keeping c-1 'open', then the page's run `page`, then a later published run keeping [{ commentId: 'c-1', verdict: 'fixed' }, 'x',
     { commentId: 'c-2', verdict: 'open' }], then a later dry run keeping c-1 'answered': laterVerdicts(ref, page, ['c-1']) is one row, verdict 'fixed', its started_at */
});
test("the gate's newest evaluation at a head is read, and none is null", async () => {
  /* two evaluations at head A (passed, then blocked with blocking 1 and refused_inline 1), one at head B: gateAt(ref, A) is the blocked one; gateAt(ref, 'c'.repeat(40)) null */
});
test('the approvals up to a run are read newest first with their withdrawal, and a pending withdrawal with its time', async () => {
  /* run 1 approved and dismissed by the app, run 2 approved with a failed dismissal 'github_403', run 3 not approved, run 4 approved:
     approvalsUpTo(ref, run3, 20) is [run 2 (ordinal 2, dismiss_failure 'github_403'), run 1 (dismissed_by 'app')]; markStoodAtMerge(run2) reads stood_at_merge;
     a withdraw job asked (askWithdraw) and not yet tried: pendingWithdrawal null; claimed and put back by requeueJob to at(52) with code 'github_403': its run_at */
});
test('feedback is counted by vote, and the newest reasons are read with their login', async () => {
  /* two up (one with reason), one down with reason, on a published live run: up 2, down 1; reasons newest first, each exactly { reason, login }; limit 1: one reason */
});
test('the runs of a pull request are read newest first with their place and the total', async () => {
  /* three runs of #128 and one of #129: pullRuns(ref, 200) ids newest first, ordinals 3, 2, 1, total 3; limit 2: two rows, total still 3; Acme/Shop as the ref: the same */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/db/review-page.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the reads of one review, its threads, approvals, gate state and feedback`.

---

### Task 2: The answers' shapes, and reading a stored result

**Files:**
- Modify: `src/ui/api-types.ts`
- Create: `src/ui/review-result.ts`, `src/ui/review-result.test.ts`

**Interfaces:**

```ts
// src/ui/api-types.ts gains (types only, it imports nothing):
export interface ReviewFile {
  path: string;
  score: number | null;              // the file's final score; null for a path not reviewed that has no score
  notReviewed: string | null;        // why it was not reviewed (coverage.notReviewed's reason; 'unknown' when it is no short code); null when it was
  source: string | null;             // the file level's source when it decides the score (call 9; 'unknown' when no short code); null when a block does
  reason: string;                    // the model's reason for the score that decides; '' when none, or written on another pull request
  category: string | null;           // the deciding block's category when its score was given on another pull request; else null
  blocks: number;                    // how many blocks the file has
  highest: { side: 'LEFT' | 'RIGHT'; first: number; last: number } | null;   // the deciding block's lines; null when the file level decides
  kept: 'earlier_run' | 'other_pull_request' | null;                           // where the deciding block's score came from
  raisedFrom: number | null;         // the score the deciding block was given before a floor raised it; null when none did
}
export type FindingKind = 'placed' | 'unplaced' | 'unchanged' | 'beyond_diff';
export type ThreadState = 'none' | 'not_posted' | 'no_thread' | 'open' | 'resolved' | 'fixed' | 'answered';
export interface ReviewFinding {
  kind: FindingKind; severity: 'blocker' | 'major' | 'minor'; path: string; side: 'LEFT' | 'RIGHT'; line: number; body: string;
  thread: { state: ThreadState; by: string | null };   // by: who resolved it, for 'resolved' only
}
export type ApprovalDecision = 'approved' | 'not_approved' | 'not_decided' | 'dry_run' | 'not_posted' | 'nothing_new' | 'failed';
export type Posting = 'published' | 'not_posted' | 'dry_run' | 'nothing_new' | 'failed';
export interface GateShown { mode: string; state: string; code: string | null; blocking: number }
export interface ApprovalEntry {
  run: number; ordinal: number; head: string;
  state: 'stands' | 'withdrawn' | 'dismissed_on_github' | 'withdrawal_failed';
  code: string | null; retryAt: string | null; stoodAtMerge: boolean;
}
export interface ReviewDependency {
  kind: 'model' | 'memory' | 'lessons' | 'mcp' | 'extension'; name: string | null;
  status: 'ok' | 'empty' | 'skipped' | 'error'; code: string | null; count: number | null;
}
export interface FeedbackReason { reason: string; login: string | null }   // login: only of GitHub's shape (call 15)
export interface OneReview {
  now: string; run: number; ordinal: number; runs: number;
  pullRequest: { repository: string; number: number; title: string | null; author: string | null; headBranch: string | null; baseBranch: string | null; url: string };
  head: string; askedBy: { reason: string; login: string | null };
  mode: 'full' | 'incremental' | 'recheck'; posting: Posting; failure: { stage: string; code: string | null } | null;   // stage 'unknown' when it is no short code
  startedAt: string; finishedAt: string; publishedAt: string | null;
  approval: { decision: ApprovalDecision; code: string | null; text: string | null };
  gate: GateShown | null; threshold: number | null;
  files: ReviewFile[]; filesCut: number; read: { files: number; reviewed: number };
  findings: ReviewFinding[]; findingsCut: number; counts: { blocker: number; major: number; minor: number };
  earlier: { cleared: number; open: number; unjudged: number; discussed: number };
  usage: { models: string[]; calls: number; inputTokens: number; cachedTokens: number; outputTokens: number; cost: number };
  approvals: ApprovalEntry[]; dependencies: ReviewDependency[];
  feedback: { helpful: number; notHelpful: number; reasons: FeedbackReason[] };
}
export interface PullReview { run: number; ordinal: number; at: string }
export interface PullReviews { now: string; total: number; reviews: PullReview[] }

// src/ui/review-result.ts: pure; every function takes the stored result as `unknown` and never throws.
export const FILES_SHOWN = 500;
export const FINDINGS_SHOWN = 200;
export const REASON_CHARS = 2000;
export const BODY_CHARS = 4000;
export type ReadFinding = Omit<ReviewFinding, 'thread'> & { quote: string };   // the quote serves matching only and is never answered
export function clip(text: string, max: number): string;                       // at most `max` UTF-16 units, never ending inside a pair
export function thresholdOf(result: unknown): number | null;
export function nothingNew(result: unknown): boolean;                          // result.nothingToDo === true
export function filesOf(result: unknown): { files: ReviewFile[]; cut: number };
export function findingsOf(result: unknown): ReadFinding[];                    // all of them, sorted (rule 4)
export function countsOf(findings: readonly ReadFinding[]): { blocker: number; major: number; minor: number };
export function earlierOf(result: unknown): OneReview['earlier'];
export function readOf(result: unknown): OneReview['read'];
export function modelsOf(result: unknown): string[];
export function dependenciesOf(result: unknown): ReviewDependency[];
export function paragraphOf(tail: string | null, approved: boolean): string | null;
```

**Rules (1 item 3; calls 6, 9, 10, 13, 14, 17, 18):** a value of another shape than the one read below is skipped, an absent list reads as empty, and nothing throws. "A short code" is `isShortCode` (`src/shell/codes.ts`).

1. **`thresholdOf`:** `result.verdict.threshold` when a finite number, else null. **`readOf`:** `files` the number of entries of `result.scores` that are objects with a string `path`, `reviewed` the number of strings in `result.coverage.reviewed`. **`modelsOf`:** the strings of `result.models` matching `^[\x21-\x7E]{1,200}$` (others skipped), at most 10.
2. **`filesOf`.** An entry of `result.scores` is read when it is an object with a string `path` and a whole `finalScore` from 0 to 100; its `blocks` (a list, else none), each a block when it is an object, its `entry` read when it is an object with a finite `score`, a string `category` and a string `reason`, its `span` when an object with `side` `LEFT` or `RIGHT` and whole `first` and `last`, its `origin` when `earlier_run` or `other_pull_request`, its `raisedFrom` when a whole number from 0 to 100; its `fileLevel` when an object with a finite `score` and a string `source`; its `wholeFile` as a block's `entry` is. **The deciding block** is the block with the highest `entry.score` (the first at a tie); **the file level decides** when it is read and either no block has an entry or its score is above that block's. The row: `score` the `finalScore`; `notReviewed` the `reason` of the first entry of `result.coverage.notReviewed` (an object with a string `path`) with that path, `'unknown'` when that reason is no short code, else null when there is no such entry; with the file level deciding, `source` its source (`'unknown'` when no short code), `reason` the `wholeFile`'s when the source is `whole_file` and `wholeFile` is read, else `''`, and `category`, `highest`, `kept` and `raisedFrom` null; with a block deciding, `source` null, `reason` the entry's reason (`''` when its origin is `other_pull_request`), `category` the entry's when its origin is `other_pull_request` and it is a short code, else null, `highest` its span (null when its span is not read), `kept` its origin or null, `raisedFrom` its `raisedFrom` or null; with neither, `source`, `category`, `highest`, `kept` and `raisedFrom` null and `reason` `''`. `blocks` is the number of blocks. A path of `coverage.notReviewed` with no row gets one: `score` null, its reason as above, `reason` `''`, `blocks` 0, the rest null. Every reason is `clip(reason, REASON_CHARS)`.
3. **Their order:** the rows with `notReviewed` null by `score` from the highest, then by path (code-unit order); then the others by path. `files` is the first `FILES_SHOWN`, `cut` the number left.
4. **`findingsOf`.** The entries of `result.findings` (`placed`), `result.unplaced` (`unplaced`), `result.unchanged` (`unchanged`) and `result.beyondDiff` (`beyond_diff`), each read when it is an object with `severity` `blocker`, `major` or `minor`, a string `path`, `side` `LEFT` or `RIGHT`, a whole `line` of at least 0 and a string `body`; `quote` is its string `quote`, else `''`; `body` is `clip(body, BODY_CHARS)`. Sorted by severity (blocker, major, minor), stably, so that each severity keeps the kinds in that order and each kind its stored order. **`countsOf`** counts them by severity.
5. **`earlierOf`:** among the objects of `result.threadVerdicts`, `open` those with `verdict` `open` and `cleared` the rest; `unjudged` is `result.threadsDue` (a whole number at least 0, else 0) less both, never below 0; `discussed` the length of `result.alreadyDiscussed` when it is a list, else 0.
6. **`dependenciesOf`,** in this order: the model (`dependencies.model` `ok` or `error`, `count` null); memory (`dependencies.memory` an object with `status` `ok`, `empty`, `skipped` or `error`, its whole `lines` as `count`); its lessons (`dependencies.memory.lessons`, the same, `shown` as `count`); each MCP server (`dependencies.mcp`, by name, status `ok`, `skipped` or `error`, `calls` as `count`); each extension (`dependencies.extensions`, by name, the four statuses, `count` null). A name is kept when it matches `^[A-Za-z0-9._-]{1,64}$`; at most 50 of each, in code-unit order. `code` is the entry's `code` when the status is not `ok` and the code is a short code, else null.
7. **`paragraphOf(tail, approved)`:** null for a null tail. The paragraph is the text after the tail's last `\n\n` (the whole tail when it has none). It is taken only when it holds printable ASCII alone (`^[\x20-\x7E]+$`), is at most 2,000 characters and starts with the lead of its decision: `**Approved automatically** ` when `approved`, `**Not approved automatically:** ` otherwise; the answer is the rest after the lead. Anything else is null.

- [ ] **Step 1: Write the failing tests.** Results are literal objects in the engine's shape (`src/engine/types.ts`, `src/engine/score/types.ts`), with invented values.

```ts
// src/ui/review-result.test.ts
test('each scored file reads with the score that decides it, its reason, its blocks and the lines of its highest', () => {
  /* src/cart/price.ts with blocks 74 (RIGHT 38-51, calculation, 'Changes the amount every order total is built from.') and 40, fileLevel null:
     { path, score: 74, notReviewed: null, source: null, reason: 'Changes the amount every order total is built from.', category: null, blocks: 2,
       highest: { side: 'RIGHT', first: 38, last: 51 }, kept: null, raisedFrom: null }; a block of origin earlier_run deciding: kept 'earlier_run';
     two blocks at 60: the first decides; a deciding block at 80 with raisedFrom 55: raisedFrom 55; raisedFrom 101 or 'x': null */
});
test('a file whose file level is above its blocks reads as decided by it, and a reason from another pull request is never read', () => {
  /* fileLevel { score: 100, source: 'builtin_floor' } over a block at 30: source 'builtin_floor', reason '', highest null; fileLevel whole_file 12 with wholeFile
     { score: 12, category: 'test', reason: 'Tests only.' } and no block: source 'whole_file', reason 'Tests only.', category 'test'; a file level equal to its block: the block decides;
     a deciding block of origin other_pull_request with reason 'OTHER-PR-REASON': reason '', category 'calculation', kept 'other_pull_request';
     a source 'Not A Code': source 'unknown'; whole_file's category is not answered (null) */
});
test('files not reviewed read with their reason, after the reviewed ones sorted by score, and the rest past 500 are counted', () => {
  /* scores 58 b.ts, 74 a.ts, 12 c.ts, 100 lock.json; coverage.notReviewed [lock.json too_large, gone.ts secret_file]: order a.ts, b.ts, c.ts, gone.ts, lock.json;
     lock.json score 100 notReviewed 'too_large'; gone.ts score null blocks 0; a stored reason 'Too Large!': notReviewed 'unknown';
     503 files: files.length 500, cut 3; a reason of 3,000 characters is cut to 2,000 */
});
test('findings of each kind read with their place and text, sorted by severity, and are counted', () => {
  /* findings [minor a:3, major a:9], unplaced [major b:1], unchanged [blocker c:2], beyondDiff [minor d:4]: kinds and order blocker unchanged, major placed, major unplaced,
     minor placed, minor beyond_diff; a quote kept for matching; counts { blocker: 1, major: 2, minor: 2 }; a body of 5,000 characters is 4,000 */
});
test("earlier threads and duplicates are counted as the review's last line counts them", () => {
  /* threadVerdicts [fixed, answered, open, 'x'], threadsDue 4, alreadyDiscussed [1 entry]: { cleared: 2, open: 1, unjudged: 1, discussed: 1 }; threadsDue 1: unjudged 0 */
});
test('dependencies read as the run stored them, in the page\'s order, with a code only where it says why', () => {
  /* { model: 'ok', memory: { status: 'ok', code: 'ok', lines: 2, lessons: { status: 'empty', code: 'no_lessons', shown: 0 } },
       mcp: { docs: { status: 'error', code: 'mcp_timeout', calls: 0 }, 'bad name!': {...} }, extensions: { example: { status: 'ok', code: 'ok' } } }:
     [model ok, memory ok count 2 code null, lessons empty code 'no_lessons' count 0, mcp docs error 'mcp_timeout' count 0, extension example ok]; a code 'Not A Code': null */
});
test('the approval paragraph is the last paragraph of the body when it starts with one of the two leads', () => {
  /* '...\n\n## Overall\n\nNo findings.\n\n**Not approved automatically:** a part of this change is at or above 70%, so a person should review it.', false:
     'a part of this change is at or above 70%, so a person should review it.'; '**Approved automatically** for commit `3f9c2e1a7b04`: every file...', true: 'for commit `3f9c2e1a7b04`: every file...';
     the approved lead with approved false: null; the other lead with approved true: null; a paragraph holding U+00E9 (written as an escape): null; no lead: null; null: null */
});
test('a result of another shape reads as empty parts, and never throws', () => {
  /* for null, 'x', [], {}, { scores: 'x' }, { scores: [7, { path: 7 }, { path: 'a', finalScore: 'x' }] }, { findings: [{ severity: 'major', path: 'a' }] },
     { threadVerdicts: [null] }, { dependencies: { model: 'maybe', mcp: [] } }: no call throws; files [], findings [], dependencies [], threshold null,
     earlier all 0, read { files: 0, reviewed: 0 }, models []; models ['vendor/model-a', 'a b', 7]: ['vendor/model-a'] */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/review-result.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the shapes of one review's answer, and reading a stored result field by field`.

---

### Task 3: A finding's thread state

**Files:**
- Create: `src/ui/threads.ts`, `src/ui/threads.test.ts`

**Interfaces:**

```ts
// src/ui/threads.ts: pure.
// Consumes CommentRow, ThreadEventRow and VerdictRow (Task 1), ReadFinding (Task 2), ThreadState (Task 2).
/** For each placed finding, in order, the id of its first comment; null when none is left for it (rule 1). */
export function commentsOf(findings: ReadonlyArray<Pick<ReadFinding, 'path' | 'side' | 'line' | 'severity' | 'quote'>>, rows: readonly CommentRow[]): Array<string | null>;
export interface ThreadSignal { at: string; kind: 'resolved' | 'unresolved' | 'fixed' | 'answered' | 'open'; by: string | null; event: boolean }
/** Each comment id's signals: its people's events and its later verdicts (rule 2). */
export function signalsOf(events: readonly ThreadEventRow[], verdicts: readonly VerdictRow[]): Map<string, ThreadSignal[]>;
/** The state the signals say (rule 3). */
export function threadOf(signals: readonly ThreadSignal[]): { state: ThreadState; by: string | null };
```

**Rules (3.3, item 9; call 11):**

1. **`commentsOf`,** in two passes over the rows in the order given (their stored order), each row taken once: first each finding, in its order, takes the first row not taken with the same `path`, `side`, `severity` and `quote` and the finding's own `line`; then each finding still without a row, in its order, takes the first row not taken with the same four and a null `line`; none: null. So a finding never takes a row with a null line while a row of its own line is left, and never leaves another finding without its exact row.
2. **`signalsOf`:** a `thread_resolved` row is `{ at, kind: 'resolved', by: author, event: true }`, a `thread_unresolved` one `{ kind: 'unresolved', by: null, event: true }`; a verdict `fixed`, `answered` or `open` is `{ at: started_at, kind: verdict, by: null, event: false }`; any other verdict is no signal. Each under its `reply_to` or `comment_id`, in the order given.
3. **`threadOf`:** the signal with the latest `at` decides; at the same `at` an event wins over a verdict, and among the same, the later in the list. `resolved` is `{ state: 'resolved', by }`; `unresolved` and `open` are `{ state: 'open', by: null }`; `fixed` and `answered` are themselves with `by` null. No signal: `{ state: 'open', by: null }`.

- [ ] **Step 1: Write the failing tests.**

```ts
// src/ui/threads.test.ts
test('each placed finding takes the first unused comment of its place, severity and quote', () => {
  /* findings [major a.ts RIGHT 9 'q', major a.ts RIGHT 12 'q', minor b.ts RIGHT 3 'r']; rows [c-1 a.ts RIGHT 12 major 'q', c-2 a.ts RIGHT 9 major 'q', c-3 b.ts RIGHT null minor 'r']:
     ['c-2', 'c-1', 'c-3']; a row of another severity or side is not taken; three findings at a.ts 9 'q' and one row: ['c-2', null, null];
     findings [major a.ts 9 'q', major a.ts 12 'q'] and rows [c-4 a.ts RIGHT null major 'q', c-5 a.ts RIGHT 9 major 'q']: ['c-5', 'c-4'], and the same with the rows reversed */
});
test("the newest signal decides, a person's event wins a tie, and none reads as open", () => {
  /* resolved by octo-lead at at(10), then fixed at at(20): fixed; fixed at at(10), unresolved at at(20): open; resolved at at(20) and open at at(20): resolved by octo-lead;
     answered alone: answered; []: { state: 'open', by: null }; two resolved at the same time by octo-lead then octo-dev: by octo-dev */
});
test("signals are built from a comment's own events and verdicts, and an unknown verdict is none", () => {
  /* events for c-1 and c-2, verdicts for c-1 'fixed' and 'maybe': c-1 has its event and one verdict signal at its started_at; c-2 its event only */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/threads.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: a finding's thread state, derived from its stored comment, people's thread events and later verdicts`.

---

### Task 4: The answers of one review and of a pull request's reviews

**Files:**
- Create: `src/ui/review.ts`, `src/ui/review.test.ts`
- Modify: `src/ui/api.ts` (export `REQUESTER_SHOWN`; nothing else changes)

**Interfaces:**

```ts
// src/ui/review.ts. Consumes Tasks 1 to 3 and ApiDeps (src/ui/api.ts, unchanged).
export const APPROVALS_SHOWN = 20;
export const REASONS_SHOWN = 20;
export const PULL_RUNS_SHOWN = 200;
/** A login of GitHub's shape, on the stored lower-cased value (call 15). */
export const FEEDBACK_LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
/** One review's page; null when no run has that id. */
export async function review(deps: ApiDeps, run: number): Promise<OneReview | null>;
/** The runs of a pull request, newest first; owner and repo are lower-cased. */
export async function pullReviews(deps: ApiDeps, ref: PullRequestRef): Promise<PullReviews>;
```

**Rules (1 item 3; 3.3 items 6 and 9; 3.4; calls 5 to 17, 24):**

1. **The reads,** in this order: `runOf`; with the run published, `runComments`, then (with at least one id) `threadEvents` and `laterVerdicts` with its id; `gateAt` at its head; `approvalsUpTo` (`APPROVALS_SHOWN`); `pendingWithdrawal` only when an approval read has `dismiss_failure`; `runFeedback` (`REASONS_SHOWN`). At most nine statements.
2. **The fields,** each from the row or Tasks 2 and 3, and nothing else:
   - `now` the clock's ISO; `run` `id`; `ordinal`, `runs`; `pullRequest`: `repository` `owner/repo`, `number`, `title`, `author`, `headBranch` `head_branch`, `baseBranch` `base_branch ?? pr_base_branch`, `url` `deps.pullRequestUrl(ref)` with the ref `{ service, owner, repo, number }` of the row; `head` the first 12 characters of `head_sha`.
   - `askedBy`: `reason` `job_reason` when there is one, else the run's `trigger`, `'unknown'` when that is no short code; `login` `job_requested_by` when the reason is in `REQUESTER_SHOWN`, else null.
   - `mode`; `posting`: `failed` when the outcome is `failed`, else `dry_run` for a dry run, else `published` when published, else `nothing_new` when `nothingNew(result)`, else `not_posted`; `failure`: for a failed run `{ stage: failure_stage when a short code, else 'unknown', code: failure_code when a short code, else null }`, else null; `startedAt`, `finishedAt`, `publishedAt` as ISO.
   - `approval.decision` by call 7 (published and `approved`: `approved`); `approval.code` the `approval_code` for `approved` and `not_approved`, `'unknown'` when it is no short code, else null; `approval.text` `paragraphOf(body_tail, approved)` for those two, else null.
   - `gate`: from `gateAt`, `{ mode: a short code or 'unknown', state: a short code or 'unknown', code: a short code or null, blocking: blocking + refused_inline }`, or null.
   - `threshold` `thresholdOf`; `files`, `filesCut` from `filesOf`; `read` `readOf`.
   - `findings`: the first `FINDINGS_SHOWN` of `findingsOf`, without `quote`, each with its `thread`: a kind other than `placed`, `{ state: 'none', by: null }`; a placed one of a run not published, `not_posted`; of a published run, by `commentsOf` over the placed ones (all of them, in their order of `findingsOf`): no comment, `no_thread`; else `threadOf` of that comment's signals. `findingsCut` the number left; `counts` `countsOf` of all; `earlier` `earlierOf`.
   - `usage`: `models` `modelsOf`, `calls`, `inputTokens`, `cachedTokens`, `outputTokens`, `cost` from the row.
   - `approvals`: each row `{ run, ordinal, head: its first 12 characters, state, code, retryAt, stoodAtMerge: stood_at_merge !== null }`, `state` `withdrawn` when `dismissed_at` is set and `dismissed_by` is `app`, `dismissed_on_github` when it is set by another, else `withdrawal_failed` when `dismiss_failure` is set (`code` it when a short code, else `unknown`; `retryAt` the pending withdrawal's `run_at`, or null; as built the one pending withdrawal of the pull request, read once, serves every approval whose withdrawal failed), else `stands`; `code` and `retryAt` null for the others.
   - `dependencies` `dependenciesOf`; `feedback`: `helpful` `up`, `notHelpful` `down`, `reasons` each `{ reason, login }`, the login kept only when it matches `FEEDBACK_LOGIN`, else null (call 15).
3. **`pullReviews`:** `pullRuns(PULL_RUNS_SHOWN)`; `{ now, total: first row's total or 0, reviews: [{ run: id, ordinal, at: finished_at }] }`.

**The answers, exactly in shape (values invented):**

```json
{ "now": "2026-03-01T10:00:00.000Z", "run": 9001, "ordinal": 3, "runs": 3,
  "pullRequest": { "repository": "acme/shop", "number": 128, "title": "Round prices before tax", "author": "octo-dev",
    "headBranch": "fix/round-prices", "baseBranch": "main", "url": "https://github.example.test/acme/shop/pull/128" },
  "head": "3f9c2e1a7b04", "askedBy": { "reason": "synchronize", "login": null },
  "mode": "incremental", "posting": "published", "failure": null,
  "startedAt": "2026-03-01T09:47:19.000Z", "finishedAt": "2026-03-01T09:48:00.000Z", "publishedAt": "2026-03-01T09:48:01.000Z",
  "approval": { "decision": "not_approved", "code": "needs_human", "text": "a part of this change is at or above 70%, so a person should review it." },
  "gate": { "mode": "enforce", "state": "blocked", "code": null, "blocking": 1 },
  "threshold": 70,
  "files": [
    { "path": "src/cart/price.ts", "score": 74, "notReviewed": null, "source": null, "reason": "Changes the amount every order total is built from.",
      "category": null, "blocks": 2, "highest": { "side": "RIGHT", "first": 38, "last": 51 }, "kept": null, "raisedFrom": null },
    { "path": "package-lock.json", "score": 100, "notReviewed": "too_large", "source": "not_scored", "reason": "", "category": null,
      "blocks": 0, "highest": null, "kept": null, "raisedFrom": null } ],
  "filesCut": 0, "read": { "files": 4, "reviewed": 2 },
  "findings": [ { "kind": "placed", "severity": "major", "path": "src/cart/price.ts", "side": "RIGHT", "line": 42,
    "body": "Rounding each line before tax can move an order total by a cent per line.", "thread": { "state": "open", "by": null } } ],
  "findingsCut": 0, "counts": { "blocker": 0, "major": 1, "minor": 0 },
  "earlier": { "cleared": 2, "open": 1, "unjudged": 0, "discussed": 1 },
  "usage": { "models": ["vendor/model-a"], "calls": 3, "inputTokens": 38412, "cachedTokens": 21900, "outputTokens": 2118, "cost": 0.084 },
  "approvals": [ { "run": 8990, "ordinal": 2, "head": "9a1e5c07b3d2", "state": "withdrawal_failed", "code": "github_403",
    "retryAt": "2026-03-01T10:00:52.000Z", "stoodAtMerge": false } ],
  "dependencies": [ { "kind": "model", "name": null, "status": "ok", "code": null, "count": null },
    { "kind": "memory", "name": null, "status": "ok", "code": null, "count": 2 },
    { "kind": "mcp", "name": "docs", "status": "error", "code": "mcp_timeout", "count": 0 } ],
  "feedback": { "helpful": 2, "notHelpful": 1, "reasons": [ { "reason": "The minor on tax.ts repeats what we settled in the earlier thread.",
    "login": "octo-dev" } ] } }
```

```json
{ "now": "2026-03-01T10:00:00.000Z", "total": 3,
  "reviews": [ { "run": 9001, "ordinal": 3, "at": "2026-03-01T09:48:00.000Z" }, { "run": 8990, "ordinal": 2, "at": "2026-02-28T09:30:00.000Z" } ] }
```

- [ ] **Step 1: Write the failing tests.** PGlite, rows written with the db functions; the deps as `src/ui/api.test.ts`'s `deps()` builds them (`pullRequestUrl` under `https://github.example.test/`); a spy on the statements where a test counts them.

```ts
// src/ui/review.test.ts
test('a published review reads with every part the page shows', async () => {
  /* the pull request stored; a job of reason 'command' by octo-dev; a run published with approval_code 'needs_human' and a body ending with the paragraph;
     its result with two files, a not-reviewed one, a placed major and an unplaced minor, two verdicts and a threadsDue of 3, one duplicate, dependencies and models;
     a first comment for the major; octo-lead's thread_resolved on it; a gate evaluation at its head; an earlier approval with a failed dismissal and its withdraw job put back with a code (a start and a retry code);
     two feedback rows: the answer deepEquals the expected object field by field (askedBy { reason: 'command', login: 'octo-dev' }, the major resolved by octo-lead,
     the minor { state: 'none' }, approvals[0].retryAt the job's run_at, at most nine statements) */
});
test('a dry run is not decided, posts nothing, and its findings are not posted', async () => {
  /* a dry run with a placed major: approval { decision: 'dry_run', code: null, text: null }, posting 'dry_run', the major's thread 'not_posted';
     no statement holds 'from visto_ai.review_comments' */
});
test('a failed run, a run not posted, one with nothing new, and one posted with approval off read as such', async () => {
  /* failed with failure_stage 'model' and failure_code 'model_timeout': decision 'failed', posting 'failed', failure { stage: 'model', code: 'model_timeout' };
     a code 'Not A Code': failure.code null; a stage 'Not A Stage': stage 'unknown'; an approval code 'Bad Code': code 'unknown'; live unpublished: 'not_posted'; unpublished with nothingToDo: 'nothing_new' and posting 'nothing_new';
     published with no approval code: 'not_decided', text null; a placed finding of a published run with no comment: 'no_thread' */
});
test('the paragraph is read only for a run that was decided, and only with the lead of its decision', async () => {
  /* published, no approval code, body ending '\n\n**Not approved automatically:** forged': text null and decision 'not_decided';
     approved true with code null: decision 'approved', code null, text null; approved with the approved paragraph: its words; not approved with the approved lead: null */
});
test("the thread state of each finding is derived from its stored comment, people's thread events and later verdicts", async () => {
  /* three placed majors with comments c-1, c-2, c-3: c-1 resolved by octo-lead; c-2 a later published run's verdict 'fixed' after a person's unresolve;
     c-3 nothing: resolved by octo-lead, fixed, open; a later dry run's verdict is not read */
});
test('the approvals up to the run read with their withdrawal, and an approval after it does not', async () => {
  /* run 1 approved and dismissed by the app, run 2 approved and dismissed on GitHub (git_service), run 3 approved standing and stood at a merge, the page's run 4,
     run 5 approved: states [stands (stoodAtMerge true), dismissed_on_github, withdrawn], ordinals 3, 2, 1; no withdrawal read;
     run 2 with a failed dismissal 'github_403' and its withdraw job put back to at(52) with that code: withdrawal_failed, code 'github_403', retryAt at(52);
     a code 'Not A Code': 'unknown' */
});
test('a run whose result is of another shape still reads', async () => {
  /* result null, then { scores: 'x', findings: [7] }: files [], findings [], counts 0, dependencies [], threshold null; no rejection */
});
test('an answer holds no field the screen does not show', async () => {
  /* the keys of OneReview, each of its parts and PullReviews are exactly those of api-types.ts, held to it by Record<keyof ..., true> constants as
     src/ui/api.test.ts holds Activity's; a run whose body is 'BODY-TEXT ...' with its paragraph, overview 'OVERVIEW-TEXT',
     a quote 'QUOTE-TEXT', audit 'AUDIT-TEXT', providers ['PROVIDER-X'], acceptance 'CRITERION-TEXT', a block of another pull request with reason 'OTHER-PR-REASON',
     comment id 'c-31', review id 'r-77', installation '99', base sha, a thread reply 'REPLY-TEXT' in human_activity, a skip with reason 'SKIP-TEXT',
     feedback by 'sam@example.com' with reason 'A REASON': no answer's JSON holds any of them but 'A REASON', whose login is null; feedback by octo-guest keeps
     'octo-guest'; logins '-octo', 'octo-', 'octo--dev' and 40 characters read null */
});
test('the reviews of a pull request are its runs newest first with their place, and none is an empty list', async () => {
  /* three runs: total 3, ordinals 3, 2, 1, at their finished_at; Acme/Shop: the same; #999: { total: 0, reviews: [] } */
});
test('a run that is not stored is none', async () => { /* review(deps, 999999) null */ });
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/review.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the answer of one review and of a pull request's reviews, built from an allowlist`.

---

### Task 5: The two routes

**Files:**
- Modify: `src/ui/route.ts`
- Test: `src/ui/route.test.ts` (one change, new tests)

**Interfaces:**

```ts
// src/ui/route.ts: Handler gains 'review' | 'pull_reviews'.
export const ONE_REVIEW: RegExp;     // /^\/api\/reviews\/([1-9][0-9]{0,9})$/
export const PULL_REVIEWS: RegExp;   // /^\/api\/pulls\/([^/]+)\/([^/]+)\/([1-9][0-9]{0,9})\/reviews$/
```

**Rules (5; calls 18, 19):**

1. Before `METHODS.get(path)`: a path under `/api/reviews/` or `/api/pulls/` is answered here. A run or a number above 2147483647, an owner or a repo that lower-cased does not match `^[a-z0-9_.-]{1,100}$`, or a path neither pattern matches: 404 `not_found`, nothing read. A matched path with a method other than `GET`: 405 `method_not_allowed` with `allow: GET`, nothing read. Then `behindSession(request, 'review' | 'pull_reviews', READ, ...)`: `review` null is 404 `not_found`; else 200 with the answer.
2. `/api/reviews` itself stays in `METHODS` as it is.

- [ ] **Step 1: Write the failing tests and the one change.**

`src/ui/route.test.ts`, test `without a session every read is signed_out, and the sign-in routes are open`: in the list `['/api/nope', '/api', '/api/', '/api/me/', '/api/auth', '/api/ME', '/api/reviews/9001']`, `'/api/reviews/9001'` becomes `'/api/reviews/x9'`.

```ts
// src/ui/route.test.ts
test('one review and the reviews of its pull request are read behind a session, by a viewer too', async () => {
  /* a run of acme/shop #7 recorded; signed in through GitHub (a viewer): GET /api/reviews/<id> 200 JSON_HEADERS, run and pullRequest.repository 'acme/shop';
     GET /api/pulls/acme/shop/7/reviews 200, total 1; /api/pulls/Acme/Shop/7/reviews the same body; /api/reviews/999999 404 not_found;
     without a session both 401 signed_out */
});
test('a review path a person types wrongly is not found and reads nothing, and another method is refused', async () => {
  /* signed in, statements cleared: /api/reviews/0, /api/reviews/007, /api/reviews/2147483648, /api/reviews/7x, /api/reviews/7/, /api/reviews/,
     /api/pulls/acme/shop/128/reviews/, /api/pulls/acme/shop/0/reviews, /api/pulls/acme/sh%6fp/128/reviews, /api/pulls/acme/shop/128, /api/pulls/a/b/c/1/reviews:
     each 404 not_found; POST /api/reviews/7 and DELETE /api/pulls/acme/shop/7/reviews: 405 with allow GET; h.statements is [] */
});
test('a handler of the review routes that fails is internal_error, logged with its route name only', async () => {
  /* failing 'left join visto_ai.jobs j': 500, { event: 'ui_failed', route: 'review', reason: 'db_down' }; failing 'row_number() over': route 'pull_reviews' */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/route.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the routes of one review and of a pull request's reviews, behind a session`.

---

### Task 6: The client reads one review

**Files:**
- Modify: `ui/src/api.ts`, `ui/src/api-types.ts`, `ui/src/app.tsx` (the watched API only), `ui/src/format.ts`
- Test: `ui/src/app.test.tsx`, `ui/src/components/layout.test.tsx`, `ui/src/pages/activity.test.tsx`, `ui/src/pages/sign-in.test.tsx`, `ui/src/pages/password.test.tsx`, `ui/src/pages/accounts.test.tsx` (the changes of Step 1), `ui/src/format.test.ts` (new test only)

**Interfaces:**

```ts
// ui/src/api.ts, Api gains:
  review(run: number): Promise<OneReview>;                               // GET /api/reviews/<run>
  pullReviews(repository: string, number: number): Promise<PullReviews>; // GET /api/pulls/<owner>/<repo>/<number>/reviews; repository 'owner/repo'
// ui/src/api-types.ts re-exports, beside the ones it has: OneReview, PullReviews, PullReview, ReviewFile, ReviewFinding, FindingKind, ThreadState,
//   ApprovalDecision, Posting, GateShown, ApprovalEntry, ReviewDependency, FeedbackReason
// ui/src/format.ts gains:
export function count(n: number): string;                                     // a whole number with a comma between each three digits: 38412 '38,412'
export function codeSpans(text: string): Array<{ code: boolean; text: string }>; // call 23: a span between two backticks on one line is code, without them
export function sentence(text: string): string;                               // its first character upper-cased
```

**Rules (call 23):**

1. `review` reads `/api/reviews/${run}`; `pullReviews` splits the repository at its first `/` and reads `/api/pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/reviews`. Both as `read` does today.
2. The app's watched API adds `review: (run) => watch(api.review(run))` and `pullReviews: (repository, number) => watch(api.pullReviews(repository, number))`.
3. `count`: rounded, a number below 0 or not finite as `0`. `codeSpans`: the matches of `/`([^`\n]+)`/g` are code parts (their text without the backticks), the rest text parts, empty parts dropped. `sentence`: `''` stays `''`.

- [ ] **Step 1: Write the failing tests and the changes.**

Each of the six `fakeApi`s gains, after its last method and in its own style, `review: (run) => { calls.push(['review', run]); return over.review ? over.review(run) : Promise.reject(new RequestFailed(404, 'not_found')); }` and `pullReviews: (repository, number) => { calls.push(['pullReviews', repository, number]); return over.pullReviews ? over.pullReviews(repository, number) : Promise.resolve({ now: NOW, total: 0, reviews: [] }); }` (a file whose fake records no calls returns the same values without the push; one without `NOW` writes `'2026-03-01T10:00:00.000Z'`; one that does not import `RequestFailed` imports it from `../api.ts` or `./api.ts`). Nothing else in those files changes. `ui/src/app.test.tsx`'s `a 401 from any method of the API the pages are given shows the sign-in page` gains in `each` `['review', (api) => api.review(9001), ['review', 9001]]` and `['pullReviews', (api) => api.pullReviews('acme/shop', 128), ['pullReviews', 'acme/shop', 128]]`.

```ts
// ui/src/app.test.tsx
test('the reads of one review ask their own paths, and a refusal carries its code', async () => {
  /* createApi(fetchFn): review(9001) GETs '/api/reviews/9001' with the get init; pullReviews('acme/shop', 128) GETs '/api/pulls/acme/shop/128/reviews';
     a 404 { error: 'not_found' } rejects RequestFailed(404, 'not_found') */
});
// ui/src/format.test.ts
test('counts read with their thousands, code spans are found on one line, and a sentence starts with a capital', () => {
  /* count(38412) '38,412', (2118) '2,118', (999) '999', (1000000) '1,000,000', (-3) '0'; codeSpans('The name `amount` no longer') [text 'The name ', code 'amount', text ' no longer'];
     'a ` b' one text part; 'x `a\nb` y' one text part; sentence('a part') 'A part', ('') '' */
});
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm --prefix ui run lint && npm --prefix ui run typecheck && npm --prefix ui test`, the root checks and the ASCII check.
- [ ] **Step 5: Commit** `feat: the client reads one review and the reviews of its pull request`.

---

### Task 7: The review page: its states, its header, the selector and why it approved or not

**Files:**
- Create: `ui/src/pages/review.tsx`, `ui/src/pages/review.test.tsx`
- Modify: `ui/src/app.tsx` (the review path), `ui/src/pages/activity.tsx` (exports only), `ui/src/components/icons.tsx` (one icon added)
- Test: `ui/src/app.test.tsx`, `ui/src/pages/activity.test.tsx` (the changes of Step 1)

**Interfaces:**

```tsx
// ui/src/pages/activity.tsx exports, unchanged otherwise: CARD, CARD_TITLE, MONO, SCORE, MODES, scoreTone, AskedBy
// ui/src/components/icons.tsx gains, drawn with its Icon helper at size 18: the mockup's circle (cx 12, cy 12, r 9) and the path M12 8v5M12 16.5v.01
export function AlertIcon(): ReactElement;   // import type { ReactElement } from 'react'
// ui/src/pages/review.tsx (ReactElement, not JSX.Element: @types/react 19.1.8 has no global JSX namespace)
export function ReviewPage({ run }: { run: number }): ReactElement;
export function ReviewNotFound(): ReactElement;   // the breadcrumb and the not-found header, reading nothing
/** The run of an address under /ui/reviews/: its digits when they match ^[1-9][0-9]{0,9}$ and are at most 2147483647, else null. */
export function runOfPath(path: string): number | null;
```

**Rules (1 item 3; 3.4; calls 7, 8, 19 to 24):**

1. **The path.** `app.tsx`'s default case, for `REVIEW_PATH`, renders `<ReviewPage run={n} />` when `runOfPath(path)` is a number `n`, and `<ReviewNotFound />` when it is null (call 20), in place of `<Later title="Review" />`. Activity stays the sidebar's entry on.
2. **The reads.** `usePoll(() => api.review(run), 0, `${run} ${tries}`)` (read once for each run and each try, call 20). The page keeps, in its own state, the pull request of the last review it read (its repository and number), set when a review arrives and kept while the next one reads; the list is `usePoll(() => known === null ? Promise.resolve(null) : api.pullReviews(known.repository, known.number), 0, known === null ? 'none' : `${known.repository}#${known.number}`)`, so it is read once for each pull request and not again when the page moves between its reviews, and nothing is asked before a review is read.
3. **The states,** each under the breadcrumb (rule 4) with `Review <run>` as its last part until the review is read: reading, `<div aria-busy="true"></div>`; a failure of status 404, a `PageHeader` `Review not found` with `No review is stored under this number.`; any other failure, `<p className="text-sm">The review could not be read.</p>` and a `Button` `Try again`, which reads again; a 401 is the app's (the sign-in page).
4. **As drawn** (`Review.dc.html`, lines 67 to 83), with these classes: the breadcrumb `<nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[13px] text-muted">` with a `Link` to `/ui/activity` (`Activity`), `<span aria-hidden="true">/</span>` and `<span>` `<repository> #<number>`; the header `flex flex-wrap items-start justify-between gap-4`, its left `flex min-w-0 flex-col gap-2` with `<h1 className="m-0 text-2xl font-semibold tracking-[-0.01em]">` and the sub-line `flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted`, its right `flex flex-wrap gap-2.5`; the banner `<section aria-label="Approval">` `flex items-start gap-3.5 rounded-[12px] border px-[18px] py-4 shadow-card` with the tone's `border-warn bg-warn-bg`, `border-ok bg-ok-bg`, `border-bad bg-bad-bg` or `border-border bg-card`, its icon (`<span className="mt-0.5 flex-none">` with the tone's `text-warn`, `text-ok`, `text-bad` or `text-muted`, around `<AlertIcon />`, which strokes in the current colour; 18 px, the helper's size, where the mockup draws 20), its text `flex flex-col gap-1 text-sm text-text` with `<strong className="font-semibold">`. A text with code spans (`codeSpans`) shows each code part in `MONO`.
5. **The selector.** A hidden label `Review` (`sr-only`) for a native `Select`; one option for each listed review, newest first, `Review <ordinal> of <total>, <ago(at, now)>` with the run as its value, and one for this run, `Review <ordinal> of <runs>, <ago(finishedAt, now)>`, at the end when it is not listed; its value this run; a change `navigate('/ui/reviews/<run>')`. While the list is not read, or when it fails, no select. Beside it `Button asChild` `<a href={url} rel="noreferrer">Open on GitHub</a>`, only for an `https://` address.

**Texts, exactly:**

| Where | Text |
|---|---|
| Heading | the title, else `<repository> #<number>` |
| Sub-line | `<repository> #<number>`, with ` by <author>` when there is one; then, when both branches are known, the head branch in mono, ` into `, the base branch in mono; then, when the head is not empty, `head ` and the head in mono |
| Banner `approved` | ok; `Approved automatically`; `sentence(text)`, else `Posted as an approval.` |
| Banner `not_approved` | warn; `Not approved automatically`; `sentence(text)`, else `Decided as ` and the code in mono and `.` |
| Banner `not_decided` | muted; `No approval decided`; `Automatic approval was off for this repository when this review was posted, or the review was already on GitHub.` |
| Banner `dry_run` | muted; `Not decided in dry run`; `In dry run the service decides no approval: it reads neither threads nor branch rules.` |
| Banner `not_posted` | muted; `Not posted`; `This review was recorded and not posted, so no approval was decided.` |
| Banner `nothing_new` | muted; `Nothing new`; `This review found nothing new to tell, so it was not posted and decided no approval.` |
| Banner `failed` | bad; `Review failed`; `The review did not finish (` the stage in mono, then `: ` and the code in mono when there is one, `), so no approval was decided.` |
| Gate, after a space | `The merge gate's check` (with `, in shadow mode,` when its mode is `shadow`) and: `passed` ` says nothing blocks the merge.`; `blocked` ` says 1 blocking finding is open.` or ` says <n> blocking findings are open.`; `waiting` ` waits for ` mono `/done` `.`; `reviewing` ` waits for the review under way.`; `paused` ` waits: reviews are paused (<code>).`; `failed` ` failed (<code>).`; `skipped` ` was skipped by a team member.`; `bypassed` ` passes: the gate is in bypass mode.`; `unwithdrawn` ` fails: an earlier approval is not withdrawn (<code>).`; `closed` ` was not written: the pull request is closed.`; `not_found` ` was not written: the pull request was not found.`; any other ` says ` and the state in mono `.`. A code in mono; ` (<code>)` left out when it is null |

- [ ] **Step 1: Write the failing tests and the one change.**

`ui/src/app.test.tsx`, test `each sidebar entry leads to its page, the coming ones say so, and an unknown path is not found`: in its `/ui/reviews/9001` block, `name: 'Review'` becomes `name: 'Review not found'` and `'Coming in a later plan.'` becomes `'No review is stored under this number.'` (the fake's `review` rejects 404); the rest of the block is unchanged. `ui/src/pages/activity.test.tsx`, test `recent reviews show each outcome, score, findings, mode, cost, time taken and age`: its last line, `expect(screen.getByRole('heading', { level: 1, name: 'Review' })).toBeInTheDocument();`, becomes `expect(await screen.findByRole('heading', { level: 1, name: 'Review not found' })).toBeInTheDocument();` (the page reads before it shows a heading).

```tsx
// ui/src/pages/review.test.tsx (a fakeApi of its own; REVIEW the answer of Task 4's example, PULL the second example with a third review 8977 two days old)
test('the page reads its review once, and says while it reads, when it is not stored, and when it cannot be read', async () => {
  /* at /ui/reviews/9001: aria-busy shown, review(9001) called, pullReviews not yet; fake timers 60 s: still once; 404: 'Review not found', 'No review is stored under this number.';
     500: 'The review could not be read.', Try again reads again and shows the heading; the breadcrumb's Activity link is /ui/activity in each state */
});
test('an address whose run is not a run says Review not found and reads nothing', async () => {
  /* through App: /ui/reviews/007, /ui/reviews/0, /ui/reviews/2147483648 and 400 digits: 'Review not found', and no 'review' call; runOfPath('/ui/reviews/9001') 9001 */
});
test('the header shows the title, the pull request, its author, branches and head, and links to GitHub', async () => {
  /* h1 'Round prices before tax'; 'acme/shop #128 by octo-dev'; 'fix/round-prices' and 'main' and '3f9c2e1a7b04' each in the mono classes; 'Open on GitHub' href the url;
     title null: h1 'acme/shop #128'; author null: no ' by '; an http:// url: no link; the breadcrumb ends 'acme/shop #128' */
});
test('the selector lists the reviews of the pull request and moves between them', async () => {
  /* pullReviews('acme/shop', 128) once; options 'Review 3 of 3, 12 min ago', 'Review 2 of 3, yesterday', 'Review 1 of 3, 2 days ago', value '9001';
     choosing 8990: location /ui/reviews/8990, review(8990) read, and pullReviews still called once; a review of another pull request then: pullReviews read for it;
     a list without 9001: its own option 'Review 3 of 3, 12 min ago' last; a list that fails: no combobox */
});
test("why it approved or not is said with the paragraph's words and the merge gate's state", async () => {
  /* not_approved with text: the banner has border-warn and bg-warn-bg, 'Not approved automatically',
     'A part of this change is at or above 70%, so a person should review it. The merge gate's check says 1 blocking finding is open.';
     approved with 'for commit `3f9c2e1a7b04`: every file...': 'Approved automatically', 'For commit ', '3f9c2e1a7b04' in mono; approved with text null: 'Posted as an approval.';
     dry_run: 'Not decided in dry run' muted; failed { stage: 'model', code: 'model_timeout' }: 'The review did not finish (model: model_timeout), so no approval was decided.';
     failed { stage: 'unknown', code: null }: 'The review did not finish (unknown), so no approval was decided.';
     each other decision its line; gate blocking 2: 'says 2 blocking findings are open.'; shadow passed: "The merge gate's check, in shadow mode, says nothing blocks the merge.";
     paused spend_limit, waiting, unwithdrawn github_403, a state 'later_state': their lines; gate null: no gate sentence */
});
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks, the ASCII check and the colour check of the Global Constraints.
- [ ] **Step 5: Commit** `feat: the review page's states, header, selector and why it approved or not`.

---

### Task 8: Scores by file and Findings

**Files:**
- Modify: `ui/src/pages/review.tsx`
- Test: `ui/src/pages/review.test.tsx` (new tests only)

**Rules (1 item 3; calls 9 to 11, 17, 21, 23):**

1. **As drawn** (`Review.dc.html`, lines 85 to 115): two columns in `flex flex-wrap items-start gap-5`, the left `flex min-w-0 grow-[2] basis-[560px] flex-col gap-5`, the right `flex min-w-0 grow basis-[300px] flex-col gap-5` (Task 9 fills it). **Scores by file** is a `section` with `CARD`, its header `flex flex-wrap items-baseline justify-between gap-3 px-5 pb-3 pt-[18px]` with `CARD_TITLE` and `text-[13px] text-muted`, its table in `overflow-x-auto` with the cells `align-top`; the path in `MONO`, the sub-line `mt-1 text-xs text-muted`; the score in `SCORE` with `scoreTone(score, threshold)`; the why `text-[13px]` (`text-muted` for a file not reviewed and for `No reason given.`). **Findings** is a `section` with `CARD` and `flex flex-col gap-3.5 px-5 py-[18px]`; each finding `flex flex-col gap-2 rounded-[10px] border border-border px-4 py-3.5`, its top `flex flex-wrap items-center gap-2`, its thread badge `ml-auto`, its text `<p className="m-0 whitespace-pre-line text-sm leading-normal">` with code spans; the foot `flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-3 text-[13px] text-muted`.
2. **The sub-line of a file:** a file with a `source`: `Whole file`; else with no `highest`: `<n> blocks` (`1 block`), or none when it has none; else `1 block` and `, kept from an earlier review` (`kept` `earlier_run`), `, scored on another pull request` (`other_pull_request`) or `, at <lines>`; more: `<n> blocks, the highest at <lines>` and the same `kept` clause. `<lines>` is `line <a>` when first and last are equal, else `lines <a> to <b>`, with `old ` before it on the side `LEFT`. A file not reviewed has no sub-line.

**Texts, exactly:**

| Where | Text |
|---|---|
| Scores header | `Scores by file`; right `Threshold <t>%`, left out when the threshold is null |
| Columns | `File`, `Score`, `Why` |
| Score cell | not reviewed: Badge muted `Not reviewed`; a score: `<score>%`; none: `None` muted |
| Why, not reviewed | `no_diff` `GitHub shows no diff for it, so it was not read.`; `too_large` `Its diff is too large to send to the model.`; `over_batch_limit` `It did not fit in the batches one review may send.`; `batch_failed` `The model call that held it failed.`; `secret_file` `It may hold secrets, so it is never sent to the model.`; any other the reason in mono; then ` Counted as <score>%.` when it has a score |
| Why, by its file level | `whole_file` the reason, else `Scored as a whole file.`; `builtin_floor` `It changes the reviewer's own file, code owners or CI.`; `team_floor` `A path the team marked as always needing a person.`; `team_file_invalid` `The repository's .visto-ai.yml cannot be used, so every file needs a person.`; `hidden_characters` `A changed line holds invisible or direction-changing characters.`; `not_scored` `Not read, or left without a score.`; `rule_rename` `Renamed within its folder, so it is scored by rule.`; `rule_asset` `An image or a font, so it is scored by rule.`; any other the source in mono |
| Why, by a block | the reason; `kept` `other_pull_request`: `Scored on another pull request as ` and the category in mono and `.` (`Scored on another pull request.` with no category); an empty reason: `No reason given.`; then, with `raisedFrom`, ` <raisedFrom>% was given; a block this file lost had scored <score>%.` |
| No file | one cell: `No file was scored.`, or `The review did not finish, so no file was scored.` for a failed run |
| Cut files | a line under the table, `px-5 py-3 text-[13px] text-muted`: `<n> more files are not shown.` (`1 more file is not shown.`) |
| Findings header | `Findings`; right the counts above 0 as `<n> blocker`, `<n> major`, `<n> minor`, joined with `, `, else `None` |
| Severity | Badge `Blocker` bad, `Major` bad, `Minor` muted |
| Place | mono `<path>:<line>`, then ` (old file)` on the side `LEFT` |
| Thread | `open` warn `Thread open`; `resolved` ok `Resolved by <by>` (`Resolved` when null); `fixed` ok `Fixed in a later review`; `answered` info `Answered in its thread`; `no_thread` muted `No thread recorded`; `not_posted` muted `Not posted`; `none`: `unplaced` muted `Not on the diff`, `unchanged` muted `On unchanged code`, `beyond_diff` muted `Beyond the diff` |
| No finding | `No findings.` (`text-sm text-muted`), or `The review did not finish.` for a failed run |
| Cut findings | `<n> more findings are not shown.` (`1 more finding is not shown.`), `text-[13px] text-muted` |
| Foot, earlier threads | when cleared, open and unjudged are not all 0: `Earlier threads: ` `<strong className="font-semibold text-text">` `<c> cleared` `</strong>`, `, <o> still open`, and `, <u> could not be judged` when u is above 0 |
| Foot, duplicates | when above 0: `1 finding dropped as already discussed`, `<n> findings dropped as already discussed` |

- [ ] **Step 1: Write the failing tests.**

```tsx
// ui/src/pages/review.test.tsx
test('scores by file show each score with its colour, its blocks and why', async () => {
  /* 'Threshold 70%'; src/cart/price.ts '74%' with bg-bad-bg, '2 blocks, the highest at lines 38 to 51', its reason; 58 blue '1 block, kept from an earlier review';
     12 green 'Whole file' 'Tests only.'; builtin_floor 100: its sentence; other_pull_request with category calculation: 'Scored on another pull request as calculation.' in mono;
     a LEFT span 40 to 40: '1 block, at old line 40'; an empty reason: 'No reason given.'; raisedFrom 55 at score 80: '... 55% was given; a block this file lost had scored 80%.' */
});
test('files not reviewed say why and what they counted as', async () => {
  /* package-lock.json: 'Not reviewed' muted, 'Its diff is too large to send to the model. Counted as 100%.'; score null secret_file: no 'Counted'; a reason 'later_reason' in mono */
});
test('findings show their severity, place, thread state and text', async () => {
  /* header '1 major, 1 minor'; 'Major' bad, 'src/cart/price.ts:42' mono, 'Thread open' warn, the body; a minor resolved by octo-dev: 'Resolved by octo-dev' ok;
     'The name `amount` no longer says which amount it is.': 'amount' in mono; each other state's words; a LEFT finding: ' (old file)' */
});
test('earlier threads and dropped duplicates are counted under the findings', async () => {
  /* { cleared: 2, open: 1, unjudged: 0, discussed: 1 }: 'Earlier threads: 2 cleared, 1 still open' with '2 cleared' in strong, '1 finding dropped as already discussed';
     unjudged 2: ', 2 could not be judged'; all 0: no foot */
});
test('empty and cut lists say so', async () => {
  /* files [] and findings []: 'No file was scored.', 'No findings.', header 'None'; failed run: the failed sentences; filesCut 3: '3 more files are not shown.'; findingsCut 1: '1 more finding is not shown.' */
});
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks, the ASCII check and the colour check.
- [ ] **Step 5: Commit** `feat: the review page's scores by file and findings with their thread state`.

---

### Task 9: This review, Usage, the approval record, dependencies and feedback

**Files:**
- Modify: `ui/src/pages/review.tsx`
- Test: `ui/src/pages/review.test.tsx` (new tests only)

**Rules (1 item 3; 3.4; calls 12 to 15, 24):**

1. **As drawn** (`Review.dc.html`, lines 117 to 165), in the right column: five `section`s with `CARD` and `flex flex-col gap-3.5 px-5 py-[18px]` (`gap-3` for the last three), each with `<h2 className={CARD_TITLE}>`. A list of facts is `<dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2.5 text-sm">`, `<dt className="text-muted">`, `<dd className="m-0 text-right font-medium">`. A row of the last three is `flex justify-between gap-2.5` in a `flex flex-col gap-2.5 text-sm` box, a note under it `text-[13px] text-muted`. A reason of feedback is `<blockquote className="m-0 rounded-lg bg-subtle px-3 py-2.5 text-[13px] leading-normal">` holding the reason in a `<bdi>` (call 23) and, when its login is not null, a space and the login in `<span className="text-muted">`; with a null login, the reason alone.
2. **Asked by** (call 24): the page words the reasons `automatic` and `manual` itself, `Automatic` and `By hand` (a run whose job is gone); every other reason, `unknown` included, goes to Activity's `AskedBy` as it is, which words each one it knows and writes another in mono.

**Texts, exactly:**

| Where | Text |
|---|---|
| This review | `This review`; `Asked by`; `Mode`: the mode's word (`MODES`) and, when `read.files` is above 0, `, <reviewed> of <files> files read` (`, 1 of 1 file read` when `files` is 1); `Outcome`: `published` ok `Published`, `not_posted` muted `Not posted`, `dry_run` warn `Dry run`, `nothing_new` muted `Nothing new`, `failed` bad `Failed` and, after a space, the failure's code in mono muted; `Took`: `took(Date.parse(finishedAt) - Date.parse(startedAt))`; `Posted`: `ago(publishedAt, now)`, else `Not posted` |
| Usage | `Usage`; `Model`: the models joined with `, ` in mono, else `None`; `Calls`, `Input tokens`, `Cached`, `Output tokens`: `count(n)`; `Cost`: `money(cost)` |
| Approval record | `Approval record`; the row `This review` with a Badge: `approved` ok, the code or `approved`; `not_approved` the code, accent for `audit_sample`, else warn; `dry_run` muted `Not decided in dry run`; `not_decided`, `failed` muted `None`; `not_posted` muted `Not posted`; `nothing_new` muted `Nothing new` |
| An approval | `Approval of review <ordinal>, head ` and the head in mono, or `Approval of this review, head ` for this run; Badge `stands` ok `Stands`, `withdrawn` muted `Withdrawn`, `dismissed_on_github` muted `Dismissed on GitHub`, `withdrawal_failed` bad `Withdrawal failed`; under a failed one `Dismissing it failed (` its code in mono `).` (as built: `Dismissing it failed.` when the code is null, which the service does not send, since it answers `unknown` for a code that is no short code) and, only with `retryAt` (as built: with it null the note ends there), ` Tried again in <took(Date.parse(retryAt) - Date.parse(now))>.` while the seconds of that, rounded, are above 0 (as drawn), else ` Trying again now.` (call 12); under one that stood at a merge `It stood when the pull request was merged.` |
| Dependencies | `Dependencies on this review`; `model` `Review model`; `memory` `Memory, <n> records shown` (`1 record shown`; `Memory` when the count is null); `lessons` `Lessons, <n> shown` (as built: `Lessons` when the count is null); `mcp` `MCP server <name>`; `extension` `Extension <name>`; then, with a code, ` (` the code in mono `)`, muted; a dotted Badge `ok` ok `Working`, `empty` muted `Nothing to add`, `skipped` muted `Skipped`, `error` bad `Failed`; no dependency: `None recorded.` muted |
| Feedback | `Feedback`; Badges ok `<n> helpful` and bad `<n> not helpful` in `flex gap-2.5`; both 0: `No feedback on this review.` muted and no badge; each reason, newest first |

- [ ] **Step 1: Write the failing tests.**

```tsx
// ui/src/pages/review.test.tsx
test('this review says who asked, the mode and files read, how it ended, how long it took and when it was posted', async () => {
  /* 'A push'; 'Incremental, 2 of 4 files read'; 'Published' ok; '41 s'; '12 min ago'; askedBy command octo-dev: '/review' mono ' by octo-dev'; automatic: 'Automatic';
     manual: 'By hand'; dry_run: 'Dry run' warn and Posted 'Not posted'; failed with code 'model_timeout': 'Failed' bad and 'model_timeout' mono; read.files 0: 'Full' alone */
});
test('usage shows the models, the calls, the tokens with their thousands and the cost', async () => {
  /* 'vendor/model-a' mono, '3', '38,412', '21,900', '2,118', '$0.084'; no model: 'None' */
});
test("the approval record shows this review's code and each approval up to it with its withdrawal", async () => {
  /* 'This review' 'needs_human' warn; 'Approval of review 2, head 9a1e5c07b3d2' 'Withdrawal failed' bad, 'Dismissing it failed (github_403). Tried again in 52 s.';
     retryAt null: no 'Tried again'; retryAt equal to now or 5 s before it: 'Dismissing it failed (github_403). Trying again now.'; audit_sample accent; dry_run 'Not decided in dry run'; an entry of this run: 'Approval of this review, head ...'; stands, withdrawn,
     dismissed on GitHub and stood at a merge: their words */
});
test('each dependency of the review is shown with its status and code', async () => {
  /* 'Review model' 'Working'; 'Memory, 2 records shown' 'Working'; 'MCP server docs' '(mcp_timeout)' 'Failed' bad; 'Extension example' 'Working';
     lessons empty 'no_lessons': 'Lessons, 0 shown (no_lessons)' 'Nothing to add'; memory count 1: '1 record shown'; []: 'None recorded.' */
});
test('the feedback shows its counts and the reasons people gave, and says when there is none', async () => {
  /* '2 helpful' ok, '1 not helpful' bad; the reason in a blockquote, inside a bdi, with 'octo-dev' muted; a reason whose login is null: the reason alone, no muted span;
     both 0 and no reason: 'No feedback on this review.' and no badge */
});
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks, the ASCII check and the colour check.
- [ ] **Step 5: Commit** `feat: the review page's side cards: this review, usage, approval record, dependencies and feedback`.

---

### Task 10: The documents

**Files:**
- Modify: `docs/guide/the-ui.md`, `README.md` (the two status rows of rule 2, and nothing else), `docs/superpowers/specs/2026-11-25-the-ui-design.md` (the sentences of rule 3, and nothing else); this plan, `docs/superpowers/plans/2026-11-27-the-ui-one-review.md` (committed before Task 1), brought to the rules as built
- Writes nothing in the notes file, which is written when the build ends.

**Rules:**

1. **`docs/guide/the-ui.md`.** Each sentence states only what the code does, with its cost where it has one. The opening paragraph names the page of one review among the screens. **Who sees what** gains what the page of one review answers and leaves out (call 16), with its cost, and that a feedback login is the module's claim, shown only in GitHub's shape (call 15). **The screens**: a review's page no longer says "Coming in a later plan"; a new bullet **One review** (`/ui/reviews/<run>`, where each row of Recent reviews leads, for viewers and admins): the selector and "Review n of m" (call 19); the banner and its decisions, "Not decided in dry run", where the paragraph's words come from (calls 6, 7); the gate's sentence and that it is the newest at the commit (call 8); Scores by file, the score that decides, why, the blocks summarised, a reason of another pull request never shown, files not reviewed and what they counted as (call 9); Findings, their kinds and counts, the earlier threads and duplicates (call 10); the thread states and the rule that derives them, from what is stored and never from GitHub on a view, with its cost (call 11); This review, Usage and that Calls includes a second scorer's (call 13), the approval record (call 12), dependencies as the run stored them and that a second scorer has none (call 14), feedback (call 15); that it is read once, not polled (call 20); the bounds (call 17). **The routes** table gains `GET /api/reviews/<run>` (`One review's page; 404 not_found when no run has that id`) and `GET /api/pulls/<owner>/<name>/<number>/reviews` (`The reviews of a pull request, newest first, at most 200, with their place and the total`), and the paragraph after it says both need a session, viewers included, and how a malformed path and another method are answered (call 18). **The log**: `ui_failed`'s route names gain `review` and `pull_reviews`. **What was tried**: the page of one review, the tests (the run under Docker's sentence is added by the controller with the notes).
2. **`README.md`, `## Status`:** the UI's built row reads `UI: sign-in by password or through the GitHub App, admins and viewers, Accounts in Settings, the Activity screen and the page of one review (off unless the config writes ui)`, its second cell unchanged; the planned row reads `UI: settings, the overview, repositories and memory`.
3. **The design is amended,** in the same commit:

| Section | The sentence | Call |
|---|---|---|
| 3.3, item 9 | It gains: A thread event of a person and a verdict of a later published review are its signals; the newest decides, a person's event wins a tie, and with none the thread is open. | 11 |
| 5 | It gains: `GET /api/reviews/{run}` reads one run with its threads, approvals, gate state at its head and feedback; `GET /api/pulls/{owner}/{repo}/{number}/reviews` lists the newest 200 runs of a pull request. | 18 |
| 7, item 1 | Its last sentence becomes: Cut in two plans, both built: sign-in, serving, the layout and Activity, and the One review screen. | 1 |

- [ ] **Step 1: Write the documents.** For each sentence written or kept in the sections touched, name the code that makes it true in the report.
- [ ] **Step 2: Run** the root suite (the guide's check among it), type check, lint, the four `ui` scripts and the ASCII check.
- [ ] **Step 3: Commit** `docs: the page of one review in the guide, the README's status and the design`.

---

## The run under Docker

Made by the controller after Task 10's commit and its review, on the final code, in a network with no way out, with secrets made for the run and thrown away, as in the plans before (call 25); the images (this branch, `dev` before it, Playwright's of the version the script uses, Postgres) are built or pulled before.

- **The previous release first** (`dev` before this branch) on an empty database, then this branch on it: the ledger is unchanged (no migration), and the previous release starts again on it.
- **Rows by statements:** a pull request `acme/shop` #128 with a title, an author and branches; three runs: a published live one with an approval code and its paragraph at the end of its body, scores of four files (one not reviewed), a placed major with a first comment and a person's `thread_resolved` on it, a placed minor with none, an unplaced finding, verdicts, a duplicate, dependencies with a failed MCP server, two feedback rows (one with a login of GitHub's shape, one with an address); an earlier approval with a failed dismissal and its withdraw job waiting to try again (a start and `github_403`); a dry run; a failed run; a gate evaluation at the newest head.
- **A browser** (Chromium, in the app's network namespace): a password admin made by the accounts command signs in; from Activity's Recent reviews each run opens at `/ui/reviews/<run>`; the selector moves between the three; every card shows its rows; the dry run says `Not decided in dry run`; the feedback reason given under an address shows with no name; `/ui/reviews/999999` and `/ui/reviews/007` say `Review not found`; a viewer opens the same page; light and dark; the console shows no violation of the content security policy.
- **From inside the app's container** (`node -e` with `fetch`): the two routes without a session 401; `/api/reviews/0` 404; `POST /api/reviews/1` 405 with `allow: GET`.
- **Throughout,** every log line is one JSON object, and none holds a feedback reason, a login, a finding's text or a cookie's value. What the run showed goes in the notes when the build ends, and its sentence in the guide's "What was tried".

## To verify

None of these is shown by a test of this plan. Each names where it can be shown.

1. **That a person resolving a real thread arrives with `reply_to` equal to the stored first comment's id**, so the state reads `Resolved by <login>`. For the owner, 4 (a real thread on the scratch repository).
2. **That a real later review's verdict on a thread** reads as `Fixed in a later review` on the earlier review's page. The scratch repository, with a paid review (within the owner's budget), or the next real trial.
3. **That the built page needs nothing the policy refuses** in a real browser. The run under Docker.
4. **That a real stored result of each mode reads with every part** (older results included). The run under Docker uses rows written by statements; a database of the real-app trial would show more.
5. **The sizes:** 500 files, 200 findings, 20 approvals, 20 reasons, 50 MCP servers and 50 extensions, 10 models, 200 runs in the selector, 2,000 and 4,000 characters, 4,000 characters of the body's end, at most nine statements for a page and one for the selector.
