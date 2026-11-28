# Notes: The Evals With Lessons plan

These notes record what happened while `2026-11-27-evals-with-lessons.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the run showed, and what is left. This plan is the fourth and last of stage 8 of the build order: with it, both evals can be shown lessons as of each case. Nothing is measured yet: the measurement (Task 10) waits for a deployment's export.

## Status

- The plan was drafted from the design, the three plans of stage 8 before it and their notes, and the code, and reviewed by another model against the code before anything was built. That review found nothing critical, four important points (a comparison by file name that could never refuse, a line `eval:compare` would have added to every comparison, an export command no test could reach, a config field that does not exist) and thirteen smaller ones; all were applied to the plan before the first line of code.
- Tasks 1 to 8 were built one at a time, each by one implementer, tests first, and each reviewed by an independent reviewer against its own diff. Tasks 1 to 7 were approved at their first review. Task 8's documents promised four runs and showed three; they were corrected in one round.
- The night's rules moved out of the service (Task 2) with `src/shell/judge.test.ts` unedited; its reviewer compared the old and the new code rule by rule. Task 3 added a test that runs the service's own nightly run over an in-process Postgres and the eval's nights over that database's export, with the same answers, and compares the verdicts and the lessons.
- Task 9's run under Docker was made by an agent of its own, on a network with no way out and with throwaway secrets (decision 7).
- Then a review of the whole branch, on the strongest model the build had: no critical or important finding, ready to merge; four minor points and one ruling on the plan, made in one round of fixes and checked again (decision 8). One point is left (below).
- At the end the suite held 3,860 tests, all passing, with typecheck and lint clean.

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it.

1. **The test of a database the export refuses** removes the `0003_publishing` row from the migration ledger of an in-process database, as the seed's test does for its migration: the test database always migrates.
2. **The ASCII check binds the files a task changes.** Four hits in `test/guide/check.test.ts` and `src/eval/judge/run.ts`, and the diagram of the design, were there before this plan and are left as they are.
3. **Two refusals beyond the plan,** `bad_findings_time` and `bad_findings_repo`, refuse an export whose time or repository cannot be read before any call is made. Cost: they name no line; they could move into the export's reader, which knows the line.
4. **A later verdict that is not text is left out of the export,** so the eval can read an older one where the database would answer nothing. The service writes only text there; the two differ only on a database changed by hand.
5. **The eval's judge has a file of its own,** `src/eval/lessons/judge-replies.ts`, which takes the model client, so its tests can run with a fake model: the suite blocks the network, and the command line builds a real client.
6. **The labels of the comparison in lessons mode** (plan, Task 7, rule 5, amended after the final review): `score-compare` comparing a candidate with lessons against a baseline without says "shown a lesson" where its first form says "shown memory", so that Task 10's numbers are not read as memory's. The first form prints as before.
7. **The run's image is not kept.** The plan has no migration, so no previous-release image is needed; the image built for the run was removed, and the image of another session's run was left in place.
8. **The final fixes:** the eval's judge removes an older `lessons.json` and `summary.md` before it reads its kept answers; the export reads a run's findings once, not once for each of its comments; a file written with `--force` is removed first, then written mode 600; the guide names the backtest's floor as the count prints it.

## What the run under Docker showed

On a real Postgres 17, migrated by the service: the export read in one read-only transaction, left every table's row count as it was and wrote its file mode 600; it refused an existing file and a path inside the project. The eval's judge, against a model endpoint made for the run, made the lessons its answers called for, and a second run asked nothing and wrote the same file byte for byte. The cases and the free count came out as computed beforehand from the code. No printed line or log held a secret, a reply, a finding, a lesson's text or a login. Not tried there: the replay and the backtest with lessons (they read GitHub and the model; their tests use fakes), a run stopped by its spend limit, and any deployment's real data.

## What is left

- **A run refused because its findings file cannot be read** still leaves an older `lessons.json` in its folder: the removal comes after the findings are read. `lesson-cases` notices (`different_export`); the replay and the backtest do not. The fix is to remove the old files before reading the findings.
- **The measurement** (Task 10) waits for the owner: the export from a deployment, a history file of the same repositories and window, and his go-ahead for the paid runs. Until it runs, the README says what lessons do is not measured.
- Minor points the reviews left as they are, none of which changes a result: the export's replies keyed by comment id alone (unique by the schema), a few casts and imports that could be tidier, a check of a case's date that accepts a loose time, and the free count's lessons not bounded as the engine's read is (it cannot be reached: at most 900 lessons are live in a repository at once).
