# Notes: The UI's Settings plan

These notes record what happened while `2026-11-27-the-ui-settings.md` was built: the decisions taken where the plan was silent or wrong, what the reviews found, what the run showed, and what is left. The plan states the rules as built. Settings is the screen for admins where the settings of the service are read and changed: General, Model, Repositories (the defaults, each override, the merge gate and automatic approval), Secrets by variable name, Access, Accounts, the record of changes, and the saved settings as `config.yml` text.

## Status

- The plan was drafted from the UI's design and the approved mockup, and reviewed by another model before anything was built. It found nothing critical, five important points (two tests the plan broke without naming, the start path with no test, a sentence about the UI off that was false once the UI had been on, and credentials written in an endpoint) and thirteen smaller ones. The planner applied all of them, with three rulings of the builder's (below).
- Tasks 1 to 11 were built one at a time, each by one implementer, tests first, and each reviewed by an independent reviewer. Four tasks needed a fix round: Task 5 (the review across a save was not pinned by its test, and a raised spend limit silenced its alerts for the rest of the day), Task 8 (the test of invalid JSON blocking a save was vacuous, and nine smaller points), Task 9 (the two heading switches showed no override line and could not go back to the default, and the pane was not keyed by repository, among ten) and Task 11 (two costs of the start were missing from the docs). All were reviewed again and came out clean.
- A review of the whole branch found nothing critical, one important point (an admin could send the model's and the scorer's API keys to another server by saving an endpoint) and five smaller ones. One fix wave addressed them (commits `ce6035f` and `d7281fc`). A review of that wave found them all addressed and left two smaller points, which the commit of these notes fixed (the scorer's endpoint on the view, and plan text left behind).
- One migration, `0016_settings`. The previous release refuses to start on a database that has it, by the ledger's own check (see "What the run under Docker showed").
- The service's full suite passed (3,681 tests) at Task 10's commit, and the frontend's tests passed (158) at the last commit. The full suite was not run again after the fixes of the commit of these notes; the focused service tests, both lints and type checks, the frontend's tests and its build passed. The run under Docker was made on the code before that commit, by an agent of its own, with throwaway secrets.

## Decisions taken while building

Each is the builder's, taken without the owner, and listed so he can overrule it. The plan's numbered calls say the same of the ones that became rules.

1. **With the UI off, each start copies the file whole** (plan review, call 13). Otherwise a setting saved while the UI was on would go on running with no screen to see it or undo it. Cost: a person who turns the UI off loses what the UI saved, and the next start records the file's values as made by `config.yml`.
2. **A credential written in an endpoint's address is disclosed, not refused** (plan review, call 17). Refusing it would stop a deployed file from starting. Cost: such an address is shown to admins. After the ruling in 8 below it is shown read only, and in the export, and is not stored in the settings tables or the record.
3. **`*` in the gate's branches is not refused** (plan review). Refusing it would stop a deployed file from starting. The screen says what it does, and so does `merge-gate.md`. Cost: a gate written that way matches no branch named `*`.
4. **A save that fails after the version check writes no `settings_save` line** (Task 4). The route's `ui_failed` line records a rejected handler, and the route's own filter makes a bad change impossible. Cost: a refusal of that kind is logged only by the route.
5. **A test of this plan may be edited by a later task of this plan** (Task 9). The new Repositories entry changed Task 8's own checks of the nav and the order of sections. Cost: none.
6. **A repository added in the page with no setting reads `It is kept once it overrides a setting.`** (Task 9). It is one sentence the mockup does not draw. Cost: one sentence the owner did not see.
7. **The reviewer's deferred minors went into a final wave, or were left** (final review): `secretsOf` read a whole extension `options` block as one reference, the export test left its blocks off so its checks proved nothing, the page's export kept stale text with no sign when its re-read failed, an Older page could answer from before a re-read, the version and the row's value were not pinned in the view's test, the Add button and its box sat inside the listbox, and some stale comments. All were fixed. Cost: none.
8. **`model.baseUrl` and `scorer.baseUrl` are the file's alone** (final review, important). They are not settings: the page shows them as read only text ending `Set in config.yml.`, a save that names either is answered 400, a row written by hand is ignored, and the lists are 17 global paths and five start-time ones. The reason: an admin who could edit them could send the API keys to an address of their choosing, at the next restart, and before this release only whoever edits `config.yml` could do that. Cost: changing an endpoint needs a file edit and a restart, which it needed a restart for already, and the page can no longer change it.
9. **The scorer's endpoint is read from the file** (commit of these notes). It was read from the saved settings, so it showed none while the scorer was off even when the file wrote one, and switching the scorer on in the page showed `The default`. It now comes from the file, with the schema's default when the scorer block writes none; it is none only when the file has no scorer block. Cost: none.
10. **The page's reads go in turn** (commit of these notes). Settings fired four reads at once and the sidebar's poll was a fifth, over the API's four places. The record and the export now start after the settings have answered, so two of the page's reads are out at most. Cost: the record and the export appear a moment later.
11. **The threshold says `From the defaults` once** (commit of these notes), under the slider with its number, and not again below it. Cost: none.
12. **The plan's text is marked "(as built)"** where it spoke of the endpoints as settings or of three `scorer.*` keys (calls 1, 8, 17 and 24, and the Task 8 table). Cost: none.

## What the run under Docker showed

In a network with no way out, on a real Postgres, with throwaway secrets: the release before this one on an empty database, then this branch on it, then the release before again, then a real browser (Chromium) and two admins.

- The release before ran on an empty database (15 migrations). This branch added `0016_settings` only (the ledger was diffed). The settings and the file's copy held the file's six values, and the record six rows made by `config.yml`. The start logged one line, `{"event":"settings","from_file":6,"from_ui":0}`. The release before then refused to start (`unknown_migration_applied`) and left the ledger as it was.
- In the browser, General showed where each value came from and `The default`, and Model showed the endpoint as text ending `Set in config.yml.` with no input. A threshold of 65 for the defaults, with the gate switched on and no branch for `acme/shop`, was refused 422 with the issue at Gated branches, and nothing was recorded. With a branch added it was saved. Changes listed the three changes by the admin. In config.yml showed the text, Copy put exactly that text on the clipboard, and that text appended to the file (its six keys removed) read back as the same eight settings.
- At the next review an opened event through the stubs gave a dry-run run with the threshold 65, and its page said `Threshold 65%`.
- Restarts: with the file unchanged nothing was recorded again (`from_file` 0, `from_ui` 3) and the UI's value stayed. A value changed in the file was recorded by `config.yml` and the UI's other value kept. Dry run switched off said `Takes effect when the service restarts`, the sidebar still said dry run, and after the restart it said live.
- With the UI off (`ui.publicUrl` removed), the start copied the file whole (`from_file` 4), the UI's routes answered 404, and every row read as made by `config.yml` again. With it put back, the file's values showed.
- A clash (automatic approval switched on in the UI, the audit key removed from the file): exit 1 with the `config:` issue line, the sentence that names the settings saved in the UI, a plain `start_failed` and then the JSON one. The tables and the record were unchanged, and with the key put back the service started.
- Two saves at once from two admins on the same version: one answered 200, the other 409 `changed`; one record row; one log line each.
- `*` in the base branches: with `[main]` a pull request into another branch was dropped (`base_filtered`); with `*` saved in the browser, the next one was reviewed, and the export wrote `- "*"`.
- A save that named `model.baseUrl` or `scorer.baseUrl`, with an admin's session and token, was answered 400 and changed nothing. A config shaped like a real deployment (the app, a database, a server, a password UI, a model with fallbacks, extra headers, extra body, efforts, prices and a time limit, live mode, the gate in shadow mode with required checks, and two overrides, one with an upper-case owner) started twice on its own database: the first start copied 33 settings, and the second recorded nothing, with the rows and their times unchanged. The model stub saw the extra headers on the key check.
- No log line held a planted secret (a database password, the webhook secret, the model key, the audit key, a private key line, one-time and chosen passwords, cookie values, tokens), and none held an account name; the exports and the database dumps held none either. No content security policy violation and no page error was reported. The switch's off state read at a contrast of 7.1 to 1 in the light theme and 6.1 to 1 in the dark.
- Two findings, both fixed in the commit of these notes. On 2 of 13 openings of Settings the sidebar's read of Activity was answered 503 `busy`: the page sent four reads at once, the sidebar's poll was a fifth, and the API has four places (decision 10). And for a repository that does not override the threshold, `From the defaults` was written twice (decision 11).
- At the end the project was brought down with its volumes and the images the run built were removed.

## What was checked against GitHub

Nothing. The run used a stand-in for GitHub, and a stand-in for the model. Settings reads and writes the service's own database, and what GitHub answers is not part of it. The one start-time cost that touches GitHub (see "For the owner") was read from the code and not seen.

## For the owner to decide

1. **Cannot be undone:** the previous release refuses to start on a database this release has migrated.
2. **`baseBranches: ['*']` now means every branch.** Before this release a file that wrote it matched no branch (git has no branch named `*`), so nothing was reviewed automatically there. After the first start that repository is reviewed, and spends, on every base branch. Keep it, or write the branches.
3. **The UI-off copy** (decision 1): with the UI off, each start copies the file whole and drops what the UI saved. Keep it, or have the UI-off start keep the database's values and say so.
4. **The endpoints are the file's alone** (decision 8). Keep it, or make them settings again and accept that every admin can then send the provider keys to another server. Nothing in the plan or the guide offers that.
5. **Two costs of a setting read once at the start:** the key check, at the start and at each upkeep, sends the start's extra headers and the start's endpoint, so a wrong header saved in the page can pause reviews until the next restart; and the merge gate's live switch is fixed at the start, so it also governs asking waiting reviews' checks when the service pauses and resumes. A gate or automatic approval switched on from the UI waits for the next start for its permission check, its sweep and the bypass alert. Keep these, or read the saved value each time.
6. **Rulings he may want to change:** decisions 1, 2, 3, 6 and 8 above, and the plan's calls 9, 10, 11, 13, 15, 16, 19 and 25.

## Known and left as they are

The reviews judged each of these a "leave", or the builder parked it.

- **A row written by hand** for `model.baseUrl` or `scorer.baseUrl` (only an unreleased build or a person with the database could) is ignored by the service but still counts for whether the scorer is on and for the log's `from_ui`, so it can block switching the scorer off. `0016` was never released.
- **A narrow window in the record's Older button:** an Older page asked for during a re-read can miss a page of older rows. A rare race.
- **The clash sentence's "or removed"** (plan call 14) is true only for a setting the file writes. The guide says it right.
- **A save does not read the admin's session again under the lock,** as an account change does. An admin made a viewer in the few milliseconds of their own save still saves. The guide's cost line can say so.
- **Size.** Every start writes one row for each setting, and the view answers every repository path for up to 200 repositories seen and every override (about half a megabyte at 200). Fine for realistic deployments.
- **No way to take a global setting back to "not written" from the screen,** except the scorer and an override's Use the default. The file can.
- **An extra header whose name or value `fetch` refuses** (a space, a line break) fails every review once saved. The file's validation is the same, by the one-validation rule.
- **JSON nested very deep** in a save is answered 500 with nothing stored; the body is bounded at 64 KB.
- **Repository names against GitHub Enterprise.** A scope must be `owner/name` with letters, digits, dots, hyphens and underscores, as GitHub's own names are.
- **Task-level leftovers:** the chips lose focus on remove and the add box has no blur; the switch's label is optional in its type though every use names it; chips are keyed by value; Effort and Prices have 16 and 12 pixel gaps the mockup draws differently; the defaults option is not marked when a refusal names the defaults; an issue on a row hidden by its switch shows only in the list at the top; the line of a start-time setting saved back to its start value still says restart in the outcome, which nothing reads; `storableValue` runs twice for a change; a few unused exports and a log field the settings routes do not use; a failed `failWith` with an empty path writes `: message`, which no caller passes; the tests of the lists check counts, not names; and the surrogate-safe cut of a long value in the record has no test.
- **The sidebar's account box wraps** at a window 1,360 pixels wide. It is the layout of an earlier plan.

## Not verified

- **GitHub.** Anything real GitHub answers, including the permission check for automatic approval and the gate's live switch, and the published side of a review (the run was in dry run), and sign-in through GitHub (the run signed in with a password).
- **Browsers other than Chromium.**
- **The size bounds** (500 changes in a save, 200 repositories seen), by tests only.
- **The whole service suite after the commit of these notes' fixes.** It passed at Task 10; the focused tests, both lints, both type checks, the frontend's tests and its build passed after.
- **That the new order of reads removes the 503.** It follows from the count of reads (two at most beside the poll, under four), and was not run again under Docker.
