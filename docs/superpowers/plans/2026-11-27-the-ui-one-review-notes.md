# Notes: The UI, One Review plan

These notes record what happened while `2026-11-27-the-ui-one-review.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the run showed, and what is left. The plan states the rules as built. The page of one review is the screen each row of Activity's Recent reviews leads to. It shows why a review approved or did not, the score of each file, its findings and their threads, its usage, its approval record, its dependencies and the feedback on it.

## Status

- The plan was drafted from the UI's design and the approved mockup, and reviewed by another model before anything was built. It found nothing critical, one important point (the shape of a feedback login) and nineteen smaller ones. The planner applied all of them, with four rulings of the builder's (below).
- Tasks 1 to 10 were built one at a time, each by one implementer, tests first, and each reviewed by an independent reviewer. Two tasks needed a fix round (Task 3: the newest signal decides a thread, which no test pinned; Task 9: a retry time of none read as "Trying again now", and five smaller points). Both were reviewed again and came out clean.
- A review of the whole branch found nothing critical, one important point (a sentence of the extension guide, "Nothing shows feedback yet", that this plan made false) and six smaller ones. One fix wave addressed them (commit `ea5ec11`). A scoped review of that wave found seven of seven addressed and one leftover, a false header comment in `src/ui/route.ts`, fixed in the commit of these notes.
- The two routes and their statements only read. There is no migration: the ledger is as before.
- The full service suite passed (3,619 tests) after Task 5's code, and the frontend's tests passed (103) after the last task. The run under Docker was made last, on the final code, by an agent of its own, with throwaway secrets.

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

1. **A feedback login is shown only in GitHub's shape** (plan review; call 15). The service takes any login a module reports, so the page shows one only when it has GitHub's shape, and a reason with any other login is shown with no name. Cost: a module's user can still answer under someone else's real login, and the page shows it as that login. The page does not verify it.
2. **Fields the mockup does not show are not answered** (plan review). The answers are built from an allowlist, field by field. Cost: showing one of them later means a change to the answer, its type and its test.
3. **The summary, the audit, the acceptance rows and the providers are stripped in the statement itself** (plan review). They never reach Node. Cost: a screen that wants one of them needs a new statement, not a new field.
4. **The branch starts from the theme branch, not from `dev`** (plan review), because the page uses the theme's components and icons. Cost: this pull request carries the theme's commits until that one merges first.
5. **A test written in this plan may be edited by a later task of this plan** (Task 8). A new heading matched a pattern in Task 7's own test, so Task 8 narrowed it. The rule "no existing test is edited" is for tests that predate the plan. Cost: none.
6. **A test of this plan may be scoped to one region when a later task's mandated text repeats a word** (Task 9). Task 7's banner test read ambiguous once the side cards repeated "Not decided in dry run". Its lookups are scoped to the banner. A withdrawal code of none, which the service never sends, reads `Dismissing it failed.` Cost: none.
7. **The comments read by a review are filtered by its pull request** (final review). The first statement filtered by run alone, and no index has `run`, so every view scanned the whole comments table. It now uses the pull request's index, as the existing comment reads do. Cost: none.
8. **The reason a job ran goes through the short-code check** (final review), as every other code the page shows. One that is not a short code reads `unknown`.
9. **The false header of `src/ui/route.ts` is corrected, not deleted** (final review of the fix wave). It said no answer but the accounts' and the review routes' holds a login. `/api/me` answers the signed-in name, and Activity's rows answer the requester's login. The header now says what holds one. Comment only.

## What the run under Docker showed

In a network with no way out, on a real Postgres, with throwaway secrets: the release before this one on an empty database, then this branch on it, then the release before again. The ledger was unchanged by this branch (names and times diffed), and the release before started again on it. Each start logged that the app check could not reach GitHub, as the network has no way out; that is expected here.

Rows were written by statements for one pull request, `acme/shop` number 128, with four runs. The plan said three runs and an earlier approval; an earlier approval is a run of its own. They were a dry run, a live approval whose dismissal failed with its withdraw job waiting, a failed run, and a published live run with every card's rows (file scores, a placed major with a person's resolution, a placed minor with no thread, an unplaced minor, verdicts, a duplicate, a failed MCP server, three feedback rows) and values the page must never answer.

- A real Chromium made 34 checks, all passed, with no content security policy violation and no page error. The four console errors were expected (two 401s before sign-in, two 404s).
- From Activity each run opened at its page, and every card showed its rows as the plan says: the banner with the paragraph and the gate's sentence, the scores (`2 blocks, the highest at lines 38 to 51`, a raised score, a block kept from an earlier review, a whole file, a file too large to send), each thread state, the earlier threads and duplicates line, usage, the approval record (`Dismissing it failed (github_403)` and when it is tried again), dependencies and feedback. A feedback reason given under an address showed with no name, and the address was nowhere on the page.
- The dry run said `Not decided in dry run`. The selector moved between the four runs, and the pull request's list was read once.
- A run that is not stored and a number with a leading zero both said `Review not found`, and the second read nothing.
- With a session, the answer for one review held none of eleven values that must never be answered.
- A viewer saw no Settings and the same cards as the admin. Both themes were checked for every run.
- From inside the container, with no session, both routes answered 401 `signed_out`. `/api/reviews/0`, `/api/reviews/007`, a number above the limit and a pull request number of 0 answered 404. `POST` and `DELETE` answered 405 with `allow: GET`.
- Every log line of both services was one JSON object. None held a feedback reason, a finding or score text, a login, an account name, a cookie's value, a password or a secret. Controls that plant each value found it where it exists.
- At the end the project was brought down with its volumes and the images the run built were removed.

## What was checked against GitHub

Nothing. The page reads what the service stored.

## For the owner to decide

1. **Who reads what.** Every signed-in viewer reads, for every repository the service reviews, what GitHub never showed: the reason of every block and file below the threshold, every finding of a dry run, and the feedback reasons people wrote. It is the plan's call 16 and the guide says it under "Who sees what". If a deployment must not show this to viewers, the change is a role check on the two routes.
2. **A feedback login is the module's claim** (decision 1). Keep it as it is, or stop showing a login at all.
3. **Rulings he may want to change:** decisions 1, 2 and 4 above, and the plan's calls 6, 8, 9, 11, 13, 15, 16, 17 and 20.
4. **A real thread on the scratch repository** would show the two things the tests cannot (see "Not verified").

## Known and left as they are

The final review judged each of these a "leave".

- **The sidebar's account box wraps.** "Signed in with a password" and "Change password" fall into a narrow column at a window 1,360 pixels wide. It is the layout of earlier plans, not of this one.
- **Pool places.** The UI's API still has four places of the pool's five, and a page view now holds one a little longer. The first plan's call 17 is unchanged. A hard guarantee would be a smaller number of places or a pool of its own.
- **Unbounded read.** The verdicts of later runs of a pull request are read with no bound, which is the same order as what a review itself reads.
- **A title and branch names show with no bidi isolation,** as Activity's titles do. Only a module's user's text is isolated.
- **Untested boundaries (service):** the shape guard of later verdicts on an object, a string or a list (probed by the reviewer, not committed); the caps of 50 names, 10 models and exactly 2,000 characters; a reason that is no short code; a login of 39 characters; a gone job; a malformed path with the wrong method; a number above the maximum; an owner of 101 characters; a forged cookie. The code refuses the path before the method and the session, so those hold by reading.
- **Untested boundaries (page):** a repository with no slash and a run that is no number (the service answers 404 to both); the page's own-run guard; the banner's icon tone and the gate's codes in mono; a not-found breadcrumb for an invalid address; a score of none; the foot's emphasis; finding text that looks like Markdown or HTML (React escapes it).
- **Weak or odd tests:** two tests that compare part of a row, one `toHaveLength(6)` that asserts nothing, two apps mounted in one test, an order test that may not tell the service's order from the fixture's, and a test of no recorded dependencies that does not assert the absent notes.
- **Small code points:** a scores entry the file reader skips still counts in the read total, which the engine never writes; a triple cast and a name ending in an underscore; names cut to 50 before the status filter; lessons read with no memory row; a list prop that restates a type; a class with a trailing space; the review's `run` named like a match result.
- **A retry time on a merged pull request** may show another approval's job time. The plan's call 12 and the guide say so: one job's time is shown on every failed approval.
- **A thread's state comes from stored events, not from GitHub.** A thread resolved by the app reads from the later review's verdict, because the app's own thread events are not stored (call 11).
- **The gate is the newest evaluation at the review's head** (call 8), and there is no polling (call 20): the page reads once per run and try.
- **The guide's opening** still says password sign-in, roles and Accounts were tried in the tests only, while "What was tried" describes their run under Docker. It is from an earlier plan.

## Not verified

- **A real thread.** That a person resolving a real thread arrives with `reply_to` equal to the stored first comment's id, so the state reads `Resolved by <login>`. The run used rows written by statements.
- **A real later verdict.** That a later real review's verdict reads as `Fixed in a later review` on the earlier page.
- **Real results of older shapes.** The tests and the reviewer's probes cover damaged and older shapes; the run's rows were all of the current shape. A database of the real-app trial would show more.
- **The size bounds:** 500 files, 200 findings, 20 approvals, 20 reasons, 50 MCP servers and extensions, 10 models, 200 runs in the selector, and the 2,000 and 4,000 characters read from a body. Tests only.
- **The page of the first review of a pull request with many later published reviews,** which reads the later verdicts on real rows. The run's pull request had two published runs.
- **Browsers other than Chromium,** and sign-in through GitHub (the run signed in with a password).
- **The whole service suite after the final fix wave.** The focused service tests (101), the frontend's tests (103) and both lints and type checks passed; the full suite last ran after Task 5.
