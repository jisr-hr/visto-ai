# Notes: The UI's Overview, Repositories and Memory plan

These notes record what happened while `2026-11-27-the-ui-overview-repositories-memory.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the run showed, and what is left. The plan states the rules as built. This plan adds three screens: the Overview (what the service did, what it spent, its alerts and the state of what it depends on), Repositories (the quality of the score of one repository, measured from what people did on its closed pull requests) and Memory (the records learned from people, which an admin switches on or off).

## Status

- The plan was drafted from the UI's design and the three approved mockups, and reviewed by another model before anything was built. It found one critical point (the live score quality was unbounded in time and memory, on the five connections that reviews and webhooks share), three important ones (runs that said nothing new dropped block labels, one failing repository could take down the whole Overview, and a task broke a test the plan did not name) and eighteen minor ones. All were applied (see decisions 15 to 17).
- Tasks 1 to 13 were built one at a time, each by one implementer, tests first, and each reviewed by an independent reviewer. Three tasks needed a fix round: Task 5 (the live quality read heads that no label counts, which filled the places for the ones that do), Task 10 (a title showed literal backticks, and the reverts' words differed from the mockup) and Task 12 (Memory's search was not capped at 100, which the service refuses).
- A review of the whole branch found nothing critical, three important points (one pull request's reads were not bounded by size, the quality cache had no stop, and the Memory search matched the hidden quote of a lesson) and thirteen smaller ones. One fix wave addressed them (commits `81038aa`, `bc22627`, `4146daa`). A review of that wave found them addressed and one new important point: waiting on the stop of the service left about 250 bytes behind for each uncached quality request (60,000 requests grew the heap by 15.5 MB). That was fixed in `db0cf1c`.
- One migration, `0017_overview` (two tables, `alerts` and `dependency_health`, and two nullable columns on `memory_records` for who switched a record and when). The previous release refuses to start on a database that has it, by the ledger's own check.
- The live numbers were compared with the backtest's own `measure` on 24 seeded cases (random pull requests, runs, files, blocks and comments, at three thresholds and three group sizes): all 24 equal.
- The service's full suite passed (3,795 tests) at `4146daa`. After it, the leak fix, the 15-minute keep and these notes' commit were checked by their focused tests (221 of 221), lint and type checks, and the frontend's tests (200 of 200).

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

1. **`CaseScores` is generic** (Task 1): `CaseScores<F extends ScoredFile = FileScore>`, because the live side passes score lists reduced to the fields measured. The backtest's type is unchanged by its default. Cost: a type parameter the brief did not name.
2. **The code lists and the withdrawal check are written once** (Task 2, the plan-mandated important point). They went into the final wave: the statements take the lists as parameters from the exported constants, and one constant holds the withdrawal check. Cost: two statements differ from the plan's text.
3. **The log's `what` labels are the code's** (Task 3): `alert`, `health`, `clear`, `prune`, not the plan's `app`. Cost: the plan's call 35 was amended.
4. **A closed status store does no more work** (Task 4): a write queued behind one that outlives the stop is not sent to a closed pool. The `!ending` guard before the prune and the test hook `beforeQuery` were accepted. Cost: none.
5. **A repository is known by an indexed lookup** (Task 5), `repositoryKnown`, not by the list of 200 repositories. It stays right past 200 repositories. Cost: one statement.
6. **The Overview's quality rows are busiest first** (Task 6), the name deciding a tie, as the mockup orders them. "By name" in the plan was read as "each shown by name". Cost: not alphabetical.
7. **Reverts show `(n approved)` whenever the repository has reverts** (Task 10). The builder first showed it only above zero; the reviewer found the mockup draws it always, and the ruling was reversed. `alertWords` takes `now`. Cost: none.
8. **A block score already raised while a record was on is kept by the score history until that block's code changes** (Task 7). Switching a record off stops every later review reading it, but a score a review already raised is carried by the scores-across-reviews floor. The guide says so. Cost: a switched-off record can still show its effect on one block until the code changes. The page's footer says only that the record is shown to no later review, which stays true.
9. **One pull request's reads are held to about 4 MB stored** (final review): its last run, then the runs at the heads its counted comments name, newest first, while they fit. A head left out labels only the last run's file and the screen says so. A last run over 2 MB is read alone. Cost: approximate labels on a pull request with more than 4 MB of stored scores. It bounds the worst heap of one group from about 195 MB to about 45 MB.
10. **Memory's search matches a record's excerpt only for a person's own words** (final review). A lesson's excerpt is the quoted reply, which no screen shows, and searching it would let a viewer probe it. Cost: a lesson is found by its path, directory and text, not by its quote.
11. **`retireExpired` keeps a disabled record's status as it is** (final review, not done). A test of plan 11 pins that a disabled one is left as it is, and no test made before this plan is edited without his word. Cost: after its expiry a switched-off record still says `disabled` in the status column. Nothing reads the difference, since every reader checks the expiry.
12. **A `closed` count in the quality answer, and `Unknown` and `Never` for a time no date writes** (final review). The screen says `No pull request closed in this window.` only when none closed, and a record with an `infinity` expiry no longer fails the page. Cost: two texts and one field the mockups do not draw.
13. **The quality cache waits through a set of waiters, not by racing the stop's promise** (the re-review). Each waiter is removed when its wait ends, and the stop answers the ones still there. Cost: none. The first form leaked, and a deterministic test now pins the fix.
14. **A computed quality result is kept 15 minutes, not 5** (after the run under Docker). The run showed that the Overview's table stopped at about ten measured repositories, since a read measures two cold ones a minute and a row lasted five. At 15 minutes twenty repositories fill in about ten minutes. Cost: a row's numbers may be up to 15 minutes old. A repository's own page reads the same cache.
15. **Quality is computed one at a time in the whole service, in groups, with a failure kept for a minute and at most two cold repositories measured for one Overview read** (plan review, critical point). Cost: numbers up to 15 minutes old (5 when planned), a request that waits up to 10 seconds, a cold computation that delays the next by up to 75 seconds, and the largest reviews not measured.
16. **Only admins switch a record, viewers see it, and one failing repository never fails the Overview** (plan review). It shows `Could not be measured` for that row. Cost: a viewer cannot switch a record, and only the last switch of a record is kept, with no history before it.
17. **A nothing-new run counts as a run at its head for labels** (plan review): the rule is the one memory's signals use, `outcome = 'ok'`. Cost: none.
18. **The final wave's service commit alone fails the UI's type check** (`81038aa`): the fixture lacked the new `closed` field. The next commit (`bc22627`) makes it whole. The service is green at each commit.
19. **Plan B's fix wave was merged into this branch** (`ui-settings` at `40abf21`, merge `50abe3e`, clean). The Settings page gained an optional `title` on its switch and one edited test, ratified. Cost: none.

## What the run under Docker showed

In a network with no way out, on a real Postgres, with throwaway secrets: the release before this one on an empty database, then this branch, then the release before again, then a real browser (Chromium). It ran on commit `4146daa`, before the 15-minute keep and the leak fix.

- The release before applied 16 migrations. This branch added `0017_overview` only. Every record read no switch time and no switch login, and kept its status. The release before then refused to start on that database, with its ledger unchanged.
- Alerts and health: a missing event of the app was stored at the start and read `Missing 1` on the Overview; each start cleared the earlier one and stored a new one. A refused MCP server stored an alert and showed `Failing`; when it answered again the alert cleared at the same millisecond the review ended. A restart while it failed and then worked: the alert cleared at the first review after. An alert raised again after a restart was logged again and stored once.
- History written by statements: 300 closed pull requests of one repository (260 in 30 days) with two to four runs each, results of real size (median 3.5 KB stored, the largest ordinary about 270 KB, one pull request of four runs of 1.52 MB for the 4 MB hold and one last run of 2.54 MB, unreadable), 20 other repositories, 596 inline comments of every kind, three reverts, two audits and 24 feedback answers.
- A cold quality computation for all time answered `ready` in 227 ms (no `computing`, being under the 10 seconds): 76 statements, 91.8 ms in all, the longest 30.5 ms (the 4 MB group), a median score read of 0.40 ms. Resident memory went from 132 MiB to 254 MiB at the peak and stayed there. A review alone took 17 to 24 ms; fired with a cold computation, 47 ms. With the computation held by a lock of 14.5 s, the answer was `computing` at 10.03 s and `ready` at 10.9 s, and reviews meanwhile took 19 to 20 ms. A cold Overview over 30 days answered in 198 ms with 2 rows measured and 18 not yet; a minute later 4 were.
- In the browser an admin signed in by password and landed on the Overview with every card filled: 810 reviews (790 published, 17 in dry run, 3 failed), spend of $5.70 of a $20.00 daily limit, approvals, the chart of 30 columns, the alerts, 20 quality rows and 4 dependencies. Switching to 7 days drew 7 columns. On Repositories, the API for 7, 30, 90 days and all time matched an independent count by hand on every field, and the text on screen matched it in light and dark. At 30 days and a threshold of 70: Safety 86% (116 of 135 blocks), by file 58%, Benefit 28%, 2 reverts (1 approved), 2 audits drawn and 1 needed, 14 of 21 answers helpful. Both notes showed (comments or runs past what one measure reads, and 2 pull requests left out).
- Memory: a record switched off was absent from what the next review was shown, and back on it was shown again; the switch was logged with only the record and the state. A viewer saw 8 switches disabled with their title and a footer saying so, and `PUT /api/memory/1` with the viewer's token was answered 403.
- A stop of the service during a cold computation, held by a lock of 4 s: the waiting request was answered `computing` at once, the statement under way ended, the next was never sent, the connections closed, and the service exited 0 in 2.75 s with no `quality_failed`. Held by a lock of 25 s: it exited 0 in 10.1 s (5 s for the cache, 5 s for the database, `database_close_timeout` logged) and sent no statement after the stop began; the stuck statement was ended by the database's 15 s limit 4 s after the exit.
- No content security policy violation and no page error. No log line (171 over 7 starts, all JSON), Postgres log or answer held a planted secret, a password, a one-time password, a cookie's value or an installation token. A comment's body appeared nowhere; memory excerpts only in Memory's answers, feedback reasons only in quality answers, logins only in Memory's and `/api/me`, none in any log.
- Four findings. The Overview's table stopped at about ten measured rows (decision 14, fixed). In dry run the `Approved automatically` card can show live approvals stored in the window above `Not decided in dry run` (see "For the owner"). One computation's resident memory (about 120 MiB) is not returned to the system. A statement stuck at the stop can run on the server up to its 15 s limit after the process exits.
- At the end the project was brought down with its volumes, the images but the last were removed, and the secrets, sessions and cookies were deleted.

## What was checked against GitHub

Nothing. The run used a stand-in for GitHub (missing one event, to test the alert) and a stand-in for the model. These screens read the service's own database; what GitHub answers is not part of them, except for two assumptions that the live labels rely on (see "Not verified").

## For the owner to decide

1. **Cannot be undone:** the previous release refuses to start on a database this release has migrated (`0017_overview`).
2. **The computations' queue has no length cap.** Distinct repositories, windows and thresholds queue one behind the other, each up to about 75 seconds on one of the five connections, so a person opening many tabs can keep one connection busy for a long while. A small bound past which a request is answered `computing` without queueing (the pages read again anyway) is a few lines. Keep it, or add it.
3. **`retireExpired` leaves disabled rows** (decision 11). Keep it, or let it retire them too and edit plan 11's test.
4. **A block score raised while a record was on stays until that code changes** (decision 8). Keep it, or have a switch reset the history of the blocks the record touched, which costs a recomputation of their scores.
5. **One computation's resident memory (about 120 MiB) is not returned to the system.** Measured as resident memory, not heap. A tight container limit should leave room for it.
6. **In dry run the `Approved automatically` card can show live approvals stored in the window above `Not decided in dry run`.** Keep it, or show only the dry-run line while the service is in dry run.
7. **A statement stuck at the stop can run on the server up to its 15 s limit after the process exits.** The service waits 5 s for it. Keep it, or lower the pool's statement limit.
8. **Rulings he may want to change:** decisions 5, 6, 7, 8, 9, 10, 11, 12 and 14 above, and the plan's calls 6, 8, 12, 17, 18, 19, 21, 24, 26, 30 and 32.

## Known and left as they are

The reviews judged each of these a "leave", or the builder parked it.

- **Task 1:** the overlap rule `meets()` is copied from the backtest's labels; the fixture heads are not 40 hex characters; the path lookups are linear; one test is redundant.
- **Task 2:** pruning keeps every `dismissal_failed` row of a key that is failing (bounded, raised only on the first failure); a function is inline; cleaning of NUL and surrogate characters is untested.
- **Task 3:** one log assertion is weak (`>= 4`) and one uses the real clock.
- **Task 4:** the held-write test does not also assert that the listener closed.
- **Task 5:** the threads of the app's findings are read without a limit (two short fields, bounded by the app's own findings).
- **Task 6:** an unlogged `catch {}` on the quality row's path; some tests check only part of their answers; a few names and repeated finds.
- **Task 8:** one test harness is named `off` and has the UI on.
- **Task 9:** `NaN%` and `$NaN` for a number that is not finite (the JSON carries none), no thousands grouping, and a day's number is not checked.
- **Task 10:** a change of period does not abort the earlier read (its answer is ignored); the Alerts and Dependencies headings are empty while health is pending; the reverts' numbers do not go through `count()`.
- **Task 11:** no tests of switching a tab or window in the middle of a read, or of leaving the page while a result computes; a failed repeat read replaces `Measuring`; the tabs have no `tabpanel`, `aria-controls` or arrow keys.
- **The Memory page's footer** does not say that a score already raised stays until the code changes (decision 8). The guide does.
- **The first letter** of a person's feedback reason is capitalised by the first plan's helper.
- **The background computation** is a fifth user of the pool beside the API's four places, so a review can wait while four reads and one computation each hold a connection. It was timed in the run (47 ms for a review beside a cold computation).
- **An extension's `alert` part** reads `Not checked yet`, and the second scorer reads as working on a review that never asked it (plan call 12's stated cost).

## Not verified

- **GitHub.** That the commit and the lines stored with an inline comment belong together, so that a comment made on an older commit is placed on the run of that commit; that a reply under one of the app's findings carries that finding's comment as its `reply_to`; the published side of a review (the run was in dry run); and sign-in through GitHub (the run signed in with a password). The live labels lean on the first two, and the run wrote them by statements.
- **Browsers other than Chromium.**
- **Heap size.** The run measured resident memory only. The heap figures (about 45 MB for one group, 195 MB before the 4 MB bound) come from a probe on an in-process Postgres.
- **The leak fix `db0cf1c` and the 15-minute keep.** Both came after the run under Docker. They are covered by tests and by a probe (60,000 requests grew the heap by 0.8 MB, against 15.5 MB before), not by a run. That a row kept 15 minutes fills the Overview's table in about ten minutes follows from two rows a minute and was not run.
- **The whole service suite after `4146daa`.** It passed (3,795) there; the focused tests (221), both lints, both type checks and the frontend's tests (200) passed after.
