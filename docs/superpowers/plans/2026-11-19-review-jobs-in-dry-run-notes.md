# Notes: Review Jobs in Dry Run plan

These notes record what happened while `2026-11-19-review-jobs-in-dry-run.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the real run showed, and what was put off. Where the plan and these notes differ, the notes say what was built.

## Status

- Before the build, the plan was reviewed by a stronger model than the one that wrote it. It found three critical and eight important defects and about twenty minor ones. Every critical and important one was applied to the plan before its first commit.
- Tasks 1 to 12 were built on the branch `stage-4b`, one implementer and one independent reviewer per task. Tasks 2, 7, 8, 10 and 11, the ones that hold the queue's orderings and the money, were reviewed by a stronger model, and Task 11 was also built by one.
- Two tasks needed one fix round each: Task 10 (one finding) and Task 12 (one, in the README). Both rounds were re-reviewed.
- Then a review of the whole branch by the strongest model, one fix wave of eight groups of changes, and one re-review of that wave. The whole-branch review found no critical defect. The re-review found every point of the wave addressed and three minor ones new; one of those, a sentence of the README, was corrected afterwards without a further review (decision 24).
- At the end: 1,112 tests pass, the type check and the lint are clean, source and tests are ASCII.
- Task 12's real run, under Docker on the builder's machine with the app cut off from the outside, passed. What it showed is below. It was made before the fix wave.
- Nothing has been checked against a real GitHub App or a real model call. Nothing on this branch has reviewed a real pull request. See "Not verified".

## Decisions taken while building

Each entry says what was decided, why, and what it costs if it is wrong.

**From the review of the plan, before the first task**

1. An event older than what is stored still triggers, from the stored facts, and never replaces a pending job (call 26). The first draft dropped such an event. Any later event of a pull request, a label for example, can be stored before the push it followed, and that push would then have queued nothing: its head would never have been reviewed. Cost if wrong: a job for a head that was already going to be reviewed, which the review job then drops as already reviewed.
2. The wiring of the real clients in `src/main.ts` moved from Task 12 to Task 11. The first draft changed what the service needs a task before the entry point that supplies it, so the project would not have compiled between the two.
3. What an alert says about a failure goes under `reason`, never `code`. In the first draft a detail named `code` replaced the alert's own name in the log line.
4. A key check starts a pause once and never extends one, and is ignored for the rest of the process once a review has proved it wrong (call 12). The first draft let a failing check hold reviews for good on an endpoint whose key route refuses what its model accepts. Cost if wrong: on such an endpoint, one job tries the model every 5 minutes while the key really is refused.
5. A job put back after a refused key is due when the pause is over, not at once (call 11). In the first draft it was due at once and sorted first, so on a provider that refuses some requests and not others it would have been retried every few seconds.
6. A redelivery attempt that did not get through is made again every 5 minutes with the same look-back, and the heartbeat does not move until one does (call 21). The first draft started the heartbeat whatever the result, which forgot the window after one failure.
7. A job whose pull request could not be read from the git service is tried again instead of ending as failed (call 24). In dry run nothing else could ask for that review again.
8. The lock's connection and the pool have a keep-alive delay of 10 seconds. Without one the operating system waits about two hours before it probes an idle connection.
9. Beyond the review: a job whose head has moved makes sure the live head has a job (call 25), and the runner, not start-up, judges a job's age and its starts. The design (8.2) says a job for a moved head is dropped, because the new head's own event queues one. Cost if wrong: one more job row per moved head.

**During the tasks**

10. Task 8. The implementer wrote the runner and its tests together and showed the tests failing afterwards. The tests are the plan's own, written before any code existed, so they were not shaped by it. Left as it is.
11. Task 10. A failure before the review that is not a failed run, such as a database read that fails or settings that throw, puts the job back with its start counted. As first built it only logged, and the job stayed `running` until the next restart. Cost if wrong: up to three cheap tries of a job that fails the same way each time, then it is dropped as out of starts.
12. Task 10, points the plan left open. A drop, and the transaction for a moved head, are tried three times like the record. A render that throws still records the run, with an empty body.
13. Task 11, points the plan left open. A heartbeat that cannot be read counts as an attempt that did not get through. A redelivery attempt that ends after the stop began raises no alert. The service logs five events the plan does not name: `upkeep_failed`, `beat_failed`, `drain_failed`, `instance_lock_release_failed` and `instance_lock_release_timeout`. One of plan 3's tests ("when listen rejects") was dropped, because the new test of a failed start covers it and also checks that the lock is released.
14. Task 12. The README first said that a cap of 50 US dollars a day is active. The limit only counts the costs that are recorded. It now says where a run's cost comes from and when the limit cannot see it.

**In the final fix wave**

15. The wait before a retry grows: a minute after a job's first start, 15 minutes after its second (call 24 said a fixed minute). A fixed minute dropped every job that came up during a failure of the git service longer than two minutes. Cost if wrong: a job sits up to 16 minutes before it is dropped as out of starts.
16. After a refused key, a job's start is given back only when the run made no model call (call 11 said: when its cost was 0). On an endpoint that reports no cost, a key refused in the middle of a review would otherwise have paid for the earlier batches every 5 minutes for a day. Cost if wrong: if a provider counts a refused call as usage, a job is dropped after three tries of a key failure.
17. The pause and the put-back times are measured from the moment of the failure, not from the job's start. A refusal seen more than 5 minutes into a review would otherwise have paused nothing.
18. A drop by the runner (too old, out of starts) is one statement guarded on the job's state, starts and creation time. As first built, a push that replaced the job between the look and the drop lost its review. The whole-branch review reproduced it with a script.
19. Once the engine has returned, no failure puts the job back. As first built, a throw in the record step would have put the job back and the review would have been paid for again.
20. The numbers a provider reports are cleaned before they are stored: token counts are rounded, and a cost that is not a finite number at or above 0 is stored as 0. A fractional count was refused by the database, which would have left a paid run unrecorded.
21. A file download that breaks in the middle of its body is a failure of the git service like any other, so the job is tried again. As first built it ended the review as failed for good.
22. Redelivery counts what its cap of 200 left out as failed, so an alert is raised, and two attempts never run at once.
23. The README says what ends a job without a review, what a restart in the middle of a review costs, and what the app needs for a dry run.

**After the re-review**

24. The fix wave's README said that reviews cut by a restart "run again afterwards". One cut on its third start is dropped as out of starts. The sentence now says "while they have starts left". This one change was made by the builder and had no review of its own. Cost if wrong: one phrase of the README.

## What the reviews found that the plan had wrong

Defects of the plan, not of the code written from it.

- The first draft threw away a trigger older than what was stored (decision 1). Found by running the repository's own code with a label stored before its push.
- The first draft could not compile between Tasks 11 and 12 (decision 2).
- The first draft's alerts lost their names in the log (decision 3).
- The first draft's pause could hold for good, or not hold at all (decisions 4 and 5).
- The first draft forgot the redelivery window after one failed attempt (decision 6).
- The plan as built from: a fixed one-minute retry, the start given back on a cost of 0, times taken from the job's start, a drop by id alone, and the record step inside the catch that puts a job back (decisions 15 to 19). All five were found after the code existed, three of them only by the whole-branch review.

## Text in the plan that these decisions made stale

- Call 11 and Task 10 say the start is given back "when the run's cost is 0". It is given back when the run made no model call.
- Call 24, Task 10 and the Shared constants name `RETRY_WAIT_MS`, one minute. It is `RETRY_WAITS_MS`, one minute and then 15.
- Task 10 says `now` is the clock when the job began, for every time it writes. The health and the two put-backs read the clock when the failure happens.
- Task 8 finishes a dropped job with `finishJob`. It uses `dropJobIfUnchanged`.
- Task 10's list of ends has no entry for a failure before the review that is not a failed run. See decision 11.
- Task 11's list of log events is shorter than what the service logs. See decision 13.
- Task 12, Step 5, item 2 says the job's three tries are "a minute apart". That was true of the run, which was made before the fix wave. They are now a minute and then 15 minutes apart.
- Task 12's README list is shorter than what the README now says.

## What the real run showed

Task 12, Step 5, under its own Compose project on the builder's machine, on a network with no way out, cleaned up afterwards. It was made at the head before the fix wave.

- The app started, logged `recovery`, `listening` and a `model_check` whose result was `unknown`, since nothing was reachable.
- An `opened` sample was answered `202 accepted`. Its job was tried three times, each try a row of `review_runs` with `failure_stage = 'prepare'`, `failure_code = 'github_network'` and `cost = 0`, and was then dropped as `attempts_exhausted`. `sum(cost)::float8` answered as a `double precision` on the real client.
- Two `synchronize` samples with two heads left one pending job, of the second head, due 180 seconds after the second. It survived a restart of the app, came up 5 seconds after its time, failed at `prepare` and was put back.
- A second app container on the same database ended at once with `start_failed` and the reason `another_instance_running`, exit code 1. The first kept running.
- After the database was restarted the app logged a `database_error` with a code and then `instance_lock_lost`, exited, was started again by Compose, and accepted the next sample.
- The app stopped with exit code 0 in under a second, and its log showed no `instance_lock_lost`.
- With nothing reachable, each start after the first logged a redelivery that could not list, raised `redelivery_failed` once, and left the heartbeat where it was.
- Two connections against the queue's statements, with `psql`:
  - A requeue against an enqueue that was not yet committed waited, then failed with a unique violation on `jobs_one_pending`.
  - A claim against a replace that was not yet committed waited, then updated no row. The same claim with nothing in its way took the row.
- The whole log was 25 lines of ids, codes and counts. It held no payload text, no key and no address.

## Put off

**Before this runs against a real app**

- The token mint and the deliveries requests have no time limit of their own, and neither have the read-only requests of the first plans. A request that hangs holds a job's place for as long as the runtime's own limit, about five minutes.
- The lock's connection is never used after the lock is taken. A Postgres that ends idle sessions would end it on a timer, and each time the service would exit and the running reviews be paid for again. Not confirmed; a light statement now and then would avoid it.
- One delivery of an unexpected shape fails the whole deliveries listing, so redelivery would never get through and the heartbeat never move. Not confirmed against a real listing.
- A delivery answered 503 while the service keeps running is not asked for again until the next start. Redelivery covers downtime only (design 8.2).
- Nothing is raised when a job is dropped. A job that waited a day on a refused key ends as `too_old` with one alert in the whole day, the first `model_error`.
- A review cut by a restart leaves no run row, so what it spent is invisible to the daily limit. Three starts bound it.
- A model timeout leaves that head unreviewed until its next push. In dry run nothing else asks again.
- A refused key of the second scorer neither pauses reviews nor raises an alert.
- The two ends that put a job back record the run and then requeue, outside a transaction. A database answer lost in between records the run twice. It needs a put-back whose cost is above 0, which only a key refused in the middle of a review has.
- `review_runs` grows without pruning, as design 13 says.

**Before publishing (the next plan)**

- The head is not read again after the review: a push that lands while a review runs is still recorded for the old head. Design 8.3's check comes with publishing.
- "Unless their review was already published" in the recovery (design 8.2).
- The start-up check of the app's permissions and events (design 8.4), and the app manifest.
- The score tables. A dry run keeps its scores and findings inside its run row.
- When a provider refuses some requests and not others, `model_error` and `model_ok` alternate on the alert address.

**Small, can wait**

- Lint does not catch a file directly in `src/forge` importing the GitHub adapter, a dynamic import of the adapter or of a Postgres client outside the engine, a sub-path of a Postgres client, or a use of the global `fetch`. None exists.
- `requeueJob` answers `superseded` also when the job was not running. `storableJson` stores an object that has `toJSON`, a `Date` for example, as `{}`; no caller passes one.
- `receive` reads the clock twice, and has a fallback for a stored pull request that cannot be missing.
- The live read of a pull request accepts an empty commit id as text.
- Answer bodies that are not read are not cancelled. The key check follows redirects.
- A signing failure of the app token inside a request would be reported as `github_network`.
- `main`'s own wiring of the two signals has no unit test; `runUntilSignal` has.
- From the re-review of the fix wave: when a record fails after a paid review, the log entry's cost can be `NaN`, which is written as `null`; one test in `runner.test.ts` starts on the same line as the end of the one before it.
- A review whose record failed three times is left `running` and, like any cut review, runs again after the next start if it has starts left, and is paid for again.
- Tests of behaviour that is right but unpinned: stop's last beat; a start step that fails; the daily limit reached in one step; an error event on the lock's connection after release.

## Not verified

- **Against a real GitHub App and a real model:** everything in the plan's last section. In short: that GitHub accepts the app token as built; that an installation token reads a pull request, its compare and its files, also from a fork; the order of the deliveries listing and whether a delivery asked for again keeps its id; what the model endpoint's key route answers; how often events arrive out of order; and one whole review in dry run whose recorded text reads like a review.
- **On a real Postgres:** the statements of a finished review. Every job of the real run failed before the engine, so the check for an already reviewed head, the transaction for a moved head, the transaction that finishes a job and records its run with a real result, and the deletion of old jobs have run only on the in-process database. So has everything the fix wave changed, the guarded drop among them.
- **Under load:** the real run showed the queue's two orderings one at a time.
- **On Linux:** CI has not run on this branch.
- **The app's permissions for a dry run:** the README states them from what the code calls.
- **Against the predecessor:** the rules carried over were written from notes of its modules, not from a fresh read of its source.
