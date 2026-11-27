# The UI, Overview, Repositories and Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The service stores every alert it raises and the state of each dependency it learns of, and the UI's last three screens open for everyone signed in. The Overview (`/ui/`) shows the reviews of the last 7, 30 or 90 days, what is in review now, today's spend against the daily limit, the pull requests approved automatically and drawn for the audit, reviews per day, open and recent alerts, score quality per repository (Safety, Benefit and Focus at the repository's threshold, each with the count behind it, measured live from what people did), reverts, each repository's automatic approval in short, and the health of each dependency. Repositories (`/ui/repositories`) shows, for one repository and a window, the three numbers at 20, 40, 70 and 90 percent and at the repository's own threshold, the blocks people stepped in on that scored under the threshold, reverts and how many the bot had approved, audits and how many needed a person, and the share of helpful feedback with the reasons given. Memory (`/ui/memory`) lists the learned records with their kind, text, place, source and dates, and an admin switches each off or on: the next review reads only the records switched on. With this plan no screen says "Coming in a later plan".

**Architecture:** `createAlerts` (`src/shell/alerts.ts`), which every alert passes through, tells a new status store (`src/shell/status-store.ts`) of each one; the four health objects (model, MCP servers, extensions, memory), the review job (the second scorer) and the start's app check tell it what they saw. The store writes, in order and never in the way of the work, to two tables of migration `0017_overview` (`alerts`, `dependency_health`), through `src/db/status.ts`; a note that a dependency works clears the open alert of its pair. Live score quality reads closed pull requests, their runs' stored scores and people's inline comments (`src/db/quality.ts`), labels them with a pure function beside the backtest's (`src/eval/live/labels.ts`), and measures them with the backtest's own code (`src/eval/backtest/metrics.ts`, which gains the counts behind its numbers); `src/ui/quality.ts` caches each result for 5 minutes. The memory switch writes `memory_records.status` (`active` or `disabled`, which the table already allows) with who switched and when; the readers of a review already read only `active`. `src/ui/overview.ts`, `src/ui/quality.ts` and `src/ui/memory.ts` build the answers from an allowlist; `src/ui/route.ts` routes six of them. In `ui/`, the client gains six calls and the three screens are drawn from their mockups with the theme's tokens.

**Tech Stack:** Unchanged: Node 26 or later, type stripping, no build step, no new library in either `package.json`. React 19, Vite, Tailwind v4 with the tokens of `ui/src/index.css` only, Vitest and Testing Library on jsdom. One migration, `0017_overview`. No model call.

**Spec:** `docs/superpowers/specs/2026-11-25-the-ui-design.md` ("the design"): 1 (items 1, 4, 5), 3.3 (items 3 to 8), 3.4 (dry run decides no approval; open and recent alerts; an audited pull request "needed a person"), 5 (`GET /api/overview?days=`, `GET /api/repositories`, `GET /api/repositories/{owner}/{repo}/quality?days=`, `GET /api/memory?kind=&repo=&q=`, `PUT /api/memory/{id}`, `GET /api/health`), 6, 7 (item 3), 8; its mockups `docs/superpowers/specs/2026-11-25-the-ui-mockups/Main.dc.html` (the Overview), `Repositories.dc.html` and `Memory.dc.html` ("the mockup" of each task; their content, columns, cards and wording; their indigo replaced by the tokens, call 3); and `docs/superpowers/specs/2026-11-13-visto-ai-design.md` ("main"): 6.6 (the "Live" score quality and its labels), 7 (every record has a kill switch in the UI), 13. It builds on the merged plans `docs/superpowers/plans/2026-11-25-the-ui-sign-in-and-activity.md` ("the first plan"), `docs/superpowers/plans/2026-11-26-password-sign-in-and-roles.md` ("the password plan"), `docs/superpowers/plans/2026-11-27-the-ui-one-review.md` ("plan A") and `docs/superpowers/plans/2026-11-27-the-ui-settings.md` ("plan B"), with their notes, whose calls and "as built" rules stand unless a call here changes them. Executors read the design, the three mockups and this plan whole, and the first plan's calls 13, 17, 19 and 22.

**Notes:** the notes file beside this plan, `docs/superpowers/plans/2026-11-27-the-ui-overview-repositories-memory-notes.md`, is written when the build ends. This plan, `docs/superpowers/plans/2026-11-27-the-ui-overview-repositories-memory.md`, is the design's plan 3 and the last of stage 10. **Plans A and B come before it, in that order:** it is built on a branch `ui-insight` cut from plan B's branch `ui-settings`, which is cut from plan A's `ui-review`, which starts from `ui-theme` (`dev` with the recolour). It names their functions as they define them (`Settings.inForce()`, `Switch`, the `PUT` of `ui/src/api.ts`, `CARD`, `CARD_TITLE` and `MONO` of `ui/src/pages/activity.tsx`, `count` of `ui/src/format.ts`, the `fakeApi`s they add); where one was built otherwise, the implementer uses what was built, keeps every addition of those plans as it finds it, and says in the task's report how it merged.

**Words used below.** *In force*: what the service runs on now, plan B's `Settings.inForce()` (without plan B's settings, the loaded config). *Started with*: the config the service started on (`startService`'s `config`; plan B's `settings.atStart`), for what is read once at start: dry run, learning, whether the second scorer is on, the extensions and the MCP servers. *An opener*: `model_error`, `mcp_error`, `extension_error` or `memory_error`; *its closer*: `model_ok`, `mcp_ok`, `extension_ok`, `memory_ok`. *An alert's key*: what it is about (call 7). *Open*, *recent*: call 8. *A note*: what a dependency was just seen to do (calls 12, 13). *A closed pull request*: stored with `state` `merged` or `closed`; *its close*: `coalesce(merged_at, closed_at)`. *A run that did not fail*: a run of `outcome` `ok`, one that found nothing new included (it still holds its head's scores, and memory's `scoredAt` reads it so). *Its last run*: the newest run that did not fail of a closed pull request that started at or before its close. *A window of d days*: from the start of the UTC day d - 1 days before the clock's day, to the clock (so it holds d UTC days, today the last); `all` is since `1970-01-01T00:00:00.000Z`. *The threshold*: a repository's `scoreThreshold` in force (`repoSettingsFor(inForce(), name)`). *An admin read*, *an admin change*: as in the password plan (call 20 there). *Short code*, *the token for changes*, *a session*: as in the plans before. *As drawn*: the mockup's markup, texts and classes, translated to the tokens.

## Scope

| In this plan | Left out, and why |
|---|---|
| Alerts stored, open and recent, a pair cleared by its pair (3.3 item 3, 3.4) | **Clearing an alert by hand** (3.4): nobody does; an alert with nothing behind it is only recent |
| Dependency health stored where the service learns it (3.3 item 4) | **A start check of the second scorer or of MCP servers**: each is learned at its first review (call 12) |
| Spend and reviews per day (3.3 item 5), feedback per repository (item 6) | **A chart of spend per day**: the mockup draws none; each day's spend is in its bar's title (call 19) |
| Live score quality, cached (3.3 item 8; main 6.6 Live) | **The diff at the last head before the merge** (3.3 item 8): not stored; the last review's hashes stand in (call 23) |
| The kill switch, written by the UI and read by the next review (3.3 item 7; main 7) | **A history of each record's switches**: the last switch is kept (call 31) |
| The Overview, Repositories and Memory screens; the routes of design 5 for them | **Expired records on the Memory screen** (call 32); **the gate's sentence on a failed withdrawal** (call 21) |

**Dry run:** alerts and health are stored as live; the Overview's approval card says "Not decided in dry run" (3.4), and a dry run counts no approval or audit anywhere; a dry run's scores are measured for score quality, as memory already counts them.

## Not in this plan

- Re-running a review, editing secrets, `app`, `database`, `server`, extensions or MCP servers (design 8).
- Anything the mockups do not show, but the states and texts the tasks pin: those of calls 18, 19, 22, 26 and 34; the lines under the Repositories cards and its ` Not enough labels yet to mean much.`; Memory's paging foot and its line for viewers; the details of every alert (the mockup's "Yesterday at 17:05." becomes the alert's age); the expiry date of a lesson (the mockup's "Never": main 7.2 gives lessons 90 days).
- Any dropped idea (no finding verifier, no repository-wide context packs, no recall-first contract, no lens pass), and any model call.

## Calls

"(builder)" marks a call the builder took before the plan was written, restated with its cost; every other call is the planner's. Where a design or a mockup says otherwise, the call says so.

**The cut and the rules of the build**

1. **(builder) The design's plan 3, whole, in one plan of thirteen tasks:** the measuring code and the live labels; the store of alerts and health; the status store and its hooks; the service writing them; live score quality and the repositories' answer; the Overview's and health's answers; memory and its switch; the routes; the client; the three screens; the documents. The run under Docker follows the last task. Cost: the largest plan of the stage; no screen says "Coming in a later plan" until it is merged.
2. **(builder) One migration, `0017_overview`:** the tables `alerts` and `dependency_health`, and on `memory_records` who switched a record last and when. The previous release refuses to start on the migrated database (`unknown_migration_applied`), as after every migration. Cost: no way back to the previous release.
3. **(builder) No new library; the tokens only; no test reaches the network, a real Postgres or a model.** Every class is a token class of `ui/src/index.css`'s `@theme` or a size, never a hex value or a palette class; the mockup's switch is plan B's `Switch`, whose off track is `bg-muted`. Cost: as plan B's call 5.
4. **(builder) Built on plans A and B as they were built** (Notes). The Overview's approval settings and each repository's threshold are read from the settings in force, never from the loaded file. Cost: the three plans' additions meet in `src/ui/route.ts`, `src/ui/api-types.ts`, `src/service.ts`, `ui/src/api.ts`, `ui/src/app.tsx` and every `fakeApi`.
5. **(builder) No dropped idea returns; no model call.**

**Alerts (3.3 item 3; 3.4)**

6. **Every alert is written where every alert passes: `createAlerts`.** Its `alert` logs each one first; it gains an optional `store`, told each alert right after the log line and before the webhook check, so an alert is stored with no webhook and no sink too, in dry run too, and with the UI off (the tables exist after the migration whatever the config). The codes the service raises today, from `docs/guide/running-the-service.md`: `model_error`, `model_ok`, `spend_80`, `spend_limit`, `cost_unknown`, `redelivery_failed`, `feature_off`, `gate_check_failed`, `gate_bypass`, `extension_error`, `extension_ok`, `mcp_error`, `mcp_ok`, `memory_error`, `memory_ok`, `learning_stale`, `lessons_stale`, `dismissal_failed`, `stale_approval_merged`. **A closer is not stored:** it says a pair ended, which the opener's clearing tells (call 9). The details stored are an allowlist (`reason`, `seen_by`, `server`, `extension`, `part`, `spent`, `limit`, `hours`, `feature`, `missing`, `failed`, `complete`, `repo`, `number`): a string through `storable()` cut at 200 characters, a finite number, a boolean; any other key or value is dropped. None of them is a secret, a login or a text a person wrote (each raise site was read). Cost: one insert per alert raised, on the database the reviews use; an alert raised before the tables exist (a start whose migration has not run) is not stored and is logged (call 13). In production plan B's `main.ts` migrates before `startService`, so the tables exist for every alert.
7. **An alert's key:** `mcp_error` the `server`; `extension_error` `<extension>/<part>`; `feature_off` `<feature>:<missing>`; `dismissal_failed` and `stale_approval_merged` `<repo>#<number>` lower-cased; every other `''`. Cost: none known.
8. **Open and recent, by rule (3.4).** An alert is **open** while what it reports still holds: an opener until it is cleared (call 9); `feature_off` until a start's check of the app reads it no longer missing (call 10); `dismissal_failed`, the newest of its key, while a failure of a standing approval of that pull request is recorded (`review_runs.dismiss_failure`, read when asked); `spend_80` and `spend_limit` until the UTC day they were raised on ends. **The design names spend at 80% only; spend at the limit is open the same way:** it is spend at 80% too, and the guard raises only `spend_limit` when one review crosses both. Every other alert, and every alert no longer open, is **recent** for 7 days. Nobody clears an alert by hand. Cost: an alert with no state behind it cannot be marked as dealt with (3.4); a withdrawal whose failure is cleared reads resolved although nothing cleared its row.
9. **An alert with a pair is cleared by its pair: the note that its dependency works,** not the closer. The health objects forget their state at a restart, so a closer may never be raised for an opener stored before it; the first note after a start is always written (call 13), and a note that a dependency works clears every open opener of its key (`model_error` `''`, `memory_error` `''`, `mcp_error` the server, `extension_error` `<extension>/<part>`). An opener raised while one of its key is open is not stored again (the first reason stays), and a spend alert raised again on the same UTC day (a restart) neither. Cost: a second reason of a failure that goes on is only in the log.
10. **The app's permissions and events at a start:** once the check has read the app, its state is written (call 12) and every open `feature_off` is cleared, before the alerts of what is still missing are raised and stored again. A check that cannot read the app changes nothing stored. Cost: one row per missing permission or event at each start.
11. **What is kept, and for how long:** alerts raised more than 30 days ago are deleted at each upkeep (every 5 minutes), but an open one; the screens list the open ones (at most 50) and the recent ones (at most 20, 7 days). Cost: an alert older than 30 days is gone from the database.

**Dependency health (3.3 item 4)**

12. **Each dependency's status, and where the service already learns it:** `working` or `failing` with a short code, with since when and when it was last seen.
    - **The review model:** the state of `ModelHealth` itself (failing while it holds a failure, with `auth` or `no_credit`), told after each key check (at start and every 5 minutes; a check that answers `unknown` tells nothing) and after each review that tells it (`review-job.ts` already calls `health.reviewed`). Its name on the screen is `model.model` in force.
    - **The second scorer:** it has no health object, no alert and no start check; the review job learns it from the review's result: with a scorer for that review, the first entry of `result.audit` of stage `scorer` with action `file_failed` or `file_not_asked` and a short code as its reason is a failure with that code; else a review that made a model call (`result.usage.calls >= 1`) is a success. **No alert is added for it** (3.3 item 3 stores the alerts the service already raises). Its name is `scorer.model` in force. Cost: a review that never asks the scorer (every file read whole) reads as a success; until a review, "Not used yet".
    - **Memory, each extension's part (`context`, `notify`, `route`), each MCP server:** each time their health object is told of one (`createMemoryHealth`, `createExtensionHealth`, `createMcpHealth`), with what it is told. The `alert` part of an extension has no health today and has none here.
    - **The app:** each start's check (call 10), `failing` with `missing` when it lacks something, with the list (at most 50 `{ feature, missing }`).
    The redelivery is not a dependency: `redelivery_failed` is an alert. Cost: a dependency is as fresh as its last use: an MCP server no review asked for a day shows the state of a day ago.
13. **Writes are queued and never in the way:** one chain of writes in order, at most 200 queued, the one under way included (one more is dropped and logged); a write that fails is logged `{ event: 'status_store_failed', what, reason }` and changes nothing else; `stop` waits for the chain as it waits for the alerts' posts (5 seconds at most), then closes the store, so a write told after it (a review left behind by the drain's limit, a late `cost_unknown`) is dropped and never reaches the closed database; the upkeep queues the pruning and does not wait for it. A note is written when its status or code differs from the last one written in this process, when none was written since the start, or when the last was written 60 seconds ago or more. Cost: "checked 2 min ago" can lag by up to a minute; at most one write a minute per dependency in steady state.
14. **What is listed:** the dependencies the service started with: the review model; the second scorer when it is on; memory when learning is on; each extension and each MCP server of the config; the GitHub App; each with its stored row, or `unknown` ("Not checked yet") when it has none. A stored row of a dependency the config no longer names is not shown. Cost: a dependency switched on in the UI that waits for the restart (plan B's call 19) is listed from the restart on.

**The Overview (design 1, item 1)**

15. **The window** is 7, 30 or 90 days (`days`, 30 when absent), as the mockup's control draws; anything else is `bad_request`. The reviews are the runs started in it, split so they add up: published, in dry run, failed, with nothing new, not posted. Cost: none known.
16. **Spend today** is what the spend guard counts (`spentSince` of the UTC day's start: the runs' cost and the judge's calls'), against `limits.spendPerDay` in force; the bar is the share, at most 100. Cost: none known.
17. **Approved automatically** counts pull requests, not reviews (design 1: "how many pull requests were approved automatically"), each once, by its newest published live run of the window that carried a decision (**as built, last fix,** in words only: a run posted as an approval, `approved`, or decided with an `approval_code`): approved when that decision approved, drawn for the audit when it is `audit_sample`; "approvable" is their sum. Counting by the newest decision keeps the two apart when the audit share changed in Settings between two reviews. In dry run the line says `Not decided in dry run` (3.4). Cost: a pull request approved, then withdrawn, still counts as approved; one approved, then drawn, counts as drawn only.
18. **Score quality on the Overview** is the 20 repositories with the most runs in the window (**as built:** listed busiest first, the name deciding a tie, each shown by name; the rest counted, and found in Repositories), each the same computation as Repositories (call 26) over the Overview's window, at its threshold, with its reverts and its automatic approval in short from the settings in force (`On, strict, 5% audit`, `On, gate rule, 10% audit`, `On, strict, no audit`, `Off`). **One Overview request measures at most 2 repositories that are not kept,** each waited for at most 10 seconds; every other such row reads `Not measured yet` and is measured by a later read (the Overview reads every 60 seconds); a repository whose computation failed reads `Could not be measured` for the minute its failure is kept, and never fails the Overview. Safety is said as a share only from 10 labelled blocks up; under that, `Not enough labels yet, <n> of <m> blocks`, as drawn. Cost: an Overview of 20 repositories opened with nothing kept fills its table over about ten minutes.
19. **Reviews per day:** for each UTC day of the window, the published runs, the failed ones, and the rest (dry run, nothing new, not posted), the third **a legend the mockup does not draw** (`Dry run or not posted`, shown only when a day holds one), or a deployment in dry run would draw empty bars. The day's spend (runs and judge calls) is in the day's `title`, the only place spend per day is shown (3.3 item 5; the mockup draws no spend chart). Bar heights are set through React's `style` property, which the content security policy allows (the first plan's call 17), and nothing else is. Cost: spend per day is read by hovering with a mouse only: no keyboard, no touch.
20. **Reading:** the Overview is read when the page opens, when its window changes and every 60 seconds; health (alerts and dependencies) every 15 seconds; neither while the page is hidden (`usePoll`, as Activity). "In review now" is the layout's activity (5 seconds). Cost: about five more requests a minute while the Overview is open.
21. **A failed withdrawal's alert says its pull request and code only.** The mockup's "The gate check of its head fails until it is gone" is not said, as plan A's call 12 leaves it out: the page does not know whether a gate requires it. Cost: a reader of a gated repository is not told what the gate does.
22. **Alerts and dependencies in words** (Task 10 pins every text): an open `model_error`, `memory_error`, failed withdrawal or spend at the limit is `Failing` (bad); every other open one (`mcp_error` and `extension_error` among them, as the mockup draws an MCP server) `Warning` (warn); a recent alert that had an open state is `Resolved`, the others `Recent` (muted). The mockup's "Tool not offered" and "Since 10:42" become the short code and `since <utc time>`. Cost: texts the owner did not see for codes the mockup does not draw.

**Live score quality (3.3 item 8; main 6.6 Live)**

23. **The labels, from what is stored.** For each closed pull request of the window, each inline comment (`human_activity` of kind `inline_comment`) by an account other than the author (bots are never stored) counts, but a reply in a thread whose first comment, followed up `reply_to` through the pull request's stored comments as `labelCase` follows it, is one of the app's findings (`review_comments` of severity `blocker`, `major` or `minor`); a reply under a note counts (main 6.6). A comment on a commit a run that did not fail scored is placed on that run's blocks whose lines on its side meet its lines (as `labelCase` does); a file-level comment, or one on lines of no block, labels its file; a comment on a commit no run scored labels its file in the pull request's last run only (main 6.6). **The strict label** needs the lines to have changed later; the diff at the merge is not stored, so a block is strict when its `hunkHash` is not among the last run's blocks of its path, and a file when its `diffHash` is not the last run's (3.3 item 8); a label on the last run itself is never strict. The screen says so. Cost: a change made after the last review is not seen; the label is only as good as the commit and lines stored with the comment (To verify, 2).
24. **What is measured.** Benefit and Focus on each pull request's last run (main 6.6); Safety on each run that holds a label, with its scores, so a block is measured with the score it had when the person commented. All at 20, 40, 70 and 90 percent and at the threshold in force, **for every pull request alike, not each run's own threshold:** the rows compare one rule across the window. A block labelled at two heads of a pull request, unchanged between them, counts once for each run that holds the label, as the backtest counts a case's blocks. Cost: runs scored under an older threshold are measured at today's; such a block weighs more in Safety than one commented on once.
25. **The measuring code is the backtest's,** reused, not copied: `src/eval/backtest/metrics.ts` gains `countAt` (the counts `measure` divides), `addCounts` (two sets of counts added, since every count is a sum over cases) and `blockFlagged` (the rule `measure` flags a block by), its case type reads only the fields it measures (`ScoredFile`, which a `FileScore` is), and `measure` is built on them with its output unchanged. The live labels are a pure function beside the backtest's, `src/eval/live/labels.ts`, which builds `CaseScores` the measuring code reads from score lists reduced, as they are read, to the fields measured. A stored score of another shape (an older run) is not measured: its run is skipped, and a pull request whose last run is skipped is counted as unreadable. Cost: none known.
26. **Bounds, one at a time, and the cache.** The reviews and the webhooks share the database's 5 connections with the UI, so a computation is bounded in what it reads, in what it holds and in how many run at once.
    - **What it reads (as built):** the newest 300 closed pull requests of the window; the ids of their runs that did not fail, at most 10,000 rows, each with its stored result's size as stored (`pg_column_size`, which reads no value; no `result` is read for them); their inline comments, newest pull requests first, at most 20,000; the scores of at most 1,000 runs, read at most 10 runs and about 4 MB stored to a statement, pull request by pull request, a pull request never split across two statements (as built: one pull request's reads are themselves held to about 4 MB stored, so none is above the bound) (each one's last run, then its runs at the heads its counted comments name, newest first: only the comments `liveCases` counts, by the one rule `countedComments` of `src/eval/live/labels.ts`, so the author's own comments and replies in the app's finding threads take no place), each list reduced to the fields measured as it is read and dropped once its pull request is counted (the counts of each pull request are added to the window's); a run whose stored result is over 2 MB as stored is not read and counts as unreadable (**as built, last fix:** a last run over it is read alone, so no other run of its pull request is read; another head over it is left out). The screen says when pull requests, comments or runs were cut (**as built, last fix:** a head left out by `planOf`, by the bound of runs or of bytes, sets `cut.runs`, so the screen says those labels are approximate). A repository no pull request is stored of is answered at once with none, neither queued nor kept, so made-up names take no place in the queue or the cache.
    - **One computation at a time in the whole service:** a queue in `createQualityCache`; a key already queued or under way is not queued twice. A request waits for its computation at most 10 seconds, then is answered `computing` (the Repositories page reads again every 5 seconds); the computation goes on and is kept. A computation stops as failed (`too_slow`) once 60 seconds have passed, checked between its statements. **(As built, last fix)** the cache has a stop, called first by the service's stop and waited for (5 seconds at most) before the database closes: a computation under way ends before its next statement, none is started, and every request waiting for one is answered `computing` at once; what is kept is still answered.
    - **Kept:** a result 5 minutes, a failure 1 minute (answered `failed` meanwhile, not tried again), at most 100 kept (the oldest put dropped first), keyed by the repository, the window (7, 30, 90 days or `all`, the mockup's "Since install") and the threshold in force.
    - **The worst case (as built, measured):** one computation holds one of the 5 connections at a time, for at most about 75 seconds (its 60 seconds and the statement under way, which the pool cuts at 15 seconds), in at most about 310 statements (9 reads and up to 300 statements of scores, one for each pull request at most, when each reads more than 2 MB stored), all short, the 60 seconds bounding them; it holds in memory the comments (20,000 rows of a few short fields), the runs' ids and sizes (10,000), one group's score lists, the counts at five thresholds and 20 blocks; the cache holds 100 answers of a few KB each. Measured with score lists of the engine's shape stored at 2 MB each (about 9.7 MB as text): a group of 4 MB stored (two lists) peaks at about 46 MB of heap, for the time of one group; **(as built, last fix)** one pull request's reads are held to about 4 MB stored too: its last run (never over 2 MB, else it is unreadable and read alone) and then the runs at the heads its counted comments name, newest first, while they fit; a head left out labels only the last run's file and sets `cut.runs`, so the labels of a giant pull request are approximate and said so. Before this fix one pull request alone could read 10 lists of 2 MB (20 MB stored) and peak at about 205 MB of heap. **Measured again after the fix** (one pull request of ten runs, each 1.96 MB stored and 9.3 MB as text, nine heads commented): it reads two lists in one statement and peaks at about 45 MB of heap (43 to 47 MB in six runs) (195 MB with the bound lifted, as before the fix); the statement took about 65 ms in the in-process Postgres. The heap follows the text the scores hold (about 2.5 times it), not their stored size: lists that compress less peak lower (24 MB at 4.8 MB as text a list), and lists that compress better higher (about 100 MB at 17.7 MB as text a list), for the same 4 MB stored. A review or a webhook meanwhile waits for a connection only while the UI's other reads hold the other four.
    Cost: numbers up to 5 minutes old; a request waits up to 10 seconds; the largest reviews are not measured; one cold computation delays the next by up to 75 seconds; a failure is answered for a minute.
27. **Outside signals.** Reverts: pull requests of the repository merged in the window whose description reverts another (`pull_requests.reverts`), and of those, the ones whose reverted pull request held an approval of the app that was never withdrawn (published, live, `approved`, `dismissed_at` null). Audits: closed pull requests of the window with a published run drawn for the audit; one **needed a person** (3.4) when any of its blocks or files is strict, or a merged revert of it is stored. Cost: an audit a person read and found fine leaves no trace (3.4).
28. **Feedback per repository (3.3 item 6):** the answers of the window, helpful and not helpful; the reasons given with "not helpful", grouped by their text with spaces trimmed and letter case aside, the 5 most given, each shown with its newest wording cut at 200 characters, as drawn ("Repeats a settled thread (3)"). Everyone signed in reads them, as plan A's call 16 already shows reasons. Cost: two wordings of one reason are counted apart.
29. **The blocks people stepped in on under the threshold:** the strict blocks the threshold leaves to the bot (`blockFlagged` false), newest pull request first, then by path, at most 20, each with the score it was measured with (its own, else its file's whole-file level, else 0). Cost: none known.

**Memory and the kill switch (3.3 item 7; main 7)**

30. **Who may switch a record: admins.** `PUT /api/memory/{id}` is an admin change (session, token, admin role); a viewer sees the Memory screen whole with each switch disabled and a line saying an admin switches them. **Why:** a record is a reason for the model to look closely at a block, so switching one off can lower a later score: it changes how the service behaves, as Settings does, which design 3.2 keeps for admins; the API refuses viewers its admin routes. A switch is not a setting: it is not recorded as a change (design 4.4), and the record keeps who switched it last and when, nothing before. Cost: a viewer who finds a bad record asks an admin; there is no history of a record's switches beyond the last.
31. **How it is written and read.** Off: `status` from `active` to `disabled`; on: back to `active`; only for a record not expired (`status` `expired`, or `expires_at` passed, answers 404 `not_found`); `switched_at` and `switched_by` (the account's name) keep the last switch. Nothing else reads them. The next review reads it through what is there: every reader of memory (`liveRecords`, `liveLessons`, `liveReverts`) reads `status = 'active'` only, and a review reads memory once, when it packs its files, so a review already running keeps what it read. Learning never switches a record back on (`addRecords` leaves a stored row as it is), and the judge does not make again a lesson switched off (`standingLessons` counts disabled ones). **(As built)** a block score already raised while a record was on is kept by the score history until that code changes, so switching a record off does not take it back; the guide says so (`memory.md`, `the-ui.md`). Cost: a switch reaches a review only from the next one; only the last switch of a record is kept (call 30).
32. **What Memory lists:** the records switched on or off that have not expired, newest recorded first (by id, 50 a page, paged by `before`), filtered by kind, repository and a search of the path, directory, the person's words of a record of people stepping in, and the lesson (**as built:** a lesson's own quote is not searched). Each shows its kind, its text (the person's words for a record of people stepping in, the lesson for a lesson, a sentence of the page's for a revert or when no words were kept), its path (else its directory), its repository, where it came from (`#<n>, by <login>` from the comment's stored author, `#<n> reverted #<m>`, `A reply on #<n>`), when it was made and when it expires, and whether it is on. The counts are the records on per kind, the repositories of those of people stepping in, and the records off. **What everyone signed in reads that no screen showed:** the start of what a person wrote under a pull request (at most 200 characters, as learning keeps it) and that person's login. The design settles it: viewers see everything but Settings (3.2), the excerpt is stored for the UI and it is the model that is shown no words a person wrote (main 7.2), and the mockup draws both (`#104, by octo-lead`). Cost: a viewer reads people's words and logins for every repository the app is installed on; expired records are not listed.
33. **Learning's state** on Memory: whether learning was on at start (it is read once, plan B's call 19), and the last pass of the learning work (`learning` row `signals`, its `ran_at`). Cost: none known.

**The routes and the run**

34. **The routes** (Task 8 holds the exact paths): `GET /api/overview?days=`, `GET /api/health`, `GET /api/repositories`, `GET /api/repositories/<owner>/<name>/quality?days=`, `GET /api/memory?kind=&repo=&q=&before=` behind a session, viewers and admins alike; `PUT /api/memory/<id>` an admin change with the body `{ "on": true }` or `{ "on": false }`. A parameter written empty reads as absent; a malformed one is 400 `bad_request`; the quality route answers 200 with its state (`ready` with the numbers, `computing`, `failed`), never 500 for a computation that failed; a record that is not there or expired is 404 `not_found`; a path under `/api/repositories/` or `/api/memory/` that matches neither pattern is 404 and reads nothing; another method is 405 with `allow`. With the UI on but no `insight` given to the route (the route tests of before), the six answer 404 `not_found` and read nothing. Each counts against the API's 4 places. The Settings page's `Alert webhook` row, not set, now reads as drawn: `Not set, alerts are shown here only` (plan B's call 12 waited for this plan). Cost: none known.
35. **Logs:** `{ event: 'memory_switch', record, on }` per switch that changed a record; `{ event: 'status_store_failed', what: 'alert' | 'health' | 'clear' | 'prune', reason }` (**as built:** the labels of the code, not `app`, which is a `health` write followed by a `clear`); `{ event: 'status_store_full', what }` once for each write dropped; `{ event: 'quality_failed', reason }` for each computation that failed (`too_slow` or a short code); `ui_failed` with the routes' names `overview`, `health`, `repositories`, `quality`, `memory`, `memory_switch`. Never a login, a name, a person's words or a lesson. Cost: who switched a record is read from the table, not the log.
36. **The run under Docker** (after Task 13), made by the controller on the final code in a network with no way out, as in the plans before (the stub of GitHub with its CA, the model stub, Playwright's Chromium in the app's network namespace, `psql`), with rows written by statements for history, among them 300 closed pull requests of real size, timing a cold computation, each of its statements against the pool's 15 seconds, and a review's time while it runs. Cost: what GitHub itself answers stays unverified.

## For the owner

1. **Cannot be undone:** the previous release refuses to start on a database this release has migrated (`0017_overview`).
2. **Rulings you may want to change** (each a small change): call 30 (admins switch records, viewers see them; only the last switch of a record is kept, with no history before it), 6 (alerts stored with the UI off and in dry run), 8 (spend at the limit open like spend at 80%), 12 (the second scorer's state read from the review's audit, no alert for it), 17 (approvals counted by each pull request's newest decision), 18 (20 repositories on the Overview, at most 2 measured a request; "Not enough labels yet" under 10 blocks), 19 (a third legend; spend per day only in each bar's title), 21 (the gate's sentence left out), 24 (one threshold, today's, for every pull request; a block commented at two heads counts twice), 26 (300 pull requests, one computation at a time, 10 seconds of waiting, 60 seconds at most, 5 minutes of cache), 32 (expired records not listed).
3. **Texts the mockups do not draw** (Not in this plan): the states of call 18 and 26, the lines under the Repositories cards, Memory's paging foot and its line for viewers, every alert's detail, a lesson's expiry date; and, from the last fix, `50+ open` on the Alerts badge and `Unknown` and `Never` for a record's time no date writes.
4. **For your information, settled by the design:** everyone signed in reads people's words kept by learning and their logins (call 32; design 3.2, main 7.2, the mockup).
5. **Not settled, and yours to weigh:** the live labels lean on the commit and lines stored with each inline comment and on the first comment a reply points to (To verify, 2 and 3).
6. **Left as built, your call (last fix):** the queue of computations has no bound on its length: distinct repositories, windows and thresholds queue one behind the other, each up to about 75 seconds on one connection, so a person opening many tabs can keep one connection busy for a long while. A small bound past which a request is answered `computing` without being queued (the pages read again anyway) is a few lines.
7. **Not done in the last fix, waiting for your ruling:** that an expired record switched off becomes `expired` too, as an active one does (`retireExpired`). It changes nothing a review or a screen reads (every reader checks the expiry), but a test of stage 8 pins the opposite ("an expired active record is retired, and a disabled one is left as it is"), and no test made before this plan is edited without your word.

## Global Constraints

Every constraint of the earlier plans still holds. The ones that bite most often, and the new ones:

- **The service:** Node 26 or later, npm, no build step, erasable TypeScript only, `import type` for types, relative imports ending in `.ts`, no new library in either `package.json`.
- **The frontend:** classes from the tokens of `ui/src/index.css` and sizes only. The token check, `LC_ALL=C grep -rnE '\[#[0-9A-Fa-f]{3,8}\]|(bg|text|border|ring|accent|fill|stroke)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]' ui/src --include='*.tsx' --exclude='*.test.tsx'`, prints nothing after each frontend task. A `style` property only for the chart's heights and the spend bar's width (call 19).
- **ASCII only** in `src`, `contract`, `test`, `examples`, `ui/src`, `ui/index.html`, `ui/public` and `ui/`'s config files: after each task `LC_ALL=C grep -rn -P '[^\x00-\x7F]' src contract test examples ui/src ui/index.html ui/public` prints nothing.
- **No test reaches the network, a real database or a model.** A database is `testDb()`; a clock is passed in; every wait has a bound; the frontend's tests stub the API object and `fetch` is blocked.
- **One migration,** `src/db/migrations/0017_overview.sql`, plain SQL in the schema `visto_ai`. Owner and repo lower-cased on every write and lookup; outside text through `storable()`; a time as an ISO string with `::timestamptz`; a list of ids or numbers passed as one JSON text read with `jsonb_array_elements_text($n::jsonb)`. **No statement of this plan run outside an API request names `visto_ai.pull_requests` or holds the word `gate`** (the service's tests filter statements by those words): the status store's statements name `alerts`, `dependency_health` and, for pruning, `review_runs` only; an alert's code is a parameter, never in a statement's text.
- **The allowlist:** each answer is built field by field into the shapes of `src/ui/api-types.ts`; no answer holds the loaded config, a secret, a stored result as it is, a body, a quote, a comment id, an installation or a delivery. Each task's `an answer holds no field the screens do not show` holds it.
- **Boundaries, by the lint as it is:** `src/eval/live/labels.ts` imports only engine types and `src/eval/backtest/` (no db); `src/db/status.ts`, `src/db/overview.ts`, `src/db/quality.ts` import only `src/db`; `src/shell/status-store.ts` imports `src/db/status.ts`, `src/db/text.ts` and `src/shell/codes.ts`; `src/ui/*.ts` import `src/db`, `src/config`, `src/shell` and `src/eval/live`, `src/eval/backtest`; `src/engine/**` is not changed.
- **No existing test is edited, but for these,** each named in its task with the exact change: every frontend `fakeApi` (`grep -rln 'fakeApi' ui/src`: the six of the first two plans and those plans A and B added) gains the six calls, and `ui/src/app.test.tsx`'s `a 401 from any method of the API the pages are given shows the sign-in page` gains them in its list (Task 9); `ui/src/app.test.tsx`'s `each sidebar entry leads to its page, the coming ones say so, and an unknown path is not found`, and `ui/src/components/layout.test.tsx`'s test whose `/ui/memory` part expects "Coming in a later plan." as the header's sub-line, each changed as Task 10 rule 9 says (Tasks 10 to 12); plan B's migration test of `0016_settings`, when it migrates `all` and expects `['0016_settings']`, which Task 2 narrows to the migrations up to `0016_settings`. No other test expects "Coming in a later plan." for these three screens (`grep -rn 'later plan' ui/src` on `dev` finds only these and Accounts' sub-line, which plan B changes). Every new parameter or field of an existing function or type is optional. An implementer who finds another test that cannot hold stops and reports it.
- **Tests:** `node:test` in `src`, Vitest in `ui`. `at(seconds)` from `2026-03-01T10:00:00.000Z`; repositories `acme/shop`, `acme/web`; the admin `octo-admin`, the viewer `octo-lead`, a pull request's author `octo-dev`, a commenter `octo-guest`; heads of 40 hex characters invented (`3f9c2e1a7b04...`, `9a1e5c07b3d2...`); an MCP server `docs`, an extension `example`; models `vendor/model-a`, `vendor/decision-model`. Every fixture is invented.
- **Commits:** one per task, message as given, ending with the co-author line the implementer's own session gives. Nothing is pushed.

## Review Focus

Inputs and sequences no happy-path test would meet. Each has a test in the task named.

1. **A restart while a dependency fails:** the health object forgets, no closer comes, and the stored alert must still clear at the first success; and the same opener raised again after the restart must not be stored twice. Task 3 `a note that a dependency works clears the open alert of its pair, one a restart forgot included` and `every alert raised is stored but the closers, with its key and only the allowlisted details`.
2. **Comments that must not label:** the author's own, a reply in the app's finding thread, a comment on a commit no run scored, a file-level one, one outside the diff, one on the last run (never strict). Task 1 `the author's own comments and replies in the app's finding threads are not counted, and a reply under a note is` and `a comment on a commit no run scored labels its file in the last run, never strictly`.
3. **Stored results of an older or damaged shape** in the quality computation: no `blocks`, a block with no `lines`, an `entry` that is no object, a score that is a string, `null`. Task 1 `a stored score is reduced to what is measured, and one of another shape is not measured and never throws`; Task 5 `a run whose scores cannot be read, or whose stored result is too large, leaves its pull request out, counted`.
4. **A switch that should not happen:** a viewer's, one without the token, one on an expired record, a body of another shape, an id that is not a number. Task 7 `an expired record cannot be switched, and a switch to the state it is in changes nothing`; Task 8 `a record is switched by an admin with the token, and refused to a viewer, without the token, or with a body of another shape`.
5. **A window or a path a person types:** `days=0`, `days=abc`, `days=all` on the Overview, `days=` empty, `/api/repositories/Acme/Shop/quality`, `/api/repositories/acme/shop/quality/`, `/api/memory/007`, `%` and `_` in the memory search. Task 6 `the window must be 7, 30 or 90 days, and an empty one is 30`; Task 5 `the window and the repository must be of their shape`; Task 7 `the search takes percent, underscore and backslash as themselves`; Task 8 `a path of these routes typed wrongly is not found and reads nothing`.

---

### Task 1: The measuring code's counts, and the live labels

**Files:**
- Modify: `src/eval/backtest/metrics.ts` (`ScoredFile`, `ScoredBlock`, `Counts`, `countAt`, `addCounts`, `blockFlagged`; `measure` built on them)
- Create: `src/eval/live/labels.ts`, `src/eval/live/labels.test.ts`
- Test: `src/eval/backtest/metrics.test.ts` (new tests only)

**Interfaces:**

```ts
// src/eval/backtest/metrics.ts gains (measure's output unchanged; a FileScore is a ScoredFile, so every caller of before still type-checks):
export interface ScoredBlock { id: string; changedLines: number; entry: { score: number } | null }
export interface ScoredFile { path: string; changedLines: number; finalScore: number; fileLevel: { score: number } | null; blocks: readonly ScoredBlock[] }
// CaseScores' `scores` becomes `readonly ScoredFile[]`; highestScore takes `readonly ScoredFile[]`. (As built: `CaseScores<F extends ScoredFile = FileScore>` is generic, since `noise.ts` needs the `FileScore` it was written for.)
export interface Counts {
  blocks: number; blocksLeft: number; looseBlocks: number; looseBlocksLeft: number;
  files: number; filesLeft: number; looseFiles: number; looseFilesLeft: number;
  prs: number; prsClear: number; focusPrs: number; flaggedLines: number; totalLines: number;
}
/** Whether `measure` flags a block for a person at `t`: its file's whole-file level, or its own score, at or above `t`. */
export function blockFlagged(file: ScoredFile, block: ScoredBlock, t: number): boolean;
/** The counts `measure` divides, at one threshold. */
export function countAt(cases: readonly CaseScores[], threshold: number | 'own'): Counts;
/** Each count of `a` and `b` added: countAt of two lists of cases, added, is countAt of both. */
export function addCounts(a: Counts, b: Counts): Counts;

// src/eval/live/labels.ts: pure; no database, no clock.
export interface LiveBlock extends ScoredBlock { hunkHash: string; lines: Ranges }   // Ranges of src/engine/context/diff.ts
export interface LiveFile extends ScoredFile { diffHash: string | null; blocks: readonly LiveBlock[] }
export interface LiveRun { id: number; head: string; scores: readonly LiveFile[] }
export interface LiveComment {
  id: string; author: string; path: string | null; side: 'LEFT' | 'RIGHT' | null; line: number | null; startLine: number | null;
  fileLevel: boolean; commit: string | null; replyTo: string | null;
}
export interface LivePull {
  number: number; author: string | null; threshold: number;
  last: LiveRun | null;                          // its last run (Words used below); null when it has none or it could not be read
  atHead: ReadonlyMap<string, LiveRun>;          // at each head a comment was made on, the newest run that did not fail, started at or before the close
  comments: readonly LiveComment[];
  findingThreads: ReadonlySet<string>;           // the ids of the app's first comments of findings on this pull request
}
export interface LiveCases {
  pulls: CaseScores[];      // one per pull request with a last run: its last run's scores, no label (Benefit, Focus)
  labelled: CaseScores[];   // one per run that holds a label: its scores and its labels (Safety)
  strict: Set<number>;      // the pull requests with a strict block or file
}
export function liveCases(pulls: readonly LivePull[]): LiveCases;
/** A run's stored `result.scores` reduced to the fields measured (rule 2); null when any file is of another shape. Never throws. */
export function storedScores(value: unknown): LiveFile[] | null;
```

**Rules (main 6.6; calls 23 to 25):**

1. **`blockFlagged`** is `(file.fileLevel?.score ?? 0) >= t || (block.entry?.score ?? 0) >= t`; `countAt` is `measure`'s loop as it is, returning its thirteen counts; `addCounts` adds each; `measure` returns what it returned, from `countAt` (its shares through `share`). The backtest's tests pass unchanged.
2. **`storedScores`:** a list whose every entry is an object with a string `path`, `diffHash` a string or null, whole `changedLines` at least 0, a finite `finalScore`, `fileLevel` null or an object with a finite `score`, and `blocks` a list whose every entry is an object with a string `id`, a string `hunkHash`, whole `changedLines` at least 0, `entry` null, absent or an object with a finite `score`, and `lines` an object whose `RIGHT` and `LEFT` are lists of two whole numbers each; anything else is null. Each file is answered as a new object of only `path`, `diffHash`, `changedLines`, `finalScore`, `fileLevel` (`{ score }` or null) and `blocks`, each block of only `id`, `hunkHash`, `changedLines`, `entry` (`{ score }` or null) and `lines` (copied): nothing of the stored list (reasons, summaries, spans) is kept.
3. **`liveCases`,** for each pull with `last` not null:
   - `pulls` gains `{ key: '<number>', threshold, status: 'ok', scores: last.scores, labels: <empty> }`.
   - Each comment: skipped when `author` equals the pull's `author` (letter case aside); skipped when its thread starts with one of the app's findings: following `replyTo` through the pull's comments by `id` (as `labelCase` follows `reply_to`), a `replyTo` in `findingThreads` skips it; a `replyTo` that is no stored comment, or a chain that loops, ends the walk and the comment counts. Its run is `atHead.get(commit)` when `commit` is not null, else none; with none, the target is `last` and the comment labels a file only. The target's file of `path`: none skips the comment. A file only, `fileLevel`, or `line` null: the file is loose. Else the blocks whose `lines[side ?? 'RIGHT']` hold a range meeting `[startLine ?? line, line]`: none, the file is loose; some, the file and each of those blocks are loose.
   - Each run holding a loose label (labels are kept per run id, so a comment on `last`'s head labels `last`) gains a case `{ key: '<number>:<run id>', threshold, status: 'ok', scores: <the run's>, labels }`, where every block and file of the run has a label: a block `{ loose, strict: loose && run.id !== last.id && <no block of last's file at the path has its hunkHash> }`, a file `{ loose, strict: loose && run.id !== last.id && <last's file at the path is absent or has another diffHash> }`; `comments` is `{ counted: 0, off_head: 0, outside_diff: 0, in_bot_thread: 0 }` and `final_missing` 0. A pull with a strict label is in `strict`.
   - A pull with `last` null adds nothing.

- [ ] **Step 1: Write the failing tests.** Scores are literal objects in the engine's shape (`src/engine/score/types.ts`) with invented values, read through `storedScores`; `blockKey` from `labels.ts`.

```ts
// src/eval/backtest/metrics.test.ts
test('countAt holds the counts measure divides, addCounts adds them, and blockFlagged is the rule measure flags by', () => {
  /* the cases of this file's tests: for each threshold of THRESHOLDS and 'own', share(countAt(c, t).blocksLeft, .blocks) equals measure(c, t).safety_blocks,
     and the same for files, loose blocks and files, benefit (prsClear of prs) and focus (flaggedLines of totalLines); addCounts(countAt(first half, 70),
     countAt(second half, 70)) deepEquals countAt(all, 70); blockFlagged with a file level of 80 at 70: true whatever the block; a block entry 75, file level null:
     true at 70, false at 90; entry null and file level null: false at 20 */
});
// src/eval/live/labels.test.ts
test('a comment on a block of the run that scored its commit labels that block, strict when the last run no longer holds its lines', () => {
  /* run 11 at head A scores src/cart/price.ts with B1 (RIGHT 38-51, hunkHash 'h1', entry 55) and B2 (RIGHT 60-70, 'h2'); last run 12 at head B holds the file with
     B1 'h9' and B2 'h2'; octo-guest comments at head A on RIGHT 40: labelled has one case '128:11' whose labels give B1 { loose: true, strict: true },
     B2 { loose: false, strict: false }, the file { loose: true, strict: <diffHash differs> }; strict has 128; a comment at RIGHT 61: B2 loose, not strict */
});
test('a comment on a head whose only run found nothing new labels that run\'s blocks', () => {
  /* run 11 at head A found nothing new but holds the scores of its head (as the engine stores them): it is atHead's run of A; a comment there on B1 labels B1 of
     run 11, strict when the last run changed it, as above */
});
test('a comment on a commit no run scored labels its file in the last run, never strictly', () => {
  /* commit C not in atHead: labelled has '128:12' with the file loose and strict false, no block loose; strict is empty */
});
test("the author's own comments and replies in the app's finding threads are not counted, and a reply under a note is", () => {
  /* author octo-dev comments ('Octo-Dev' too): nothing; octo-guest replies to 'c-1' in findingThreads: nothing; a reply to a person's reply whose replyTo is 'c-1':
     nothing (the chain is followed); replies to 'n-1' (a note, not in findingThreads): counted; a replyTo of no stored comment: counted; a chain that loops: counted */
});
test('a file-level comment, one on lines of no block, and one on a path the run does not hold label the file only or nothing', () => {
  /* fileLevel true: the file loose, no block; line 200 outside every block: the file loose; path 'other.ts': no case; side LEFT meets only LEFT ranges */
});
test('benefit and focus are measured on each last run, safety on each labelled run, by the backtest\'s own code', () => {
  /* two pulls, one with last null: pulls has one case, its scores the last run's; countAt(pulls, 70).prs 1; countAt(labelled, 70).blocks counts the strict blocks */
});
test('a stored score is reduced to what is measured, and one of another shape is not measured and never throws', () => {
  /* null, 'x', [{ path: 'a' }], a block with no lines, lines.RIGHT [[1]], entry 'x', finalScore '70': null; [] is []; a good list with reasons, summaries and spans:
     each file's keys are exactly path, diffHash, changedLines, finalScore, fileLevel, blocks, and each block's id, hunkHash, changedLines, entry, lines; entry { score } only */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/eval/backtest/metrics.test.ts src/eval/live/labels.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the counts behind the backtest's numbers, and live labels from stored comments and runs`.

---

### Task 2: The store of alerts and dependency health

**Files:**
- Create: `src/db/migrations/0017_overview.sql`, `src/db/status.ts`, `src/db/status.test.ts`
- Test: `src/db/migrate.test.ts` (a new test, and the one change of Step 1)

**Interfaces:**

```ts
// src/db/status.ts
export const PAIR_OPENERS: readonly string[];   // ['model_error', 'mcp_error', 'extension_error', 'memory_error']
export const SPEND_ALERTS: readonly string[];   // ['spend_80', 'spend_limit']
export type AlertDetails = Record<string, string | number | boolean>;
export interface AlertRow { id: number; code: string; key: string; details: unknown; raised_at: Date; cleared_at: Date | null }
/** Stores one alert; false when `dedupeSince` is given and a row of its code and key raised at or after it is not cleared. */
export async function storeAlert(db: Db, a: { code: string; key: string; details: AlertDetails; at: string; dedupeSince: string | null }): Promise<boolean>;
/** Clears the open rows of a code, of one key or (key null) of every key; how many. */
export async function clearAlerts(db: Db, code: string, key: string | null, at: string): Promise<number>;
/** The open alerts (call 8), newest first; `dayStart` is the start of the clock's UTC day. */
export async function openAlerts(db: Db, dayStart: string, limit: number): Promise<AlertRow[]>;
/** The alerts raised since `since` that are not open by the open rule (whether or not they are shown), newest first (as built, last fix: not by the ids shown). */
export async function recentAlerts(db: Db, since: string, dayStart: string, limit: number): Promise<AlertRow[]>;
/** Deletes the alerts raised before `before` that are not open but by their day; how many. */
export async function pruneAlerts(db: Db, before: string): Promise<number>;
export type HealthKind = 'model' | 'scorer' | 'memory' | 'extension' | 'mcp' | 'app';
export interface HealthRow { kind: HealthKind; name: string; part: string; status: 'ok' | 'failing'; code: string | null; missing: unknown; since: Date; seen_at: Date }
/** One dependency's state: `since` stays while its status holds and becomes `at` when it changes; an older write changes nothing. */
export async function writeHealth(db: Db, h: { kind: HealthKind; name: string; part: string; ok: boolean; code: string | null; missing: unknown; at: string }): Promise<void>;
export async function readHealth(db: Db): Promise<HealthRow[]>;
```

**Rules (3.3 items 3 and 4, 3.4; calls 2, 7 to 11):**

1. **The migration**, exactly:

```sql
create table visto_ai.alerts (
  id integer generated always as identity primary key,
  code text not null,
  key text not null,
  details jsonb not null,
  raised_at timestamptz not null,
  cleared_at timestamptz
);
create index alerts_raised on visto_ai.alerts (raised_at);
create index alerts_open on visto_ai.alerts (code, key) where cleared_at is null;
create index alerts_withdrawal on visto_ai.alerts (key, id) where code = 'dismissal_failed';   -- as built, last fix: the newest of a key, without a walk of the table
create table visto_ai.dependency_health (
  kind text not null check (kind in ('model', 'scorer', 'memory', 'extension', 'mcp', 'app')),
  name text not null,
  part text not null,
  status text not null check (status in ('ok', 'failing')),
  code text,
  missing jsonb,
  since timestamptz not null,
  seen_at timestamptz not null,
  primary key (kind, name, part)
);
alter table visto_ai.memory_records add column switched_at timestamptz;
alter table visto_ai.memory_records add column switched_by text;
```

2. **The statements**, exactly (the key, the code, a name and a part through `storable()`; the details and the missing list as `storableJson()` of what is given, `::jsonb`, as the code stores JSON):

```sql
-- storeAlert ($5: dedupeSince or null)
insert into visto_ai.alerts (code, key, details, raised_at)
select $1, $2, $3::jsonb, $4::timestamptz
where $5::timestamptz is null or not exists (
  select 1 from visto_ai.alerts where code = $1 and key = $2 and cleared_at is null and raised_at >= $5::timestamptz)
returning id;
-- clearAlerts
update visto_ai.alerts set cleared_at = $3::timestamptz
where code = $1 and ($2::text is null or key = $2) and cleared_at is null
returning id;
-- (as built, last fix) every code is a parameter: the lists as JSON from PAIR_OPENERS (with 'feature_off') and SPEND_ALERTS,
-- and 'dismissal_failed'; the withdrawal check is one constant, WITHDRAWAL_STANDS, and the open rule one, OPEN, its $1 to $4:
--   ((a.code in (select jsonb_array_elements_text($1::jsonb)) and a.cleared_at is null)
--    or (a.code in (select jsonb_array_elements_text($2::jsonb)) and a.cleared_at is null and a.raised_at >= $3::timestamptz)
--    or (a.code = $4 and a.id = (select max(b.id) from visto_ai.alerts b where b.code = $4 and b.key = a.key) and WITHDRAWAL_STANDS))
-- WITHDRAWAL_STANDS: exists (select 1 from visto_ai.review_runs r where r.owner || '/' || r.repo || '#' || r.number = a.key
--                      and r.approved and r.published and not r.dry_run and r.dismissed_at is null and r.dismiss_failure is not null)
-- openAlerts ($1 to $4: the open rule's, $3 the UTC day's start; $5: the limit, 50)
select a.id, a.code, a.key, a.details, a.raised_at, a.cleared_at from visto_ai.alerts a
where OPEN
order by a.raised_at desc, a.id desc
limit $5;
-- recentAlerts ($1 to $4: the open rule's; $5: since; $6: the limit)
select a.id, a.code, a.key, a.details, a.raised_at, a.cleared_at from visto_ai.alerts a
where a.raised_at >= $5::timestamptz and not OPEN
order by a.raised_at desc, a.id desc
limit $6;
-- pruneAlerts ($2: the codes open until cleared, $3: 'dismissal_failed')
delete from visto_ai.alerts a
where a.raised_at < $1::timestamptz
  and not (a.code in (select jsonb_array_elements_text($2::jsonb)) and a.cleared_at is null)
  and not (a.code = $3 and WITHDRAWAL_STANDS)
returning id;
-- writeHealth ($6: the missing list as JSON, or null)
insert into visto_ai.dependency_health (kind, name, part, status, code, missing, since, seen_at)
values ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $7::timestamptz)
on conflict (kind, name, part) do update set
  since = case when visto_ai.dependency_health.status = excluded.status then visto_ai.dependency_health.since else excluded.since end,
  status = excluded.status, code = excluded.code, missing = excluded.missing, seen_at = excluded.seen_at
where visto_ai.dependency_health.seen_at <= excluded.seen_at;
-- readHealth
select kind, name, part, status, code, missing, since, seen_at from visto_ai.dependency_health order by kind, name, part;
```

- [ ] **Step 1: Write the failing tests and the one change.** Plan B's test of `0016_settings`, when it migrates `all` and expects `['0016_settings']`, migrates `all.filter((m) => m.name <= '0016_settings')` instead, as plan B narrowed the test of `0015_accounts`; nothing else in it changes.

```ts
// src/db/migrate.test.ts
test('0017_overview adds the alerts, dependency health and who switched a record, and every record stored before reads as never switched', async () => {
  /* migrations below 0017 applied, a memory record inserted, then all applied: '0017_overview' follows '0016_settings'; alerts and dependency_health exist and are
     empty; the record's switched_at and switched_by are null and its status is as it was */
});
// src/db/status.test.ts
test('an alert is stored with its key and details, and an opener is not stored again while one of its key is open', async () => {
  /* storeAlert mcp_error 'docs' { server: 'docs', reason: 'mcp_timeout' } at(0) dedupeSince epoch: true, the row as given; again at(10): false; key 'other': true;
     cleared, then again: true; dedupeSince null: stored every time */
});
test('a spend alert is stored once a UTC day', async () => {
  /* spend_80 at at(0) with dedupeSince the day's start: true; at at(60): false; the next day with its own day's start: true */
});
test('alerts are cleared by code and key, or by code alone', async () => {
  /* two feature_off keys and one mcp_error open: clearAlerts('feature_off', null) 2; clearAlerts('mcp_error', 'docs') 1; cleared rows keep cleared_at; again 0 */
});
test('the open alerts follow their rules: openers and feature_off until cleared, spend for its UTC day, a withdrawal while its failure is recorded', async () => {
  /* memory_error open, model_error cleared, feature_off open, spend_80 raised yesterday and spend_limit today, gate_bypass, two dismissal_failed of acme/shop#128
     (the newer at(20)) with a run of #128 approved, published, live, dismiss_failure 'github_403': open is [spend_limit, the newer dismissal_failed, feature_off,
     memory_error] by raised_at; the run's failure cleared by clearDismissFailure: the withdrawal is not open */
});
test('the recent alerts are those of the last days that are not open, newest first', async () => {
  /* recentAlerts(at(-7 days), [ids of the open ones], 20): gate_bypass, the cleared model_error, yesterday's spend_80, the older dismissal_failed; none older than 7 days */
});
test('pruning keeps what is open, and deletes the rest raised before the time', async () => {
  /* rows of 40 days ago: an open memory_error, a cleared one, a gate_bypass, a dismissal_failed whose failure is still recorded: pruneAlerts(at(-30 days)) deletes 2 */
});
test("a dependency's state keeps since while its status holds, moves it when the status changes, and an older write changes nothing", async () => {
  /* mcp docs ok at(0); ok at(60): since at(0), seen_at at(60); failing 'mcp_timeout' at(120): since at(120); a write at at(90): unchanged; app failing 'missing'
     with missing [{ feature: 'gate', missing: 'checks:write' }]: read back as given */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/db/migrate.test.ts src/db/status.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the store of alerts and of each dependency's state, and who switched a memory record`.

---

### Task 3: The status store, told by the alerts and the health objects

**Files:**
- Create: `src/shell/status-store.ts`, `src/shell/status-store.test.ts`
- Modify: `src/shell/alerts.ts` (`store`), `src/shell/model-health.ts`, `src/shell/mcp-health.ts`, `src/shell/extension-health.ts`, `src/shell/memory-health.ts` (each an optional `note`)
- Test: `src/shell/alerts.test.ts`, `src/shell/model-health.test.ts`, `src/shell/mcp-health.test.ts`, `src/shell/extension-health.test.ts`, `src/shell/memory-health.test.ts` (new tests only)

**Interfaces:**

```ts
// src/shell/status-store.ts
export const SEEN_WRITE_MS = 60_000;
export const ALERT_KEEP_MS = 30 * 86_400_000;
export const RECENT_MS = 7 * 86_400_000;
export const MAX_WAITING = 200;
export interface HealthNote {
  kind: HealthKind; name: string; part: string; ok: boolean; code: string | null;
  missing?: ReadonlyArray<{ feature: string; missing: string }>;
}
export interface StatusStore {
  /** An alert as raised (call 6): queued; never throws. */
  alerted(code: string, details: Record<string, string | number | boolean | null>): void;
  /** What a dependency was just seen to do (call 13): queued; never throws. */
  noted(note: HealthNote): void;
  /** A start's check read the app (call 10): its state, then every open feature_off cleared; queued; never throws. */
  appChecked(lacking: ReadonlyArray<{ feature: string; missing: string }>): void;
  /** Deletes the alerts past keeping (call 11): queued, not waited for; never throws. */
  prune(): void;
  /** Resolves when nothing is queued or under way. */
  settled(): Promise<void>;
  /** From now on every write told is dropped, unlogged (call 13): the service calls it once the queue settled, before the database closes. */
  close(): void;
}
export function createStatusStore(deps: { db: Db; clock: () => Date; log: (entry: Record<string, unknown>) => void }): StatusStore;
/** An alert's key (call 7). */
export function alertKey(code: string, details: Record<string, unknown>): string;
// src/shell/alerts.ts: createAlerts' deps gain
  store?: (code: string, details: Record<string, string | number | boolean | null>) => void;
// the health objects gain an optional second parameter:
export function createModelHealth(alert: Alert, note?: (ok: boolean, code: 'auth' | 'no_credit' | null) => void): ModelHealth;
export function createMcpHealth(alert: Alert, note?: (server: string, ok: boolean, code: string) => void): McpHealth;
export function createExtensionHealth(alert: Alert, note?: (extension: string, part: 'context' | 'notify' | 'route', ok: boolean, code: string) => void): ExtensionHealth;
export function createMemoryHealth(alert: Alert, note?: (ok: boolean, code: string) => void): MemoryHealth;
```

**Rules (calls 6 to 13):**

1. **`createAlerts`:** `deps.store?.(code, details)` right after the `alert` log line and before the check that returns when there is neither a webhook nor a sink, inside `try/catch`; a store that throws changes nothing. Nothing else of it changes.
2. **The health objects:** each calls its `note`, inside `try/catch`, every time it is told of one: `createMcpHealth`, `createExtensionHealth` and `createMemoryHealth` with what `noted` was given; `createModelHealth` after `checked` (but for a result `unknown`) and after `reviewed`, with its state once the call is done (`failure === null`, and its code or null). Their alerts are as before.
3. **One queue:** each write is chained after the one before, so they run in the order told. `MAX_WAITING` counts the writes queued, the one under way included: with that many, a new one is dropped and logged `{ event: 'status_store_full', what }`. A write that rejects is logged `{ event: 'status_store_failed', what, reason: codeOf(error) }`; the queue goes on. A clock that throws drops that write, logged the same way.
4. **`alerted`:** a closer stores nothing. Any other: the details kept are call 6's allowlist (a string `storable()` and cut at 200, a finite number, a boolean); `storeAlert` with `alertKey(code, details)`, the clock's ISO, and `dedupeSince` `'1970-01-01T00:00:00.000Z'` for an opener, the clock's UTC day start for a spend alert, null for the rest.
5. **`alertKey`:** call 7, each value read with `String()` and lower-cased for the two of a pull request; a detail missing reads as `''`.
6. **`noted`:** `code` is null when ok, else a short code (`isShortCode`) or `internal_error`. Keyed by kind, name and part: written (`writeHealth`, the missing list or null) when none was written for the key since this store was made, when `ok`, `code` or the missing list differs from the last written, or when the last was written `SEEN_WRITE_MS` or more before. When a written note is ok, `clearAlerts` of its opener and key (`model` `model_error` `''`; `memory` `memory_error` `''`; `mcp` `mcp_error` the name; `extension` `extension_error` `<name>/<part>`; the scorer and the app have none).
7. **`appChecked`:** `noted({ kind: 'app', name: '', part: '', ok: lacking.length === 0, code: ok ? null : 'missing', missing: <the first 50> })`, written whatever the throttle says, then `clearAlerts('feature_off', null, <now>)`, both queued.
8. **`prune`:** `pruneAlerts(<now - ALERT_KEEP_MS>)` queued and not waited for; a rejection is logged (`what: 'prune'`).
9. **`close`:** every write told after it is dropped with no statement and no log line; writes already queued still run.

- [ ] **Step 1: Write the failing tests.** PGlite (`testDb()`); a clock the test moves; a log that records.

```ts
// src/shell/status-store.test.ts
test('every alert raised is stored but the closers, with its key and only the allowlisted details', async () => {
  /* alerted mcp_error { server: 'docs', reason: 'mcp_timeout', extra: 'x', bad: null }, mcp_ok { server: 'docs' }, model_ok, gate_bypass, feature_off
     { feature: 'gate', missing: 'checks:write' }, dismissal_failed { reason: 'github_403', repo: 'Acme/Shop', number: 128 }: settled, the rows are mcp_error key
     'docs' details { server, reason }, gate_bypass key '', feature_off key 'gate:checks:write', dismissal_failed key 'acme/shop#128'; a reason of 300 characters
     is 200; mcp_error again while open: still one row */
});
test('a note that a dependency works clears the open alert of its pair, one a restart forgot included', async () => {
  /* a memory_error row stored by an earlier store; a new store: noted memory ok: the row cleared at the note's time; mcp_error 'docs' open, noted mcp 'web' ok:
     still open, noted mcp 'docs' ok: cleared; noted extension 'example' 'notify' ok clears extension_error 'example/notify' only */
});
test("a dependency's state is written when it changes, and its sighting at most once a minute", async () => {
  /* noted model ok at(0), at(30), at(59): one write; at(60): a second (seen_at at(60)); failing 'auth' at(61): written, since at(61); a code 'Not A Code': 'internal_error' */
});
test("the app's check writes its state with what it lacks, and clears the feature_off alerts before those still missing are stored again", async () => {
  /* two feature_off open; appChecked([{ feature: 'gate', missing: 'checks:write' }]) then alerted feature_off of it: the two cleared, one new open row; the app
     row failing 'missing' with the list; appChecked([]): ok, missing null, every feature_off cleared */
});
test('a write that fails is logged with a short code and changes nothing else, and past 200 waiting writes one is dropped and logged', async () => {
  /* a db whose insert rejects 'db_down': alerted resolves nothing, settled resolves, the log holds { event: 'status_store_failed', what: 'alert', reason: 'db_down' };
     a db whose first insert is held: 201 alerted gate_bypass (not deduplicated): one { event: 'status_store_full', what: 'alert' } (200 queued, the held one
     included); released: 200 rows */
});
test('pruning deletes what is past keeping, queued and not waited for', async () => {
  /* rows of 31 days ago, one open memory_error: prune() returns at once; settled: the open one is left */
});
test('a closed store writes nothing more', async () => { /* close(), then alerted and noted: settled, no statement, no log line; a write queued before close still runs */ });
// src/shell/alerts.test.ts
test('the store is told of each alert, with no webhook and no sink too, and a store that throws changes nothing', async () => {
  /* createAlerts with webhook null, no sinks, store recording: alert('gate_bypass') and ('spend_80', { spent: 40, limit: 50 }): the store got both, after the log line;
     a store that throws: the log line is written and alert returns */
});
// src/shell/model-health.test.ts
test('the model health tells its note of its state after each check and review, and a check that says nothing tells nothing', async () => {
  /* checked auth: note(false, 'auth'); checked unknown: no call; checked ok: note(true, null); reviewed no_credit: (false, 'no_credit'); checked ok while the failure was
     seen by a review: (false, 'no_credit'); reviewed null: (true, null); a note that throws changes nothing (paused as before) */
});
// src/shell/mcp-health.test.ts, extension-health.test.ts, memory-health.test.ts: one each
test('the health tells its note of what it was told, every time, and a note that throws changes nothing', async () => {
  /* noted three times (fail, fail, ok): three note calls with what was given; the alerts as before: one error, one ok */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/shell/status-store.test.ts src/shell/alerts.test.ts src/shell/model-health.test.ts src/shell/mcp-health.test.ts src/shell/extension-health.test.ts src/shell/memory-health.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: a status store of alerts and dependency states, told by the alerts and the health objects, a pair cleared by its dependency working`.

---

### Task 4: The service writes them

**Files:**
- Modify: `src/service.ts` (the store, its notes, the app check, the upkeep, the stop), `src/shell/review-job.ts` (`ReviewJobDeps.scorerHealth`)
- Test: `src/service.test.ts`, `src/shell/review-job.test.ts` (new tests only)

**Interfaces:**

```ts
// src/shell/review-job.ts, ReviewJobDeps gains:
  /** Told how the second scorer did in a review that had one (call 12); absent: nobody is told. */
  scorerHealth?: { noted(ok: boolean, code: string): void };
```

**Rules (calls 6, 10 to 13):**

1. **`startService`** makes `const status = createStatusStore({ db, clock, log: say })` before `createAlerts`, which gets `store: status.alerted`. The health objects get their notes: model `(ok, code) => status.noted({ kind: 'model', name: '', part: '', ok, code })`, MCP `(server, ok, code) => status.noted({ kind: 'mcp', name: server, part: '', ok, code })`, extension `(name, part, ok, code) => status.noted({ kind: 'extension', name, part, ok, code })`, memory `(ok, code) => status.noted({ kind: 'memory', name: '', part: '', ok, code })`. The review deps (each `reviewDepsAt` of plan B) gain `scorerHealth: { noted: (ok, code) => status.noted({ kind: 'scorer', name: '', part: '', ok, code }) }`.
2. **The app check:** once `lacks` has answered (and the service is not stopping), `status.appChecked(lacking)` before its log lines and alerts.
3. **The upkeep** gains, after `delete_finished`, `status.prune()`, not awaited (it is queued, so a queue backed up never holds the upkeep).
4. **The stop** waits for `status.settled()` beside `alertsSettled()`, within the same `ALERT_TIMEOUT_MS`, then calls `status.close()` before the database is closed.
5. **The review job:** after the memory notes of step 6, with `scorerHealth` given, the review's engine deps holding a `scorer`, and a result: the first `result.audit` entry with `stage` `scorer`, `action` `file_failed` or `file_not_asked` and a short code as `reason` is `noted(false, reason)`; else, with `result.usage.calls >= 1`, `noted(true, 'ok')`; else nothing. Inside `try/catch`; in dry run too.

- [ ] **Step 1: Write the failing tests.**

```ts
// src/service.test.ts
test('the alerts the service raises are stored, and the start writes the state of the app', async () => {
  /* the harness with the lacks fake answering [{ feature: 'gate', missing: 'checks:write' }]: after settled, alerts holds feature_off key 'gate:checks:write'
     and dependency_health the app failing 'missing' with that list; started again with lacks answering []: the feature_off cleared, the app ok */
});
test('a review notes the model, and the upkeep prunes the alerts past keeping', async () => {
  /* a review run through the service with a model call: dependency_health holds model ok; an alert row of 31 days ago, the upkeep run: deleted */
});
test('stop waits for the status writes, and nothing is written after the database closes', async () => {
  /* a db whose alerts insert is held: stop resolves only after it is released, within 5 s; an alert raised after stop (the judge's noteUsage): no statement after
     the close, as the harness's check of statements after the close reads */
});
// src/shell/review-job.test.ts
test('with a second scorer, the review job notes how it did from the audit, and without one notes nothing', async () => {
  /* engine with scorer, result.audit [{ stage: 'scorer', action: 'file_failed', subject: 'a.ts', reason: 'timeout' }]: noted(false, 'timeout');
     no scorer entry and usage.calls 2: noted(true, 'ok'); calls 0: no call; a reason 'Not A Code': noted(true, 'ok') when calls >= 1; no scorer in the engine: no call */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/service.test.ts src/shell/review-job.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the service stores its alerts and the state of each dependency where it learns it`.

---

### Task 5: Live score quality, one at a time and kept, and the repositories' answer

**Files:**
- Create: `src/ui/insight.ts`, `src/db/quality.ts`, `src/db/quality.test.ts`, `src/ui/quality.ts`, `src/ui/quality.test.ts`
- Modify: `src/ui/api-types.ts` (the types below, after the others)

**Interfaces:**

```ts
// src/ui/api-types.ts gains (types only):
export type WindowDays = 7 | 30 | 90;
export type QualityWindow = WindowDays | 'all';
export interface Measure { share: number | null; part: number; of: number }   // share: part of `of`, three decimals; null when `of` is 0
export interface ApprovalShort { enabled: boolean; threads: 'strict' | 'gate'; auditShare: number }
export interface QualityRow { threshold: number; current: boolean; safetyBlocks: Measure; safetyFiles: Measure; benefit: Measure; focus: Measure }
export interface SteppedBlock { path: string; number: number; score: number }
export interface Quality {
  repository: string; window: QualityWindow; threshold: number;
  closed: number;   // (as built, last fix) the pull requests closed in the window that were read, at most 300: what `No pull request closed` is said by
  pullRequests: number; unreadable: number; cut: { pulls: boolean; comments: boolean; runs: boolean };
  rows: QualityRow[]; stepped: SteppedBlock[];
  reverts: { merged: number; approved: number }; audits: { drawn: number; needed: number };
  feedback: { helpful: number; notHelpful: number; reasons: Array<{ reason: string; count: number }> };
}
export type QualityState = 'ready' | 'computing' | 'failed';
export interface QualityAnswer { now: string; state: QualityState; quality: Quality | null }   // quality only when ready
export interface Repositories { now: string; repositories: string[] }
// src/ui/insight.ts: what the reads of this plan's three screens are given (Task 8 wires it).
export interface StartedWith {
  dryRun: boolean; learning: boolean; scorer: boolean;
  extensions: ReadonlyArray<{ name: string; parts: ReadonlyArray<'context' | 'notify' | 'alert' | 'route'> }>;
  mcpServers: readonly string[];
}
export interface InsightDeps { db: Db; clock: () => Date; inForce: () => DeploymentConfig; started: StartedWith; quality: QualityCache }
/** The start of a window (Words used below): of `days` UTC days, today the last; `all` is the epoch. */
export function windowStart(now: Date, days: QualityWindow): string;
// src/db/quality.ts (RepoKey from src/db/memory-records.ts)
export async function closedPulls(db: Db, repo: RepoKey, since: string, limit: number): Promise<Array<{ number: number; author: string | null; closed_at: Date }>>;
export async function okRuns(db: Db, repo: RepoKey, numbers: readonly number[], limit: number): Promise<Array<{ id: number; number: number; head_sha: string; started_at: Date }>>;
/** Each run's stored scores; null for a run whose stored result is over `maxBytes` as stored. */
export async function runScores(db: Db, ids: readonly number[], maxBytes: number): Promise<Array<{ id: number; scores: unknown }>>;
export async function inlineCommentsOf(db: Db, repo: RepoKey, numbers: readonly number[], limit: number): Promise<Array<{
  id: string; number: number; author: string; path: string | null; side: string | null; line: number | null; start_line: number | null;
  file_level: boolean | null; commit: string | null; reply_to: string | null }>>;
export async function findingThreads(db: Db, repo: RepoKey, numbers: readonly number[]): Promise<Array<{ number: number; comment_id: string }>>;
export async function mergedReverts(db: Db, repo: RepoKey, limit: number): Promise<Array<{ number: number; reverts: number; merged_at: Date; approved: boolean }>>;
export async function auditedPulls(db: Db, repo: RepoKey, numbers: readonly number[]): Promise<number[]>;
export async function feedbackCounts(db: Db, repo: RepoKey, since: string): Promise<{ up: number; down: number }>;
export async function feedbackReasons(db: Db, repo: RepoKey, since: string, limit: number): Promise<Array<{ reason: string; count: number }>>;
// src/ui/quality.ts
export const QUALITY_PULLS = 300;
export const QUALITY_RUN_ROWS = 10000;
export const QUALITY_COMMENTS = 20000;
export const QUALITY_RUNS = 1000;
export const QUALITY_GROUP = 10;                      // runs whose scores one statement reads
export const QUALITY_GROUP_BYTES = 4 * 1024 * 1024;   // (as built) and about this much stored; one pull request's reads are held to it too
export const QUALITY_RESULT_BYTES = 2 * 1024 * 1024;  // a stored result above this, as stored, is not read
export const QUALITY_DEADLINE_MS = 60_000;
export const QUALITY_WAIT_MS = 10_000;
export const QUALITY_CACHE_MS = 300_000;
export const QUALITY_FAILED_MS = 60_000;
export const QUALITY_KEPT = 100;
export const STEPPED_SHOWN = 20;
export const REASONS_SHOWN = 5;
export type Measured = { state: 'ready'; quality: Quality } | { state: 'computing' } | { state: 'failed' };
export interface QualityCache {
  /** What is kept for the key: a result younger than QUALITY_CACHE_MS or a failure younger than QUALITY_FAILED_MS; else null. */
  kept(key: string): Measured | null;
  /** What is kept, else the key's computation: queued behind every other of the service (one runs at a time), not queued twice, waited for at most `waitMs`. */
  measure(key: string, compute: () => Promise<Quality>, waitMs: number): Promise<Measured>;
}
export function createQualityCache(deps: { clock: () => Date; log: (entry: Record<string, unknown>) => void }): QualityCache;
/** The repository lower-cased, the window and the threshold, joined by a line feed. */
export function qualityKey(repository: string, window: QualityWindow, threshold: number): string;
/** One repository's quality over a window at a threshold (rules 3 to 6); rejects `too_slow` past QUALITY_DEADLINE_MS. */
export interface QualityBounds { resultBytes: number; comments: number; runRows: number; runs: number; groupBytes: number }   // the constants above; a test gives lower ones (groupBytes as built)
// (as built) the plan of one pull request (rule 3), on its own; and, in src/eval/live/labels.ts, the one rule of the comments liveCases counts:
export function planOf(pull: { number: number; author: string | null; closed_at: Date }, runs: readonly PlanRun[], comments: readonly LiveComment[], findings: ReadonlySet<string>, resultBytes?: number): Planned;
export function countedComments(pull: Pick<LivePull, 'author' | 'comments' | 'findingThreads'>): Array<LiveComment & { path: string }>;
// (as built) src/db/quality.ts: export async function repositoryKnown(db: Db, repo: RepoKey): Promise<boolean>;
export function computeQuality(deps: InsightDeps, repository: string, window: QualityWindow, threshold: number, bounds?: Partial<QualityBounds>): Promise<Quality>;
/** Through the cache, at the repository's threshold in force. */
export function qualityOf(deps: InsightDeps, repository: string, window: QualityWindow, waitMs: number): Promise<Measured>;
export function quality(deps: InsightDeps, repository: string, query: URLSearchParams): Promise<QualityAnswer | 'bad_request'>;
export function repositories(deps: InsightDeps): Promise<Repositories>;
export function approvalShort(deps: InsightDeps, repository: string): ApprovalShort;   // approvalOf(repoSettingsFor(inForce(), repository))
```

**Rules (main 6.6; 3.3 items 6 and 8, 3.4; calls 23 to 29):**

1. **The statements**, exactly; `$1` to `$3` the repository's service, owner and repo; a list of numbers or ids as JSON:

```sql
-- closedPulls ($4: the window's start, $5: QUALITY_PULLS + 1)
select number, author, coalesce(merged_at, closed_at) as closed_at from visto_ai.pull_requests
where service = $1 and owner = $2 and repo = $3 and state in ('merged', 'closed') and coalesce(merged_at, closed_at) >= $4::timestamptz
order by coalesce(merged_at, closed_at) desc, number desc
limit $5;
-- okRuns ($4: the numbers, $5: QUALITY_RUN_ROWS + 1): no result is read, only its size as stored (as built)
select id, number, head_sha, started_at, pg_column_size(result) as size from visto_ai.review_runs
where service = $1 and owner = $2 and repo = $3 and number in (select (jsonb_array_elements_text($4::jsonb))::int) and outcome = 'ok'
order by number desc, id desc
limit $5;
-- runScores ($1: at most QUALITY_GROUP ids, $2: QUALITY_RESULT_BYTES)
select id, case when pg_column_size(result) <= $2 then result -> 'scores' end as scores
from visto_ai.review_runs where id in (select (jsonb_array_elements_text($1::jsonb))::int);
-- inlineCommentsOf ($4: the numbers, $5: QUALITY_COMMENTS + 1)
select source_id as id, number, author, path, side, line, start_line, file_level, commit, reply_to from visto_ai.human_activity
where service = $1 and owner = $2 and repo = $3 and number in (select (jsonb_array_elements_text($4::jsonb))::int) and kind = 'inline_comment'
order by number desc, at, id
limit $5;
-- findingThreads ($4: the numbers)
select number, comment_id from visto_ai.review_comments
where service = $1 and owner = $2 and repo = $3 and number in (select (jsonb_array_elements_text($4::jsonb))::int)
  and severity in ('blocker', 'major', 'minor');
-- mergedReverts ($4: 1000)
select p.number, p.reverts, p.merged_at,
       exists (select 1 from visto_ai.review_runs r
               where r.service = p.service and r.owner = p.owner and r.repo = p.repo and r.number = p.reverts
                 and r.approved and r.published and not r.dry_run and r.dismissed_at is null) as approved
from visto_ai.pull_requests p
where p.service = $1 and p.owner = $2 and p.repo = $3 and p.state = 'merged' and p.reverts is not null
order by p.merged_at desc
limit $4;
-- auditedPulls ($4: the numbers)
select distinct number from visto_ai.review_runs
where service = $1 and owner = $2 and repo = $3 and number in (select (jsonb_array_elements_text($4::jsonb))::int)
  and published and approval_code = 'audit_sample';
-- feedbackCounts ($4: the window's start)
select (count(*) filter (where vote = 'up'))::int as up, (count(*) filter (where vote = 'down'))::int as down
from visto_ai.review_feedback where service = $1 and owner = $2 and repo = $3 and at >= $4::timestamptz;
-- feedbackReasons ($5: REASONS_SHOWN)
select (array_agg(left(btrim(reason), 200) order by at desc, id desc))[1] as reason, count(*)::int as count
from visto_ai.review_feedback
where service = $1 and owner = $2 and repo = $3 and at >= $4::timestamptz and vote = 'down' and reason is not null and btrim(reason) <> ''
group by lower(btrim(reason))
order by count desc, lower(btrim(reason))
limit $5;
```

2. **The cache, one at a time (call 26).** `measure` answers what `kept` gives; else it joins the key's computation when one is queued or under way, or puts one at the end of the service's one queue (a computation starts only when the one before it settled); it waits at most `waitMs`: resolved, `ready` (kept `QUALITY_CACHE_MS`); rejected, `failed` (kept `QUALITY_FAILED_MS`, logged `{ event: 'quality_failed', reason: codeOf(error) }`); the wait over first, `computing`, and the computation goes on and is kept when it settles. At most `QUALITY_KEPT` kept, the oldest put dropped first. `qualityOf` reads the threshold in force and asks `measure(qualityKey(...), () => computeQuality(...), waitMs)`.
3. **What `computeQuality` reads.** Before each statement, past `QUALITY_DEADLINE_MS` since it began, it rejects `too_slow`. `closedPulls`: `cut.pulls` when a 301st came back; the 300. With none, it reads only `mergedReverts` and the feedback. Else `inlineCommentsOf` (`cut.comments` when a 20,001st came back; 20,000 kept), `okRuns` (`cut.runs` when a 10,001st came back), `findingThreads`, of their numbers. For each pull, from `okRuns`' rows started at or before its close: its last run, the highest id; for each head a comment of it names, that head's highest id. Its runs to read: its last run, then its commented heads' runs newest first, other than the last run, at most `QUALITY_GROUP` in all. **(As built)** the heads are those of the comments `liveCases` counts (`countedComments`), and this plan is `planOf`.
4. **Groups.** The pulls, in `closedPulls`' order, are taken into groups whose runs to read add up to at most `QUALITY_GROUP` (**as built:** and whose sizes as stored add up to at most `QUALITY_GROUP_BYTES`, which `planOf` holds each pull request to, as the last fix leaves it; `liveCases` is called once for each pull request of the group, so no number is read back from a case's key); once `QUALITY_RUNS` runs have been read, the pulls left are not measured and `cut.runs` is set. For each group: one `runScores`, each run's scores through `storedScores` (a run whose scores are null or of another shape is unread); a pull whose last run is unread counts in `unreadable` and is given `last` null; the comments read field by field (`side` `LEFT` or `RIGHT` else null, `file_level` true or not); `liveCases` of the group at the threshold `t`; for each threshold of the rows, `addCounts` of `countAt(pulls, x)` and of `countAt(labelled, x)` into the window's two counts; the group's stepped blocks (rule 5) added and the list cut to `STEPPED_SHOWN`; its `strict` numbers kept. Then the group's score lists are dropped before the next group is read.
5. **The rows:** for each of `THRESHOLDS` and `t` (once, ascending): `safetyBlocks` `{ part: blocksLeft, of: blocks }` and `safetyFiles` `{ part: filesLeft, of: files }` of the labelled counts, `benefit` `{ part: prsClear, of: prs }` and `focus` `{ part: flaggedLines, of: totalLines }` of the pulls' counts, each `share` by `share()`; `current` for `t`. `pullRequests` the pulls measured (a last run read). **`stepped`:** each block of a labelled case whose label is strict and `blockFlagged(file, block, t)` false, as `{ path, number, score: block.entry?.score ?? file.fileLevel?.score ?? 0 }`, by number from the highest then path.
6. **`reverts`:** `mergedReverts(1000)`: `merged` those with `merged_at` in the window, `approved` of those the ones `approved`. **`audits`:** `auditedPulls` of the 300: `drawn` their count; `needed` those in a group's `strict`, or whose number is the `reverts` of any row of `mergedReverts`. **`feedback`:** `feedbackCounts` and `feedbackReasons`.
7. **`quality`:** the repository lower-cased must match `^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$`; `days` empty or absent is 30, else exactly `7`, `30`, `90` or `all`; else `'bad_request'`. Then `qualityOf(..., QUALITY_WAIT_MS)`: `{ now, state, quality }`, `quality` only when `ready`. **(As built)** what is kept is answered first; else a repository with no pull request stored (`repositoryKnown`, one indexed probe, where `knownRepositories` would read every name and stop at 200) is answered `ready` with no pull requests, neither queued nor kept. A computation that failed is never a 500: it is `failed`.
8. **`repositories`:** `knownRepositories(db, 200)`.

**The answers, exactly in shape (values invented):**

```json
{ "now": "2026-03-01T10:00:00.000Z", "state": "ready", "quality": {
  "repository": "acme/shop", "window": 30, "threshold": 70, "pullRequests": 127, "unreadable": 0, "cut": { "pulls": false, "comments": false, "runs": false },
  "rows": [ { "threshold": 20, "current": false, "safetyBlocks": { "share": 0, "part": 0, "of": 74 }, "safetyFiles": { "share": 0, "part": 0, "of": 71 },
      "benefit": { "share": 0.063, "part": 8, "of": 127 }, "focus": { "share": 0.61, "part": 5741, "of": 9412 } },
    { "threshold": 70, "current": true, "safetyBlocks": { "share": 0.041, "part": 3, "of": 74 }, "safetyFiles": { "share": 0.07, "part": 5, "of": 71 },
      "benefit": { "share": 0.409, "part": 52, "of": 127 }, "focus": { "share": 0.18, "part": 1694, "of": 9412 } } ],
  "stepped": [ { "path": "src/cart/discount.ts", "number": 119, "score": 55 } ],
  "reverts": { "merged": 2, "approved": 0 }, "audits": { "drawn": 6, "needed": 1 },
  "feedback": { "helpful": 31, "notHelpful": 5, "reasons": [ { "reason": "Repeats a settled thread", "count": 3 } ] } } }
```

```json
{ "now": "2026-03-01T10:00:00.000Z", "state": "computing", "quality": null }
```

```json
{ "now": "2026-03-01T10:00:00.000Z", "repositories": ["acme/shop", "acme/web"] }
```

- [ ] **Step 1: Write the failing tests.** PGlite; pull requests with `savePullRequest`, runs with `recordRun` (a `result` holding `scores` in the engine's shape), comments with `recordActivity`, the app's comments with `recordComments`, feedback with `recordFeedback`; a clock the test moves; a spy on the statements.

```ts
// src/db/quality.test.ts
test('the closed pull requests of a window are read newest first, and an open one or one closed before is not', async () => { /* merged, closed, open, closed before: two */ });
test('the runs that did not fail are read as ids, nothing-new ones included, and no result is read', async () => {
  /* two ok runs at head A (one nothing-new), a failed one at B: two rows, newest first; the statement's text holds no 'result' */
});
test('scores are read for the ids given, and a stored result over the size is read as null', async () => { /* maxBytes 10: null; maxBytes 2 MB: the list */ });
test('the comments, newest pull requests first, the finding threads, the merged reverts, the audits and the feedback of a repository are read as stored', async () => {
  /* one of each, another repository's ignored; comments of #120 before those of #119; mergedReverts' approved true for an approval never withdrawn, false once
     dismissed_at is set; reasons ' Repeats a settled thread', 'repeats a settled thread' and 'Too long': [{ reason: <the newest wording>, count: 2 }, { 'Too long', 1 }] */
});
// src/ui/quality.test.ts
test("a repository's quality is measured on the pull requests closed in the window, from their stored runs and people's comments", async () => {
  /* #119 merged: run 1 at head A scores src/cart/discount.ts B1 55, run 2 at head B (last) changes B1's hunkHash; octo-guest comments at head A on B1; #120 merged,
     nothing reached 70: the row at 70 has safetyBlocks { part: 1, of: 1 }, benefit { part: 1, of: 2 }; stepped [{ path: 'src/cart/discount.ts', number: 119, score: 55 }] */
});
test("a comment on a head whose only run found nothing new is placed on that run, and the last run is the newest that did not fail", async () => {
  /* #121: run 1 (head A, scores), run 2 (head B, nothing new, its head's scores), a comment at head B on a block: labelled on run 2; the last run is run 2 */
});
test("the repository's threshold in force is a row of its own, marked, and one of the four is marked when it is that", async () => {
  /* threshold 65 in force: rows 20, 40, 65 (current), 70, 90; threshold 70: four rows, 70 current */
});
test('scores are read ten runs to a statement, pull request by pull request, and the counts add up across groups', async () => {
  /* 25 pull requests of one run each: three runScores statements of 10, 10 and 5 ids; the rows equal those of one countAt over all (computed in the test) */
});
test('one computation runs at a time in the service, the same key is not queued twice, and a result is kept five minutes', async () => {
  /* two keys asked at once: the second's first statement comes after the first's last; the same key twice: one closedPulls; again at +299 s: none; at +300 s: one;
     a threshold changed in force: another key */
});
test('a request waits ten seconds at most, then is answered computing, and the computation is kept when it ends', async () => {
  /* a held closedPulls: quality answers { state: 'computing', quality: null } after 10 s by the clock and timers; released: the next read is ready with no statement */
});
test('a failure is kept for a minute, answered failed, and logged with its code', async () => {
  /* closedPulls rejects 'db_down': { state: 'failed' }, one { event: 'quality_failed', reason: 'db_down' }; again at +59 s: failed, no statement; at +60 s: computed again */
});
test('a computation past sixty seconds stops as too slow', async () => { /* the clock moved 61 s during okRuns: failed, reason 'too_slow' */ });
test('reverts and audits are counted, an audit needing a person when it was labelled strictly or reverted', async () => {
  /* #130 reverts #128 (approved, never withdrawn), merged in the window: reverts { merged: 1, approved: 1 }; audited #128 (reverted) and #129 (nothing): audits { drawn: 2, needed: 1 } */
});
test('a run whose scores cannot be read, or whose stored result is too large, leaves its pull request out, counted', async () => {
  /* a last run whose scores are 'x': unreadable 1, pullRequests 0; bounds { resultBytes: 10 }: unreadable */
});
test('pull requests, comments and runs past their bounds are cut, and said so', async () => {
  /* 301 closed: cut.pulls, pullRequests at most 300; bounds { comments: 2 } and { runs: 1 }: cut.comments, cut.runs */
});
test('the window and the repository must be of their shape', async () => {
  /* days '', '30', '7', '90', 'all': read; '0', '365', 'ALL': 'bad_request'; repository 'acme', 'acme/shop/x': 'bad_request'; 'Acme/Shop': read as acme/shop */
});
test('the repositories are those seen, by name', async () => { /* two pull requests of acme/shop and acme/web: ['acme/shop', 'acme/web'] */ });
test('an answer holds no field the screens do not show', async () => {
  /* keys of QualityAnswer, Quality, QualityRow, SteppedBlock, Repositories exactly those of api-types.ts; a comment body 'COMMENT-TEXT', a reason in a block
     'REASON-TEXT', a quote 'QUOTE-TEXT', an author login 'octo-guest' of a comment: no answer's JSON holds any of them */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/db/quality.test.ts src/ui/quality.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: live score quality of a repository from stored runs and comments, read in bounded groups, one computation at a time, kept five minutes`.

---

### Task 6: The Overview's and health's answers

**Files:**
- Create: `src/db/overview.ts`, `src/db/overview.test.ts`, `src/ui/overview.ts`, `src/ui/overview.test.ts`
- Modify: `src/ui/api-types.ts` (the types below, after the others)

**Interfaces:**

```ts
// src/ui/api-types.ts gains (types only; Measure, ApprovalShort, WindowDays and QualityState are Task 5's):
export interface OverviewQuality {
  repository: string; threshold: number; state: QualityState;   // the numbers and reverts only when ready
  safety: Measure | null; benefit: Measure | null; focus: Measure | null; reverts: { merged: number; approved: number } | null;
  approval: ApprovalShort;
}
export interface Overview {
  now: string; days: WindowDays; repositories: number;
  reviews: { total: number; published: number; dryRun: number; failed: number; nothingNew: number; notPosted: number };
  spend: { today: number; limit: number };
  approvals: { approved: number; audited: number };
  perDay: Array<{ day: string; published: number; failed: number; other: number; cost: number }>;   // oldest first; day 'YYYY-MM-DD', UTC
  quality: OverviewQuality[]; qualityCut: number;
}
export type DependencyKind = 'model' | 'scorer' | 'memory' | 'extension' | 'mcp' | 'app';
export type DependencyStatus = 'working' | 'failing' | 'unknown';
export interface DependencyPart { part: 'context' | 'notify' | 'alert' | 'route'; status: DependencyStatus; code: string | null; since: string | null }
export interface DependencyShown {
  kind: DependencyKind; name: string | null; model: string | null; status: DependencyStatus; code: string | null;
  since: string | null; seenAt: string | null; parts: DependencyPart[]; missing: Array<{ feature: string; missing: string }>;
}
export interface AlertShown { id: number; code: string; details: Record<string, string | number | boolean>; raisedAt: string; open: boolean }
export interface Health { now: string; dependencies: DependencyShown[]; open: AlertShown[]; recent: AlertShown[] }
// src/db/overview.ts
export interface ReviewTotals { total: number; published: number; dry_run: number; failed: number; nothing_new: number; not_posted: number; repositories: number }
export async function reviewTotals(db: Db, since: string): Promise<ReviewTotals>;
export async function reviewsPerDay(db: Db, since: string): Promise<Array<{ day: string; published: number; failed: number; other: number; cost: number }>>;
export async function judgeCostPerDay(db: Db, since: string): Promise<Array<{ day: string; cost: number }>>;
export async function approvalCounts(db: Db, since: string): Promise<{ approved: number; audited: number }>;
export async function reviewedRepositories(db: Db, since: string, limit: number): Promise<string[]>;
// src/ui/overview.ts
export const QUALITY_ON_OVERVIEW = 20;
export const COLD_PER_OVERVIEW = 2;   // repositories not kept that one Overview request measures
export const OPEN_SHOWN = 50;
export const RECENT_SHOWN = 5;        // as many as the Overview shows
// InsightDeps and windowStart are Task 5's (src/ui/insight.ts).
export function overview(deps: InsightDeps, query: URLSearchParams): Promise<Overview | 'bad_request'>;
export function health(deps: InsightDeps): Promise<Health>;
```

**Rules (design 1 item 1, 3.3 items 3 to 5, 3.4; calls 8, 12, 14 to 18, 22):**

1. **The statements**, exactly; `$1` the window's start:

```sql
-- reviewTotals
select count(*)::int as total,
       (count(*) filter (where outcome = 'ok' and published))::int as published,
       (count(*) filter (where outcome = 'ok' and dry_run))::int as dry_run,
       (count(*) filter (where outcome = 'failed'))::int as failed,
       (count(*) filter (where outcome = 'ok' and not dry_run and not published and result -> 'nothingToDo' = 'true'::jsonb))::int as nothing_new,
       (count(*) filter (where outcome = 'ok' and not dry_run and not published
                          and (result -> 'nothingToDo') is distinct from 'true'::jsonb))::int as not_posted,
       (count(distinct owner || '/' || repo))::int as repositories
from visto_ai.review_runs where started_at >= $1::timestamptz;
-- reviewsPerDay
select to_char(started_at at time zone 'UTC', 'YYYY-MM-DD') as day,
       (count(*) filter (where outcome = 'ok' and published))::int as published,
       (count(*) filter (where outcome = 'failed'))::int as failed,
       (count(*) filter (where outcome = 'ok' and not published))::int as other,
       coalesce(sum(cost), 0)::float8 as cost
from visto_ai.review_runs where started_at >= $1::timestamptz group by 1 order by 1;
-- judgeCostPerDay
select to_char(at at time zone 'UTC', 'YYYY-MM-DD') as day, coalesce(sum(cost), 0)::float8 as cost
from visto_ai.judge_calls where at >= $1::timestamptz group by 1 order by 1;
-- approvalCounts: each pull request once, by its newest published live run of the window that carried a decision (call 17)
select (count(*) filter (where approved))::int as approved, (count(*) filter (where approval_code = 'audit_sample'))::int as audited
from (select distinct on (owner, repo, number) approved, approval_code from visto_ai.review_runs
      where started_at >= $1::timestamptz and published and not dry_run and (approved or approval_code is not null)
      order by owner, repo, number, id desc) d;
-- reviewedRepositories ($2: QUALITY_ON_OVERVIEW): the busiest, then by name
select owner || '/' || repo as name from visto_ai.review_runs where started_at >= $1::timestamptz
group by owner, repo order by count(*) desc, name limit $2;
```

2. **`overview`:** `days` written empty or absent is 30; else exactly `7`, `30` or `90`, else `'bad_request'`. `repositories` the totals' count; `reviews` the totals; `spend` `{ today: spentSince(<the UTC day's start>), limit: inForce().limits.spendPerDay }`; `approvals` `approvalCounts`; `perDay` one entry for each UTC day of the window, oldest first, today last, zeros where no row, `cost` the runs' and the judge's added; `quality`: `reviewedRepositories(QUALITY_ON_OVERVIEW)`, shown by name; for each, what `deps.quality.kept(qualityKey(name, days, <its threshold>))` gives, else, for the first `COLD_PER_OVERVIEW` not kept, `qualityOf(deps, name, days, QUALITY_WAIT_MS)` one after the other, else `computing`; each row `{ repository, threshold, state, approval: approvalShort(deps, name) }` with, when `ready`, `safety` the current row's `safetyBlocks`, `benefit`, `focus` and `reverts`, else those four null. A repository whose computation failed is a row `failed`: the Overview never answers 500 for it. `qualityCut` the totals' `repositories` less 20, at least 0.
3. **`health`:** `readHealth`, then the list of call 14, in this order: the model (`model` `inForce().model.model`); the scorer when `started.scorer` (`model` `inForce().scorer?.model ?? null`); memory when `started.learning`; each extension of `started.extensions` by name, its `parts` each of the module's parts with its row's state (`alert` always `unknown`), its own state `failing` when a part's is, else `working` when a part's is, else `unknown`, `code` and `since` the first failing part's; each MCP server of `started.mcpServers` by name; the app, with `missing` its row's list read field by field (strings, at most 50). A row's `ok` is `working`, `failing` is `failing`, none is `unknown` with null times. `open` `openAlerts(<day start>, OPEN_SHOWN)`; `recent` `recentAlerts(<now - RECENT_MS>, <the open ids>, RECENT_SHOWN)` (**as built, last fix:** `recentAlerts(<now - RECENT_MS>, <day start>, RECENT_SHOWN)`, the open rule's, so an open alert past the 50 shown is not recent); each alert `{ id, code, details: <call 6's allowlist again>, raisedAt, open }` (**as built, last fix:** the status store's own `keptDetails`, one list; an alert whose time no ISO time writes is passed over).
4. Every answer carries `now`, the clock's ISO.

**The answers, exactly in shape (values invented):**

```json
{ "now": "2026-03-01T10:00:00.000Z", "days": 30, "repositories": 2,
  "reviews": { "total": 412, "published": 398, "dryRun": 9, "failed": 5, "nothingNew": 0, "notPosted": 0 },
  "spend": { "today": 12.4, "limit": 50 }, "approvals": { "approved": 38, "audited": 6 },
  "perDay": [ { "day": "2026-01-31", "published": 12, "failed": 0, "other": 0, "cost": 3.1 } ],
  "quality": [ { "repository": "acme/shop", "threshold": 70, "state": "ready", "safety": { "share": 0.041, "part": 3, "of": 74 },
    "benefit": { "share": 0.409, "part": 52, "of": 127 }, "focus": { "share": 0.18, "part": 1694, "of": 9412 },
    "reverts": { "merged": 2, "approved": 0 }, "approval": { "enabled": true, "threads": "strict", "auditShare": 5 } },
    { "repository": "acme/web", "threshold": 70, "state": "computing", "safety": null, "benefit": null, "focus": null, "reverts": null,
      "approval": { "enabled": false, "threads": "strict", "auditShare": 5 } } ],
  "qualityCut": 0 }
```

```json
{ "now": "2026-03-01T10:00:00.000Z",
  "dependencies": [
    { "kind": "model", "name": null, "model": "vendor/model-a", "status": "working", "code": null, "since": "2026-03-01T08:00:00.000Z",
      "seenAt": "2026-03-01T09:58:00.000Z", "parts": [], "missing": [] },
    { "kind": "mcp", "name": "docs", "model": null, "status": "failing", "code": "mcp_timeout", "since": "2026-03-01T09:42:00.000Z",
      "seenAt": "2026-03-01T09:55:00.000Z", "parts": [], "missing": [] },
    { "kind": "app", "name": null, "model": null, "status": "failing", "code": "missing", "since": "2026-03-01T08:00:00.000Z",
      "seenAt": "2026-03-01T08:00:00.000Z", "parts": [], "missing": [ { "feature": "capture", "missing": "event:pull_request_review" } ] } ],
  "open": [ { "id": 31, "code": "mcp_error", "details": { "server": "docs", "reason": "mcp_timeout" }, "raisedAt": "2026-03-01T09:42:00.000Z", "open": true } ],
  "recent": [ { "id": 27, "code": "spend_80", "details": { "spent": 40.2, "limit": 50 }, "raisedAt": "2026-02-28T17:05:00.000Z", "open": false } ] }
```

- [ ] **Step 1: Write the failing tests.** PGlite; runs written with `recordRun` and `markPublished`; judge calls with `recordJudgeCall`; `InsightDeps` with `inForce` a parsed config the test changes and a real `createQualityCache` (Task 5).

```ts
// src/db/overview.test.ts
test('the reviews of a window are counted so they add up', async () => {
  /* a live published run, a dry run, a failed run, a live unpublished nothing-new run, a live unpublished run, one before the window: total 5, each 1, repositories 1 */
});
test('reviews and spend are read per UTC day, the judge calls counted with the runs', async () => {
  /* runs at 23:59 and 00:01 UTC: two days; costs 1.5 and 2; a judge call of 0.5 on the second day: reviewsPerDay costs 1.5 and 2, judgeCostPerDay 0.5 */
});
test('approvals and audits are counted by pull request, once each by its newest decision, and a dry run never counts', async () => {
  /* #7 approved twice, #8 audit_sample, #9 a dry run, #10 approved then audit_sample (the share raised meanwhile): { approved: 1, audited: 2 } */
});
test('the repositories of the overview are the busiest of the window', async () => { /* 21 repositories, acme/zz with the most runs: in the 20 */ });
// src/ui/overview.test.ts
test('the overview holds the window\'s reviews, spend against the limit in force, approvals and each day', async () => {
  /* inForce spendPerDay 40, spent 12.4 today: spend { today: 12.4, limit: 40 }; days 7: perDay has 7 entries, the last today, zeros where none */
});
test('the window must be 7, 30 or 90 days, and an empty one is 30', async () => {
  /* days '' and absent: 30; '7', '90': as given; '0', '31', 'all', 'abc', '07': 'bad_request' */
});
test('the score quality of each reviewed repository, at most 20, at its threshold and approval in force, at most 2 measured a request', async () => {
  /* 21 repositories reviewed, nothing kept: 20 rows by name, qualityCut 1, two ready and 18 computing with null numbers; read again: four ready; acme/shop's
     threshold 60 in force: its row's threshold 60; approval of acme/web on gate 10: { enabled: true, threads: 'gate', auditShare: 10 }; a repository with none:
     { enabled: false, threads: 'strict', auditShare: 5 } */
});
test('a repository whose computation fails is a row failed, and the rest of the overview is answered', async () => {
  /* the first repository's closedPulls rejects 'db_down': the overview resolves, its row { state: 'failed', safety: null, ... }, the reviews, spend, approvals and
     days as without the failure */
});
test('health lists the dependencies the service started with, each with its stored state or none', async () => {
  /* started { learning: true, scorer: true, extensions: [example with context and notify], mcpServers: [docs] }; rows model ok, mcp docs failing, extension
     example notify failing: [model working, scorer unknown, memory unknown, extension example failing (parts context unknown, notify failing), mcp docs failing,
     app unknown]; a row of an MCP server 'old' not started with: not listed; learning off: no memory entry */
});
test('the open and recent alerts carry only the allowlisted details', async () => {
  /* a stored row whose details hold 'login': 'octo-guest' (written by hand): the answer's details lack it; open ones are not in recent */
});
test('an answer holds no field the screens do not show', async () => {
  /* the keys of Overview, OverviewQuality, Measure, ApprovalShort, Health, DependencyShown, DependencyPart, AlertShown are exactly those of api-types.ts, held by
     Record<keyof ..., true> constants; with inForce holding model.apiKey 'model-key-for-tests-only': no answer's JSON holds it */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/db/overview.test.ts src/ui/overview.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the answers of the overview and of dependency health and alerts`.

---

### Task 7: Memory: the reads, the switch and their answers

**Files:**
- Modify: `src/db/memory-records.ts` (the functions below), `src/ui/api-types.ts` (the types below, after the others)
- Create: `src/ui/memory.ts`, `src/ui/memory.test.ts`
- Test: `src/db/memory-records.test.ts` (new tests only)

**Interfaces:**

```ts
// src/ui/api-types.ts gains:
export type MemoryKind = 'human_signal' | 'revert' | 'lesson';
export interface MemoryRecordShown {
  id: number; kind: MemoryKind; repository: string; number: number; text: string; path: string | null; directory: string | null;
  by: string | null; reverted: number | null; createdAt: string | null; expiresAt: string | null; on: boolean;   // as built, last fix: null for a time no ISO time writes (isoOf)
}
export interface MemoryView {
  now: string; learning: { on: boolean; ranAt: string | null };
  counts: { signals: number; signalRepositories: number; reverts: number; lessons: number; off: number };
  total: number; records: MemoryRecordShown[]; next: number | null;
}
export interface MemorySwitched { record: MemoryRecordShown }
// src/db/memory-records.ts gains:
export interface ShownRow {
  id: number; owner: string; repo: string; kind: RecordKind; number: number; path: string | null; directory: string | null;
  excerpt: string; lesson: string | null; reverted: number | null; status: 'active' | 'disabled'; created_at: Date; expires_at: Date; by: string | null;
}
export interface MemoryFilter { repo: RepoKey | null; kind: RecordKind | null; text: string | null; before: number | null }   // text: the ilike pattern, escaped
export async function shownRecords(db: Db, f: MemoryFilter, now: string, limit: number): Promise<ShownRow[]>;
export async function countShown(db: Db, f: MemoryFilter, now: string): Promise<number>;                 // `before` not read
export async function shownRecord(db: Db, id: number, now: string): Promise<ShownRow | null>;
export async function memoryCounts(db: Db, now: string): Promise<{ signals: number; signal_repositories: number; reverts: number; lessons: number; off: number }>;
/** On: disabled to active; off: active to disabled; only a record not expired; true when it changed. */
export async function switchRecord(db: Db, id: number, on: boolean, by: string, now: string): Promise<boolean>;
// src/ui/memory.ts
export const MEMORY_PAGE = 50;
export const TEXT_CHARS = 1000;
export function memory(deps: InsightDeps, query: URLSearchParams): Promise<MemoryView | 'bad_request'>;
export function switchOf(body: Record<string, unknown>): { on: boolean } | null;
/** The record after the switch; null when it is not there or expired. */
export function switchMemory(deps: InsightDeps & { log: (entry: Record<string, unknown>) => void }, id: number, on: boolean, by: string): Promise<MemoryRecordShown | null>;
```

**Rules (3.3 item 7; main 7; calls 30 to 33, 35):**

1. **The statements**, exactly; the select list and joins are shared by the three reads of records (in the source the escape character is written `'\\'` inside the template literal):

```sql
-- the shared part
select r.id, r.owner, r.repo, r.kind, r.number, r.path, r.directory, r.excerpt, r.lesson, r.reverted, r.status, r.created_at, r.expires_at,
       a.author as by
from visto_ai.memory_records r
left join visto_ai.human_activity a
  on r.kind = 'human_signal' and a.service = r.service and a.kind = 'inline_comment' and a.source_id = r.comment
where r.status in ('active', 'disabled') and r.expires_at > $1::timestamptz
-- shownRecords adds ($6: before or null, $7: the limit, 51)
  and ($2::text is null or (r.owner = $2 and r.repo = $3)) and ($4::text is null or r.kind = $4)
  and ($5::text is null or r.path ilike $5 escape '\' or r.directory ilike $5 escape '\' or (r.kind = 'human_signal' and r.excerpt ilike $5 escape '\') or r.lesson ilike $5 escape '\')   -- (as built, last fix) a lesson's quote is not searched
  and ($6::integer is null or r.id < $6::integer)
order by r.id desc limit $7
-- countShown: count(*)::int of the shared part's rows with the same filters, $6 and $7 left out
-- shownRecord adds
  and r.id = $2
-- memoryCounts
select (count(*) filter (where kind = 'human_signal' and status = 'active'))::int as signals,
       (count(distinct owner || '/' || repo) filter (where kind = 'human_signal' and status = 'active'))::int as signal_repositories,
       (count(*) filter (where kind = 'revert' and status = 'active'))::int as reverts,
       (count(*) filter (where kind = 'lesson' and status = 'active'))::int as lessons,
       (count(*) filter (where status = 'disabled'))::int as off
from visto_ai.memory_records where status in ('active', 'disabled') and expires_at > $1::timestamptz;
-- switchRecord ($4: the account's name through storable())
update visto_ai.memory_records
set status = case when $2::boolean then 'active' else 'disabled' end, switched_at = $3::timestamptz, switched_by = $4
where id = $1 and status in ('active', 'disabled') and expires_at > $3::timestamptz
  and status <> case when $2::boolean then 'active' else 'disabled' end
returning id;
```

2. **`memory`:** a parameter written empty reads as absent. `kind` one of the three kinds; `repo` lower-cased matching `^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$`; `q` trimmed, at most 100 characters, none after the trim reads as absent, no U+0000, as the pattern `'%' + q.replaceAll(/[\\%_]/g, (c) => '\\' + c) + '%'`; `before` `^\d{1,10}$` up to 2147483647. Anything else is `'bad_request'` before any statement. 51 rows read; `next` the 50th's id when a 51st came. `learning` `{ on: started.learning, ranAt: readLearning(db, 'signals')?.ranAt ?? null }`; `counts` from `memoryCounts`; `total` `countShown`.
3. **Each record:** `repository` `owner/repo`; `text` the excerpt for `human_signal`, the lesson for `lesson`, `''` for `revert` (the page writes the sentence), each `clip`ped (plan A's `clip`) to `TEXT_CHARS`; `by` the stored author for `human_signal` only; `reverted` for `revert` only; `on` `status === 'active'`; times as ISO.
4. **`switchOf`:** exactly the key `on`, a boolean; else null. **`switchMemory`:** `switchRecord(id, on, by, now)`, then `shownRecord(id, now)`: null is null (not there, or expired); a change logs `{ event: 'memory_switch', record: id, on }`, a switch to the state it is in logs nothing and answers the record as it is.

- [ ] **Step 1: Write the failing tests.** PGlite; records with `addRecords`; activity with `recordActivity`.

```ts
// src/db/memory-records.test.ts
test('a record switched off is read by no later review, and switched on again is read by the next', async () => {
  /* a human_signal, a revert and a lesson of acme/shop: switchRecord off each: liveRecords, liveReverts and liveLessons answer none of them; switched_by 'octo-admin',
     switched_at as given; standingLessons still holds the lesson; addRecords of the same source_ref again: still disabled; switched on: each read again */
});
test('an expired record cannot be switched, and a switch to the state it is in changes nothing', async () => {
  /* expires_at passed: false, unchanged; status 'expired': false; on while on: false, switched_at unchanged */
});
test('the records shown are those on or off not expired, newest recorded first, filtered and paged, with the commenter of a person\'s record', async () => {
  /* five records, one expired: four, by id desc; the human_signal's by is the inline comment's author 'octo-guest'; kind lesson: one; repo acme/web: its own;
     a pattern of 'cart': path and (human_signal) excerpt matches; before the second id: the rest; countShown ignores before */
});
test('the counts are the records on by kind, the repositories of people stepping in, and the records off', async () => { /* ... */ });
// src/ui/memory.test.ts
test('the memory answer holds learning, the counts and a page of records with their words and places', async () => {
  /* started.learning true, the signals row ran at at(-180): { on: true, ranAt: at(-180) }; 51 records: 50 and next; a revert's text '' and reverted 68; a lesson's text its lesson */
});
test('the search takes percent, underscore and backslash as themselves, an empty parameter is absent, and a malformed one is bad_request', async () => {
  /* excerpts '100% done', 'a_b', 'c\\d': '%' finds only the first ... ; 'kind=&repo=&q=&before=' as none; kind 'person', repo 'acme', before 'x', q of 101: 'bad_request' */
});
test('a switch answers the record as it is after, and logs a change only', async () => {
  /* off: on false, one { event: 'memory_switch', record, on: false }; off again: on false, no line; an expired one: null */
});
test('the body of a switch is exactly on, a boolean', () => {
  /* { on: true } and { on: false }: as given; {}, { on: 'true' }, { on: true, id: 1 }: null */
});
test('an answer holds no field the screens do not show', async () => {
  /* keys of MemoryView, MemoryRecordShown exactly those of api-types.ts; a record's source_ref, comment id, category and reason, missed: in no answer's JSON */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/db/memory-records.test.ts src/ui/memory.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: memory records listed with their words and places, and switched off or on for the next review`.

---

### Task 8: The routes, and the service serving them

**Files:**
- Modify: `src/ui/route.ts`, `src/service.ts` (the route's `insight`)
- Test: `src/ui/route.test.ts`, `src/service.test.ts` (new tests only)

**Interfaces:**

```ts
// src/ui/route.ts: Handler gains 'overview' | 'health' | 'repositories' | 'quality' | 'memory' | 'memory_switch'; createUiRoute's deps gain
  insight?: InsightDeps;
export const REPOSITORY_QUALITY: RegExp;   // /^\/api\/repositories\/([^/]+)\/([^/]+)\/quality$/
export const MEMORY_RECORD: RegExp;        // /^\/api\/memory\/([1-9][0-9]{0,9})$/
```

**Rules (3.2, 5; calls 30, 34, 35):**

1. **`METHODS`** gains `['/api/overview', 'GET']`, `['/api/health', 'GET']`, `['/api/repositories', 'GET']`, `['/api/memory', 'GET']`. Before `METHODS.get(path)`, beside plan A's two prefixes: a path under `/api/repositories/` is answered here when it matches `REPOSITORY_QUALITY` with owner and repo lower-cased each matching `^[a-z0-9_.-]{1,100}$`, and a path under `/api/memory/` when it matches `MEMORY_RECORD` with the id at most 2147483647; any other path under either is 404 `not_found` and reads nothing; a matched one with another method is 405 with `allow` (`GET`, or `PUT` for a record), reading nothing.
2. **With `deps.insight` absent,** the six answer 404 `not_found` before any read.
3. **The handlers:** `GET /api/overview` (`overview`), `GET /api/health` (`health`), `GET /api/repositories` (`repositories`), `GET /api/repositories/<owner>/<repo>/quality` (`quality`), `GET /api/memory` (`memory`): `behindSession(..., READ, ...)`, a `'bad_request'` answer 400. `PUT /api/memory/<id>` (`memory_switch`): `behindSession(..., ADMIN_CHANGE, ...)`, then `withBody`, `switchOf` null 400 `bad_request`, `switchMemory(..., session.login)` null 404 `not_found`, else 200 `{ record }`.
4. **The service** gives `createUiRoute` `insight: { db, clock, inForce, started, quality: createQualityCache({ clock, log: say }) }` (one cache, so one computation at a time, for the service), with `inForce` the service's settings in force (plan B's Task 5 closure), and `started`: `{ dryRun: config.dryRun, learning: config.learning, scorer: config.scorer !== null, extensions: deps.extensions.map((e) => ({ name: e.name, parts: (['context', 'notify', 'alert', 'route'] as const).filter((p) => e.parts[p] !== undefined) })), mcpServers: config.mcpServers.map((s) => s.name) }`, where `config` is what the service started on.

- [ ] **Step 1: Write the failing tests.**

```ts
// src/ui/route.test.ts
test('the overview, health, repositories, quality and memory are read behind a session, by a viewer too', async () => {
  /* signed in as a viewer: each GET 200 with JSON_HEADERS and its shape's keys; without a session each 401 signed_out; /api/overview?days=0 400 bad_request */
});
test('a record is switched by an admin with the token, and refused to a viewer, without the token, or with a body of another shape', async () => {
  /* admin with the token, { on: false }: 200, record.on false; a viewer: 403 forbidden, nothing written; no token: 403 csrf; { on: 'no' }: 400; a body not JSON: as
     withBody answers; an id not stored: 404 not_found */
});
test('a path of these routes typed wrongly is not found and reads nothing, and another method is refused', async () => {
  /* signed in, statements cleared: /api/repositories/acme/shop/quality/, /api/repositories/acme/quality, /api/repositories/acme/sh%6fp/quality,
     /api/memory/007, /api/memory/0, /api/memory/2147483648, /api/memory/x: 404; POST /api/overview, DELETE /api/memory/7: 405 with allow; no statement */
});
test('without insight the six routes are not found and read nothing', async () => { /* the route of before: each 404 not_found */ });
test('a handler of these routes that fails is internal_error, logged with its route name only', async () => {
  /* failing 'from visto_ai.dependency_health': 500, { event: 'ui_failed', route: 'health', reason: 'db_down' }; failing 'memory_records r': route 'memory' */
});
// src/service.test.ts
test('with the UI on, the overview reads the settings in force and the dependencies the service started with', async () => {
  /* uiYaml with an account, an MCP server docs in the YAML: GET /api/health signed in lists mcp docs unknown; GET /api/overview's spend limit is the one in force */
});
```

- [ ] **Step 2: Run them and see them fail.** `node --import ./test/setup.ts --test src/ui/route.test.ts src/service.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` and the ASCII check.
- [ ] **Step 5: Commit** `feat: the routes of the overview, health, repositories, score quality and memory, and the switch for admins`.

---

### Task 9: The client reads them

**Files:**
- Modify: `ui/src/api.ts`, `ui/src/api-types.ts`, `ui/src/app.tsx` (the watched API only), `ui/src/format.ts`
- Test: every `fakeApi` (Global Constraints) and `ui/src/app.test.tsx` (the changes of Step 1), `ui/src/format.test.ts` (new test only)

**Interfaces:**

```ts
// ui/src/api.ts, Api gains:
  overview(days: WindowDays): Promise<Overview>;                          // GET /api/overview?days=<n>
  health(): Promise<Health>;                                              // GET /api/health
  repositories(): Promise<Repositories>;                                  // GET /api/repositories
  quality(repository: string, window: QualityWindow): Promise<QualityAnswer>;   // GET /api/repositories/<owner>/<repo>/quality?days=<n|all>
  memory(query: MemoryQuery): Promise<MemoryView>;                        // GET /api/memory?kind=&repo=&q=&before=
  switchMemory(csrf: string, id: number, on: boolean): Promise<MemorySwitched>;   // PUT /api/memory/<id>, { on }, with the token
export interface MemoryQuery { kind?: MemoryKind; repo?: string; q?: string; before?: number }
// ui/src/api-types.ts re-exports, beside the ones it has: WindowDays, QualityWindow, Measure, ApprovalShort, OverviewQuality, Overview, DependencyKind,
//   DependencyStatus, DependencyPart, DependencyShown, AlertShown, Health, QualityRow, SteppedBlock, Quality, QualityState, QualityAnswer, Repositories,
//   MemoryKind, MemoryRecordShown, MemoryView, MemorySwitched
// ui/src/format.ts gains:
export function percent(share: number | null): string;   // 0.041 '4%', 0.5 '50%', null 'None'
export function dollars(n: number): string;              // 12.4 '$12.40', 0 '$0.00'
export function shortDay(day: string): string;           // '2026-10-27' 'Oct 27'; a day that cannot be read ''
```

**Rules:**

1. `quality` splits the repository at its first `/` and encodes each part with `encodeURIComponent`; `memory` sends only the parameters given, `q` encoded; `switchMemory` uses the client's `PUT` (plan B's) with the token header and the body `{ "on": <on> }`. Each read as the others do.
2. The app's watched API passes each of the six through `watch`.
3. `percent`: `Math.round(share * 100)` and `%`. `shortDay`: the UTC month's three letters (`Jan` to `Dec`) and the day without a leading zero.

- [ ] **Step 1: Write the failing tests and the changes.** Each `fakeApi` gains, after its last method and in its own style, the six methods, each recording its call and answering `over`'s, else rejecting `RequestFailed(500, 'not_expected')`. Nothing else in those files changes. `ui/src/app.test.tsx`'s `a 401 from any method of the API the pages are given shows the sign-in page` gains in its list `['overview', (api) => api.overview(30), ['overview', 30]]`, `['health', (api) => api.health(), ['health']]`, `['repositories', (api) => api.repositories(), ['repositories']]`, `['quality', (api) => api.quality('acme/shop', 30), ['quality', 'acme/shop', 30]]`, `['memory', (api) => api.memory({}), ['memory', {}]]` and `['switchMemory', (api) => api.switchMemory('t', 7, false), ['switchMemory', 't', 7, false]]`.

```ts
// ui/src/app.test.tsx
test('the reads of the overview, repositories and memory ask their own paths, and a switch sends the token and the body', async () => {
  /* createApi(fetchFn): overview(7) GETs '/api/overview?days=7'; quality('acme/shop', 'all') '/api/repositories/acme/shop/quality?days=all';
     memory({ kind: 'lesson', q: 'a b' }) '/api/memory?kind=lesson&q=a%20b' (or the URLSearchParams form '+'); switchMemory('t', 7, false) PUTs '/api/memory/7'
     with x-visto-csrf 't' and the body '{"on":false}'; a 403 { error: 'forbidden' } rejects RequestFailed(403, 'forbidden') */
});
// ui/src/format.test.ts
test('shares read as whole percents, money with cents, and days with their month', () => {
  /* percent(0.041) '4%', (0.005) '1%', (0) '0%', (null) 'None'; dollars(12.4) '$12.40', (50) '$50.00'; shortDay('2026-10-27') 'Oct 27', ('2026-01-05') 'Jan 5', ('x') '' */
});
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm --prefix ui run lint && npm --prefix ui run typecheck && npm --prefix ui test`, the root checks, the ASCII check and the token check.
- [ ] **Step 5: Commit** `feat: the client reads the overview, health, repositories, score quality and memory, and switches a record`.

---

### Task 10: The Overview screen

**Files:**
- Create: `ui/src/pages/overview.tsx`, `ui/src/pages/overview.test.tsx`, `ui/src/words.ts`, `ui/src/words.test.ts`
- Modify: `ui/src/app.tsx` (the path `/ui/`), plan B's Settings page (the `Alert webhook` row, call 34)
- Test: `ui/src/app.test.tsx` (its Overview part of rule 9)

**Interfaces:**

```ts
// ui/src/words.ts: pure.
export type Tone = 'bad' | 'warn' | 'muted' | 'ok';
export function alertWords(alert: AlertShown): { tone: Tone; badge: string; title: string; detail: string };
export function dependencyWords(dependency: DependencyShown, now: string): { title: string; tone: Tone; badge: string; line: string };
export function approvalWords(approval: ApprovalShort): { tone: Tone; text: string };
export function partsWords(parts: readonly DependencyPart['part'][]): string;   // ['context', 'notify'] 'Context and notices'
// ui/src/pages/overview.tsx
export const OVERVIEW_MS = 60000;
export const HEALTH_MS = 15000;
export const ENOUGH_LABELS = 10;
export function OverviewPage(): JSX.Element;
```

**Rules (design 1 item 1, 3.4; calls 15 to 22):**

1. **The path.** `app.tsx` renders `<OverviewPage />` for `/ui/`.
2. **The reads.** `api.overview(days)` with `usePoll` every `OVERVIEW_MS`, keyed by `days`; `api.health()` every `HEALTH_MS`; "In review now" from the context's `Activity`. `days` starts at 30.
3. **As drawn** (`Main.dc.html`, lines 73 to 137), in tokens: the page header (`PageHeader`) with the `Segmented` period; the summary `section aria-label="Summary"` `grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4` of four `Card`s `flex flex-col gap-2 p-[18px]`, each a label `text-[13px] font-medium text-muted`, a number `text-[30px] font-semibold leading-[1.1] tracking-[-0.02em]` and a line `text-[13px] text-muted`; "In review now" a `Link` to `/ui/activity` with the card's classes and `text-text no-underline`; the spend bar `h-1.5 overflow-hidden rounded-full bg-subtle` with an inner `block h-full rounded-full bg-accent` whose width is the share (call 19); a `section` `flex flex-wrap gap-4` holding "Reviews per day" (`Card` `flex min-w-0 grow-[2] basis-[520px] flex-col gap-4 p-5`) and "Alerts" (`Card` `flex min-w-0 grow basis-[320px] flex-col gap-3.5 p-5`); the chart `flex h-[180px] items-end gap-[5px] border-b border-border pt-2` of one column per day `flex h-full flex-1 flex-col justify-end gap-0.5`, its parts, from the top, as the mockup stacks them (its failed part first in a column laid out from the bottom): `rounded-[3px] bg-bad` (failed, on top), `rounded-[3px] bg-muted` (other) and `rounded-t-[4px] rounded-b-[2px] bg-accent opacity-90` (published, at the bottom), each height its count over the window's highest day's total, as a percent; the legend's squares `size-2.5 rounded-[3px]` of the same tokens; "Score quality by repository" (`section` as a `Card` `overflow-hidden`, the first plan's `Table`); "Dependencies" (`Card` `flex flex-col gap-3.5 p-5`, a grid `grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3` of boxes `flex flex-col gap-1.5 rounded-[10px] border border-border px-3.5 py-3`). Headings `<h2 className="m-0 text-base font-semibold">`.
4. **Texts, exactly:**

| Where | Text |
|---|---|
| Header | `<h1>Overview</h1>`; sub `Last <days> days across <n> repositories` (`1 repository`; 0: `Last <days> days, no repository reviewed`); the control `aria-label="Period"`: `7 days`, `30 days`, `90 days` |
| Reviews | `Reviews`; the total; `<p> published, <d> in dry run, <f> failed`, then `, <n> with nothing new` and `, <m> not posted` when above 0 |
| In review now | `In review now`; the running count of the first plan's call 19; `<r> reviewing, <w> waiting for pushes to settle` (`r` the running count less the jobs `waiting`), then `, <q> queued` when above 0; before the activity is read, the number `0` and `Not read yet.` |
| Spend today | `Spend today`; `dollars(today)`; the bar `role="img"`, `aria-label` `<p> percent of the daily limit` (`p` the share, at most 100, rounded); `of the <dollars(limit)> daily limit` |
| Approved automatically | `Approved automatically`; the approved count; `of <approved + audited> approvable, <audited> drawn for the audit`; with `me.mode` `dry_run`: `Not decided in dry run` |
| Reviews per day | `Reviews per day`; legend `Published`, `Dry run or not posted` (when a day's `other` is above 0), `Failed`, `text-xs text-muted`; the chart `role="img"`, `aria-label` `Reviews per day over the last <days> days, between <min> and <max> a day`; each column's `title` `<shortDay>: <p> published, <o> dry run or not posted, <f> failed, <dollars(cost)> spent`; under it, `text-xs text-muted`, the first day's `shortDay`, the middle day's, and `Today` |
| Alerts | `Alerts`; Badge bad `<n> open` (**as built, last fix:** `50+ open` at 50, the most the answer holds), or muted `None open`; each open alert, then at most 5 recent: a Badge of `alertWords`' tone and badge (`mt-0.5`), the title `font-semibold`, the detail `text-[13px] text-muted`; none of either: `No alert in the last 7 days.` (`text-sm text-muted`); a failed read: `The alerts could not be read.` |
| Score quality | `Score quality by repository`; `All numbers` (`Link` to `/ui/repositories`); columns `Repository`, `Threshold`, `Safety (lower is better)`, `Benefit`, `Focus`, `Reverts`, `Automatic approval`; the repository a `Link` to `/ui/repositories?repo=<name>` (the name as it is; **as built, last fix:** encoded with `encodeURIComponent`); `<t>%`; Safety `<strong>percent</strong> <muted><part> of <of> blocks</muted>`, or with `of` below `ENOUGH_LABELS` muted `Not enough labels yet, <part> of <of> blocks`; Benefit `<strong>percent</strong> <muted><part> of <of></muted>`, `of` 0 muted `None`; Focus `<strong>percent</strong> <muted>of lines</muted>`, null muted `None`; Reverts `<merged>`, then muted ` (<approved> approved)` when above 0; a Badge of `approvalWords`; the foot `Safety: of the blocks a person stepped in on, the share the score would have left to the bot. Benefit: the share of pull requests where nothing reached the threshold. Focus: in pull requests that needed a person, the share of changed lines flagged for them.` (`border-t border-border px-5 pt-3 pb-4 text-[13px] text-muted`); `qualityCut` above 0: a line after the table `And <n> more repositories, in Repositories.` (`1 more repository`); none: `No repository was reviewed in the last <days> days.` in one cell |
| Dependencies | `Dependencies`; each box: the title `text-sm font-semibold`, a dotted Badge of `dependencyWords`, the line `text-[13px] text-muted` (through `codeSpans`, rule 5); a failed read: `The dependencies could not be read.` |
| Quality not ready | a row `computing`: one cell from Safety to Reverts, muted, `Not measured yet`; `failed`: `Could not be measured`; the repository, threshold and approval cells as for a row ready |
| Overview failed | `The overview could not be read.` and `Button` `Try again`, which reads again; while it reads, `<div aria-busy="true"></div>` below the header |
| Every state | the page header (heading, sub-line, period) shows whatever the reads did; before the overview is read the sub-line is `Last <days> days`. No line of a read that failed carries `role="alert"`, as on Activity |

5. **`alertWords`** (`Failing` bad for an open `model_error`, `memory_error`, `dismissal_failed`, `spend_limit`; `Warning` warn for any other open; `Resolved` muted for a recent one of an open-able code, call 8; `Recent` muted otherwise), titles and details, `<ago>` being `ago(raisedAt, now)`:

| Code | Title | Detail |
|---|---|---|
| `model_error` | `The review model refused the key` (`reason` `auth`), `The review model is out of credit` (`no_credit`) | `Seen by the key check, <ago>.` or `Seen by a review, <ago>.` (`seen_by`) |
| `spend_limit` | `Spend reached the daily limit` | `<dollars(spent)> of <dollars(limit)>. Reviews start again with the next UTC day.` |
| `spend_80` | `Spend reached 80% of the daily limit` | `<dollars(spent)> of <dollars(limit)>, <ago>.` |
| `cost_unknown` | `A review used tokens but cost nothing` | `Without prices the daily limit sees no spend, <ago>.` |
| `mcp_error` | `MCP server <server> is failing` | `<reason>, <ago>.` |
| `extension_error` | `Extension <extension> is failing` | `Its <part> part: <reason>, <ago>.` |
| `memory_error` | `Memory could not be read` | `<reason>, <ago>. Reviews go on without it.` |
| `learning_stale` | `Learning has not run for <hours> hours` | `<ago>.` |
| `lessons_stale` | `Lessons have not been judged for <hours> hours` | `<ago>.` |
| `gate_check_failed` | `A merge gate check could not be set` | `<reason>, <ago>.` |
| `gate_bypass` | `A repository's merge gate is in bypass` | `Said at each start, <ago>.` |
| `feature_off` | `The GitHub App lacks <missing>` | `So <feature> is off. A start finds it once it is granted.` |
| `redelivery_failed` | `Missed deliveries could not all be asked for again` | `<reason>, <ago>.` |
| `dismissal_failed` | `An approval could not be withdrawn` | `<repo> #<number>, <reason>.` |
| `stale_approval_merged` | `An approval stood when its pull request merged` | `<repo> #<number>, <ago>.` |
| any other | the code | `<ago>.` |

   In a detail, and in a dependency's line, each short code and each model's name is written between backticks; the page renders the text through plan A's `codeSpans` (`ui/src/format.ts`), a code part in `MONO`, so the words stay pure.
6. **`dependencyWords`:** titles `Review model`, `Second scorer`, `Memory`, `MCP server <name>`, `Extension <name>`, `GitHub App`; badges `working` ok `Working`, `failing` bad `Failing` (the app warn `Missing <n>`), `unknown` muted `Not checked yet`; lines: the model `<model>, checked <ago(seenAt)>` (unknown `<model>, not checked yet`); the scorer `<model>` (unknown `<model>, not used yet`); memory `Last lookup <ago(seenAt)>` (unknown `No lookup yet`); an MCP server `Last used <ago(seenAt)>` (unknown `Not used yet`); an extension `partsWords` of its parts (unknown `<partsWords>, not used yet`); the app `Permissions and events as needed` (unknown `Not checked yet`), missing: its first item as `Event <name> not subscribed` (`event:<name>`) or `Permission <name> (<level>) not granted` (`<name>:<level>`), then `, and <n> more`; failing, any but the app: `<code> since <utc(since)>`, an extension's `<the part's word> failing: <code> since <utc(since)>`. `partsWords`: `context` `context`, `notify` `notices`, `alert` `alerts`, `route` `a route`, joined `a, b and c`, the first character upper-cased.
7. **`approvalWords`:** off: muted `Off`; on: ok `On, strict` or `On, gate rule`, then `, <n>% audit`, or `, no audit` when 0.
8. **The Settings page** (plan B's Secrets card): the `Alert webhook` row not set reads, as drawn, Badge muted `Not set, alerts are shown here only`; nothing else of it changes.
9. **The tests of before that expect "Coming in a later plan."**, each changed in the task that builds its screen and in nothing else:
   - `ui/src/app.test.tsx`'s `each sidebar entry leads to its page, the coming ones say so, and an unknown path is not found` is named `each sidebar entry leads to its page, and an unknown path is not found`; its first `expect(screen.getByText('Coming in a later plan.'))` (at `/ui/repositories`) expects Repositories' sub-line `How well the score tells what needs a person, measured from what people did` (Task 11); its list `pages` gains each page's sub-line as a fourth element, `Last 30 days` for Overview (this task), Memory's `What the service learned from people, reverts and replies, told to later reviews as context` (Task 12) and Repositories' (Task 11), and the loop's `expect(screen.getByText('Coming in a later plan.'))` expects `screen.getByText(<that sub-line>)`.
   - `ui/src/components/layout.test.tsx`'s part at `/ui/memory` (its comment `The coming pages' line is the header's sub-line.` becomes `A page's line is the header's sub-line.`) finds Memory's sub-line in place of `Coming in a later plan.`, with the same classes and tag `P` (Task 12).
   The default `fakeApi`s reject the new reads, so these pages render their failure states there: the header and sub-line show in every state (the tables above), which is what these tests read.

- [ ] **Step 1: Write the failing tests and the change** (rule 9, its Overview part).

```ts
// ui/src/words.test.ts
test('each alert code reads with its tone, its badge, its title and its detail', () => {
  /* one AlertShown of each row of rule 5, open or not as its tone needs: the exact title and detail, codes between backticks ('`mcp_timeout`, 12 min ago.'); mcp_error recent and cleared: 'Resolved' muted;
     gate_bypass recent: 'Recent' muted; spend_limit open: 'Failing' bad; feature_off open: 'Warning' warn; an unknown code: its code as title */
});
test('each dependency reads with its title, badge and line', () => {
  /* model working seen 2 min before: 'Review model', 'Working', '`vendor/model-a`, checked 2 min ago'; mcp failing since 09:42: '`mcp_timeout` since 2026-03-01 09:42 UTC';
     app missing two: 'Missing 2', 'Event `pull_request_review` not subscribed, and 1 more'; extension parts context and notify: 'Context and notices' */
});
test('automatic approval reads in short', () => { /* off 'Off'; strict 5 'On, strict, 5% audit'; gate 10 'On, gate rule, 10% audit'; strict 0 'On, strict, no audit' */ });
// ui/src/pages/overview.test.tsx
test('the summary cards say the reviews, what is in review now, the spend and the approvals', async () => {
  /* the overview of the shape above: 'Reviews' '412' '398 published, 9 in dry run, 5 failed'; activity 2 reviewing and 1 waiting: '3', '2 reviewing, 1 waiting for pushes to settle';
     '$12.40', 'of the $50.00 daily limit', the bar's label '25 percent of the daily limit'; '38', 'of 44 approvable, 6 drawn for the audit'; me in dry run: 'Not decided in dry run' */
});
test('the period is sent to the server, and the overview is read again every minute and health every fifteen seconds', async () => {
  /* clicking 7 days: overview(7); fake timers: overview at 0 and 60 s, health at 0, 15 s, 30 s; hidden: none */
});
test('reviews per day draw one column a day with its counts and spend in its title', async () => {
  /* 30 entries: 30 columns; a day 2026-02-14 with 12, 1, 0, 3.1: title 'Feb 14: 12 published, 0 dry run or not posted, 1 failed, $3.10 spent'; the legend has no
     'Dry run or not posted' when every other is 0, and has it when one is 1; axis 'Today' */
});
test('alerts list the open ones then the recent ones, and say when there is none', async () => {
  /* two open and seven recent: badge '2 open', both, then five recent; none: 'None open', 'No alert in the last 7 days.'; health rejected: 'The alerts could not be read.' */
});
test('score quality by repository shows each number with its count, and too few labels as such', async () => {
  /* acme/shop: '70%', '4%' '3 of 74 blocks', '41%' '52 of 127', '18%' 'of lines', '2' '(0 approved)', 'On, strict, 5% audit'; of 4: 'Not enough labels yet, 0 of 4 blocks';
     the link's href '/ui/repositories?repo=acme/shop'; qualityCut 1: 'And 1 more repository, in Repositories.'; none: 'No repository was reviewed in the last 30 days.' */
});
test('a repository not measured yet, or whose measuring failed, says so in its row', async () => {
  /* rows computing and failed: 'Not measured yet' and 'Could not be measured' in one cell each, the threshold and the approval badge still shown */
});
test('the dependencies show each with its state', async () => { /* the health of the shape above: 'Review model' 'Working'; 'MCP server docs' 'Failing'; 'GitHub App' 'Missing 1' */ });
test('an overview that cannot be read says so with no alert role, keeps its header, and Try again reads again', async () => {
  /* overview and health rejected 500: heading 'Overview', 'Last 30 days', 'The overview could not be read.', no role alert; then answered */
});
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks, the ASCII check and the token check.
- [ ] **Step 5: Commit** `feat: the Overview screen: reviews, spend, approvals, reviews per day, alerts, score quality and dependencies`.

---

### Task 11: The Repositories screen

**Files:**
- Create: `ui/src/pages/repositories.tsx`, `ui/src/pages/repositories.test.tsx`
- Modify: `ui/src/app.tsx` (the path `/ui/repositories`)
- Test: `ui/src/app.test.tsx` (its Repositories part of Task 10's rule 9)

**Interfaces:**

```tsx
// ui/src/pages/repositories.tsx
export const QUALITY_RETRY_MS = 5000;
export function RepositoriesPage(): JSX.Element;
```

**Rules (design 1 item 4; 3.3 items 6 and 8, 3.4; calls 23 to 29):**

1. **The reads.** `api.repositories()` once; the repository shown is `?repo=` (lower-cased) when the list holds it, else the first; a tab's click `navigate('/ui/repositories?repo=<name>', true)` (**as built, last fix:** the name encoded); `api.quality(repository, window)` once for each repository and window (`usePoll` with 0, keyed by both, as plan A reads a review), `window` from the select, 30 at first; while it answers `computing`, read again every `QUALITY_RETRY_MS` (5000) until it is `ready` or `failed`; not polled otherwise (call 26).
2. **As drawn** (`Repositories.dc.html`, lines 67 to 113), in tokens: the header with the window select (hidden label `Window`, `sr-only`) and, for an admin only, `Button asChild` `<Link to="/ui/settings">Settings of <repository></Link>` (a `Link`, so the page does not reload; Settings opens at its top, whose nav leads to Repositories: an anchor would not exist yet when the browser looked for it); the tabs `<div role="tablist" aria-label="Repository" className="flex flex-wrap gap-1 border-b border-border">`, each `<button type="button" role="tab" aria-selected>` `-mb-px min-h-11 cursor-pointer border-0 border-b-2 border-transparent bg-transparent px-3.5 py-2.5 text-sm font-medium text-muted`, the one on `border-accent text-text`; the headline `section aria-label="Headline numbers at the threshold"` of four cards as the Overview's (grid `minmax(210px,1fr)`); "At each threshold" (a `Card` `overflow-hidden` with its head, the table, the foot), the current row's cells `bg-accent-soft`; then a `flex flex-wrap gap-4` of the two cards `flex min-w-0 grow basis-[360px] flex-col gap-3 px-5 py-[18px]`.
3. **Texts, exactly:**

| Where | Text |
|---|---|
| Header | `<h1>Repositories</h1>`; `How well the score tells what needs a person, measured from what people did`; options `Last 30 days`, `Last 90 days`, `Since install` (values 30, 90, `all`) |
| Safety, by block | `Safety, by block`; `percent(share)`; `<part> of <of> blocks that needed a person were under <t>%. Lower is better.`, then ` Not enough labels yet to mean much.` when `of` is below 10 |
| Benefit | `Benefit`; `percent`; `In <part> of <of> pull requests nothing reached <t>%.` |
| Focus | `Focus`; `percent`; `of <count(of)> changed lines in pull requests that needed a person were flagged for them.` |
| Outside signals | `Outside signals`; `<merged>` with ` reverts` (`revert` when 1) in `text-base font-medium text-muted`; `<approved> of them approved by the bot. Audit: <drawn> drawn, <needed> needed a person.` |
| Under the cards | when `cut.pulls`: `Measured on the newest 300 pull requests closed in this window.`; when `cut.comments` or `cut.runs`: `Some comments or runs were past what one measure reads, and were left out.`; when `unreadable` above 0: `<n> pull requests left out: their stored scores could not be read.` (`1 pull request`); `pullRequests` 0: `No pull request closed in this window.` (**as built, last fix:** `closed` 0, so it is not said when pull requests closed but none was measured) (`text-[13px] text-muted`) |
| At each threshold | `At each threshold`; right `The highlighted row is the repository's own threshold`; columns `Threshold`, `Safety, by block`, `Safety, by file`, `Benefit`, `Focus`; a cell `<span className="font-semibold">percent</span> <muted><part> of <of></muted>`, Focus the percent alone; the current row `<strong><t>%</strong>` and Badge accent `current`; the foot `A block needed a person when someone other than the author commented on its lines and the lines changed in a later commit, as the pull request's last review saw them: the diff at the merge is not stored. Labels per block are fewer than per file, so the block numbers need more history before they mean much.` |
| Blocks stepped in on | `Blocks a person stepped in on, under the threshold`; each `<path in MONO> <muted>#<number></muted>` and right `<muted>scored <score>%</muted>`; none: `None in this window.` |
| Reviewer feedback | `Reviewer feedback`; `percent(helpful / (helpful + notHelpful))` and `helpful, <helpful> of <total> answers` (`answer`); `Reasons given when not helpful` (muted) and the reasons `<reason> (<count>)` joined `, `, the first character upper-cased (**as built, last fix:** each reason in a `<bdi>`, as the page of one review); no reason: `None given.`; no answer: the number `None` and `No answer in this window.` |
| States | no repository: `No repository has been reviewed yet.`; reading: `<div aria-busy="true"></div>`; `computing`: `Measuring this repository's pull requests.` (`text-sm text-muted`); `failed`: `The numbers could not be measured. They are measured again a minute after the failure.` and `Try again`; a read that failed: `The numbers could not be read.` and `Try again`; none of these lines carries `role="alert"`; the header and its sub-line show in every state |

- [ ] **Step 1: Write the failing tests and the change** (Task 10's rule 9, its Repositories part).

```tsx
// ui/src/pages/repositories.test.tsx
test('the headline cards and the table say each number with its count at the threshold, the current row marked', async () => {
  /* the quality of the shape above: '4%' '3 of 74 blocks that needed a person were under 70%. Lower is better.'; '41%' 'In 52 of 127 pull requests nothing reached 70%.';
     '18%' 'of 9,412 changed lines ...'; '2' 'reverts' '0 of them approved by the bot. Audit: 6 drawn, 1 needed a person.'; the 70% row holds 'current' and its cells bg-accent-soft */
});
test('a tab and the window choose what is read, and ?repo= opens that repository', async () => {
  /* repositories acme/shop and acme/web at /ui/repositories?repo=acme/web: quality('acme/web', 30), its tab aria-selected; clicking acme/shop: quality('acme/shop', 30)
     and the address ?repo=acme/shop; Since install: quality('acme/shop', 'all') */
});
test('the blocks stepped in on and the feedback are listed, and their absence said', async () => {
  /* stepped one: 'src/cart/discount.ts' '#119' 'scored 55%'; none: 'None in this window.'; reasons: 'Repeats a settled thread (3), too long (1)'; no answer: 'No answer in this window.' */
});
test('the settings link is an admin\'s only', async () => { /* admin: 'Settings of acme/shop' to /ui/settings; viewer: none */ });
test('a repository being measured is read again every five seconds until it is ready, and a failure says so', async () => {
  /* quality answers computing, then ready: 'Measuring this repository\'s pull requests.', then after 5 s the numbers; failed: 'The numbers could not be measured. ...', no role alert */
});
test('too few labels, a cut, unreadable runs and no repository are said', async () => {
  /* of 4: '... Lower is better. Not enough labels yet to mean much.'; cut.pulls: 'Measured on the newest 300 ...'; cut.runs: 'Some comments or runs were past ...';
     unreadable 1: '1 pull request left out: ...'; none: 'No repository has been reviewed yet.' */
});
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks, the ASCII check and the token check.
- [ ] **Step 5: Commit** `feat: the Repositories screen: score quality at each threshold, outside signals, blocks stepped in on and feedback`.

---

### Task 12: The Memory screen

**Files:**
- Create: `ui/src/pages/memory.tsx`, `ui/src/pages/memory.test.tsx`
- Modify: `ui/src/app.tsx` (the path `/ui/memory`); delete `ui/src/pages/later.tsx` once nothing imports it
- Test: `ui/src/app.test.tsx` and `ui/src/components/layout.test.tsx` (their Memory parts of Task 10's rule 9)

**Interfaces:**

```tsx
// ui/src/pages/memory.tsx
export function MemoryPage(): JSX.Element;
```

**Rules (design 1 item 5; main 7; calls 30 to 33):**

1. **The reads.** `api.memory(query)` at once and when the query changes; the search sent 300 ms after the last key (Activity's `SEARCH_MS`); any filter change starts from the first page; paging keeps a stack of `before` values (Next pushes `next`, Previous pops), as Activity does. Not polled. After a switch, the page is read again with the same query.
2. **The switch:** plan B's `Switch` (`role="switch"`, `aria-checked`), `label` `Turn off: <where>` when on, `Turn on: <where>` when off; for an admin, a click calls `api.switchMemory(me.csrf, id, !on)`, the switch disabled while it waits; a failure says `The record could not be switched.` (`role="alert"`, `text-sm text-bad`, above the table); for a viewer every switch is `disabled`.
3. **As drawn** (`Memory.dc.html`, lines 69 to 106), in tokens: the header with the learning badge and line; the counts `section aria-label="Records"` (grid `minmax(200px,1fr)`, cards `flex flex-col gap-1.5 px-[18px] py-4`, the number `text-[26px] font-semibold`); the card with its head (`flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4`: the `Segmented` `aria-label="Kind"`, the search, the repository select), the table, the foot; a record's badge `self-start`, its text `text-sm leading-normal`, a row off `[&>td]:opacity-60`.
4. **Texts, exactly:**

| Where | Text |
|---|---|
| Header | `<h1>Memory</h1>`; `What the service learned from people, reverts and replies, told to later reviews as context`; learning on: dotted Badge ok `Learning is on` and `Last pass <ago(ranAt)>` (`No pass yet` when null); off: dotted Badge muted `Learning is off` and `No record is made, and none is shown to reviews.` (`text-[13px] text-muted`) |
| Counts | `People stepped in` `<signals>` `across <n> repositories` (`1 repository`); `Reverts` `<reverts>` `files of reverted pull requests`; `Lessons` `<lessons>` `from replies to findings`; `Turned off` `<off>` `shown to no review` |
| Kind | `All`, `People stepped in`, `Reverts`, `Lessons` |
| Search | hidden label `Search records`, placeholder `Search path or text`, `type="search"`, `w-[220px]` |
| Repository | hidden label `Repository`; first option `All repositories`, value `''`; then `me.repositories` |
| Columns | `Record`, `Where`, `From`, `Made`, `Expires`, `Shown to reviews` |
| Record | `human_signal` Badge info `A person stepped in`, text the record's, or `A person commented on these lines.` when it is `''`; `revert` Badge bad `Reverted`, `This file was part of a pull request that was reverted.`; `lesson` Badge accent `Lesson`, its text |
| Where | the path, else the directory, in `MONO`; under it `text-xs text-muted` the repository |
| From | `human_signal` `#<number>`, then `, by <by>` when known; `revert` `#<number> reverted #<reverted>`; `lesson` `A reply on #<number>` (`text-[13px] text-muted`) |
| Made, Expires | `shortDay` of the date's UTC day (`text-[13px] text-muted whitespace-nowrap`); **as built, last fix:** a time the answer gives as none reads `Unknown` (made) and `Never` (expires) |
| Shown to reviews | the switch and `On` or `Off` (`text-[13px] text-muted`) |
| Foot | `<rows> of <total> records` (`record`), `Previous`, `Next`; the line `A record turned off is shown to no later review, at once. Turning it on again shows it from the next review. Nothing learned can lower a score.`, and for a viewer ` Only an admin can turn a record on or off.` |
| Empty | `No record yet.`, or `No record matches.` with any filter, in one cell; read failed: `The records could not be read.`, with no `role="alert"`; the header and its sub-line show in every state, the learning badge once the records are read |

- [ ] **Step 1: Write the failing tests and the changes** (Task 10's rule 9, its Memory parts in `ui/src/app.test.tsx` and `ui/src/components/layout.test.tsx`).

```tsx
// ui/src/pages/memory.test.tsx
test('the records show their kind, text, place, source, dates and state', async () => {
  /* three records of the three kinds: 'A person stepped in' with its words, 'Reverted' 'This file was part of a pull request that was reverted.', 'Lesson' its text;
     'src/cart/price.ts' 'acme/shop'; '#104, by octo-lead', '#70 reverted #68', 'A reply on #188'; 'Nov 12', 'May 11'; 'On'; one off: 'Off' and its row's opacity class */
});
test('an admin switches a record, which is then read again', async () => {
  /* clicking 'Turn off: src/cart/price.ts': switchMemory(csrf, 1, false), then memory read again; a rejection: 'The record could not be switched.' */
});
test('a viewer sees every switch disabled, and why', async () => { /* role viewer: each switch disabled; 'Only an admin can turn a record on or off.' */ });
test('the kind, the repository and the search are sent to the server, and paging goes forward and back', async () => {
  /* Lessons: memory({ kind: 'lesson' }); acme/shop; 'cart' after 300 ms once; Next with next 51: before 51; Previous: without */
});
test('learning and the counts are said, and so are an empty and a failed list', async () => {
  /* on with ranAt 3 min before: 'Learning is on' 'Last pass 3 min ago'; off: 'Learning is off'; counts 146 across 4 repositories ...; 'No record yet.', 'No record matches.', 'The records could not be read.' */
});
```

- [ ] **Step 2: Run them and see them fail.** `npm --prefix ui test`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four `ui` scripts, the root checks, the ASCII check and the token check.
- [ ] **Step 5: Commit** `feat: the Memory screen: the learned records with their words and places, and a switch for each`.

---

### Task 13: The documents

**Files:**
- Modify: `docs/guide/the-ui.md`, `docs/guide/memory.md`, `docs/guide/lessons-and-reverts.md`, `docs/guide/running-the-service.md`, `docs/guide/backtest.md`, `README.md` (the status rows of rule 2, and nothing else), `docs/superpowers/specs/2026-11-25-the-ui-design.md` and `docs/superpowers/specs/2026-11-13-visto-ai-design.md` (the sentences of rule 4, and nothing else); this plan, brought to the rules as built

**Rules:**

1. **The guide.** Each sentence states only what the code does, with its cost where it has one.
   - `the-ui.md`: the opening paragraph names the Overview, Repositories and Memory among the screens, and no screen "Coming in a later plan". **Who sees what**: its sentence saying no answer holds "any author's login, or any text a person wrote but a title" (as plans A and B leave it) is replaced, not added to, by one saying what the answers hold of people: the titles, the requesters of `/review` and `/done`, the page of one review's words and logins (plan A), Memory's start of what a person wrote under a pull request, as learning keeps it, with that person's login (call 32), and Repositories' feedback reasons without their logins (call 28); and what they still never hold (the config, a secret, a body, rendered comments, a quote, the id of a review, a comment, an installation or a delivery), with the cost. **The screens**: a bullet each. **Overview** (`/ui/`): the window and its control, the reviews' split, "In review now", spend today and its limit in force, approvals by pull request and "Not decided in dry run", reviews per day with the third legend and spend in each day's title, alerts open and recent with their rules (calls 8 to 11), score quality per repository with its bounds and "Not enough labels yet" (call 18), dependencies and where each is learned (calls 12 to 14), what is read how often (call 20). **Repositories** (`/ui/repositories`): the tabs, the windows, the rows and the current one, the live labels and what they cannot see (calls 23, 24), the bounds and the cache (call 26), outside signals (call 27), feedback (call 28), the blocks stepped in on (call 29), the settings link for admins. **Memory** (`/ui/memory`): what is listed and how (calls 32, 33), who may switch (call 30) and what a switch does and when (call 31). **The routes** table gains the six of call 34, with their shapes in a sentence each, and the paragraph after it says who may call each and how a malformed path, a parameter and another method are answered. **The log** gains `memory_switch`, `status_store_failed`, `status_store_full`, and `ui_failed`'s six route names. **The migrations** gains `0017_overview` and that a previous release cannot be put back. **In the database**: the statements of rule 3. **What was tried**: the three screens, the tests (the run under Docker's sentence is added by the controller with the notes).
   - `memory.md`: **The kill switch** becomes the Memory screen, for admins, with what it does and when (call 31), the statements kept below it for an operator (they still work, and the UI's switch writes the same column with who and when); **The three alerts** says they are also stored and shown on the Overview, cleared by the first review whose memory works.
   - `lessons-and-reverts.md`: where it says a lesson or a revert record is switched off in the database: in the Memory screen by an admin, or in the database.
   - `running-the-service.md`: after the list of alerts, that every alert but the four closers is also stored in `visto_ai.alerts` and shown on the Overview (open and recent, call 8), kept 30 days, and each dependency's state in `visto_ai.dependency_health` (call 12).
   - `backtest.md`: one sentence: the UI's Repositories measures with the same code (`countAt`), on labels built from the stored comments and runs (call 23), so its numbers and the backtest's differ where the stored data differs from a history file.
2. **`README.md`, `## Status`:** the UI's built row names the Overview, Repositories and Memory beside the screens it names, its second cell unchanged; the planned UI row is removed.
3. **The statements** for `the-ui.md`:

```sql
-- the open alerts, and the newest of every code
select id, code, key, details, raised_at, cleared_at from visto_ai.alerts where cleared_at is null order by raised_at desc limit 50;
-- each dependency's state, and since when
select kind, name, part, status, code, since, seen_at from visto_ai.dependency_health order by kind, name, part;
-- who switched memory records, the latest first
select id, owner, repo, kind, status, switched_by, switched_at from visto_ai.memory_records where switched_at is not null order by switched_at desc limit 50;
```

4. **The designs are amended,** in the same commit, one sentence for each place this plan departs from them or adds to them:

| Document, section | The sentence | Call |
|---|---|---|
| UI design 3.3, item 3 | It gains: A dependency working again clears the alert of its pair through its stored state, and the alert that says so is not stored; alerts are kept 30 days. | 6, 9, 11 |
| UI design 3.3, item 4 | It gains: The second scorer's state is read from each review's audit; a dependency the service did not start with is not listed. | 12, 14 |
| UI design 3.3, item 7 | It gains: Admins switch a record; viewers see the switches. A switch is not a setting: the record keeps who switched it last and when, and no history. | 30, 31 |
| UI design 3.3, item 8 | It gains: The pull requests closed in the window, the newest 300, are measured at the repository's threshold in force, one computation at a time in the service, in bounded reads; a result is kept 5 minutes and a failure 1 minute. | 24, 26 |
| UI design 3.4, open and recent alerts | Spend at the limit is open as spend at 80% is, until the UTC day ends. | 8 |
| UI design 5 | `GET /api/repositories/{owner}/{repo}/quality` takes `days` 7, 30, 90 or `all`; `GET /api/memory` pages 50 at a time with `before`; `PUT /api/memory/{id}` is an admin's. | 26, 30, 32 |
| UI design 7, item 3 | It gains: Built in one plan. | 1 |
| Main 6.6, Live | The live strict label reads each block's hash at the pull request's last review, since the diff at the merge is not stored. | 23 |
| Main 7, the sentence "Until the UI exists, a record can be disabled only in the database." | It becomes: An admin switches a record off or on in the UI's Memory screen, or in the database. | 30 |
| Main 13 | `alerts` and `dependency_health` hold the alerts raised and each dependency's state; `memory_records` gains who switched a record last and when. | 2 |

- [ ] **Step 1: Write the documents.** For each sentence written or kept in the sections touched, name the code that makes it true in the report.
- [ ] **Step 2: Run** the root suite, type check, lint, the four `ui` scripts, the ASCII check, the token check and the guide check (`npm test` runs `test/guide/check.test.ts`).
- [ ] **Step 3: Commit** `docs: the overview, repositories and memory in the guide, the README's status and the designs`.

**(As built)** The guide's first statement lists the alerts not cleared, newest first, and its comment says that the Overview's open ones also end with the UTC day for spend and follow a withdrawal's stored failure (the comment the plan gave, "the newest of every code", did not describe the statement). The sentence of rule 4 for Main 7 stands in section 18, item 8 ("Until the UI exists, a record can be disabled only in the database."), where it is written. Two sentences outside the sections named, that said "the UI to come" of a record's words and a lesson's quote, now say what the Memory screen shows, and the guide's Secrets row says what the alert webhook reads when it is not set (call 34).

---

## The run under Docker (call 36)

Made by the controller after the last fix, on the final code, as in the plans before:

- **The previous release first** (`dev` before this branch) on an empty database, given memory records of each kind by statements, then stopped; this branch starts on it: the ledger gains `0017_overview`, those records read as never switched and keep their status; the previous release, started again, refuses.
- **Alerts and health live:** the stub of GitHub answers the app with one event missing (so `feature_off` is raised and stored, and the GitHub App reads `Missing 1`) and 404 on the deliveries (`redelivery_failed`, recent); an MCP server pointed at a stub that refuses, then answers: one dry-run review through the stubs stores `mcp_error` and the server `Failing`; the stub fixed and a second review: the alert `Resolved`, the server `Working`; the app restarted while the server fails, then fixed: the stored alert cleared at the first review after (call 9).
- **History by statements:** 300 closed pull requests of `acme/shop` in the window, each with two to four runs whose stored results are of real size (written by a script made for the run in the engine's shape, every path and text invented: a few hundred KB for the largest, one over 2 MB), people's inline comments at earlier heads, a finding thread with a reply, a merged revert of an approved pull request, an audited pull request, feedback with reasons; and 20 other repositories with a few each.
- **Timing:** a cold `GET /api/repositories/acme/shop/quality?days=all`: the time to `ready` (through `computing` answers), each statement's time from the log of Postgres (`log_min_duration_statement = 0` for the run), all under the pool's 15 seconds; the process's resident memory before, at its peak and after; meanwhile one dry-run review through the stubs, whose time is recorded against the same review with nothing else running. A cold Overview: at most 2 rows measured, the rest `Not measured yet`, its answer within about 20 seconds; read again a minute later, two more. The numbers go in the notes.
- **A browser** (Playwright's Chromium in the app's network namespace): an admin signs in with a password and lands on the Overview with every card filled, switches the period; opens Repositories from a row, changes the window, and the numbers match a hand count from the rows written; on Memory switches a record off; a dry-run review of a pull request on that record's path then shows no memory line for it (the run's audit `memory_shown` does not name its source reference), and on again the next does; a viewer sees the switches disabled, and `PUT /api/memory/<id>` with the viewer's token answers 403 `forbidden`; light and dark; the console shows no violation of the content security policy.
- **Throughout,** every log line is one JSON object; no answer or log line holds a secret, a person's words or a login but the screens' own; everything the run made is removed.

## To verify

None of these is shown by a test of this plan. Each names the step that can show it, or "For the owner" when it needs GitHub.

1. **That Postgres computes score quality as PGlite does, and within its bounds** for a repository of 300 closed pull requests of real size: each statement under 15 seconds, a cold computation under 60, the memory of call 26, a review's time meanwhile. The run under Docker, timing.
2. **That the commit and lines stored with an inline comment belong together** (capture stores `original_commit_id` with `original_line` and `original_start_line`, `src/forge/github/objects.ts`), so the live labels place a comment on the run of the commit whose diff its line numbers count on, also for a comment made on an older commit. For the owner, on the scratch repository, with a comment on an older commit.
3. **That a reply under one of the app's findings carries that finding's comment as `reply_to`** (GitHub's `in_reply_to_id` names a thread's first comment), on which the labels leave such replies out. For the owner, with a real reply.
4. **That the chart, the switches and the tabs render and work under the content security policy** in a real browser. The run under Docker.
5. **That a stored alert clears after a restart** on a real start, not only in the test. The run under Docker, alerts and health live.
6. **The sizes:** 50 open and 5 recent alerts, 7 days recent and 30 kept, 200 writes queued, 60 seconds between sightings, 20 repositories on the Overview and 2 measured a request, 300 pull requests, 10,000 run rows, 1,000 runs read 10 at a time, 2 MB a stored result and 20,000 comments a computation, 60 seconds a computation, 10 seconds of waiting, 5 minutes and 100 results kept and 1 minute a failure, 10 labels before Safety is said, 20 blocks stepped in on, 5 reasons, 50 records a page, 1,000 characters of a record's text, 60, 15 and 5 seconds of polling.
